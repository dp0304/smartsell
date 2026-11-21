import { readers, reviewers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { bool, conflict, emit, expectVersion, get, hash, insert, instant, integer, invalid, list, object, option, optional, strings, update } from './command-model.ts';

const dayMs = 86_400_000;
const live = ['active', 'expiring'];
const platformKey = (value: string) => value.toLowerCase().replace(/^meta_/, '');
const purposeKey = (value: string) => {
  const key = value.toLowerCase();
  return key === 'organic' ? 'organic_social' : ['paid', 'paid_usage'].includes(key) ? 'paid_ads' : key;
};

export interface UsageInput {
  asset_version_id: string;
  platform: string;
  market: string;
  purpose: string;
  at: string;
  modification?: boolean;
}

export interface UsageResult {
  allowed: boolean;
  reason?: string;
  valid_until?: string;
  grant_id?: string;
  grant_version?: number;
  warnings?: string[];
  attribution_text?: string;
  restrictions?: string;
}

export function terms(input: Fields) {
  const valid_from = instant(input.valid_from, 'valid_from');
  const valid_until = input.valid_until == null ? null : instant(input.valid_until, 'valid_until');
  if (valid_until && valid_until <= valid_from) invalid('valid_until must follow valid_from');
  const usages = strings(input.usages, 'usages').map(purposeKey);
  if (!usages.length) invalid('At least one usage is required');
  const attribution_required = bool(input, 'attribution_required', false);
  const attribution_text = optional(input, 'attribution_text');
  if (attribution_required && !attribution_text) invalid('Attribution text is required');
  return {
    usages,
    platforms: input.platforms == null ? null : strings(input.platforms, 'platforms').map(s => s.toLowerCase()),
    regions: input.regions == null ? null : strings(input.regions, 'regions').map(s => s.toUpperCase()),
    valid_from, valid_until, allow_modification: bool(input, 'allow_modification', false),
    attribution_required, attribution_text, restrictions: optional(input, 'restrictions'),
    exclusivity: input.exclusivity == null ? null : option(input, 'exclusivity', ['none', 'category', 'full']),
    evidence_ids: strings(input.evidence_ids ?? [], 'evidence_ids'),
  };
}

function readTerms(input: Fields) {
  return terms(input.terms === undefined ? input : object(input.terms, 'terms'));
}

async function newRevision(ctx: Context, grant: Entity, proposed: ReturnType<typeof terms>) {
  const revisionNo = (await list(ctx, 'rights_grant_revision')).filter(row => row.data.rights_grant_id === grant.id)
    .reduce((max, row) => Math.max(max, Number(row.data.revision_no)), 0) + 1;
  return insert(ctx, 'rights_grant_revision', { ...proposed, rights_grant_id: grant.id, revision_no: revisionNo, content_hash: hash(proposed), created_by_id: ctx.actorId });
}

async function createDraft(ctx: Context, input: Fields) {
  const brandId = text(input, 'brand_id', 256);
  if (!await ctx.get('workspace', 'brand', brandId)) invalid('Grant brand must exist in this workspace');
  const grantType = option(input, 'grant_type', ['owned', 'license', 'ugc_permission', 'creator_contract', 'stock', 'employee']);
  const grantorKind = option(input, 'grantor_kind', ['brand', 'creator', 'external_party', 'stock_provider', 'employee']);
  if (grantType === 'owned' && grantorKind !== 'brand') invalid('Owned grants must originate with the brand');
  const assets = input.assets ?? [{ asset_id: input.asset_id, asset_version_id: input.asset_version_id }];
  if (!Array.isArray(assets) || !assets.length || assets.length > 100) invalid('Provide between 1 and 100 covered assets');
  const coverage = new Map<string, Fields>();
  for (const item of assets) {
    const link = object(item, 'assets');
    const versionId = optional(link, 'asset_version_id', 256);
    const version = versionId ? await get(ctx, 'asset_version', versionId) : null;
    const assetId = link.asset_id === undefined && version ? version.data.asset_id : text(link, 'asset_id', 256);
    const asset = await get(ctx, 'asset', assetId);
    if (asset.data.status === 'archived' || asset.data.brand_id !== brandId || version && version.data.asset_id !== assetId) invalid('Covered assets and versions must belong to the grant brand and asset');
    if (grantType === 'owned' && asset.data.origin !== 'upload') invalid('Owned grants require brand uploads');
    const version_scope = version ? 'specific_version' : 'all_versions';
    if (link.version_scope !== undefined && link.version_scope !== version_scope) invalid('version_scope must agree with asset_version_id');
    if (coverage.has(assetId)) invalid('Each asset may be covered once per grant');
    coverage.set(assetId, { asset_id: assetId, asset_version_id: versionId, version_scope });
  }
  const proposed = readTerms(input);
  const grant = await insert(ctx, 'rights_grant', {
    brand_id: brandId, grant_type: grantType, grantor_kind: grantorKind,
    grantor_ref: input.grantor_ref == null ? null : object(input.grantor_ref, 'grantor_ref'),
    status: 'draft', current_revision_id: null, active_revision_id: null, pending_revision_id: null,
    expiring_notice_days: integer(input.expiring_notice_days ?? 14, 'expiring_notice_days', 0, 365),
  });
  for (const link of coverage.values()) await insert(ctx, 'rights_grant_asset', { ...link, rights_grant_id: grant.id });
  const revision = await newRevision(ctx, grant, proposed);
  return update(ctx, grant, { current_revision_id: revision.id, pending_revision_id: revision.id });
}

async function activate(ctx: Context, grant: Entity, revision: Entity) {
  const data = revision.data;
  if (data.rights_grant_id !== grant.id || revision.id === grant.data.active_revision_id) conflict('Review unconfirmed terms belonging to this grant');
  if (grant.data.grant_type !== 'owned' && !data.evidence_ids.length) invalid('Evidence is required to confirm this grant');
  for (const id of data.evidence_ids) if (!await ctx.get('core', 'evidence', id)) invalid('Grant evidence must exist in this workspace');
  const now = instant(ctx.now, 'now');
  if (data.valid_until && data.valid_until <= now) conflict('Cannot activate elapsed terms');
  const event = grant.data.status === 'draft' ? 'activated' : 'revised';
  await insert(ctx, 'rights_grant_confirmation', { rights_grant_id: grant.id, revision_id: revision.id, confirmed_by: ctx.actorId, confirmed_at: now });
  const updated = await update(ctx, grant, {
    status: 'active', current_revision_id: revision.id, active_revision_id: revision.id, pending_revision_id: null,
    valid_from: data.valid_from, valid_until: data.valid_until, confirmed_by: ctx.actorId, confirmed_at: now,
  });
  await emit(ctx, `rights_grant.${event}`, { rights_grant_id: grant.id, grant_version: data.revision_no, valid_until: data.valid_until });
  return updated;
}

/**
 * Evaluate an exact, immutable asset version at the scheduled or execution instant.
 * @example
 * const rights = await checkUsage(ctx, {
 *   asset_version_id, platform: 'instagram', market: 'US',
 *   purpose: 'organic_social', at: scheduled_at,
 * });
 * // If allowed, persist rights.grant_id and rights.grant_version with the approval.
 */
export async function checkUsage(ctx: Context, input: UsageInput): Promise<UsageResult> {
  const at = instant(input.at, 'at');
  const platform = platformKey(text(input, 'platform', 256));
  const marketId = text(input, 'market', 256);
  const market = marketId.toUpperCase();
  const purpose = purposeKey(text(input, 'purpose', 256));
  const modification = bool(input, 'modification', false);
  const version = await ctx.get('asset', 'asset_version', text(input, 'asset_version_id', 256));
  if (!version) return { allowed: false, reason: 'asset_version_not_found' };
  const asset = await ctx.get('asset', 'asset', version.data.asset_id);
  if (!asset) return { allowed: false, reason: 'asset_not_found' };
  if (asset.data.archived_at || asset.data.status === 'archived') return { allowed: false, reason: 'asset_unavailable' };
  // Metadata-only legacy imports have no file binding. A bound file must still be available.
  if (version.data.file_object_id != null) {
    const file = await ctx.get('core', 'file_object', version.data.file_object_id);
    if (!file || file.data.deleted_at || !['clean', 'skipped'].includes(file.data.scan_status) || !['asset', 'import'].includes(file.data.purpose)) {
      return { allowed: false, reason: 'file_unavailable' };
    }
  }
  const marketRecord = await ctx.get('workspace', 'market', marketId);
  if (marketRecord?.data.brand_id && marketRecord.data.brand_id !== asset.data.brand_id) return { allowed: false, reason: 'region_not_covered' };
  const country = typeof marketRecord?.data.country_code === 'string' ? marketRecord.data.country_code.toUpperCase() : market;
  const grants = new Set((await list(ctx, 'rights_grant_asset')).filter(link => link.data.asset_id === asset.id &&
    (link.data.version_scope === 'all_versions' || link.data.version_scope === 'specific_version' && link.data.asset_version_id === version.id))
    .map(link => link.data.rights_grant_id));
  const candidates = (await list(ctx, 'rights_grant')).filter(grant => grants.has(grant.id) && grant.data.brand_id === asset.data.brand_id &&
    [...live, 'expired', 'revoked', 'superseded'].includes(grant.data.status)).sort((a, b) =>
    (b.data.valid_until ?? '￿').localeCompare(a.data.valid_until ?? '￿') || a.id.localeCompare(b.id));
  let reason = 'no_grant';
  let bestScore = -1;
  for (const grant of candidates) {
    const revisionId = grant.data.active_revision_id ?? grant.data.current_revision_id;
    const revision = revisionId ? await ctx.get('asset', 'rights_grant_revision', revisionId) : undefined;
    if (!revision || revision.data.rights_grant_id !== grant.id) continue;
    const scope = revision.data;
    const from = Date.parse(scope.valid_from);
    const until = scope.valid_until == null ? Infinity : Date.parse(scope.valid_until);
    const when = Date.parse(at);
    const checks: [boolean, string][] = [
      [Array.isArray(scope.usages) && scope.usages.some((value: unknown) => typeof value === 'string' && purposeKey(value) === purpose), 'usage_not_covered'],
      [scope.platforms == null || Array.isArray(scope.platforms) && scope.platforms.some((value: unknown) => typeof value === 'string' && platformKey(value) === platform), 'platform_not_covered'],
      [scope.regions == null || Array.isArray(scope.regions) && scope.regions.some((value: unknown) => typeof value === 'string' && [market, country].includes(value.toUpperCase())), 'region_not_covered'],
      [!modification || scope.allow_modification === true, 'modification_not_allowed'],
      [from <= when, 'not_yet_valid'],
      [when < until, 'expired'],
      [grant.data.status !== 'revoked' || when < Date.parse(grant.data.revoked_at), 'revoked'],
      [grant.data.status !== 'superseded' || when < Date.parse(grant.data.superseded_at), 'superseded'],
    ];
    const failed = checks.findIndex(([passed]) => !passed);
    if (failed !== -1) {
      if (failed > bestScore) [bestScore, reason] = [failed, checks[failed][1]];
      continue;
    }
    const warnings = [];
    if (until - when <= (grant.data.expiring_notice_days ?? 14) * dayMs) warnings.push('expiring_within_days');
    if (scope.attribution_required) warnings.push('attribution_required');
    if (scope.restrictions) warnings.push('review_restrictions');
    return { allowed: true, grant_id: grant.id, grant_version: scope.revision_no,
      ...(scope.valid_until ? { valid_until: scope.valid_until } : {}),
      ...(scope.attribution_required ? { attribution_text: scope.attribution_text } : {}),
      ...(scope.restrictions ? { restrictions: scope.restrictions } : {}), ...(warnings.length ? { warnings } : {}) };
  }
  return { allowed: false, reason };
}

async function recordImpact(ctx: Context, rights_grant_id: string, required_action: 'review' | 'takedown_required') {
  const refs = (await ctx.list('planning', 'publish_target_ref')).filter(ref => ref.data.ref_type === 'rights_grant' && ref.data.ref_id === rights_grant_id);
  const targets = new Set(refs.map(ref => ref.data.publish_target_id ?? ref.data.target_id).filter(Boolean));
  for (const target of await ctx.list('planning', 'publish_target')) {
    const snapshots = target.data.frozen?.asset_versions;
    if (Array.isArray(snapshots) && snapshots.some(snapshot => snapshot.grant_id === rights_grant_id)) targets.add(target.id);
  }
  const existing = new Map((await list(ctx, 'rights_impact')).filter(row => row.data.rights_grant_id === rights_grant_id).map(row => [row.data.platform_post_id, row]));
  const tasks = new Map((await ctx.list('execution', 'execution_task')).map(row => [row.id, row]));
  const ids = [];
  for (const post of await ctx.list('execution', 'platform_post')) {
    const targetId = post.data.publish_target_id ?? post.data.target_id ?? tasks.get(post.data.execution_task_id)?.data.publish_target_id;
    if (!targets.has(targetId) || ['deleted', 'removed_by_platform'].includes(post.data.post_status ?? post.data.status)) continue;
    const impact = existing.get(post.id) ?? await insert(ctx, 'rights_impact', { rights_grant_id, platform_post_id: post.id, required_action, status: 'open' });
    if (required_action === 'takedown_required' && existing.get(post.id)?.data.required_action !== required_action) {
      if (impact.data.required_action !== required_action) await update(ctx, impact, { required_action, status: 'open' });
      const work = await ctx.insert('workspace', 'work_item', { kind: 'rights_takedown', type: 'fix_task', priority: 'high', title: 'Review required rights takedown', status: 'open', subject_ref: { kind: 'platform_post', id: post.id }, rights_grant_id });
      await ctx.emit('workspace.work_item.created', { work_item_id: work.id });
    }
    ids.push(impact.id);
  }
  return ids;
}

export const rightsCommands: Commands = {
  asset_check_usage: { roles: readers, async run(ctx, input) {
    if (input.asset_ids !== undefined) {
      const ids = strings(input.asset_ids, 'asset_ids');
      if (!ids.length) invalid('Provide at least one asset');
      return Promise.all(ids.map(async asset_id => {
        const asset = await ctx.get('asset', 'asset', asset_id);
        const version = asset?.data.current_version_id;
        const exact = version && await ctx.get('asset', 'asset_version', version);
        const result = exact && exact.data.asset_id === asset_id ? await checkUsage(ctx, {
          asset_version_id: version, platform: input.platform ?? 'generic', market: input.market ?? input.region ?? 'unknown',
          purpose: input.purpose ?? input.usage, at: input.at ?? ctx.now, modification: input.modification,
        }) : { allowed: false, reason: 'asset_version_not_found' };
        return { asset_id, ...result };
      }));
    }
    if (input.asset_version_ids === undefined) return checkUsage(ctx, input as UsageInput);
    const ids = strings(input.asset_version_ids, 'asset_version_ids');
    if (!ids.length) invalid('Provide at least one asset version');
    return Promise.all(ids.map(async id => ({ asset_version_id: id, ...await checkUsage(ctx, { ...input, asset_version_id: id } as UsageInput) })));
  } },
  rights_create_draft: { roles: writers, run: createDraft },
  rights_list: { roles: readers, async run(ctx, input) {
    return (await list(ctx, 'rights_grant')).filter(row => (!input.brand_id || row.data.brand_id === input.brand_id) && (!input.status || row.data.status === input.status));
  } },
  rights_add_revision: { roles: writers, async run(ctx, input) {
    const grant = await get(ctx, 'rights_grant', text(input, 'rights_grant_id', 256));
    expectVersion(grant, input);
    if (!['draft', ...live].includes(grant.data.status)) conflict('Grant cannot be revised');
    const revision = await newRevision(ctx, grant, readTerms(input));
    await update(ctx, grant, { pending_revision_id: revision.id, ...(grant.data.status === 'draft' ? { current_revision_id: revision.id } : {}) });
    return revision;
  } },
  rights_activate: { roles: reviewers, async run(ctx, input) {
    const grant = await get(ctx, 'rights_grant', text(input, 'rights_grant_id', 256));
    expectVersion(grant, input);
    if (!['draft', ...live].includes(grant.data.status) || !grant.data.pending_revision_id) conflict('No proposed terms to activate');
    const id = text(input, 'revision_id', 256);
    if (id !== grant.data.pending_revision_id) conflict('Review the current grant revision before activation');
    return activate(ctx, grant, await get(ctx, 'rights_grant_revision', id));
  } },
  rights_renew: { roles: reviewers, async run(ctx, input) {
    const grant = await get(ctx, 'rights_grant', text(input, 'rights_grant_id', 256));
    expectVersion(grant, input);
    if (!live.includes(grant.data.status) || !grant.data.valid_until || grant.data.valid_until <= instant(ctx.now, 'now')) conflict('Only an unexpired term with an end date can be renewed');
    const approved = await get(ctx, 'rights_grant_revision', grant.data.active_revision_id);
    const renewed = terms({ ...approved.data, valid_until: input.valid_until, evidence_ids: input.evidence_ids ?? approved.data.evidence_ids });
    if (!Object.hasOwn(input, 'valid_until') || renewed.valid_until && renewed.valid_until <= grant.data.valid_until) invalid('Renewal must extend valid_until');
    return activate(ctx, grant, await newRevision(ctx, grant, renewed));
  } },
  rights_revoke: { roles: reviewers, async run(ctx, input) {
    const grant = await get(ctx, 'rights_grant', text(input, 'rights_grant_id', 256));
    expectVersion(grant, input);
    if (!live.includes(grant.data.status)) conflict('Only an active grant can be revoked');
    const effect = option(input, 'revocation_effect', ['stop_new_use', 'takedown_required']) as 'stop_new_use' | 'takedown_required';
    const updated = await update(ctx, grant, { status: 'revoked', revoked_at: instant(ctx.now, 'now'), revocation_effect: effect });
    const impact_ids = effect === 'takedown_required' ? await recordImpact(ctx, grant.id, effect) : [];
    await emit(ctx, 'rights_grant.revoked', { rights_grant_id: grant.id, revocation_effect: effect, impact_ids });
    return updated;
  } },
  rights_expiry_scan: { roles: reviewers, async run(ctx) {
    const now = instant(ctx.now, 'now');
    const expired: string[] = [];
    const expiring: string[] = [];
    for (const grant of await list(ctx, 'rights_grant')) {
      const until = grant.data.valid_until;
      if (!live.includes(grant.data.status) || !until) continue;
      if (until <= now) {
        await update(ctx, grant, { status: 'expired' });
        const impact_ids = await recordImpact(ctx, grant.id, 'review');
        await emit(ctx, 'rights_grant.expired', { rights_grant_id: grant.id, valid_until: until, impact_ids });
        expired.push(grant.id);
      } else if (grant.data.status === 'active' && Date.parse(until) - Date.parse(now) <= (grant.data.expiring_notice_days ?? 14) * dayMs) {
        await update(ctx, grant, { status: 'expiring' });
        await emit(ctx, 'rights_grant.expiring', { rights_grant_id: grant.id, valid_until: until });
        expiring.push(grant.id);
      }
    }
    return { expired, expiring };
  } },
  rights_resolve_impact: { roles: reviewers, async run(ctx, input) {
    const impact = await get(ctx, 'rights_impact', text(input, 'impact_id', 256));
    expectVersion(impact, input);
    if (impact.data.status !== 'open') conflict('Only open impact records can be resolved');
    return update(ctx, impact, { status: 'resolved', resolution: text(input, 'resolution'), resolved_by: ctx.actorId, resolved_at: ctx.now });
  } },
};
