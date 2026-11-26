import { createContext, useContext } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ApiError, asRecord, bindPath, operationKey, operationPath, parameterNames, request, requestCompatibilityOperation, workspacePath, type Method, type Operation, type RecordData, type Session } from '@smartsell/sdk';
import { Busy, EmptyState } from '@smartsell/ui';
import { useCopy } from './i18n';

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

type Words = readonly [string, string];
/** U8: what a failed request means for the person, by HTTP status and error code. Status and code go under 詳細資料. */
const problemWords = {
  offline: ['中樞沒有回應。請確認中樞那台電腦開著、SmartSell 正在執行，再按「重新載入」。', 'The hub is not responding. Check that the hub computer is on and SmartSell is running, then reload.'],
  server: ['中樞處理這個要求時出了問題，請稍後再試。一直發生的話，請在中樞那台電腦執行 pnpm hub:doctor。', 'The hub ran into a problem with this request. Try again in a moment; if it keeps happening, run pnpm hub:doctor on the hub computer.'],
  busy: ['中樞正忙，請稍後再試。', 'The hub is busy. Try again in a moment.'],
  session: ['登入已過期，請重新登入。', 'Your sign-in has expired. Sign in again.'],
  forbidden: ['你的帳號沒有權限做這件事；需要的話請工作區擁有者調整權限。', 'Your account is not allowed to do this; ask the workspace owner if you need access.'],
  notFound: ['找不到這筆資料，可能已經刪除，或網址不對。', 'This could not be found. It may have been deleted, or the link is wrong.'],
  tooLarge: ['檔案太大，請換一個比較小的檔案。', 'The file is too large; use a smaller one.'],
  rateLimited: ['操作太頻繁，請稍等一下再試。', 'Too many requests. Wait a moment and try again.'],
  fields: ['有欄位不正確：{fields}。請修改後再送出。', 'Some fields are not valid: {fields}. Fix them and send again.'],
  fieldsUnnamed: ['有欄位不正確，請檢查後再送出。', 'Some fields are not valid; check them and send again.'],
  details: ['詳細資料', 'Details'],
} as const satisfies Record<string, Words>;
const fieldWords: Record<string, Words> = {
  url: ['網址', 'link'], when: ['時間', 'time'], scheduled_at: ['排程時間', 'scheduled time'], reason: ['原因', 'reason'], email: ['電子郵件', 'email'],
  password: ['密碼', 'password'], name: ['名稱', 'name'], display_name: ['名稱', 'name'], token: ['權杖', 'token'], label: ['名稱', 'name'],
  timezone: ['時區', 'time zone'], daily_cap: ['每日上限', 'daily limit'], window: ['發文時段', 'posting window'], caption: ['文案', 'caption'],
  confirm_text: ['確認文字', 'confirmation text'], workspaceName: ['工作區名稱', 'workspace name'], username: ['使用者名稱', 'username'],
};

/** The validation issues a 400/422 problem carries (details.issues, or issues at the top level). */
export function problemIssues(error: unknown): { path: string; message: string }[] {
  if (!(error instanceof ApiError)) return [];
  const issues = asRecord(error.problem.details).issues ?? error.problem.issues;
  return Array.isArray(issues) ? issues.map(asRecord).map(issue => ({ path: String(issue.path ?? ''), message: String(issue.message ?? '') })).filter(issue => issue.path || issue.message) : [];
}

/**
 * U8: the plain sentence for a failed request, in the active language. Network failures and 5xx say what to check; 401, 403,
 * 404, 412, 413 and 429 have their own words; a 400/422 names the fields; any other refusal keeps the server's own sentence.
 */
export function problemMessage(error: unknown, label: (value: Words) => string, t: (key: string) => string): string {
  const problem = error instanceof ApiError ? error : undefined;
  if (!problem) return error instanceof TypeError ? label(problemWords.offline) : t('error');
  const { status } = problem;
  const code = String(problem.problem.code ?? '');
  if (code === 'INVALID_RESPONSE') return t('invalidResponse');
  if ((status === 502 && !Object.keys(problem.problem).length) || status === 504) return label(problemWords.offline);
  if (status === 503) return label(code === 'TRANSACTION_RETRY' ? problemWords.busy : problemWords.offline);
  if (status >= 500) return label(problemWords.server);
  if (status === 401) return label(problemWords.session);
  if (status === 403) return label(problemWords.forbidden);
  if (status === 404) return label(problemWords.notFound);
  if (status === 412) return t('conflict');
  if (status === 413) return label(problemWords.tooLarge);
  if (status === 429) return label(problemWords.rateLimited);
  if (status === 400 || status === 422) {
    const names = [...new Set(problemIssues(error).map(issue => issue.path.split(/[.[\]/]/).filter(Boolean).pop() ?? '').filter(Boolean)
      .map(path => fieldWords[path] ? label(fieldWords[path]) : path))];
    if (names.length || /^INVALID_(ARGUMENTS|REQUEST|BODY)$|VALIDATION/.test(code)) {
      return names.length ? label(problemWords.fields).replace('{fields}', names.join(label(['、', ', ']))) : label(problemWords.fieldsUnnamed);
    }
  }
  return problem.message || t('error');
}

/** Status, code, the server's own message and request id, folded away under 詳細資料 (U8). */
export function ProblemDetails({ error }: { error: unknown }) {
  const { label } = useCopy();
  if (!(error instanceof ApiError)) return null;
  const issues = problemIssues(error);
  const lines = [
    [error.status, error.problem.code].filter(Boolean).join(' · '),
    error.message && error.message !== String(error.status) ? error.message : '',
    ...issues.map(issue => `${issue.path}: ${issue.message}`),
    typeof error.problem.request_id === 'string' ? `request_id ${error.problem.request_id}` : '',
  ].filter(Boolean);
  return <details className="problem-details"><summary>{label(problemWords.details)}</summary>{lines.map((line, index) => <small key={index}>{line}</small>)}</details>;
}

export function ProblemNotice({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t, label } = useCopy();
  return <div className="problem" role="alert"><strong>{t('error')}</strong><p>{problemMessage(error, label, t)}</p>
    {retry && <button type="button" onClick={retry}>{t('retry')}</button>}<ProblemDetails error={error} /></div>;
}

export function ReadState({ read }: { read: Pick<ReturnType<typeof useRead>, 'op' | 'isPending' | 'isError' | 'error'> & { refetch: () => Promise<unknown> } }) {
  const { t } = useCopy();
  if (!read.op) return <EmptyState title={t('noAccess')} detail={t('noAccessDetail')} />;
  if (read.isPending) return <Busy label={t('loading')} />;
  if (read.isError) return <ProblemNotice error={read.error} retry={() => void read.refetch()} />;
  return null;
}
