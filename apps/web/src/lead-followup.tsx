import type { RecordData } from '@smartsell/sdk';
import { findOperation, recordRows, stringValue, useApi } from './api';
import { text, type Action } from './actions';
import { useCopy } from './i18n';

const path = '/leads/:id';
const channel = { ...text('channel', ['渠道', 'Channel']), type: 'select' as const, options: ['email', 'sms', 'whatsapp'] };
const outcome = { ...text('outcome', ['跟進結果', 'Follow-up outcome', '跟进结果']), type: 'textarea' as const };
const receipt: Action = { path: `${path}/handoff/receipt`, label: ['記錄 CRM 核對結果', 'Record CRM readback', '记录 CRM 核对结果'], versioned: true, fields: [
  { ...text('outcome', ['回執結果', 'Receipt outcome', '回执结果']), type: 'select', options: ['unknown', 'confirmed', 'failed'] },
  text('evidence_ref', ['回執證據', 'Receipt evidence', '回执证据']), { ...text('external_ref', ['CRM 參考編號', 'CRM reference', 'CRM 参考编号']), optional: true },
] };
const steps: Record<string, Action> = {
  contact_permitted: { path, method: 'PATCH', label: ['記錄已聯絡', 'Record contact', '记录已联系'], fields: [channel, { ...text('purpose', ['聯絡用途', 'Contact purpose', '联系用途']), type: 'select', options: ['service', 'marketing'] }, outcome], body: values => ({ ...values, status: 'contacted' }) },
  contacted: { path, method: 'PATCH', label: ['標記已確認需求', 'Qualify lead', '标记已确认需求'], fields: [outcome], body: values => ({ ...values, status: 'qualified' }) },
  qualified: { path: `${path}/handoff`, label: ['申請 CRM 交接', 'Request CRM handoff', '申请 CRM 交接'], fields: [channel, text('destination', ['CRM 目的地', 'CRM destination'])], confirm: true },
  handed_off: { path, method: 'PATCH', label: ['標記成交', 'Mark converted', '标记成交'], fields: [outcome], body: values => ({ ...values, status: 'converted' }) },
};

export function LeadStatus({ value }: { value: unknown }) {
  const { label } = useCopy();
  const names: Record<string, readonly [string, string, string?]> = {
    new: ['待處理', 'Awaiting review', '待处理'], contact_not_permitted: ['尚無聯絡同意', 'Contact consent unavailable', '尚无联系同意'],
    contact_permitted: ['已同意聯絡，待跟進', 'Contact permitted, awaiting follow-up', '已同意联系，待跟进'],
    contacted: ['已聯絡', 'Contacted', '已联系'], qualified: ['已確認需求', 'Qualified', '已确认需求'],
    handed_off: ['CRM 已接收', 'Accepted by CRM'], converted: ['已成交', 'Converted'], closed: ['已關閉', 'Closed', '已关闭'],
  };
  const name = names[stringValue(value)];
  return <span>{name ? label(name) : stringValue(value) || '—'}</span>;
}

export function LeadBoard({ rows, onPick }: { rows: RecordData[]; onPick: (row: RecordData) => void }) {
  const { label, locale } = useCopy();
  const columns = [
    { key: 'pending', title: ['待聯絡', 'Awaiting contact', '待联系'], rows: rows.filter(row => !['closed', 'converted'].includes(stringValue(row.status)) && row.contact_permitted !== true) },
    { key: 'permitted', title: ['同意聯絡', 'Contact permitted', '同意联系'], rows: rows.filter(row => !['closed', 'converted'].includes(stringValue(row.status)) && row.contact_permitted === true) },
    { key: 'converted', title: ['已成交', 'Converted'], rows: rows.filter(row => row.status === 'converted') },
  ] as const;
  const closed = rows.filter(row => row.status === 'closed');
  function leadList(leads: RecordData[]) {
    return leads.length ? <ul>{leads.map(row => <li key={stringValue(row.id)}>
      <button className="text-button table-title" onClick={() => onPick(row)}>{stringValue(row.id)}</button>
      <LeadStatus value={row.status} />
    </li>)}</ul> : <p>{label(['這一欄沒有線索', 'No leads in this column', '这一栏没有线索'])}</p>;
  }
  return <>
    <div className="lead-board" role="region" aria-label={label(['線索收件箱', 'Lead inbox', '线索收件箱'])}>
      {columns.map(column => <section key={column.key} aria-label={label(column.title)}>
        <h3>{label(column.title)} · {new Intl.NumberFormat(locale).format(column.rows.length)}</h3>
        {leadList(column.rows)}
      </section>)}
    </div>
    {closed.length > 0 && <details className="lead-board-closed"><summary>{label(['已關閉', 'Closed', '已关闭'])}</summary>{leadList(closed)}</details>}
  </>;
}

