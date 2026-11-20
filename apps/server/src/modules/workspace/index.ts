import type { Commands, Context, Entity, Fields } from '../types.js';
import { action, active, add, administer, brandFilter, browse, choice, emit, expected, fields, get, identifier, inBrand, list, listLimit, manage, must, nullable, obj, problems, put, safeTitle, str } from './workbench-core.js';
import { notificationCommands, notificationList, notificationQueries } from './workbench-events.js';
import { onboardingCommands, onboardingQueries } from './workbench-onboarding.js';
import { approvalRows, overviewQueries } from './workbench-overview.js';
import { taskCommands, taskQueries } from './workbench-tasks.js';

export { handleWorkspaceEvent } from './workbench-events.js';
export { operations, applyWorkspaceEvent, scanWorkspaceDue, schedules, subscribers } from './operations.js';

const defaults = { kind: 'brand_team', status: 'active', default_timezone: 'UTC', default_ui_locale: 'zh-Hant', reporting_currency: 'USD' };
async function workspace(ctx: Context) {
  const settings = await get(ctx, 'workspace', ctx.workspaceId);
  return { ...defaults, ...settings?.data, id: ctx.workspaceId, version: settings?.version ?? 0 };
}
const name = (v: unknown) => str(v, 'name');
function slug(v: unknown) {
  const value = str(v, 'slug', 100);
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) ? value : problems.invalid('Invalid slug');
}
function timezone(v: unknown) {
  const value = str(v, 'timezone');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return problems.invalid('Invalid timezone'); }
}
function currency(v: unknown) {
  const value = str(v, 'currency').toUpperCase();
  return /^[A-Z]{3}$/.test(value) ? value : problems.invalid('Invalid currency');
}
function country(v: unknown) {
  const value = str(v, 'country_code').toUpperCase();
  return /^[A-Z]{2}$/.test(value) ? value : problems.invalid('Invalid country_code');
}
function locale(v: unknown) {
  try { return Intl.getCanonicalLocales(str(v, 'language'))[0]!; }
  catch { return problems.invalid('Invalid language'); }
}
function values(v: unknown, field: string, validate: (item: unknown) => string) {
  if (!Array.isArray(v) || v.length > 100) return problems.invalid(`Invalid ${field}`);
  return [...new Set<string>(v.map(validate))];
}
async function activeBrand(ctx: Context, id: string) {
  const row = await must(ctx, 'brand', id);
  if (row.data.status === 'archived') problems.conflict('Brand is archived');
  return row;
}
async function saveBrand(ctx: Context, input: Fields, patching = false) {
  const prev = patching ? await activeBrand(ctx, identifier(input.id)) : undefined;
  if (prev) expected(prev, input);
  const patch = fields(input, { name, slug, logo_file_id: nullable(identifier), default_market_id: nullable(identifier) });
  const data = prev ? { ...prev.data, ...patch } : { ...patch, name: name(input.name), slug: slug(input.slug), status: 'active' } as Fields;
  if ((await list(ctx, 'brand')).some(row => row.id !== prev?.id && row.data.slug === data.slug)) problems.conflict('Brand slug already exists');
  if (data.default_market_id) {
    const market = await must(ctx, 'market', data.default_market_id);
    if (!prev || market.data.brand_id !== prev.id || market.data.status !== 'active') problems.missing('Active market not found');
  }
  const row = prev ? await put(ctx, prev, patch) : await add(ctx, 'brand', data);
  await emit(ctx, `brand.${prev ? 'updated' : 'created'}`, { brand_id: row.id });
  return row;
}
const unfinished = (row: Entity) => !['published', 'cancelled', 'skipped', 'closed', 'archived'].includes(row.data.status);
async function archiveBrand(ctx: Context, input: Fields) {
  const row = await must(ctx, 'brand', identifier(input.id));
  if (input.dry_run !== undefined && typeof input.dry_run !== 'boolean') problems.invalid('Invalid dry_run');
  const refs = [['planning', 'publish_target'], ['campaign', 'campaign'], ['account', 'social_account'], ['account', 'connection']] as const;
  const impact = await Promise.all(refs.map(async ([module, kind]) => ({ kind, count: (await ctx.list(module, kind)).filter(r => inBrand(r, row.id) && (kind === 'publish_target' ? unfinished(r) : active(r) && r.data.status !== 'completed')).length })));
  if (input.dry_run !== false || row.data.status === 'archived') return { brand: row, impact };
  expected(row, input);
  if (impact[0]!.count) problems.conflict('Unfinished publishing targets block brand archive');
  const next = await put(ctx, row, { status: 'archived' });
  await emit(ctx, 'brand.archived', { brand_id: row.id });
  return { brand: next, impact };
}
async function saveMarket(ctx: Context, input: Fields, patching = false) {
  const prev = patching ? await must(ctx, 'market', identifier(input.id)) : undefined;
  if (prev) expected(prev, input);
  const brand = await activeBrand(ctx, prev?.data.brand_id ?? identifier(input.brand_id));
  const patch = fields(input, { name, country_code: country, primary_language: locale, currency, timezone,
    languages: v => values(v, 'languages', locale), sales_channels: v => values(v, 'sales_channels', identifier),
    status: v => choice(v, 'status', ['active', 'paused', 'archived']) });
  const data: Fields = prev ? { ...prev.data, ...patch } : { languages: [], sales_channels: [], status: 'active', ...patch,
    name: name(input.name), country_code: country(input.country_code), primary_language: locale(input.primary_language), currency: currency(input.currency), timezone: timezone(input.timezone), brand_id: brand.id };
  if (prev && prev.id === brand.data.default_market_id && data.status !== 'active') problems.conflict('Change the default market first');
  if (prev && data.status === 'archived' && (await ctx.list('planning', 'publish_target')).some(row => row.data.market_id === prev.id && unfinished(row))) problems.conflict('Unfinished publishing targets block market archive');
  if ((await list(ctx, 'market')).some(row => row.id !== prev?.id && row.data.brand_id === brand.id && row.data.country_code === data.country_code && row.data.primary_language === data.primary_language)) problems.conflict('Market already exists for this country and language');
  const languages = [...new Set([data.primary_language, ...data.languages])];
  const row = prev ? await put(ctx, prev, { ...patch, languages }) : await add(ctx, 'market', { ...data, languages });
  await emit(ctx, `market.${prev ? 'updated' : 'created'}`, { market_id: row.id, brand_id: brand.id });
  return row;
}

