import { fileStore, postgresStore } from '@smartsell/db';
import { configuration } from '../config.js';
import { discoverOperations, moduleKeys } from '../operations.js';
import { createServer } from '../server.js';
import { loadIdentityKey } from './enterprise-host.js';

export async function startKernel(config = configuration()) {
  const discovery = await discoverOperations();
  if (discovery.missingModules.length) {
    const message = `Modules awaiting named operations export: ${discovery.missingModules.join(', ')}`;
    for (const [module, error] of discovery.loadFailures) console.warn(`${module}: ${error}`);
    if (config.production) throw new Error(message);
    console.warn(message);
  }
  const statePath = config.kernelStatePath;
  const store = config.databaseUrl ? await postgresStore(config.databaseUrl) : await fileStore(statePath);
  let app: ReturnType<typeof createServer> | undefined;
  try {
    const identityKey = config.roles.has('api') ? await loadIdentityKey({ ...config, statePath }) : undefined;
    app = createServer({ config, store, ...discovery, identityKey, logger: true });
    await app.listen({ host: config.host, port: config.port });
    app.log.info({ roles: [...config.roles], modules: moduleKeys.length - discovery.missingModules.length, operations: discovery.operations.length }, 'SmartSell ready');
    return app;
  } catch (error) {
    if (app) await app.close(); else await store.close();
    throw error;
  }
}
