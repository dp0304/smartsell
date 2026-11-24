// Selector data file (§8.11): selectors, aria names and text regexes are data.
// The bundled selectors.json is the default; the hub can ship a newer version
// through GET /api/v1/device/driver-config. Only strings are allowed, every
// regex is at most 200 characters and must compile; an invalid file is
// rejected and the previous table stays in use.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import bundled from './selectors.json' with { type: 'json' };
import { writeAtomic } from '../runtime/job-store.ts';
import type { CdpPage, NodeRef } from './types.ts';

export interface SelectorQuery {
  css?: string; role?: string; name?: string; text?: string; attr?: string; pattern?: string;
  hidden?: 'allow'; scope?: string; frame?: string;
}
export interface StepSelectors { primary: SelectorQuery[]; fallback: SelectorQuery[] }
export interface ProviderSelectors { steps: Record<string, StepSelectors>; patterns: Record<string, string> }
export interface SelectorTable { schema: 'smartsell.driver-selectors.v1'; version: string; x: ProviderSelectors; tiktok: ProviderSelectors }

export class SelectorTableError extends Error {
  constructor(message: string) { super(message); this.name = 'SelectorTableError'; }
}

const queryKeys = new Set(['css', 'role', 'name', 'text', 'attr', 'pattern', 'hidden', 'scope', 'frame']);
const regexKeys = new Set(['name', 'text', 'pattern']);

/** Steps and patterns the drivers depend on; a downloaded table must define all of them. */
export const REQUIRED: Record<'x' | 'tiktok', { steps: string[]; patterns: string[] }> = {
  x: {
    steps: ['x.ready', 'x.identity', 'x.file_input', 'x.attached', 'x.textbox', 'x.post_button', 'x.toast', 'x.discard', 'x.tweet', 'x.tweet_text',
      'x.tweet_time', 'x.tweet_link', 'x.tweet_pinned', 'x.tweet_author', 'x.login_button', 'x.arkose', 'x.reply_settings', 'x.reply_menu_item'],
    patterns: ['toast_success', 'upload_url', 'create_tweet_url', 'risk_text', 'error_text', 'login_url', 'flow_url', 'two_factor_text', 'risk_url',
      'captcha_frame', 'risk_codes', 'compose_path', 'home_path', 'reply_option_following', 'reply_option_verified', 'reply_option_mentioned',
      'reply_state_following', 'reply_state_verified', 'reply_state_mentioned'],
  },
  tiktok: {
    steps: ['tt.ready', 'tt.legacy_frame', 'tt.file_input', 'tt.popup_buttons', 'tt.uploaded', 'tt.upload_error', 'tt.caption', 'tt.mention_popover', 'tt.visibility',
      'tt.allow_comment', 'tt.allow_reuse', 'tt.show_more', 'tt.disclosure', 'tt.disclosure_your_brand', 'tt.disclosure_branded', 'tt.ai_label',
      'tt.ai_confirm', 'tt.post_button', 'tt.continue_dialog', 'tt.post_now', 'tt.discard', 'tt.discard_confirm', 'tt.content_row', 'tt.content_empty',
      'tt.row_link', 'tt.row_time', 'tt.handle', 'tt.captcha'],
    patterns: ['upload_path', 'settings_path', 'content_path', 'user_id', 'success_url', 'success_text', 'post_api', 'error_text', 'risk_text',
      'restricted_text', 'login_url', 'two_factor_url', 'captcha_frame', 'privacy_PUBLIC_TO_EVERYONE', 'privacy_MUTUAL_FOLLOW_FRIENDS',
      'privacy_FOLLOWER_OF_CREATOR', 'privacy_SELF_ONLY'],
  },
};
const pathPatterns = new Set(['compose_path', 'home_path', 'upload_path', 'settings_path', 'content_path']);

function regex(source: string, where: string) {
  if (source.length > 200) throw new SelectorTableError(`${where}: regex longer than 200 characters`);
  try { new RegExp(source, 'i'); } catch { throw new SelectorTableError(`${where}: regex does not compile`); }
}
function plainObject(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SelectorTableError(`${where}: expected an object`);
  return value as Record<string, unknown>;
}

