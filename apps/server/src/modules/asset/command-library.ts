import { admins, readers, required, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { emit, expectVersion, get, hash, insert, integer, invalid, conflict, list, object, option, optional, strings, update } from './command-model.ts';
import { compatibleMediaFile } from '../../integration/media-host.js';
import { checkUsage } from './command-rights.ts';

export const assetKinds = ['image', 'video', 'audio', 'subtitle', 'document', 'design_link'];
const origins = ['upload', 'ugc', 'creator_delivery', 'design_tool', 'import', 'ai_generated', 'stock'];
const renditionKinds = ['platform_resize', 'crop', 'subtitle_burned', 'cover', 'thumbnail', 'transcode', 'preview', 'waveform'];
const relations: Record<string, [string, string]> = {
  product: ['commerce', 'product'], product_variant: ['commerce', 'product_variant'], campaign: ['campaign', 'campaign'],
};

export function safeUrl(input: Fields, key: string): string | null {
  const value = optional(input, key, 2048);
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch { /* Report the field uniformly. */ }
  return invalid(`Invalid ${key} HTTPS URL`);
}

async function folderFor(ctx: Context, folderId: string | null, brandId: string): Promise<Entity | null> {
  if (!folderId) return null;
  const folder = await get(ctx, 'asset_folder', folderId);
  if (folder.data.archived_at || folder.data.brand_id && folder.data.brand_id !== brandId) invalid('Folder belongs to another brand');
  return folder;
}

export async function verifiedFile(ctx: Context, id: string, purposes = ['asset']): Promise<Entity> {
  const file = await compatibleMediaFile(ctx, id, purposes) ?? await required(ctx, 'core', 'file_object', id);
  if (!purposes.includes(file.data.purpose) || file.data.deleted_at || !['clean', 'skipped'].includes(file.data.scan_status)) conflict('File is unavailable or has not cleared scanning');
  return file;
}

async function appendVersion(ctx: Context, asset: Entity, input: Fields, file: Entity): Promise<{ asset: Entity; version: Entity }> {
  const sha = file.data.sha256;
  if (typeof sha !== 'string' || !/^[a-f0-9]{64}$/i.test(sha)) invalid('File is missing a verified SHA-256');
  const sha256 = sha.toLowerCase();
  const mimeType = text(file.data, 'mime_type', 256);
  if (['image', 'video', 'audio'].includes(asset.data.kind) && !mimeType.startsWith(`${asset.data.kind}/`)) invalid('File MIME type does not match the asset kind');
  if (input.sha256 !== undefined && text(input, 'sha256', 64).toLowerCase() !== sha256) invalid('sha256 does not match the stored object');
  const thumbnailId = file.data.thumbnail_file_id ?? null;
  if (thumbnailId) await verifiedFile(ctx, thumbnailId);
  const predecessor = asset.data.current_version_id ? await get(ctx, 'asset_version', asset.data.current_version_id) : null;
  const version = await insert(ctx, 'asset_version', {
    asset_id: asset.id, version_no: (predecessor?.data.version_no ?? 0) + 1,
    file_object_id: file.id, sha256, mime_type: mimeType,
    meta: file.data.meta ?? {}, thumbnail_file_id: thumbnailId, perceptual_hash: file.data.perceptual_hash ?? null,
    change_note: optional(input, 'change_note'), external_version: optional(input, 'external_version', 256), created_by_id: ctx.actorId,
  });
  const updated = await update(ctx, asset, { current_version_id: version.id, status: 'ready' });
  await emit(ctx, 'version.created', { asset_id: asset.id, asset_version_id: version.id, version_no: version.data.version_no });
  if (file.data.storage_key && file.data.purpose === 'asset' && !thumbnailId && ['image', 'video'].includes(asset.data.kind)) {
    await requestRendition(ctx, { asset_version_id: version.id, kind: 'thumbnail' });
  }
  await emit(ctx, 'asset.ready', { asset_id: asset.id, asset_version_id: version.id });
  return { asset: updated, version };
}

async function linkAsset(ctx: Context, asset: Entity, input: Fields): Promise<Entity> {
  const link_type = option(input, 'link_type', Object.keys(relations));
  const link_id = text(input, 'link_id', 256);
  const [module, kind] = relations[link_type];
  const target = await required(ctx, module, kind, link_id);
  const parent = link_type === 'product_variant' && !target.data.brand_id
    ? await required(ctx, 'commerce', 'product', target.data.product_id) : target;
  if (parent.data.brand_id !== asset.data.brand_id) invalid('Linked object must belong to the asset brand');
  const prior = (await list(ctx, 'asset_link')).find(row => row.data.asset_id === asset.id && row.data.link_id === link_id && row.data.link_type === link_type);
  if (prior?.data.status === 'unlinked') return update(ctx, prior, { status: 'active' });
  return prior ?? insert(ctx, 'asset_link', { asset_id: asset.id, link_type, link_id, status: 'active' });
}

export async function createAsset(ctx: Context, input: Fields, file: Entity): Promise<{ asset: Entity; version: Entity }> {
  const brandId = text(input, 'brand_id', 256);
  await required(ctx, 'workspace', 'brand', brandId);
  const folder = await folderFor(ctx, optional(input, 'folder_id', 256), brandId);
  const provenance = input.origin_ref == null ? {} : object(input.origin_ref, 'origin_ref');
  const asset = await insert(ctx, 'asset', {
    brand_id: brandId, folder_id: folder?.id ?? null,
    kind: option(input, 'kind', assetKinds), title: text(input, 'title', 512), description: optional(input, 'description'),
    tags: strings(input.tags ?? [], 'tags'), locale: optional(input, 'locale', 35),
    origin: input.origin === undefined ? 'upload' : option(input, 'origin', origins),
    origin_ref: { ...provenance, edit_url: safeUrl(provenance, 'edit_url'), external_url: safeUrl(provenance, 'external_url') },
    status: 'processing', current_version_id: null, created_by_id: ctx.actorId,
  });
  await emit(ctx, 'asset.created', { asset_id: asset.id });
  if (input.links !== undefined) {
    if (!Array.isArray(input.links) || input.links.length > 100) invalid('Invalid links');
    for (const link of input.links) await linkAsset(ctx, asset, object(link, 'link'));
  }
  return appendVersion(ctx, asset, input, file);
}

const rowsFor = (rows: Entity[], key: string, id: string) => rows.filter(row => row.data[key] === id);

async function usage(ctx: Context, asset: Entity, versions: Entity[], renditions: Entity[]) {
  const ids = new Map([
    ['asset', new Set([asset.id])], ['asset_version', new Set(versions.map(row => row.id))],
    ['asset_rendition', new Set(renditions.map(row => row.id))],
  ]);
  const matches = (row: Entity) => ids.get(row.data.ref_type)?.has(row.data.ref_id) ?? false;
  const content = (await ctx.list('content', 'content_reference')).filter(matches);
  const targetRefs = (await ctx.list('planning', 'publish_target_ref')).filter(matches);
  const targetIds = new Set(targetRefs.map(row => row.data.publish_target_id ?? row.data.target_id).filter(Boolean));
  const revisionIds = new Set(content.map(row => row.data.revision_id ?? row.data.content_revision_id).filter(Boolean));
  const targets = (await ctx.list('planning', 'publish_target')).filter(row => targetIds.has(row.id) ||
    revisionIds.has(row.data.revision_id ?? row.data.variant_revision_id) || row.data.frozen?.asset_versions?.some((item: Fields) => ids.get('asset_version')?.has(item.id)));
  for (const target of targets) targetIds.add(target.id);
  const tasks = new Map((await ctx.list('execution', 'execution_task')).map(row => [row.id, row]));
  const posts = (await ctx.list('execution', 'platform_post')).filter(row => targetIds.has(row.data.publish_target_id ?? row.data.target_id ?? tasks.get(row.data.execution_task_id)?.data.publish_target_id) || revisionIds.has(row.data.variant_revision_id));
  const ads = (await ctx.list('ads', 'ad_creative_variant')).filter(row => row.data.rendition_ids?.some((id: string) => ids.get('asset_rendition')?.has(id)));
  return { content, targets, target_refs: targetRefs, posts, ads };
}

async function assetFiles(ctx: Context, asset: Entity) {
  const versions = rowsFor(await list(ctx, 'asset_version'), 'asset_id', asset.id).sort((a, b) => b.data.version_no - a.data.version_no);
  const ids = new Set(versions.map(v => v.id));
  const renditions = (await list(ctx, 'asset_rendition')).filter(r => ids.has(r.data.asset_version_id));
  return { versions, renditions };
}

async function requestRendition(ctx: Context, input: Fields): Promise<Entity> {
  const version = await get(ctx, 'asset_version', text(input, 'asset_version_id', 256));
  const asset = await get(ctx, 'asset', version.data.asset_id);
  if (asset.data.status === 'archived') conflict('Asset is archived');
  await verifiedFile(ctx, version.data.file_object_id, ['asset', 'import']);
  const kind = option(input, 'kind', renditionKinds);
  const params = object(input.params ?? {}, 'params');
  for (const key of ['width', 'height', 'max_bytes']) if (Object.hasOwn(params, key)) integer(params[key], key, 1, Number.MAX_SAFE_INTEGER);
  if (JSON.stringify(params).length > 16_384) invalid('Rendition parameters exceed size limit');
  const target_platform = optional(input, 'target_platform', 100);
  if (params.subtitle_asset_version_id !== undefined) {
    const subtitle = await get(ctx, 'asset_version', text(params, 'subtitle_asset_version_id', 256));
    const subtitleAsset = await get(ctx, 'asset', subtitle.data.asset_id);
    await verifiedFile(ctx, subtitle.data.file_object_id, ['asset', 'import']);
    if (subtitleAsset.data.status === 'archived' || subtitleAsset.data.kind !== 'subtitle' || subtitleAsset.data.brand_id !== asset.data.brand_id) invalid('Invalid subtitle source');
  }
  const params_hash = hash({ kind, params, target_platform });
  const same = (await list(ctx, 'asset_rendition')).find(row => row.data.asset_version_id === version.id && row.data.params_hash === params_hash);
  if (same) return same.data.status === 'failed' ? retryRendition(ctx, same) : same;
  // A deterministic scoped ID also prevents duplicate rows under concurrent requests.
  const id = hash([ctx.workspaceId, version.id, params_hash]);
  const rendition = await insert(ctx, 'asset_rendition', {
    asset_version_id: version.id, kind, params, target_platform, params_hash, status: 'queued', attempts: 1,
  }, id);
  await emit(ctx, 'rendition.requested', { rendition_id: rendition.id, asset_version_id: version.id, attempt: 1 });
  return rendition;
}

async function retryRendition(ctx: Context, row: Entity) {
  if (row.data.status !== 'failed') conflict('Only failed renditions can be retried');
  const source = await get(ctx, 'asset_version', row.data.asset_version_id);
  if ((await get(ctx, 'asset', source.data.asset_id)).data.status === 'archived') conflict('Asset is archived');
  await verifiedFile(ctx, source.data.file_object_id, ['asset', 'import']);
  const attempt = row.data.attempts + 1;
  const updated = await update(ctx, row, { status: 'queued', attempts: attempt, error: null, file_object_id: null, meta: null });
  await emit(ctx, 'rendition.requested', { rendition_id: row.id, asset_version_id: source.id, attempt });
  return updated;
}

export const libraryCommands: Commands = {
  asset_create: { roles: writers, async run(ctx, input) {
    return createAsset(ctx, input, await verifiedFile(ctx, text(input, 'file_object_id', 256)));
  } },
  asset_add_version: { roles: writers, async run(ctx, input) {
    const asset = await get(ctx, 'asset', text(input, 'asset_id', 256));
    expectVersion(asset, input);
    if (asset.data.status === 'archived') conflict('Asset is archived');
    return appendVersion(ctx, asset, input, await verifiedFile(ctx, text(input, 'file_object_id', 256)));
  } },
  asset_get: { roles: readers, async run(ctx, input) {
    const asset = await get(ctx, 'asset', text(input, 'asset_id', 256));
    const files = await assetFiles(ctx, asset);
    const scope = rowsFor(await list(ctx, 'rights_grant_asset'), 'asset_id', asset.id);
    const ids = new Set(scope.map(row => row.data.rights_grant_id));
    const grants = (await list(ctx, 'rights_grant')).filter(row => ids.has(row.id));
    const links = rowsFor(await list(ctx, 'asset_link'), 'asset_id', asset.id).filter(row => row.data.status !== 'unlinked');
    return { asset, ...files, grants, scope, links, usage: await usage(ctx, asset, files.versions, files.renditions) };
  } },
  asset_usage: { roles: readers, async run(ctx, input) {
    const asset = await get(ctx, 'asset', text(input, 'asset_id', 256));
    const { versions, renditions } = await assetFiles(ctx, asset);
    return usage(ctx, asset, versions, renditions);
  } },
  asset_search: { roles: readers, async run(ctx, input) {
    const keyword = optional(input, 'q', 512)?.toLocaleLowerCase();
    const filters = ['brand_id', 'kind', 'folder_id', 'locale', 'status'] as const;
    const tag = optional(input, 'tag', 256);
    const scope = input.usable_for === undefined ? null : object(input.usable_for, 'usable_for');
    const relationFilters = Object.keys(relations).filter(type => input[`${type}_id`]);
    const links = relationFilters.length ? (await list(ctx, 'asset_link')).filter(row => row.data.status !== 'unlinked') : [];
    const favorites = input.favorite_only === true ? (await list(ctx, 'asset_favorite')).filter(row => row.data.actor_id === ctx.actorId && row.data.active) : null;
    const result: Entity[] = [];
    for (const asset of await list(ctx, 'asset')) {
      const data = asset.data;
      if (!filters.every(key => input[key] === undefined || data[key] === input[key])) continue;
      if (data.status === 'archived' && input.status === undefined) continue;
      const tags = Array.isArray(data.tags) ? data.tags : [];
      if (keyword && ![data.title, data.description, ...tags].some(value => typeof value === 'string' && value.toLocaleLowerCase().includes(keyword))) continue;
      if (tag && !tags.includes(tag)) continue;
      if (relationFilters.some(type => !links.some(row => row.data.asset_id === asset.id && row.data.link_type === type && row.data.link_id === input[`${type}_id`]))) continue;
      if (favorites && !favorites.some(row => row.data.asset_id === asset.id)) continue;
      if (scope && (!data.current_version_id || !(await checkUsage(ctx, {
        asset_version_id: data.current_version_id, at: scope.at ?? ctx.now, purpose: scope.purpose ?? scope.usage,
        platform: scope.platform, market: scope.market ?? scope.region, modification: scope.modification,
      })).allowed)) continue;
      result.push(asset);
    }
    return result;
  } },
  asset_update: { roles: writers, async run(ctx, input) {
    const asset = await get(ctx, 'asset', text(input, 'asset_id', 256));
    expectVersion(asset, input);
    const patch: Fields = {};
    if (Object.hasOwn(input, 'title')) patch.title = text(input, 'title', 512);
    if (Object.hasOwn(input, 'description')) patch.description = optional(input, 'description');
    if (Object.hasOwn(input, 'locale')) patch.locale = optional(input, 'locale', 35);
    if (Object.hasOwn(input, 'tags')) patch.tags = strings(input.tags, 'tags');
    if (Object.hasOwn(input, 'folder_id')) patch.folder_id = (await folderFor(ctx, optional(input, 'folder_id', 256), asset.data.brand_id))?.id ?? null;
    if (!Object.keys(patch).length) invalid('Provide an editable asset field');
    return update(ctx, asset, patch);
  } },
  asset_archive: { roles: writers, async run(ctx, input) {
    const asset = await get(ctx, 'asset', text(input, 'asset_id', 256));
    expectVersion(asset, input);
    if (asset.data.status === 'archived') return asset;
    const archived = await update(ctx, asset, { status: 'archived', archived_at: ctx.now });
    await emit(ctx, 'asset.archived', { asset_id: asset.id });
    return archived;
  } },
  asset_folder_create: { roles: admins, async run(ctx, input) {
    const brandId = optional(input, 'brand_id', 256);
    if (brandId) await required(ctx, 'workspace', 'brand', brandId);
    const parentId = optional(input, 'parent_id', 256);
    const parent = parentId ? await get(ctx, 'asset_folder', parentId) : null;
    if (parent?.data.brand_id && parent.data.brand_id !== brandId) invalid('Folder parent belongs to another brand');
    const name = text(input, 'name', 256);
    if (name.includes('/')) invalid('Folder names cannot contain slashes');
    const path = `${parent?.data.path ?? ''}/${name}`;
    if ((await list(ctx, 'asset_folder')).some(row => row.data.brand_id === brandId && row.data.path === path)) conflict('Folder path already exists');
    return insert(ctx, 'asset_folder', { name, path, parent_id: parentId, brand_id: brandId });
  } },
  asset_link: { roles: writers, async run(ctx, input) {
    return linkAsset(ctx, await get(ctx, 'asset', text(input, 'asset_id', 256)), input);
  } },
  asset_unlink: { roles: writers, async run(ctx, input) {
    const link = await get(ctx, 'asset_link', text(input, 'link_record_id', 256));
    expectVersion(link, input);
    return link.data.status === 'unlinked' ? link : update(ctx, link, { status: 'unlinked' });
  } },
  asset_set_favorite: { roles: readers, async run(ctx, input) {
    const asset = await get(ctx, 'asset', text(input, 'asset_id', 256));
    if (typeof input.active !== 'boolean') invalid('Invalid active');
    const id = hash([ctx.workspaceId, ctx.actorId, asset.id]);
    const prior = await ctx.get('asset', 'asset_favorite', id);
    return prior ? update(ctx, prior, { active: input.active }) : insert(ctx, 'asset_favorite', { actor_id: ctx.actorId, asset_id: asset.id, active: input.active }, id);
  } },
  asset_find_duplicates: { roles: readers, async run(ctx, input) {
    const version = await get(ctx, 'asset_version', text(input, 'asset_version_id', 256));
    const asset = await get(ctx, 'asset', version.data.asset_id);
    const brandAssets = new Set((await list(ctx, 'asset')).filter(row => row.data.brand_id === asset.data.brand_id && row.data.status !== 'archived').map(row => row.id));
    return (await list(ctx, 'asset_version')).filter(row => row.id !== version.id && brandAssets.has(row.data.asset_id) && row.data.sha256 === version.data.sha256);
  } },
  asset_request_rendition: { roles: writers, run: requestRendition },
  asset_rendition_get: { roles: readers, run: (ctx, input) => get(ctx, 'asset_rendition', text(input, 'rendition_id', 256)) },
  asset_retry_rendition: { roles: writers, async run(ctx, input) {
    const row = await get(ctx, 'asset_rendition', text(input, 'rendition_id', 256));
    expectVersion(row, input);
    return retryRendition(ctx, row);
  } },
  asset_update_rendition_status: { roles: admins, async run(ctx, input) {
    const row = await get(ctx, 'asset_rendition', text(input, 'rendition_id', 256));
    if (integer(input.attempt, 'attempt', 1, Number.MAX_SAFE_INTEGER) !== row.data.attempts) conflict('Stale rendition attempt');
    const status = option(input, 'status', ['processing', 'ready', 'failed']);
    if (status === 'processing' ? row.data.status !== 'queued' : row.data.status !== 'processing') conflict('Invalid rendition state transition');
    const patch: Fields = { status };
    if (status === 'ready') {
      const file = await verifiedFile(ctx, text(input, 'file_object_id', 256));
      patch.file_object_id = file.id;
      patch.meta = file.data.meta ?? {};
    } else if (status === 'failed') patch.error = text(input, 'error');
    const updated = await update(ctx, row, patch);
    if (status !== 'processing') await emit(ctx, `rendition.${status}`, { rendition_id: row.id, asset_version_id: row.data.asset_version_id });
    return updated;
  } },
};
