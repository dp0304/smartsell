import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { request } from '@smartsell/sdk';
import { CopyButton, StatusChip, formatDateTime } from '@smartsell/ui';
import { ProblemNotice } from '../../api';
import { workerPairingBody, workerRegistrationNotice, type WorkerPairingCode } from '../../worker-connect';
import { useView, useViewContext, type ViewResult } from '../data/use-view';
import { Loaded, useText } from '../parts';
import { SessionStatus } from './setup-connections';
import { setupText as text } from './setup-copy';
import { activeDevices, hasWorkerHeartbeat, useSetupWrite, type BrowserSession, type Device, type Store, type WorkerCatalog } from './setup-data';

const downloadRoute = '/api/v1/worker-downloads';
const platformLabels = {
  'mac-arm64': ['macOS（Apple 晶片）', 'macOS (Apple silicon)'],
  'mac-x64': ['macOS（Intel）', 'macOS (Intel)'],
  'win-x64': ['Windows（64 位元）', 'Windows (64-bit)'],
} as const;
interface WorkerDownload { platform: keyof typeof platformLabels; url: string }
interface SocialAccount { id: string; display_name: string; status: string }

function OneTimeConnection({ workbench, onCodeIssued }: { workbench: string; onCodeIssued: (expiresAt: number) => void }) {
  const { l, lang } = useText();
  const action = useSetupWrite();
  const [code, setCode] = useState<WorkerPairingCode>();
  const [expired, setExpired] = useState(false);
  const link = code && !expired ? `${workbench}/get-started?step=worker#worker-pair=${encodeURIComponent(code.pairing_code)}` : '';
  useEffect(() => {
    if (!code) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, Date.parse(code.expires_at) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [code]);
  async function pair(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!new FormData(event.currentTarget).has('owns')) return;
    const result = await action.run<WorkerPairingCode>('POST', '/devices/pairing-codes', workerPairingBody);
    if (result) {
      setCode(result);
      setExpired(false);
      onCodeIssued(Date.parse(result.expires_at));
    }
  }
  return <details className="setup-download-details">
    <summary>{l(['改用一次性連接網址', 'Use a one-time connection URL'])}</summary>
    <div className="setup-download">
      <p>{l(workerRegistrationNotice)}</p>
      <form className="vs-form" onSubmit={pair}><fieldset disabled={action.pending}>
        <label className="st-check-field"><input name="owns" type="checkbox" required /><span>{l(text.ownership)}</span></label>
        <button type="submit" className="vs-btn primary-soft">{l(['產生連接網址', 'Generate connection URL'])}</button>
      </fieldset>{action.error !== undefined && <ProblemNotice error={action.error} />}</form>
      {code && <div role="status" className="setup-download">
        {expired ? <p>{l(['連接網址已過期，請產生新的網址。', 'The connection URL expired. Generate a new one.'])}</p> : <>
          <label htmlFor="worker-connection-url">{l(['連接網址', 'Connection URL'])}</label>
          <input id="worker-connection-url" value={link} readOnly spellCheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()} />
          <div><CopyButton text={link} label={['複製連接網址', 'Copy connection URL']} /></div>
          <small>{l(['僅供本人使用，限用一次，有效時間至', 'Keep this one-time URL private. Expires at'])} <time dateTime={code.expires_at}>{formatDateTime(code.expires_at, lang)}</time></small>
        </>}
      </div>}
    </div>
  </details>;
}