function validateQuery(value: unknown, where: string): SelectorQuery {
  const query = plainObject(value, where);
  for (const [key, item] of Object.entries(query)) {
    if (!queryKeys.has(key)) throw new SelectorTableError(`${where}: unknown key ${key}`);
    if (typeof item !== 'string' || !item.length || item.length > 400) throw new SelectorTableError(`${where}.${key}: expected a non-empty string`);
    if (regexKeys.has(key)) regex(item, `${where}.${key}`);
  }
  if (!query.css && !query.role) throw new SelectorTableError(`${where}: needs css or role`);
  if (query.role && !query.name) throw new SelectorTableError(`${where}: role needs a name regex`);
  if (query.hidden !== undefined && query.hidden !== 'allow') throw new SelectorTableError(`${where}.hidden: only "allow"`);
  return query as SelectorQuery;
}

function validateProvider(value: unknown, provider: 'x' | 'tiktok'): ProviderSelectors {
  const input = plainObject(value, provider);
  for (const key of Object.keys(input)) if (key !== 'steps' && key !== 'patterns') throw new SelectorTableError(`${provider}: unknown key ${key}`);
  const steps = plainObject(input.steps, `${provider}.steps`);
  const patterns = plainObject(input.patterns, `${provider}.patterns`);
  const outSteps: Record<string, StepSelectors> = {};
  for (const [id, raw] of Object.entries(steps)) {
    const step = plainObject(raw, `${provider}.steps.${id}`);
    for (const key of Object.keys(step)) if (key !== 'primary' && key !== 'fallback') throw new SelectorTableError(`${id}: unknown key ${key}`);
    const lists = { primary: step.primary, fallback: step.fallback ?? [] };
    if (!Array.isArray(lists.primary) || !lists.primary.length || !Array.isArray(lists.fallback)) throw new SelectorTableError(`${id}: primary must be a non-empty list`);
    outSteps[id] = {
      primary: lists.primary.map((query, index) => validateQuery(query, `${id}.primary[${index}]`)),
      fallback: lists.fallback.map((query, index) => validateQuery(query, `${id}.fallback[${index}]`)),
    };
  }
  const outPatterns: Record<string, string> = {};
  for (const [key, item] of Object.entries(patterns)) {
    if (typeof item !== 'string' || !item.length) throw new SelectorTableError(`${provider}.patterns.${key}: expected a string`);
    if (pathPatterns.has(key)) { if (!item.startsWith('/') || item.length > 200) throw new SelectorTableError(`${provider}.patterns.${key}: expected a path`); }
    else regex(item, `${provider}.patterns.${key}`);
    outPatterns[key] = item;
  }
  for (const id of REQUIRED[provider].steps) if (!outSteps[id]) throw new SelectorTableError(`${provider}: missing step ${id}`);
  for (const key of REQUIRED[provider].patterns) if (!outPatterns[key]) throw new SelectorTableError(`${provider}: missing pattern ${key}`);
  return { steps: outSteps, patterns: outPatterns };
}

export function validateSelectorTable(input: unknown): SelectorTable {
  const table = plainObject(input, 'table');
  if (table.schema !== 'smartsell.driver-selectors.v1') throw new SelectorTableError('schema must be smartsell.driver-selectors.v1');
  if (typeof table.version !== 'string' || !/^\d{4}\.\d{1,2}\.\d{1,4}$/.test(table.version)) throw new SelectorTableError('version must look like 2026.11.3');
  for (const key of Object.keys(table)) if (!['schema', 'version', 'x', 'tiktok'].includes(key)) throw new SelectorTableError(`unknown key ${key}`);
  return { schema: 'smartsell.driver-selectors.v1', version: table.version, x: validateProvider(table.x, 'x'), tiktok: validateProvider(table.tiktok, 'tiktok') };
}

export function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number), right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff) return diff < 0 ? -1 : 1;
  }
  return 0;
}

export function defaultSelectors(): SelectorTable { return validateSelectorTable(structuredClone(bundled)); }

export function patternOf(table: SelectorTable, provider: 'x' | 'tiktok', key: string, flags = 'i') {
  const source = table[provider].patterns[key];
  if (source === undefined) throw new SelectorTableError(`missing pattern ${key}`);
  return new RegExp(source, flags);
}
export function pathOf(table: SelectorTable, provider: 'x' | 'tiktok', key: string) { return table[provider].patterns[key]; }

/**
 * Keeps the active table: the newer of the bundled default and the last valid
 * download stored under <userData>/driver-config/selectors.json.
 */
