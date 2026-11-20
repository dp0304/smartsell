import type { Context, Data, Row } from '@smartsell/contracts';
import type { Adapter, ConnectionCtx, ExecutionReceipt, ExternalRef } from '../../../../../packages/adapters/src/official.js';
import { connectionContext, type AccountServices } from '../account/oauth.js';
import { getLicenseState } from '../ops/metering.js';
import { isJobPaused } from '../ops/controls.js';
import { POST, SLOT, after, find, time } from './service.js';
import type { Transact } from './worker.js';

export type PostMaintenanceServices = Pick<AccountServices, 'adapter' | 'encryptionKey' | 'oauthRedirectUri'>;
export const postMaintenanceStatuses = ['manual', 'queued', 'submitting', 'accepted', 'outcome_unknown'];

export function maintenanceConnection(ctx: Context, post: Row, kind: unknown, services?: PostMaintenanceServices) {
  if (!services || !['edit_caption', 'delete'].includes(String(kind)) || post.verification !== 'system_verified' || typeof post.external_post_id !== 'string') return;
  const account = find(ctx, 'social_account', post.social_account_id);
  if (account?.provider !== 'youtube' || account.status !== 'active' || typeof account.external_account_id !== 'string') return;
  const operation = kind === 'edit_caption' ? 'edit_post' : 'delete_post';
  const adapter = services.adapter?.('youtube');
  if (!adapter?.observeMaintenance || !adapter.staticMatrix().some(row => row.operation === operation && row.readiness === 'implemented' && row.executor === 'api')) return;
  for (const link of ctx.list('social_account_connection')) {
    if (link.status !== 'active' || link.social_account_id !== account.id) continue;
    const connection = find(ctx, 'connection', link.connection_id);
    if (connection?.provider !== 'youtube' || connection.status !== 'active' || (connection.expires_at && !(time(connection.expires_at) > time(ctx.now)))) continue;
    try {
      const auth = connectionContext(ctx, connection, services, account.external_account_id);
      if (!auth.scopes?.some(scope => ['https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.force-ssl'].includes(scope))) continue;
      const reference: ExternalRef = { kind: 'post', id: post.external_post_id, parentId: account.external_account_id };
      return { adapter, auth, reference, operation } as { adapter: Adapter; auth: ConnectionCtx; reference: ExternalRef; operation: 'edit_post' | 'delete_post' };
    } catch { /* Try another active, independently linked grant. */ }
  }
}

function finish(ctx: Context, row: Row, status: string, patch: Data = {}) {
  const slot = ctx.list(SLOT).find(value => value.holder_kind === 'post_operation' && value.holder_id === row.id && value.fencing_token === row.write_slot_fencing_token);
  if (slot) ctx.update(SLOT, slot.id, { holder_id: null, holder_kind: null, lease_expires_at: null });
  ctx.update('post_operation', row.id, { status, completed_at: ctx.now, ...patch });
  ctx.emit('execution.post_operation.completed', { post_operation_id: row.id, platform_post_id: row.platform_post_id, outcome: status });
}

