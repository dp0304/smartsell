// Android phone remote control over plain adb (core-automation-proposal §4, step 5): the phone is plugged into this
// machine (USB debugging allowed on the phone), and the owner's Agent looks at the screen and acts one step at a time —
// the same shape as the browser sessions (sessions.ts). adb is Apache-2.0 platform tooling; mobilecli is not used
// because of its FSL-1.1 licence (see the proposal's §4.1 correction).
//
// Boundaries:
// - only apps the owner allowed for this phone (package names; the launcher and SmartSell's own checks excepted);
// - a protected screen (FLAG_SECURE: payment, some sign-in pages) screenshots black: stop and hand it to the owner;
// - every step answers with a fresh snapshot; element refs are valid until the next snapshot.
import { execFile } from 'node:child_process';
import { inflateSync } from 'node:zlib';

export interface Adb {
  /** Runs `adb -s <serial> <args>` (or `adb <args>` without a serial) and returns stdout as bytes. */
  run(args: string[], options?: { serial?: string; timeoutMs?: number }): Promise<Buffer>;
}

export function systemAdb(executable = 'adb'): Adb {
  return {
    run: (args, options = {}) => new Promise((resolve, reject) => {
      execFile(executable, [...(options.serial ? ['-s', options.serial] : []), ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: options.timeoutMs ?? 20_000, windowsHide: true },
        (error, stdout, stderr) => error ? reject(new PhoneError('ADB_FAILED', (stderr.toString('utf8').trim() || error.message).slice(0, 300))) : resolve(stdout));
    }),
  };
}

export class PhoneError extends Error {
  constructor(readonly code: 'ADB_FAILED' | 'NO_DEVICE' | 'UNAUTHORIZED' | 'APP_NOT_ALLOWED' | 'STALE_REF' | 'INVALID_ACTION' | 'PROTECTED_SCREEN' | 'TEXT_NOT_SUPPORTED', message: string) {
    super(message); this.name = 'PhoneError';
  }
}

export interface AndroidDevice { serial: string; state: 'device' | 'unauthorized' | 'offline' | string; model: string | null }

/** `adb devices -l` → devices; `unauthorized` means the owner still has to allow USB debugging on the phone. */
export function parseDevices(output: string): AndroidDevice[] {
  return output.split('\n').slice(1).map(line => line.trim()).filter(Boolean).map(line => {
    const [serial, state, ...rest] = line.split(/\s+/);
    const model = rest.find(item => item.startsWith('model:'))?.slice(6).replaceAll('_', ' ') ?? null;
    return { serial, state, model };
  });
}

export interface PhoneElement { ref: string; text: string; description: string; resource_id: string; class: string; clickable: boolean; editable: boolean; box: [number, number, number, number] }

const attr = (tag: string, name: string) => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? match[1].replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&') : '';
};

/** uiautomator's XML dump → the elements an Agent can act on (clickable, editable or labelled), in document order. */
export function parseUiDump(xml: string, limit = 200): { elements: Omit<PhoneElement, 'ref'>[]; packageName: string | null } {
  const elements: Omit<PhoneElement, 'ref'>[] = [];
  let packageName: string | null = null;
  for (const match of xml.matchAll(/<node\b[^>]*?>/g)) {
    const tag = match[0];
    packageName ??= attr(tag, 'package') || null;
    const bounds = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(attr(tag, 'bounds'));
    if (!bounds) continue;
    const [x1, y1, x2, y2] = bounds.slice(1).map(Number);
    if (x2 <= x1 || y2 <= y1) continue;
    const text = attr(tag, 'text'), description = attr(tag, 'content-desc'), className = attr(tag, 'class');
    const clickable = attr(tag, 'clickable') === 'true' || attr(tag, 'long-clickable') === 'true';
    const editable = /EditText/.test(className) || attr(tag, 'focusable') === 'true' && /edit|search/i.test(attr(tag, 'resource-id'));
    if (!clickable && !editable && !text && !description) continue;
    if (attr(tag, 'enabled') === 'false') continue;
    elements.push({ text: text.slice(0, 120), description: description.slice(0, 120), resource_id: attr(tag, 'resource-id'), class: className, clickable, editable,
      box: [x1, y1, x2 - x1, y2 - y1] });
    if (elements.length >= limit) break;
  }
  return { elements, packageName };
}

/** PNG width/height from the IHDR chunk. */
export function pngSize(png: Buffer) {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) throw new PhoneError('ADB_FAILED', 'The phone did not return a PNG screenshot.');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Share of near-black pixels (each of R, G, B below 16) in an 8-bit RGB or RGBA, non-interlaced PNG — what
 * `screencap -p` writes. Rows are un-filtered per the PNG spec (None, Sub, Up, Average, Paeth). null for other formats.
 */
