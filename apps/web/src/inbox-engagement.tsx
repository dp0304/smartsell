import type { RecordData } from '@smartsell/sdk';
import { entity, findOperation, ReadState, recordRows, stringValue, useApi, useRead } from './api';
import { text, type Action } from './actions';
import { useCopy } from './i18n';

type Open = (path: string, action: Action, ids?: string[], record?: RecordData, seed?: RecordData) => void;
const linkPath = '/inbox/participants/:id/link-customer';
const moderationPath = '/conversations/:id/moderation';
const area = (key: string, zh: string, en: string) => ({ ...text(key, zh, en), type: 'textarea' as const });
const url = (key: string, zh: string, en: string) => ({ ...text(key, zh, en), type: 'url' as const });

function Source({ value }: { value: unknown }) {
  const { label } = useCopy();
  const href = stringValue(value);
  if (!/^https?:\/\//i.test(href)) return null;
  return <a href={href} target="_blank" rel="noopener noreferrer">{label(['在平台查看原文', 'View original on platform'])}</a>;
}

function CustomerLink({ id, open }: { id: string; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  const read = useRead('/conversations/:id/customer-link', [id]);
  if (!read.op) return null;
  const result = entity(read.data?.data);
  const participant = entity(result.participant);
  const customer = entity(result.customer);
  const participantId = stringValue(participant.id);
  const linked = Boolean(participant.customer_identity_id);
  const method = linked ? 'DELETE' : 'POST';
  const action: Action = linked ? {
    method, path: linkPath, label: ['撤銷客戶關聯', 'Undo customer link'],
    fields: [area('reason', '撤銷原因', 'Reason for undoing')], versioned: true, confirm: true,
  } : {
    path: linkPath, label: ['確認客戶關聯', 'Confirm customer link'], versioned: true, confirm: true,
    fields: [text('customer_identity_id', '客戶身分 ID（見客戶檔案）', 'Identity ID from the customer profile'), area('manual_confirmation', '真人核對依據（例如客戶確認跨渠道身分）', 'Verification basis (for example, customer confirmed both channels)')],
  };
  return <section className="message"><h3>{label(['跨渠道客戶關聯', 'Cross-channel customer link'])}</h3><ReadState read={read} />
    {read.data && (!participantId ? <p>{label(['此對話沒有可關聯的參與者。', 'No participant is available to link.'])}</p> : <>
      <p>{stringValue(participant.display_name) || participantId} · {linked ? label(['已關聯', 'Linked']) : label(['未關聯。相同暱稱不會自動配對。', 'Unlinked. Matching nicknames never link automatically.'])}</p>
      {customer.id && <p>{label(['客戶', 'Customer'])} <a href={`/w/${encodeURIComponent(api.ws)}/lifecycle?tab=customers&id=${encodeURIComponent(stringValue(customer.id))}`}>{stringValue(customer.id)}</a></p>}
      {findOperation(api, method, linkPath) && <button onClick={() => open(linkPath, action, [participantId], participant)}>{label(action.label)}</button>}
      {Boolean(recordRows(result.history)?.length) && <ul>{recordRows(result.history)!.map(row => <li key={stringValue(row.id)}>{row.customer_identity_id ? label(['關聯', 'Linked']) : label(['撤銷', 'Unlinked'])} · {stringValue(row.created_at)} · {stringValue(row.actor_id)} · {stringValue(row.manual_confirmation ?? row.reason ?? row.evidence_id)}</li>)}</ul>}
    </>)}
  </section>;
}

function Moderation({ id, record, open }: { id: string; record: RecordData; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  const read = useRead(moderationPath, [id]);
  if (!read.op) return null;
  const result = entity(read.data?.data);
  const source = stringValue(result.source_url);
  const canRecord = findOperation(api, 'POST', moderationPath);
  const messages = (recordRows(record.messages) ?? []).filter(message => message.direction === 'inbound' && message.visibility === 'public');
  return <section className="message"><h3>{label(['評論管理', 'Comment moderation'])}</h3><ReadState read={read} />
    {result.mode === 'manual_only' && <>
      <p>{label(['請在平台處置評論。工作台只記錄人工處置結果。', 'Moderate on the platform. The workspace records the outcome.'])}</p><Source value={source} />
      {canRecord && messages.map(message => {
        const action: Action = { path: moderationPath, label: ['記錄已完成的人工處置', 'Record completed manual moderation'], confirm: true,
          fields: [{ ...text('action', '平台上已採取的動作', 'Action taken on platform'), type: 'select', options: ['hide', 'delete', 'block'] }, url('source_url', '平台原文連結', 'Original platform URL'), area('reason', '處置原因', 'Reason')],
          body: values => ({ ...values, message_id: message.id, confirmed_on_platform: true }),
        };
        return <p key={stringValue(message.id)}><button onClick={() => open(moderationPath, action, [id], record, { source_url: source })}>{label(action.label)}</button> <span>{stringValue(entity(message.untrusted_content).body_text).slice(0, 80)}</span></p>;
      })}
      {(recordRows(result.actions) ?? []).map(row => {
        const path = `${moderationPath}/readback`;
        const action: Action = { path, label: ['核對平台狀態', 'Verify platform state'], fields: [], body: () => ({ moderation_action_id: row.id }) };
        return <article key={stringValue(row.id)}><strong>{stringValue(row.action)} · {stringValue(row.actor_id)}</strong>
          <p>{stringValue(row.original_text)}</p><small>{stringValue(row.created_at)} · {stringValue(row.reason)}</small>
          {Boolean(row.latest_readback_status) && <p role="status">{row.latest_readback_status === 'verified' ? label(['已核實', 'Verified']) : label(['待核實', 'Unconfirmed'])}</p>}
          {result.local_readback === true && findOperation(api, 'POST', path) && <button onClick={() => open(path, action, [id], record)}>{label(action.label)}</button>}
        </article>;
      })}
    </>}
  </section>;
}

export function InboxSlaSample() {
  const { label } = useCopy();
  const read = useRead('/inbox/sla-sample');
  if (!read.op) return null;
  const sample = entity(read.data?.data);
  return <section className="message"><h3>{label(['服務時限樣本', 'Service deadline sample'])}</h3><ReadState read={read} />
    {read.data && <dl>
      <dt>{label(['已套用政策的對話', 'Conversations with a policy'])}</dt><dd>{stringValue(sample.sample_count)}</dd>
      <dt>{label(['無政策的對話', 'Conversations without a policy'])}</dt><dd>{stringValue(sample.without_policy_count)}</dd>
      <dt>{label(['已首次回覆／已解決', 'First response recorded / Resolved'])}</dt><dd>{stringValue(sample.first_response_count)} / {stringValue(sample.resolution_count)}</dd>
      <dt>{label(['政策暫停排除時間（秒）', 'Time excluded by policy pauses (seconds)'])}</dt><dd>{stringValue(sample.policy_pause_seconds)}</dd>
    </dl>}
  </section>;
}

export function InboxCoverage({ value }: { value: unknown }) {
  const { label } = useCopy();
  const data = entity(value);
  const accounts = new Map((recordRows(data.accounts) ?? []).map(row => [row.id, row]));
  const capabilities = recordRows(data.capabilities) ?? [];
  const statuses: Record<string, readonly [string, string]> = {
    available: ['可用', 'Available'], read_only: ['僅供讀取', 'Read only'],
    needs_authorization: ['無權限', 'No permission'], no_permission: ['無權限', 'No permission'],
    unsupported: ['API 不支援', 'API unsupported'], unverified: ['未驗證', 'Unverified'],
  };
  const names: Record<string, readonly [string, string]> = { 'comment.read': ['讀取評論', 'Read comments'], 'dm.read': ['讀取私訊', 'Read direct messages'] };
  return capabilities.length ? <ul>{capabilities.map((row, index) => {
    const account = accounts.get(row.social_account_id);
    const capability = stringValue(row.capability);
    const status = stringValue(row.status);
    const mobileEvaluation = account?.provider === 'xiaohongshu' && capability === 'comment.read' && status === 'unsupported';
    return <li className="message" key={`${stringValue(row.social_account_id)}-${capability}-${index}`}>
      <strong>{stringValue(account?.display_name ?? row.social_account_id)} · {names[capability] ? label(names[capability]) : capability}</strong>
      <p>{statuses[status] ? label(statuses[status]) : status || label(['未知', 'Unknown'])}{mobileEvaluation && label(['；P1 評估手機路徑', '; mobile route pending P1 evaluation'])}</p>
    </li>;
  })}</ul> : <p>{label(['尚無已知的渠道覆蓋。', 'No channel coverage is known yet.'])}</p>;
}

export function InboxRuleRuns({ id }: { id: string }) {
  const { label } = useCopy();
  const read = useRead('/inbox/auto-rules/:id/runs', [id]);
  if (!read.op) return null;
  const runs = recordRows(read.data?.data) ?? [];
  const outcomes: Record<string, readonly [string, string]> = {
    drafted: ['已產生草稿', 'Draft created'], skipped_occupied: ['已略過：人工處理中', 'Skipped: operator held the conversation'],
    skipped_replied: ['已略過：已有回覆或待核實', 'Skipped: already replied or awaiting verification'],
    skipped_unavailable: ['已略過：訊息或對話不可用', 'Skipped: message or conversation unavailable'],
    skipped_frequency: ['已略過：達到頻率上限', 'Skipped: frequency limit'],
    skipped_window: ['已略過：不在處理時間內', 'Skipped: outside the processing window'],
    skipped_capability: ['已略過：渠道能力不可用', 'Skipped: channel capability unavailable'],
  };
  return <section className="detail-block"><h3>{label(['規則執行紀錄', 'Rule run history'])}</h3><ReadState read={read} />
    {read.data && (runs.length ? <ul>{runs.map(row => <li key={stringValue(row.id)}>
      {label(outcomes[stringValue(row.outcome)] ?? ['未知結果', 'Unknown outcome'])} · {stringValue(row.message_id)} · {stringValue(row.created_at)}
    </li>)}</ul> : <p>{label(['尚無執行紀錄。', 'No rule runs yet.'])}</p>)}
  </section>;
}

export function CustomerIdentities({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const identities = recordRows(record.identities) ?? [];
  return <section className="message"><h3>{label(['渠道身分', 'Channel identities'])}</h3>
    {identities.length ? <ul>{identities.map(identity => <li key={stringValue(identity.id)}><code>{stringValue(identity.id)}</code> · {stringValue(identity.kind)} · {identity.verified ? label(['已核實', 'Verified']) : label(['待核實', 'Unverified'])}</li>)}</ul> : <p>{label(['尚無渠道身分。', 'No channel identities.'])}</p>}
  </section>;
}

export function InboxEngagement({ id, record, open }: { id: string; record: RecordData; open: Open }) {
  const { label } = useCopy();
  const notes = recordRows(record.notes) ?? [];
  return <>
    <section className="message"><h3>{label(['內部備註', 'Internal notes'])}</h3>
      {notes.length ? notes.map(note => <article key={stringValue(note.id)}><p>{stringValue(note.body)}</p><small>{stringValue(note.created_by)} · {stringValue(note.created_at)}</small></article>) : <p>{label(['尚無內部備註。', 'No internal notes.'])}</p>}
    </section>
    <CustomerLink id={id} open={open} />
    {['comment_thread', 'ad_comment'].includes(stringValue(record.kind)) && <Moderation id={id} record={record} open={open} />}
  </>;
}

const importReview: Action = {
  path: '/inbox/review-sources/:id/import', label: ['匯入公開評價', 'Import public review'],
  fields: [text('external_review_id', '平台評價 ID', 'Platform review ID'), url('source_url', '原評價網址', 'Original review URL'), text('rating', '評分', 'Rating'), text('scale_max', '滿分', 'Maximum rating')],
  body: values => ({ ...values, rating: Number(values.rating), scale_max: Number(values.scale_max) }),
};

export function ReviewSourceDetails({ id, record, open }: { id: string; record: RecordData; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  return <section className="message"><Source value={record.source_url} />
    {findOperation(api, 'POST', importReview.path) && <p><button onClick={() => open(importReview.path, importReview, [id], record)}>{label(importReview.label)}</button></p>}
  </section>;
}

export function ReviewDetails({ id, record, open }: { id: string; record: RecordData; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  const handoff: Action = { path: '/reviews/:id/handoff', label: ['指派人工跟進', 'Assign manual follow-up'], versioned: true,
    fields: [{ ...text('assignee_user_id', '接手成員', 'Assignee'), type: 'ref', lookup: '/members' }],
  };
  const verify: Action = { path: '/reviews/:id/verify-reply', label: ['記錄平台已回覆', 'Record observed platform reply'], versioned: true, confirm: true,
    fields: [url('reply_url', '平台回覆網址', 'Platform reply URL'), area('evidence_note', '人工核對依據', 'Manual verification evidence')],
  };
  const action = record.status === 'open' ? handoff : record.status === 'handed_off' ? verify : null;
  return <section className="message">
    <p>{label(['評分', 'Rating'])} {stringValue(record.rating)} / {stringValue(record.scale_max)} · {stringValue(record.status)}</p>
    <p>{label(['唯讀評價。請在原平台處理回覆。', 'Read-only review. Manage replies on the originating platform.'])}</p>
    <Source value={record.source_url} />
    {action && findOperation(api, 'POST', action.path) && <p><button onClick={() => open(action.path, action, [id], record)}>{label(action.label)}</button></p>}
    {(recordRows(record.verification_history) ?? []).map(row => <p key={stringValue(row.id)}>{stringValue(row.observed_at)} · {stringValue(row.actor_id)} · {stringValue(row.evidence_note)}</p>)}
  </section>;
}
