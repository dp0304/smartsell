import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { Entity } from './workbench-api';

type Row = { id: string; version: number; status: string };
type Change = Row & { items: { seq: number; status: string; preview: { title: { before: string; after: string } } }[] };
type Suggestion = Row & { output: string; change_set?: Change };

async function agentRequest<T>(path: string, signal?: AbortSignal, body?: object, version?: number) {
  const headers = new Headers({ accept: 'application/json' });
  if (body) {
    const csrf = await fetch('/api/v1/session/csrf', { signal, cache: 'no-store' });
    if (!csrf.ok) throw new Error('session');
    headers.set('x-csrf-token', (await csrf.json()).csrf_token);
    headers.set('content-type', 'application/json');
    headers.set('idempotency-key', crypto.randomUUID());
    if (version !== undefined) headers.set('if-match', String(version));
  }
  const response = await fetch(`/api/v1${path}`, { method: body ? 'POST' : 'GET', headers, signal, cache: 'no-store',
    body: body && JSON.stringify(body) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()).data as T;
}

export function AgentAssistant({ wid, page, row, role }: { wid: string; page: string; row?: Pick<Entity, 'id' | 'kind' | 'data' | 'version'>; role: string }) {
  const { i18n } = useTranslation();
  const say = (zh: string, en: string) => i18n.language.startsWith('zh') ? zh : en;
  const prefix = `/workspaces/${encodeURIComponent(wid)}`;
  const canRequest = ['owner', 'admin', 'manager', 'editor'].includes(role);
  const status = useQuery({ queryKey: ['workspace', wid, 'agent-status'], queryFn: ({ signal }) => agentRequest<{ purposes: string[] }>(`${prefix}/ai/status`, signal), enabled: canRequest, retry: false });
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState('');
  const [title, setTitle] = useState('');
  const [suggestion, setSuggestion] = useState<Suggestion>();
  const [change, setChange] = useState<Change>();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [knowledge, setKnowledge] = useState<{ items: { revision_id: string; title: string; body: string }[] }>();
  const [q, setQuery] = useState('');
  const brand = row?.kind === 'brand' ? row?.id : row?.data.brand_id;
  const target = row && ['work_item', 'content_item'].includes(row.kind) ? row : undefined;
  const hasAssistant = canRequest && status.data?.purposes.includes('draft');
  if (!hasAssistant && typeof brand !== 'string') return null;

  async function perform(work: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try { await work(); } catch { setFailed(true); } finally { setBusy(false); }
  }

  return <section className="wb-note">
    {hasAssistant && <button onClick={() => setOpen(!open)} aria-expanded={open}>{say('頁面助手', 'Page assistant')}</button>}
    {open && hasAssistant && <form onSubmit={event => { event.preventDefault(); void perform(async () => {
      const result = await agentRequest<Suggestion>(`${prefix}/assist`, undefined, { page, intent,
        resource_refs: target ? [{ kind: target.kind, id: target.id }] : [] });
      if (!result.output) throw new Error('suggestion');
      setSuggestion(result); setTitle(result.output.slice(0, 250)); setChange(undefined);
    }); }}>
      <label>{say('想取得的建議', 'What would you like help with?')}<textarea required maxLength={8000} value={intent} onChange={event => setIntent(event.target.value)} /></label>
      <button disabled={busy}>{say('取得建議', 'Get suggestion')}</button>
    </form>}
    {open && hasAssistant && suggestion?.status === 'shown' && <div>
      <p>{suggestion.output}</p>
      {target && <><label>{say('擬議標題', 'Proposed title')}<input maxLength={250} value={title} onChange={event => setTitle(event.target.value)} /></label>
        <button disabled={busy || !title.trim()} onClick={() => void perform(async () => {
          const result = await agentRequest<Suggestion>(`${prefix}/assist/${suggestion.id}/review`, undefined, { decision: 'propose', title: say('頁面助手建議', 'Page assistant proposal'),
            items: [{ target_type: target.kind, target_id: target.id, expected_version: target.version, patch: { title } }] }, suggestion.version);
          setSuggestion(result); setChange(result.change_set);
        })}>{say('送交變更審閱', 'Submit for review')}</button></>}
      <button disabled={busy} onClick={() => void perform(async () => setSuggestion(await agentRequest<Suggestion>(
        `${prefix}/assist/${suggestion.id}/review`, undefined, { decision: 'reject' }, suggestion.version)))}>{say('退回建議', 'Dismiss suggestion')}</button>
    </div>}
    {open && hasAssistant && change && <div>
      {change.items.map(item => <div key={item.seq}>
        <p>{say('原標題', 'Current title')} <del>{item.preview.title.before}</del></p>
        <p>{say('新標題', 'New title')} <ins>{item.preview.title.after}</ins></p>
        {item.status !== 'pending' && <p role="status">{item.status === 'conflict' ? say('版本衝突，保留現有內容', 'Version conflict. Current content kept.') : say('已套用', 'Applied')}</p>}
        {['owner', 'admin', 'manager', 'reviewer'].includes(role) && item.status === 'pending' && <button disabled={busy}
          onClick={() => void perform(async () => setChange(await agentRequest<Change>(`${prefix}/change-sets/${change.id}/apply`, undefined,
            { item_seqs: [item.seq] }, change.version)))}>{say('確認並套用顯示的差異', 'Confirm and apply this change')}</button>}
      </div>)}
    </div>}
    {typeof brand === 'string' && <form onSubmit={event => { event.preventDefault(); void perform(async () => setKnowledge(await agentRequest(
      `${prefix}/brands/${encodeURIComponent(brand)}/agent-context?q=${encodeURIComponent(q)}`))); }}>
      <label>{say('搜尋核准的品牌知識', 'Search approved brand knowledge')}<input value={q} onChange={event => setQuery(event.target.value)} /></label>
      <button disabled={busy}>{say('預覽品牌上下文', 'Preview brand context')}</button>
    </form>}
    {knowledge && (knowledge.items.length ? knowledge.items.map(item => <article key={item.revision_id}><strong>{item.title}</strong><p>{item.body}</p></article>) :
      <p role="status">{say('沒有符合的核准知識', 'No matching approved knowledge')}</p>)}
    {failed && <p role="alert">{say('無法完成操作。請重新載入並檢查版本或設定。', 'Could not complete the action. Refresh and check the version or configuration.')}</p>}
  </section>;
}
