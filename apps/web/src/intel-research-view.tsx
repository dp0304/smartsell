import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { EmptyState, Panel, Pill } from '@smartsell/ui';
import { callOperation, entity, findOperation, ProblemNotice, ReadState, stringValue, useApi, useRead, wsKey } from './api';
import { useCopy } from './i18n';
import type { Label } from './modules';
import { records, safeUrl, Timestamp, useWorkflowRequest } from './workflow-view-ui';

const stances = {
  evidence: ['證據', 'Evidence', '证据'], demand: ['需求', 'Demand'], question: ['疑問', 'Question', '疑问'],
  counter_example: ['反例', 'Counterexample'], hypothesis: ['假設', 'Hypothesis', '假设'],
} satisfies Record<string, Label>;
const kinds: Record<string, Label> = {
  research_item: ['研究項目', 'Research item', '研究项目'], note: ['筆記', 'Note', '笔记'], link: ['連結', 'Link', '链接'],
  observation: ['觀測', 'Observation', '观测'], creative_reference: ['創意參考', 'Creative reference', '创意参考'],
  mention: ['提及', 'Mention'], candidate: ['候選商品', 'Product candidate', '候选商品'], product_candidate: ['候選商品', 'Product candidate', '候选商品'],
};
const authors: Record<string, Label> = {
  human: ['人工', 'Human'], agent: ['Agent', 'Agent'], mixed: ['人工與 Agent', 'Human and Agent', '人工与 Agent'],
};
const text = (form: FormData, field: string) => stringValue(form.get(field)).trim();
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
const idOf = (row: RecordData) => stringValue(row.id);

function SourceLink({ value, showUrl = false }: { value: unknown; showUrl?: boolean }) {
  const { label } = useCopy();
  const href = safeUrl(value);
  return href ? <a href={href} target="_blank" rel="noreferrer noopener">{showUrl ? href : label(['開啟來源', 'Open source', '打开来源'])}</a> : null;
}

function evidenceTitle(row: RecordData) {
  const content = asRecord(row.untrusted_content);
  return stringValue(row.title ?? content.title ?? row.name ?? asRecord(row.attributes ?? content.attributes).title ?? asRecord(row.structure ?? content.structure).topic)
    || safeUrl(row.url ?? content.url) || idOf(row);
}

function EvidenceEntry({ row, kind }: { row: RecordData; kind: string }) {
  const { label } = useCopy();
  const content = asRecord(row.untrusted_content);
  const body = stringValue(row.body ?? row.note ?? row.text_excerpt ?? content.body ?? content.note ?? content.text_excerpt);
  return <>
    <strong>{evidenceTitle(row)}</strong>
    <p><small>{kinds[kind] ? label(kinds[kind]) : kind} · <code>{idOf(row)}</code></small></p>
    {body && <p>{body}</p>}
    {row.observed_at != null && <p>{label(['觀測時間', 'Observed at', '观测时间'])} · <Timestamp value={row.observed_at} /></p>}
    <SourceLink value={row.url ?? content.url} />
  </>;
}

function ExactEvidence({ item }: { item: RecordData }) {
  const { label } = useCopy();
  const read = useRead('/research-items/:id/evidence', [idOf(item)]);
  const result = asRecord(read.data?.data);
  const evidence = records(result.evidence);
  const directIds = new Set([...strings(asRecord(result.item).evidence_refs), stringValue(asRecord(result.item).ref_id)].filter(Boolean));
  return <>
    <ReadState read={read} />
    {read.data && !read.isError && (evidence.length ? <ol>{[...evidence].sort((a, b) => Number(directIds.has(idOf(b))) - Number(directIds.has(idOf(a)))).map(row =>
      <li className="message" key={`${stringValue(row.kind)}:${idOf(row)}`}><EvidenceEntry row={row} kind={stringValue(row.kind)} /></li>)}</ol>
      : <p>{label(['此項目沒有引用其他記錄。', 'This item has no linked citations.', '此项目没有引用其他记录。'])}</p>)}
  </>;
}

