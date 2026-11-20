import { useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, Panel } from '@smartsell/ui';
import { findOperation, ProblemNotice, ReadState, rowTitle, stringValue, useApi, useRead } from './api';
import { useCopy } from './i18n';
import { records, safeUrl, Status, Timestamp, useWorkflowRequest } from './workflow-view-ui';

const candidatePath = '/product-candidates/:id';
const mentionPath = '/mentions/:id';
const dimensions = {
  demand_evidence: ['需求證據', 'Demand evidence'],
  competition: ['競爭情況', 'Competition'],
  product_fit: ['商品適配度', 'Product fit'],
  supply_feasibility: ['供應可行性', 'Supply feasibility'],
} as const;
type Dimension = keyof typeof dimensions;
const transitions: Record<string, string[]> = {
  proposed: ['researching'], researching: ['validating', 'parked'], validating: ['accepted', 'rejected'],
  parked: ['researching'], rejected: ['researching'],
};
const transitionNames: Record<string, readonly [string, string]> = {
  researching: ['開始研究', 'Start research'], validating: ['送交驗證', 'Move to validation'],
  parked: ['暫擱候選商品', 'Park candidate'], accepted: ['採納候選商品', 'Accept candidate'], rejected: ['淘汰候選商品', 'Reject candidate'],
};
const estimatedCost = ['估算成本', 'Estimated cost'] as const;
const actualQuote = ['實際報價', 'Actual quote'] as const;
const decisionReason = ['決策理由', 'Decision reason'] as const;
const supplyNotes = ['供應備註', 'Supply notes'] as const;
const evidence = ['研究證據', 'Research evidence'] as const;
const watchTargetLabel = ['監測目標', 'Watch target'] as const;
const sourceLabel = ['來源', 'Source'] as const;
const sampleLabel = ['樣本數', 'Sample size'] as const;
const coverageLabel = ['覆蓋說明', 'Coverage'] as const;
const manualLabel = ['人工', 'Manual'] as const;
const dash = '—';

const text = (form: FormData, name: string) => stringValue(form.get(name)).trim();
const list = (value: unknown): string[] => Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
const splitIds = (value: string) => value.split(/[,\n]/).map(id => id.trim()).filter(Boolean);
const formData = (event: FormEvent<HTMLFormElement>) => new FormData(event.currentTarget);

function Table({ title, headings, children }: { title: string; headings: string[]; children: ReactNode }) {
  return <div className="table-scroll"><table className="entity-table" aria-label={title}>
    <thead><tr>{headings.map(heading => <th key={heading} scope="col">{heading}</th>)}</tr></thead>
    <tbody>{children}</tbody>
  </table></div>;
}

function Actions({ pending, submit, close }: { pending: boolean; submit?: string; close?: () => void }) {
  const { t } = useCopy();
  return <div className="action-row">
    <button className="primary" type="submit">{pending ? t('saving') : submit ?? t('save')}</button>
    {close && <button type="button" onClick={close}>{t('cancel')}</button>}
  </div>;
}

function Money({ value }: { value: unknown }) {
  const { locale } = useCopy();
  const { amount_minor, currency } = asRecord(value);
  if (typeof amount_minor !== 'number' || typeof currency !== 'string') return <>{dash}</>;
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency, currencyDisplay: 'code' });
  return <>{format.format(amount_minor / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2))}</>;
}

function MoneyFields({ name, legend, min, max }: { name: string; legend: string; min: unknown; max?: RecordData }) {
  const { label } = useCopy();
  const money = asRecord(min);
  return <div className="message" role="group" aria-label={legend}>
    <strong>{legend}</strong>
    <label className="field">{max ? label(['最低金額（最小貨幣單位）', 'Minimum amount (minor units)']) : label(['金額（最小貨幣單位）', 'Amount (minor units)'])}
      <input name={`${name}_min`} type="number" min="0" step="1" defaultValue={stringValue(money.amount_minor)} />
    </label>
    {max && <label className="field">{label(['最高金額（最小貨幣單位）', 'Maximum amount (minor units)'])}
      <input name={`${name}_max`} type="number" min="0" step="1" defaultValue={stringValue(max.amount_minor)} />
    </label>}
    <label className="field">{label(['貨幣代碼', 'Currency code'])}
      <input name={`${name}_currency`} maxLength={3} pattern="[A-Za-z]{3}" placeholder="USD" defaultValue={stringValue(money.currency)} />
    </label>
  </div>;
}

