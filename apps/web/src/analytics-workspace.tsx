import { useState, type FormEvent } from 'react';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EntityTable, Panel } from '@smartsell/ui';
import { AnalyticsResult } from './analytics-result';
import { callOperation, findOperation, ProblemNotice, ReadState, recordRows, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';

export const analyticsReadResources = ['metrics', 'performance', 'accountPerformance', 'linkPerformance', 'contribution', 'revenue'] as const;
type AnalyticsReadResource = typeof analyticsReadResources[number];
const queryViews = {
  performance: { path: '/metrics/query', action: 'metrics_query', title: ['查詢同齡作品成效', 'Compare posts at the same age', '查找同龄作品成效'] },
  accountPerformance: { path: '/metrics/query', action: 'metrics_query', title: ['查詢帳號成效', 'Query account performance', '查找账号成效'] },
  linkPerformance: { path: '/performance/links', action: 'links_performance_get', title: ['查詢短連結成效', 'Query link performance', '查找短链接成效'] },
  contribution: { path: '/contribution', action: 'contribution_query', title: ['查詢估算貢獻', 'Query estimated contribution', '查找估算贡献'] },
  revenue: { path: '/revenue/daily', action: 'revenue_query', title: ['查詢收入對帳', 'Query revenue reconciliation', '查找收入对帐'] },
} as const;

export function isAnalyticsReadResource(resource: string): resource is AnalyticsReadResource {
  return analyticsReadResources.some(key => resource === key);
}

export function AnalyticsReadWorkspace({ resource, onPick }: { resource: AnalyticsReadResource; onPick: (id: string) => void }) {
  return resource === 'metrics' ? <MetricDictionary onPick={onPick} /> : <AnalyticsReadForm resource={resource} onPick={onPick} />;
}

function MetricDictionary({ onPick }: { onPick: (id: string) => void }) {
  const { label, locale } = useCopy();
  const read = useRead('/metric-definitions', [], {}, 'analytics');
  return <Panel><div className="panel-head"><h2>{label(['指標字典', 'Metric dictionary', '指标字典'])}</h2></div>
    <div className="detail-body"><ReadState read={read} />
      {read.data && <AnalyticsResult action="metric_definitions_get" result={asRecord(read.data.data)} locale={locale} onPick={onPick} />}
    </div>
  </Panel>;
}

function AnalyticsReadForm({ resource, onPick }: { resource: Exclude<AnalyticsReadResource, 'metrics'>; onPick: (id: string) => void }) {
  const api = useApi();
  const { locale, label, t } = useCopy();
  const view = queryViews[resource];
  const posts = resource === 'performance';
  const metrics = view.action === 'metrics_query';
  const contribution = resource === 'contribution';
  const operation = findOperation(api, metrics ? 'POST' : 'GET', view.path, 'analytics');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RecordData>();
  const [error, setError] = useState<unknown>();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!operation || pending) return;
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '').trim();
    const period = { from: field('from'), to: field('to'), tz: field('tz') };
    const store = field('store_id');
    const link = field('short_link_id');
    const subjects = field('subject_ids').split(',').map(id => id.trim()).filter(Boolean);
    setResult(undefined);
    setError(undefined);
    setPending(true);
    try {
      const response = await callOperation(api, operation, [], metrics ? { key: crypto.randomUUID(), body: {
        metrics: field('metric_keys').split(',').map(key => key.trim()).filter(Boolean),
        subject: { type: posts ? 'platform_post' : 'social_account', filter: subjects.length ? { subject_ids: subjects } : {} },
        time: { ...period, basis: posts ? 'published_at' : 'period' },
        ...(posts && { age_bucket: field('age_bucket'), include_estimates: form.has('include_estimates') }),
        ...(subjects.length && { group_by: ['subject_id'] }),
      } } : { query: { ...period, ...(store && { store_id: store }), ...(link && { short_link_id: link }),
        ...(contribution && { scope: field('scope'), currency: field('currency').toUpperCase() }) } });
      setResult(asRecord(response.data));
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }

  return <Panel><div className="panel-head"><h2>{label(view.title)}</h2></div>
    {operation ? <form onSubmit={submit} className="detail-body">
      <div className="toolbar">
        <label className="field">{label(['起始日期', 'Start date'])}<input name="from" type="date" required /></label>
        <label className="field">{label(['結束日期（不含）', 'End date (exclusive)', '结束日期（不含）'])}<input name="to" type="date" required /></label>
        <label className="field">{label(['時區', 'Time zone', '时区'])}<input name="tz" defaultValue="UTC" required /></label>
        {contribution && <>
          <label className="field">{label(['範圍', 'Scope', '范围'])}<input name="scope" required /></label>
          <label className="field">{label(['貨幣', 'Currency', '货币'])}<input name="currency" pattern="[A-Za-z]{3}" maxLength={3} defaultValue="USD" required /></label>
        </>}
        {resource === 'linkPerformance' && <label className="field">{label(['短連結 ID（選填）', 'Short link ID (optional)', '短链接 ID（选填）'])}<input name="short_link_id" /></label>}
        {resource === 'revenue' && <label className="field">{label(['店鋪 ID（選填）', 'Store ID (optional)', '店铺 ID（选填）'])}<input name="store_id" /></label>}
        {metrics && <>
          <label className="field">{label(['指標鍵（以逗號分隔）', 'Metric keys (comma-separated)', '指标键（以逗号分隔）'])}<input name="metric_keys" defaultValue={posts ? 'norm.post.views' : 'norm.account.followers'} required /></label>
          <label className="field">{label(['對象 ID（選填，以逗號分隔）', 'Subject IDs (optional, comma-separated)', '对象 ID（选填，以逗号分隔）'])}<input name="subject_ids" /></label>
        </>}
        {posts && <label className="field">{label(['發布後年齡', 'Age after publication', '发布后年龄'])}<select name="age_bucket" defaultValue="24h">
          {['1h', '6h', '24h', '72h', '7d', '28d', '90d'].map(age => <option key={age}>{age}</option>)}
        </select></label>}
      </div>
      {posts && <div><label><input type="checkbox" name="include_estimates" /> {label(['允許同齡內插估算', 'Include interpolated estimates', '允许同龄内插估算'])}</label></div>}
      <button type="submit" className="primary" disabled={pending}>{pending ? t('loading') : label(view.title)}</button>
      {error != null && <ProblemNotice error={error} />}
    </form> : <p className="detail-body">{t('noAccess')}</p>}
    {result && <div className="detail-body"><AnalyticsResult action={view.action} result={result} locale={locale} onPick={posts ? onPick : undefined} /></div>}
  </Panel>;
}

