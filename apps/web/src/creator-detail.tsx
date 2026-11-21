import { useState } from 'react';
import { ReadState, recordRows, stringValue, useRead } from './api';
import { useCopy } from './i18n';
import { EntityTable } from '@smartsell/ui';
import { actions } from './catalog';
import { asEntity, useCommandRead, values } from './workbench-data';
import { Empty, Failure, Status, useFormat } from './workbench-ui';
import type { Command, Entity, Payload } from './workbench-api';

export function CreatorAttribution({ id }: { id: string }) {
  const { label } = useCopy();
  const read = useRead('/collaborations/:id/attribution-reconciliation', [id]);
  if (!read.op) return null;
  const rows = recordRows(read.data?.data) ?? [];
  const unknown = label(['未回報', 'Not reported', '未回报']);
  return <section className="detail-block" aria-label={label(['創作者歸因對帳', 'Creator attribution reconciliation', '创作者归因对帐'])}>
    <h3>{label(['創作者歸因對帳', 'Creator attribution reconciliation', '创作者归因对帐'])}</h3>
    <p>{label(['平台觀測以訂單為單位。兩欄分開對帳。', 'Platform observations are order-level. Reconcile the two columns separately.', '平台观测以订单为单位。两栏分开对帐。'])}</p>
    <ReadState read={read} />
    {read.data && <EntityTable records={rows} rowKey={row => stringValue(row.order_id)} columns={[
      { label: label(['訂單', 'Order', '订单']), cell: row => stringValue(row.external_order_id || row.order_id) },
      ...(['ledger_entries', 'order_level_reports'] as const).map((key, index) => ({
        label: index === 0 ? label(['訂單衍生佣金', 'Order-derived commission', '订单衍生佣金']) : label(['平台回報佣金', 'Platform-reported commission', '平台回报佣金']),
        cell: (row: typeof rows[number]) => {
          const entries = recordRows(row[key]);
          return entries?.length ? <ul>{entries.map(entry => <li key={stringValue(entry.id)}>
            {String(row.currency)} {String(entry.commission_minor)} · {stringValue(entry.source_kind)}{entry.observed_at ? ` · ${stringValue(entry.observed_at)}` : ''}
          </li>)}</ul> : unknown;
        },
      })),
    ]} />}
    {read.data && rows.length === 0 && <p>{label(['尚無可對帳的訂單。', 'No orders to reconcile yet.', '尚无可对帐的订单。'])}</p>}
  </section>;
}

export function CreatorAccounts({ accounts, commands, open }: {
  accounts: unknown; commands: Command[]; open: (command: Command, row: Entity) => void;
}) {
  const { locale, date, t } = useFormat();
  const zh = locale.startsWith('zh');
  const rows = values(accounts).flatMap(value => asEntity(value, 'creator', 'creator_account') ?? []);
  const verify = commands.find(command => command.module === 'creator' && command.action === 'creators_verify_account');
  const levels: Record<string, readonly [string, string, string?]> = {
    self_reported: ['自行填報', 'Self-reported', '自行填报'], public_profile: ['公開檔案', 'Public profile', '公开文件'], manually_verified: ['人工核實', 'Manually verified', '人工核实'],
  };
  return <section>
    <h3>{zh ? '平台帳號' : 'Platform accounts'}</h3>
    {rows.length ? <EntityTable records={rows} rowKey={row => row.id} columns={[
      { label: zh ? '帳號' : 'Account', cell: row => `${row.data.provider} · ${row.data.handle ?? row.data.external_account_id}` },
      { label: zh ? '核實狀態' : 'Verification', cell: row => levels[String(row.data.verification_level)]?.[zh ? 0 : 1] ?? '—' },
      { label: zh ? '核實時間' : 'Verified at', cell: row => date(String(row.data.verified_at), true) },
      { label: zh ? '核實記錄' : 'Verification evidence', cell: row => typeof row.data.verification_ref === 'string'
        ? <a href={row.data.verification_ref} target="_blank" rel="noreferrer">{String(row.data.verification_note ?? row.data.verification_ref)}</a> : '—' },
      ...(verify ? [{ label: zh ? '操作' : 'Action', cell: (row: Entity) => <button onClick={() => open(verify, row)}>{zh ? '記錄帳號核實' : 'Record account verification'}</button> }] : []),
    ]} /> : <Empty>{t('ui.empty')}</Empty>}
  </section>;
}

