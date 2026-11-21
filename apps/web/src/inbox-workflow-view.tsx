import { useState, type FormEvent } from 'react';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, Panel } from '@smartsell/ui';
import { findOperation, ProblemNotice, ReadState, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { records, safeUrl, Status, Timestamp, useWorkflowRequest } from './workflow-view-ui';

export function InboxThread({ record }: { record: RecordData }) {
  const { t, label } = useCopy();
  const [cursors, setCursors] = useState<string[]>([]);
  const id = stringValue(record.id);
  const after = cursors.at(-1);
  const more = useRead('/conversations/:id', [after ? id : ''], after ? { after } : {});
  const page = after ? asRecord(more.data?.data) : record;
  return <>
    <h3>{t('messages')}</h3>
    {after && <ReadState read={more} />}
    {(!after || more.data) && (records(page.messages).length ? records(page.messages).map((message, index) => <article className="message" key={stringValue(message.id) || index}>
      <b>{stringValue(message.author_name ?? message.sender_display ?? message.direction)}</b>
      <p>{stringValue(asRecord(message.untrusted_content).body_text ?? message.body_text) || '—'}</p>
      {records(message.translations).map(translation => <details key={stringValue(translation.id)}>
        <summary>{label(['查看人工翻譯', 'Show human translation'])} · {stringValue(translation.target_lang)}</summary>
        <p>{stringValue(translation.text)}</p>
      </details>)}
      <small><Timestamp value={message.platform_created_at ?? message.created_at} /></small>
    </article>) : <EmptyState title={t('empty')} />)}
    {(after || page.next_cursor) && <div className="pagination">
      {after && <button onClick={() => setCursors(previous => previous.slice(0, -1))}>{t('previousPeriod')}</button>}
      {typeof page.next_cursor === 'string' && <button onClick={() => setCursors(previous => [...previous, String(page.next_cursor)])}>{t('next')}</button>}
    </div>}
  </>;
}

export function InboxActivity({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const activity = records(record.activity).filter(row => ['assigned', 'status_changed', 'reopened'].includes(stringValue(row.type)))
    .sort((a, b) => stringValue(b.created_at).localeCompare(stringValue(a.created_at)));
  return <section className="detail-block" aria-label={label(['對話活動', 'Conversation activity'])}>
    <h3>{label(['對話活動', 'Conversation activity'])}</h3>
    {activity.length ? <ol>{activity.map(row => {
      const assignment = row.type === 'assigned';
      const value = (entry: unknown) => assignment ? stringValue(entry) || label(['未指派', 'Unassigned']) : <Status value={entry} />;
      return <li className="message" key={stringValue(row.id)}>
        <strong>{assignment ? label(['指派變更', 'Assignment changed']) : label(['狀態變更', 'Status changed'])}</strong>
        <dl>
          <dt>{label(['操作者', 'Actor'])}</dt><dd>{stringValue(row.actor_id) || '—'}</dd>
          <dt>{label(['變更前', 'Before'])}</dt><dd>{value(row.from_value)}</dd>
          <dt>{label(['變更後', 'After'])}</dt><dd>{value(row.to_value)}</dd>
        </dl>
        <Timestamp value={row.created_at} />
      </li>;
    })}</ol> : <p>{label(['尚無指派或狀態變更。', 'No assignment or status changes yet.'])}</p>}
  </section>;
}

export function InboxContext({ record, hasSelection, onOpenDraft }: { record: RecordData; hasSelection: boolean; onOpenDraft: (id: string) => void }) {
  const { t, label } = useCopy();
  const api = useApi();
  const lease = asRecord(record.occupancy);
  const sla = asRecord(record.sla);
  const ownLease = Boolean(api.session.user.id && lease.holder_id === api.session.user.id);
  return <Panel className="context-panel"><div className="panel-head"><h2>{t('context')}</h2></div>
    {!hasSelection ? <EmptyState title={t('selectRecord')} /> : <div className="detail-body">
      <p><Status value={record.status} /> · <Status value={record.priority} /></p>
      <p>{t('platform')} · {stringValue(record.platform ?? record.provider) || '—'}</p>
      <p>{label(['負責人', 'Assignee'])} · {stringValue(record.assignee_user_id) || label(['未指派', 'Unassigned'])}</p>
      {lease.holder_id != null && Date.parse(stringValue(lease.lease_expires_at)) > Date.now() && <p>{ownLease ? label(['你的處理權有效至', 'Your lease expires at']) : label(['其他成員處理中，租約有效至', 'Another operator holds the lease until'])} <Timestamp value={lease.lease_expires_at} /></p>}
      {sla.id != null && <section className="detail-block"><h3>{label(['服務時限', 'Service deadlines'])}</h3>
        <p>{label(['首次回覆', 'First response'])} · <Timestamp value={sla.first_response_due_at} /></p>
        <p>{label(['解決', 'Resolution'])} · <Timestamp value={sla.resolution_due_at} /></p>
      </section>}
      {findOperation(api, 'GET', '/reply-drafts/:id') && records(record.reply_drafts).length > 0 && <section className="detail-block">
        <h3>{label(['回覆草稿', 'Reply drafts'])}</h3>
        <ul>{records(record.reply_drafts).map(draft => <li key={stringValue(draft.id)}>
          <button className="text-button" onClick={() => onOpenDraft(stringValue(draft.id))}>{stringValue(draft.body_text)}</button> · <Status value={draft.status} />
        </li>)}</ul>
      </section>}
      {findOperation(api, 'GET', '/reply-drafts/:id') && <form className="fields" onSubmit={event => {
        event.preventDefault();
        const id = String(new FormData(event.currentTarget).get('draft') ?? '').trim();
        if (id && id !== '.' && id !== '..' && !/[/\\]/.test(id)) onOpenDraft(id);
      }}><label className="field">{label(['回覆草稿 ID', 'Reply draft ID'])}<input name="draft" required /></label><button>{label(['開啟草稿', 'Open draft'])}</button></form>}
    </div>}
  </Panel>;
}

export function InboxDraft({ draft, conversation, onSubmitted }: { draft: RecordData; conversation: RecordData; onSubmitted: (id: string) => void }) {
  const { t, label } = useCopy();
  const api = useApi();
  const request = useWorkflowRequest();
  const [intent, setIntent] = useState<'submit-approval' | 'approve' | 'send'>();
  const lease = asRecord(conversation.occupancy);
  const canSend = Boolean(api.session.user.id && lease.holder_id === api.session.user.id && lease.purpose === 'reply' &&
    Date.parse(stringValue(lease.lease_expires_at)) > Date.now() && Number.isSafeInteger(lease.fencing_token) &&
    draft.based_on_inbound_revision === conversation.inbound_revision && conversation.status !== 'resolved');
  const path = '/reply-drafts/:id';
  const next = draft.status === 'editing' ? 'submit-approval' : draft.status === 'pending_approval' ? 'approve' : draft.status === 'approved' ? 'send' : undefined;
  const copy = { 'submit-approval': ['提交回覆審批', 'Submit reply for approval'], approve: ['核准回覆', 'Approve reply'], send: ['準備人工回覆', 'Stage manual reply'] } as const;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!intent || intent !== next || (intent === 'send' && !canSend)) return;
    const data = await request.run('POST', `${path}/${intent}`, [stringValue(draft.id)], intent === 'send' ? { fencing_token: lease.fencing_token, mode: 'manual' } : {}, draft);
    if (data) {
      setIntent(undefined);
      if (intent === 'send' && data.id) onSubmitted(stringValue(data.id));
    }
  }
  if (draft.conversation_id !== conversation.id) return <p role="alert" className="problem">{label(['這份草稿不屬於此對話。', 'This draft belongs to a different conversation.'])}</p>;
  return <section className="detail-block"><h3>{label(['回覆草稿', 'Reply draft'])} · <Status value={draft.status} /></h3>
    <article className="message"><p>{stringValue(draft.body_text)}</p></article>
    {next && findOperation(api, 'POST', `${path}/${next}`) && (next === 'send' && !canSend ? <p className="notice">{label(['回到對話取得回覆處理權，並確認草稿仍適用於最新訊息。', 'Return to the conversation to acquire a reply lease and check that the draft still matches the latest message.'])}</p> :
      intent === next ? <form className="fields" onSubmit={submit}><fieldset disabled={request.pending}><label className="check"><input type="checkbox" required />{t('confirmAction')}</label><div className="action-row"><button className="primary" type="submit">{request.pending ? t('saving') : label(copy[next])}</button><button type="button" onClick={() => setIntent(undefined)}>{t('cancel')}</button></div></fieldset></form> : <button className="primary" onClick={() => setIntent(next)}>{label(copy[next])}</button>)}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </section>;
}

