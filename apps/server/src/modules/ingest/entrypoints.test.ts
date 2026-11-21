import assert from 'node:assert/strict';
import { test } from 'node:test';
import { register, type Registry } from '../../registry.js';

const scenarios = {
  ingest: ['start_backfill', 'record_metric_page'],
  commerce: ['preview_import', 'rollback_import', 'attest_import_coverage'],
  intel: ['record_observation', 'observation_timeline'],
  analytics: ['metrics_query', 'attribution_run', 'reports_generate_version'],
  ads: ['approve_proposal', 'reconcile_operation'],
} as const;

test('all five module indexes register their workspace commands', async () => {
  const registry: Registry = new Map();
  for (const [module, actions] of Object.entries(scenarios)) {
    const { commands } = await import(new URL(`../${module}/index.js`, import.meta.url).href);
    register(registry, module, commands);
    for (const action of actions) assert.ok(registry.get(module)?.has(action), `${module}.${action} is not registered`);
  }
});
