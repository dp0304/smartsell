import { EntityTable, EmptyState } from '@smartsell/ui';
import { useState } from 'react';
import { productSearchLabel, useCatalogQuery } from './commerce-workbench';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { Link } from 'react-router-dom';
import { findOperation, ProblemNotice, ReadState, rowTitle, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { records, Status, Timestamp, useWorkflowRequest } from './workflow-view-ui';
import { CampaignTracking, CampaignCloseout } from './campaign-tracking';
import './campaign-workspace.css';

const campaignPath = '/campaigns/:id';
const idOf = (row: RecordData) => stringValue(row.id);
const field = (data: FormData, key: string) => String(data.get(key) ?? '').trim();
const editable = (campaign: RecordData) => !['closed', 'cancelled'].includes(stringValue(campaign.status));

function CampaignProducts({ campaign, id }: { campaign: RecordData; id: string }) {
  const { label } = useCopy();
  const api = useApi();
  const save = useWorkflowRequest();
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const query = useCatalogQuery(search);
  const path = `${campaignPath}/products`;
  const brandId = stringValue(campaign.brand_id);
  const attached = records(campaign.products);
  const canAdd = editable(campaign) && Boolean(findOperation(api, 'PUT', path, 'campaign'));
  const catalog = useRead(canAdd || attached.length ? '/products' : '/__none__', [], { brand_id: brandId }, 'commerce');
  const matches = useRead(canAdd && query ? '/products' : '/__none__', [], { brand_id: brandId, query }, 'commerce');
  const candidates = records((query ? matches : catalog).data?.data).filter(row => !attached.some(link => link.product_id === row.id));
  const roles = [
    ['hero', ['主打', 'Hero']], ['supporting', ['搭配', 'Supporting']],
    ['bundle', ['組合', 'Bundle']], ['gift', ['贈品', 'Gift']],
  ] as const;
  return <section className="detail-block">
    <h3>{label(['活動商品', 'Campaign products'])}</h3>
    {attached.length > 0 && <ul>{attached.map(link => {
      const product = records(catalog.data?.data).find(row => row.id === link.product_id);
      const role = roles.find(([key]) => key === link.role);
      return <li key={stringValue(link.product_id)}>{product ? rowTitle(product) : stringValue(link.product_id)}{role && ` · ${label(role[1])}`}</li>;
    })}</ul>}
    {canAdd && catalog.op && <form className="fields" onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      if (query !== search.trim() || !candidates.some(row => row.id === productId)) return;
      const result = await save.run('PUT', path, [id], { products: [
        ...attached.map(({ product_id, variant_ids, market_ids, role }) => ({ product_id, variant_ids, market_ids, role })),
        { product_id: productId, role: field(data, 'role') },
      ] }, campaign);
      if (result) { setProductId(''); setSearch(''); form.reset(); }
    }}>
      <label className="field">{label(productSearchLabel)}<input type="search" value={search} onChange={event => { setSearch(event.target.value); setProductId(''); }} /></label>
      <ReadState read={query ? matches : catalog} />
      <label className="field">{label(['商品', 'Product'])}<select value={productId} required onChange={event => setProductId(event.target.value)}>
        <option value="">—</option>{query === search.trim() && candidates.map(row => <option key={idOf(row)} value={idOf(row)}>{rowTitle(row)}</option>)}
      </select></label>
      <label className="field">{label(['商品角色', 'Product role'])}<select name="role" defaultValue="hero">
        {roles.map(([key, copy]) => <option key={key} value={key}>{label(copy)}</option>)}
      </select></label>
      <button disabled={save.pending || !productId}>{label(['加入活動商品', 'Add campaign product'])}</button>
      {save.error != null && <ProblemNotice error={save.error} />}
    </form>}
  </section>;
}

