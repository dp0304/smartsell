import { useState, type FormEvent, type ReactNode } from 'react';
import { asRecord, type Method, type RecordData } from '@smartsell/sdk';
import { EntityTable, Panel } from '@smartsell/ui';
import { findOperation, ProblemNotice, ReadState, rowTitle, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { records, safeUrl, Timestamp, useWorkflowRequest } from './workflow-view-ui';

const metrics = ['likes', 'comments', 'shares', 'views', 'reactions', 'impressions', 'reach', 'sales'];
const acquisitionNames: Record<string, [string, string, string?]> = {
  manual: ['人工觀測', 'Manual observation', '人工观测'], import: ['使用者匯入', 'User import', '用户导入'],
  vendor: ['授權供應商（自動）', 'Authorized provider (automatic)', '授权供应商（自动）'],
  official_api: ['官方 API（自動）', 'Official API (automatic)', '官方 API（自动）'], platform_api: ['官方 API（自動）', 'Official API (automatic)', '官方 API（自动）'],
};
const availability: Record<string, [string, string, string?]> = {
  source_not_provided: ['來源未提供', 'Source did not provide', '来源未提供'], no_permission: ['無權限', 'Permission unavailable', '无权限'],
  not_collected: ['未採集', 'Not collected', '未采集'], not_applicable: ['不適用', 'Not applicable', '不适用'],
  delayed: ['延遲', 'Delayed', '延迟'], sync_failed: ['同步失敗', 'Sync failed', '同步失败'], estimated: ['估算', 'Estimated'],
};

function value(data: FormData, name: string) { return String(data.get(name) ?? '').trim(); }
function timestamp(data: FormData, name: string) {
  const raw = value(data, name);
  return raw ? new Date(raw).toISOString() : undefined;
}
function filterQuery(event: FormEvent<HTMLFormElement>, dateFields: string[] = ['from', 'to']) {
  event.preventDefault();
  const data = new FormData(event.currentTarget);
  return Object.fromEntries([...data].filter(([, entry]) => entry !== '').map(([name, entry]) =>
    [name, dateFields.includes(name) ? timestamp(data, name)! : String(entry)]));
}
function Field({ name, caption, type = 'text', required, children }: {
  name: string; caption: string; type?: string; required?: boolean; children?: ReactNode;
}) {
  return <label className="field">{caption}{children ?? <input name={name} type={type} required={required} />}</label>;
}
function Select({ name, options, empty, initial }: { name: string; options: string[]; empty?: string; initial?: string }) {
  return <select name={name} defaultValue={initial ?? ''}>{empty !== undefined && <option value="">{empty}</option>}{options.map(key => <option key={key}>{key}</option>)}</select>;
}
function Change({ title, method = 'POST', path, ids = [], record, body, children }: {
  title: string; method?: Method; path: string; ids?: string[]; record?: RecordData;
  body: (data: FormData) => RecordData; children?: ReactNode;
}) {
  const api = useApi();
  const { label } = useCopy();
  const { run, pending, error } = useWorkflowRequest();
  const [saved, setSaved] = useState(false);
  if (!findOperation(api, method, path, 'intel')) return null;
  return <form className="fields" onSubmit={async event => {
    event.preventDefault();
    setSaved(false);
    setSaved(Boolean(await run(method, path, ids, body(new FormData(event.currentTarget)), record)));
  }}><fieldset disabled={pending}>{children}<button type="submit">{title}</button></fieldset>
    {saved && <p role="status">{label(['已儲存', 'Saved', '已保存'])}</p>}{error !== undefined && <ProblemNotice error={error} />}
  </form>;
}
function DateFields() {
  const { label } = useCopy();
  return <><Field name="from" caption={label(['觀測起點', 'Observed from', '观测起点'])} type="datetime-local" />
    <Field name="to" caption={label(['觀測終點（不含）', 'Observed before', '观测终点（不含）'])} type="datetime-local" /></>;
}
function Metric({ row, name }: { row: RecordData; name: string }) {
  const { label } = useCopy();
  const metric = asRecord(asRecord(row.metrics)[name]);
  const status = stringValue(metric.availability) || 'source_not_provided';
  const count = metric.value ?? metric.amount_minor;
  return typeof count === 'number' ? <>{count}{stringValue(metric.currency) && ` ${metric.currency}`}{status === 'estimated' && ` (${label(availability.estimated)})`}</>
    : <>{availability[status] ? label(availability[status]) : status}</>;
}

export function IntelWatchCreate() {
  const { label } = useCopy();
  const sources = useRead('/data-sources', [], {}, 'ingest');
  const [kind, setKind] = useState('keyword');
  const [mode, setMode] = useState('manual');
  const keyword = ['keyword', 'hashtag', 'category'].includes(kind);
  return <details className="message"><summary>{label(['新增監測對象', 'New watch target', '添加监测对象'])}</summary>
    <Change title={label(['建立監測對象', 'Create watch target', '创建监测对象'])} path="/watch-targets" body={data => ({
      name: value(data, 'name'), target_type: kind, data_mode: mode, platform: value(data, 'platform') || undefined,
      query: { keywords: keyword ? value(data, 'keywords').split(',').map(word => word.trim()).filter(Boolean) : [],
        url: value(data, 'url') || undefined, handle: value(data, 'handle') || undefined },
      data_source_id: value(data, 'data_source_id') || undefined, refresh_frequency: value(data, 'refresh_frequency'),
      owner_user_id: value(data, 'owner_user_id') || undefined, coverage_note: value(data, 'coverage_note') || undefined,
    })}>
      <Field name="name" caption={label(['名稱', 'Name', '名称'])} required />
      <Field name="target_type" caption={label(['類型', 'Target type', '类型'])}><select value={kind} onChange={event => setKind(event.target.value)}>{['keyword', 'hashtag', 'category', 'competitor_account', 'store', 'creator_account', 'product_url'].map(type => <option key={type}>{type}</option>)}</select></Field>
      {keyword && <Field name="keywords" caption={label(['關鍵字（逗號分隔）', 'Keywords (comma separated)', '关键字（逗号分隔）'])} required />}
      <Field name="url" caption={label(['收藏連結', 'Saved link', '收藏链接'])} type="url" required={kind === 'product_url'} />
      {!keyword && kind !== 'product_url' && <Field name="handle" caption={label(['帳號名稱', 'Handle', '账号名称'])} />}
      <Field name="platform" caption={label(['平台', 'Platform'])} />
      <Field name="data_mode" caption={label(['取得方式', 'Acquisition method'])}><select value={mode} onChange={event => setMode(event.target.value)}>{Object.entries(acquisitionNames).filter(([id]) => id !== 'platform_api').map(([id, caption]) => <option key={id} value={id}>{label(caption)}</option>)}</select></Field>
      {mode !== 'manual' && <Field name="data_source_id" caption={label(['批准的資料來源', 'Approved data source', '批准的数据源'])}><select name="data_source_id" required={mode !== 'import'}><option value="">—</option>{records(sources.data?.data).map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{rowTitle(row)}</option>)}</select></Field>}
      <Field name="owner_user_id" caption={label(['負責人 ID', 'Owner ID', '负责人 ID'])} />
      <Field name="refresh_frequency" caption={label(['更新頻率', 'Refresh frequency', '更新频率'])}><Select name="refresh_frequency" options={['manual', 'daily', 'weekly']} initial="manual" /></Field>
      <Field name="coverage_note" caption={label(['涵蓋說明', 'Coverage note', '涵盖说明'])} />
    </Change></details>;
}