function BoardItem({ item, board }: { item: RecordData; board: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const [open, setOpen] = useState(false);
  const stance = stances[stringValue(item.stance) as keyof typeof stances];
  const author = authors[stringValue(item.authorship)] ?? (item.ai_generated === true ? authors.agent : authors.human);
  const hasCitations = Boolean(item.ref_id || strings(item.evidence_refs).length);
  return <article className="message">
    <EvidenceEntry row={item} kind={stringValue(item.item_type)} />
    <p>{stance && <><Pill tone={item.stance === 'hypothesis' ? 'warning' : 'neutral'}>{label(stance)}</Pill>{' '}</>}{label(author)}</p>
    {hasCitations && findOperation(api, 'GET', '/research-items/:id/evidence') && <details onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>{label(['查看精確引證', 'View exact citations', '查看精确引证'])}</summary>
      {open && <ExactEvidence item={item} />}
    </details>}
    <ItemHandoff item={item} board={board} />
  </article>;
}

function ItemHandoff({ item, board }: { item: RecordData; board: RecordData }) {
  const api = useApi();
  const { label } = useCopy();
  const request = useWorkflowRequest();
  const path = '/research-items/:id/convert';
  const converted = asRecord(item.converted_to);
  if (converted.id) return <p>{label(['已轉交', 'Converted', '已转交'])} · {stringValue(converted.resource_type)} · <code>{stringValue(converted.id)}</code></p>;
  if (board.status === 'archived' || !findOperation(api, 'POST', path, 'intel')) return null;
  return <div className="action-row">
    {board.brand_id != null && <button type="button" disabled={request.pending} onClick={() => void request.run('POST', path, [idOf(item)], { destination: 'idea' }, item)}>{label(['轉為選題', 'Convert to content idea', '转为选题'])}</button>}
    {board.campaign_id != null && <button type="button" disabled={request.pending} onClick={() => void request.run('POST', path, [idOf(item)], { destination: 'campaign_hypothesis' }, item)}>{label(['轉為拍攝簡報', 'Convert to production brief', '转为拍摄演示文稿'])}</button>}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </div>;
}

function BoardDigest({ board }: { board: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const request = useWorkflowRequest();
  const [operationId, setOperationId] = useState('');
  const op = findOperation(api, 'GET', '/operations/:id');
  const status = useQuery({
    queryKey: [...wsKey(api.ws), 'research-digest-operation', operationId],
    enabled: Boolean(op && operationId),
    queryFn: async ({ signal }) => asRecord((await callOperation(api, op!, [operationId], { signal })).data),
    refetchInterval: ({ state }) => ['queued', 'running'].includes(stringValue(state.data?.status)) ? 1000 : false,
  });
  const digestId = stringValue(asRecord(status.data?.result_ref).research_digest_id);
  const result = useRead('/research-digests/:id', [digestId], {}, 'intel');
  const digest = result.data?.data;
  const waiting = Boolean(operationId && !status.isError && (!status.data || ['queued', 'running'].includes(stringValue(status.data.status))));
  return <details><summary>{label(['研究簡報匯出', 'Export research digest', '研究演示文稿导出'])}</summary>
    <form className="fields" onSubmit={async event => {
      event.preventDefault();
      setOperationId('');
      const data = new FormData(event.currentTarget);
      const accepted = await request.run('POST', '/research-digests', [], { board_id: idOf(board), period: {
        from: `${text(data, 'from')}T00:00:00Z`, to: `${text(data, 'to')}T00:00:00Z`,
      } }, board);
      setOperationId(stringValue(accepted?.operation_id));
    }}><fieldset disabled={request.pending || waiting}>
      <label className="field">{label(['起始日（UTC）', 'Start date (UTC)'])}<input type="date" name="from" required /></label>
      <label className="field">{label(['結束日（UTC，不含）', 'End date (UTC, exclusive)', '结束日（UTC，不含）'])}<input type="date" name="to" required /></label>
      <button>{label(['產生研究簡報', 'Generate research digest', '产生研究演示文稿'])}</button>
    </fieldset></form>
    {operationId && <p>{label(['作業 ID', 'Operation ID', '作业 ID'])} <code>{operationId}</code></p>}
    {waiting && <p role="status">{label(['正在產生研究簡報', 'Generating research digest', '正在产生研究演示文稿'])}</p>}
    {status.data?.status === 'cancelled' && <p role="status">{label(['研究簡報作業已取消', 'Research digest operation cancelled', '研究演示文稿作业已取消'])}</p>}
    {status.data?.status === 'failed' && <p role="alert">{label(['研究簡報產生失敗', 'Research digest generation failed', '研究演示文稿产生失败'])} {stringValue(status.data.error_code)}</p>}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
    {status.isError && <ProblemNotice error={status.error} retry={status.refetch} />}
    {digestId && <ReadState read={result} />}
    {digest != null && <a download={`research-digest-${digestId}.json`} href={`data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(digest, null, 2))}`}>{label(['下載 JSON', 'Download JSON', '下载 JSON'])}</a>}
  </details>;
}

function BoardNote({ boardId, items, selectedCitations, changeCitation, onSave }: {
  boardId: string; items: RecordData[]; selectedCitations: string[]; changeCitation: (id: string, checked: boolean) => void; onSave: () => void;
}) {
  const { label, t } = useCopy();
  const request = useWorkflowRequest();
  const [saved, setSaved] = useState(false);
  const itemIds = new Set(items.map(idOf));
  const otherCitations = selectedCitations.filter(id => !itemIds.has(id));
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaved(false);
    const form = event.currentTarget;
    const data = new FormData(form);
    const body = text(data, 'body');
    if (!body) return;
    const result = await request.run('POST', '/research-boards/:id/notes', [boardId], {
      title: text(data, 'title') || null, body, stance: text(data, 'stance'), evidence_refs: selectedCitations,
    });
    if (result) { form.reset(); onSave(); setSaved(true); }
  }
  return <section className="detail-block">
    <h3>{label(['新增研究筆記', 'Add research note', '添加研究笔记'])}</h3>
    <form className="fields" onSubmit={submit}>
      <fieldset disabled={request.pending}>
        <label className="field">{label(['標題', 'Title', '标题'])}<input name="title" maxLength={250} /></label>
        <label className="field">{label(['筆記內容', 'Note text', '笔记内容'])}<textarea name="body" required maxLength={4000} rows={3} /></label>
        <label className="field">{label(['分類', 'Stance', '分类'])}<select name="stance" defaultValue="demand">
          {Object.entries(stances).map(([key, copy]) => <option key={key} value={key}>{label(copy)}</option>)}
        </select></label>
        {(items.length > 0 || otherCitations.length > 0) && <details open={selectedCitations.length > 0 || undefined}>
          <summary>{label(['引用研究項目', 'Cite research items', '引用研究项目'])} · {selectedCitations.length}/30</summary>
          {items.map(row => {
            const id = idOf(row);
            const checked = selectedCitations.includes(id);
            return <label className="check" key={id}><input type="checkbox" checked={checked} disabled={!checked && selectedCitations.length >= 30}
              onChange={event => changeCitation(id, event.currentTarget.checked)} />{evidenceTitle(row)}</label>;
          })}
          {otherCitations.map(id => <label className="check" key={id}>
            <input type="checkbox" checked onChange={() => changeCitation(id, false)} /><code>{id}</code>
          </label>)}
        </details>}
        <div><button className="primary">{request.pending ? t('saving') : label(['儲存筆記', 'Save note', '保存笔记'])}</button></div>
      </fieldset>
    </form>
    {saved && <p role="status">{label(['筆記已儲存。', 'Note saved.', '笔记已保存。'])}</p>}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </section>;
}

function BoardLink({ boardId }: { boardId: string }) {
  const { label, t } = useCopy();
  const request = useWorkflowRequest();
  const [invalid, setInvalid] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const url = safeUrl(text(data, 'url'));
    setInvalid(!url);
    if (!url) return;
    if (await request.run('POST', '/research-boards/:id/items', [boardId], { item_type: 'link', url, title: text(data, 'title') || null, stance: 'evidence' })) form.reset();
  }
  return <details className="detail-block">
    <summary>{label(['新增證據連結', 'Add evidence link', '添加证据链接'])}</summary>
    <form className="fields" onSubmit={submit}><fieldset disabled={request.pending}>
      <label className="field">{label(['來源網址', 'Source URL', '来源网址'])}<input type="url" name="url" required maxLength={2048} /></label>
      <label className="field">{label(['標題', 'Title', '标题'])}<input name="title" maxLength={250} /></label>
      <div><button>{request.pending ? t('saving') : label(['新增連結', 'Add link', '添加链接'])}</button></div>
    </fieldset></form>
    {invalid && <p role="alert">{label(['請輸入 HTTP 或 HTTPS 網址。', 'Enter an HTTP or HTTPS URL.', '请输入 HTTP 或 HTTPS 网址。'])}</p>}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </details>;
}