function CandidateEdit({ record, close }: { record: RecordData; close: () => void }) {
  const { label } = useCopy();
  const request = useWorkflowRequest();
  const [versioned] = useState(record);
  const [invalidMoney, setInvalidMoney] = useState(false);
  const range = asRecord(versioned.price_range);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formData(event);
    function readMoney(field: string, range = false) {
      const min = text(form, `${field}_min`);
      const max = text(form, `${field}_max`);
      const currency = text(form, `${field}_currency`).toUpperCase();
      if (!min && !max && !currency) return null;
      if (!currency || !min || (range && (!max || Number(max) < Number(min)))) return undefined;
      const amount = { amount_minor: Number(min), currency };
      return range ? { min: amount, max: { amount_minor: Number(max), currency } } : amount;
    }
    const estimate = readMoney('estimated_cost');
    const quote = readMoney('actual_quote');
    const priceRange = readMoney('price_range', true);
    const invalid = [estimate, quote, priceRange].includes(undefined);
    setInvalidMoney(invalid);
    if (invalid) return;
    const result = await request.run('PATCH', candidatePath, [stringValue(versioned.id)], {
      name: text(form, 'name'), market_ids: splitIds(text(form, 'market_ids')), supply_notes: text(form, 'supply_notes') || null,
      price_range: priceRange, estimated_cost: estimate, actual_quote: quote,
    }, versioned);
    if (result) close();
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset disabled={request.pending}>
      <label className="field">{label(['候選商品名稱', 'Candidate name'])}<input name="name" required maxLength={250} defaultValue={stringValue(versioned.name)} /></label>
      <label className="field">{label(['市場 ID（以逗號分隔）', 'Market IDs (comma-separated)'])}<input name="market_ids" defaultValue={list(versioned.market_ids).join(', ')} /></label>
      <label className="field">{label(supplyNotes)}<textarea name="supply_notes" maxLength={4000} defaultValue={stringValue(versioned.supply_notes)} /></label>
      <MoneyFields name="price_range" legend={label(['價格區間', 'Price range'])} min={range.min} max={asRecord(range.max)} />
      <MoneyFields name="estimated_cost" legend={label(estimatedCost)} min={versioned.estimated_cost} />
      <MoneyFields name="actual_quote" legend={label(actualQuote)} min={versioned.actual_quote} />
      {invalidMoney && <p className="problem" role="alert">{label(['請填寫各組金額及貨幣代碼，並確認區間由低至高。清除金額時請將該組欄位留空。', 'Enter each amount with its currency code and check that ranges are in ascending order. Leave all fields in a group blank to clear it.'])}</p>}
      <Actions pending={request.pending} close={close} />
    </fieldset>
    {request.error != null && <ProblemNotice error={request.error} />}
  </form>;
}

function ScoreEdit({ record, dimension, score, close }: { record: RecordData; dimension: Dimension; score: RecordData; close: () => void }) {
  const { label } = useCopy();
  const request = useWorkflowRequest();
  const [versioned] = useState(record);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formData(event);
    if (await request.run('POST', `${candidatePath}/scores`, [stringValue(versioned.id)], {
      dimension, score: Number(text(form, 'score')), uncertainty: Number(text(form, 'uncertainty')),
      evidence_item_ids: splitIds(text(form, 'evidence_item_ids')), is_estimate: form.has('is_estimate'),
    }, versioned)) close();
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset disabled={request.pending}>
      <legend>{label(dimensions[dimension])}</legend>
      <label className="field">{label(['分數（0–100）', 'Score (0–100)'])}<input name="score" type="number" step="any" min="0" max="100" required defaultValue={stringValue(score.score)} /></label>
      <label className="field">{label(['不確定性（0–1）', 'Uncertainty (0–1)'])}<input name="uncertainty" type="number" step="any" min="0" max="1" required defaultValue={stringValue(score.uncertainty)} /></label>
      <label className="field">{label(['研究項目 ID（每行一筆）', 'Research item IDs (one per line)'])}<textarea name="evidence_item_ids" defaultValue={list(score.evidence_item_ids).join('\n')} /></label>
      <label className="check"><input name="is_estimate" type="checkbox" defaultChecked={score.is_estimate === true} />{label(['估算評分', 'Estimated score'])}</label>
      <Actions pending={request.pending} close={close} />
    </fieldset>
    {request.error != null && <ProblemNotice error={request.error} />}
  </form>;
}