export async function runPostMaintenance(transact: Transact, services: PostMaintenanceServices) {
  const ids = await transact(ctx => ctx.list('post_operation').filter(row => row.executor === 'api' && (
    row.status === 'queued' || row.status === 'submitting' && time(row.lease_expires_at) <= time(ctx.now) ||
    row.status === 'accepted' && time(row.next_check_at) <= time(ctx.now))).map(row => row.id));
  for (const id of ids) {
    const work = await transact(ctx => {
      const row = ctx.get('post_operation', id);
      if (row.status === 'submitting' && time(row.lease_expires_at) <= time(ctx.now)) {
        finish(ctx, row, 'outcome_unknown', { error_class: 'submission_interrupted' });
        return;
      }
      if (row.status !== 'queued' && (row.status !== 'accepted' || time(row.next_check_at) > time(ctx.now))) return;
      const post = ctx.get(POST, String(row.platform_post_id));
      const before = row.before_snapshot as Row;
      const binding = maintenanceConnection(ctx, post, row.kind, services);
      if (row.status === 'accepted') {
        if (time(row.lease_expires_at) <= time(ctx.now)) {
          finish(ctx, row, 'outcome_unknown', { error_class: 'verification_expired' });
          return;
        }
        const receipt = row.receipt as ExternalRef;
        ctx.update('post_operation', id, { next_check_at: after(ctx, 30) });
        if (binding && receipt.id === binding.reference.id && receipt.parentId === binding.reference.parentId) return { row, ...binding, observe: true };
        return;
      }
      const slot = ctx.list(SLOT).find(value => value.holder_kind === 'post_operation' && value.holder_id === id && value.fencing_token === row.write_slot_fencing_token);
      if (!slot || time(slot.lease_expires_at) <= time(ctx.now) || !binding || before.external_post_id !== post.external_post_id || before.post_status !== post.post_status || before.caption_snapshot !== post.caption_snapshot) {
        finish(ctx, row, 'failed', { error_class: 'precheck_blocked' });
        return;
      }
      if (['read_only', 'terminated'].includes(getLicenseState(ctx)) || isJobPaused(ctx, { queue: 'publish', task_kind: 'publish', provider: 'youtube', side_effect: true })) return;
      ctx.update('post_operation', id, { status: 'submitting', submission_started_at: ctx.now });
      return { row, ...binding, observe: false };
    });
    if (!work) continue;
    const { row, adapter, auth, reference, operation } = work;
    const caption = (row.after_payload as Data | undefined)?.caption;
    if (work.observe) {
      let result;
      try { result = await adapter.observeMaintenance?.(operation, reference, typeof caption === 'string' ? caption : undefined, auth); }
      catch { continue; }
      if (result !== 'verified') continue;
      await transact(ctx => {
        const current = ctx.get('post_operation', id);
        if (current.status !== 'accepted') return;
        const post = ctx.get(POST, String(row.platform_post_id));
        const before = row.before_snapshot as Row;
        if (before.external_post_id !== post.external_post_id || before.post_status !== post.post_status || before.caption_snapshot !== post.caption_snapshot) {
          finish(ctx, current, 'outcome_unknown', { error_class: 'post_changed_during_verification' });
          return;
        }
        const updated = ctx.update(POST, post.id, operation === 'delete_post' ? { post_status: 'deleted' } : { caption_snapshot: caption });
        if (operation === 'delete_post') ctx.emit('execution.platform_post.status_changed', { platform_post_id: post.id, post_status: 'deleted' });
        finish(ctx, current, 'verified', { verification: 'system_verified', after_snapshot: updated });
      });
      continue;
    }
    let receipt: ExecutionReceipt;
    try {
      receipt = await adapter.execute(operation, { postId: reference.id, caption }, { ...auth, credentialState: 'active', client_request_id: id,
        fencing_token: Number(row.write_slot_fencing_token), approval: { provider: 'youtube', externalAccountId: reference.parentId!, operation, clientRequestId: id } });
    } catch { receipt = { status: 'unknown' }; }
    await transact(ctx => {
      const current = ctx.get('post_operation', id);
      if (current.status !== 'submitting') return;
      if (receipt.status === 'accepted' && receipt.externalRef?.kind === 'post' && receipt.externalRef.id === reference.id && receipt.externalRef.parentId === reference.parentId) {
        ctx.update('post_operation', id, { status: 'accepted', receipt: reference, accepted_at: ctx.now, next_check_at: ctx.now });
        ctx.emit('execution.post_operation.accepted', { post_operation_id: id, platform_post_id: row.platform_post_id });
      } else {
        finish(ctx, current, receipt.status === 'failed' ? 'failed' : 'outcome_unknown', { error_class: receipt.error?.errorClass ?? 'receipt_unverified' });
      }
    });
  }
}