export function IntelWatch({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const [query, setQuery] = useState<Record<string, string>>({});
  const [metric, setMetric] = useState('');
  const id = stringValue(record.id);
  const read = useRead('/watch-targets/:id/observations', [id], query, 'intel');
  const source = asRecord(record.acquisition);
  const method = stringValue(source.method ?? record.data_mode);
  const queryLink = safeUrl(asRecord(record.query).url);
  const resourceNames = Array.isArray(source.resources) ? source.resources.map(stringValue).filter(Boolean) : [];
  const uses = Object.entries(asRecord(source.allowed_uses)).filter(([, allowed]) => allowed === true).map(([name]) => name);
  const shown = [...new Set(['likes', 'impressions', 'reach', 'sales', ...(query.metric ? [query.metric] : [])])];
  return <section className="fields"><h3>{label(['資料取得與涵蓋', 'Acquisition and coverage', '数据取得与涵盖'])}</h3>
    <dl><dt>{label(['取得方式', 'Acquisition method'])}</dt><dd>{acquisitionNames[method] ? label(acquisitionNames[method]) : method || '—'}</dd>
      <dt>{label(['範圍', 'Coverage', '范围'])}</dt><dd>{stringValue(source.coverage_note ?? record.coverage_note) || '—'}{resourceNames.length > 0 && ` · ${resourceNames.join(', ')}`}</dd>
      {source.data_source_id != null && <><dt>{label(['授權來源', 'Authorized source', '授权来源'])}</dt><dd>{stringValue(source.data_source_id)} · {stringValue(source.source_status)}</dd></>}
      {uses.length > 0 && <><dt>{label(['允許用途', 'Allowed uses', '允许用途'])}</dt><dd>{uses.join(', ')}</dd></>}
      <dt>{label(['更新頻率', 'Refresh frequency', '更新频率'])}</dt><dd>{stringValue(record.refresh_frequency) || '—'}</dd>
      <dt>{label(['負責人', 'Owner', '负责人'])}</dt><dd>{stringValue(record.owner_user_id) || '—'}</dd></dl>
    {queryLink && <a href={queryLink} target="_blank" rel="noreferrer">{label(['收藏連結', 'Saved link', '收藏链接'])}</a>}
    <details><summary>{label(['新增人工觀測', 'Record a manual observation', '添加人工观测'])}</summary>
      <Change title={label(['儲存人工觀測', 'Save manual observation', '保存人工观测'])} path="/observations" body={data => ({
        watch_target_id: id, subject_type: value(data, 'subject_type'), url: value(data, 'url'),
        observed_at: timestamp(data, 'observed_at'), published_at: timestamp(data, 'published_at'),
        note: value(data, 'note') || undefined, metrics: Object.fromEntries(['likes', 'comments', 'shares', 'views'].filter(key => value(data, key) !== '')
          .map(key => [key, { availability: 'observed', value: Number(value(data, key)) }])),
      })}>
        <Field name="subject_type" caption={label(['對象', 'Subject', '对象'])}><Select name="subject_type" options={['post', 'video', 'live', 'account', 'product']} initial="post" /></Field>
        <Field name="url" caption={label(['觀測連結', 'Observation link', '观测链接'])} type="url" required />
        <Field name="observed_at" caption={label(['觀測時間', 'Observed at', '观测时间'])} type="datetime-local" required />
        <Field name="published_at" caption={label(['發布時間', 'Published at', '发布时间'])} type="datetime-local" />
        {['likes', 'comments', 'shares', 'views'].map(key => <Field key={key} name={key} caption={key}><input name={key} type="number" min="0" step="1" /></Field>)}
        <Field name="note" caption={label(['備註', 'Note', '备注'])} />
      </Change></details>
    <h3>{label(['觀測時間線', 'Observation timeline', '观测时间线'])}</h3>
    <form className="fields" onSubmit={event => setQuery(filterQuery(event))}>
      <DateFields />
      <Field name="age_bucket" caption={label(['作品觀測時效', 'Post age at observation', '作品观测时效'])}><Select name="age_bucket" options={['0-24h', '1-7d', '7-30d']} empty={label(['所有時效', 'All post ages', '所有时效'])} /></Field>
      <Field name="metric" caption={label(['指標', 'Metric', '指标'])}><select name="metric" value={metric} onChange={event => setMetric(event.target.value)}><option value="">—</option>{metrics.map(name => <option key={name}>{name}</option>)}</select></Field>
      {metric && <Field name="availability" caption={label(['可用性', 'Availability'])}><select name="availability"><option value="">{label(['有數值', 'Has a value', '有数值'])}</option>{Object.entries(availability).map(([key, caption]) => <option key={key} value={key}>{label(caption)}</option>)}</select></Field>}
      <button type="submit">{label(['篩選觀測', 'Filter observations', '筛选观测'])}</button>
    </form>
    <ReadState read={read} />
    {read.data && <EntityTable records={records(read.data.data)} rowKey={row => stringValue(row.id)} columns={[
      { label: label(['來源', 'Source', '来源']), cell: row => {
        const method = stringValue(asRecord(row.source).method);
        const link = safeUrl(row.url);
        return <>{link ? <a href={link} target="_blank" rel="noreferrer">{stringValue(row.external_id) || stringValue(row.url)}</a> : stringValue(row.id)}<br />
          {acquisitionNames[method] ? label(acquisitionNames[method]) : method}</>;
      } },
      { label: label(['觀測時間', 'Observed at', '观测时间']), cell: row => <Timestamp value={row.observed_at} /> },
      ...shown.map(name => ({ label: name, cell: (row: RecordData) => <Metric row={row} name={name} /> })),
    ]} />}
    {read.data && records(read.data.data).length === 0 && <p>{label(['沒有符合條件的觀測', 'No matching observations', '没有符合条件的观测'])}</p>}
  </section>;
}

export function IntelCompare() {
  const { label } = useCopy();
  const [query, setQuery] = useState<Record<string, string>>({});
  const targets = useRead('/watch-targets', [], {}, 'intel');
  const result = useRead('/research/compare', [query.watch_target_ids ?? ''], query, 'intel');
  const rows = records(targets.data?.data);
  const data = asRecord(result.data?.data);
  return <Panel><div className="detail-body"><h2>{label(['同齡觀測比較', 'Same-age observation comparison', '同龄观测比较'])}</h2>
    <ReadState read={targets} />
    <form className="fields" onSubmit={event => {
      const form = new FormData(event.currentTarget);
      setQuery({ ...filterQuery(event), watch_target_ids: form.getAll('watch_target_ids').join(',') });
    }}>
      <Field name="watch_target_ids" caption={label(['監測對象（可複選）', 'Watch targets (select multiple)', '监测对象（可复选）'])}><select name="watch_target_ids" multiple required>{rows.map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{rowTitle(row)}</option>)}</select></Field>
      <Field name="metric" caption={label(['指標', 'Metric', '指标'])}><Select name="metric" options={['likes', 'comments', 'shares', 'views', 'reactions', 'post_frequency']} initial="likes" /></Field>
      <Field name="age" caption={label(['作品年齡桶', 'Post age bucket', '作品年龄桶'])}><Select name="age" options={['24h', '7d']} initial="24h" /></Field>
      <DateFields /><button type="submit">{label(['比較', 'Compare', '比较'])}</button>
    </form>
    {query.watch_target_ids && <ReadState read={result} />}
    {result.data && <><p>{label(['計算時間', 'As of', '计算时间'])} <Timestamp value={data.as_of} /> · {stringValue(data.age)}</p>
      <EntityTable records={records(data.sample)} rowKey={row => stringValue(row.watch_target_id)} columns={[
        { label: label(['對象', 'Target', '对象']), cell: row => rowTitle(rows.find(target => target.id === row.watch_target_id) ?? {}) || stringValue(row.watch_target_id) },
        { label: label(['樣本數', 'Sample size', '样本数']), cell: row => stringValue(row.sample_size) },
        { label: label(['觀測均值（樣本）', 'Observed mean (samples)', '观测均值（样本）']), cell: row => `${stringValue(row.average) || '—'} (${stringValue(row.observed_sample_size)})` },
        { label: label(['估算均值（樣本）', 'Estimated mean (samples)', '估算均值（样本）']), cell: row => `${stringValue(row.estimate_average) || '—'} (${stringValue(row.estimated_sample_size)})` },
        { label: label(['涵蓋', 'Coverage', '涵盖']), cell: row => stringValue(row.coverage_note) },
      ]} /></>}
  </div></Panel>;
}