function AcceptProductFields({ record, createDraft }: { record: RecordData; createDraft: boolean }) {
  const { label, t } = useCopy();
  const brand = stringValue(record.brand_id);
  const read = useRead(createDraft ? '/stores' : '/products', [], brand ? { brand_id: brand } : {}, 'commerce');
  const options = records(read.data?.data).filter(row => (!brand || row.brand_id === brand) && (createDraft || ['active', 'draft'].includes(stringValue(row.status))));
  return <>
    <ReadState read={read} />
    <label className="field">{createDraft ? label(['草稿店鋪', 'Draft store']) : label(['現有商品', 'Existing product'])}
      <select name={createDraft ? 'store_id' : 'linked_product_id'} required defaultValue="">
        <option value="">{read.data && options.length === 0 ? label(['沒有符合條件的選項', 'No eligible options']) : t('select')}</option>
        {options.map(row => <option key={stringValue(row.id)} value={stringValue(row.id)}>{rowTitle(row)}</option>)}
      </select>
    </label>
    {createDraft && <label className="field">{label(['草稿商品名稱', 'Product draft title'])}<input name="draft_title" defaultValue={stringValue(record.name)} maxLength={250} required /></label>}
  </>;
}

function CandidateTransition({ record, next, close }: { record: RecordData; next: string; close: () => void }) {
  const api = useApi();
  const { label } = useCopy();
  const request = useWorkflowRequest();
  const [versioned] = useState(record);
  const [createDraft, setCreateDraft] = useState(false);
  const final = next === 'accepted' || next === 'rejected';
  const reopening = versioned.status === 'rejected';
  const action = reopening ? label(['重新開啟研究', 'Reopen research']) : label(transitionNames[next]!);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formData(event);
    const reason = text(form, 'decision_reason');
    const body: RecordData = { status: next, decision_reason: reason || null };
    if (reopening) body.evidence_item_ids = splitIds(text(form, 'evidence_item_ids'));
    if (next === 'accepted') {
      if (createDraft) body.product_draft = { store_id: text(form, 'store_id'), title: text(form, 'draft_title') };
      else body.linked_product_id = text(form, 'linked_product_id');
    }
    if (await request.run(final ? 'POST' : 'PATCH', final ? `${candidatePath}/decide` : candidatePath, [stringValue(versioned.id)], body, versioned)) close();
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset disabled={request.pending}>
      <legend>{action}</legend>
      <label className="field">{label(decisionReason)}<textarea name="decision_reason" required={final} maxLength={4000} /></label>
      {reopening && <label className="field">{label(['新增研究項目 ID（每行一筆）', 'New research item IDs (one per line)'])}<textarea name="evidence_item_ids" required /></label>}
      {next === 'accepted' && <>
        {findOperation(api, 'POST', '/products', 'commerce') && <label className="field">{label(['商品連結方式', 'Product link method'])}
          <select value={createDraft ? 'draft' : 'existing'} onChange={event => setCreateDraft(event.target.value === 'draft')}>
            <option value="existing">{label(['連結現有商品', 'Link existing product'])}</option>
            <option value="draft">{label(['建立商品草稿', 'Create product draft'])}</option>
          </select>
        </label>}
        <AcceptProductFields key={String(createDraft)} record={versioned} createDraft={createDraft} />
      </>}
      <Actions pending={request.pending} submit={action} close={close} />
    </fieldset>
    {request.error != null && <ProblemNotice error={request.error} />}
  </form>;
}

export function IntelCandidate({ record }: { record: RecordData }) {
  return <CandidateDetail key={stringValue(record.id)} record={record} />;
}

