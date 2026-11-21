import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { actions } from './action-index';
import { api, type Command, type Entity, type Payload } from './workbench-api';
import { asEntity, values } from './workbench-data';
import { Failure, recordName, Status, useFormat } from './workbench-ui';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { callOperation, findOperation, ProblemNotice, recordRows, rowTitle, stringValue, useApi, useRead, versionOf, wsKey } from './api';
import { useCopy } from './i18n';
import './workbench-content.css';

const translationStatuses: Record<string, readonly [string, string, string?]> = {
  source_changed: ['來源已變更，待重審', 'Source changed · Review required', '来源已变更，待重审'],
  needs_review: ['術語已變更，待重審', 'Glossary changed · Review required', '术语已变更，待重审'],
  accepted_divergence: ['已保留市場改寫', 'Market rewrite retained', '已保留市场改写'],
  in_sync: ['已審閱來源', 'Source reviewed', '已审阅来源'],
};
const validationMessages: Record<string, readonly [string, string, string?]> = {
  alt_text_unsupported: ['此平台與格式不支援替代文字，工作稿仍會保留。', 'This platform and format do not support alt text. The draft retains it.', '此平台与格式不支持替代文字，工作稿仍会保留。'],
  captions_unsupported: ['此平台與格式不支援字幕檔，工作稿仍會保留。', 'This platform and format do not support caption files. The draft retains them.', '此平台与格式不支持字幕档，工作稿仍会保留。'],
  rendition_not_ready: ['素材衍生檔尚未就緒。', 'The media rendition is not ready.', '素材衍生档尚未就绪。'],
  tiktok_privacy_required: ['請人員選擇 TikTok 隱私設定。', 'Select TikTok privacy manually.', '请人员选择 TikTok 隐私设置。'],
  tiktok_commercial_disclosure_required: ['請人員選擇 TikTok 商業內容揭露。', 'Select TikTok commercial disclosure manually.', '请人员选择 TikTok 商业内容揭露。'],
};

function TranslationStatus({ link }: { link: Entity }) {
  const { label } = useFormat();
  const status = String(link.data.status);
  return <span className={`wb-status ${['source_changed', 'needs_review'].includes(status) ? 'warn' : 'neutral'}`}>{label('state', status, translationStatuses[status])}</span>;
}

