import { problemSummary } from './problem-copy';
import { AnalyticsResult } from './analytics-result';
import { EntityTable } from '@smartsell/ui';
import { Status, useFormat } from './workbench-ui';
import type { Command, Entity, Payload } from './workbench-api';
import { asEntity } from './workbench-data';

const object = (value: unknown): Payload | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Payload : undefined;
const records = (value: unknown): Payload[] => Array.isArray(value) ? (value as unknown[]).map(object).filter(row => row !== undefined) : [];
const validVersion = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function commandFollowUps({ module, action }: Command, result?: Payload): { action: string; row: Entity }[] {
  if (!result) return [];
  const choices: { action: string; row: Entity }[] = [];
  const add = (action: string, row?: Entity) => { if (row) choices.push({ action, row }); };
  if (module === 'commerce' && validVersion(result.version) && typeof result.batch_id === 'string') {
    const batch = asEntity(result, module, 'import_batch');
    if (result.status === 'previewed') {
      if (object(result.counts)?.invalid === 0) add('commit_import', batch);
      add('preflight_import', batch);
      if (records(result.issues).length) add('import_error_file', batch);
    } else if (action === 'commit_import' && result.status === 'committed') add('rollback_import', batch);
  }
  if (module === 'planning' && action === 'create_plan') add('preview_plan', asEntity(result, module, 'publish_plan'));
  if (module === 'planning' && action === 'preview_plan') {
    const items = records(result.items);
    if (validVersion(result.expected_version) && typeof result.plan_id === 'string' && items.length > 0 && items.length === (result.items as unknown[]).length
      && items.every(item => typeof item.target_id === 'string' && validVersion(item.expected_version) && Array.isArray(item.blockers) && !item.blockers.length)) {
      const commit_items = items.map(({ target_id, expected_version }) => ({ target_id, expected_version }));
      add('commit_plan', asEntity({ id: result.plan_id, version: result.expected_version, data: { commit_items } }, module, 'publish_plan'));
    }
  }
  if (module === 'execution' && ['begin_manual', 'get_task', 'report_manual_unknown'].includes(action)) {
    const task = asEntity(result.task, module, 'execution_task');
    const attempt = object(result.attempt) ?? records(result.attempts).find(item => item.id === task?.data.active_attempt_id);
    const attemptData = object(attempt?.data);
    if (task && attempt && typeof attempt.id === 'string' && attempt.id === task.data.active_attempt_id
      && attemptData?.route === 'manual' && ['manual_in_progress', 'outcome_unknown'].includes(String(attemptData.status)) && validVersion(attemptData.fencing_token)) {
      const row = { ...task, data: { ...task.data, fencing_token: attemptData.fencing_token } };
      add('reconcile_manual', row);
      if (attemptData.status === 'manual_in_progress') add('report_manual_unknown', row);
    }
  }
  if (module === 'analytics' && ['reports_generate_version', 'reports_update_narrative', 'reports_finalize'].includes(action)) {
    const version = asEntity(result, module, 'report_version');
    if (version?.data.status === 'draft') {
      if (action !== 'reports_update_narrative') add('reports_update_narrative', version);
      add('reports_finalize', version);
    } else if (version?.data.status === 'finalized') add('reports_export', version);
  }
  return choices;
}

function downloadable(result: Payload) {
  const name = typeof result.filename === 'string' ? result.filename : typeof result.template_key === 'string' ? `${result.template_key}.csv` : 'result.csv';
  if (typeof result.csv === 'string') return { name, content: result.csv, mime: 'text/csv;charset=utf-8', encoding: 'utf-8' };
  if (typeof result.content !== 'string' || typeof result.mime_type !== 'string') return;
  if (result.encoding === 'utf-8' && /^text\/csv(?:;|$)/.test(result.mime_type)) return { name, content: result.content, mime: result.mime_type, encoding: result.encoding };
  if (result.encoding === 'base64' && result.mime_type === 'application/pdf') return { name, content: result.content, mime: result.mime_type, encoding: result.encoding };
}

function download(file: NonNullable<ReturnType<typeof downloadable>>) {
  const bytes = file.encoding === 'base64' ? Uint8Array.from(atob(file.content), value => value.charCodeAt(0)) : file.content;
  const url = URL.createObjectURL(new Blob([bytes], { type: file.mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function CommandResult({ module, action, result, raw }: { module: string; action: string; result?: Payload; raw: unknown }) {
  const { t, label, locale, number } = useFormat();
  const rows = result?.batch_id ? records(result.rows) : [];
  const issues = result?.batch_id ? records(result.issues) : [];
  const data = object(result?.data) ?? result;
  const blockers = records(data?.blockers);
  const counts = Object.entries(object(data?.counts) ?? {}).filter(([, value]) => typeof value === 'number');
  const file = result && downloadable(result);
  const status = typeof data?.status === 'string' ? data.status : undefined;
  const analytics = result && module === 'analytics' ? <AnalyticsResult action={action} result={result} locale={locale} /> : null;
  const summarized = analytics && ['cohorts_list', 'attribution_query', 'attribution_explain'].includes(action);
  return <>
    {status && <Status value={status} />}
    {blockers.length > 0 && <ul>{blockers.map((blocker, index) => <li key={index}>{String(blocker.message ?? blocker.code ?? '—')}</li>)}</ul>}
    {analytics}
    {counts.length > 0 && <div className="wb-inline-actions">{counts.map(([state, count]) => <span key={state}>{label('state', state)} · {number(Number(count))}</span>)}</div>}
    {issues.length > 0 && <EntityTable records={issues.slice(0, 100)} rowKey={row => String(issues.indexOf(row))} columns={[
      { label: t('ui.csvLine'), cell: row => number(Number(row.line)) }, { label: t('ui.csvIssue'), cell: row => problemSummary(locale, String(row.code ?? '')) ?? String(row.message ?? row.code ?? '') },
    ]} />}
    {rows.length > 0 && <details open><summary>{t('ui.importPreview')}</summary><EntityTable records={rows.slice(0, 25)} rowKey={row => String(row.line)} columns={[
      { label: t('ui.csvLine'), cell: row => number(Number(row.line)) }, { label: t('ui.status'), cell: row => <Status value={String(row.status ?? '')} /> },
      { label: t('ui.record'), cell: row => { const values = row.values as Payload; return String(values?.title ?? values?.sku ?? values?.handle ?? '—'); } },
    ]} /></details>}
    {file && <button onClick={() => download(file)}>{t('ui.downloadResult')}</button>}
    {raw != null && <details open={!rows.length && !file && !summarized}><summary>{t('ui.result')}</summary><pre>{JSON.stringify(raw, null, 2)}</pre></details>}
  </>;
}
