import { useState } from 'react';
import { Link } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, EntityTable, Pill } from '@smartsell/ui';
import { findOperation, ProblemNotice, ReadState, rowTitle, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { records, Status, Timestamp, useWorkflowRequest } from './workflow-view-ui';

type Props = { campaign: RecordData; id: string };
const base = '/campaigns/:id';
const idOf = (row: RecordData) => stringValue(row.id);
const text = (form: FormData, key: string) => String(form.get(key) ?? '').trim();
const workspaceUrl = (wid: string, path: string) => `/w/${encodeURIComponent(wid)}/${path}`;
const detailUrl = (wid: string, path: string, id: unknown) => workspaceUrl(wid, `${path}/${encodeURIComponent(stringValue(id))}`);

export function CampaignTracking({ campaign, id }: Props) {
  const { label, locale } = useCopy();
  const api = useApi();
  const read = useRead(`${base}/tracking-summary`, [id], {}, 'campaign');
  const summary = asRecord(read.data?.data);
  const number = new Intl.NumberFormat(locale);
  return <section className="detail-block"><h3>{label(['活動追蹤', 'Campaign tracking'])}</h3><ReadState read={read} />
    {read.data && <>
      <EntityTable records={[summary]} rowKey={() => id} columns={[
        { label: label(['點擊', 'Clicks']), cell: row => number.format(records(asRecord(row.clicks).items).reduce((sum, item) => sum + Number(item.redirects), 0)) },
        { label: label(['優惠碼使用', 'Coupon uses']), cell: row => typeof row.observed_coupon_usage_count === 'number' ? number.format(row.observed_coupon_usage_count) : '—' },
      ]} />
      <p>{label(['追蹤鍵', 'Tracking key'])} <code>{stringValue(campaign.utm_key)}</code></p>
      {records(summary.links).length > 0 && <><h4>{label(['短鏈', 'Short links'])}</h4><ul>{records(summary.links).map(row =>
        <li key={idOf(row)}><Link to={workspaceUrl(api.ws, `traffic?tab=links&id=${encodeURIComponent(idOf(row))}`)}>{rowTitle(row) || stringValue(row.slug) || idOf(row)}</Link></li>)}</ul></>}
      {records(summary.content_items).length > 0 && <><h4>{label(['活動內容', 'Campaign content'])}</h4><ul>{records(summary.content_items).map(row =>
        <li key={idOf(row)}><Link to={detailUrl(api.ws, 'content/items', row.id)}>{rowTitle(row)}</Link></li>)}</ul></>}
      {records(summary.promotions).length > 0 && <EntityTable records={records(summary.promotions)} rowKey={row => stringValue(row.promotion_id)} columns={[
        { label: label(['促銷', 'Promotion']), cell: row => stringValue(row.name) },
        { label: label(['優惠碼使用', 'Coupon uses']), cell: row => number.format(Number(row.observed_usage_count)) },
      ]} />}
    </>}
  </section>;
}

function ReuseTemplate({ campaign, id }: Props) {
  const { label } = useCopy();
  const api = useApi();
  const templates = useRead('/campaign-templates', [], {}, 'campaign');
  const create = useWorkflowRequest();
  const instantiate = useWorkflowRequest();
  const [draft, setDraft] = useState<RecordData>();
  const sourceTemplates = records(templates.data?.data).filter(row => row.source_campaign_id === id);
  const createPath = `${base}/templates`;
  const instantiatePath = '/campaign-templates/:id/instantiate';
  return <section><h4>{label(['活動範本', 'Campaign templates'])}</h4>
    {findOperation(api, 'POST', createPath, 'campaign') && <form className="fields" onSubmit={async event => {
      event.preventDefault();
      const form = event.currentTarget;
      if (await create.run('POST', createPath, [id], { name: text(new FormData(form), 'name') })) form.reset();
    }}><label className="field">{label(['範本名稱', 'Template name'])}<input name="name" required /></label>
      <button disabled={create.pending}>{label(['儲存活動範本', 'Save campaign template'])}</button>
      {create.error != null && <ProblemNotice error={create.error} />}
    </form>}
    <ReadState read={templates} />
    {sourceTemplates.length > 0 && findOperation(api, 'POST', instantiatePath, 'campaign') && <form className="fields" onSubmit={async event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const starts = new Date(text(data, 'starts_at'));
      if (!Number.isFinite(starts.valueOf())) return;
      setDraft(await instantiate.run('POST', instantiatePath, [text(data, 'template_id')], {
        brand_id: campaign.brand_id, name: text(data, 'name'), kind: campaign.kind, timezone: campaign.timezone, starts_at: starts.toISOString(),
      }));
    }}>
      <label className="field">{label(['來源範本', 'Source template'])}<select name="template_id" required>{sourceTemplates.map(row => <option key={idOf(row)} value={idOf(row)}>{rowTitle(row)}</option>)}</select></label>
      <label className="field">{label(['新活動名稱', 'New campaign name'])}<input name="name" required /></label>
      <label className="field">{label(['開始時間', 'Starts at'])}<input name="starts_at" type="datetime-local" required /></label>
      <button disabled={instantiate.pending}>{label(['從範本建立活動', 'Create campaign from template'])}</button>
      {instantiate.error != null && <ProblemNotice error={instantiate.error} />}
      {draft?.id != null && <Link to={detailUrl(api.ws, 'campaigns', draft.id)}>{rowTitle(draft)}</Link>}
    </form>}
  </section>;
}

