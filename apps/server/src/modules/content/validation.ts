import { checkUsage } from '../asset/command-rights.ts';
import type { Context, Entity, Fields } from '../types.ts';
import { fail, hash, list, render } from './model.ts';
import { isEstimatedPrice } from '../commerce/listings.ts';

export async function assetUsage(ctx: Context, media: Fields, platform: string, market: string | null, body: string, at: string, brand?: string) {
  const version = await ctx.get('asset', 'asset_version', media.asset_version_id);
  const asset = version?.data.asset_id ? await ctx.get('asset', 'asset', version.data.asset_id) : undefined;
  if (!asset || asset.data.status === 'archived' || (brand && asset.data.brand_id !== brand) || (media.asset_id && media.asset_id !== asset.id)) return { allowed: false };
  const result = await checkUsage(ctx, {
    platform, market: market ?? '*', purpose: 'organic', at,
    asset_version_id: media.asset_version_id, modification: !!(media.crop || media.rendition_id),
  });
  return { ...result, allowed: result.allowed && (!result.attribution_text || body.includes(result.attribution_text)) };
}

export async function assetPermitted(...args: Parameters<typeof assetUsage>) {
  return (await assetUsage(...args)).allowed;
}

type Severity = 'blocking' | 'warning' | 'info';
type Issue = { severity: Severity; code: string; field?: string; social_account_id?: string };
const defaults: Record<string, Fields> = {
  instagram: { max_characters: 2200, max_media: 20, supports_captions: false },
  facebook: { max_characters: 63206 },
  tiktok: { max_characters: 2200, supports_captions: false },
  youtube: { max_characters: 5000 },
};
const formatAliases: Record<string, string> = { feed_image: 'image', long_video: 'video', short_video: 'short' };
const publishOperations = new Set(['publish', 'publish_story', 'publish_short', 'publish_schedule']);
const minimumMedia: Record<string, number> = { feed_image: 1, carousel: 2, reel: 1, story: 1, short_video: 1, long_video: 1 };

export const accountPlatform = (row: Entity) => String(row.data.platform ?? row.data.provider ?? '').replace(/^meta_/, '');

function scopedFactRevision(revision: Entity, fact: Entity | undefined, sku: Entity | undefined): Entity {
  const matches = fact && revision.data.fact_id === fact.id && sku && sku.data.product_id === fact.data.product_id && (!fact.data.variant_id || fact.data.variant_id === sku.id);
  return { ...revision, data: { ...revision.data, variant_id: matches ? sku.id : null, brand_id: fact?.data.brand_id,
    category: fact?.data.category === 'speculation' ? 'speculation' : revision.data.category ?? fact?.data.category,
    fact_key: fact?.data.fact_key, applicable_market_ids: fact?.data.applicable_market_ids,
    is_current: fact?.data.status === 'active' && fact.data.approved_revision_id === revision.id &&
      fact.data.rolled_back !== true && revision.data.rolled_back !== true && sku?.data.rolled_back !== true,
  } };
}

