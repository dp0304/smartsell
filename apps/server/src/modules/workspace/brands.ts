import { type Context, type Data, type Input, type Row } from '@smartsell/contracts';
import { assertUsageAllowed, recordUsage } from '../ops/metering.js';
import { tenantScope } from '../ops/support.js';
import type { WorkspaceReadContext } from './search.js';
import { activeBrand, conflict, currency, id, invalid, label, locale, missing, obj, one, pick, str, strings, timezone } from './shared.js';

const slug = (value: unknown) => {
  const result = str(value, 'slug', 100);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(result)) return invalid('Invalid slug');
  return result;
};
const workspaceDefaults = { default_timezone: 'UTC', default_ui_locale: 'zh-Hant', reporting_currency: 'USD' };
const settings = (body: Data) => pick(body, {
  name: label, slug, kind: value => one(value, 'kind', ['brand_team', 'agency_client', 'internal']),
  default_timezone: timezone, reporting_currency: currency,
  default_ui_locale: value => one(value, 'default_ui_locale', ['zh-Hant', 'en']),
  settings: value => obj(value, 'settings'),
});
export function workspace(ctx: WorkspaceReadContext) {
  const settings = ctx.list('workspace')[0];
  return { ...workspaceDefaults, name: ctx.workspaceName, ...settings, id: ctx.workspaceId, version: settings?.version ?? 0 };
}
export function updateWorkspace(ctx: Context, { body, expectedVersion }: Input) {
  const previous = ctx.list('workspace')[0];
  if (previous && expectedVersion !== previous.version) conflict('Workspace settings version has changed');
  const patch = settings(body);
  const row = previous ? ctx.update('workspace', previous.id, patch) : ctx.create('workspace', { ...workspaceDefaults, ...patch });
  ctx.emit('workspace.workspace.updated', { workspace_id: ctx.workspaceId });
  return { ...row, id: ctx.workspaceId };
}

function brandFields(body: Data) {
  return pick(body, { name: label, slug, default_market_id: value => value === null ? null : id(value) });
}
function checkBrand(ctx: Context, values: Data, previous?: Row) {
  if (ctx.list('brand').some(row => row.id !== previous?.id && row.slug === values.slug)) conflict('Brand slug already exists');
  if (typeof values.default_market_id === 'string') {
    const market = ctx.get('market', values.default_market_id);
    if (!previous || market.brand_id !== previous.id || market.status !== 'active') missing('Market');
  }
}
export function saveBrand(ctx: Context, { body, params }: Input) {
  const previous = params.id ? activeBrand(ctx, params.id) : undefined;
  const patch = brandFields(body);
  const values = previous ? { ...previous, ...patch } : { name: label(body.name), slug: slug(body.slug), ...patch, status: 'active' };
  checkBrand(ctx, values, previous);
  const metered = tenantScope(ctx) !== undefined;
  if (!previous && metered) assertUsageAllowed(ctx, 'brands', 1);
  const row = previous ? ctx.update('brand', previous.id, patch) : ctx.create('brand', values);
  if (!previous && metered) recordUsage(ctx, 'brands', 1, `brand:${row.id}:created`);
  ctx.emit(`workspace.brand.${previous ? 'updated' : 'created'}`, { brand_id: row.id });
  return row;
}

const unfinishedTarget = (row: Row) => !['published', 'cancelled', 'failed', 'skipped', 'archived', 'closed', 'superseded'].includes(String(row.plan_status ?? row.status));

export function archiveBrand(ctx: Context, { body, params }: Input) {
  const brand = ctx.get('brand', params.id!);
  const references = [
    ['publish_target', unfinishedTarget],
    ['campaign', (row: Row) => !['completed', 'cancelled', 'archived'].includes(String(row.status))],
    ['social_account', (row: Row) => row.status !== 'archived'],
    ['connection', (row: Row) => !['archived', 'revoked', 'disconnected'].includes(String(row.status))],
  ] as const;
  const impact = references.map(([kind, live]) => ({ kind, count: ctx.list(kind).filter(row => row.brand_id === brand.id && live(row)).length }));
  if (body.dry_run !== undefined && typeof body.dry_run !== 'boolean') invalid('Invalid dry_run');
  if (body.dry_run !== false) return { brand, impact };
  if (impact[0]!.count > 0) conflict('Unfinished publish targets block brand archive', { impact });
  if (brand.status === 'archived') return { brand, impact };
  const updated = ctx.update('brand', brand.id, { status: 'archived' });
  const tenant = tenantScope(ctx);
  if (tenant?.list('usage_event').some(row => row.meter_key === 'brands' && row.workspace_id === ctx.workspaceId &&
    (row.source_ref === `brand:${brand.id}:created` || String(row.source_ref).startsWith(`brand:${brand.id}:restored:`)))) {
    recordUsage(ctx, 'brands', -1, `brand:${brand.id}:archived:${updated.version}`);
  }
  ctx.emit('workspace.brand.archived', { brand_id: brand.id });
  return { brand: updated, impact };
}

export function restoreBrand(ctx: Context, { params }: Input) {
  const brand = ctx.get('brand', params.id!);
  if (brand.status === 'active') return brand;
  if (brand.status !== 'archived') conflict('Only archived brands can be restored');
  const metered = tenantScope(ctx) !== undefined;
  if (metered) assertUsageAllowed(ctx, 'brands', 1);
  const restored = ctx.update('brand', brand.id, { status: 'active' });
  if (metered) recordUsage(ctx, 'brands', 1, `brand:${brand.id}:restored:${restored.version}`);
  ctx.emit('workspace.brand.restored', { brand_id: brand.id });
  return restored;
}

const country = (value: unknown) => {
  const result = str(value, 'country_code').toUpperCase();
  if (!/^[A-Z]{2}$/.test(result)) return invalid('Invalid country_code');
  return result;
};
export function saveMarket(ctx: Context, { params, body }: Input, previous?: Row) {
  const brand = activeBrand(ctx, previous ? id(previous.brand_id) : params.id!);
  const fields = pick(body, {
    name: label, country_code: country, primary_language: locale, currency, timezone,
    languages: value => strings(value, 'languages').map(locale),
    sales_channels: value => strings(value, 'sales_channels'),
    status: value => one(value, 'status', ['active', 'paused', 'archived']),
  });
  const market = previous ? { ...previous, ...fields } : {
    name: label(body.name), country_code: country(body.country_code), primary_language: locale(body.primary_language),
    currency: currency(body.currency), timezone: timezone(body.timezone), languages: [], sales_channels: [], status: 'active', ...fields,
  };
  market.languages = [...new Set([market.primary_language, ...strings(market.languages, 'languages')])];
  if (previous && brand.default_market_id === previous.id && market.status !== 'active') conflict('Change the default market before disabling it');
  if (market.status === 'archived' && previous && ctx.list('publish_target').some(row => row.market_id === previous.id && !['published', 'cancelled', 'failed', 'skipped', 'archived'].includes(String(row.status)))) conflict('Unfinished publish targets block market archive');
  if (ctx.list('market').some(row => row.id !== previous?.id && row.brand_id === brand.id && row.country_code === market.country_code && row.primary_language === market.primary_language)) conflict('Market already exists for this country and language');
  const patch = { ...fields, languages: market.languages };
  const row = previous ? ctx.update('market', previous.id, patch) : ctx.create('market', { ...market, brand_id: brand.id });
  ctx.emit(`workspace.market.${previous ? 'updated' : 'created'}`, { brand_id: brand.id, market_id: row.id });
  return row;
}
