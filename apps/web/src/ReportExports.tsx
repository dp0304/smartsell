import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { workspacePath, type RecordData } from '@smartsell/sdk';
import { Status } from './workflow-view-ui';
import { callOperation, findOperation, ProblemNotice, stringValue, useApi, wsKey } from './api';
import { useCopy } from './i18n';

const path = '/reports/:id/versions/:n';
type Job = { operation_id: string; status: string; format: string; version: number; error_code?: string };

export function ReportExports({ record }: { record: RecordData }) {
  const api = useApi();
  const { label, t } = useCopy();
  const ids = [stringValue(record.report_id), stringValue(record.version_no)];
  const queue = findOperation(api, 'POST', `${path}/export`);
  const list = findOperation(api, 'GET', `${path}/exports`);
  const cancel = findOperation(api, 'POST', '/operations/:id/cancel');
  const download = findOperation(api, 'GET', '/report-exports/:id/download');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const query = useQuery({ queryKey: [...wsKey(api.ws), api.session.user.id, 'report-exports', ...ids],
    enabled: Boolean(list) && ids.every(Boolean) && ['finalized', 'superseded'].includes(String(record.status)),
    queryFn: async ({ signal }) => ((await callOperation(api, list!, ids, { signal })).data as { items: Job[] }).items,
    refetchInterval: state => state.state.data?.some(job => job.status === 'queued') ? 1000 : false,
  });
  if (!queue || !list || !ids.every(Boolean) || !['finalized', 'superseded'].includes(String(record.status))) return null;

  async function act(run: () => Promise<unknown>) {
    setPending(true);
    setError(undefined);
    try { await run(); }
    catch (failure) { setError(failure); }
    finally { await query.refetch(); setPending(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const format = String(new FormData(event.currentTarget).get('format'));
    void act(() => callOperation(api, queue!, ids, { body: { format } }));
  }

  return <section className="detail-block">
    <h3>{label(['報告匯出', 'Report exports', '报告导出'])}</h3>
    <form className="inline-form" onSubmit={submit}>
      <label>{label(['檔案格式', 'File format', '文件格式'])} <select name="format"><option value="pdf">PDF</option><option value="csv">CSV</option><option value="xlsx">XLSX</option></select></label>
      <button disabled={pending}>{label(['匯出報告', 'Export report', '导出报告'])}</button>
    </form>
    {query.isPending && <p role="status">{t('loading')}</p>}
    {(error ?? query.error) && <ProblemNotice error={error ?? query.error} />}
    {query.data?.map(job => <div key={job.operation_id} className="inline-form">
      <span role="status">{job.format.toUpperCase()} <Status value={job.status} /> <code>{job.operation_id}</code></span>
      {job.error_code && <small>{job.error_code}</small>}
      {cancel && job.status === 'queued' && <button disabled={pending} onClick={() => void act(() => callOperation(api, cancel, [job.operation_id], { body: {}, version: job.version }))}>
        {label(['取消匯出', 'Cancel export', '取消导出'])}
      </button>}
      {download && job.status === 'succeeded' && <a href={`${workspacePath(api.ws)}/report-exports/${encodeURIComponent(job.operation_id)}/download`} download>
        {label(['下載', 'Download', '下载'])} {job.format.toUpperCase()}
      </a>}
    </div>)}
  </section>;
}
