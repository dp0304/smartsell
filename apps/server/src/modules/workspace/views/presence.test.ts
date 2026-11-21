import assert from 'node:assert/strict';
import { test } from 'node:test';
import { READ } from '@smartsell/contracts';
import { brandOperationAllowed } from '../../../integration/brand-access.js';
import { testWorkspace } from '../../lifecycle/workspace-test-context.js';
import { viewOperations } from './index.js';
import { presenceViewOperations } from './presence.js';

test('agent presence is a small read every role can make, including brand-scoped viewers', () => {
  const workspace = testWorkspace(presenceViewOperations);
  const { ctx } = workspace;
  const read = () => workspace.call<Record<string, unknown>>('views_agent_presence');
  assert.deepEqual(read(), { connections: null, last_seen_at: null, timezone: 'UTC', as_of: ctx.now });
  ctx.create('workspace', { default_timezone: 'Asia/Taipei' });
  ctx.create('agent_connection', { revoked: false, expires_at: '2026-12-01T00:00:00.000Z', last_used_at: '2026-11-19T11:00:00.000Z' });
  ctx.create('agent_connection', { revoked: true, last_used_at: '2026-11-19T11:59:00.000Z' });
  ctx.create('activity_event', { occurred_at: '2026-11-19T11:30:00.000Z', actor_type: 'agent', action: 'content_create_item', actor_id: 'author' });
  assert.deepEqual(read(), { connections: 1, last_seen_at: '2026-11-19T11:30:00.000Z', timezone: 'Asia/Taipei', as_of: ctx.now });
  const [operation] = presenceViewOperations;
  assert.deepEqual([operation!.method, operation!.path, operation!.roles], ['GET', '/views/agent-presence', READ]);
  assert.ok(viewOperations.includes(operation!));
  assert.ok(brandOperationAllowed(['brand:b1'], 'views_agent_presence', 'GET'));
});
