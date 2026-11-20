import { type Context, type Input, type Row } from '@smartsell/contracts';
import { brandScope, inBrand, invalid, isManager, limit, str } from './shared.js';
import { canReadTask } from './tasks.js';
import { canReadFinancial } from '../analytics/metrics.js';
import { approvedKnowledgeRevision } from '../asset/knowledge.js';

const catalog = {
  brand: '/brands', market: '/markets', campaign: '/campaigns', content_item: '/content-items', asset: '/assets',
  product: '/products', conversation: '/conversations', customer: '/customers', creator: '/creators', work_item: '/work-items',
  knowledge_entry: '/assets/knowledge',
} as const;
export type SearchKind = keyof typeof catalog;
const kindKnown = (kind: string): kind is SearchKind => Object.hasOwn(catalog, kind);
/** The host can supply authorization from the owning resource facade within the current scope. */
export interface WorkspaceReadContext extends Context {
  canReadWorkspaceResource?(kind: string, row: Row): boolean;
  workspaceName?: string;
}
export function canReadResource(ctx: WorkspaceReadContext, kind: string, row: Row): boolean {
  if (!kindKnown(kind)) return false;
  if (ctx.canReadWorkspaceResource && !ctx.canReadWorkspaceResource(kind, row)) return false;
  if (kind === 'work_item') return canReadTask(ctx, row);
  if (kind === 'brand' || kind === 'market') return true;
  if (['customer', 'conversation', 'creator'].includes(kind)) {
    return ctx.canReadWorkspaceResource?.(kind, row) ?? (isManager(ctx) || row.assignee_user_id === ctx.actorId || row.owner_id === ctx.actorId);
  }
  return ctx.role !== 'agent' || ctx.canReadWorkspaceResource?.(kind, row) === true;
}
export function canFollow(ctx: WorkspaceReadContext, kind: string, resource: string) {
  if (kind === 'report') {
    const report = ctx.list('report').find(row => row.id === resource && row.status === 'active');
    return !!report && ctx.role !== 'agent' && (!report.sensitive || canReadFinancial(ctx));
  }
  if (!kindKnown(kind) || kind === 'knowledge_entry') return false;
  const row = ctx.list(kind).find(item => item.id === resource);
  return !!row && canReadResource(ctx, kind, row);
}

const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;
const normalize = (text: string) => text.normalize('NFKC').toLowerCase();
function tokens(text: string): string[] {
  const normalized = normalize(text);
  const words: string[] = normalized.replace(cjk, ' ').match(/[\p{L}\p{N}]+/gu) ?? [];
  for (const segment of normalized.matchAll(cjk)) {
    const chars = Array.from(segment[0]);
    if (chars.length === 1) words.push(chars[0]!);
    else for (let i = 1; i < chars.length; i++) words.push(chars[i - 1]! + chars[i]!);
  }
  return [...new Set(words)];
}
const text = (row: Row, keys: readonly string[]) => keys.map(key => row[key]).filter((value): value is string => typeof value === 'string' && value.length > 0);
function project(kind: SearchKind, row: Row) {
  const title = text(row, ['title', 'name', 'display_name', 'filename', 'original_filename', 'subject', 'handle', 'sku'])[0] ?? row.id;
  const excerpt = ['conversation', 'customer', 'creator'].includes(kind) ? undefined : text(row, ['summary', 'description'])[0]?.slice(0, 300);
  return { resource_type: kind, resource_id: row.id, title, excerpt, brand_id: kind === 'brand' ? row.id : row.brand_id, status: row.status,
    owner_id: row.owner_id ?? row.assignee_id ?? row.assignee_user_id, updated_at: row.updated_at, route: `${catalog[kind]}/${encodeURIComponent(row.id)}` };
}
export function search(ctx: WorkspaceReadContext, { query }: Input) {
  const q = str(query.q, 'q', 200);
  const clause = tokens(q);
  const phrase = normalize(q);
  const hits = keywordCandidates(ctx, query).flatMap(({ item, body }) => {
    const searchable = `${item.title} ${body ?? item.excerpt ?? ''}`;
    const words = new Set(tokens(searchable));
    const title = normalize(item.title);
    const matches = normalize(item.resource_id).includes(phrase) || (clause.length > 0 && clause.every(token => words.has(token))) ||
      (clause.length === 1 && normalize(searchable).includes(phrase));
    return matches ? [{ item, score: title === phrase ? 4 : title.startsWith(phrase) ? 3 : title.includes(phrase) ? 2 : 1 }] : [];
  });
  hits.sort((a, b) => b.score - a.score || b.item.updated_at.localeCompare(a.item.updated_at) || a.item.resource_id.localeCompare(b.item.resource_id));
  return { items: hits.slice(0, limit(query.limit)).map(({ item }) => item), total: hits.length };
}

type KeywordCandidate = {
  item: ReturnType<typeof project> & { revision_id?: string; revision_no?: Row['revision_no'] };
  body?: string;
};

export function searchCandidates(ctx: WorkspaceReadContext, query: Record<string, string>) {
  // Semantic search sends these excerpts to the embedding route as internal data.
  return keywordCandidates(ctx, query).filter(({ item }) => item.resource_type !== 'knowledge_entry').map(({ item }) => item);
}

function keywordCandidates(ctx: WorkspaceReadContext, query: Record<string, string>) {
  const brand = brandScope(ctx, query.brand_id);
  const kinds = query.types === undefined ? Object.keys(catalog) : [...new Set(query.types.split(',').map(type => type.trim()))];
  return kinds.flatMap(kind => {
    if (!kindKnown(kind)) return invalid(`Unknown search type ${kind}`);
    const rows = ctx.list(kind).filter(row => (kind === 'brand' ? brand === undefined || row.id === brand : inBrand(row, brand)) &&
      row.status !== 'archived' && canReadResource(ctx, kind, row));
    const revisions = kind === 'knowledge_entry' && rows.length ? new Map(ctx.list('knowledge_revision').map(row => [row.id, row])) : undefined;
    return rows.flatMap<KeywordCandidate>(row => {
      const item = project(kind, row);
      if ((query.status !== undefined && query.status !== item.status) || (query.owner_id !== undefined && query.owner_id !== item.owner_id)) return [];
      if (!revisions) return [{ item }];
      const revision = approvedKnowledgeRevision(row, revisions.get(String(row.active_revision_id)));
      if (!revision) return [];
      const body = typeof revision.body === 'string' ? revision.body : undefined;
      return [{ item: { ...item, excerpt: body?.slice(0, 300), revision_id: revision.id, revision_no: revision.revision_no }, body }];
    });
  });
}
