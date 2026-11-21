import type { DecisionItem } from '@smartsell/ui';
import type { AgentConnection } from './types';

/** Pages that read a period, with the server's default length for each. */
export const periodDefaults: Record<string, number> = { '': 7, social: 30, ads: 30 };

export function sectionOf(pathname: string) {
  return /^\/app\/[^/]+\/?([^/?#]*)/.exec(pathname)?.[1] ?? '';
}

export type AgentState = 'active' | 'idle' | 'none' | 'unknown';
const recentMs = 15 * 60 * 1000;
/** Connection lamp: used in the last 15 minutes, connected but quiet, none usable, or unreadable. */
export function agentState(connections: readonly AgentConnection[] | undefined, now = Date.now()): AgentState {
  if (!connections) return 'unknown';
  const live = connections.filter(item => connectionState(item, now) === 'active');
  if (!live.length) return 'none';
  return live.some(item => item.last_used_at && now - Date.parse(item.last_used_at) < recentMs) ? 'active' : 'idle';
}

export function connectionState(item: AgentConnection, now = Date.now()): 'revoked' | 'expired' | 'active' {
  if (item.revoked) return 'revoked';
  return item.expires_at && Date.parse(item.expires_at) <= now ? 'expired' : 'active';
}

/** Shapes one sentence into the agent_jobs_create body; a long sentence keeps its full text as constraints. */
export function jobBody(sentence: string, brandId?: string) {
  const text = sentence.trim().replace(/\s+/g, ' ');
  const long = text.length > 300;
  const scope = { ...(brandId ? { brand_ids: [brandId] } : {}), ...(long ? { constraints: text.slice(0, 4000) } : {}) };
  return { title: long ? `${text.slice(0, 299)}…` : text, kind: 'custom', expected_output: { type: 'note' }, ...(Object.keys(scope).length ? { input_scope: scope } : {}) };
}

const severityRank: Record<string, number> = { blocker: 0, high: 1, normal: 2 };
/** Most blocking first, then the earliest deadline, then the oldest request. */
export function sortDecisions(items: readonly DecisionItem[]) {
  return [...items].sort((a, b) => (severityRank[a.severity] ?? 3) - (severityRank[b.severity] ?? 3)
    || (a.due_at ?? '￿').localeCompare(b.due_at ?? '￿') || a.created_at.localeCompare(b.created_at));
}

export function groupByKind(items: readonly DecisionItem[]) {
  const groups = new Map<string, DecisionItem[]>();
  for (const item of sortDecisions(items)) groups.set(item.kind, [...(groups.get(item.kind) ?? []), item]);
  return [...groups];
}
