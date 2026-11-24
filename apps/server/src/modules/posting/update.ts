import { Problem, renderCaption, type Context, type Data, type Row } from '@smartsell/contracts';
import { locate } from '../../../../../packages/domain/src/publishing/index.js';
import { commitVariantRevision } from '../content/index.js';
import { cancel, resubmitIfWaiting, submit, updateTarget } from '../planning/index.js';
import { TARGET, latestJob, postStatus, problemCode, webUrl, workspaceZone } from './model.js';
import { agentPost, type AgentPost } from './posts.js';
import { resolveWhen } from './schedule.js';
import { parseOperationBody } from './schemas.js';

/** hub_posts_update (phase1-design §7.2.7, §5.14 table). */

export interface UpdateResult { post: AgentPost; approval_retained: boolean; changes: string[] }

const FINAL_PLAN = ['cancelled', 'superseded', 'closed'];

function guard(ctx: Context, target: Row) {
  const job = latestJob(ctx, target);
  const status = postStatus(ctx, target, job);
  const url = webUrl(ctx, 'post', target.id);
  if (status === 'published' || status === 'cancelled' || FINAL_PLAN.includes(String(target.plan_status))) {
    throw new Problem(409, 'POST_FINAL', 'Final. Use post_schedule to post again.', { status, web_url: url });
  }
  if (status === 'unknown') {
    throw new Problem(409, 'POST_RESULT_UNKNOWN', 'The result is unknown. Ask the owner to confirm published or not published at web_url.',
      { status, web_url: url, owner_message: '結果不明，請主人先在貼文頁確認已發或未發。' });
  }
  if (job && (job.status === 'submitting' || job.status === 'result_pending')) {
    throw new Problem(409, 'POST_LOCKED', 'Publishing is in progress; wait for the result.', { status, web_url: url, owner_message: '正在發布中，無法修改；請等結果。' });
  }
  return status;
}

/** The planning edit guard answers LEASE_HELD once a Worker may have started; the Agent sees POST_LOCKED (§5.2). */
function locked<T>(ctx: Context, target: Row, run: () => T): T {
  try { return run(); } catch (error) {
    if (problemCode(error) === 'LEASE_HELD') {
      throw new Problem(409, 'POST_LOCKED', 'Publishing is in progress; wait for the result.', { web_url: webUrl(ctx, 'post', target.id), owner_message: '正在發布中，無法修改；請等結果。' });
    }
    throw error;
  }
}

/** §4 common rule: a post that lost its approval is resubmitted at once (direct approves, needs_approval waits for the owner). */
function resubmit(ctx: Context, targetId: string) {
  const current = ctx.get(TARGET, targetId);
  if (current.plan_status === 'awaiting_approval') return resubmitIfWaiting(ctx, targetId);
  if (current.plan_status === 'draft' || current.plan_status === 'changes_requested') return submit(ctx, current);
  return current;
}

export async function updatePost(ctx: Context, postId: string, body: unknown): Promise<UpdateResult> {
  const args = parseOperationBody('hub_posts_update', body);
  const target = locate(ctx, TARGET, postId);
  if (!target) throw new Problem(404, 'POST_NOT_FOUND', `Unknown post_id ${postId}. Read post_id from post_schedule or posts_list.`);
  guard(ctx, target);
  if (args.action === 'cancel') {
    const result = cancel(ctx, target, args.reason) as Data;
    void result;
    return { post: agentPost(ctx, ctx.get(TARGET, target.id)), approval_retained: false, changes: ['cancelled'] };
  }
  if (args.action === 'reschedule') {
    // E39: like post_schedule and the tool schema, an omitted timezone means the workspace time zone, not the post's own zone.
    const zone = args.timezone ?? workspaceZone(ctx);
    // updateTarget refuses any time before now, so no tolerance for a past minute here.
    const when = resolveWhen(ctx, args.when!, zone, args.dst_choice, 0);
    const updated = locked(ctx, target, () => updateTarget(ctx, target, when.fields, true));
    if (!updated.approval_retained) resubmit(ctx, target.id);
    return { post: agentPost(ctx, ctx.get(TARGET, target.id)), approval_retained: updated.approval_retained, changes: ['scheduled_at'] };
  }
  const caption = args.caption!;
  const rendered = renderCaption(caption.text, caption.tags ?? []);
  const committed = await commitVariantRevision(ctx, String(target.content_variant_id), { body: rendered });
  if (!committed.changed) return { post: agentPost(ctx, target), approval_retained: true, changes: [] };
  const updated = locked(ctx, target, () => updateTarget(ctx, ctx.get(TARGET, target.id), { variant_revision_id: committed.revision_id }));
  if (!updated.approval_retained) resubmit(ctx, target.id);
  return { post: agentPost(ctx, ctx.get(TARGET, target.id)), approval_retained: updated.approval_retained, changes: ['caption'] };
}
