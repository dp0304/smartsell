export type ViewQuery = Record<string, string | null | undefined>;

export const viewPrefix = (ws: string) => ['workspace', ws, 'view'] as const;

/** Drops empty values and orders keys so equal filters always share one cache entry. */
export function normalizeQuery(query: ViewQuery = {}): Record<string, string> {
  return Object.fromEntries(Object.entries(query)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== '')
    .sort(([a], [b]) => a.localeCompare(b)));
}

/** `allPages` reads (every page concatenated) cache apart from single-page reads of the same path. */
export const viewKey = (ws: string, path: string, query: ViewQuery = {}, allPages = false) =>
  [...viewPrefix(ws), path, normalizeQuery(query), ...(allPages ? ['all-pages'] as const : [])] as const;