export async function loadProductSources(ctx: Context, refs: Fields[]) {
  const cache = new Map<string, Entity | undefined>();
  for (const ref of refs) {
    for (const [kind, refId] of [['product_fact_revision', ref.fact_revision_id], ['listing_snapshot', ref.listing_snapshot_id]] as const) {
      const key = `${kind}:${refId}:${ref.variant_id}`;
      if (!refId || cache.has(key)) continue;
      let row = await ctx.get('commerce', kind, refId);
      if (kind === 'listing_snapshot' && row) {
        const variant = await ctx.get('commerce', 'product_variant', ref.variant_id);
        const product = variant?.data.product_id ? await ctx.get('commerce', 'product', variant.data.product_id) : undefined;
        row = { ...row, data: { ...row.data, brand_id: product?.data.brand_id ?? variant?.data.brand_id ?? row.data.brand_id } };
      }
      if (kind === 'product_fact_revision' && row) {
        const fact = row.data.fact_id ? await ctx.get('commerce', 'product_fact', row.data.fact_id) : undefined;
        const variant = await ctx.get('commerce', 'product_variant', ref.variant_id);
        row = scopedFactRevision(row, fact, variant);
      }
      cache.set(key, row);
    }
  }
  return cache;
}
export function usableProductSource(row: Entity | undefined, ref: Fields, fact: boolean, brand?: string) {
  if (!row) return false;
  const data = row.data;
  if (brand && (fact || data.brand_id) && data.brand_id !== brand) return false;
  if ((data.variant_id ?? data.product_variant_id) !== ref.variant_id) return false;
  if (ref.market_id && data.market_id && data.market_id !== ref.market_id) return false;
  if (Array.isArray(data.applicable_market_ids) && !data.applicable_market_ids.includes(ref.market_id)) return false;
  if (ref.currency && data.currency && data.currency !== ref.currency) return false;
  if (data.is_current === false || data.retracted_at) return false;
  return fact ? (data.review_status ?? data.status) === 'approved' && data.category !== 'speculation'
    : data.is_current === true && (data.availability == null || data.availability === 'observed') && !isEstimatedPrice(data);
}

export function factPin(source: Entity, locale: string) {
  const { value, source: provenance, revision_no, fact_id, fact_key } = source.data;
  const localized = value?.by_locale ?? {};
  const language = locale.split('-')[0];
  const inserted_text = value?.type === 'locale_text'
    ? localized[locale] ?? localized[language] ?? localized.und
    : value?.type === 'number' ? [value.number, value.unit].filter(part => part != null).join(' ') : value?.text;
  const collected_at = provenance?.collected_at ?? source.created_at;
  if (typeof inserted_text !== 'string' || !inserted_text.trim() || inserted_text.length > 10000 ||
      !Number.isInteger(revision_no) || !Number.isFinite(Date.parse(collected_at))) return;
  return { fact_id, fact_key, fact_revision_no: revision_no, collected_at, inserted_text: inserted_text.trim() };
}

// Provenance is server-owned. Preserve a previously saved pin when its editable reference is unchanged.
function refFingerprint(ref: Fields) {
  const { fact_id, fact_key, fact_revision_no, collected_at, ...editable } = ref;
  return hash(editable);
}

export async function pinProductFacts(ctx: Context, variant: Fields, draft: Fields, prior: Fields[], restoring = false) {
  const refs = draft.product_refs as Fields[];
  if (!refs.some(ref => ref.fact_revision_id)) return draft;
  const sources = await loadProductSources(ctx, refs.filter(ref => ref.fact_revision_id));
  const previous = new Map(prior.filter(ref => ref.fact_revision_id).map(ref => [refFingerprint(ref), ref]));
  const market = variant.market_id ?? variant.market ?? null;
  const product_refs = refs.map(ref => {
    if (!ref.fact_revision_id) return ref;
    const source = sources.get(`product_fact_revision:${ref.fact_revision_id}:${ref.variant_id}`);
    if (source?.data.category === 'speculation') fail('invalid_product_reference', 'Speculative product facts cannot be inserted');
    const saved = previous.get(refFingerprint(ref));
    if (saved || restoring) {
      const historical = saved ?? ref;
      if (historical.collected_at || !source) return historical;
      const provenance = factPin(source, variant.locale);
      return provenance ? { ...historical, ...provenance, inserted_text: historical.inserted_text ?? provenance.inserted_text } : historical;
    }
    const scoped = { ...ref, market_id: ref.market_id ?? market };
    if (!source || scoped.market_id !== market || !usableProductSource(source, scoped, true, variant.brand_id)) {
      fail('invalid_product_reference', 'Product fact revision is unavailable or unapproved');
    }
    const pin = factPin(source, variant.locale);
    if (!pin) fail('invalid_product_reference', 'Product fact revision has no usable value or provenance for this locale');
    return { ...scoped, ...pin };
  });
  return { ...draft, product_refs };
}

