import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ApiError, request, workspacePath, type Session } from '@smartsell/sdk';
import { ProblemNotice } from './api';
import { useCopy } from './i18n';
import './worker-connect.css';

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const stateFormat = /^[A-Za-z0-9_-]{43}$/;
const codeFormat = /^[A-Za-z0-9_-]{32}$/;

export interface WorkerConnectRequest { port: string; state: string; workspace?: string; name: string }
export interface WorkerPairingCode { pairing_code: string; expires_at: string }
export const workerPairingBody = { owned_device_confirmed: true, allow_channel_registration: true };
export const workerRegistrationNotice = [
  '授權後，這台 Worker 可登記你在桌面程式中確認的社群帳號和店鋪。',
  'After authorization, this worker can register the social accounts and stores you confirm in the desktop app.',
] as const;
export const canAuthorizeWorker = (role?: string) => role === 'owner' || role === 'admin';

export function parseWorkerConnect(search: string): WorkerConnectRequest | undefined {
  const params = new URLSearchParams(search);
  const port = params.get('port') ?? '';
  const state = params.get('state') ?? '';
  const workspace = params.get('workspace');
  const name = params.get('name')?.trim() ?? '';
  if ([...params.keys()].some(key => !['port', 'state', 'workspace', 'name'].includes(key) || params.getAll(key).length !== 1) ||
      !/^[1-9]\d{3,4}$/.test(port) || Number(port) < 1024 || Number(port) > 65535 || !stateFormat.test(state) ||
      (workspace !== null && !uuid.test(workspace)) || !name || name.length > 100 || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(name)) return;
  return { port, state, workspace: workspace?.toLowerCase(), name };
}

export function WorkerConnectCard({ children, language }: { children: ReactNode; language: ReactNode }) {
  const { label } = useCopy();
  return <main className="worker-connect"><section className="auth-card">
    {language}<h1>{label(['授權桌面 Worker', 'Authorize desktop worker'])}</h1>{children}
  </section></main>;
}

export function WorkerConnectPage({ session, intent, language }: { session: Session; intent: WorkerConnectRequest; language: ReactNode }) {
  const { label } = useCopy();
  const workspaces = session.workspaces.filter(item => uuid.test(item.id) && canAuthorizeWorker(item.role));
  const [selected, setSelected] = useState(intent.workspace ?? (workspaces.length === 1 ? workspaces[0].id : ''));
  const workspace = workspaces.find(item => item.id === selected);
  const blocked = intent.workspace !== undefined && !workspace;
  const sending = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function authorize(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (window.top !== window.self || sending.current || !workspace || !session.csrf_token) return;
    sending.current = true;
    setPending(true);
    setError(undefined);
    try {
      const { data } = await request<WorkerPairingCode>(`${workspacePath(workspace.id)}/devices/pairing-codes`, {
        method: 'POST', body: workerPairingBody, csrf: session.csrf_token,
      });
      if (!codeFormat.test(data?.pairing_code ?? '')) throw new ApiError(502, { code: 'INVALID_RESPONSE' });
      const fragment = new URLSearchParams({ state: intent.state, workspace: workspace.id, code: data.pairing_code });
      window.location.replace(`http://127.0.0.1:${intent.port}/smartsell-worker#${fragment}`);
    } catch (failure) {
      setError(failure);
      sending.current = false;
      setPending(false);
    }
  }
  return <WorkerConnectCard language={language}>
    <p>{label(['要連接的機器', 'Machine requesting access'])} <strong dir="auto">{intent.name}</strong></p>
    {blocked || !workspaces.length ? <p role="alert">{label(['你需要有該工作區的擁有者或管理員權限。', 'You need owner or admin access to the requested workspace.'])}</p>
      : !session.csrf_token ? <p role="alert">{label(['無法驗證登入狀態，請重新登入後再試。', 'Could not verify your session. Sign in again and retry.'])}</p>
      : <form onSubmit={authorize}>
        <p>{label(workerRegistrationNotice)}</p>
        <fieldset disabled={pending}>
          <label>{label(['工作區', 'Workspace'])}
            <select required value={selected} disabled={Boolean(intent.workspace)} onChange={event => setSelected(event.target.value)}>
              {!selected && <option value="">{label(['請選擇工作區', 'Select a workspace'])}</option>}
              {workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            </select>
          </label>
          <p id="worker-connect-confirm">{label(['按下授權即確認你擁有或獲授權管理這台機器，並同意將它連接至此工作區。',
            'By authorizing, you confirm that you own or are authorized to manage this machine and want to connect it to this workspace.'])}</p>
          <button className="button" type="submit" aria-describedby="worker-connect-confirm" disabled={!workspace}>{pending ? label(['正在連接…', 'Connecting…']) : label(['授權並返回桌面程式', 'Authorize and return to desktop'])}</button>
        </fieldset>
        {error !== undefined && <ProblemNotice error={error} />}
      </form>}
  </WorkerConnectCard>;
}
