import type { Context } from '@smartsell/contracts';
import { audit } from './input.js';

export const ownedSocialProviders = ['douyin', 'xiaohongshu', 'tiktok', 'meta_instagram', 'meta_facebook', 'youtube'] as const;

export function createOwnedSocialAccount(ctx: Context, fields: {
  provider: typeof ownedSocialProviders[number]; external_account_id: string; display_name: string;
  brand_id: string; owner_id: string; default_timezone: string;
}, source: 'ownership_attested' | 'worker_channel_registration') {
  const account = ctx.create('social_account', { ...fields, status: 'active' });
  audit(ctx, 'account.social_account.registered', { social_account_id: account.id, source });
  return account;
}
