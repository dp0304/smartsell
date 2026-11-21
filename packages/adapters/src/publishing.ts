import { bearer, fail, https, identifier, json, list, object, platformError, text, urlWith } from './adapter-http.ts';
import type { Requester } from './adapter-http.ts';
import { verifiedTikTokMedia, youtubeFailure } from './provider-social.ts';
import type { ConnectionCtx, ExternalRef, OperationKey, OutcomeObservation, PlatformProvider, ValidationIssue } from './types.ts';

const version = 'v24.0';
const instagram = `https://graph.instagram.com/${version}`;
const facebook = `https://graph.facebook.com/${version}`;
const tiktok = 'https://open.tiktokapis.com/v2/post/publish';
const segment = (value: unknown): string | undefined => {
  const valueText = text(value);
  return valueText && /^[A-Za-z0-9_.-]+$/.test(valueText) && valueText !== '.' && valueText !== '..' ? valueText : undefined;
};
const readId = (value: unknown) => segment(identifier(value));
const youtubePrivacy = ['public', 'private', 'unlisted'];

export function validatePublish(provider: PlatformProvider, operation: OperationKey, input: unknown): ValidationIssue[] {
  const data = object(input);
  const issues: ValidationIssue[] = [];
  const require = (field: string, condition: unknown, reason = 'required_or_invalid') => { if (!condition) issues.push({ field, reason }); };
  if (provider === 'meta_instagram' && operation === 'prepare_publish') {
    require('mediaUrl', https(data.mediaUrl));
    require('mediaType', ['jpeg', 'reels'].includes(String(data.mediaType)));
    if (data.mediaType === 'reels' && data.altText !== undefined) require('altText', false, 'unsupported_for_reels');
  }
  if (provider === 'meta_instagram' && operation === 'publish') require('containerId', segment(data.containerId));
  if (provider === 'meta_facebook' && operation === 'publish') {
    require('message', data.photoUrl !== undefined || text(data.message) || https(data.link));
    if (data.photoUrl !== undefined) require('photoUrl', https(data.photoUrl));
    if (data.link !== undefined) require('link', https(data.link) && data.photoUrl === undefined);
    if (data.publishAt !== undefined) require('publishAt', false, 'unsupported_schedule');
  }
  if (provider === 'tiktok' && (operation === 'publish' || operation === 'upload_draft')) {
    require('mediaUrl', https(data.mediaUrl));
    if (data.watermarked === true) require('watermarked', false, 'unsupported_watermark');
    if (operation === 'publish') {
      require('privacyLevel', text(data.privacyLevel));
      require('privacySelected', data.privacySelected === true);
      require('musicConsent', data.musicConsent === true);
      require('durationSeconds', typeof data.durationSeconds === 'number' && Number.isFinite(data.durationSeconds) && data.durationSeconds > 0);
      require('commercialDisclosure', ['none', 'own_brand', 'branded_content'].includes(String(data.commercialDisclosure)));
      require('commercialDisclosure', data.commercialDisclosure !== 'branded_content' || data.privacyLevel !== 'SELF_ONLY', 'branded_content_requires_visibility');
    }
  }
  if (provider === 'youtube' && operation === 'publish') {
    require('title', text(data.title));
    require('privacyStatus', youtubePrivacy.includes(String(data.privacyStatus)));
    require('media', data.media instanceof Uint8Array && data.media.byteLength > 0 && data.media.byteLength <= 32 * 1024 * 1024, 'multipart_media_required_max_32_mib');
    require('mimeType', typeof data.mimeType === 'string' && /^video\/[a-z0-9.+-]+$/.test(data.mimeType));
    if (data.containsSyntheticMedia !== undefined) require('containsSyntheticMedia', typeof data.containsSyntheticMedia === 'boolean');
    if (data.madeForKids !== undefined) require('madeForKids', typeof data.madeForKids === 'boolean');
    if (data.publishAt !== undefined) require('publishAt', data.privacyStatus === 'private' && typeof data.publishAt === 'string' && Date.parse(data.publishAt) > Date.now());
  }
  return issues;
}

