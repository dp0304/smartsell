import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';
import { checkAssetRights, invalidateTargets } from '../../../../../packages/domain/src/publishing/index.js';
import { fromAgent } from '../../agent-actor.js';
import { choose, hash, objects, str, strings } from './values.js';

export const grantKind = 'rights_grant';
const revisionKind = 'rights_grant_revision';
const linkKind = 'rights_grant_asset';
const grantTypes = ['owned', 'license', 'ugc_permission', 'creator_contract', 'stock', 'employee'];
const grantors = ['brand', 'creator', 'external_party', 'stock_provider', 'employee'];
const usages = ['organic_social', 'paid_ads', 'creator_whitelisting', 'website', 'email', 'marketplace_listing', 'offline'];
const liveStatuses = ['active', 'expiring'];
const by = (ctx: Context) => ({ created_by_type: fromAgent(ctx) ? 'agent' : 'user', created_by_id: ctx.actorId });

export function date(value: unknown, name: string) {
  const text = str(value, name);
  const time = Date.parse(text);
  if (!Number.isFinite(time)) throw new Problem(422, 'INVALID_INPUT', `Invalid ${name}`);
  return new Date(time).toISOString();
}
function termValues(ctx: Context, input: Data) {
  const valid_from = date(input.valid_from ?? ctx.now, 'valid_from');
  const valid_until = input.valid_until == null ? null : date(input.valid_until, 'valid_until');
  if (valid_until && valid_until <= valid_from) throw new Problem(422, 'INVALID_INPUT', 'valid_until must be after valid_from');
  const selectedUsages = strings(input.usages, 'usages').map(value => choose(value, 'usage', usages));
  if (!selectedUsages.length) throw new Problem(422, 'INVALID_INPUT', 'Select at least one usage');
  const allow_modification = input.allow_modification ?? false;
  const attribution_required = input.attribution_required ?? false;
  if (typeof allow_modification !== 'boolean' || typeof attribution_required !== 'boolean') throw new Problem(422, 'INVALID_INPUT', 'Invalid rights settings');
  const attribution_text = input.attribution_text == null ? null : str(input.attribution_text, 'attribution_text');
  if (attribution_required && !attribution_text) throw new Problem(422, 'INVALID_INPUT', 'Provide the required attribution text');
  return {
    usages: selectedUsages, valid_from, valid_until, allow_modification, attribution_required, attribution_text,
    platforms: input.platforms == null ? null : strings(input.platforms, 'platforms'),
    regions: input.regions == null ? null : strings(input.regions, 'regions').map(region => {
      if (!/^[a-z]{2}(-[a-z0-9]{1,3})?$/i.test(region)) throw new Problem(422, 'INVALID_INPUT', 'Invalid rights region');
      return region.toUpperCase();
    }),
    restrictions: input.restrictions == null ? null : str(input.restrictions, 'restrictions', 10_000),
    exclusivity: choose(input.exclusivity ?? 'none', 'exclusivity', ['none', 'category', 'full']),
    evidence_ids: strings(input.evidence_ids ?? [], 'evidence_ids'),
  };
}
function newRevision(ctx: Context, grant: Row, terms: ReturnType<typeof termValues>, confirmed: boolean) {
  const revision_no = ctx.list(revisionKind).filter(row => row.rights_grant_id === grant.id).reduce((max, row) => Math.max(max, Number(row.revision_no)), 0) + 1;
  return ctx.create(revisionKind, {
    rights_grant_id: grant.id, revision_no, ...terms, content_hash: hash(terms), ...by(ctx),
    confirmed_by: confirmed ? ctx.actorId : null, confirmed_at: confirmed ? ctx.now : null,
  });
}
export function createGrant(ctx: Context, body: Data) {
  const brand_id = ctx.get('brand', str(body.brand_id, 'brand_id')).id;
  const grant_type = choose(body.grant_type, 'grant_type', grantTypes);
  const grantor_kind = choose(body.grantor_kind ?? (grant_type === 'owned' ? 'brand' : 'external_party'), 'grantor_kind', grantors);
  if (grant_type === 'owned' && grantor_kind !== 'brand') throw new Problem(422, 'INVALID_INPUT', 'An owned grant must identify the brand as grantor');
  const expiring_notice_days = body.expiring_notice_days ?? 14;
  if (!Number.isSafeInteger(expiring_notice_days) || Number(expiring_notice_days) < 0 || Number(expiring_notice_days) > 365) throw new Problem(422, 'INVALID_INPUT', 'Invalid expiring_notice_days');
  const links = objects(body.assets ?? strings(body.asset_ids ?? [], 'asset_ids').map(asset_id => ({ asset_id })), 'assets').map(scope => {
    const asset = ctx.get('asset', str(scope.asset_id, 'asset_id'));
    if (asset.brand_id !== brand_id || asset.archived_at || asset.status === 'archived') throw new Problem(422, 'ASSET_UNAVAILABLE', 'Grant assets must be available in the same brand');
    if (grant_type === 'owned' && asset.origin !== 'upload') throw new Problem(422, 'INVALID_INPUT', 'Owned grants require brand uploads');
    const version_scope = choose(scope.version_scope ?? (scope.asset_version_id ? 'specific_version' : 'all_versions'), 'version_scope', ['all_versions', 'specific_version']);
    const version = version_scope === 'specific_version' ? ctx.get('asset_version', str(scope.asset_version_id, 'asset_version_id')) : null;
    if (version && version.asset_id !== asset.id) throw new Problem(422, 'ASSET_VERSION_MISMATCH', 'The version does not belong to this asset');
    if (!version && scope.asset_version_id != null) throw new Problem(422, 'INVALID_INPUT', 'asset_version_id requires specific_version scope');
    return { asset_id: asset.id, version_scope, asset_version_id: version?.id ?? null };
  });
  if (!links.length || links.length !== new Set(links.map(link => link.asset_id)).size) throw new Problem(422, 'INVALID_INPUT', 'Provide a non-empty list of unique assets');
  const terms = termValues(ctx, body);
  const grant = ctx.create(grantKind, { brand_id, grant_type, grantor_kind, grantor_ref: body.grantor_ref ?? null, expiring_notice_days, status: 'draft' });
  const revision = newRevision(ctx, grant, terms, false);
  for (const link of links) ctx.create(linkKind, { rights_grant_id: grant.id, ...link });
  return ctx.update(grantKind, grant.id, { current_revision_id: revision.id, pending_revision_id: revision.id, valid_from: terms.valid_from, valid_until: terms.valid_until });
}
export function reviseGrant(ctx: Context, id: string, body: Data) {
  const grant = ctx.get(grantKind, id);
  if (grant.status !== 'draft' && !liveStatuses.includes(String(grant.status))) throw new Problem(409, 'INVALID_GRANT_TRANSITION', 'This grant no longer accepts revisions');
  const current = ctx.get(revisionKind, String(grant.current_revision_id));
  const terms = termValues(ctx, { ...current, ...body });
  const revision = newRevision(ctx, grant, terms, false);
  if (grant.status === 'draft') ctx.update(grantKind, id, { current_revision_id: revision.id, pending_revision_id: revision.id, valid_from: terms.valid_from, valid_until: terms.valid_until });
  else ctx.update(grantKind, id, { pending_revision_id: revision.id });
  return revision;
}
export function activateGrant(ctx: Context, id: string, body: Data) {
  const grant = ctx.get(grantKind, id);
  if (grant.status !== 'draft' && !liveStatuses.includes(String(grant.status))) throw new Problem(409, 'INVALID_GRANT_TRANSITION', 'This grant cannot activate');
  const attached = ctx.list(revisionKind).filter(row => row.rights_grant_id === id).sort((a, b) => Number(b.revision_no) - Number(a.revision_no));
  const desired = body.revision_id == null ? attached[0] : attached.find(row => row.id === str(body.revision_id, 'revision_id'));
  if (!desired || desired.confirmed_at || desired.id === grant.active_revision_id || desired.id !== attached[0]?.id) throw new Problem(409, 'GRANT_DRAFT_REQUIRED', 'Confirm the latest unconfirmed terms');
  const terms = termValues(ctx, desired);
  if (terms.valid_until && terms.valid_until <= ctx.now) throw new Problem(422, 'GRANT_EXPIRED', 'Expired terms cannot activate');
  if (!terms.evidence_ids.length && grant.grant_type !== 'owned') throw new Problem(422, 'EVIDENCE_REQUIRED', 'An evidence record is required to activate these terms');
  for (const evidence_id of terms.evidence_ids) ctx.get('evidence', evidence_id);
  const revision = newRevision(ctx, grant, terms, true);
  const updated = ctx.update(grantKind, id, { status: 'active', current_revision_id: revision.id, active_revision_id: revision.id, pending_revision_id: null, valid_from: terms.valid_from, valid_until: terms.valid_until });
  ctx.emit(`asset.rights_grant.${grant.status === 'draft' ? 'activated' : 'revised'}`, { rights_grant_id: id, rights_grant_revision_id: revision.id, grant_version: revision.revision_no });
  if (grant.status !== 'draft') propagateLoss(ctx, updated, 'rights_revised');
  return updated;
}

