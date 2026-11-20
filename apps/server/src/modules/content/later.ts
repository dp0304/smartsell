import { admins, readers, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { array, choice, clearHumanSettings, emit, fail, get, hash, id, insert, kinds, list, object, optionalText, requireVersion, snapshot, text, update, webUrl } from './model.ts';
import { activeItem, createVariant, currentRevision } from './revisions.ts';
import { assetPermitted, factPin, loadProductSources, usableProductSource } from './validation.ts';

type CreateItem = (ctx: Context, input: Fields, options?: { lineage?: Fields }) => Promise<{ item: Entity }>;
type SaveIdea = (ctx: Context, input: Fields) => Promise<Entity>;

async function duplicate(ctx: Context, input: Fields, createItem: CreateItem) {
  const source = await get(ctx, kinds.item, id(input, 'content_item_id'));
  const brand = input.brand_id ?? source.data.brand_id;
  const { item } = await createItem(ctx, { brand_id: brand, title: input.title ?? source.data.title, campaign_id: input.campaign_id }, { lineage: { derived_from_item_id: source.id } });
  const warnings: Fields[] = [];
  const variants: Entity[] = [];
  for (const variant of (await list(ctx, kinds.variant)).filter(row => row.data.content_item_id === source.id)) {
    const head = await currentRevision(ctx, variant);
    if (!head) continue;
    const draft = clearHumanSettings(snapshot(head), variant.data.platform);
    const copyWarnings: Fields[] = [];
    const media = [];
    for (const entry of draft.media as Fields[]) {
      if (await assetPermitted(ctx, entry, variant.data.platform, variant.data.market, draft.body, ctx.now, brand)) media.push(entry);
      else copyWarnings.push({ code: 'asset_removed', asset_version_id: entry.asset_version_id });
    }
    const refs: Fields[] = [];
    for (const oldRef of draft.product_refs as Fields[]) {
      const ref = { ...oldRef };
      if (ref.fact_revision_id) {
        const old = await ctx.get('commerce', 'product_fact_revision', ref.fact_revision_id);
        const fact = old?.data.fact_id ? await ctx.get('commerce', 'product_fact', old.data.fact_id) : undefined;
        if (fact && fact.data.brand_id === brand) ref.fact_revision_id = fact.data.approved_revision_id;
        else if (brand !== source.data.brand_id) ref.fact_revision_id = null;
      }
      if (ref.listing_snapshot_id) {
        const prior = await ctx.get('commerce', 'listing_snapshot', ref.listing_snapshot_id);
        const candidates = await list(ctx, 'listing_snapshot', 'commerce');
        if (brand === source.data.brand_id) ref.listing_snapshot_id = candidates.find(row => row.data.variant_id === ref.variant_id && row.data.market_id === ref.market_id && row.data.channel === prior?.data.channel && row.data.is_current === true)?.id;
        else ref.listing_snapshot_id = null;
      }
      const sources = await loadProductSources(ctx, [ref]);
      if (ref.fact_revision_id) {
        const source = sources.get(`product_fact_revision:${ref.fact_revision_id}:${ref.variant_id}`);
        const pin = source && usableProductSource(source, ref, true, brand) && factPin(source, variant.data.locale);
        if (pin) Object.assign(ref, pin);
        else {
          ref.fact_revision_id = null;
          for (const key of ['fact_id', 'fact_key', 'fact_revision_no', 'collected_at']) delete ref[key];
        }
      }
      if (ref.listing_snapshot_id && !usableProductSource(sources.get(`listing_snapshot:${ref.listing_snapshot_id}:${ref.variant_id}`), ref, false, brand)) ref.listing_snapshot_id = null;
      const retained = ref.listing_snapshot_id || (ref.fact_revision_id && !/price/i.test(ref.field ?? ''));
      if (!retained || hash(oldRef) !== hash(ref)) copyWarnings.push({ code: 'product_copy_review', before: oldRef, after: retained ? ref : null });
      if (retained) refs.push(ref);
    }
    const { variant: copy } = await createVariant(ctx, item, {
      ...draft, settings: { ...draft.settings, platform_options: {} }, asset_version_ids: undefined, media, product_refs: refs,
      platform: variant.data.platform, format: variant.data.format, locale: variant.data.locale, market_id: variant.data.market,
    }, { agent: true, lineage: { derived_from_revision_id: head.id, parent_variant_id: variant.id, reuse_warnings: copyWarnings,
      reuse_review_required: copyWarnings.some(warning => warning.code === 'product_copy_review') } });
    warnings.push(...copyWarnings.map(warning => ({ ...warning, variant_id: copy.id })));
    variants.push(copy);
  }
  return { item, variants, warnings };
}

function feedFields(input: Fields, existing?: Entity) {
  const interval = input.poll_interval_minutes ?? existing?.data.poll_interval_minutes ?? 60;
  if (!Number.isSafeInteger(interval) || interval < 15 || interval > 10_080) fail('invalid_input', 'Invalid poll interval');
  const expire_after_days = input.expire_after_days ?? existing?.data.expire_after_days ?? 90;
  if (!Number.isSafeInteger(expire_after_days) || expire_after_days < 1 || expire_after_days > 365) fail('invalid_input', 'Invalid expire_after_days');
  const rule = Object.hasOwn(input, 'auto_enqueue_rule') ? input.auto_enqueue_rule : existing?.data.auto_enqueue_rule;
  const auto_enqueue_rule = rule == null ? null : object(rule, 'auto_enqueue_rule');
  if (auto_enqueue_rule && (Object.keys(auto_enqueue_rule).some(key => !['enabled', 'max_per_poll'].includes(key)) ||
    typeof auto_enqueue_rule.enabled !== 'boolean' || !Number.isSafeInteger(auto_enqueue_rule.max_per_poll) || auto_enqueue_rule.max_per_poll < 1 || auto_enqueue_rule.max_per_poll > 50)) {
    fail('invalid_input', 'Auto-import requires enabled and max_per_poll from 1 to 50');
  }
  return { expire_after_days, auto_enqueue_rule, url: webUrl(input.url ?? existing?.data.url), kind: choice(input.kind ?? existing?.data.kind ?? 'rss', 'kind', ['rss', 'atom', 'sitemap', 'link', 'file']),
    poll_interval_minutes: interval, brand_id: text(input.brand_id ?? existing?.data.brand_id, 'brand_id'),
    pillar_id: optionalText(input.pillar_id ?? existing?.data.pillar_id, 'pillar_id') };
}

/** A trusted feed worker supplies normalized entries after fetching through its protected transport. */
export async function recordFeedItems(ctx: Context, feedId: string, input: Fields, saveIdea?: SaveIdea) {
  const source = await get(ctx, kinds.feed, feedId);
  if (source.data.status !== 'active') fail('feed_inactive', 'Feed source is inactive', 409);
  if (input.source_version !== undefined) requireVersion(source, { expected_version: input.source_version });
  const siblingIds = new Set((await list(ctx, kinds.feed)).filter(feed => feed.data.brand_id === source.data.brand_id).map(feed => feed.id));
  const all = (await list(ctx, kinds.feedItem)).filter(entry => siblingIds.has(entry.data.feed_source_id));
  const existing = new Map(all.filter(row => row.data.feed_source_id === feedId).map(row => [row.data.guid, row]));
  const hashes = new Set(all.map(row => row.data.content_hash));
  const items: Entity[] = [];
  let duplicate_count = 0;
  for (const entry of array(input.entries, 'entries', 500)) {
    const raw = object(entry, 'feed entry');
    const parsedUrl = new URL(webUrl(raw.url));
    parsedUrl.hash = '';
    const url = parsedUrl.href;
    const title = text(raw.title, 'title', 240);
    const summary = optionalText(raw.summary, 'summary', 16_000);
    const author = optionalText(raw.author, 'author', 300);
    const guid = text(raw.guid ?? url, 'guid', 2048);
    const content_hash = hash({ url, title, summary, author });
    if (existing.has(guid) || hashes.has(content_hash)) { duplicate_count++; continue; }
    const publishedAt = optionalText(raw.published_at, 'published_at');
    if (publishedAt && !Number.isFinite(Date.parse(publishedAt))) fail('invalid_input', 'Invalid published_at');
    const row = await insert(ctx, kinds.feedItem, { feed_source_id: feedId, guid, url, title, summary, author,
      published_at: publishedAt ? new Date(publishedAt).toISOString() : null, status: 'new', content_hash, grants_republication_rights: false });
    items.push(row);
    existing.set(guid, row);
    hashes.add(content_hash);
  }
  await update(ctx, source, { last_polled_at: ctx.now,
    ...(Object.hasOwn(input, 'etag') ? { etag: optionalText(input.etag, 'etag', 2048) } : {}),
    ...(Object.hasOwn(input, 'last_modified') ? { last_modified: optionalText(input.last_modified, 'last_modified') } : {}),
  });
  if (source.data.auto_enqueue_rule?.enabled && saveIdea && source.data.pillar_id) {
    const pillar = await ctx.get('content', kinds.pillar, source.data.pillar_id);
    const cap = source.data.auto_enqueue_rule.max_per_poll;
    if (pillar && pillar.data.brand_id === source.data.brand_id && !pillar.data.archived_at) {
      for (let index = 0; index < Math.min(cap, items.length); index++) {
        const entry = items[index]!;
        const { item } = await importEntry(ctx, source, entry, saveIdea);
        items[index] = item;
      }
    }
  }
  return { items, duplicate_count };
}

async function importEntry(ctx: Context, feed: Entity, entry: Entity, saveIdea: SaveIdea) {
  const idea = await saveIdea(ctx, { brand_id: feed.data.brand_id, pillar_id: feed.data.pillar_id,
    origin: ['rss', 'atom'].includes(feed.data.kind) ? 'rss' : 'import', title: entry.data.title,
    hypothesis: entry.data.summary, observed_at: entry.data.published_at,
    origin_refs: [{ type: 'url', url: entry.data.url, author: entry.data.author }] });
  const item = await update(ctx, entry, { status: 'imported', idea_id: idea.id });
  return { item, idea };
}

async function requestFeedPoll(ctx: Context, feed: Entity) {
  const intervalMs = feed.data.poll_interval_minutes * 60_000;
  const now = Date.parse(ctx.now);
  const window = Math.floor(now / intervalMs);
  if (feed.data.last_poll_window !== window) {
    const queued = await update(ctx, feed, { last_poll_window: window, last_poll_requested_at: ctx.now });
    await emit(ctx, 'feed.poll_requested', { feed_source_id: queued.id, source_version: queued.version,
      idempotency_key: `feed:${queued.id}:${window}` });
  }
  return { feed_source_id: feed.id, status: 'queued' };
}

export async function scanContentFeeds(ctx: Context) {
  const feeds = await list(ctx, kinds.feed);
  const now = Date.parse(ctx.now);
  const feedById = new Map(feeds.map(feed => [feed.id, feed]));
  for (const item of await list(ctx, kinds.feedItem)) {
    const retention = (feedById.get(item.data.feed_source_id)?.data.expire_after_days ?? 90) * 86_400_000;
    if (item.data.status === 'new' && Date.parse(item.created_at) + retention <= now) {
      await update(ctx, item, { status: 'expired', expired_at: ctx.now });
    }
  }
  for (const feed of feeds) {
    if (feed.data.status !== 'active' || !['rss', 'atom', 'sitemap'].includes(feed.data.kind)) continue;
    const last = Math.max(Date.parse(feed.data.last_polled_at) || 0, Date.parse(feed.data.last_poll_requested_at) || 0);
    if (last + feed.data.poll_interval_minutes * 60_000 <= now) await requestFeedPoll(ctx, feed);
  }
}

function transcriptSegments(value: unknown) {
  let lastStart = -1;
  return array(value, 'segments', 10_000).map(value => {
    const segment = object(value, 'transcript segment');
    const { start_ms, end_ms } = segment;
    if (!Number.isSafeInteger(start_ms) || !Number.isSafeInteger(end_ms) || start_ms < 0 || start_ms < lastStart || end_ms <= start_ms) {
      fail('invalid_input', 'Transcript segments must have ordered and valid time ranges');
    }
    lastStart = start_ms;
    return { start_ms, end_ms, text: text(segment.text, 'segment text', 4000) };
  });
}

/** Accept normalized results from a trusted worker after its data-egress policy check. */
export async function recordTranscriptResult(ctx: Context, transcriptId: string, input: Fields) {
  const request = await get(ctx, 'transcript', transcriptId);
  const segments = transcriptSegments(input.segments);
  const model = text(input.model, 'model');
  const result_hash = hash({ segments, model });
  if (request.data.result_hash === result_hash) return request;
  if (request.data.status !== 'requested') fail('transcript_closed', 'This transcription request already has a result', 409);
  return update(ctx, request, { model, segments, result_hash, status: 'ready', completed_at: ctx.now });
}

export function laterCommands(createItem: CreateItem, saveIdea: SaveIdea): Commands {
  return {
    content_duplicate: { roles: writers, run: (ctx, input) => duplicate(ctx, input, createItem) },
    content_list_feeds: { roles: admins, run: (ctx) => list(ctx, kinds.feed) },
    content_get_feed: { roles: admins, run: (ctx, input) => get(ctx, kinds.feed, id(input, 'feed_source_id')) },
    content_create_feed: { roles: admins, run: async (ctx, input) => insert(ctx, kinds.feed, { ...feedFields(input), status: 'active' }) },
    content_update_feed: { roles: admins, run: async (ctx, input) => {
      const feed = await get(ctx, kinds.feed, id(input, 'feed_source_id'));
      requireVersion(feed, input);
      if (feed.data.status === 'archived') fail('feed_inactive', 'Feed source is archived', 409);
      const fields = feedFields(input, feed);
      if (fields.brand_id !== feed.data.brand_id) fail('invalid_input', 'Feed brand cannot be changed');
      return update(ctx, feed, { ...fields, status: choice(input.status ?? feed.data.status, 'status', ['active', 'paused']),
        ...(fields.url !== feed.data.url ? { etag: null, last_modified: null, last_polled_at: null, last_poll_window: null, last_poll_requested_at: null } : {}),
      });
    } },
    content_archive_feed: { roles: admins, run: async (ctx, input) => {
      const feed = await get(ctx, kinds.feed, id(input, 'feed_source_id'));
      requireVersion(feed, input);
      return update(ctx, feed, { status: 'archived' });
    } },
    content_poll_feed: { roles: admins, run: async (ctx, input) => {
      const feed = await get(ctx, kinds.feed, id(input, 'feed_source_id'));
      if (feed.data.status !== 'active') fail('feed_inactive', 'Feed source is inactive', 409);
      if (!['rss', 'atom', 'sitemap'].includes(feed.data.kind)) fail('invalid_input', 'Use preview import for a link or file');
      return requestFeedPoll(ctx, feed);
    } },
    content_list_feed_items: { roles: readers, run: async (ctx, input) => {
      const feed = await get(ctx, kinds.feed, id(input, 'feed_source_id'));
      return (await list(ctx, kinds.feedItem)).filter(row => row.data.feed_source_id === feed.id);
    } },
    content_import_feed_item: { roles: writers, run: async (ctx, input) => {
      const entry = await get(ctx, kinds.feedItem, id(input, 'feed_item_id'));
      if (entry.data.idea_id) return get(ctx, kinds.idea, entry.data.idea_id);
      const feed = await get(ctx, kinds.feed, entry.data.feed_source_id);
      if (feed.data.status === 'archived' || entry.data.status !== 'new') fail('feed_inactive', 'Feed item is unavailable for import', 409);
      return (await importEntry(ctx, feed, entry, saveIdea)).idea;
    } },
    content_request_post_maintenance: { roles: writers, run: async (ctx, input) => {
      const post = await get(ctx, 'platform_post', id(input, 'platform_post_id'), 'execution');
      const action = choice(input.action, 'action', ['edit', 'hide', 'delete']);
      const targetId = post.data.target_id ?? post.data.publish_target_id;
      const target = targetId ? await get(ctx, 'publish_target', targetId, 'planning') : undefined;
      const revisionId = optionalText(input.new_revision_id, 'new_revision_id');
      if (action === 'edit') {
        if (!revisionId) fail('invalid_input', 'Editing requires a replacement revision');
        const revision = await get(ctx, kinds.revision, revisionId);
        const publishedRevisionId = post.data.variant_revision_id ?? post.data.content_revision_id ?? post.data.revision_id ?? target?.data.variant_revision_id ?? target?.data.content_revision_id;
        const publishedRevision = publishedRevisionId ? await ctx.get('content', kinds.revision, publishedRevisionId) : undefined;
        const variantId = post.data.content_variant_id ?? post.data.variant_id ?? target?.data.content_variant_id ?? target?.data.variant_id ?? publishedRevision?.data.variant_id;
        if (!variantId || revision.data.variant_id !== variantId) fail('invalid_input', 'The replacement must belong to the published variant');
      } else if (revisionId) fail('invalid_input', 'Only editing accepts a replacement revision');
      const request = await insert(ctx, 'post_maintenance_request', { platform_post_id: post.id, action, new_revision_id: revisionId, status: 'requested', requested_by: ctx.actorId });
      await emit(ctx, 'post_maintenance.requested', { post_maintenance_request_id: request.id, platform_post_id: post.id, action });
      return request;
    } },
    content_record_handoff_checklist: { roles: writers, run: async (ctx, input) => {
      const item = await activeItem(ctx, id(input, 'content_item_id'));
      const entries = array(input.items, 'items', 50).map(value => {
        const entry = object(value, 'checklist item');
        if (typeof entry.complete !== 'boolean') fail('invalid_input', 'Specify checklist completion');
        return { label: text(entry.label, 'label', 240), complete: entry.complete };
      });
      if (!entries.length) fail('invalid_input', 'At least one checklist item is required');
      const prior = (await list(ctx, 'handoff_checklist')).find(row => row.data.content_item_id === item.id);
      const fields = { content_item_id: item.id, items: entries, result: entries.every(entry => entry.complete) ? 'passed' : 'pending', recorded_by: ctx.actorId };
      if (prior) { requireVersion(prior, input); return update(ctx, prior, fields); }
      return insert(ctx, 'handoff_checklist', fields);
    } },
    content_get_transcript: { roles: readers, run: (ctx, input) => get(ctx, 'transcript', id(input, 'transcript_id')) },
    content_review_transcript: { roles: writers, run: async (ctx, input) => {
      const transcript = await get(ctx, 'transcript', id(input, 'transcript_id'));
      requireVersion(transcript, input);
      if (transcript.data.status !== 'ready') fail('transcript_not_ready', 'Wait for transcription before reviewing', 409);
      const segments = input.segments === undefined ? transcript.data.segments : transcriptSegments(input.segments);
      return update(ctx, transcript, { segments, reviewed: true, reviewed_at: ctx.now, reviewed_by: ctx.actorId });
    } },
    content_request_transcript: { roles: writers, run: async (ctx, input) => {
      const asset = await get(ctx, 'asset_version', id(input, 'asset_version_id'), 'asset');
      const locale = text(input.locale, 'locale', 35);
      const prior = (await list(ctx, 'transcript')).find(row => row.data.asset_version_id === asset.id && row.data.locale === locale);
      if (prior) return prior;
      const request = await insert(ctx, 'transcript', { asset_version_id: asset.id, locale, status: 'requested', segments: [], reviewed: false });
      await emit(ctx, 'transcribe.requested', { transcript_id: request.id, asset_version_id: asset.id, locale });
      return request;
    } },
  };
}
