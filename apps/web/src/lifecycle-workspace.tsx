import { useState } from 'react';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EntityTable } from '@smartsell/ui';
import { Link } from 'react-router-dom';
import { findOperation, ProblemNotice, ReadState, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { records, Status, Timestamp, useWorkflowRequest } from './workflow-view-ui';

const campaignPath = '/esp-campaigns/:id';
const segmentPath = '/segments/:id';
const rowId = (row: RecordData) => stringValue(row.id);
const value = (input: unknown) => stringValue(input) || '—';

const snapshotTypes = {
  preview: ['受眾預覽', 'Audience preview', '受众预览'],
  schedule_estimate: ['提交時估算', 'Submission estimate', '提交时估算'],
  send_execution: ['ESP 實際發送', 'ESP actual send', 'ESP 实际发送'],
} as const;
const exclusionReasons = {
  opted_out: ['已撤回', 'Withdrawn'], suppressed: ['抑制', 'Suppressed'],
  no_consent: ['未同意', 'No consent'], consent_conflict: ['同意衝突', 'Consent conflict', '同意冲突'], frequency: ['達頻次上限', 'Frequency cap', '达频次上限'],
} as const;
const coverageLabels = {
  imported_esp_reports_only: ['限匯入的 ESP 報表', 'Imported ESP reports only', '限导入的 ESP 报表'],
  no_report_in_period: ['期間內無報表', 'No report in period', '期间内无报表'],
  not_connected: ['未接入，發送及成效無法觀測', 'Not connected · sends and outcomes are unobserved', '未接入，发送及成效无法观测'],
} as const;

export function LifecycleAudience({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const id = rowId(record);
  const read = useRead(`${segmentPath}/snapshots`, [id], {}, 'lifecycle');
  const mutation = useWorkflowRequest();
  const previewPath = `${segmentPath}/preview`;
  return <section className="detail-block">
    <h3>{label(['受眾快照', 'Audience snapshots', '受众快照'])}</h3>
    {findOperation(api, 'POST', previewPath, 'lifecycle') && <button disabled={mutation.pending} onClick={() => void mutation.run('POST', previewPath, [id], {})}>{label(['預覽目前受眾', 'Preview current audience', '预览目前受众'])}</button>}
    {mutation.error != null && <ProblemNotice error={mutation.error} />}
    <ReadState read={read} />
    {read.data && <EntityTable records={records(read.data.data)} rowKey={rowId} columns={[
      { label: label(['紀錄類型', 'Record type', '记录类型']), cell: row => <>
        {label(snapshotTypes[row.purpose as keyof typeof snapshotTypes] ?? [value(row.purpose), value(row.purpose)])}
        {row.action === 'test_send' && <div><small>{label(['測試寄送', 'Test send', '测试寄送'])}</small></div>}
      </> },
      { label: label(['記錄時間', 'Recorded at', '记录时间']), cell: row => <Timestamp value={row.taken_at} /> },
      { label: label(['符合資格', 'Eligible audience', '符合资格']), cell: row => value(row.eligible_count) },
      { label: label(['ESP 發送人數', 'ESP sent audience', 'ESP 发送人数']), cell: row => value(row.esp_count) },
      { label: label(['排除原因', 'Exclusions']), cell: row => Object.entries(asRecord(row.excluded)).map(([key, count]) => {
        const name = exclusionReasons[key as keyof typeof exclusionReasons];
        return `${name ? label(name) : key} ${value(count)}`;
      }).join(' · ') || '—' },
      { label: label(['來源', 'Source', '来源']), cell: row => value(row.source_ref ?? row.audience_coverage) },
      { label: label(['活動', 'Campaign', '活动']), cell: row => row.esp_campaign_ref_id ? <Link to={`/w/${encodeURIComponent(api.ws)}/lifecycle?tab=espCampaigns&id=${encodeURIComponent(value(row.esp_campaign_ref_id))}`}>{label(['查看生命週期活動', 'View lifecycle campaign', '查看生命周期活动'])}</Link> : '—' },
    ]} />}
  </section>;
}

export function LifecycleCampaign({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const id = rowId(record);
  const attempts = useRead(`${campaignPath}/attempts`, [id], {}, 'lifecycle');
  const accounts = useRead('/esp-accounts', [], {}, 'lifecycle');
  const account = records(accounts.data?.data).find(row => row.id === record.esp_account_id);
  const rows = records(attempts.data?.data);
  const mutation = useWorkflowRequest();
  const [submission, setSubmission] = useState<RecordData>();
  const submitPath = `${campaignPath}/local-submit`;
  const cancelPath = `${campaignPath}/local-cancel`;
  const reconcilePath = `${campaignPath}/local-reconcile`;
  const canSubmit = record.status === 'draft' && account?.local_enabled === true && attempts.isSuccess && findOperation(api, 'POST', submitPath, 'lifecycle');
  const canRetry = (action: string) => rows.every(row => row.action !== action || row.status === 'failed');
  async function submit(action: string, testAddress?: string) {
    const result = await mutation.run('POST', submitPath, [id], { action, ...(testAddress && { test_address: testAddress }) }, record);
    setSubmission(result);
  }
  return <section className="detail-block">
    <h3>{label(['活動投遞', 'Campaign delivery', '活动投递'])}</h3>
    <dl>
      <dt>{label(['本地草稿計畫時間', 'Local planned time', '本地草稿计划时间'])}</dt><dd><Timestamp value={record.planned_send_at} /></dd>
      <dt>{label(['活動紀錄狀態', 'Campaign record status', '活动记录状态'])}</dt><dd><Status value={record.status} /></dd>
    </dl>
    {accounts.data && account?.local_enabled !== true && <p>{label(['此渠道未啟用本機 ESP 提交。', 'Local ESP submission is unavailable for this channel.', '此渠道未激活本机 ESP 提交。'])}</p>}
    {canSubmit && <>
      {canRetry('schedule') && <button disabled={mutation.pending} onClick={() => void submit('schedule')}>{label(['提交本機 ESP 排期', 'Submit local ESP schedule', '提交本机 ESP 排期'])}</button>}
      {canRetry('test_send') && <form className="inline-form" onSubmit={event => {
        event.preventDefault();
        void submit('test_send', String(new FormData(event.currentTarget).get('address')).trim().toLowerCase());
      }}><label>{label(['允許的測試地址', 'Allowlisted test address', '允许的测试地址'])} <input type="email" name="address" required /></label>
        <button disabled={mutation.pending}>{label(['提交本機測試寄送', 'Submit local test send', '提交本机测试寄送'])}</button></form>}
    </>}
    {submission?.status === 'blocked' && <p role="status">{label(['沒有符合資格的允許測試地址。', 'No eligible allowlisted test addresses.', '没有符合资格的允许测试地址。'])}</p>}
    {mutation.error != null && <ProblemNotice error={mutation.error} />}
    {attempts.op && <><h4>{label(['ESP 提交與收據紀錄', 'ESP submissions and receipts', 'ESP 提交与收据记录'])}</h4><ReadState read={attempts} /></>}
    {attempts.data && <EntityTable records={rows} rowKey={rowId} columns={[
      { label: label(['提交類型', 'Submission type', '提交类型']), cell: row => row.action === 'test_send' ? label(['測試寄送', 'Test send', '测试寄送']) : label(['排期', 'Schedule']) },
      { label: label(['ESP 讀回狀態', 'ESP readback status', 'ESP 读回状态']), cell: row => <><Status value={row.status} />
        {row.cancel_requested_at != null && !['cancelled', 'sent'].includes(value(row.status)) && <p>{label(['取消待確認', 'Cancellation awaiting confirmation', '取消待确认'])}</p>}
        {row.last_readback_failed_at != null && <p role="status">{label(['最近一次 ESP 查詢失敗', 'Latest ESP readback failed', '最近一次 ESP 查找失败'])}</p>}
      </> },
      { label: label(['ESP 收據', 'ESP receipt', 'ESP 收据']), cell: row => value(row.receipt_ref) },
      { label: label(['ESP 報表送達數', 'Delivered per ESP report', 'ESP 报表送达数']), cell: row => <>{value(row.delivered_count)}{row.delivery_receipt_ref != null && <div><small>{value(row.delivery_receipt_ref)}</small></div>}</> },
      { label: label(['操作', 'Actions']), cell: row => account?.local_enabled === true && <>
        {!['failed', 'cancelled'].includes(value(row.status)) && findOperation(api, 'POST', reconcilePath, 'lifecycle') && <button disabled={mutation.pending} onClick={() => void mutation.run('POST', reconcilePath, [id], { attempt_id: row.id })}>{label(['重查 ESP 收據', 'Check ESP receipt', '重查 ESP 收据'])}</button>}
        {row.action === 'schedule' && ['accepted', 'scheduled'].includes(value(row.status)) && !row.cancel_requested_at && findOperation(api, 'POST', cancelPath, 'lifecycle') && <button disabled={mutation.pending} onClick={() => void mutation.run('POST', cancelPath, [id], { attempt_id: row.id }, record)}>{label(['請求撤回 ESP 排期', 'Request ESP cancellation', '请求撤回 ESP 排期'])}</button>}
      </> },
    ]} />}
  </section>;
}

export function LifecycleFlow({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const accounts = useRead('/esp-accounts', [], {}, 'lifecycle');
  const account = records(accounts.data?.data).find(row => row.id === record.esp_account_id);
  const mutation = useWorkflowRequest();
  const path = '/esp-flows/:id/local-readback';
  const ref = stringValue(record.external_flow_id);
  return <section className="detail-block">
    <h3>{label(['流程狀態', 'Flow state', '流程状态'])}</h3>
    <dl>
      <dt>{label(['本地流程狀態', 'Local flow status', '本地流程状态'])}</dt><dd><Status value={record.status} /></dd>
      <dt>{label(['本地檢閱模式', 'Local review mode', '本地检阅模式'])}</dt><dd><Status value={record.review_mode} /></dd>
      <dt>{label(['ESP 流程狀態', 'ESP flow status', 'ESP 流程状态'])}</dt><dd>{record.provider_status ? <Status value={record.provider_status} /> : label(['尚未讀回', 'Awaiting readback', '尚未读回'])}</dd>
      <dt>{label(['ESP 查詢時間', 'ESP observed at', 'ESP 查找时间'])}</dt><dd><Timestamp value={record.provider_observed_at} /></dd>
    </dl>
    {account?.local_enabled === true && findOperation(api, 'POST', path, 'lifecycle') && <form className="inline-form" onSubmit={event => {
      event.preventDefault();
      const flowRef = ref || String(new FormData(event.currentTarget).get('reference')).trim();
      void mutation.run('POST', path, [rowId(record)], { flow_ref: flowRef });
    }}>
      {ref ? <span>{ref}</span> : <label>{label(['ESP 流程參照', 'ESP flow reference', 'ESP 流程参照'])} <input name="reference" required /></label>}
      <button disabled={mutation.pending}>{label(['讀取 ESP 流程', 'Read ESP flow', '读取 ESP 流程'])}</button>
    </form>}
    {mutation.error != null && <ProblemNotice error={mutation.error} />}
  </section>;
}

export function LifecycleHealth({ data }: { data: unknown }) {
  const { label } = useCopy();
  const health = asRecord(data);
  const metrics = [
    ['sent', '發送', 'Sent', '发送'], ['bounced', '退信', 'Bounces'], ['complained', '投訴', 'Complaints', '投诉'],
    ['unsubscribed', '退訂', 'Unsubscribes', '退订'], ['suppressed_total', '抑制', 'Suppressions'],
    ['opened', '開信', 'Opens', '开信'], ['clicked', '點擊', 'Clicks', '点击'], ['purchased', '購買', 'Purchases', '购买'],
  ] as const;
  return <>
    <h3>{label(['渠道覆蓋', 'Channel coverage', '渠道覆盖'])}</h3>
    <EntityTable records={records(health.channel_coverage)} rowKey={row => value(row.channel)} columns={[
      { label: label(['渠道', 'Channel']), cell: row => value(row.channel) },
      { label: label(['覆蓋限制', 'Coverage limit', '覆盖限制']), cell: row => label(coverageLabels[row.coverage as keyof typeof coverageLabels] ?? [value(row.coverage), value(row.coverage)]) },
    ]} />
    <h3>{label(['ESP 寄送報表', 'ESP delivery reports', 'ESP 寄送报表'])}</h3>
    <EntityTable records={records(health.snapshots)} rowKey={rowId} columns={[
      { label: label(['報表來源', 'Report reference', '报表来源']), cell: row => value(row.source_ref) },
      { label: label(['觀測時間', 'Observed at', '观测时间']), cell: row => <Timestamp value={row.observed_at} /> },
      ...metrics.map(([key, zh, en]) => ({ label: label([zh, en]), cell: (row: RecordData) => value(row[key]) })),
    ]} />
  </>;
}

export function LifecycleConsent({ id }: { id: string }) {
  const { label } = useCopy();
  const read = useRead('/customers/:id/consents', [id], {}, 'lifecycle');
  if (!read.op) return null;
  const marketing = records(asRecord(read.data?.data).states).filter(row => row.purpose === 'marketing');
  return <section className="detail-block">
    <h3>{label(['渠道行銷同意', 'Channel marketing consent', '渠道行销同意'])}</h3><ReadState read={read} />
    {read.data && <EntityTable records={marketing} rowKey={row => value(row.channel)} columns={[
      { label: label(['渠道', 'Channel']), cell: row => value(row.channel) },
      { label: label(['同意狀態', 'Consent status', '同意状态']), cell: row => <Status value={row.state} /> },
    ]} />}
  </section>;
}
