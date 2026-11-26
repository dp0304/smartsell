import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { asRecord, type RecordData } from '@smartsell/sdk';
import { ProblemNotice } from '../../api';
import { fill } from '../copy';
import type { AlertChannelsView, ChannelSummary, MachineSummary } from '../data/hub-types';
import type { AgentConnection, AgentEnrollment } from '../data/types';
import { useView, useViewContext, type ViewResult } from '../data/use-view';
import { Loaded, PageHeader, RouterLink, useText } from '../parts';
import { hub } from '../hub-copy';
import { Badge, ChannelName, Empty, LoginBadge, OnlineBadge, WriteError, tr, useHubWrite } from '../hub-parts';
import { warningTitle } from '../hub-copy';
import { READINESS_KEYS, readinessDone } from './ChannelsPage';
import { SetupAgent } from './setup-agent';
import { setupText } from './setup-copy';
import { canSetUp, dismissSetup, mcpUsed } from './setup-data';
import { AgentConnectWays, HubAddress, WorkerDownloads } from './setup-hub';
import './setup.css';

/** The first-run wizard (phase1-design §2.9): workspace → machines → channels → notifications → Codex. */

export const wizardSteps = ['workspace', 'machines', 'channels', 'notifications', 'agent'] as const;
export type WizardStep = typeof wizardSteps[number];
/** Older links (?step=worker|social|store|import) open the machine step; unknown values open the first open step. */
export function wizardStep(value: string | null): WizardStep | undefined {
  if (value === 'worker' || value === 'social' || value === 'store' || value === 'import') return 'machines';
  return wizardSteps.find(step => step === value);
}

const text = {
  intro: ['照順序設定一次：工作區時區、要發文的機器、帳號、通知，最後連接你的 AI 助手（Codex、Claude Code 或 WorkBuddy）。每一步都可以之後再回來。', 'Set up once, in order: the workspace time zone, the machines that post, channels, notifications, then your AI assistant (Codex, Claude Code or WorkBuddy). You can come back to any step.'],
  workspace: ['工作區', 'Workspace'], machines: ['連接機器', 'Connect machines'], channels: ['新增帳號', 'Add channels'], notifications: ['通知', 'Notifications'], agent: ['連接 AI 助手', 'Connect your AI assistant'],
  name: ['工作區名稱', 'Workspace name'], zone: ['時區', 'Time zone'], zoneHint: ['排程的時間都以這個時區解讀（例如「明天 9:00」）；Worker 登記的帳號也用它。', 'Times such as "tomorrow 9:00" are read in this zone; channels added by a Worker use it too.'],
  currency: ['報表幣別', 'Reporting currency'], saveWorkspace: ['儲存並繼續', 'Save and continue'], savedWorkspace: ['已儲存工作區設定。', 'Workspace settings saved.'],
  stepsTitle: ['在要發文的機器上（例如 Mac-B）', 'On the machine that will post (e.g. Mac-B)'],
  step1: ['安裝 Tailscale、登入同一個 tailnet、不設 exit node，並在 Tailscale 後台關閉這台機器的金鑰到期。', 'Install Tailscale, sign in to the same tailnet, use no exit node, and disable key expiry for this machine in the Tailscale admin.'],
  step2: ['安裝並開啟 SmartSell Worker，貼上上面的中樞位址。', 'Install and open SmartSell Worker and paste the hub address above.'],
  step3: ['Worker 問「這台機器叫什麼名字？」時，用你平常叫它的名字（例如 Mac-B）。Codex 會用這個名字找機器。', 'When the Worker asks for the machine name, use the name you normally use (e.g. Mac-B). Codex finds machines by it.'],
  step4: ['那台機器的瀏覽器會開啟中樞的配對頁，登入後按「授權」。配對永遠在那台機器上完成，不用傳連結。', 'That machine\'s browser opens the hub pairing page; sign in and click Authorize. Pairing always happens on that machine; no links to send.'],
  paired: ['已配對的機器（新配對的會自動出現）', 'Paired machines (new ones appear by themselves)'], noPaired: ['還沒有機器。照上面的步驟在那台機器完成配對。', 'No machines yet. Follow the steps above on that machine.'],
  channelsIntro: ['帳號一律在那台機器的 SmartSell Worker 新增，登入由你自己在跳出的 Chrome 視窗完成。', 'Channels are added in SmartSell Worker on that machine; you sign in yourself in the Chrome window it opens.'],
  channelSteps: ['在 {machine} 開啟 SmartSell Worker → 新增帳號 → 選平台（X 或 TikTok）→ 在跳出的 Chrome 視窗登入 → 確認加入', 'On {machine} open SmartSell Worker → Add account → choose X or TikTok → sign in in the Chrome window → confirm'],
  noChannels: ['這台機器還沒有帳號。', 'No channels on this machine yet.'], needMachine: ['先完成「連接機器」。', 'Connect a machine first.'],
  finishChannel: ['到帳號頁完成就緒清單：', 'Finish the readiness checklist on the channel page:'],
  notificationsIntro: ['要你處理的事（驗證碼、登入過期、要你按發布、沒有發出）會送到網頁鈴鐺、筆電的 SmartSell App 與手機推播。', 'Things that need you (captcha, sign-in expired, click Post, missed) go to the web bell, the laptop App and phone push.'],
  pushCount: ['已設定 {n} 個手機推播。', '{n} phone push channels set.'], pushNone: ['還沒有設定手機推播（選填，但建議）。', 'No phone push yet (optional, recommended).'],
  openPush: ['設定手機推播並傳一則測試', 'Set up phone push and send a test'],
  agentIntro: ['連接後，在 Codex 說「把 video.mp4 明天 9:00 發到 Mac-B 的 X」就會排好。', 'Once connected, tell Codex "post video.mp4 to X on Mac-B tomorrow at 9:00" and it is scheduled.'],
  agentVerified: ['已有 Agent 透過 MCP 呼叫過 SmartSell。', 'An Agent has called SmartSell over MCP.'], legacy: ['進階：舊的接入方式（提示詞）', 'Advanced: the previous setup (prompt)'],
  finish: ['完成，前往今日', 'Done, go to Today'], later: ['稍後再設定', 'Finish later'], next: ['下一步', 'Next'], back: ['上一步', 'Back'],
  done: ['已完成', 'Done'], todo: ['待設定', 'To do'], optional: ['選填', 'Optional'], unread: ['無法讀取', 'Could not read'],
} as const;