export function PageExperimentReport({ pageId, experimentId }: { pageId: string; experimentId: string }) {
  const { label, t } = useCopy();
  const read = useRead('/landing-pages/:id/experiment', [pageId], { experiment_id: experimentId }, 'traffic');
  const report = asRecord(read.data?.data);
  const title = label(['導流頁實驗報表', 'Landing page experiment report', '导流页实验报表']);
  return <section className="detail-block" aria-label={title}>
    <h3>{title}</h3>
    <ReadState read={read} />
    {read.data && <>
      {report.coverage === 'insufficient_traffic' && <p role="status"><strong>{label(['流量不足，無法作出結論。', 'Insufficient traffic to draw a conclusion.', '流量不足，无法作出结论。'])}</strong></p>}
      {report.coverage === 'unavailable' && <p>{label(['尚無實驗結果。', 'No experiment results yet.', '尚无实验结果。'])}</p>}
      <p>{label(['每組最低樣本數', 'Minimum sample size per arm', '每组最低样本数'])} · {stringValue(report.minimum_sample_size)}</p>
      <EntityTable records={recordRows(report.arms) ?? []} rowKey={row => stringValue(row.arm_key)} columns={[
        { label: label(['實驗組', 'Experiment arm', '实验组']), cell: row => stringValue(row.arm_key) },
        { label: label(['樣本數', 'Sample size', '样本数']), cell: row => stringValue(row.sample_size) || '—' },
        { label: stringValue(report.primary_metric) || t('result'), cell: row => stringValue(row.value) || '—' },
      ]} />
    </>}
  </section>;
}