const menu = [
  ['home', 'home'], ['summary', 'home/summary'], ['me', 'me'], ['campaign', 'campaigns'], ['commerce', 'commerce'], ['content', 'content'],
  ['planning', 'calendar'], ['execution', 'execution'], ['inbox', 'inbox'], ['analytics', 'reports'], ['asset', 'assets'], ['intel', 'research'],
  ['creator', 'creators'], ['traffic', 'traffic'], ['ads', 'ads'], ['lifecycle', 'lifecycle'], ['ingest', 'data'], ['agent', 'automation'],
  ['account', 'settings/accounts'], ['workspace', 'settings/brands'], ['team', 'settings/members', manage], ['onboarding', 'setup', manage], ['ops', 'settings/ops', administer],
] as const;
async function navigation(ctx: Context) {
  const [routes, providers, settings] = await Promise.all([ctx.list('agent', 'model_route'), ctx.list('agent', 'model_provider'), workspace(ctx)]);
  const enabled = new Set(providers.filter(row => row.data.enabled === true).map(row => row.id));
  const purposes = routes.filter(row => row.data.enabled === true && enabled.has(row.data.provider_id)).map(row => row.data.purpose ?? row.id).sort();
  const ai = Object.fromEntries(['draft', 'translate', 'classify', 'analyze', 'plan', 'embed'].map(purpose => [purpose, purposes.includes(purpose)]));
  const base = `/w/${encodeURIComponent(ctx.workspaceId)}/`;
  return { workspace_id: ctx.workspaceId, role: ctx.role, default_ui_locale: settings.default_ui_locale,
    items: menu.filter(([, , roles]) => !roles || (roles as readonly string[]).includes(ctx.role)).map(([key, route]) => ({ key, route: base + route })), ai };
}
const searchable = { brand: 'workspace', market: 'workspace', work_item: 'workspace', campaign: 'campaign', content_item: 'content', asset: 'asset', product: 'commerce', conversation: 'inbox', customer: 'lifecycle', creator: 'creator' } as const;
const tokenize = (value: string) => value.normalize('NFKC').toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{L}\p{N}_-]+/gu) ?? [];
function terms(value: string) {
  return tokenize(value).flatMap(word => {
    if (![...word].some(ch => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(ch))) return [word];
    const chars = [...word];
    return chars.length === 1 ? chars : chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
  });
}
async function search(ctx: Context, input: Fields) {
  const query = str(input.q, 'q', 200);
  const brand = await brandFilter(ctx, input.brand_id);
  const selected = input.types === undefined ? Object.keys(searchable) : values(input.types, 'types', v => choice(v, 'type', Object.keys(searchable)));
  const tokens = terms(query);
  if (!tokens.length) problems.invalid('Search requires a letter or number');
  const result = (await Promise.all(selected.map(async kind => {
    const module = searchable[kind as keyof typeof searchable];
    // Cabinet-specific and revenue-bearing records remain behind the owning role boundary.
    if (kind === 'customer' && !manage.some(role => role === ctx.role)) return [];
    const rows = await ctx.list(module, kind);
    return rows.filter(row => active(row) && !row.data.merged_into_id && (inBrand(row, brand) || kind === 'brand' && row.id === brand)).flatMap(row => {
      const title = safeTitle(row, kind);
      const haystack = `${title} ${row.id}`.normalize('NFKC').toLowerCase();
      if (!tokens.every(token => haystack.includes(token))) return [];
      return [{ module, kind, id: row.id, title, status: row.data.status ?? null, brand_id: row.data.brand_id ?? null, updated_at: row.updated_at }];
    });
  }))).flat();
  result.sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { total: result.length, items: result.slice(0, listLimit(input.limit)) };
}
async function personalInbox(ctx: Context, input: Fields) {
  const brand = await brandFilter(ctx, input.brand_id);
  const limit = listLimit(input.limit);
  const [work, approval, notifications, subscriptions] = await Promise.all([
    list(ctx, 'work_item'), approvalRows(ctx, brand), notificationList(ctx, { brand_id: brand, limit: 100 }), list(ctx, 'subscription'),
  ]);
  const tasks = work.filter(row => inBrand(row, brand) && row.data.assignee_id === ctx.actorId && !['done', 'cancelled'].includes(row.data.status));
  const represented = new Set(tasks.filter(row => row.data.event_family === 'approval').map(row => row.data.resource_id));
  const items = [...tasks.map(row => ({ type: 'work_item', row })), ...approval.filter(row => !represented.has(row.id)).map(row => ({ type: 'approval', row })),
    ...notifications.items.filter(row => row.data.type === 'mentioned').map(row => ({ type: 'mention', row }))];
  const following = [];
  for (const subscription of subscriptions) {
    if (subscription.data.user_id !== ctx.actorId || subscription.data.active === false) continue;
    const kind = subscription.data.resource_type as keyof typeof searchable;
    if (!Object.hasOwn(searchable, kind)) continue;
    const source = await ctx.get(searchable[kind], kind, subscription.data.resource_id);
    if (source && active(source) && inBrand(source, brand)) following.push(subscription);
  }
  return { total: items.length, items: items.sort((a, b) => b.row.updated_at.localeCompare(a.row.updated_at) || a.row.id.localeCompare(b.row.id)).slice(0, limit), following: following.slice(0, limit) };
}

