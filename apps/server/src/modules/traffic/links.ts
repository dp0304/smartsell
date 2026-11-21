import { randomBytes } from 'node:crypto';
import { ADMIN, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { conflict, destination, host, invalid, items, missing, object, oneOf, optional, safeUrl, slug, text, time } from './operation-policy.js';

const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id'] as const;
const tokens = ['platform', 'account.handle', 'campaign.slug', 'content.short_id', 'creator.handle'];
const bindings = ['brand_id', 'campaign_id', 'content_item_id', 'publish_target_id', 'collaboration_id', 'product_variant_id', 'market_id'];
const linkStatuses = ['active', 'paused', 'expired', 'archived'] as const;

function utm(value: unknown, vars?: Data, rules: Data = {}): Record<string, string> {
  const result: Record<string, string> = {};
  const max = rules.max_len === undefined ? 100 : rules.max_len;
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 1 || max > 150) invalid('Invalid UTM max length');
  for (const [key, raw] of Object.entries(object(value))) {
    oneOf(key, utmKeys, 'UTM key');
    let value = text(raw, key);
    value = value.replace(/\{([^{}]+)\}/g, (_, token: string) => {
      if (!tokens.includes(token) || (vars && !Object.hasOwn(vars, token))) invalid(`Missing or unknown UTM token ${token}`);
      return vars ? text(vars[token], token).replace(/\s+/g, '-') : `{${token}}`;
    });
    if (vars || !/[{}]/.test(value)) {
      if (rules.lowercase === true) value = value.toLowerCase();
      if (value.length > max || !/^[a-z0-9_.-]+$/i.test(value)) invalid(`Invalid ${key}`);
    } else if (/[{}]/.test(value.replace(/\{[^{}]+\}/g, ''))) invalid(`Invalid ${key}`);
    result[key] = value;
  }
  return result;
}
function buildUtm(ctx: Context, body: Data) {
  if (!body.utm_template_id) return utm(body.utm_params ?? {}, {});
  const template = ctx.get('utm_template', text(body.utm_template_id, 'utm_template_id'));
  return utm(template.params, object(body.variables ?? {}), object(template.rules ?? {}));
}
function finalUrl(base: URL, params: Record<string, string>): string {
  const url = new URL(base);
  for (const key of utmKeys) url.searchParams.delete(key);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}