function CloseoutForm({ campaign, id, reports }: Props & { reports: RecordData[] }) {
  const { label } = useCopy();
  const api = useApi();
  const preview = useWorkflowRequest();
  const save = useWorkflowRequest();
  const [draft, setDraft] = useState<RecordData>();
  const draftPath = `${base}/closeout/draft`;
  if (!findOperation(api, 'POST', draftPath, 'campaign') || !findOperation(api, 'POST', `${base}/closeout`, 'campaign')) return null;
  const unfinished = records(asRecord(draft?.facts).unfinished);
  return <>
    <button disabled={preview.pending || save.pending} onClick={async () => setDraft(await preview.run('POST', draftPath, [id], {}))}>{label(['預覽結案清單', 'Review closeout checklist'])}</button>
    {preview.error != null && <ProblemNotice error={preview.error} />}
    {draft && <form className="fields" onSubmit={event => {
      event.preventDefault();
      const data = new FormData(event.currentTarget);
      const notes = text(data, 'retrospective');
      void save.run('POST', `${base}/closeout`, [id], { report_version_id: text(data, 'report_version_id') || null,
        retrospective_doc: { type: 'doc', content: notes ? [{ type: 'paragraph', content: [{ type: 'text', text: notes }] }] : [] },
        retentions: unfinished.map(issue => ({ type: issue.type, id: issue.id, reason: text(data, `${issue.type}:${issue.id}`) })),
      }, campaign);
    }}>
      <label className="field">{label(['結案報告版本', 'Report version for closeout'])}<select name="report_version_id" aria-label={label(['結案報告版本', 'Report version for closeout'])}>
        <option value="">{label(['不附報告', 'No report'])}</option>
        {reports.flatMap(entry => records(entry.versions).filter(version => ['finalized', 'superseded'].includes(stringValue(version.status))).map(version =>
          <option key={idOf(version)} value={idOf(version)}>{rowTitle(entry)} · {label(['版本', 'Version'])} {stringValue(version.version_no)}</option>))}
      </select></label>
      <label className="field">{label(['復盤紀錄', 'Retrospective'])}<textarea name="retrospective" /></label>
      {unfinished.map(issue => <label className="field" key={`${issue.type}:${issue.id}`}>{label(['保留原因', 'Reason to retain'])} · {stringValue(issue.type)} {idOf(issue)}
        <input name={`${issue.type}:${issue.id}`} required /></label>)}
      <label><input type="checkbox" required /> {label(['已確認結案清單', 'Closeout checklist reviewed'])}</label>
      <button disabled={save.pending}>{label(['確認結案', 'Close campaign'])}</button>
      {save.error != null && <ProblemNotice error={save.error} />}
    </form>}
  </>;
}

export function CampaignCloseout({ campaign, id }: Props) {
  const { label, t } = useCopy();
  const api = useApi();
  const read = useRead(`${base}/closeout`, [id], {}, 'campaign');
  const reports = useRead(`${base}/reports`, [id], {}, 'campaign');
  const backfill = useWorkflowRequest();
  const backfillPath = `${base}/reports/:reportId/backfill`;
  const closed = campaign.status === 'closed';
  const closeout = asRecord(read.data?.data);
  const snapshot = asRecord(closeout.snapshot);
  const reportRows = records(reports.data?.data);
  return <section className="detail-block"><h3>{label(['結案', 'Closeout'])}</h3><ReadState read={read} />
    {read.data && (closeout.id ? <>
      <Pill>{label(['已結案', 'Closed'])}</Pill>
      <dl><dt>{label(['快照時間', 'Snapshot captured'])}</dt><dd><Timestamp value={closeout.created_at} /></dd>
        <dt>{label(['結案資料截止時間', 'Closeout data cutoff'])}</dt><dd><Timestamp value={snapshot.data_cutoff_at} /></dd></dl>
      {records(snapshot.retentions).length > 0 && <ul>{records(snapshot.retentions).map(row =>
        <li key={`${row.type}:${row.id}`}>{stringValue(row.type)} {idOf(row)} · {stringValue(row.reason)}</li>)}</ul>}
    </> : campaign.status !== 'wrapping' && <EmptyState title={t('empty')} />)}
    {campaign.status === 'wrapping' && <CloseoutForm id={id} campaign={campaign} reports={reportRows} />}
    {(closed || campaign.status === 'wrapping' || reportRows.length > 0) && <ReadState read={reports} />}
    {reportRows.map(report => {
      return <article key={idOf(report)}>
        <h4><Link to={detailUrl(api.ws, 'reports', report.id)}>{rowTitle(report)}</Link></h4>
        <EntityTable records={records(report.versions)} rowKey={idOf} columns={[
          { label: label(['版本', 'Version']), cell: row => `${label(['版本', 'Version'])} ${stringValue(row.version_no)}` },
          { label: t('status'), cell: row => <Status value={row.status} /> },
          { label: label(['資料截止時間', 'Data cutoff']), cell: row => <Timestamp value={row.data_cutoff_at} /> },
          { label: label(['結案快照', 'Closeout snapshot']), cell: row => row.id === closeout.report_version_id ? label(['結案使用', 'Used for closeout']) : '—' },
        ]} />
        {closed && report.status !== 'archived' && findOperation(api, 'POST', backfillPath, 'campaign') && <button disabled={backfill.pending}
          onClick={() => void backfill.run('POST', backfillPath, [id, idOf(report)], {})}>{label(['補採報告', 'Backfill report'])}</button>}
      </article>;
    })}
    {backfill.error != null && <ProblemNotice error={backfill.error} />}
    {closed && <ReuseTemplate campaign={campaign} id={id} />}
  </section>;
}
