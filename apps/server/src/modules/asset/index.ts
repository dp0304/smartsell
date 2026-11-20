import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { makeThumbnail } from '../../../../../packages/media-store/src/index.js';
import { ADMIN, APPROVE, Problem, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { choose, hash, object, objects, pick, str, strings } from './values.js';
import { activateGrant, checkUsage, createGrant, grantKind, reviseGrant, renewGrant, revokeGrant, rightsDetail, scanExpiry } from './rights.js';
import { approveKnowledge, context, knowledgeDetail, proposeKnowledge, rejectKnowledge, retireKnowledge } from './knowledge.js';
import { commandContext, toRest } from '../content/operations.js';
import type { Commands } from '../types.ts';
import { rightsCommands } from './command-rights.ts';
import { knowledgeCommands } from './command-knowledge.ts';
import { libraryCommands, safeUrl, verifiedFile } from './command-library.ts';
import { mediaFor } from '../../integration/media-host.js';
import { requireMediaFile } from '../../extensions/media-files.js';
import { assertUsageAllowed } from '../ops/metering.js';
import { acceptSubmission, acceptSubmissionBatch, intakeCommands } from './command-intake.ts';

export { checkUsage, type UsageInput, type UsageResult } from './command-rights.ts';
export { scanExpiry as scanAssetRightsExpiry } from './rights.js';
export const schedules = [{ id: 'asset.rights_expiry_scan', intervalMs: 86_400_000, run: scanExpiry }];
export const commands: Commands = { ...libraryCommands, ...rightsCommands, ...knowledgeCommands, ...intakeCommands };

const ASSET = 'asset';
const VERSION = 'asset_version';
const RENDITION = 'asset_rendition';
const FOLDER = 'asset_folder';
const kindNames = ['image', 'video', 'audio', 'subtitle', 'document', 'design_link'];
const assetOrigins = ['upload', 'ugc', 'creator_delivery', 'design_tool', 'import', 'ai_generated', 'stock'];
const renditionKinds = ['platform_resize', 'crop', 'subtitle_burned', 'cover', 'thumbnail', 'transcode', 'preview', 'waveform'];
const by = (ctx: Context) => ({ created_by_type: ctx.role === 'agent' ? 'agent' : 'user', created_by_id: ctx.actorId });
const has = (body: Data, key: string) => Object.hasOwn(body, key);
const optionalText = (value: unknown, name: string) => value == null ? null : str(value, name, 4096);
const clean = (file: Row) => !file.deleted_at && ['clean', 'skipped'].includes(String(file.scan_status));

function getFile(ctx: Context, body: Data, purposes: string[]) {
  const upload = body.file_object_id == null && body.upload_id != null ? ctx.get('file_upload', str(body.upload_id, 'upload_id')) : undefined;
  if (upload && !upload.file_object_id) throw new Problem(422, 'FILE_INCOMPLETE', 'Finish uploading the file before attaching it');
  if (upload && upload.created_by_id !== ctx.actorId) throw new Problem(404, 'NOT_FOUND', 'Upload not found');
  const file = ctx.get('file_object', str(body.file_object_id ?? upload?.file_object_id, 'file_object_id'));
  if (file.storage_key) return requireMediaFile(ctx, file.id, purposes);
  if (file.deleted_at || file.scan_status === 'infected' || !purposes.includes(String(file.purpose))) throw new Problem(422, 'FILE_UNAVAILABLE', 'The selected file cannot be used for this operation');
  if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256) || typeof file.mime_type !== 'string') throw new Problem(422, 'FILE_INCOMPLETE', 'Finish uploading the file before attaching it');
  return file;
}
function originReference(value: unknown) {
  const ref = object(value, 'origin_ref');
  try { return { ...ref, edit_url: safeUrl(ref, 'edit_url'), external_url: safeUrl(ref, 'external_url') }; }
  catch (error) { throw new Problem(422, 'INVALID_INPUT', (error as Error).message); }
}
function folderId(ctx: Context, value: unknown, brand: unknown) {
  if (value == null) return null;
  const folder = ctx.get(FOLDER, str(value, 'folder_id'));
  if (folder.archived_at || (folder.brand_id != null && folder.brand_id !== brand)) throw new Problem(422, 'FOLDER_UNAVAILABLE', 'The folder is unavailable for this brand');
  return folder.id;
}
function setLinks(ctx: Context, asset: Row, value: unknown) {
  const links = new Map<string, Data>();
  for (const link of objects(value, 'links')) {
    const link_type = choose(link.link_type, 'link_type', ['product', 'product_variant', 'campaign']);
    const resource = ctx.get(link_type, str(link.link_id, 'link_id'));
    const brand = link_type === 'product_variant' ? ctx.get('product', String(resource.product_id)).brand_id : resource.brand_id;
    if (brand !== asset.brand_id) throw new Problem(422, 'BRAND_MISMATCH', 'Asset links must stay within the same brand');
    links.set(`${link_type}:${resource.id}`, { link_type, link_id: resource.id });
  }
  for (const existing of ctx.list('asset_link').filter(row => row.asset_id === asset.id)) {
    const key = `${existing.link_type}:${existing.link_id}`;
    if (!links.delete(key)) ctx.remove('asset_link', existing.id);
  }
  for (const link of links.values()) ctx.create('asset_link', { asset_id: asset.id, ...link });
}
function versionMeta(value: unknown): Data {
  const values = Object.hasOwn((value ?? {}) as object, 'meta') ? (value as Data).meta : value;
  const source = object(values ?? {}, 'meta');
  const meta = pick(source, ['width', 'height', 'duration_ms', 'fps', 'codec', 'bitrate', 'has_audio', 'color_space', 'pages']);
  if (meta.duration_ms == null && typeof source.duration_seconds === 'number') meta.duration_ms = Math.round(source.duration_seconds * 1000);
  if (meta.codec == null && (source.video_codec || source.audio_codec)) meta.codec = source.video_codec ?? source.audio_codec;
  if (meta.has_audio == null && (source.video_codec || source.audio_codec)) meta.has_audio = typeof source.audio_codec === 'string';
  for (const key of ['width', 'height', 'duration_ms', 'fps', 'bitrate', 'pages']) if (has(meta, key) && (typeof meta[key] !== 'number' || !Number.isFinite(meta[key]) || Number(meta[key]) < 0)) throw new Problem(422, 'INVALID_INPUT', `Invalid meta.${key}`);
  if (has(meta, 'has_audio') && typeof meta.has_audio !== 'boolean') throw new Problem(422, 'INVALID_INPUT', 'Invalid meta.has_audio');
  return meta;
}
function addVersion(ctx: Context, asset: Row, body: Data, file = getFile(ctx, body, ['asset'])) {
  if (asset.archived_at || asset.status === 'archived') throw new Problem(409, 'ASSET_ARCHIVED', 'Archived assets cannot take new versions');
  const version_no = ctx.list(VERSION).filter(row => row.asset_id === asset.id).reduce((max, row) => Math.max(max, Number(row.version_no)), 0) + 1;
  const kind = String(asset.kind);
  if (['image', 'video', 'audio'].includes(kind) && !String(file.mime_type).startsWith(`${kind}/`)) throw new Problem(422, 'FILE_TYPE_MISMATCH', 'The file type does not match the asset');
  const thumbnail = file.thumbnail_file_id == null ? null : getFile(ctx, { file_object_id: file.thumbnail_file_id }, ['asset']);
  const thumbnail_file_id = thumbnail && clean(thumbnail) ? thumbnail.id : null;
  const version = ctx.create(VERSION, {
    asset_id: asset.id, version_no, file_object_id: file.id, mime_type: file.mime_type, sha256: file.sha256,
    meta: versionMeta(file.meta), thumbnail_file_id, change_note: optionalText(body.change_note, 'change_note'),
    external_version: optionalText(body.external_version, 'external_version'), ...by(ctx),
  });
  const result = ctx.update(ASSET, asset.id, { current_version_id: version.id, status: clean(file) ? 'ready' : 'processing' });
  ctx.emit('asset.version.created', { asset_id: asset.id, asset_version_id: version.id, version_no });
  if (clean(file) && !thumbnail_file_id && ['image', 'video'].includes(kind)) requestRendition(ctx, version.id, { kind: 'thumbnail' });
  if (result.status === 'ready') ctx.emit('asset.asset.ready', { asset_id: asset.id, asset_version_id: version.id });
  return { asset: result, asset_version: version };
}
function assetUsage(ctx: Context, asset: Row) {
  const ids = new Map<string, Set<unknown>>([
    [ASSET, new Set([asset.id])],
    [VERSION, new Set(ctx.list(VERSION).filter(row => row.asset_id === asset.id).map(row => row.id))],
  ]);
  ids.set(RENDITION, new Set(ctx.list(RENDITION).filter(row => ids.get(VERSION)?.has(row.asset_version_id)).map(row => row.id)));
  const matches = (row: Row) => ids.get(String(row.ref_type))?.has(row.ref_id);
  const references = ctx.list('content_reference').filter(matches);
  const target_refs = ctx.list('publish_target_ref').filter(matches);
  const explicitTargets = new Set(target_refs.map(row => row.publish_target_id ?? row.target_id));
  const revisionIds = new Set(references.map(row => row.revision_id ?? row.content_revision_id).filter(Boolean));
  const targets = ctx.list('publish_target').filter(row => {
    const frozen = row.frozen as Data | undefined;
    return explicitTargets.has(row.id) || revisionIds.has(row.variant_revision_id ?? row.revision_id) ||
      (Array.isArray(frozen?.asset_versions) && frozen.asset_versions.some(item => ids.get(VERSION)?.has(item?.id)));
  });
  const targetIds = new Set(targets.map(row => row.id));
  const taskIds = new Set(ctx.list('execution_task').filter(row => targetIds.has(String(row.publish_target_id))).map(row => row.id));
  const ads = ctx.list('ad_creative_variant').filter(row => Array.isArray(row.rendition_ids) && row.rendition_ids.some(id => ids.get(RENDITION)?.has(id)));
  return { references, target_refs, ads, publish_targets: targets, platform_posts: ctx.list('platform_post').filter(row => revisionIds.has(row.variant_revision_id) || targetIds.has(String(row.publish_target_id ?? row.target_id)) || taskIds.has(String(row.execution_task_id))) };
}
function assetDetail(ctx: Context, asset: Row) {
  const versions = ctx.list(VERSION).filter(row => row.asset_id === asset.id).sort((a, b) => Number(b.version_no) - Number(a.version_no));
  const versionIds = new Set(versions.map(row => row.id));
  const grants = new Set(ctx.list('rights_grant_asset').filter(row => row.asset_id === asset.id).map(row => row.rights_grant_id));
  return {
    ...asset, versions, renditions: ctx.list(RENDITION).filter(row => versionIds.has(String(row.asset_version_id))),
    rights_grants: ctx.list(grantKind).filter(row => grants.has(row.id)), links: ctx.list('asset_link').filter(row => row.asset_id === asset.id),
    usage: assetUsage(ctx, asset),
  };
}
function changeFolder(ctx: Context, body: Data, old?: Row) {
  const brand_id = body.brand_id == null ? old?.brand_id ?? null : ctx.get('brand', str(body.brand_id, 'brand_id')).id;
  const parent_id = has(body, 'parent_id') ? folderId(ctx, body.parent_id, brand_id) : old?.parent_id ?? null;
  if (old && brand_id !== old.brand_id) throw new Problem(422, 'BRAND_MISMATCH', 'Folder brand is fixed');
  const parent = parent_id ? ctx.get(FOLDER, String(parent_id)) : null;
  if (parent && (parent.id === old?.id || String(parent.path).startsWith(`${old?.path}/`))) throw new Problem(422, 'FOLDER_CYCLE', 'A folder cannot be nested inside itself');
  const name = str(body.name ?? old?.name, 'name', 200);
  if (ctx.list(FOLDER).some(row => !row.archived_at && row.id !== old?.id && row.brand_id === brand_id && (row.parent_id ?? null) === parent_id && row.name === name)) throw new Problem(409, 'FOLDER_EXISTS', 'A folder already has this name');
  const result = old ? ctx.update(FOLDER, old.id, { parent_id, name }) : ctx.create(FOLDER, { name, parent_id, brand_id });
  const path = `${parent?.path ?? ''}/${result.id}`;
  if (path === old?.path) return result;
  for (const row of ctx.list(FOLDER)) if (old && row.id !== old.id && String(row.path).startsWith(`${old.path}/`)) ctx.update(FOLDER, row.id, { path: path + String(row.path).slice(String(old.path).length) });
  return ctx.update(FOLDER, result.id, { path });
}
function archiveAsset(ctx: Context, asset: Row) {
  if (asset.status === 'archived') return asset;
  const row = ctx.update(ASSET, asset.id, { status: 'archived', archived_at: ctx.now });
  ctx.emit('asset.asset.archived', { asset_id: asset.id });
  return row;
}
function deleteAsset(ctx: Context, asset: Row) {
  if (asset.status !== 'archived') throw new Problem(409, 'ARCHIVE_REQUIRED', 'Archive this asset before deleting it');
  const detail = assetDetail(ctx, asset);
  const versionIds = new Set(detail.versions.map(row => row.id));
  const subtitleUse = ctx.list(RENDITION).some(row => !versionIds.has(String(row.asset_version_id)) && versionIds.has(String((row.params as Data | undefined)?.subtitle_asset_version_id)));
  const intakeUse = ctx.list('submission').some(row => Array.isArray(row.accepted_asset_ids) && row.accepted_asset_ids.includes(asset.id));
  if (subtitleUse || intakeUse || Object.values(detail.usage).some(rows => rows.length)) throw new Problem(409, 'ASSET_REFERENCED', 'Another record references this asset');
  if (detail.rights_grants.length) throw new Problem(409, 'RIGHTS_RETENTION', 'A rights grant still refers to this asset');
  if (ctx.list('deliverable_version').some(row => Array.isArray(row.asset_ids) && row.asset_ids.includes(asset.id))) throw new Problem(409, 'ASSET_REFERENCED', 'A creator deliverable references this asset');
  const files = new Set([...detail.versions, ...detail.renditions].flatMap(row => [row.file_object_id, row.thumbnail_file_id]));
  if (ctx.list('file_object').some(row => files.has(row.id) && typeof row.retention_until === 'string' && Date.parse(row.retention_until) > Date.parse(ctx.now))) throw new Problem(409, 'FILE_RETENTION', 'A file is still in its retention period');
  for (const row of detail.links) ctx.remove('asset_link', row.id);
  for (const kind of ['asset_favorite', 'external_source']) {
    for (const row of ctx.list(kind).filter(row => row.asset_id === asset.id)) ctx.remove(kind, row.id);
  }
  for (const row of detail.renditions) ctx.remove(RENDITION, row.id);
  for (const row of detail.versions) ctx.remove(VERSION, row.id);
  ctx.remove(ASSET, asset.id);
  ctx.emit('asset.asset.deleted', { asset_id: asset.id });
  return { id: asset.id, deleted: true };
}
function requestRendition(ctx: Context, id: string, body: Data) {
  const version = ctx.get(VERSION, id);
  const asset = ctx.get(ASSET, String(version.asset_id));
  if (asset.status === 'archived') throw new Problem(409, 'ASSET_ARCHIVED', 'Archived assets cannot take new renditions');
  if (!clean(ctx.get('file_object', String(version.file_object_id)))) throw new Problem(422, 'FILE_UNAVAILABLE', 'The source file requires a successful scan');
  const kind = choose(body.kind, 'kind', renditionKinds);
  const params = object(body.params ?? {}, 'params');
  if (JSON.stringify(params).length > 16_384) throw new Problem(422, 'INVALID_INPUT', 'Rendition parameters are too large');
  for (const key of ['width', 'height', 'max_bytes']) if (has(params, key) && (!Number.isSafeInteger(params[key]) || Number(params[key]) <= 0)) throw new Problem(422, 'INVALID_INPUT', `Invalid params.${key}`);
  if (params.subtitle_asset_version_id != null) {
    const subtitle = ctx.get(VERSION, str(params.subtitle_asset_version_id, 'subtitle_asset_version_id'));
    const subtitleAsset = ctx.get(ASSET, String(subtitle.asset_id));
    if (subtitleAsset.status === 'archived' || !clean(ctx.get('file_object', String(subtitle.file_object_id))) || subtitleAsset.kind !== 'subtitle' || subtitleAsset.brand_id !== asset.brand_id) throw new Problem(422, 'ASSET_UNAVAILABLE', 'Subtitle version must belong to the same brand');
  }
  imageRecipe(kind, params, version);
  const target_platform = optionalText(body.target_platform, 'target_platform');
  const params_hash = hash({ kind, params, target_platform });
  const existing = ctx.list(RENDITION).find(row => row.asset_version_id === id && row.params_hash === params_hash);
  if (existing && existing.status !== 'failed') return existing;
  const row = existing
    ? ctx.update(RENDITION, existing.id, { status: 'queued', error: null, attempts: Number(existing.attempts) + 1, file_object_id: null, meta: null })
    : ctx.create(RENDITION, { asset_version_id: id, kind, params, params_hash, target_platform, file_object_id: null, status: 'queued', attempts: 1 });
  ctx.emit('asset.rendition.requested', { asset_version_id: id, asset_rendition_id: row.id, rendition_id: row.id, attempts: row.attempts, attempt: row.attempts });
  return row;
}
function finishRendition(ctx: Context, row: Row, body: Data) {
  if (body.attempt !== row.attempts) throw new Problem(409, 'RENDITION_STALE_ATTEMPT', 'Report the current rendition attempt');
  const status = choose(body.status, 'status', ['processing', 'ready', 'failed']);
  if (row.status !== (status === 'processing' ? 'queued' : 'processing')) throw new Problem(409, 'RENDITION_INVALID_STATE', 'Invalid rendition transition');
  if (status === 'processing') return ctx.update(RENDITION, row.id, { status });
  const patch: Data = { status };
  if (status === 'ready') {
    const file = getFile(ctx, body, ['asset']);
    if (!clean(file)) throw new Problem(422, 'FILE_UNAVAILABLE', 'The rendition file requires a successful scan');
    patch.file_object_id = file.id;
    patch.meta = versionMeta(file.storage_key ? file.meta : body.meta ?? file.meta);
  } else patch.error = str(body.error, 'error', 4000);
  const out = ctx.update(RENDITION, row.id, patch);
  ctx.emit(`asset.rendition.${status}`, { asset_rendition_id: row.id, rendition_id: row.id, asset_version_id: row.asset_version_id, attempt: row.attempts });
  return out;
}
function templateValues(ctx: Context, body: Data, old?: Row) {
  const patch: Data = {};
  if (old && has(body, 'brand_id') && (body.brand_id ?? null) !== (old.brand_id ?? null)) throw new Problem(422, 'BRAND_MISMATCH', 'Template brand is fixed');
  if (!old || has(body, 'brand_id')) patch.brand_id = body.brand_id == null ? null : ctx.get('brand', str(body.brand_id, 'brand_id')).id;
  if (!old || has(body, 'kind')) patch.kind = choose(body.kind, 'kind', ['text_snippet', 'hashtag_set', 'cta', 'caption_template', 'visual_template']);
  if (!old || has(body, 'name')) patch.name = str(body.name, 'name', 250);
  if (!old || has(body, 'body')) {
    patch.body = typeof body.body === 'string' ? str(body.body, 'template body', 40_000)
      : (patch.kind ?? old?.kind) === 'hashtag_set' && Array.isArray(body.body) ? strings(body.body, 'template body') : object(body.body, 'template body');
    if (JSON.stringify(patch.body).length > 200_000) throw new Problem(422, 'INVALID_INPUT', 'Template body is too large');
  }
  if (!old || has(body, 'variables')) {
    const variables = objects(body.variables ?? [], 'variables').map(variable => {
      const key = str(variable.key, 'variable key', 200);
      if (!/^[a-z][a-z0-9_.-]*$/i.test(key)) throw new Problem(422, 'INVALID_INPUT', 'Invalid variable key');
      if (variable.required !== undefined && typeof variable.required !== 'boolean') throw new Problem(422, 'INVALID_INPUT', 'Invalid required flag');
      return { key, source: choose(variable.source ?? 'free', 'source', ['product_fact', 'listing', 'promotion', 'link', 'free']), required: variable.required ?? false };
    });
    if (variables.length !== new Set(variables.map(row => row.key)).size) throw new Problem(422, 'INVALID_INPUT', 'Variable keys must be unique');
    patch.variables = variables;
  }
  for (const key of ['platforms', 'market_ids', 'locales']) if (!old || has(body, key)) patch[key] = body[key] == null ? null : strings(body[key], key);
  return patch;
}