function AudienceSnapshots() {
  const { label, locale } = useCopy();
  const [account, setAccount] = useState('');
  const read = useRead('/audience-insights', [], {}, 'analytics');
  const snapshots = Array.isArray(read.data?.data) ? read.data.data.map(asRecord) : [];
  const accounts = [...new Set(snapshots.map(row => String(row.social_account_id)))].sort();
  const sources = [
    ['platform', ['平台資料', 'Platform data', '平台数据'], ['由平台提供的觀測值。', 'Observations reported by the platform.', '由平台提供的观测值。']],
    ['owned_engagement', ['自有互動', 'Owned engagement', '自有交互'], ['以自有互動紀錄為基礎。', 'Based on owned engagement records.', '以自有交互记录为基础。']],
    ['third_party_estimate', ['第三方估計', 'Third-party estimates', '第三方估计'], ['由外部來源提供的估計值。', 'Estimates provided by an external source.', '由外部来源提供的估计值。']],
  ] as const;
  return <Panel><div className="panel-head"><h2>{label(['受眾快照', 'Audience snapshots', '受众快照'])}</h2></div>
    <div className="detail-body"><ReadState read={read} />
    {read.data && <>
      <label className="field">{label(['來源帳號', 'Source account', '来源账号'])}<select value={account} onChange={event => setAccount(event.target.value)}>
        <option value="">{label(['所有帳號', 'All accounts', '所有账号'])}</option>
        {accounts.map(id => <option key={id}>{id}</option>)}
      </select></label>
      <div className="table-scroll">
        <table className="entity-table" aria-label={label(['依來源比較受眾快照', 'Audience snapshots by source', '依来源比较受众快照'])}>
          <thead><tr>{sources.map(([source, title]) => <th key={source} scope="col">{label(title)}</th>)}</tr></thead>
          <tbody><tr>{sources.map(([source, , basis]) => {
            const rows = snapshots.filter(row => row.source === source && (!account || row.social_account_id === account));
            return <td key={source} style={{ verticalAlign: 'top', width: '33%' }}>
              <p>{label(basis)}</p>
              {rows.length ? rows.map(row => <article key={String(row.id)}>
                <h4>{String(row.dimension)}</h4>
                <p>{label(['帳號', 'Account', '账号'])} · {String(row.social_account_id)}</p>
                <p>{label(['觀測時間', 'Observed at', '观测时间'])} · <time dateTime={String(row.observed_at)}>{String(row.observed_at)}</time></p>
                <p>{label(['來源參照', 'Source reference', '来源参照'])} · {String(row.source_ref)}</p>
                <dl>{(Array.isArray(row.values) ? row.values.map(asRecord) : []).map((value, index) => <div key={index}>
                  <dt>{String(value.bucket)}</dt><dd>{typeof value.value === 'number' ? value.value.toLocaleString(locale) : label(['未取得', 'Unavailable'])}</dd>
                </div>)}</dl>
              </article>) : label(['無快照', 'No snapshots', '无快照'])}
            </td>;
          })}</tr></tbody>
        </table>
      </div>
    </>}
    </div>
  </Panel>;
}

