import { createHash, createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { buildApp, type NotFoundDelegate } from './app';
import { previewIdentityKey } from './integration/command-identity-key.js';
import { configuration } from './config';
import { MemoryStore } from './memory';
import { PostgresStore } from './postgres';
import { discover } from './registry';
import { runWorkspaceBackground, type BackgroundDrain } from './runtime.js';
import { commandBackgroundStore } from './integration/command-background.js';
import { customerEgress } from './integration/customer-egress.js';
import { createMediaHost } from './integration/media-host.js';
import { createPublishHost } from './integration/publish-host.js';
import { createSignedWebhookHost } from './integration/signed-webhook-host.js';
import { configureAlerts, createAlertsDrain } from './modules/alerts/index.js';
import { MemoryNonceStore, configureDeviceNonces } from './modules/worker/nonces.js';
import { readBundledClip } from './modules/worker/host-cache.js';
import type { BackgroundStore } from './runtime.js';


async function optionalOperationApi(config: ReturnType<typeof configuration>) {
  if (process.env.SMARTSELL_OPERATION_API === '0') return undefined;
  const [{ discoverOperations }, { registerOperationRoutes }, { createCommerceProviders }, { commerceDrain, commerceSubscribers }] = await Promise.all([
    import('./operations.js'), import('./operation-server.js'),
    import('./integration/commerce-providers.js'), import('./integration/commerce-jobs.js'),
  ]);
  const { operations, loadFailures, subscribers, schedules } = await discoverOperations();
  for (const [module, error] of loadFailures) {
    if (config.production) throw new Error(`Unable to load ${module} operations: ${error}`);
    console.warn(`${module} operations not loaded: ${error}`);
  }
  const providers = createCommerceProviders(config);
  const egress = customerEgress();
  egress.ops.deploymentMode = config.identityDeployment;
  const signedWebhook = createSignedWebhookHost(egress, { allowLoopbackHttp: config.allowLoopbackWebhook });
  const media = createMediaHost(config);
  // The Worker job engine (S3): test timing, release/selector directories and the bundled dry-run clip (§5.13, §8.11, §8.18).
  const publishing = createPublishHost(providers.account, media.media, undefined, {
    testTiming: config.testTiming, workerDownloadDirectory: config.workerDownloadDirectory, driverConfigDirectory: config.driverConfigDirectory,
    bundledClip: await readBundledClip(),
  });
  // Owner alerts (S10 ledger 1–2): push tokens are sealed with a key derived from APP_SECRET; links use PUBLIC_ORIGIN.
  configureAlerts({ secretKey: createHash('sha256').update(`smartsell:alert-channel:v1:${config.secret}`).digest(), publicOrigin: config.origin,
    // S6: the home hub may push to its own ntfy on 127.0.0.1 or the tailnet; SaaS pushes only to public addresses.
    privateEgress: config.pushPrivateNetwork });
  // §9.6, C7: one link builder (S7's views) for MCP results (S4), owner alerts (S10) and the dashboard; S10's machine_setup
  // alerts use the §3.2 warnings. Loaded after discoverOperations(), so the account/planning modules are already linked.
  const [{ installWebLinks }, { effectiveMode }] = await Promise.all([
    import('./modules/workspace/views/install.js'), import('./modules/account/channel-settings.js'),
  ]);
  installWebLinks({ publicOrigin: config.origin });
  // S10 ledger 11: "click Post" reminders follow a risk acknowledgement withdrawn after dispatch (the live mode, not job.mode).
  configureAlerts({ effectiveMode: (ctx, socialAccountId) => { try { return effectiveMode(ctx, socialAccountId); } catch { return undefined; } } });
  const alertsDrain = createAlertsDrain();
  const drainCommerce = commerceDrain(providers.account);
  const drain: BackgroundDrain = async transact => {
    await drainCommerce(transact);
    await signedWebhook.drain(transact);
    await publishing.drain(transact);
    // Phone push is sent outside every transaction, after the alert rows commit (§11.2 C13, §0 rule 8).
    await alertsDrain(transact);
  };
  return { config, media, operations: [...operations.map(op => publishing.bindOperation(providers.bindOperation(op))), ...signedWebhook.operations], register: registerOperationRoutes,
    subscribers: [...subscribers.map(media.bindSubscriber), ...commerceSubscribers, signedWebhook.subscriber],
    schedules: [...publishing.schedules(schedules), providers.accountSchedule, media.schedule],
    egress, drain, providers, publishing };
}

/** A stable development APP_SECRET derived from the owner-only preview key under .local/. */
export function developmentSecret(statePath: string) {
  return createHmac('sha256', previewIdentityKey(statePath)).update('smartsell:app-secret:v1').digest('hex');
}

/** Services a start hook may use to mount routes that need the Commands session. */
export interface StartServices {
  config: ReturnType<typeof configuration>;
  /** Resolves the signed-in session or throws a 401 DomainError. */
  requireSession(request: FastifyRequest): Promise<unknown>;
  /** The Operation store as the background runtime sees it (workspace transactions); for start hooks and in-process tests. */
  background?: BackgroundStore;
}

export interface StartHooks {
  /** Runs after every built-in route is registered and before `listen`; the hub mounts `/api/v1/hub/info` and static files here. */
  beforeListen?(app: FastifyInstance, services: StartServices): void | Promise<void>;
  /** GET/HEAD requests that match no route and are not `/api/*`, `/mcp`, `/agent/*` (SPA fallback, §2.4). */
  notFound?: NotFoundDelegate;
}

export async function start(config = configuration(), hooks: StartHooks = {}) {
  if (!config.roles.has('api')) throw new Error('The Commands server requires the api role');
  if (config.identityDeployment === 'saas') throw new Error('SaaS identity requires the Operation server');
  // A hub always uses the local SQLite snapshot store (§2.4); configuration() already rejects other stores.
  const mode = config.hub ? 'local' : process.env.SMARTSELL_STORE ?? (config.databaseUrl ? 'postgres' : 'local');
  if (config.databaseUrl ? mode !== 'postgres' : config.mode === 'production') throw new Error('DATABASE_URL requires PostgreSQL storage');
  if (mode !== 'postgres' && mode !== 'local' && !(mode === 'memory' && process.env.NODE_ENV === 'test')) {
    throw new Error('SMARTSELL_STORE must be postgres, local, or explicit test-mode memory');
  }
  if (mode === 'postgres' && !config.databaseUrl) throw new Error('Set DATABASE_URL to a migrated PostgreSQL 17+ request login');
  // Development without APP_SECRET keeps Agent tokens, CSRF tokens and cursors valid across watch restarts.
  if (!config.production && config.generatedSecret && mode !== 'memory') config = { ...config, secret: developmentSecret(config.statePath) };
  if (!config.production && !config.setupToken && !config.localSetupOrigins?.size) {
    console.warn('Initial setup is disabled until SETUP_TOKEN is configured');
  }
  const reportMissing = config.production ? undefined : (name: string, error: Error) => {
    console.warn(`${name} not loaded: ${error.message}`);
  };
  const { registry, extensions, missing } = await discover(undefined, undefined, reportMissing);
  if (missing.length) {
    if (config.production) throw new Error(`Missing command modules: ${missing.join(', ')}`);
    console.warn(`Modules awaiting command exports: ${missing.join(', ')}`);
  }
  const operationApi = await optionalOperationApi(config);
  // The hub runs background schedules in the same process (§2.4).
  const runsMaintenance = config.hub || config.roles.has('worker') || config.roles.has('scheduler') || config.roles.has('media');
  // Provider configuration has already been validated by optionalOperationApi.
  const requiresCallbacks = operationApi && (
    Object.keys(JSON.parse(process.env.SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS || '{}')).length > 0 ||
    JSON.parse(process.env.SMARTSELL_SHOPIFY_APPS || '[]').length > 0
  );
  if (mode === 'postgres' && operationApi && (runsMaintenance || requiresCallbacks) && !config.backgroundDatabaseUrl) {
    throw new Error('Set BACKGROUND_DATABASE_URL to the PostgreSQL background login for Commands maintenance or commerce callbacks');
  }
  // §2.10, C8: the hub keeps device nonces in memory (no snapshot write per heartbeat; requests signed before this process
  // started are refused). Development and Postgres keep the durable device_nonce records.
  configureDeviceNonces(config.hub && mode !== 'postgres' ? new MemoryNonceStore() : 'records');
  const requestStore = mode === 'postgres' ? new PostgresStore(config.databaseUrl!) : undefined;
  const store = requestStore ?? (mode === 'local' ? (await import('./local.js')).localStore(config.statePath) : new MemoryStore());
  const backgroundStore = requestStore && operationApi && config.backgroundDatabaseUrl
    ? new PostgresStore(config.backgroundDatabaseUrl) : undefined;
  let app: ReturnType<typeof buildApp>['app'] | undefined;
  try {
    if (requestStore) await requestStore.ready('request');
    else await store.ready();
    await backgroundStore?.ready('background');
    const commandIdentityKey = config.identityKey ? Buffer.from(config.identityKey, 'hex')
      : config.production || process.env.APP_SECRET || mode === 'memory' ? createHash('sha256').update(config.secret).digest()
      : previewIdentityKey(config.statePath);
    const built = buildApp({ ...config, store, registry, logger: true, extensions, operationApi, commandIdentityKey, notFound: hooks.notFound });
    app = built.app;
    if (backgroundStore) app.addHook('onClose', () => backgroundStore.close());
    const operationStore = requestStore ? backgroundStore : store;
    let background: BackgroundStore | undefined;
    if (operationApi && operationStore) {
      background = commandBackgroundStore(operationStore);
      operationApi.providers.mountOAuthCallback(app, background);
      operationApi.providers.mountShopifyWebhook(app, background);
      operationApi.publishing.mount(app, background, operationApi.egress);
      if (runsMaintenance) {
        const stop = runWorkspaceBackground(background, config, operationApi.subscribers, operationApi.schedules,
          app.log, operationApi.operations, operationApi.egress, operationApi.drain);
        app.addHook('preClose', stop);
      }
    }
    await hooks.beforeListen?.(app, { config, requireSession: built.requireSession, background });
    await app.listen({ host: config.host, port: config.port });
    app.log.info({ modules: registry.size, extensions: [...extensions.keys()], operations: operationApi?.operations.length ?? 0 }, 'Workspace routes loaded');
    return app;
  } catch (error) {
    if (app) await app.close();
    else await Promise.all([store.close(), backgroundStore?.close()]);
    throw error;
  }
}
