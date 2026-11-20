import type { AdapterOptions, CapabilityReport, ClassifiedError, ConnectionCtx, ExecutionReceipt, ExternalRef, OutcomeObservation, ProviderKey, SyncCtx, SyncPage, ValidationIssue } from './adapter-types.ts';
import { AdapterError, bearer, classifyCode, form, header, identifier, json, record, rows, secureUrl, text, url, type Client } from './provider-http.ts';

const ig = 'https://graph.instagram.com/v24.0';
const fb = 'https://graph.facebook.com/v24.0';
const yt = 'https://www.googleapis.com/youtube/v3';
const tiktok = 'https://open.tiktokapis.com/v2';
const youtubeUploadPath = '/upload/youtube/v3/videos';
function youtubeSession(value: unknown): string | undefined {
  const session = secureUrl(value);
  if (!session) return;
  const parsed = new URL(session);
  if (['www.googleapis.com', 'youtube.googleapis.com'].includes(parsed.host) &&
    parsed.pathname === youtubeUploadPath && text(parsed.searchParams.get('upload_id'))) return session;
}
const socialId = (value: unknown) => {
  const candidate = identifier(value);
  return candidate && /^[A-Za-z0-9_.-]+$/.test(candidate) && candidate !== '.' && candidate !== '..' ? candidate : undefined;
};
function pathId(value: unknown, reason: string): string {
  const candidate = socialId(value);
  if (!candidate) throw new AdapterError('invalid_input', reason);
  return candidate;
}
const account = (ctx: ConnectionCtx) => pathId(ctx.externalAccountId, 'account_binding_required');
const id = (body: unknown) => socialId(record(body).id);

export function verifiedTikTokMedia(value: string, verified: string): boolean {
  const base = secureUrl(verified);
  if (!base) return false;
  const prefix = new URL(base);
  const media = new URL(value);
  if (prefix.search || media.origin !== prefix.origin) return false;
  if (prefix.pathname === '/') return true;
  // Do not let a second decoding pass at the CDN change the prefix boundary.
  if (/%(?:2f|5c|25)/i.test(media.pathname)) return false;
  return media.pathname === prefix.pathname || media.pathname.startsWith(`${prefix.pathname.replace(/\/$/, '')}/`);
}
const ref = (kind: ExternalRef['kind'], id: string, parentId?: string): ExternalRef => ({ kind, id, parentId });
const issue = (field: string, code = 'invalid_input'): ValidationIssue => ({ field, code });
const parseDate = (value: unknown) => Date.parse(text(value) ?? '');
const metaRead = (request: Client, root: string, path: string, token: string, params: Record<string, string | undefined> = {}) => request({ method: 'GET', url: url(`${root}/${path}`, params), headers: bearer(token) });
const metaWrite = (request: Client, root: string, path: string, token: string, fields: Record<string, string | undefined>) => {
  const encoded = form(fields);
  return request({ method: 'POST', url: `${root}/${path}`, headers: { ...encoded.headers, ...bearer(token) }, body: encoded.body }, { mutation: true });
};
function postJson(request: Client, endpoint: string, token: string, fields: unknown, mutation = false, headers: Record<string, string> = {}) {
  const data = json(fields);
  return request({ method: 'POST', url: endpoint, headers: { ...data.headers, ...bearer(token), ...headers }, body: data.body }, { mutation });
}

export function youtubeFailure(status: Record<string, unknown>, processing?: unknown): ClassifiedError | undefined {
  if (status.uploadStatus === 'failed') {
    if (status.failureReason === 'codec' || status.failureReason === 'conversion' || status.failureReason === 'emptyFile' || status.failureReason === 'invalidFile') {
      return { errorClass: 'invalid_input', reason: 'youtube_invalid_media' };
    }
  } else if (status.uploadStatus !== 'rejected' && processing !== 'failed' && processing !== 'terminated') {
    return;
  }
  return { errorClass: 'platform_rejected', reason: 'video_processing_failed' };
}
async function* facebookPages(request: Client, token: string, fields: string) {
  const seen = new Set<string>();
  let after: string | undefined;
  do {
    const response = await metaRead(request, fb, 'me/accounts', token, { fields, limit: '100', after });
    const body = record(response.body);
    if (!Array.isArray(body.data)) throw new AdapterError('transient', 'malformed_page_accounts');
    yield* rows(body.data);
    const paging = record(body.paging);
    if (!paging.next) return;
    after = text(record(paging.cursors).after);
    if (!after) throw new AdapterError('transient', 'missing_page_accounts_cursor');
    if (seen.has(after)) throw new AdapterError('transient', 'cursor_did_not_advance');
    seen.add(after);
  } while (after);
}

