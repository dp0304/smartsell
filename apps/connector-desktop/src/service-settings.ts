import { randomUUID } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { apiOrigin } from '../../connector/src/device-client.ts';
import { channelId, channelRows } from './channels.ts';

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
      try { saveSetting(path, value); }
      catch { throw new Error('无法保存本机服务地址。'); }
    },
  };
}

function saveSetting(path: string, value: string) {
  const temp = `${path}.${randomUUID()}.part`;
  try {
    writeFileSync(temp, value, { mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } finally { rmSync(temp, { force: true }); }
}

export function setupChannelSettings(path: string) {
  function selection(value: unknown) {
    if (!Array.isArray(value) || value.length > channelRows.length) throw new Error('请选择支持的平台。');
    return [...new Set(value.map(channelId))];
  }
  return {
    load() {
      try { return selection(JSON.parse(readFileSync(path, 'utf8'))); }
      catch { return []; }
    },
    save(value: unknown) {
      const ids = selection(value);
      try { saveSetting(path, JSON.stringify(ids)); }
      catch { throw new Error('无法保存所选平台。'); }
      return ids;
    },
  };
}

export function workbenchOrigin(origin: string | undefined) {
  const url = origin && URL.parse(origin);
  if (!url || url.protocol !== 'https:' || url.href !== `${url.origin}/` ||
    isIP(url.hostname.replace(/^\[|\]$/g, '')) || /(?:^|\.)localhost\.?$/i.test(url.hostname)) return;
  return url.origin;
}

/** What this machine does (§2.9 step 5, §6.2): a posting Worker, or the owner's laptop (Codex relay + alerts). */
export type AppRole = 'worker' | 'agent';
export interface AppSettings {
  role: AppRole | null;
  /** Login item; turned on after the first pairing, can be switched off in the settings (§8.2). */
  autostart: boolean | null;
  /** Legacy work lines (抖音、小紅書、知乎、商品匯入) live under 「進階」 and stay off by default (§8.17). */
  legacy_lines: boolean;
  /** Laptop mode: hub address typed before the first Codex connection. */
  agent_hub_origin: string | null;
}

const DEFAULT_APP_SETTINGS: AppSettings = { role: null, autostart: null, legacy_lines: false, agent_hub_origin: null };

function appSettingsValue(value: unknown): AppSettings {
  const row = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const origin = typeof row.agent_hub_origin === 'string' ? URL.parse(row.agent_hub_origin) : null;
  return {
    role: row.role === 'worker' || row.role === 'agent' ? row.role : null,
    autostart: typeof row.autostart === 'boolean' ? row.autostart : null,
    legacy_lines: row.legacy_lines === true,
    agent_hub_origin: origin && (origin.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) ? origin.origin : null,
  };
}

export function appSettings(path: string) {
  return {
    load(): AppSettings {
      try { return appSettingsValue(JSON.parse(readFileSync(path, 'utf8'))); }
      catch { return { ...DEFAULT_APP_SETTINGS }; }
    },
    save(patch: Partial<AppSettings>): AppSettings {
      const next = appSettingsValue({ ...this.load(), ...patch });
      try { saveSetting(path, `${JSON.stringify(next, null, 2)}\n`); }
      catch { throw new Error('無法儲存 SmartSell 的設定。'); }
      return next;
    },
  };
}
