import { fields, opaqueId, sha256, type BrowserTarget, type ConnectorTask, type PublishTask } from '../../../packages/connector-tasks/src/tasks.ts';
import type { PostResult } from '../../connector/src/workflow.ts';

export const creators = {
  douyin: 'https://creator.douyin.com/',
  xhs: 'https://creator.xiaohongshu.com/',
} as const;

export function httpsOrigin(input: string | undefined): string | undefined {
  if (!input) return;
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.href !== `${url.origin}/`) throw new Error('需要配置 HTTPS 服务源地址。');
  return url.origin;
}

const sellerHosts: Record<string, readonly string[]> = {
  shopify: ['admin.shopify.com'],
  tiktok_shop: ['seller.tiktok.com', 'seller-us.tiktok.com', 'seller-uk.tiktok.com', 'seller-sg.tiktok.com', 'seller-id.tiktok.com', 'seller-ph.tiktok.com', 'seller-vn.tiktok.com', 'seller-th.tiktok.com', 'seller-my.tiktok.com', 'seller.tiktokglobalshop.com'],
  amazon_sp: ['sellercentral.amazon.com', 'sellercentral.amazon.co.uk', 'sellercentral.amazon.de', 'sellercentral.amazon.co.jp', 'sellercentral.amazon.ca', 'sellercentral.amazon.com.au', 'sellercentral.amazon.com.mx', 'sellercentral.amazon.com.br', 'sellercentral.amazon.fr', 'sellercentral.amazon.it', 'sellercentral.amazon.es', 'sellercentral.amazon.in'],
  shopee: ['seller.shopee.sg', 'seller.shopee.com.my', 'seller.shopee.ph', 'seller.shopee.co.id', 'seller.shopee.co.th', 'seller.shopee.vn', 'seller.shopee.tw', 'seller.shopee.com.br'],
  lazada: ['sellercenter.lazada.sg', 'sellercenter.lazada.com.my', 'sellercenter.lazada.co.id', 'sellercenter.lazada.co.th', 'sellercenter.lazada.vn', 'sellercenter.lazada.com.ph'],
};

export function sellerPortal(job: { provider: string; external_store_id: string; portal_url?: string }) {
  const url = job.portal_url && URL.parse(job.portal_url);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return;
  const shopDomain = job.provider === 'shopify' && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(job.external_store_id)
    ? job.external_store_id : undefined;
  if (url.hostname === shopDomain) return `${url.origin}/admin`;
  if (!Object.hasOwn(sellerHosts, job.provider) || !sellerHosts[job.provider].includes(url.hostname)) return;
  const storePath = job.provider === 'shopify' && /^\/store\/([a-z0-9][a-z0-9-]*)(?:\/|$)/.exec(url.pathname);
  if (storePath) {
    if (shopDomain && `${storePath[1]}.myshopify.com` !== shopDomain) return;
    return `${url.origin}/store/${storePath[1]}`;
  }
  return `${url.origin}/`;
}

export function isPublish(task: ConnectorTask): task is PublishTask {
  return task.kind === 'douyin.video.publish' || task.kind === 'xhs.note.publish';
}

export function parseReceipt(input: unknown, app: BrowserTarget['app'], expectedPost?: string): PostResult {
  const row = fields(input, ['postId', 'url', 'objectId', 'sha256']);
  const platform_post_id = opaqueId(row.postId, 'platform_post_id');
  if (expectedPost && expectedPost !== platform_post_id) throw new Error('作品 ID 与核实任务不一致。');
  if (typeof row.url !== 'string' || row.url.length > 2048) throw new Error('无效的作品地址。');
  const url = URL.parse(row.url);
  const pattern = app === 'douyin' ? /^\/(?:video|note)\/([0-9]+)\/?$/ : /^\/(?:explore|discovery\/item)\/([a-f0-9]+)\/?$/;
  const hosts = app === 'douyin' ? ['www.douyin.com', 'douyin.com'] : ['www.xiaohongshu.com', 'xiaohongshu.com'];
  if (!url || url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.port || url.username || url.password ||
    url.search || url.hash || pattern.exec(url.pathname)?.[1] !== platform_post_id) throw new Error('请填写与作品 ID 一致的官方作品链接（去除查询参数和片段）。');
  return {
    platform_post_id, result_url: url.href,
    evidence: [{ kind: 'masked_screenshot', object_id: opaqueId(row.objectId, 'object_id'), sha256: sha256(row.sha256, 'sha256') }],
  };
}

export const challengeReasons = ['captcha', 'risk_control', 'login_expired', 'app_prompt'] as const;
export const mediaExtensions = ['jpg', 'jpeg', 'png', 'webp', 'mp4', 'mov'];