function DownloadPanel({ onCodeIssued }: { onCodeIssued: (expiresAt: number) => void }) {
  const { l } = useText();
  const { base } = useViewContext();
  const workbench = `${window.location.origin}${base}`;
  const downloads = useQuery({ queryKey: ['worker-downloads'], queryFn: async ({ signal }) =>
    (await request<WorkerDownload[]>(downloadRoute, { signal })).data });
  const available = downloads.data?.filter(item => Object.hasOwn(platformLabels, item.platform) && item.url === `${downloadRoute}/${item.platform}`) ?? [];
  return <section className="vs-notice setup-download" aria-label={l(['下載與連接', 'Download and connect'])}>
    <p>{l(['安裝並開啟 SmartSell Worker。將下方工作台網址貼入桌面 Worker，再在瀏覽器按一次「授權並返回桌面程式」。',
      'Install and open SmartSell Worker. Paste the workbench URL into the desktop worker, then authorize once in your browser.'])}</p>
    {downloads.isPending ? <p role="status">{l(['正在查詢安裝包…', 'Checking available installers…'])}</p>
      : downloads.isError ? <ProblemNotice error={downloads.error} retry={() => void downloads.refetch()} />
      : available.length > 0 ? <div className="vs-actions">{available.map(item => <a className="vs-btn" key={item.platform} href={item.url} download>
        {l(['下載', 'Download'])} {l(platformLabels[item.platform])}</a>)}</div>
      : <p>{l(['此服務目前沒有提供安裝包。', 'This service has no installers available yet.'])}</p>}
    <label htmlFor="worker-workbench-url">{l(['工作台網址', 'Workbench URL'])}</label>
    <input id="worker-workbench-url" value={workbench} readOnly spellCheck={false} autoComplete="off" onFocus={event => event.currentTarget.select()} />
    <div><CopyButton text={workbench} label={['複製工作台網址', 'Copy workbench URL']} /></div>
    <p>{l(['在另一台機器上連接時，桌面程式必須能連到此服務的 HTTPS 網址。',
      'When connecting from another machine, the desktop app must be able to reach this service over HTTPS.'])}</p>
    <OneTimeConnection workbench={workbench} onCodeIssued={onCodeIssued} />
  </section>;
}

function AllowChannelRegistration({ device }: { device: Device }) {
  const { l } = useText();
  const action = useSetupWrite();
  return <div className="vs-notice setup-download">
    <p>{l(['選用權限。若要讓此 Worker 登記你在桌面程式確認的社群帳號和店鋪，請先授權。',
      'Optional. Allow this worker to register the social accounts and stores you confirm in the desktop app.'])}</p>
    <div><button type="button" className="vs-btn" disabled={action.pending || action.saved}
      onClick={() => void action.run('PUT', `/devices/${encodeURIComponent(device.id)}/channel-registration`, { enabled: true })}>
      {l(['允許此 Worker 登記渠道', 'Allow this worker to register channels'])}
    </button></div>
    {action.error !== undefined && <ProblemNotice error={action.error} />}
  </div>;
}

function WorkerConnections({ device }: { device?: Device }) {
  const { l } = useText();
  const polling = { refetchInterval: 10_000 };
  const accounts = useView<SocialAccount[]>('/social-accounts', {}, { allPages: true, ...polling });
  const sessions = useView<BrowserSession[]>('/browser-sessions', {}, polling);
  const stores = useView<Store[]>('/stores', {}, { allPages: true, ...polling });
  const catalog = useView<WorkerCatalog>('/worker-catalog', {}, polling);
  const waiting = ['等待指定機器', 'Waiting for a worker'] as const;
  const empty = ['這台機器尚無相關記錄。', 'No records for this machine yet.'] as const;
  return <>
    <h3 className="vs-subhead">{l(text.social)}</h3>
    <Loaded read={accounts}>{items => <Loaded read={sessions}>{records => {
      const associated = items.filter(item => item.status === 'active').flatMap(item => {
        const bindings = records.filter(record => record.social_account_id === item.id);
        const machineSessions = device ? bindings.filter(record => record.device_id === device.id) : [];
        if (!machineSessions.length && bindings.length) return [];
        return [{ item, machineSessions }];
      });
      return associated.length ? <ul className="vs-list" aria-label={l(text.social)}>{associated.map(({ item, machineSessions }) => <li key={item.id}>
        <strong>{item.display_name}</strong>
        {machineSessions.length ? machineSessions.map(record => <SessionStatus key={record.id} status={record.status} />)
          : <StatusChip status="pending" label={waiting} />}
      </li>)}</ul> : <p className="muted">{l(device ? empty : text.socialEmpty)}</p>;
    }}</Loaded>}</Loaded>
    <h3 className="vs-subhead">{l(['店鋪', 'Stores'])}</h3>
    <Loaded read={stores}>{items => <Loaded read={catalog}>{data => {
      const associated = items.filter(item => item.status !== 'disabled').flatMap(item => {
        const binding = data.bindings.find(record => record.store_id === item.id);
        return !binding || binding.device_id === device?.id ? [{ item, binding }] : [];
      });
      const online = device?.status === 'active' && device.online === true && hasWorkerHeartbeat(device);
      return associated.length ? <ul className="vs-list" aria-label={l(['店鋪', 'Stores'])}>{associated.map(({ item, binding }) => <li key={item.id}>
        <strong>{item.name}</strong><StatusChip status={binding && online ? 'connected' : 'pending'}
          label={!binding ? waiting : online ? text.bound : ['已指定，等待機器上線', 'Assigned, waiting for worker to come online']} />
      </li>)}</ul> : <p className="muted">{l(device ? empty : text.noStores)}</p>;
    }}</Loaded>}</Loaded>
  </>;
}

