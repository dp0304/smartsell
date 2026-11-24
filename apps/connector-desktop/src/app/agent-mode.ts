// Laptop Agent mode (§6.2, §5.9 channel 2, §8.17): "這台是我的筆電（只連
// Codex，不發文）". A login item with a tray and one small window; it never
// pairs as a Worker. Three jobs: connect Codex / Claude Code, show every
// machine's owner alerts as OS notifications, and continue uploads that the
// relay handed off when Codex returned (C12).
import { readFileSync, writeFileSync } from 'node:fs';
import type { OwnerAlert } from '@smartsell/contracts';
import { AlertStream, shouldNotify, type AlertStreamState } from './alerts.ts';
import { connectAgentClient, readRelayConfig, readRelayToken, relayFiles, type AgentClient, type ConnectDeps, type ConnectResult } from './agent-connect.ts';
import { COPY, type Notifier } from './notify.ts';
import { UploadHandoff, type UploadHandoffOptions } from './upload-handoff.ts';
import type { AppSettings } from '../service-settings.ts';

export interface AgentShellDeps {
  userData: string;
  platform: NodeJS.Platform;
  hostname: string;
  execPath: string;
  homeDir: string;
  socketPath: string;
  notifier: Pick<Notifier, 'notify' | 'reset'>;
  hold(reason: string, on: boolean): void;
  settings: { load(): AppSettings; save(patch: Partial<AppSettings>): AppSettings };
  openExternal(url: string): Promise<void>;
  which: ConnectDeps['which'];
  run: ConnectDeps['run'];
  bundledRelayScript: string | null;
  onChange(): void;
  log(message: string, detail?: object): void;
  fetch?: typeof fetch;
  now?(): number;
  /** Test seams. */
  connect?: typeof connectAgentClient;
  handoff?: Partial<UploadHandoffOptions>;
}

export class AgentShell {
  readonly #d: AgentShellDeps;
  readonly #handoff: UploadHandoff;
  #stream?: AlertStream;
  #streamState: AlertStreamState = 'idle';
  #connecting?: AbortController;
  #lastConnect: (ConnectResult & { at: string }) | null = null;
  #error: string | null = null;
  #alerts: OwnerAlert[] = [];

  constructor(deps: AgentShellDeps) {
    this.#d = deps;
    const files = relayFiles(deps.userData);
    this.#handoff = new UploadHandoff({
      socketPath: deps.socketPath, dataDir: files.dir, platform: deps.platform, homeDir: deps.homeDir,
      credentials: async () => this.#credentials(), hold: deps.hold, onChange: deps.onChange, log: deps.log, now: deps.now,
      ...deps.handoff,
    });
  }

  #credentials() {
    const config = readRelayConfig(this.#d.userData);
    const token = readRelayToken(this.#d.userData);
    return config && token ? { hubOrigin: config.hub_origin, token } : null;
  }

  async start() {
    try { await this.#handoff.start(); }
    catch (error) { this.#d.log('upload handoff server failed to start', { error: String(error) }); }
    this.#subscribe();
    this.#d.onChange();
  }

  /** (Re)subscribes to the alert stream with the stored agent token, resuming after the stored Last-Event-ID. */
  #subscribe() {
    void this.#stream?.stop();
    this.#stream = undefined;
    const credentials = this.#credentials();
    if (!credentials) { this.#streamState = 'idle'; return; }
    const cursorPath = relayFiles(this.#d.userData).cursor;
    let cursor: string | null = null;
    try { cursor = readFileSync(cursorPath, 'utf8').trim() || null; } catch { /* first run */ }
    const stream = new AlertStream({
      hubOrigin: credentials.hubOrigin, token: credentials.token, fetch: this.#d.fetch, lastEventId: cursor,
      saveLastEventId: id => writeFileSync(cursorPath, id, { mode: 0o600 }),
      onAlert: alert => {
        this.#alerts.unshift(alert);
        this.#alerts.length = Math.min(this.#alerts.length, 20);
        if (shouldNotify(alert, (this.#d.now ?? Date.now)())) {
          this.#d.notifier.notify({ title: alert.title, body: alert.body, url: alert.web_url, urgent: alert.severity === 'urgent', key: `alert:${alert.id}` });
        }
        this.#d.onChange();
      },
      onState: state => {
        this.#streamState = state;
        if (state === 'unauthorized') this.#d.notifier.notify({ title: COPY.agentUnauthorizedTitle, body: COPY.agentUnauthorized, urgent: true, key: 'agent_unauthorized' });
        if (state === 'open') this.#d.notifier.reset('agent_unauthorized');
        this.#d.onChange();
      },
    });
    this.#stream = stream;
    void stream.start();
  }

  setHub(input: string) {
    const url = URL.parse(input.trim());
    if (!url || (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('請貼上中樞位址，例如 https://hub.tail1234.ts.net。');
    this.#d.settings.save({ role: 'agent', agent_hub_origin: url.origin });
    this.#d.onChange();
  }

  /** 「連接 Codex／Claude Code」 (§6.2). */
  async connect(client: unknown) {
    if (client !== 'codex' && client !== 'claude_code') throw new Error('請選 Codex 或 Claude Code。');
    const hub = this.#d.settings.load().agent_hub_origin ?? readRelayConfig(this.#d.userData)?.hub_origin;
    if (!hub) throw new Error('請先貼上中樞位址。');
    this.#connecting?.abort();
    const abort = new AbortController();
    this.#connecting = abort;
    this.#error = null;
    this.#d.onChange();
    try {
      const result = await (this.#d.connect ?? connectAgentClient)({
        hubOrigin: hub, client: client as AgentClient, hostname: this.#d.hostname, userData: this.#d.userData, execPath: this.#d.execPath,
        platform: this.#d.platform, homeDir: this.#d.homeDir, openExternal: this.#d.openExternal, signal: abort.signal, fetch: this.#d.fetch,
        which: this.#d.which, run: this.#d.run, bundledRelayScript: this.#d.bundledRelayScript, log: this.#d.log,
      });
      this.#lastConnect = { ...result, at: new Date((this.#d.now ?? Date.now)()).toISOString() };
      this.#d.settings.save({ role: 'agent', agent_hub_origin: hub });
      this.#subscribe();
      return result;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      if (this.#connecting === abort) this.#connecting = undefined;
      this.#d.onChange();
    }
  }

  cancelConnect() { this.#connecting?.abort(); }

  async stop() {
    this.#connecting?.abort();
    await this.#stream?.stop();
    await this.#handoff.stop();
  }

  snapshot() {
    const config = readRelayConfig(this.#d.userData);
    return {
      hub_origin: this.#d.settings.load().agent_hub_origin ?? config?.hub_origin ?? null,
      connected_client: config?.client ?? null, connection_id: config?.connection_id ?? null,
      alerts_state: this.#streamState, alerts: this.#alerts.map(alert => ({ ...alert })), uploads: this.#handoff.uploads(),
      handoff_listening: this.#handoff.listening, connecting: !!this.#connecting, last_connect: this.#lastConnect, error: this.#error,
    };
  }
}
