import { LOGIN_CHECK_MAX_AGE_H, Problem, renderCaption, type Context, type Data, type Row } from '@smartsell/contracts';
import { channelMediaRule, digest, locate, platformKey, resolveLocal, time } from '../../../../../packages/domain/src/publishing/index.js';
import { ensureChannelSettings, workerEngine } from '../account/channel-settings.js';
import { applyChannelDefaults, createItem } from '../content/index.js';
import { commandContext } from '../content/operations.js';
import { createTarget, submit, targetValues } from '../planning/index.js';
import {
  TARGET, agentCredential, channelMachine, effectiveModeFor, fromAgent, hasDriver, isHubProvider, liveCheckLoginJob, localText,
  loginCheckedAt, mcpProvider, platformPostFor, problemCode, validZone, webUrl, workspaceZone,
} from './model.js';
import { agentPost, type AgentPost, type PostWarning } from './posts.js';
import { invalidArguments, parseOperationBody, type ToolArgs } from './schemas.js';

/** hub_posts_schedule (phase1-design §7.2.6). One Operation transaction: any Problem rolls the whole call back. */

const REQUEST = 'posting_request';
const REPLAY_MS = 15 * 60_000;
const KEEP_MS = 24 * 3_600_000;
/** Warnings made by the scheduling call itself (Appendix C.4); precheck risks and machine warnings are recomputed on replay. */
const SCHEDULE_WARNINGS = ['caption_empty', 'caption_title_ignored', 'login_check_unavailable'];

type ScheduleArgs = ToolArgs<'post_schedule'>;
type Caption = NonNullable<NonNullable<ScheduleArgs['captions']>['default']>;
export interface ScheduleResult { content_id: string; content_ids?: string[]; replayed: boolean; posts: AgentPost[]; web_url: string }

const problem = (status: number, code: string, message: string, details?: Data) => new Problem(status, code, message, details);

// ---------- Time (§7.2.6 server rules) ----------

export interface ResolvedTime { scheduled_at: string; fields: Data; zone: string }

/** Resolves `when` in `zone` into the planning schedule fields; maps DST and past-time cases to the Appendix C codes. */
export function resolveWhen(ctx: Context, when: string, zone: string, dstChoice?: string, pastToleranceMs = 60_000): ResolvedTime {
  if (!validZone(zone)) throw problem(422, 'TIMEZONE_INVALID', `Unknown time zone '${zone}'. Use an IANA name such as Asia/Shanghai, or omit timezone for the workspace time zone.`, { timezone: zone });
  if (when === 'now') {
    const scheduled_at = new Date(time(ctx.now) + 30_000).toISOString();
    return { scheduled_at, zone, fields: { schedule_kind: 'exact', scheduled_at, schedule_tz: zone } };
  }
  const local = when.replace(' ', 'T');
  let resolved: { scheduled_at: string };
  try {
    resolved = resolveLocal(local, zone, dstChoice);
  } catch (error) {
    const failure = problemCode(error);
    if (!failure) throw error;
    if (failure === 'DST_FOLD') throw problem(422, 'TIME_AMBIGUOUS', `${when} happens twice in ${zone} (clock change). Pass dst_choice.`, { dst_choice: ['earlier_occurrence', 'later_occurrence'] });
    if (failure === 'DST_GAP') throw problem(422, 'TIME_NONEXISTENT', `${when} does not exist in ${zone} (clock change). Pass dst_choice "shift_forward" or pick another time.`, { dst_choice: ['shift_forward'] });
    throw invalidArguments([{ path: 'when', code: 'invalid_date', message: `when: ${when} is not a valid date and time` }]);
  }
  if (time(resolved.scheduled_at) < time(ctx.now) - pastToleranceMs) {
    throw problem(422, 'TIME_IN_PAST', `${when} ${zone} is in the past (now ${localText(ctx.now, zone)}). Use a later time or "now".`,
      { now_local: localText(ctx.now, zone), timezone: zone });
  }
  return { scheduled_at: resolved.scheduled_at, zone,
    fields: { schedule_kind: 'exact', local_scheduled_at: local, schedule_tz: zone, ...(dstChoice ? { dst_choice: dstChoice } : {}) } };
}

