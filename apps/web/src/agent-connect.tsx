import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, request, workspacePath, type Session } from '@smartsell/sdk';
import { ProblemNotice } from './api';
import { useCopy } from './i18n';
import { canAuthorizeWorker } from './worker-connect';

/**
 * /agent-connect (phase1-design §6.2 step 2, S7): the laptop SmartSell App opens this page to connect Codex or Claude Code.
 * After the owner authorizes, the page enrolls an Agent connection and hands the one-time code back to the App with a
 * top-level navigation to its loopback page, exactly like worker-connect.tsx (never a fetch to a loopback address: that would
 * break this page's CSP connect-src 'self' and trigger Chrome's local network prompt).
 */

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const stateFormat = /^[A-Za-z0-9_-]{43}$/;
const codeFormat = /^[A-Za-z0-9_-]{100,512}$/;
export type AgentClient = 'codex' | 'claude_code';
export interface AgentConnectRequest { client: AgentClient; port: string; state: string; label: string }
export interface AgentEnrollmentData { id: string; client: AgentClient; code: string; expires_at?: string }
const clientName: Record<AgentClient, string> = { codex: 'Codex', claude_code: 'Claude Code' };

/** `?client=codex|claude_code&port=<p>&state=<s>&label=<hostname> · Codex`, strictly (each key once, nothing else). */
export function parseAgentConnect(search: string): AgentConnectRequest | undefined {
  const params = new URLSearchParams(search);
  const client = params.get('client');
  const port = params.get('port') ?? '';
  const state = params.get('state') ?? '';
  const label = params.get('label')?.trim() ?? '';
  if ([...params.keys()].some(key => !['client', 'port', 'state', 'label'].includes(key) || params.getAll(key).length !== 1) ||
      (client !== 'codex' && client !== 'claude_code') || !/^[1-9]\d{3,4}$/.test(port) || Number(port) < 1024 || Number(port) > 65535 ||
      !stateFormat.test(state) || !label || label.length > 120 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(label)) return;
  return { client, port, state, label };
}

/** The loopback URL the App listens on, with the grant in the fragment (never sent to any server). */
export function agentReturnUrl(intent: AgentConnectRequest, workspace: string, enrollment: AgentEnrollmentData) {
  const fragment = new URLSearchParams({ workspace, code: enrollment.code, state: intent.state, connection: enrollment.id });
  return `http://127.0.0.1:${intent.port}/smartsell-agent#${fragment}`;
}

export function AgentConnectCard({ children, language }: { children: ReactNode; language: ReactNode }) {
  const { label } = useCopy();
  return <main className="worker-connect"><section className="auth-card">
    {language}<h1>{label(['連接 Codex／Claude Code', 'Connect Codex / Claude Code'])}</h1>{children}
  </section></main>;
}

export function AgentConnectPage({ session, intent, language }: { session: Session; intent: AgentConnectRequest; language: ReactNode }) {
  const { label } = useCopy();
  const workspaces = session.workspaces.filter(item => uuid.test(item.id) && canAuthorizeWorker(item.role));
  const [selected, setSelected] = useState(workspaces.length === 1 ? workspaces[0].id : '');
  const workspace = workspaces.find(item => item.id === selected);
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const name = clientName[intent.client];
  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (window.top !== window.self || sending.current || !workspace || !session.csrf_token) return;
    sending.current = true;
    setPending(true);
    setError(undefined);
    try {
      const { data } = await request<AgentEnrollmentData>(`${workspacePath(workspace.id)}/agent-connections/enroll`, {
        method: 'POST', body: { client: intent.client, label: intent.label, expires_days: 365 }, csrf: session.csrf_token,
      });
      if (!data || !uuid.test(data.id ?? '') || !codeFormat.test(data.code ?? '')) throw new ApiError(502, { code: 'INVALID_RESPONSE' });
      window.location.replace(agentReturnUrl(intent, workspace.id, data));
    } catch (failure) {
      setError(failure);
      sending.current = false;
      setPending(false);
    }
  }
  return <AgentConnectCard language={language}>
    <p>{label(['要連接的筆電', 'Laptop requesting access'])} <strong dir="auto">{intent.label}</strong></p>
    {!workspaces.length ? <p role="alert">{label(['你需要有該工作區的擁有者或管理員權限。', 'You need owner or admin access to a workspace.'])}</p>
      : !session.csrf_token ? <p role="alert">{label(['無法驗證登入狀態，請重新登入後再試。', 'Could not verify your session. Sign in again and retry.'])}</p>
      : <form onSubmit={authorize}>
        <p>{label([`授權後，這台筆電上的 ${name} 可以透過 SmartSell 查看機器與帳號、上傳影片並排程貼文。核准、恢復、確認結果等動作仍然只能由你在網頁上做。`,
          `After you authorize, ${name} on this laptop can read machines and channels, upload media and schedule posts through SmartSell. Approving, resuming and confirming results stay with you on the web.`])}</p>
        <fieldset disabled={pending}>
          <label>{label(['工作區', 'Workspace'])}
            <select required value={selected} onChange={event => setSelected(event.target.value)}>
              {!selected && <option value="">{label(['請選擇工作區', 'Select a workspace'])}</option>}
              {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <p id="agent-connect-confirm" className="muted">{label(['連線有效 365 天，可以隨時在 Agent 頁撤銷。重新連接同一台筆電時，SmartSell App 會撤銷舊的連線。',
            'The connection is valid for 365 days and can be revoked on the Agent page. Reconnecting the same laptop revokes the old connection.'])}</p>
          <button className="button" type="submit" aria-describedby="agent-connect-confirm" disabled={!workspace}>{pending ? label(['正在連接…', 'Connecting…']) : label(['授權並返回 SmartSell App', 'Authorize and return to the SmartSell App'])}</button>
        </fieldset>
        {error !== undefined && <ProblemNotice error={error} />}
      </form>}
  </AgentConnectCard>;
}