function Goals({ campaign, id }: { campaign: RecordData; id: string }) {
  const { label, t } = useCopy();
  const api = useApi();
  const create = useWorkflowRequest();
  const attach = useWorkflowRequest();
  const goals = useRead(`${campaignPath}/goals`, [id], {}, 'campaign');
  const markets = useRead('/brands/:id/markets', [stringValue(campaign.brand_id)], {}, 'workspace');
  const definitions = useRead('/metric-definitions', [], {}, 'analytics');
  const metrics = records(asRecord(definitions.data?.data).items).filter(metric => metric.status !== 'deprecated' &&
    Array.isArray(metric.subject_types) && metric.subject_types.includes('campaign'));
  const metricList = `campaign-metrics-${id}`;
  const attached = records(campaign.markets);
  const available = records(markets.data?.data);
  const marketName = (marketId: unknown) => rowTitle(available.find(row => row.id === marketId) ?? {}) || stringValue(marketId);
  const remaining = available.filter(row => row.status !== 'archived' && !attached.some(link => link.market_id === row.id));
  return <section className="detail-block">
    <h3>{label(['市場目標', 'Market goals'])}</h3>
    <ReadState read={goals} />
    {goals.data && <EntityTable records={records(goals.data.data)} rowKey={idOf} columns={[
      { label: label(['市場', 'Market']), cell: goal => goal.campaign_market_id ? marketName(attached.find(link => link.id === goal.campaign_market_id)?.market_id) : label(['整體活動', 'Whole campaign']) },
      { label: label(['指標鍵', 'Metric key']), cell: goal => stringValue(goal.metric_key) },
      { label: label(['單位', 'Unit']), cell: goal => stringValue(goal.unit) },
      { label: label(['幣別', 'Currency']), cell: goal => stringValue(goal.currency) || '—' },
      { label: label(['基準值', 'Baseline value']), cell: goal => stringValue(goal.baseline_value) },
      { label: label(['目標值', 'Target value']), cell: goal => stringValue(goal.target_value) },
      { label: label(['到期時間', 'Due at']), cell: goal => <Timestamp value={goal.due_at} /> },
      { label: t('status'), cell: goal => <Status value={goal.status} /> },
    ]} />}
    {editable(campaign) && remaining.length > 0 && findOperation(api, 'PUT', `${campaignPath}/markets`, 'campaign') && <details>
      <summary>{label(['新增活動市場', 'Add campaign market'])}</summary>
      <form className="fields" onSubmit={async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const data = new FormData(form);
        const result = await attach.run('PUT', `${campaignPath}/markets`, [id], { markets: [
          ...attached.map(({ market_id, locales, starts_at, ends_at, owner_user_id, status }) => ({ market_id, locales, starts_at, ends_at, owner_user_id, status })),
          // A campaign market needs at least one locale; start from the market's own languages.
          ((market: RecordData | undefined) => ({ market_id: field(data, 'market_id'),
            locales: [...new Set([market?.primary_language, ...(Array.isArray(market?.languages) ? market.languages : [])].filter((value): value is string => typeof value === 'string' && Boolean(value)))] }))(remaining.find(row => idOf(row) === field(data, 'market_id'))),
        ] }, campaign);
        if (result) form.reset();
      }}>
        <label className="field">{label(['可用市場', 'Available market'])}<select name="market_id" defaultValue="" required><option value="">—</option>{remaining.map(row => <option key={idOf(row)} value={idOf(row)}>{rowTitle(row)}</option>)}</select></label>
        <button disabled={attach.pending}>{label(['加入市場', 'Attach market'])}</button>
        {attach.error != null && <ProblemNotice error={attach.error} />}
      </form>
    </details>}
    {editable(campaign) && findOperation(api, 'POST', `${campaignPath}/goals`, 'campaign') && <form className="fields" onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      const due_at = new Date(field(data, 'due_at'));
      if (!Number.isFinite(due_at.valueOf())) return;
      const result = await create.run('POST', `${campaignPath}/goals`, [id], {
        campaign_market_id: field(data, 'campaign_market_id') || null, metric_key: field(data, 'metric_key'),
        unit: field(data, 'unit'), currency: field(data, 'currency') || undefined, baseline_source: field(data, 'baseline_source'),
        baseline_value: Number(data.get('baseline_value')), target_value: Number(data.get('target_value')), due_at: due_at.toISOString(),
      });
      if (result) form.reset();
    }}>
      <label className="field">{label(['市場', 'Market'])}<select name="campaign_market_id" aria-label={label(['市場', 'Market'])} defaultValue=""><option value="">{label(['整體活動', 'Whole campaign'])}</option>{attached.map(row => <option key={idOf(row)} value={idOf(row)}>{marketName(row.market_id)}</option>)}</select></label>
      <label className="field">{label(['指標鍵', 'Metric key'])}<input name="metric_key" list={metricList} required /></label>
      <datalist id={metricList}>{metrics.map(metric => <option key={stringValue(metric.key)} value={stringValue(metric.key)} label={stringValue(metric.display_name)} />)}</datalist>
      <label className="field">{label(['單位', 'Unit'])}<select name="unit" aria-label={label(['單位', 'Unit'])} defaultValue="" required><option value="">—</option>{['count', 'currency', 'percent', 'seconds'].map(unit => <option key={unit}>{unit}</option>)}</select></label>
      <label className="field">{label(['幣別', 'Currency'])}<input name="currency" pattern="[A-Za-z]{3}" maxLength={3} placeholder="USD" /></label>
      <label className="field">{label(['基準值', 'Baseline value'])}<input name="baseline_value" type="number" step="any" required /></label>
      <label className="field">{label(['基準來源', 'Baseline source'])}<input name="baseline_source" defaultValue="manual" required /></label>
      <label className="field">{label(['目標值', 'Target value'])}<input name="target_value" type="number" step="any" required /></label>
      <label className="field">{label(['到期時間', 'Due at'])}<input name="due_at" type="datetime-local" required /></label>
      <button disabled={create.pending}>{label(['儲存目標', 'Save goal'])}</button>
      {create.error != null && <ProblemNotice error={create.error} />}
    </form>}
  </section>;
}

