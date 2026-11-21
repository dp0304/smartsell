import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, asRecord, bindPath, operationKey, operationPath, parameterNames, request, requestCompatibilityOperation, workspacePath, type Method, type Operation, type RecordData, type Session } from '@smartsell/sdk';
import { Busy, EmptyState } from '@smartsell/ui';
import { useCopy } from './i18n';
import { problemSummary } from './problem-copy';

export interface WorkspaceApi { ws: string; session: Session; catalog: Operation[]; brandId?: string; compatibility?: boolean }
export const ApiContext = createContext<WorkspaceApi>(null!);
export const useApi = () => useContext(ApiContext);
export const sessionKey = ['session'];
export const wsKey = (ws: string) => ['workspace', ws];

export function findOperation(api: WorkspaceApi, method: Method, template: string, module?: string) {
  return api.catalog.find(op => {
    const path = operationPath(op, api.ws);
    return path && op.method === method && (!module || module === op.module) && operationKey(path) === operationKey(template);
  });
}

export async function callOperation(api: WorkspaceApi, op: Operation, values: string[], options: {
  query?: Record<string, string>; body?: RecordData; version?: string | number; key?: string; signal?: AbortSignal;
} = {}) {
  const path = operationPath(op, api.ws);
  if (!path) throw new Error('invalid_catalog_path');
  const bound = bindPath(path, Object.fromEntries(parameterNames(path).map((name, i) => [name, values[i]])));
  const input = { ...options, csrf: api.session.csrf_token };
  if (api.compatibility) {
    const result = await requestCompatibilityOperation(api.ws, op, values, input);
    if (result) return result;
  }
  return request<unknown>(`${workspacePath(api.ws)}${bound === '/' ? '' : bound}`, { ...input, method: op.method });
}

export function useRead(template: string, values: string[] = [], query: Record<string, string> = {}, module?: string) {
  const api = useApi();
  const op = findOperation(api, 'GET', template, module);
  const result = useQuery({ queryKey: [...wsKey(api.ws), 'read', op?.name, template, values, query],
    enabled: Boolean(op) && values.every(Boolean), queryFn: ({ signal }) => callOperation(api, op!, values, { query, signal }) });
  return { op, ...result };
}

export function entity(value: unknown): RecordData {
  const record = asRecord(value);
  if (record.module && record.kind) return { ...asRecord(record.data), ...record };
  return record;
}

export function recordRows(value: unknown): RecordData[] | undefined {
  if (Array.isArray(value)) return value.map(entity);
  const record = asRecord(value);
  for (const key of ['items', 'records', 'rows', 'results']) if (Array.isArray(record[key])) return (record[key] as unknown[]).map(entity);
}

export function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

export function rowTitle(row: RecordData) {
  return stringValue(row.title ?? row.name ?? row.display_name ?? row.subject ?? row.external_id ?? row.key ?? row.id);
}

export function versionOf(record: RecordData) {
  return stringValue(record.etag ?? record.version);
}

export function ProblemNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t, locale } = useCopy();
  const problem = error instanceof ApiError ? error : undefined;
  const code = stringValue(problem?.problem.code);
  const offline = error instanceof TypeError || problem?.status === 502 && !Object.keys(problem.problem).length;
  const detail = problem && (stringValue(problem.problem.detail) || stringValue(problem.problem.message));
  const message = offline ? t('offline') : problemSummary(locale, code, problem?.status) ?? (detail || t('error'));
  return <div className="problem" role="alert"><strong>{t('error')}{problem ? ` · ${problem.status}` : ''}</strong><p>{message}</p>
    {detail && detail !== message && <details><summary>{t('serverDetails')}</summary><p>{detail}</p></details>}
    {code && <small>{code}</small>}{retry && <button type="button" onClick={retry}>{t('retry')}</button>}</div>;
}

export function ReadState({ read }: { read: Pick<ReturnType<typeof useRead>, 'op' | 'isPending' | 'isError' | 'error'> & { refetch: () => Promise<unknown> } }) {
  const { t } = useCopy();
  if (!read.op) return <EmptyState title={t('noAccess')} detail={t('noAccessDetail')} />;
  if (read.isPending) return <Busy label={t('loading')} />;
  if (read.isError) return <ProblemNotice error={read.error} retry={() => void read.refetch()} />;
  return null;
}
