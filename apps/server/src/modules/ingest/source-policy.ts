import { ADMIN, Problem, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { asData, integer, invalid, listed, object, text } from './ingest-input';

export const STORE_PROVIDERS = ['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'lazada'];
export const SOCIAL_PROVIDERS = ['meta_instagram', 'meta_facebook', 'tiktok', 'youtube', 'douyin', 'xiaohongshu'];
const uses = ['display', 'team_share', 'export', 'public_display', 'model_processing'] as const;
export type Use = typeof uses[number];

export function checkUse(ctx: Context, ids: readonly string[], use: Use) {
  for (const id of new Set(ids)) {
    const source = ctx.get('data_source', id);
    if (source.status === 'disabled' || asData(source.allowed_uses)[use] !== true) {
      throw new Problem(403, 'EGRESS_BLOCKED', `Data source does not permit ${use}`);
    }
  }
}

export function callbackFallback(ctx: Context, source: Row) {
  const endpoints = ctx.list('callback_endpoint').filter(row => row.provider === source.provider &&
    (row.connection_id == null || row.connection_id === source.connection_id));
  const scoped = endpoints.filter(row => row.connection_id != null);
  const fallback = (scoped.length ? scoped : endpoints).find(row => row.fallback_polling === true);
  if (!fallback || source.status_reason === 'ip_not_allowed') return null;
  return fallback.reachable === false ? 'callback_unreachable' : 'callback_prerequisite_missing';
}

export function permitSourceResource(source: Row, resource: string) {
  if (!listed(source.resources).includes(resource)) throw new Problem(422, 'RESOURCE_NOT_ENABLED', 'Resource is not enabled for this source');
}

function permissions(value: unknown, vendor: boolean, previous?: unknown): Data {
  const input = value === undefined ? {} : object(value, 'allowed_uses');
  const base = asData(previous);
  const result: Data = {};
  for (const use of uses) {
    const flag = input[use] ?? base[use] ?? (!vendor && ['display', 'team_share', 'export'].includes(use));
    if (typeof flag !== 'boolean') invalid(`allowed_uses.${use} must be boolean`);
    result[use] = flag;
  }
  result.cache_days = integer(input.cache_days ?? base.cache_days ?? (vendor ? 0 : 90), 'cache_days', 0, 90);
  return result;
}

function editable(body: Data, source?: Row): Data {
  const kind = String(source?.kind ?? body.kind ?? 'file_import');
  const provider = text(source?.provider ?? body.provider ?? 'file_import', 'provider');
  const vendor = kind === 'vendor';
  if (!['file_import', 'platform_account', 'store', 'vendor', 'ad_account', 'esp'].includes(kind)) invalid('Invalid data source type');
  if ((kind === 'file_import' && provider !== 'file_import') || (vendor && !/^vendor:[\w-]+$/.test(provider)) ||
    (kind === 'store' && !STORE_PROVIDERS.includes(provider)) || (kind === 'platform_account' && !SOCIAL_PROVIDERS.includes(provider))) invalid('Provider does not match data source type');
  const requested = body.resources ?? source?.resources ?? [];
  if (!Array.isArray(requested) || requested.some(resource => typeof resource !== 'string' || !/^[a-z][a-z0-9_]*$/.test(resource))) invalid('resources must contain snake_case keys');
  const resources = [...new Set(listed(requested))];
  const contract = vendor ? text(body.contract_ref ?? source?.contract_ref, 'contract_ref') : null;
  const history: Data = {};
  for (const [resource, duration] of Object.entries(asData(body.history_limit ?? source?.history_limit))) {
    if (!resources.includes(resource) || typeof duration !== 'string' || !/^P[1-9]\d{0,3}[DMY]$/.test(duration)) invalid('history_limit requires ISO day/month/year durations on enabled resources');
    history[resource] = duration;
  }
  return {
    name: text(body.name ?? source?.name, 'name'), resources, history_limit: history,
    allowed_uses: permissions(body.allowed_uses, vendor, source?.allowed_uses), contract_ref: contract,
    min_sync_interval_min: integer(body.min_sync_interval_min ?? source?.min_sync_interval_min ?? 0, 'min_sync_interval_min', 0, 10_080),
    field_coverage: Object.fromEntries(resources.map(resource => [resource, asData(source?.field_coverage)[resource] ?? { status: 'not_collected', fields: [], missing: [] }])),
  };
}

function setStatus(ctx: Context, source: Row, status: string, reason: string | null) {
  if (source.status === status && source.status_reason === reason) return source;
  const updated = ctx.update('data_source', source.id, { status, status_reason: reason });
  ctx.emit('ingest.data_source.status_changed', { data_source_id: source.id, status, status_reason: reason });
  return updated;
}

export function markIpDenied(ctx: Context, source: Row) {
  return setStatus(ctx, source, 'degraded', 'ip_not_allowed');
}

/** Only call after an actual read-only adapter probe. */
export function resolveProbe(ctx: Context, sourceId: string, succeeded: boolean) {
  const source = ctx.get('data_source', sourceId);
  if (source.status_reason !== 'ip_not_allowed' || !succeeded) return source;
  return setStatus(ctx, source, 'active', null);
}

export const sourceOperations: Operation[] = [
  { path: '/data-sources', method: 'GET', name: 'data_source_list', roles: READ, summary: 'List data source policies and status', run: ctx => ctx.list('data_source') },
  { path: '/data-sources/:id', method: 'GET', name: 'data_source_get', roles: READ, summary: 'Read data source', run(ctx, { params }) {
    const source = ctx.get('data_source', params.id);
    const reason = callbackFallback(ctx, source);
    return { ...source, fallback_polling: Boolean(reason), fallback_polling_reason: reason };
  } },
  { path: '/data-sources', method: 'POST', name: 'data_source_create', roles: ADMIN, summary: 'Register a data source policy', run(ctx, { body }) {
    const fields = editable(body);
    const kind = String(body.kind ?? 'file_import'), provider = String(body.provider ?? 'file_import');
    const connectionId = body.connection_id === undefined ? null : text(body.connection_id, 'connection_id');
    const storeId = body.store_id === undefined ? null : text(body.store_id, 'store_id');
    const socialAccountId = body.social_account_id === undefined ? null : text(body.social_account_id, 'social_account_id');
    const adAccountId = body.ad_account_id === undefined ? null : text(body.ad_account_id, 'ad_account_id');
    if (adAccountId) {
      if (!['ad_account', 'file_import'].includes(kind) || storeId || socialAccountId) invalid('Advertising data source must target a single ad account');
      const account = ctx.get('ad_account', adAccountId);
      if (kind !== 'file_import' && account.provider !== provider) invalid('Ad account provider does not match');
      if (connectionId && account.connection_id !== connectionId) invalid('Ad account belongs to a different connection');
    }
    if (connectionId && ctx.get('connection', connectionId).provider !== provider) invalid('Connection provider does not match');
    if (storeId && ctx.get('store', storeId).provider !== provider) invalid('Store provider does not match');
    if (socialAccountId) {
      const account = ctx.get('social_account', socialAccountId);
      if ((account.provider ?? account.platform) !== provider) invalid('Social account provider does not match');
      if (connectionId && account.connection_id && account.connection_id !== connectionId) invalid('Social account belongs to a different connection');
    }
    const ref = connectionId || storeId || socialAccountId || adAccountId;
    if (ref && ctx.list('data_source').some(row => row.provider === provider && row.connection_id === connectionId && row.store_id === storeId && row.social_account_id === socialAccountId && (row.ad_account_id ?? null) === adAccountId && row.status !== 'disabled')) {
      throw new Problem(409, 'SOURCE_EXISTS', 'An enabled data source already exists for this connection and resource');
    }
    const status = connectionId || vendorOrFile(kind) ? 'active' : 'needs_authorization';
    const source = ctx.create('data_source', { ...fields, kind, provider, connection_id: connectionId, store_id: storeId, social_account_id: socialAccountId,
      ...(adAccountId ? { ad_account_id: adAccountId } : {}), status });
    ctx.emit('ingest.data_source.status_changed', { data_source_id: source.id, status });
    return source;
  } },
  { path: '/data-sources/:id', method: 'PATCH', name: 'data_source_update', roles: ADMIN, versionKind: 'data_source', summary: 'Update source resources and allowed uses', run(ctx, { params, body }) {
    const source = ctx.get('data_source', params.id);
    return ctx.update('data_source', source.id, editable(body, source));
  } },
  { path: '/data-sources/:id/pause', method: 'POST', name: 'data_source_pause', roles: ADMIN, summary: 'Pause new collection requests', run(ctx, { params }) {
    const source = ctx.get('data_source', params.id);
    if (source.status === 'disabled') throw new Problem(409, 'SOURCE_DISABLED', 'Source is disabled');
    return setStatus(ctx, source, 'paused', typeof source.status_reason === 'string' ? source.status_reason : null);
  } },
  { path: '/data-sources/:id/resume', method: 'POST', name: 'data_source_resume', roles: ADMIN, summary: 'Resume a paused source or request a read-only IP probe', run(ctx, { params }) {
    const source = ctx.get('data_source', params.id);
    if (source.status_reason === 'ip_not_allowed') {
      const previous = ctx.list('sync_run').find(run => run.data_source_id === source.id && run.run_type === 'probe' && ['queued', 'running'].includes(String(run.status)));
      const run = previous ?? ctx.create('sync_run', { data_source_id: source.id, run_type: 'probe', status: 'queued', executor_status: 'awaiting_adapter', request_count: 0, attempt: 1, checkpoint_index: 0 });
      if (!previous) ctx.emit('ingest.sync_run.queued', { sync_run_id: run.id, data_source_id: source.id });
      return { data_source: source, sync_run_id: run.id };
    }
    if (source.status !== 'paused') throw new Problem(409, 'SOURCE_NOT_PAUSED', 'Only paused sources can resume');
    return setStatus(ctx, source, source.connection_id || vendorOrFile(String(source.kind)) ? 'active' : 'needs_authorization', null);
  } },
];

function vendorOrFile(kind: string) { return kind === 'vendor' || kind === 'file_import'; }
