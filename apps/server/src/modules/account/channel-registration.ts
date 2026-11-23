import { ADMIN, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { createWorkerStore } from '../commerce/store-operations.js';
import { bindRegisteredWorkerStore, externalStoreId, workerCatalogBindingFor } from '../commerce/worker-catalog.js';
import { saveBrand } from '../workspace/brands.js';
import { bindingFor, sessionFor } from './device-control.js';
import { audit, fail, matches, object, one, text, time } from './input.js';
import { activeMigration } from './migration.js';
import { storeProviders } from './oauth.js';
import { createOwnedSocialAccount, ownedSocialProviders } from './social-accounts.js';

type SocialProvider = typeof ownedSocialProviders[number];
type Selection = { external_id: string; identity: string; display_name: string; observed_at: string; portal_url?: string } & (
  { kind: 'social'; platform: SocialProvider } | { kind: 'store'; platform: typeof storeProviders[number] }
);

const socialHosts: Record<SocialProvider, readonly string[]> = {
  douyin: ['creator.douyin.com', 'www.douyin.com'],
  xiaohongshu: ['creator.xiaohongshu.com', 'www.xiaohongshu.com'],
  tiktok: ['www.tiktok.com', 'tiktok.com', 'studio.tiktok.com'],
  meta_instagram: ['www.instagram.com', 'instagram.com', 'business.facebook.com'],
  meta_facebook: ['www.facebook.com', 'facebook.com', 'business.facebook.com'],
  youtube: ['studio.youtube.com', 'www.youtube.com', 'youtube.com'],
};
const socialIdentities: Record<SocialProvider, RegExp> = {
  douyin: /^[A-Za-z0-9_.-]{2,64}$/,
  xiaohongshu: /^[0-9a-f]{24}$/,
  tiktok: /^[0-9]{8,25}$/,
  meta_instagram: /^[0-9]{1,32}$/,
  meta_facebook: /^[0-9]{1,32}$/,
  youtube: /^UC[A-Za-z0-9_-]{22}$/,
};
const maxObservationAge = 30 * 60_000;
const timestamp = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

function onlyFields(body: Data, allowed: readonly string[]) {
  if (Object.keys(body).some(key => !allowed.includes(key))) fail('INVALID_WORKER_CHANNEL_INPUT', 422);
}

function storeIdentity(platform: string, id: string) {
  if (platform !== 'shopify') return id;
  return /^[a-z0-9][a-z0-9-]*(?:\.myshopify\.com)?$/i.test(id) ? id.toLowerCase() : id;
}

function parseSelection(ctx: Context, value: unknown): Selection {
  const row = object(value);
  onlyFields(row, ['kind', 'platform', 'external_id', 'display_name', 'observed_at', 'portal_url']);
  const kind = one(row.kind, ['social', 'store'] as const);
  const raw = text(row.external_id, 160).trim();
  if (/^https?:/i.test(raw)) fail('INVALID_WORKER_CHANNEL_INPUT', 422);
  const at = matches(row.observed_at, timestamp, 40);
  const observed = Date.parse(at);
  const date = at.slice(0, 10);
  if (!Number.isFinite(observed) || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) fail('INVALID_WORKER_CHANNEL_INPUT', 422);
  if (time(ctx) - observed > maxObservationAge || observed - time(ctx) > 60_000) fail('WORKER_CHANNEL_OBSERVATION_EXPIRED', 422);
  const displayName = row.display_name === undefined ? undefined : text(row.display_name, 160).trim();
  if (displayName && /[\p{Cc}\p{Cf}\p{Cs}]/u.test(displayName)) fail('INVALID_WORKER_CHANNEL_INPUT', 422);
  const portal = row.portal_url === undefined ? undefined : text(row.portal_url, 2048);
  const url = portal === undefined ? undefined : URL.parse(portal);
  if (portal !== undefined && (!url || !/^https:\/\/[^/?#@]+(?:\/|$)/.test(portal) || /[\\\s?#]/u.test(portal) || url.username || url.password || url.port)) {
    fail('WORKER_CHANNEL_PORTAL_INVALID', 422);
  }
  const common = { observed_at: new Date(observed).toISOString(), portal_url: portal };
  if (kind === 'social') {
    const platform = one(row.platform, ownedSocialProviders);
    const externalId = matches(raw, socialIdentities[platform], 128);
    if (url && !socialHosts[platform].includes(url.hostname)) fail('WORKER_CHANNEL_PORTAL_INVALID', 422);
    return { ...common, kind, platform, external_id: externalId, identity: externalId, display_name: displayName ?? externalId };
  }
  const platform = one(row.platform, storeProviders);
  const externalId = externalStoreId(raw);
  if (platform === 'amazon_sp' && !/^[A-Z0-9]{8,32}$/.test(externalId)) fail('INVALID_WORKER_CHANNEL_INPUT', 422);
  if (platform === 'shopify' && !/^[a-z0-9][a-z0-9-]*(?:\.myshopify\.com)?$/i.test(externalId)) fail('INVALID_WORKER_CHANNEL_INPUT', 422);
  return { ...common, kind, platform, external_id: externalId, identity: storeIdentity(platform, externalId), display_name: displayName ?? externalId };
}

function registrationAuthorizer(ctx: Context, device: Row) {
  const members = (ctx as Context & { activeWorkspaceMembers?: readonly { userId: string; role: Role; scopes?: readonly string[] }[] }).activeWorkspaceMembers;
  // Explicit reauthorization can adopt a legacy pairing without changing its original owner or key.
  const authorizerId = device.channel_registration_authorized_by ?? device.owner_id;
  const authorizer = members?.find(member => member.userId === authorizerId);
  if (device.allow_channel_registration !== true || !authorizer || !ADMIN.includes(authorizer.role) || authorizer.scopes?.length) {
    fail('WORKER_CHANNEL_REGISTRATION_NOT_AUTHORIZED', 403);
  }
  return authorizer.userId;
}

function intakeBrand(ctx: Context) {
  const allocated = ctx.list('worker_channel_scope')[0];
  if (allocated) return String(allocated.brand_id);
  const slugs = new Set(ctx.list('brand').map(row => row.slug));
  const base = 'worker-channels';
  let slug = base;
  for (let suffix = 2; slugs.has(slug); suffix++) slug = `${base}-${suffix}`;
  const brand = saveBrand(ctx, { body: { name: 'Worker channels', slug }, params: {}, query: {} });
  ctx.create('worker_channel_scope', { brand_id: brand.id });
  return brand.id;
}

function assertBrandScope(ctx: Context, brandId: unknown, alreadyAssigned: boolean) {
  if (typeof brandId !== 'string' || !ctx.list('brand').some(row => row.id === brandId && row.status === 'active')) {
    fail('WORKER_CHANNEL_BRAND_INACTIVE', 409);
  }
  if (!alreadyAssigned && !ctx.list('worker_channel_scope').some(row => row.brand_id === brandId)) fail('WORKER_CHANNEL_BRAND_SCOPE', 403);
}

function bindSocial(ctx: Context, account: Row, device: Row, observedAt: string) {
  if (account.status !== 'active' || activeMigration(ctx, account.id)) fail('WORKER_CHANNEL_ACCOUNT_UNAVAILABLE', 409);
  const existing = bindingFor(ctx, account.id);
  if (existing && (existing.device_id !== device.id || existing.connector_channel !== 'browser' ||
      !['connector', 'hybrid'].includes(String(existing.mode)))) fail('WORKER_CHANNEL_ALREADY_BOUND', 409);
  assertBrandScope(ctx, account.brand_id, Boolean(existing));
  const binding = existing ?? ctx.create('account_execution_binding', {
    social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id,
    mobile_device_id: null, mobile_app: null, connector_mode: 'assist', paused: false,
  });
  const session = sessionFor(ctx, binding);
  if (session?.status === 'verified') return;
  if (session && session.status !== 'pending_identity') fail('WORKER_CHANNEL_SESSION_UNAVAILABLE', 409);
  const status = { status: 'verified', verified_at: ctx.now, observed_at: observedAt };
  if (session) ctx.update('browser_session', session.id, status);
  else ctx.create('browser_session', { social_account_id: account.id, binding_id: binding.id, device_id: device.id, ...status });
  if (!existing) ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: account.id });
}

export function registerWorkerChannels(ctx: Context, device: Row, body: Data) {
  const authorizerId = registrationAuthorizer(ctx, device);
  onlyFields(body, ['confirmed', 'selections']);
  if (body.confirmed !== true || !Array.isArray(body.selections) || !body.selections.length || body.selections.length > 32) {
    fail('INVALID_WORKER_CHANNEL_INPUT', 422);
  }
  const selections = new Map<string, Selection>();
  for (const input of body.selections) {
    const selection = parseSelection(ctx, input);
    const key = JSON.stringify([selection.kind, selection.platform, selection.identity]);
    if (!selections.has(key)) selections.set(key, selection);
  }
  const authorizerContext = { ...ctx, actorId: authorizerId };
  const registrations = [...selections.values()].map(selection => {
    const { kind, platform, external_id, identity, display_name, observed_at, portal_url } = selection;
    const rows = kind === 'social'
      ? ctx.list('social_account').filter(row => row.provider === platform && row.external_account_id === external_id)
      : ctx.list('store').filter(row => row.provider === platform && typeof row.external_store_id === 'string' && storeIdentity(platform, row.external_store_id) === identity);
    if (rows.length > 1) fail('WORKER_CHANNEL_IDENTITY_AMBIGUOUS', 409);
    let resource = rows[0];
    if (kind === 'social') {
      resource ??= createOwnedSocialAccount(authorizerContext, { provider: platform, external_account_id: external_id, display_name,
        brand_id: intakeBrand(ctx), owner_id: authorizerId, default_timezone: 'UTC' }, 'worker_channel_registration');
      bindSocial(ctx, resource, device, observed_at);
    } else {
      resource ??= createWorkerStore(ctx, { provider: platform, external_store_id: identity, name: display_name, brand_id: intakeBrand(ctx) });
      const binding = workerCatalogBindingFor(ctx, resource.id);
      if (binding && binding.device_id !== device.id) fail('WORKER_CHANNEL_ALREADY_BOUND', 409);
      assertBrandScope(ctx, resource.brand_id, Boolean(binding));
      bindRegisteredWorkerStore(authorizerContext, resource, device, portal_url);
    }
    if (!rows.length) audit(ctx, 'account.worker_channel.registered', { kind, platform, resource_id: resource.id, device_id: device.id, approved_by: authorizerId });
    return { kind, platform, external_id, resource_id: resource.id, device_id: device.id };
  });
  return { registrations };
}