/** A read that failed before it ever succeeded: its step is neither done nor to do, it is unknown (W-specs #2). */
const unread = (read: Pick<ViewResult<unknown>, 'value' | 'isError'>) => read.value === undefined && read.isError;

const ZONES = ['Asia/Shanghai', 'Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Singapore', 'Asia/Tokyo', 'Asia/Seoul', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'UTC'];
const CURRENCIES = ['CNY', 'TWD', 'HKD', 'USD', 'SGD', 'JPY', 'EUR', 'GBP'];
const browserZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; } };

function WorkspaceStep({ onDone }: { onDone: () => void }) {
  const { l } = useText();
  const read = useView<RecordData>('');
  const write = useHubWrite();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [saved, setSaved] = useState(false);
  return <Loaded read={read}>{value => {
    const row = asRecord(value);
    const version = typeof row.version === 'number' && row.version > 0 ? row.version : undefined;
    const zone = typeof row.default_timezone === 'string' && (version || row.default_timezone !== 'UTC') ? row.default_timezone : browserZone();
    const zones = [...new Set([zone, browserZone(), ...ZONES])];
    async function submit(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      setPending(true); setError(undefined);
      try {
        await write('PATCH', '', { name: String(form.get('name') ?? '').trim(), default_timezone: String(form.get('zone')), reporting_currency: String(form.get('currency')) }, { version });
        setSaved(true); onDone();
      } catch (failure) { setError(failure); } finally { setPending(false); }
    }
    return <form className="hub-form-grid" onSubmit={submit}>
      <label className="hub-field">{l(text.name)}<input name="name" required maxLength={120} defaultValue={String(row.name ?? '')} /></label>
      <label className="hub-field">{l(text.zone)}<select name="zone" defaultValue={zone}>{zones.map(item => <option key={item} value={item}>{item}</option>)}</select>
        <small className="muted">{l(text.zoneHint)}</small></label>
      <label className="hub-field">{l(text.currency)}<select name="currency" defaultValue={String(row.reporting_currency ?? 'CNY')}>
        {[...new Set([String(row.reporting_currency ?? 'CNY'), ...CURRENCIES])].map(item => <option key={item} value={item}>{item}</option>)}</select></label>
      <div className="hub-span vs-actions"><button className="vs-btn primary-soft" type="submit" disabled={pending}>{pending ? l(hub.common.saving) : l(text.saveWorkspace)}</button>
        {saved && <span className="vs-notice good" role="status">{l(text.savedWorkspace)}</span>}</div>
      <div className="hub-span"><WriteError error={error} /></div>
    </form>;
  }}</Loaded>;
}