const read = (path: string, name: string, summary: string, run: Operation['run']): Operation => ({ method: 'GET', path, name, roles: READ, summary, run });
const write = (method: Operation['method'], path: string, name: string, summary: string, run: Operation['run'], versionKind?: string, roles = WRITE): Operation => {
  const humanOnly = !roles.includes('agent');
  return {
    method, path, name, roles, summary, ...(versionKind ? { versionKind } : {}), ...(humanOnly ? { mcp: false } : {}),
    run(ctx, input) {
      if (humanOnly && (ctx.role === 'agent' || (ctx as Context & { agentCredentialId?: string }).agentCredentialId)) {
        throw new Problem(403, 'PERMISSION_DENIED', 'Only a person can perform this action');
      }
      return run(ctx, input);
    },
  };
};

async function runCommand(ctx: Context, name: string, input: Data) {
  const context = commandContext(ctx);
  try {
    if (name === 'submission_accept' || name === 'submission_accept_batch') {
      const accept = name === 'submission_accept' ? acceptSubmission : acceptSubmissionBatch;
      return await accept(context, input, async file => {
        const media = mediaFor(ctx);
        // Approval authorizes reading this submission's private file and copying it into the library.
        const storageCtx: Context = { ...ctx, role: 'admin' };
        const size = Number(file.data.size_bytes);
        assertUsageAllowed(ctx, 'storage_bytes', size);
        const stored = await media.withMediaSource(storageCtx, file.id, async (path, mime) => {
          const upload = media.begin(storageCtx, { purpose: 'asset', mime_type: mime, size_bytes: size,
            sha256: file.data.sha256, original_filename: file.data.original_filename ?? undefined });
          await media.stage(storageCtx, upload.id, createReadStream(path), size);
          return media.complete(storageCtx, upload.id);
        });
        return verifiedFile(context, stored.id);
      });
    }
    return await commands[name].run(context, input);
  }
  catch (error) {
    if (error instanceof Error && 'status' in error && typeof error.status === 'number' && 'code' in error && typeof error.code === 'string' && !(error instanceof Problem)) throw new Problem(error.status, error.code, error.message);
    throw error;
  }
}

