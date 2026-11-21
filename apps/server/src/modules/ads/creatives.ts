import { required, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { accountAccess, accountFor, ads, bool, check, cmd, draft, eventData, expected, hash, inputRow, matchingCampaign, oneOf, optional, patch, read, refs, row, same } from './domain.js';

export async function rendition(ctx: Context, id: string, brandId: string) {
  const item = await required(ctx, 'asset', 'asset_rendition', id);
  const version = await required(ctx, 'asset', 'asset_version', item.data.asset_version_id);
  const asset = await required(ctx, 'asset', 'asset', version.data.asset_id);
  same(asset.data.brand_id, brandId, 'Asset');
  check(item.data.status === 'ready' && asset.data.status !== 'archived', 'invalid_state', 'Asset rendition is not ready', 409);
  return { item, version, asset };
}

export async function rightsCheck(ctx: Context, account: Entity, revision: Fields) {
  const variants = await Promise.all((revision.creative_variant_ids as string[]).map(id => row(ctx, 'ad_creative_variant', id)));
  const links = await ctx.list('asset', 'rights_grant_asset');
  const evidence: Fields[] = [];
  const blockers: Fields[] = [];
  for (const variant of variants) {
    const creative = await row(ctx, 'ad_creative', variant.data.creative_id);
    same(creative.data.ad_account_id, account.id, 'Creative account');
    if (creative.data.status === 'archived') {
      blockers.push({ creative_variant_id: variant.id, reason: 'creative_archived' });
      continue;
    }
    for (const id of variant.data.rendition_ids as string[]) {
      const { asset, version } = await rendition(ctx, id, account.data.brand_id);
      const matching = links.filter(link => link.data.asset_id === asset.id &&
        (link.data.version_scope !== 'specific_version' || link.data.asset_version_id === version.id));
      const scopes = creative.data.creator_identity_required ? ['paid_ads', 'creator_whitelisting'] : ['paid_ads'];
      for (const usage of scopes) {
        let found: Fields | undefined;
        for (const link of matching) {
          const grant = await ctx.get('asset', 'rights_grant', link.data.rights_grant_id);
          if (!grant || grant.data.brand_id !== account.data.brand_id || grant.data.revoked_at ||
              !['active', 'expiring'].includes(grant.data.status) || !grant.data.current_revision_id) continue;
          const terms = await ctx.get('asset', 'rights_grant_revision', grant.data.current_revision_id);
          if (!terms || terms.data.rights_grant_id !== grant.id) continue;
          const data = terms.data;
          const supportedUsage = usage === 'paid_ads' ? ['paid_ads', 'paid_usage'] : [usage];
          const provider = account.data.provider;
          const providerKeys = [provider, provider.replace(/_ads$/, '')];
          const placements = revision.placements as string[];
          const platformsCovered = !data.platforms || providerKeys.some(key => data.platforms.includes(key)) ||
            (provider === 'meta_ads' && placements.every(placement => data.platforms.includes(placement.split('_')[0]))) ||
            (provider === 'google_ads' && placements.every(placement => placement === 'youtube' && data.platforms.includes('youtube')));
          if (!data.usages?.some((item: string) => supportedUsage.includes(item)) || !platformsCovered ||
              (data.regions && !revision.regions.every((region: string) => data.regions.includes(region))) ||
              !(Date.parse(data.valid_from) <= Date.parse(revision.schedule.start_at)) ||
              (data.valid_until && !(Date.parse(data.valid_until) >= Date.parse(revision.schedule.end_at) && Date.parse(data.valid_until) > Date.parse(ctx.now)))) continue;
          found = { id: grant.id, revision_id: terms.id, rendition_id: id, usage, restrictions: data.restrictions ?? null, attribution_text: data.attribution_text ?? null };
          break;
        }
        if (found) evidence.push(found);
        else blockers.push({ creative_variant_id: variant.id, rendition_id: id, reason: usage === 'paid_ads' ? 'paid_usage_missing' : 'creator_identity_missing' });
      }
    }
  }
  return { eligible: blockers.length === 0, evidence, blockers };
}

export const creatives: Commands = {
  create_creative: cmd(draft, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'draft');
    const campaign_id = text(input, 'campaign_id', 200);
    await matchingCampaign(ctx, campaign_id, account.data.brand_id);
    const origin = oneOf(input.origin, ['platform_post', 'deliverable', 'asset', 'new'] as const, 'origin');
    const origin_ref = origin === 'new' ? null : text(input, 'origin_ref', 200);
    const creator_identity_required = input.creator_identity_required == null ? false : bool(input.creator_identity_required, 'creator_identity_required');
    if (origin_ref) {
      const source = origin === 'asset' ? await required(ctx, 'asset', 'asset', origin_ref)
        : origin === 'platform_post' ? await required(ctx, 'execution', 'platform_post', origin_ref)
        : await required(ctx, 'creator', 'deliverable', origin_ref);
      const owner = origin === 'deliverable' && !source.data.brand_id
        ? await required(ctx, 'creator', 'collaboration', source.data.collaboration_id) : source;
      same(owner.data.brand_id, account.data.brand_id, 'Creative source');
    }
    const creative = await ctx.insert(ads, 'ad_creative', { ad_account_id: account.id, brand_id: account.data.brand_id, campaign_id,
      origin, origin_ref, creator_identity_required, status: 'draft', created_by: ctx.actorId, rights_check: { status: 'needs_proposal_scope' } });
    await ctx.emit('ads.creative.created', eventData(ctx, creative));
    return creative;
  }),
  create_creative_variant: cmd(draft, async (ctx, input) => {
    const creative = await inputRow(ctx, 'ad_creative', input, 'creative_id');
    const account = await accountFor(ctx, creative, 'draft');
    check(creative.data.status !== 'archived', 'invalid_state', 'Creative is archived', 409);
    const rendition_ids = refs(input.rendition_ids, 'rendition_ids', 1);
    const assets = await Promise.all(rendition_ids.map(id => rendition(ctx, id, account.data.brand_id)));
    if (creative.data.origin === 'asset') check(assets.some(({ asset }) => asset.id === creative.data.origin_ref), 'scope_mismatch', 'Variant must use its source asset', 403);
    const locale = text(input, 'locale', 50);
    let normalizedLocale: string;
    try { [normalizedLocale] = Intl.getCanonicalLocales(locale); } catch { check(false, 'invalid_input', 'Invalid locale'); }
    const aspect_ratio = text(input, 'aspect_ratio', 20);
    check(/^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(aspect_ratio), 'invalid_input', 'Invalid aspect_ratio');
    const payload = { headline: text(input, 'headline', 300), primary_text: text(input, 'primary_text', 8000),
      cta: text(input, 'cta', 80), rendition_ids, aspect_ratio, locale: normalizedLocale };
    const content_hash = hash(payload);
    const id = hash(['creative_variant', creative.id, content_hash]);
    check(!(await ctx.get(ads, 'ad_creative_variant', id)), 'conflict', 'Identical creative variant already exists', 409);
    const variant = await ctx.insert(ads, 'ad_creative_variant', { ...payload, content_hash, creative_id: creative.id, ad_account_id: account.id,
      brand_id: account.data.brand_id, campaign_id: creative.data.campaign_id, created_by: ctx.actorId }, id);
    await ctx.emit('ads.creative.variant_created', eventData(ctx, variant));
    return variant;
  }),
  archive_creative: cmd(draft, async (ctx, input) => {
    const creative = await inputRow(ctx, 'ad_creative', input);
    await accountFor(ctx, creative, 'draft');
    expected(creative, input);
    check(creative.data.status !== 'archived', 'invalid_state', 'Creative is already archived', 409);
    const archived = await patch(ctx, creative, { status: 'archived', archived_by: ctx.actorId });
    await ctx.emit('ads.creative.archived', eventData(ctx, archived));
    return archived;
  }),
  list_creatives: cmd(read, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'read');
    const campaign = optional(input, 'campaign_id', 200);
    const creatives = (await ctx.list(ads, 'ad_creative')).filter(item => item.data.ad_account_id === account.id && (!campaign || item.data.campaign_id === campaign));
    const ids = new Set(creatives.map(item => item.id));
    const usage = (await ctx.list(ads, 'ad_creative_usage')).filter(item => item.data.ad_account_id === account.id);
    const variants = (await ctx.list(ads, 'ad_creative_variant')).filter(item => ids.has(item.data.creative_id))
      .map(item => ({ ...item, data: { ...item.data, usage_history: usage.filter(link => link.data.creative_variant_id === item.id).map(link => link.data.ad_entity_id) } }));
    return { items: creatives, variants };
  }),
};