export function LeadFollowup({ record, open }: { record: RecordData; open: (path: string, action: Action, ids: string[], record: RecordData) => void }) {
  const api = useApi();
  const { label } = useCopy();
  const serviceChannels = Array.isArray(record.service_contact_channels) ? record.service_contact_channels.map(stringValue).filter(value => channel.options.includes(value)) : [];
  const handoffPending = record.handoff_status === 'pending' || record.handoff_status === 'unknown';
  const step = record.status === 'qualified'
    ? serviceChannels.length && !handoffPending ? { ...steps.qualified, fields: [{ ...channel, options: serviceChannels }, text('destination', ['CRM 目的地', 'CRM destination'])] } : undefined
    : steps[stringValue(record.status)];
  return <section className="message"><h3>{label(['線索跟進', 'Lead follow-up', '线索跟进'])}</h3>
    <p><LeadStatus value={record.status} /></p>
    <p>{record.contact_permitted === true ? label(['有渠道同意', 'Channel consent available']) : label(['目前沒有有效的渠道同意', 'No active channel consent', '目前没有有效的渠道同意'])}</p>
    {record.status === 'qualified' && !serviceChannels.length && <p>{label(['CRM 交接需有效的服務聯絡同意。', 'CRM handoff requires active service consent.', 'CRM 交接需有效的服务联系同意。'])}</p>}
    {handoffPending && <p role="status">{record.handoff_status === 'unknown'
      ? label(['CRM 結果未知。請先核對回執。', 'CRM result unknown. Verify the receipt first.', 'CRM 结果未知。请先核对回执。'])
      : label(['等待 CRM 回執。', 'Waiting for the CRM receipt.', '等待 CRM 回执。'])}</p>}
    {step && findOperation(api, step.method ?? 'POST', step.path) &&
      <button onClick={() => open(step.path, { ...step, versioned: true }, [stringValue(record.id)], record)}>{label(step.label)}</button>}
    {handoffPending && record.handoff_id && findOperation(api, 'POST', receipt.path) ?
      <button onClick={() => open(receipt.path, { ...receipt, body: values => ({ ...values, handoff_id: record.handoff_id }) }, [stringValue(record.id)], record)}>{label(receipt.label)}</button> : null}
    {handoffPending && record.local_crm_receipt_available === true && !record.local_crm_dispatched_at && findOperation(api, 'POST', `${path}/handoff/local-dispatch`) &&
      <button onClick={() => open(`${path}/handoff/local-dispatch`, { path: `${path}/handoff/local-dispatch`, label: ['送交本機 CRM', 'Dispatch to local CRM', '送交本机 CRM'], fields: [], versioned: true, confirm: true }, [stringValue(record.id)], record)}>{label(['送交本機 CRM', 'Dispatch to local CRM', '送交本机 CRM'])}</button>}
    {handoffPending && record.local_crm_receipt_available === true && findOperation(api, 'POST', receipt.path) &&
      <button onClick={() => open(receipt.path, { ...receipt, label: ['向本機 CRM 核對', 'Check local CRM receipt', '向本机 CRM 核对'], fields: [],
        body: () => ({ handoff_id: record.handoff_id, readback: 'local' }) }, [stringValue(record.id)], record)}>{label(['向本機 CRM 核對', 'Check local CRM receipt', '向本机 CRM 核对'])}</button>}
    {(recordRows(record.handoff_receipts) ?? []).map(entry => <p key={stringValue(entry.id)}>
      <strong>{label(['CRM 回執', 'CRM receipt', 'CRM 回执'])}</strong> · {stringValue(entry.outcome)} · {stringValue(entry.evidence_ref)} · {stringValue(entry.received_at)}
    </p>)}
    {(recordRows(record.activities) ?? []).map(activity => <p key={stringValue(activity.id)}>{stringValue(activity.at)} · {stringValue(activity.type)} · {stringValue(activity.outcome)}</p>)}
  </section>;
}