function CandidateDetail({ record }: { record: RecordData }) {
  const api = useApi();
  const { label, t } = useCopy();
  const [form, setForm] = useState<{ kind: 'edit' } | { kind: 'score'; dimension: Dimension } | { kind: 'transition'; next: string }>();
  const close = () => setForm(undefined);
  const status = stringValue(record.status);
  const id = stringValue(record.id);
  const productId = stringValue(record.linked_product_id);
  const scores = records(record.scores);
  const scoredDimensions = new Set(scores.filter(row => list(row.evidence_item_ids).length > 0).map(row => row.dimension));
  const patch = id && findOperation(api, 'PATCH', candidatePath, 'intel');
  const edit = patch && !['accepted', 'rejected'].includes(status);
  const score = id && ['researching', 'validating'].includes(status) && findOperation(api, 'POST', `${candidatePath}/scores`, 'intel');
  const decide = id && findOperation(api, 'POST', `${candidatePath}/decide`, 'intel');
  const nextStatuses = (transitions[status] ?? []).filter(next => ['accepted', 'rejected'].includes(next) ? decide : patch);
  const range = asRecord(record.price_range);
  return <>
    <section className="detail-block">
      <h3>{label(['成本與供應', 'Costs and supply'])} · <Status value={status} /></h3>
      <Table title={label(['候選商品成本', 'Candidate costs'])} headings={[label(estimatedCost), label(actualQuote), label(['價格區間', 'Price range'])]}>
        <tr><td><Money value={record.estimated_cost} /></td><td><Money value={record.actual_quote} /></td><td>{range.min && range.max ? <><Money value={range.min} /> – <Money value={range.max} /></> : dash}</td></tr>
      </Table>
      <dl>
        <dt>{label(supplyNotes)}</dt><dd>{stringValue(record.supply_notes) || dash}</dd>
        <dt>{label(['市場', 'Markets'])}</dt><dd>{list(record.market_ids).join(', ') || dash}</dd>
      </dl>
      {edit && (form?.kind === 'edit' ? <CandidateEdit record={record} close={close} /> :
        <button type="button" disabled={!!form} onClick={() => setForm({ kind: 'edit' })}>{label(['編輯候選商品', 'Edit candidate'])}</button>)}
    </section>
    <section className="detail-block">
      <h3>{label(['四維評分', 'Candidate scores'])}</h3>
      <Table title={label(['四維評分', 'Candidate scores'])} headings={[label(['評分維度', 'Dimension']), label(['分數', 'Score']), label(['不確定性', 'Uncertainty']), label(evidence), ...(score ? [t('operation')] : [])]}>
        {(Object.keys(dimensions) as Dimension[]).map(dimension => {
          const value = scores.find(row => row.dimension === dimension) ?? {};
          const name = label(dimensions[dimension]);
          return <tr key={dimension}>
            <th scope="row">{name}</th><td>{stringValue(value.score) || dash}{value.is_estimate === true && <small> · {label(['估算', 'Estimate'])}</small>}</td>
            <td>{stringValue(value.uncertainty) || dash}</td><td>{list(value.evidence_item_ids).join(', ') || dash}</td>
            {score && <td><button type="button" aria-label={`${t('edit')} ${name}`} disabled={!!form} onClick={() => setForm({ kind: 'score', dimension })}>{t('edit')}</button></td>}
          </tr>;
        })}
      </Table>
      {form?.kind === 'score' && <ScoreEdit key={form.dimension} record={record} dimension={form.dimension} score={scores.find(item => item.dimension === form.dimension) ?? {}} close={close} />}
    </section>
    <section className="detail-block">
      <h3>{label(['候選商品決策', 'Candidate decision'])}</h3>
      <dl>
        <dt>{label(decisionReason)}</dt><dd>{stringValue(record.decision_reason) || dash}</dd>
        <dt>{label(['決策時間', 'Decision date'])}</dt><dd><Timestamp value={record.decided_at} /></dd>
        <dt>{label(['已連結商品', 'Linked product'])}</dt><dd>{productId ? <Link to={`/w/${encodeURIComponent(api.ws)}/commerce/products/${encodeURIComponent(productId)}`}>{productId}</Link> : dash}</dd>
      </dl>
      {nextStatuses.includes('validating') && scoredDimensions.size < 2 && <p className="notice">{label(['須有至少兩個維度附研究證據，才能送交驗證。', 'Add research evidence to at least two score dimensions to move to validation.'])}</p>}
      {form?.kind === 'transition' ? <CandidateTransition key={form.next} record={record} next={form.next} close={close} /> :
        <div className="action-row">{nextStatuses.map(next => <button type="button" key={next} disabled={!!form || (next === 'validating' && scoredDimensions.size < 2)} onClick={() => setForm({ kind: 'transition', next })}>
          {status === 'rejected' ? label(['重新開啟研究', 'Reopen research']) : label(transitionNames[next]!)}
        </button>)}</div>}
    </section>
  </>;
}

const labelTypes = {
  sentiment: ['情緒', 'Sentiment'], intent: ['意圖', 'Intent'], topic: ['主題', 'Topic'],
} as const;
type LabelType = keyof typeof labelTypes;
const sentiments = {
  positive: ['正面', 'Positive'], negative: ['負面', 'Negative'], neutral: ['中立', 'Neutral'],
  mixed: ['混合', 'Mixed'], uncertain: ['不確定', 'Uncertain'],
} as const;
const labelHistoryTitle = ['標註歷史', 'Label history'] as const;
const voiceTitle = ['聲量占比', 'Share of voice'] as const;

function labelValue(row: RecordData, label: ReturnType<typeof useCopy>['label'], field = 'value') {
  const value = stringValue(row[field]);
  const sentiment = row.label_type === 'sentiment' && sentiments[value as keyof typeof sentiments];
  return sentiment ? label(sentiment) : value || dash;
}

