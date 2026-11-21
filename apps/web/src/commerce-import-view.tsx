import { problemSummary } from './problem-copy';
import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, EntityTable, Panel } from '@smartsell/ui';
import { findOperation, ProblemNotice, ReadState, rowTitle, stringValue, useApi, useRead, versionOf } from './api';
import { useCopy } from './i18n';
import { records, Status, Timestamp, useWorkflowRequest } from './workflow-view-ui';

const templates = {
  product_list: ['商品清單', 'Products', '商品清单'], inventory_list: ['庫存清單', 'Inventory', '库存清单'],
  order_list: ['訂單清單', 'Orders', '订单清单'], refund_list: ['退款清單', 'Refunds', '退款清单'],
} as const;
type Template = keyof typeof templates;
const importPath = '/stores/:id/imports';
const batchPath = '/imports/:id';
const pageSize = 50;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
const templateName = (key: unknown) => templates[key as Template] ?? [stringValue(key), stringValue(key)] as const;

export function CommerceImports({ storeId, onPick, onStores }: { storeId: string; onPick: (id: string, store?: string) => void; onStores: () => void }) {
  const { t, label, locale } = useCopy();
  const api = useApi();
  const stores = useRead('/stores');
  const schemas = useRead('/import-templates');
  const history = useRead('/imports');
  const request = useWorkflowRequest();
  const [selected, setSelected] = useState(storeId);
  const [template, setTemplate] = useState<Template>('product_list');
  const [invalid, setInvalid] = useState('');
  const [reading, setReading] = useState(false);
  const writable = findOperation(api, 'POST', importPath);
  const availableStores = records(stores.data?.data).filter(store => store.status !== 'disabled');
  const provider = availableStores.find(store => store.id === selected)?.provider;
  const options: Template[] = ['product_list'];
  if (provider === 'shopify') options.push('inventory_list');
  if (findOperation(api, 'PATCH', '/stores/:id') && ['amazon_sp', 'shopee', 'lazada', 'file_import', 'other'].includes(stringValue(provider))) options.push('order_list', 'refund_list');
  const schema = records(schemas.data?.data).find(row => row.key === template);
  const columns = strings(schema?.columns);
  const batches = records(history.data?.data).filter(batch => batch.store_id && (!selected || batch.store_id === selected));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (request.pending || reading || !availableStores.some(store => store.id === selected)) return;
    const form = new FormData(event.currentTarget);
    const file = form.get('csv');
    if (!(file instanceof File) || !file.size) { setInvalid(label(['請選擇非空白檔案。', 'Choose a non-empty file.', '请选择非空白文件。'])); return; }
    if (file.size > 1_000_000) { setInvalid(t('fileTooLarge')); return; }
    setInvalid('');
    setReading(true);
    try {
      const csv = await file.text();
      if (!csv.trim()) { setInvalid(label(['檔案沒有資料。', 'The file has no data.', '文件没有数据。'])); return; }
      const timezone = String(form.get('timezone') ?? '').trim();
      const response = await request.run('POST', importPath, [selected], { template_key: template, csv_text: csv, ...(timezone && { options: { timezone } }) });
      if (response?.id) onPick(stringValue(response.id), selected);
    } catch { setInvalid(label(['無法讀取檔案。', 'Could not read the file.', '无法读取文件。'])); }
    finally { setReading(false); }
  }
  return <>
    {writable && <Panel><div className="panel-head"><h2>{label(['預覽店鋪 CSV', 'Preview a store CSV', '预览店铺 CSV'])}</h2></div><div className="detail-body">
      <ReadState read={stores} />
      {stores.data && (availableStores.length ? <form className="fields" onSubmit={submit}>
        <fieldset disabled={reading || request.pending}>
          <label className="field">{t('resource.stores')}<select name="store" aria-label={t('resource.stores')} required value={selected} onChange={event => { setSelected(event.target.value); setTemplate('product_list'); }}>
            <option value="">{t('select')}</option>{availableStores.map(store => <option key={stringValue(store.id)} value={stringValue(store.id)}>{rowTitle(store)} · {stringValue(store.provider)}</option>)}
          </select></label>
          <label className="field">{t('template_key')}<select value={template} onChange={event => setTemplate(event.target.value as Template)}>{options.map(key => <option key={key} value={key}>{label(templates[key])}</option>)}</select></label>
          {columns.length > 0 && <details><summary>{label(['可對應的欄位', 'Supported columns', '可对应的字段'])}</summary><p>{columns.join(', ')}</p></details>}
          <label className="field">{label(['CSV 或 TSV 檔案', 'CSV or TSV file', 'CSV 或 TSV 文件'])}<input required type="file" name="csv" accept=".csv,.tsv,text/csv,text/tab-separated-values" /></label>
          {(template === 'order_list' || template === 'refund_list') && <label className="field">{label(['報告時區（IANA）', 'Report time zone (IANA)', '报告时区（IANA）'])}<input name="timezone" defaultValue={Intl.DateTimeFormat().resolvedOptions().timeZone} /></label>}
          <button className="primary" type="submit">{reading || request.pending ? t('saving') : label(['產生預覽', 'Generate preview', '产生预览'])}</button>
        </fieldset>
        {invalid && <p role="alert" className="problem">{invalid}</p>}
        {request.error !== undefined && <ProblemNotice error={request.error} />}
      </form> : <EmptyState title={label(['先建立可用的店鋪', 'Set up an import store first', '先创建可用的店铺'])} action={<button onClick={onStores}>{t('resource.stores')}</button>} />)}
    </div></Panel>}
    <Panel><div className="panel-head"><h2>{label(['店鋪匯入紀錄', 'Store import history', '店铺导入记录'])}</h2></div>
      <ReadState read={history} />
      {history.data && (batches.length ? <EntityTable records={batches} rowKey={row => stringValue(row.id)} columns={[
        { label: t('template_key'), cell: row => <button className="text-button" onClick={() => onPick(stringValue(row.id), stringValue(row.store_id))}>{label(templateName(row.template_key))}</button> },
        { label: t('resource.stores'), cell: row => rowTitle(availableStores.find(store => store.id === row.store_id) ?? { id: row.store_id }) },
        { label: t('status'), cell: row => <Status value={row.status} /> },
        { label: t('created_at'), cell: row => <Timestamp value={row.created_at} /> },
      ]} /> : <EmptyState title={t('empty')} />)}
    </Panel>
  </>;
}

