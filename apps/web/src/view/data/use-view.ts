import { createContext, useContext, useSyncExternalStore } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { asRecord, request, workspacePath, type Envelope, type Method, type RecordData, type Session } from '@smartsell/sdk';
import type { DecisionAction, DecisionItem } from '@smartsell/ui';
import { normalizeQuery, viewKey, viewPrefix, type ViewQuery } from './keys';

export interface ViewContextValue { ws: string; session: Session; workspace: Session['workspaces'][number]; base: string }
export const ViewContext = createContext<ViewContextValue | null>(null);
export function useViewContext() {
  const value = useContext(ViewContext);
  if (!value) throw new Error('useViewContext outside ViewApp');
  return value;
}

export type ViewEnvelope<T> = Envelope<T> & { as_of?: string };

// The workspace time zone arrives with the read models; period presets use it to compute "today".
const zones = new Map<string, string>();
export const workspaceZone = (ws: string) => zones.get(ws);
function rememberZone(ws: string, path: string, data: unknown) {
  const record = asRecord(data);
  // Plan and product reads carry their own time zone; only workspace-wide views define the workspace zone.
  const workspaceWide = path === '/views/home' || path === '/views/agent-presence';
  const zone = [workspaceWide ? record.timezone : undefined, asRecord(record.period).tz, asRecord(record.range).tz]
    .find(value => typeof value === 'string' && value);
  if (typeof zone === 'string') zones.set(ws, zone);
}

// Summary pages (products, plans) total every row, so they read all pages; past this many rows they say so.
const pageLimit = 200;
const maxPages = 25;
// Cursors are offsets, so a row that moves to the front between two page reads shows up twice (and pushes another past
// the read). A repeated id means the list shifted: read again from the first page; the last try keeps the first copy.
export async function readAllPages<T>(url: string, params: Record<string, string>, signal?: AbortSignal, tries = 3) {
  for (let attempt = 1; ; attempt++) {
    const rows: unknown[] = [];
    const seen = new Set<unknown>();
    let envelope: ViewEnvelope<T> | undefined;
    let cursor: string | undefined;
    let shifted = false;
    for (let page = 0; page < maxPages && !shifted; page++) {
      envelope = await request<T>(url, { query: { ...params, limit: String(pageLimit), ...(cursor && { cursor }) }, signal }) as ViewEnvelope<T>;
      if (!Array.isArray(envelope.data)) return envelope;
      for (const row of envelope.data) {
        const id = asRecord(row).id;
        if (id !== undefined && seen.has(id)) { shifted = true; continue; }
        seen.add(id);
        rows.push(row);
      }
      cursor = envelope.next_cursor ?? undefined;
      if (!cursor) break;
    }
    if (!shifted || attempt >= tries) return { ...envelope!, data: rows as T, next_cursor: cursor ?? null };
  }
}

/** Reads a workspace-relative path under the `view` cache prefix that the stream invalidates. */
export function useView<T>(path: string, query: ViewQuery = {}, options: { enabled?: boolean; allPages?: boolean } = {}) {
  const { ws } = useViewContext();
  const params = normalizeQuery(query);
  const result = useQuery({
    queryKey: viewKey(ws, path, params, options.allPages), enabled: options.enabled ?? true, placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const url = `${workspacePath(ws)}${path}`;
      const envelope = options.allPages ? await readAllPages<T>(url, params, signal) : await request<T>(url, { query: params, signal }) as ViewEnvelope<T>;
      rememberZone(ws, path, envelope.data);
      return envelope;
    },
  });
  const data = result.data;
  const nested = asRecord(data?.data).as_of;
  // List read models have no as_of of their own; the fetch time is the honest freshness for them.
  const fetched = result.dataUpdatedAt ? new Date(result.dataUpdatedAt).toISOString() : undefined;
  return { ...result, value: data?.data, asOf: typeof nested === 'string' ? nested : data?.as_of ?? fetched, nextCursor: data?.next_cursor ?? null };
}
export type ViewResult<T> = ReturnType<typeof useView<T>>;

const writeMethods = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
/** Builds the request a DecisionItem action describes; the path must stay inside the workspace API. */
export function decisionRequest(ws: string, action: Pick<DecisionAction, 'method' | 'path' | 'version' | 'body' | 'reason_field'>, reason?: string) {
  const method = String(action.method).toUpperCase();
  if (!writeMethods.has(method)) throw new Error('invalid_decision_method');
  const path = String(action.path);
  if (!/^\/[\w\-.~:%/]*$/.test(path) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) throw new Error('invalid_decision_path');
  // Endpoints name the reason differently (reason, note) or ignore it; the decision view says which.
  const field = action.reason_field === undefined ? 'reason' : action.reason_field;
  const body: RecordData = { ...asRecord(action.body), ...(reason && field ? { [field]: reason } : {}) };
  const version = action.version === null || action.version === undefined ? undefined : action.version;
  return { url: `${workspacePath(ws)}${path}`, method: method as Method, body, version };
}