export async function factChoices(ctx: Context, variant: Entity, productId: string) {
  const product = await ctx.get('commerce', 'product', productId);
  if (!product || product.data.brand_id !== variant.data.brand_id || product.data.rolled_back === true) {
    fail('not_found', 'Product not found', 404);
  }
  const skus = (await list(ctx, 'product_variant', 'commerce')).filter(sku => sku.data.product_id === product.id);
  const choices: Fields[] = [];
  for (const fact of await list(ctx, 'product_fact', 'commerce')) {
    if (fact.data.product_id !== product.id || !fact.data.approved_revision_id) continue;
    const revision = await ctx.get('commerce', 'product_fact_revision', fact.data.approved_revision_id);
    if (!revision) continue;
    for (const sku of skus) {
      const ref = { variant_id: sku.id, fact_revision_id: revision.id, market_id: variant.data.market_id ?? variant.data.market ?? null };
      const source = scopedFactRevision(revision, fact, sku);
      if (!usableProductSource(source, ref, true, variant.data.brand_id)) continue;
      const pin = factPin(source, variant.data.locale);
      if (pin) choices.push({ ...ref, ...pin, sku: sku.data.sku ?? sku.data.title ?? sku.id });
    }
  }
  return choices;
}

export async function validate(ctx: Context, variant: Fields, draft: Fields, accountIds: string[] = [], scheduledAt = ctx.now) {
  const issues: Issue[] = [];
  const add = (severity: Severity, code: string, field?: string, social_account_id?: string) => issues.push({ severity, code, ...(field ? { field } : {}), ...(social_account_id ? { social_account_id } : {}) });
  const preview = render(draft);
  const options = draft.settings.platform_options?.[variant.platform] ?? {};
  const media = draft.media as Fields[];
  if (!draft.body.trim() && !media.length) add('blocking', 'content_required', 'body');
  if (media.filter(item => !item.role || ['primary', 'slide'].includes(item.role)).length < (minimumMedia[variant.format] ?? 0)) add('blocking', 'media_required', 'media');
  if (variant.platform === 'tiktok') {
    if (!options.privacy_level) add('blocking', 'tiktok_privacy_required', 'settings.platform_options.tiktok.privacy_level');
    if (!options.commercial_disclosure) add('blocking', 'tiktok_commercial_disclosure_required', 'settings.platform_options.tiktok.commercial_disclosure');
    if (options.privacy_level === 'SELF_ONLY' && ['branded_content', 'both'].includes(options.commercial_disclosure)) add('blocking', 'tiktok_branded_content_visibility', 'settings.platform_options.tiktok.privacy_level');
  }
  if (['douyin', 'xiaohongshu'].includes(variant.platform) && !options.visibility) add('blocking', 'mobile_visibility_required', `settings.platform_options.${variant.platform}.visibility`);

  const market = variant.market_id ?? variant.market;
  const effectiveMedia = new Map<number, Fields>();
  for (const [index, item] of media.entries()) {
    const path = `media.${index}`;
    const asset = await ctx.get('asset', 'asset_version', item.asset_version_id);
    if (!asset) add('blocking', 'asset_version_missing', `${path}.asset_version_id`);
    else {
      effectiveMedia.set(index, { ...asset.data, ...asset.data.metadata, ...asset.data.meta });
      if (!await assetPermitted(ctx, item, variant.platform, market, draft.body, scheduledAt, variant.brand_id)) {
        add('blocking', 'asset_rights_denied', `${path}.asset_version_id`);
      }
    }
    if (item.requires_rendition && !item.rendition_id) add('blocking', 'rendition_required', `${path}.rendition_id`);
    for (const field of ['rendition_id', 'caption_rendition_id']) {
      if (!item[field]) continue;
      const rendition = await ctx.get('asset', 'asset_rendition', item[field]);
      if (!rendition || !['ready', 'completed', 'succeeded'].includes(rendition.data.status ?? rendition.data.state) ||
          (field === 'rendition_id' && (rendition.data.asset_version_id !== item.asset_version_id ||
            (rendition.data.target_platform && rendition.data.target_platform !== variant.platform)))) {
        add('blocking', 'rendition_not_ready', `${path}.${field}`);
      } else if (field === 'rendition_id') {
        const file = rendition.data.file_object_id ? await ctx.get('core', 'file_object', rendition.data.file_object_id) : undefined;
        effectiveMedia.set(index, { ...effectiveMedia.get(index), ...rendition.data.params, ...rendition.data.metadata, ...rendition.data.meta,
          ...(file?.data.size_bytes != null ? { size_bytes: file.data.size_bytes } : {}) });
      }
    }
  }

  const media_layout = media.map((item, index) => {
    const metadata = effectiveMedia.get(index);
    const dimensions = metadata && Number.isFinite(metadata.width) && metadata.width > 0 && Number.isFinite(metadata.height) && metadata.height > 0
      ? { width: metadata.width, height: metadata.height } : null;
    const crop = item.crop;
    const appliesCrop = !item.rendition_id && Number.isFinite(crop?.w) && crop.w > 0 && Number.isFinite(crop?.h) && crop.h > 0;
    const aspect_ratio = dimensions ? dimensions.width / dimensions.height * (appliesCrop ? crop.w / crop.h : 1) : null;
    return { media_index: index, dimensions, aspect_ratio, crop: crop ?? null, cover_time_ms: item.cover_time_ms ?? null };
  });
  const capabilities = await list(ctx, 'capability', 'account');
  const targetIds = accountIds.length ? accountIds : variant.social_account_id ? [variant.social_account_id] : [];
  for (const target of targetIds.length ? targetIds : [undefined]) {
    if (target) {
      const account = await ctx.get('account', 'social_account', target);
      if (!account || (account.data.status != null && account.data.status !== 'active') || accountPlatform(account) !== variant.platform || (account.data.brand_id && variant.brand_id && account.data.brand_id !== variant.brand_id) || (variant.social_account_id && variant.social_account_id !== target)) {
        add('blocking', 'account_mismatch', 'social_account_ids', target);
        continue;
      }
    }
    const formats = [variant.format, formatAliases[variant.format]].filter(Boolean);
    const scope = capabilities.map(row => row.data).filter(data =>
      (!data.operation || publishOperations.has(data.operation)) &&
      (data.platform ? String(data.platform).replace(/^meta_/, '') === variant.platform : data.social_account_id === target && !!target) &&
      (!data.content_format && !data.format || (data.content_format ?? data.format) === '*' || formats.includes(data.content_format ?? data.format)));
    const select = (accountId?: string) => scope.filter(row => (row.social_account_id ?? undefined) === accountId).sort((a, b) => {
      const score = (row: Fields) => Number(formats.includes(row.content_format ?? row.format)) * 4 +
        (['available', 'manual_only'].includes(row.status) ? 2 : row.status === 'unverified' ? 0 : 1);
      return score(b) - score(a);
    })[0];
    const platformCaps = select();
    const capability = target ? select(target) : platformCaps;
    const unverified = !capability || capability.status === 'unverified';
    if (unverified) add('warning', 'capability_unverified', undefined, target);
    const videoOrStory = ['reel', 'story', 'short_video', 'long_video'].includes(variant.format);
    const rules = { ...defaults[variant.platform],
      ...(videoOrStory && ['instagram', 'tiktok'].includes(variant.platform) ? { supports_alt_text: false } : {}),
      ...platformCaps?.limits, ...(unverified ? {} : { ...capability, ...capability.limits }) };
    if (!unverified && (['unsupported', 'read_only', 'needs_authorization'].includes(capability.status) ||
      (Array.isArray(rules.formats) && !formats.some(format => rules.formats.includes(format))))) add('blocking', 'format_unsupported', 'format', target);
    for (const [rule, value, field] of [['max_characters', preview.char_count, 'body'], ['max_hashtags', preview.hashtags.length, 'body'], ['max_media', media.length, 'media']] as const) {
      if (typeof rules[rule] === 'number' && value > rules[rule]) add('blocking', rule, field, target);
    }
    for (const field of Array.isArray(rules.required_fields) ? rules.required_fields : []) {
      if (typeof field === 'string' && field.split('.').reduce((parent, key) => parent?.[key], draft) == null) add('blocking', 'required_field', field, target);
    }
    if (variant.platform === 'tiktok' && !unverified) {
      if (options.privacy_level && Array.isArray(rules.privacy_level_options) && !rules.privacy_level_options.includes(options.privacy_level)) add('blocking', 'tiktok_privacy_unsupported', 'settings.platform_options.tiktok.privacy_level', target);
      for (const toggle of ['comment', 'duet', 'stitch']) {
        if (options[`allow_${toggle}`] === true && (rules[`allow_${toggle}`] === false || rules[`${toggle}_disabled`] === true)) add('blocking', 'tiktok_interaction_disabled', `settings.platform_options.tiktok.allow_${toggle}`, target);
      }
    }
    for (const [index, item] of media.entries()) {
      const metadata = effectiveMedia.get(index);
      if (item.alt_text && rules.supports_alt_text === false) add('warning', 'alt_text_unsupported', `media.${index}.alt_text`, target);
      if (item.caption_rendition_id && rules.supports_captions === false) add('warning', 'captions_unsupported', `media.${index}.caption_rendition_id`, target);
      if (!metadata) continue;
      for (const [rule, field] of [['max_bytes', 'size_bytes'], ['max_duration_ms', 'duration_ms']] as const) {
        if (typeof rules[rule] === 'number' && typeof metadata[field] === 'number' && metadata[field] > rules[rule]) add('blocking', rule, `media.${index}`, target);
      }
      const aspect = media_layout[index]?.aspect_ratio;
      if (aspect != null && ((typeof rules.min_aspect === 'number' && aspect < rules.min_aspect) || (typeof rules.max_aspect === 'number' && aspect > rules.max_aspect))) add('blocking', 'media_aspect_unsupported', `media.${index}`, target);
    }
  }

  const productSources = await loadProductSources(ctx, draft.product_refs);
  for (const [index, ref] of (draft.product_refs as Fields[]).entries()) {
    const path = `product_refs.${index}`;
    if (ref.market_id && market && ref.market_id !== market) add('blocking', 'product_market_mismatch', path);
    if (ref.fact_revision_id && !usableProductSource(productSources.get(`product_fact_revision:${ref.fact_revision_id}:${ref.variant_id}`), ref, true, variant.brand_id)) add('blocking', 'product_fact_unavailable', `${path}.fact_revision_id`);
    if (ref.listing_snapshot_id && !usableProductSource(productSources.get(`listing_snapshot:${ref.listing_snapshot_id}:${ref.variant_id}`), ref, false, variant.brand_id)) add('blocking', 'listing_snapshot_unavailable', `${path}.listing_snapshot_id`);
  }
  if (variant.campaign_id) {
    const campaign = await ctx.get('campaign', 'campaign', variant.campaign_id);
    if (campaign) {
      const campaignMarket = (variant.market_id ?? variant.market) && (await list(ctx, 'campaign_market', 'campaign')).find(row =>
        row.data.campaign_id === campaign.id && row.data.market_id === (variant.market_id ?? variant.market));
      const at = Date.parse(scheduledAt);
      const outside = (window: Fields) => Date.parse(window.starts_at ?? window.start_at) > at || Date.parse(window.ends_at ?? window.end_at) < at;
      if (outside(campaign.data) || (campaignMarket && outside(campaignMarket.data))) add('blocking', 'outside_campaign_window', 'campaign_id');
      if (campaign.data.brand_id && variant.brand_id !== campaign.data.brand_id) add('blocking', 'campaign_brand_mismatch', 'campaign_id');
    }
  }
  return { issues, valid: !issues.some(issue => issue.severity === 'blocking'),
    preview: { ...preview, platform: variant.platform, format: variant.format, approximate: true, media, media_layout, settings: draft.settings } };
}