function MachinesStep({ read }: { read: ViewResult<MachineSummary[]> }) {
  const { l } = useText();
  const { base } = useViewContext();
  return <div className="hub-wizard-body">
    <HubAddress />
    <WorkerDownloads />
    <h3 className="vs-subhead">{l(text.stepsTitle)}</h3>
    <ol className="hub-steps">{[text.step1, text.step2, text.step3, text.step4].map((step, index) => <li key={index}>{l(step)}</li>)}</ol>
    <h3 className="vs-subhead">{l(text.paired)}</h3>
    {/* Only a successful read can say "no machines yet"; a failed one shows the error with 重試. */}
    <Loaded read={read}>{machines => machines.length ? <ul className="hub-rows">{machines.map(machine => <li key={machine.machine_id} className="hub-row static two">
      <span className="hub-row-main"><RouterLink to={`${base}/machines/${encodeURIComponent(machine.machine_id)}`}><strong>{machine.name}</strong></RouterLink>
        {machine.warnings.length > 0 && <small className="muted">{machine.warnings.map(warning => tr(l, warningTitle, warning.code)).join('、')}</small>}</span>
      <span className="hub-row-tags"><OnlineBadge online={machine.online} paused={machine.paused} />{machine.app_version && <Badge>{machine.app_version}</Badge>}</span>
    </li>)}</ul> : <Empty>{l(text.noPaired)}</Empty>}</Loaded>
  </div>;
}

function ChannelsStep({ machines: machinesRead, channels: channelsRead }: { machines: ViewResult<MachineSummary[]>; channels: ViewResult<ChannelSummary[]> }) {
  const { l } = useText();
  return <Loaded read={machinesRead}>{machines => !machines.length ? <Empty>{l(text.needMachine)}</Empty>
    : <Loaded read={channelsRead}>{channels => <MachineChannels machines={machines} channels={channels} />}</Loaded>}</Loaded>;
}

function MachineChannels({ machines, channels }: { machines: MachineSummary[]; channels: ChannelSummary[] }) {
  const { l } = useText();
  const { base } = useViewContext();
  return <div className="hub-wizard-body">
    <p>{l(text.channelsIntro)}</p>
    {machines.map(machine => {
      const own = channels.filter(channel => channel.machine?.id === machine.machine_id);
      return <section key={machine.machine_id} className="hub-way">
        <h3>{machine.name} <OnlineBadge online={machine.online} paused={machine.paused} /></h3>
        <p className="muted">{fill(l(text.channelSteps), { machine: machine.name })}</p>
        {own.length ? <ul className="hub-rows">{own.map(channel => {
          const missing = READINESS_KEYS.filter(key => !channel.readiness[key] && (key !== 'defaults_ready' || channel.provider === 'tiktok'));
          return <li key={channel.channel_id} className="hub-row static two">
            <span className="hub-row-main"><RouterLink to={`${base}/channels/${encodeURIComponent(channel.channel_id)}`}><ChannelName provider={channel.provider} handle={channel.handle} label={channel.display_name} /></RouterLink>
              {missing.length > 0 && <small className="muted">{l(text.finishChannel)} {missing.map(key => l(hub.channels[key])).join('、')}</small>}</span>
            <span className="hub-row-tags"><LoginBadge state={channel.login.state} /><Badge tone={missing.length ? 'warning' : 'good'}>{readinessDone(channel.readiness)}/{READINESS_KEYS.length}</Badge></span>
          </li>;
        })}</ul> : <p className="muted">{l(text.noChannels)}</p>}
      </section>;
    })}
  </div>;
}

function NotificationsStep({ push }: { push: ViewResult<AlertChannelsView> }) {
  const { l } = useText();
  const { base } = useViewContext();
  return <div className="hub-wizard-body">
    <p>{l(text.notificationsIntro)}</p>
    <Loaded read={push}>{value => {
      const count = value.channels.length;
      return <p className={count ? 'hub-ok-text' : 'muted'}>{count ? fill(l(text.pushCount), { n: count }) : l(text.pushNone)}</p>;
    }}</Loaded>
    <div className="vs-actions"><RouterLink to={`${base}/settings/notifications`} className="vs-btn primary-soft">{l(text.openPush)}</RouterLink></div>
    <section className="hub-way"><h3>{l(hub.push.laptop)}</h3><p>{l(hub.push.laptopHint)}</p><p className="muted">{l(hub.push.tailnet)}</p></section>
  </div>;
}

/** `issued` lives in the Wizard, so 上一步／下一步 keeps the one-time prompt while its code is valid (W-specs #3). */
function AgentStep({ connections, issued, onIssued }: {
  connections: ViewResult<AgentConnection[]>; issued: AgentEnrollment | undefined; onIssued: (data: AgentEnrollment) => void;
}) {
  const { l } = useText();
  const verified = (connections.value ?? []).some(mcpUsed);
  return <div className="hub-wizard-body">
    <p>{l(text.agentIntro)}</p>
    {unread(connections) && <ProblemNotice error={connections.error} retry={() => void connections.refetch()} />}
    {verified && <p className="vs-notice good" role="status">{l(text.agentVerified)}</p>}
    <AgentConnectWays />
    <details className="hub-legacy"><summary>{l(text.legacy)}</summary>
      <SetupAgent connections={connections.value ?? []} issued={issued} onIssued={onIssued} />
    </details>
  </div>;
}