function commandRoute(path: string, name: string, summary: string, roles: Operation['roles'], idField?: string, versionKind?: string): Operation {
  return write('POST', path, name, summary, async (ctx, { body, params, expectedVersion }) => {
    const result = await runCommand(ctx, name, { ...body, ...(idField ? { [idField]: params.id } : {}), ...(expectedVersion === undefined ? {} : { expected_version: expectedVersion }) });
    return toRest(result);
  }, versionKind, roles);
}

export const operations: Operation[] = [
  read('/submission-boxes', 'asset_list_submission_boxes', 'List scoped intake boxes', ctx => ctx.list('submission_box')),
  read('/submission-boxes/:id', 'asset_get_submission_box', 'List intake entries in this box', (ctx, { params }) => ({ ...ctx.get('submission_box', params.id), submissions: ctx.list('submission').filter(row => row.box_id === params.id) })),
  commandRoute('/submission-boxes', 'submission_box_create', 'Create a time-limited intake box', ADMIN),
  commandRoute('/submission-boxes/:id/submissions', 'submission_receive', 'Record a delivered file and rights declaration', WRITE.filter(role => role !== 'agent'), 'box_id'),
  commandRoute('/submission-boxes/:id/accept-batch', 'submission_accept_batch', 'Review multiple pending submissions into the library', APPROVE, 'box_id'),
  commandRoute('/submissions/:id/accept', 'submission_accept', 'Review a delivered asset into the library', APPROVE, 'submission_id', 'submission'),
  commandRoute('/submissions/:id/reject', 'submission_reject', 'Reject a delivered asset', APPROVE, 'submission_id', 'submission'),
  write('DELETE', '/submission-boxes/:id', 'asset_close_submission_box', 'Close the intake box while preserving review records', (ctx, { params }) => ctx.update('submission_box', params.id, { status: 'closed', closed_at: ctx.now }), 'submission_box', ADMIN),
  commandRoute('/assets/import-external', 'asset_import_external', 'Import a verified external file with provenance', WRITE.filter(role => role !== 'agent')),
  read('/external-sources', 'asset_list_external_sources', 'List imported external sources and observed changes', ctx => ctx.list('external_source')),
  commandRoute('/external-sources/:id/observe', 'asset_observe_external_version', 'Record an external version observation', ADMIN, 'source_id'),
  commandRoute('/external-sources/:id/import-version', 'asset_import_external_version', 'Import the reviewed observed version', WRITE.filter(role => role !== 'agent'), 'source_id', 'external_source'),
  write('POST', '/assets/uploads', 'asset_begin_upload', 'Reserve an asset upload', async (ctx, { body }) => {
    if (typeof body.size_bytes === 'number' && Number.isSafeInteger(body.size_bytes) && body.size_bytes > 0) assertUsageAllowed(ctx, 'storage_bytes', body.size_bytes);
    const mediaFiles = mediaFor(ctx);
    const upload = mediaFiles.begin(ctx, { ...body, purpose: 'asset' });
    return { ...upload, upload_id: upload.id, ...(upload.direct_upload ? await mediaFiles.operations.find(operation => operation.name === 'file_direct_upload')!.run(ctx, { body: {}, query: {}, params: { id: upload.id } }) as Data : {}) };
  }),
  read('/assets', 'asset_search', 'Search the asset library', (ctx, { query }) => {
    if (query.brand_id !== undefined) ctx.get('brand', query.brand_id);
    const keyword = query.q?.toLowerCase();
    const links = ctx.list('asset_link').filter(row => row.status !== 'unlinked');
    const favorites = query.favorite_only === 'true' ? new Set(ctx.list('asset_favorite').filter(row => row.actor_id === ctx.actorId && row.active === true).map(row => row.asset_id)) : null;
    return ctx.list(ASSET).filter(asset => {
      if (['brand_id', 'folder_id', 'kind', 'locale', 'status'].some(key => query[key] !== undefined && query[key] !== asset[key])) return false;
      if (!query.status && asset.status === 'archived') return false;
      if (favorites && !favorites.has(asset.id)) return false;
      const tags = Array.isArray(asset.tags) ? asset.tags : [];
      if (query.tag && !tags.includes(query.tag)) return false;
      if (keyword && ![asset.title, asset.description, ...tags].some(value => typeof value === 'string' && value.toLowerCase().includes(keyword))) return false;
      if (['product', 'product_variant', 'campaign'].some(type => query[`${type}_id`] && !links.some(row => row.asset_id === asset.id && row.link_type === type && row.link_id === query[`${type}_id`]))) return false;
      if (query.in_use !== undefined && Object.values(assetUsage(ctx, asset)).some(rows => rows.length) !== (query.in_use === 'true')) return false;
      if (query.rights_status && !assetDetail(ctx, asset).rights_grants.some(grant => grant.status === query.rights_status)) return false;
      if (query.usage && !checkUsage(ctx, { asset_ids: [asset.id], usage: query.usage, platform: query.platform, region: query.region, at: query.at, modification: query.modification === 'true', attribution: query.attribution })[0]?.allowed) return false;
      return true;
    });
  }),
  write('POST', '/assets', 'asset_create', 'Register an uploaded file as an asset', (ctx, { body }) => {
    const brand_id = ctx.get('brand', str(body.brand_id, 'brand_id')).id;
    const file = getFile(ctx, body, ['asset']);
    const folder_id = folderId(ctx, body.folder_id, brand_id);
    const asset = ctx.create(ASSET, {
      brand_id, folder_id, kind: choose(body.kind, 'kind', kindNames), title: str(body.title, 'title', 250),
      description: optionalText(body.description, 'description'), tags: strings(body.tags ?? [], 'tags'), locale: optionalText(body.locale, 'locale'),
      origin: ctx.role === 'agent' && body.origin == null ? 'ai_generated' : choose(body.origin ?? 'upload', 'origin', assetOrigins),
      origin_ref: body.origin_ref == null ? null : originReference(body.origin_ref), status: 'processing', current_version_id: null, favorite_count: 0, archived_at: null,
    });
    setLinks(ctx, asset, body.links ?? []);
    ctx.emit('asset.asset.created', { asset_id: asset.id, brand_id });
    const result = addVersion(ctx, asset, body, file);
    return { ...result.asset, asset_version: result.asset_version };
  }),
  read('/assets/:id/duplicates', 'asset_find_duplicates', 'Find matching uploaded bytes within the asset brand', (ctx, { params }) => {
    const asset = ctx.get(ASSET, params.id);
    if (!asset.current_version_id) return [];
    const version = ctx.get(VERSION, String(asset.current_version_id));
    const matching = new Set(ctx.list(VERSION).filter(row => row.sha256 === version.sha256 && row.asset_id !== asset.id).map(row => row.asset_id));
    return ctx.list(ASSET).filter(row => row.brand_id === asset.brand_id && row.status !== 'archived' && matching.has(row.id));
  }),
  read('/assets/:id', 'asset_get', 'Get an asset, versions, rights and usage', (ctx, { params }) => assetDetail(ctx, ctx.get(ASSET, params.id))),
  write('PATCH', '/assets/:id', 'asset_update', 'Update describing metadata and asset associations', (ctx, { body, params }) => {
    const asset = ctx.get(ASSET, params.id);
    const patch: Data = {};
    if (has(body, 'title')) patch.title = str(body.title, 'title', 250);
    for (const key of ['locale', 'description']) if (has(body, key)) patch[key] = optionalText(body[key], key);
    if (has(body, 'tags')) patch.tags = strings(body.tags, 'tags');
    if (has(body, 'folder_id')) patch.folder_id = folderId(ctx, body.folder_id, asset.brand_id);
    if (has(body, 'links')) setLinks(ctx, asset, body.links);
    return ctx.update(ASSET, asset.id, patch);
  }, ASSET),
  commandRoute('/assets/:id/favorite', 'asset_set_favorite', 'Set your asset favorite', READ, 'asset_id'),
  read('/asset-versions/:id/download', 'asset_download_version', 'Issue a short-lived source download link', (ctx, { params, query }) => {
    const version = ctx.get(VERSION, params.id);
    return mediaFor(ctx).download(ctx, String(version.file_object_id), query.inline === 'true');
  }),
  read('/assets/:id/versions', 'asset_list_versions', 'List immutable file versions', (ctx, { params }) => assetDetail(ctx, ctx.get(ASSET, params.id)).versions),
  write('POST', '/assets/:id/versions', 'asset_add_version', 'Attach a new immutable file version', (ctx, { body, params }) => addVersion(ctx, ctx.get(ASSET, params.id), body), ASSET),
  write('POST', '/assets/:id/refresh-file-status', 'asset_refresh_file_status', 'Reconcile the asset with its current file scan', (ctx, { params }) => {
    const asset = ctx.get(ASSET, params.id);
    if (asset.status === 'archived' || !asset.current_version_id) return asset;
    const version = ctx.get(VERSION, String(asset.current_version_id));
    const file = ctx.get('file_object', String(version.file_object_id));
    const status = clean(file) ? 'ready' : file.deleted_at || file.scan_status === 'infected' ? 'failed' : 'processing';
    if (status === asset.status) return asset;
    const row = ctx.update(ASSET, asset.id, { status });
    if (status === 'ready' && !version.thumbnail_file_id && ['image', 'video'].includes(String(asset.kind))) requestRendition(ctx, version.id, { kind: 'thumbnail' });
    ctx.emit(`asset.asset.${status}`, { asset_id: asset.id, asset_version_id: version.id });
    return row;
  }, ASSET, ADMIN),
  read('/assets/:id/usage', 'asset_usage', 'List the published and draft uses of an asset', (ctx, { params }) => assetUsage(ctx, ctx.get(ASSET, params.id))),
  write('POST', '/asset-versions/:id/renditions', 'asset_request_rendition', 'Queue or reuse a deterministic rendition', (ctx, { body, params }) => requestRendition(ctx, params.id, body)),
  write('POST', '/asset-versions/:id/rendition-batch', 'asset_request_rendition_batch', 'Queue up to twenty rendition recipes for a version', (ctx, { body, params }) => {
    const recipes = objects(body.recipes, 'recipes');
    if (recipes.length < 1 || recipes.length > 20) throw new Problem(422, 'INVALID_INPUT', 'Provide between 1 and 20 recipes');
    return { items: recipes.map(recipe => requestRendition(ctx, params.id, recipe)) };
  }),
  commandRoute('/renditions/:id/retry', 'asset_retry_rendition', 'Retry a failed rendition', WRITE, 'rendition_id', RENDITION),
  read('/renditions/:id', 'asset_get_rendition', 'Get rendition state and a short-lived download link', (ctx, { params }) => {
    const rendition = ctx.get(RENDITION, params.id);
    if (rendition.status !== 'ready' || typeof rendition.file_object_id !== 'string') return rendition;
    return { ...rendition, download: mediaFor(ctx).download(ctx, rendition.file_object_id, rendition.kind === 'thumbnail') };
  }),
  write('POST', '/renditions/:id/result', 'asset_finish_rendition', 'Record the media worker result', (ctx, { body, params }) => finishRendition(ctx, ctx.get(RENDITION, params.id), body), RENDITION, ADMIN),
  write('POST', '/assets/:id/archive', 'asset_archive', 'Archive an asset', (ctx, { params }) => archiveAsset(ctx, ctx.get(ASSET, params.id)), ASSET),
  write('DELETE', '/assets/:id', 'asset_delete', 'Delete an unreferenced archived asset', (ctx, { params }) => deleteAsset(ctx, ctx.get(ASSET, params.id)), ASSET, ADMIN),
  read('/asset-folders', 'asset_list_folders', 'List folders', (ctx, { query }) => ctx.list(FOLDER).filter(row => !query.brand_id || !row.brand_id || row.brand_id === query.brand_id)),
  read('/asset-folders/:id', 'asset_get_folder', 'Get a folder', (ctx, { params }) => ctx.get(FOLDER, params.id)),
  write('POST', '/asset-folders', 'asset_create_folder', 'Create a folder', (ctx, { body }) => changeFolder(ctx, body), undefined, ADMIN),
  write('PATCH', '/asset-folders/:id', 'asset_update_folder', 'Rename or move a folder', (ctx, { body, params }) => changeFolder(ctx, body, ctx.get(FOLDER, params.id)), FOLDER, ADMIN),
  write('DELETE', '/asset-folders/:id', 'asset_delete_folder', 'Delete an empty folder', (ctx, { params }) => {
    ctx.get(FOLDER, params.id);
    if (ctx.list(FOLDER).some(row => row.parent_id === params.id) || ctx.list(ASSET).some(row => row.folder_id === params.id) || ctx.list('submission_box').some(row => row.target_folder_id === params.id)) throw new Problem(409, 'FOLDER_IN_USE', 'Move its files and subfolders before deleting the folder');
    ctx.remove(FOLDER, params.id);
    return { id: params.id, deleted: true };
  }, FOLDER, ADMIN),
  read('/rights-grants', 'rights_list', 'List grants and filter by validity state', (ctx, { query }) => ctx.list(grantKind).filter(row => ['brand_id', 'status'].every(key => !query[key] || row[key] === query[key]))),
  read('/rights-impacts', 'rights_list_impacts', 'List affected published posts', (ctx, { query }) => ctx.list('rights_impact').filter(row => ['rights_grant_id', 'status'].every(key => !query[key] || row[key] === query[key]))),
  commandRoute('/rights-impacts/:id/resolve', 'rights_resolve_impact', 'Resolve a post rights impact', APPROVE, 'impact_id', 'rights_impact'),
  read('/rights-grants/:id', 'rights_get', 'Get rights terms, history and covered assets', (ctx, { params }) => rightsDetail(ctx, ctx.get(grantKind, params.id))),
  write('POST', '/rights-grants', 'rights_create_draft', 'Draft an asset rights grant', (ctx, { body }) => createGrant(ctx, body)),
  write('POST', '/rights-grants/:id/revisions', 'rights_revise', 'Propose revised grant terms', (ctx, { params, body }) => reviseGrant(ctx, params.id, body), grantKind),
  write('POST', '/rights-grants/:id/activate', 'rights_activate', 'Confirm and activate grant terms', (ctx, { params, body }) => activateGrant(ctx, params.id, body), grantKind, APPROVE),
  write('POST', '/rights-grants/:id/renew', 'rights_renew', 'Confirm extended terms', (ctx, { params, body }) => renewGrant(ctx, params.id, body), grantKind, APPROVE),
  write('POST', '/rights-grants/:id/revoke', 'rights_revoke', 'Revoke a live rights grant', (ctx, { params, body }) => revokeGrant(ctx, params.id, body), grantKind, APPROVE),
  write('POST', '/rights-grants/scan-expiry', 'rights_scan_expiry', 'Advance expiring and expired grants', ctx => scanExpiry(ctx), undefined, ADMIN),
  write('POST', '/rights/check', 'asset_check_usage', 'Check scoped asset use rights', (ctx, { body }) => ({ items: checkUsage(ctx, body) }), undefined, READ),
  read('/knowledge', 'knowledge_list', 'List brand knowledge', (ctx, { query }) => ctx.list('knowledge_entry').filter(row => ['brand_id', 'kind', 'status'].every(key => !query[key] || row[key] === query[key]))),
  write('POST', '/knowledge/import', 'knowledge_import', 'Import extracted entries as proposals', (ctx, { body }) => {
    const evidence_id = ctx.get('evidence', str(body.evidence_id, 'evidence_id')).id;
    const entries = objects(body.entries, 'entries');
    if (!entries.length || entries.length > 50) throw new Problem(422, 'INVALID_INPUT', 'Provide between 1 and 50 extracted entries');
    return entries.map(entry => proposeKnowledge(ctx, { ...entry, brand_id: body.brand_id, source: { kind: 'document_import', evidence_id } }));
  }),
  read('/knowledge/:id', 'knowledge_get', 'Get a knowledge entry and its revisions', (ctx, { params }) => knowledgeDetail(ctx, ctx.get('knowledge_entry', params.id))),
  write('POST', '/knowledge', 'knowledge_propose', 'Propose a brand knowledge entry', (ctx, { body }) => proposeKnowledge(ctx, body), undefined, READ.filter(role => role !== 'viewer')),
  write('POST', '/knowledge/:id/revisions', 'knowledge_revise', 'Propose a revision to brand knowledge', (ctx, { params, body }) => proposeKnowledge(ctx, body, ctx.get('knowledge_entry', params.id)), 'knowledge_entry', READ.filter(role => role !== 'viewer')),
  write('POST', '/knowledge-revisions/:id/approve', 'knowledge_approve', 'Activate a proposed knowledge revision', (ctx, { params }) => approveKnowledge(ctx, params.id), 'knowledge_revision', APPROVE),
  write('POST', '/knowledge-revisions/:id/reject', 'knowledge_reject', 'Reject a proposed knowledge revision', (ctx, { params }) => rejectKnowledge(ctx, params.id), 'knowledge_revision', APPROVE),
  write('POST', '/knowledge/:id/retire', 'knowledge_retire', 'Retire active brand knowledge', (ctx, { params }) => retireKnowledge(ctx, params.id), 'knowledge_entry', APPROVE),
  read('/brands/:brandId/context', 'knowledge_get_context', 'Assemble scoped active brand context', (ctx, { params, query }) => context(ctx, params.brandId, query)),
  read('/templates', 'template_list', 'List reusable templates', (ctx, { query }) => ctx.list('template').filter(row => (!query.brand_id || row.brand_id == null || row.brand_id === query.brand_id) && (!query.kind || row.kind === query.kind) && row.status === (query.status ?? 'active') &&
    Object.entries({ platform: 'platforms', market_id: 'market_ids', locale: 'locales' }).every(([key, scope]) => !query[key] || !Array.isArray(row[scope]) || (row[scope] as unknown[]).includes(query[key])))),
  read('/templates/:id', 'template_get', 'Get a template', (ctx, { params }) => ctx.get('template', params.id)),
  write('POST', '/templates', 'template_create', 'Create a reusable template', (ctx, { body }) => ctx.create('template', { ...templateValues(ctx, body), status: 'active' })),
  write('PATCH', '/templates/:id', 'template_update', 'Edit a template', (ctx, { params, body }) => {
    const row = ctx.get('template', params.id);
    if (row.status !== 'active') throw new Problem(409, 'TEMPLATE_ARCHIVED', 'This template is archived');
    return ctx.update('template', params.id, templateValues(ctx, body, row));
  }, 'template'),
  write('DELETE', '/templates/:id', 'template_archive', 'Archive a template', (ctx, { params }) => ctx.update('template', params.id, { status: 'archived' }), 'template'),
  write('POST', '/templates/:id/render', 'template_render', 'Render a template with approved source values', async (ctx, { params, body }) => {
    const result = await runCommand(ctx, 'template_render', { ...body, template_id: params.id }) as Data;
    return { ...result, body_doc: result.body, pending_validation: (result.revalidate as Data[]).map(field => field.key) };
  }, undefined, READ),
  write('POST', '/templates/:id/apply', 'template_apply', 'Replace a working draft caption from a reusable template',
    (ctx, { params, body }) => runCommand(ctx, 'template_apply', { ...body, template_id: params.id }), undefined, WRITE.filter(role => role !== 'agent')),
  write('POST', '/content-variants/:id/apply-template', 'template_apply_to_variant', 'Replace the working draft caption from a reusable template',
    async (ctx, { params, body, expectedVersion }) => {
      await runCommand(ctx, 'template_apply', { ...body, variant_id: params.id, expected_version: expectedVersion });
      return ctx.get('content_variant', params.id);
    }, 'content_variant', WRITE.filter(role => role !== 'agent')),
];

