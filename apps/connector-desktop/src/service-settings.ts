import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { apiOrigin } from '../../connector/src/device-client.ts';

export function serviceOrigin(input: unknown) {
  const message = '请填写工作台显示的 HTTPS 服务地址。开发环境可使用本机 HTTP 地址。';
  if (typeof input !== 'string' || input.length > 1024) throw new Error(message);
  const value = input.trim();
  if (!/^https:\/\/[^/?#\\\s]+\/?$/i.test(value) && !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?\/?$/i.test(value)) {
    throw new Error(message);
  }
  try { return apiOrigin(value); }
  catch { throw new Error(message); }
}

export function serviceSettings(path: string) {
  return {
    load(): string | undefined {
      try { return serviceOrigin(readFileSync(path, 'utf8')); }
      catch { return undefined; }
    },
    save(origin: string) {
      const value = serviceOrigin(origin);
      const temp = `${path}.${randomUUID()}.part`;
      try {
        writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
        renameSync(temp, path);
      } catch { throw new Error('无法保存本机服务地址。'); }
      finally { rmSync(temp, { force: true }); }
    },
  };
}

export function workbenchOrigin(origin: string | undefined) {
  const url = origin && URL.parse(origin);
  if (!url || url.protocol !== 'https:' || url.href !== `${url.origin}/` ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) || /(?:^|\.)localhost\.?$/i.test(url.hostname)) return;
  return url.origin;
}
