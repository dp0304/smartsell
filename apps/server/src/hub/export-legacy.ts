import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';

/** Kinds never exported (§2.11): sessions, MCP credentials and replay nonces. */
export function excludedKind(kind: string) {
  return /^session/i.test(kind) || /(?:^|\.)session/i.test(kind) || kind === 'mcp_runtime.credential' || kind === 'device_nonce' || /(?:^|\.)device_nonce$/.test(kind);
}

/**
 * Field names removed at any depth: the §2.11 list (`*_hash`, `*_ciphertext`, `private*`) plus anything that names a
 * password, secret or bearer token, so an export never carries a credential even under an unexpected name.
 */
export function excludedField(name: string) {
  return /_hash$/i.test(name) || /ciphertext$/i.test(name) || /^private/i.test(name) || /password/i.test(name) || /secret/i.test(name) ||
    /^(?:token|access_token|refresh_token|id_token|api_key|apikey|setup_token|pairing_code|code_hash)$/i.test(name);
}

export function scrub(value: unknown, depth = 0): unknown {
  if (depth > 64) return null;
  if (Array.isArray(value)) return value.map(item => scrub(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !excludedField(key)).map(([key, item]) => [key, scrub(item, depth + 1)]));
  }
  return value;
}

type Entity = { id: string; module: string; kind: string; data: Record<string, unknown>; [key: string]: unknown };

/** Rows of a local-store snapshot grouped by kind (Commands `module.kind`; Operation rows by their own kind). */
export function exportSnapshot(payload: string) {
  const state = JSON.parse(payload) as { records?: [string, Entity | null][] };
  const kinds: Record<string, unknown[]> = {};
  const skipped: Record<string, number> = {};
  const add = (kind: string, row: unknown) => {
    if (excludedKind(kind)) { skipped[kind] = (skipped[kind] ?? 0) + 1; return; }
    (kinds[kind] ??= []).push(scrub(row));
  };
  for (const [, entity] of state.records ?? []) {
    if (!entity || typeof entity !== 'object') continue;
    if (entity.module === 'operation_runtime' && entity.kind === 'record') {
      const key = entity.id;
      if (key.startsWith('outbox/') || key.startsWith('job/')) { skipped[key.split('/')[0] + '/'] = (skipped[key.split('/')[0] + '/'] ?? 0) + 1; continue; }
      const raw = entity.data?.value;
      if (typeof raw !== 'string') continue;
      let row: unknown;
      try { row = JSON.parse(raw); } catch { continue; }
      if (row === null) continue;
      const match = /^row\/([^/]+)\/(.+)$/.exec(key);
      if (match) add(decodeURIComponent(match[1]), row);
      else add(`operation_runtime/${key.split('/')[0]}`, { key, value: row });
      continue;
    }
    if (entity.module === 'operation_runtime') continue;   // revision counters
    add(`${entity.module}.${entity.kind}`, entity);
  }
  return { kinds, skipped };
}

function copyMedia(source: string, target: string) {
  let files = 0;
  const walk = (from: string, to: string) => {
    mkdirSync(to, { recursive: true, mode: 0o700 });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const path = join(from, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) walk(path, join(to, entry.name));
      else if (stat.isFile()) {
        cpSync(path, join(to, entry.name), { errorOnExist: true, force: false, preserveTimestamps: true });
        files++;
      }
    }
  };
  walk(source, target);
  return files;
}

export interface ExportResult { exportPath: string; kinds: Record<string, number>; skipped: Record<string, number>; mediaFiles: number; mediaSource: string | null }

/** `pnpm hub:export-legacy --from <old .sqlite> --out <dir> [--media <dir>]` (§2.11). The source is opened read-only. */
export function exportLegacy(options: { from: string; out: string; media?: string; now?: Date }): ExportResult {
  const from = resolve(options.from);
  const out = resolve(options.out);
  if (!existsSync(from)) throw new Error(`找不到舊資料檔 ${from}`);
  if (existsSync(out) && readdirSync(out).length) throw new Error(`輸出資料夾 ${out} 已存在且不是空的，請換一個新的資料夾`);
  const db = new DatabaseSync(from, { readOnly: true });
  let payload: string | undefined;
  try {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'snapshot'").get();
    if (!table) throw new Error(`${from} 不是 SmartSell 的本機資料檔（沒有 snapshot 資料表）`);
    payload = (db.prepare('SELECT payload FROM snapshot WHERE id = 1').get() as { payload?: string } | undefined)?.payload;
  } finally {
    db.close();
  }
  const { kinds, skipped } = payload ? exportSnapshot(payload) : { kinds: {}, skipped: {} };
  mkdirSync(out, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(out, 0o700);
  const exportPath = join(out, 'export.json');
  writeFileSync(exportPath, `${JSON.stringify({ exported_at: (options.now ?? new Date()).toISOString(), source: from, kinds }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  const mediaSource = resolve(options.media ?? join(dirname(from), 'media'));
  const mediaFiles = existsSync(mediaSource) && lstatSync(mediaSource).isDirectory() ? copyMedia(mediaSource, join(out, 'media')) : 0;
  return { exportPath, kinds: Object.fromEntries(Object.entries(kinds).map(([kind, rows]) => [kind, rows.length])), skipped, mediaFiles,
    mediaSource: existsSync(mediaSource) ? mediaSource : null };
}

export function exportLegacyMain(argv: readonly string[], log: (line: string) => void = line => console.log(line)) {
  const { values } = parseArgs({ args: argv.filter(arg => arg !== '--'), options: { from: { type: 'string' }, out: { type: 'string' }, media: { type: 'string' } } });
  if (!values.from || !values.out) {
    log('用法：pnpm hub:export-legacy --from .local/smartsell.sqlite --out ~/SmartSell-export-YYYYMMDD [--media .local/media]');
    return 2;
  }
  try {
    const result = exportLegacy({ from: values.from, out: values.out, media: values.media });
    log(`已匯出 ${result.exportPath}`);
    for (const [kind, count] of Object.entries(result.kinds).sort()) log(`  ${kind}: ${count}`);
    if (Object.keys(result.skipped).length) log(`  已排除：${Object.entries(result.skipped).map(([kind, count]) => `${kind} ${count}`).join('、')}`);
    log(result.mediaSource ? `已複製 ${result.mediaFiles} 個媒體檔（來源 ${result.mediaSource}）` : '沒有找到舊的媒體資料夾，未複製媒體。');
    log('中樞不會匯入這份資料；它只供你保存或查閱。');
    return 0;
  } catch (error) {
    log(`匯出失敗：${(error as Error).message}`);
    return 1;
  }
}
