export type RecordData = Record<string, unknown>;
export interface Envelope<T> { data: T; next_cursor?: string | null; etag?: string }

export class ApiError extends Error {
  constructor(public status: number, public problem: RecordData) {
    super(String(problem.detail ?? problem.message ?? problem.title ?? status));
    this.name = 'ApiError';
  }
}

export const params = /\{([\w-]+)\}|:([\w-]+)/g;

export function bindPath(path: string, values: Record<string, string>) {
  return path.replace(params, (_, brace: string | undefined, colon: string | undefined) => {
    const value = values[(brace ?? colon)!]?.trim();
    if (!value || value === '.' || value === '..' || /[/\\]/.test(value)) throw new Error('invalid_path_parameter');
    return encodeURIComponent(value);
  });
}

export function asRecord(value: unknown): RecordData {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordData : {};
}
