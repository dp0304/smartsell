import type { Label } from './modules';
import type { RecordData } from '@smartsell/sdk';
import { entity, findOperation, ReadState, recordRows, stringValue, useApi, useRead } from './api';
import { text, type Action } from './actions';
import { useCopy } from './i18n';

type Open = (path: string, action: Action, ids?: string[], record?: RecordData, seed?: RecordData) => void;
const linkPath = '/inbox/participants/:id/link-customer';
const moderationPath = '/conversations/:id/moderation';
const area = (key: string, label: Label) => ({ ...text(key, label), type: 'textarea' as const });
const url = (key: string, label: Label) => ({ ...text(key, label), type: 'url' as const });

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
    method, path: linkPath, label: ['撤銷客戶關聯', 'Undo customer link', '撤销客户关联'],
    fields: [area('reason', ['撤銷原因', 'Reason for undoing', '撤销原因'])], versioned: true, confirm: true,
  } : {
    path: linkPath, label: ['確認客戶關聯', 'Confirm customer link', '确认客户关联'], versioned: true, confirm: true,
    fields: [text('customer_identity_id', ['客戶身分 ID（見客戶檔案）', 'Identity ID from the customer profile', '客户身分 ID（见客户文件）']), area('manual_confirmation', ['真人核對依據（例如客戶確認跨渠道身分）', 'Verification basis (for example, customer confirmed both channels)', '真人核对依据（例如客户确认跨渠道身分）'])],
  };
  return <section className="message"><h3>{label(['跨渠道客戶關聯', 'Cross-channel customer link', '跨渠道客户关联'])}</h3><ReadState read={read} />
    {read.data && (!participantId ? <p>{label(['此對話沒有可關聯的參與者。', 'No participant is available to link.', '此对话没有可关联的参与者。'])}</p> : <>
      <p>{stringValue(participant.display_name) || participantId} · {linked ? label(['已關聯', 'Linked', '已关联']) : label(['未關聯。相同暱稱不會自動配對。', 'Unlinked. Matching nicknames never link automatically.', '未关联。相同暱称不会自动配对。'])}</p>
      {customer.id && <p>{label(['客戶', 'Customer', '客户'])} <a href={`/w/${encodeURIComponent(api.ws)}/lifecycle?tab=customers&id=${encodeURIComponent(stringValue(customer.id))}`}>{stringValue(customer.id)}</a></p>}
      {findOperation(api, method, linkPath) && <button onClick={() => open(linkPath, action, [participantId], participant)}>{label(action.label)}</button>}
      {Boolean(recordRows(result.history)?.length) && <ul>{recordRows(result.history)!.map(row => <li key={stringValue(row.id)}>{row.customer_identity_id ? label(['關聯', 'Linked', '关联']) : label(['撤銷', 'Unlinked', '撤销'])} · {stringValue(row.created_at)} · {stringValue(row.actor_id)} · {stringValue(row.manual_confirmation ?? row.reason ?? row.evidence_id)}</li>)}</ul>}
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
  return <section className="message"><h3>{label(['評論管理', 'Comment moderation', '评论管理'])}</h3><ReadState read={read} />
    {result.mode === 'manual_only' && <>
      <p>{label(['請在平台處置評論。工作台只記錄人工處置結果。', 'Moderate on the platform. The workspace records the outcome.', '请在平台处置评论。工作台只记录人工处置结果。'])}</p><Source value={source} />
      {canRecord && messages.map(message => {
        const action: Action = { path: moderationPath, label: ['記錄已完成的人工處置', 'Record completed manual moderation', '记录已完成的人工处置'], confirm: true,
          fields: [{ ...text('action', ['平台上已採取的動作', 'Action taken on platform', '平台上已采取的动作']), type: 'select', options: ['hide', 'delete', 'block'] }, url('source_url', ['平台原文連結', 'Original platform URL', '平台原文链接']), area('reason', ['處置原因', 'Reason', '处置原因'])],
          body: values => ({ ...values, message_id: message.id, confirmed_on_platform: true }),
        };
        return <p key={stringValue(message.id)}><button onClick={() => open(moderationPath, action, [id], record, { source_url: source })}>{label(action.label)}</button> <span>{stringValue(entity(message.untrusted_content).body_text).slice(0, 80)}</span></p>;
      })}
      {(recordRows(result.actions) ?? []).map(row => {
        const path = `${moderationPath}/readback`;
        const action: Action = { path, label: ['核對平台狀態', 'Verify platform state', '核对平台状态'], fields: [], body: () => ({ moderation_action_id: row.id }) };
        return <article key={stringValue(row.id)}><strong>{stringValue(row.action)} · {stringValue(row.actor_id)}</strong>
          <p>{stringValue(row.original_text)}</p><small>{stringValue(row.created_at)} · {stringValue(row.reason)}</small>
          {Boolean(row.latest_readback_status) && <p role="status">{row.latest_readback_status === 'verified' ? label(['已核實', 'Verified', '已核实']) : label(['待核實', 'Unconfirmed', '待核实'])}</p>}
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
  return <section className="message"><h3>{label(['服務時限樣本', 'Service deadline sample', '服务时限样本'])}</h3><ReadState read={read} />
    {read.data && <dl>
      <dt>{label(['已套用政策的對話', 'Conversations with a policy', '已套用政策的对话'])}</dt><dd>{stringValue(sample.sample_count)}</dd>
      <dt>{label(['無政策的對話', 'Conversations without a policy', '无政策的对话'])}</dt><dd>{stringValue(sample.without_policy_count)}</dd>
      <dt>{label(['已首次回覆／已解決', 'First response recorded / Resolved', '已首次回复／已解决'])}</dt><dd>{stringValue(sample.first_response_count)} / {stringValue(sample.resolution_count)}</dd>
      <dt>{label(['政策暫停排除時間（秒）', 'Time excluded by policy pauses (seconds)', '政策暂停排除时间（秒）'])}</dt><dd>{stringValue(sample.policy_pause_seconds)}</dd>
    </dl>}
  </section>;
}

export function InboxCoverage({ value }: { value: unknown }) {
  const { label } = useCopy();
  const data = entity(value);
  const accounts = new Map((recordRows(data.accounts) ?? []).map(row => [row.id, row]));
  const capabilities = recordRows(data.capabilities) ?? [];
  const statuses: Record<string, readonly [string, string, string?]> = {
    available: ['可用', 'Available'], read_only: ['僅供讀取', 'Read only', '仅供读取'],
    needs_authorization: ['無權限', 'No permission', '无权限'], no_permission: ['無權限', 'No permission', '无权限'],
    unsupported: ['API 不支援', 'API unsupported', 'API 不支持'], unverified: ['未驗證', 'Unverified', '未验证'],
  };
  const names: Record<string, readonly [string, string, string?]> = { 'comment.read': ['讀取評論', 'Read comments', '读取评论'], 'dm.read': ['讀取私訊', 'Read direct messages', '读取私讯'] };
  return capabilities.length ? <ul>{capabilities.map((row, index) => {
    const account = accounts.get(row.social_account_id);
    const capability = stringValue(row.capability);
    const status = stringValue(row.status);
    const mobileEvaluation = account?.provider === 'xiaohongshu' && capability === 'comment.read' && status === 'unsupported';
    return <li className="message" key={`${stringValue(row.social_account_id)}-${capability}-${index}`}>
      <strong>{stringValue(account?.display_name ?? row.social_account_id)} · {names[capability] ? label(names[capability]) : capability}</strong>
      <p>{statuses[status] ? label(statuses[status]) : status || label(['未知', 'Unknown'])}{mobileEvaluation && label(['；P1 評估手機路徑', '; mobile route pending P1 evaluation', '；P1 评估手机路径'])}</p>
    </li>;
  })}</ul> : <p>{label(['尚無已知的渠道覆蓋。', 'No channel coverage is known yet.', '尚无已知的渠道覆盖。'])}</p>;
}

export function InboxRuleRuns({ id }: { id: string }) {
  const { label } = useCopy();
  const read = useRead('/inbox/auto-rules/:id/runs', [id]);
  if (!read.op) return null;
  const runs = recordRows(read.data?.data) ?? [];
  const outcomes: Record<string, readonly [string, string, string?]> = {
    drafted: ['已產生草稿', 'Draft created', '已产生草稿'], skipped_occupied: ['已略過：人工處理中', 'Skipped: operator held the conversation', '已略过：人工处理中'],
    skipped_replied: ['已略過：已有回覆或待核實', 'Skipped: already replied or awaiting verification', '已略过：已有回复或待核实'],
    skipped_unavailable: ['已略過：訊息或對話不可用', 'Skipped: message or conversation unavailable', '已略过：消息或对话不可用'],
    skipped_frequency: ['已略過：達到頻率上限', 'Skipped: frequency limit', '已略过：达到频率上限'],
    skipped_window: ['已略過：不在處理時間內', 'Skipped: outside the processing window', '已略过：不在处理时间内'],
    skipped_capability: ['已略過：渠道能力不可用', 'Skipped: channel capability unavailable', '已略过：渠道能力不可用'],
  };
  return <section className="detail-block"><h3>{label(['規則執行紀錄', 'Rule run history', '规则运行记录'])}</h3><ReadState read={read} />
    {read.data && (runs.length ? <ul>{runs.map(row => <li key={stringValue(row.id)}>
      {label(outcomes[stringValue(row.outcome)] ?? ['未知結果', 'Unknown outcome', '未知结果'])} · {stringValue(row.message_id)} · {stringValue(row.created_at)}
    </li>)}</ul> : <p>{label(['尚無執行紀錄。', 'No rule runs yet.', '尚无运行记录。'])}</p>)}
  </section>;
}

export function CustomerIdentities({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const identities = recordRows(record.identities) ?? [];
  return <section className="message"><h3>{label(['渠道身分', 'Channel identities'])}</h3>
    {identities.length ? <ul>{identities.map(identity => <li key={stringValue(identity.id)}><code>{stringValue(identity.id)}</code> · {stringValue(identity.kind)} · {identity.verified ? label(['已核實', 'Verified', '已核实']) : label(['待核實', 'Unverified', '待核实'])}</li>)}</ul> : <p>{label(['尚無渠道身分。', 'No channel identities.', '尚无渠道身分。'])}</p>}
  </section>;
}

export function InboxEngagement({ id, record, open }: { id: string; record: RecordData; open: Open }) {
  const { label } = useCopy();
  const notes = recordRows(record.notes) ?? [];
  return <>
    <section className="message"><h3>{label(['內部備註', 'Internal notes', '内部备注'])}</h3>
      {notes.length ? notes.map(note => <article key={stringValue(note.id)}><p>{stringValue(note.body)}</p><small>{stringValue(note.created_by)} · {stringValue(note.created_at)}</small></article>) : <p>{label(['尚無內部備註。', 'No internal notes.', '尚无内部备注。'])}</p>}
    </section>
    <CustomerLink id={id} open={open} />
    {['comment_thread', 'ad_comment'].includes(stringValue(record.kind)) && <Moderation id={id} record={record} open={open} />}
  </>;
}

const importReview: Action = {
  path: '/inbox/review-sources/:id/import', label: ['匯入公開評價', 'Import public review', '导入公开评价'],
  fields: [text('external_review_id', ['平台評價 ID', 'Platform review ID', '平台评价 ID']), url('source_url', ['原評價網址', 'Original review URL', '原评价网址']), text('rating', ['評分', 'Rating', '评分']), text('scale_max', ['滿分', 'Maximum rating', '满分'])],
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
  const handoff: Action = { path: '/reviews/:id/handoff', label: ['指派人工跟進', 'Assign manual follow-up', '指派人工跟进'], versioned: true,
    fields: [{ ...text('assignee_user_id', ['接手成員', 'Assignee', '接手成员']), type: 'ref', lookup: '/members' }],
  };
  const verify: Action = { path: '/reviews/:id/verify-reply', label: ['記錄平台已回覆', 'Record observed platform reply', '记录平台已回复'], versioned: true, confirm: true,
    fields: [url('reply_url', ['平台回覆網址', 'Platform reply URL', '平台回复网址']), area('evidence_note', ['人工核對依據', 'Manual verification evidence', '人工核对依据'])],
  };
  const action = record.status === 'open' ? handoff : record.status === 'handed_off' ? verify : null;
  return <section className="message">
    <p>{label(['評分', 'Rating', '评分'])} {stringValue(record.rating)} / {stringValue(record.scale_max)} · {stringValue(record.status)}</p>
    <p>{label(['唯讀評價。請在原平台處理回覆。', 'Read-only review. Manage replies on the originating platform.', '唯读评价。请在原平台处理回复。'])}</p>
    <Source value={record.source_url} />
    {action && findOperation(api, 'POST', action.path) && <p><button onClick={() => open(action.path, action, [id], record)}>{label(action.label)}</button></p>}
    {(recordRows(record.verification_history) ?? []).map(row => <p key={stringValue(row.id)}>{stringValue(row.observed_at)} · {stringValue(row.actor_id)} · {stringValue(row.evidence_note)}</p>)}
  </section>;
}
