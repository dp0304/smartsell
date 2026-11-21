import type { Context as RestContext, Operation } from '@smartsell/contracts';
import { admins, readers, writers, type Command, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { array, choice, emit, fail, get, hash, id, ids, insert, kinds, list, machineActor, object, optionalText, pick, requireVersion, stages, text, update, webUrl } from './model.ts';
import { activeItem, autosave, commit, createVariant, currentRevision, diffRevisions, handleContentEvent, insertProductFact, insertProductPrice, prepareEdit, revisionFor, setReadiness, variantFor } from './revisions.ts';
import { laterCommands, recordFeedItems as recordNormalizedFeedItems } from './later.ts';
import { applyContentEvent as applyReferenceEvent, commandContext, contentAcceptsEvent as acceptsReferenceEvent, makeOperations } from './operations.ts';
import { fetchFeed, parseFeed, type FeedTransport } from './feed-worker.js';
import { assetPermitted, factChoices, validate } from './validation.ts';
import { priceChoices } from './product-prices.ts';
import { libraryCommands } from '../asset/command-library.ts';

const read = (run: Command['run']): Command => ({ roles: readers, run });
const write = (run: Command['run']): Command => ({ roles: writers, run });
const manage = (run: Command['run']): Command => ({ roles: admins, run });
const ideaStatuses = ['open', 'discussing', 'accepted', 'parked', 'rejected'];
const origins = ['observation', 'customer_question', 'competitor_ref', 'product_point', 'monitoring', 'rss', 'agent', 'other', 'import'];
const itemFields = ['brand_id', 'campaign_id', 'pillar_id', 'idea_id', 'title', 'owner_user_id', 'production_due_at', 'blocked_reason'];
const pillarFields = ['brand_id', 'name', 'description', 'audience_note', 'target_share', 'evergreen'];
const ideaFields = ['brand_id', 'pillar_id', 'campaign_id', 'title', 'hypothesis', 'objective', 'audience_note', 'origin', 'origin_refs', 'observed_at', 'status', 'priority', 'tags'];
const stageTransitions: Record<string, string[]> = {
  accepted: ['drafting', 'archived'], drafting: ['design', 'awaiting_assets', 'internal_review'], design: ['awaiting_assets', 'internal_review'],
  awaiting_assets: ['design'], internal_review: ['drafting', 'ready'], ready: ['drafting', 'archived'], archived: [],
};

function date(value: unknown, field: string) {
  if (value == null) return null;
  const raw = text(value, field);
  if (!Number.isFinite(Date.parse(raw))) fail('invalid_input', `Invalid ${field}`);
  return new Date(raw).toISOString();
}
function metadata(input: Fields, keys: string[]) {
  const patch = pick(input, keys);
  for (const key of keys) {
    if (!Object.hasOwn(patch, key)) continue;
    if (['brand_id', 'name', 'title'].includes(key)) patch[key] = text(patch[key], key, 240);
    else if (key.endsWith('_at')) patch[key] = date(patch[key], key);
    else if (key.endsWith('_id')) patch[key] = optionalText(patch[key], key);
  }
  return patch;
}
async function checkPillar(ctx: Context, value: Fields) {
  if (!value.pillar_id) return;
  const pillar = await get(ctx, kinds.pillar, value.pillar_id);
  if (pillar.data.archived_at || pillar.data.brand_id !== value.brand_id) fail('invalid_input', 'Pillar must be active and belong to the selected brand');
}
async function savePillar(ctx: Context, input: Fields, existing?: Entity) {
  const patch = metadata(input, pillarFields);
  const data = { ...existing?.data, ...patch };
  text(data.brand_id, 'brand_id'); text(data.name, 'name');
  if (existing && patch.brand_id && patch.brand_id !== existing.data.brand_id) fail('invalid_input', 'Pillar brand cannot be changed');
  if (data.target_share != null && (!Number.isFinite(data.target_share) || data.target_share < 0 || data.target_share > 100)) fail('invalid_input', 'Invalid target_share');
  if (data.evergreen != null && typeof data.evergreen !== 'boolean') fail('invalid_input', 'Invalid evergreen');
  if ((await list(ctx, kinds.pillar)).some(row => row.id !== existing?.id && row.data.brand_id === data.brand_id && row.data.name === data.name)) fail('duplicate_pillar', 'Pillar already exists', 409);
  return existing ? update(ctx, existing, patch) : insert(ctx, kinds.pillar, { evergreen: false, ...patch });
}
async function saveIdea(ctx: Context, input: Fields, existing?: Entity) {
  const patch = metadata(input, ideaFields);
  const data = { ...existing?.data, ...patch };
  text(data.brand_id, 'brand_id'); text(data.title, 'title');
  await checkPillar(ctx, data);
  if (!existing || patch.origin !== undefined) patch.origin = choice(data.origin ?? 'observation', 'origin', origins);
  if (!existing || patch.status !== undefined) patch.status = choice(data.status ?? 'open', 'status', ideaStatuses);
  if (patch.origin_refs !== undefined) patch.origin_refs = array(patch.origin_refs, 'origin_refs').map(value => {
    const ref = object(value, 'origin_ref');
    const type = text(ref.type, 'origin_ref.type');
    if (!ref.url && !ref.id) fail('invalid_input', 'An evidence reference requires an ID or URL');
    return { type, ...(ref.url ? { url: webUrl(ref.url) } : {}), ...(ref.id ? { id: text(ref.id, 'origin_ref.id') } : {}), ...(ref.author ? { author: text(ref.author, 'author', 300) } : {}) };
  });
  if ((!existing || patch.origin_refs !== undefined) && !(patch.origin_refs?.length > 0)) fail('invalid_input', 'Attach at least one evidence reference');
  if (patch.tags !== undefined) patch.tags = ids(patch.tags, 'tags');
  if (existing) return update(ctx, existing, patch);
  const idea = await insert(ctx, kinds.idea, { tags: [], ...patch });
  await emit(ctx, 'idea.created', { idea_id: idea.id });
  return idea;
}
async function recordStage(ctx: Context, item: Entity, from: string | null, to: string, note?: string | null) {
  await insert(ctx, kinds.stage, { content_item_id: item.id, from_stage: from, to_stage: to, changed_by_type: 'user', changed_by_id: ctx.actorId, changed_at: ctx.now, note: note ?? null });
}
export async function createItem(ctx: Context, input: Fields, options: { agent?: boolean; initialize?: boolean; lineage?: Fields } = {}) {
  const data = metadata(input, itemFields);
  data.brand_id = text(data.brand_id, 'brand_id');
  data.title = text(data.title, 'title', 240);
  await checkPillar(ctx, data);
  if (data.idea_id && (await get(ctx, kinds.idea, data.idea_id)).data.brand_id !== data.brand_id) fail('invalid_input', 'Idea must belong to the selected brand');
  const variants = input.variants === undefined ? [] : array(input.variants, 'variants', 50).map(value => object(value, 'variant'));
  const item = await insert(ctx, kinds.item, { ...data, ...options.lineage, production_stage: 'accepted' });
  await recordStage(ctx, item, null, 'accepted');
  await emit(ctx, 'item.created', { content_item_id: item.id });
  const results = [];
  for (const variant of variants) results.push(await createVariant(ctx, item, variant, options));
  const tasks = [];
  if (input.tasks !== undefined) {
    for (const entry of array(input.tasks, 'tasks', 50)) {
      const task = object(entry, 'production task');
      const assignee = optionalText(task.assignee_id ?? task.assignee_user_id, 'assignee_id');
      const created = await ctx.insert('workspace', 'work_item', {
        type: 'production_task', kind: 'production_task', resource_type: kinds.item, resource_id: item.id,
        subject_ref: { module: 'content', kind: kinds.item, id: item.id }, title: text(task.title, 'task.title', 240),
        brand_id: item.data.brand_id, campaign_id: item.data.campaign_id ?? null, priority: 'normal', status: 'open',
        assignee_id: assignee, assignee_type: assignee ? 'user' : null, due_at: date(task.due_at, 'due_at'),
        blocked_reason: optionalText(task.blocked_reason, 'blocked_reason', 1000), created_by_id: ctx.actorId, source_type: 'manual',
      });
      tasks.push(created);
      await ctx.emit('workspace.work_item.created', { work_item_id: created.id });
      if (assignee) await ctx.emit('workspace.work_item.assigned', { work_item_id: created.id, assignee_id: assignee });
    }
  }
  return { item, variants: results.map(row => row.variant), revisions: results.flatMap(row => row.revision ? [row.revision] : []), tasks };
}
function matches(data: Fields, input: Fields, fields: string[]) {
  return fields.every(field => input[field] == null || data[field] === input[field]);
}
async function listItems(ctx: Context, input: Fields) {
  const variants = await list(ctx, kinds.variant);
  return (await list(ctx, kinds.item)).filter(item => matches(item.data, input, ['brand_id', 'campaign_id', 'pillar_id', 'production_stage', 'owner_user_id']) &&
    (!['platform', 'locale', 'readiness'].some(field => input[field] != null) || variants.some(variant => variant.data.content_item_id === item.id && matches(variant.data, input, ['platform', 'locale', 'readiness']))));
}
async function listIdeas(ctx: Context, input: Fields) {
  const ideas = (await list(ctx, kinds.idea)).filter(row => matches(row.data, input, ['brand_id', 'pillar_id', 'campaign_id', 'origin', 'status']) &&
    (!input.tag || row.data.tags?.includes(input.tag)));
  if (input.sort === undefined) return ideas;
  if (input.sort !== 'historical_engagement') fail('invalid_input', 'Invalid idea sort');
  const brand = text(input.brand_id, 'brand_id');
  const items = new Map((await list(ctx, kinds.item)).filter(row => row.data.brand_id === brand && row.data.idea_id).map(row => [row.id, row.data.idea_id]));
  const variants = new Map((await list(ctx, kinds.variant)).map(row => [row.id, row.data.content_item_id]));
  const revisions = new Map((await list(ctx, kinds.revision)).map(row => [row.id, row.data.variant_id]));
  const itemFor = (row: Fields) => row.content_item_id ?? variants.get(row.content_variant_id ?? row.variant_id ??
    revisions.get(row.variant_revision_id ?? row.content_revision_id ?? row.revision_id));
  const targets = new Map((await list(ctx, 'publish_target', 'planning')).map(row => [row.id, itemFor(row.data)]));
  const posts = new Map<string, string>();
  for (const post of await list(ctx, 'platform_post', 'execution')) {
    const idea = items.get(itemFor(post.data) ?? targets.get(post.data.publish_target_id ?? post.data.target_id));
    if (idea) posts.set(post.id, idea);
  }
  const latestByPost = new Map<string, { value: number; at: number }>();
  for (const observation of await list(ctx, 'metric_observation', 'analytics')) {
    const row = observation.data;
    const at = Date.parse(row.observed_at);
    if (!posts.has(row.subject_id) || row.subject_type !== 'platform_post' || row.metric_key !== 'norm.post.engagements' ||
        row.availability !== 'observed' || row.rolled_back || row.period_kind !== 'lifetime' || !Number.isFinite(at) || at > Date.parse(ctx.now) ||
        !Number.isFinite(row.value) || row.value < 0) continue;
    if ((latestByPost.get(row.subject_id)?.at ?? -Infinity) < at) latestByPost.set(row.subject_id, { value: row.value, at });
  }
  const scoreByIdea = new Map<string, { total: number; posts: number }>();
  for (const [post, point] of latestByPost) {
    const idea = posts.get(post)!;
    const score = scoreByIdea.get(idea) ?? { total: 0, posts: 0 };
    scoreByIdea.set(idea, { total: score.total + point.value, posts: score.posts + 1 });
  }
  return ideas.map(idea => {
    const score = scoreByIdea.get(idea.id);
    return { ...idea, data: { ...idea.data, historical_engagement: score ? { mean: score.total / score.posts, observed_post_count: score.posts } : null } };
  }).sort((a, b) => (b.data.historical_engagement?.mean ?? -1) - (a.data.historical_engagement?.mean ?? -1) || a.id.localeCompare(b.id));
}
async function variantDetail(ctx: Context, variant: Entity) {
  const revision = await currentRevision(ctx, variant);
  const revisions = (await list(ctx, kinds.revision)).filter(row => row.data.variant_id === variant.id);
  const revisionIds = new Set(revisions.map(row => row.id));
  const refs = revision ? (await list(ctx, kinds.reference)).filter(ref => ref.data.revision_id === revision.id) : [];
  const related = (await list(ctx, 'publish_target', 'planning')).filter(target => [target.data.content_revision_id, target.data.variant_revision_id].some(revisionId => revisionIds.has(revisionId)) || [target.data.variant_id, target.data.content_variant_id].includes(variant.id));
  const validation = await validate(ctx, variant.data, variant.data.draft_doc);
  const link = (await list(ctx, kinds.translation)).find(row => row.data.target_variant_id === variant.id);
  const source = link && await get(ctx, kinds.variant, link.data.source_variant_id);
  return { variant, current_revision: revision, revisions: revisions.sort((a, b) => b.data.revision_no - a.data.revision_no), references: refs, publish_targets: related,
    translation_link: link ?? null, translation_source_revision_id: source?.data.current_revision_id ?? null, ...validation };
}
function taskContentItem(data: Fields) {
  if (data.resource_type === kinds.item && data.resource_id) return data.resource_id;
  if (data.subject_ref?.kind === kinds.item) return data.subject_ref.id;
}

async function productionWorkload(ctx: Context, input: Fields) {
  if (machineActor(ctx)) fail('forbidden', 'Production workload is available to workspace members', 403);
  const { owner_user_id, ...itemFilters } = input;
  const items = new Set((await listItems(ctx, itemFilters)).filter(item => item.data.production_stage !== 'archived').map(item => item.id));
  const workload = new Map<string | null, { owner_user_id: string | null; outstanding: number; blocked: number; overdue: number }>();
  for (const { data } of await list(ctx, 'work_item', 'workspace')) {
    if (!items.has(taskContentItem(data)) || (data.kind ?? data.type) !== 'production_task' || ['done', 'cancelled'].includes(data.status)) continue;
    const owner = (!data.assignee_type || data.assignee_type === 'user') ? data.assignee_id ?? null : null;
    if (owner_user_id != null && owner_user_id !== owner) continue;
    const entry = workload.get(owner) ?? { owner_user_id: owner, outstanding: 0, blocked: 0, overdue: 0 };
    entry.outstanding++;
    if (data.status === 'blocked' || data.blocked_reason) entry.blocked++;
    if (Date.parse(data.due_at) < Date.parse(ctx.now)) entry.overdue++;
    workload.set(owner, entry);
  }
  return [...workload.values()].sort((a, b) => b.outstanding - a.outstanding || (a.owner_user_id ?? '').localeCompare(b.owner_user_id ?? ''));
}

async function itemDetail(ctx: Context, item: Entity) {
  const variants = (await list(ctx, kinds.variant)).filter(variant => variant.data.content_item_id === item.id);
  const stages = (await list(ctx, kinds.stage)).filter(entry => entry.data.content_item_id === item.id);
  const tasks = (await list(ctx, 'work_item', 'workspace')).filter(entry => taskContentItem(entry.data) === item.id &&
    (!machineActor(ctx) || [entry.data.assignee_id, entry.data.created_by_id].includes(ctx.actorId)));
  const details = await Promise.all(variants.map(variant => variantDetail(ctx, variant)));
  const targetIds = new Set(details.flatMap(detail => detail.publish_targets.map(target => target.id)));
  const variantIds = new Set(variants.map(variant => variant.id));
  const revisionIds = new Set((await list(ctx, kinds.revision)).filter(row => variantIds.has(row.data.variant_id)).map(row => row.id));
  const tasksById = new Map((await list(ctx, 'execution_task', 'execution')).map(task => [task.id, task.data]));
  const tasksByPost = new Map([...tasksById.values()].filter(task => task.platform_post_id).map(task => [task.platform_post_id, task]));
  const platformPosts = (await list(ctx, 'platform_post', 'execution')).filter(({ id, data }) => {
    const task = tasksById.get(data.execution_task_id) ?? tasksByPost.get(id);
    return data.content_item_id === item.id || task?.content_item_id === item.id ||
      targetIds.has(data.publish_target_id ?? data.target_id ?? task?.publish_target_id ?? task?.target_id) ||
      variantIds.has(data.content_variant_id ?? data.variant_id ?? task?.content_variant_id ?? task?.variant_id) ||
      revisionIds.has(data.variant_revision_id ?? data.content_revision_id ?? data.revision_id ?? task?.variant_revision_id ?? task?.revision_id);
  });
  const postIds = new Set(platformPosts.map(post => post.id));
  const postOperations = new Map((await list(ctx, 'post_operation', 'execution')).map(operation => [operation.id, operation]));
  const maintenance = (await list(ctx, 'post_maintenance_request')).filter(request => postIds.has(request.data.platform_post_id));
  const taskIds = new Set(tasks.map(task => task.id));
  const task_dependencies = machineActor(ctx) ? [] : (await list(ctx, 'work_item_dependency', 'workspace'))
    .filter(edge => edge.data.active !== false && taskIds.has(edge.data.work_item_id));
  const handoff_checklists = (await list(ctx, 'handoff_checklist')).filter(checklist => checklist.data.content_item_id === item.id);
  return { item, variants: details, stage_history: stages, tasks, task_dependencies, handoff_checklists, platform_posts: platformPosts,
    maintenance_requests: maintenance.map(request => ({ request, execution_operation: postOperations.get(request.data.post_operation_id) ?? null })) };
}
async function setStage(ctx: Context, input: Fields) {
  const item = await activeItem(ctx, id(input, 'content_item_id'));
  requireVersion(item, input);
  const to = choice(input.to, 'to', stages);
  const from = item.data.production_stage;
  if (!stageTransitions[from]?.includes(to)) fail('invalid_stage_transition', 'Invalid production stage transition', 409);
  if (to === 'ready') {
    const variants = (await list(ctx, kinds.variant)).filter(variant => variant.data.content_item_id === item.id && variant.data.readiness === 'ready');
    let ready = variants.length > 0;
    for (const variant of variants) {
      const head = await currentRevision(ctx, variant);
      if (!head || hash(variant.data.draft_doc) !== head.data.content_hash || !(await validate(ctx, variant.data, variant.data.draft_doc)).valid) ready = false;
    }
    const currentRevisions = new Set((await list(ctx, kinds.variant))
      .filter(variant => variant.data.content_item_id === item.id && variant.data.current_revision_id).map(variant => variant.data.current_revision_id));
    const unresolved = (await list(ctx, 'comment_thread', 'team')).some(thread => thread.data.required === true && !thread.data.resolved_at && thread.data.status !== 'resolved' &&
      (thread.data.content_item_id === item.id || [thread.data.anchor?.id, thread.data.revision_id, thread.data.resource_id].some(revisionId => currentRevisions.has(revisionId))));
    const checklists = (await list(ctx, 'handoff_checklist')).filter(checklist => checklist.data.content_item_id === item.id);
    if (!ready || unresolved || checklists.some(checklist => checklist.data.result !== 'passed')) fail('handoff_blocked', 'A validated revision and completed required review are needed for handoff', 409);
  }
  const note = optionalText(input.note, 'note', 4000);
  const result = await update(ctx, item, { production_stage: to, ...(to === 'archived' ? { archived_at: ctx.now } : {}) });
  await recordStage(ctx, item, from, to, note);
  await emit(ctx, 'item.stage_changed', { content_item_id: item.id, from_stage: from, to_stage: to });
  if (to === 'archived') await emit(ctx, 'item.archived', { content_item_id: item.id });
  return result;
}
async function markReady(ctx: Context, input: Fields) {
  const variant = await variantFor(ctx, input);
  await activeItem(ctx, variant.data.content_item_id);
  requireVersion(variant, input);
  const revision = await currentRevision(ctx, variant);
  if (!revision || revision.data.content_hash !== hash(variant.data.draft_doc)) fail('revision_required', 'Commit the current working draft before marking ready', 409);
  const link = (await list(ctx, kinds.translation)).find(link => link.data.target_variant_id === variant.id);
  if (link && ['source_changed', 'needs_review'].includes(link.data.status)) fail('translation_review_required', 'Review translation source or glossary changes first', 409);
  if (variant.data.reuse_review_required && input.confirm_reuse_review !== true) fail('reuse_review_required', 'Review the copied product copy and references', 409);
  if (variant.data.readiness === 'stale' && input.confirm_stale !== true) fail('stale_confirmation_required', 'Confirm stale issues have been addressed', 409);
  const result = await validate(ctx, variant.data, variant.data.draft_doc, input.social_account_ids === undefined ? [] : ids(input.social_account_ids, 'social_account_ids'));
  if (!result.valid) fail('validation_failed', 'Content has blocking validation issues', 422, { issues: result.issues });
  const reviewed = variant.data.reuse_review_required ? await update(ctx, variant, { reuse_review_required: false }) : variant;
  return setReadiness(ctx, reviewed, 'ready');
}
async function createTranslation(ctx: Context, input: Fields) {
  const source = await get(ctx, kinds.variant, id(input, 'source_variant_id'));
  const revision = await currentRevision(ctx, source);
  if (!revision) fail('revision_required', 'Commit the source variant first', 409);
  if (input.source_revision_id && input.source_revision_id !== revision.id) fail('VERSION_CONFLICT', 'The translation source has advanced', 409, { current_revision_id: revision.id });
  const item = await activeItem(ctx, source.data.content_item_id);
  const locale = text(input.locale, 'locale', 35);
  const market = optionalText(input.market_id ?? input.market, 'market_id');
  if (source.data.locale === locale && source.data.market === market) fail('invalid_input', 'Specify a different locale or market');
  if ((await list(ctx, kinds.variant)).some(variant => variant.data.content_item_id === item.id && variant.data.platform === source.data.platform && variant.data.format === source.data.format && variant.data.locale === locale && variant.data.market === market && !variant.data.social_account_id)) fail('translation_exists', 'This locale and market already have a variant', 409);
  const result = await createVariant(ctx, item, { ...input, locale, market_id: market, platform: source.data.platform, format: source.data.format, social_account_id: null },
    { initialize: true, lineage: { origin: 'translation', parent_variant_id: source.id, derived_from_revision_id: revision.id } });
  const link = await insert(ctx, kinds.translation, { source_variant_id: source.id, source_revision_id: revision.id, target_variant_id: result.variant.id,
    target_revision_id: result.revision?.id, glossary_version: optionalText(input.glossary_version, 'glossary_version'), status: 'in_sync' });
  return { ...result, translation_link: link };
}
async function acknowledgeTranslation(ctx: Context, input: Fields, divergence: boolean) {
  const link = await get(ctx, kinds.translation, id(input, 'translation_link_id'));
  requireVersion(link, input);
  const source = await get(ctx, kinds.variant, link.data.source_variant_id);
  const target = await get(ctx, kinds.variant, link.data.target_variant_id);
  await activeItem(ctx, target.data.content_item_id);
  if (text(input.source_revision_id, 'source_revision_id') !== source.data.current_revision_id) fail('VERSION_CONFLICT', 'The translation source has advanced', 409, { current_revision_id: source.data.current_revision_id });
  const glossary = optionalText(input.glossary_version, 'glossary_version');
  const changedGlossaries = (target.data.stale_reasons as Fields[]).filter(reason => reason.kind === 'glossary_changed' && reason.glossary_version);
  if ((changedGlossaries.length && glossary !== changedGlossaries.at(-1)?.glossary_version) || (link.data.status === 'needs_review' && !glossary)) fail('glossary_review_required', 'Confirm the current glossary version', 409);
  const result = await update(ctx, link, { source_revision_id: source.data.current_revision_id, status: divergence ? 'accepted_divergence' : 'in_sync',
    glossary_version: glossary ?? link.data.glossary_version, divergence_note: divergence ? text(input.note, 'note', 4000) : null });
  const remaining = (target.data.stale_reasons as Fields[]).filter(reason => reason.kind !== 'glossary_changed' && !(reason.kind === 'translation_source_changed' && reason.ref_id === link.id));
  if (target.data.readiness === 'stale') await setReadiness(ctx, target, remaining.length ? 'stale' : 'draft', remaining);
  return result;
}

const baseCommands: Commands = {
  content_list_pillars: read(async (ctx, input) => (await list(ctx, kinds.pillar)).filter(row => matches(row.data, input, ['brand_id']) && (!row.data.archived_at || input.include_archived === true))),
  content_get_pillar: read((ctx, input) => get(ctx, kinds.pillar, id(input, 'pillar_id'))),
  content_create_pillar: manage((ctx, input) => savePillar(ctx, input)),
  content_update_pillar: manage(async (ctx, input) => { const row = await get(ctx, kinds.pillar, id(input, 'pillar_id')); requireVersion(row, input); return savePillar(ctx, input, row); }),
  content_archive_pillar: manage(async (ctx, input) => { const row = await get(ctx, kinds.pillar, id(input, 'pillar_id')); requireVersion(row, input); return update(ctx, row, { archived_at: ctx.now }); }),
  idea_list: read(listIdeas),
  idea_get: read((ctx, input) => get(ctx, kinds.idea, id(input, 'idea_id'))),
  idea_create: write((ctx, input) => saveIdea(ctx, input)),
  idea_create_from_conversation: write(async (ctx, input) => {
    if (machineActor(ctx)) fail('forbidden', 'Inbox idea capture requires a human operator', 403);
    const conversation = await get(ctx, 'conversation', id(input, 'conversation_id'), 'inbox');
    if (input.brand_id != null && input.brand_id !== conversation.data.brand_id) fail('invalid_input', 'Conversation belongs to another brand');
    return saveIdea(ctx, {
      ...pick(input, ['title', 'hypothesis', 'objective', 'audience_note', 'pillar_id', 'tags']),
      brand_id: conversation.data.brand_id, origin: 'customer_question',
      origin_refs: [{ type: 'conversation', id: conversation.id }],
    });
  }),
  idea_update: write(async (ctx, input) => { const row = await get(ctx, kinds.idea, id(input, 'idea_id')); requireVersion(row, input); return saveIdea(ctx, input, row); }),
  idea_convert: write(async (ctx, input) => {
    const idea = await get(ctx, kinds.idea, id(input, 'idea_id'));
    const result = await createItem(ctx, { ...input, idea_id: idea.id, brand_id: idea.data.brand_id, title: input.title ?? idea.data.title, pillar_id: input.pillar_id ?? idea.data.pillar_id, campaign_id: input.campaign_id ?? idea.data.campaign_id });
    if (idea.data.status !== 'accepted') await update(ctx, idea, { status: 'accepted' });
    await emit(ctx, 'idea.converted', { idea_id: idea.id, content_item_id: result.item.id });
    return result;
  }),
  content_list: read(listItems),
  content_production_workload: read(productionWorkload),
  content_preview_feed_import: manage(async (ctx, input) => {
    const feed = await get(ctx, kinds.feed, id(input, 'feed_source_id'));
    requireVersion(feed, input);
    if (!['link', 'file'].includes(feed.data.kind)) fail('invalid_input', 'Manual preview requires a link or file source');
    const entries = feed.data.kind === 'link'
      ? [{ url: feed.data.url, title: input.title, author: input.author, summary: input.summary, published_at: input.published_at }]
      : array(input.entries, 'entries', 500);
    // Manual previews never auto-import. The caller explicitly imports a preview afterward.
    return recordNormalizedFeedItems(ctx, feed.id, { entries, source_version: feed.version });
  }),
  content_export_item: write(async (ctx, input) => {
    const detail = await itemDetail(ctx, await get(ctx, kinds.item, id(input, 'content_item_id')));
    return { item: detail.item, variants: detail.variants.map(({ variant, current_revision, references }) => ({
      variant_id: variant.id, platform: variant.data.platform, format: variant.data.format, locale: variant.data.locale,
      market_id: variant.data.market_id, revision: current_revision, references,
    })) };
  }),
  content_get: read(async (ctx, input) => input.variant_id ? variantDetail(ctx, await variantFor(ctx, input)) : itemDetail(ctx, await get(ctx, kinds.item, id(input, 'content_item_id')))),
  content_create_item: write((ctx, input) => createItem(ctx, input)),
  content_update_item: write(async (ctx, input) => {
    const item = await activeItem(ctx, id(input, 'content_item_id'));
    requireVersion(item, input);
    const patch = metadata(input, itemFields.filter(field => !['brand_id', 'idea_id', 'campaign_id'].includes(field)));
    await checkPillar(ctx, { ...item.data, ...patch });
    return update(ctx, item, patch);
  }),
  content_set_stage: write(setStage),
  content_create_variant: write(async (ctx, input) => createVariant(ctx, await activeItem(ctx, id(input, 'content_item_id')), input)),
  content_get_variant: read(async (ctx, input) => variantDetail(ctx, await variantFor(ctx, input))),
  content_autosave_variant: write(autosave),
  content_list_product_facts: read(async (ctx, input) => factChoices(ctx, await variantFor(ctx, input), text(input.product_id, 'product_id'))),
  content_insert_product_fact: write(insertProductFact),
  content_list_product_prices: read(async (ctx, input) => priceChoices(ctx, await variantFor(ctx, input), text(input.product_id, 'product_id'))),
  content_insert_product_price: write(insertProductPrice),
  content_request_rendition: write(async (ctx, input) => {
    const variant = await variantFor(ctx, input);
    await activeItem(ctx, variant.data.content_item_id);
    requireVersion(variant, input);
    const draft = variant.data.draft_doc;
    const index = input.media_index;
    if (!Number.isSafeInteger(index) || index < 0 || index >= draft.media.length) fail('invalid_input', 'Invalid media_index');
    const attachment = draft.media[index];
    if (!await assetPermitted(ctx, { ...attachment, crop: true }, variant.data.platform, variant.data.market_id ?? variant.data.market,
      draft.body, ctx.now, variant.data.brand_id)) fail('asset_rights_denied', 'The selected asset may not be adapted for this variant', 403);
    const rendition = await libraryCommands.asset_request_rendition!.run(ctx, {
      asset_version_id: attachment.asset_version_id, kind: input.kind, params: input.params, target_platform: variant.data.platform,
    }) as Entity;
    const media = draft.media.map((entry: Fields, position: number) => position === index ? { ...entry, requires_rendition: true, rendition_id: rendition.id } : entry);
    return { variant: await autosave(ctx, { variant_id: variant.id, expected_version: variant.version, media }), rendition };
  }),
  content_commit_revision: write(async (ctx, input) => { const { variant, draft } = await prepareEdit(ctx, input, 'human'); return commit(ctx, variant, draft, 'human'); }),
  content_list_revisions: read(async (ctx, input) => {
    const variant = await variantFor(ctx, input);
    return (await list(ctx, kinds.revision)).filter(row => row.data.variant_id === variant.id).sort((a, b) => b.data.revision_no - a.data.revision_no);
  }),
  content_get_revision: read(revisionFor),
  content_diff_revisions: read(diffRevisions),
  content_restore_revision: write(async (ctx, input) => {
    if (machineActor(ctx)) fail('human_selection_required', 'Only a human may restore a revision', 403);
    const restored = await revisionFor(ctx, input);
    const { variant, draft } = await prepareEdit(ctx, input, 'restore', restored);
    return commit(ctx, variant, draft, 'human', restored.id);
  }),
  content_validate_variant: read(async (ctx, input) => {
    const variant = await variantFor(ctx, input);
    const revision = input.revision_id === undefined ? null : await revisionFor(ctx, input);
    if (revision && revision.data.variant_id !== variant.id) fail('invalid_input', 'Revision does not belong to this variant');
    return validate(ctx, variant.data, revision?.data ?? variant.data.draft_doc,
      input.social_account_ids === undefined ? [] : ids(input.social_account_ids, 'social_account_ids'), date(input.scheduled_at, 'scheduled_at') ?? ctx.now);
  }),
  content_set_readiness: write(markReady),
  content_list_translations: read(async (ctx, input) => {
    const source = await variantFor(ctx, input);
    const latest = await currentRevision(ctx, source);
    return Promise.all((await list(ctx, kinds.translation)).filter(link => link.data.source_variant_id === source.id).map(async link => {
      const [baseline, target] = await Promise.all([
        get(ctx, kinds.revision, link.data.source_revision_id), get(ctx, kinds.variant, link.data.target_variant_id),
      ]);
      const source_diff = latest && latest.id !== baseline.id ? await diffRevisions(ctx, { revision_a: baseline.id, revision_b: latest.id }) : null;
      const glossary = (target.data.stale_reasons ?? []).filter((reason: Fields) => reason.kind === 'glossary_changed').at(-1);
      return { translation_link: link, source_revision: baseline, target_variant: target, current_source_revision: latest,
        target_revision: await currentRevision(ctx, target), source_diff, pending_glossary_version: glossary?.glossary_version ?? null };
    }));
  }),
  content_create_translation: write(createTranslation),
  content_accept_source_change: write((ctx, input) => acknowledgeTranslation(ctx, input, false)),
  content_mark_divergence: write((ctx, input) => acknowledgeTranslation(ctx, input, true)),
  content_list_stale: read(async (ctx, input) => {
    const reasons = input.reason === undefined ? [] : ids(input.reason, 'reason');
    return (await list(ctx, kinds.variant)).filter(variant => variant.data.readiness === 'stale' && matches(variant.data, input, ['campaign_id']) && (!reasons.length || variant.data.stale_reasons.some((reason: Fields) => reasons.includes(reason.kind))));
  }),
  content_create_draft: write((ctx, input) => createItem(ctx, input, { agent: true, initialize: true })),
  content_update_variant: write(async (ctx, input) => { const { variant, draft } = await prepareEdit(ctx, input, 'agent'); return commit(ctx, variant, draft, 'agent'); }),
  content_batch_variants: write(async (ctx, input) => {
    if (typeof input.dry_run !== 'boolean') fail('invalid_input', 'Specify dry_run');
    const changes = array(input.changes, 'changes', 50).map(value => object(value, 'change'));
    const seen = new Set();
    const results = [];
    for (const change of changes) {
      if (change.variant_id) {
        if (seen.has(change.variant_id)) fail('invalid_input', 'Only one update per variant is allowed');
        seen.add(change.variant_id);
        const { variant, draft } = await prepareEdit(ctx, change, 'agent');
        results.push(input.dry_run ? { operation: 'update', variant_id: variant.id, draft_doc: draft, ...(await validate(ctx, variant.data, draft)) }
          : await commit(ctx, variant, draft, 'agent'));
      } else {
        const item = await activeItem(ctx, id(change, 'content_item_id'));
        const created = await createVariant(ctx, item, change, { agent: true, initialize: true, dryRun: input.dry_run });
        results.push(input.dry_run ? { operation: 'create', content_item_id: item.id, draft_doc: created.variant.data.draft_doc,
          ...await validate(ctx, created.variant.data, created.variant.data.draft_doc) } : created);
      }
    }
    return { dry_run: input.dry_run, results };
  }),
};
export const contentCommands: Commands = { ...baseCommands, ...laterCommands(createItem, saveIdea) };
export const commands = contentCommands;
export const operations: Operation[] = makeOperations(commands);
export { handleContentEvent };
export { scanContentDue } from './operations.js';
export { recordTranscriptResult } from './later.ts';
export const recordFeedItems = (ctx: Context, feedId: string, input: Fields) => recordNormalizedFeedItems(ctx, feedId, input, saveIdea);
export const contentAcceptsEvent = (type: string) => type === 'content.feed.poll_requested' || acceptsReferenceEvent(type);
export async function applyContentEvent(ctx: RestContext, event: Fields, transport?: FeedTransport) {
  if (event.type !== 'content.feed.poll_requested') return applyReferenceEvent(ctx, event);
  const payload = event.payload ?? event.data ?? {};
  const source = ctx.list(kinds.feed).find(row => row.id === payload.feed_source_id);
  if (!source || source.version !== payload.source_version || source.status !== 'active') return;
  const kind = source.kind;
  if (kind !== 'rss' && kind !== 'atom' && kind !== 'sitemap') return;
  const headers: Record<string, string> = {};
  if (typeof source.etag === 'string') headers['If-None-Match'] = source.etag;
  if (typeof source.last_modified === 'string') headers['If-Modified-Since'] = source.last_modified;
  const { response, url } = await fetchFeed(String(source.url), headers, transport);
  return recordFeedItems(commandContext(ctx), source.id, {
    source_version: source.version, entries: response.status === 304 ? [] : parseFeed(response.body!, url, kind),
    ...(response.status === 200 || response.etag !== undefined ? { etag: response.etag } : {}),
    ...(response.status === 200 || response.last_modified !== undefined ? { last_modified: response.last_modified } : {}),
  });
}
