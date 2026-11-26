// Android remote control over adb (core-automation-proposal step 5). No phone is attached in CI, so a fake adb answers
// with the formats real adb prints (`devices -l`, `screencap -p` PNGs, `uiautomator dump` XML) and records every
// command; the assertions check exactly what would run on the phone.
import assert from 'node:assert/strict';
import { deflateSync, crc32 } from 'node:zlib';
import { test } from 'node:test';
import { AndroidPhone, darkFraction, inputTextArgument, looksProtected, parseDevices, parseUiDump, PhoneError, pngSize, type Adb } from '../../apps/connector-desktop/src/remote/android.ts';

/** An RGBA PNG like `screencap -p`; 'black' keeps a bright status bar (the top 4 %) as a secure window would. */
function png(width: number, height: number, fill: 'noise' | 'black', filter = 1) {
  const row = (y: number) => {
    const line = Buffer.alloc(1 + width * 4);
    line[0] = 0;
    for (let x = 0; x < width; x++) {
      const bright = fill === 'noise' || y < height * 0.04;
      const v = bright ? (x * 31 + y * 17 + ((x * y) % 97)) & 0xff | 0x40 : 0;
      line[1 + x * 4] = v; line[2 + x * 4] = (v * 7) & 0xff | (bright ? 0x20 : 0); line[3 + x * 4] = (v * 13) & 0xff; line[4 + x * 4] = 255;
    }
    if (filter === 1) {   // Sub filter, as zlib-based encoders often pick
      const raw = Buffer.from(line.subarray(1));
      for (let i = raw.length - 1; i >= 4; i--) raw[i] = (raw[i] - raw[i - 4]) & 0xff;
      raw.copy(line, 1);
      line[0] = 1;
    }
    return line;
  };
  const raw = Buffer.concat(Array.from({ length: height }, (_, y) => row(y)));
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const XHS = `UI hierchary dumped to: /dev/tty<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">
<node index="0" text="" resource-id="" class="android.widget.FrameLayout" package="com.xingin.xhs" content-desc="" clickable="false" enabled="true" focusable="false" bounds="[0,0][1080,2400]">
<node index="1" text="" resource-id="com.xingin.xhs:id/search" class="android.widget.EditText" package="com.xingin.xhs" content-desc="搜尋" clickable="true" enabled="true" focusable="true" bounds="[40,120][900,220]" />
<node index="2" text="發布" resource-id="com.xingin.xhs:id/post" class="android.widget.Button" package="com.xingin.xhs" content-desc="" clickable="true" enabled="true" focusable="true" bounds="[440,2200][640,2340]" />
<node index="3" text="已關閉" resource-id="" class="android.widget.Button" package="com.xingin.xhs" content-desc="" clickable="true" enabled="false" focusable="true" bounds="[0,0][10,10]" />
<node index="4" text="&quot;新魚餌&quot; &amp; more" resource-id="" class="android.widget.TextView" package="com.xingin.xhs" content-desc="" clickable="false" enabled="true" focusable="false" bounds="[40,400][1040,480]" />
</node></hierarchy>`;

function fakePhone(options: { state?: string; screen?: 'noise' | 'black'; xml?: string } = {}) {
  const calls: string[][] = [];
  let xml = options.xml ?? XHS;
  const screen = png(108, 240, options.screen ?? 'noise');
  const adb: Adb = {
    async run(args) {
      calls.push(args);
      if (args[0] === 'devices') return Buffer.from(`List of devices attached\nR5CT12345   ${options.state ?? 'device'} usb:1-1 product:a54 model:SM_A546E device:a54x transport_id:3\n\n`);
      if (args.join(' ') === 'exec-out screencap -p') return screen;
      if (args.join(' ') === 'exec-out uiautomator dump /dev/tty') return Buffer.from(xml);
      return Buffer.alloc(0);
    },
  };
  const phone = new AndroidPhone({ adb, serial: 'R5CT12345', apps: () => ['com.xingin.xhs'], sleep: async () => {} });
  return { phone, calls, setXml: (value: string) => { xml = value; } };
}

test('adb devices -l: serial, state and model; unauthorized means the owner must allow USB debugging', () => {
  assert.deepEqual(parseDevices('List of devices attached\nemulator-5554 device product:sdk model:Pixel_8 device:emu\nR5CT1 unauthorized usb:1-1 transport_id:2\n'),
    [{ serial: 'emulator-5554', state: 'device', model: 'Pixel 8' }, { serial: 'R5CT1', state: 'unauthorized', model: null }]);
});

test('uiautomator dump: clickable, editable and labelled nodes with boxes; disabled ones dropped; entities decoded', () => {
  const { elements, packageName } = parseUiDump(XHS.slice(XHS.indexOf('<?xml')));
  assert.equal(packageName, 'com.xingin.xhs');
  assert.deepEqual(elements.map(element => [element.text || element.description, element.editable, element.box]), [
    ['搜尋', true, [40, 120, 860, 100]], ['發布', false, [440, 2200, 200, 140]], ['"新魚餌" & more', false, [40, 400, 1000, 80]],
  ]);
});

test('PNG size and protected-screen detection (un-filtered RGBA pixels, status bar still lit)', () => {
  assert.deepEqual(pngSize(png(108, 240, 'noise')), { width: 108, height: 240 });
  assert.equal(looksProtected(png(270, 600, 'black')), true, 'a black FLAG_SECURE frame with a status bar');
  assert.equal(looksProtected(png(270, 600, 'black', 0)), true, 'same with filter None');
  assert.equal(looksProtected(png(108, 240, 'noise')), false);
  assert.ok((darkFraction(png(270, 600, 'black')) ?? 0) > 0.95);
});

test('input text escaping; non-ASCII text is refused instead of being mangled', () => {
  assert.equal(inputTextArgument('new lure test'), 'new%slure%stest');
  assert.equal(inputTextArgument('a&b $(x)'), 'a\\&b%s\\$\\(x\\)');
  assert.throws(() => inputTextArgument('新魚餌'), (error: unknown) => error instanceof PhoneError && error.code === 'TEXT_NOT_SUPPORTED');
});

test('snapshot then tap by ref: the tap goes to the element centre; a stale ref is refused', async () => {
  const { phone, calls } = fakePhone();
  const snap = await phone.snapshot();
  assert.equal(snap.foreground, 'com.xingin.xhs');
  assert.deepEqual(snap.screen, { width: 108, height: 240 });
  const post = snap.elements.find(element => element.text === '發布')!;
  await phone.act({ kind: 'tap', ref: post.ref });
  assert.deepEqual(calls.find(args => args[1] === 'input' && args[2] === 'tap'), ['shell', 'input', 'tap', '540', '2270']);
  await assert.rejects(phone.act({ kind: 'tap', ref: 'p99' }), (error: unknown) => error instanceof PhoneError && error.code === 'STALE_REF');
});

test('type into a field, keys, swipe and launch run the expected adb commands', async () => {
  const { phone, calls } = fakePhone();
  const snap = await phone.snapshot();
  await phone.act({ kind: 'type', ref: snap.elements[0].ref, text: 'fishing lure' });
  await phone.act({ kind: 'key', key: 'back' });
  await phone.act({ kind: 'swipe', from: [540, 1800], to: [540, 600], ms: 400 });
  await phone.act({ kind: 'launch', package: 'com.xingin.xhs' });
  const commands = calls.filter(args => args[0] === 'shell').map(args => args.slice(1).join(' '));
  assert.deepEqual(commands, ['input tap 470 170', 'input text fishing%slure', 'input keyevent KEYCODE_BACK', 'input swipe 540 1800 540 600 400',
    'monkey -p com.xingin.xhs -c android.intent.category.LAUNCHER 1']);
});

test('an app the owner did not allow: launch is refused without touching the phone; in the foreground it goes home', async () => {
  const { phone, calls, setXml } = fakePhone();
  await assert.rejects(phone.act({ kind: 'launch', package: 'com.tencent.mm' }), (error: unknown) => error instanceof PhoneError && error.code === 'APP_NOT_ALLOWED');
  assert.equal(calls.filter(args => args[1] === 'monkey').length, 0);
  setXml(XHS.replaceAll('com.xingin.xhs', 'com.tencent.mm'));
  await assert.rejects(phone.snapshot(), (error: unknown) => error instanceof PhoneError && error.code === 'APP_NOT_ALLOWED');
  assert.deepEqual(calls.at(-1), ['shell', 'input', 'keyevent', 'KEYCODE_HOME']);
});

test('a protected screen and an unauthorized phone hand over to the owner', async () => {
  await assert.rejects(fakePhone({ screen: 'black' }).phone.snapshot(), (error: unknown) => error instanceof PhoneError && error.code === 'PROTECTED_SCREEN');
  await assert.rejects(fakePhone({ state: 'unauthorized' }).phone.snapshot(), (error: unknown) => error instanceof PhoneError && error.code === 'UNAUTHORIZED');
});
