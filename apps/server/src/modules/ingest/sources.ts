import { providerCatalog } from '../../../../../packages/adapters/src/provider-catalog.js';
import { admins, readers, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { DAY, at, checkUse, choice, emit, get, hash, identifier, insert, integer, iso, methods, metricKeys, nativeTimezone, requireThat, resources, roleAllowed, shape, socialProviders, update, uses } from './model.js';

const officialCapability = (provider: typeof socialProviders[number]) => providerCatalog[provider]?.capabilities.find(
  entry => entry.operation === 'insights_read' && entry.executor === 'api' && entry.readiness === 'implemented' && !entry.requires_review,
);

const providerResources: Record<string, readonly string[]> = {
  meta_instagram: ['account_metrics', 'post_metrics'], meta_facebook: ['account_metrics', 'post_metrics'],
  tiktok: ['account_metrics', 'video_metrics'], youtube: ['account_metrics', 'video_metrics'],
  douyin: ['account_metrics', 'video_metrics'], xiaohongshu: ['note_metrics'], file_import: resources,
};
const metricFields: Record<string, readonly string[]> = {
  account_metrics: ['impressions', 'reach', 'views', 'followers', 'clicks'],
  post_metrics: ['impressions', 'reach', 'views', 'video_views', 'likes', 'comments', 'shares', 'saves', 'clicks', 'watch_time_seconds'],
  video_metrics: ['impressions', 'reach', 'views', 'video_views', 'likes', 'comments', 'shares', 'saves', 'watch_time_seconds'],
  note_metrics: ['impressions', 'reach', 'views', 'likes', 'comments', 'shares', 'saves'],
  ad_metrics: ['impressions', 'reach', 'views', 'clicks', 'spend', 'conversions'],
};

export function sourceResource(source: Entity, resource: unknown) {
  const key = choice(resource, resources, 'resource');
  requireThat(source.data.resources.includes(key), 'capability_unavailable', 'Resource is not enabled for this source', 409);
  return key;
}

export async function authorization(ctx: Context, source: Fields): Promise<string | null> {
  if (source.authorization_confirmed !== true) return 'authorization_required';
  if (source.kind === 'platform_account') {
    const account = await ctx.get('account', 'social_account', source.social_account_id);
    if (!account || account.data.provider !== source.provider || account.data.status !== 'active') return 'account_unavailable';
    if (source.method === 'official_api') {
      const capability = officialCapability(source.provider);
      if (!capability) return 'api_not_implemented';
      const connection = await ctx.get('account', 'connection', source.connection_id);
      if (!connection || connection.data.provider !== source.provider || connection.data.purpose !== 'social' || connection.data.status !== 'active') return 'connection_unavailable';
      if (!(at(connection.data.expires_at) > at(ctx.now))) return 'connection_expired';
      if (!connection.data.external_account_ids?.includes(account.data.external_account_id)) return 'connection_account_mismatch';
      const linked = (await ctx.list('account', 'social_account_connection')).some(row => row.data.social_account_id === account.id && row.data.connection_id === connection.id);
      if (!linked) return 'connection_account_mismatch';
      const scopes: string[] = connection.data.granted_scopes;
      if (!Array.isArray(scopes) || !(capability.requires_scopes ?? []).every(scope => scope.split('|').some(value => scopes.includes(value)))) return 'scope_missing';
    }
  }
  return null;
}

export async function assertCollectable(ctx: Context, source: Entity) {
  requireThat(source.data.status === 'active', 'source_inactive', 'Data source is not active', 409);
  requireThat(!(await authorization(ctx, source.data)), 'no_permission', 'Data source lacks current authorization', 403);
}

export const scheduleId = (source: string, resource: string) => hash('schedule', source, resource);

export const sourceCommands: Commands = {
  create_source: { roles: admins, async run(ctx, input) {
    roleAllowed(ctx, admins);
    shape(input, ['name', 'provider', 'kind', 'method', 'connection_id', 'social_account_id', 'resources', 'timezone', 'authorized', 'allowed_uses', 'history_days', 'field_coverage']);
    const name = text(input, 'name', 120);
    const provider = choice(input.provider, [...socialProviders, 'file_import'], 'provider');
    const kind = choice(input.kind, ['platform_account', 'file_import'] as const, 'kind');
    const method = choice(input.method, methods, 'method');
    requireThat((provider === 'file_import') === (kind === 'file_import'), 'invalid_input', 'Provider and source kind do not match');
    requireThat(method !== 'official_api' || !['xiaohongshu', 'file_import'].includes(provider), 'capability_unavailable', 'This provider does not support official API collection here');
    requireThat(input.authorized === true, 'authorization_required', 'Confirm authorization to use this source', 403);
    requireThat(Array.isArray(input.resources) && input.resources.length > 0 && input.resources.length <= resources.length, 'invalid_input', 'Select one or more resources');
    const selected = [...new Set<string>(input.resources.map((value: unknown) => choice(value, providerResources[provider], 'resource')))];
    const requestedFields = input.field_coverage === undefined ? {} : shape(input.field_coverage, selected, 'field_coverage');
    const field_coverage: Fields = {};
    for (const resource of selected) {
      const supported = metricFields[resource];
      const granted = requestedFields[resource];
      requireThat(granted === undefined || Array.isArray(granted) && granted.length <= supported.length, 'invalid_input', 'Invalid field coverage');
      const fields = granted === undefined ? supported : [...new Set<string>(granted.map((key: unknown) => choice(key, supported, 'metric field')))];
      field_coverage[resource] = { status: fields.length === supported.length ? 'available' : fields.length ? 'partial' : 'no_permission', fields,
        missing: supported.filter(key => !fields.includes(key)).map(field => ({ field, reason: 'no_permission' })) };
    }
    const allowed = shape(input.allowed_uses, [...uses, 'cache_days'], 'allowed_uses');
    const allowed_uses: Fields = {};
    for (const use of uses) {
      requireThat(allowed[use] === undefined || typeof allowed[use] === 'boolean', 'invalid_input', `Invalid ${use}`);
      allowed_uses[use] = allowed[use] === true;
    }
    allowed_uses.cache_days = integer(allowed.cache_days ?? 0, 0, 90, 'cache_days');
    const timezone = nativeTimezone(input.timezone);
    const connection_id = method === 'official_api' ? identifier(input, 'connection_id') : null;
    const social_account_id = kind === 'platform_account' ? identifier(input, 'social_account_id') : null;
    requireThat(connection_id !== null || input.connection_id === undefined, 'invalid_input', 'Unexpected connection for this method');
    requireThat(social_account_id !== null || input.social_account_id === undefined, 'invalid_input', 'Unexpected account for this kind');
    const history_days = integer(input.history_days ?? 30, 1, 366, 'history_days');
    const data = { name, kind, provider, method, connection_id, social_account_id, resources: selected, field_coverage, allowed_uses,
      history_days, timezone, authorization_confirmed: true, authorized_by: ctx.actorId, authorized_at: ctx.now, status: 'active', status_reason: null, last_success_at: null };
    const denied = await authorization(ctx, data);
    requireThat(!denied, 'no_permission', 'Data source lacks a matching authorized account or connection', 403);
    const id = hash('source', provider, method, social_account_id ?? name);
    requireThat(!(await ctx.get('ingest', 'data_source', id)), 'source_exists', 'Data source already exists', 409);
    const source = await insert(ctx, 'data_source', data, id);
    for (const resource of selected) {
      const interval_seconds = 14_400;
      await insert(ctx, 'sync_schedule', { data_source_id: source.id, resource, mode: method === 'official_api' ? 'interval' : 'manual_only',
        interval_seconds, overlap_seconds: 3_600, settle_seconds: provider === 'youtube' ? 86_400 : 300,
        next_due_at: method === 'official_api' ? iso(at(ctx.now) + interval_seconds * 1_000) : null }, scheduleId(source.id, resource));
    }
    await emit(ctx, 'data_source.status_changed', { data_source_id: id, status: 'active', provider });
    return source;
  } },
  set_source_status: { roles: admins, async run(ctx, input) {
    roleAllowed(ctx, admins);
    shape(input, ['data_source_id', 'status']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    const status = choice(input.status, ['active', 'paused', 'disabled'] as const, 'status');
    requireThat(source.data.status !== 'disabled' && source.data.status !== status, 'invalid_transition', 'Invalid data source transition', 409);
    if (status === 'active') requireThat(!(await authorization(ctx, source.data)), 'no_permission', 'Source authorization must be restored first', 403);
    const row = await update(ctx, source, { status, status_reason: null });
    await emit(ctx, 'data_source.status_changed', { data_source_id: row.id, status });
    return row;
  } },
  get_source_capability: { roles: readers, async run(ctx, input) {
    roleAllowed(ctx, readers);
    shape(input, ['data_source_id']);
    const source = await get(ctx, 'data_source', identifier(input, 'data_source_id'));
    const reason = await authorization(ctx, source.data);
    return { data_source_id: source.id, provider: source.data.provider, method: source.data.method,
      status: reason && source.data.status === 'active' ? 'needs_authorization' : source.data.status,
      reason, field_coverage: source.data.field_coverage, timezone: source.data.timezone, allowed_uses: source.data.allowed_uses };
  } },
  check_use: { roles: readers, async run(ctx, input) {
    roleAllowed(ctx, readers);
    shape(input, ['source_ids', 'use']);
    requireThat(Array.isArray(input.source_ids) && input.source_ids.length >= 1 && input.source_ids.length <= 100, 'invalid_input', 'Select one or more sources');
    const ids = input.source_ids.map((id: unknown) => identifier({ id }, 'id'));
    await checkUse(ctx, ids, choice(input.use, uses, 'use'));
    return { allowed: true };
  } },
};

export const historyStart = (ctx: Context, source: Entity) => at(ctx.now) - source.data.history_days * DAY;
export const supportedMetric = (metric: unknown) => choice(metric, metricKeys, 'metric_key');