export async function probeSocial(provider: ProviderKey, request: Client, ctx: ConnectionCtx, token: string): Promise<NonNullable<CapabilityReport['accounts']>> {
  if (provider === 'meta_instagram') {
    const response = await metaRead(request, ig, 'me', token, { fields: 'user_id,username' });
    const body = record(response.body);
    const externalAccountId = identifier(body.user_id ?? body.id);
    return externalAccountId ? [{ externalAccountId, name: text(body.username) }] : [];
  }
  if (provider === 'meta_facebook') {
    const accounts = new Map<string, NonNullable<CapabilityReport['accounts']>[number]>();
    for await (const page of facebookPages(request, token, 'id,name,tasks')) {
      const externalAccountId = id(page);
      const pageTasks = Array.isArray(page.tasks) ? page.tasks.filter((task): task is string => typeof task === 'string') : [];
      if (externalAccountId) accounts.set(externalAccountId, { externalAccountId, name: text(page.name), pageTasks });
    }
    return [...accounts.values()];
  }
  if (provider === 'youtube') {
    const response = await metaRead(request, yt, 'channels', token, { part: 'snippet,contentDetails', mine: 'true' });
    return rows(record(response.body).items).flatMap(channel => {
      const externalAccountId = id(channel);
      return externalAccountId ? [{ externalAccountId, name: text(record(channel.snippet).title), uploadsPlaylistId: text(record(record(channel.contentDetails).relatedPlaylists).uploads) }] : [];
    });
  }
  if (provider === 'tiktok') {
    const response = await metaRead(request, tiktok, 'user/info/', token, { fields: 'open_id,display_name' });
    const user = record(record(record(response.body).data).user);
    const externalAccountId = identifier(user.open_id);
    return externalAccountId ? [{ externalAccountId, name: text(user.display_name) }] : [];
  }
  if (provider === 'douyin') {
    const open_id = account(ctx);
    const response = await metaRead((req) => request({ ...req, headers: { 'access-token': token } }), 'https://open.douyin.com', 'oauth/userinfo/', token, { open_id });
    const data = record(record(response.body).data);
    return data.open_id === open_id ? [{ externalAccountId: open_id, name: text(data.nickname) }] : [];
  }
  throw new AdapterError('unsupported');
}

export async function facebookPageToken(request: Client, ctx: ConnectionCtx, userToken: string, write = false): Promise<string> {
  const owner = account(ctx);
  for await (const page of facebookPages(request, userToken, 'id,access_token,tasks')) {
    if (id(page) !== owner) continue;
    const token = text(page.access_token);
    if (token && (!write || (Array.isArray(page.tasks) && page.tasks.includes('CREATE_CONTENT')))) return token;
    break;
  }
  throw new AdapterError('permission_denied', 'page_token_or_task_unavailable');
}

export const maintenanceOperation = (op: string): op is 'edit_post' | 'delete_post' => op === 'edit_post' || op === 'delete_post';

async function youtubeMaintenanceRead(request: Client, token: string, postId: string, owner: string) {
  const response = await metaRead(request, yt, 'videos', token, { part: 'snippet', id: postId });
  const items = record(response.body).items;
  if (!Array.isArray(items)) throw new AdapterError('transient', 'post_readback_invalid');
  if (!items.length) return undefined;
  const video = record(items[0]);
  const snippet = record(video.snippet);
  if (items.length !== 1 || video.id !== postId || snippet.channelId !== owner) {
    throw new AdapterError('permission_denied', 'post_owner_mismatch');
  }
  return snippet;
}

