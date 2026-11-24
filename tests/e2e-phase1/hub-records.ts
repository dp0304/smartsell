// Read-only view of the hub's own records for assertions the read models do not expose (seq, fence_override, events).
// Only ever opened while the hub process is stopped: a reader on the rollback-journal SQLite file could make a running
// hub's commit fail with SQLITE_BUSY, which would change the behaviour under test.
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

export type HubRow = Record<string, unknown> & { id: string };
export interface HubRecords {
  list(kind: string): HubRow[];
  get(kind: string, id: string): HubRow | undefined;
}

export function readHubRecords(statePath: string): HubRecords {
  const db = new DatabaseSync(`${pathToFileURL(statePath).href}?mode=ro`, { readOnly: true } as never);
  let payload: string | undefined;
  try {
    payload = (db.prepare('SELECT payload FROM snapshot WHERE id = 1').get() as { payload: string } | undefined)?.payload;
  } finally { db.close(); }
  if (!payload) throw new Error(`no snapshot in ${statePath}`);
  const state = JSON.parse(payload) as { records: [string, unknown][] };
  const byKind = new Map<string, HubRow[]>();
  for (const [key, entity] of state.records) {
    let parts: unknown;
    try { parts = JSON.parse(key); } catch { continue; }
    if (!Array.isArray(parts)) continue;
    const id = String(parts[parts.length - 1] ?? '');
    const match = /^row\/([^/]+)\/([^/]+)$/.exec(id);
    if (!match || !parts.includes('operation_runtime')) continue;
    const value = (entity as { data?: { value?: unknown } })?.data?.value;
    if (typeof value !== 'string') continue;
    const row = JSON.parse(value) as HubRow;
    const kind = decodeURIComponent(match[1]);
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind)!.push(row);
  }
  return {
    list: kind => [...(byKind.get(kind) ?? [])],
    get: (kind, id) => byKind.get(kind)?.find(row => row.id === id),
  };
}