// ---------- Channels and media ----------

function resolveChannels(ctx: Context, ids: readonly string[]): Row[] {
  const accounts = ids.map(id => locate(ctx, 'social_account', id));
  const missing = ids.filter((_, index) => { const account = accounts[index]; return !account || account.status !== 'active' || !isHubProvider(account.provider); });
  if (missing.length) {
    throw problem(422, 'CHANNEL_NOT_FOUND', `Unknown or inactive channel_id ${missing.join(', ')}. Call channels_list.`, { channel_ids: missing, hint: 'call channels_list' });
  }
  return accounts as Row[];
}

export interface ResolvedMedia { asset: Row; version: Row; kind: 'video' | 'image' | 'other'; filename: string }

export function resolveMedia(ctx: Context, ids: readonly string[]): ResolvedMedia[] {
  const missing: string[] = [];
  const failed: Data[] = [];
  const media = ids.flatMap(id => {
    const asset = locate(ctx, 'asset', id);
    const version = asset && (locate(ctx, 'asset_version', asset.current_version_id)
      ?? ctx.list('asset_version').filter(row => row.asset_id === asset.id).sort((a, b) => Number(b.version_no ?? 0) - Number(a.version_no ?? 0))[0]);
    if (!asset || !version || asset.deleted_at || asset.archived_at) { missing.push(id); return []; }
    if (asset.status === 'failed') { failed.push({ media_id: id, reason: (asset.failure as Data | undefined)?.code ?? 'failed' }); return []; }
    const mime = String(version.mime_type ?? '');
    const kind = asset.kind === 'video' || asset.kind === 'image' ? asset.kind as 'video' | 'image'
      : mime.startsWith('video/') ? 'video' as const : mime.startsWith('image/') ? 'image' as const : 'other' as const;
    const file = locate(ctx, 'file_object', version.file_object_id);
    return [{ asset, version, kind, filename: String(file?.original_filename ?? asset.title ?? 'media') }];
  });
  if (missing.length) throw problem(422, 'MEDIA_NOT_FOUND', `Unknown media_id ${missing.join(', ')}. Use the media_id returned by media_upload.`, { media_ids: missing });
  if (failed.length) throw problem(422, 'MEDIA_FAILED', `Media ${failed.map(row => row.media_id).join(', ')} failed to upload or process. Upload the file again with media_upload.`, { media: failed });
  return media;
}

/** §7.2.6 media rules; returns the content format. */
function mediaFormat(accounts: readonly Row[], media: readonly ResolvedMedia[]): 'short_video' | 'feed_image' {
  const kinds = media.map(item => item.kind);
  const mixed = new Set(kinds).size > 1 || kinds.includes('other');
  const reasons = accounts.flatMap(account => {
    const reason = mixed ? 'Videos and images cannot be mixed in one post.' : channelMediaRule(account.provider, kinds);
    return reason ? [{ channel_id: account.id, provider: mcpProvider(account.provider), reason }] : [];
  });
  if (reasons.length) {
    throw problem(422, 'MEDIA_NOT_SUPPORTED', 'X takes 1 video or 1–4 images; TikTok takes exactly 1 video. ' +
      reasons.map(row => `${row.provider} ${row.channel_id}: ${row.reason}`).join(' '), { channels: reasons });
  }
  return kinds[0] === 'image' ? 'feed_image' : 'short_video';
}

// ---------- Login check (§5.12) ----------

function loginCheck(ctx: Context, account: Row): { checkTaskId: string | null; warning?: PostWarning } {
  const { device } = channelMachine(ctx, account.id);
  if (!hasDriver(account.provider) || !device || effectiveModeFor(ctx, account) === 'owner') return { checkTaskId: null };
  const checked = loginCheckedAt(ctx, account.id);
  if (checked && time(ctx.now) - time(checked) < LOGIN_CHECK_MAX_AGE_H * 3_600_000) return { checkTaskId: null };
  const live = liveCheckLoginJob(ctx, account.id);
  if (live) return { checkTaskId: live.id };
  try {
    return { checkTaskId: workerEngine().createCheckLoginJob(ctx, account.id, { openLoginWindow: false }).id };
  } catch (error) {
    // The job engine is a separate module; without it the post is still scheduled and the reason is reported, never faked.
    if (problemCode(error) === 'WORKER_ENGINE_UNAVAILABLE') {
      return { checkTaskId: null, warning: { code: 'login_check_unavailable', message: 'The login check could not be queued: the hub has no Worker job engine running.' } };
    }
    throw error;
  }
}

