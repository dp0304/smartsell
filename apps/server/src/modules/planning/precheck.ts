import type { Context, Entity, Fields } from '../types.ts';
import { checkUsage } from '../asset/index.ts';
import { kinds as contentKinds } from '../content/model.ts';
import { accountPlatform as platformOfAccount, validate as validateContent } from '../content/validation.ts';
import { APPROVAL, PAUSE, PRECHECK, PROFILE, TARGET, activeTarget, addMinutes, emit, hash, insert, list, nonempty, object } from './model.ts';

export type Stage = 'schedule' | 'approval' | 'preflight' | 'execution';
export type Blocker = { code: string; message: string };
interface Issue extends Blocker { repair: string }

export async function accountFor(ctx: Context, id: string) {
  const [account, profile] = await Promise.all([ctx.get('account', 'social_account', id), ctx.get('planning', PROFILE, id)]);
  return { account, profile, timezone: account?.data.default_timezone ?? profile?.data.timezone };
}

export async function inspect(ctx: Context, target: Entity, stage: Stage) {
  const d = target.data;
  const blockers: Issue[] = [];
  const risks: Issue[] = [];
  const block = (code: string, message: string, repair: string) => blockers.push({ code, message, repair });
  const risk = (code: string, message: string, repair: string) => risks.push({ code, message, repair });
  const [variant, { account, profile }, pauses] = await Promise.all([
    ctx.get('content', 'content_variant', d.content_variant_id), accountFor(ctx, d.account_id), list(ctx, PAUSE),
  ]);
  const v = variant?.data;
  const revision = v && nonempty(v.current_revision_id) ? await ctx.get('content', contentKinds.revision, v.current_revision_id) : undefined;
  const r = revision?.data;
  const platform = r?.platform ?? v?.platform;
  const market = r?.market ?? v?.market ?? r?.market_id ?? v?.market_id;
  const format = r?.format ?? v?.format;
  const authorId = r?.author_id ?? r?.created_by;
  const body = nonempty(r?.body) ? r.body : r?.rendered?.text ?? r?.body_doc ?? r?.body;
  const assets = r?.asset_version_ids ?? (Array.isArray(r?.media) ? [...new Set(r.media.map((item: Fields) => item.asset_version_id))] : undefined);
  const item = nonempty(v?.content_item_id) ? (await ctx.get('content', 'content_item', v.content_item_id))?.data : undefined;
  const campaignId = r?.campaign_id ?? v?.campaign_id ?? item?.campaign_id;
  const brandId = r?.brand_id ?? v?.brand_id ?? item?.brand_id;
  const p = profile?.data;
  const platformProvider = account?.data.provider ?? account?.data.platform ?? p?.platform;
  const accountPlatform = account ? platformOfAccount(account) : p?.platform;
  const accountIdentity = account?.data.external_account_id ?? account?.data.platform_account_id ?? account?.data.account_identity ?? p?.account_identity ?? null;
  const at = stage === 'preflight' || stage === 'execution' ? ctx.now : d.scheduled_at;
  const when = Date.parse(d.scheduled_at);
  const dedupedAssets = Array.isArray(assets) && assets.every(nonempty) && new Set(assets).size === assets.length ? assets as string[] : undefined;

  if (v?.archived_at || v?.status === 'archived' || item?.archived_at || item?.production_stage === 'archived' || (v?.content_item_id && !item)) {
    block('content_unavailable', 'The content item or variant is archived or unavailable.', 'content');
  }
  if (!variant || !r || !revision || (r.variant_id ?? r.content_variant_id ?? variant.id) !== variant.id || (d.revision_id && d.revision_id !== revision.id)) {
    block('revision_changed', 'The target must use the current content revision.', 'content');
  }
  if (!nonempty(platform) || !nonempty(market) || !nonempty(format) || !nonempty(authorId) || !dedupedAssets ||
    (!nonempty(body) && !object(body) && !dedupedAssets?.length)) {
    block('invalid_content', 'The revision needs valid content, platform, market, format, author and asset references.', 'content');
  }
  if (!Number.isFinite(when) || ((stage === 'schedule' || stage === 'approval') && when <= Date.parse(ctx.now))) {
    block('invalid_schedule', 'Choose a future scheduled time.', 'schedule');
  }
  if (!p || p.active !== true || (p.linked_account && !account) || (account && account.data.status !== 'active')) {
    block('account_unavailable', 'The account needs an active publishing profile and must be active.', 'account');
  }
  if (accountPlatform !== platform || (p && accountPlatform !== p.platform) || (v?.social_account_id && v.social_account_id !== d.account_id) ||
    (brandId && account?.data.brand_id && account.data.brand_id !== brandId)) {
    block('account_mismatch', 'The account does not match the content platform, brand, or assigned account.', 'account');
  }
  if (d.route === 'official') {
    if (p?.official_capability !== true || !nonempty(p.adapter_key) || !Number.isSafeInteger(p.quota_limit) || p.quota_limit < 1) {
      block('capability_unavailable', 'Official publishing requires an enabled capability, adapter and positive quota.', 'account');
    }
    if (!nonempty(accountIdentity)) block('account_identity_required', 'Verify the account identity before official publishing.', 'account');
    if (p?.connection_expires_at && Date.parse(p.connection_expires_at) <= Date.parse(at)) {
      block('connection_expired', 'The publishing connection has expired.', 'account');
    }
    if (!account) block('account_unavailable', 'Register the social account before official publishing.', 'account');
    else {
      const links = (await ctx.list('account', 'social_account_connection')).filter(link => link.data.social_account_id === account.id);
      const connections = await Promise.all(links.map(link => ctx.get('account', 'connection', link.data.connection_id)));
      if (!connections.some(connection => {
        const c = connection?.data;
        return c?.status === 'active' && c.purpose === 'social' && c.provider === platformProvider &&
          Date.parse(c.expires_at) > Date.parse(at) && Array.isArray(c.external_account_ids) && c.external_account_ids.includes(accountIdentity);
      })) block('connection_unavailable', 'Official publishing requires an active provider connection for this account.', 'account');
    }
  } else if (d.route === 'manual') {
    if (p?.manual_capability !== true) block('capability_unavailable', 'Manual publishing is disabled for this account.', 'account');
    else risk('manual_route', 'A person must publish and record the result.', 'execution');
  } else block('invalid_route', 'Select an official or manual route.', 'account');
  if (Array.isArray(p?.formats) && !p.formats.includes(format)) block('media_format_unsupported', 'The selected format is unavailable on this account.', 'content');
  if (Array.isArray(p?.markets) && !p.markets.includes(market)) block('unsupported_market', 'This account does not publish in the target market.', 'account');
  if (Array.isArray(p?.visibilities) && !p.visibilities.includes(d.visibility)) block('visibility_unavailable', 'The selected visibility is unavailable for this account.', 'target');
  if (pauses.some(row => row.data.active === true && (row.data.scope === 'workspace' ||
    (row.data.scope === 'account' && row.data.scope_id === d.account_id) || (row.data.scope === 'campaign' && row.data.scope_id === campaignId) ||
    (row.data.scope === 'brand' && row.data.scope_id === brandId)))) block('publishing_paused', 'Publishing is paused for this target.', 'pause');

  if (campaignId) {
    const c = (await ctx.get('campaign', 'campaign', campaignId))?.data;
    if (!c || c.status !== 'active') block('campaign_inactive', 'The linked campaign must be active.', 'campaign');
    else {
      const starts = c.starts_at != null ? Date.parse(c.starts_at) : -Infinity;
      const ends = c.ends_at != null ? Date.parse(c.ends_at) : Infinity;
      const effective = stage === 'execution' ? Date.parse(ctx.now) : when;
      if (Number.isNaN(starts) || Number.isNaN(ends) || !(when >= starts && when < ends && effective >= starts && effective < ends)) {
        block('campaign_outside_window', 'Publishing falls outside the campaign window.', 'campaign');
      }
    }
  }

  if (r && nonempty(platform) && nonempty(format) && dedupedAssets) {
    const validation = await validateContent(ctx, { ...v, platform, format, market, social_account_id: account ? d.account_id : null }, {
      ...r, body: typeof body === 'string' ? body : '', body_doc: r.body_doc ?? (object(body) ? body : null),
      media: r.media ?? dedupedAssets.map(asset_version_id => ({ asset_version_id })), settings: r.settings ?? {}, product_refs: r.product_refs ?? [],
    }, account ? [d.account_id] : [], d.scheduled_at);
    for (const issue of validation.issues) {
      // Planning evaluates the exact asset versions through the rights facade at its stage-specific instant.
      if (issue.code === 'asset_rights_denied') continue;
      const add = issue.severity === 'blocking' ? block : risk;
      add(issue.code, issue.field ? `Review ${issue.field} (${issue.code}).` : `Review ${issue.code}.`, 'content');
    }
  }
  const assetSnapshots: Fields[] = [];
  if (dedupedAssets?.length && nonempty(platform) && nonempty(market) && Number.isFinite(Date.parse(at))) {
    for (const id of dedupedAssets) {
      const version = await ctx.get('asset', 'asset_version', id);
      if (!version) { block('asset_unavailable', `Asset version ${id} is unavailable.`, 'asset'); continue; }
      const asset = await ctx.get('asset', 'asset', version.data.asset_id);
      if (!asset || asset.data.status !== 'ready' || (brandId && asset.data.brand_id !== brandId)) {
        block('asset_unavailable', `Asset version ${id} is unavailable for this brand.`, 'asset');
        continue;
      }
      const modification = Array.isArray(r?.media) && r.media.some((item: Fields) => item.asset_version_id === id && item.crop != null);
      const result = await checkUsage(ctx, { asset_version_id: id, platform, market, purpose: 'organic', at, modification });
      if (!result.allowed) block('asset_rights_denied', `Asset version ${id} is unavailable for this use (${result.reason ?? 'rights'}).`, 'asset');
      if (result.attribution_text && (typeof body !== 'string' || !body.includes(result.attribution_text))) {
        block('asset_attribution_required', `Include the required credit for asset version ${id}.`, 'content');
      }
      for (const warning of result.warnings ?? []) risk(warning, `Review terms for asset version ${id}.`, 'asset');
      assetSnapshots.push({ id, sha256: version.data.sha256 ?? version.data.content_hash ?? null,
        grant_id: result.grant_id ?? null, grant_version: result.grant_version ?? null });
    }
  }
  const renditions: Fields[] = [];
  for (const id of new Set<string>((Array.isArray(r?.media) ? r.media : []).flatMap((media: Fields) => [media.rendition_id, media.caption_rendition_id]).filter(nonempty))) {
    const rendition = await ctx.get('asset', 'asset_rendition', id);
    if (!rendition) block('rendition_unavailable', `Asset rendition ${id} is unavailable.`, 'asset');
    else renditions.push({ id, sha256: rendition.data.sha256 ?? rendition.data.content_hash ?? null });
  }
  const productSnapshots: Fields[] = [];
  for (const ref of Array.isArray(r?.product_refs) ? r.product_refs : []) {
    if (nonempty(ref.listing_snapshot_id)) {
      const snapshot = (await ctx.get('commerce', 'listing_snapshot', ref.listing_snapshot_id))?.data;
      if (snapshot) productSnapshots.push({ id: ref.listing_snapshot_id, sha256: hash(snapshot) });
      if (!snapshot || snapshot.is_current !== true || snapshot.is_estimate === true || snapshot.price_source === 'fx_estimate' ||
        ['out_of_stock', 'sold_out', 'discontinued', 'unavailable'].includes(snapshot.stock_status) || snapshot.market_id !== (ref.market_id ?? market)) {
        block('listing_snapshot_invalid', `Listing snapshot ${ref.listing_snapshot_id} must be refreshed and reviewed.`, 'commerce');
      }
    }
    if (nonempty(ref.fact_revision_id)) {
      const factRevision = (await ctx.get('commerce', 'product_fact_revision', ref.fact_revision_id))?.data;
      const fact = nonempty(factRevision?.fact_id) ? (await ctx.get('commerce', 'product_fact', factRevision.fact_id))?.data : undefined;
      if (!fact || fact.status !== 'active' || fact.approved_revision_id !== ref.fact_revision_id) {
        block('product_fact_invalid', `Product fact revision ${ref.fact_revision_id} is no longer approved.`, 'commerce');
      }
    }
  }
  if (stage === 'schedule' || stage === 'approval') {
    for (const other of await list(ctx, TARGET)) {
      if (other.id === target.id || !activeTarget(other) || other.data.account_id !== d.account_id) continue;
      const diff = Math.abs(Date.parse(other.data.scheduled_at) - when);
      if (diff === 0 && other.data.content_variant_id === d.content_variant_id) block('duplicate_target', `Target ${other.id} already plans this variant at this time.`, 'schedule');
      else if (diff <= 15 * 60_000) risk('time_conflict', `Target ${other.id} is scheduled on this account within 15 minutes.`, 'schedule');
    }
  }
  const frozen: Fields | null = revision && r && dedupedAssets ? {
    target_id: target.id, account_id: d.account_id, account_identity: accountIdentity, platform, platform_provider: platformProvider, route: d.route,
    ...(d.route === 'official' ? { adapter_key: p?.adapter_key, quota_limit: p?.quota_limit } : {}),
    revision: { id: revision.id, body, format, platform, market, author_id: authorId, asset_version_ids: dedupedAssets,
      content_hash: r.content_hash ?? null, media: r.media ?? [], settings: r.settings ?? {}, product_refs: r.product_refs ?? [], link_refs: r.link_refs ?? [] },
    content_variant_id: d.content_variant_id, campaign_id: campaignId ?? null, brand_id: brandId ?? null,
    asset_versions: assetSnapshots, renditions, product_snapshots: productSnapshots, visibility: d.visibility, options: d.options,
    purpose: 'organic', scheduled_at: d.scheduled_at, schedule_tz: d.schedule_tz,
  } : null;
  return { stage, checked_at: ctx.now, valid_until: addMinutes(ctx.now, 5), blockers, risks, frozen };
}