export function CreatorAudience({ profile }: { profile: Entity }) {
  const { locale, date } = useFormat();
  const zh = locale.startsWith('zh');
  const rows = Array.isArray(profile.data.audience_markets) ? profile.data.audience_markets as Payload[] : [];
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
  const source: Record<string, readonly [string, string, string?]> = {
    self_reported: ['創作者自報', 'Self-reported', '创作者自报'], public: ['公開資料', 'Public data', '公开数据'], manual: ['人工記錄', 'Manual record', '人工记录'],
  };
  return <section>
    <h3>{zh ? '受眾市場' : 'Audience markets'}</h3>
    {rows.length ? <EntityTable records={rows} rowKey={row => String(row.market)} columns={[
      { label: zh ? '市場' : 'Market', cell: row => String(row.market) },
      { label: zh ? '佔比' : 'Share', cell: row => percent.format(Number(row.share_bps) / 10_000) },
      { label: zh ? '來源' : 'Source', cell: row => source[String(row.source_kind)]?.[zh ? 0 : 1] ?? '—' },
      { label: zh ? '觀測時間' : 'Observed at', cell: row => date(String(row.observed_at), true) },
    ]} /> : <Empty>{zh ? '尚無受眾觀測資料' : 'No audience observations'}</Empty>}
  </section>;
}

type CreatorPanel = { wid: string; commands: Command[]; open: (command: Command, row: Entity) => void };

export function CreatorProfileRelations({ wid, profile, commands, open }: CreatorPanel & { profile: Entity }) {
  const { locale, date } = useFormat();
  const zh = locale.startsWith('zh');
  const contacts = useCommandRead<Payload[]>(wid, commands, 'creator', 'creators_list_contacts', { creator_id: profile.id });
  const associations = useCommandRead<Payload[]>(wid, commands, 'creator', 'creators_list_associations', { creator_id: profile.id });
  const undo = commands.find(command => command.module === 'creator' && command.action === 'creators_revoke_association');
  const rows = values(associations.data).flatMap(value => asEntity(value, 'creator', 'creator_association') ?? []);
  return <>
    {contacts.permitted && <section><h3>{zh ? '聯絡資料' : 'Creator contacts'}</h3>
      {contacts.isError && <Failure error={contacts.error} retry={() => void contacts.refetch()} />}
      <ul>{(contacts.data ?? []).map((contact) => <li key={String(contact.id)}>{String(contact.channel)} · {String(contact.value)} · {String(contact.source_ref)}</li>)}</ul>
    </section>}
    <section><h3>{zh ? '檔案關聯記錄' : 'Profile association history'}</h3>
      {associations.isError && <Failure error={associations.error} retry={() => void associations.refetch()} />}
      <ul>{rows.map(row => <li key={row.id}>
        {String(row.data.related_display_name)} · {String(row.data.reason)} · {date(row.created_at, true)}
        {row.data.status === 'revoked' ? <p>{zh ? '已撤銷' : 'Undone'} · {String(row.data.revoked_reason)}</p> : undo &&
          <button onClick={() => open(undo, row)}>{zh ? '撤銷檔案關聯' : 'Undo profile association'}</button>}
      </li>)}</ul>
    </section>
  </>;
}

export function CreatorEvaluations({ wid, campaignId, commands, open }: CreatorPanel & { campaignId: string }) {
  const { locale, date, number } = useFormat();
  const zh = locale.startsWith('zh');
  const read = useCommandRead<Payload[]>(wid, commands, 'creator', 'creators_list_evaluations', { campaign_id: campaignId });
  const override = commands.find(command => command.module === 'creator' && command.action === 'creators_override_evaluation');
  const rows = values(read.data).flatMap(value => asEntity(value, 'creator', 'evaluation') ?? []);
  const fields = [
    ['brand_fit', '品牌契合', 'Brand fit'], ['market_fit', '市場契合', 'Market fit', '市场契合'], ['content_quality', '內容品質', 'Content quality', '内容品质'],
    ['audience_evidence', '受眾依據', 'Audience evidence', '受众依据'], ['cost_fit', '費用契合', 'Cost fit', '费用契合'],
  ];
  const score = (value: unknown) => typeof value === 'number' ? number(value) : (zh ? '未知' : 'Unknown');
  const dimensions = (values: Payload | undefined) => <ul>{fields.map(([key, name, english]) => {
    const dimension = values?.[key] as Payload | undefined;
    const refs = Array.isArray(dimension?.evidence_refs) ? dimension.evidence_refs : [];
    return <li key={key}>{zh ? name : english} · {score(dimension?.score)}{refs.length > 0 && ` (${refs.join(', ')})`}</li>;
  })}</ul>;
  if (!read.permitted) return null;
  return <section><h3>{zh ? '創作者評估比較' : 'Creator evaluations'}</h3>
    {read.isError && <Failure error={read.error} retry={() => void read.refetch()} />}
    {rows.map(row => <article key={row.id}>
      <h4>{String(row.data.creator_display_name)}</h4>
      <p>{row.data.ai_generated === true ? (zh ? '代理原始評估' : 'Agent assessment') : (zh ? '人工評估' : 'Human assessment')} · {String(row.data.decision)} · {score(row.data.total)}</p>
      {dimensions(row.data.scores as Payload)}
      {row.data.original != null && <details><summary>{zh ? '原始評分與覆寫記錄' : 'Original scores and override history'}</summary>
        {dimensions((row.data.original as Payload).scores as Payload)}
        <ol>{(values(row.data.overrides) as Payload[]).map((audit) => <li key={String(audit.id)}>
          {String(audit.reason)} · {String(audit.created_by)} · {date(String(audit.overridden_at), true)}
          <p>{String((audit.before as Payload).decision)} ({score((audit.before as Payload).total)}) → {String((audit.after as Payload).decision)} ({score((audit.after as Payload).total)})</p>
        </li>)}</ol>
      </details>}
      {override && <button onClick={() => open(override, row)}>{zh ? '人工覆寫評分' : 'Override evaluation'}</button>}
    </article>)}
  </section>;
}

