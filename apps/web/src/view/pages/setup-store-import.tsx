import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { StatusChip, formatDateTime, type Lang, type Tuple } from '@smartsell/ui';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, useText } from '../parts';
import { DeviceStatus } from './setup-connections';
import { setupText as text } from './setup-copy';
import { importPath, useSetupWrite, type CatalogJob, type Device, type Store, type WorkerBinding } from './setup-data';
import { StoreMarketSetup } from './setup-store-market';
import { WriteProblem } from './settings-parts';

const copy = {
  request: ['向固定 Worker 發出商品匯入請求。可先設定市場，讓來源檔案的價格與庫存顯示在商品看板。', 'Request a product import from the dedicated worker. You can set up a market first to show prices and stock from the export in Products.'],
  waiting: ['等待 Worker 上傳', 'Waiting for worker upload'],
  checkUpload: ['檢查是否已上傳', 'Check for upload'],
  worker: ['請在已綁定的機器上開啟 SmartSell Desktop，連線並領取商品任務。', 'On the assigned machine, open SmartSell Desktop, connect, and claim the product task.'],
  export: ['從官方商家後台匯出商品 CSV、TSV 或 XLSX。核對官方店鋪 ID，在 Desktop 選擇檔案並確認上傳。', 'Export a product CSV, TSV, or XLSX from the official merchant portal. Verify the official store ID, then select the file and confirm the upload in Desktop.'],
  returned: ['上傳後回到這一步檢查預覽並確認合併。', 'After uploading, return to this step to review the preview and confirm the merge.'],
  review: ['檢查商品匯入預覽', 'Review product import preview'],
  confirm: ['確認合併', 'Confirm merge'],
  continue: ['繼續合併', 'Continue merge'],
  confirmText: ['我已檢查預覽，確認將有效商品寫入這家店鋪。無效或重複列會略過。', 'I reviewed the preview and confirm that valid products should be merged into this store. Invalid or duplicate rows will be skipped.'],
  rows: ['列數', 'Rows'], valid: ['有效', 'Valid'], invalid: ['無效', 'Invalid'], duplicate: ['重複', 'Duplicates'],
  row: ['檔案列', 'File row'], fields: ['商品 / SKU', 'Product / SKU'], price: ['來源價格', 'Source price'], stock: ['來源庫存', 'Source stock'],
  outcome: ['結果', 'Result'], missing: ['未採集', 'Not collected'], unknown: ['未知', 'Unknown'],
  previous: ['上一頁', 'Previous page'], next: ['下一頁', 'Next page'],
  advanced: ['在新分頁開啟完整批次工具', 'Open full batch tools in a new tab'],
  view: ['在新分頁查看商品', 'View products in a new tab'],
  again: ['再匯入一份商品清單', 'Import another product export'],
  partial: ['合併完成，部分列未匯入。', 'Merge finished with some rows left out.'],
  empty: ['沒有匯入任何商品列。請檢查批次或上傳修正後的檔案。', 'No product rows were imported. Review the batch or upload a corrected export.'],
  counts: ['已合併 / 無須更新 / 未匯入', 'Merged / unchanged / left out'],
  unavailable: ['此批次已無法在向導確認。', 'This batch is no longer available to confirm here.'],
} as const;

const jobLabels: Record<string, Tuple> = {
  queued: text.queued, claimed: text.claimed, previewed: text.previewed, imported: text.imported,
  failed: text.failed, expired: text.expiredJob, cancelled: text.cancelled,
};
const rowLabels: Record<string, Tuple> = {
  new: ['新增', 'New'], changed: ['更新', 'Changed'], unchanged: ['無須更新', 'Unchanged'], invalid: copy.invalid,
  dup_in_file: copy.duplicate, merged: ['已合併', 'Merged'], skipped: ['已略過', 'Skipped'], merge_failed: text.failed,
};