export async function observeYoutubeMaintenance(operation: 'edit_post' | 'delete_post', reference: ExternalRef, expected: string | undefined, ctx: ConnectionCtx, request: Client, token: string) {
  const owner = account(ctx);
  if (reference.kind !== 'post' || reference.parentId !== owner || !socialId(reference.id)) return 'inconclusive';
  const channels = await probeSocial('youtube', request, ctx, token);
  if (!channels.some(channel => channel.externalAccountId === owner)) return 'inconclusive';
  const snippet = await youtubeMaintenanceRead(request, token, reference.id, owner);
  if (operation === 'delete_post' ? snippet === undefined : snippet !== undefined && typeof expected === 'string' && snippet.description === expected) return 'verified';
  return 'inconclusive';
}

export function validateSocial(provider: ProviderKey, operation: string, input: Record<string, unknown>, now: number): ValidationIssue[] {
  if (provider === 'youtube' && maintenanceOperation(operation)) {
    if (!socialId(input.postId)) return [issue('postId')];
    if (operation === 'edit_post' && (typeof input.caption !== 'string' || new TextEncoder().encode(input.caption).length > 5000)) return [issue('caption')];
    return [];
  }
  const format = text(input.format);
  if (!format) return [issue('format')];
  if (provider === 'meta_instagram') {
    if (input.containerId !== undefined) return typeof input.containerId === 'string' && socialId(input.containerId) ? [] : [issue('containerId')];
    if (input.altText !== undefined && format !== 'image') return [issue('altText')];
    if (format === 'carousel') {
      const children = input.imageUrls;
      return Array.isArray(children) && children.length >= 2 && children.length <= 20 && children.every(secureUrl) ? [] : [issue('imageUrls')];
    }
    return secureUrl(input.mediaUrl) ? [] : [issue('mediaUrl')];
  }
  if (provider === 'meta_facebook') {
    if (format === 'image' && !secureUrl(input.mediaUrl)) return [issue('mediaUrl')];
    if (format === 'text' && !text(input.caption) && !secureUrl(input.link)) return [issue('caption')];
    if (format === 'image' && input.link !== undefined) return [issue('link')];
    if (operation === 'publish_schedule') {
      if (format !== 'text') return [issue('format')];
      const delay = parseDate(input.publishAt) - now;
      if (!Number.isFinite(delay) || delay < 600_000 || delay > 30 * 86_400_000) return [issue('publishAt')];
    }
    if (operation === 'publish' && input.publishAt !== undefined) return [issue('publishAt')];
    if (input.link !== undefined && !secureUrl(input.link)) return [issue('link')];
  }
  if (provider === 'tiktok') {
    if (!secureUrl(input.mediaUrl)) return [issue('mediaUrl')];
    if (input.musicUsageConfirmed !== true) return [issue('musicUsageConfirmed')];
    if (operation === 'publish' && (!text(input.privacyLevel) || typeof input.durationSeconds !== 'number' || !Number.isFinite(input.durationSeconds) || input.durationSeconds <= 0)) return [issue('privacyLevel'), issue('durationSeconds')];
    if (input.brandedContent === true && input.privacyLevel === 'SELF_ONLY') return [issue('privacyLevel')];
    if (input.watermarked === true) return [issue('watermarked')];
  }
  if (provider === 'youtube') {
    if (!(input.media instanceof Uint8Array) || !input.media.length) return [issue('media')];
    if (!text(input.title)) return [issue('title')];
    if (input.mimeType !== undefined && (typeof input.mimeType !== 'string' || !/^video\/[a-z0-9.+-]+$/i.test(input.mimeType))) return [issue('mimeType')];
    for (const field of ['madeForKids', 'containsSyntheticMedia'] as const) {
      if (input[field] !== undefined && typeof input[field] !== 'boolean') return [issue(field)];
    }
    if (!['private', 'unlisted', 'public'].includes(String(input.privacyStatus))) return [issue('privacyStatus')];
    if (operation === 'publish_schedule' && (input.privacyStatus !== 'private' || !(parseDate(input.publishAt) > now))) return [issue('publishAt')];
    if (operation === 'publish' && input.publishAt !== undefined) return [issue('publishAt')];
  }
  return [];
}

