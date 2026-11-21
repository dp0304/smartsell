import { Problem, type Context, type Data, type Row } from '@smartsell/contracts';

export function invalid(message: string): never { throw new Problem(422, 'VALIDATION_FAILED', message); }
export function conflict(message: string): never { throw new Problem(409, 'STATE_CONFLICT', message); }
export function missing(): never { throw new Problem(404, 'NOT_FOUND', 'Resource not found'); }
export function object(value: unknown): Data {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Expected an object');
  return value as Data;
}
export function text(value: unknown, key: string, max = 240): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`Invalid ${key}`);
  return value.trim();
}
export function optional(value: unknown, key: string): string | undefined {
  return value == null ? undefined : text(value, key);
}
export function oneOf<T extends string>(value: unknown, values: readonly T[], key: string): T {
  if (!values.includes(value as T)) invalid(`Invalid ${key}`);
  return value as T;
}
export function items(value: unknown, max = 50): unknown[] {
  if (!Array.isArray(value) || value.length > max) invalid('Invalid list');
  return value;
}
export function slug(value: unknown): string {
  const result = text(value, 'slug', 80);
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(result)) invalid('Invalid slug');
  return result.toLowerCase();
}
export function time(value: unknown, key: string): string | null {
  if (value == null) return null;
  const raw = text(value, key);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(raw) || !Number.isFinite(Date.parse(raw))) invalid(`Invalid ${key}`);
  return new Date(raw).toISOString();
}
export function host(value: unknown): string {
  const result = text(value, 'hostname', 253).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(result) ||
      ['localhost', 'local', 'internal', 'test', 'invalid', 'example', 'onion', 'home', 'lan'].includes(result.split('.').at(-1)!)) invalid('Expected a public DNS hostname');
  return result;
}
export function safeUrl(ctx: Context, value: unknown): URL {
  const raw = text(value, 'URL', 2048);
  if (!/^https:\/\//i.test(raw) || /[\\\u0000-\u0020\u007f]/.test(raw)) invalid('Expected an HTTPS URL');
  let url: URL;
  try { url = new URL(raw); } catch { return invalid('Invalid URL'); }
  const hostname = host(url.hostname);
  if (url.username || url.password || url.port || !ctx.list('redirect_allowlist').some(row => row.hostname === hostname && row.status === 'active')) invalid('Destination hostname is not allowed');
  return url;
}
function productListing(ctx: Context, variantId: string, market: unknown): Row {
  const rows = ctx.list('listing_snapshot').filter(row => row.variant_id === variantId && row.is_current === true && (market == null || row.market_id === market));
  if (rows.length !== 1) invalid('Platform destination unknown: select a market with one current listing');
  const listing = rows[0]!;
  const variant = ctx.get('product_variant', variantId);
  const product = ctx.get('product', text(variant.product_id, 'product_id'));
  const store = ctx.get('store', text(product.store_id, 'store_id'));
  if (typeof store.provider !== 'string' || store.provider === 'lazada') invalid('Platform destination policy unknown');
  if (!listing.purchase_url) invalid('Platform listing has no purchase URL');
  return listing;
}
export function destination(ctx: Context, value: unknown, variantId?: string, market?: unknown): URL {
  const url = safeUrl(ctx, value);
  if (!variantId) return url;
  const expected = safeUrl(ctx, productListing(ctx, variantId, market).purchase_url);
  if (url.href !== expected.href) invalid(`Use the product listing purchase URL: ${expected.href}`);
  return url;
}
export function productView(ctx: Context, variantId: string, market: unknown) {
  const row = productListing(ctx, variantId, market);
  const currency = typeof row.currency === 'string' && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
  let price: string | null = null;
  if (currency && row.availability === 'observed' && row.is_estimate === false && typeof row.price_amount_minor === 'number' && Number.isSafeInteger(row.price_amount_minor) && row.price_amount_minor >= 0) {
    const formatter = new Intl.NumberFormat('en', { style: 'currency', currency });
    price = formatter.format(row.price_amount_minor / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
  }
  const sources: Record<string, string> = { store_market_price: '店鋪市場價格', store_base_price: '店鋪基礎價格', manual: '人工錄入' };
  const source = typeof row.price_source === 'string' && Object.hasOwn(sources, row.price_source) ? sources[row.price_source] : undefined;
  const observed_at = row.price_observed_at ?? row.observed_at;
  const hasProvenance = source && typeof observed_at === 'string' && Number.isFinite(Date.parse(observed_at));
  return { url: safeUrl(ctx, row.purchase_url).href, price: hasProvenance ? price : null,
    price_source_label: hasProvenance ? source : null, observed_at: hasProvenance ? observed_at : null };
}
export const channels = ['email', 'sms', 'whatsapp', 'push', 'platform_dm'] as const;
export type Channel = (typeof channels)[number];
export function consentText(ctx: Context, id: string, channel: string, purpose: string): Row {
  const row = ctx.get('consent_text_version', id);
  if (row.channel !== channel || row.purpose !== purpose || !Number.isFinite(Date.parse(String(row.effective_from))) ||
      Date.parse(String(row.effective_from)) > Date.parse(ctx.now)) invalid('Consent text version is not effective for this channel and purpose');
  return row;
}
