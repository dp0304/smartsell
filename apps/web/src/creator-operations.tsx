import type { RecordData } from '@smartsell/sdk';
import { entity, findOperation, ReadState, recordRows, stringValue, useApi, useRead } from './api';
import { text, type Action } from './actions';
import { useCopy } from './i18n';

type Open = (path: string, action: Action, ids?: string[], record?: RecordData, seed?: RecordData) => void;
const select = (key: string, zh: string, en: string, options: string[]) => ({ ...text(key, zh, en), type: 'select' as const, options });
const date = (key: string, zh: string, en: string) => ({ ...text(key, zh, en), type: 'datetime-local' as const });

export function CreatorAudienceObservations({ record, open }: { record: RecordData; open: Open }) {
  const api = useApi();
  const { label, locale } = useCopy();
  const rows = recordRows(record.audience_markets) ?? [];
  const format = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 2 });
  const sources: Record<string, readonly [string, string]> = {
    self_reported: ['創作者自報', 'Self-reported'], public: ['公開資料', 'Public data'], manual: ['人工記錄', 'Manual record'],
  };
  const action: Action = { path: '/creators/:id/audience-observations', label: ['記錄受眾觀測', 'Record audience observation'], versioned: true,
    fields: [text('market', '市場', 'Market'), text('share_bps', '佔比（基點）', 'Share (basis points)'),
      select('source_kind', '來源', 'Source', Object.keys(sources)), text('source_ref', '來源依據', 'Source reference'), date('observed_at', '觀測時間', 'Observed at')],
    body: values => ({ ...values, share_bps: Number(values.share_bps) }),
  };
  return <section className="detail-block"><h3>{label(['受眾市場', 'Audience markets'])}</h3>
    {rows.length ? <ul>{rows.map(row => <li key={stringValue(row.market)}>
      {stringValue(row.market)} · {typeof row.share_bps === 'number' ? format.format(row.share_bps / 10_000) : '—'} · {sources[stringValue(row.source_kind)] ? label(sources[stringValue(row.source_kind)]) : '—'} · {stringValue(row.source_ref)} · {stringValue(row.observed_at)}
    </li>)}</ul> : <p>{label(['尚無受眾觀測資料', 'No audience observations'])}</p>}
    {findOperation(api, 'POST', action.path) && <button onClick={() => open(action.path, action, [stringValue(record.id)], record)}>{label(action.label)}</button>}
  </section>;
}