export function CreatorDeliverables({ wid, deliverables, commands, open }: CreatorPanel & { deliverables: unknown }) {
  const { locale, date } = useFormat();
  const zh = locale.startsWith('zh');
  const [selected, setSelected] = useState<string>();
  const rows = values(deliverables).flatMap(value => asEntity(value, 'creator', 'deliverable') ?? []);
  const read = useCommandRead<Payload>(wid, commands, 'creator', 'deliverables_get', { deliverable_id: selected }, Boolean(selected));
  const current = asEntity(read.data?.deliverable, 'creator', 'deliverable');
  const change = commands.find(command => command.module === 'creator' && command.action === 'deliverables_change_deadline');
  return <section><h3>{zh ? '合作交付' : 'Collaboration deliverables'}</h3>
    <ul>{rows.map(row => <li key={row.id}><button className="wb-text" aria-expanded={selected === row.id} onClick={() => setSelected(row.id)}>{String(row.data.kind)} · {date(String(row.data.due_at), true)}</button></li>)}</ul>
    {read.isError && <Failure error={read.error} retry={() => void read.refetch()} />}
    {current && <>
      {change && !['accepted', 'published_verified'].includes(String(current.data.status)) && <button onClick={() => open(change, current)}>{zh ? '變更交付期限' : 'Change deliverable deadline'}</button>}
      <ol>{(values(read.data?.deadline_changes) as Payload[]).map((audit) => {
        const impact = audit.impact as Payload | null;
        return <li key={String(audit.id)}>
          {date(String(audit.previous_due_at), true)} → {date(String(audit.due_at), true)} · {String(audit.reason)}
          {impact && <p>{zh ? '請檢查發布排期' : 'Review publication schedule'} · {String(impact.publish_target_id)} · {date(String(impact.scheduled_at), true)}
            {impact.deadline_after_schedule === true && (zh ? ' · 新期限晚於發布時間' : ' · New deadline falls after publication')}</p>}
        </li>;
      })}</ol>
    </>}
  </section>;
}

export function CreatorTermsComparison({ revisions }: { revisions: unknown }) {
  const { locale, label } = useFormat();
  const zh = locale.startsWith('zh');
  const rows = values(revisions).flatMap(value => asEntity(value, 'creator', 'collaboration_terms') ?? [])
    .sort((a, b) => Number(b.data.revision_no) - Number(a.data.revision_no));
  const [beforeId, setBeforeId] = useState('');
  const [afterId, setAfterId] = useState('');
  if (rows.length < 2) return null;
  const before = rows.find(row => row.id === beforeId) ?? rows[1];
  const after = rows.find(row => row.id === afterId) ?? rows[0];
  const fields = [
    ['fee', '費用', 'Fee', '费用'], ['commission_rule', '佣金規則', 'Commission rule', '佣金规则'],
    ['deliverable_requirements', '交付要求', 'Deliverable requirements'], ['usage_rights_required', '使用授權', 'Usage rights', '使用授权'],
    ['deadline', '期限', 'Deadline'], ['attachment_ids', '附件', 'Attachments'],
  ];
  const formatValue = (value: unknown) => value == null ? '—' : typeof value === 'object' ? <pre>{JSON.stringify(value, null, 2)}</pre> : String(value);
  const changed = fields.filter(([key]) => JSON.stringify(before.data[key]) !== JSON.stringify(after.data[key]));
  const options = rows.map(row => <option key={row.id} value={row.id}>{`${label('field', 'version')} ${row.data.revision_no} · ${label('state', String(row.data.sign_status))}`}</option>);
  return <section>
    <h3>{zh ? '比對條款修訂' : 'Compare terms revisions'}</h3>
    <div className="wb-inline-actions">
      <label>{zh ? '原版本' : 'Base revision'} <select value={before.id} onChange={event => setBeforeId(event.target.value)}>{options}</select></label>
      <label>{zh ? '比較版本' : 'Comparison revision'} <select value={after.id} onChange={event => setAfterId(event.target.value)}>{options}</select></label>
    </div>
    {changed.length ? <EntityTable records={changed} rowKey={([key]) => key} columns={[
      { label: zh ? '欄位' : 'Field', cell: row => row[zh ? 1 : 2] },
      { label: zh ? '原內容' : 'Base value', cell: ([key]) => formatValue(before.data[key]) },
      { label: zh ? '比較內容' : 'Comparison value', cell: ([key]) => formatValue(after.data[key]) },
    ]} /> : <Empty>{zh ? '條款內容相同' : 'The terms are identical'}</Empty>}
  </section>;
}