function PostingTimeResult({ result }: { result: RecordData }) {
  const { locale, label } = useCopy();
  const basis = asRecord(result.basis_period);
  return <div role="status" aria-label={label(['發布時段結果', 'Posting time result', '发布时段结果'])}>
    <p>{label(['觀察期間（不含結束日期）', 'Observation period (end exclusive)', '观察期间（不含结束日期）'])} · {String(basis.from)} – {String(basis.to)}</p>
    <p>{label(['帳號時區', 'Account time zone', '账号时区'])} · {String(result.timezone)}</p>
    <p>{label(['依據', 'Basis', '依据'])} · {String(result.content_type)} · {String(result.metric_key)} · {label(['發布後 24 小時的自然流量', 'Organic performance at 24 hours', '发布后 24 小时的自然流量'])}</p>
    {result.recommendation === null ? <>
      <p>{label(['可比較作品', 'Comparable posts', '可比较作品'])} · {Number(result.sample_size).toLocaleString(locale)} / {Number(result.minimum_sample_size).toLocaleString(locale)}</p>
      <p>{result.reason === 'INSUFFICIENT_SLOT_SAMPLE'
        ? label(['沒有時段達到最低樣本數。請繼續使用人工排程。', 'No time slot has enough observations. Continue using manual scheduling.', '没有时段达到最低样本数。请继续使用人工调度。'])
        : label(['可比較作品不足。請繼續使用人工排程。', 'Too few comparable posts. Continue using manual scheduling.', '可比较作品不足。请继续使用人工调度。'])}</p>
      {result.reason === 'INSUFFICIENT_SLOT_SAMPLE' && <p>{label(['每時段最少作品', 'Minimum posts per slot', '每时段最少作品'])} · {String(result.minimum_slot_sample_size)}</p>}
    </> : <>
      <p>{label(['可比較作品', 'Comparable posts', '可比较作品'])} · {Number(result.sample_size).toLocaleString(locale)}</p>
      <p>{label(['時段根據歷史觀測得出，未來表現可能不同。', 'Times are based on historical observations. Future performance may differ.', '时段根据历史观测得出，未来表现可能不同。'])}</p>
      <AnalyticsResult action="posting_time_suggest" result={result} locale={locale} />
      <ApplyPostingTimes recommendation={result} />
    </>}
  </div>;
}

