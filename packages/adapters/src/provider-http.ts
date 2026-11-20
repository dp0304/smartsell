import type { ClassifiedError, ErrorClass, ProviderKey, Transport, TransportRequest, TransportResponse } from './adapter-types.ts';

type Dict = Record<string, unknown>;
export const record = (value: unknown): Dict => value && typeof value === 'object' && !Array.isArray(value) ? value as Dict : {};
export const rows = (value: unknown): Dict[] => Array.isArray(value) ? value.filter(row => row && typeof row === 'object' && !Array.isArray(row)) as Dict[] : [];
export const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value : undefined;
export const identifier = (value: unknown): string | undefined => text(value) ?? (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : undefined);
export const header = (headers: Readonly<Record<string, string | undefined>> | undefined, name: string) => Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
export function url(base: string, params: Record<string, string | number | boolean | undefined> = {}) {
  const result = new URL(base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) result.searchParams.set(key, String(value));
  return result.toString();
}
export function secureUrl(value: unknown): string | undefined {
  const candidate = text(value);
  if (!candidate) return undefined;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol === 'https:' && !parsed.username && !parsed.password && !parsed.hash) return parsed.href;
  } catch { /* invalid URL */ }
}
export const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const form = (body: Record<string, string | undefined>) => ({ headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(Object.entries(body).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString() });
export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
export function requireText(value: unknown, reason: string): string {
  const result = text(value);
  if (!result) throw new AdapterError('invalid_input', reason);
  return result;
}
export class AdapterError extends Error {
  readonly errorClass: ErrorClass;
  readonly reason?: string;
  readonly retryAfter?: string;
  constructor(errorClass: ErrorClass, reason?: string, retryAfter?: string) {
    super(reason ?? errorClass);
    this.name = 'AdapterError';
    this.errorClass = errorClass;
    this.reason = reason;
    this.retryAfter = retryAfter;
  }
}
export class TransportError extends Error {
  readonly delivery: 'not_sent' | 'possibly_sent';
  constructor(delivery: 'not_sent' | 'possibly_sent') {
    super(delivery);
    this.delivery = delivery;
  }
}
const reasons: Partial<Record<ErrorClass, string[]>> = {
  auth_expired: ['190', 'auth_removed', 'access_token_invalid', 'invalid_grant', 'invalid_token', 'invalid_access_token', '28001003', '28001008', 'error_auth', 'IllegalAccessToken'],
  permission_denied: ['10', '200', 'scope_not_authorized', 'url_ownership_unverified', 'ACCESS_DENIED', 'insufficientPermissions', '28001014', '28001018', '28001019', '28001016', 'ip_not_allowed', 'error_ip'],
  quota_exhausted: ['quotaExceeded', 'dailyLimitExceeded', 'uploadLimitExceeded', 'spam_risk_too_many_posts', 'spam_risk_too_many_pending_share', '2114007', '28003017', 'error_limit'],
  rate_limited: ['4', '17', '32', '613', 'rate_limit_exceeded', 'rateLimitExceeded', 'userRateLimitExceeded', 'THROTTLED', 'error_rate_limit'],
  invalid_input: ['100', 'file_format_check_failed', 'duration_check_failed', 'frame_rate_check_failed', 'picture_size_check_failed', 'MAX_COST_EXCEEDED', '28001007', '210005', '2100005', '2114006', '2190007', 'invalid_param', 'invalid_request'],
  transient: ['video_pull_failed', 'photo_pull_failed', 'internal_error', 'INTERNAL_SERVER_ERROR', '2100004', '28001005', '28001006'],
  platform_rejected: ['SHOP_INACTIVE', 'spam_risk_user_banned_from_posting'],
};
export function classifyCode(code: string | undefined, fallback: ErrorClass): ClassifiedError {
  if (!code) return { errorClass: fallback };
  for (const [errorClass, codes] of Object.entries(reasons)) {
    if (codes.includes(code)) return { errorClass: errorClass as ErrorClass, reason: code === 'error_ip' ? 'ip_not_allowed' : code };
  }
  return { errorClass: fallback };
}
function responseError(provider: ProviderKey, response: TransportResponse, mutation: boolean): AdapterError | undefined {
  const body = record(response.body);
  const embedded = record(body.error);
  const firstError = rows(embedded.errors)[0] ?? rows(body.errors)[0] ?? {};
  let code = text(firstError.reason) ?? text(record(firstError.extensions).code) ?? identifier(embedded.code) ?? text(body.error);
  if (provider === 'douyin') code = identifier(record(body.data).error_code ?? record(body.extra).error_code);
  if (provider === 'tiktok_shop') code = identifier(body.code);
  const explicitSuccess = code === '0' || code === 'ok';
  if (explicitSuccess) code = undefined;
  const status = response.status;
  const ok = status >= 200 && status < 300;
  if (ok && !code && (explicitSuccess || !Object.keys(embedded).length) && !rows(body.errors).length) return undefined;
  const fallback = status === 401 ? 'auth_expired' : status === 403 ? 'permission_denied' : status === 429 ? 'rate_limited'
    : status === 400 || status === 422 ? 'invalid_input' : status === 408 || status >= 500 ? (mutation ? 'outcome_unknown' : 'transient') : 'platform_rejected';
  const classified = classifyCode(code, fallback);
  const errorClass = fallback === 'outcome_unknown' ? fallback : classified.errorClass;
  return new AdapterError(errorClass, classified.reason ?? (ok ? 'provider_error' : `http_${status}`), header(response.headers, 'retry-after'));
}
export function classifyError(error: unknown): ClassifiedError {
  if (!(error instanceof AdapterError)) return { errorClass: 'transient', reason: 'unexpected_error' };
  return { errorClass: error.errorClass, reason: error.reason, retryAfter: error.retryAfter };
}
export function client(provider: ProviderKey, transport?: Transport) {
  return async (request: TransportRequest, { mutation = false, accept = [] as number[] } = {}) => {
    if (!transport) throw new AdapterError('unsupported', 'unconfigured');
    let response: TransportResponse;
    try { response = await transport(request); }
    catch (error) {
      if (error instanceof TransportError && error.delivery === 'not_sent') throw new AdapterError('transient', 'not_sent');
      throw new AdapterError(mutation ? 'outcome_unknown' : 'transient', 'transport_error');
    }
    if (response.status >= 300 && response.status < 400 &&
      (!accept.includes(response.status) || header(response.headers, 'location') !== undefined)) {
      throw new AdapterError(mutation ? 'outcome_unknown' : 'platform_rejected', 'unexpected_redirect');
    }
    if (!accept.includes(response.status)) {
      const error = responseError(provider, response, mutation);
      if (error) throw error;
    }
    return response;
  };
}
export type Client = ReturnType<typeof client>;
export const shopifyApiVersion = '2026-10';
export function checkShopifyApiVersion(headers: TransportResponse['headers']): void {
  const actual = header(headers, 'x-shopify-api-version');
  if (actual !== undefined && actual !== shopifyApiVersion) throw new AdapterError('unsupported', 'shopify_api_version_mismatch');
}
export function shopHost(value: unknown): string {
  const host = requireText(value, 'shop_domain_required').toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.myshopify\.com$/.test(host)) throw new AdapterError('invalid_input', 'invalid_shop_domain');
  return host;
}
