import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ActivityList, CopyButton, StatusChip, formatDateTime, relativeTime, type ActivityItem, type Tuple } from '@smartsell/ui';
import { ProblemNotice } from '../../api';
import { copy, fill } from '../copy';
import { useView, useViewContext, useViewWrite } from '../data/use-view';
import { connectionState, jobBody } from '../data/logic';
import type { AgentConnection, AgentJob, CreatedConnection } from '../data/types';
import { Loaded, PageHeader, Section, resourcePath, useFilters, useText } from '../parts';

const clients: [string, Tuple][] = [['claude_code', copy.agent.clientClaude], ['codex', copy.agent.clientCodex], ['other', copy.agent.clientOther]];
const lifetimes = [30, 90, 180, 365];
const terminalJobs = new Set(['done', 'cancelled']);

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Snippet({ text, label }: { text: string; label: string }) {
  return <div className="vs-snippet"><div className="vs-snippet-head"><small>{label}</small><CopyButton text={text} /></div><pre><code>{text}</code></pre></div>;
}

function TokenBox({ created, onClose }: { created: CreatedConnection; onClose: () => void }) {
  const { l } = useText();
  const setup = created.setup ?? {};
  const tabs = ([
    ['claude', copy.agent.setupClaude, setup.claude_code_command],
    ['json', copy.agent.setupJson, setup.claude_code_json],
    ['codex', copy.agent.setupCodex, [setup.codex_toml, setup.codex_command].filter(Boolean).join('\n\n') || undefined],
    ['agents', copy.agent.setupAgents, setup.agents_md],
  ] as const).filter(([, , text]) => text);
  const preferred = created.client === 'codex' ? 'codex' : created.client === 'other' ? 'json' : 'claude';
  const [tab, setTab] = useState<string>(tabs.some(([key]) => key === preferred) ? preferred : tabs[0]?.[0] ?? '');
  const current = tabs.find(([key]) => key === tab);
  return <div className="vs-token" role="region" aria-label={l(copy.agent.token)}>
    <p className="vs-notice warning" role="alert">{l(copy.agent.tokenOnce)}</p>
    <Snippet label={l(copy.agent.token)} text={created.token} />
    <Snippet label={l(copy.agent.mcpUrl)} text={created.mcp_url} />
    {tabs.length > 0 && <>
      <div className="vs-tabs" role="tablist">{tabs.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}>{l(label)}</button>)}</div>
      {current && <div role="tabpanel"><Snippet label={l(current[1])} text={current[2] ?? ''} />
        {current[0] === 'agents' && setup.agents_md && <button type="button" className="vs-btn" onClick={() => download('AGENTS.md', setup.agents_md!)}>{l(copy.agent.download)}</button>}</div>}
      <p className="muted"><small>{l(copy.agent.setupHint)}</small></p>
    </>}
    <div className="vs-actions"><button type="button" className="vs-btn primary-soft" onClick={onClose}>{l(copy.agent.closeToken)}</button></div>
  </div>;
}

function ConnectForm({ onCreated }: { onCreated: (created: CreatedConnection) => void }) {
  const { l } = useText();
  const write = useViewWrite();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const key = useRef<string>(undefined);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const element = event.currentTarget;
    const form = new FormData(element);
    const label = String(form.get('label') ?? '').trim();
    if (!label || pending) return;
    key.current ??= crypto.randomUUID();
    setPending(true); setError(undefined);
    try {
      const { data } = await write<CreatedConnection>('POST', '/agent-connections', { label, client: String(form.get('client')), expires_days: Number(form.get('expires_days')) }, key.current);
      key.current = undefined;
      element.reset();
      onCreated(data);
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <form className="vs-form" onSubmit={submit}><fieldset disabled={pending}>
    <label className="vs-field"><span>{l(copy.agent.label)}</span><input name="label" required maxLength={120} placeholder={l(copy.agent.labelHint)} onChange={() => { key.current = undefined; }} /></label>
    <div className="vs-field-row">
      <label className="vs-field"><span>{l(copy.agent.client)}</span><select name="client" defaultValue="claude_code">{clients.map(([value, label]) => <option key={value} value={value}>{l(label)}</option>)}</select></label>
      <label className="vs-field"><span>{l(copy.agent.expires)}</span><select name="expires_days" defaultValue="90">{lifetimes.map(days => <option key={days} value={days}>{fill(l(copy.agent.days), { n: days })}</option>)}</select></label>
    </div>
    <div className="vs-actions"><button type="submit" className="vs-btn primary-soft">{l(pending ? copy.agent.creating : copy.agent.create)}</button></div>
  </fieldset>{error !== undefined && <ProblemNotice error={error} />}</form>;
}

function Connections() {
  const { l, lang } = useText();
  const write = useViewWrite();
  const read = useView<AgentConnection[]>('/agent-connections');
  const [confirming, setConfirming] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<unknown>();
  async function revoke(id: string) {
    setBusy(id); setError(undefined);
    try { await write('DELETE', `/agent-connections/${encodeURIComponent(id)}`); setConfirming(undefined); }
    catch (failure) { setError(failure); }
    finally { setBusy(undefined); }
  }
  return <Loaded read={read}>{items => {
    const list = Array.isArray(items) ? [...items].sort((a, b) => Number(a.revoked) - Number(b.revoked) || b.created_at.localeCompare(a.created_at)) : [];
    if (!list.length) return <p className="muted">{l(copy.agent.noConnections)}</p>;
    return <>{error !== undefined && <ProblemNotice error={error} />}<ul className="vs-list vs-connections">{list.map(item => {
      const state = connectionState(item);
      return <li key={item.id}>
        <div className="vs-grow"><div className="vs-row-head"><strong>{item.label}</strong><StatusChip status={state === 'active' ? 'connected' : state} label={copy.agent[state]} /></div>
          <small className="muted">{clients.find(([value]) => value === item.client)?.[1][lang === 'en' ? 1 : 0] ?? item.client} · {l(copy.agent.lastUsed)}: {item.last_used_at
            ? <time dateTime={item.last_used_at} title={formatDateTime(item.last_used_at, lang)}>{relativeTime(item.last_used_at, lang)}</time> : l(copy.agent.neverUsed)}
            {item.expires_at && <> · {l(copy.agent.expiresAt)} {formatDateTime(item.expires_at, lang)}</>}</small></div>
        {state === 'active' && (confirming === item.id ? <span className="vs-actions">
          <button type="button" className="vs-btn danger" disabled={busy === item.id} onClick={() => void revoke(item.id)}>{l(copy.agent.revokeConfirm)}</button>
          <button type="button" className="vs-btn ghost" disabled={busy === item.id} onClick={() => setConfirming(undefined)}>×</button>
        </span> : <button type="button" className="vs-btn" onClick={() => setConfirming(item.id)}>{l(copy.agent.revoke)}</button>)}
      </li>;
    })}</ul></>;
  }}</Loaded>;
}

function Delegate() {
  const { l } = useText();
  const { brandId } = useFilters();
  const write = useViewWrite();
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>();
  const key = useRef<string>(undefined);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim() || pending) return;
    key.current ??= crypto.randomUUID();
    setPending(true); setError(undefined); setSent(false);
    try { await write('POST', '/agent-jobs', jobBody(text, brandId), key.current); key.current = undefined; setText(''); setSent(true); }
    catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <form className="vs-form" onSubmit={submit}><fieldset disabled={pending}>
    <label className="vs-field"><span className="vs-sr">{l(copy.agent.delegate)}</span>
      <textarea rows={2} maxLength={4000} value={text} placeholder={l(copy.agent.delegatePlaceholder)} onChange={event => { setText(event.target.value); key.current = undefined; setSent(false); }} /></label>
    <div className="vs-actions"><button type="submit" className="vs-btn primary-soft" disabled={!text.trim()}>{l(pending ? copy.agent.sending : copy.agent.send)}</button>
      {sent && <span className="vs-notice good" role="status">{l(copy.agent.sent)}</span>}</div>
  </fieldset>{error !== undefined && <ProblemNotice error={error} />}</form>;
}