export function StoreProductImport({ store, binding, devices, jobs, refresh, catalogError }: {
  store: Store; binding: WorkerBinding; devices: Device[]; jobs: CatalogJob[]; refresh: () => void; catalogError: boolean;
}) {
  const { l, lang } = useText();
  const { ws } = useViewContext();
  const action = useSetupWrite();
  const marketId = useId();
  const [showMarket, setShowMarket] = useState(false);
  const [marketSaved, setMarketSaved] = useState(false);
  const [queued, setQueued] = useState<CatalogJob>();
  const [startAnother, setStartAnother] = useState(false);
  const active = jobs.find(item => ['queued', 'claimed', 'previewed'].includes(item.status));
  const job = queued && !jobs.some(item => item.id === queued.id) ? queued : active ?? jobs[0];
  const waiting = job?.status === 'queued' || job?.status === 'claimed';
  const reviewing = job?.status === 'previewed' && Boolean(job.import_id);
  const complete = job?.status === 'imported';
  const showRequest = !waiting && !reviewing && (!complete || startAnother);
  const device = devices.find(item => item.id === (waiting ? job?.device_id : binding.device_id));
  async function queue() {
    const result = await action.run<CatalogJob>('POST', `/stores/${encodeURIComponent(store.id)}/worker/imports`, {});
    if (!result) return;
    setQueued(result);
    setStartAnother(false);
    refresh();
  }
  return <div aria-busy={action.pending || undefined}>
    <div className="vs-row-head"><strong>{device?.name ?? binding.device_name}</strong><small>{job?.external_store_id ?? binding.external_store_id}</small><DeviceStatus device={device} /></div>
    {job && !reviewing && <div className="vs-row-head" role="status">
      <StatusChip status={job.status} label={Object.hasOwn(jobLabels, job.status) ? jobLabels[job.status] : undefined} />
      {job.error_code && <small><code>{job.error_code}</code></small>}
    </div>}
    {waiting && <>
      <h3>{l(copy.waiting)}</h3>
      <ol><li>{l(copy.worker)}</li><li>{l(copy.export)}</li><li>{l(copy.returned)}</li></ol>
      {job?.expires_at && <p className="muted">{l(text.expires)} <time dateTime={job.expires_at}>{formatDateTime(job.expires_at, lang)}</time></p>}
      <button type="button" className="vs-btn" onClick={refresh}>{l(copy.checkUpload)}</button>
    </>}
    {job?.import_id && <ImportBatch key={job.import_id} id={job.import_id} store={store} reviewing={reviewing} refresh={refresh} />}
    {complete && !startAnother && <div className="vs-actions">
      <button type="button" className="vs-btn" onClick={() => setStartAnother(true)}>{l(copy.again)}</button>
    </div>}
    {showRequest && <>
      <p>{l(copy.request)}</p>
      <div className="vs-actions">
        <button type="button" className="vs-btn" aria-expanded={showMarket} aria-controls={marketId} onClick={() => setShowMarket(value => !value)}>
          {l(text.marketSetup)}
        </button>
        {marketSaved && <span role="status">{l(text.marketSaved)}</span>}
      </div>
      <div id={marketId} hidden={!showMarket}>{showMarket && <StoreMarketSetup store={store} onReady={result => {
        if (result.status === 'configured') setMarketSaved(true);
        setShowMarket(false);
      }} />}</div>
      {!showMarket && <div className="vs-actions">
        <button type="button" className="vs-btn primary-soft" disabled={action.pending || catalogError}
          onClick={() => void queue()}>{l(action.pending ? text.requestPending : text.startImport)}</button>
        {device?.online === false && <small className="muted">{l(text.offlineImport)}</small>}
      </div>}
      {action.error !== undefined && <WriteProblem error={action.error} />}
    </>}
    <div className="vs-actions"><Link className="vs-btn" to={importPath(ws, undefined, store.id)} target="_blank" rel="noopener">{l(text.fileImport)}</Link></div>
  </div>;
}

interface Batch {
  id: string;
  store_id: string;
  template_key: string;
  status: string;
  stats?: { rows?: number; valid?: number; invalid?: number; dup_in_file?: number };
  merged_rows?: number;
  skipped_rows?: number;
  failed_rows?: number;
}

function ImportBatch({ id, store, reviewing, refresh }: { id: string; store: Store; reviewing: boolean; refresh: () => void }) {
  const { l } = useText();
  const { ws, base } = useViewContext();
  const path = `/imports/${encodeURIComponent(id)}`;
  const batch = useView<Batch>(path);
  return <Loaded read={batch}>{value => {
    if (value.store_id !== store.id || value.template_key !== 'product_list') return <p role="alert">{l(copy.unavailable)}</p>;
    const final = value.status === 'merged' || value.status === 'partially_merged';
    const merged = value.merged_rows ?? 0;
    const skipped = value.skipped_rows ?? 0;
    const failed = value.failed_rows ?? 0;
    const products = `${base}/products${store.brand_id ? `?${new URLSearchParams({ brand: store.brand_id })}` : ''}`;
    return <>
      {final ? <>
        <p role="status">{l(merged + skipped === 0 ? copy.empty : failed ? copy.partial : text.imported)}</p>
        <p>{l(copy.counts)} · {merged} / {skipped} / {failed}</p>
        {merged + skipped > 0 && <Link className="vs-btn primary-soft" to={products} target="_blank" rel="noopener">{l(copy.view)}</Link>}
      </> : reviewing && ['awaiting_confirmation', 'merging'].includes(value.status) ?
        <BatchPreview batch={value} path={path} blocked={batch.isError} refresh={() => { void batch.refetch(); refresh(); }} /> :
        <p>{l(copy.unavailable)}</p>}
      <Link className="vs-btn" to={importPath(ws, id, store.id)} target="_blank" rel="noopener">{l(copy.advanced)}</Link>
    </>;
  }}</Loaded>;
}