const imageDemuxers = new Map([
  ['image/png', 'png_pipe'], ['image/jpeg', 'jpeg_pipe'], ['image/webp', 'webp_pipe'], ['image/gif', 'gif'],
]);
const imageDimension = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 4096;
const cropOffset = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8192;

function imageRecipe(kind: string, params: Data, version: Row): string | undefined {
  if (!imageDemuxers.has(String(version.mime_type))) return;
  if (kind === 'transcode' && ['jpeg', 'jpg', 'image/jpeg'].includes(String(params.format))) {
    const source = object(version.meta ?? {}, 'source metadata');
    if (!imageDimension(source.width) || !imageDimension(source.height) || source.width * source.height > 12_000_000) {
      throw new Problem(422, 'INVALID_INPUT', 'JPEG conversion requires verified source dimensions within limits');
    }
    if (Object.keys(params).some(key => !['format', 'max_bytes'].includes(key))) {
      throw new Problem(422, 'INVALID_INPUT', 'JPEG conversion supports only format and max_bytes');
    }
    return 'null'; // Convert the format while keeping the original dimensions.
  }
  if (kind !== 'crop' && kind !== 'platform_resize') return;
  const { width, height, crop, max_bytes } = params;
  if (!imageDimension(width) || !imageDimension(height) || width * height > 12_000_000) throw new Problem(422, 'INVALID_INPUT', 'Invalid image rendition dimensions');
  if (max_bytes != null && (typeof max_bytes !== 'number' || !Number.isSafeInteger(max_bytes) || max_bytes < 1)) throw new Problem(422, 'INVALID_INPUT', 'Invalid image rendition byte limit');
  if (kind === 'platform_resize') return `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`;
  const { x = 0, y = 0 } = object(crop ?? {}, 'crop');
  const source = object(version.meta ?? {}, 'source metadata');
  if (!cropOffset(x) || !cropOffset(y) ||
    typeof source.width !== 'number' || typeof source.height !== 'number' ||
    x + width > source.width || y + height > source.height) throw new Problem(422, 'INVALID_INPUT', 'Crop must fit the verified source dimensions');
  return `crop=${width}:${height}:${x}:${y}:exact=1`;
}

