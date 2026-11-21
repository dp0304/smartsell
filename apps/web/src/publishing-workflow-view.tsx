import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, EntityTable, Panel } from '@smartsell/ui';
import { ReadState, rowTitle, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { Json } from './OperationForm';
import { records, safeUrl, Status, Timestamp } from './workflow-view-ui';

const dateKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
function offset(date: Date, days: number) { const result = new Date(date); result.setDate(result.getDate() + days); return result; }
const weekStart = (date: Date) => offset(date, -((date.getDay() + 6) % 7));
const idOf = (row: RecordData) => stringValue(row.id);
const routes = { content: 'content', targets: 'calendar', tasks: 'execution', posts: 'posts' } as const;
const markers = { targets: ['排期', 'Scheduled'], production_deadlines: ['製作期限', 'Deadline', '制作期限'], posts: ['實際發布', 'Published', '实际发布'] } as const;

function WorkflowLink({ tab, id, children }: { tab: keyof typeof routes; id: string; children: React.ReactNode }) {
  const { ws } = useApi();
  return <Link to={`/w/${encodeURIComponent(ws)}/${routes[tab]}?${new URLSearchParams({ tab, id })}`}>{children}</Link>;
}

export function PublishingCalendar({ onPick }: { onPick: (id: string) => void }) {
  const { t, label, locale } = useCopy();
  const [params] = useSearchParams();
  const [base, setBase] = useState(() => {
    const date = params.get('date') ?? '';
    const requested = new Date(date.length === 10 ? `${date}T00:00:00` : date);
    return Number.isFinite(requested.getTime()) ? requested : new Date();
  });
  const [view, setView] = useState('week');
  const [account, setAccount] = useState('');
  const start = view === 'month' ? weekStart(new Date(base.getFullYear(), base.getMonth(), 1)) : view === 'day' ? base : weekStart(base);
  const count = view === 'month' ? 42 : view === 'day' ? 1 : 7;
  const days = Array.from({ length: count }, (_, index) => offset(start, index));
  const midnight = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).toISOString();
  const read = useRead('/calendar', [], { from: midnight(start), to: midnight(offset(start, count)), view, ...(account && { social_account_id: account }) });
  const accounts = useRead('/social-accounts');
  const data = asRecord(read.data?.data);
  const schedule = Object.keys(markers).flatMap(key => {
    const kind = key as keyof typeof markers;
    return records(data[kind]).flatMap((entry, index) => {
      const stamp = stringValue(kind === 'targets' ? entry.scheduled_at ?? entry.local_scheduled_at : kind === 'posts' ? entry.published_at : entry.due_at);
      if (!stamp || !Number.isFinite(Date.parse(stamp))) return [];
      return [{ entry, kind, stamp, day: stamp.length === 10 ? stamp : dateKey(new Date(stamp)), key: `${kind}-${index}` }];
    });
  }).sort((a, b) => a.day.localeCompare(b.day) || Date.parse(a.stamp) - Date.parse(b.stamp));
  const dayFormatter = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric' });
  const clock = new Intl.DateTimeFormat(locale, { timeStyle: 'short' });
  const period = new Intl.DateTimeFormat(locale, view === 'month' ? { month: 'long', year: 'numeric' } : { dateStyle: 'medium' });
  function move(direction: number) { setBase(view === 'month' ? new Date(base.getFullYear(), base.getMonth() + direction, 1) : offset(base, direction * count)); }
  function marker({ entry, kind, stamp }: typeof schedule[number]) {
    const title = `${label(markers[kind])} · ${stamp.length > 10 ? `${clock.format(new Date(stamp))} · ` : ''}${rowTitle(entry) || t('details')}`;
    if (kind === 'targets' && idOf(entry)) return <button title={title} type="button" onClick={() => onPick(idOf(entry))}>{title}</button>;
    if (kind === 'production_deadlines' && entry.content_item_id) return <WorkflowLink tab="content" id={stringValue(entry.content_item_id)}>{title}</WorkflowLink>;
    if (kind === 'posts' && idOf(entry)) return <WorkflowLink tab="posts" id={idOf(entry)}>{title}</WorkflowLink>;
    return <span>{title}</span>;
  }
  function markerStatus({ entry, kind }: typeof schedule[number]) {
    return <>
      <Status value={entry.display_status ?? entry.production_stage ?? entry.verification} />
      {kind === 'targets' && entry.approval_invalidated_reason === 'product_price_claim_changed' &&
        <small className="notice">{label(['價格已變更，審批已失效', 'Price changed. Approval invalidated.', '价格已变更，审批已失效'])}</small>}
    </>;
  }
  return <Panel className="calendar-panel">
    <div className="panel-head"><div><h2>{view === 'month' || count === 1 ? period.format(base) : period.formatRange(start, offset(start, count - 1))}</h2><small>{t('calendarZone')}</small></div>
      <div className="toolbar">
        <button className="icon-button" aria-label={t('previousPeriod')} onClick={() => move(-1)}><ChevronLeft size={16} /></button>
        <button className="icon-button" aria-label={t('nextPeriod')} onClick={() => move(1)}><ChevronRight size={16} /></button>
        <button onClick={() => setBase(new Date())}>{label(['今天', 'Today'])}</button>
        <select aria-label={t('calendar')} value={view} onChange={event => setView(event.target.value)}>{['day', 'week', 'month', 'list'].map(key => <option key={key} value={key}>{t(key)}</option>)}</select>
        {records(accounts.data?.data).length > 0 && <select aria-label={t('social_account_id')} value={account} onChange={event => setAccount(event.target.value)}>
          <option value="">{label(['所有社群帳號', 'All social accounts', '所有社交媒体账号'])}</option>{records(accounts.data?.data).map(row => <option key={idOf(row)} value={idOf(row)}>{rowTitle(row)}</option>)}
        </select>}
      </div>
    </div>
    <p className="detail-block">{Object.values(markers).map(value => label(value)).join(' · ')}</p>
    <ReadState read={read} />
    {read.data && (view === 'list' ? (schedule.length > 0 && <EntityTable records={schedule} rowKey={event => event.key} columns={[
      { label: t('calendar'), cell: event => event.day }, { label: t('title'), cell: marker },
      { label: t('status'), cell: markerStatus },
    ]} />) : <div className={`calendar-grid ${view === 'day' ? 'single' : ''}`}>
      {days.map(day => <div className={`calendar-day ${dateKey(day) === dateKey(new Date()) ? 'current' : ''}`} key={dateKey(day)}><b>{dayFormatter.format(day)}</b>
        {schedule.filter(event => event.day === dateKey(day)).map(event => <span key={event.key}>
          {marker(event)}
          {event.kind === 'targets' && markerStatus(event)}
        </span>)}
      </div>)}
    </div>)}
    {read.data && schedule.length === 0 && <EmptyState title={t('empty')} detail={t('planningHint')} />}
  </Panel>;
}

