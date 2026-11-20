import { randomBytes } from 'node:crypto';
import { buildApp } from '../../apps/server/src/app.js';
import * as collaboration from '../../apps/server/src/extensions/collaboration.js';
import { MemoryStore } from '../../apps/server/src/memory.js';
import { commands as lifecycle } from '../../apps/server/src/modules/lifecycle/index.js';
import { commands as team } from '../../apps/server/src/modules/team/index.js';
import { commands as traffic } from '../../apps/server/src/modules/traffic/index.js';
import { register, type Registry } from '../../apps/server/src/registry.js';

export function collaborationHost(setupToken: string) {
  const store = new MemoryStore();
  const origins = new Set<string>();
  const registry: Registry = new Map();
  register(registry, 'lifecycle', lifecycle);
  register(registry, 'team', team);
  register(registry, 'traffic', traffic);
  const { app } = buildApp({ registry, extensions: new Map([['collaboration', collaboration]]), store,
    secret: randomBytes(32).toString('hex'), secureCookie: false, setupToken, origins });
  return { app, store, origins };
}