async function renderImage(path: string, mime: string, filter: string, maxBytes: number) {
  const demuxer = imageDemuxers.get(mime);
  if (!demuxer) throw new Error('Unsupported image input');
  const input = await open(path, 'r');
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn('ffmpeg', ['-nostdin', '-v', 'error', '-max_alloc', '67108864', '-filter_threads', '1', '-threads', '1',
        '-protocol_whitelist', 'fd', '-format_whitelist', demuxer, '-f', demuxer, '-i', 'fd:', '-frames:v', '1',
        '-map', '0:V:0', '-vf', filter, '-threads', '1', '-c:v', 'mjpeg', '-f', 'image2pipe', 'pipe:1'],
      { stdio: [input.fd, 'pipe', 'ignore'], shell: false, windowsHide: true });
      const chunks: Buffer[] = [];
      let length = 0;
      let stopped = false;
      const stop = () => { stopped = true; child.kill('SIGKILL'); };
      const timer = setTimeout(stop, 15_000);
      child.stdout!.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maxBytes) stop();
        if (!stopped) chunks.push(chunk);
      });
      child.once('error', reject);
      child.once('close', code => {
        clearTimeout(timer);
        if (stopped || code !== 0 || length === 0) reject(new Error('Image rendition could not be produced within limits'));
        else resolve(Buffer.concat(chunks, length));
      });
    });
  } finally { await input.close(); }
}