export class SelectorStore {
  #table: SelectorTable;
  #source: 'bundled' | 'downloaded' = 'bundled';
  #health: 'ok' | 'unknown' = 'ok';
  readonly path: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.path = join(dir, 'selectors.json');
    this.#table = defaultSelectors();
    try {
      const stored = validateSelectorTable(JSON.parse(readFileSync(this.path, 'utf8')));
      if (compareVersions(stored.version, this.#table.version) > 0) { this.#table = stored; this.#source = 'downloaded'; }
    } catch { /* No stored table, or it is no longer valid: use the bundled default. */ }
  }

  get table() { return this.#table; }
  get version() { return this.#table.version; }
  get source() { return this.#source; }
  /** 'unknown' after a rejected download (§8.11): reported in heartbeat drivers[].health. */
  get health() { return this.#health; }

  needsUpdate(offered: { version: string; sha256: string } | null) {
    return !!offered && compareVersions(offered.version, this.#table.version) > 0;
  }

  /** Verifies the hub's sha256 and the schema; on failure keeps the current table and marks health unknown. */
  apply(bytes: Uint8Array, offered: { version: string; sha256: string }): { ok: true } | { ok: false; reason: string } {
    try {
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== offered.sha256) throw new SelectorTableError('sha256 mismatch');
      const table = validateSelectorTable(JSON.parse(Buffer.from(bytes).toString('utf8')));
      if (table.version !== offered.version) throw new SelectorTableError('version differs from the heartbeat');
      writeAtomic(this.path, Buffer.from(bytes));
      this.#table = table;
      this.#source = 'downloaded';
      this.#health = 'ok';
      return { ok: true };
    } catch (error) {
      this.#health = 'unknown';
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
}

// ---------- lookup ----------
export interface Found { node: NodeRef; matched: 'primary' | 'fallback'; value: string | null }

async function runQuery(page: CdpPage, query: SelectorQuery, within?: NodeRef): Promise<{ node: NodeRef; value: string | null }[]> {
  let scopes: (NodeRef | undefined)[] = [within];
  if (query.frame) {
    const frames = await page.queryCss(query.frame, { within, visible: false });
    if (!frames.length) return [];
    scopes = frames;
  }
  if (query.scope) {
    const next: NodeRef[] = [];
    for (const scope of scopes) next.push(...await page.queryCss(query.scope, { within: scope, visible: true }));
    if (!next.length) return [];
    scopes = next;
  }
  const nodes: NodeRef[] = [];
  for (const scope of scopes) {
    if (query.css) {
      nodes.push(...await page.queryCss(query.css, { within: scope, visible: query.hidden !== 'allow', text: query.text ? new RegExp(query.text, 'i') : undefined }));
    } else if (query.role) {
      nodes.push(...await page.queryRole(query.role, new RegExp(query.name!, 'i'), { within: scope }));
    }
  }
  const out: { node: NodeRef; value: string | null }[] = [];
  for (const node of nodes) {
    let value: string | null = null;
    if (query.attr || query.pattern) {
      const raw = query.attr ? await page.attribute(node, query.attr) : await page.innerText(node);
      if (raw === null) continue;
      if (query.pattern) {
        const match = new RegExp(query.pattern, 'i').exec(raw.trim());
        if (!match) continue;
        value = match[1] ?? match[0];
      } else value = raw;
    }
    out.push({ node, value });
  }
  return out;
}

/** Tries the primary queries, then the fallback queries; returns the first non-empty result set. */
export async function findStep(page: CdpPage, table: SelectorTable, provider: 'x' | 'tiktok', step: string, within?: NodeRef): Promise<Found[]> {
  const entry = table[provider].steps[step];
  if (!entry) throw new SelectorTableError(`unknown step ${step}`);
  for (const [matched, list] of [['primary', entry.primary], ['fallback', entry.fallback]] as const) {
    for (const query of list) {
      const found = await runQuery(page, query, within);
      if (found.length) return found.map(item => ({ ...item, matched }));
    }
  }
  return [];
}

/** Every match of every query of a step (used for dismissing several stacked dialogs). */
export async function findEvery(page: CdpPage, table: SelectorTable, provider: 'x' | 'tiktok', step: string, within?: NodeRef): Promise<Found[]> {
  const entry = table[provider].steps[step];
  if (!entry) throw new SelectorTableError(`unknown step ${step}`);
  const out: Found[] = [];
  const seen = new Set<number>();
  for (const [matched, list] of [['primary', entry.primary], ['fallback', entry.fallback]] as const) {
    for (const query of list) {
      for (const item of await runQuery(page, query, within)) {
        if (seen.has(item.node.backendNodeId)) continue;
        seen.add(item.node.backendNodeId);
        out.push({ ...item, matched });
      }
    }
  }
  return out;
}
