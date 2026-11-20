import { readFile } from 'node:fs/promises';
import { fileStore, postgresStore } from '@smartsell/db';
import { configuration } from '../config.js';
import { configureEnterpriseConnection, loadIdentityKey } from './enterprise-host.js';

async function main() {
  const [path] = process.argv.slice(2);
  if (!path || process.argv.length !== 3) throw new Error('Usage: identity:configure <connection.json>');
  const config = configuration();
  if (config.identityDeployment !== 'saas') throw new Error('Enterprise connections require SaaS identity');
  const input: unknown = JSON.parse(await readFile(path, 'utf8'));
  const statePath = config.kernelStatePath;
  const store = config.databaseUrl ? await postgresStore(config.databaseUrl) : await fileStore(statePath);
  try {
    await configureEnterpriseConnection(store, await loadIdentityKey({ ...config, statePath }), input);
    console.log('Enterprise connection updated');
  } finally {
    await store.close();
  }
}

main().catch(error => {
  console.error(error instanceof SyntaxError ? 'Invalid connection JSON' : error instanceof Error ? error.message : 'Connection update failed');
  process.exitCode = 1;
});