function ResearchSearch({ boardId, items, canAdd, cite, citations }: {
  boardId: string; items: RecordData[]; canAdd: boolean; cite?: (id: string, checked: boolean) => void; citations: string[];
}) {
  const { label, t } = useCopy();
  const [query, setQuery] = useState<Record<string, string>>();
  const request = useWorkflowRequest();
  return <details className="detail-block">
    <summary>{label(['搜尋研究證據', 'Search research evidence', '搜索研究证据'])}</summary>
    <form className="fields" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const keyword = text(form, 'keyword');
      if (keyword) setQuery({ keyword });
    }}>
      <label className="field">{label(['關鍵字', 'Keyword', '关键字'])}<input name="keyword" maxLength={300} required /></label>
      <button>{t('search')}</button>
    </form>
    <form className="fields" onSubmit={event => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const id = text(form, 'id');
      if (id) setQuery({ id, kind: text(form, 'kind') });
    }}>
      <label className="field">{label(['證據類型', 'Evidence type', '证据类型'])}<select name="kind">
        {['research_item', 'observation', 'creative_reference', 'mention'].map(kind => <option key={kind} value={kind}>{label(kinds[kind]!)}</option>)}
      </select></label>
      <label className="field">{label(['證據 ID', 'Evidence ID', '证据 ID'])}<input name="id" maxLength={200} required /></label>
      <button>{label(['依 ID 查找', 'Find by ID'])}</button>
    </form>
    {query && <SearchResults boardId={boardId} query={query} items={items} canAdd={canAdd} cite={cite} citations={citations} request={request} />}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </details>;
}