export function darkFraction(png: Buffer): number | null {
  const { width, height } = pngSize(png);
  const bitDepth = png[24], colorType = png[25], interlace = png[28];
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || !channels || interlace !== 0) return null;
  const idat: Buffer[] = [];
  for (let offset = 8; offset + 8 <= png.length;) {
    const length = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset += 12 + length;
  }
  const data = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  let previous = Buffer.alloc(stride), dark = 0;
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1), filter = data[start];
    const line = Buffer.from(data.subarray(start + 1, start + 1 + stride));
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? line[i - channels] : 0, up = previous[i], upLeft = i >= channels ? previous[i - channels] : 0;
      let add = 0;
      if (filter === 1) add = left;
      else if (filter === 2) add = up;
      else if (filter === 3) add = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft, pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upLeft);
        add = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      line[i] = (line[i] + add) & 0xff;
    }
    for (let x = 0; x < stride; x += channels) if (line[x] < 16 && line[x + 1] < 16 && line[x + 2] < 16) dark++;
    previous = line;
  }
  return dark / (width * height);
}

/**
 * A FLAG_SECURE window (payment, some sign-in screens) screenshots black; the status bar may still show. Treat a frame
 * that is at least 92 % near-black as protected and hand it to the owner.
 */
export function looksProtected(png: Buffer) {
  const fraction = darkFraction(png);
  return fraction !== null && fraction >= 0.92;
}

