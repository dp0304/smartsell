import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { formatDateTime } from '@smartsell/ui';
import { ProblemNotice } from '../../api';
import { copy, fill } from '../copy';
import { connectionState } from '../data/logic';
import type { AgentConnection, AgentEnrollment } from '../data/types';
import { useViewWrite } from '../data/use-view';
import { useText } from '../parts';
import { agentCheckPrompt, agentEnrollmentPrompt, agentRepairCommand } from './setup-agent-prompt';
import { setupText as text } from './setup-copy';
import { mcpUsed } from './setup-data';

const clients = { claude_code: 'Claude Code', codex: 'Codex' } as const;
const lifetimes = [30, 90, 180, 365];

function Prompt({ value, kind = 'command' }: { value: string; kind?: 'command' | 'check' | 'code' }) {
  const { l } = useText();
  const id = useId();
  const field = useRef<HTMLTextAreaElement>(null);
  const [feedback, setFeedback] = useState<'copied' | 'selected'>();
  async function copyPrompt() {
    try {
      await navigator.clipboard.writeText(value);
      setFeedback('copied');
    } catch {
      field.current?.focus();
      field.current?.select();
      setFeedback('selected');
    }
  }
  return <div className="setup-agent-prompt">
    <label htmlFor={id}>{l({ command: text.agentPrompt, check: text.agentCheckPrompt, code: text.agentCode }[kind])}</label>
    <textarea id={id} ref={field} readOnly value={value} rows={kind === 'code' ? 2 : 5} spellCheck={false} autoComplete="off" />
    <div className="vs-actions"><button className="vs-btn primary-soft" type="button" onClick={() => void copyPrompt()}>
      {l({ command: text.agentCopy, check: text.agentCopyCheck, code: text.agentCopyCode }[kind])}
    </button><span className="setup-copy-feedback" role="status">{feedback && l(feedback === 'copied' ? text.agentCopied : text.agentManualCopy)}</span></div>
  </div>;
}

export function SetupAgent({ connections, issued, onIssued }: {
  connections: AgentConnection[]; issued?: AgentEnrollment; onIssued: (data: AgentEnrollment) => void;
}) {
  const { l, lang } = useText();
  const create = useViewWrite();
  const [client, setClient] = useState<AgentEnrollment['client']>('claude_code');
  const [adding, setAdding] = useState(false);
  const [expiredCode, setExpiredCode] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const promptHeading = useRef<HTMLHeadingElement>(null);
  // O4: only connections this prompt enrollment made (or older ones from before setup_via): a relay token or the App's own
  // connection is never offered a check prompt or a 修復 Codex 連線 command here.
  const usable = connections.filter(item => connectionState(item) === 'active' && (item.setup_via ?? 'prompt') === 'prompt');
  const verified = usable.some(mcpUsed);
  const redeemed = issued && usable.find(item => item.id === issued.id);
  const expired = issued && (expiredCode === issued.id || Date.parse(issued.expires_at) <= Date.now());
  const english = lang === 'en';

  useEffect(() => {
    if (!issued) return;
    promptHeading.current?.focus();
    const timer = window.setTimeout(() => setExpiredCode(issued.id), Math.max(0, Date.parse(issued.expires_at) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [issued]);

  async function generate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError(undefined);
    try {
      const { data } = await create<AgentEnrollment>('POST', '/agent-connections/enroll', {
        client, label: String(form.get('label') ?? '').trim() || clients[client], expires_days: Number(form.get('expires_days') ?? 90), setup_via: 'prompt',
      });
      onIssued(data);
      setAdding(false);
    } catch (failure) { setError(failure); }
    finally { setBusy(false); }
  }

  return <div className="setup-agent">
    {verified && <p className="vs-notice good" role="status">{l(text.agentSeen)}</p>}
    {issued ? <div className="setup-agent-current">
      <h3 className="vs-subhead" tabIndex={-1} ref={promptHeading}>{clients[issued.client]}</h3>
      {redeemed ? (!mcpUsed(redeemed) && <>
        <p>{l(text.agentWaitingForTools)}</p>
        <Prompt key={`${issued.id}-${lang}-check`} value={agentCheckPrompt(english, issued.id)} kind="check" />
        <details><summary>{l(text.agentRetry)}</summary>
          <Prompt key={`${issued.id}-${lang}`} value={agentEnrollmentPrompt(issued)} />
        </details>
      </>) : expired ?
        <p role="status" className="vs-notice warning">{l(text.agentCodeExpired)}</p> : <>
          <p>{fill(l(text.agentPaste), { client: clients[issued.client] })}</p>
          {issued.client === 'codex' && <p>{l(text.agentCodexRouting)}</p>}
          <Prompt key={`${issued.id}-${lang}`} value={agentEnrollmentPrompt(issued)} />
          <Prompt key={`${issued.id}-code`} value={issued.code} kind="code" />
          <small className="muted">{fill(l(text.agentCodeExpiry), { time: formatDateTime(issued.expires_at, lang) })}</small>
        </>}
    </div> : !verified && usable.length > 0 && <>
      <p>{l(text.agentResume)}</p>
      <Prompt key={lang} value={agentCheckPrompt(english, usable.length === 1 ? usable[0]?.id : undefined)} kind="check" />
      <p className="muted">{l(text.agentMissing)}</p>
    </>}
    {usable.filter(item => item.client === 'codex' && item.mcp_url && item.id !== issued?.id).map(item =>
      <details key={item.id}>
        <summary>{fill(l(text.agentRepair), { label: item.label })}</summary>
        <p>{l(text.agentRepairHint)}</p>
        <p>{l(text.agentCodexRouting)}</p>
        <Prompt value={agentRepairCommand(item.id, item.mcp_url!)} />
        <Prompt value={agentCheckPrompt(english, item.id)} kind="check" />
      </details>)}
    {(adding || (!issued && !usable.length)) ? <form className="vs-form" onSubmit={generate}>
      <fieldset disabled={busy}>
        <p>{l(text.agentChoose)}</p>
        <label className="vs-field"><span>{l(copy.agent.client)}</span><select value={client} onChange={event => setClient(event.target.value as AgentEnrollment['client'])}>
          {Object.entries(clients).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
        </select></label>
        <details className="setup-agent-advanced">
          <summary>{l(text.agentAdvanced)}</summary>
          <div className="vs-field-row">
            <label className="vs-field"><span>{l(copy.agent.label)}</span><input name="label" maxLength={80} placeholder={clients[client]} /></label>
            <label className="vs-field"><span>{l(copy.agent.expires)}</span><select name="expires_days" defaultValue="90">
              {lifetimes.map(days => <option key={days} value={days}>{fill(l(copy.agent.days), { n: days })}</option>)}
            </select></label>
          </div>
        </details>
        <div className="vs-actions"><button className="vs-btn primary-soft" type="submit">{l(busy ? text.agentGenerating : text.agentGenerate)}</button></div>
      </fieldset>
      {error !== undefined && <ProblemNotice error={error} />}
    </form> : <div className="vs-actions"><button className="vs-btn" type="button" onClick={() => setAdding(true)}>
      {l(verified ? text.agentAnother : text.agentGenerateNew)}
    </button></div>}
  </div>;
}
