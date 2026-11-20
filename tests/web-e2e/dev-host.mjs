import { glob } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { start } from '../../apps/server/src/bootstrap.ts';
import { configuration } from '../../apps/server/src/config.ts';

const host = '127.0.0.1';
const root = new URL('../../apps/web/', import.meta.url);
const require = createRequire(new URL('package.json', root));
const { createServer: createVite, preview } = await import(pathToFileURL(require.resolve('vite')).href);
let web;
let api;
let workspaceAccountFixture;
let commerceStoreFixture;

async function workspaceAccountOptions(store, operations) {
  const { makeContext } = await import('../../apps/server/src/context.ts');
  let terms = { version: 'fixture-v1', text: 'Initial fixture terms' };
  let providerUnavailable = false;
  workspaceAccountFixture = async ({ workspaceId, accountId, expiresAt, terms: updated, outage }) => {
    if (updated) terms = updated;
    if (typeof outage === 'boolean') providerUnavailable = outage;
    if (!workspaceId) return;
    return store.transaction({ readOnly: !accountId }, async tx => {
      const { tenantId } = tx.identity.get(`workspace/${workspaceId}`);
      const scope = { workspaceId, tenantId, actorId: workspaceId };
      const records = await tx.workspace(scope);
      const ctx = makeContext(records, scope, 'owner');
      if (!accountId) return records.get('schedule/account.workspace-health');
      const device = ctx.create('connector_device', { status: 'active', last_seen_at: ctx.now });
      const binding = ctx.create('account_execution_binding', { social_account_id: accountId, mode: 'connector',
        connector_channel: 'browser', device_id: device.id, connector_mode: 'assist', paused: false });
      ctx.create('browser_session', { social_account_id: accountId, binding_id: binding.id, device_id: device.id,
        status: 'verified', verified_at: ctx.now });
      const connection = ctx.create('connection', { provider: 'youtube', status: 'active', expires_at: expiresAt });
      return { bindingId: binding.id, connectionId: connection.id };
    });
  };
  return {
    accountConnectorServices: { terms: () => terms, connectorConfigured: () => true },
    operations: operations.map(op => op.name === 'workspace_get_today' ? {
      ...op, run: (ctx, input) => op.run(Object.assign(ctx, {
        workspacePendingProviders: providerUnavailable ? [{ key: 'ingest.health', list() { throw new Error('Fixture provider outage'); } }] : [],
      }), input),
    } : op),
  };
}
const front = createServer((request, reply) => {
  if (web) web.middlewares(request, reply);
  else reply.writeHead(503).end();
});
let closing;
function close() {
  return closing ??= Promise.all([
    web?.close(), api?.close(), commerceStoreFixture?.close(),
    new Promise(resolve => {
      front.close(resolve);
      front.closeAllConnections();
    }),
  ]);
}
try {
  front.listen(0, host);
  await once(front, 'listening');
  const origin = `http://${host}:${front.address().port}`;
  process.env.PUBLIC_ORIGIN = origin;
  const config = { ...configuration(), port: 0 };
  if (process.env.SMARTSELL_E2E_PAUSE_WORKER === '1') config.roles.delete('worker');
  if (process.env.SMARTSELL_E2E_OPERATIONS === '1') {
    const { createServer } = await import('../../apps/server/src/server.ts');
    const { discoverOperations } = await import('../../apps/server/src/operations.ts');
    const { fileStore } = await import('../../packages/db/src/index.ts');
    const discovered = await discoverOperations();
    const commerceFixture = process.env.SMARTSELL_E2E_COMMERCE_STORE;
    if (commerceFixture === 'catalog' || commerceFixture === 'promotions') {
      const { commerceStoreOptions } = await import('./commerce-store-fixture.mjs');
      commerceStoreFixture = await commerceStoreOptions(config, discovered, commerceFixture);
    }
    const store = await fileStore(config.kernelStatePath);
    const accountOptions = process.env.SMARTSELL_E2E_WORKSPACE_ACCOUNT === '1'
      ? await workspaceAccountOptions(store, discovered.operations) : {};
    api = createServer({ ...discovered, ...accountOptions, config, store,
      ...(commerceStoreFixture && { testCommerceTransport: commerceStoreFixture.testCommerceTransport }) });
    await api.listen({ host, port: 0 });
  } else {
    api = await start(config);
  }
  const apiOrigin = `http://${host}:${api.server.address().port}`;
  process.env.SMARTSELL_API_TARGET = apiOrigin;
  const options = { root: fileURLToPath(root), configLoader: 'runner' };
  web = process.env.SMARTSELL_E2E_PREVIEW === '1'
    ? await preview({ ...options, preview: { host, port: 0, strictPort: true } })
    : await createVite({
      ...options,
      // Both entries are loaded dynamically. Prebundle their dependencies before the first navigation.
      optimizeDeps: {
        noDiscovery: true,
        include: ['react', 'react-dom/client', 'react/jsx-dev-runtime', '@tanstack/react-query', 'i18next', 'lucide-react', 'react-i18next', 'react-router-dom'],
      },
      server: { middlewareMode: true, watch: null, hmr: { server: front } },
    });
  if (process.env.SMARTSELL_E2E_PREVIEW !== '1') {
    const sourceFiles = await Array.fromAsync(glob('src/**/*.{ts,tsx,css}', { cwd: options.root }));
    await Promise.all(sourceFiles.map(file => web.transformRequest(`/${file}`)));
  }
  process.once('SIGTERM', () => void close());
  process.once('SIGINT', () => void close());
  process.on('message', async ({ testTime, workspaceAccount }) => {
    if (workspaceAccount && workspaceAccountFixture) {
      try { process.send({ workspaceAccount: await workspaceAccountFixture(workspaceAccount) }); }
      catch (error) { process.send({ fixtureError: error.message }); }
      return;
    }
    process.getBuiltinModule('node:test').mock.timers.enable({ apis: ['Date'], now: testTime });
    process.send({ testTime });
  });
  process.send({ origin, apiOrigin, ...(commerceStoreFixture && { browserFixture: commerceStoreFixture.browserFixture }) });
} catch (error) {
  await close();
  throw error;
}