function SearchResults({ boardId, query, items, canAdd, cite, citations, request }: {
  boardId: string; query: Record<string, string>; items: RecordData[]; canAdd: boolean;
  cite?: (id: string, checked: boolean) => void; citations: string[]; request: ReturnType<typeof useWorkflowRequest>;
}) {
  const { label } = useCopy();
  const read = useRead('/research/search', [], query);
  const result = asRecord(read.data?.data);
  const matches = [
    ...records(result.research_items).map(row => ({ row, kind: 'research_item' })),
    ...records(result.observations).map(row => ({ row, kind: 'observation' })),
    ...records(result.creative_references).map(row => ({ row, kind: 'creative_reference' })),
    ...records(result.mentions).map(row => ({ row, kind: 'mention' })),
  ];
  return <>
    <ReadState read={read} />
    {read.data && !read.isError && (matches.length ? matches.map(({ row, kind }) => {
      const id = idOf(row);
      const pinned = items.some(item => item.ref_id === id && item.item_type === kind);
      const cited = citations.includes(id);
      return <article className="message" key={`${kind}:${id}`}>
        <EvidenceEntry row={row} kind={kind} />
        {kind === 'research_item' && cite && <div className="action-row"><button type="button" aria-pressed={cited} disabled={!cited && citations.length >= 30}
          onClick={() => cite(id, !cited)}>{cited ? label(['移除引證', 'Remove citation', '移除引证']) : label(['在筆記中引用', 'Cite in note', '在笔记中引用'])}</button></div>}
        {kind !== 'research_item' && canAdd && <div className="action-row"><button type="button" disabled={pinned || request.pending}
          onClick={() => void request.run('POST', '/research-boards/:id/items', [boardId], { item_type: kind, ref_id: id, stance: 'evidence' })}>
          {pinned ? label(['已加入研究板', 'On this board']) : label(['加入研究板作為證據', 'Add to board as evidence', '加入研究板作为证据'])}</button></div>}
      </article>;
    }) : <p>{label(['找不到符合的研究證據。', 'No matching evidence.', '找不到符合的研究证据。'])}</p>)}
  </>;
}

export function IntelBoard({ record }: { record: RecordData }) {
  return <ResearchBoard key={idOf(record)} record={record} />;
}