export function IntelAlerts() {
  const api = useApi();
  const { label } = useCopy();
  const rules = useRead('/alert-rules', [], {}, 'intel');
  const targets = useRead('/watch-targets', [], {}, 'intel');
  const [type, setType] = useState('new_post');
  if (!findOperation(api, 'GET', '/alert-rules', 'intel')) return null;
  return <Panel><div className="detail-body"><h2>{label(['監測警示規則', 'Monitoring alert rules', '监测警示规则'])}</h2>
    <ReadState read={rules} />
    {rules.data && <ul>{records(rules.data.data).map(rule => <li key={stringValue(rule.id)}>{rowTitle(rule)} · {stringValue(asRecord(rule.condition).type)} · {stringValue(rule.status)}</li>)}</ul>}
    <details><summary>{label(['建立警示規則', 'Create alert rule', '创建警示规则'])}</summary>
      <Change title={label(['儲存警示規則', 'Save alert rule', '保存警示规则'])} path="/alert-rules" body={data => ({
        name: value(data, 'name'), watch_target_ids: data.getAll('watch_target_ids'),
        condition: { type, ...(type === 'keyword' && { keyword: value(data, 'keyword') }),
          ...(type === 'engagement_increment' && { metric: value(data, 'metric'), min_increment: Number(value(data, 'min_increment')) }) },
        min_freshness: value(data, 'min_freshness') ? Number(value(data, 'min_freshness')) : undefined,
        recipients: value(data, 'recipients').split(',').map(entry => entry.trim()).filter(Boolean),
      })}>
        <Field name="name" caption={label(['名稱', 'Name', '名称'])} required />
        <Field name="watch_target_ids" caption={label(['監測對象（可複選）', 'Watch targets (select multiple)', '监测对象（可复选）'])}><select name="watch_target_ids" multiple required>{records(targets.data?.data).map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{rowTitle(row)}</option>)}</select></Field>
        <Field name="type" caption={label(['條件', 'Condition', '条件'])}><select value={type} onChange={event => setType(event.target.value)}>{['new_post', 'engagement_increment', 'price_change', 'keyword'].map(key => <option key={key}>{key}</option>)}</select></Field>
        {type === 'keyword' && <Field name="keyword" caption={label(['關鍵字', 'Keyword', '关键字'])} required />}
        {type === 'engagement_increment' && <><Field name="metric" caption={label(['指標', 'Metric', '指标'])}><Select name="metric" options={metrics.slice(0, 5)} initial="likes" /></Field>
          <Field name="min_increment" caption={label(['最小增量', 'Minimum increment'])}><input name="min_increment" type="number" min="1" step="1" required /></Field></>}
        <Field name="min_freshness" caption={label(['資料失效時間（秒）', 'Source freshness limit (seconds)', '数据失效时间（秒）'])}><input name="min_freshness" type="number" min="1" step="1" /></Field>
        <Field name="recipients" caption={label(['收件人成員 ID（逗號分隔）', 'Recipient member IDs (comma separated)', '收件人成员 ID（逗号分隔）'])} />
      </Change></details>
    <Change title={label(['立即檢查警示', 'Evaluate alerts now', '立即检查警示'])} path="/alerts/evaluate" body={() => ({})} />
  </div></Panel>;
}