function briefText(doc: unknown): string {
  const node = asRecord(doc);
  if (typeof node.text === 'string') return node.text;
  return Array.isArray(node.content) ? node.content.map(briefText).join(['doc', 'bulletList', 'orderedList', 'listItem'].includes(stringValue(node.type)) ? '\n' : '') : '';
}

function BriefRevisions({ brief }: { brief: RecordData }) {
  const { label } = useCopy();
  const read = useRead('/briefs/:id/revisions', [idOf(brief)], {}, 'campaign');
  return <article><h4>{rowTitle(brief)}</h4><ReadState read={read} />{records(read.data?.data).map(row => <div key={idOf(row)}>
    <strong>{label(['版本', 'Version'])} {stringValue(row.revision_no)}</strong> <Status value={row.status} />
    <p style={{ whiteSpace: 'pre-wrap' }}>{briefText(row.body_doc)}</p>
  </div>)}</article>;
}

function BriefHistory({ id }: { id: string }) {
  const { label, t } = useCopy();
  const read = useRead(`${campaignPath}/briefs`, [id], {}, 'campaign');
  const briefs = records(read.data?.data);
  return <section className="detail-block"><h3>{label(['簡報修訂歷史', 'Brief history'])}</h3>
    <ReadState read={read} />{briefs.map(brief => <BriefRevisions key={idOf(brief)} brief={brief} />)}
    {read.data && !briefs.length && <EmptyState title={t('empty')} />}
  </section>;
}