export const queries: Commands = {
  ...taskQueries, ...notificationQueries, ...overviewQueries, ...onboardingQueries,
  get_workspace: action(browse, workspace), navigation: action(browse, navigation), search: action(browse, search), me_inbox: action(browse, personalInbox),
  list_brands: action(browse, async (ctx, input) => ({ items: (await list(ctx, 'brand')).filter(row => input.status === undefined || row.data.status === input.status) })),
  get_brand: action(browse, (ctx, input) => must(ctx, 'brand', identifier(input.id))),
  list_markets: action(browse, async (ctx, input) => { const brand = await brandFilter(ctx, input.brand_id); return { items: (await list(ctx, 'market')).filter(row => inBrand(row, brand)) }; }),
  get_market: action(browse, (ctx, input) => must(ctx, 'market', identifier(input.id))),
  get_context: action(browse, async (ctx, input) => {
    const brand = await brandFilter(ctx, input.brand_id);
    const [settings, brands, markets, accounts] = await Promise.all([workspace(ctx), list(ctx, 'brand'), list(ctx, 'market'), ctx.list('account', 'social_account')]);
    return { workspace: settings, role: ctx.role, actor_id: ctx.actorId, brands: brands.filter(row => !brand || row.id === brand), markets: markets.filter(row => inBrand(row, brand)),
      accounts: accounts.filter(row => active(row) && inBrand(row, brand)).map(row => ({ id: row.id, brand_id: row.data.brand_id, name: safeTitle(row, 'Account'), provider: row.data.provider, status: row.data.status })) };
  }),
};
export const commands: Commands = {
  ...queries, ...taskCommands, ...notificationCommands, ...onboardingCommands,
  update_workspace: action(administer, async (ctx, input) => {
    const row = await get(ctx, 'workspace', ctx.workspaceId);
    if (row) expected(row, input);
    const data = fields(input, { name, slug, default_timezone: timezone, reporting_currency: currency,
      default_ui_locale: v => choice(v, 'default_ui_locale', ['zh-Hant', 'en']), settings: v => obj(v, 'settings') });
    if (!Object.keys(data).length) problems.invalid('Supply a workspace settings change');
    const next = row ? await put(ctx, row, data) : await add(ctx, 'workspace', { ...defaults, ...data }, ctx.workspaceId);
    await emit(ctx, 'workspace.updated', { workspace_id: ctx.workspaceId });
    return next;
  }),
  create_brand: action(manage, saveBrand), update_brand: action(manage, (ctx, input) => saveBrand(ctx, input, true)), archive_brand: action(manage, archiveBrand),
  create_market: action(manage, saveMarket), update_market: action(manage, (ctx, input) => saveMarket(ctx, input, true)),
};
