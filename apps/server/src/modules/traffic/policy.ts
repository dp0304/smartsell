import { randomBytes } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import { DomainError, required, text, type Context } from '../types.ts';
import { invalid, object } from '../lifecycle/validation.ts';

export const traffic = 'traffic';
export const opaque = () => randomBytes(24).toString('base64url');
export const own = (ctx: Context, kind: string, id: string) => required(ctx, traffic, kind, id);
export function publicId(id: string) {
  if (!/^[A-Za-z0-9_-]{32}$/.test(id)) throw new DomainError('not_found', 'Resource not found', 404);
  return id;
}
export function conflict(message: string): never {
  throw new DomainError('state_conflict', message, 409);
}
export function hostname(value: unknown) {
  const host = text({ value }, 'value', 253).toLowerCase();
  const suffix = host.split('.').at(-1)!;
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)
      || ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion', 'home', 'lan', 'arpa'].includes(suffix)) {
    invalid('Expected a public DNS hostname');
  }
  return host;
}

export function httpsUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value) || /[\\\u0000- \u007f]/.test(value)) invalid('Expected an HTTPS URL');
  let url: URL;
  try { url = new URL(value); } catch { return invalid('Invalid destination URL'); }
  hostname(url.hostname);
  if (url.username || url.password || url.port) invalid('Invalid destination authority');
  return url;
}

export type ResolveTxt = (name: string) => Promise<string[][]>;
export async function verifyDestinationDomain(ctx: Context, id: string, lookup: ResolveTxt = name => new Resolver({ timeout: 1500, tries: 2 }).resolveTxt(name)) {
  const domain = await own(ctx, 'destination_domain', id);
  if (domain.data.status === 'revoked') conflict('Domain verification was revoked');
  if (domain.data.status === 'verified') return domain;
  let answers: string[][];
  try { answers = await lookup(`_smartsell.${domain.data.hostname}.`); }
  catch { return conflict('Destination DNS proof is unavailable'); }
  if (!answers.some(txt => txt.join('') === `smartsell-verification=${domain.data.challenge}`)) conflict('Destination DNS proof did not match');
  const verified = await ctx.update(traffic, 'destination_domain', id, { status: 'verified', verified_at: ctx.now }, domain.version);
  await ctx.emit('traffic.destination_domain.verified', { destination_domain_id: id });
  return verified;
}

export async function verifiedUrl(ctx: Context, value: unknown) {
  const url = httpsUrl(value);
  if (!(await ctx.list(traffic, 'destination_domain')).some(row => row.data.hostname === url.hostname && row.data.status === 'verified')) {
    throw new DomainError('unverified_destination', 'Verify the exact destination hostname first');
  }
  return url;
}

export async function destinationUrl(ctx: Context, value: unknown, variantId?: string | null, marketId?: string | null) {
  const url = await verifiedUrl(ctx, value);
  if (!variantId) return url;
  const variant = await required(ctx, 'commerce', 'product_variant', variantId);
  const product = await required(ctx, 'commerce', 'product', variant.data.product_id);
  const store = await required(ctx, 'commerce', 'store', product.data.store_id);
  const provider = store.data.provider;
  if (!['shopify', 'shopee', 'amazon_sp', 'tiktok_shop', 'file_import', 'other'].includes(provider)) invalid('Platform destination policy is unknown');
  if (provider === 'shopee') {
    const listings = (await ctx.list('commerce', 'listing_snapshot')).filter(row => row.data.variant_id === variantId && row.data.is_current === true
      && (!marketId || row.data.market_id === marketId));
    if (listings.length !== 1 || !listings[0]?.data.purchase_url) invalid('A single current Shopee product listing is required');
    const listing = httpsUrl(listings[0].data.purchase_url);
    if (listing.href !== url.href) invalid('Use the current Shopee product listing purchase URL');
  }
  return url;
}

const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id'] as const;
export function utmParams(raw: unknown) {
  const data = object(raw ?? {}, utmKeys);
  return Object.fromEntries(Object.entries(data).sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => {
    const normalized = text({ value }, 'value', 100).toLowerCase().replace(/\s+/g, '-');
    if (!/^[a-z0-9_-]+$/.test(normalized)) invalid(`Invalid ${key}`);
    return [key, normalized];
  }));
}

export function withUtm(url: URL, params: Record<string, string>) {
  for (const key of [...url.searchParams.keys()]) {
    if (/^utm_/i.test(key)) url.searchParams.delete(key);
  }
  const destination_url = url.href;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { destination_url, final_url: url.href };
}