// ---------- Dedupe (§7.2.6 step 2) ----------

function requestKey(ctx: Context, args: ScheduleArgs) {
  const { request_id, ...rest } = args;
  const credential = agentCredential(ctx) ?? null;
  const argsHash = digest(rest);
  const key = request_id ? digest(['post_schedule', ctx.actorId, credential, 'request', request_id]) : digest(['post_schedule', ctx.actorId, credential, 'args', argsHash]);
  return { key, argsHash };
}

/**
 * F5: a replay answers with each post's current state, never the snapshot stored at creation (a cancelled post is reported
 * cancelled, an unblocked one scheduled). When every stored post was cancelled, the same call is a new request: the stored
 * record is dropped and the posts are scheduled anew. Anything else (scheduled, published, unknown…) is never posted twice.
 */
function replay(ctx: Context, key: string, argsHash: string): ScheduleResult | undefined {
  const now = time(ctx.now);
  for (const row of ctx.list(REQUEST)) if (now - time(row.created_at) > KEEP_MS) ctx.remove(REQUEST, row.id);
  const matching = ctx.list(REQUEST).filter(row => row.dedupe_key === key && now - time(row.created_at) <= REPLAY_MS)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const prior = matching[0];
  if (!prior) return undefined;
  if (prior.args_hash !== argsHash) {
    throw problem(422, 'IDEMPOTENCY_MISMATCH', 'This request_id was already used for different arguments. Use a new request_id for a new request.');
  }
  const stored = prior.result as ScheduleResult;
  const targets = (Array.isArray(prior.target_ids) ? prior.target_ids as unknown[] : stored.posts.map(post => post.post_id)).map(id => locate(ctx, TARGET, id));
  if (targets.length && targets.every(target => target?.plan_status === 'cancelled' && !platformPostFor(ctx, target.id))) {
    for (const row of matching) ctx.remove(REQUEST, row.id);
    return undefined;
  }
  const posts = stored.posts.map((post, index) => {
    const target = targets[index]?.id === post.post_id ? targets[index] : locate(ctx, TARGET, post.post_id);
    // Warnings computed at scheduling (caption_empty…) and the login check it queued stay; status and approval are current.
    const warnings = post.warnings.filter(warning => SCHEDULE_WARNINGS.includes(warning.code));
    return target ? agentPost(ctx, target, { checkTaskId: post.login?.check_task_id ?? null, warnings }) : post;
  });
  return { ...stored, posts, replayed: true };
}

// ---------- The operation ----------

function chosenCaption(args: ScheduleArgs, account: Row): Caption | undefined {
  const captions = args.captions as Record<string, Caption | undefined> | undefined;
  return captions?.[mcpProvider(account.provider)] ?? captions?.default;
}