export function InboxDelivery({ delivery, conversation }: { delivery: RecordData; conversation: RecordData }) {
  const { t, label } = useCopy();
  const api = useApi();
  const request = useWorkflowRequest();
  const reply = asRecord(delivery.reply ?? delivery);
  const lease = asRecord(conversation.occupancy);
  const path = '/outbound-replies/:id';
  const uncertain = ['accepted', 'outcome_unknown'].includes(stringValue(reply.status));
  const canReconcile = (uncertain || reply.status === 'manual') && Number(reply.current_attempt_no) > 0 && findOperation(api, 'POST', `${path}/reconcile`);
  const canRecord = ['manual', 'accepted', 'outcome_unknown', 'failed', 'retryable'].includes(stringValue(reply.status)) && findOperation(api, 'POST', `${path}/manual-complete`);
  const ownLease = Boolean(api.session.user.id && lease.holder_id === api.session.user.id && lease.purpose === 'reply' && Date.parse(stringValue(lease.lease_expires_at)) > Date.now());
  const draft = useRead('/reply-drafts/:id', [reply.conversation_id === conversation.id ? stringValue(reply.reply_draft_id) : '']);
  async function recordDelivery(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const url = safeUrl(new FormData(event.currentTarget).get('link'));
    if (url && ownLease) await request.run('POST', `${path}/manual-complete`, [stringValue(reply.id)], { platform_url: url, fencing_token: lease.fencing_token }, reply);
  }
  if (reply.conversation_id !== conversation.id) return <p className="problem" role="alert">{label(['此回覆不屬於這個對話。', 'This delivery belongs to a different conversation.'])}</p>;
  return <section className="detail-block"><h3>{label(['回覆傳送狀態', 'Delivery status'])} · <Status value={reply.status} /></h3>
    {reply.status === 'manual' && <>
      <p>{label(['在正確的平台帳號人工回覆，再用平台連結登記送達。', 'Reply from the correct platform account, then record the delivery with its platform link.'])}</p>
      {draft.data && <article className="message"><p>{stringValue(asRecord(draft.data.data).body_text)}</p></article>}
    </>}
    {uncertain && <p className="notice">{label(['先核實傳送結果，以免重複回覆。', 'Verify delivery before attempting another reply.'])}</p>}
    {canReconcile && <button disabled={request.pending} onClick={() => void request.run('POST', `${path}/reconcile`, [stringValue(reply.id)], {})}>{label(['核實送達狀態', 'Verify delivery'])}</button>}
    {canRecord && (ownLease ? <details><summary>{label(['登記已確認的送達', 'Record confirmed delivery'])}</summary><form className="fields" onSubmit={recordDelivery}>
      <fieldset disabled={request.pending}>
        <label className="field">{label(['平台回覆連結', 'Platform reply link'])}<input name="link" type="url" pattern="https?://.+" required /></label>
        <label className="check"><input type="checkbox" required />{label(['我已在平台核實此回覆。', 'I verified this reply on the platform.'])}</label>
        <button type="submit">{request.pending ? t('saving') : t('save')}</button>
      </fieldset>
    </form></details> : <p>{label(['登記送達前，請先取得回覆處理權。', 'Acquire a reply lease to record delivery.'])}</p>)}
    {records(delivery.attempts).map(attempt => <p key={stringValue(attempt.id)}><Status value={attempt.outcome} /> · <Timestamp value={attempt.finished_at ?? attempt.started_at} /></p>)}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </section>;
}