function Wizard() {
  const { l } = useText();
  const { base, ws, session } = useViewContext();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const heading = useRef<HTMLHeadingElement>(null);
  const polling = { refetchInterval: 10_000 };
  const workspaceRead = useView<RecordData>('');
  const machines = useView<MachineSummary[]>('/views/machines', {}, polling);
  const channels = useView<ChannelSummary[]>('/views/channels', {}, polling);
  const push = useView<AlertChannelsView>('/hub/alerts/channels');
  const connections = useView<AgentConnection[]>('/agent-connections', {}, polling);
  const [issued, setIssued] = useState<AgentEnrollment>();
  // Completion comes only from a successful read (value is kept across a failed refetch); a step whose read failed is unknown.
  const done: Record<WizardStep, boolean> = {
    workspace: Number(asRecord(workspaceRead.value).version ?? 0) > 0,
    machines: (machines.value ?? []).some(machine => !!machine.app_version),
    channels: (channels.value ?? []).some(channel => channel.can_schedule && channel.readiness.logged_in),
    notifications: (push.value?.channels.length ?? 0) > 0,
    agent: (connections.value ?? []).some(mcpUsed),
  };
  const failed: Record<WizardStep, boolean> = {
    workspace: unread(workspaceRead), machines: unread(machines), channels: unread(machines) || unread(channels),
    notifications: unread(push), agent: unread(connections),
  };
  const status = (step: WizardStep) => done[step] ? 'done' : failed[step] ? 'failed' : 'waiting';
  const requested = wizardStep(params.get('step'));
  const active: WizardStep = requested ?? wizardSteps.find(step => !done[step]) ?? 'agent';
  const index = wizardSteps.indexOf(active);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [active]);
  const go = (step: WizardStep) => void navigate({ search: `?step=${step}` });
  const leave = () => dismissSetup(ws, session.user.id);
  return <>
    <PageHeader title={l(setupText.title)} subtitle={l(text.intro)}>
      <Link className="vs-btn" to={base} state={{ skipSetupCheck: true }} onClick={leave}>{l(text.later)}</Link>
    </PageHeader>
    <div className="setup-layout">
      <nav aria-label={l(setupText.steps)} className="setup-progress"><ol role="list">{wizardSteps.map((step, position) => <li key={step}>
        <button type="button" aria-current={active === step ? 'step' : undefined} onClick={() => go(step)}>
          <span className="setup-step-number" aria-hidden="true">{position + 1}</span>
          <span><strong>{l(text[step])}</strong><small data-status={status(step)}>{l(done[step] ? text.done : failed[step] ? text.unread : step === 'notifications' ? text.optional : text.todo)}</small></span>
        </button>
      </li>)}</ol></nav>
      <section className="vs-card setup-panel" aria-labelledby="setup-step-title">
        <header className="vs-card-head"><div>
          <small className="muted">{fill(l(setupText.progress), { step: index + 1, total: wizardSteps.length })}</small>
          <h2 tabIndex={-1} ref={heading} id="setup-step-title">{l(text[active])}</h2>
        </div></header>
        {active === 'workspace' && <WorkspaceStep onDone={() => go('machines')} />}
        {active === 'machines' && <MachinesStep read={machines} />}
        {active === 'channels' && <ChannelsStep machines={machines} channels={channels} />}
        {active === 'notifications' && <NotificationsStep push={push} />}
        {active === 'agent' && <AgentStep connections={connections} issued={issued} onIssued={setIssued} />}
        <footer className="vs-actions setup-footer">
          {index > 0 && <button className="vs-btn" type="button" onClick={() => go(wizardSteps[index - 1])}>{l(text.back)}</button>}
          {index < wizardSteps.length - 1 ? <button className="vs-btn primary-soft" type="button" onClick={() => go(wizardSteps[index + 1])}>{l(text.next)}</button>
            : <Link className="vs-btn primary-soft" to={base} state={{ skipSetupCheck: true }} onClick={leave}>{l(text.finish)}</Link>}
        </footer>
      </section>
    </div>
  </>;
}

export function GetStartedPage() {
  const { l } = useText();
  const { base, workspace, session } = useViewContext();
  return canSetUp(workspace.role) ? <Wizard key={JSON.stringify([workspace.id, session.user.id])} /> : <>
    <PageHeader title={l(setupText.title)} subtitle={l(setupText.admin)}><Link className="vs-btn" to={base}>{l(setupText.finish)}</Link></PageHeader>
  </>;
}