export function CreatorLivePlans({ wid, collaborationId, plans, commands, open }: {
  wid: string; collaborationId: string; plans: unknown; commands: Command[]; open: (command: Command, row: Entity) => void;
}) {
  const { locale, date, t } = useFormat();
  const zh = locale.startsWith('zh');
  const [selected, setSelected] = useState<string>();
  const read = useCommandRead<Payload>(wid, commands, 'creator', 'creators_get_live_session', { live_session_id: selected }, Boolean(selected));
  const rows = values(plans).flatMap(value => asEntity(value, 'creator', 'live_session') ?? []).filter(row => row.data.collaboration_id === collaborationId);
  const session = asEntity(read.data?.live_session, 'creator', 'live_session');
  const clips = values(read.data?.clips).flatMap(value => asEntity(value, 'creator', 'live_clip_reuse') ?? []);
  const planDate = (row: Entity) => {
    const time = new Date(String(row.data.scheduled_at));
    return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: String(row.data.tz) }).format(time);
  };
  const commandButtons = session && commands.filter(command => command.module === 'creator' && (
    command.action === 'creators_update_live_session' && ['planning', 'scheduled', 'live'].includes(String(session.data.status)) ||
    command.action === 'creators_plan_clip_reuse' && session.data.status === 'ended'
  ));
  const runSheet = values(session?.data.run_sheet) as Payload[];
  const warmups = values(session?.data.warmup_publish_target_ids);
  return <section>
    <h3>{zh ? '平台直播企劃' : 'External live plans'}</h3>
    <p>{zh ? '請在直播平台開播及結束，並於此處記錄進度。' : 'Start and end the stream on the platform, then record its progress here.'}</p>
    {rows.length ? <EntityTable records={rows} rowKey={row => row.id} columns={[
      { label: zh ? '平台' : 'Platform', cell: row => <button className="wb-text" aria-pressed={selected === row.id} onClick={() => setSelected(row.id)}>{String(row.data.platform)}</button> },
      { label: zh ? '預定時間' : 'Scheduled time', cell: row => `${planDate(row)} (${row.data.tz})` },
      { label: t('ui.status'), cell: row => <Status value={String(row.data.status)} /> },
    ]} /> : <Empty>{t('ui.empty')}</Empty>}
    {selected && read.isPending && <p role="status">{t('ui.loading')}</p>}
    {read.isError && <Failure error={read.error} retry={() => void read.refetch()} />}
    {session && <>
      {session.data.observation_ref != null && <p>{zh ? '平台觀測依據' : 'Platform evidence'} · {String(session.data.observation_ref)} · {date(String(session.data.observed_at), true)}</p>}
      <div className="wb-inline-actions">{commandButtons && commandButtons.map(command => <button key={command.action} onClick={() => open(command, session)}>{actions[`creator.${command.action}`].label?.[zh ? 0 : 1]}</button>)}</div>
      <h4>{zh ? '流程表' : 'Run sheet'}</h4>
      {runSheet.length ? <ol>{runSheet.map((item, index) => <li key={index}>{String(item.title)}{typeof item.notes === 'string' && ` · ${item.notes}`}</li>)}</ol> : <Empty>{t('ui.empty')}</Empty>}
      <h4>{zh ? '預熱排期' : 'Warm-up schedules'}</h4>
      {warmups.length ? <ul>{warmups.map(id => <li key={String(id)}>{String(id)}</li>)}</ul> : <Empty>{t('ui.empty')}</Empty>}
      <h4>{zh ? '片段復用任務' : 'Clip reuse tasks'}</h4>
      {clips.length ? <EntityTable records={clips} rowKey={row => row.id} columns={[
        { label: t('ui.record'), cell: row => String(row.data.title) },
        { label: zh ? '復用時間' : 'Reuse time', cell: row => date(String(row.data.reuse_at), true) },
        { label: zh ? '授權' : 'Rights', cell: row => row.data.rights_status === 'covered' ? (zh ? '符合授權' : 'Covered') : (zh ? '授權不足' : 'Blocked') },
      ]} /> : <Empty>{t('ui.empty')}</Empty>}
    </>}
  </section>;
}