export function PauseWithdrawals({ record }: { record: RecordData }) {
  const { label, t } = useCopy();
  const withdrawals = records(record.platform_withdrawals);
  if (!withdrawals.length) return null;
  return <section aria-label={label(['平台排程撤回', 'Platform schedule withdrawals', '平台调度撤回'])}>
    <h3>{label(['平台排程撤回', 'Platform schedule withdrawals', '平台调度撤回'])}</h3>
    <EntityTable records={withdrawals} rowKey={row => stringValue(row.target_id)} columns={[
      { label: label(['發布目標', 'Publish target', '发布目标']), cell: row => <WorkflowLink tab="targets" id={stringValue(row.target_id)}>{stringValue(row.title ?? row.target_id)}</WorkflowLink> },
      { label: t('status'), cell: row => <Status value={row.execution_status ?? row.plan_status} /> },
    ]} />
  </section>;
}

export function TargetReview({ record }: { record: RecordData }) {
  const { t, label } = useCopy();
  const revision = asRecord(record.revision);
  const precheck = asRecord(record.precheck);
  const approval = asRecord(record.approval);
  const execution = asRecord(record.execution);
  const copy = stringValue(asRecord(revision.rendered).text ?? revision.body);
  const invalidation = stringValue(record.approval_invalidated_reason);
  return <>
    <section className="detail-block">
      <h3>{label(['排期與修訂', 'Schedule and revision', '排期与修订'])} · <Status value={record.display_status ?? record.plan_status} /></h3>
      <p>{record.scheduled_at ? <Timestamp value={record.scheduled_at} /> : stringValue(record.local_scheduled_at) || '—'} {stringValue(record.schedule_tz)}</p>
      {copy && <div className="message"><p>{copy}</p></div>}
      <p>{label(['修訂', 'Revision', '修订'])} <code>{stringValue(record.variant_revision_id) || '—'}</code></p>
    </section>
    <section className="detail-block"><h3>{label(['發布預檢', 'Publishing precheck', '发布预检'])} · <Status value={precheck.overall ?? record.precheck_summary} /></h3>
      {records(precheck.items).map((item, index) => <article className="message" key={idOf(item) || index}>
        <Status value={item.severity} /> <b>{stringValue(item.code ?? item.check_key)}</b><p>{stringValue(item.message ?? item.detail)}</p>
      </article>)}
    </section>
    {(approval.id != null || invalidation) && <section className="detail-block"><h3>{label(['審批', 'Approval', '审批'])} · <Status value={approval.status} /></h3>
      {invalidation && <p className="notice">{label(['審批失效原因', 'Approval invalidation', '审批失效原因'])} · {invalidation}</p>}
      {approval.current_step != null && <p>{label(['審批步驟', 'Review step', '审批步骤'])} {stringValue(approval.current_step)} · {t('due_at')} <Timestamp value={approval.due_at} /></p>}
      {approval.resource_hash != null && <p>{label(['綁定內容雜湊', 'Bound content hash', '绑定内容哈希'])} <code>{stringValue(approval.resource_hash)}</code></p>}
    </section>}
    {execution.id != null && <p><WorkflowLink tab="tasks" id={idOf(execution)}>{label(['查看執行任務', 'Open execution task', '查看运行任务'])}</WorkflowLink> · <Status value={execution.status} /></p>}
  </>;
}