function responseRef(provider: PlatformProvider, accountId: string, kind: ExternalRef['kind'], value: unknown): ExternalRef {
  const id = readId(value);
  if (!id) fail('outcome_unknown', 'write_reference_missing');
  return { provider, accountId, kind, id };
}

export async function publish(provider: PlatformProvider, operation: OperationKey, input: unknown, ctx: ConnectionCtx, request: Requester): Promise<OutcomeObservation> {
  const data = object(input);
  const credential = ctx.credential!;
  const auth = bearer(credential.accessToken);
  const accountId = ctx.accountId;
  const platformAccount = segment(credential.configuration?.platformAccountId);
  const send = async (url: string, body: unknown, effect: 'read' | 'write' = 'write') => {
    const content = json(body);
    return (await request({ url, method: 'POST', effect, ...content, headers: { ...content.headers, ...auth } })).payload;
  };

  if (provider === 'meta_instagram') {
    if (!platformAccount) fail('permission_denied', 'missing_platform_account_id');
    if (operation === 'prepare_publish') {
      const reel = data.mediaType === 'reels';
      const payload = await send(`${instagram}/${platformAccount}/media`, { caption: text(data.caption),
        ...(reel ? { video_url: data.mediaUrl, media_type: 'REELS' } : { image_url: data.mediaUrl, alt_text: text(data.altText) }) });
      return { status: 'running', substatus: 'uploaded', ref: responseRef(provider, accountId, 'container', payload.id) };
    }
    const ref: ExternalRef = { provider, accountId, kind: 'container', id: String(data.containerId) };
    if (data.containerAccountId !== accountId) fail('permission_denied', 'container_binding_required');
    const observation = await observe(provider, ref, ctx, request);
    if (observation.substatus !== 'ready_to_publish') return observation;
    const { payload: quota } = await request({ effect: 'read', method: 'GET', headers: auth,
      url: urlWith(`${instagram}/${platformAccount}/content_publishing_limit`, { fields: 'quota_usage,config' }) });
    const limits = object(list(quota.data)[0]);
    const total = object(limits.config).quota_total;
    const used = limits.quota_usage;
    if (typeof used !== 'number' || !Number.isSafeInteger(used) || used < 0 || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0) {
      fail('transient', 'publishing_quota_missing');
    }
    if (used >= total) fail('quota_exhausted', 'instagram_publishing_quota');
    try {
      const payload = await send(`${instagram}/${platformAccount}/media_publish`, { creation_id: ref.id });
      return { status: 'accepted', ref: responseRef(provider, accountId, 'media', payload.id) };
    } catch (error) {
      if (object(error).errorClass === 'outcome_unknown') return { status: 'unknown', ref, error: { errorClass: 'outcome_unknown' } };
      throw error;
    }
  }
  if (provider === 'meta_facebook') {
    if (!platformAccount) fail('permission_denied', 'missing_platform_account_id');
    if (!credential.approvals?.includes('facebook_page_create_content')) fail('permission_denied', 'missing_page_task');
    const photo = data.photoUrl !== undefined;
    const payload = await send(`${facebook}/${platformAccount}/${photo ? 'photos' : 'feed'}`, photo
      ? { url: data.photoUrl, caption: text(data.message) }
      : { message: text(data.message), link: text(data.link) });
    return { status: 'accepted', ref: responseRef(provider, accountId, 'page_post', photo ? payload.post_id : payload.id) };
  }
  if (provider === 'tiktok') {
    const media = https(data.mediaUrl)!;
    const verified = credential.configuration?.verifiedMediaPrefix;
    if (!verified || !verifiedTikTokMedia(media.href, verified)) {
      fail('permission_denied', 'url_ownership_unverified');
    }
    const source_info = { source: 'PULL_FROM_URL', video_url: media.href };
    if (operation === 'upload_draft') {
      const payload = await send(`${tiktok}/inbox/video/init/`, { source_info });
      return { status: 'running', substatus: 'uploading', ref: responseRef(provider, accountId, 'tiktok_publish', object(payload.data).publish_id) };
    }
    const creator = object((await send(`${tiktok}/creator_info/query/`, {}, 'read')).data);
    const maxDuration = creator.max_video_post_duration_sec;
    if (!list(creator.privacy_level_options).includes(data.privacyLevel) || typeof maxDuration !== 'number' || !Number.isFinite(maxDuration) ||
      typeof data.durationSeconds !== 'number' || data.durationSeconds > maxDuration) fail('permission_denied', 'creator_publish_options_unavailable');
    const payload = await send(`${tiktok}/video/init/`, { source_info, post_info: {
      title: text(data.caption), privacy_level: data.privacyLevel,
      disable_comment: creator.comment_disabled !== false || data.allowComment !== true,
      disable_duet: creator.duet_disabled !== false || data.allowDuet !== true,
      disable_stitch: creator.stitch_disabled !== false || data.allowStitch !== true,
      brand_content_toggle: data.commercialDisclosure === 'branded_content', brand_organic_toggle: data.commercialDisclosure === 'own_brand',
    } });
    return { status: 'running', substatus: 'uploading', ref: responseRef(provider, accountId, 'tiktok_publish', object(payload.data).publish_id) };
  }
  if (provider === 'youtube') {
    const boundary = `smartsell_${crypto.randomUUID()}`;
    const encoder = new TextEncoder();
    const video = data.media as Uint8Array;
    const metadata = { snippet: { title: data.title, description: text(data.description) }, status: {
      privacyStatus: data.privacyStatus, publishAt: data.publishAt, containsSyntheticMedia: data.containsSyntheticMedia,
      selfDeclaredMadeForKids: typeof data.madeForKids === 'boolean' ? data.madeForKids : undefined,
    } };
    const head = encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${data.mimeType}\r\n\r\n`);
    const tail = encoder.encode(`\r\n--${boundary}--\r\n`);
    const body = new Uint8Array(head.length + video.length + tail.length);
    body.set(head); body.set(video, head.length); body.set(tail, head.length + video.length);
    const { payload } = await request({ method: 'POST', effect: 'write', body,
      headers: { ...auth, 'Content-Type': `multipart/related; boundary=${boundary}` },
      url: urlWith('https://www.googleapis.com/upload/youtube/v3/videos', { part: 'snippet,status', uploadType: 'multipart', notifySubscribers: String(data.notifySubscribers === true) }) });
    return { status: 'accepted', substatus: 'processing', ref: responseRef(provider, accountId, 'youtube_video', payload.id) };
  }
  fail('unsupported', 'publish_api_unavailable');
}

export async function observe(provider: PlatformProvider, ref: ExternalRef, ctx: ConnectionCtx, request: Requester): Promise<OutcomeObservation> {
  if (ref.provider !== provider || ref.accountId !== ctx.accountId || !segment(ref.id)) fail('invalid_input', 'invalid_reference');
  const auth = bearer(ctx.credential!.accessToken);
  const get = async (base: string, params: Record<string, string>) => (await request({ method: 'GET', effect: 'read', url: urlWith(base, params), headers: auth })).payload;
  if (provider === 'meta_instagram' && ref.kind === 'container') {
    const payload = await get(`${instagram}/${ref.id}`, { fields: 'status_code,id' });
    if (payload.id !== undefined && readId(payload.id) !== ref.id) return { status: 'unknown', ref };
    switch (payload.status_code) {
      case 'IN_PROGRESS': return { status: 'running', substatus: 'processing', ref };
      case 'FINISHED': return { status: 'running', substatus: 'ready_to_publish', ref };
      case 'PUBLISHED': return { status: 'accepted', substatus: 'published_needs_media_reference', ref };
      case 'ERROR': return { status: 'failed', ref, error: { errorClass: 'platform_rejected', reason: 'container_error' } };
      case 'EXPIRED': return { status: 'failed', ref, error: { errorClass: 'transient', reason: 'container_expired' } };
      default: return { status: 'unknown', ref };
    }
  }
  if ((provider === 'meta_instagram' && ref.kind === 'media') || (provider === 'meta_facebook' && ref.kind === 'page_post')) {
    const expectedOwner = segment(ctx.credential!.configuration?.platformAccountId);
    if (!expectedOwner) fail('permission_denied', 'missing_platform_account_id');
    const isInstagram = provider === 'meta_instagram';
    const payload = await get(`${isInstagram ? instagram : facebook}/${ref.id}`,
      { fields: isInstagram ? 'id,permalink,owner' : 'id,permalink_url,is_published,from' });
    const owner = identifier(object(isInstagram ? payload.owner : payload.from).id);
    if (identifier(payload.id) !== ref.id || owner !== expectedOwner) return { status: 'unknown', substatus: 'post_identity_unverified', ref };
    const url = https(isInstagram ? payload.permalink : payload.permalink_url);
    const host = isInstagram ? 'instagram.com' : 'facebook.com';
    if (!url || ![host, `www.${host}`].includes(url.host) || (!isInstagram && payload.is_published !== true)) {
      return { status: 'accepted', substatus: 'pending_readback', ref };
    }
    return { status: 'published', ref, url: url.href };
  }
  if (provider === 'tiktok' && ref.kind === 'tiktok_publish') {
    const data = json({ publish_id: ref.id });
    const { payload } = await request({ method: 'POST', effect: 'read', url: `${tiktok}/status/fetch/`, ...data, headers: { ...data.headers, ...auth } });
    const result = object(payload.data);
    switch (result.status) {
      case 'PROCESSING_UPLOAD': case 'PROCESSING_DOWNLOAD': return { status: 'running', substatus: 'uploading', ref };
      case 'SEND_TO_USER_INBOX': return { status: 'accepted', substatus: 'awaiting_creator_action', ref };
      case 'PUBLISH_COMPLETE': {
        const postIds = [...new Set(list(result.publicaly_available_post_id).map(readId).filter((value): value is string => value !== undefined))];
        return postIds.length ? { status: 'published', ref, postIds } : { status: 'accepted', substatus: 'published_limited_or_under_review', ref };
      }
      case 'FAILED': return { status: 'failed', ref, error: platformError(provider, text(result.fail_reason) ?? '') };
      default: return { status: 'unknown', ref };
    }
  }
  if (provider === 'youtube' && ref.kind === 'youtube_video') {
    const expectedChannel = segment(ctx.credential!.configuration?.platformAccountId ?? ctx.accountId);
    if (!expectedChannel) fail('permission_denied', 'missing_platform_account_id');
    const payload = await get('https://www.googleapis.com/youtube/v3/videos', { part: 'snippet,status', id: ref.id });
    const video = list(payload.items).map(object).find(item => item.id === ref.id && object(item.snippet).channelId === expectedChannel);
    if (!video) return { status: 'unknown', substatus: 'post_identity_unverified', ref };
    const status = object(video.status);
    const failure = youtubeFailure(status);
    if (failure) return { status: 'failed', ref, error: failure };
    if (status.uploadStatus === 'deleted') return { status: 'unknown', ref };
    if (status.uploadStatus === 'processed' && status.privacyStatus === 'public') return { status: 'published', ref, url: urlWith('https://www.youtube.com/watch', { v: ref.id }) };
    return { status: 'accepted', ref, substatus: text(status.publishAt) ? 'scheduled_on_platform' : status.uploadStatus === 'processed' ? 'published_limited' : 'processing' };
  }
  fail('invalid_input', 'invalid_reference_kind');
}