function destinationInput(ctx: Context, body: Data, link: Data) {
  const ref = body.landing_destination_id ? ctx.get('landing_destination', text(body.landing_destination_id, 'landing_destination_id')) : undefined;
  if (ref && (ref.status !== 'active' || body.destination_url !== undefined)) invalid('Select exactly one active destination');
  if (ref?.product_variant_id && ref.product_variant_id !== link.product_variant_id) invalid('Destination product does not match the short link');
  const base = destination(ctx, ref?.url ?? body.destination_url, optional(link.product_variant_id, 'product_variant_id'), link.market_id);
  const params = buildUtm(ctx, body);
  const routes = items(body.market_routes ?? [], 20).map(value => {
    const route = object(value);
    const market_id = slug(route.market_id);
    return { market_id, label: text(route.label, 'label'), url: destination(ctx, route.url, optional(link.product_variant_id, 'product_variant_id'), market_id).href };
  });
  if (new Set(routes.map(route => route.market_id)).size !== routes.length) invalid('Duplicate market route');
  return { destination_url: base.href, utm_params: params, final_url: finalUrl(base, params), market_routes: routes,
    landing_destination_id: ref?.id ?? null };
}
function duplicateUtm(ctx: Context, campaign: unknown, params: Data, except?: string): boolean {
  const keys = Object.keys(params).sort();
  if (!campaign || !keys.length) return false;
  return ctx.list('short_link').filter(row => row.campaign_id === campaign && row.id !== except && row.status !== 'archived' && typeof row.current_revision_id === 'string').some(row => {
    const other = object(ctx.get('short_link_revision', String(row.current_revision_id)).utm_params);
    return Object.keys(other).length === keys.length && keys.every(key => other[key] === params[key]);
  });
}
function draftLink(ctx: Context, body: Data) {
  const domain = ctx.get('link_domain', text(body.domain_id, 'domain_id'));
  if (domain.verification_status !== 'verified' || domain.tls_status !== 'active') invalid('Link domain is not ready');
  const code = body.code === undefined ? randomBytes(8).toString('hex') : slug(body.code);
  if (['p','b','f','api','assets','health','landing','unsubscribe'].includes(code)) invalid('Reserved short code');
  const refs: Data = {};
  for (const key of bindings) if (body[key] !== undefined) refs[key] = text(body[key], key);
  const link = { ...refs, brand_id: text(body.brand_id, 'brand_id'), domain_id: domain.id, code, status: 'active',
    expires_at: time(body.expires_at, 'expires_at'), fallback_url: body.fallback_url == null ? null : destination(ctx, body.fallback_url, optional(refs.product_variant_id, 'product_variant_id'), refs.market_id).href,
    locked_after_publish: true };
  const revision = destinationInput(ctx, body, link);
  if (link.expires_at && link.expires_at <= ctx.now) invalid('An active link must expire in the future');
  return { link, revision, duplicate_utm: duplicateUtm(ctx, refs.campaign_id, revision.utm_params) };
}
function createLink(ctx: Context, draft: ReturnType<typeof draftLink>) {
  const { link, revision, duplicate_utm } = draft;
  if (ctx.list('short_link').some(row => row.code === link.code && row.domain_id === link.domain_id)) conflict('Short code already exists');
  const row = ctx.create('short_link', link);
  const rev = ctx.create('short_link_revision', { ...revision, short_link_id: row.id, revision_no: 1, change_reason: 'created' });
  const saved = ctx.update('short_link', row.id, { current_revision_id: rev.id });
  ctx.emit('traffic.short_link.created', { short_link_id: row.id, revision_id: rev.id });
  return { ...saved, duplicate_utm };
}
function inUse(ctx: Context, id: string) {
  return ctx.list('platform_post').filter(row => row.short_link_id === id || (Array.isArray(row.short_link_ids) && row.short_link_ids.includes(id))).map(row => row.id);
}
export function linkStats(ctx: Context, linkIds: Set<string>, query: Record<string, string>) {
  const since = time(query.since, 'since');
  const until = time(query.until, 'until');
  if (since && until && since >= until) invalid('Invalid stats period');
  const period = oneOf(query.interval ?? 'day', ['hour','day'], 'interval');
  const groups = new Map<string, { redirects: number; human_likely: number; bot_filtered: number; unknown: number; visitors: Set<string> }>();
  for (const row of ctx.list('click_event')) {
    if (!linkIds.has(String(row.short_link_id)) || typeof row.occurred_at !== 'string' ||
      (since && row.occurred_at < since) || (until && row.occurred_at >= until) || (query.revision_id && query.revision_id !== row.revision_id)) continue;
    const key = row.occurred_at.slice(0, period === 'hour' ? 13 : 10);
    const group = groups.get(key) ?? { redirects: 0, human_likely: 0, bot_filtered: 0, unknown: 0, visitors: new Set<string>() };
    group.redirects++;
    if (row.classification === 'human_likely') {
      group.human_likely++;
      if (typeof row.daily_visitor_hash === 'string') group.visitors.add(row.daily_visitor_hash);
    } else if (row.classification === 'unknown') group.unknown++;
    else group.bot_filtered++;
    groups.set(key, group);
  }
  return { interval: period, items: [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([period_start, { visitors, ...counts }]) => ({ period_start, ...counts,
    daily_unique_estimate: visitors.size ? visitors.size : null, estimate: true })) };
}

function listing(ctx: Context, body: Data, previous?: Row) {
  const input = { ...previous, ...body };
  const kind = oneOf(input.kind, ['store_product', 'store_collection', 'external_page', 'own_landing_page'], 'kind');
  const variant = optional(input.product_variant_id, 'product_variant_id');
  if (kind === 'store_product' && !variant) invalid('Store product requires a product variant');
  return { kind, url: destination(ctx, input.url, variant, input.market_id).href, brand_id: text(input.brand_id, 'brand_id'),
    market_id: optional(input.market_id, 'market_id') ?? null, product_variant_id: variant ?? null, campaign_id: optional(input.campaign_id, 'campaign_id') ?? null,
    expected_language: optional(input.expected_language, 'expected_language') ?? null,
    status: oneOf(input.status ?? 'active', ['active', 'archived'], 'status') };
}