export async function saveCheck(ctx: Context, target: Entity, result: Awaited<ReturnType<typeof inspect>>) {
  const { frozen, ...rest } = result;
  const check = await insert(ctx, PRECHECK, { target_id: target.id, target_version: target.version, ...rest });
  await emit(ctx, 'precheck.completed', { target_id: target.id, precheck_id: check.id, stage: result.stage, blockers: result.blockers.length });
  return check;
}

export async function checkExecution(ctx: Context, target: Entity): Promise<{ blockers: Blocker[] }> {
  const blockers: Blocker[] = [];
  const { frozen, frozen_hash, approval_id, status } = target.data;
  if (target.module !== 'planning' || target.kind !== TARGET || target.tenant_id !== ctx.tenantId || target.workspace_id !== ctx.workspaceId || status !== 'scheduled') {
    return { blockers: [{ code: 'target_not_scheduled', message: 'The scoped target must be scheduled.' }] };
  }
  if (!object(frozen) || !nonempty(frozen_hash) || hash(frozen) !== frozen_hash) {
    return { blockers: [{ code: 'frozen_hash_invalid', message: 'The target payload does not match its frozen hash.' }] };
  }
  const approval = nonempty(approval_id) ? await ctx.get('planning', APPROVAL, approval_id) : undefined;
  if (!approval || approval.data.target_id !== target.id || approval.data.status !== 'approved' || approval.data.frozen_hash !== frozen_hash) {
    blockers.push({ code: 'approval_invalid', message: 'The target lacks an approval for this frozen payload.' });
  }
  const current = await inspect(ctx, target, 'execution');
  blockers.push(...current.blockers.map(({ code, message }) => ({ code, message })));
  if (!current.frozen || hash(current.frozen) !== frozen_hash) blockers.push({ code: 'frozen_payload_changed', message: 'Current publishing inputs differ from the approved snapshot.' });
  return { blockers };
}