export function PostAudit({ post, onComplete }: { post: RecordData; onComplete?: (operation: RecordData) => void }) {
  const { label, t } = useCopy();
  const history = useRead('/performance/posts/:id/history', [idOf(post)]);
  const publication = asRecord(post.publication);
  return <>
    <section className="detail-block"><h3>{label(['發布審計', 'Publication audit', '发布审计'])} · <Status value={post.post_status} /></h3>
      {publication.id != null && <p><WorkflowLink tab="tasks" id={idOf(publication)}>{label(['查看原始發布任務', 'Open original publication task', '查看原始发布任务'])}</WorkflowLink> · <Status value={publication.status} /></p>}
      <section aria-label={label(['平台操作紀錄', 'Post maintenance history', '平台操作记录'])}>{records(post.post_operations).map(operation => {
        const actionUrl = safeUrl(operation.action_url);
        return <article className="message" key={idOf(operation)}>
          <b>{stringValue(operation.kind)}</b> · <Status value={operation.status} />
          <p>{stringValue(operation.reason)} · {operation.executor === 'api' ? label(['官方 API', 'Official API']) : label(['人工', 'Manual'])}</p>
          {operation.status === 'accepted' && <p>{label(['已取得回執，等待平台讀回。', 'Receipt received. Waiting for platform readback.', '已取得回执，等待平台读回。'])}</p>}
          {operation.status === 'outcome_unknown' && <p className="notice">{t('unknownHint')}</p>}
          {operation.status === 'manual' && actionUrl && <p><a href={actionUrl} target="_blank" rel="noreferrer">{label(['開啟平台作品', 'Open post on platform', '打开平台作品'])}</a></p>}
          {operation.status === 'manual' && onComplete && <button onClick={() => onComplete(operation)}>{label(['回填操作結果', 'Record maintenance result', '回填操作结果'])}</button>}
          <details><summary>{t('details')}</summary><Json value={operation} /></details>
        </article>;
      })}</section>
    </section>
    {history.op && <section className="detail-block"><h3>{label(['成效歷史', 'Metric history', '成效历史'])}</h3><ReadState read={history} />
      {history.data && (records(asRecord(history.data.data).items).length ? <EntityTable records={records(asRecord(history.data.data).items)} rowKey={idOf} columns={[
        { label: label(['指標', 'Metric', '指标']), cell: row => stringValue(row.metric_key) },
        { label: label(['數值', 'Value', '数值']), cell: row => stringValue(row.value) },
        { label: label(['觀察時間', 'Observed at', '观察时间']), cell: row => <Timestamp value={row.observed_at} /> },
      ]} /> : <p className="muted">{t('empty')}</p>)}
    </section>}
  </>;
}