export async function schedulePosts(ctx: Context, body: unknown): Promise<ScheduleResult> {
  const args = parseOperationBody('hub_posts_schedule', body);
  const { key, argsHash } = requestKey(ctx, args);
  const replayed = replay(ctx, key, argsHash);
  if (replayed) return replayed;

  const accounts = resolveChannels(ctx, args.channel_ids);
  const media = resolveMedia(ctx, args.media_ids);
  const format = mediaFormat(accounts, media);
  const zone = args.timezone ?? workspaceZone(ctx);
  const when = resolveWhen(ctx, args.when, zone, args.dst_choice);

  const captions = new Map<string, { body: string; warnings: PostWarning[]; title?: string }>();
  for (const account of accounts) {
    const chosen = chosenCaption(args, account);
    const rendered = chosen ? renderCaption(chosen.text, chosen.tags ?? []) : '';
    const warnings: PostWarning[] = [];
    // Never invented: without an owner-given caption the post goes out without text (§7.2.6).
    if (!rendered) warnings.push({ code: 'caption_empty', message: 'Scheduled without text because no caption was given.' });
    if (chosen?.title && mcpProvider(account.provider) !== 'youtube') warnings.push({ code: 'caption_title_ignored', message: 'title is used by YouTube only; it was ignored for this channel.' });
    captions.set(account.id, { body: rendered, warnings, ...(chosen?.title && mcpProvider(account.provider) === 'youtube' && { title: chosen.title }) });
  }
  const firstText = (args.captions?.default ?? Object.values(args.captions ?? {})[0] as Caption | undefined)?.text?.trim();
  const title = (args.plan_tag ?? (firstText ? [...firstText].slice(0, 60).join('') : undefined) ?? media[0]!.filename).trim() || 'Post';

  // Group by brand: one content item (with one variant per channel) per brand (§7.2.6 step 4).
  const groups = new Map<string, Row[]>();
  for (const account of accounts) {
    if (typeof account.brand_id !== 'string' || !account.brand_id) {
      throw problem(409, 'INVALID_STATE', `Channel ${account.id} has no brand; the owner must finish setting it up in the web app.`, { web_url: webUrl(ctx, 'channel', account.id) });
    }
    groups.set(account.brand_id, [...groups.get(account.brand_id) ?? [], account]);
  }
  const mediaInput = media.map(item => ({ asset_id: item.asset.id, asset_version_id: item.version.id, role: 'primary' }));
  const variants = new Map<string, string>();
  const contentIds: string[] = [];
  for (const [brand, group] of groups) {
    // body and media sit at the top of each variant: draftFor reads only top-level body/media (content/model.ts).
    const created = await createItem(commandContext(ctx), {
      brand_id: brand, title,
      variants: group.map(account => ({ platform: platformKey(account.provider), format, social_account_id: account.id,
        body: captions.get(account.id)!.body, media: mediaInput })),
    }, { agent: fromAgent(ctx), initialize: true });
    contentIds.push(created.item.id);
    group.forEach((account, index) => variants.set(account.id, created.variants[index]!.id));
  }

  const posts: AgentPost[] = [];
  for (const account of accounts) {
    const settings = ensureChannelSettings(ctx, account.id);
    const variantId = variants.get(account.id)!;
    await applyChannelDefaults(ctx, variantId, settings.platform_defaults);
    const login = loginCheck(ctx, account);
    const caption = captions.get(account.id)!;
    const values = targetValues(ctx, {
      social_account_id: account.id, content_variant_id: variantId, ...when.fields,
      late_policy: 'skip', grace_minutes: settings.lateness_limit_min, visibility: 'public', operation: 'publish',
    });
    const target = createTarget(ctx, values, {
      origin: 'agent_tool', plan_tag: args.plan_tag ?? null, created_by_tool: 'post_schedule', auto_submit_on_unblock: true,
      posting_request_key: key, ...(caption.title && { youtube_title: caption.title }),
    });
    submit(ctx, ctx.get(TARGET, target.id));
    posts.push(agentPost(ctx, ctx.get(TARGET, target.id), {
      checkTaskId: login.checkTaskId, warnings: [...caption.warnings, ...(login.warning ? [login.warning] : [])],
    }));
  }
  const result: ScheduleResult = {
    content_id: contentIds[0]!, ...(contentIds.length > 1 && { content_ids: contentIds }), replayed: false, posts,
    web_url: webUrl(ctx, 'calendar', posts[0]!.post_id, when.scheduled_at),
  };
  ctx.create(REQUEST, { dedupe_key: key, args_hash: argsHash, request_id: args.request_id ?? null, actor_id: ctx.actorId,
    credential_id: agentCredential(ctx) ?? null, target_ids: posts.map(post => post.post_id), result });
  ctx.emit('posting.posts.scheduled', { content_ids: contentIds, target_ids: posts.map(post => post.post_id), via_agent: fromAgent(ctx) });
  return result;
}