export function CreatorProfileAssociations({ id, open }: { id: string; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  const read = useRead('/creators/:id/associations', [id]);
  if (!read.op) return null;
  const rows = recordRows(read.data?.data) ?? [];
  const reason = { ...text('reason', '原因', 'Reason'), type: 'textarea' as const };
  const associate: Action = { path: '/creators/:id/associations', label: ['關聯重複檔案', 'Associate duplicate profiles'], confirm: true, fields: [
    { ...text('related_creator_id', '另一創作者檔案', 'Other creator profile'), type: 'ref', lookup: '/creators' },
    { ...text('evidence_ids', '證據 ID（逗號分隔）', 'Evidence IDs (comma-separated)'), type: 'ids' }, reason,
  ] };
  const undo: Action = { path: '/creator-associations/:id/revoke', label: ['撤銷檔案關聯', 'Undo profile association'], versioned: true, confirm: true, fields: [reason] };
  return <section className="detail-block"><h3>{label(['檔案關聯', 'Profile associations'])}</h3>
    <p>{label(['相同暱稱不會自動關聯。關聯會保留兩份檔案。', 'Matching nicknames never link automatically. An association preserves both profiles.'])}</p>
    <ReadState read={read} />
    {read.data && !rows.some(row => row.status === 'associated') && findOperation(api, 'POST', associate.path) &&
      <button onClick={() => open(associate.path, associate, [id])}>{label(associate.label)}</button>}
    <ul>{rows.map(row => <li key={stringValue(row.id)}>
      {stringValue(row.related_display_name)} · {stringValue(row.status)} · {stringValue(row.reason)} · {stringValue(row.created_by)}
      {row.status === 'revoked' && <> · {stringValue(row.revoked_reason)} · {stringValue(row.revoked_by)}</>}
      {row.status === 'associated' && findOperation(api, 'POST', undo.path) &&
        <button onClick={() => open(undo.path, undo, [stringValue(row.id)], row)}>{label(undo.label)}</button>}
    </li>)}</ul>
  </section>;
}

const plan: Action = { path: '/live-sessions', label: ['規劃平台直播', 'Plan external live session'], fields: [
  { ...text('collaboration_id', '合作案', 'Collaboration'), type: 'ref', lookup: '/collaborations' },
  text('platform', '直播平台', 'Live platform'), date('scheduled_at', '開始時間（瀏覽器時區）', 'Starts at (browser time zone)'),
  { ...text('tz', '直播時區（IANA）', 'Live time zone (IANA)'), initial: Intl.DateTimeFormat().resolvedOptions().timeZone },
  { ...text('run_sheet', '流程表（每行一項）', 'Run sheet (one item per line)', true), type: 'textarea' },
  { ...text('warmup_publish_target_ids', '預熱排期 ID（逗號分隔）', 'Warm-up publish target IDs (comma-separated)', true), type: 'ids' },
], body: values => ({ ...values, run_sheet: stringValue(values.run_sheet).split(/\r?\n/).map(title => title.trim()).filter(Boolean).map(title => ({ title })) }) };

export function CreatorPlanButton({ open, collaborationId }: { open: Open; collaborationId?: string }) {
  const api = useApi();
  const { label } = useCopy();
  if (!findOperation(api, 'POST', plan.path)) return null;
  return <button onClick={() => open(plan.path, plan, [], undefined, { collaboration_id: collaborationId })}>{label(plan.label)}</button>;
}

const transitions: Record<string, string[]> = { planning: ['scheduled', 'cancelled'], scheduled: ['live', 'cancelled'], live: ['ended'] };
const reuse: Action = { path: '/live-sessions/:id/clip-reuse', label: ['規劃片段再用', 'Plan clip reuse'], fields: [
  text('title', '名稱', 'Title'), { ...text('asset_id', '素材', 'Asset'), type: 'ref', lookup: '/assets' },
  text('asset_version_id', '素材版本 ID', 'Asset version ID'), text('platform', '發布平台', 'Destination platform'),
  text('market_id', '市場 ID', 'Market ID'),
  select('usage', '用途', 'Usage', ['organic_social', 'paid_ads']), date('reuse_at', '預定再用時間', 'Intended reuse time'), text('attribution', '署名', 'Attribution', true),
] };

export function CreatorLiveSession({ record, open }: { record: RecordData; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  const statuses = transitions[stringValue(record.status)] ?? [];
  const update: Action = { path: '/live-sessions/:id', method: 'PATCH', label: ['記錄平台直播進度', 'Record external live progress'], versioned: true,
    fields: [select('status', '進度', 'Progress', statuses), text('source_ref', '平台觀測依據（直播中／結束必填）', 'Platform evidence (required when live or ended)', true)],
  };
  const id = stringValue(record.id);
  const observations = recordRows(record.observations) ?? (record.observation_ref ? [{
    status: record.status, source_ref: record.observation_ref, observed_at: record.observed_at, observed_by: record.observed_by,
  }] : []);
  return <section className="detail-block"><h3>{label(['平台直播企劃', 'External live plan'])}</h3>
    <p>{label(['請在平台開播與結束直播，並在此記錄進度。', 'Start and end the stream on the platform and record progress here.'])}</p>
    <p>{stringValue(record.platform)} · {stringValue(record.scheduled_at)} · {stringValue(record.tz)} · {stringValue(record.status)}</p>
    <h4>{label(['流程表', 'Run sheet'])}</h4>
    <ol>{(recordRows(record.run_sheet) ?? []).map((row, index) => <li key={index}>{stringValue(row.title)}{Boolean(row.notes) && <> · {stringValue(row.notes)}</>}</li>)}</ol>
    <h4>{label(['預熱排期', 'Warm-up schedule'])}</h4>
    <ul>{(Array.isArray(record.warmup_publish_target_ids) ? record.warmup_publish_target_ids : []).map(value => {
      const target = stringValue(value);
      return <li key={target}><a href={`/w/${encodeURIComponent(api.ws)}/calendar?tab=targets&id=${encodeURIComponent(target)}`}>{target}</a></li>;
    })}</ul>
    {!!observations.length && <ul aria-label={label(['平台觀測', 'Platform observations'])}>{observations.map(row => <li key={stringValue(row.status)}>
      {stringValue(row.status)} · {stringValue(row.source_ref)} · {stringValue(row.observed_at)} · {stringValue(row.observed_by)}
    </li>)}</ul>}
    {statuses.length > 0 && findOperation(api, 'PATCH', update.path) && <button onClick={() => open(update.path, update, [id], record, { status: statuses[0] })}>{label(update.label)}</button>}
    {record.status === 'ended' && findOperation(api, 'POST', reuse.path) && <button onClick={() => open(reuse.path, reuse, [id], undefined, { usage: 'organic_social' })}>{label(reuse.label)}</button>}
    <h4>{label(['片段再用', 'Clip reuse'])}</h4>
    {(recordRows(record.clips) ?? []).map(row => <p key={stringValue(row.id)}>{stringValue(row.title)} · {row.rights_status === 'covered'
      ? label(['符合授權', 'Rights covered']) : label(['授權阻擋', 'Blocked by rights'])}</p>)}
  </section>;
}

export function CreatorCollaborationLive({ id, open }: { id: string; open: Open }) {
  const api = useApi();
  const { label } = useCopy();
  const read = useRead('/live-sessions', [], { collaboration_id: id });
  if (!read.op) return null;
  return <section className="detail-block"><h3>{label(['直播企劃', 'Live sessions'])}</h3>
    <CreatorPlanButton open={open} collaborationId={id} />
    <ReadState read={read} />
    <ul>{(recordRows(read.data?.data) ?? []).map(row => <li key={stringValue(row.id)}>
      <a href={`/w/${encodeURIComponent(api.ws)}/creators?tab=live&id=${encodeURIComponent(stringValue(row.id))}`}>{stringValue(row.platform)} · {stringValue(row.scheduled_at)} · {stringValue(row.status)}</a>
    </li>)}</ul>
  </section>;
}