function Milestones({ campaign, id }: { campaign: RecordData; id: string }) {
  const { label, t } = useCopy();
  const api = useApi();
  const complete = useWorkflowRequest();
  const read = useRead(`${campaignPath}/milestones`, [id], {}, 'campaign');
  const milestones = records(read.data?.data);
  const completePath = '/work-items/:id/complete';
  const canComplete = findOperation(api, 'POST', completePath, 'workspace');
  const taskPath = '/work-items/:id';
  const canStart = findOperation(api, 'PATCH', taskPath, 'workspace');
  return <section className="detail-block"><h3>{label(['製作里程碑', 'Production milestones'])}</h3>
    <ReadState read={read} />
    {read.data && <EntityTable records={milestones} rowKey={idOf} columns={[
      { label: label(['工作項目', 'Work item']), cell: rowTitle },
      { label: label(['製作期限', 'Production due']), cell: row => <Timestamp value={row.due_at} /> },
      { label: t('status'), cell: row => <><Status value={row.status} />
        {row.blocked === true && <p>{label(['前置工作未完成', 'Blocked by predecessor'])}</p>}
        {row.status === 'done' && asRecord(row.payload).gate === 'ready_for_scheduling' && <p>{label(['可排期', 'Ready for scheduling'])}</p>}</> },
      { label: label(['動作', 'Actions']), cell: row => editable(campaign) && row.blocked !== true && <>
        {row.status === 'open' && canStart && <button disabled={complete.pending}
          onClick={() => void complete.run('PATCH', taskPath, [idOf(row)], { status: 'in_progress' }, row)}>{label(['開始工作項目', 'Start work item'])}</button>}
        {row.status === 'in_progress' && canComplete && <button disabled={complete.pending}
          onClick={() => void complete.run('POST', completePath, [idOf(row)], {}, row)}>{label(['完成工作項目', 'Complete work item'])}</button>}
      </> },
    ]} />}{complete.error != null && <ProblemNotice error={complete.error} />}
  </section>;
}

function ChannelMatrix({ id }: { id: string }) {
  const { label, t } = useCopy();
  const read = useRead(`${campaignPath}/matrix`, [id], {}, 'campaign');
  const accounts = useRead('/social-accounts', [], {}, 'account');
  const content = useRead('/content-items', [], { campaign_id: id }, 'content');
  const matrix = asRecord(read.data?.data);
  const cells: RecordData[] = records(matrix.cells).map(cell => ({ ...cell, id: idOf(asRecord(cell.slot)) }));
  const actuals: RecordData[] = [...cells.flatMap(cell => records(cell.actual)), ...records(matrix.outside_plan).map(row => ({ ...row, unplanned: true })),
    ...records(matrix.unplanned_items).map(row => ({ ...row, content_item_id: row.id, unplanned: true, status: 'in_production' }))];
  const titleOf = (readData: unknown, id: unknown) => rowTitle(records(readData).find(row => row.id === id) ?? {}) || stringValue(id) || '—';
  const accountName = (id: unknown) => titleOf(accounts.data?.data, id);
  return <section className="detail-block"><h3>{label(['渠道矩陣', 'Channel matrix'])}</h3><ReadState read={read} />
    {read.data && <><EntityTable records={cells} rowKey={idOf} columns={[
      { label: t('platform'), cell: row => stringValue(asRecord(row.slot).platform) },
      { label: label(['帳號', 'Account']), cell: row => accountName(asRecord(row.slot).social_account_id) },
      { label: label(['階段', 'Stage']), cell: row => stringValue(asRecord(row.slot).stage) },
      { label: label(['計畫', 'Planned']), cell: row => stringValue(asRecord(row.slot).planned_count) },
      ...([['in_production', '製作中', 'In production'], ['scheduled', '已排期', 'Scheduled'], ['published', '已發布', 'Published'], ['failed', '失敗', 'Failed']] as const).map(([key, zh, en]) => ({
        label: label([zh, en]), cell: (row: RecordData) => stringValue(asRecord(row.counts)[key]),
      })),
      { label: label(['缺口', 'Gap']), cell: row => stringValue(row.gap) },
    ]} />
    <EntityTable records={actuals} rowKey={row => stringValue(row.publish_target_id ?? row.content_variant_id ?? row.content_item_id)} columns={[
      { label: label(['帳號', 'Account']), cell: row => accountName(row.social_account_id) },
      { label: label(['內容變體', 'Content variant']), cell: row => <>{titleOf(content.data?.data, row.content_item_id)}{row.content_variant_id != null && <div><small>{stringValue(row.content_variant_id)}</small></div>}</> },
      { label: label(['發布目標', 'Publishing target']), cell: row => stringValue(row.publish_target_id) || '—' },
      { label: label(['發布時間', 'Publish time']), cell: row => row.scheduled_at ? <Timestamp value={row.scheduled_at} /> : label(['未排期', 'Unscheduled']) },
      { label: t('status'), cell: row => <Status value={row.status} /> },
      { label: label(['計畫歸屬', 'Plan']), cell: row => row.unplanned ? label(['計畫外', 'Unplanned']) : label(['計畫內', 'Planned']) },
    ]} /></>}
  </section>;
}