export async function executeSocial(provider: ProviderKey, operation: string, input: Record<string, unknown>, ctx: ConnectionCtx, options: AdapterOptions, request: Client, token: string): Promise<ExecutionReceipt> {
  const owner = account(ctx);
  if (provider === 'youtube' && maintenanceOperation(operation)) {
    const postId = socialId(input.postId)!;
    const channels = await probeSocial(provider, request, ctx, token);
    if (!channels.some(channel => channel.externalAccountId === owner)) throw new AdapterError('permission_denied', 'channel_identity_mismatch');
    const snippet = await youtubeMaintenanceRead(request, token, postId, owner);
    if (!snippet) throw new AdapterError('permission_denied', 'owned_video_unverified');
    const externalRef = ref('post', postId, owner);
    if (operation === 'delete_post') {
      const result = await request({ method: 'DELETE', url: url(`${yt}/videos`, { id: postId }), headers: bearer(token) }, { mutation: true });
      return result.status === 204 ? { status: 'accepted', externalRef } : { status: 'unknown' };
    }
    if (!text(snippet.title) || !text(snippet.categoryId)) throw new AdapterError('transient', 'video_snippet_incomplete');
    const { title, categoryId, tags, defaultLanguage } = snippet;
    const body = json({ id: postId, snippet: { title, categoryId, tags, defaultLanguage, description: input.caption } });
    const result = await request({ method: 'PUT', url: url(`${yt}/videos`, { part: 'snippet' }), ...body, headers: { ...body.headers, ...bearer(token) } }, { mutation: true });
    return id(result.body) === postId ? { status: 'accepted', externalRef } : { status: 'unknown' };
  }
  if (provider === 'meta_instagram') {
    const container = text(input.containerId);
    if (container) {
      const containerRef = ref('container', container, owner);
      const status = await observeSocial(provider, containerRef, ctx, request, token);
      if (status.subStatus !== 'ready_to_publish') {
        if (status.status === 'failed') return { status: 'failed', externalRef: containerRef, error: status.error };
        if (status.status === 'retryable') return { status: 'failed', externalRef: containerRef, error: { errorClass: 'transient', reason: 'container_expired' } };
        return { status: status.status === 'running' ? 'running' : 'unknown', externalRef: containerRef, subStatus: status.subStatus };
      }
      const quota = await metaRead(request, ig, `${owner}/content_publishing_limit`, token, { fields: 'quota_usage,config' });
      const limits = rows(record(quota.body).data)[0] ?? {};
      const used = limits.quota_usage;
      const limit = record(limits.config).quota_total;
      if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0) throw new AdapterError('transient', 'publishing_limit_unverified');
      if (used >= limit) throw new AdapterError('quota_exhausted', 'publishing_limit');
      try {
        const result = await metaWrite(request, ig, `${owner}/media_publish`, token, { creation_id: container });
        const media = id(result.body);
        return media ? { status: 'accepted', externalRef: ref('post', media, owner) } : { status: 'unknown', externalRef: containerRef, error: { errorClass: 'outcome_unknown', reason: 'missing_media_id' } };
      } catch (error) {
        if (error instanceof AdapterError && error.errorClass === 'outcome_unknown') return { status: 'unknown', externalRef: containerRef, error };
        throw error;
      }
    }
    const format = text(input.format);
    const mediaPath = `${owner}/media`;
    let fields: Record<string, string | undefined> = { caption: text(input.caption) };
    if (format === 'carousel') {
      const children = [];
      for (const image of input.imageUrls as string[]) {
        const child = await metaWrite(request, ig, mediaPath, token, { image_url: secureUrl(image), is_carousel_item: 'true' });
        const childId = id(child.body);
        if (!childId) throw new AdapterError('outcome_unknown', 'missing_carousel_child_id');
        children.push(childId);
      }
      fields = { ...fields, media_type: 'CAROUSEL', children: children.join(',') };
    } else if (format === 'reel') fields = { ...fields, media_type: 'REELS', video_url: secureUrl(input.mediaUrl) };
    else if (format === 'story') fields = { media_type: 'STORIES', [input.mediaType === 'video' ? 'video_url' : 'image_url']: secureUrl(input.mediaUrl) };
    else fields = { ...fields, image_url: secureUrl(input.mediaUrl), alt_text: text(input.altText) };
    const response = await metaWrite(request, ig, mediaPath, token, fields);
    const created = id(response.body);
    if (!created) throw new AdapterError('outcome_unknown', 'missing_container_id');
    return { status: 'running', subStatus: 'uploaded', externalRef: ref('container', created, owner) };
  }
  if (provider === 'meta_facebook') {
    const isScheduled = operation === 'publish_schedule';
    const image = input.format === 'image';
    const response = await metaWrite(request, fb, `${owner}/${image ? 'photos' : 'feed'}`, token, image ? {
      url: secureUrl(input.mediaUrl), caption: text(input.caption), published: 'true',
    } : { message: text(input.caption), link: secureUrl(input.link), published: isScheduled ? 'false' : undefined, scheduled_publish_time: isScheduled ? String(Math.floor(parseDate(input.publishAt) / 1000)) : undefined });
    const body = record(response.body);
    const post = image ? socialId(body.post_id) : id(body);
    if (!post) throw new AdapterError('outcome_unknown', 'missing_post_id');
    return { status: 'accepted', subStatus: isScheduled ? 'scheduled_on_platform' : undefined, externalRef: { ...ref('post', post, owner), scheduled: isScheduled } };
  }
  if (provider === 'tiktok') {
    const endpoint = `${tiktok}/post/publish`;
    const video_url = secureUrl(input.mediaUrl)!;
    if (!options.credentials?.tiktokVerifiedMediaOrigins?.some(prefix => verifiedTikTokMedia(video_url, prefix))) throw new AdapterError('permission_denied', 'url_ownership_unverified');
    const source_info = { source: 'PULL_FROM_URL', video_url };
    let fields: unknown = { source_info };
    if (operation === 'publish') {
      const info = await postJson(request, `${endpoint}/creator_info/query/`, token, {});
      const creator = record(record(info.body).data);
      const privacy = text(input.privacyLevel)!;
      if (!Array.isArray(creator.privacy_level_options) || !creator.privacy_level_options.includes(privacy)) throw new AdapterError('permission_denied', 'creator_privacy_unavailable');
      if (typeof creator.max_video_post_duration_sec !== 'number' || !Number.isFinite(creator.max_video_post_duration_sec) || creator.max_video_post_duration_sec <= 0 || Number(input.durationSeconds) > creator.max_video_post_duration_sec) throw new AdapterError('invalid_input', 'duration_exceeds_creator_limit');
      fields = { source_info, post_info: {
        title: text(input.caption), privacy_level: privacy,
        disable_comment: creator.comment_disabled !== false || input.allowComments !== true,
        disable_duet: creator.duet_disabled !== false || input.allowDuet !== true,
        disable_stitch: creator.stitch_disabled !== false || input.allowStitch !== true,
        brand_content_toggle: input.brandedContent === true, brand_organic_toggle: input.ownBrand === true,
      } };
    }
    const response = await postJson(request, `${endpoint}/${operation === 'publish_upload' ? 'inbox/video/init/' : 'video/init/'}`, token, fields, true);
    const publishId = socialId(record(record(response.body).data).publish_id);
    if (!publishId) throw new AdapterError('outcome_unknown', 'missing_publish_id');
    return { status: 'running', subStatus: 'uploading', externalRef: { ...ref('publish', publishId, owner), visibility: text(input.privacyLevel) } };
  }
  if (provider === 'youtube') {
    const media = input.media as Uint8Array;
    const mime = text(input.mimeType) ?? 'video/mp4';
    if (!/^video\/[a-z0-9.+-]+$/i.test(mime)) throw new AdapterError('invalid_input', 'invalid_media_type');
    const privacyStatus = text(input.privacyStatus)!;
    const initiate = await postJson(request, url(`https://www.googleapis.com${youtubeUploadPath}`, { part: 'snippet,status', uploadType: 'resumable', notifySubscribers: input.notifySubscribers === true }), token, {
      snippet: { title: text(input.title), description: text(input.caption), categoryId: text(input.categoryId) },
      status: { privacyStatus, publishAt: text(input.publishAt), selfDeclaredMadeForKids: typeof input.madeForKids === 'boolean' ? input.madeForKids : undefined, containsSyntheticMedia: typeof input.containsSyntheticMedia === 'boolean' ? input.containsSyntheticMedia : undefined },
    }, false, { 'x-upload-content-length': String(media.length), 'x-upload-content-type': mime });
    const session = youtubeSession(header(initiate.headers, 'location'));
    if (!session) throw new AdapterError('transient', 'unrecognized_upload_session');
    const uploadRef = { ...ref('upload_session', session, owner), uploadBytes: media.length, visibility: privacyStatus, scheduled: operation === 'publish_schedule' };
    try {
      const uploaded = await request({ method: 'PUT', url: session, headers: { ...bearer(token), 'content-type': mime, 'content-length': String(media.length), 'content-range': `bytes 0-${media.length - 1}/${media.length}` }, body: media }, { mutation: true, accept: [308] });
      if (uploaded.status === 308) return { status: 'running', subStatus: 'upload_incomplete', externalRef: uploadRef };
      const videoId = id(uploaded.body);
      return videoId ? { status: 'accepted', subStatus: 'processing', externalRef: { ...ref('post', videoId, owner), visibility: privacyStatus, scheduled: operation === 'publish_schedule' } } : { status: 'unknown', externalRef: uploadRef, error: { errorClass: 'outcome_unknown', reason: 'missing_video_id' } };
    } catch (error) {
      if (error instanceof AdapterError && error.errorClass === 'outcome_unknown') return { status: 'unknown', externalRef: uploadRef, error };
      throw error;
    }
  }
  throw new AdapterError('unsupported', 'operation_not_implemented');
}

