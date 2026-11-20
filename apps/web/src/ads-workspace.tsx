import { useState } from 'react';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { Panel } from '@smartsell/ui';
import { ProblemNotice, ReadState, findOperation, recordRows, rowTitle, stringValue, useApi, useRead } from './api';
import { OperationForm, type Selection } from './OperationForm';
import { useCopy } from './i18n';
import { useWorkflowRequest } from './workflow-view-ui';

function fields(value: unknown): RecordData[] {
  return recordRows(value) ?? [];
}

function amount(value: unknown, currency: unknown, missing: string) {
  return typeof value === 'number' ? `${stringValue(currency)} ${value}`.trim() : missing;
}

function AdPerformance({ account }: { account: string }) {
  const { label } = useCopy();
  const [query, setQuery] = useState<Record<string, string>>();
  const report = useRead('/ads/performance', [query?.ad_account_id ?? ''], query);
  const data = asRecord(report.data?.data);
  const missing = label(['未回報', 'Not reported']);
  return <section className="detail-block">
    <h3>{label(['投放表現與預算進度', 'Ad performance and budget pacing'])}</h3>
    <form className="fields" onSubmit={event => {
      event.preventDefault();
      const values = new FormData(event.currentTarget);
      setQuery({ ad_account_id: account, from: String(values.get('from')), until: String(values.get('until')),
        campaign_id: String(values.get('campaign_id')).trim() });
    }}>
      <label className="field">{label(['起始日', 'Start date'])}<input name="from" type="date" required /></label>
      <label className="field">{label(['結束日', 'End date'])}<input name="until" type="date" required /></label>
      <label className="field">{label(['活動 ID（選填）', 'Campaign ID (optional)'])}<input name="campaign_id" /></label>
      <button disabled={!account || !report.op}>{label(['查詢表現', 'Read performance'])}</button>
    </form>
    {query && <ReadState read={report} />}
    {report.data && <>
      <dl>
        <dt>{label(['報表時區', 'Report time zone'])}</dt><dd>{stringValue(data.timezone) || '—'}</dd>
        <dt>{label(['統計口徑', 'Reporting basis'])}</dt><dd>{label(['平台原始每日口徑', 'Provider-native daily reporting'])}</dd>
        <dt>{label(['最近觀察時間', 'Latest observation'])}</dt><dd>{stringValue(data.as_of) || missing}</dd>
      </dl>
      <table><thead><tr>
        <th>{label(['實際支出（最小貨幣單位）', 'Actual spend (minor units)'])}</th>
        <th>{label(['活動預算（最小貨幣單位）', 'Campaign budget (minor units)'])}</th>
        <th>{label(['預算進度（已回報支出 ÷ 預算）', 'Budget pacing (reported spend ÷ budget)'])}</th>
        <th>{label(['回報完整度', 'Reporting completeness'])}</th>
      </tr></thead><tbody>{fields(data.pacing).map(row => <tr key={String(row.currency)}>
        <td>{amount(row.actual_spend_minor, row.currency, missing)}</td>
        <td>{amount(row.budget_minor, row.currency, '—')}</td>
        <td>{typeof row.observed_pacing === 'number' ? `${Number((row.observed_pacing * 100).toFixed(2))}%` : '—'}</td>
        <td>{typeof row.coverage_ratio === 'number' && `${Number((row.coverage_ratio * 100).toFixed(2))}% · `}{row.delayed === true ? label(['部分日期未回報', 'Some dates are unreported']) : row.delayed === false ? label(['日期均已回報', 'All dates reported']) : '—'}</td>
      </tr>)}</tbody></table>
      <h4>{label(['指標原始口徑', 'Source metric definitions'])}</h4>
      {fields(data.observations).length === 0 ? <p>{missing}</p> : <table><thead><tr>
        <th>{label(['指標', 'Metric'])}</th><th>{label(['報表日', 'Report day'])}</th>
        <th>{label(['數值', 'Value'])}</th><th>{label(['可用性', 'Availability'])}</th><th>{label(['定義', 'Definition'])}</th>
      </tr></thead><tbody>{fields(data.observations).map(row => <tr key={String(row.id)}>
        <td>{stringValue(row.metric_key)}</td><td>{stringValue(row.native_date)}</td>
        <td>{amount(row.value, row.currency, missing)}</td><td>{stringValue(row.availability)}</td><td>{stringValue(row.definition) || '—'}</td>
      </tr>)}</tbody></table>}
    </>}
  </section>;
}