interface PreviewRow {
  row_no: number;
  status: string;
  normalized?: { title?: string; sku?: string; price_minor?: number; currency?: string; available?: number };
  issues?: { code: string; message?: string }[];
}

function sourcePrice(value: PreviewRow['normalized'], lang: Lang) {
  if (value?.price_minor == null || !value.currency) return;
  const format = new Intl.NumberFormat(lang === 'en' ? 'en-US' : 'zh-TW', { style: 'currency', currency: value.currency });
  return format.format(value.price_minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
}

const pageSize = 20;
function BatchPreview({ batch, path, refresh, blocked }: { batch: Batch; path: string; refresh: () => void; blocked: boolean }) {
  const { l, lang } = useText();
  const action = useSetupWrite();
  const [confirmed, setConfirmed] = useState(false);
  const [page, setPage] = useState(0);
  const continuing = batch.status === 'merging';
  const rows = useView<PreviewRow[]>(`${path}/rows`, { offset: String(page * pageSize), limit: String(pageSize) });
  const stats = batch.stats;
  async function merge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked || !rows.isSuccess || rows.isPlaceholderData || (!continuing && !confirmed)) return;
    const result = await action.run<Batch>('POST', `${path}/confirm`, {});
    if (!result) return;
    setConfirmed(false);
    refresh();
  }
  return <>
    <h3>{l(copy.review)}</h3>
    <p role="status">{l(continuing ? copy.continue : text.previewed)}</p>
    <p>{l(copy.rows)} {stats?.rows ?? 0} · {l(copy.valid)} {stats?.valid ?? 0} · {l(copy.invalid)} {stats?.invalid ?? 0} · {l(copy.duplicate)} {stats?.dup_in_file ?? 0}</p>
    <Loaded read={rows}>{items => <>
      <div className="vs-table-scroll"><table className="vs-table">
        <thead><tr>{[copy.row, copy.fields, copy.price, copy.stock, copy.outcome].map(label => <th scope="col" key={label[1]}>{l(label)}</th>)}</tr></thead>
        <tbody>{items.map(row => {
          const value = row.normalized;
          return <tr key={row.row_no}>
            <th scope="row">{row.row_no}</th>
            <td>{value?.title ?? '—'}{value?.sku && <div>{value.sku}</div>}</td>
            <td>{sourcePrice(value, lang) ?? l(copy.missing)}</td>
            <td>{value?.available ?? l(copy.unknown)}</td>
            <td>{Object.hasOwn(rowLabels, row.status) ? l(rowLabels[row.status]!) : row.status}
              {row.issues?.map((issue, i) => <div key={i}>{issue.message ?? issue.code}</div>)}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {((stats?.rows ?? 0) > pageSize || page > 0) && <div className="vs-actions">
        <button className="vs-btn" type="button" disabled={page === 0 || rows.isFetching} onClick={() => setPage(page - 1)}>{l(copy.previous)}</button>
        <button className="vs-btn" type="button" disabled={(page + 1) * pageSize >= (stats?.rows ?? 0) || rows.isFetching} onClick={() => setPage(page + 1)}>{l(copy.next)}</button>
      </div>}
    </>}</Loaded>
    <form className="vs-form" onSubmit={event => void merge(event)}><fieldset disabled={action.pending || blocked || !rows.isSuccess || rows.isPlaceholderData}>
      {!continuing && <label><input type="checkbox" required checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /> {l(copy.confirmText)}</label>}
      <div className="vs-actions"><button type="submit" className="vs-btn primary-soft" disabled={!continuing && (!confirmed || !stats?.valid)}>
        {l(action.pending ? text.requestPending : continuing ? copy.continue : copy.confirm)}
      </button></div>
    </fieldset>{action.error !== undefined && <WriteProblem error={action.error} />}</form>
  </>;
}