function ResearchBoard({ record }: { record: RecordData }) {
  const { label } = useCopy();
  const api = useApi();
  const id = idOf(record);
  const [citations, setCitations] = useState<string[]>([]);
  const items = records(record.items).filter(row => row.status !== 'archived');
  const active = Boolean(id) && record.status !== 'archived';
  const canNote = active && Boolean(findOperation(api, 'POST', '/research-boards/:id/notes'));
  const canAdd = active && Boolean(findOperation(api, 'POST', '/research-boards/:id/items'));
  function changeCitation(itemId: string, checked: boolean) {
    setCitations(current => checked ? (current.includes(itemId) || current.length >= 30 ? current : [...current, itemId]) : current.filter(value => value !== itemId));
  }
  return <>
    <section className="detail-block">
      <h3>{label(['研究板項目', 'Board items', '研究板项目'])}</h3>
      {items.length ? items.map(item => <BoardItem key={idOf(item)} item={item} board={record} />)
        : <EmptyState title={label(['研究板尚無項目', 'No items on this board', '研究板尚无项目'])} />}
    </section>
    {findOperation(api, 'POST', '/research-digests', 'intel') && <BoardDigest board={record} />}
    {canAdd && <BoardLink boardId={id} />}
    {findOperation(api, 'GET', '/research/search') && <ResearchSearch boardId={id} items={items} canAdd={canAdd} cite={canNote ? changeCitation : undefined} citations={citations} />}
    {canNote && <BoardNote boardId={id} items={items} selectedCitations={citations} changeCitation={changeCitation} onSave={() => setCitations([])} />}
  </>;
}

const structureFields = {
  hook: ['開場鉤子', 'Hook', '开场钩子'], topic: ['主題', 'Topic', '主题'], format: ['內容形式', 'Format', '内容形式'],
  presentation: ['呈現方式', 'Presentation', '呈现方式'], cta: ['行動呼籲', 'Call to action', '行动呼吁'],
  interaction_question: ['互動提問', 'Interaction question', '交互提问'], duration_s: ['時長（秒）', 'Duration (seconds)', '时长（秒）'],
} satisfies Record<string, Label>;

function CreativeForm({ row, onSave }: { row?: RecordData; onSave?: () => void }) {
  const { label, t } = useCopy();
  const request = useWorkflowRequest();
  const [original] = useState(row);
  const structure = asRecord(original?.structure);
  const [message, setMessage] = useState<Label>();
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const patch: RecordData = {};
    setMessage(undefined);
    for (const key of Object.keys(structureFields)) {
      const value = text(data, key);
      if (!value) continue;
      const parsed = key === 'duration_s' ? Number(value) : value;
      if (parsed !== structure[key]) patch[key] = parsed;
    }
    if (row && !Object.keys(patch).length) {
      setMessage(['請至少修改一個結構欄位。', 'Change at least one structure field.', '请至少修改一个结构字段。']);
      return;
    }
    const url = row ? undefined : safeUrl(text(data, 'url'));
    if (!row && !url) { setMessage(['請輸入 HTTP 或 HTTPS 網址。', 'Enter an HTTP or HTTPS URL.', '请输入 HTTP 或 HTTPS 网址。']); return; }
    const result = original
      ? await request.run('PATCH', '/creative-references/:id', [idOf(original)], { structure: patch }, original)
      : await request.run('POST', '/creative-references', [], { url, structure: patch, observation_id: text(data, 'observation_id') || undefined });
    if (result) {
      if (!row) form.reset();
      setMessage(row ? ['標註已儲存。', 'Annotation saved.', '标注已保存。'] : ['創意參考已新增。', 'Creative reference added.', '创意参考已添加。']);
      onSave?.();
    }
  }
  return <form className="fields" onSubmit={submit}>
    <fieldset disabled={request.pending}>
      {!row && <label className="field">{label(['創意參考網址', 'Creative reference URL', '创意参考网址'])}<input name="url" required type="url" maxLength={2048} /></label>}
      {!row && <label className="field">{label(['保存的觀測 ID（選填）', 'Saved observation ID (optional)', '保存的观测 ID（选填）'])}<input name="observation_id" maxLength={200} /></label>}
      {Object.entries(structureFields).map(([key, copy]) => <label className="field" key={key}>{label(copy)}
        {key === 'duration_s' ? <input name={key} type="number" min={0} max={604800} step={1} defaultValue={stringValue(structure[key])} />
          : <input name={key} maxLength={1000} defaultValue={stringValue(structure[key])} />}
      </label>)}
      {row && <small>{label(['只會儲存有變更的非空白欄位。', 'Only changed fields with a value are saved.', '只会保存有变更的非空白字段。'])}</small>}
      <div><button className="primary">{request.pending ? t('saving') : row ? label(['儲存標註', 'Save annotation', '保存标注']) : label(['新增創意參考', 'Add creative reference', '添加创意参考'])}</button></div>
    </fieldset>
    {message && <p role="status">{label(message)}</p>}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </form>;
}

