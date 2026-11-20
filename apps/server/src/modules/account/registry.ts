import { findPlatform } from '../../extensions/platforms.js';
import { text, type Context, type Entity, type Fields } from '../types.js';
import { approved, choice, emit, ensure, get, idFor, identifier, insert, list, millis, timezone, update } from './model.js';

const stores = ['shopify', 'tiktok_shop', 'amazon_sp', 'shopee', 'lazada', 'file_import'];
export type LicenseSource = (ctx: Context) => Promise<{ social_accounts: number } | undefined>;
export interface ProviderGrant {
  provider: string;
  principalId: string;
  scopes: readonly string[];
  expiresAt: string;
  externalAccountIds: readonly string[];
}

export async function recordGrant(ctx: Context, grant: ProviderGrant, existingConnectionId?: string, flow?: { appId?: string; flowStartedAt: string }) {
  const platform = findPlatform(grant.provider);
  ensure(platform && !['file_import', 'lazada', 'xiaohongshu'].includes(grant.provider), 'provider_authorization_unavailable');
  const principal = text({ principal: grant.principalId }, 'principal', 160);
  const expiresAt = Date.parse(grant.expiresAt);
  ensure(expiresAt > millis(ctx), 'credential_expired');
  ensure(Array.isArray(grant.scopes) && grant.scopes.length <= 100 && Array.isArray(grant.externalAccountIds) && grant.externalAccountIds.length <= 1000, 'invalid_grant', 422);
  const purpose = stores.includes(grant.provider) ? 'store' : 'social';
  const data = {
    provider: grant.provider, purpose, principal_id: principal, status: 'active', expires_at: new Date(expiresAt).toISOString(),
    granted_scopes: [...new Set(grant.scopes.map((scope) => text({ scope }, 'scope', 100)))],
    external_account_ids: purpose === 'social' ? [...new Set(grant.externalAccountIds.map((id) => identifier({ id }, 'id')))] : [],
  };
  const id = idFor(ctx.workspaceId, grant.provider, principal);
  if (existingConnectionId) ensure(existingConnectionId === id, 'connection_principal_mismatch');
  const previous = await ctx.get('account', 'connection', id);
  const revision = (previous?.data.grant_revision ?? 0) + 1;
  if (flow) {
    ensure(!previous?.data.revoked_at || Date.parse(previous.data.revoked_at) < Date.parse(flow.flowStartedAt), 'connection_changed');
    ensure(!previous?.data.platform_app_id || previous.data.platform_app_id === flow.appId, 'connection_app_mismatch');
  }
  const values = { ...data, grant_revision: revision, revoked_at: null, ...(flow?.appId ? { platform_app_id: flow.appId } : {}) };
  const connection = previous ? await update(ctx, previous, values) : await insert(ctx, 'connection', values, id);
  await emit(ctx, 'connection.authorized', { connection_id: id, provider: grant.provider, purpose, granted_scopes: data.granted_scopes });
  if (previous && JSON.stringify([...previous.data.granted_scopes].sort()) !== JSON.stringify([...data.granted_scopes].sort())) {
    await emit(ctx, 'connection.scope_changed', { connection_id: id, granted_scopes: data.granted_scopes });
  }
  return connection;
}

export function connectionActive(ctx: Context, connection: Entity) {
  return connection.data.status === 'active' && Date.parse(connection.data.expires_at) > millis(ctx);
}

export async function revokeConnection(ctx: Context, input: Fields) {
  const connection = await get(ctx, 'connection', identifier(input, 'connection_id'));
  const affected = (await list(ctx, 'social_account_connection')).filter((row) => row.data.connection_id === connection.id).map((row) => row.data.social_account_id);
  if (input.dry_run !== undefined) ensure(typeof input.dry_run === 'boolean', 'invalid_dry_run', 422);
  if (input.dry_run === true) return { connection_id: connection.id, affected_account_ids: affected, status: connection.data.status };
  if (connection.data.status !== 'revoked') {
    await update(ctx, connection, { status: 'revoked', revoked_at: ctx.now });
    await emit(ctx, 'connection.revoked', { connection_id: connection.id, grant_revision: connection.data.grant_revision ?? 0, provider: connection.data.provider, affected_account_ids: affected });
  }
  return { connection_id: connection.id, affected_account_ids: affected, status: 'revoked' };
}

