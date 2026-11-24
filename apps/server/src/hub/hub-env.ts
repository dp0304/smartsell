import { randomBytes } from 'node:crypto';
import { chmodSync, closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/** The only keys `hub.env` may set (§2.5). Anything else in the file is ignored and reported by name. */
export const HUB_ENV_KEYS = [
  'APP_SECRET', 'SETUP_TOKEN', 'PUBLIC_ORIGIN', 'PORT', 'SMARTSELL_DATA_FILE', 'MEDIA_DIRECTORY', 'SMARTSELL_MAX_UPLOAD_BYTES', 'SMARTSELL_WEB_DIST',
] as const;
export type HubEnvKey = typeof HUB_ENV_KEYS[number];
export type HubEnvValues = Partial<Record<HubEnvKey, string>>;
export const HUB_ENV_FILE = 'hub.env';

const allowed = new Set<string>(HUB_ENV_KEYS);
export const isHubEnvKey = (key: string): key is HubEnvKey => allowed.has(key);
export const hubEnvPath = (hubDir: string) => join(hubDir, HUB_ENV_FILE);

export interface ParsedHubEnv {
  values: HubEnvValues;
  /** Keys present in the file but outside the allow-list (values are never reported). */
  ignored: string[];
  /** 1-based line numbers that are not `KEY=VALUE`. */
  invalidLines: number[];
}

function unquote(value: string) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed.at(-1) === trimmed[0]) return trimmed.slice(1, -1);
  return trimmed;
}

/** `KEY=VALUE` lines; blank lines and `#` comments are skipped; the first occurrence of a key wins. */
export function parseHubEnv(text: string): ParsedHubEnv {
  const values: HubEnvValues = {};
  const ignored: string[] = [];
  const invalidLines: number[] = [];
  text.replace(/^﻿/, '').split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!match) return void invalidLines.push(index + 1);
    const [, key, value] = match;
    if (!isHubEnvKey(key)) return void (ignored.includes(key) || ignored.push(key));
    if (values[key] === undefined) values[key] = unquote(value);
  });
  return { values, ignored, invalidLines };
}

export interface HubEnvFile extends ParsedHubEnv {
  path: string;
  exists: boolean;
  /** POSIX permission bits, undefined on Windows or when the file is missing. */
  mode?: number;
}

export function readHubEnvFile(hubDir: string, platform: NodeJS.Platform = process.platform): HubEnvFile {
  const path = hubEnvPath(hubDir);
  if (!existsSync(path)) return { path, exists: false, values: {}, ignored: [], invalidLines: [] };
  const stat = lstatSync(path);
  if (!stat.isFile()) throw new Error(`${path} 必須是一般檔案`);
  return { path, exists: true, ...parseHubEnv(readFileSync(path, 'utf8')), ...(platform === 'win32' ? {} : { mode: stat.mode & 0o777 }) };
}

/** Fills only variables that are not already set; returns the keys it applied. */
export function applyHubEnv(values: HubEnvValues, env: NodeJS.ProcessEnv = process.env) {
  const applied: HubEnvKey[] = [];
  for (const key of HUB_ENV_KEYS) {
    const value = values[key];
    if (value === undefined || env[key] !== undefined) continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}

/**
 * Adds missing keys to `hub.env` without changing existing values or other lines; the file is written atomically
 * with mode 0600. Returns which keys were added and which already had a value.
 */
export function mergeHubEnv(hubDir: string, values: HubEnvValues, platform: NodeJS.Platform = process.platform) {
  const current = readHubEnvFile(hubDir, platform);
  const text = current.exists ? readFileSync(current.path, 'utf8') : '';
  const added: HubEnvKey[] = [];
  const kept: HubEnvKey[] = [];
  const lines: string[] = [];
  for (const key of HUB_ENV_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    if (current.values[key] !== undefined) { kept.push(key); continue; }
    if (/[\r\n\0]/.test(value)) throw new Error(`${key} 不能包含換行`);
    lines.push(`${key}=${value}`);
    added.push(key);
  }
  if (!added.length && current.exists) {
    if (platform !== 'win32') chmodSync(current.path, 0o600);
    return { path: current.path, added, kept };
  }
  const header = current.exists ? '' : '# SmartSell Hub settings written by pnpm hub:init. Keep this file private (mode 0600).\n';
  const body = `${header}${text}${text && !text.endsWith('\n') ? '\n' : ''}${lines.map(line => `${line}\n`).join('')}`;
  writePrivateFile(current.path, body, platform);
  return { path: current.path, added, kept };
}

/** Atomic replace of a file readable only by its owner. */
export function writePrivateFile(path: string, content: string, platform: NodeJS.Platform = process.platform) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(temporary, { force: true });
    throw error;
  }
  closeSync(fd);
  try {
    if (platform !== 'win32') chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

export const randomSecretHex = () => randomBytes(32).toString('hex');