const ascii = /^[\x20-\x7e]*$/;
/** `input text` escaping: spaces become %s and shell metacharacters are backslash-escaped. */
export function inputTextArgument(text: string) {
  if (!ascii.test(text)) throw new PhoneError('TEXT_NOT_SUPPORTED', 'Only ASCII text can be typed over adb; ask the owner to type Chinese text, or paste it from the phone\'s clipboard.');
  return text.replace(/([\\"'`$&|;<>()*?#~!{}[\]])/g, '\\$1').replaceAll(' ', '%s');
}

export const KEYS: Record<string, string> = {
  back: 'KEYCODE_BACK', home: 'KEYCODE_HOME', enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL', app_switch: 'KEYCODE_APP_SWITCH', search: 'KEYCODE_SEARCH',
};

export type PhoneAction =
  | { kind: 'tap'; ref?: string; x?: number; y?: number }
  | { kind: 'long_press'; ref?: string; x?: number; y?: number; ms?: number }
  | { kind: 'swipe'; from: [number, number]; to: [number, number]; ms?: number }
  | { kind: 'type'; text: string; ref?: string }
  | { kind: 'key'; key: keyof typeof KEYS }
  | { kind: 'launch'; package: string }
  | { kind: 'wait'; ms: number };

export interface PhoneSnapshot {
  serial: string; foreground: string | null; screen: { width: number; height: number };
  elements: PhoneElement[];
  /** `scale`: image pixels per screen pixel; tap x,y are screen pixels (image x / scale). */
  screenshot: { mime: string; base64: string; scale: number }; taken_at: string;
}

export interface AndroidPhoneOptions {
  adb: Adb;
  serial: string;
  /** Apps (package names) the owner allowed on this phone. */
  apps(): readonly string[];
  /** Turns the PNG into what the Agent gets (the App scales it and encodes JPEG with Electron's nativeImage). */
  encode?(png: Buffer): Promise<{ mime: string; bytes: Buffer; width?: number }>;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

/** Apps that are always fine to be on: the home screen and system UI (lock screen, notification shade). */
const ALWAYS_ALLOWED = [/launcher/i, /^com\.android\.systemui$/, /^com\.google\.android\.apps\.nexuslauncher$/];

export class AndroidPhone {
  #refs = new Map<string, [number, number]>();
  constructor(private readonly options: AndroidPhoneOptions) {}

  #adb(args: string[], timeoutMs?: number) { return this.options.adb.run(args, { serial: this.options.serial, timeoutMs }); }

  appAllowed(packageName: string | null) {
    if (!packageName) return true;
    return ALWAYS_ALLOWED.some(pattern => pattern.test(packageName)) || this.options.apps().includes(packageName);
  }

  async state(): Promise<AndroidDevice | undefined> {
    const devices = parseDevices((await this.options.adb.run(['devices', '-l'])).toString('utf8'));
    return devices.find(device => device.serial === this.options.serial);
  }

  async #ready() {
    const device = await this.state();
    if (!device) throw new PhoneError('NO_DEVICE', 'The phone is not connected to this machine (check the USB cable).');
    if (device.state === 'unauthorized') throw new PhoneError('UNAUTHORIZED', 'Allow USB debugging on the phone (a prompt is on its screen), then try again.');
    if (device.state !== 'device') throw new PhoneError('NO_DEVICE', `The phone is ${device.state}.`);
  }

  async snapshot(): Promise<PhoneSnapshot> {
    await this.#ready();
    const png = await this.#adb(['exec-out', 'screencap', '-p'], 30_000);
    if (looksProtected(png)) {
      this.#refs.clear();
      throw new PhoneError('PROTECTED_SCREEN', 'The phone shows a protected screen (payment, sign-in or a secure app). Ask the owner to handle it on the phone.');
    }
    const xml = (await this.#adb(['exec-out', 'uiautomator', 'dump', '/dev/tty'], 30_000)).toString('utf8');
    const { elements, packageName } = parseUiDump(xml.slice(xml.indexOf('<?xml')));
    if (!this.appAllowed(packageName)) {
      this.#refs.clear();
      await this.#adb(['shell', 'input', 'keyevent', KEYS.home]).catch(() => {});
      throw new PhoneError('APP_NOT_ALLOWED', `${packageName} is not in the apps the owner allowed for this phone; went back to the home screen.`);
    }
    const screen = pngSize(png);
    const shot = this.options.encode ? await this.options.encode(png) : { mime: 'image/png', bytes: png };
    this.#refs = new Map();
    const listed = elements.map((element, index) => {
      const ref = `p${index + 1}`;
      this.#refs.set(ref, [element.box[0] + element.box[2] / 2, element.box[1] + element.box[3] / 2]);
      return { ref, ...element };
    });
    return { serial: this.options.serial, foreground: packageName, screen, elements: listed,
      screenshot: { mime: shot.mime, base64: shot.bytes.toString('base64'), scale: 'width' in shot && shot.width ? shot.width / screen.width : 1 }, taken_at: new Date(this.options.now?.() ?? Date.now()).toISOString() };
  }

  #point(action: { ref?: string; x?: number; y?: number }): [number, number] {
    if (action.ref) {
      const point = this.#refs.get(action.ref);
      if (!point) throw new PhoneError('STALE_REF', `${action.ref} is not on the last snapshot. Take a new snapshot and use its refs.`);
      return [Math.round(point[0]), Math.round(point[1])];
    }
    if (!Number.isFinite(action.x) || !Number.isFinite(action.y) || action.x! < 0 || action.y! < 0) throw new PhoneError('INVALID_ACTION', 'Needs a ref or x and y in screen pixels.');
    return [Math.round(action.x!), Math.round(action.y!)];
  }

  async act(action: PhoneAction): Promise<PhoneSnapshot> {
    await this.#ready();
    switch (action.kind) {
      case 'tap': { const [x, y] = this.#point(action); await this.#adb(['shell', 'input', 'tap', String(x), String(y)]); break; }
      case 'long_press': {
        const [x, y] = this.#point(action);
        const ms = Math.max(300, Math.min(5000, action.ms ?? 800));
        await this.#adb(['shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(ms)]);
        break;
      }
      case 'swipe': {
        const values = [...action.from, ...action.to];
        if (values.some(value => !Number.isFinite(value) || value < 0)) throw new PhoneError('INVALID_ACTION', 'swipe needs from and to points in screen pixels.');
        await this.#adb(['shell', 'input', 'swipe', ...values.map(value => String(Math.round(value))), String(Math.max(100, Math.min(3000, action.ms ?? 300)))]);
        break;
      }
      case 'type': {
        const text = inputTextArgument(action.text);
        if (action.ref) { const [x, y] = this.#point(action); await this.#adb(['shell', 'input', 'tap', String(x), String(y)]); }
        await this.#adb(['shell', 'input', 'text', text]);
        break;
      }
      case 'key': {
        const code = KEYS[action.key];
        if (!code) throw new PhoneError('INVALID_ACTION', `key must be one of ${Object.keys(KEYS).join(', ')}.`);
        await this.#adb(['shell', 'input', 'keyevent', code]);
        break;
      }
      case 'launch': {
        if (!/^[A-Za-z][\w]*(\.[A-Za-z][\w]*)+$/.test(action.package)) throw new PhoneError('INVALID_ACTION', 'package must be an Android package name like com.xingin.xhs.');
        if (!this.appAllowed(action.package)) throw new PhoneError('APP_NOT_ALLOWED', `${action.package} is not in the apps the owner allowed for this phone.`);
        await this.#adb(['shell', 'monkey', '-p', action.package, '-c', 'android.intent.category.LAUNCHER', '1']);
        break;
      }
      case 'wait': break;
      default: throw new PhoneError('INVALID_ACTION', 'Unknown action.');
    }
    await this.options.sleep(action.kind === 'wait' ? Math.max(0, Math.min(10_000, action.ms)) : action.kind === 'launch' ? 2000 : 800);
    return this.snapshot();
  }
}
