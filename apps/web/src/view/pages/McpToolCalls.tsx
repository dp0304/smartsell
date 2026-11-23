import { useState } from 'react';
import { formatDateTime, type Tuple } from '@smartsell/ui';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, Section, useText } from '../parts';
import { WorkerSocialReceipt } from './worker-social-receipt';

const workerSocialTools = new Set(['worker_social_status_request', 'worker_social_status_get', 'worker_social_status_report']);

type Call = {
  call_id: string; request_id: string; credential_id: string; actor_id: string; occurred_at: string;
  tool: string; target: string; outcome: string; error_code?: string; status?: string; replayed?: boolean;
  business_committed?: boolean;
  agent_job_id?: string; task_id?: string; device_id?: string;
};

const labels = {
  title: ['MCP 工具審計', 'MCP tool audit'], search: ['查詢', 'Search'], allResults: ['所有結果', 'All results'],
  request: ['請求 ID', 'Request ID'], actor: ['使用者 ID', 'User ID'], credential: ['Agent 授權 ID', 'Agent authorization ID'],
  tool: ['工具名稱', 'Tool name'], result: ['結果', 'Result'], call: ['呼叫 ID', 'Call ID'],
  job: ['Agent 工作 ID', 'Agent job ID'], task: ['任務 ID', 'Task ID'], device: ['裝置 ID', 'Device ID'],
  businessCommitted: ['業務已提交，呼叫未結案', 'Business write committed, call unfinished'],
  workerCallSucceeded: ['工具呼叫成功', 'Tool call succeeded'],
  replay: ['已重播', 'Replayed'], empty: ['沒有符合的工具呼叫。', 'No matching tool calls.'],
  previous: ['上一頁', 'Previous page'], next: ['下一頁', 'Next page'],
} satisfies Record<string, Tuple>;
const outcomes: Record<string, Tuple> = {
  pending: ['處理中', 'Pending'], success: ['成功', 'Succeeded'], denied: ['已拒絕', 'Denied'],
  failed: ['呼叫失敗', 'Call failed'], reconciled: ['已核對', 'Reconciled'],
};
const statuses: Record<string, Tuple> = {
  unsupported: ['不支援', 'Unsupported'], blocked: ['受阻', 'Blocked'], failed: ['業務失敗', 'Business failure'],
  outcome_unknown: ['結果未知', 'Outcome unknown'],
};
const searchFields = [
  ['request_id', labels.request], ['actor_id', labels.actor], ['credential_id', labels.credential], ['tool', labels.tool],
] as const;

export function McpToolCalls() {
  const { workspace, ws } = useViewContext();
  if (workspace.role !== 'owner' && workspace.role !== 'admin') return null;
  return <CallHistory key={ws} />;
}

function CallHistory() {
  const { l, lang } = useText();
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [pages, setPages] = useState<string[]>([]);
  const cursor = pages.at(-1);
  const read = useView<Call[]>('/mcp-tool-calls', { ...filters, cursor });
  return <Section title={l(labels.title)}>
    <form className="vs-form" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const submitted = Object.fromEntries(searchFields.map(([key]) => [key, String(data.get(key) ?? '').trim()]).filter(([, value]) => value));
      const [field, value] = String(data.get('result') ?? '').split(':');
      if (field && value) submitted[field] = value;
      if (!cursor && Object.keys(filters).length === Object.keys(submitted).length &&
          Object.entries(submitted).every(([key, value]) => filters[key] === value)) void read.refetch();
      setFilters(submitted);
      setPages([]);
    }}>
      <fieldset>
        {searchFields.map(([name, label]) => <label key={name}>{l(label)} <input name={name} /></label>)}
        <label>{l(labels.result)} <select name="result">
          <option value="">{l(labels.allResults)}</option>
          {Object.entries(outcomes).map(([key, label]) => <option value={`outcome:${key}`} key={key}>{l(label)}</option>)}
          {Object.entries(statuses).map(([key, label]) => <option value={`status:${key}`} key={`status:${key}`}>{l(label)}</option>)}
        </select></label>
        <div><button className="vs-btn" type="submit">{l(labels.search)}</button></div>
      </fieldset>
    </form>
    <Loaded read={read}>{calls => calls.length ? <>
      <ul>{calls.map(call => {
        const workerSocial = workerSocialTools.has(call.tool);
        const outcome = workerSocial && call.outcome === 'success' ? labels.workerCallSucceeded : outcomes[call.outcome];
        return <li key={call.call_id}>
          <p><time dateTime={call.occurred_at}>{formatDateTime(call.occurred_at, lang)}</time> · <strong>{call.tool}</strong> · {call.target} · {call.business_committed ? l(labels.businessCommitted) : outcome ? l(outcome) : call.outcome}
            {call.error_code && <> · <code>{call.error_code}</code></>}
            {call.status && statuses[call.status] && <> · {l(statuses[call.status])}</>}
            {call.replayed && <> · {l(labels.replay)}</>}
          </p>
          <dl>
            {([
              [labels.request, call.request_id], [labels.call, call.call_id], [labels.actor, call.actor_id],
              [labels.credential, call.credential_id], [labels.job, call.agent_job_id], [labels.task, call.task_id], [labels.device, call.device_id],
            ] as const).map(([label, value]) => value && <div key={label[1]}><dt>{l(label)}</dt><dd><code>{value}</code></dd></div>)}
          </dl>
          {workerSocial && call.task_id && <WorkerSocialReceipt key={call.task_id} taskId={call.task_id} deviceId={call.device_id} />}
        </li>;
      })}</ul>
      {(cursor || read.nextCursor) && <div className="vs-actions">
        <button className="vs-btn" type="button" disabled={!cursor || read.isPlaceholderData} onClick={() => setPages(pages.slice(0, -1))}>{l(labels.previous)}</button>
        <button className="vs-btn" type="button" disabled={!read.nextCursor || read.isPlaceholderData} onClick={() => setPages([...pages, read.nextCursor!])}>{l(labels.next)}</button>
      </div>}
    </> : <p className="muted">{l(labels.empty)}</p>}</Loaded>
  </Section>;
}
