import { createHash } from 'node:crypto';
import { DomainError, type Context, type Entity, type Fields } from '../types.ts';

export const key = 'content';
export const machineActor = (ctx: { role: string; agentClientId?: string }) => ctx.role === 'agent' || Boolean(ctx.agentClientId);
export const kinds = {
  pillar: 'content_pillar', idea: 'idea', item: 'content_item', variant: 'content_variant',
  revision: 'content_revision', reference: 'content_reference', stage: 'content_stage_history',
  translation: 'translation_link', feed: 'feed_source', feedItem: 'feed_item',
} as const;
export const platforms = ['instagram', 'facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu', 'x', 'generic'];
export const formats = ['feed_image', 'carousel', 'reel', 'story', 'short_video', 'long_video', 'text', 'note', 'live_teaser'];
export const stages = ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived'];

export function fail(code: string, message: string, status = 422, details?: Fields): never {
  throw Object.assign(new DomainError(code, message, status), details ? { details } : {});
}
export async function get(ctx: Context, kind: string, id: string, module = key) {
  const row = await ctx.get(module, kind, id);
  if (!row) fail('not_found', `${module}.${kind} not found`, 404);
  return row;
}
export const list = (ctx: Context, kind: string, module = key) => ctx.list(module, kind);
export const insert = (ctx: Context, kind: string, data: Fields) => ctx.insert(key, kind, data);
export const update = (ctx: Context, row: Entity, data: Fields) => ctx.update(key, row.kind, row.id, data, row.version);
export const emit = (ctx: Context, event: string, data: Fields) => ctx.emit(`${key}.${event}`, data);

export function object(value: unknown, field: string): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', `Invalid ${field}`);
  return value as Fields;
}
export function array(value: unknown, field: string, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail('invalid_input', `Invalid ${field}`);
  return value;
}
export function text(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail('invalid_input', `Invalid ${field}`);
  return value.trim();
}
export const ids = (value: unknown, field: string) => [...new Set(array(value, field).map(id => text(id, field)))];
export const id = (input: Fields, field = 'id') => text(input[field] ?? input.id, field);
export const optionalText = (value: unknown, field: string, max?: number) => value == null ? null : text(value, field, max);
export function pick(input: Fields, fields: readonly string[]): Fields {
  return Object.fromEntries(fields.filter(field => Object.hasOwn(input, field)).map(field => [field, structuredClone(input[field])]));
}
export function choice(value: unknown, field: string, choices: readonly string[]): string {
  const result = text(value, field);
  if (!choices.includes(result)) fail('invalid_input', `Invalid ${field}`);
  return result;
}
export function version(input: Fields, required = true) {
  const expected = input.expected_version;
  if (expected === undefined && !required) return undefined;
  if (!Number.isSafeInteger(expected) || expected < 1) fail('invalid_input', 'expected_version is required');
  return expected as number;
}
export function requireVersion(row: Entity, input: Fields, required = true) {
  const expected = version(input, required);
  if (expected !== undefined && expected !== row.version) fail('VERSION_CONFLICT', 'Resource version has changed', 409, { current_version: row.version });
}
export function baseRevision(input: Fields, required = true): string | null | undefined {
  if (!Object.hasOwn(input, 'base_revision_id')) {
    if (required) fail('invalid_input', 'base_revision_id is required (use null for the first revision)');
    return undefined;
  }
  return optionalText(input.base_revision_id, 'base_revision_id');
}
export function hash(value: unknown): string {
  const stable = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(stable);
    if (entry && typeof entry === 'object') return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => [name, stable(item)]));
    return entry;
  };
  return createHash('sha256').update(JSON.stringify(stable(value)) ?? 'undefined').digest('hex');
}

/** Platform options only a person selects. Agents reach them only through the channel defaults (phase1-design §4.4). */
const humanOptions: Record<string, string[]> = {
  tiktok: ['privacy_level', 'commercial_disclosure', 'allow_comment', 'allow_duet', 'allow_stitch', 'ai_generated'],
  douyin: ['visibility'], xiaohongshu: ['visibility'],
  youtube: ['title', 'categoryId', 'madeForKids', 'containsSyntheticMedia'],
  x: ['reply_settings'],
};
const interactions = ['allow_comment', 'allow_duet', 'allow_stitch'];
const booleanOptions = ['madeForKids', 'containsSyntheticMedia', 'ai_generated'];
const disclosures = ['none', 'your_brand', 'branded_content', 'both'];
export const xReplySettings = ['everyone', 'following', 'mentioned', 'verified'];
const draftFields = ['body', 'body_doc', 'media', 'asset_version_ids', 'product_refs', 'link_refs', 'knowledge_refs', 'settings', 'template_application'];
const settingsFields = ['first_comment', 'location', 'user_tags', 'collaborators', 'product_tag', 'music_ref', 'visibility_hint', 'disclosure', 'platform_options'];