function AdProposals({ account }: { account: string }) {
  const { label } = useCopy();
  const api = useApi();
  const request = useWorkflowRequest();
  const [proposal, setProposal] = useState('');
  const list = useRead('/ad-proposals', [account], { ad_account_id: account });
  const detail = useRead('/ad-proposals/:id', [proposal]);
  const record = asRecord(detail.data?.data);
  const preview = asRecord(record.preview);
  const revision = fields(record.revisions).find(row => row.id === record.current_revision_id);
  const change = asRecord(revision?.change);
  const actions = fields(record.operations);
  const pausePath = '/ad-proposals/:id/operations';
  const reconcilePath = '/ad-operations/:id/reconcile';
  const budget = asRecord(preview.planned_budget);
  return <section className="detail-block">
    <h3>{label(['投放方案與草稿', 'Ad proposals and drafts'])}</h3>
    {account && <ReadState read={list} />}
    <label className="field">{label(['廣告草稿', 'Ad draft'])}<select value={proposal} onChange={event => setProposal(event.target.value)} disabled={!list.data}>
      <option value="">{label(['選擇提案', 'Select proposal'])}</option>
      {fields(list.data?.data).map(row => <option key={String(row.id)} value={String(row.id)}>{rowTitle(row)}</option>)}
    </select></label>
    {proposal && <ReadState read={detail} />}
    {detail.data && <>
      <dl>
        <dt>{label(['計畫預算（最小貨幣單位）', 'Planned budget (minor units)'])}</dt><dd>{amount(budget.amount_minor, budget.currency, '—')}</dd>
        <dt>{label(['支出上限（最小貨幣單位）', 'Spend cap (minor units)'])}</dt><dd>{amount(budget.cap_minor, budget.currency, '—')}</dd>
        <dt>{label(['實際支出（最小貨幣單位）', 'Actual spend (minor units)'])}</dt><dd>{amount(preview.actual_spend_minor, budget.currency, label(['未回報', 'Not reported']))}</dd>
      </dl>
      <h4>{label(['估算值', 'Estimates'])}</h4>
      {fields(preview.estimates).length ? <ul>{fields(preview.estimates).map((row, index) => <li key={index}>{stringValue(row.metric)} · {stringValue(row.value)} · {stringValue(row.source)}</li>)}</ul> : <p>—</p>}
      {fields(preview.unsupported_fields).length > 0 && <fieldset disabled>
        <legend>{label(['平台不支援的設定', 'Unsupported platform settings'])}</legend>
        {fields(preview.unsupported_fields).map((row, index) => <label className="field" key={index}>{stringValue(row.field)}<input value={typeof row.value === 'string' ? row.value : JSON.stringify(row.value) ?? ''} readOnly /></label>)}
      </fieldset>}
      {change.kind === 'pause' && ['approved', 'exported'].includes(String(record.status)) &&
        !actions.some(row => row.proposal_revision_id === revision?.id) && findOperation(api, 'POST', pausePath) &&
        <button type="button" disabled={request.pending} onClick={() => void request.run('POST', pausePath, [proposal], {
          kind: 'pause', proposal_revision_id: revision?.id,
        }, record)}>{label(['送出已核准的暫停', 'Send approved pause'])}</button>}
      {actions.length > 0 && <section>
        <h4>{label(['平台操作', 'Platform operations'])}</h4>
        <ul>{actions.map(row => <li key={String(row.id)}>
          {row.status === 'accepted' ? label(['平台已接受，等待核實', 'Provider accepted, awaiting verification'])
            : row.status === 'outcome_unknown' ? label(['結果未知，可讀取平台狀態核實', 'Outcome unknown, verify by reading platform status'])
            : row.status === 'verified' && row.verified_state === 'paused' ? label(['已核實暫停', 'Verified paused']) : stringValue(row.status)}
          {typeof row.blocked_reason === 'string' && ` · ${row.blocked_reason}`}
          {['accepted', 'outcome_unknown'].includes(String(row.status)) && findOperation(api, 'POST', reconcilePath) &&
            <button type="button" disabled={request.pending} onClick={() => void request.run('POST', reconcilePath, [String(row.id)], {}, row)}>
              {label(['讀取平台狀態核實', 'Verify platform status'])}</button>}
        </li>)}</ul>
        <button type="button" onClick={() => void detail.refetch()}>{label(['更新操作狀態', 'Refresh operation status'])}</button>
      </section>}
      {request.error !== undefined && <ProblemNotice error={request.error} />}
    </>}
  </section>;
}

