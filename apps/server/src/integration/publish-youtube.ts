import { readFile } from 'node:fs/promises';
import type { Context } from '@smartsell/contracts';
import { entries, object } from '../../../../packages/domain/src/publishing/index.js';
import { requireMediaFile } from '../extensions/media-files.js';
import { connectionContext, type AccountServices } from '../modules/account/oauth.js';
import { ATTEMPT, SLOT, TASK, executionCheck, find, pending, time } from '../modules/execution/service.js';
import type { ExecutionAdapter, Submission, Transact } from '../modules/execution/worker.js';

export type PublishMedia = { withMediaSource<T>(ctx: Context, id: string, use: (path: string, mime: string) => Promise<T>): Promise<T> };
const maxVideoBytes = 64 * 1024 * 1024;
const youtubeId = /^[A-Za-z0-9_-]{11}$/;

const uploadScope = 'https://www.googleapis.com/auth/youtube.upload';
const observationScopes = [uploadScope, 'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube', 'https://www.googleapis.com/auth/youtube.force-ssl', 'https://www.googleapis.com/auth/youtubepartner'];

function grant(ctx: Context, request: Submission, services: AccountServices, scopes: readonly string[]) {
  const account = find(ctx, 'social_account', request.social_account_id);
  if (account?.provider !== 'youtube' || account.status !== 'active' || typeof account.external_account_id !== 'string') return;
  for (const link of ctx.list('social_account_connection')) {
    if (link.social_account_id !== account.id || link.status !== 'active') continue;
    const row = find(ctx, 'connection', link.connection_id);
    if (row?.provider !== 'youtube' || row.purpose !== 'social') continue;
    try {
      const adapter = services.adapter?.('youtube', typeof row.platform_app_id === 'string' ? row.platform_app_id : undefined);
      const auth = connectionContext(ctx, row, services, account.external_account_id);
      if (adapter && scopes.some(scope => auth.scopes?.includes(scope))) return { adapter, auth };
    } catch { /* An inactive or mismatched grant cannot authorize publishing. */ }
  }
}

function video(ctx: Context, request: Submission) {
  const frozen = request.frozen;
  const items = entries(frozen.media);
  const item = items[0];
  const frozenOptions = object(frozen.options);
  const platformOptions = object(object(frozenOptions.platform_options).youtube);
  const rendered = object(frozen.rendered);
  const { title = rendered.title, ...options } = frozenOptions.platform_options === undefined ? frozenOptions : platformOptions;
  if (frozen.operation !== 'publish' || frozen.content_format !== 'video' || frozen.visibility !== 'private' || items.length !== 1 ||
      !item || (item.role && item.role !== 'primary') || item.caption_rendition_id || entries(frozen.product_refs).length || entries(frozen.link_refs).length ||
      Object.keys(frozenOptions).some(key => !['platform_options', 'categoryId', 'madeForKids', 'containsSyntheticMedia'].includes(key)) ||
      Object.keys(options).some(key => !['categoryId', 'madeForKids', 'containsSyntheticMedia'].includes(key)) ||
      typeof options.categoryId !== 'string' || !/^\d{1,3}$/.test(options.categoryId) || typeof options.madeForKids !== 'boolean' ||
      typeof title !== 'string' || !title.trim() || (Array.isArray(rendered.tags) && rendered.tags.length)) return;
  const asset = find(ctx, item.rendition_id ? 'asset_rendition' : 'asset_version', item.rendition_id ?? item.asset_version_id);
  const checksum = item.rendition_id ? entries(frozen.refs).find(row => row.ref_type === 'asset_rendition' && row.ref_id === item.rendition_id)?.binding :
    entries(frozen.media_bindings).find(row => row.asset_version_id === item.asset_version_id)?.sha256;
  if (typeof asset?.file_object_id !== 'string' || typeof checksum !== 'string') return;
  const file = requireMediaFile(ctx, asset.file_object_id, ['asset']);
  if (file.sha256 !== checksum || !(Number(file.size_bytes) > 0 && Number(file.size_bytes) <= maxVideoBytes)) return;
  return { id: file.id, options, title, caption: rendered.text };
}