export function ExecutionReview({ task }: { task: RecordData }) {
  const { t, label } = useCopy();
  const id = idOf(task);
  const allowed = Array.isArray(task.allowed_actions) && task.allowed_actions.includes('manual_bundle');
  const bundle = useRead('/execution-tasks/:id/manual-bundle', [allowed ? id : '']);
  const instructions = asRecord(bundle.data?.data);
  const frozen = asRecord(instructions.frozen);
  const payload = asRecord(frozen.payload ?? frozen.revision ?? frozen);
  const caption = stringValue(asRecord(payload.rendered).text ?? payload.text ?? payload.caption);
  const post = asRecord(task.platform_post);
  const permalink = safeUrl(post.permalink);
  const unresolved = task.status === 'outcome_unknown' || task.status === 'accepted' || (Array.isArray(task.pending_side_effects) && task.pending_side_effects.length > 0);
  return <>
    <section className="detail-block"><h3>{label(['任務結果', 'Task outcome', '任务结果'])} · <Status value={task.status} /></h3>
      <p>{t('due_at')} <Timestamp value={task.due_at} /> · <Status value={task.sub_status} /></p>
      {unresolved && <p className="notice">{t('unknownHint')}</p>}
      {task.publish_target_id != null && <p><WorkflowLink tab="targets" id={stringValue(task.publish_target_id)}>{label(['查看發布目標', 'Open publish target', '查看发布目标'])}</WorkflowLink></p>}
      {permalink && <p><a href={permalink} target="_blank" rel="noreferrer">{label(['開啟已發布作品', 'Open published post', '打开已发布作品'])}</a> · <Status value={post.verification} /></p>}
    </section>
    {allowed && bundle.op && <section className="detail-block"><h3>{t('manualBundle')}</h3><ReadState read={bundle} />
      {bundle.data && <>
        <p>{label(['社群帳號', 'Social account', '社交媒体账号'])} <code>{stringValue(instructions.social_account_id)}</code></p>
        {caption && <article className="message"><p>{caption}</p></article>}
        {Array.isArray(instructions.instructions) && <ol>{instructions.instructions.map((line, index) => <li key={index}>{stringValue(line)}</li>)}</ol>}
        <details><summary>{label(['查看已核准的完整發布內容', 'Inspect the full approved payload', '查看已核准的完整发布内容'])}</summary><Json value={frozen} /></details>
      </>}
    </section>}
    {([['執行嘗試', 'Attempts', task.attempts], ['核實紀錄', 'Verifications', task.verifications], ['執行步驟', 'Attempt steps', task.steps], ['交接紀錄', 'Handovers', task.handovers]] as const).map(([zh, en, items]) => <section className="detail-block" key={en}>
      <h3>{label([zh, en])}</h3>
      {records(items).length ? records(items).map((row, index) => <article className="message" key={idOf(row) || index}>
        <b>{stringValue(row.attempt_no ?? row.step ?? row.executor ?? row.reason) || t('status')}</b> · <Status value={row.status ?? row.outcome} />
        <small><Timestamp value={row.started_at ?? row.created_at} /></small>
        <details><summary>{t('details')}</summary><Json value={row} /></details>
      </article>) : <p className="muted">{t('empty')}</p>}
    </section>)}
  </>;
}