function ApplyPostingTimes({ recommendation }: { recommendation: RecordData }) {
  const api = useApi();
  const { label, t } = useCopy();
  const operation = findOperation(api, 'POST', '/posting-time-recommendations/:id/apply', 'analytics');
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<unknown>();
  if (!operation || recommendation.status !== 'proposed' || typeof recommendation.id !== 'string' || typeof recommendation.version !== 'number') return null;
  const { id, version } = recommendation;
  const apply = async () => {
    setPending(true);
    setError(undefined);
    try {
      await callOperation(api, operation, [id], { key: crypto.randomUUID(), version, body: {} });
      setApplied(true);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  };
  return <div className="action-row">
    {applied ? <p>{label(['已儲存為可調整的排程時段範本。', 'Saved as editable planning slot templates.', '已保存为可调整的调度时段范本。'])}</p>
      : <button type="button" onClick={() => void apply()} disabled={pending}>{pending ? t('loading') : label(['儲存為排程時段範本', 'Save as planning slot templates', '保存为调度时段范本'])}</button>}
    {error != null && <ProblemNotice error={error} />}
  </div>;
}

export function AnalyticsWorkspace({ resource }: { resource: 'cohorts' | 'attribution' | 'audience' }) {
  const api = useApi();
  const { locale, label, t } = useCopy();
  const cohorts = resource === 'cohorts';
  const attribution = resource === 'attribution';
  const audience = resource === 'audience';
  const path = cohorts ? '/cohorts' : attribution ? '/attribution/query' : '/posting-time-recommendations';
  const operation = findOperation(api, cohorts ? 'GET' : 'POST', path, 'analytics');
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<RecordData>();
  const [error, setError] = useState<unknown>();
  if (!operation) return audience ? <AudienceSnapshots /> : null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !operation) return;
    const form = new FormData(event.currentTarget);
    const field = (key: string) => String(form.get(key) ?? '').trim();
    const period = { from: field('from'), to: field('to'), tz: field('tz') };
    const store_id = field('store_id');
    const postingBasis = { from: period.from, to: period.to, social_account_id: field('social_account_id'),
      content_type: field('content_type'), metric_key: field('metric_key') };
    setResult(undefined);
    setError(undefined);
    setPending(true);
    try {
      const response = await callOperation(api, operation, [], cohorts ? { query: { ...period, ...(store_id && { store_id }),
        history_months: field('history_months'), observation_months: field('observation_months') } } : {
        key: crypto.randomUUID(), body: attribution ? { ...period, ...(store_id && { store_id }), models: form.getAll('models') } : postingBasis,
      });
      const data = asRecord(response.data);
      setResult(cohorts ? { items: response.data, observation_months: Number(field('observation_months')), history_months: Number(field('history_months')) }
        : audience ? { basis_period: { from: postingBasis.from, to: postingBasis.to }, content_type: postingBasis.content_type, metric_key: postingBasis.metric_key, ...data } : data);
    } catch (failure) {
      setError(failure);
    } finally {
      setPending(false);
    }
  }
  const title = cohorts ? label(['查詢首購與復購客群', 'Query first-purchase and repeat cohorts', '查找首购与复购客群']) : attribution ?
    label(['比較訂單歸因', 'Compare order attribution', '比较订单归因']) : label(['建議發布時段', 'Suggest posting times', '建议发布时段']);
  return <>
    {audience && <AudienceSnapshots />}
    <Panel><div className="panel-head"><h2>{title}</h2></div>
    <form onSubmit={submit} className="detail-body">
      <div className="toolbar">
        <label className="field">{label(['起始日期', 'Start date'])}<input name="from" type="date" required /></label>
        <label className="field">{label(['結束日期（不含）', 'End date (exclusive)', '结束日期（不含）'])}<input name="to" type="date" required /></label>
        {!audience && <label className="field">{label(['時區', 'Time zone', '时区'])}<input name="tz" defaultValue="UTC" required /></label>}
        {(cohorts || attribution) && <label className="field">{label(['店鋪 ID（選填）', 'Store ID (optional)', '店铺 ID（选填）'])}<input name="store_id" /></label>}
        {cohorts && <>
          <label className="field">{label(['復購觀察月數', 'Repeat observation months', '复购观察月数'])}<input name="observation_months" type="number" min="1" max="24" defaultValue="1" required /></label>
          <label className="field">{label(['最低歷史月數', 'Minimum history months', '最低历史月数'])}<input name="history_months" type="number" min="1" max="24" defaultValue="3" required /></label>
        </>}
        {!cohorts && !attribution && <>
          <label className="field">{label(['社群帳號 ID', 'Social account ID', '社交媒体账号 ID'])}<input name="social_account_id" required /></label>
          <label className="field">{label(['內容形式', 'Content type', '内容形式'])}<input name="content_type" required /></label>
          <label className="field">{label(['指標', 'Metric', '指标'])}<input name="metric_key" defaultValue="norm.post.engagements" required /></label>
        </>}
      </div>
      {attribution && <fieldset><legend>{label(['歸因模型', 'Attribution models', '归因模型'])}</legend>
        {(['link_session', 'discount_code', 'platform_reported', 'first_touch', 'last_touch', 'linear', 'external_service'] as const).map((model, index) =>
          <label key={model}><input type="checkbox" name="models" value={model} defaultChecked={index < 3} /> {model.replaceAll('_', ' ')} </label>)}
      </fieldset>}
      <button type="submit" className="primary" disabled={pending}>{pending ? t('loading') : title}</button>
      {error != null && <ProblemNotice error={error} />}
      {result && (audience ? <PostingTimeResult result={result} />
        : <div role="status"><AnalyticsResult action={cohorts ? 'cohorts_list' : 'attribution_query'} result={result} locale={locale} /></div>)}
    </form>
    </Panel>
  </>;
}
