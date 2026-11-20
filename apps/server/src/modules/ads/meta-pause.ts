import { randomUUID } from 'node:crypto';
import { Problem, type Context, type Row } from '@smartsell/contracts';
import type { Transport } from '../../../../../packages/adapters/src/adapter-types.ts';
import { createFetchTransport } from '../../../../../packages/adapters/src/fetch-transport.ts';
import { connectionContext, type AccountServices } from '../account/oauth.js';
import { assertEmergencyNotStopped, assertJobAllowed } from '../ops/controls.js';
import type { BackgroundDrain } from '../../runtime.js';
import { authorizeMetaPause } from './workspace-operations.js';

const origin = 'https://graph.facebook.com';
const writeLease = 45_000;

function claim(ctx: Context, services: AccountServices) {
  const candidates = ctx.list('ad_operation').filter(row => row.kind === 'pause' && row.proposal_id);
  for (const row of candidates) {
    const elapsed = typeof row.lease_until === 'string' && row.lease_until <= ctx.now;
    if (row.status === 'sending' && elapsed) {
      ctx.update('ad_operation', row.id, { status: 'outcome_unknown', readback_requested: true, fence: null });
      const attempt = ctx.list('ad_operation_attempt').find(attempt => attempt.operation_id === row.id && attempt.fence === row.fence);
      if (attempt) ctx.update('ad_operation_attempt', attempt.id, { status: 'outcome_unknown', finished_at: ctx.now });
      continue;
    }
    const write = row.status === 'queued';
    const observe = row.readback_requested === true && ['accepted', 'outcome_unknown'].includes(String(row.status));
    if (!write && !observe && !(row.status === 'observing' && elapsed)) continue;
    try {
      if (write) assertEmergencyNotStopped(ctx);
      assertJobAllowed(ctx, { provider: 'meta_ads', queue: 'ads', side_effect: write });
      const target = authorizeMetaPause(ctx, row, write);
      const accounts = target.connection.discovered_accounts;
      const account = Array.isArray(accounts) && accounts.find(item => item?.externalAccountId === target.accountId || item?.externalAccountId === `act_${target.accountId}`);
      if (!account) throw new Problem(409, 'CAPABILITY_UNAVAILABLE', 'Advertising connection does not own this account');
      const auth = connectionContext(ctx, target.connection, services, account.externalAccountId);
      if (!auth.scopes?.some(scope => write ? scope === 'ads_management' : ['ads_read', 'ads_management'].includes(scope))) {
        throw new Problem(409, 'CAPABILITY_UNAVAILABLE', 'Advertising credential lacks the required scope');
      }
      const fence = randomUUID();
      const previous = write ? 'queued' : row.status === 'observing' ? row.before_readback : row.status;
      ctx.update('ad_operation', row.id, { status: write ? 'sending' : 'observing', fence, before_readback: previous,
        readback_requested: false, lease_until: new Date(Date.parse(ctx.now) + writeLease).toISOString() });
      const attempt = ctx.create('ad_operation_attempt', { operation_id: row.id, fence, kind: write ? 'write' : 'readback', status: 'started' });
      return { id: row.id, target, token: auth.accessToken, fence, attempt: attempt.id, write, previous };
    } catch (error) {
      if (error instanceof Problem && ['job_paused', 'emergency_halt'].includes(error.code)) continue;
      const status = write ? 'blocked' : row.status === 'observing' ? row.before_readback : row.status;
      ctx.update('ad_operation', row.id, { status, readback_requested: false, fence: null, blocked_reason: error instanceof Problem ? error.code : 'authorization_required' });
    }
  }
}

export function metaPauseDrain(services: AccountServices, send: Transport = createFetchTransport({ origins: [origin], timeoutMs: 10_000 })): BackgroundDrain {
  return async transact => {
    const execution = await transact(ctx => claim(ctx, services));
    if (!execution) return;
    const { target, token, write } = execution;
    let observation: Record<string, unknown> = {};
    try {
      const url = `${origin}/v25.0/${target.externalId}`;
      const headers = { authorization: `Bearer ${token}` };
      const read = () => send({ method: 'GET', url: `${url}?fields=id,account_id,configured_status,effective_status`, headers });
      const current = await read();
      const body = current.body as Record<string, unknown> | undefined;
      if (current.status !== 200 || body?.id !== target.externalId || body?.account_id !== target.accountId) {
        if (write) observation = { status: 'blocked', blocked_reason: 'provider_target_unverified' };
      } else if (write) {
        const result = await send({ method: 'POST', url, headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, body: 'status=PAUSED' });
        if (result.status === 200 && (result.body as { success?: boolean } | undefined)?.success === true) observation = { status: 'accepted' };
      } else if (body.configured_status === 'PAUSED' && body.effective_status === 'PAUSED') {
        observation = { status: 'verified', verified_state: 'paused', configured_status: 'PAUSED', effective_status: 'PAUSED' };
      } else {
        observation = { configured_status: body.configured_status === 'ACTIVE' ? 'ACTIVE' : undefined,
          effective_status: body.effective_status === 'ACTIVE' ? 'ACTIVE' : undefined };
      }
    } catch {
      // A lost response is never authority to repeat a write.
    }
    await transact(ctx => {
      const row: Row = ctx.get('ad_operation', execution.id);
      if (row.fence !== execution.fence) return;
      const status = observation.status ?? (write ? 'outcome_unknown' : execution.previous);
      ctx.update('ad_operation_attempt', execution.attempt, { ...observation, status, finished_at: ctx.now });
      ctx.update('ad_operation', row.id, { ...observation, status, lease_until: null, fence: null,
        readback_requested: write ? ['accepted', 'outcome_unknown'].includes(String(status)) : row.readback_requested });
      ctx.emit('ads.operation.observed', { operation_id: row.id, status });
    });
  };
}