function WorkerChecklist({ device, read }: { device?: Device; read: ViewResult<Device[]> }) {
  const { l, lang } = useText();
  const active = device?.status === 'active';
  const heartbeat = active && hasWorkerHeartbeat(device);
  const online = heartbeat && device.online === true;
  return <>
    <h3 className="vs-subhead" id="worker-checklist-title">{l(text.workerChecks)}</h3>
    <ol className="vs-list worker-checklist" role="list" aria-labelledby="worker-checklist-title">
      <li>
        <div className="vs-row-head"><strong>{l(text.workerSecureStorage)}</strong><StatusChip status="unknown" label={text.workerLocal} /></div>
        <small className="muted">{l(text.workerSecureStorageHint)}</small>
      </li>
      <li>
        <div className="vs-row-head"><strong>{l(text.workerAuthorization)}</strong>
          <span role="status">
            {read.isError ? <StatusChip status="failed" label={text.workerReadError} />
              : read.isPending ? <StatusChip status="pending" label={text.checking} />
              : active ? <StatusChip status="connected" label={text.workerAuthorized} />
              : device ? <StatusChip status={device.status} />
              : <StatusChip status="pending" label={text.workerUnauthorized} />}
          </span>
        </div>
        {!read.isError && !read.isPending && !active && <small className="muted">{l(device ? text.workerInactiveHint : text.workerAuthorizeHint)}</small>}
      </li>
      <li>
        <div className="vs-row-head"><strong>{l(text.workerHeartbeat)}</strong>
          <span role="status">
            {read.isError ? <StatusChip status="unknown" label={text.unavailable} />
              : read.isPending ? <StatusChip status="pending" label={text.checking} />
              : active ? <StatusChip status={online ? 'connected' : heartbeat ? 'offline' : 'pending'}
                label={online ? text.workerVerifiedOnline : heartbeat ? text.workerVerifiedOffline : text.workerAwaitingHeartbeat} />
              : <StatusChip status="pending" label={text.workerAwaitingAuthorization} />}
          </span>
        </div>
        {heartbeat && device.last_seen_at && <small className="muted">{l(text.lastSeen)} <time dateTime={device.last_seen_at}>{formatDateTime(device.last_seen_at, lang)}</time></small>}
        {active && !online && <small className="muted">{l(text.workerHeartbeatHint)}</small>}
      </li>
      <li>
        <div className="vs-row-head"><strong>{l(text.workerChrome)}</strong><StatusChip status="unknown" label={text.workerLocal} /></div>
        <small className="muted">{l(text.workerChromeHint)} {l(text.workerLocalEvidence)}</small>
      </li>
      <li>
        <div className="vs-row-head"><strong>{l(text.workerVerifyAccounts)}</strong><StatusChip status="unknown" label={text.workerLocal} /></div>
        <small className="muted">{l(text.workerVerifyAccountsHint)}</small>
      </li>
    </ol>
  </>;
}

export function WorkerStep({ devices, onCodeIssued }: { devices: ViewResult<Device[]>; onCodeIssued: (expiresAt: number) => void }) {
  const { l } = useText();
  const [selected, setSelected] = useState('');
  const machines = devices.isError ? [] : devices.value ?? [];
  const device = machines.find(machine => machine.id === selected) ?? activeDevices(machines)[0] ?? machines[0];
  return <>
    <h3 className="vs-subhead">{l(text.devices)}</h3>
    <Loaded read={devices}>{() => <>
      {device ? <>
        {machines.length > 1 && <label className="vs-select"><span>{l(['選擇機器', 'Select machine'])}</span>
          <select value={device.id} onChange={event => setSelected(event.target.value)}>{machines.map(machine => <option key={machine.id} value={machine.id}>{machine.name}</option>)}</select>
        </label>}
        <strong>{device.name}</strong>
      </> : !devices.isError && <p className="muted">{l(text.noDevices)}</p>}
    </>}</Loaded>
    <WorkerChecklist device={device} read={devices} />
    <details className="setup-download-details"><summary className="vs-btn">{l(['下載桌面 Worker', 'Download desktop worker'])}</summary>
      <DownloadPanel onCodeIssued={onCodeIssued} />
    </details>
    {device?.status === 'active' && device.allow_channel_registration === false && <AllowChannelRegistration key={device.id} device={device} />}
    {!devices.isPending && !devices.isError && <WorkerConnections device={device} />}
  </>;
}