export function youtubePublishing(transact: Transact, services: AccountServices, media: PublishMedia): ExecutionAdapter {
  function live(ctx: Context, request: Submission) {
    const task = find(ctx, TASK, request.task_id);
    const attempt = find(ctx, ATTEMPT, task?.active_attempt_id);
    if (!task || !attempt || attempt.status !== 'in_progress' || attempt.client_request_id !== request.client_request_id ||
        attempt.request_hash !== request.request_hash || task.fencing_token !== attempt.fencing_token ||
        !ctx.list(SLOT).some(row => row.holder_id === attempt.id && row.fencing_token === attempt.write_slot_fencing_token && time(row.lease_expires_at) > time(ctx.now))) return;
    const check = executionCheck(ctx, task);
    if (check.reason || check.assessment?.route !== 'api') return;
    const binding = grant(ctx, request, services, [uploadScope]);
    if (binding) return { ...binding, token: Number(attempt.fencing_token) };
  }
  return {
    provider: 'youtube',
    async submit(request) {
      const rejected = (error_class: 'auth_expired' | 'invalid_input' = 'invalid_input') => ({ status: 'not_submitted' as const, error_class, evidence: 'youtube_preflight' });
      let input;
      try {
        const source = await transact(ctx => live(ctx, request) ? { ctx, item: video(ctx, request) } : undefined);
        if (!source) return rejected('auth_expired');
        const { item } = source;
        if (!item) return rejected();
        const upload = await media.withMediaSource(source.ctx, item.id, async (path, mimeType) => ({ media: await readFile(path), mimeType }));
        input = { ...item.options, ...upload, title: item.title, caption: item.caption, privacyStatus: 'private', format: 'video' };
      } catch { return rejected(); }
      const prepared = await transact(ctx => live(ctx, request));
      if (!prepared) return rejected('auth_expired');
      const { adapter, auth } = prepared;
      const capability = await adapter.probe(auth);
      if (capability.status !== 'ready' || adapter.validate('publish', input, capability).length) return rejected();
      const current = await transact(ctx => live(ctx, request));
      if (!current || current.adapter !== adapter || current.auth.accessToken !== auth.accessToken) return rejected('auth_expired');
      const receipt = await adapter.execute('publish', input, { ...current.auth, client_request_id: request.client_request_id, fencing_token: current.token,
        credentialState: 'active', approval: { provider: 'youtube', operation: 'publish', externalAccountId: auth.externalAccountId!, clientRequestId: request.client_request_id } });
      const ref = receipt.externalRef;
      if (receipt.status === 'accepted' && ref?.kind === 'post' && ref.parentId === auth.externalAccountId && youtubeId.test(ref.id)) return { status: 'accepted', reference: ref.id };
      // Resumable session URLs are bearer capabilities. Keep them out of execution records.
      return { status: 'unknown', reason: 'youtube_receipt_unverified' };
    },
    async observe(request, id) {
      if (!id || !youtubeId.test(id)) return { status: 'inconclusive' };
      const binding = await transact(ctx => {
        const task = find(ctx, TASK, request.task_id);
        if (!task || task.social_account_id !== request.social_account_id) return;
        const attempt = pending(ctx, task);
        if (!attempt || attempt.client_request_id !== request.client_request_id ||
            attempt.request_hash !== request.request_hash || attempt.receipt !== id) return;
        const token = attempt.fencing_token;
        if (typeof token !== 'number' || !Number.isSafeInteger(token) || token <= 0) return;
        const binding = grant(ctx, request, services, observationScopes);
        if (binding) return { adapter: binding.adapter, auth: { ...binding.auth, client_request_id: request.client_request_id, fencing_token: token } };
      });
      if (!binding) return { status: 'inconclusive' };
      const result = await binding.adapter.observe({ kind: 'post', id, parentId: binding.auth.externalAccountId, visibility: 'private' }, binding.auth);
      if (result.status === 'published' && result.externalRef?.id === id && result.externalRef.parentId === binding.auth.externalAccountId) {
        return { status: 'published', external_post_id: id, permalink: result.permalink, visibility: 'private' };
      }
      if (result.status === 'failed') return { status: 'failed', evidence: 'youtube_video_failed' };
      if (result.status === 'running' || result.status === 'accepted') return { status: 'pending', processing: 'processing' };
      return { status: 'inconclusive' };
    },
  };
}
