import { ADMIN, APPROVE, READ, WRITE, Problem, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { conflict, dto, flag, hash, instant, integer, invalid, oneOf, optional, strings, text, unavailable, zone } from '../lifecycle/dto.js';
import { asData } from '../ingest/ingest-input.js';
import { nativeDay } from '../ingest/model.js';
import { requireHuman } from '../../agent-actor.js';
import { DomainError } from '../types.js';
import { permissions } from './accounts.js';
import { activeAccountGrant } from './domain.js';
import { unsupportedAdFields } from './proposals.js';

const author = [...WRITE, 'analyst'] as const;
const operators = ['owner','admin','manager'] as const;
const id = (input: Input, name: string) => text(input.params.id ?? input.body[name], name);
const rows = (ctx: Context, kind: string, field: string, value: unknown) => ctx.list(kind).filter(r => r[field] === value);
const accountActions: Record<string, string> = {
  ads_submit_proposal: 'review', ads_decide_proposal: 'approve', ads_decide_adjustment: 'approve',
  ads_export_proposal: 'export', ads_execute_operation: 'execute', ads_record_manual_operation: 'execute',
  ads_reconcile_operation: 'reconcile',
};
const accountChildren = new Set(['ad_entity', 'ad_proposal', 'ad_operation', 'adjustment_suggestion']);
function accountScope(ctx: Context, action: string): Context {
  if (ADMIN.includes(ctx.role)) return ctx;
  const accounts = ctx.list('ad_account').filter(row => {
    const grant = activeAccountGrant(row.permissions, ctx.actorId, ctx.now);
    return grant?.actions.includes('read') && grant.actions.includes(action);
  });
  const accountIds = new Set(accounts.map(row => row.id));
  const brands = new Set(accounts.map(row => row.brand_id));
  const visible = (kind: string, row: Row) => {
    if (kind === 'ad_account') return accountIds.has(row.id);
    if (accountChildren.has(kind)) return accountIds.has(String(row.ad_account_id));
    if (kind === 'ad_creative') return row.ad_account_id ? accountIds.has(String(row.ad_account_id)) : brands.has(row.brand_id);
    if (kind === 'ad_creative_variant') return visible('ad_creative', ctx.get('ad_creative', String(row.creative_id)));
    if (kind === 'budget_line') return accountIds.has(String(row.ad_account_id));
    return true;
  };
  return { ...ctx,
    list: kind => ctx.list(kind).filter(row => visible(kind, row)),
    get(kind, id) {
      const row = ctx.get(kind, id);
      if (!visible(kind, row)) throw new Problem(404, 'NOT_FOUND', 'Advertising resource not found');
      return row;
    },
  };
}
const shape = (path: string, method: Operation['method'], name: string, roles: Operation['roles'], summary: string,
  run: Operation['run'], versionKind?: string, external?: boolean): Operation => ({ path, method, name, roles, summary,
  scopeContext(ctx, { params, body }) {
    const scope = accountScope(ctx, accountActions[name] ?? (method === 'GET' ? 'read' : 'draft'));
    if (scope === ctx || method === 'GET') return scope;
    if (versionKind && params.id) scope.get(versionKind, params.id);
    if (name === 'ads_create_proposal') scope.get('ad_account', text(body.ad_account_id, 'ad_account_id'));
    if (name === 'ads_suggest_adjustments') scope.get('ad_entity', text(body.target_entity_id, 'target_entity_id'));
    if (name === 'ads_create_creative') requireDraftBrand(scope, body.brand_id);
    return scope;
  }, run, versionKind, external });
const actionKinds = ['create_external_draft','launch','pause','resume','update_budget','update_creative'] as const;
const revisionFields = ['objective','product_variant_ids','market_ids','audience_spec','placements','schedule','budget','creative_variant_ids','estimates','change','platform_options'];

function unsupported(account: Row, revision: Data) {
  return unsupportedAdFields(String(account.provider), String(revision.objective),
    strings(revision.placements, 'placements'), asData(revision.platform_options));
}
function currency(value: unknown) {
  const code = text(value, 'currency');
  if (!/^[A-Z]{3}$/.test(code)) invalid('Invalid currency');
  return code;
}
function capabilities(ctx: Context, account: Row) {
  const connection = ctx.list('connection').find(r => r.id === account.connection_id);
  const unexpired = (row: Row) => row.expires_at == null || Date.parse(String(row.expires_at)) > Date.parse(ctx.now);
  const active = connection && connection.status === 'active' && connection.provider === account.provider &&
    connection.brand_id === account.brand_id && ['ads','advertising'].includes(String(connection.purpose)) && unexpired(connection) &&
    (connection.external_account_id == null || connection.external_account_id === account.external_account_id);
  const supports = (keys: string[]) => !!active && ctx.list('capability').some(r => r.connection_id === account.connection_id &&
    r.social_account_id == null && unexpired(r) && (r.external_account_id == null || r.external_account_id === account.external_account_id) &&
    (r.status === 'available' || r.state === 'available') && keys.includes(String(r.key ?? r.capability_key)));
  return { read_capability: supports(['ads_read','ads.report.read']) ? 'available' : 'unavailable',
    write_capability: supports(['ads_write','ads.operation.write']) ? 'available' : 'unavailable' };
}
function accountValues(ctx: Context, fields: Data) {
  const provider = text(fields.provider, 'provider');
  if (!/^[a-z][a-z0-9_]*_ads$/.test(provider)) invalid('Expected an advertising provider');
  const brand_id = text(fields.brand_id, 'brand_id');
  const connection_id = optional(fields.connection_id, 'connection_id');
  if (connection_id) {
    const connection = ctx.get('connection', connection_id);
    if (connection.provider !== provider || connection.brand_id !== brand_id || !['ads','advertising'].includes(String(connection.purpose))) {
      unavailable('A dedicated advertising connection for this brand and provider is required');
    }
  }
  return { provider, brand_id, connection_id, external_account_id: text(fields.external_account_id, 'external_account_id'),
    currency: currency(fields.currency), timezone: zone(fields.timezone),
    spend_cap_snapshot: fields.spend_cap_snapshot === undefined ? undefined : integer(fields.spend_cap_snapshot, 'spend_cap_snapshot', 1),
  };
}
function requireDraftBrand(ctx: Context, brandId: unknown) {
  if (!ctx.list('ad_account').some(row => row.brand_id === brandId)) {
    throw new Problem(404, 'NOT_FOUND', 'Advertising brand not found');
  }
}
function campaignBrand(ctx: Context, campaign: unknown, brand: unknown) {
  const campaignId = optional(campaign, 'campaign_id');
  if (campaignId && ctx.get('campaign', campaignId).brand_id !== brand) invalid('Campaign belongs to another brand');
  return campaignId;
}
function creatorMaterial(ctx: Context, variantId: string, renditionId: string) {
  const variant = ctx.get('ad_creative_variant', variantId);
  if (ctx.get('ad_creative', String(variant.creative_id)).origin === 'deliverable') return true;
  const rendition = ctx.get('asset_rendition', renditionId);
  const version = ctx.list('asset_version').find(row => row.id === rendition.asset_version_id);
  const asset = ctx.get('asset', String(rendition.asset_id ?? version?.asset_id));
  return ['ugc', 'creator_delivery'].includes(String(asset.origin));
}
function rights(ctx: Context, account: Row, revision: Row) {
  const schedule = revision.schedule as { starts_at: string; ends_at: string };
  const markets = strings(revision.market_ids, 'market_ids');
  const grants = ctx.list('rights_grant');
  const revisions = ctx.list('rights_grant_revision');
  const links = ctx.list('rights_grant_asset');
  return strings(revision.creative_variant_ids, 'creative_variant_ids').flatMap(variantId => {
    const variant = ctx.get('ad_creative_variant', variantId);
    const creative = ctx.get('ad_creative', String(variant.creative_id));
    if (creative.brand_id !== account.brand_id || creative.status === 'archived') invalid('Creative is unavailable for this brand');
    return strings(variant.rendition_ids, 'rendition_ids').flatMap(renditionId => {
      const rendition = ctx.get('asset_rendition', renditionId);
      const version = ctx.list('asset_version').find(r => r.id === rendition.asset_version_id);
      const assetId = rendition.asset_id ?? version?.asset_id;
      const asset = ctx.list('asset').find(r => r.id === assetId);
      if (!asset || asset.brand_id !== account.brand_id || asset.status === 'archived' || asset.archived_at) invalid('Rendition is unavailable for this brand');
      return (creative.creator_identity_required ? ['paid_ads','creator_whitelisting'] : ['paid_ads']).filter(usage => !grants.some(grant => {
        if (grant.brand_id !== account.brand_id || !['active','expiring'].includes(String(grant.status))) return false;
        if (!links.some(link => link.rights_grant_id === grant.id && link.asset_id === assetId &&
          (link.version_scope === 'all_versions' || link.asset_version_id === rendition.asset_version_id))) return false;
        const terms = revisions.find(r => r.id === grant.current_revision_id && r.rights_grant_id === grant.id);
        if (!terms || !Array.isArray(terms.usages) || !terms.usages.includes(usage)) return false;
        const platform = String(account.provider).replace(/_ads$/, '');
        const start = Date.parse(String(terms.valid_from));
        const end = terms.valid_until == null ? Infinity : Date.parse(String(terms.valid_until));
        return start <= Date.parse(schedule.starts_at) && end >= Date.parse(schedule.ends_at) && end > Date.parse(ctx.now) &&
          (!Array.isArray(terms.platforms) || terms.platforms.includes(platform) || terms.platforms.includes(account.provider)) &&
          (!Array.isArray(terms.regions) || markets.every(market => {
            const region = ctx.list('market').find(row => row.id === market)?.country_code ?? market;
            return (terms.regions as unknown[]).includes(region);
          })) &&
          (!['crop','platform_resize','subtitle_burned'].includes(String(rendition.kind)) || terms.allow_modification === true) &&
          terms.attribution_required !== true && !terms.restrictions;
      })).map(usage => ({ variant_id: variantId, rendition_id: renditionId, missing_usage: usage }));
    });
  });
}
function appendRevision(ctx: Context, proposal: Row, body: Data) {
  dto(body, revisionFields);
  const account = ctx.get('ad_account', String(proposal.ad_account_id));
  const rawBudget = dto(body.budget, ['type','amount_minor','currency','cap_minor']);
  const budget = { type: oneOf(rawBudget.type, ['daily','lifetime'], 'budget type'), amount_minor: integer(rawBudget.amount_minor, 'amount_minor', 1),
    currency: currency(rawBudget.currency), cap_minor: integer(rawBudget.cap_minor, 'cap_minor', 1) };
  if (budget.currency !== account.currency || budget.amount_minor > budget.cap_minor ||
      (typeof account.spend_cap_snapshot === 'number' && budget.cap_minor > account.spend_cap_snapshot)) invalid('Budget violates account currency or spend limit');
  const rawSchedule = dto(body.schedule, ['starts_at','ends_at','tz']);
  const schedule = { starts_at: instant(rawSchedule.starts_at, 'starts_at'), ends_at: instant(rawSchedule.ends_at, 'ends_at'), tz: zone(rawSchedule.tz ?? account.timezone) };
  if (schedule.starts_at >= schedule.ends_at) invalid('Invalid schedule interval');
  const rawAudience = dto(body.audience_spec ?? {}, ['description','languages','countries']);
  const audience_spec = { description: optional(rawAudience.description, 'description'), languages: strings(rawAudience.languages, 'languages'), countries: strings(rawAudience.countries, 'countries') };
  const rawChange = dto(body.change ?? {kind:'create_external_draft'}, ['kind','target_entity_id']);
  const change = { kind: oneOf(rawChange.kind, actionKinds, 'change kind'), target_entity_id: optional(rawChange.target_entity_id, 'target_entity_id') };
  let target_external_id: string | undefined;
  if (change.target_entity_id) {
    const target = ctx.get('ad_entity', change.target_entity_id);
    if (target.ad_account_id !== account.id || change.kind === 'create_external_draft') invalid('Change target does not match the selected account and action');
    target_external_id = text(target.external_id, 'target external ID');
  } else if (change.kind !== 'create_external_draft') invalid('Change requires an existing advertising entity');
  const creative_variant_ids = strings(body.creative_variant_ids, 'creative_variant_ids');
  const market_ids = strings(body.market_ids, 'market_ids');
  if (change.kind !== 'pause' && (!creative_variant_ids.length || !market_ids.length)) invalid('Change requires creative variants and target markets');
  const estimates = body.estimates === undefined ? [] : body.estimates;
  if (!Array.isArray(estimates) || estimates.length > 100) invalid('Invalid estimates');
  const objective = text(body.objective, 'objective');
  const placements = strings(body.placements, 'placements');
  const values = { objective, product_variant_ids: strings(body.product_variant_ids, 'product_variant_ids'), market_ids, audience_spec, placements,
    schedule, budget, creative_variant_ids, change: { ...change, target_external_id }, estimates: estimates.map(value => {
      const entry = dto(value, ['metric','value','source']);
      if (typeof entry.value !== 'number' || !Number.isFinite(entry.value) || entry.value < 0) invalid('Invalid estimate value');
      return { metric: text(entry.metric, 'metric'), value: entry.value, source: text(entry.source, 'source'), estimate: true };
    }), platform_options: dto(body.platform_options ?? {}, Object.keys(asData(body.platform_options))),
    platform_validation: 'unverified' };
  const checked = { ...values, unsupported_fields: unsupported(account, values) };
  const revision = ctx.create('ad_proposal_revision', { proposal_id: proposal.id,
    revision_no: rows(ctx, 'ad_proposal_revision', 'proposal_id', proposal.id).length + 1, ...checked, content_hash: hash(checked) });
  const missing = rights(ctx, account, revision);
  if (missing.some(item => creatorMaterial(ctx, item.variant_id, item.rendition_id))) {
    throw new Problem(409, 'RIGHTS_UNAVAILABLE', 'Paid advertising rights do not cover the selected creator material');
  }
  if (proposal.approval_request_id) {
    const request = ctx.get('ad_approval_request', String(proposal.approval_request_id));
    ctx.update('ad_approval_request', request.id, { status: 'superseded' });
  }
  return ctx.update('ad_proposal', proposal.id, { current_revision_id: revision.id, approval_request_id: null, status: 'draft' });
}
function current(ctx: Context, proposal: Row) {
  return ctx.get('ad_proposal_revision', String(proposal.current_revision_id));
}
function approved(ctx: Context, proposal: Row) {
  const revision = current(ctx, proposal);
  if (!['approved','exported'].includes(String(proposal.status)) || !proposal.approval_request_id) conflict('Approved revision required');
  const request = ctx.get('ad_approval_request', String(proposal.approval_request_id));
  if (request.status !== 'approved' || request.revision_id !== revision.id || request.revision_hash !== revision.content_hash) conflict('Approval does not match the current revision');
  return revision;
}
function gate(ctx: Context, proposal: Row, revision: Row) {
  const account = ctx.get('ad_account', String(proposal.ad_account_id));
  if (account.brand_id !== proposal.brand_id) conflict('Advertising account brand changed');
  const {cap_minor, currency: budgetCurrency} = revision.budget as {cap_minor: number; currency: string};
  if (budgetCurrency !== account.currency || (typeof account.spend_cap_snapshot === 'number' && cap_minor > account.spend_cap_snapshot)) conflict('Current account spend limit or currency blocks this change');
  const change = revision.change as { kind: string; target_entity_id?: string; target_external_id?: string };
  if (change.target_entity_id) {
    const target = ctx.get('ad_entity', change.target_entity_id);
    if (target.ad_account_id !== account.id || target.external_id !== change.target_external_id) conflict('Approved advertising target changed');
  }
  if (rights(ctx, account, revision).length) throw new Problem(409, 'RIGHTS_UNAVAILABLE', 'Paid advertising rights do not cover every selected asset');
  if (change.kind !== 'pause' && unsupported(account, revision).length) {
    throw new Problem(409, 'UNSUPPORTED_AD_FIELDS', 'Remove unsupported advertising fields before submitting or applying this revision');
  }
  return account;
}
const metaId = /^[1-9]\d{0,19}$/;
export function metaPauseTarget(ctx: Context, account: Row, targetId: unknown) {
  const connection = ctx.list('connection').find(row => row.id === account.connection_id);
  const target = typeof targetId === 'string' ? ctx.get('ad_entity', targetId) : undefined;
  const accountId = String(account.external_account_id).replace(/^act_/, '');
  if (account.provider !== 'meta_ads' || !connection?.sealed_token || !target || target.ad_account_id !== account.id ||
      target.level !== 'campaign' || !metaId.test(accountId) || !metaId.test(String(target.external_id))) {
    unavailable('A connected Meta advertising campaign is required for official pause and readback');
  }
  return { connection, accountId, externalId: String(target.external_id) };
}

export function authorizeMetaPause(ctx: Context, operation: Row, write: boolean) {
  const account = ctx.get('ad_account', String(operation.ad_account_id));
  const capabilitiesNow = capabilities(ctx, account);
  if (capabilitiesNow.read_capability !== 'available' || (write && capabilitiesNow.write_capability !== 'available')) unavailable('Advertising platform permission unavailable');
  if (write) {
    const proposal = ctx.get('ad_proposal', String(operation.proposal_id));
    const actorId = String(operation.requested_by);
    const lookup = (ctx as Context & { workspaceMemberRole?(id: string): Context['role'] | undefined }).workspaceMemberRole;
    const role = lookup ? lookup(actorId) : operation.requested_role as Context['role'];
    if (!role || !operators.includes(role as typeof operators[number])) unavailable('Advertising operator no longer has permission');
    const caller = accountScope({ ...ctx, actorId, role }, 'execute');
    caller.get('ad_account', account.id);
    const revision = approved(ctx, proposal);
    if (revision.id !== operation.proposal_revision_id || proposal.approval_request_id !== operation.approval_request_id) conflict('Approved advertising revision changed');
    gate(ctx, proposal, revision);
  }
  const target = metaPauseTarget(ctx, account, operation.target_entity_id);
  if (target.externalId !== operation.target_external_id) conflict('Advertising target changed');
  return target;
}

function variant(ctx: Context, creative: Row, body: Data) {
  dto(body, ['headline','primary_text','cta','rendition_ids','aspect_ratio','locale']);
  if (creative.status === 'archived') conflict('Creative is archived');
  const rendition_ids = strings(body.rendition_ids, 'rendition_ids');
  if (!rendition_ids.length) invalid('Creative requires at least one rendition');
  for (const renditionId of rendition_ids) {
    const rendition = ctx.get('asset_rendition', renditionId);
    const version = ctx.list('asset_version').find(r => r.id === rendition.asset_version_id);
    const assetId = rendition.asset_id ?? version?.asset_id;
    if (ctx.get('asset', text(assetId, 'asset_id')).brand_id !== creative.brand_id) invalid('Rendition belongs to another brand');
  }
  const values = { headline: text(body.headline, 'headline'), primary_text: text(body.primary_text, 'primary_text'), cta: optional(body.cta, 'cta'),
    rendition_ids, aspect_ratio: optional(body.aspect_ratio, 'aspect_ratio'), locale: text(body.locale, 'locale') };
  return ctx.create('ad_creative_variant', { creative_id: creative.id, ...values, content_hash: hash(values) });
}

export const operations: Operation[] = [
  shape('/ad-accounts','GET','ads_list_accounts',READ,'List ad account and capability references',ctx => ctx.list('ad_account').map(r => {
    const { permissions: grants, ...account } = r;
    return { ...account, ...(ADMIN.includes(ctx.role) && { permissions: grants ?? [] }), ...capabilities(ctx, r) };
  })),
  shape('/ad-accounts','POST','ads_register_account',ADMIN,'Register a dedicated or import-only ad account', (ctx, {body}) => {
    dto(body, ['provider','brand_id','external_account_id','connection_id','currency','timezone','spend_cap_snapshot']);
    const values = accountValues(ctx, body);
    if (ctx.list('ad_account').some(r => r.provider === values.provider && r.external_account_id === values.external_account_id)) conflict('Advertising account already registered');
    const row = ctx.create('ad_account', values);
    if (row.connection_id) ctx.emit('ads.account.connected', { ad_account_id: row.id });
    return { ...row, ...capabilities(ctx, row) };
  }),
  shape('/ad-accounts/:id','PATCH','ads_update_account',ADMIN,'Update connection and spend cap references', (ctx, input) => {
    dto(input.body, ['connection_id','spend_cap_snapshot','permissions']);
    const account = ctx.get('ad_account', id(input, 'ad_account_id'));
    const values = accountValues(ctx, { ...account, ...input.body });
    let grants: Data = {};
    if (input.body.permissions !== undefined) {
      // Grants decide who may approve or spend on this account; an admin's Agent may edit the account but not its approvers.
      requireHuman(ctx, 'Changing ad account permissions');
      try { grants = { permissions: permissions(input.body.permissions, ctx.now) }; }
      catch (error) { if (error instanceof DomainError) invalid(error.message); throw error; }
    }
    const row = ctx.update('ad_account', account.id, { ...values, ...grants });
    if (grants.permissions) ctx.emit('ads.account.permissions_changed', { ad_account_id: row.id, actor_id: ctx.actorId });
    ctx.emit('ads.account.capability_changed', { ad_account_id: row.id, ...capabilities(ctx, row) });
    return { ...row, ...capabilities(ctx, row) };
  }, 'ad_account'),
  shape('/ad-accounts/:id/import','POST','ads_import_report',ADMIN,'Import advertising structure and observations', (ctx, input) => importReport(ctx, input)),
  shape('/ad-entities','GET','ads_list_entities',READ,'List observed advertising structure', (ctx, {query}) => ctx.list('ad_entity').filter(r =>
    (!query.ad_account_id || r.ad_account_id === query.ad_account_id) && (!query.campaign_id || r.campaign_id === query.campaign_id))),
  shape('/ads/performance','GET','ads_query_performance',READ,'Read advertising observations and budget pacing', (ctx, input) => performance(ctx, input)),
  shape('/ad-creatives','GET','ads_list_creatives',READ,'List advertising creative references',ctx => ctx.list('ad_creative')),
  shape('/ad-creatives','POST','ads_create_creative',author,'Create an ad creative and optional immutable variant', (ctx, {body}) => {
    dto(body, ['brand_id','campaign_id','origin','origin_ref','creator_identity_required','variant']);
    const brand_id = text(body.brand_id, 'brand_id');
    const origin = oneOf(body.origin, ['platform_post','deliverable','asset','new'], 'origin');
    const origin_ref = optional(body.origin_ref, 'origin_ref');
    if (origin !== 'new' && !origin_ref) invalid('Creative source reference required');
    const creative = ctx.create('ad_creative', { brand_id, campaign_id: campaignBrand(ctx, body.campaign_id, brand_id), origin, origin_ref,
      creator_identity_required: flag(body.creator_identity_required, 'creator_identity_required'), status: 'draft' });
    return { ...creative, variant: body.variant === undefined ? undefined : variant(ctx, creative, body.variant as Data), rights_check: 'requires_target_market_and_schedule' };
  }),
  shape('/ad-creatives/:id/variants','GET','ads_list_creative_variants',READ,'List creative variants and observed usage', (ctx, input) => {
    const creative = ctx.get('ad_creative', id(input, 'creative_id'));
    return rows(ctx,'ad_creative_variant','creative_id',creative.id).map(r => ({ ...r, usage_history: rows(ctx,'ad_entity','ad_creative_variant_id',r.id).map(x => x.id) }));
  }),
  shape('/ad-creatives/:id/variants','POST','ads_create_creative_variant',author,'Append an immutable ad creative variant', (ctx, input) => variant(ctx, ctx.get('ad_creative', id(input,'creative_id')), input.body), 'ad_creative'),
  shape('/ad-creatives/:id','DELETE','ads_archive_creative',author,'Archive a creative and retain variant history', (ctx,input) => {
    dto(input.body, []);
    return ctx.update('ad_creative', id(input,'creative_id'), {status:'archived'});
  }, 'ad_creative'),
  shape('/ad-proposals','GET','ads_list_proposals',READ,'List advertising proposals', (ctx, {query}) => ctx.list('ad_proposal').filter(row =>
    (!query.ad_account_id || row.ad_account_id === query.ad_account_id) && (!query.campaign_id || row.campaign_id === query.campaign_id))),
  shape('/ad-proposals','POST','ads_create_proposal',author,'Create an immutable advertising change proposal revision', (ctx, {body}) => {
    dto(body, ['ad_account_id','campaign_id','experiment_id','name','revision']);
    const account = ctx.get('ad_account', text(body.ad_account_id,'ad_account_id'));
    const experiment_id = optional(body.experiment_id, 'experiment_id');
    if (experiment_id && ctx.get('experiment',experiment_id).brand_id !== account.brand_id) invalid('Experiment belongs to another brand');
    const proposal = ctx.create('ad_proposal', { ad_account_id: account.id, brand_id: account.brand_id,
      campaign_id: campaignBrand(ctx,body.campaign_id,account.brand_id), experiment_id, name: optional(body.name, 'name'), status:'draft' });
    return appendRevision(ctx, proposal, dto(body.revision, revisionFields));
  }),
  shape('/ad-proposals/:id','GET','ads_get_proposal',READ,'Get proposal with revision and approval history', (ctx,input) => {
    const p = ctx.get('ad_proposal',id(input,'proposal_id'));
    const revision = current(ctx, p);
    const account = ctx.get('ad_account', String(p.ad_account_id));
    return { ...p, revisions: rows(ctx,'ad_proposal_revision','proposal_id',p.id), approvals: rows(ctx,'ad_approval_request','proposal_id',p.id),
      operations: rows(ctx, 'ad_operation', 'proposal_id', p.id).map(({ idempotency_key: _key, ...row }) => row),
      preview: { planned_budget: revision.budget, estimates: revision.estimates, actual_spend_minor: null,
        unsupported_fields: unsupported(account, revision) } };
  }),
  shape('/ad-proposals/:id/revisions','POST','ads_revise_proposal',author,'Append a revision and invalidate earlier approval', (ctx,input) =>
    appendRevision(ctx,ctx.get('ad_proposal',id(input,'proposal_id')),input.body), 'ad_proposal'),
  shape('/ad-proposals/:id/submit-approval','POST','ads_submit_proposal',author,'Submit the current revision for approval', (ctx,input) => {
    dto(input.body, []);
    const p = ctx.get('ad_proposal',id(input,'proposal_id'));
    if (p.status !== 'draft') conflict('Only draft proposals can enter review');
    const revision = current(ctx,p);
    gate(ctx,p,revision);
    const request = ctx.create('ad_approval_request',{ proposal_id:p.id, revision_id:revision.id, revision_hash:revision.content_hash, status:'pending', submitted_by:ctx.actorId });
    ctx.emit('ads.proposal.submitted',{ proposal_id:p.id, revision_id:revision.id, approval_request_id:request.id });
    return ctx.update('ad_proposal',p.id,{ status:'in_review', approval_request_id:request.id });
  }, 'ad_proposal'),
  shape('/ad-proposals/:id/decide','POST','ads_decide_proposal',APPROVE,'Approve or reject the submitted revision', (ctx,input) => {
    dto(input.body,['decision','reason']);
    const status = oneOf(input.body.decision,['approved','rejected'],'decision');
    const reason = optional(input.body.reason,'reason');
    const p = ctx.get('ad_proposal',id(input,'proposal_id'));
    if (p.status !== 'in_review') conflict('Proposal is not in review');
    const revision = current(ctx,p);
    const request = ctx.get('ad_approval_request',String(p.approval_request_id));
    if (request.status !== 'pending' || request.revision_id !== revision.id || request.revision_hash !== revision.content_hash) conflict('Review does not match the current revision');
    if (status === 'approved') gate(ctx,p,revision);
    ctx.update('ad_approval_request',request.id,{ status, reason, decided_by:ctx.actorId, decided_at:ctx.now });
    ctx.emit(`ads.proposal.${status}`,{ proposal_id:p.id, revision_id:revision.id, approval_request_id:request.id });
    return ctx.update('ad_proposal',p.id,{status});
  }, 'ad_proposal'),
  shape('/ad-proposals/:id/export','POST','ads_export_proposal',author,'Export a revision-bound manual operation package', (ctx,input) => {
    dto(input.body,[]);
    const p = ctx.get('ad_proposal',id(input,'proposal_id'));
    const revision = approved(ctx,p);
    gate(ctx,p,revision);
    if (p.status !== 'exported') ctx.update('ad_proposal',p.id,{status:'exported'});
    return { mode:'manual', proposal_id:p.id, revision, approval_request_id:p.approval_request_id,
      checklist:['Confirm provider supports the objective, placements and settings','Verify account, rights, creative and spend cap before applying','Record provider review and delivery results independently'] };
  }, 'ad_proposal'),
  shape('/ad-proposals/:id/operations','POST','ads_execute_operation',operators,'Validate an approved operation and require an advertising adapter', (ctx,input) => {
    dto(input.body,['proposal_revision_id','kind']);
    const p = ctx.get('ad_proposal',id(input,'proposal_id'));
    const revision = approved(ctx,p);
    const kind = oneOf(input.body.kind,actionKinds,'kind');
    const change = revision.change as {kind:string};
    if (input.body.proposal_revision_id !== revision.id || kind !== change.kind) conflict('Operation differs from approved change');
    const account = gate(ctx,p,revision);
    if (!input.idempotencyKey) invalid('Idempotency-Key is required');
    const previous = rows(ctx,'ad_operation','idempotency_key',input.idempotencyKey)[0];
    if (previous) {
      if (previous.proposal_revision_id !== revision.id || previous.kind !== kind || previous.status === 'manual') conflict('Idempotency key already used for a different change');
      return previous;
    }
    if (capabilities(ctx,account).write_capability !== 'available') unavailable('Advertising write capability unavailable');
    if (kind !== 'pause' || account.provider !== 'meta_ads') unavailable('Official adapter is unavailable for this advertising action');
    const existing = rows(ctx, 'ad_operation', 'proposal_revision_id', revision.id).find(row => row.kind === kind && row.status !== 'manual');
    if (existing) return existing;
    if (capabilities(ctx,account).read_capability !== 'available') unavailable('Advertising readback capability unavailable');
    const targetId = (revision.change as Data).target_entity_id;
    const target = metaPauseTarget(ctx, account, targetId);
    const operation = ctx.create('ad_operation', { proposal_id: p.id, proposal_revision_id: revision.id,
      approval_request_id: p.approval_request_id, ad_account_id: account.id, kind, target_entity_id: targetId,
      target_external_id: target.externalId, status: 'queued', currency: account.currency, idempotency_key: input.idempotencyKey,
      requested_by: ctx.actorId, requested_role: ctx.role });
    ctx.emit('ads.operation.queued', { operation_id: operation.id });
    return operation;
  }, 'ad_proposal', true),
  shape('/ad-proposals/:id/manual-operations','POST','ads_record_manual_operation',operators,'Record an approved manual handoff with no provider execution', (ctx,input) => {
    dto(input.body, []);
    const proposal = ctx.get('ad_proposal',id(input,'proposal_id'));
    const revision = approved(ctx,proposal);
    const account = gate(ctx,proposal,revision);
    if (!input.idempotencyKey) invalid('Idempotency-Key is required');
    const change = revision.change as {kind:string; target_entity_id?:string};
    const target = change.target_entity_id ? ctx.get('ad_entity',change.target_entity_id) : undefined;
    if (target && (target.ad_account_id !== account.id || typeof target.external_id !== 'string')) conflict('Manual change requires a verified target reference');
    const previous = rows(ctx,'ad_operation','idempotency_key',input.idempotencyKey)[0];
    if (previous) {
      if (previous.proposal_revision_id !== revision.id || previous.status !== 'manual') conflict('Idempotency key already used for a different handoff');
      return previous;
    }
    const client_reference = `smartsell-${hash([ctx.workspaceId,revision.id,input.idempotencyKey]).slice(0,24)}`;
    const row = ctx.create('ad_operation',{ proposal_revision_id:revision.id, approval_request_id:proposal.approval_request_id,
      ad_account_id:account.id, kind:change.kind, target_entity_id:target?.id, target_external_id:target?.external_id,
      status:'manual', client_reference, idempotency_key:input.idempotencyKey, currency:account.currency, provider_verification:'unavailable' });
    ctx.emit('ads.operation.manual_requested',{ ad_operation_id:row.id, proposal_revision_id:revision.id });
    return row;
  }, 'ad_proposal'),
  shape('/ad-operations/:id','GET','ads_get_operation',READ,'Read an advertising operation and its observed attempts', (ctx,input) => {
    const op = ctx.get('ad_operation',id(input,'ad_operation_id'));
    return { ...op, attempts: rows(ctx,'ad_operation_attempt','operation_id',op.id) };
  }),
  shape('/ad-operations/:id/reconcile','POST','ads_reconcile_operation',operators,'Require an adapter for operation readback and reconciliation', (ctx,input) => {
    dto(input.body,[]);
    const operation = ctx.get('ad_operation',id(input,'ad_operation_id'));
    if (operation.kind !== 'pause' || operation.status === 'manual') unavailable('Advertising reconciliation adapter unavailable');
    authorizeMetaPause(ctx, operation, false);
    if (operation.status === 'verified') return operation;
    if (!['accepted', 'outcome_unknown', 'sending', 'observing'].includes(String(operation.status))) conflict('Operation is not ready for readback');
    return ctx.update('ad_operation', operation.id, { readback_requested: true });
  }, 'ad_operation', true),
  shape('/adjustment-suggestions','GET','ads_list_adjustments',READ,'List evidence-backed advertising adjustments', (ctx, {query}) => {
    const observations = new Map(ctx.list('metric_observation').map(row => [row.id, row]));
    return ctx.list('adjustment_suggestion')
      .filter(row => !query.ad_account_id || row.ad_account_id === query.ad_account_id)
      .map(row => adjustmentDetails(row, observations));
  }),
  shape('/adjustment-suggestions','POST','ads_suggest_adjustments',author,'Record a reviewable advertising adjustment with evidence', (ctx,{body}) => suggest(ctx,body)),
  shape('/adjustment-suggestions/:id/decide','POST','ads_decide_adjustment',APPROVE,'Decide an adjustment and create a new draft revision', (ctx,input) => decideSuggestion(ctx,input), 'adjustment_suggestion'),
];

const metrics = ['spend','impressions','clicks','conversions'] as const;

export function prepareAdSpendReport(ctx: Context, batch: Row, input: Data, source: Data) {
  if (!ADMIN.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Advertising reports require account administration');
  const account = ctx.get('ad_account', text(batch.ad_account_id, 'ad_account_id'));
  const dataSource = batch.data_source_id ? ctx.get('data_source', String(batch.data_source_id)) : undefined;
  if ((dataSource?.ad_account_id && dataSource.ad_account_id !== account.id) ||
      (batch.provider && batch.provider !== 'file_import' && batch.provider !== account.provider)) invalid('Import source does not match the advertising account');
  const timezone = zone(account.timezone);
  const importZone = asData(batch.options).timezone;
  if (importZone && zone(importZone) !== timezone) invalid('Report timezone must match the advertising account');
  const externalId = text(input.external_ad_id, 'external_ad_id');
  const entities = ctx.list('ad_entity').filter(row => row.ad_account_id === account.id && row.level === 'ad' && row.external_id === externalId);
  if (entities.length !== 1) throw new Problem(422, 'UNKNOWN_AD_ENTITY', 'Register a unique matching ad under the selected account');
  const [entity] = entities;
  const code = currency(input.currency);
  if (code !== account.currency) invalid('Report currency must match the advertising account');
  const value = integer(input.amount_minor, 'amount_minor');
  const date = reportDay(input.report_day ?? localDay(instant(input.report_date, 'report_date'), timezone));
  let bounds: [number, number];
  try { bounds = nativeDay(date, timezone); }
  catch (error) { if (error instanceof DomainError) invalid(error.message); throw error; }
  const [start, end] = bounds;
  if (start > Date.parse(ctx.now)) invalid('Report date cannot be in the future');
  const previous = ctx.list('metric_observation').find(row => row.subject_type === 'ads.ad_entity' && row.subject_id === entity.id &&
    row.native_date === date && row.metric_key === 'ads.spend' && asData(row.source).method === 'import' && !!row.import_report);
  const changed = previous?.value !== value || previous.currency !== code || previous.timezone !== timezone;
  const status = !previous ? 'new' : changed ? 'changed' : 'unchanged';
  return { status, apply: () => {
    if (previous && !changed) return previous;
    const data = { subject_type: 'ads.ad_entity', subject_id: entity.id, ad_account_id: account.id, brand_id: account.brand_id,
      metric_key: 'ads.spend', definition_revision: 1, platform: account.provider, period_kind: 'day', date, native_date: date,
      period_start: new Date(start).toISOString(), period_end: new Date(end).toISOString(), dims: {}, value, availability: 'observed',
      currency: code, timezone, observed_at: ctx.now, source, import_report: true };
    const saved = previous ? ctx.update('metric_observation', previous.id, data) : ctx.create('metric_observation', data);
    ctx.emit('analytics.observations.recorded', { subject_type: 'ads.ad_entity', subject_id: entity.id, count: 1, ad_account_id: account.id, batch_id: batch.id });
    return saved;
  } } as const;
}

function importReport(ctx: Context, input: Input) {
  const {body} = input;
  dto(body,['source_ref','entity','observations']);
  const account = ctx.get('ad_account', id(input,'ad_account_id'));
  const source_ref = text(body.source_ref,'source_ref');
  const entity = dto(body.entity,['level','external_id','parent_entity_id','name','objective','status_snapshot','observed_at','campaign_id','ad_creative_variant_id']);
  const level = oneOf(entity.level,['campaign','ad_group','ad'],'level');
  const external_id = text(entity.external_id,'external_id');
  const parent_entity_id = optional(entity.parent_entity_id,'parent_entity_id');
  const parent = parent_entity_id && ctx.get('ad_entity',parent_entity_id);
  if (level === 'campaign' ? !!parent : !parent || parent.ad_account_id !== account.id || parent.level !== (level === 'ad' ? 'ad_group' : 'campaign')) invalid('Invalid entity hierarchy');
  const observed_at = instant(entity.observed_at ?? ctx.now,'observed_at');
  if (Date.parse(observed_at) > Date.parse(ctx.now)) invalid('Observation cannot be in the future');
  const campaign_id = campaignBrand(ctx,entity.campaign_id ?? (parent ? parent.campaign_id : undefined),account.brand_id);
  if (parent && parent.campaign_id && campaign_id !== parent.campaign_id) invalid('Entity campaign differs from its parent');
  const ad_creative_variant_id = optional(entity.ad_creative_variant_id,'ad_creative_variant_id');
  if (ad_creative_variant_id) {
    const variant = ctx.get('ad_creative_variant',ad_creative_variant_id);
    if (ctx.get('ad_creative',String(variant.creative_id)).brand_id !== account.brand_id) invalid('Creative belongs to another brand');
  }
  const values = { ad_account_id:account.id, level, external_id, parent_entity_id, campaign_id, ad_creative_variant_id,
    name:text(entity.name,'name'), objective:optional(entity.objective,'objective'), status_snapshot:optional(entity.status_snapshot,'status_snapshot'),
    observed_at, source:'report_import' };
  const previous = rows(ctx,'ad_entity','ad_account_id',account.id).find(r => r.level === level && r.external_id === external_id);
  const row = previous ? (Date.parse(String(previous.observed_at)) <= Date.parse(observed_at) ? ctx.update('ad_entity',previous.id,values) : previous) : ctx.create('ad_entity',values);
  const inputs = body.observations ?? [];
  if (!Array.isArray(inputs) || inputs.length > 1000) invalid('Invalid observations');
  const imported = inputs.map(value => {
    const item = dto(value,['metric_key','value','date','availability','definition']);
    const metric = oneOf(item.metric_key,metrics,'metric_key');
    const date = reportDay(item.date);
    const localObservedDate = localDay(observed_at,String(account.timezone));
    if (date > localObservedDate) invalid('Metric date follows its observation date');
    const availability = oneOf(item.availability,['observed','estimated','source_not_provided','no_permission','sync_failed','not_collected','not_applicable'],'availability');
    const known = availability === 'observed' || availability === 'estimated';
    if (!known && item.value != null) invalid('Unavailable metric cannot carry a value');
    const amount = known ? integer(item.value,'value') : null;
    const payload = { subject_type:'ads.ad_entity', subject_id:row.id, ad_account_id:account.id, metric_key:`ads.${metric}`,
      platform:account.provider, period_kind:'day', native_date:date, availability, value:amount, currency:metric === 'spend' ? account.currency : undefined,
      timezone:account.timezone, observed_at, source_ref, definition:text(item.definition,'definition') };
    const existing = rows(ctx,'metric_observation','subject_id',row.id).find(r => r.native_date === date && r.metric_key === payload.metric_key && r.source_ref === source_ref);
    if (existing && (existing.value !== amount || existing.availability !== availability || existing.definition !== payload.definition)) conflict('Report observation conflicts with an earlier import');
    return existing ?? ctx.create('metric_observation',payload);
  });
  if (imported.length) ctx.emit('analytics.observations.recorded',{ subject_type:'ads.ad_entity', subject_id:row.id, count:imported.length });
  return {entity:row, observations:imported};
}
function reportDay(value: unknown) {
  const day = text(value,'date');
  const at = Date.parse(`${day}T00:00:00Z`);
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !Number.isFinite(at) || new Date(at).toISOString().slice(0,10) !== day) invalid('Invalid report date');
  return day;
}
function localDay(at: string, timeZone: string) {
  return new Intl.DateTimeFormat('sv-SE',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
}
function performance(ctx: Context, {query}: Input) {
  const account = query.ad_account_id ? ctx.get('ad_account',query.ad_account_id) : undefined;
  const campaign = query.campaign_id ? ctx.get('campaign',query.campaign_id) : undefined;
  if (account && campaign && campaign.brand_id !== account.brand_id) invalid('Campaign belongs to another brand');
  const from = query.from ? reportDay(query.from) : undefined;
  const until = query.until ? reportDay(query.until) : undefined;
  if (from && until && (until < from || (Date.parse(until) - Date.parse(from)) / 86_400_000 > 366)) invalid('Invalid reporting interval');
  const entities = ctx.list('ad_entity').filter(r => (!account || r.ad_account_id === account.id) && (!campaign || r.campaign_id === campaign.id) && (!query.entity_id || r.id === query.entity_id));
  const byId = new Map(entities.map(r => [r.id,r]));
  const observations = ctx.list('metric_observation').filter(r => ['ad','ads.ad_entity'].includes(String(r.subject_type)) && byId.has(String(r.subject_id)) &&
    (!from || String(r.native_date) >= from) && (!until || String(r.native_date) <= until));
  const latest = new Map<string, Row>();
  for (const row of observations) {
    const key = JSON.stringify([row.subject_id,row.native_date,row.metric_key,row.currency]);
    const current = latest.get(key);
    if (!current || Date.parse(String(current.observed_at)) <= Date.parse(String(row.observed_at))) latest.set(key,row);
  }
  const available = [...latest.values()];
  const observedSpend = available.filter(r => r.metric_key === 'ads.spend' && r.period_kind === 'day' && r.availability === 'observed' && typeof r.value === 'number');
  const spendBySubject = new Set(observedSpend.map(r => JSON.stringify([r.subject_id, r.native_date, r.currency])));
  const spend = observedSpend.filter(r => {
    // A reported ancestor total already includes its descendants for that accounting day.
    const visited = new Set<unknown>([r.subject_id]);
    let parent = byId.get(String(r.subject_id))?.parent_entity_id;
    while (parent && !visited.has(parent)) {
      if (spendBySubject.has(JSON.stringify([parent, r.native_date, r.currency]))) return false;
      visited.add(parent);
      parent = byId.get(String(parent))?.parent_entity_id;
    }
    return true;
  });
  const budgets = campaign && !query.entity_id ? rows(ctx,'budget_line','campaign_id',campaign.id)
    .filter(r => (r.category ?? r.kind) === 'ads' && typeof r.amount_minor === 'number' && r.status !== 'archived' &&
      (!account || !r.ad_account_id || r.ad_account_id === account.id)) : [];
  const entityAccounts = new Map(ctx.list('ad_account').map(r => [r.id,r]));
  const currencies = [...new Set([
    ...spend.map(r => r.currency), ...budgets.map(r => r.currency),
    ...entities.map(r => entityAccounts.get(String(r.ad_account_id))?.currency), account?.currency,
  ].filter((code): code is string => typeof code === 'string'))];
  const pacing = currencies.map(currency => {
    const subset = spend.filter(r => r.currency === currency);
    const total = subset.length ? subset.reduce((sum,r) => sum + Number(r.value),0) : null;
    const lines = budgets.filter(r => r.currency === currency);
    const budget = lines.length ? lines.reduce((sum,r) => sum + Number(r.amount_minor),0) : null;
    const units = entities.filter(r => entityAccounts.get(String(r.ad_account_id))?.currency === currency);
    const roots = units.filter(r => !byId.has(String(r.parent_entity_id)));
    const children = new Map<unknown, Row[]>();
    for (const row of units) {
      if (row.parent_entity_id) children.set(row.parent_entity_id, [...(children.get(row.parent_entity_id) ?? []), row]);
    }
    const covered = (row: Row, day: string): boolean => {
      if (spendBySubject.has(JSON.stringify([row.id, day, currency]))) return true;
      const descendants = children.get(row.id) ?? [];
      return descendants.length > 0 && descendants.every(child => covered(child, day));
    };
    const reportedDays = new Set(subset.map(row => String(row.native_date)));
    const completeDays = [...reportedDays].filter(day => roots.every(root => covered(root, day))).length;
    const dayCount = from && until && roots.length ? (Date.parse(until) - Date.parse(from)) / 86_400_000 + 1 : null;
    const gap = dayCount === null ? null : dayCount - completeDays;
    return { currency, actual_spend_minor:total, budget_minor:budget, observed_pacing:total !== null && budget ? total / budget : null,
      coverage_ratio: dayCount === null ? null : completeDays / dayCount,
      unreported_days:gap, delayed:gap === null ? null : gap > 0, as_of:subset.map(r => String(r.observed_at)).sort().at(-1) ?? null };
  });
  const accounts = account ? [account] : [...new Set(entities.map(r => String(r.ad_account_id)))].flatMap(id => entityAccounts.get(id) ?? []);
  return { observations:available, as_of:available.map(r => String(r.observed_at)).sort().at(-1) ?? null,
    timezone: account?.timezone ?? null, reporting_basis: 'provider_native_daily',
    report_timezones: [...new Set(accounts.map(r => r.timezone))],
    coverage: available.length ? 'observations_only' : 'unavailable', pacing };
}

function adjustmentDetails(suggestion: Row, observations: Map<string, Row>) {
  const evidence = strings(suggestion.evidence_refs, 'evidence_refs').flatMap(id => {
    const row = observations.get(id);
    if (!row || row.subject_id !== suggestion.target_entity_id || row.availability !== 'observed' ||
        !['ad','ads.ad_entity'].includes(String(row.subject_type))) return [];
    return [{ id, metric_key: row.metric_key, value: row.value, currency: row.currency, native_date: row.native_date,
      timezone: row.timezone, definition: row.definition, observed_at: row.observed_at }];
  });
  // This runtime has no provider write adapter, even when an account advertises write permission.
  return { ...suggestion, evidence, execution_mode: 'manual', manual_checklist: [
    'verify_target_and_evidence', 'review_limitations_and_rights', 'approve_draft_before_manual_change', 'record_platform_readback',
  ] };
}

function suggest(ctx: Context, body: Data) {
  dto(body,['target_entity_id','experiment_id','kind','rationale','evidence_refs','checks','ai_generated']);
  const target = ctx.get('ad_entity',text(body.target_entity_id,'target_entity_id'));
  const account = ctx.get('ad_account',String(target.ad_account_id));
  const experiment_id = optional(body.experiment_id,'experiment_id');
  if (experiment_id && ctx.get('experiment',experiment_id).brand_id !== account.brand_id) invalid('Experiment belongs to another brand');
  const evidence_refs = strings(body.evidence_refs,'evidence_refs');
  if (!evidence_refs.length) invalid('Evidence is required');
  for (const ref of evidence_refs) {
    const evidence = ctx.get('metric_observation',ref);
    if (evidence.availability !== 'observed' || evidence.subject_id !== target.id || !['ad','ads.ad_entity'].includes(String(evidence.subject_type))) invalid('Evidence must be observed data for the target');
  }
  const checks = dto(body.checks,['inventory','rights','budget','sample_size','minimum_sample_size','promotion_overlap']);
  const assessment = { inventory:flag(checks.inventory,'inventory'), rights:flag(checks.rights,'rights'), budget:flag(checks.budget,'budget'),
    sample_size:integer(checks.sample_size,'sample_size'), minimum_sample_size:integer(checks.minimum_sample_size,'minimum_sample_size',1),
    promotion_overlap:flag(checks.promotion_overlap,'promotion_overlap') };
  const limits = [!assessment.inventory && 'inventory', !assessment.rights && 'rights', !assessment.budget && 'budget',
    assessment.sample_size < assessment.minimum_sample_size && 'insufficient_sample', assessment.promotion_overlap && 'promotion_overlap'].filter(Boolean);
  return ctx.create('adjustment_suggestion',{ target_entity_id:target.id, experiment_id, ad_account_id:account.id,
    kind:oneOf(body.kind,['pause','scale','reallocate','swap_creative'],'kind'), rationale:text(body.rationale,'rationale'), evidence_refs,
    checks:assessment, limitations:limits, ai_generated:flag(body.ai_generated,'ai_generated'), status:'proposed' });
}
function decideSuggestion(ctx: Context, input: Input) {
  const {body} = input;
  dto(body,['decision','proposal_id','revision']);
  const suggestion = ctx.get('adjustment_suggestion',id(input,'suggestion_id'));
  if (suggestion.status !== 'proposed') conflict('Suggestion was already decided');
  const status = oneOf(body.decision,['accepted','modified','rejected'],'decision');
  let resulting_proposal_revision_id: unknown;
  if (status !== 'rejected') {
    const target = ctx.get('ad_entity',String(suggestion.target_entity_id));
    const proposalId = optional(body.proposal_id,'proposal_id');
    const proposal = proposalId ? ctx.get('ad_proposal',proposalId) : ctx.create('ad_proposal',{ ad_account_id:target.ad_account_id,
      brand_id:ctx.get('ad_account',String(target.ad_account_id)).brand_id, campaign_id:target.campaign_id, experiment_id:suggestion.experiment_id, status:'draft' });
    if (proposal.ad_account_id !== target.ad_account_id || proposal.campaign_id !== target.campaign_id) invalid('Proposal belongs to a different account or campaign');
    const revision = dto(body.revision,revisionFields);
    const change = dto(revision.change,['kind','target_entity_id']);
    const matching = { pause:'pause', scale:'update_budget', reallocate:'update_budget', swap_creative:'update_creative' };
    if (change.target_entity_id !== target.id || (status === 'accepted' && change.kind !== matching[suggestion.kind as keyof typeof matching])) invalid('Revision does not match the suggestion target or action');
    const updated = appendRevision(ctx,proposal,revision);
    resulting_proposal_revision_id = updated.current_revision_id;
  } else if (body.proposal_id !== undefined || body.revision !== undefined) invalid('Rejection cannot create a revision');
  return ctx.update('adjustment_suggestion',suggestion.id,{status, resulting_proposal_revision_id, decided_by:ctx.actorId});
}