function LabelHistory({ id }: { id: string }) {
  const { label, locale } = useCopy();
  const read = useRead(`${mentionPath}/labels`, [id], {}, 'intel');
  const labels = records(read.data?.data).sort((first, second) => stringValue(second.created_at).localeCompare(stringValue(first.created_at)));
  const superseded = new Set(labels.map(row => row.overrides_label_id).filter(Boolean));
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return <>
    <ReadState read={read} />
    {read.data && (labels.length ? <Table title={label(labelHistoryTitle)} headings={[
      label(['類型', 'Type']), label(['標註值', 'Label value']), label(['原始模型值', 'Raw model value']),
      label(['作者', 'Author']), label(['信心', 'Confidence']), label(['狀態', 'Status']), label(['時間', 'Time']),
    ]}>
      {labels.map(row => <tr key={stringValue(row.id)}>
        <th scope="row">{label(labelTypes[row.label_type as LabelType] ?? labelTypes.topic)}</th>
        <td>{labelValue(row, label)}</td><td>{labelValue(row, label, 'raw_value')}</td>
        <td>{row.labeled_by === 'model' ? label(['模型', 'Model']) : label(manualLabel)}{row.model_ref != null && <><br />{stringValue(row.model_ref)}</>}</td>
        <td>{typeof row.confidence === 'number' ? percent.format(row.confidence) : dash}</td>
        <td>{superseded.has(row.id) ? label(['已被取代', 'Superseded']) : label(['目前標註', 'Current'])}</td>
        <td><Timestamp value={row.created_at} /></td>
      </tr>)}
    </Table> : <p>{label(['尚無標註。', 'No labels yet.'])}</p>)}
  </>;
}

function MentionLabelForm({ row, close }: { row: RecordData; close: () => void }) {
  const { label } = useCopy();
  const request = useWorkflowRequest();
  const [versioned] = useState(row);
  const [type, setType] = useState<LabelType>('sentiment');
  const previous = records(versioned.labels).find(item => item.label_type === type);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formData(event);
    const value = text(form, 'value');
    const confidence = text(form, 'confidence');
    if (await request.run('PATCH', `${mentionPath}/labels`, [stringValue(versioned.id)], {
      label_type: type, value, ...(confidence && { confidence: Number(confidence) }),
      ...(previous && { overrides_label_id: previous.id }),
    }, versioned)) close();
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset disabled={request.pending}>
      <legend>{label(['人工標註', 'Manual label'])}</legend>
      <label className="field">{label(['標註類型', 'Label type'])}<select value={type} onChange={event => setType(event.target.value as LabelType)}>
        {(Object.keys(labelTypes) as LabelType[]).map(key => <option key={key} value={key}>{label(labelTypes[key])}</option>)}
      </select></label>
      <label className="field">{label(['標註值', 'Label value'])}{type === 'sentiment' ? <select name="value" defaultValue={stringValue(previous?.value) || 'uncertain'}>
        {(Object.keys(sentiments) as Array<keyof typeof sentiments>).map(key => <option key={key} value={key}>{label(sentiments[key])}</option>)}
      </select> : <input key={type} name="value" defaultValue={stringValue(previous?.value)} required maxLength={200} />}</label>
      <label className="field">{label(['信心（0–1，選填）', 'Confidence (0–1, optional)'])}<input type="number" name="confidence" min="0" max="1" step="any" /></label>
      {previous && <p>{label(['這次標註將取代目前值，原標註會保留在歷史中。', 'This label replaces the current value and keeps it in the history.'])}</p>}
      <Actions pending={request.pending} submit={label(['儲存標註', 'Save label'])} close={close} />
    </fieldset>
    {request.error != null && <ProblemNotice error={request.error} />}
  </form>;
}

function MentionEscalation({ row, close }: { row: RecordData; close: () => void }) {
  const { label } = useCopy();
  const request = useWorkflowRequest();
  const [versioned] = useState(row);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formData(event);
    if (await request.run('POST', `${mentionPath}/escalate`, [stringValue(versioned.id)], {
      title: text(form, 'title'), ...(text(form, 'assignee_id') && { assignee_id: text(form, 'assignee_id') }),
    }, versioned)) close();
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset disabled={request.pending}>
      <legend>{label(['建立後續工作項目', 'Create follow-up work item'])}</legend>
      <label className="field">{label(['工作項目標題', 'Work item title'])}<input name="title" required maxLength={200} defaultValue={label(['檢視品牌提及', 'Review monitored brand mention'])} /></label>
      <label className="field">{label(['負責人 ID（選填）', 'Assignee ID (optional)'])}<input name="assignee_id" maxLength={200} /></label>
      <Actions pending={request.pending} submit={label(['建立工作項目', 'Create work item'])} close={close} />
    </fieldset>
    {request.error != null && <ProblemNotice error={request.error} />}
  </form>;
}