export async function requireCapacity(ctx: Context, source: LicenseSource | undefined) {
  if (!source) return;
  const license = await source(ctx);
  ensure(license && Number.isSafeInteger(license.social_accounts) && license.social_accounts >= 0, 'LICENSE_UNAVAILABLE', 402);
  const accounts = await list(ctx, 'social_account');
  ensure(accounts.filter(({ data }) => data.status === 'active').length < license.social_accounts, 'LICENSE_LIMIT', 402);
  // The host serializes quota transactions at the license scope. The sentinel also fences stale workspace writes.
  const id = 'social_account_quota';
  const lock = await ctx.get('account', 'license_usage', id);
  if (lock) await update(ctx, lock, { touched_at: ctx.now });
  else await insert(ctx, 'license_usage', { touched_at: ctx.now }, id);
}

export async function registerAccount(ctx: Context, input: Fields, license?: LicenseSource) {
  const provider = identifier(input, 'provider');
  ensure(findPlatform(provider) && !stores.includes(provider), 'invalid_social_provider', 422);
  const externalId = identifier(input, 'external_account_id');
  const id = idFor(ctx.workspaceId, provider, externalId);
  const name = text(input, 'name', 100);
  const brand = identifier(input, 'brand_id');
  const zone = timezone(text(input, 'default_timezone', 80));
  const existing = await ctx.get('account', 'social_account', id);
  if (existing) ensure(existing.data.brand_id === brand, 'account_brand_conflict');
  const connectionId = input.connection_id === undefined ? undefined : identifier(input, 'connection_id');
  if (connectionId) {
    const connection = await get(ctx, 'connection', connectionId);
    ensure(connectionActive(ctx, connection) && connection.data.purpose === 'social' && connection.data.provider === provider && connection.data.external_account_ids.includes(externalId), 'account_not_in_grant');
  } else approved(input, 'owned_account_confirmed');
  if (!existing) await requireCapacity(ctx, license);
  const account = existing ?? await insert(ctx, 'social_account', { provider, external_account_id: externalId, name, brand_id: brand, default_timezone: zone, status: 'active', registration_source: connectionId ? 'provider_grant' : 'human_report' }, id);
  if (!existing) await emit(ctx, 'social_account.created', { social_account_id: id, provider });
  if (connectionId) {
    const link = idFor(id, connectionId);
    if (!await ctx.get('account', 'social_account_connection', link)) await insert(ctx, 'social_account_connection', { social_account_id: id, connection_id: connectionId }, link);
  }
  return account;
}

export async function accountStatus(ctx: Context, input: Fields, status: 'active' | 'disabled', license?: LicenseSource) {
  const account = await get(ctx, 'social_account', identifier(input, 'social_account_id'));
  if (account.data.status === status) return account;
  if (status === 'active') await requireCapacity(ctx, license);
  const updated = await update(ctx, account, { status });
  if (status === 'disabled') {
    const binding = await ctx.get('account', 'account_execution_binding', account.id);
    if (binding) await update(ctx, binding, { connector_mode: 'assist', binding_revision: binding.data.binding_revision + 1 });
  }
  await emit(ctx, `social_account.${status === 'active' ? 'enabled' : 'disabled'}`, { social_account_id: account.id });
  return updated;
}

export async function linkedActive(ctx: Context, account: Entity) {
  const links = (await list(ctx, 'social_account_connection')).filter((row) => row.data.social_account_id === account.id);
  const result: Entity[] = [];
  for (const link of links) {
    const conn = await ctx.get('account', 'connection', link.data.connection_id);
    if (conn && connectionActive(ctx, conn) && conn.data.provider === account.data.provider && conn.data.external_account_ids.includes(account.data.external_account_id)) result.push(conn);
  }
  return result;
}

export async function recordManualResult(ctx: Context, input: Fields) {
  const account = await get(ctx, 'social_account', identifier(input, 'social_account_id'));
  const jobId = identifier(input, 'job_id');
  const result = choice(input, 'outcome', ['reported_present', 'reported_absent', 'unknown'] as const);
  const ref = input.external_ref === undefined ? null : text(input, 'external_ref', 300);
  ensure(result !== 'reported_present' || ref, 'external_ref_required', 422);
  const note = text(input, 'note', 1000);
  const row = await insert(ctx, 'manual_result', { social_account_id: account.id, job_id: jobId, outcome: result, external_ref: ref, note, evidence_source: 'human_report', actor_id: ctx.actorId, verified: false });
  await emit(ctx, 'manual_result.recorded', { manual_result_id: row.id, social_account_id: account.id, job_id: jobId, outcome: result, verified: false });
  return row;
}
