import { ADMIN, READ, type Context, type Data, type Operation, type Role, type Row } from '@smartsell/contracts';
import { audit, fail, find, integer, one, select, text, time } from './input.ts';
import { type AccountServices, connectShopifyMerchant, connectionContext, invalidateConnectionCapabilities, providers, publicConnection, startOAuth, storeProviders } from './oauth.ts';
import { type Limits, type Terms, countAutoGrants, defaultLimits, haltSources, limits, policy, setPolicy, windows } from './auto-control.ts';
import { drainConnectorTasks } from './connector-service.ts';
import { bindingFor, blocked, connectorReady, issuePairingCode, online, sessionFor } from './device-control.ts';
import { activeMigration, completeMigration, migrationImpact, migrationStatus, startMigration } from './migration.ts';
import { providerCatalog } from '../../../../../packages/adapters/src/provider-catalog.ts';
import type { CapabilityReport, ProviderKey } from '../../../../../packages/adapters/src/adapter-types.ts';

export interface Services extends AccountServices {
  terms?: () => Terms | undefined;
  platformLimits?: (provider: ProviderKey) => Limits | undefined;
  connectorConfigured?: (ctx: Context, bindingId: string, mode: 'assist' | 'auto') => boolean;
  /** Host supplies trusted browser-session provenance. Never derive it from an input field or the user role. */
  humanSession?: (ctx: Context) => boolean;
  privateDeployment?: boolean;
}
const STAFF = ['owner', 'admin', 'manager', 'editor'] as const;
const INTERNAL_READ = READ.filter(role => role !== 'agent');
const accountFields = ['provider', 'external_account_id', 'display_name', 'brand_id', 'owner_id', 'default_timezone', 'status'];
const appProvider: Record<string, string> = { instagram: 'meta_instagram', facebook: 'meta_facebook', tiktok: 'tiktok', douyin: 'douyin', xhs: 'xiaohongshu', xiaohongshu: 'xiaohongshu' };

function zone(value: unknown) {
  const timezone = text(value, 100);
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch { fail('INVALID_TIME_ZONE', 422); }
  return timezone;
}

export function impact(ctx: Context, accountIds: string[]) {
  const tasks = ctx.list('execution_task').filter(row => accountIds.includes(String(row.social_account_id ?? row.account_id)) && !['published', 'failed', 'cancelled'].includes(String(row.status)));
  const connector = ctx.list('connector_task').filter(row => accountIds.includes(String(row.social_account_id)) && ['queued', 'claimed', 'outcome_unknown'].includes(String(row.status)));
  return { social_account_ids: accountIds, execution_task_ids: tasks.map(row => row.id), connector_task_ids: connector.map(row => row.id) };
}

const accountBinding = (ctx: Context, id: string) => bindingFor(ctx, id) ?? fail('BINDING_NOT_CONFIGURED');

function activeBrand(ctx: Context, value: unknown) {
  const brand = ctx.get('brand', text(value));
  if (brand.status != null && brand.status !== 'active') fail('BRAND_INACTIVE');
  return brand.id;
}

async function capabilityReport(ctx: Context, connection: Row, services: Services, externalId: string) {
  const provider = connection.provider as ProviderKey;
  const adapter = services.adapter?.(provider, connection.platform_app_id as string | undefined);
  if (adapter?.provider !== provider) return;
  try {
    const report = await adapter.probe(connectionContext(ctx, connection, services, externalId));
    if (report.provider === provider && report.status === 'ready' && (report.externalAccountId === externalId ||
      report.accounts?.some(item => item.externalAccountId === externalId))) return report;
  } catch { /* A failed or unauthorized probe cannot grant capability. */ }
}

async function storeCapabilities(ctx: Context, id: string, externalId: string | undefined, services: Services, persist = false) {
  const connection = ctx.get('connection', id);
  const provider = connection.provider as ProviderKey;
  if (connection.purpose !== 'store' || !storeProviders.includes(provider)) fail('STORE_CONNECTION_REQUIRED', 422);
  const accounts = connection.discovered_accounts as CapabilityReport['accounts'];
  const account = externalId ? accounts?.find(item => item.externalAccountId === externalId) : accounts?.length === 1 ? accounts[0] : undefined;
  if (!account) fail('PLATFORM_IDENTITY_UNVERIFIED', 422);
  const report = await capabilityReport(ctx, connection, services, account.externalAccountId);
  const capabilities = providerCatalog[provider].capabilities.map(decl => ({
    ...decl, status: report?.capabilities.find(item => item.operation === decl.operation && item.content_format === decl.content_format && item.executor === decl.executor)?.status
      ?? (decl.readiness === 'unsupported' ? 'unsupported' : 'unverified'),
  }));
  if (persist) persistCapabilities(ctx, { social_account_id: null, connection_id: id, external_account_id: account.externalAccountId }, capabilities);
  return { connection_id: id, external_account_id: account.externalAccountId, checked_at: ctx.now, capabilities,
    ...(!report && { reason: connection.status === 'active' ? 'not_configured_or_unverified' : 'connection_inactive' }) };
}

function persistCapabilities(ctx: Context, scope: Data, capabilities: readonly Data[]) {
  const existing = ctx.list('capability').filter(row => row.source === 'account_probe' && Object.entries(scope).every(([key, value]) => row[key] === value));
  const identity = (row: Data) => JSON.stringify([row.connection_id ?? null, row.operation, row.content_format, row.executor, row.connector_channel]);
  const byKey = new Map(existing.map(row => [identity(row), row]));
  for (const cap of capabilities) {
    const values = { ...scope, ...cap, checked_at: ctx.now, source: 'account_probe' };
    const key = identity(values);
    const row = byKey.get(key);
    if (row) ctx.update('capability', row.id, values);
    else ctx.create('capability', values);
    byKey.delete(key);
  }
  for (const row of byKey.values()) ctx.remove('capability', row.id);
}