export function ContentDetails({ row, detail, commands, open, select }: {
  row: Entity; detail: Payload; commands: Command[]; open: (command: Command, record: Entity) => void; select: (record: Entity) => void;
}) {
  const { label, t } = useFormat();
  const copy = (zh: string, en: string, hans?: string) => label('content', '', [zh, en, hans]);
  if (row.kind === 'content_item') {
    const variants = values(detail.variants) as Payload[];
    return <>
      {typeof row.data.derived_from_item_id === 'string' && <p>{copy('來源內容', 'Source content', '来源内容')} <code>{row.data.derived_from_item_id}</code></p>}
      {Boolean(variants.length) && <section><h3>{copy('內容變體', 'Content variants', '内容变体')}</h3><ul>{variants.map(entry => {
        const variant = asEntity(entry.variant, 'content', 'content_variant');
        if (!variant) return null;
        const link = asEntity(entry.translation_link, 'content', 'translation_link');
        return <li key={variant.id} className="wb-content-variant"><button className="wb-text" onClick={() => select(variant)}>{[variant.data.platform, variant.data.locale, variant.data.market_id].filter(Boolean).join(' · ')}</button>{link && <TranslationStatus link={link} />}</li>;
      })}</ul></section>}
    </>;
  }
  if (row.kind !== 'content_variant') return null;
  const preview = detail.preview as Payload | undefined;
  const link = asEntity(detail.translation_link, 'content', 'translation_link');
  const reviewActions = ['content_accept_source_change', 'content_mark_divergence'];
  const issues = values(detail.issues) as Payload[];
  const warnings = values(row.data.reuse_warnings) as Payload[];
  const revisionText = typeof row.data.derived_from_revision_id === 'string' ? row.data.derived_from_revision_id : '';
  return <>
    {revisionText && <p>{copy('來源修訂', 'Source revision', '来源修订')} <code>{revisionText}</code></p>}
    {link && <section><h3>{copy('翻譯審閱', 'Translation review', '翻译审阅')}</h3><TranslationStatus link={link} />
      {['source_changed', 'needs_review'].includes(String(link.data.status)) && typeof detail.translation_source_revision_id === 'string' && <div className="wb-inline-actions">
        {commands.filter(command => command.module === 'content' && reviewActions.includes(command.action)).map(command => <button key={command.action} onClick={() => open(command, { ...link, data: { ...link.data, source_revision_id: detail.translation_source_revision_id } })}>{label('command', command.action, actions[`content.${command.action}`].label)}</button>)}
      </div>}
    </section>}
    {preview?.approximate === true && <section><h3>{copy('近似發布預覽', 'Approximate publishing preview', '近似发布预览')}</h3><p className="wb-content-preview">{String(preview.text ?? '')}</p></section>}
    {Boolean(issues.length) && <section><h3>{copy('工作稿驗證', 'Draft validation', '工作稿验证')}</h3><ul>{issues.map((issue, index) => <li key={index}><strong>{label('state', String(issue.severity))}</strong> {label('issue', String(issue.code), validationMessages[String(issue.code)])}{typeof issue.field === 'string' && <> <code>{issue.field}</code></>}</li>)}</ul></section>}
    {Boolean(warnings.length) && <section><h3>{copy('複用檢查', 'Reuse checks', '复用检查')}</h3><ul>{warnings.map((warning, index) => <li key={index}>{warning.code === 'asset_removed'
      ? <>{copy('授權重檢未通過，已移除素材', 'Asset removed after rights recheck', '授权重检未通过，已移除素材')} <code>{String(warning.asset_version_id)}</code></>
      : <details><summary>{copy('商品引用已變更，請審閱文案', 'Product reference changed · Review the copy', '商品引用已变更，请审阅文案')}</summary><dl><dt>{copy('複用前', 'Before reuse', '复用前')}</dt><dd><pre>{JSON.stringify(warning.before, null, 2)}</pre></dd><dt>{copy('複用後', 'After reuse', '复用后')}</dt><dd><pre>{JSON.stringify(warning.after, null, 2)}</pre></dd></dl></details>}</li>)}</ul></section>}
    <FactReferences refs={(row.data.draft_doc as Payload | undefined)?.product_refs} label={pair => label('content', '', pair)} />
    {typeof row.data.current_revision_id === 'string' && <p>{t('field.version')} <code>{row.data.current_revision_id}</code></p>}
  </>;
}

const productionStages = ['accepted', 'drafting', 'design', 'awaiting_assets', 'internal_review', 'ready', 'archived'];
export function ContentBoard({ wid, rows, commands, select }: { wid: string; rows: Entity[]; commands: Command[]; select: (row: Entity) => void }) {
  const { label } = useFormat();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<unknown>();
  const [moving, setMoving] = useState(false);
  const move = commands.find(command => command.module === 'content' && command.action === 'content_set_stage');
  async function drop(id: string, stage: string) {
    const row = rows.find(row => row.id === id);
    if (!move || !row || moving || row.data.production_stage === stage) return;
    setMoving(true);
    setFailure(undefined);
    try {
      await api.execute(wid, move, { content_item_id: row.id, expected_version: row.version, to: stage }, crypto.randomUUID());
    } catch (error) {
      setFailure(error);
    } finally {
      await queryClient.invalidateQueries({ queryKey: ['workspace', wid] });
      setMoving(false);
    }
  }
  return <>{failure != null && <Failure error={failure} />}<div className="wb-content-board">{productionStages.map(stage => <section key={stage} aria-label={label('state', stage)}
    onDragOver={event => { if (move && !moving && event.dataTransfer.types.includes('text/plain')) event.preventDefault(); }}
    onDrop={event => { event.preventDefault(); void drop(event.dataTransfer.getData('text/plain'), stage); }}>
    <h3><Status value={stage} /></h3>
    {rows.filter(row => row.data.production_stage === stage).map(row => <article key={row.id} draggable={Boolean(move) && !moving} onDragStart={event => event.dataTransfer.setData('text/plain', row.id)}>
      <button className="wb-text" onClick={() => select(row)}>{recordName(row)}</button>
      {typeof row.data.blocked_reason === 'string' && row.data.blocked_reason.trim() && <p><strong>{label('field', 'blocked_reason', ['阻塞原因', 'Blocker reason'])}</strong> {row.data.blocked_reason}</p>}
    </article>)}
  </section>)}</div></>;
}