function MentionRow({ row, target }: { row: RecordData; target: string }) {
  const api = useApi();
  const { label, t } = useCopy();
  const request = useWorkflowRequest();
  const [form, setForm] = useState<'label' | 'escalate'>();
  const [history, setHistory] = useState(false);
  const [queued, setQueued] = useState(false);
  const id = stringValue(row.id);
  const escalated = stringValue(row.escalated_to);
  const labels = records(row.labels);
  const content = asRecord(row.untrusted_content);
  const link = safeUrl(content.url);
  const excerpt = stringValue(content.text_excerpt);
  const showClassification = row.classification_available === true && findOperation(api, 'POST', `${mentionPath}/classify`, 'intel');
  const close = () => setForm(undefined);
  return <article className="message" id={`mention-${id}`} aria-label={`${label(['提及', 'Mention'])} ${id}`}>
    <strong>{target || stringValue(row.platform)}</strong> · <Timestamp value={row.observed_at} />
    <p>{excerpt || label(['沒有可顯示的摘錄。', 'No excerpt available.'])}</p>
    <p>{label(sourceLabel)} · {stringValue(row.platform) || dash} / {stringValue(asRecord(row.source).data_source_id) || label(manualLabel)}</p>
    {link && <a href={link} target="_blank" rel="noopener noreferrer">{label(['開啟原文', 'Open source post'])}</a>}
    {labels.length > 0 && <ul aria-label={label(['目前標註', 'Current labels'])}>{labels.map(item => <li key={stringValue(item.id)}>
      {label(labelTypes[item.label_type as LabelType] ?? labelTypes.topic)} · {labelValue(item, label)}
    </li>)}</ul>}
    {escalated && <p>{label(['已升級為', 'Escalated to'])} <Link to={`/w/${encodeURIComponent(api.ws)}/settings/brands?${new URLSearchParams({ tab: 'work', id: escalated })}`}>{label(['後續工作項目', 'Follow-up work item'])}</Link></p>}
    <div className="action-row">
      {findOperation(api, 'PATCH', `${mentionPath}/labels`, 'intel') && <button type="button" disabled={!!form || request.pending} onClick={() => setForm('label')}>{label(['人工標註', 'Manual label'])}</button>}
      {!escalated && findOperation(api, 'POST', `${mentionPath}/escalate`, 'intel') && <button type="button" disabled={!!form || request.pending} onClick={() => setForm('escalate')}>{label(['升級提及', 'Escalate mention'])}</button>}
      {showClassification && !queued && <button type="button" disabled={!!form || request.pending} onClick={async () => {
        const result = await request.run('POST', `${mentionPath}/classify`, [id], {}, row);
        if (result) { setQueued(true); setHistory(true); }
      }}>{request.pending ? t('saving') : label(['使用模型分類', 'Classify with model'])}</button>}
    </div>
    {queued && !labels.some(item => item.label_type === 'sentiment') && <p role="status">{label(['分類已排入佇列。請重新整理提及以查看結果。', 'Classification queued. Refresh mentions to see the result.'])}</p>}
    {request.error != null && <ProblemNotice error={request.error} />}
    {form === 'label' && <MentionLabelForm row={row} close={() => { close(); setHistory(true); }} />}
    {form === 'escalate' && <MentionEscalation row={row} close={close} />}
    {findOperation(api, 'GET', `${mentionPath}/labels`, 'intel') && <details open={history} onToggle={event => setHistory(event.currentTarget.open)}>
      <summary>{label(labelHistoryTitle)}</summary>
      {history && <LabelHistory id={id} />}
    </details>}
  </article>;
}

type Options = Array<{ id: string; title: string }>;