async function capabilityRows(ctx: Context, id: string, services: Services, persist = false) {
  const account = ctx.get('social_account', id);
  const provider = account.provider as ProviderKey;
  const decls = providerCatalog[provider]?.capabilities ?? [];
  const links = ctx.list('social_account_connection').filter(row => row.social_account_id === id && row.status === 'active');
  const reports: { connection_id: string; report: CapabilityReport }[] = [];
  for (const link of account.status === 'active' ? links : []) {
    const connection = ctx.get('connection', String(link.connection_id));
    if (connection.provider !== provider || connection.purpose !== 'social' || connection.brand_id !== account.brand_id) continue;
    const report = await capabilityReport(ctx, connection, services, String(account.external_account_id));
    if (report) reports.push({ connection_id: connection.id, report });
  }
  const binding = bindingFor(ctx, id);
  const capabilities = decls.map(decl => {
    let status = 'unverified';
    let reason: string | undefined;
    if (account.status !== 'active') { status = 'unsupported'; reason = 'account_disabled'; }
    else if (decl.executor === 'manual') status = 'manual_only';
    else if (decl.readiness === 'unsupported') status = 'unsupported';
    else if (decl.executor === 'connector') {
      reason = 'connector_not_configured';
      if (decl.readiness === 'implemented' && binding && binding.connector_channel === decl.connector_channel && services.connectorConfigured?.(ctx, binding.id, 'assist')) {
        if (blocked(ctx, account.id)) reason = 'account_blocked';
        else if (!connectorReady(ctx, binding)) reason = 'connector_not_ready';
        else { status = 'available'; reason = undefined; }
      }
    } else if (decl.executor === 'api' && decl.readiness === 'implemented') {
      const matches = reports.flatMap(({ report }) => report.capabilities).filter(cap => cap.operation === decl.operation && cap.content_format === decl.content_format && cap.executor === 'api');
      status = (['available', 'read_only', 'needs_authorization', 'unsupported'] as const).find(value => matches.some(cap => cap.status === value)) ?? 'unverified';
      if (status === 'unverified') reason = links.length ? 'not_configured_or_unverified' : 'no_active_connection';
    }
    return { ...decl, status, reason, checked_at: ctx.now };
  });
  if (persist) {
    const api = reports.flatMap(({ connection_id, report }) => report.capabilities.filter(cap => cap.executor === 'api' &&
      decls.some(decl => decl.readiness === 'implemented' && decl.executor === 'api' && decl.operation === cap.operation && decl.content_format === cap.content_format))
      .map(cap => ({ ...cap, connection_id })));
    const fallback = capabilities.filter(cap => cap.executor !== 'api' || !api.some(row => row.operation === cap.operation && row.content_format === cap.content_format));
    persistCapabilities(ctx, { social_account_id: id }, [...api, ...fallback]);
  }
  return capabilities;
}

/** EX calls this again immediately before acting. Route availability does not mutate capability state. */
export async function resolveExecutors(ctx: Context, accountId: string, operation: string, format: string, services: Services) {
  const account = ctx.get('social_account', accountId);
  if (account.status !== 'active') return [];
  if (blocked(ctx, accountId)) return [{ executor: 'manual', reason: 'account_blocked' }];
  const capabilities = (await capabilityRows(ctx, accountId, services)).filter(cap => cap.operation === operation && [format, '*'].includes(cap.content_format));
  const binding = bindingFor(ctx, accountId);
  const result: Data[] = [];
  if ((!binding || ['api', 'hybrid'].includes(String(binding.mode))) && capabilities.some(cap => cap.executor === 'api' && ['available', 'read_only'].includes(cap.status))) result.push({ executor: 'api' });
  if (binding && connectorReady(ctx, binding) && capabilities.some(cap => cap.executor === 'connector' && cap.status === 'available' && cap.connector_channel === binding.connector_channel)) {
    const auto = !!services.terms?.() && binding.connector_mode === 'auto' && !haltSources(ctx, binding).length && binding.auto_ack_terms_version === services.terms?.()?.version && services.connectorConfigured?.(ctx, binding.id, 'auto');
    result.push({ executor: 'connector', device_id: binding.device_id, channel: binding.connector_channel, mobile_device_id: binding.mobile_device_id, mode: auto ? 'auto' : 'assist' });
  }
  if (capabilities.some(cap => cap.executor === 'manual') || capabilities.some(cap => ['api', 'connector'].includes(String(cap.executor)))) result.push({ executor: 'manual' });
  return result;
}

const humanOnly = new Set([
  'register_owned_social_account', 'connect_shopify_merchant', 'start_oauth', 'link_accounts', 'revoke_connection', 'register_platform_app', 'update_platform_app',
  'issue_device_pairing_code', 'approve_mobile_device', 'bind_mobile_app',
  'unbind_mobile_app', 'enable_mobile_device', 'remove_mobile_device', 'set_execution_binding', 'start_binding_migration', 'complete_binding_migration',
  'enable_auto_mode', 'update_auto_mode', 'release_account_auto',
  'release_workspace_auto', 'set_connector_auto_policy', 'resolve_account_block',
]);