export function renewGrant(ctx: Context, id: string, body: Data) {
  const grant = ctx.get(grantKind, id);
  if (!liveStatuses.includes(String(grant.status)) || typeof grant.valid_until !== 'string' || Date.parse(grant.valid_until) <= Date.parse(ctx.now)) throw new Problem(409, 'INVALID_GRANT_TRANSITION', 'Only an unexpired grant with an end date can be renewed');
  if (!Object.hasOwn(body, 'valid_until')) throw new Problem(422, 'INVALID_INPUT', 'Provide the extended valid_until');
  const until = body.valid_until === null ? null : date(body.valid_until, 'valid_until');
  if (until !== null && Date.parse(until) <= Date.parse(grant.valid_until)) throw new Problem(422, 'INVALID_INPUT', 'Renewal must extend the current term');
  const active = ctx.get(revisionKind, String(grant.active_revision_id));
  const revision = reviseGrant(ctx, id, { ...active, valid_until: until, evidence_ids: body.evidence_ids ?? active.evidence_ids });
  return activateGrant(ctx, id, { revision_id: revision.id });
}

function revMedia(ctx: Context, revision: Row, scopes: Row[]): Data[] {
  if (!Array.isArray(revision.media)) return [];
  const versions = new Map(ctx.list('asset_version').map(row => [row.id, row]));
  return (revision.media as Data[])
    .map<Data>(media => ({ ...media, asset_id: media.asset_id ?? versions.get(String(media.asset_version_id))?.asset_id }))
    .filter(media => scopes.some(scope => scope.asset_id === media.asset_id && (scope.version_scope !== 'specific_version' || scope.asset_version_id === media.asset_version_id)));
}
function losesRights(ctx: Context, revision: Row, scopes: Row[], platform: string, market: string | undefined, at: string) {
  const attribution = String((revision.rendered as Data | undefined)?.text ?? '');
  const marketRow = market && ctx.list('market').find(row => row.id === market);
  const region = marketRow ? String(marketRow.country_code ?? marketRow.region ?? marketRow.code ?? market) : market;
  return revMedia(ctx, revision, scopes).some(media => {
    const rendition = ctx.list('asset_rendition').find(row => row.id === media.rendition_id);
    return !checkAssetRights(ctx, String(media.asset_id), {
      platform, market: region, at, usage: 'organic_social', asset_version_id: String(media.asset_version_id),
      modified: Boolean(media.crop || rendition && ['crop', 'platform_resize', 'subtitle_burned'].includes(String(rendition.kind))), attribution,
    }).allowed;
  });
}
function propagateLoss(ctx: Context, grant: Row, reason: string) {
  const scopes = ctx.list(linkKind).filter(row => row.rights_grant_id === grant.id);
  const revisions = new Map(ctx.list('content_revision').map(row => [row.id, row]));
  const variants = new Map(ctx.list('content_variant').map(row => [row.id, row]));
  const accounts = new Map(ctx.list('social_account').map(row => [row.id, row]));
  for (const variant of variants.values()) {
    const revision = revisions.get(String(variant.current_revision_id));
    if (!revision || !losesRights(ctx, revision, scopes, String(variant.platform), typeof variant.market_id === 'string' ? variant.market_id : undefined, ctx.now)) continue;
    const old = Array.isArray(variant.stale_reasons) ? variant.stale_reasons as Data[] : [];
    const kind = reason === 'rights_revoked' ? 'rights_revoked' : reason === 'rights_revised' ? 'rights_revised' : 'rights_expired';
    if (variant.readiness === 'stale' && old.some(value => value.kind === kind && value.ref_id === grant.id)) continue;
    ctx.update('content_variant', variant.id, { readiness: 'stale', stale_reasons: [...old, { kind, ref_id: grant.id }] });
    ctx.emit('content.variant.readiness_changed', { content_variant_id: variant.id, readiness: 'stale', reason: kind, ref_id: grant.id });
  }
  invalidateTargets(ctx, target => {
    const revision = revisions.get(String(target.variant_revision_id));
    const variant = variants.get(String(target.content_variant_id));
    const platform = accounts.get(String(target.social_account_id))?.provider ?? variant?.platform;
    const market = variant?.market_id;
    const at = typeof target.scheduled_at === 'string' && Date.parse(target.scheduled_at) > Date.parse(ctx.now) ? target.scheduled_at : ctx.now;
    return Boolean(revision && losesRights(ctx, revision, scopes, String(platform), typeof market === 'string' ? market : undefined, at));
  }, reason);
  return { scopes, revisions, variants };
}
export function revokeGrant(ctx: Context, id: string, body: Data) {
  const grant = ctx.get(grantKind, id);
  if (!liveStatuses.includes(String(grant.status))) throw new Problem(409, 'INVALID_GRANT_TRANSITION', 'Only a live grant can be revoked');
  const revocation_effect = choose(body.revocation_effect, 'revocation_effect', ['stop_new_use', 'takedown_required']);
  const row = ctx.update(grantKind, id, { status: 'revoked', revoked_at: ctx.now, revocation_effect });
  propagateLoss(ctx, row, 'rights_revoked');
  const impact_ids = revocation_effect === 'takedown_required' ? recordImpact(ctx, id, 'takedown_required') : [];
  ctx.emit('asset.rights_grant.revoked', { rights_grant_id: id, revocation_effect, impact_ids });
  return row;
}
function recordImpact(ctx: Context, grantId: string, requiredAction: 'review' | 'takedown_required') {
  const targetIds = new Set(ctx.list('publish_target_ref')
    .filter(ref => ref.ref_type === 'rights_grant' && ref.ref_id === grantId)
    .map(ref => ref.publish_target_id ?? ref.target_id).filter(Boolean));
  for (const target of ctx.list('publish_target')) {
    const frozen = target.frozen as Data | undefined;
    if (Array.isArray(frozen?.asset_versions) && frozen.asset_versions.some(item => item?.grant_id === grantId)) targetIds.add(target.id);
  }
  const tasks = new Map(ctx.list('execution_task').map(task => [task.id, task]));
  const impacts = new Map(ctx.list('rights_impact').filter(row => row.rights_grant_id === grantId).map(row => [row.platform_post_id, row]));
  const impactIds = [];
  for (const post of ctx.list('platform_post')) {
    if (['deleted', 'removed_by_platform'].includes(String(post.post_status ?? post.status))) continue;
    const targetId = post.publish_target_id ?? post.target_id ?? tasks.get(String(post.execution_task_id))?.publish_target_id;
    if (!targetIds.has(targetId)) continue;
    const existing = impacts.get(post.id);
    const impact = existing ?? ctx.create('rights_impact', { rights_grant_id: grantId, platform_post_id: post.id, required_action: requiredAction, status: 'open' });
    if (requiredAction === 'takedown_required' && existing?.required_action !== requiredAction) {
      if (existing) ctx.update('rights_impact', existing.id, { required_action: requiredAction, status: 'open' });
      const work = ctx.create('work_item', { kind: 'rights_takedown', type: 'fix_task', priority: 'high', title: 'Review required rights takedown', status: 'open', subject_ref: { kind: 'platform_post', id: post.id }, rights_grant_id: grantId });
      ctx.emit('workspace.work_item.created', { work_item_id: work.id });
    }
    impactIds.push(impact.id);
  }
  return impactIds;
}
export function scanExpiry(ctx: Context) {
  const affected: Row[] = [];
  for (const grant of ctx.list(grantKind)) {
    if (!liveStatuses.includes(String(grant.status)) || typeof grant.valid_until !== 'string') continue;
    const remaining = Date.parse(grant.valid_until) - Date.parse(ctx.now);
    const status = remaining <= 0 ? 'expired' : remaining <= Number(grant.expiring_notice_days ?? 14) * 86_400_000 ? 'expiring' : 'active';
    if (status === grant.status) continue;
    const row = ctx.update(grantKind, grant.id, { status });
    const impact_ids = status === 'expired' ? recordImpact(ctx, grant.id, 'review') : [];
    ctx.emit(`asset.rights_grant.${status}`, { rights_grant_id: grant.id, valid_until: grant.valid_until, impact_ids });
    if (status === 'expired') propagateLoss(ctx, row, 'rights_expired');
    affected.push(row);
  }
  return { items: affected };
}
export function checkUsage(ctx: Context, body: Data) {
  const ids = strings(body.asset_ids, 'asset_ids');
  if (!ids.length) throw new Problem(422, 'INVALID_INPUT', 'Provide at least one asset');
  const purpose = str(body.usage ?? body.purpose, 'usage').toLowerCase();
  const usage = choose(purpose === 'organic' ? 'organic_social' : ['paid', 'paid_usage'].includes(purpose) ? 'paid_ads' : purpose, 'usage', usages);
  const platform = str(body.platform ?? 'generic', 'platform');
  const market = body.region == null && body.market == null && body.market_id == null ? undefined : str(body.region ?? body.market ?? body.market_id, 'region');
  const at = date(body.at ?? ctx.now, 'at');
  const modified = body.modification ?? body.modified ?? false;
  if (typeof modified !== 'boolean') throw new Problem(422, 'INVALID_INPUT', 'Invalid modification');
  const asset_version_id = body.asset_version_id == null ? undefined : str(body.asset_version_id, 'asset_version_id');
  const attribution = body.attribution == null ? undefined : str(body.attribution, 'attribution', 200_000);
  const assets = new Map(ctx.list('asset').map(row => [row.id, row]));
  const versions = new Map(ctx.list('asset_version').map(row => [row.id, row]));
  const files = new Map(ctx.list('file_object').map(row => [row.id, row]));
  const marketBrand = market && ctx.list('market').find(row => row.id === market)?.brand_id;
  return ids.map(asset_id => {
    const asset = assets.get(asset_id);
    const version = versions.get(String(asset_version_id ?? asset?.current_version_id));
    const file = version?.file_object_id == null ? undefined : files.get(String(version.file_object_id));
    if (!asset || asset.archived_at || asset.status === 'archived') return { asset_id, allowed: false, code: 'asset_unavailable' };
    if (!version || version.asset_id !== asset_id) return { asset_id, allowed: false, code: 'asset_version_not_found' };
    if (version.file_object_id != null && (!file || file.deleted_at || !['clean', 'skipped'].includes(String(file.scan_status)) || !['asset', 'import'].includes(String(file.purpose)))) {
      return { asset_id, allowed: false, code: 'file_unavailable' };
    }
    if (marketBrand && marketBrand !== asset.brand_id) return { asset_id, allowed: false, code: 'rights_not_covered' };
    return { asset_id, ...checkAssetRights(ctx, asset_id, { platform, market, usage, at, modified, asset_version_id: version.id, attribution }) };
  });
}
export function rightsDetail(ctx: Context, grant: Row) {
  return {
    ...grant,
    revisions: ctx.list(revisionKind).filter(row => row.rights_grant_id === grant.id).sort((a, b) => Number(b.revision_no) - Number(a.revision_no)),
    assets: ctx.list(linkKind).filter(row => row.rights_grant_id === grant.id),
  };
}
