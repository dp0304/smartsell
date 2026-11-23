import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { DesktopConnector } from '../../apps/connector-desktop/src/controller.ts';
import { parseWorkbenchAddress, requestWorkbenchGrant } from '../../apps/connector-desktop/src/worker-pairing.ts';
import type { Pairing } from '../../apps/connector-desktop/src/vault.ts';

const origin = 'https://workbench.example.test';
const workspace = '11111111-2222-3333-4444-555555555555';
const code = 'a'.repeat(32);
const link = `${origin}/app/${workspace}/get-started?step=worker#worker-pair=${code}`;

test('validates a pasted pairing address and never forwards the link or code to service settings', async () => {
  assert.deepEqual(parseWorkbenchAddress(link), { origin, workspace, code });
  assert.deepEqual(parseWorkbenchAddress(`${origin}/app/${workspace}/overview?tab=accounts`), { origin, workspace });
  assert.deepEqual(parseWorkbenchAddress(`${origin}/?from=help`), { origin });
  for (const invalid of [link.replace('step=worker', 'step=store'), `${link}&next=1`, `${origin}/#worker-pair=${code}`,
    link.replace('https://', 'https://wrong@'), link.replace('https://', 'http://'), link.replace(workspace, '%2F')]) {
    assert.throws(() => parseWorkbenchAddress(invalid), /工作台/);
  }
  let pairing: Pairing | undefined;
  const persisted: string[] = [];
  const paths: string[] = [];
  const connector = new DesktopConnector({ version: '1.0.0', platform: 'darwin', machineName: 'Fixture machine',
    openAuthorization: async () => assert.fail('A generated URL needs no browser round-trip'),
    openPlatform: async () => {}, pickMedia: async () => undefined, saveOrigin: value => persisted.push(value),
    vault: { available: () => true, load: () => pairing, save: value => { pairing = value; }, clear: () => { pairing = undefined; } },
    fetcher: async (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, origin);
      assert.equal(url.search + url.hash, '');
      paths.push(url.pathname);
      if (url.pathname === '/api/v1/device/pair') {
        const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString());
        assert.equal(body.pairing_code, code);
        assert.equal(body.name, 'Fixture machine');
        return Response.json({ data: { device_id: 'fixture-device' } });
      }
      if (url.pathname === '/api/v1/device/catalog/claim') return Response.json({ data: { job: null } });
      return Response.json({ data: { status: 'online' } });
    },
  });
  await assert.rejects(connector.pairWorkbench({ url: link, ownsDevice: false }), /授权/);
  assert.deepEqual(paths, []);
  await connector.pairWorkbench({ url: link, ownsDevice: true });
  await turn();
  assert.deepEqual(persisted, [origin]);
  assert.deepEqual(paths, ['/api/v1/device/pair', '/api/v1/device/heartbeat', '/api/v1/device/catalog/claim']);
  assert.equal(connector.snapshot().online, true);
  assert.equal(connector.snapshot().workspace, workspace);
  assert(!JSON.stringify(connector.snapshot()).includes(code));
  assert.equal(Object.hasOwn(pairing!, 'code'), false);
  await assert.rejects(connector.pairWorkbench({ url: link, ownsDevice: true }), /授权/);
  assert.equal(paths.length, 3);
});

test('loopback grant only accepts its own callback path, Host, Origin, state and requested workspace', async () => {
  const abort = new AbortController();
  const launch = Promise.withResolvers<URL>();
  const grant = requestWorkbenchGrant({ origin, workspace }, 'Fixture machine', async url => { launch.resolve(new URL(url)); }, abort.signal);
  try {
    const url = await launch.promise;
    const port = Number(url.searchParams.get('port'));
    const state = url.searchParams.get('state')!;
    assert(port >= 1024 && port <= 65535);
    assert.match(state, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(url.searchParams.get('workspace'), workspace);
    const callback = new URL(`http://127.0.0.1:${port}/smartsell-worker`);
    const post = (values: Record<string, string>, headers: Record<string, string> = {}, path = callback.href) => fetch(path, {
      method: 'POST', headers: { origin: callback.origin, 'content-type': 'application/x-www-form-urlencoded', ...headers },
      body: new URLSearchParams({ state, workspace, code, ...values }),
    });
    assert.equal((await post({}, { origin })).status, 403);
    assert.equal((await post({}, {}, `http://localhost:${port}/smartsell-worker`)).status, 404);
    assert.equal((await post({}, {}, `${callback.href}?code=${code}`)).status, 404);
    assert.equal((await post({ state: 'b'.repeat(43) })).status, 400);
    assert.equal((await post({ workspace: 'another-workspace' })).status, 400);
    assert.equal((await post({ code: 'bad' })).status, 400);
    const html = await fetch(callback);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.equal((await post({})).status, 200);
    assert.deepEqual(await grant, { workspace, code });
    await assert.rejects(fetch(callback));
  } finally { abort.abort(); await grant.catch(() => {}); }
});