function CreativeEntry({ row, canEdit }: { row: RecordData; canEdit: boolean }) {
  const { label } = useCopy();
  const [editing, setEditing] = useState(false);
  const api = useApi();
  const request = useWorkflowRequest();
  const analyzePath = '/creative-references/:id/analyze';
  const canAnalyze = row.analysis_available === true && findOperation(api, 'POST', analyzePath, 'intel');
  const structure = asRecord(row.structure);
  const fieldAuthors = asRecord(row.structure_authors);
  const source = authors[stringValue(row.structure_source)];
  const fields = Object.entries(structureFields).filter(([key]) => structure[key] != null);
  return <article className="message">
    <h3>{stringValue(structure.topic) || safeUrl(row.url) || idOf(row)}</h3>
    <p><SourceLink value={row.url} showUrl /></p>
    {(row.rights === 'reference_only' || row.rights == null) && <Pill tone="neutral">{label(['僅供參考', 'Reference only', '仅供参考'])}</Pill>}
    {fields.length ? <>
      {source && <p>{label(['結構標註來源', 'Annotation source', '结构标注来源'])} · {label(source)}</p>}
      {row.structure_updated_by_id != null && <p>{label(['最後標註者', 'Last annotator', '最后标注者'])} · <code>{stringValue(row.structure_updated_by_id)}</code></p>}
      <dl>{fields.map(([key, copy]) => {
        const author = authors[stringValue(fieldAuthors[key])];
        return <div key={key}><dt>{label(copy)}{author && <> · <small>{label(author)}</small></>}</dt><dd>{stringValue(structure[key])}</dd></div>;
      })}</dl>
    </> : <p>{label(['尚未標註內容結構。', 'No structure annotation yet.', '尚未标注内容结构。'])}</p>}
    {canEdit && (editing ? <>
      <CreativeForm row={row} onSave={() => setEditing(false)} />
      <button type="button" onClick={() => setEditing(false)}>{label(['取消', 'Cancel'])}</button>
    </> : <button type="button" onClick={() => setEditing(true)}>{label(['人工標註', 'Annotate manually', '人工标注'])}</button>)}
    {canAnalyze && !editing && <button type="button" disabled={request.pending} onClick={() => void request.run('POST', analyzePath, [idOf(row)], {}, row)}>{label(['以模型分析已保存觀測', 'Analyze saved observation with model', '以模型分析已保存观测'])}</button>}
    {request.error !== undefined && <ProblemNotice error={request.error} />}
  </article>;
}

export function IntelCreatives() {
  const { label } = useCopy();
  const api = useApi();
  const read = useRead('/creative-references');
  const rows = records(read.data?.data);
  const canCreate = Boolean(findOperation(api, 'POST', '/creative-references'));
  const canEdit = Boolean(findOperation(api, 'PATCH', '/creative-references/:id'));
  return <Panel>
    <div className="panel-head"><h2>{label(['創意參考', 'Creative references', '创意参考'])}</h2></div>
    <div className="detail-body">
      <p>{label(['參考連結僅供研究，不會成為可用素材。你可以直接人工拆解內容結構。', 'Reference links are for research only and do not become usable assets. You can annotate their structure manually.', '参考链接仅供研究，不会成为可用素材。你可以直接人工拆解内容结构。'])}</p>
      {canCreate && <details className="detail-block"><summary>{label(['新增創意參考', 'New creative reference', '添加创意参考'])}</summary><CreativeForm /></details>}
      <ReadState read={read} />
      {read.data && (rows.length ? rows.map(row => <CreativeEntry key={idOf(row)} row={row} canEdit={canEdit} />) : <EmptyState title={label(['尚無創意參考', 'No creative references yet', '尚无创意参考'])} />)}
    </div>
  </Panel>;
}

