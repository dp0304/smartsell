import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Busy, Drawer, EmptyState, EntityTable, Panel } from '@smartsell/ui';
import { asRecord, type Method, type RecordData } from '@smartsell/sdk';
import { Link } from 'react-router-dom';
import { callOperation, entity, findOperation, ProblemNotice, ReadState, recordRows, rowTitle, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';
import { Status, Timestamp } from './workflow-view-ui';

const mappingLabel = ['SKU 對照', 'SKU mapping', 'SKU 对照'] as const;
export const productSearchLabel = ['依名稱、代稱或 SKU 搜尋', 'Search by title, handle, or SKU', '依名称、代称或 SKU 搜索'] as const;
const productPath = (wid: string, id: string) => `/w/${encodeURIComponent(wid)}/commerce/products/${encodeURIComponent(id)}`;
const show = (value: unknown) => typeof value === 'string' && value ? value : '—';
const readText = (fields: FormData, key: string) => String(fields.get(key) ?? '').trim();
const variantList = (value: unknown) => recordRows(value) ?? [];
const idOf = (row: RecordData) => String(row.id ?? '');
function useCommerceList(path: string, module: string) {
  const api = useApi();
  const op = findOperation(api, 'GET', path, module);
  const read = useQuery({
    queryKey: [...wsKey(api.ws), 'commerce-list', path], enabled: Boolean(op),
    queryFn: async ({ signal }) => {
      const result: RecordData[] = [];
      let cursor: string | null | undefined;
      do {
        const page = await callOperation(api, op!, [], { query: { limit: '200', ...(cursor && { cursor }) }, signal });
        result.push(...recordRows(page.data) ?? []);
        cursor = page.next_cursor;
      } while (cursor);
      return result;
    },
  });
  return { op, ...read };
}

export function useCatalogQuery(search: string) {
  const [query, setQuery] = useState(search.trim());
  useEffect(() => {
    if (!search.trim()) { setQuery(''); return; }
    const timer = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  return query;
}

export function CommerceForm({ path, method = 'POST', ids = [], version, title, children, body, close, saved }: {
  path: string; method?: Method; ids?: string[]; version?: string | number; title: string; children: ReactNode;
  body: (fields: FormData) => RecordData; close: () => void; saved?: (result: RecordData) => void;
}) {
  const { t, label } = useCopy();
  const api = useApi();
  const op = findOperation(api, method, path, 'commerce');
  const client = useQueryClient();
  const previous = useRef<{ signature: string; key: string }>(undefined);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [failure, setFailure] = useState<unknown>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !op) return;
    setInvalid(false);
    setFailure(undefined);
    let data: RecordData;
    try { data = body(new FormData(event.currentTarget)); }
    catch { setInvalid(true); return; }
    const signature = JSON.stringify(data);
    if (previous.current?.signature !== signature) previous.current = { signature, key: crypto.randomUUID() };
    busy.current = true;
    setPending(true);
    try {
      const result = await callOperation(api, op, ids, { body: data, key: previous.current.key, version });
      await client.invalidateQueries({ queryKey: wsKey(api.ws) });
      close();
      saved?.(entity(result.data));
    } catch (error) {
      setFailure(error);
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  return <Drawer title={title} closeLabel={t('close')} onClose={() => { if (!busy.current) close(); }}>
    <form className="fields" onSubmit={submit}><fieldset disabled={pending || !op}>{children}
      {invalid && <p className="problem" role="alert">{label(['請檢查欄位內容。', 'Check the field values.', '请检查字段内容。'])}</p>}
      {failure != null && <ProblemNotice error={failure} />}
      <button className="primary" type="submit">{pending ? t('saving') : title}</button>
    </fieldset></form>
  </Drawer>;
}

type MappingSheet = { kind: 'create' } | { kind: 'link'; group: RecordData } | { kind: 'split'; member: RecordData };
export function MappingWorkspace() {
  const { t, label } = useCopy();
  const api = useApi();
  const wid = api.ws;
  const [sheet, setSheet] = useState<MappingSheet>();
  const [selected, setSelected] = useState('');
  const groups = useCommerceList('/variant-groups', 'commerce');
  const brands = useCommerceList('/brands', 'workspace');
  const stores = useCommerceList('/stores', 'commerce');
  const canCreate = Boolean(findOperation(api, 'POST', '/variant-groups', 'commerce'));
  const canLink = Boolean(findOperation(api, 'POST', '/variant-groups/:id/members', 'commerce'));
  const canSplit = Boolean(findOperation(api, 'DELETE', '/variant-groups/:id/members/:memberId', 'commerce'));
  const rows = groups.data ?? [];
  const group = rows.find(row => row.id === selected) ?? rows[0];
  const members = recordRows(group?.members) ?? [];
  const active = members.filter(row => !row.unlinked_at);
  const history = members.filter(row => row.unlinked_at).sort((a, b) => String(b.unlinked_at).localeCompare(String(a.unlinked_at)));
  const linked = new Set(rows.flatMap(row => (recordRows(row.members) ?? []).filter(member => !member.unlinked_at).map(member => member.variant_id)));
  const create = label(['建立對照群組', 'Create mapping group', '创建对照群组']);
  const link = label(['連結變體', 'Link variant', '链接变体']);
  const split = label(['拆分對照', 'Split mapping', '拆分对照']);
  const reason = label(['拆分原因', 'Split reason']);
  const variant = label(['商品變體', 'Product variant', '商品变体']);
  const labelOf = (list: RecordData[] | undefined, id: unknown) => {
    const row = list?.find(row => row.id === id);
    return row ? rowTitle(row) : show(id);
  };
  const baseColumns = [
    { label: variant, cell: (row: RecordData) => {
      const title = show(row.sku ?? row.variant_id);
      return typeof row.product_id === 'string' ? <Link to={productPath(wid, row.product_id)}>{title}</Link> : title;
    } },
    { label: label(['店鋪', 'Store', '店铺']), cell: (row: RecordData) => labelOf(stores.data, row.store_id) },
    { label: label(['連結時間', 'Linked at', '链接时间']), cell: (row: RecordData) => <Timestamp value={row.created_at} /> },
    { label: label(['連結人員', 'Linked by', '链接人员']), cell: (row: RecordData) => show(row.linked_by) },
    { label: label(['對照依據', 'Mapping evidence', '对照依据']), cell: (row: RecordData) => show(row.evidence) },
  ];
  const close = () => setSheet(undefined);
  return <>
    <Panel>
      <header className="panel-head"><h2>{label(mappingLabel)}</h2>{groups.op && canCreate && <button className="primary" onClick={() => setSheet({ kind: 'create' })}>{create}</button>}</header>
      {!groups.op ? <EmptyState title={t('noAccess')} /> : groups.isPending ? <Busy label={t('loading')} /> : groups.isError ? <ProblemNotice error={groups.error} retry={() => void groups.refetch()} /> : !group ? <EmptyState title={t('empty')} />
        : <div className="panel-head"><label className="field">{label(['對照群組', 'Mapping group', '对照群组'])}<select value={idOf(group)} onChange={event => setSelected(event.target.value)}>
          {rows.map(row => <option key={idOf(row)} value={idOf(row)}>{rowTitle(row)} · {labelOf(brands.data, row.brand_id)}</option>)}
        </select></label>{group.note != null && <span>{show(group.note)}</span>}</div>}
    </Panel>
    {group && <>
      <MappingSuggestions key={idOf(group)} group={group} stores={stores.data ?? []} />
      <Panel><header className="panel-head"><h2>{label(['有效對照', 'Active mappings', '有效对照'])}</h2>{canLink && <button onClick={() => setSheet({ kind: 'link', group })}>{link}</button>}</header>
        {active.length ? <EntityTable records={active} rowKey={idOf} columns={[
          ...baseColumns, ...(canSplit ? [{ label: label(['操作', 'Action']), cell: (member: RecordData) => <button onClick={() => setSheet({ kind: 'split', member })}>{split}</button> }] : []),
        ]} /> : <EmptyState title={t('empty')} />}
      </Panel>
      <Panel><header className="panel-head"><h2>{label(['對照歷史', 'Mapping history', '对照历史'])}</h2></header>
        {history.length ? <EntityTable records={history} rowKey={idOf} columns={[
          ...baseColumns,
          { label: label(['拆分時間', 'Split at', '拆分时间']), cell: row => <Timestamp value={row.unlinked_at} /> },
          { label: label(['拆分人員', 'Split by', '拆分人员']), cell: row => show(row.unlinked_by) },
          { label: reason, cell: row => show(row.unlink_reason) },
        ]} /> : <EmptyState title={t('empty')} />}
      </Panel>
    </>}
    {sheet?.kind === 'create' && <CommerceForm title={create} path="/variant-groups" close={close} saved={result => { if (typeof result.id === 'string') setSelected(result.id); }} body={fields => {
      const name = readText(fields, 'name');
      const brand_id = readText(fields, 'brand_id');
      if (!name || !brand_id) throw new Error();
      const note = readText(fields, 'note');
      return { name, brand_id, ...(note && { note }) };
    }}>
      <label className="field">{label(['群組名稱', 'Group name', '群组名称'])}<input name="name" required /></label>
      <label className="field">{label(['品牌', 'Brand'])}<select name="brand_id" aria-label={label(['品牌', 'Brand'])} required><option value="">{t('select')}</option>
        {brands.data?.map(brand => <option key={idOf(brand)} value={idOf(brand)}>{rowTitle(brand)}</option>)}
      </select></label>
      {!brands.op ? <EmptyState title={t('noAccess')} /> : brands.isPending ? <Busy label={t('loading')} /> : brands.isError ? <ProblemNotice error={brands.error} retry={() => void brands.refetch()} /> : null}
      <label className="field">{label(['備註', 'Note', '备注'])}<textarea name="note" rows={3} /></label>
    </CommerceForm>}
    {sheet?.kind === 'link' && <CommerceForm title={link} path="/variant-groups/:id/members" ids={[idOf(sheet.group)]} close={close} body={fields => {
      const variant_id = readText(fields, 'variant_id');
      if (!variant_id || linked.has(variant_id)) throw new Error();
      const evidence = readText(fields, 'evidence');
      return { variant_id, ...(evidence && { evidence }) };
    }}>
      <p>{rowTitle(sheet.group)}</p>
      <MappingVariantPicker group={sheet.group} stores={stores.data ?? []} linked={linked} />
      <label className="field">{label(['對照依據', 'Mapping evidence', '对照依据'])}<textarea name="evidence" rows={3} /></label>
    </CommerceForm>}
    {sheet?.kind === 'split' && <CommerceForm title={split} path="/variant-groups/:id/members/:memberId" ids={[String(sheet.member.group_id), idOf(sheet.member)]} method="DELETE" close={close} body={fields => {
      const reason = readText(fields, 'reason');
      if (!reason) throw new Error();
      return { reason };
    }}>
      <p>{show(sheet.member.sku ?? sheet.member.variant_id)} · {labelOf(stores.data, sheet.member.store_id)}</p>
      <label className="field">{reason}<textarea name="reason" rows={3} required /></label>
    </CommerceForm>}
  </>;
}

function MappingSuggestions({ group, stores }: { group: RecordData; stores: RecordData[] }) {
  const { label } = useCopy();
  const api = useApi();
  const read = useCommerceList('/variant-groups/suggestions', 'commerce');
  const [review, setReview] = useState(false);
  const suggestions = (read.data ?? []).filter(row => row.brand_id === group.brand_id);
  const path = '/variant-groups/:id/members/batch';
  const title = label(['審查條碼對照', 'Review barcode matches', '审查条码对照']);
  const sameBarcode = label(['相同條碼', 'Same barcode', '相同条码']);
  return <Panel><header className="panel-head"><h2>{label(['對照建議', 'Mapping suggestions', '对照建议'])}</h2>
    <button disabled={!suggestions.length || !findOperation(api, 'POST', path, 'commerce')} onClick={() => setReview(true)}>{title}</button></header>
    {!read.isPending && !suggestions.length && <EmptyState title={label(['無可審查建議', 'No matches to review', '无可审查建议'])} />}
    {read.isError && <ProblemNotice error={read.error} retry={() => void read.refetch()} />}
    {review && <CommerceForm title={title} path={path} ids={[idOf(group)]} close={() => setReview(false)} body={form => {
      const ids = new Set(form.getAll('suggestion'));
      const selected = suggestions.filter(row => ids.has(row.id as string));
      if (!selected.length) throw new Error();
      const members = new Map<string, RecordData>();
      for (const row of selected) for (const variant of variantList(row.variants)) {
        members.set(idOf(variant), { variant_id: variant.id, evidence: `barcode:${String(row.barcode)}` });
      }
      return { members: [...members.values()], linked_via: 'suggestion_accepted' };
    }}>
      {suggestions.map(row => <label className="check" key={idOf(row)}>
        <input type="checkbox" name="suggestion" value={idOf(row)} /> {sameBarcode} {String(row.barcode)} · {variantList(row.variants).map(variant =>
          `${stores.find(store => store.id === variant.store_id)?.name ?? variant.store_id} / ${variant.sku ?? variant.id}`).join(' ↔ ')}
      </label>)}
    </CommerceForm>}
  </Panel>;
}

function MappingVariantPicker({ group, stores, linked }: {
  group: RecordData; stores: RecordData[]; linked: Set<unknown>;
}) {
  const { t, label } = useCopy();
  const [search, setSearch] = useState('');
  const [productId, setProductId] = useState('');
  const query = useCatalogQuery(search);
  const products = useRead('/products', [], { ...(query && { query }), ...(typeof group.brand_id === 'string' ? { brand_id: group.brand_id } : {}), limit: '200' }, 'commerce');
  const picked = useRead('/products/:id', [productId], {}, 'commerce');
  const options = variantList(asRecord(picked.data?.data).variants).filter(variant => !linked.has(variant.id));
  const searchLabel = label(productSearchLabel);
  return <>
    <label className="field">{searchLabel}<input type="search" value={search} onChange={event => { setSearch(event.target.value); setProductId(''); }} /></label>
    <ReadState read={products} />
    <label className="field">{label(['商品', 'Product'])}<select aria-label={label(['商品', 'Product'])} value={productId} disabled={products.isPending || query !== search.trim()} onChange={event => setProductId(event.target.value)}>
      <option value="">{t('select')}</option>
      {recordRows(products.data?.data)?.filter(row => !group.brand_id || row.brand_id === group.brand_id).map(row => <option key={idOf(row)} value={idOf(row)}>
        {rowTitle(row)} · {show(stores.find(store => store.id === row.store_id)?.name ?? row.store_id)}
      </option>)}
    </select></label>
    {productId && <ReadState read={picked} />}
    <label className="field">{label(['商品變體', 'Product variant', '商品变体'])}<select key={productId} name="variant_id" required>
      <option value="">{t('select')}</option>
      {options.map(row => <option key={idOf(row)} value={idOf(row)}>{variantName(row)} · {idOf(row)}</option>)}
    </select></label>
    {picked.isSuccess && !options.length && <p role="status">{label(['此商品沒有可連結的變體。', 'This product has no variants available to link.', '此商品没有可链接的变体。'])}</p>}
  </>;
}

function variantOptions(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? Object.entries(value).filter(([, value]) => typeof value === 'string') as [string, string][] : [];
}
function variantName(row: RecordData) {
  return [row.sku, ...variantOptions(row.options).map(([key, value]) => `${key}: ${value}`)].filter(Boolean).join(' · ') || idOf(row);
}

export function ProductDetail({ product }: { product: RecordData }) {
  const { t, label } = useCopy();
  const [editing, setEditing] = useState<RecordData | 'new'>();
  const api = useApi();
  const variants = variantList(product.variants);
  const canAdd = Boolean(findOperation(api, 'POST', '/products/:id/variants', 'commerce'));
  const canEdit = Boolean(findOperation(api, 'PATCH', '/variants/:id', 'commerce'));
  const add = label(['新增變體', 'Add variant', '添加变体']);
  const edit = label(['編輯變體', 'Edit variant', '编辑变体']);
  const optionsLabel = label(['變體選項', 'Variant options', '变体选项']);
  return <>
    <section className="detail-block"><h3>{label(['商品變體', 'Product variants', '商品变体'])}</h3>
      {canAdd && <button onClick={() => setEditing('new')}>{add}</button>}
      {variants.length ? <EntityTable records={variants} rowKey={idOf} columns={[
        { label: 'SKU', cell: row => show(row.sku) },
        { label: label(['條碼', 'Barcode', '条码']), cell: row => show(row.barcode) },
        { label: optionsLabel, cell: row => variantOptions(row.options).map(([key, value]) => `${key}: ${value}`).join(' · ') || '—' },
        { label: t('status'), cell: row => <Status value={row.status} /> },
        ...(canEdit ? [{ label: label(['操作', 'Action']), cell: (row: RecordData) => <button onClick={() => setEditing(row)}>{edit}</button> }] : []),
      ]} /> : <EmptyState title={t('empty')} />}
    </section>
    <ListingPreflight product={product} variants={variants} />
    <ProductUsage key={idOf(product)} product={product} variants={variants} />
    {editing && <VariantForm product={product} row={editing === 'new' ? undefined : editing} title={editing === 'new' ? add : edit} close={() => setEditing(undefined)} />}
  </>;
}

function ListingPreflight({ product, variants }: { product: RecordData; variants: RecordData[] }) {
  const { label, locale } = useCopy();
  const markets = useCommerceList('/markets', 'workspace');
  const listings = variantList(product.listings);
  const missing = <span className="pill warning">{label(['未取得', 'Not obtained'])}</span>;
  return <section className="detail-block">
    <h3>{label(['地區價格與文案預檢', 'Market prices and content preflight', '地区价格与文案预检'])}</h3>
    {!listings.length ? <p>{missing}</p> : <EntityTable records={listings} rowKey={idOf} columns={[
      { label: 'SKU', cell: row => show(variants.find(variant => variant.id === row.variant_id)?.sku ?? row.variant_id) },
      { label: label(['市場', 'Market', '市场']), cell: row => `${show(markets.data?.find(market => market.id === row.market_id)?.name ?? row.market_id)} · ${show(row.channel)}` },
      { label: label(['價格', 'Price', '价格']), cell: row => {
        if (typeof row.price_amount_minor !== 'number' || typeof row.currency !== 'string') return missing;
        const formatter = new Intl.NumberFormat(locale, { style: 'currency', currency: row.currency, currencyDisplay: 'code' });
        return formatter.format(row.price_amount_minor / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
      } },
      { label: label(['文案使用', 'Content use']), cell: row => row.publishable_price === true ? label(['可引用', 'Eligible to reference'])
        : row.is_estimate === true ? label(['換匯估計不可引用', 'Exchange-rate estimate is blocked', '换汇估计不可引用'])
          : row.price_stale === true ? label(['價格已過期', 'Price is stale', '价格已过期']) : label(['尚不可引用', 'Reference unavailable']) },
    ]} />}
  </section>;
}

export function ProductForm({ close, saved }: { close: () => void; saved: (result: RecordData) => void }) {
  const { t, label } = useCopy();
  const api = useApi();
  const stores = useCommerceList('/stores', 'commerce');
  return <CommerceForm title={label(['新增商品', 'Create product', '添加商品'])} path="/products" close={close} saved={saved} body={fields => {
    const title = readText(fields, 'title');
    const store_id = readText(fields, 'store_id');
    if (!title || !store_id) throw new Error();
    return { title, store_id, status: readText(fields, 'status'),
      handle: readText(fields, 'handle') || null, product_type: readText(fields, 'product_type') || null, vendor: readText(fields, 'vendor') || null };
  }}>
    {stores.data && !stores.data.some(store => store.status !== 'disabled') ? <div className="field">{label(['店鋪', 'Store', '店铺'])}<div className="field-empty">
      <span>{label(['商品要掛在店鋪下。請先新增店鋪（可選「檔案匯入」）。', 'Products belong to a store. Create a store first (File import works).', '商品要挂在店铺下。请先添加店铺（可选「文件导入」）。'])}</span>
      <Link to={`/w/${encodeURIComponent(api.ws)}/commerce/stores`} onClick={close}>{label(['前往新增店鋪', 'Create a store', '前往添加店铺'])} →</Link></div></div> :
    <label className="field">{label(['店鋪', 'Store', '店铺'])}<select name="store_id" required defaultValue={stores.data?.filter(store => store.status !== 'disabled').length === 1 ? idOf(stores.data.find(store => store.status !== 'disabled')!) : ''}><option value="">{t('select')}</option>
      {stores.data?.filter(store => store.status !== 'disabled').map(store => <option key={idOf(store)} value={idOf(store)}>{rowTitle(store)}</option>)}
    </select></label>}
    {!stores.op ? <EmptyState title={t('noAccess')} /> : stores.isPending ? <Busy label={t('loading')} /> : stores.isError ? <ProblemNotice error={stores.error} retry={() => void stores.refetch()} /> : null}
    <label className="field">{label(['標題', 'Title', '标题'])}<input name="title" required /></label>
    <label className="field">{label(['商品代稱', 'Product handle', '商品代称'])}<input name="handle" /></label>
    <label className="field">{label(['商品類型', 'Product type', '商品类型'])}<input name="product_type" /></label>
    <label className="field">{label(['供應商', 'Vendor', '供应商'])}<input name="vendor" /></label>
    <label className="field">{t('status')}<select name="status" defaultValue="draft">
      {['draft', 'active', 'archived'].map(value => <option key={value} value={value}>{t(`state.${value}`, { defaultValue: value })}</option>)}
    </select></label>
  </CommerceForm>;
}

function VariantForm({ product, row, title, close }: { product: RecordData; row?: RecordData; title: string; close: () => void }) {
  const { t, label } = useCopy();
  const existingOptions = variantOptions(row?.options);
  return <CommerceForm title={title} path={row ? '/variants/:id' : '/products/:id/variants'} ids={[idOf(row ?? product)]} method={row ? 'PATCH' : 'POST'} version={row ? Number(row.version) : undefined} close={close} body={fields => {
    const options = new Map<string, string>();
    const names = fields.getAll('option_name').map(value => String(value).trim());
    const entries = fields.getAll('option_value').map(value => String(value).trim());
    names.forEach((name, i) => {
      const value = entries[i];
      if (!name && !value) return;
      if (!name || !value || options.has(name)) throw new Error();
      options.set(name, value);
    });
    return { sku: readText(fields, 'sku') || null, barcode: readText(fields, 'barcode') || null,
      options: Object.fromEntries(options), status: readText(fields, 'status') };
  }}>
    <label className="field">SKU<input name="sku" defaultValue={String(row?.sku ?? '')} /></label>
    <label className="field">{label(['條碼', 'Barcode', '条码'])}<input name="barcode" defaultValue={String(row?.barcode ?? '')} /></label>
    <label className="field">{t('status')}<select name="status" defaultValue={row?.status === 'archived' ? 'archived' : 'active'}>
      {['active', 'archived'].map(value => <option key={value} value={value}>{t(`state.${value}`, { defaultValue: value })}</option>)}
    </select></label>
    <VariantOptions initial={existingOptions} />
  </CommerceForm>;
}

function VariantOptions({ initial }: { initial: [string, string][] }) {
  const { label } = useCopy();
  const [rows, setRows] = useState(() => (initial.length ? initial : [['', '']]).map(([name, value], id) => ({ id, name, value })));
  const nextId = useRef(rows.length);
  return <div><h4>{label(['變體選項', 'Variant options', '变体选项'])}</h4>
    {rows.map(row => <div key={idOf(row)} className="action-row">
      <label className="field">{label(['選項名稱', 'Option name', '选项名称'])}<input name="option_name" defaultValue={row.name} /></label>
      <label className="field">{label(['選項值', 'Option value', '选项值'])}<input name="option_value" defaultValue={row.value} /></label>
      <button type="button" onClick={() => setRows(rows => rows.filter(item => item.id !== row.id))}>{label(['移除選項', 'Remove option', '移除选项'])}</button>
    </div>)}
    <button type="button" onClick={() => { const id = nextId.current++; setRows(rows => [...rows, { id, name: '', value: '' }]); }}>{label(['新增選項', 'Add option', '添加选项'])}</button>
  </div>;
}

function ProductUsage({ product, variants }: { product: RecordData; variants: RecordData[] }) {
  const { t, label } = useCopy();
  const { ws: wid } = useApi();
  const [selectedVariantId, setVariantId] = useState('');
  const variantId = variants.some(row => row.id === selectedVariantId) ? selectedVariantId : '';
  const read = useRead('/products/:id/usage', [idOf(product)], {}, 'commerce');
  const usage = asRecord(read.data?.data);
  const scope = `/w/${encodeURIComponent(wid)}`;
  const href = (path: string, tab: string, id: string) => `${scope}/${path}?${new URLSearchParams({ tab, id })}`;
  const campaignLinks = recordRows(usage.campaign_links) ?? [];
  const campaigns = (recordRows(usage.campaigns) ?? []).filter(campaign => !variantId || campaignLinks.some(link =>
    link.campaign_id === campaign.id && (link.variant_ids == null || Array.isArray(link.variant_ids) && link.variant_ids.includes(variantId))));
  const assets = (recordRows(usage.asset_links) ?? []).filter(row => !variantId || row.link_id === variantId || row.link_type === 'product');
  const references = (recordRows(usage.references) ?? []).filter(row => {
    if (!variantId) return true;
    const referencedVariant = row.variant_id ?? (row.ref_type === 'product_variant' ? row.ref_id : undefined);
    return referencedVariant ? referencedVariant === variantId :
      row.product_id === product.id || row.resource_type === 'product' && row.resource_id === product.id || row.ref_type === 'product';
  });
  const targets = (Array.isArray(usage.publish_target_ids) ? usage.publish_target_ids : []).filter((id): id is string => typeof id === 'string');
  return <section className="detail-block"><h3>{label(['商品使用處', 'Product usage', '商品使用处'])}</h3>
    {read.data && variants.length > 0 && <label className="field">{label(['依商品變體查看', 'View usage by variant', '依商品变体查看'])}<select value={variantId} onChange={event => setVariantId(event.target.value)}>
      <option value="">{label(['所有商品使用處', 'All product usage', '所有商品使用处'])}</option>
      {variants.map(row => <option key={idOf(row)} value={idOf(row)}>{variantName(row)}</option>)}
    </select></label>}
    {(!read.op || read.isPending || read.isError) ? <ReadState read={read} /> : !campaigns.length && !assets.length && !references.length && !targets.length ? <EmptyState title={t('empty')} /> : <>
        {campaigns.length > 0 && <section><h4>{label(['活動', 'Campaigns', '活动'])}</h4><ul>{campaigns.map(row => <li key={idOf(row)}><Link to={href('campaigns', 'campaigns', idOf(row))}>{rowTitle(row)}</Link></li>)}</ul></section>}
        {references.length > 0 && <section><h4>{label(['內容引用', 'Content references', '内容引用'])}</h4><ul>{references.map(row => <li key={idOf(row)}>
          {label(['內容修訂', 'Content revision', '内容修订'])} {show(row.revision_id ?? row.content_revision_id ?? row.id)}
          {typeof row.field === 'string' && ` · ${row.field}`}
          {typeof row.inserted_text === 'string' && ` · ${row.inserted_text}`}
        </li>)}</ul></section>}
        {targets.length > 0 && <section><h4>{label(['商品發布目標', 'Product publishing targets', '商品发布目标'])}</h4><ul>{targets.map(id => <li key={id}><Link to={href('calendar', 'targets', id)}>{id}</Link></li>)}</ul></section>}
        {assets.length > 0 && <section><h4>{label(['素材', 'Assets'])}</h4><ul>{assets.map(row => {
          const id = row.asset_id;
          if (typeof id !== 'string') return null;
          return <li key={idOf(row)}><Link to={href('assets', 'assets', id)}>{show(row.asset_title ?? row.asset_name ?? id)}</Link></li>;
        })}</ul></section>}
      </>}
  </section>;
}
