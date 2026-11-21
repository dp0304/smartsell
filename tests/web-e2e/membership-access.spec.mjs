import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';

const origin = process.env.SMARTSELL_REVIEWER_ORIGIN;
const container = process.env.SMARTSELL_MEMBERSHIP_PG_CONTAINER;
test.skip(!origin || !container, 'Run with tests/acceptance/reviewer-sessions.sh membership');
test.use({ baseURL: origin, ignoreHTTPSErrors: true });

function sql(statement, variables = {}) {
  const args = Object.entries(variables).flatMap(([name, value]) => ['-v', `${name}=${value}`]);
  return execFileSync('docker', ['exec', '-i', container, 'psql', '-XqAt', '-U', 'postgres', '-d', 'reviewer_acceptance',
    '-v', 'ON_ERROR_STOP=1', ...args], { input: statement, encoding: 'utf8' }).trim();
}

async function call(client, method, path, status, data, headers = {}) {
  const response = await client.fetch(path, { method, data, headers: { Origin: origin, ...headers }, maxRedirects: 0 });
  const json = await response.json().catch(() => undefined);
  expect(response.status(), `${method} ${path} (${json?.error?.code ?? 'no error code'})`).toBe(status);
  if (path === '/mcp') expect(Boolean(response.headers()['www-authenticate'])).toBe(status === 401);
  return json;
}

const person = name => ({ name, email: `${name}@example.test`, password: randomBytes(24).toString('hex') });
const api = '/api/v1';
const ws = id => `${api}/workspaces/${id}`;
const mcp = (client, token, workspace, job, status, tool = 'jobs_get') => call(client, 'POST', '/mcp', status, {
  jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: { workspace_id: workspace, operation_id: job } },
}, { Authorization: `Bearer ${token}`, Accept: 'application/json, text/event-stream' });