export type DecisionOutcome = { kind: 'done' } | { kind: 'blocked'; blockers: string[] } | { kind: 'expired' } | { kind: 'stale' } | { kind: 'partial'; skipped: number };
const records = (value: unknown) => Array.isArray(value) ? value.map(asRecord) : [];
/** A decision endpoint can answer 200 without carrying the decision out; this reads which outcome it was. */
export function decisionOutcome(item: Pick<DecisionItem, 'kind'>, data: unknown): DecisionOutcome {
  const row = asRecord(data);
  if (row.decision_status === 'blocked') {
    const blockers = records(asRecord(row.precheck).items).filter(check => check.severity === 'blocker' && check.result === 'fail')
      .map(check => String(check.message ?? check.check_key ?? '')).filter(Boolean);
    return { kind: 'blocked', blockers };
  }
  if (row.decision_status === 'expired') return { kind: 'expired' };
  if (item.kind === 'change_set' && row.status === 'stale') return { kind: 'stale' };
  if (item.kind === 'change_set' && row.status === 'partial') return { kind: 'partial', skipped: records(row.items).filter(entry => entry.status === 'conflict').length };
  return { kind: 'done' };
}

/** Outcomes whose item leaves the decisions list on the next read, so the card that showed the outcome unmounts. */
export type UnfinishedOutcome = Extract<DecisionOutcome, { kind: 'expired' | 'stale' | 'partial' }>;
export const leavesList = (outcome: DecisionOutcome): outcome is UnfinishedOutcome => outcome.kind === 'expired' || outcome.kind === 'stale' || outcome.kind === 'partial';
export interface UnfinishedDecision { id: string; kind: string; title: string; outcome: UnfinishedOutcome }
// Kept per workspace until the person dismisses them, outside any card, so the notice survives the refetch.
const unfinished = new Map<string, readonly UnfinishedDecision[]>();
const unfinishedListeners = new Set<() => void>();
const noUnfinished: readonly UnfinishedDecision[] = [];
function setUnfinished(ws: string, next: readonly UnfinishedDecision[]) {
  unfinished.set(ws, next);
  for (const listener of unfinishedListeners) listener();
}
export function rememberUnfinished(ws: string, entry: UnfinishedDecision) {
  setUnfinished(ws, [entry, ...(unfinished.get(ws) ?? []).filter(row => row.id !== entry.id)].slice(0, 10));
}
export function useUnfinishedDecisions() {
  const { ws } = useViewContext();
  const snapshot = () => unfinished.get(ws) ?? noUnfinished;
  const list = useSyncExternalStore(listener => { unfinishedListeners.add(listener); return () => { unfinishedListeners.delete(listener); }; }, snapshot, snapshot);
  return { list, dismiss: (id: string) => setUnfinished(ws, (unfinished.get(ws) ?? []).filter(row => row.id !== id)) };
}

const idempotency = new Map<string, string>();
/** Sends one decision; a retry of the same decision reuses its Idempotency-Key. */
export function useDecide() {
  const { ws, session } = useViewContext();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ item, action, reason }: { item: DecisionItem; action: DecisionAction; reason?: string }) => {
      const call = decisionRequest(ws, action, reason);
      const slot = JSON.stringify([ws, item.id, action.key, action.version ?? null, reason ?? '']);
      const key = idempotency.get(slot) ?? crypto.randomUUID();
      idempotency.set(slot, key);
      const result = await request<unknown>(call.url, { method: call.method, body: call.body, version: call.version, key, csrf: session.csrf_token });
      idempotency.delete(slot);
      const outcome = decisionOutcome(item, result.data);
      if (leavesList(outcome)) rememberUnfinished(ws, { id: item.id, kind: item.kind, title: item.title, outcome });
      return outcome;
    },
    onSettled: () => client.invalidateQueries({ queryKey: viewPrefix(ws) }),
  });
}

/** Human-only writes outside decisions (agent connections, delegated jobs), refreshed through the view prefix. */
export function useViewWrite() {
  const { ws, session } = useViewContext();
  const client = useQueryClient();
  return async <T>(method: Method, path: string, body?: RecordData, key?: string) => {
    try { return await request<T>(`${workspacePath(ws)}${path}`, { method, body, key, csrf: session.csrf_token }); }
    finally { void client.invalidateQueries({ queryKey: viewPrefix(ws) }); }
  };
}
