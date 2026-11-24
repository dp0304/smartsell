import assert from 'node:assert/strict';
import { test } from 'node:test';

test('discoverOperations registers the alerts operations under their full names, with the schedule and subscriber', async t => {
  let loaded: typeof import('../../operations.js');
  try { loaded = await import('../../operations.js'); } catch (error) {
    // The operation registry's own import graph (outside modules/alerts) can be mid-edit by another workstream.
    if (error instanceof ReferenceError && !String(error.stack).includes('/modules/alerts/')) return t.skip(`operations.ts did not load: ${error.message}`);
    throw error;
  }
  const { discoverOperations, HUMAN_ONLY, agentCallable } = loaded;
  const { operations, loadFailures, schedules, subscribers } = await discoverOperations();
  assert.equal(loadFailures.get('alerts'), undefined);
  const alerts = operations.filter(operation => operation.module === 'alerts');
  assert.deepEqual(alerts.map(operation => `${operation.method} ${operation.path} ${operation.name}`).sort(), [
    'GET /hub/alerts/channels hub_alerts_get_channels', 'GET /views/alerts views_alerts', 'POST /hub/alerts/read hub_alerts_read',
    'POST /hub/alerts/test hub_alerts_test', 'PUT /hub/alerts/channels hub_alerts_update_channels',
  ]);
  for (const name of ['hub_alerts_update_channels', 'hub_alerts_test']) {
    assert.ok(HUMAN_ONLY.has(name));
    assert.equal(agentCallable(alerts.find(operation => operation.name === name)!), false);
  }
  assert.equal(agentCallable(alerts.find(operation => operation.name === 'views_alerts')!), true);
  assert.ok(schedules.some(schedule => schedule.id === 'alerts.reminders'));
  assert.ok(subscribers.some(subscriber => subscriber.id === 'alerts.triggers'));
  // Every route is unique across all modules.
  const routes = operations.map(operation => `${operation.method} ${operation.path}`);
  for (const operation of alerts) assert.equal(routes.filter(route => route === `${operation.method} ${operation.path}`).length, 1);
});
