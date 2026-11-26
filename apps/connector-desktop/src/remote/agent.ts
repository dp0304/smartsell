// The Worker's end of remote control (design E50): while the owner has remote control on for this machine, long-poll the
// hub for the next command, run it in the owner's Chrome (sessions.ts) or on a plugged-in Android phone (android.ts), and
// answer. One command at a time. When remote control is off the Worker only checks back every `offPollMs`.
import type { RemoteCapabilities, RemoteCommandEnvelope, RemoteControlSettings, RemoteNextRequest, RemoteNextResponse, RemoteResultRequest } from '../runtime/contracts.ts';
import { AndroidPhone, parseDevices, PhoneError, type Adb } from './android.ts';
import { RemoteError, type RemoteCommand, type RemoteSessions } from './sessions.ts';

export interface RemoteAgentOptions {
  hub: { remoteNext?(body: RemoteNextRequest): Promise<RemoteNextResponse>; remoteResult?(body: RemoteResultRequest): Promise<{ accepted: boolean }> };
  /** Browser sessions in the owner's Chrome (own-Chrome mode only), created with the current settings' sites. */
  browser?(settings: RemoteControlSettings): RemoteSessions | undefined;
  /** Whether the owner's Chrome is connected (the SmartSell extension), for the capabilities the hub shows the Agent. */
  browserReady?(): boolean;
  adb?: Adb;
  /** The App scales phone screenshots and encodes JPEG; without it the PNG is sent as is. */
  encodePhone?(png: Buffer): Promise<{ mime: string; bytes: Buffer; width?: number }>;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  log?(message: string, detail?: object): void;
  offPollMs?: number;
}

export class RemoteAgent {
  #abort = new AbortController();
  #running?: Promise<void>;
  #settings: RemoteControlSettings | null = null;
  #phones = new Map<string, AndroidPhone>();
  #adbMissing = false;
  constructor(private readonly options: RemoteAgentOptions) {}

  get settings() { return this.#settings; }

  start() {
    if (this.#running || !this.options.hub.remoteNext || !this.options.hub.remoteResult) return;
    this.#abort = new AbortController();
    this.#running = this.#loop(this.#abort.signal).finally(() => { this.#running = undefined; });
  }

  async stop() {
    this.#abort.abort();
    await this.#running?.catch(() => {});
  }

  async #capabilities(settings: RemoteControlSettings | null): Promise<RemoteCapabilities> {
    const phones = settings?.phone.enabled && this.options.adb && !this.#adbMissing
      ? await this.options.adb.run(['devices', '-l']).then(out => parseDevices(out.toString('utf8')), error => {
        this.#adbMissing = true;
        this.options.log?.('adb unavailable for phone remote control', { error: String(error) });
        return [];
      })
      : [];
    // Whether the owner's Chrome is connected, whatever the last settings said: the hub knows the current ones.
    return { browser: this.options.browserReady?.() ?? false, phones: phones.map(phone => ({ serial: phone.serial, model: phone.model, state: phone.state })) };
  }

  async #loop(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const capabilities = await this.#capabilities(this.#settings);
        const reply = await this.options.hub.remoteNext!({ wait_ms: 25_000, capabilities });
        this.#settings = reply.settings;
        failures = 0;
        if (reply.command) await this.#answer(reply.command);
        else if (!reply.settings.browser.enabled && !reply.settings.phone.enabled) await this.options.sleep(this.options.offPollMs ?? 20_000, signal);
      } catch (error) {
        if (signal.aborted) break;
        failures++;
        // A hub from before remote control (no route): check back rarely instead of logging every minute.
        const status = error && typeof error === 'object' && 'status' in error ? (error as { status: unknown }).status : null;
        if (status === 404) { await this.options.sleep(10 * 60_000, signal).catch(() => {}); continue; }
        this.options.log?.('remote poll failed', { error: error instanceof Error ? error.message : String(error) });
        await this.options.sleep(Math.min(60_000, 2000 * 2 ** Math.min(failures, 5)), signal).catch(() => {});
      }
    }
  }

  async #answer(envelope: RemoteCommandEnvelope) {
    let body: RemoteResultRequest;
    try {
      if (Date.parse(envelope.expires_at) < Date.now()) throw new RemoteError('INVALID_ACTION', 'The command expired before it reached the machine.');
      const result = envelope.target === 'browser' ? await this.#browser(envelope) : await this.#phone(envelope);
      body = { command_id: envelope.command_id, ok: true, result: result as Record<string, unknown> };
    } catch (error) {
      const known = error instanceof RemoteError || error instanceof PhoneError;
      body = { command_id: envelope.command_id, ok: false, error: { code: known ? error.code : 'REMOTE_FAILED',
        message: known ? error.message : 'The machine could not do that step; take a new snapshot and try again.' } };
      if (!known) this.options.log?.('remote command failed', { error: error instanceof Error ? error.stack ?? error.message : String(error) });
    }
    await this.options.hub.remoteResult!(body).catch(error => this.options.log?.('remote result not delivered', { error: String(error) }));
  }

  async #browser(envelope: RemoteCommandEnvelope) {
    const settings = this.#settings;
    if (!settings?.browser.enabled) throw new RemoteError('SITE_NOT_ALLOWED', 'Browser remote control is off on this machine.');
    const sessions = this.options.browser?.(settings);
    if (!sessions) throw new RemoteError('BROWSER_UNAVAILABLE', 'This machine posts with separate Chrome profiles; remote control needs "use my own Chrome" in the SmartSell Worker.');
    return sessions.handle(envelope.command as unknown as RemoteCommand);
  }

  async #phone(envelope: RemoteCommandEnvelope) {
    const settings = this.#settings;
    if (!settings?.phone.enabled) throw new PhoneError('APP_NOT_ALLOWED', 'Phone remote control is off on this machine.');
    if (!this.options.adb || this.#adbMissing) throw new PhoneError('NO_DEVICE', 'adb is not installed on this machine (Android platform tools).');
    const devices = parseDevices((await this.options.adb.run(['devices', '-l'])).toString('utf8')).filter(device => device.state !== 'offline');
    const serial = envelope.serial ?? (devices.length === 1 ? devices[0].serial : undefined);
    if (!serial) throw new PhoneError('NO_DEVICE', devices.length ? `Several phones are connected (${devices.map(device => device.serial).join(', ')}); pass serial.` : 'No phone is connected to this machine.');
    let phone = this.#phones.get(serial);
    if (!phone) {
      phone = new AndroidPhone({ adb: this.options.adb, serial, apps: () => this.#settings?.phone.apps ?? [], encode: this.options.encodePhone, sleep: ms => this.options.sleep(ms) });
      this.#phones.set(serial, phone);
    }
    const command = envelope.command as { op?: string; action?: unknown };
    return command.op === 'act' ? phone.act(command.action as Parameters<AndroidPhone['act']>[0]) : phone.snapshot();
  }
}
