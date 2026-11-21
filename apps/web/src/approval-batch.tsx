import { problemSummary } from './problem-copy';
import { useRef, useState } from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { Drawer, EntityTable } from '@smartsell/ui';
import { callOperation, findOperation, ProblemNotice, recordRows, rowTitle, stringValue, useApi, wsKey } from './api';
import { useCopy } from './i18n';
import { Status } from './workflow-view-ui';

export const approvalTargetId = (row: RecordData) => stringValue(row.resource_id ?? row.target_id ?? row.publish_target_id);
export const approvalBatchPath = '/approvals/batch';

export function ApprovalBatch({ requests, close }: { requests: RecordData[]; close: () => void }) {
  const { t, locale } = useCopy();
  const api = useApi();
  const client = useQueryClient();
  const detail = findOperation(api, 'GET', '/publish-targets/:id', 'planning');
  const approve = findOperation(api, 'POST', approvalBatchPath, 'planning');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [result, setResult] = useState<RecordData[]>();
  const attempt = useRef<{ key: string; items: RecordData[] }>(undefined);
  const flight = useRef(false);
  const previews = useQueries({ queries: requests.map(request => {
    const id = approvalTargetId(request);
    return {
      queryKey: [...wsKey(api.ws), 'approval-batch-preview', id],
      queryFn: ({ signal }: { signal: AbortSignal }) => callOperation(api, detail!, [id], { signal }),
      enabled: Boolean(detail && id), refetchOnWindowFocus: false, staleTime: 0,
    };
  }) });
  const rows = requests.map((request, index) => {
    const read = previews[index];
    const target = asRecord(read.data?.data);
    const binding = asRecord(target.approval);
    const id = approvalTargetId(request);
    const version = Number(target.version);
    const hash = stringValue(binding.resource_hash);
    const ready = read.isSuccess && binding.id === request.id && hash && Number.isSafeInteger(version) && version > 0 &&
      Array.isArray(target.allowed_actions) && target.allowed_actions.includes('approve');
    return { id, title: rowTitle(target) || rowTitle(request) || id, read, item: ready ? {
      target_id: id, approval_request_id: request.id, resource_hash: hash, expected_version: version,
    } : undefined };
  });
  const loading = previews.some(read => read.isFetching);
  const items = rows.flatMap(row => row.item ? [row.item] : []);

  async function submit() {
    if (!approve || flight.current || result || (!attempt.current && (loading || !items.length))) return;
    attempt.current ??= { key: crypto.randomUUID(), items };
    flight.current = true;
    setPending(true);
    setError(undefined);
    try {
      const response = await callOperation(api, approve, [], { key: attempt.current.key, body: { items: attempt.current.items } });
      setResult(recordRows(response.data) ?? []);
      void client.invalidateQueries({ queryKey: wsKey(api.ws) });
    } catch (failure) {
      setError(failure);
    } finally {
      flight.current = false;
      setPending(false);
    }
  }

  return <Drawer title={t('approvalBatchPreview')} closeLabel={t('close')} onClose={() => { if (!pending) close(); }}>
    <p className="batch-help">{t(result ? 'approvalBatchResults' : 'approvalBatchHelp')}</p>
    <EntityTable records={rows} rowKey={row => row.id} columns={[
      { label: t('title'), cell: row => row.title },
      { label: t('status'), cell: row => {
        if (!result) {
          if (row.read.isFetching) return t('loading');
          if (row.read.isError) return <ProblemNotice error={row.read.error} retry={attempt.current ? undefined : () => void row.read.refetch()} />;
          return t(row.item ? 'state.ready' : 'approvalBatchSkipped');
        }
        if (!attempt.current?.items.some(item => item.target_id === row.id)) return t('approvalBatchSkipped');
        const outcome = result.find(item => (item.target_id ?? item.id) === row.id);
        if (!outcome) return t('approvalBatchMissing');
        const failure = asRecord(outcome.error);
        if (failure.code) return <span>{t('state.failed')} · {problemSummary(locale, stringValue(failure.code)) ?? (stringValue(failure.message) || stringValue(failure.code))}</span>;
        return <Status value={outcome.plan_status ?? outcome.status ?? outcome.display_status} />;
      } },
    ]} />
    {error != null && <ProblemNotice error={error} />}
    {!result && <button className="primary batch-submit" type="button" disabled={!approve || pending || (!attempt.current && (loading || !items.length))} onClick={() => void submit()}>
      {t(pending ? 'saving' : error ? 'approvalBatchReplay' : 'approvalBatchConfirm', { count: items.length })}
    </button>}
  </Drawer>;
}