function ListeningQuery({ voice, targets, sources, apply }: { voice?: boolean; targets: Options; sources: Options; apply: (query: Record<string, string>) => void }) {
  const { label } = useCopy();
  const [badPeriod, setBadPeriod] = useState(false);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = formData(event);
    const from = text(form, 'from');
    const to = text(form, 'to');
    const invalid = !!from && !!to && Date.parse(from) >= Date.parse(to);
    setBadPeriod(invalid);
    if (invalid) return;
    const query: Record<string, string> = {};
    if (from) query.from = new Date(from).toISOString();
    if (to) query.to = new Date(to).toISOString();
    for (const key of ['keyword', 'platform', 'label']) {
      const value = text(form, key);
      if (value) query[key] = value;
    }
    for (const key of ['watch_target_ids', 'sources']) {
      const selected = form.getAll(key).map(stringValue).filter(Boolean);
      if (selected.length) query[key] = selected.join(',');
    }
    apply(query);
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset>
      <label className="field">{voice ? label(['監測目標（可複選）', 'Watch targets (multiple)']) : label(watchTargetLabel)}
        <select name="watch_target_ids" multiple={voice} required={voice} defaultValue={voice ? [] : ''}>
          {!voice && <option value="">{label(['所有監測目標', 'All watch targets'])}</option>}
          {targets.map(target => <option key={target.id} value={target.id}>{target.title}</option>)}
        </select>
      </label>
      <label className="field">{voice ? label(['來源（可複選）', 'Sources (multiple)']) : label(sourceLabel)}
        <select name="sources" multiple={voice} required={voice} defaultValue={voice ? ['manual'] : ''}>
          {!voice && <option value="">{label(['所有可用來源', 'All available sources'])}</option>}
          {sources.map(source => <option key={source.id} value={source.id}>{source.title}</option>)}
        </select>
      </label>
      <label className="field">{label(['觀測起點（含）', 'Observed from (inclusive)'])}<input name="from" type="datetime-local" step="1" required={voice} /></label>
      <label className="field">{label(['觀測終點（不含）', 'Observed to (exclusive)'])}<input name="to" type="datetime-local" step="1" required={voice} /></label>
      <label className="field">{label(['關鍵字', 'Keyword'])}<input name="keyword" type="search" maxLength={200} /></label>
      {!voice && <>
        <label className="field">{label(['平台', 'Platform'])}<input name="platform" maxLength={100} /></label>
        <label className="field">{label(['目前標註值', 'Current label value'])}<input name="label" maxLength={200} placeholder="negative" /></label>
      </>}
      {badPeriod && <p className="problem" role="alert">{label(['觀測終點須晚於起點。', 'The end of the observation period must follow the start.'])}</p>}
      <div className="action-row">
        <button className="primary" type="submit">{voice ? label(['計算聲量占比', 'Compute share of voice']) : label(['查詢提及', 'Query mentions'])}</button>
        {!voice && <button type="reset" onClick={() => { setBadPeriod(false); apply({}); }}>{label(['清除篩選', 'Clear filters'])}</button>}
      </div>
    </fieldset>
  </form>;
}

function QueryDefinition({ value, targets, sources }: { value: unknown; targets: Options; sources: Options }) {
  const { label } = useCopy();
  const definition = asRecord(value);
  const period = asRecord(definition.period);
  const targetName = (id: string) => targets.find(option => option.id === id)?.title || id;
  const specified = (key: string, options: Options) => list(definition[key]).map(id => options.find(option => option.id === id)?.title || id).join(', ');
  return <details>
    <summary>{label(['查詢定義', 'Query definition'])}</summary>
    <dl>
      <dt>{label(['觀測期間', 'Observation period'])}</dt><dd><Timestamp value={period.from} /> – <Timestamp value={period.to} /></dd>
      <dt>{label(watchTargetLabel)}</dt><dd>{specified('watch_target_ids', targets) || label(['所有監測目標', 'All watch targets'])}</dd>
      <dt>{label(sourceLabel)}</dt><dd>{specified('sources', sources) || label(['所有可用來源', 'All available sources'])}</dd>
      <dt>{label(['關鍵字', 'Keyword'])}</dt><dd>{stringValue(definition.keyword) || dash}</dd>
      {Object.hasOwn(definition, 'platform') && <><dt>{label(['平台', 'Platform'])}</dt><dd>{stringValue(definition.platform) || dash}</dd></>}
      {Object.hasOwn(definition, 'label') && <><dt>{label(['目前標註值', 'Current label value'])}</dt><dd>{stringValue(definition.label) || dash}</dd></>}
    </dl>
    {records(definition.queries).map(row => <section key={stringValue(row.id)}>
      <strong>{targetName(stringValue(row.id))} · {label(['版本', 'Version'])} {stringValue(row.version)}</strong>
      <pre className="json">{JSON.stringify(row.query, null, 2)}</pre>
    </section>)}
  </details>;
}