function OpenJobs() {
  const { l, lang } = useText();
  const { base } = useViewContext();
  const read = useView<AgentJob[]>('/agent-jobs');
  return <Loaded read={read}>{items => {
    const open = (Array.isArray(items) ? items : []).filter(job => !terminalJobs.has(job.status)).sort((a, b) => (b.created_at ?? '').localeCompare(a.created_at ?? ''));
    if (!open.length) return <p className="muted">{l(copy.agent.noJobs)}</p>;
    return <ul className="vs-list">{open.map(job => <li key={job.id}>
      <div className="vs-grow"><div className="vs-row-head"><span>{job.title}</span><StatusChip status={job.status} /></div>
        <small className="muted">{job.assignee_type === 'agent_client' ? l(copy.agent.byAgent) : job.assignee_type === 'user' ? l(copy.agent.byPerson) : l(copy.agent.unassigned)}
          {job.created_at && <> · {relativeTime(job.created_at, lang)}</>}{job.progress_note && <> · {job.progress_note}</>}</small></div>
      {job.status === 'submitted' && <Link className="vs-btn" to={`${base}/decisions?kind=agent_job_review`}>{l(copy.agent.review)}</Link>}
    </li>)}</ul>;
  }}</Loaded>;
}

function Activity() {
  const { l } = useText();
  const { base } = useViewContext();
  const [actor, setActor] = useState<'' | 'agent' | 'human'>('');
  const read = useView<ActivityItem[]>('/views/activity', { actor, limit: '50' });
  return <>
    <div className="vs-filter-row" role="group" aria-label={l(copy.agent.activity)}>
      {([['', copy.agent.all], ['agent', copy.agent.onlyAgent], ['human', copy.agent.onlyHuman]] as const).map(([value, label]) =>
        <button key={value} type="button" aria-pressed={actor === value} onClick={() => setActor(value)}>{l(label)}</button>)}
    </div>
    <Loaded read={read}>{items => Array.isArray(items) && items.length
      ? <ActivityList items={items} resourceHref={item => resourcePath(base, item.resource)} />
      : <p className="muted">{l(copy.agent.noActivity)}</p>}</Loaded>
  </>;
}

export function AgentPage() {
  const { l } = useText();
  const [created, setCreated] = useState<CreatedConnection>();
  return <>
    <PageHeader title={l(copy.agent.title)} subtitle={l(copy.agent.subtitle)} />
    <div className="vs-columns">
      <Section title={l(copy.agent.connect)}>{created ? <TokenBox created={created} onClose={() => setCreated(undefined)} /> : <ConnectForm onCreated={setCreated} />}</Section>
      <Section title={l(copy.agent.connections)}><Connections /></Section>
      <Section title={l(copy.agent.delegate)}><p className="muted"><small>{l(copy.agent.delegateHint)}</small></p><Delegate /><h3 className="vs-subhead">{l(copy.agent.openJobs)}</h3><OpenJobs /></Section>
      <Section title={l(copy.agent.activity)}><Activity /></Section>
    </div>
  </>;
}
