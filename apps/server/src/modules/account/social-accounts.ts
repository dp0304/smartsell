import type { Context } from '@smartsell/contracts';
import { audit, fail } from './input.js';

export const ownedSocialProviders = ['douyin', 'xiaohongshu', 'tiktok', 'meta_instagram', 'meta_facebook', 'youtube', 'x'] as const;

/** X identity is the lowercase handle (phase1-design §3.3); matching is case-insensitive. */
export const xHandle = /^[a-z0-9_]{1,15}$/;
/** Display handle: lowercase, without '@', at most 64 characters. */
export const displayHandle = /^[a-z0-9_.]{1,64}$/;

export function normalizeXHandle(value: string) {
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (!xHandle.test(handle)) fail('INVALID_X_HANDLE', 422);
  return handle;
}

export function normalizeDisplayHandle(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') fail('INVALID_INPUT', 422);
  const handle = value.trim().replace(/^@/, '').toLowerCase();
  if (!displayHandle.test(handle)) fail('INVALID_INPUT', 422);
  return handle;
}

export function createOwnedSocialAccount(ctx: Context, fields: {
  provider: typeof ownedSocialProviders[number]; external_account_id: string; display_name: string;
  brand_id: string; owner_id: string; default_timezone: string; handle?: string | null;
}, source: 'ownership_attested' | 'worker_channel_registration') {
  const account = ctx.create('social_account', { ...fields, handle: fields.handle ?? null, status: 'active' });
  audit(ctx, 'account.social_account.registered', { social_account_id: account.id, source });
  return account;
}