export function createOperations(services: Services = {}): Operation[] {
  const op = (method: Operation['method'], path: string, name: string, roles: readonly Role[], run: Operation['run'], versionKind?: string): Operation => ({
    method, path, name: `account_${name}`, roles, summary: name.replaceAll('_', ' '), versionKind,
    run(ctx, input) {
      if (humanOnly.has(name) && services.humanSession?.(ctx) !== true) fail('HUMAN_SESSION_REQUIRED', 403);
      return run(ctx, input);
    },
  });
  const accountPath = '/social-accounts/:id';
  const bindPath = `${accountPath}/execution-binding`;
  const migrationPath = `${bindPath}/migration`;
  function mobileUnbindImpact(ctx: Context, id: string) {
    const row = ctx.get('mobile_app_binding', id);
    const accountId = String(row.social_account_id);
    const binding = bindingFor(ctx, accountId);
    const current = binding?.mobile_device_id === row.mobile_device_id && binding?.mobile_app === row.app;
    const staged = activeMigration(ctx, accountId)?.target_session_id === row.id;
    const guidance = current || staged ? ['Move the execution binding and finish migration before unlinking this app.'] :
      ['Sign out of the app on the phone if it is being handed over.', 'If the phone is being retired, remove it and revoke its USB or LAN debugging authorization on the phone.'];
    return { id: row.id, status: row.status, can_unbind: !current && !staged, guidance,
      ...(current && binding ? impact(ctx, [accountId]) : { social_account_ids: [accountId], execution_task_ids: [],
        connector_task_ids: ctx.list('connector_task').filter(task => task.social_account_id === accountId && task.mobile_device_id === row.mobile_device_id && ['claimed', 'outcome_unknown'].includes(String(task.status))).map(task => task.id) }) };
  }
  function bindingLimits(ctx: Context, binding: ReturnType<typeof accountBinding>, body: Data) {
    const account = ctx.get('social_account', String(binding.social_account_id));
    const defaults = policy(ctx)?.defaults as Limits | undefined ?? defaultLimits;
    const ceiling = services.platformLimits?.(account.provider as ProviderKey) ?? defaults;
    return { ...limits(body, ceiling), allowed_windows: windows(body.allowed_windows) };
  }
  return [
    op('GET', '/social-accounts', 'list_social_accounts', READ, (ctx, { query }) => ctx.list('social_account')
      .filter(row => ['provider', 'brand_id', 'status'].every(key => !query[key] || row[key] === query[key]))
      .filter(row => !query.q || [row.display_name, row.external_account_id].some(value => String(value).toLowerCase().includes(query.q.toLowerCase())))
      .map(row => select(row, accountFields))),
    op('POST', '/social-accounts', 'register_owned_social_account', ADMIN, (ctx, { body }) => {
      const provider = one(body.provider, ['douyin', 'xiaohongshu', 'tiktok', 'meta_instagram', 'meta_facebook', 'youtube'] as const);
      const externalId = text(body.external_account_id);
      if (body.owned_account_confirmed !== true) fail('ACCOUNT_OWNERSHIP_REQUIRED', 422);
      if (find(ctx, 'social_account', { provider, external_account_id: externalId })) fail('ACCOUNT_ALREADY_REGISTERED');
      const row = ctx.create('social_account', { provider, external_account_id: externalId, display_name: text(body.display_name),
        brand_id: activeBrand(ctx, body.brand_id), owner_id: ctx.actorId, default_timezone: zone(body.default_timezone ?? 'UTC'), status: 'active' });
      audit(ctx, 'account.social_account.registered', { social_account_id: row.id, source: 'ownership_attested' });
      return select(row, accountFields);
    }),
    op('GET', accountPath, 'get_social_account', READ, (ctx, { params }) => select(ctx.get('social_account', params.id), accountFields)),
    op('PATCH', accountPath, 'update_social_account', STAFF, (ctx, { params, body }) => {
      const patch: Data = {};
      if (body.display_name != null) patch.display_name = text(body.display_name);
      if (body.brand_id != null) patch.brand_id = activeBrand(ctx, body.brand_id);
      if (body.owner_id != null) patch.owner_id = text(body.owner_id);
      if (body.default_timezone != null) patch.default_timezone = zone(body.default_timezone);
      return select(ctx.update('social_account', params.id, patch), accountFields);
    }, 'social_account'),
    ...(['disable', 'enable'] as const).map(action => op('POST', `${accountPath}/${action}`, `${action}_social_account`, STAFF, (ctx, { params, body }) => {
      ctx.get('social_account', params.id);
      const affected = impact(ctx, [params.id]);
      if (body.dry_run !== true) {
        ctx.update('social_account', params.id, { status: action === 'enable' ? 'active' : 'disabled' });
        if (action === 'disable') drainConnectorTasks(ctx, row => row.social_account_id === params.id);
        ctx.emit(`account.social_account.${action}d`, { social_account_id: params.id });
      }
      return affected;
    })),
    op('GET', `${accountPath}/capabilities`, 'get_capabilities', READ, (ctx, { params }) => capabilityRows(ctx, params.id, services)),
    op('GET', `${accountPath}/operation-check`, 'check_operation', READ, async (ctx, { params, query }) => {
      const operation = text(query.operation, 80);
      const format = text(query.content_format, 80);
      const account = ctx.get('social_account', params.id);
      const binding = bindingFor(ctx, account.id);
      const session = binding && sessionFor(ctx, binding);
      const paths = await resolveExecutors(ctx, account.id, operation, format, services);
      return { decision: paths.some(path => path.executor !== 'manual') ? 'allow' : paths.length ? 'manual' : 'unsupported',
        paths, auto: binding ? { mode: binding.connector_mode, halt_sources: haltSources(ctx, binding),
          stop_reason: binding.auto_stop_reason, block_id: binding.auto_stop_block_id, daily_cap: binding.daily_cap,
          today_grants: countAutoGrants(ctx, account.id, String(account.default_timezone)),
          identity_status: session?.status, identity_checked_at: session?.verified_at } : null };
    }),
    op('POST', `${accountPath}/capabilities/probe`, 'probe_capabilities', ADMIN, async (ctx, { params }) => {
      const capabilities = await capabilityRows(ctx, params.id, services, true);
      ctx.emit('account.capability.probed', { social_account_id: params.id });
      return { capabilities };
    }),
    op('GET', '/platform-catalog', 'get_platform_catalog', READ, () => Object.entries(providerCatalog).map(([provider, entry]) => ({ provider, ...entry }))),
    op('GET', '/platform-apps', 'list_platform_apps', ADMIN, ctx => ctx.list('platform_app').map(row => ({
      ...select(row, ['provider', 'status', 'distribution', 'scope_version', 'shop_domain']),
      egress_verified: row.provider === 'shopify' ? services.shopifyApp?.(ctx, row.id)?.egressVerified === true : null,
    }))),
    op('POST', '/platform-apps', 'register_platform_app', ADMIN, (ctx, { body }) => {
      if (!services.privateDeployment) fail('PLATFORM_APP_MANAGED_BY_OPS', 403);
      if (body.client_secret != null || body.webhook_secret != null) fail('USE_SECRET_MANAGER', 422);
      const provider = one(body.provider, storeProviders);
      const distribution = provider === 'shopify' ? one(body.distribution, ['merchant_custom'] as const) : 'official';
      const shopDomain = provider === 'shopify' ? text(body.shop_domain, 100) : null;
      if (shopDomain && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.myshopify\.com$/.test(shopDomain)) fail('INVALID_SHOP_DOMAIN', 422);
      if (find(ctx, 'platform_app', { provider, shop_domain: shopDomain })) fail('PLATFORM_APP_ALREADY_REGISTERED');
      const row = ctx.create('platform_app', { provider, distribution, shop_domain: shopDomain, scope_version: text(body.scope_version), status: 'pending' });
      audit(ctx, 'account.platform_app.registered', { platform_app_id: row.id });
      return select(row, ['provider', 'distribution', 'shop_domain', 'scope_version', 'status']);
    }),
    op('PATCH', '/platform-apps/:id', 'update_platform_app', ADMIN, (ctx, { params, body }) => {
      if (!services.privateDeployment) fail('PLATFORM_APP_MANAGED_BY_OPS', 403);
      const app = ctx.get('platform_app', params.id);
      if (app.distribution === 'partner_custom_distribution') fail('PLATFORM_APP_MANAGED_BY_OPS', 403);
      const status = one(body.status, ['pending', 'active', 'disabled'] as const);
      if (status === 'active' && (!services.adapter?.(app.provider as ProviderKey, app.id) ||
        (app.provider === 'shopify' && !services.shopifyApp?.(ctx, app.id)?.egressVerified))) fail('PLATFORM_APP_NOT_READY');
      const row = ctx.update('platform_app', app.id, { status, scope_version: text(body.scope_version) });
      if (app.scope_version !== row.scope_version || status !== 'active') {
        for (const connection of ctx.list('connection').filter(conn => conn.platform_app_id === app.id)) {
          invalidateConnectionCapabilities(ctx, connection.id, 'unverified');
        }
      }
      audit(ctx, 'account.platform_app.updated', { platform_app_id: row.id, status });
      return select(row, ['provider', 'distribution', 'shop_domain', 'scope_version', 'status']);
    }, 'platform_app'),
    op('GET', '/connections', 'list_connections', ADMIN, ctx => ctx.list('connection').map(publicConnection)),
    op('POST', '/connections/oauth/start', 'start_oauth', ADMIN, (ctx, { body }) => startOAuth(ctx, { ...body, brand_id: activeBrand(ctx, body.brand_id) }, one(body.provider, providers), services)),
    op('GET', '/connections/:id/capabilities', 'get_store_capabilities', ADMIN, (ctx, { params, query }) =>
      storeCapabilities(ctx, params.id, query.external_account_id == null ? undefined : text(query.external_account_id), services)),
    op('POST', '/connections/:id/capabilities/probe', 'probe_store_capabilities', ADMIN, (ctx, { params, body }) =>
      storeCapabilities(ctx, params.id, body.external_account_id == null ? undefined : text(body.external_account_id), services, true)),
    op('POST', '/connections/shopify/merchant', 'connect_shopify_merchant', ADMIN, (ctx, { body }) => {
      if (!services.privateDeployment) fail('PLATFORM_APP_MANAGED_BY_OPS', 403);
      return connectShopifyMerchant(ctx, text(body.platform_app_id), activeBrand(ctx, body.brand_id), services);
    }),
    op('GET', '/connections/:id/accounts', 'list_connection_accounts', ADMIN, (ctx, { params }) => {
      const row = ctx.get('connection', params.id);
      if (row.status !== 'active') fail('CONNECTION_INACTIVE');
      return (row.discovered_accounts as { externalAccountId: string; name?: string }[]).map(item => ({ external_account_id: item.externalAccountId, display_name: item.name }));
    }),
    op('POST', '/connections/:id/accounts/link', 'link_accounts', ADMIN, (ctx, { params, body }) => {
      const connection = ctx.get('connection', params.id);
      if (connection.status !== 'active' || (connection.expires_at != null && !(Date.parse(String(connection.expires_at)) > time(ctx)))) fail('CONNECTION_INACTIVE');
      if (storeProviders.includes(connection.provider as ProviderKey)) fail('STORE_FACADE_REQUIRED');
      if (!Array.isArray(body.external_account_ids) || !body.external_account_ids.length || body.external_account_ids.length > 100) fail('INVALID_ACCOUNT_SELECTION', 422);
      const timezone = zone(body.default_timezone ?? 'UTC');
      return [...new Set(body.external_account_ids.map(id => text(id)))].map(id => {
        const accounts = connection.discovered_accounts as { externalAccountId: string; name?: string }[];
        const item = accounts.find(account => account.externalAccountId === id);
        if (!item) fail('PLATFORM_IDENTITY_UNVERIFIED', 422);
        const account = find(ctx, 'social_account', { provider: connection.provider, external_account_id: id }) ?? ctx.create('social_account', {
          provider: connection.provider, external_account_id: id, display_name: item.name || id, brand_id: connection.brand_id,
          owner_id: ctx.actorId, default_timezone: timezone, status: 'active',
        });
        if (account.brand_id !== connection.brand_id) fail('BRAND_MISMATCH', 409);
        const match = { social_account_id: account.id, connection_id: connection.id };
        const existing = find(ctx, 'social_account_connection', match);
        if (!existing) ctx.create('social_account_connection', { ...match, status: 'active' });
        else if (existing.status !== 'active') ctx.update('social_account_connection', existing.id, { status: 'active' });
        return select(account, accountFields);
      });
    }),
    op('POST', '/connections/:id/revoke', 'revoke_connection', ADMIN, (ctx, { params, body }) => {
      const connection = ctx.get('connection', params.id);
      const links = ctx.list('social_account_connection').filter(row => row.connection_id === connection.id);
      const affected = { ...impact(ctx, links.map(row => String(row.social_account_id))),
        store_ids: ctx.list('store').filter(row => row.connection_id === connection.id).map(row => row.id) };
      if (body.dry_run !== true && connection.status !== 'revoked') {
        ctx.update('connection', connection.id, { status: 'revoked', sealed_token: null, revoked_at: ctx.now });
        for (const link of links) ctx.update('social_account_connection', link.id, { status: 'revoked' });
        invalidateConnectionCapabilities(ctx, connection.id, 'needs_authorization');
        for (const task of ctx.list('execution_task')) {
          if (!affected.execution_task_ids.includes(task.id) || !['queued', 'scheduled', 'retryable'].includes(String(task.status)) || task.active_attempt_id) continue;
          const route = Array.isArray(task.route) ? task.route[0] : undefined;
          if (route?.executor !== 'api') continue;
          const alternate = ctx.list('capability').some(cap => cap.social_account_id === task.social_account_id && cap.executor === 'api' &&
            cap.status === 'available' && cap.operation === task.operation && [task.content_format, '*'].includes(cap.content_format) &&
            ctx.list('social_account_connection').some(link => link.connection_id === cap.connection_id && link.status === 'active' && link.social_account_id === task.social_account_id) &&
            ctx.list('connection').some(grant => grant.id === cap.connection_id && grant.purpose === 'social' &&
              grant.status === 'active' && (grant.expires_at == null || time(ctx) < Date.parse(String(grant.expires_at)))));
          if (alternate) continue;
          ctx.update('execution_task', task.id, { status: 'blocked', status_reason: 'connection_revoked', sub_status: 'auth_expired' });
          ctx.emit('execution.task.blocked', { task_id: task.id, publish_target_id: task.publish_target_id, reason: 'connection_revoked' });
        }
        audit(ctx, 'account.connection.revoked', { connection_id: connection.id });
        ctx.emit('account.connection.revoked', { connection_id: connection.id, ...affected });
      }
      return { ...affected, revocation_scope: 'local' };
    }),
    op('GET', '/devices', 'list_devices', ADMIN, ctx => ctx.list('connector_device').map(row => ({ ...select(row, ['name', 'platform', 'owner_id', 'last_seen_at', 'status', 'client_version']), online: online(ctx, row) }))),
    op('POST', '/devices/pairing-codes', 'issue_device_pairing_code', ADMIN, (ctx, { body }) => issuePairingCode(ctx, body)),
    ...(['disable', 'revoke'] as const).map(action => op('POST', `/devices/:id/${action}`, `${action}_device`, ADMIN, (ctx, { params, body }) => {
      const device = ctx.get('connector_device', params.id);
      const bindings = ctx.list('account_execution_binding').filter(row => row.device_id === device.id);
      const affected = impact(ctx, bindings.map(row => String(row.social_account_id)));
      if (body.dry_run !== true) {
        drainConnectorTasks(ctx, row => row.device_id === device.id);
        ctx.update('connector_device', device.id, { status: action === 'revoke' || device.status === 'revoked' ? 'revoked' : 'disabled' });
        for (const mobile of ctx.list('mobile_device').filter(row => row.device_id === device.id && row.status !== 'removed')) ctx.update('mobile_device', mobile.id, { status: 'disabled' });
        audit(ctx, `account.device.${action}`, { device_id: device.id });
      }
      return affected;
    })),
    op('GET', '/mobile-devices', 'list_mobile_devices', ADMIN, (ctx, { query }) => ctx.list('mobile_device').filter(row => ['device_id', 'platform', 'status'].every(key => !query[key] || row[key] === query[key]))
      .map(row => select(row, ['platform', 'device_id', 'model', 'serial_suffix', 'os_version', 'connection', 'status', 'prerequisites_ready', 'driver_version', 'signing_expires_at', 'last_seen_at']))),
    op('POST', '/mobile-devices/:id/approve', 'approve_mobile_device', ADMIN, (ctx, { params, body }) => {
      const phone = ctx.get('mobile_device', params.id);
      if (phone.status !== 'detected' || body.owned_device_confirmed !== true || body.serial_suffix !== phone.serial_suffix || body.model !== phone.model) fail('MOBILE_APPROVAL_MISMATCH');
      if (!online(ctx, ctx.get('connector_device', String(phone.device_id)))) fail('DEVICE_OFFLINE');
      const status = phone.prerequisites_ready && time(ctx) - Date.parse(String(phone.last_seen_at)) < 90_000 ? 'ready' : 'pending_setup';
      ctx.update('mobile_device', phone.id, { approved_at: ctx.now, approved_by: ctx.actorId, status });
      audit(ctx, 'account.mobile_device.approved', { mobile_device_id: phone.id });
      return { id: phone.id, status };
    }),
    ...(['disable', 'enable', 'remove'] as const).map(action => op('POST', `/mobile-devices/:id/${action}`, `${action}_mobile_device`, ADMIN, (ctx, { params, body }) => {
      const phone = ctx.get('mobile_device', params.id);
      if (phone.status === 'removed' || !phone.approved_at) fail('MOBILE_NOT_APPROVED');
      const links = ctx.list('mobile_app_binding').filter(row => row.mobile_device_id === phone.id && row.status !== 'revoked');
      const affected = impact(ctx, links.map(row => String(row.social_account_id)));
      if (body.dry_run === true) return affected;
      if (action === 'remove') {
        if (ctx.list('account_execution_binding').some(row => row.mobile_device_id === phone.id) ||
          ctx.list('binding_migration').some(row => row.target_mobile_device_id === phone.id && row.status === 'draining')) fail('MOVE_EXECUTION_BINDING_FIRST');
        for (const link of links) ctx.update('mobile_app_binding', link.id, { status: 'revoked', revoked_at: ctx.now });
      }
      if (action !== 'enable') drainConnectorTasks(ctx, row => row.mobile_device_id === phone.id);
      ctx.update('mobile_device', phone.id, { status: action === 'enable' ? 'pending_setup' : action === 'disable' ? 'disabled' : 'removed' });
      audit(ctx, `account.mobile_device.${action}`, { mobile_device_id: phone.id });
      return { ...affected, revoke_debug_authorization: action === 'remove' };
    })),
    op('POST', '/mobile-devices/:id/app-bindings', 'bind_mobile_app', ADMIN, (ctx, { params, body }) => {
      const phone = ctx.get('mobile_device', params.id);
      const account = ctx.get('social_account', text(body.social_account_id));
      const app = text(body.app);
      if (phone.status !== 'ready' || account.status !== 'active' || body.owned_account_confirmed !== true || !Object.hasOwn(appProvider, app) || appProvider[app] !== account.provider) fail('MOBILE_APP_BINDING_INVALID', 422);
      const source = bindingFor(ctx, account.id);
      if (activeMigration(ctx, account.id)) fail('MIGRATION_IN_PROGRESS');
      if (ctx.list('mobile_app_binding').some(row => row.status !== 'revoked' &&
        (row.mobile_device_id === phone.id && row.app === app || row.social_account_id === account.id && row.mobile_device_id !== source?.mobile_device_id))) fail('MOBILE_APP_ALREADY_BOUND');
      const row = ctx.create('mobile_app_binding', { app, mobile_device_id: phone.id, device_id: phone.device_id, social_account_id: account.id, status: 'pending_identity', approved_by: ctx.actorId });
      ctx.emit('account.mobile_app.identity_requested', { binding_id: row.id, device_id: phone.device_id });
      return row;
    }),
    op('GET', '/mobile-app-bindings', 'list_mobile_app_bindings', ADMIN, ctx => ctx.list('mobile_app_binding')
      .map(row => select(row, ['social_account_id', 'mobile_device_id', 'device_id', 'app', 'status', 'verified_at', 'revoked_at']))),
    op('GET', '/mobile-app-bindings/:id/impact', 'preview_mobile_app_unbind', ADMIN, (ctx, { params }) => mobileUnbindImpact(ctx, params.id)),
    op('DELETE', '/mobile-app-bindings/:id', 'unbind_mobile_app', ADMIN, (ctx, { params }) => {
      const affected = mobileUnbindImpact(ctx, params.id);
      if (!affected.can_unbind) fail('MOVE_EXECUTION_BINDING_FIRST');
      if (affected.status !== 'revoked') {
        ctx.update('mobile_app_binding', params.id, { status: 'revoked', revoked_at: ctx.now });
        audit(ctx, 'account.mobile_app.unbound', { binding_id: params.id });
      }
      return { ...affected, status: 'revoked' };
    }),
    op('POST', '/mobile-app-bindings/:id/verify', 'verify_mobile_app_identity', STAFF, (ctx, { params }) => {
      const row = ctx.get('mobile_app_binding', params.id);
      if (row.status === 'revoked') fail('BINDING_REVOKED');
      ctx.update('mobile_app_binding', row.id, { status: 'pending_identity' });
      ctx.emit('account.mobile_app.identity_requested', { binding_id: row.id, device_id: row.device_id });
      return { status: 'pending_identity' };
    }),
    op('GET', '/browser-sessions', 'list_browser_sessions', INTERNAL_READ, ctx => ctx.list('browser_session').filter(row => row.status !== 'revoked').map(row => select(row, ['device_id', 'social_account_id', 'status', 'verified_at']))),
    op('POST', '/browser-sessions/:id/request-login', 'request_browser_login', STAFF, (ctx, { params }) => {
      const row = ctx.get('browser_session', params.id);
      if (row.status === 'revoked') fail('BINDING_REVOKED');
      ctx.update('browser_session', row.id, { status: 'pending_identity' });
      ctx.emit('account.browser_session.login_requested', { session_id: row.id, device_id: row.device_id });
      return { status: 'pending_identity' };
    }),
    op('GET', `${migrationPath}/preview`, 'preview_binding_migration', ADMIN, (ctx, { params }) => migrationImpact(ctx, accountBinding(ctx, params.id))),
    op('GET', migrationPath, 'get_binding_migration', ADMIN, (ctx, { params }) => {
      const binding = bindingFor(ctx, params.id);
      ctx.get('social_account', params.id);
      return binding ? migrationStatus(ctx, binding) : { migration: null, impact: null };
    }),
    op('POST', migrationPath, 'start_binding_migration', ADMIN, (ctx, { params, body }) => startMigration(ctx, accountBinding(ctx, params.id), body)),
    op('POST', `${migrationPath}/complete`, 'complete_binding_migration', ADMIN, (ctx, { params }) => completeMigration(ctx, params.id)),
    op('PUT', bindPath, 'set_execution_binding', ADMIN, (ctx, { params, body }) => {
      const account = ctx.get('social_account', params.id);
      if (account.status !== 'active' || (body.connector_mode != null && body.connector_mode !== 'assist')) fail('EXECUTION_BINDING_INVALID');
      const mode = one(body.mode, ['api', 'connector', 'manual', 'hybrid'] as const);
      const needsDevice = mode === 'connector' || mode === 'hybrid';
      const channel = needsDevice ? one(body.connector_channel, ['browser', 'mobile'] as const) : null;
      const device = needsDevice ? ctx.get('connector_device', text(body.device_id)) : undefined;
      if (needsDevice && (!device || device.status !== 'active' || body.owned_account_confirmed !== true)) fail('EXECUTION_BINDING_INVALID');
      const phoneId = channel === 'mobile' ? text(body.mobile_device_id) : null;
      const app = phoneId ? text(body.mobile_app) : null;
      if (phoneId) {
        const phone = ctx.get('mobile_device', phoneId);
        const link = find(ctx, 'mobile_app_binding', { mobile_device_id: phoneId, social_account_id: account.id, app, status: 'verified' });
        if (!link || phone.device_id !== device?.id || phone.status !== 'ready') fail('MOBILE_APP_NOT_VERIFIED');
      }
      const existing = bindingFor(ctx, account.id);
      const affected = impact(ctx, [account.id]);
      if (body.dry_run === true) return affected;
      if (activeMigration(ctx, account.id)) fail('MIGRATION_IN_PROGRESS');
      if (existing?.device_id && needsDevice) {
        if (existing.device_id !== device?.id || existing.connector_channel !== channel || (existing.mobile_device_id ?? null) !== phoneId ||
          (existing.mobile_app ?? null) !== app) fail('USE_BINDING_MIGRATION');
        if (existing.mode === mode) return { binding: existing, ...affected };
        const binding = ctx.update('account_execution_binding', existing.id, { mode });
        ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: account.id });
        return { binding, ...affected };
      }
      if (existing) drainConnectorTasks(ctx, row => row.binding_id === existing.id);
      if (existing && ctx.list('connector_task').some(row => row.binding_id === existing.id && ['claimed', 'outcome_unknown'].includes(String(row.status)))) fail('EXECUTION_DRAIN_REQUIRED');
      const patch = { social_account_id: account.id, mode, connector_channel: channel, device_id: device?.id ?? null, mobile_device_id: phoneId, mobile_app: app, connector_mode: 'assist', paused: false };
      const row = existing ? ctx.update('account_execution_binding', existing.id, patch) : ctx.create('account_execution_binding', patch);
      if (existing) for (const old of ctx.list('browser_session').filter(session => session.binding_id === existing.id && session.status !== 'revoked')) ctx.update('browser_session', old.id, { status: 'revoked' });
      if (channel === 'browser') ctx.create('browser_session', { social_account_id: account.id, device_id: device?.id, binding_id: row.id, status: 'pending_identity' });
      ctx.emit('account.binding.changed', { binding_id: row.id, social_account_id: account.id });
      return { binding: row, ...affected };
    }),
    op('POST', `${bindPath}/auto-mode`, 'enable_auto_mode', ADMIN, (ctx, { params, body }) => {
      const binding = accountBinding(ctx, params.id);
      const terms = services.terms?.();
      if (!terms || body.terms_version !== terms.version || body.risk_acknowledged !== true) fail('AUTO_TERMS_REQUIRED');
      if (ctx.get('social_account', params.id).status !== 'active' || haltSources(ctx, binding).length || blocked(ctx, params.id) || !connectorReady(ctx, binding) || !services.connectorConfigured?.(ctx, binding.id, 'auto')) fail('AUTO_MODE_NOT_READY');
      const configured = bindingLimits(ctx, binding, body);
      const updated = ctx.update('account_execution_binding', binding.id, { ...configured, connector_mode: 'auto', auto_ack_by: ctx.actorId,
        auto_ack_at: ctx.now, auto_ack_terms_version: terms.version, auto_ack_generation: Number(binding.auto_ack_generation ?? 0) + 1, auto_failure_streak: 0, auto_stop_reason: null, auto_stop_block_id: null, auto_stop_terms_version: null, auto_stopped_at: null });
      audit(ctx, 'account.binding.admin', { binding_id: binding.id, terms_version: terms.version, ...configured });
      ctx.emit('account.binding.auto_enabled', { binding_id: binding.id, terms_version: terms.version });
      return updated;
    }),
    op('PATCH', `${bindPath}/auto-mode`, 'update_auto_mode', ADMIN, (ctx, { params, body }) => {
      const binding = accountBinding(ctx, params.id);
      const configured = bindingLimits(ctx, binding, { ...binding, ...body });
      ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: params.id });
      return ctx.update('account_execution_binding', binding.id, configured);
    }),
    op('DELETE', `${bindPath}/auto-mode`, 'disable_auto_mode', ADMIN, (ctx, { params }) => {
      const binding = accountBinding(ctx, params.id);
      ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: params.id });
      return ctx.update('account_execution_binding', binding.id, { connector_mode: 'assist' });
    }),
    ...([true, false] as const).map(halted => op('POST', `${bindPath}/auto-halt${halted ? '' : '/release'}`, halted ? 'halt_account_auto' : 'release_account_auto', halted ? STAFF : ADMIN, (ctx, { params }) => {
      const row = accountBinding(ctx, params.id);
      const updated = ctx.update('account_execution_binding', row.id, { auto_halted: halted, halt_generation: Number(row.halt_generation ?? 0) + 1 });
      audit(ctx, 'account.connector_auto_halt.account', { binding_id: row.id, halted });
      return { halt_sources: haltSources(ctx, updated) };
    })),
    op('GET', '/connector-auto-policy', 'get_connector_auto_policy', READ, ctx => ({ defaults: policy(ctx)?.defaults ?? defaultLimits,
      failure_stop_threshold: policy(ctx)?.failure_stop_threshold ?? 3, halt_sources: haltSources(ctx), terms: services.terms?.() ?? null })),
    op('PUT', '/connector-auto-policy', 'set_connector_auto_policy', ADMIN, (ctx, { body }) => {
      const values = { defaults: limits(body), failure_stop_threshold: integer(body.failure_stop_threshold, 1, 10) };
      setPolicy(ctx, values);
      audit(ctx, 'account.connector_auto_policy.updated', values);
      return values;
    }),
    ...([true, false] as const).map(halted => op('POST', `/connector-auto-policy/${halted ? 'halt' : 'release'}`, halted ? 'halt_workspace_auto' : 'release_workspace_auto', halted ? STAFF : ADMIN, ctx => {
      if (!halted && policy(ctx)?.halted_by_workspace !== true && haltSources(ctx).includes('ops')) fail('HALTED_BY_OPS');
      setPolicy(ctx, { halted_by_workspace: halted, halt_generation: Number(policy(ctx)?.halt_generation ?? 0) + 1 });
      audit(ctx, 'account.connector_auto_halt.workspace', { halted });
      return { halt_sources: haltSources(ctx) };
    })),
    op('GET', '/account-blocks', 'list_account_blocks', READ, (ctx, { query }) => ctx.list('account_block')
      .filter(row => ['status', 'social_account_id'].every(key => !query[key] || row[key] === query[key]))
      .map(row => {
        const affected = impact(ctx, [String(row.social_account_id)]);
        return { ...row, affected_task_count: affected.execution_task_ids.length, affected_connector_task_count: affected.connector_task_ids.length };
      })),
    op('PATCH', '/account-blocks/:id', 'assign_account_block', STAFF, (ctx, { params, body }) => {
      const block = ctx.get('account_block', params.id);
      if (block.status === 'resolved') fail('BLOCK_ALREADY_RESOLVED');
      return ctx.update('account_block', block.id, { status: 'assigned', assignee_id: text(body.assignee_id) });
    }, 'account_block'),
    op('POST', '/account-blocks/:id/resolve', 'resolve_account_block', STAFF, (ctx, { params }) => {
      const block = ctx.get('account_block', params.id);
      const binding = accountBinding(ctx, String(block.social_account_id));
      const session = sessionFor(ctx, binding);
      if (!session || !connectorReady(ctx, binding) || Date.parse(String(session.verified_at)) <= Date.parse(String(block.opened_at))) fail('FRESH_IDENTITY_CHECK_REQUIRED');
      ctx.emit('account.block.resolved', { block_id: block.id });
      return ctx.update('account_block', block.id, { status: 'resolved', resolved_at: ctx.now, resolved_by: ctx.actorId });
    }),
  ];
}

export const operations: Operation[] = createOperations();
export { acceptWebhook, completeOAuth, refreshConnection, connectionContext } from './oauth.ts';
export { pairDevice, deviceRequestBytes } from './device-control.ts';
export { setOpsHalt, recheckTerms } from './auto-control.ts';
export { enqueueConnectorTask, expireConnectorTasks, handleDeviceRequest, reconcileConnectorTask, type ConnectorServices } from './connector-service.ts';
export { createAccountGateway, type AccountGatewayDependencies } from './gateway.ts';
export { mountAccountIngress } from './http.ts';
export { commands, createAccountModule, type CommandServices } from './commands.js';
export { deviceCommandBytes, deviceCommandActions, type SignedDeviceCommand } from './device-ingress.js';
export type { CommandOAuthServices, ConfiguredOAuth, OAuthFlowRequest } from './command-oauth.js';
