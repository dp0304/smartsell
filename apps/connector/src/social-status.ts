import { fields, opaqueId, parseChoice, timestamp } from '../../../packages/connector-tasks/src/tasks.ts';

export const socialStatusPlatforms = ['x', 'youtube', 'facebook', 'instagram', 'reddit', 'douyin', 'xhs', 'tiktok'] as const;
export type SocialStatusPlatform = typeof socialStatusPlatforms[number];
export type SocialStatusClaim = {
  id: string; workspace_id: string; device_id: string; fencing_token: number; lease_expires_at: string;
  mode: 'account_status' | 'recent_posts'; platform?: SocialStatusPlatform; expected_identity?: string;
};
export type SocialStatusPost = { id: string; url: string; text: string; has_video: boolean };
export type SocialStatusChannel = { platform: SocialStatusPlatform } & (
  { status: 'verified'; identity: string; posts?: SocialStatusPost[] }
  | { status: 'login_required' | 'identity_mismatch' | 'unverified' | 'unsupported' }
);
export type SocialStatusResult = { channels: SocialStatusChannel[] };

export function parseSocialStatusClaim(value: unknown): SocialStatusClaim {
  const row = fields(value, ['id', 'workspace_id', 'device_id', 'mode', 'fencing_token', 'lease_expires_at'], ['platform', 'expected_identity']);
  const fence = row.fencing_token;
  if (typeof fence !== 'number' || !Number.isSafeInteger(fence) || fence < 1) throw new TypeError('Invalid social status fencing token');
  return {
    id: opaqueId(row.id, 'id'), workspace_id: opaqueId(row.workspace_id, 'workspace_id'), device_id: opaqueId(row.device_id, 'device_id'),
    mode: parseChoice(row.mode, ['account_status', 'recent_posts'], 'mode'), fencing_token: fence,
    lease_expires_at: timestamp(row.lease_expires_at, 'lease_expires_at'),
    ...(row.platform !== undefined && { platform: parseChoice(row.platform, socialStatusPlatforms, 'platform') }),
    ...(row.expected_identity !== undefined && { expected_identity: socialIdentity(row.expected_identity) }),
  };
}

function socialIdentity(value: unknown) {
  if (typeof value !== 'string' || value.length > 160 || !/^[\p{L}\p{N}@_.-]+$/u.test(value)) throw new TypeError('Invalid social status identity');
  return value;
}

function normalizeIdentity(platform: SocialStatusPlatform, identity: string) {
  return platform === 'x' || platform === 'reddit' ? identity.replace(/^@/, '').toLowerCase() : identity;
}

export function socialIdentityMatches(platform: SocialStatusPlatform, observed: string, expected: string) {
  return normalizeIdentity(platform, observed) === normalizeIdentity(platform, expected);
}

export function parseSocialStatusResult(value: unknown, claim: SocialStatusClaim): SocialStatusResult {
  const { channels } = fields(value, ['channels']);
  const platforms = claim.platform ? [claim.platform] : claim.mode === 'recent_posts' ? ['x'] : socialStatusPlatforms;
  if (!Array.isArray(channels) || channels.length !== platforms.length) throw new TypeError('Invalid social status channel count');
  const seen = new Set<string>();
  return { channels: channels.map(input => {
    const row = fields(input, ['platform', 'status'], ['identity', 'posts']);
    const platform = parseChoice(row.platform, platforms, 'platform') as SocialStatusPlatform;
    if (seen.has(platform)) throw new TypeError('Duplicate social status channel');
    seen.add(platform);
    const status = parseChoice(row.status, ['verified', 'login_required', 'identity_mismatch', 'unverified', 'unsupported'], 'status');
    if (status !== 'verified') {
      if ('identity' in row || 'posts' in row) throw new TypeError('Unverified social status contains details');
      return { platform, status };
    }
    const identity = normalizeIdentity(platform, socialIdentity(row.identity));
    if (platform === 'x' && !/^[a-z0-9_]{1,15}$/.test(identity)) throw new TypeError('Invalid X identity');
    if (claim.expected_identity && !socialIdentityMatches(platform, identity, claim.expected_identity)) throw new TypeError('Unexpected social status identity');
    if (claim.mode === 'account_status' && !('posts' in row)) return { platform, status, identity };
    if (claim.mode !== 'recent_posts' || platform !== 'x' ||
      !Array.isArray(row.posts) || row.posts.length > 5) throw new TypeError('Invalid social status posts');
    const ids = new Set<string>();
    const posts = row.posts.map(input => {
      const { id, url, text, has_video } = fields(input, ['id', 'url', 'text', 'has_video']);
      if (typeof id !== 'string' || !/^[1-9][0-9]{0,19}$/.test(id) || ids.has(id) || url !== `https://x.com/${identity}/status/${id}` ||
        typeof text !== 'string' || text.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text) || typeof has_video !== 'boolean') throw new TypeError('Invalid social status post');
      ids.add(id);
      return { id, url, text, has_video };
    });
    return { platform, status, identity, posts };
  }) };
}
