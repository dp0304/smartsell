import { configuration } from '../../apps/server/src/config.js';
import { discoverOperations } from '../../apps/server/src/operations.js';
import { createServer } from '../../apps/server/src/server.js';
import { fileStore, postgresStore } from '../../packages/db/src/index.js';

export async function portalTestStore(statePath: string, databaseUrl?: string) {
  return databaseUrl ? postgresStore(databaseUrl) : fileStore(statePath);
}

export async function portalHost(statePath: string, setupToken: string, portalOrigin: string, assertionKey: string, databaseUrl?: string, customOrigins: string[] = []) {
  const config = configuration({ SETUP_TOKEN: setupToken, PORTAL_ORIGIN: portalOrigin, PORTAL_ASSERTION_KEY: assertionKey,
    PORTAL_CUSTOM_ORIGINS: customOrigins.join(','), SMARTSELL_DATA_FILE: statePath });
  const discovered = await discoverOperations();
  // Exercise the manual reminder without racing the automatic reminder for the same delivery.
  const schedules = discovered.schedules.filter(schedule => schedule.id !== 'team.delivery_reminder');
  const store = await portalTestStore(statePath, databaseUrl);
  const originalEnv = process.env;
  const api = (() => {
    try {
      process.env = { MEDIA_DIRECTORY: `${statePath}.media` };
      return createServer({ ...discovered, config, schedules, store });
    } finally { process.env = originalEnv; }
  })();
  return { api, staffOrigin: config.origin, store };
}