function BudgetLedger({ title, id, endpoint }: { title: string; id: string; endpoint: string }) {
  const { label, t, locale } = useCopy();
  const read = useRead(`${campaignPath}/${endpoint}`, [id], {}, 'campaign');
  const format = new Intl.NumberFormat(locale);
  if (!read.op) return null;
  return <><h4>{title}</h4><ReadState read={read} />{read.data && <EntityTable records={records(read.data.data)} rowKey={idOf} columns={[
    { label: label(['金額', 'Amount']), cell: row => format.format(Number(row.amount_minor)) },
    { label: label(['幣別', 'Currency']), cell: row => stringValue(row.currency) },
    { label: label(['換算日', 'FX date']), cell: row => stringValue(row.fx_date) || '—' },
    { label: t('status'), cell: row => <Status value={row.voided_at ? 'voided' : row.status ?? 'recorded'} /> },
  ]} />}</>;
}

function Budget({ id }: { id: string }) {
  const { label, locale } = useCopy();
  const read = useRead(`${campaignPath}/budget-summary`, [id], {}, 'campaign');
  const lines = records(asRecord(read.data?.data).lines);
  const format = new Intl.NumberFormat(locale);
  return <section className="detail-block"><h3>{label(['活動預算', 'Campaign budget'])}</h3><ReadState read={read} />
    {read.data && <>
      <p>{label(['所有金額以原幣最小單位列示。', 'Amounts are in minor units of the original currency.'])}</p>
      {lines.some(row => Number(row.overrun_minor) > 0) && <p role="status">{label(['有預算項目超額，請檢視審批。', 'Budget overrun detected. Review the approval request.'])}</p>}
      <EntityTable records={lines} rowKey={row => stringValue(row.budget_line_id)} columns={[
        { label: label(['類別', 'Category']), cell: row => stringValue(row.category) },
        { label: label(['幣別', 'Currency']), cell: row => stringValue(row.currency) },
        { label: label(['換算日', 'FX date']), cell: row => stringValue(row.fx_date) },
        ...([['budget_minor', '計畫', 'Planned'], ['committed_minor', '承諾', 'Committed'], ['open_commitment_minor', '未執行承諾', 'Outstanding commitments'], ['actual_minor', '已花', 'Spent'], ['overrun_minor', '超額', 'Overrun']] as const).map(([key, zh, en]) => ({
          label: label([zh, en]), cell: (row: RecordData) => format.format(Number(row[key])),
        })),
      ]} />
      <BudgetLedger id={id} endpoint="cost-commitments" title={label(['承諾明細', 'Commitment entries'])} />
      <BudgetLedger id={id} endpoint="cost-entries" title={label(['實際成本明細', 'Actual cost entries'])} />
    </>}
  </section>;
}

export function CampaignWorkspace({ record, id }: { record: RecordData; id: string }) {
  return <div className="campaign-detail">
    <CampaignProducts campaign={record} id={id} />
    <Goals campaign={record} id={id} />
    <BriefHistory id={id} />
    <Milestones campaign={record} id={id} />
    <ChannelMatrix id={id} />
    <Budget id={id} />
    <CampaignTracking campaign={record} id={id} />
    <CampaignCloseout campaign={record} id={id} />
  </div>;
}

export function CampaignBacklink({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const id = stringValue(record.campaign_id);
  const read = useRead(campaignPath, [id], {}, 'campaign');
  if (!id || !read.op) return null;
  const campaign = asRecord(read.data?.data);
  return <><ReadState read={read} />{read.data && <p>{label(['所屬活動', 'Campaign'])} <Link to={`/w/${encodeURIComponent(api.ws)}/campaigns/${encodeURIComponent(id)}`}>{rowTitle(campaign)}</Link></p>}</>;
}