function ShareOfVoice({ query, targets, sources, brands }: { query: Record<string, string>; targets: Options; sources: Options; brands: Options }) {
  const { label, locale } = useCopy();
  const read = useRead('/share-of-voice', [], query, 'intel');
  const data = asRecord(read.data?.data);
  const shares = asRecord(data.shares);
  const ids = list(data.evidence_mention_ids);
  const percent = new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 1 });
  return <>
    <ReadState read={read} />
    {read.data && <>
      <p><strong>{label(sampleLabel)}</strong> · {stringValue(data.sample_size) || dash}</p>
      <p><strong>{label(coverageLabel)}</strong> · {stringValue(data.coverage_note) || dash}</p>
      <p><strong>{label(['計算時間', 'As of'])}</strong> · <Timestamp value={data.as_of} /></p>
      <QueryDefinition value={data.query_definition} targets={targets} sources={sources} />
      <Table title={label(voiceTitle)} headings={[label(['品牌', 'Brand']), label(['樣本筆數', 'Sample count']), label(['占比', 'Share'])]}>
        {Object.entries(asRecord(data.brand_counts)).map(([id, count]) => <tr key={id}>
          <th scope="row">{brands.find(brand => brand.id === id)?.title || id}</th><td>{stringValue(count)}</td>
          <td>{typeof shares[id] === 'number' ? percent.format(shares[id]) : dash}</td>
        </tr>)}
      </Table>
      <details><summary>{label(['佐證提及 ID', 'Evidence mention IDs'])} ({ids.length})</summary>
        {ids.length ? <ul>{ids.map(id => <li key={id}>{id}</li>)}</ul> : <p>{label(['此樣本沒有提及。', 'No mentions in this sample.'])}</p>}
      </details>
    </>}
  </>;
}

function options(rows: RecordData[]): Options {
  return rows.map(row => ({ id: stringValue(row.id), title: rowTitle(row) })).filter(option => option.id);
}

export function IntelListening() {
  const { label, t } = useCopy();
  const [query, setQuery] = useState<Record<string, string>>({});
  const [voiceQuery, setVoiceQuery] = useState<Record<string, string>>();
  const mentions = useRead('/mentions', [], query, 'intel');
  const watch = useRead('/watch-targets', [], {}, 'intel');
  const sourceData = useRead('/data-sources');
  const brands = useRead('/brands', [], {}, 'workspace');
  const voice = findOperation(useApi(), 'GET', '/share-of-voice', 'intel');
  const data = asRecord(mentions.data?.data);
  const rows = records(data.items);
  const watchRows = records(watch.data?.data);
  const targets = options(watchRows);
  const sources = new Map<string, string>([['manual', label(manualLabel)]]);
  for (const option of options(records(sourceData.data?.data))) sources.set(option.id, option.title);
  for (const id of [...list(data.sample_sources), ...watchRows.map(row => stringValue(row.data_source_id)).filter(Boolean)]) {
    if (!sources.has(id)) sources.set(id, id);
  }
  const sourceOptions = Array.from(sources, ([id, title]) => ({ id, title }));
  return <div className="record-layout">
    <Panel>
      <div className="panel-head"><h2>{label(['提及查詢', 'Mention search'])}</h2>
        {mentions.op && <button type="button" onClick={() => void mentions.refetch()} disabled={mentions.isFetching}>{t('refresh')}</button>}
      </div>
      <div className="detail-body">
        {watch.op && <ReadState read={watch} />}
        {mentions.op && <ListeningQuery targets={targets} sources={sourceOptions} apply={setQuery} />}
        <ReadState read={mentions} />
        {mentions.data && <section className="detail-block">
          <p><strong>{label(sampleLabel)}</strong> · {stringValue(data.sample_size) || dash}</p>
          <p><strong>{label(['樣本來源', 'Sample sources'])}</strong> · {list(data.sample_sources).map(id => sources.get(id) ?? id).join(', ') || dash}</p>
          <p><strong>{label(coverageLabel)}</strong> · {stringValue(data.coverage_note) || dash}</p>
          <QueryDefinition value={data.query_definition} targets={targets} sources={sourceOptions} />
          {typeof data.sample_size === 'number' && data.sample_size > rows.length && <p>{label(['僅顯示前', 'Showing the first'])} {rows.length} {label(['筆提及。', 'mentions.'])}</p>}
          {rows.length ? rows.map(row => <MentionRow row={row} target={targets.find(target => target.id === row.watch_target_id)?.title ?? ''} key={stringValue(row.id)} />) :
            <EmptyState title={label(['沒有符合條件的提及', 'No matching mentions'])} />}
        </section>}
      </div>
    </Panel>
    {voice && <Panel>
      <div className="panel-head"><h2>{label(voiceTitle)}</h2></div>
      <div className="detail-body">
        <ListeningQuery voice targets={options(watchRows.filter(row => row.brand_id))} sources={sourceOptions} apply={setVoiceQuery} />
        {voiceQuery && <section className="detail-block"><ShareOfVoice query={voiceQuery} targets={targets} sources={sourceOptions} brands={options(records(brands.data?.data))} /></section>}
      </div>
    </Panel>}
  </div>;
}