const productPicker = {
  fact: {
    path: '/content-variants/:id/product-facts',
    title: ['插入商品事實', 'Insert product fact', '插入商品事实'],
    field: ['已核准商品事實', 'Approved product fact', '已核准商品事实'],
    empty: ['此商品沒有可插入的事實。', 'This product has no facts available to insert.', '此商品没有可插入的事实。'],
    saved: ['已將商品事實加入工作稿。', 'Product fact added to the working draft.', '已将商品事实加入工作稿。'],
  },
  price: {
    path: '/content-variants/:id/product-prices',
    title: ['插入地區售價', 'Insert market price', '插入地区售价'],
    field: ['可引用的地區售價', 'Eligible market price', '可引用的地区售价'],
    empty: ['此商品在內容所選市場沒有可引用的售價。換匯估計不可插入。', 'This product has no eligible price in the content market. Exchange-rate estimates cannot be inserted.', '此商品在内容所选市场没有可引用的售价。换汇估计不可插入。'],
    saved: ['已將地區售價加入工作稿。', 'Market price added to the working draft.', '已将地区售价加入工作稿。'],
  },
} as const;
const factChoiceKey = (row: RecordData) => `${row.variant_id}:${row.fact_revision_id}`;

function FactReferences({ refs, label }: { refs: unknown; label: (pair: readonly [string, string, string?]) => string }) {
  const facts = (recordRows(refs) ?? []).filter(ref => ref.fact_revision_id);
  if (!facts.length) return null;
  return <section aria-label={label(['商品事實引用', 'Product fact references', '商品事实引用'])}>
    <h3>{label(['商品事實引用', 'Product fact references', '商品事实引用'])}</h3>
    <ul>{facts.map((ref, index) => <li key={`${factChoiceKey(ref)}:${index}`}>
      <strong>{stringValue(ref.fact_key ?? ref.field)}</strong> {stringValue(ref.inserted_text)}
      <dl>
        <dt>{label(['事實修訂', 'Fact revision', '事实修订'])}</dt><dd>{ref.fact_revision_no != null && <>#{stringValue(ref.fact_revision_no)} · </>}<code>{stringValue(ref.fact_revision_id)}</code></dd>
        {typeof ref.collected_at === 'string' && <><dt>{label(['採集時間', 'Collected at', '采集时间'])}</dt><dd><time dateTime={ref.collected_at}>{ref.collected_at}</time></dd></>}
      </dl>
    </li>)}</ul>
  </section>;
}

export function ContentFactWorkbench({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const refs = asRecord(record.draft_doc).product_refs;
  const prices = (recordRows(refs) ?? []).filter(ref => ref.listing_snapshot_id && ref.field === 'price');
  return <>
    <FactReferences refs={refs} label={label} />
    {prices.length > 0 && <section aria-label={label(['地區售價引用', 'Market price references', '地区售价引用'])}>
      <h3>{label(['地區售價引用', 'Market price references', '地区售价引用'])}</h3>
      <ul>{prices.map((price, index) => <li key={`${price.listing_snapshot_id}:${index}`}>
        <strong>{stringValue(price.inserted_text)}</strong> <code>{stringValue(price.listing_snapshot_id)}</code>
      </li>)}</ul>
    </section>}
    <ContentProductPicker record={record} kind="fact" />
    <ContentProductPicker record={record} kind="price" />
  </>;
}

function ContentProductPicker({ record, kind }: { record: RecordData; kind: keyof typeof productPicker }) {
  const picker = productPicker[kind];
  const keyOf = (row: RecordData) => kind === 'fact' ? factChoiceKey(row) : stringValue(row.listing_snapshot_id);
  const api = useApi();
  const { t, label } = useCopy();
  const client = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [productId, setProductId] = useState('');
  const [choiceKey, setChoiceKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  const attempt = useRef<{ fingerprint: string; key: string }>(undefined);
  const variantId = stringValue(record.id);
  const brandId = stringValue(record.brand_id);
  const version = versionOf(record);
  const operation = findOperation(api, 'POST', picker.path, 'content');
  const products = useRead('/products', [], { brand_id: brandId }, expanded ? 'commerce' : '__disabled__');
  const available = useRead(picker.path, [expanded && productId ? variantId : ''], { product_id: productId }, 'content');
  const choices = recordRows(available.data?.data) ?? [];
  const choice = choices.find(row => keyOf(row) === choiceKey);

  async function insert() {
    if (!operation || !choice || !version || saving) return;
    const body = kind === 'fact' ? { product_variant_id: choice.variant_id, fact_revision_id: choice.fact_revision_id }
      : { listing_snapshot_id: choice.listing_snapshot_id };
    const fingerprint = JSON.stringify([variantId, version, body]);
    if (attempt.current?.fingerprint !== fingerprint) attempt.current = { fingerprint, key: crypto.randomUUID() };
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      await callOperation(api, operation, [variantId], { body, version, key: attempt.current.key });
      attempt.current = undefined;
      setChoiceKey('');
      setSaved(true);
    } catch (failure) {
      setError(failure);
    } finally {
      await client.invalidateQueries({ queryKey: wsKey(api.ws) });
      setSaving(false);
    }
  }

  if (!operation || !brandId) return null;
  return <section className="detail-block" aria-label={label(picker.title)}>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{label(picker.title)}</button>
      {expanded && <div>
        <label>{label(['商品', 'Product'])}<select value={productId} disabled={saving} onChange={event => {
          setProductId(event.target.value); setChoiceKey(''); setError(undefined); setSaved(false);
        }}><option value="">{t('select')}</option>{(recordRows(products.data?.data) ?? []).map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{rowTitle(row)}</option>)}</select></label>
        {products.isError && <ProblemNotice error={products.error} retry={() => void products.refetch()} />}
        {productId && <>
          <label>{label(picker.field)}<select value={choiceKey} disabled={saving || available.isFetching} onChange={event => {
            setChoiceKey(event.target.value); setError(undefined); setSaved(false);
          }}><option value="">{t('select')}</option>{choices.map(row => <option key={keyOf(row)} value={keyOf(row)}>
            {stringValue(kind === 'fact' ? row.fact_key : row.channel)} · {stringValue(row.sku)} · {stringValue(row.inserted_text)}
          </option>)}</select></label>
          {available.isError && <ProblemNotice error={available.error} retry={() => void available.refetch()} />}
          {available.isSuccess && !choices.length && <p>{label(picker.empty)}</p>}
          {kind === 'fact' && choice && <FactReferences refs={[choice]} label={label} />}
          <button type="button" disabled={saving || available.isFetching || !choice || !version} onClick={() => void insert()}>{saving ? t('saving') : label(['加入工作稿', 'Add to working draft'])}</button>
        </>}
        {error != null && <ProblemNotice error={error} />}
        {saved && <p role="status">{label(picker.saved)}</p>}
      </div>}
  </section>;
}