// The host dispatches outbox events after the requesting transaction commits.
export const assetAcceptsEvent = (type: string) => type === 'asset.rendition.requested';
export async function applyAssetEvent(ctx: Context, event: Data, injectedMedia?: ReturnType<typeof mediaFor>) {
  if (typeof event.type !== 'string' || !assetAcceptsEvent(event.type)) return;
  const payload = object(event.payload ?? event.data, 'asset event');
  const id = payload.rendition_id ?? payload.asset_rendition_id;
  const attempt = payload.attempt ?? payload.attempts;
  const row = ctx.list(RENDITION).find(candidate => candidate.id === id);
  if (!row || row.status !== 'queued' || row.attempts !== attempt) return;
  const version = ctx.get(VERSION, String(row.asset_version_id));
  if (ctx.get(ASSET, String(version.asset_id)).status === 'archived') {
    const processing = finishRendition(ctx, row, { status: 'processing', attempt });
    return finishRendition(ctx, processing, { status: 'failed', attempt, error: 'Source asset is archived' });
  }
  const params = object(row.params ?? {}, 'params');
  const defaultStill = ['thumbnail', 'cover'].includes(String(row.kind)) && !Object.keys(params).length;
  const imagePreview = row.kind === 'preview' && imageDemuxers.has(String(version.mime_type)) && !Object.keys(params).length;
  let filter: string | undefined;
  try { filter = imageRecipe(String(row.kind), params, version); }
  catch (error) {
    const processing = finishRendition(ctx, row, { status: 'processing', attempt });
    return finishRendition(ctx, processing, { status: 'failed', attempt, error: (error as Error).message });
  }
  if (!defaultStill && !imagePreview && !filter) return; // Other recipes are handled by the external result path.
  const processing = finishRendition(ctx, row, { status: 'processing', attempt });
  const media = injectedMedia ?? mediaFor(ctx);
  let bytes: Buffer;
  try {
    const maxBytes = Math.min(Number(params.max_bytes ?? 8 * 1024 * 1024), 8 * 1024 * 1024);
    bytes = await media.withMediaSource(ctx, String(version.file_object_id), (path, mime) => filter ? renderImage(path, mime, filter, maxBytes) : makeThumbnail(path, mime));
  } catch {
    return finishRendition(ctx, processing, { status: 'failed', attempt, error: 'Rendition generation failed' });
  }
  try { assertUsageAllowed(ctx, 'storage_bytes', bytes.length); }
  catch (error) {
    if (!(error instanceof Problem) || error.status !== 402) throw error;
    return finishRendition(ctx, processing, { status: 'failed', attempt, error: error.code });
  }
  const upload = media.begin(ctx, { purpose: 'asset', mime_type: 'image/jpeg', size_bytes: bytes.length,
    original_filename: `${String(row.kind)}.jpg`, sha256: createHash('sha256').update(bytes).digest('hex') });
  await media.stage(ctx, upload.id, Readable.from([bytes]), bytes.length);
  const file = await media.complete(ctx, upload.id);
  return finishRendition(ctx, processing, { status: 'ready', attempt, file_object_id: file.id });
}
