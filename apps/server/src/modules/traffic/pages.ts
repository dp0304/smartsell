import { createHash } from 'node:crypto';
import { APPROVE, READ, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { publicLink, resolveLink } from './links.js';
import { probeDestination } from './probe.js';
import { fromAgent } from '../../agent-actor.js';
import { conflict, destination, invalid, items, missing, object, oneOf, optional, productView, safeUrl, slug, text, time } from './operation-policy.js';

export function hash(content: unknown): string { return createHash('sha256').update(JSON.stringify(content)).digest('hex'); }
const blockTypes = ['text','cta','product','faq','form','image','video'] as const;
function blocks(ctx: Context, raw: unknown, market: unknown) {
  return items(raw, 30).map(value => {
    const row = object(value);
    const type = oneOf(row.type, blockTypes, 'block type');
    const title = row.title === '' ? '' : optional(row.title, 'title') ?? '';
    switch (type) {
      case 'text': return { type, title, text: text(row.text, 'text', 4000) };
      case 'faq': return { type, title, entries: items(row.entries, 20).map(value => {
        const entry = object(value);
        return { question: text(entry.question, 'question'), answer: text(entry.answer, 'answer', 2000) };
      }) };
      case 'form': {
        const form = ctx.get('form', text(row.form_id, 'form_id'));
        return { type, title, form_id: form.id };
      }
      case 'product': case 'cta': {
        const variant = type === 'product' ? text(row.product_variant_id, 'product_variant_id') : optional(row.product_variant_id, 'product_variant_id');
        const url = row.url == null && variant ? productView(ctx, variant, market).url : destination(ctx, row.url, variant, market).href;
        return { type, title, url, product_variant_id: variant ?? null, label: text(row.label, 'label') };
      }
      case 'image': case 'video': return { type, title, url: safeUrl(ctx, row.url).href, alt: optional(row.alt, 'alt') ?? '' };
    }
  });
}
function version(ctx: Context, page: Row, body: Data) {
  const locale = text(body.locale ?? 'zh-Hant', 'locale', 40);
  if (!/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(locale)) invalid('Invalid locale');
  const content = { title: text(body.title, 'title'), locale, blocks: blocks(ctx, body.blocks, page.market_id) };
  if (!content.blocks.length) invalid('A landing page requires at least one block');
  return ctx.create('landing_page_version', { ...content, content_hash: hash(content), page_id: page.id,
    version_no: ctx.list('landing_page_version').filter(row => row.page_id === page.id).length + 1 });
}
function checkPage(ctx: Context, page: Row, version: Row, requireActiveForms = true) {
  const checked = blocks(ctx, version.blocks, page.market_id);
  const hasProduct = checked.some(row => row.type === 'product');
  for (const row of checked) {
    if (row.type === 'form') {
      const form = ctx.get('form', row.form_id);
      if (requireActiveForms && (form.status !== 'active' || typeof form.active_version_id !== 'string')) invalid('Embedded form must be active');
      if (form.brand_id !== page.brand_id) invalid('Embedded form must belong to the same brand');
    }
    if (hasProduct && row.type === 'cta' && !row.product_variant_id) invalid('A CTA on a product page must cite its product variant');
  }
  return checked;
}
function appSlug(ctx: Context, kind: string, key: string, value: unknown) {
  const id = slug(value);
  if (ctx.list(kind).some(row => row[key] === id)) conflict('Public identifier already exists');
  return id;
}
function bioValues(ctx: Context, page: Row, input: Data) {
  const link = ctx.get('short_link', text(input.short_link_id, 'short_link_id'));
  if (link.brand_id !== page.brand_id || link.status !== 'active') invalid('Select an active short link for this brand');
  resolveLink(ctx, link);
  const valid_from = time(input.valid_from, 'valid_from');
  const valid_until = time(input.valid_until, 'valid_until');
  if (valid_from && valid_until && valid_from >= valid_until) invalid('Invalid schedule');
  const sort = input.sort ?? 0;
  if (typeof sort !== 'number' || !Number.isSafeInteger(sort) || sort < 0) invalid('Invalid sort order');
  return { bio_page_id: page.id, label: text(input.label, 'label'), short_link_id: link.id, sort, valid_from, valid_until,
    market_ids: items(input.market_ids ?? [], 20).map(slug), status: oneOf(input.status ?? 'active', ['active','paused'], 'status') };
}

function matchesExperiment(experiment: Row, arms: Row[] | { landing_page_version_id: string; split_weight: number }[]) {
  const variants = items(experiment.variants).map(object);
  return variants.length === arms.length && variants.every(variant => arms.some(arm =>
    arm.landing_page_version_id === variant.ref_id && arm.split_weight === variant.allocation));
}
function passed(ctx: Context, versionId: string) {
  return ctx.list('page_check').filter(row => row.target_id === versionId && row.target_type === 'landing_page_version').at(-1)?.status === 'pass';
}

export function publicPage(ctx: Context, slug: string, bucket?: number) {
  const page = ctx.list('landing_page').find(row => row.slug === slug && row.status === 'published' && typeof row.published_version_id === 'string');
  if (!page) return missing();
  let chosen = String(page.published_version_id);
  let experiment: Data | null = null;
  if (bucket != null) {
    const arms = ctx.list('experiment_assignment').filter(row => row.landing_page_id === page.id && typeof row.experiment_id === 'string');
    const ids = [...new Set(arms.map(row => row.experiment_id))];
    for (const id of ids) {
      const exp = ctx.get('experiment', String(id));
      if (exp.type !== 'page' || exp.status !== 'running') continue;
      const period = object(exp.period);
      const now = Date.parse(ctx.now);
      if (!(now >= Date.parse(String(period.from)) && now < Date.parse(String(period.to)))) continue;
      const assigned = arms.filter(row => row.experiment_id === id).sort((a,b) => String(a.arm_key).localeCompare(String(b.arm_key)));
      if (!matchesExperiment(exp, assigned)) continue;
      if (assigned.reduce((sum, row) => sum + Number(row.split_weight), 0) !== 100) continue;
      let offset = bucket;
      for (const arm of assigned) {
        offset -= Number(arm.split_weight);
        if (offset < 0) {
          chosen = String(arm.landing_page_version_id);
          experiment = { experiment_id: id, arm_key: arm.arm_key };
          break;
        }
      }
      break;
    }
  }
  const row = ctx.get('landing_page_version', chosen);
  if (row.page_id !== page.id) return missing();
  return { page, row, blocks: checkPage(ctx, page, row, false), experiment };
}
export function publicBio(ctx: Context, hostname: string, handle: string, market?: string) {
  const page = ctx.list('bio_page').find(row => row.handle === handle && row.status === 'published');
  if (!page) return missing();
  const active = ctx.list('bio_item').filter(row => row.bio_page_id === page.id && row.status === 'active' &&
      (row.valid_from == null || String(row.valid_from) <= ctx.now));
  const markets = [...new Set(active.flatMap(row => items(row.market_ids ?? []).map(String)))].sort();
  const notices = { expired: false, delisted: false };
  const entries = active.sort((a,b) => Number(a.sort) - Number(b.sort)).flatMap(row => {
    const allowed = items(row.market_ids ?? []);
    if (allowed.length && !allowed.includes(market)) return [];
    const ref = ctx.list('short_link').find(link => link.id === row.short_link_id);
    if (!ref) return [];
    try {
      const link = publicLink(ctx, hostname, String(ref.code));
      if (link.id !== ref.id || link.status !== 'active') return [];
      if ([row.valid_until, link.expires_at].some(value => typeof value === 'string' && value <= ctx.now)) {
        notices.expired = true;
        return [];
      }
      if (typeof link.product_variant_id === 'string') {
        const variant = ctx.get('product_variant', link.product_variant_id);
        const product = ctx.get('product', String(variant.product_id));
        if ([product.status, variant.status].some(status => status === 'archived' || status === 'removed_at_source')) {
          notices.delisted = true;
          return [];
        }
      }
      if (!resolveLink(ctx, link, market).revision) return [];
      return [{ label: String(row.label), path: `/${encodeURIComponent(String(link.code))}${market ? `?market=${encodeURIComponent(market)}` : ''}` }];
    } catch { return []; }
  });
  return { title: String(page.title), entries, markets, notices };
}

export const pageOperations: Operation[] = [
  { method: 'GET', path: '/landing-pages', name: 'pages_list', roles: READ, summary: 'List landing pages', run: ctx => ctx.list('landing_page') },
  { method: 'POST', path: '/landing-pages', name: 'pages_create_draft', roles: WRITE, summary: 'Create a landing page draft', run(ctx, { body }) {
    const page = ctx.create('landing_page', { slug: appSlug(ctx, 'landing_page', 'slug', body.slug), brand_id: text(body.brand_id, 'brand_id'),
      campaign_id: optional(body.campaign_id, 'campaign_id') ?? null, market_id: optional(body.market_id, 'market_id') ?? null, status: 'draft', published_version_id: null });
    return body.blocks === undefined ? page : { ...page, draft: version(ctx, page, body) };
  } },
  { method: 'GET', path: '/landing-pages/:id/versions', name: 'pages_versions', roles: READ, summary: 'List immutable landing page versions', run(ctx, { params }) {
    ctx.get('landing_page', params.id!);
    return ctx.list('landing_page_version').filter(row => row.page_id === params.id);
  } },
  { method: 'POST', path: '/landing-pages/:id/versions', name: 'pages_create_version', roles: WRITE, versionKind: 'landing_page', summary: 'Append a page draft version', run(ctx, { params, body }) {
    const page = ctx.get('landing_page', params.id!);
    const draft = version(ctx, page, body);
    ctx.update('landing_page', page.id, { latest_version_id: draft.id });
    return draft;
  } },
  { method: 'POST', path: '/landing-pages/:id/publish', name: 'pages_publish', roles: APPROVE, versionKind: 'landing_page', summary: 'Publish a checked page version', run(ctx, { params, body }) {
    const page = ctx.get('landing_page', params.id!);
    const draft = ctx.get('landing_page_version', text(body.version_id, 'version_id'));
    if (draft.page_id !== page.id) missing();
    checkPage(ctx, page, draft);
    if (!passed(ctx, draft.id)) conflict('Page version needs a passing pre-publish check');
    const saved = ctx.update('landing_page', page.id, { published_version_id: draft.id, status: 'published' });
    ctx.emit('traffic.landing_page.published', { landing_page_id: page.id, version_id: draft.id });
    return saved;
  } },
  { method: 'POST', path: '/landing-pages/:id/unpublish', name: 'pages_unpublish', roles: APPROVE, versionKind: 'landing_page', summary: 'Take a page offline', run(ctx, { params }) {
    const row = ctx.update('landing_page', params.id!, { status: 'unpublished', published_version_id: null });
    ctx.emit('traffic.landing_page.unpublished', { landing_page_id: row.id });
    return row;
  } },
  { method: 'GET', path: '/page-checks', name: 'links_list_checks', roles: READ, summary: 'List page check evidence', run: (ctx, { query }) => ctx.list('page_check').filter(row => (!query.target_type || row.target_type === query.target_type) && (!query.target_id || row.target_id === query.target_id)) },
  { method: 'POST', path: '/page-checks/probe', name: 'links_probe', roles: APPROVE, summary: 'Observe a registered HTTPS destination', async run(ctx, { body }) {
    const target_type = oneOf(body.target_type, ['short_link','landing_destination'], 'target_type');
    const target = ctx.get(target_type, text(body.target_id, 'target_id'));
    let url: string;
    if (target_type === 'short_link') {
      const result = resolveLink(ctx, target);
      if (!result.location || !result.revision) conflict('Short link is unavailable');
      url = result.location;
    } else {
      if (target.status !== 'active') conflict('Destination is unavailable');
      url = destination(ctx, target.url, optional(target.product_variant_id, 'product_variant_id'), target.market_id).href;
    }
    const items = await probeDestination(ctx, url, optional(target.expected_language, 'expected_language'));
    const status = ['fail','unknown','warn','pass'].find(status => items.some(row => row.result === status))!;
    const prior = ctx.list('page_check').filter(row => row.target_type === target_type && row.target_id === target.id).at(-1);
    const check = ctx.create('page_check', { target_type, target_id: target.id, kind: 'auto_link', trigger: 'manual', checked_at: ctx.now, status, items });
    if (target_type === 'landing_destination') ctx.update(target_type, target.id, { last_check_id: check.id, last_check_status: status });
    if (status === 'fail' || (status === 'pass' && prior?.status === 'fail')) ctx.emit(`traffic.page_check.${status === 'fail' ? 'failed' : 'recovered'}`, { page_check_id: check.id, target_type, target_id: target.id });
    return check;
  } },
  { method: 'POST', path: '/page-checks', name: 'links_check', roles: WRITE, summary: 'Run local checks and record manual evidence', run(ctx, { body }) {
    const target_type = oneOf(body.target_type, ['short_link','landing_destination','landing_page_version'], 'target_type');
    const target = ctx.get(target_type, text(body.target_id, 'target_id'));
    const kind = oneOf(body.kind ?? 'pre_publish', ['auto_link','manual_checklist','pre_publish'], 'kind');
    const results: Data[] = [];
    try {
      if (target_type === 'short_link') {
        if (!resolveLink(ctx, target).revision) invalid('Short link is inactive');
      } else if (target_type === 'landing_destination') {
        destination(ctx, target.url, optional(target.product_variant_id, 'product_variant_id'), target.market_id);
      } else {
        checkPage(ctx, ctx.get('landing_page', String(target.page_id)), target);
      }
      results.push({ check: 'platform_redirect', result: 'pass' });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'Validation unavailable';
      results.push({ check: 'platform_redirect', result: /unknown|not found/i.test(detail) ? 'unknown' : 'fail', detail });
    }
    const observed = items(body.items ?? [], 20).map(object);
    // An Agent may report what it saw, but it cannot vouch for a page a person will publish: its "pass" stays unknown.
    const byAgent = fromAgent(ctx);
    for (const row of observed) {
      const check = oneOf(row.check, ['http_status','language','mobile','form','promotion','availability'], 'check');
      if (kind === 'auto_link') invalid('Automatic checks cannot accept manual results');
      const reported = oneOf(row.result, ['pass','warn','fail','unknown'], 'result');
      const result = byAgent && reported === 'pass' ? 'unknown' : reported;
      results.push({ check, result, ...(result !== reported && { reported_result: reported }), detail: text(row.detail, 'detail', 1000),
        source: byAgent ? 'agent' : 'manual', evidence_id: optional(row.evidence_id, 'evidence_id') ?? null });
    }
    if (!results.some(row => row.check === 'http_status')) results.push({ check: 'http_status', result: 'unknown' });
    const status = ['fail','unknown','warn','pass'].find(status => results.some(row => row.result === status))!;
    const previous = ctx.list('page_check').filter(row => row.target_type === target_type && row.target_id === target.id).at(-1);
    const check = ctx.create('page_check', { target_type, target_id: target.id, kind, status, items: results, trigger: 'manual', checked_at: ctx.now });
    if (target_type === 'landing_destination') ctx.update(target_type, target.id, { last_check_id: check.id, last_check_status: status });
    if (status === 'fail' || (status === 'pass' && previous?.status === 'fail')) ctx.emit(`traffic.page_check.${status === 'fail' ? 'failed' : 'recovered'}`, { page_check_id: check.id, target_type, target_id: target.id });
    return check;
  } },
  { method: 'GET', path: '/bio-pages', name: 'bio_list', roles: READ, summary: 'List bio pages', run: ctx => ctx.list('bio_page') },
  { method: 'POST', path: '/bio-pages', name: 'bio_create', roles: WRITE, summary: 'Create a bio page draft', run: (ctx, { body }) => ctx.create('bio_page', { handle: appSlug(ctx, 'bio_page', 'handle', body.handle), brand_id: text(body.brand_id, 'brand_id'), title: text(body.title, 'title'), social_account_id: optional(body.social_account_id, 'social_account_id') ?? null, status: 'draft' }) },
  { method: 'POST', path: '/bio-pages/:id/publish', name: 'bio_publish', roles: APPROVE, versionKind: 'bio_page', summary: 'Publish or take a bio page offline', run: (ctx, { params, body }) => ctx.update('bio_page', params.id!, { status: body.unpublish === true ? 'unpublished' : 'published' }) },
  { method: 'GET', path: '/bio-pages/:id/items', name: 'bio_items', roles: READ, summary: 'List scheduled bio items with current visibility', run(ctx, { params }) {
    const page = ctx.get('bio_page', params.id!);
    return ctx.list('bio_item').filter(row => row.bio_page_id === page.id).map(row => {
      const link = ctx.list('short_link').find(link => link.id === row.short_link_id);
      let disposition = 'active';
      if (typeof row.valid_until === 'string' && row.valid_until <= ctx.now) disposition = 'expired';
      else if (row.status !== 'active' || !link || link.status !== 'active') disposition = 'unlisted';
      else if (typeof link.expires_at === 'string' && link.expires_at <= ctx.now) disposition = 'expired';
      else if (typeof row.valid_from === 'string' && row.valid_from > ctx.now) disposition = 'scheduled';
      else {
        try {
          if (!resolveLink(ctx, link).revision) disposition = 'unlisted';
        } catch { disposition = 'unlisted'; }
      }
      return { ...row, disposition };
    });
  } },
  { method: 'POST', path: '/bio-pages/:id/items', name: 'bio_add_item', roles: APPROVE, versionKind: 'bio_page', summary: 'Schedule a bio item', run(ctx, { params, body }) {
    const page = ctx.get('bio_page', params.id!);
    const row = ctx.create('bio_item', bioValues(ctx, page, body));
    ctx.update('bio_page', page.id, { items_updated_at: ctx.now });
    return row;
  } },
  { method: 'PATCH', path: '/bio-items/:id', name: 'bio_edit_item', roles: APPROVE, versionKind: 'bio_item', summary: 'Reschedule or pause a bio item', run(ctx, { params, body }) {
    const row = ctx.get('bio_item', params.id!);
    return ctx.update('bio_item', row.id, bioValues(ctx, ctx.get('bio_page', String(row.bio_page_id)), { ...row, ...body }));
  } },
  { method: 'DELETE', path: '/bio-items/:id', name: 'bio_remove_item', roles: APPROVE, versionKind: 'bio_item', summary: 'Remove a bio item', run(ctx, { params }) { ctx.remove('bio_item', params.id!); return { removed: true }; } },
  { method: 'GET', path: '/landing-pages/:id/experiment', name: 'pages_experiment_report', roles: READ, summary: 'Read reported page experiment samples and coverage', run(ctx, { params, query }) {
    const page = ctx.get('landing_page', params.id!);
    const arms = ctx.list('experiment_assignment').filter(row => row.landing_page_id === page.id && row.experiment_id === query.experiment_id);
    if (!arms.length) return missing();
    const experiment = ctx.get('experiment', text(query.experiment_id, 'experiment_id'));
    if (experiment.type !== 'page' || !matchesExperiment(experiment, arms)) return missing();
    const latest = ctx.list('experiment_result_snapshot').filter(row => row.experiment_id === experiment.id)
      .sort((a, b) => String(b.as_of).localeCompare(String(a.as_of)) || b.created_at.localeCompare(a.created_at))[0];
    const samples = latest ? items(latest.variants, 30).map(object) : [];
    const results = arms.map(arm => {
      const observed = samples.find(sample => sample.ref_id === arm.landing_page_version_id);
      return { arm_key: arm.arm_key, sample_size: observed?.sample_size ?? null, value: observed?.value ?? null };
    });
    const minimum = typeof experiment.minimum_sample_size === 'number' && experiment.minimum_sample_size > 0 ? experiment.minimum_sample_size : 1;
    const coverage = !latest ? 'unavailable' : results.some(arm => typeof arm.sample_size !== 'number' || arm.sample_size < minimum) ? 'insufficient_traffic' : 'observed';
    return { experiment_id: experiment.id, primary_metric: experiment.primary_metric, minimum_sample_size: minimum, coverage, as_of: latest?.as_of ?? null,
      source: latest?.source ?? null, limitations: latest?.limitations ?? [], arms: results };
  } },
  { method: 'PUT', path: '/landing-pages/:id/experiment', name: 'pages_configure_experiment', roles: APPROVE, versionKind: 'landing_page', summary: 'Set page version experiment weights', run(ctx, { body, params }) {
    const page = ctx.get('landing_page', params.id!);
    const exp = ctx.get('experiment', text(body.experiment_id, 'experiment_id'));
    if (exp.type !== 'page' || exp.status !== 'draft') conflict('Only a draft page experiment can be configured');
    const arms = items(body.arms, 8).map(value => {
      const row = object(value);
      const version = ctx.get('landing_page_version', text(row.version_id, 'version_id'));
      if (version.page_id !== page.id) missing();
      checkPage(ctx, page, version);
      if (!passed(ctx, version.id)) conflict('Every experiment arm requires a passing check');
      if (typeof row.weight !== 'number' || !Number.isInteger(row.weight) || row.weight <= 0) invalid('Invalid weight');
      return { landing_page_id: page.id, experiment_id: exp.id, arm_key: slug(row.arm_key), landing_page_version_id: version.id, split_weight: row.weight };
    });
    if (arms.length < 2 || new Set(arms.map(arm => arm.arm_key)).size !== arms.length || arms.reduce((sum, arm) => sum + arm.split_weight, 0) !== 100) invalid('Use unique arms totaling 100 percent');
    if (!matchesExperiment(exp, arms)) invalid('Page arms must match the analytics experiment versions and allocations');
    for (const row of ctx.list('experiment_assignment').filter(row => row.landing_page_id === page.id && row.experiment_id === exp.id)) ctx.remove('experiment_assignment', row.id);
    ctx.update('landing_page', page.id, { experiment_updated_at: ctx.now });
    return arms.map(arm => ctx.create('experiment_assignment', arm));
  } },
];
