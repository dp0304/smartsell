import { admins, DomainError, readers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { flag, instant, invalid, object, oneOf } from '../lifecycle/validation.ts';
import { landingCommands } from './landing.ts';
import { conflict, destinationUrl, hostname, opaque, own, publicId, traffic, utmParams, verifiedUrl, verifyDestinationDomain, withUtm } from './policy.ts';

export { readLeadContact, submitLandingPage, viewLandingPage, type PublicLandingPage, type PublicLandingSubmission } from './landing.ts';
export { trafficPublicBridge, type PublicTrafficRequest, type PublicTrafficResponse, type PublicTrafficSecrets } from './operation-bridge.js';
export { decryptLeadContact, recordLeadHandoffReceipt } from './forms.js';

import type { Operation } from '@smartsell/contracts';
import { formOperations } from './forms.js';
import { linkOperations } from './links.js';
import { pageOperations } from './pages.js';

export const operations: Operation[] = [...linkOperations, ...pageOperations, ...formOperations];

const bindingFields = ['campaign_id', 'content_item_id', 'publish_target_id', 'collaboration_id', 'product_variant_id', 'market_id'] as const;
const utmFields = ['utm_params', 'utm_template_id', 'tokens'] as const;
const templateTokens = ['platform', 'account.handle', 'campaign.slug', 'content.short_id', 'creator.handle'];
const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'];
const opt = (input: Fields, key: string) => input[key] === undefined ? undefined : text(input, key, 128);

async function buildUtm(ctx: Context, input: Fields) {
  const templateId = opt(input, 'utm_template_id');
  if (!templateId) {
    if (input.tokens !== undefined) invalid('UTM tokens need a template');
    return utmParams(input.utm_params);
  }
  if (input.utm_params !== undefined) invalid('Choose either UTM parameters or a template');
  const template = await own(ctx, 'utm_template', templateId);
  const tokens = object(input.tokens ?? {}, templateTokens);
  const params = Object.fromEntries(Object.entries(template.data.params as Record<string, string>).map(([key, value]) => [key,
    value.replace(/\{([^{}]+)\}/g, (_, token: string) => text({ token: tokens[token] }, 'token', 100))]));
  return utmParams(params);
}

async function revisionFields(ctx: Context, input: Fields, bindings: Fields, old?: Entity) {
  const destination_id = opt(input, 'landing_destination_id');
  if (destination_id && input.destination_url !== undefined) invalid('Choose one landing destination');
  const destination = destination_id ? await own(ctx, 'landing_destination', destination_id) : undefined;
  if (destination && destination.data.status !== 'active') conflict('Landing destination is not active');
  if (destination) {
    for (const key of ['product_variant_id', 'market_id'] as const) {
      const bound = destination.data[key];
      if (!bound) continue;
      if (bindings[key] == null && !old) bindings[key] = bound;
      else if (bindings[key] !== bound) invalid(`Link and registered destination disagree on ${key}`);
    }
  }
  const url = await destinationUrl(ctx, destination?.data.url ?? input.destination_url, bindings.product_variant_id, bindings.market_id);
  const utm_params = old && !utmFields.some(key => input[key] !== undefined) ? old.data.utm_params : await buildUtm(ctx, input);
  return { ...withUtm(url, utm_params), utm_params, landing_destination_id: destination?.id ?? null };
}

interface RedirectObservation { userAgent?: string; purpose?: string }
function classify({ userAgent = '', purpose = '' }: RedirectObservation) {
  if (/facebookexternalhit|facebot|Twitterbot|Slackbot|LinkedInBot|Discordbot/i.test(userAgent)) return 'bot_preview';
  if (/Googlebot|bingbot|crawler|spider|robot/i.test(userAgent)) return 'crawler';
  if (/prefetch|prerender/i.test(purpose)) return 'prefetch';
  if (/^Mozilla\/5\.0 .*(Chrome|Firefox|Safari)\//i.test(userAgent)) return 'human_likely';
  return 'unknown';
}

/** The public adapter resolves the opaque ID and constructs a scoped transaction. */
export async function resolveShortLink(ctx: Context, code: string, observation: RedirectObservation = {}): Promise<{ location: string }> {
  const link = await own(ctx, 'short_link', publicId(code));
  if (link.data.code !== code || link.data.status === 'archived') throw new DomainError('not_found', 'Short link not found', 404);
  const expired = link.data.expires_at && Date.parse(link.data.expires_at) <= Date.parse(ctx.now);
  const fallback = link.data.status !== 'active' || Boolean(expired);
  if (fallback && !link.data.fallback_url) throw new DomainError('link_unavailable', 'Short link is not active', 410);
  const revision = await own(ctx, 'short_link_revision', link.data.current_revision_id);
  if (revision.data.short_link_id !== link.id) throw new DomainError('not_found', 'Short link revision not found', 404);
  if (!fallback && revision.data.landing_destination_id) {
    const destination = await own(ctx, 'landing_destination', revision.data.landing_destination_id);
    if (destination.data.status !== 'active') throw new DomainError('link_unavailable', 'Landing destination is not active', 410);
  }
  const url = await destinationUrl(ctx, fallback ? link.data.fallback_url : revision.data.destination_url, link.data.product_variant_id, link.data.market_id);
  const location = fallback ? url.href : withUtm(url, revision.data.utm_params).final_url;
  await ctx.insert(traffic, 'click_event', { short_link_id: link.id, revision_id: revision.id, occurred_at: ctx.now, classification: classify(observation), fallback });
  return { location };
}

async function warnDuplicate(ctx: Context, link: Entity, params: Record<string, string>) {
  if (!link.data.campaign_id || !Object.keys(params).length) return [];
  const links = await ctx.list(traffic, 'short_link');
  const revisions = new Map((await ctx.list(traffic, 'short_link_revision')).map(row => [row.id, row]));
  const candidate = JSON.stringify(params);
  const duplicate = links.some(peer => peer.id !== link.id && peer.data.status !== 'archived' && peer.data.campaign_id === link.data.campaign_id
    && JSON.stringify(revisions.get(peer.data.current_revision_id)?.data.utm_params) === candidate);
  return duplicate ? ['duplicate_campaign_utm'] : [];
}

export const commands = {
  ...landingCommands,
  request_destination_domain: { roles: admins, async run(ctx, input) {
    object(input, ['hostname']);
    const host = hostname(input.hostname);
    if ((await ctx.list(traffic, 'destination_domain')).some(row => row.data.hostname === host && row.data.status !== 'revoked')) conflict('A destination domain already exists');
    return ctx.insert(traffic, 'destination_domain', { hostname: host, status: 'pending', challenge: opaque() });
  } },
  verify_destination_domain: { roles: admins, async run(ctx, input) {
    object(input, ['destination_domain_id']);
    return verifyDestinationDomain(ctx, text(input, 'destination_domain_id', 128));
  } },
  revoke_destination_domain: { roles: admins, async run(ctx, input) {
    object(input, ['destination_domain_id', 'expected_version']);
    const domain = await own(ctx, 'destination_domain', text(input, 'destination_domain_id', 128));
    if (domain.version !== input.expected_version) conflict('Destination domain version has changed');
    await ctx.emit('traffic.destination_domain.revoked', { destination_domain_id: domain.id });
    return ctx.update(traffic, 'destination_domain', domain.id, { status: 'revoked' }, domain.version);
  } },
  register_landing_destination: { roles: writers, async run(ctx, input) {
    object(input, ['url', 'kind', 'product_variant_id', 'market_id']);
    const product_variant_id = opt(input, 'product_variant_id');
    const market_id = opt(input, 'market_id');
    const kind = oneOf(input.kind, ['store_product', 'store_collection', 'external_page'], 'kind');
    if (kind === 'store_product' && !product_variant_id) invalid('A store product destination needs a variant');
    const url = await destinationUrl(ctx, input.url, product_variant_id, market_id);
    if ((await ctx.list(traffic, 'landing_destination')).some(row => row.data.url === url.href && row.data.status === 'active')) conflict('Landing destination already exists');
    return ctx.insert(traffic, 'landing_destination', { url: url.href, kind, product_variant_id: product_variant_id ?? null, market_id: market_id ?? null, status: 'active' });
  } },
  create_utm_template: { roles: admins, async run(ctx, input) {
    object(input, ['name', 'params']);
    const params = object(input.params, utmKeys);
    if (!Object.keys(params).length) invalid('A UTM template needs parameters');
    for (const [key, raw] of Object.entries(params)) {
      const value = text({ raw }, 'raw', 240);
      const literal = value.replace(/\{([^{}]+)\}/g, (_, token: string) => {
        if (!templateTokens.includes(token)) invalid('Invalid UTM template token');
        return 'token';
      });
      utmParams({ [key]: literal });
      params[key] = value;
    }
    return ctx.insert(traffic, 'utm_template', { name: text(input, 'name', 120), params });
  } },
  utm_build: { roles: readers, async run(ctx, input) {
    object(input, utmFields);
    return { utm_params: await buildUtm(ctx, input) };
  } },
  links_create: { roles: writers, async run(ctx, input) {
    object(input, [...bindingFields, ...utmFields, 'destination_url', 'landing_destination_id', 'expires_at', 'fallback_url']);
    const bindings = Object.fromEntries(bindingFields.map(key => [key, opt(input, key) ?? null]));
    const expires_at = input.expires_at === undefined ? null : instant(input.expires_at, 'expires_at');
    if (expires_at && Date.parse(expires_at) <= Date.parse(ctx.now)) invalid('expires_at must be in the future');
    const revisionData = await revisionFields(ctx, input, bindings);
    const fallback_url = input.fallback_url === undefined ? null : (await destinationUrl(ctx, input.fallback_url, bindings.product_variant_id, bindings.market_id)).href;
    const code = opaque();
    const link = await ctx.insert(traffic, 'short_link', { ...bindings, code, status: 'active', expires_at, fallback_url, locked_after_publish: true }, code);
    const revision = await ctx.insert(traffic, 'short_link_revision', { ...revisionData, short_link_id: link.id, revision_no: 1 });
    const updated = await ctx.update(traffic, 'short_link', link.id, { current_revision_id: revision.id, revision_no: 1 }, link.version);
    await ctx.emit('traffic.short_link.created', { short_link_id: link.id, revision_id: revision.id });
    return { link: updated, revision, warnings: await warnDuplicate(ctx, updated, revisionData.utm_params) };
  } },
  change_link_destination: { roles: admins, async run(ctx, input) {
    object(input, [...utmFields, 'short_link_id', 'expected_version', 'destination_url', 'landing_destination_id', 'reason', 'confirm_in_use']);
    const link = await own(ctx, 'short_link', text(input, 'short_link_id', 128));
    if (link.version !== input.expected_version || link.data.status === 'archived') conflict('Link cannot be changed at this version');
    const confirmed = flag(input.confirm_in_use, 'confirm_in_use');
    if (link.data.publish_target_id && !confirmed) conflict('Confirm the destination change for the bound publishing target');
    const reason = text(input, 'reason', 1000);
    const previous = await own(ctx, 'short_link_revision', link.data.current_revision_id);
    const revisionData = await revisionFields(ctx, input, link.data, previous);
    const revision = await ctx.insert(traffic, 'short_link_revision', {
      ...revisionData, short_link_id: link.id, revision_no: link.data.revision_no + 1, change_reason: reason,
    });
    const updated = await ctx.update(traffic, 'short_link', link.id, { current_revision_id: revision.id, revision_no: revision.data.revision_no }, link.version);
    await ctx.emit('traffic.short_link.destination_changed', { short_link_id: link.id, previous_revision_id: previous.id, revision_id: revision.id });
    return { link: updated, revision, warnings: await warnDuplicate(ctx, updated, revisionData.utm_params) };
  } },
  set_link_status: { roles: writers, async run(ctx, input) {
    object(input, ['short_link_id', 'expected_version', 'status']);
    const link = await own(ctx, 'short_link', text(input, 'short_link_id', 128));
    const status = oneOf(input.status, ['active', 'paused', 'archived'], 'status');
    if (link.version !== input.expected_version || link.data.status === 'archived') conflict('Link cannot be changed at this version');
    if (status === 'active' && link.data.expires_at && Date.parse(link.data.expires_at) <= Date.parse(ctx.now)) conflict('Expired links cannot be activated');
    const updated = await ctx.update(traffic, 'short_link', link.id, { status }, link.version);
    await ctx.emit('traffic.short_link.status_changed', { short_link_id: link.id, status });
    return updated;
  } },
  links_check: { roles: writers, async run(ctx, input) {
    object(input, ['short_link_id']);
    const link = await own(ctx, 'short_link', text(input, 'short_link_id', 128));
    const revision = await own(ctx, 'short_link_revision', link.data.current_revision_id);
    let verified = false;
    try {
      await destinationUrl(ctx, revision.data.destination_url, link.data.product_variant_id, link.data.market_id);
      if (link.data.fallback_url) await verifiedUrl(ctx, link.data.fallback_url);
      verified = true;
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
    }
    const check = await ctx.insert(traffic, 'page_check', {
      target_type: 'short_link', target_id: link.id, kind: 'destination_policy', trigger: 'manual', checked_at: ctx.now,
      status: verified ? 'unknown' : 'fail', items: [{ check: 'destination_policy', result: verified ? 'pass' : 'fail' }, { check: 'http_status', result: 'unknown' }],
    });
    if (!verified) await ctx.emit('traffic.page_check.failed', { page_check_id: check.id, short_link_id: link.id });
    return check;
  } },
  links_get_stats: { roles: readers, async run(ctx, input) {
    object(input, ['short_link_id', 'campaign_id', 'from', 'to']);
    const link = opt(input, 'short_link_id');
    const campaign = opt(input, 'campaign_id');
    if (Boolean(link) === Boolean(campaign)) invalid('Choose one short link or campaign');
    const from = input.from === undefined ? undefined : instant(input.from, 'from');
    const to = input.to === undefined ? undefined : instant(input.to, 'to');
    if (from && to && from >= to) invalid('from must precede to');
    const ids = link ? [ (await own(ctx, 'short_link', link)).id ] : (await ctx.list(traffic, 'short_link')).filter(row => row.data.campaign_id === campaign).map(row => row.id);
    const selected = new Set(ids);
    const events = (await ctx.list(traffic, 'click_event')).filter(({ data }) => selected.has(data.short_link_id)
      && (!from || data.occurred_at >= from) && (!to || data.occurred_at < to));
    return {
      redirects: events.length, human_likely: events.filter(row => row.data.classification === 'human_likely').length,
      bot_filtered: events.filter(row => ['bot_preview', 'crawler', 'prefetch'].includes(row.data.classification)).length,
      unknown: events.filter(row => row.data.classification === 'unknown').length,
    };
  } },
} satisfies Commands;