function CorrectedImport({ batch, id }: { batch: RecordData; id: string }) {
  const { label } = useCopy();
  const [params, setParams] = useSearchParams();
  const request = useWorkflowRequest();
  const [reading, setReading] = useState(false);
  const [readError, setReadError] = useState(false);
  const related = (batchId: string) => {
    const next = new URLSearchParams(params);
    next.set('related', 'import');
    next.set('rid', batchId);
    return next;
  };
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = new FormData(event.currentTarget).get('corrected-file');
    if (!(file instanceof File) || !file.size || reading || request.pending) return;
    const workbook = file.name.toLowerCase().endsWith('.xlsx');
    if (file.size > (workbook ? 700_000 : 1_000_000)) { setReadError(true); return; }
    setReading(true);
    setReadError(false);
    try {
      const payload = workbook
        ? { xlsx_base64: btoa(Array.from(new Uint8Array(await file.arrayBuffer()), byte => String.fromCharCode(byte)).join('')) }
        : { csv_text: await file.text() };
      const result = await request.run('POST', '/imports', [], {
        ...payload, template_key: batch.template_key, options: batch.options, supersedes_batch_id: id,
        ...(typeof batch.store_id === 'string' && { store_id: batch.store_id }),
        ...(typeof batch.data_source_id === 'string' && { data_source_id: batch.data_source_id }),
        ...(typeof batch.ad_account_id === 'string' && { ad_account_id: batch.ad_account_id }),
      });
      if (typeof result?.id === 'string') setParams(related(result.id));
    } catch { setReadError(true); }
    finally { setReading(false); }
  }
  return <>
    {typeof batch.supersedes_batch_id === 'string' && <p><Link to={{ search: `?${related(batch.supersedes_batch_id)}` }}>{label(['查看前一批與原始錯列', 'View previous batch and its errors', '查看前一批与原始错列'])}</Link></p>}
    <form className="fields" onSubmit={submit}>
      <fieldset disabled={reading || request.pending}>
        <label className="field">{label(['修正後的報表', 'Corrected report', '修正后的报表'])}<input name="corrected-file" type="file" accept=".csv,.tsv,.xlsx" required /></label>
        <button type="submit">{label(['預覽修正檔', 'Preview corrected report', '预览修正档'])}</button>
      </fieldset>
      {readError && <p role="alert">{label(['無法讀取修正檔。', 'Could not read the corrected file.', '无法读取修正档。'])}</p>}
      {request.error !== undefined && <ProblemNotice error={request.error} />}
    </form>
  </>;
}

