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