export const linkOperations: Operation[] = [
  { method: 'GET', path: '/short-links', name: 'links_list', roles: READ, summary: 'List workspace short links', run: (ctx, { query }) => ctx.list('short_link').filter(row => bindings.every(key => !query[key] || query[key] === row[key])) },
  { method: 'POST', path: '/short-links', name: 'links_create', roles: WRITE, summary: 'Create a tracked short link', run: (ctx, { body }) => createLink(ctx, draftLink(ctx, body)) },
  { method: 'GET', path: '/short-links/:id', name: 'links_get', roles: READ, summary: 'Read link and destination revisions', run: (ctx, { params }) => ({ ...ctx.get('short_link', params.id!), revisions: ctx.list('short_link_revision').filter(row => row.short_link_id === params.id), platform_post_ids: inUse(ctx, params.id!) }) },
  { method: 'PATCH', path: '/short-links/:id', name: 'links_update', roles: WRITE, versionKind: 'short_link', summary: 'Pause or archive a short link', run(ctx, { body, params }) {
    const row = ctx.get('short_link', params.id!);
    if (row.status === 'archived') conflict('Archived links are immutable');
    const status = oneOf(body.status ?? row.status, linkStatuses, 'status');
    const expires_at = body.expires_at === undefined ? row.expires_at : time(body.expires_at, 'expires_at');
    if (status === 'active' && typeof expires_at === 'string' && expires_at <= ctx.now) invalid('An active link must expire in the future');
    return ctx.update('short_link', row.id, { status, expires_at });
  } },
  { method: 'POST', path: '/short-links/:id/destination', name: 'links_change_destination', roles: WRITE, versionKind: 'short_link', summary: 'Append a destination revision', run(ctx, { body, params }) {
    const row = ctx.get('short_link', params.id!);
    if (row.status === 'archived') conflict('Archived links are immutable');
    if (row.locked_after_publish && inUse(ctx, row.id).length && body.confirm_in_use !== true) conflict('Published posts use this short link. Confirm the change explicitly.');
    const change_reason = text(body.reason, 'reason');
    const previous = ctx.get('short_link_revision', text(row.current_revision_id, 'current_revision_id'));
    const data = destinationInput(ctx, {
      ...body,
      utm_params: body.utm_params ?? (body.utm_template_id ? undefined : previous.utm_params),
      market_routes: body.market_routes ?? previous.market_routes ?? [],
    }, row);
    const rev = ctx.create('short_link_revision', { ...data, short_link_id: row.id, revision_no: Number(previous.revision_no) + 1, change_reason });
    ctx.update('short_link', row.id, { current_revision_id: rev.id });
    ctx.emit('traffic.short_link.destination_changed', { short_link_id: row.id, previous_revision_id: previous.id, revision_id: rev.id });
    return { ...rev, duplicate_utm: duplicateUtm(ctx, row.campaign_id, data.utm_params, row.id) };
  } },
  { method: 'GET', path: '/short-links/:id/stats', name: 'links_get_stats', roles: READ, summary: 'Separate observed redirects from likely human traffic', run(ctx, { params, query }) {
    const id = params.id ?? query.short_link_id;
    const links = id ? [ctx.get('short_link', id)] : ctx.list('short_link').filter(row => query.campaign_id && row.campaign_id === query.campaign_id);
    if (!id && !query.campaign_id) invalid('Provide a link or campaign');
    return linkStats(ctx, new Set(links.map(row => row.id)), query);
  } },
  { method: 'POST', path: '/short-links/batch', name: 'links_batch', roles: WRITE, summary: 'Preview or create a batch of short links', run(ctx, { body }) {
    const drafts = items(body.links).map(entry => draftLink(ctx, object(entry)));
    const codes = drafts.map(draft => JSON.stringify([draft.link.domain_id, draft.link.code]));
    if (new Set(codes).size !== codes.length) invalid('Duplicate short code in batch');
    return body.dry_run === false ? drafts.map(draft => createLink(ctx, draft)) : drafts;
  } },
  { method: 'GET', path: '/redirect-allowlist', name: 'links_allowlist_list', roles: ADMIN, summary: 'List allowed destination hosts', run: ctx => ctx.list('redirect_allowlist') },
  { method: 'POST', path: '/redirect-allowlist', name: 'links_allow_host', roles: ADMIN, summary: 'Allow an exact HTTPS destination hostname', run(ctx, { body }) {
    const hostname = host(body.hostname);
    const row = ctx.list('redirect_allowlist').find(row => row.hostname === hostname);
    return row ? ctx.update('redirect_allowlist', row.id, { status: 'active' }) : ctx.create('redirect_allowlist', { hostname, status: 'active' });
  } },
  { method: 'DELETE', path: '/redirect-allowlist/:id', name: 'links_revoke_host', roles: ADMIN, versionKind: 'redirect_allowlist', summary: 'Revoke a destination hostname', run: (ctx, { params }) => ctx.update('redirect_allowlist', params.id!, { status: 'revoked' }) },
  { method: 'GET', path: '/link-domains', name: 'links_domains_list', roles: READ, summary: 'List registered short-link domains', run: ctx => ctx.list('link_domain') },
  { method: 'POST', path: '/link-domains', name: 'links_domain_create', roles: ADMIN, summary: 'Register a pending custom domain', run(ctx, { body }) {
    const hostname = host(body.hostname);
    if (ctx.list('link_domain').some(row => row.hostname === hostname)) conflict('Domain already registered');
    return ctx.create('link_domain', { hostname, kind: 'custom', verification_status: 'pending', tls_status: 'pending' });
  } },
  { method: 'POST', path: '/link-domains/:id/verify', name: 'links_domain_verify', roles: ADMIN, versionKind: 'link_domain', summary: 'Request custom domain validation', run(ctx, { params }) {
    const row = ctx.get('link_domain', params.id!);
    if (row.verification_status === 'verified' && row.tls_status === 'active') return row;
    ctx.emit('traffic.link_domain.verification_requested', { link_domain_id: row.id, hostname: row.hostname });
    return { link_domain_id: row.id, status: 'pending' };
  } },
  { method: 'GET', path: '/utm-templates', name: 'utm_list', roles: READ, summary: 'List UTM templates', run: ctx => ctx.list('utm_template') },
  { method: 'POST', path: '/utm-templates', name: 'utm_create', roles: ADMIN, summary: 'Create a UTM template', run: (ctx, { body }) => ctx.create('utm_template', templateValues(body)) },
  { method: 'PATCH', path: '/utm-templates/:id', name: 'utm_update', roles: ADMIN, versionKind: 'utm_template', summary: 'Update a UTM template', run: (ctx, { params, body }) => ctx.update('utm_template', params.id!, templateValues({ ...ctx.get('utm_template', params.id!), ...body })) },
  { method: 'DELETE', path: '/utm-templates/:id', name: 'utm_remove', roles: ADMIN, versionKind: 'utm_template', summary: 'Remove a UTM template', run: (ctx, { params }) => { ctx.remove('utm_template', params.id!); return { removed: true }; } },
  { method: 'POST', path: '/utm-templates/preview', name: 'utm_build', roles: READ, summary: 'Preview expanded UTM parameters', run: (ctx, { body }) => ({ utm_params: buildUtm(ctx, body) }) },
  { method: 'GET', path: '/landing-destinations', name: 'links_destinations_list', roles: READ, summary: 'List registered destinations', run: ctx => ctx.list('landing_destination') },
  { method: 'POST', path: '/landing-destinations', name: 'links_destination_create', roles: WRITE, summary: 'Register an allowed landing destination', run(ctx, { body }) {
    const values = listing(ctx, body);
    if (ctx.list('landing_destination').some(row => row.url === values.url)) conflict('Destination already exists');
    return ctx.create('landing_destination', values);
  } },
  { method: 'PATCH', path: '/landing-destinations/:id', name: 'links_destination_update', roles: WRITE, versionKind: 'landing_destination', summary: 'Update a registered destination', run(ctx, { params, body }) {
    const previous = ctx.get('landing_destination', params.id!);
    const values = listing(ctx, body, previous);
    if (ctx.list('landing_destination').some(row => row.id !== previous.id && row.url === values.url)) conflict('Destination already exists');
    return ctx.update('landing_destination', previous.id, { ...values, ...(values.url === previous.url && values.product_variant_id === previous.product_variant_id && values.market_id === previous.market_id ? {} : { last_check_id: null, last_check_status: null }) });
  } },
];
function templateValues(body: Data) {
  const source = object(body.rules ?? {});
  const rules = { lowercase: source.lowercase === true, max_len: source.max_len ?? 100 };
  return { name: text(body.name, 'name'), params: utm(body.params, undefined, rules), rules, is_default: body.is_default === true };
}