export function ImportReview({ batch, id }: { batch: RecordData; id: string }) {
  const { t, label, locale } = useCopy();
  const api = useApi();
  const [offset, setOffset] = useState(0);
  const [filter, setFilter] = useState('');
  const [confirmation, setConfirmation] = useState<'confirm' | 'cancel'>();
  const request = useWorkflowRequest();
  const read = useRead(`${batchPath}/rows`, [id], { offset: String(offset), limit: String(pageSize), ...(filter && { status: filter }) });
  const schemas = useRead('/import-templates');
  const schema = records(schemas.data?.data).find(row => row.key === batch.template_key);
  const columns = strings(schema?.columns);
  const mapping = asRecord(batch.mapping);
  const stats = asRecord(batch.stats);
  const rows = records(read.data?.data);
  const preview = batch.status === 'awaiting_confirmation';
  const merging = batch.status === 'merging';
  const confirm = (preview || merging) && findOperation(api, 'POST', `${batchPath}/confirm`);
  const cancel = preview && findOperation(api, 'POST', `${batchPath}/cancel`);
  const remap = preview && versionOf(batch) && columns.length > 0 && findOperation(api, 'PATCH', batchPath);
  const outcomes = ['new', 'changed', 'unchanged', 'invalid', 'dup_in_file', 'merged', 'skipped', 'merge_failed'];
  async function applyMapping(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = strings(batch.header);
    const form = new FormData(event.currentTarget);
    const values = Object.fromEntries(fields.map((header, index) => [header, form.get(`mapping-${index}`)]).filter(([, value]) => value));
    if (await request.run('PATCH', batchPath, [id], { mapping: values }, batch)) { setOffset(0); setFilter(''); }
  }
  async function applyConfirmation(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirmation && await request.run('POST', `${batchPath}/${confirmation}`, [id], {})) setConfirmation(undefined);
  }
  async function download() {
    const data = await request.run('GET', `${batchPath}/error-file`, [id]);
    if (typeof data?.csv !== 'string') return;
    const url = URL.createObjectURL(new Blob([data.csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'import-errors.csv';
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <>
    <section className="detail-block">
      <h3>{label(templateName(batch.template_key))} · <Status value={batch.status} /></h3>
      <p>{label(['預覽列數', 'Rows previewed', '预览列数'])} {stringValue(stats.rows) || '0'} · {label(['有效', 'Valid'])} {stringValue(stats.valid) || '0'} · {label(['無效', 'Invalid', '无效'])} {stringValue(stats.invalid) || '0'} · {label(['檔內重複', 'Duplicates', '档内重复'])} {stringValue(stats.dup_in_file) || '0'}</p>
      {batch.checkpoint_row != null && <p>{label(['處理至第幾列', 'Processed through row', '处理至第几列'])} {stringValue(batch.checkpoint_row)} · {label(['已合併', 'Merged', '已合并'])} {stringValue(batch.merged_rows) || '0'} · {label(['已略過', 'Skipped', '已略过'])} {stringValue(batch.skipped_rows) || '0'} · {label(['失敗', 'Failed', '失败'])} {stringValue(batch.failed_rows) || '0'}</p>}
      <div className="action-row">
        {confirm && <button className="primary" disabled={request.pending} onClick={() => setConfirmation('confirm')}>{merging ? label(['繼續合併', 'Continue merge', '继续合并']) : t('importConfirm')}</button>}
        {cancel && <button disabled={request.pending} onClick={() => setConfirmation('cancel')}>{label(['取消批次', 'Cancel batch', '取消批量'])}</button>}
        {findOperation(api, 'GET', `${batchPath}/error-file`) && <button disabled={request.pending} onClick={() => void download()}>{label(['下載錯誤 CSV', 'Download error CSV', '下载错误 CSV'])}</button>}
      </div>
      {findOperation(api, 'POST', '/imports') && <CorrectedImport batch={batch} id={id} />}
      {confirmation && <form className="fields" onSubmit={applyConfirmation} key={confirmation}>
        <fieldset disabled={request.pending}>
          <label className="check"><input type="checkbox" required />{confirmation === 'confirm' ? label(['我已檢查預覽。合併會略過無效或重複列。', 'I reviewed the preview. Invalid and duplicate rows will be skipped.', '我已检查预览。合并会略过无效或重复列。']) : label(['我確認捨棄此預覽。', 'I confirm that this preview can be discarded.', '我确认舍弃此预览。'])}</label>
          <div className="action-row"><button className="primary" type="submit">{request.pending ? t('saving') : confirmation === 'confirm' ? t('importConfirm') : label(['確認取消', 'Confirm cancellation', '确认取消'])}</button><button type="button" onClick={() => setConfirmation(undefined)}>{t('close')}</button></div>
        </fieldset>
      </form>}
      {request.error !== undefined && <ProblemNotice error={request.error} />}
      {remap && <details><summary>{t('importMapping')}</summary><form className="fields" onSubmit={applyMapping} key={versionOf(batch)}><fieldset disabled={request.pending}>
        {strings(batch.header).map((header, index) => <label className="field" key={header}>{header}<select name={`mapping-${index}`} defaultValue={stringValue(mapping[header])}>
          <option value="">{label(['略過此欄位', 'Ignore this column', '略过此字段'])}</option>{columns.map(column => <option key={column}>{column}</option>)}
        </select></label>)}
        <button type="submit">{label(['重新產生預覽', 'Regenerate preview', '重新产生预览'])}</button>
      </fieldset></form></details>}
    </section>
    <section className="detail-block"><div className="toolbar"><h3>{t('importRows')}</h3><select aria-label={t('status')} value={filter} onChange={event => { setFilter(event.target.value); setOffset(0); }}>
      <option value="">{label(['所有結果', 'All results', '所有结果'])}</option>{outcomes.map(status => <option key={status} value={status}>{t(`state.${status}`, { defaultValue: status.replaceAll('_', ' ') })}</option>)}
    </select></div>
      <ReadState read={read} />
      {read.data && (rows.length ? <EntityTable records={rows} rowKey={row => stringValue(row.row_no)} columns={[
        { label: label(['檔案列', 'CSV row', '文件列']), cell: row => stringValue(row.row_no) },
        { label: t('status'), cell: row => <Status value={row.status} /> },
        { label: label(['欄位與問題', 'Fields and issues', '字段与问题']), cell: row => <>
          {records(row.issues).map((issue, index) => <p key={index}>{problemSummary(locale, stringValue(issue.code)) ?? stringValue(issue.message ?? issue.code)}</p>)}
          <details><summary>{t('details')}</summary><dl>{Object.entries(asRecord(row.normalized ?? row.raw)).map(([field, value]) => <div key={field}><dt>{field}</dt><dd>{stringValue(value) || '—'}</dd></div>)}</dl></details>
        </> },
      ]} /> : <EmptyState title={t('empty')} />)}
      {(offset > 0 || rows.length === pageSize) && <div className="pagination"><button disabled={!offset} onClick={() => setOffset(offset - pageSize)}>{t('previousPeriod')}</button><button disabled={rows.length < pageSize} onClick={() => setOffset(offset + pageSize)}>{t('next')}</button></div>}
    </section>
  </>;
}
