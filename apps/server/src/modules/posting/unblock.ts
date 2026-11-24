import type { Context, Data, Row } from '@smartsell/contracts';
import { hasExecutionRisk, locate, time } from '../../../../../packages/domain/src/publishing/index.js';
import { approvalDeadline, channelSettings } from '../account/channel-settings.js';
import { applyChannelDefaults } from '../content/index.js';
import { resubmitIfWaiting, submit, updateTarget } from '../planning/index.js';
import { TARGET, problemCode, problemStatus } from './model.js';

/**
 * posting.unblock (phase1-design §7.2.6, §4.4): when the owner fixes what blocked an Agent-scheduled post, apply the channel
 * defaults to a new revision, point the target at it, then submit again. A direct channel approves at once; a needs_approval
 * channel gets a pending request.
 */

export const UNBLOCK_EVENTS: ReadonlySet<string> = new Set([
  'account.channel_settings.changed', 'account.automation_notice.acked', 'asset.version.created', 'account.binding.changed',
]);

/**
 * Posts the Agent scheduled (auto_submit_on_unblock) that are draft, or wait for approval without a valid pending request
 * (§4 common rule). E37: never changes_requested. That is the owner's 駁回 (or 'request changes'), which stands until someone
 * edits or reschedules the post with post_update or explicitly submits it again; a settings change must not bring it back.
 */
function waiting(ctx: Context, target: Row) {
  if (target.auto_submit_on_unblock !== true) return false;
  if (target.plan_status === 'draft') return true;
  if (target.plan_status !== 'awaiting_approval') return false;
  const request = locate(ctx, 'approval_request', target.approval_request_id);
  return !(request?.status === 'pending' && request.resource_id === target.id && time(request.due_at) > time(ctx.now));
}

function candidates(ctx: Context, type: string, payload: Data): Row[] {
  if (type === 'asset.version.created') {
    const assetId = payload.asset_id;
    const linked = new Set(ctx.list('publish_target_ref').filter(ref => ref.ref_type === 'asset' && ref.ref_id === assetId).map(ref => ref.publish_target_id));
    return ctx.list(TARGET).filter(target => {
      if (linked.has(target.id)) return true;
      const revision = locate(ctx, 'content_revision', target.variant_revision_id);
      return Array.isArray(revision?.media) && (revision.media as Data[]).some(item => item.asset_id === assetId);
    });
  }
  const accountId = payload.social_account_id;
  return typeof accountId === 'string' ? ctx.list(TARGET).filter(target => target.social_account_id === accountId) : [];
}

export async function applyUnblock(ctx: Context, event: Data) {
  const type = typeof event.type === 'string' ? event.type : '';
  if (!UNBLOCK_EVENTS.has(type)) return { resubmitted: 0 };
  const payload = (event.payload ?? event.data ?? {}) as Data;
  let resubmitted = 0;
  for (const candidate of candidates(ctx, type, payload)) {
    const target = ctx.get(TARGET, candidate.id);
    if (!waiting(ctx, target) || hasExecutionRisk(ctx, target)) continue;
    const settings = channelSettings(ctx, String(target.social_account_id));
    if (!settings) continue;
    // Past scheduled_at + lateness the post cannot go out any more; "改到…" (post_update reschedule) resubmits it.
    const deadline = approvalDeadline(ctx, target);
    if (deadline && time(deadline) <= time(ctx.now)) continue;
    try {
      const applied = await applyChannelDefaults(ctx, String(target.content_variant_id), settings.platform_defaults);
      let current = ctx.get(TARGET, target.id);
      if (applied.revision_id !== current.variant_revision_id) {
        updateTarget(ctx, current, { variant_revision_id: applied.revision_id });
        current = ctx.get(TARGET, target.id);
      }
      if (current.plan_status === 'awaiting_approval') resubmitIfWaiting(ctx, current.id);
      else if (current.plan_status === 'draft') submit(ctx, current);
      resubmitted++;
    } catch (error) {
      // One post that cannot move (edited meanwhile, now final) must not hold back the others; the event is not retried for it.
      if (!problemCode(error) || problemStatus(error) >= 500) throw error;
    }
  }
  return { resubmitted };
}

export const unblockSubscriber = {
  id: 'posting.unblock',
  accepts: (type: string) => UNBLOCK_EVENTS.has(type),
  run: (ctx: Context, event: Data) => applyUnblock(ctx, event),
};