export async function observeSocial(provider: ProviderKey, reference: ExternalRef, ctx: ConnectionCtx, request: Client, token: string): Promise<OutcomeObservation> {
  const owner = account(ctx);
  const unknown: OutcomeObservation = { status: 'unknown', externalRef: reference };
  const state = (status: OutcomeObservation['status'], subStatus?: string): OutcomeObservation => ({ status, subStatus, externalRef: reference });
  if (reference.parentId !== owner) return { ...unknown, subStatus: 'account_binding_mismatch' };
  if (reference.kind !== 'upload_session' && (typeof reference.id !== 'string' || !socialId(reference.id))) return { ...unknown, subStatus: 'invalid_reference' };
  if (provider === 'meta_instagram' && reference.kind === 'container') {
    const response = await metaRead(request, ig, reference.id, token, { fields: 'status_code,id' });
    const body = record(response.body);
    if (body.id !== undefined && id(body) !== reference.id) return unknown;
    switch (body.status_code) {
      case 'IN_PROGRESS': return state('running', 'processing');
      case 'FINISHED': return state('running', 'ready_to_publish');
      case 'PUBLISHED': return state('accepted', 'published_media_id_unverified');
      case 'EXPIRED': return state('retryable', 'container_expired');
      case 'ERROR': return { ...state('failed'), error: { errorClass: 'platform_rejected', reason: 'container_error' } };
      default: return unknown;
    }
  }
  if (provider === 'meta_instagram' && reference.kind === 'post') {
    const response = await metaRead(request, ig, reference.id, token, { fields: 'id,permalink,owner' });
    const body = record(response.body);
    const permalink = secureUrl(body.permalink);
    if (id(body) === reference.id && identifier(record(body.owner).id) === owner && permalink && ['instagram.com', 'www.instagram.com'].includes(new URL(permalink).host)) return { ...state('published'), permalink };
  }
  if (provider === 'meta_facebook' && reference.kind === 'post') {
    const response = await metaRead(request, fb, reference.id, token, { fields: 'id,permalink_url,is_published,from' });
    const body = record(response.body);
    const permalink = secureUrl(body.permalink_url);
    if (id(body) !== reference.id || identifier(record(body.from).id) !== owner) return unknown;
    if (body.is_published === true && permalink && ['facebook.com', 'www.facebook.com'].includes(new URL(permalink).host)) return { ...state('published'), permalink };
    if (reference.scheduled && body.is_published === false) return state('accepted', 'scheduled_on_platform');
  }
  if (provider === 'tiktok' && reference.kind === 'publish') {
    const response = await postJson(request, `${tiktok}/post/publish/status/fetch/`, token, { publish_id: reference.id });
    const data = record(record(response.body).data);
    switch (data.status) {
      case 'PROCESSING_UPLOAD': case 'PROCESSING_DOWNLOAD': return state('running', 'uploading');
      case 'SEND_TO_USER_INBOX': return state('accepted', 'awaiting_creator_action');
      case 'PUBLISH_COMPLETE': {
        const ids = data.publicaly_available_post_id;
        const postIds = Array.isArray(ids) ? [...new Set(ids.map(socialId).filter((item): item is string => item !== undefined))] : [];
        return postIds.length ? { ...state('published'), postIds } : state('accepted', reference.visibility === 'SELF_ONLY' ? 'published_limited' : 'under_review');
      }
      case 'FAILED': return { ...state('failed'), error: classifyCode(text(data.fail_reason), 'platform_rejected') };
      case 'PUBLISH_CANCELLED': return state('cancelled');
      default: return unknown;
    }
  }
  if (provider === 'youtube' && reference.kind === 'upload_session') {
    const session = youtubeSession(reference.id);
    const bytes = reference.uploadBytes;
    if (!session || typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0) return { ...unknown, subStatus: 'invalid_upload_session' };
    const response = await request({ method: 'PUT', url: session, headers: { ...bearer(token), 'content-length': '0', 'content-range': `bytes */${bytes}` } }, { accept: [308] });
    if (response.status === 308) return state('running', 'upload_incomplete');
    const videoId = id(response.body);
    if (!videoId) return unknown;
    return observeSocial(provider, { kind: 'post', id: videoId, parentId: owner, visibility: reference.visibility, scheduled: reference.scheduled }, ctx, request, token);
  }
  if (provider === 'youtube' && reference.kind === 'post') {
    const response = await metaRead(request, yt, 'videos', token, { part: 'snippet,status,processingDetails', id: reference.id });
    const video = rows(record(response.body).items).find(item => id(item) === reference.id);
    if (!video || record(video.snippet).channelId !== owner) return unknown;
    const status = record(video.status);
    const processing = record(video.processingDetails).processingStatus;
    const failure = youtubeFailure(status, processing);
    if (failure) return { ...state('failed'), error: failure };
    if (status.uploadStatus === 'deleted') return unknown;
    const ready = status.uploadStatus === 'processed' || processing === 'succeeded';
    if (ready && status.privacyStatus === 'public') return { ...state('published'), permalink: url('https://www.youtube.com/watch', { v: reference.id }) };
    if (ready && status.privacyStatus === 'unlisted' && reference.visibility === 'unlisted') return { ...state('published'), permalink: url('https://www.youtube.com/watch', { v: reference.id }) };
    if (ready && status.privacyStatus === 'private' && reference.visibility === 'private' && !reference.scheduled) return state('published');
    if (reference.scheduled && status.privacyStatus === 'private' && text(status.publishAt)) return state('accepted', 'scheduled_on_platform');
    return state('accepted', ready ? 'published_limited' : 'processing');
  }
  return unknown;
}

