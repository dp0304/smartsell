import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../memory.js';
import { commands } from '../modules/agent/index.js';
import type { Entity } from '../modules/types.js';
import { createMcpCommandBridge, createMcpHandler } from './mcp.js';

test('MCP dispatch shares the workspace command transaction and records credential-bound audit', async () => {
  const store = new MemoryStore();
  await store.setup({ email: 'owner@example.test', name: 'Owner', passwordHash: 'test', workspaceName: 'Workspace' }, 'fixture');
  const { workspaces: [workspace] } = (await store.session('fixture'))!;
  const { job, tenantId, actorId } = await store.workspace('fixture', workspace!.id, async unit => {
    const { context } = unit;
    const job = await unit.command({ module: 'agent', action: 'jobs_create', key: 'seed', fingerprint: 'seed' },
      () => commands.jobs_create!.run(context, { title: 'Internal brief' })) as Entity;
    return { job, tenantId: context.tenantId, actorId: context.actorId };
  });
  const workspaceId = workspace!.id;
  const handle = createMcpHandler({
    ...createMcpCommandBridge({
      workspace: (principal, run) => store.workspace('fixture', principal.workspaceId, run),
      lookup: (module, action) => module === 'agent' ? commands[action] : undefined,
      permit: (_ctx, request) => request.mode === 'list' || request.input.body.agent_job_id === job.id,
    }),
    authenticate: token => token === 'fixture' ? { tenantId, workspaceId, actorId, tokenId: 'credential',
      allowedTools: ['agent_jobs_claim', 'agent_jobs_heartbeat'] } : undefined,
  });
  async function call(name: string, args: Record<string, unknown>) {
    const response = await handle(new Request('https://fixture.test/mcp', { method: 'POST',
      headers: { Authorization: 'Bearer fixture', Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { workspace_id: workspaceId, ...args } } }),
    }));
    return (await response.json()).result;
  }
  const claim = await call('agent_jobs_claim', { agent_job_id: job.id, expected_version: job.version });
  assert.equal(claim.structuredContent.data.status, 'claimed');
  assert.equal(claim.structuredContent.data.title, undefined);
  const heartbeat = await call('agent_jobs_heartbeat', { agent_job_id: job.id, expected_version: job.version,
    fencing_token: claim.structuredContent.data.fencing_token });
  assert.equal(heartbeat.isError, true);
  await store.workspace('fixture', workspaceId, async ({ context }) => {
    const saved = await context.get('agent', 'agent_job', job.id);
    assert.equal(saved?.data.lease_client_id, 'credential');
    assert.equal((await context.get('workspace', 'work_item', `agent-job:${job.id}`))?.data.status, 'in_progress');
    const audit = await context.list('agent', 'tool_call');
    assert.deepEqual(audit.map(row => row.data.outcome).sort(), ['failed', 'succeeded']);
    assert.ok(audit.every(row => row.data.credential_id === 'credential' && /^[a-f0-9]{64}$/.test(row.data.input_hash)));
  });
});
