import { text, type Context, type Entity, type Fields } from '../types.js';
import { channels, deviceOnline, workflows } from './devices.js';
import { approved, blocks, choice, emit, ensure, get, identifier, list, openBlock, stopAuto, update, upsert } from './model.js';

import { isSupportedWorkflow as supportsWorkflow } from '../../../../../packages/connector-tasks/src/index.js';

export async function setBinding(ctx: Context, input: Fields) {
  const account = await get(ctx, 'social_account', identifier(input, 'social_account_id'));
  ensure(account.data.status === 'active', 'account_disabled');
  const mode = choice(input, 'mode', ['api', 'manual', 'connector', 'hybrid'] as const);
  const current = await ctx.get('account', 'account_execution_binding', account.id);
  let local = { device_id: null as string | null, mobile_device_id: null as string | null, connector_channel: null as string | null, workflow: null as string | null, workflow_ack_by: null as string | null, workflow_ack_at: null as string | null };
  if (mode === 'connector' || mode === 'hybrid') {
    const device = await get(ctx, 'device', identifier(input, 'device_id'));
    const channel = choice(input, 'connector_channel', channels);
    const workflow = choice(input, 'workflow', workflows);
    ensure(supportsWorkflow(account.data.provider, channel, workflow), 'unsupported_workflow', 422);
    ensure(device.data.status === 'paired', 'device_unavailable');
    approved(input, 'owned_account_confirmed');
    approved(input, 'workflow_consent_confirmed');
    const mobileId = channel === 'mobile' ? identifier(input, 'mobile_device_id') : null;
    if (mobileId) {
      approved(input, 'owned_mobile_confirmed');
      const others = (await list(ctx, 'account_execution_binding')).filter((row) => row.id !== account.id && row.data.mobile_device_id === mobileId);
      for (const other of others) {
        const boundAccount = await get(ctx, 'social_account', other.data.social_account_id);
        ensure(other.data.device_id === device.id && boundAccount.data.provider !== account.data.provider, 'mobile_binding_conflict');
      }
    }
    local = { device_id: device.id, mobile_device_id: mobileId, connector_channel: channel, workflow, workflow_ack_by: ctx.actorId, workflow_ack_at: ctx.now };
  }
  const patch = { mode, social_account_id: account.id, ...local, connector_mode: 'assist', binding_revision: (current?.data.binding_revision ?? 0) + 1, observed_platform_user_id: null, identity_status: 'unverified' };
  const result = await upsert(ctx, 'account_execution_binding', account.id, patch);
  await emit(ctx, 'binding.changed', { binding_id: account.id, ...patch });
  return result;
}

export async function reportIdentity(ctx: Context, bindingId: string, deviceId: string, observedId: string | null) {
  const binding = await get(ctx, 'account_execution_binding', bindingId);
  ensure(binding.data.device_id === deviceId, 'device_binding_mismatch', 403);
  const account = await get(ctx, 'social_account', binding.data.social_account_id);
  const identity_status = observedId === null ? 'login_required' : observedId === account.data.external_account_id ? 'verified' : 'identity_mismatch';
  const reported = await update(ctx, binding, { identity_status, observed_platform_user_id: observedId, identity_checked_at: ctx.now,
    binding_revision: identity_status === 'verified' ? binding.data.binding_revision : binding.data.binding_revision + 1 });
  await emit(ctx, `session.${identity_status}`, { binding_id: binding.id, device_id: deviceId, social_account_id: account.id });
  if (identity_status === 'verified') return reported;
  const block = await openBlock(ctx, reported, identity_status);
  return stopAuto(ctx, reported, identity_status, block.id);
}

export async function readiness(ctx: Context, account: Entity, binding: Entity) {
  const { data } = binding;
  if (account.data.status !== 'active') return 'account_disabled';
  if (!data.device_id || !data.workflow_ack_at || !supportsWorkflow(account.data.provider, data.connector_channel, data.workflow)) return 'workflow_unavailable';
  if (data.connector_channel === 'mobile' && !data.mobile_device_id) return 'mobile_device_not_bound';
  const device = await ctx.get('account', 'device', data.device_id);
  if (!device || !deviceOnline(ctx, device)) return 'device_offline';
  if (data.identity_status !== 'verified' || data.observed_platform_user_id !== account.data.external_account_id) return 'identity_unverified';
  const age = Date.parse(ctx.now) - Date.parse(data.identity_checked_at);
  if (!(age >= 0 && age < 90_000)) return 'identity_stale';
  if ((await blocks(ctx, binding.id)).length) return 'account_blocked';
  return null;
}

export async function deviceBlock(ctx: Context, bindingId: string, deviceId: string, reason: 'captcha' | 'platform_restriction') {
  const binding = await get(ctx, 'account_execution_binding', bindingId);
  ensure(binding.data.device_id === deviceId, 'device_binding_mismatch', 403);
  const updated = await update(ctx, binding, { identity_status: 'unverified', binding_revision: binding.data.binding_revision + 1 });
  const block = await openBlock(ctx, updated, reason);
  await stopAuto(ctx, updated, reason, block.id);
  return block;
}

export async function resolveBlock(ctx: Context, input: Fields) {
  const block = await get(ctx, 'account_block', identifier(input, 'block_id'));
  if (block.data.status !== 'open') return block;
  const binding = await get(ctx, 'account_execution_binding', block.data.binding_id);
  ensure(binding.data.identity_status === 'verified' && Date.parse(binding.data.identity_checked_at) >= Date.parse(block.created_at), 'identity_recheck_required');
  const note = text(input, 'note', 1000);
  const updated = await update(ctx, block, { status: 'resolved', note, resolved_by: ctx.actorId, resolved_at: ctx.now });
  await emit(ctx, 'block.resolved', { block_id: block.id, binding_id: binding.id });
  return updated;
}