const trendMetrics = {
  comments: ['留言', 'Comments'], likes: ['按讚', 'Likes', '按赞'], shares: ['分享', 'Shares'],
  views: ['觀看', 'Views', '观看'], reactions: ['心情回應', 'Reactions', '心情回应'],
} satisfies Record<string, Label>;

function trendDefaults(record: RecordData) {
  const period = asRecord(record.period);
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  to.setUTCDate(to.getUTCDate() + 1);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 30);
  return {
    from: stringValue(period.from).slice(0, 16) || from.toISOString().slice(0, 16),
    to: stringValue(period.to).slice(0, 16) || to.toISOString().slice(0, 16),
    metric: stringValue(record.metric) || 'comments',
  };
}

export function IntelTrend({ record }: { record: RecordData }) {
  const topicId = stringValue(record.topic_id ?? record.id);
  return <TopicTrend key={topicId} record={record} defaultTopic={topicId} />;
}

function TopicTrend({ record, defaultTopic }: { record: RecordData; defaultTopic: string }) {
  const { label } = useCopy();
  const topics = useRead('/topics');
  const [filters, setFilters] = useState(() => trendDefaults(record));
  const [selection, setSelection] = useState<string>();
  const [invalid, setInvalid] = useState(false);
  const rows = records(topics.data?.data);
  const topicId = selection ?? (defaultTopic || idOf(rows[0] ?? {}));
  const topicRows = defaultTopic && !rows.some(row => idOf(row) === defaultTopic) ? [{ id: defaultTopic, name: record.name }, ...rows] : rows;
  const read = useRead('/topics/:id/trend', [topicId], {
    from: `${filters.from}:00.000Z`, to: `${filters.to}:00.000Z`, metric: filters.metric,
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const from = text(form, 'from');
    const to = text(form, 'to');
    const invalidRange = !from || !to || from >= to;
    setInvalid(invalidRange);
    if (!invalidRange) setFilters({ from, to, metric: text(form, 'metric') });
  }
  return <section className="detail-block">
    <h3>{label(['話題趨勢', 'Topic trends', '话题趋势'])}</h3>
    <ReadState read={topics} />
    {topicRows.length ? <>
      <label className="field">{label(['話題', 'Topic', '话题'])}<select value={topicId} onChange={event => setSelection(event.currentTarget.value)}>
        {topicRows.map(row => <option key={idOf(row)} value={idOf(row)}>{stringValue(row.name) || idOf(row)}</option>)}
      </select></label>
      <form className="fields" onSubmit={submit}>
        <label className="field">{label(['開始時間（UTC）', 'Start time (UTC)', '开始时间（UTC）'])}<input type="datetime-local" required name="from" defaultValue={filters.from} /></label>
        <label className="field">{label(['結束時間，不含該時刻（UTC）', 'End time, exclusive (UTC)', '结束时间，不含该时刻（UTC）'])}<input type="datetime-local" required name="to" defaultValue={filters.to} /></label>
        <label className="field">{label(['指標', 'Metric', '指标'])}<select name="metric" defaultValue={filters.metric}>
          {Object.entries(trendMetrics).map(([key, copy]) => <option key={key} value={key}>{label(copy)}</option>)}
        </select></label>
        <button>{label(['比較期間', 'Compare periods', '比较期间'])}</button>
      </form>
      {invalid && <p className="problem" role="alert">{label(['結束時間必須晚於開始時間。', 'End time must follow the start time.', '结束时间必须晚于开始时间。'])}</p>}
      <ReadState read={read} />
      {read.data && !read.isError && <TrendComparison key={JSON.stringify([topicId, filters])} result={entity(read.data.data)} />}
    </> : topics.data && <EmptyState title={label(['尚無可比較的話題', 'No topics to compare', '尚无可比较的话题'])} />}
  </section>;
}

function TrendComparison({ result }: { result: RecordData }) {
  const { label, locale } = useCopy();
  const number = new Intl.NumberFormat(locale);
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
  const periodText = (period: unknown) => {
    const { from, to } = asRecord(period);
    const start = Date.parse(stringValue(from));
    const end = Date.parse(stringValue(to));
    return Number.isFinite(start) && Number.isFinite(end) ? <><time dateTime={stringValue(from)}>{date.format(start)}</time> – <time dateTime={stringValue(to)}>{date.format(end)}</time></> : '—';
  };
  const metric = trendMetrics[stringValue(result.metric) as keyof typeof trendMetrics];
  const previous = asRecord(result.comparison);
  const metrics = {
    sample_size: ['總樣本量', 'Total samples', '总样本量'], observed_sample_size: ['實測樣本量', 'Observed samples', '实测样本量'],
    observed_increment: ['實測增量', 'Observed change', '实测增量'], estimated_sample_size: ['估算樣本量', 'Estimated samples', '估算样本量'],
    estimated_increment: ['估算增量', 'Estimated change'], purchase_intent_sample_size: ['有購買意圖的樣本', 'Samples with purchase intent', '有购买意图的样本'],
  } satisfies Record<string, Label>;
  const display = (value: unknown) => typeof value === 'number' ? number.format(value) : '—';
  return <>
    <div className="table-scroll"><table className="entity-table">
      <caption>{label(['樣本與增量比較', 'Sample and change comparison', '样本与增量比较'])}{metric && <> · {label(metric)}</>}</caption>
      <thead><tr><th scope="col">{label(['指標', 'Measure', '指标'])}</th>
        <th scope="col">{label(['目前期間', 'Current period', '目前期间'])}<br />{periodText(result.period)}</th>
        <th scope="col">{label(['前一期間', 'Previous period', '前一期间'])}<br />{periodText(result.comparison_period)}</th>
      </tr></thead>
      <tbody>{Object.entries(metrics).map(([key, copy]) => <tr key={key}><th scope="row">{label(copy)}</th>
        <td>{display(result[key])}</td><td>{display(previous[key])}</td>
      </tr>)}</tbody>
    </table></div>
    <p><small>{label(['時間以 UTC 顯示，結束時刻不計入期間。樣本須有兩次可比較的觀測。— 表示沒有可計算的數值。', 'Times are in UTC and the end time is exclusive. A sample requires two comparable snapshots. A dash means no value could be calculated.', '时间以 UTC 显示，结束时刻不计入期间。样本须有两次可比较的观测。— 表示没有可计算的数值。'])}</small></p>
    <TrendEvidence title={label(['目前期間的觀測證據', 'Current-period observations', '目前期间的观测证据'])} ids={strings(result.evidence_observation_ids)} metric={stringValue(result.metric)} />
    <TrendEvidence title={label(['前一期間的觀測證據', 'Previous-period observations', '前一期间的观测证据'])} ids={strings(previous.evidence_observation_ids)} metric={stringValue(result.metric)} />
  </>;
}

function TrendEvidence({ title, ids, metric }: { title: string; ids: string[]; metric: string }) {
  const { label } = useCopy();
  const api = useApi();
  const [selection, setSelection] = useState('');
  if (!ids.length || !findOperation(api, 'GET', '/research/search')) return null;
  return <details className="detail-block">
    <summary>{title}</summary>
    <label className="field">{label(['觀測 ID', 'Observation ID', '观测 ID'])}<select value={selection} onChange={event => setSelection(event.currentTarget.value)}>
      <option value="">{label(['選擇觀測', 'Choose an observation', '选择观测'])}</option>
      {[...new Set(ids)].map(id => <option key={id} value={id}>{id}</option>)}
    </select></label>
    {selection && <ObservationEvidence id={selection} metric={metric} />}
  </details>;
}

function ObservationEvidence({ id, metric }: { id: string; metric: string }) {
  const { label, locale } = useCopy();
  const read = useRead('/research/search', [], { id, kind: 'observation' });
  const row = records(asRecord(read.data?.data).observations).find(row => idOf(row) === id);
  const value = asRecord(asRecord(row?.metrics)[metric]).value;
  const metricLabel = trendMetrics[metric as keyof typeof trendMetrics];
  return <>
    <ReadState read={read} />
    {read.data && !read.isError && (row ? <article className="message">
      <EvidenceEntry row={row} kind="observation" />
      {typeof value === 'number' && metricLabel && <p>{label(metricLabel)} · {new Intl.NumberFormat(locale).format(value)}</p>}
    </article> : <p>{label(['此觀測目前無法顯示。', 'This observation is currently unavailable.', '此观测目前无法显示。'])}</p>)}
  </>;
}