function documentText(value: unknown, depth = 0): string {
  const node = object(value, 'body_doc node');
  if (depth > 32 || typeof node.type !== 'string') fail('invalid_input', 'Invalid body_doc');
  if (node.type === 'text') {
    if (typeof node.text !== 'string') fail('invalid_input', 'Invalid body_doc text');
    return node.text;
  }
  if (node.type === 'hardBreak') return '\n';
  return node.content === undefined ? '' : array(node.content, 'body_doc content', 5000)
    .map(child => documentText(child, depth + 1)).join(['doc', 'bulletList', 'orderedList', 'listItem', 'blockquote'].includes(node.type) ? '\n' : '');
}

function platformSettings(input: Fields, prior: Fields, platform: string, agent: boolean) {
  const incoming = input.platform_options === undefined ? {} : object(input.platform_options, 'platform_options');
  const options = { ...prior.platform_options };
  for (const [name, value] of Object.entries(incoming)) {
    if (name !== platform) fail('invalid_input', 'platform_options must match the variant platform');
    const selected = object(value, `platform_options.${name}`);
    const merged = { ...options[name] };
    for (const field of humanOptions[name] ?? []) {
      if (!Object.hasOwn(selected, field)) continue;
      const setting = selected[field];
      if (agent && (!interactions.includes(field) || setting !== false)) fail('human_selection_required', `Only a human may select ${field}`, 403);
      if (agent) continue;
      if (!interactions.includes(field) && setting === null) delete merged[field];
      else if (interactions.includes(field) || booleanOptions.includes(field)) {
        if (typeof setting !== 'boolean') fail('invalid_input', `Invalid ${field}`);
        merged[field] = setting;
      } else if (field === 'reply_settings') {
        merged[field] = choice(setting, field, xReplySettings);
      } else if (field === 'categoryId') {
        if (typeof setting !== 'string' || !/^\d{1,3}$/.test(setting)) fail('invalid_input', `Invalid ${field}`);
        merged[field] = setting;
      } else if (field === 'commercial_disclosure') merged[field] = choice(setting, field, disclosures);
      else if (field === 'privacy_level') merged[field] = choice(setting, field, ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY']);
      else merged[field] = text(setting, field);
    }
    options[name] = merged;
  }
  if (platform === 'tiktok') options.tiktok = { allow_comment: false, allow_duet: false, allow_stitch: false, ...options.tiktok };
  const settings: Fields = { ...prior, ...pick(input, settingsFields), platform_options: options };
  if (platform === 'tiktok') delete settings.visibility_hint;
  return settings;
}
export function clearHumanSettings(draft: Fields, platform: string): Fields {
  const settings = { ...draft.settings, platform_options: {} };
  delete settings.visibility_hint;
  return { ...draft, settings: platformSettings({}, settings, platform, false) };
}

function mediaItems(value: unknown): Fields[] {
  return array(value, 'media').map((item, order) => {
    const media = object(item, 'media item');
    const result = pick(media, ['asset_id', 'asset_version_id', 'rendition_id', 'caption_rendition_id', 'alt_text', 'crop', 'cover_time_ms', 'role', 'requires_rendition']);
    for (const field of ['asset_id', 'rendition_id', 'caption_rendition_id']) if (result[field] != null) result[field] = text(result[field], field);
    if (result.alt_text != null) result.alt_text = text(result.alt_text, 'alt_text', 4000);
    return { ...result, asset_version_id: text(media.asset_version_id, 'asset_version_id'), order };
  });
}
function productItems(value: unknown): Fields[] {
  return array(value, 'product_refs').map(item => {
    const ref = object(item, 'product_ref');
    const result = pick(ref, ['variant_id', 'fact_revision_id', 'listing_snapshot_id', 'market_id', 'currency', 'field', 'inserted_text']);
    result.variant_id = text(result.variant_id, 'product_ref.variant_id');
    for (const field of ['fact_revision_id', 'listing_snapshot_id', 'market_id', 'currency', 'field']) if (result[field] != null) result[field] = text(result[field], field);
    if (result.inserted_text !== undefined) result.inserted_text = text(result.inserted_text, 'inserted_text', result.fact_revision_id ? 10000 : 4000);
    if (!result.fact_revision_id && !result.listing_snapshot_id) fail('invalid_input', 'A product reference requires a fact revision or listing snapshot');
    if (/price/i.test(result.field ?? '') && (!result.listing_snapshot_id || !result.market_id || !/^[A-Z]{3}$/.test(result.currency ?? ''))) fail('invalid_input', 'Price references require a listing snapshot, market_id, and ISO currency');
    return result;
  });
}
export function draftFor(input: Fields, platform: string, prior: Fields = {}, agent = false): Fields {
  const supplied = input.draft_doc === undefined ? input : { ...input, ...object(input.draft_doc, 'draft_doc') };
  const doc = supplied.body_doc ?? (supplied.type === 'doc' ? pick(supplied, ['type', 'content', 'attrs']) : undefined);
  let body = supplied.body ?? supplied.body_markdown ?? supplied.text;
  if (doc !== undefined) {
    if (object(doc, 'body_doc').type !== 'doc') fail('invalid_input', 'body_doc must have a doc root');
    body = documentText(doc);
  }
  if (body !== undefined && (typeof body !== 'string' || body.length > 100_000)) fail('invalid_input', 'Invalid body');
  let media: Fields[] = prior.media ?? [];
  if (supplied.media !== undefined) media = mediaItems(supplied.media);
  else if (supplied.asset_version_ids !== undefined) media = ids(supplied.asset_version_ids, 'asset_version_ids').map((asset_version_id, order) => ({ asset_version_id, order }));
  const asset_version_ids = [...new Set(media.map(item => item.asset_version_id as string))];
  if (supplied.asset_version_ids !== undefined && hash(ids(supplied.asset_version_ids, 'asset_version_ids').sort()) !== hash([...asset_version_ids].sort())) fail('invalid_input', 'media and asset_version_ids disagree');
  const settings = supplied.settings === undefined ? {} : object(supplied.settings, 'settings');
  return {
    body: body ?? prior.body ?? '',
    body_doc: doc ?? (body === undefined && prior.body_doc ? prior.body_doc : {
      type: 'doc', content: (body ?? prior.body ?? '').split(/\r?\n/).map((line: string) => ({ type: 'paragraph', ...(line ? { content: [{ type: 'text', text: line }] } : {}) })),
    }), media, asset_version_ids,
    product_refs: supplied.product_refs === undefined ? prior.product_refs ?? [] : productItems(supplied.product_refs),
    link_refs: supplied.link_refs === undefined ? prior.link_refs ?? [] : array(supplied.link_refs, 'link_refs').map(value => {
      const link = object(value, 'link_ref');
      return link.short_link_id ? { short_link_id: text(link.short_link_id, 'short_link_id') } : { url: webUrl(link.url) };
    }),
    knowledge_refs: supplied.knowledge_refs === undefined ? prior.knowledge_refs ?? [] : ids(supplied.knowledge_refs, 'knowledge_refs'),
    settings: platformSettings(settings, prior.settings ?? {}, platform, agent),
    ...(prior.template_application ? { template_application: prior.template_application } : {}),
  };
}
export const snapshot = (revision: Entity) => pick(revision.data, draftFields);
export const changedFields = (from: Fields | null, to: Fields | null) => draftFields.filter(field => hash(from?.[field]) !== hash(to?.[field]));
export function render(draft: Fields) {
  const body = draft.body as string;
  return { text: body, char_count: [...body].length, hashtags: [...new Set(body.match(/#[\p{L}\p{N}_]+/gu) ?? [])],
    mentions: [...new Set(body.match(/@[\p{L}\p{N}_.]+/gu) ?? [])], links: [...new Set(body.match(/https?:\/\/[^\s<>]+/g) ?? [])] };
}
export function references(draft: Fields) {
  const output = new Map<string, { ref_type: string; ref_id: string }>();
  function add(ref_type: string, ref_id?: string) {
    if (ref_id) output.set(`${ref_type}:${ref_id}`, { ref_type, ref_id });
  }
  for (const media of draft.media) {
    add('asset', media.asset_id); add('asset_version', media.asset_version_id);
    add('asset_rendition', media.rendition_id); add('asset_rendition', media.caption_rendition_id);
  }
  for (const ref of draft.product_refs) {
    add('product_variant', ref.variant_id); add('product_fact_revision', ref.fact_revision_id); add('listing_snapshot', ref.listing_snapshot_id);
  }
  for (const ref of draft.link_refs) add('short_link', ref.short_link_id);
  for (const ref of draft.knowledge_refs) add('knowledge_entry', ref);
  return [...output.values()];
}
export function webUrl(value: unknown) {
  const raw = text(value, 'url', 2048);
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    return url.href;
  } catch { fail('invalid_input', 'Expected an HTTP(S) URL without credentials'); }
}