test('TE01 workspace removal denies an issued PAT and preserves other access and handover history', async ({ playwright }) => {
  const contexts = await Promise.all(Array.from({ length: 4 }, () => playwright.request.newContext({ baseURL: origin, ignoreHTTPSErrors: true })));
  const [setup, owner, member, bearer] = contexts;
  try {
    const admin = person('owner');
    const editor = person('editor');
    const { workspaces: [{ id: primary }] } = await call(setup, 'POST', `${api}/setup`, 201, {
      ...admin, workspaceName: 'Removed workspace',
    }, { 'X-Setup-Token': process.env.SETUP_TOKEN });
    const { user: administrator } = await call(owner, 'POST', `${api}/session`, 200, admin);
    const csrf = async client => ({ 'X-CSRF-Token': (await call(client, 'GET', `${api}/session/csrf`, 200)).csrf_token });
    const ownerHeaders = await csrf(owner);
    const { data: invite } = await call(owner, 'POST', `${ws(primary)}/members/invite`, 200, { email: editor.email, role: 'editor' }, ownerHeaders);
    await call(member, 'POST', `${api}/member-invitations/accept`, 204, { ...editor, token: invite.invitation_token });
    const { user: departing } = await call(member, 'POST', `${api}/session`, 200, editor);
    expect(departing.id).not.toBe(administrator.id);
    const sessionCookie = async client => {
      const cookie = (await client.storageState()).cookies.find(row => row.name === '__Host-smartsell_session');
      expect(cookie).toMatchObject({ secure: true, httpOnly: true });
      return cookie.value;
    };
    const editorCookie = await sessionCookie(member);
    const ownerCookie = await sessionCookie(owner);
    expect(editorCookie === ownerCookie).toBe(false);
    const memberHeaders = await csrf(member);

    // This service has no API to provision a second workspace for existing accounts.
    // Seed only the topology. The users, sessions, PATs and work all come from HTTP.
    const retained = randomUUID();
    const ids = { primary, retained, editor: departing.id, owner: administrator.id };
    sql(`BEGIN;
      INSERT INTO ss.workspaces (id, tenant_id, name)
        SELECT :'retained', tenant_id, 'Retained workspace' FROM ss.workspaces WHERE id=:'primary';
      INSERT INTO ss.memberships VALUES (:'retained', :'editor', 'viewer'), (:'retained', :'owner', 'owner');
      COMMIT;`, ids);
    const members = async (wid, client) => (await call(client, 'GET', `${ws(wid)}/members`, 200)).data;
    expect(await members(primary, owner)).toEqual(expect.arrayContaining([
      expect.objectContaining({ user_id: departing.id, role: 'editor' }), expect.objectContaining({ user_id: administrator.id, role: 'owner' }),
    ]));
    expect(await members(retained, member)).toEqual(expect.arrayContaining([expect.objectContaining({ user_id: departing.id, role: 'viewer' })]));

    const issue = async (wid, client = member) => (await call(client, 'POST', `${ws(wid)}/tokens`, 201, { access: 'read', tools: ['jobs_get'] })).data;
    const job = async wid => (await call(owner, 'POST', `${ws(wid)}/commands/agent/jobs_create`, 200,
      { title: `TE01 ${wid}` }, { 'Idempotency-Key': randomUUID() })).data.id;
    const removedJob = await job(primary);
    const retainedJob = await job(retained);
    const before = await issue(primary);
    const ownerPat = await issue(primary, owner);
    const stillAllowed = await issue(retained);
    const revoked = await issue(primary);
    const expiring = await issue(primary);
    const read = async (pat, wid, id) => {
      const rpc = await mcp(bearer, pat.token, wid, id, 200);
      expect(rpc.result?.structuredContent?.data).toMatchObject({ operation_id: id, status: 'open' });
    };
    await read(before, primary, removedJob);
    await read(ownerPat, primary, removedJob);
    await read(stillAllowed, retained, retainedJob);
    await read(revoked, primary, removedJob);
    await read(expiring, primary, removedJob);
    await call(member, 'DELETE', `${ws(primary)}/tokens/${revoked.id}`, 204);
    expect(sql(`UPDATE ss.entities SET data=jsonb_set(data, '{expires}', '0')
      WHERE workspace_id=:'primary' AND module='mcp_runtime' AND kind='credential' AND id=:'pat' RETURNING id;`,
    { primary, pat: expiring.id })).toBe(expiring.id);
    const invalid = `ss_command_${randomBytes(100).toString('base64url')}`;
    const verifyRejected = async () => {
      for (const token of [invalid, expiring.token, revoked.token]) await mcp(bearer, token, primary, removedJob, 401);
    };
    await verifyRejected();

    const { data: work } = await call(member, 'POST', `${ws(primary)}/work-items`, 200, { title: 'Review the launch report' }, memberHeaders);
    const workPath = `${ws(primary)}/work-items/${work.id}`;
    await call(member, 'PATCH', workPath, 200, { status: 'in_progress' }, { ...memberHeaders, 'If-Match': String(work.version) });
    const remove = `${ws(primary)}/members/${departing.id}/remove`;
    await call(member, 'POST', remove, 403, {}, memberHeaders);
    const { data: preview } = await call(owner, 'POST', remove, 200, {}, ownerHeaders);
    expect(preview.items).toContainEqual({ kind: 'work_item', id: work.id });
    const { data: removed } = await call(owner, 'POST', remove, 200, { preview_hash: preview.preview_hash, to_user_id: administrator.id }, ownerHeaders);
    expect((await members(primary, owner)).map(row => row.user_id)).not.toContain(departing.id);
    const session = await call(member, 'GET', `${api}/session`, 200);
    expect(session.user.id).toBe(departing.id);
    expect(session.workspaces).toEqual([expect.objectContaining({ id: retained, role: 'viewer' })]);
    expect(await sessionCookie(member) === editorCookie).toBe(true);
    expect(await sessionCookie(owner) === ownerCookie).toBe(true);
    await mcp(bearer, before.token, primary, removedJob, 403);
    await read(ownerPat, primary, removedJob);
    await read(stillAllowed, retained, retainedJob);
    const deniedWrite = await mcp(bearer, stillAllowed.token, retained, retainedJob, 200, 'jobs_cancel');
    expect(deniedWrite.result).toMatchObject({ isError: true, structuredContent: { error: { code: 'TOOL_UNAVAILABLE' } } });
    await read(stillAllowed, retained, retainedJob);
    await verifyRejected();

    const previous = (await call(owner, 'GET', workPath, 200)).data;
    expect(previous).toMatchObject({ created_by_id: departing.id, assignee_id: departing.id, status: 'in_progress' });
    const { data: handovers } = await call(owner, 'GET', `${ws(primary)}/handovers`, 200);
    const handover = handovers.find(row => row.id === removed.handover_id);
    expect(handover).toMatchObject({ from_user_id: departing.id, to_user_id: administrator.id, status: 'pending_accept' });
    const { data: accepted } = await call(owner, 'POST', `${ws(primary)}/handovers/${handover.id}/accept`, 200, {}, {
      ...ownerHeaders, 'If-Match': String(handover.version),
    });
    expect(accepted).toMatchObject({ from_user_id: departing.id, to_user_id: administrator.id, status: 'completed' });
    expect((await call(owner, 'GET', workPath, 200)).data).toMatchObject({
      created_by_id: departing.id, assignee_id: administrator.id, status: 'in_progress',
    });
    const history = sql(`SELECT data->>'value' FROM ss.entities WHERE workspace_id=:'primary' AND module='operation_runtime'
      AND kind='record' AND id LIKE 'row/work_item_event/%' AND (data->>'value')::jsonb->>'work_item_id'=:'work';`, { primary, work: work.id });
    expect(history.split('\n').map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({
      kind: 'handed_over', from_value: departing.id, to_value: administrator.id, actor_id: administrator.id,
    }));
    const audit = sql(`SELECT json_agg(json_build_object('action', action, 'actor_id', actor_id)) FROM ss.audit WHERE workspace_id=:'primary';`, { primary });
    expect(JSON.parse(audit)).toEqual(expect.arrayContaining([
      { action: 'tasks_create', actor_id: departing.id }, { action: 'team_member_remove', actor_id: administrator.id },
      { action: 'team_handover_accept', actor_id: administrator.id },
    ]));
    expect(sql(`SELECT count(*) FROM ss.events e JOIN ss.audit a ON a.id=e.audit_id
      WHERE e.workspace_id=:'primary' AND e.name='team.member.removed' AND e.payload->>'member_id'=:'editor'
        AND a.actor_id=:'owner' AND a.action='team_member_remove';`, ids)).toBe('1');

    expect(sql(`WITH records AS (
        SELECT id, (data->>'value')::jsonb AS record FROM ss.entities
        WHERE workspace_id=:'primary' AND module='operation_runtime' AND kind='record' AND (id LIKE 'outbox/%' OR id LIKE 'audit/%')
      ) SELECT count(*) FROM records e JOIN records a ON e.record->>'trace_id'=a.record->>'request_id'
      WHERE e.id LIKE 'outbox/%' AND e.record->>'type'='team.handover.completed'
        AND e.record->'payload'->>'handover_id'=:'handover' AND e.record->>'actor_id'=:'owner'
        AND a.id LIKE 'audit/%' AND a.record->>'action'='team_handover_accept'
        AND a.record->>'resource_id'=:'handover' AND a.record->>'actor_id'=:'owner';`,
    { primary, owner: administrator.id, handover: handover.id })).toBe('1');

    // A restored membership must not restore the old PAT's workspace grant.
    sql(`INSERT INTO ss.memberships VALUES (:'primary', :'editor', 'editor');`, ids);
    await mcp(bearer, before.token, primary, removedJob, 403);
    const restored = await issue(primary);
    await read(restored, primary, removedJob);
    await call(member, 'DELETE', `${api}/session`, 204);
    await mcp(bearer, stillAllowed.token, retained, retainedJob, 401);
    await mcp(bearer, restored.token, primary, removedJob, 401);
    await call(owner, 'GET', `${api}/session`, 200);
    console.log(`TE01: PAT 200 -> 403 in removed workspace ${primary}; PAT 200 -> 200 in retained workspace ${retained}; invalid/expired/revoked 401; handover ${handover.id} and audit verified`);
  } finally {
    await Promise.all(contexts.map(context => context.dispose()));
  }
});