export async function socialPage(provider: ProviderKey, resource: string, cursor: string | null, ctx: SyncCtx, request: Client, token: string): Promise<SyncPage> {
  const owner = account(ctx);
  const after = cursor ?? undefined;
  if (provider === 'meta_instagram' || provider === 'meta_facebook') {
    const root = provider === 'meta_instagram' ? ig : fb;
    let path: string;
    let fields: string;
    if (provider === 'meta_instagram' && resource === 'comment_read') {
      const mediaId = pathId(ctx.objectId, 'media_id_required');
      const media = record((await metaRead(request, ig, mediaId, token, { fields: 'id,owner' })).body);
      if (id(media) !== mediaId || id(media.owner) !== owner) throw new AdapterError('permission_denied', 'post_identity_unverified');
      path = `${mediaId}/comments`;
      fields = 'id,text,timestamp,username,like_count';
    } else if (provider === 'meta_facebook' && resource === 'comment_read') {
      const postId = pathId(ctx.objectId, 'post_id_required');
      const post = record((await metaRead(request, fb, postId, token, { fields: 'id,from' })).body);
      if (id(post) !== postId || id(post.from) !== owner) throw new AdapterError('permission_denied', 'post_identity_unverified');
      path = `${postId}/comments`;
      fields = 'id,message,created_time,from,like_count';
    } else if (provider === 'meta_facebook' && resource === 'scheduled_post_read') {
      path = `${owner}/scheduled_posts`;
      fields = 'id,message,scheduled_publish_time,is_published,from';
    } else if (resource === 'post_read') {
      path = `${owner}/${provider === 'meta_instagram' ? 'media' : 'feed'}`;
      fields = provider === 'meta_instagram' ? 'id,caption,media_type,permalink,timestamp' : 'id,message,created_time,permalink_url,from';
    } else throw new AdapterError('unsupported', 'sync_not_implemented');
    const response = await metaRead(request, root, path, token, { fields, after });
    const body = record(response.body);
    if (!Array.isArray(body.data)) throw new AdapterError('transient', 'malformed_sync_page');
    const paging = record(body.paging);
    const nextCursor = paging.next ? text(record(paging.cursors).after) : null;
    if (paging.next && !nextCursor) throw new AdapterError('transient', 'missing_sync_cursor');
    return { items: rows(body.data), nextCursor: nextCursor ?? null };
  }
  if (provider === 'youtube') {
    if (resource === 'insights_read' || resource === 'comment_read') {
      const videoId = pathId(ctx.objectId, 'video_id_required');
      const part = resource === 'insights_read' ? 'snippet,statistics' : 'snippet';
      const body = record((await metaRead(request, yt, 'videos', token, { part, id: videoId })).body);
      if (!Array.isArray(body.items)) throw new AdapterError('transient', 'malformed_sync_page');
      const video = rows(body.items).find(item => id(item) === videoId && record(item.snippet).channelId === owner);
      if (resource === 'insights_read') return { items: video ? [{ ...record(video.statistics), id: videoId }] : [], nextCursor: null };
      if (!video) throw new AdapterError('permission_denied', 'post_identity_unverified');
      const threads = record((await metaRead(request, yt, 'commentThreads', token, {
        part: 'snippet', videoId, maxResults: '100', pageToken: after, textFormat: 'plainText',
      })).body);
      if (!Array.isArray(threads.items)) throw new AdapterError('transient', 'malformed_sync_page');
      return { items: rows(threads.items).filter(item => record(item.snippet).videoId === videoId), nextCursor: text(threads.nextPageToken) ?? null };
    }
    if (resource === 'post_read') {
      const uploads = pathId(ctx.uploadsPlaylistId, 'uploads_playlist_required');
      const response = await metaRead(request, yt, 'playlistItems', token, { part: 'snippet,contentDetails,status', playlistId: uploads, maxResults: '50', pageToken: after });
      const body = record(response.body);
      if (!Array.isArray(body.items)) throw new AdapterError('transient', 'malformed_sync_page');
      const items = rows(body.items).filter(item => {
        const snippet = record(item.snippet);
        return snippet.playlistId === uploads && snippet.channelId === owner && (snippet.videoOwnerChannelId ?? owner) === owner;
      });
      return { items, nextCursor: text(body.nextPageToken) ?? null };
    }
  }
  throw new AdapterError('unsupported', 'sync_not_implemented');
}