export function publicLink(ctx: Context, hostname: string, code: string) {
  const domain = ctx.list('link_domain').find(row => row.hostname === hostname && row.verification_status === 'verified' && row.tls_status === 'active');
  const row = domain && ctx.list('short_link').find(row => row.domain_id === domain.id && row.code === code && row.status !== 'archived');
  if (!row) return missing();
  return row;
}
export function resolveLink(ctx: Context, row: Row, market?: string) {
  const variant = optional(row.product_variant_id, 'product_variant_id');
  if (row.status !== 'active' || (typeof row.expires_at === 'string' && row.expires_at <= ctx.now)) {
    return { location: row.fallback_url ? destination(ctx, row.fallback_url, variant, row.market_id).href : null, revision: null, market: null, choices: [] };
  }
  const revision = ctx.get('short_link_revision', text(row.current_revision_id, 'current_revision_id'));
  if (revision.short_link_id !== row.id) return missing();
  if (typeof revision.landing_destination_id === 'string' && ctx.get('landing_destination', revision.landing_destination_id).status !== 'active') {
    return { location: null, revision: null, market: null, choices: [] };
  }
  const routes = items(revision.market_routes ?? []).map(object);
  const selected = routes.find(route => route.market_id === market);
  const base = destination(ctx, selected?.url ?? revision.destination_url, variant, selected?.market_id ?? row.market_id);
  const location = safeUrl(ctx, finalUrl(base, utm(revision.utm_params, {}))).href;
  return { location, revision, market: selected?.market_id ?? null, choices: routes.map(route => ({ market_id: String(route.market_id), label: String(route.label) })) };
}