const checklist = {
  verify_target_and_evidence: ['核對平台上的廣告目標與報表證據', 'Verify the ad target and reporting evidence in the platform'],
  review_limitations_and_rights: ['核對限制、預算及素材授權', 'Review the limitations, budget and creative rights'],
  approve_draft_before_manual_change: ['先核准草稿，再到平台手動執行', 'Approve the draft before applying the change manually'],
  record_platform_readback: ['讀回並記錄平台結果', 'Read back and record the platform result'],
} as const;
const limitations = {
  insufficient_sample: ['樣本數不足', 'Insufficient sample size'], inventory: ['未確認庫存', 'Inventory unconfirmed'],
  rights: ['未確認授權', 'Rights unconfirmed'], budget: ['未確認預算', 'Budget unconfirmed'],
  promotion_overlap: ['與促銷重疊', 'Concurrent promotion'],
} as const;

export function AdAdjustment({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const checks = asRecord(record.checks);
  const refs = Array.isArray(record.evidence_refs) ? record.evidence_refs : [];
  const evidence = fields(record.evidence);
  const limits = Array.isArray(record.limitations) ? record.limitations : [];
  const steps = Array.isArray(record.manual_checklist) ? record.manual_checklist : [];
  return <section className="detail-block">
    <h3>{label(['建議依據', 'Adjustment evidence'])}</h3>
    <p>{stringValue(record.rationale)}</p>
    <ul>{refs.map(id => {
      const row = evidence.find(value => value.id === id);
      return <li key={String(id)}><code>{String(id)}</code>{row ? ` · ${stringValue(row.metric_key)} · ${amount(row.value, row.currency, '—')} · ${stringValue(row.native_date)} ${stringValue(row.timezone)} · ${stringValue(row.definition)}` : ` · ${label(['證據目前不可用', 'Evidence is currently unavailable'])}`}</li>;
    })}</ul>
    <h3>{label(['限制', 'Limitations'])}</h3>
    <p>{label(['樣本／最低要求', 'Sample size / minimum'])} {stringValue(checks.sample_size)} / {stringValue(checks.minimum_sample_size)}</p>
    <ul>{limits.map(value => <li key={String(value)}>{Object.hasOwn(limitations, String(value)) ? label(limitations[value as keyof typeof limitations]) : String(value)}</li>)}</ul>
    {record.execution_mode === 'manual' && <>
      <h3>{label(['手動操作清單', 'Manual checklist'])}</h3>
      <p>{label(['平台寫入介面不可用。採納建議只建立草稿。', 'Platform writes are unavailable. Accepting a suggestion creates a draft only.'])}</p>
      <ol>{steps.flatMap(value => Object.hasOwn(checklist, String(value)) ? [<li key={String(value)}>{label(checklist[value as keyof typeof checklist])}</li>] : [])}</ol>
    </>}
  </section>;
}

export function AdsWorkspaceReads() {
  const { label } = useCopy();
  const api = useApi();
  const [account, setAccount] = useState('');
  const [selection, setSelection] = useState<Selection>();
  const list = useRead('/ad-accounts');
  const selected = fields(list.data?.data).find(row => row.id === account);
  const edit = findOperation(api, 'PATCH', '/ad-accounts/:id');
  return <Panel><div className="detail-block"><label className="field">{label(['分析用廣告帳號', 'Ad account for reporting'])}<select value={account} onChange={event => setAccount(event.target.value)} disabled={!list.data}>
    <option value="">{label(['選擇廣告帳號', 'Select ad account'])}</option>
    {fields(list.data?.data).map(row => <option key={String(row.id)} value={String(row.id)}>{stringValue(row.external_account_id) || rowTitle(row)}</option>)}
  </select></label></div>
    <ReadState read={list} />
    {selected && edit && <button type="button" onClick={() => setSelection({ op: edit, ids: [account], record: selected, action: {
      path: '/ad-accounts/:id', method: 'PATCH', label: ['編輯帳號授權', 'Edit account permissions'], versioned: true,
      fields: [{ key: 'permissions', type: 'array', label: ['操作人授權（actor_id、actions）', 'Actor grants (actor_id, actions)'] }],
    } })}>{label(['編輯帳號授權', 'Edit account permissions'])}</button>}
    {selection && <OperationForm selection={selection} onClose={() => setSelection(undefined)} follow={() => {}} />}
    <AdPerformance key={`performance:${account}`} account={account} />
    <AdProposals key={`proposals:${account}`} account={account} />
  </Panel>;
}
