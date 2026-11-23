import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Busy, StatusChip } from '@smartsell/ui';
import { useCopy } from '../../i18n';
import { fill } from '../copy';
import { viewPrefix } from '../data/keys';
import { agentState, connectionState } from '../data/logic';
import type { AgentConnection, AgentEnrollment } from '../data/types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, useText } from '../parts';
import { SetupAgent } from './setup-agent';
import { WorkerStep } from './setup-worker';
import { setupText as text } from './setup-copy';
import { activeDevices, canSetUp, dismissSetup, mcpUsed, readSetupNavigation, saveSetupNavigation, setupLocation, setupSteps, workerSetupComplete,
  type Device, type SetupLocation, type SetupStep } from './setup-data';
import './setup.css';

function stepStatus(reads: { isError: boolean; isPending: boolean }[], complete?: boolean, pending?: boolean):
  'unavailable' | 'checking' | 'done' | 'verifying' | 'waiting' {
  if (reads.some(read => read.isError)) return 'unavailable';
  if (reads.some(read => read.isPending)) return 'checking';
  if (complete) return 'done';
  if (pending) return 'verifying';
  return 'waiting';
}

function SetupProgress() {
  const { l } = useText();
  const { t } = useCopy();
  const { base, ws, session } = useViewContext();
  const user = session.user.id;
  const client = useQueryClient();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [navigation, setNavigation] = useState(() => readSetupNavigation(ws, user));
  const [pairingUntil, setPairingUntil] = useState(0);
  const [agentEnrollment, setAgentEnrollment] = useState<AgentEnrollment>();
  const heading = useRef<HTMLHeadingElement>(null);
  const previousStep = useRef<SetupLocation | undefined>(undefined);
  const polling = { refetchInterval: 10_000 };
  const connections = useView<AgentConnection[]>('/agent-connections', {}, polling);
  const devices = useView<Device[]>('/devices', {}, polling);
  const status = {
    agent: stepStatus([connections], connections.value?.some(mcpUsed), connections.value?.some(item => connectionState(item) === 'active')),
    worker: stepStatus([devices], workerSetupComplete(devices.value), activeDevices(devices.value).length > 0 || pairingUntil > Date.now()),
  };
  const remaining = setupSteps.filter(step => status[step] !== 'done');
  const checking = setupSteps.some(step => status[step] === 'checking');
  const requested = params.get('step');
  const mapped = setupLocation(requested);
  const active = mapped ?? navigation.location ?? (checking ? undefined : remaining[0] ?? 'summary');
  useEffect(() => {
    if (mapped && requested !== mapped) {
      const next = new URLSearchParams(location.search);
      next.set('step', mapped);
      void navigate({ search: `?${next}`, hash: location.hash }, { replace: true });
    }
  }, [mapped, requested, location.search, location.hash, navigate]);
  useEffect(() => {
    if (!active) return;
    saveSetupNavigation(ws, user, active, navigation.skipped);
    if (navigation.location !== active) setNavigation(current => ({ ...current, location: active }));
  }, [active, navigation, ws, user]);
  useEffect(() => {
    if (!active || active === previousStep.current || !heading.current) return;
    const target = heading.current;
    if (previousStep.current) {
      const topBar = target.closest('.view-shell')?.querySelector('.vs-top');
      const top = (topBar?.getBoundingClientRect().height ?? 0) + 16;
      const bounds = target.getBoundingClientRect();
      const titleTop = target.parentElement?.getBoundingClientRect().top ?? bounds.top;
      if (titleTop < top || bounds.bottom > window.innerHeight) {
        window.scrollBy({ top: titleTop - top, behavior: 'instant' });
      }
    }
    target.focus({ preventScroll: true });
    previousStep.current = active;
  }, [active]);
  useEffect(() => {
    if (!pairingUntil) return;
    const timer = window.setTimeout(() => setPairingUntil(0), Math.max(0, pairingUntil - Date.now()));
    return () => window.clearTimeout(timer);
  }, [pairingUntil]);

  function select(location: SetupLocation, skip?: SetupStep) {
    setNavigation(current => ({ ...current, skipped: skip ? [...current.skipped.filter(step => step !== skip), skip] : current.skipped.filter(step => step !== location) }));
    const next = new URLSearchParams(params);
    next.set('step', location);
    void navigate({ search: `?${next}` });
  }
  function label(step: SetupStep) {
    const state = status[step];
    if (state === 'waiting' && navigation.skipped.includes(step)) return l(text.skipped);
    if (state === 'done' && step === 'agent') return `${l(text.done)} · ${l(text.agentSeen)}`;
    const seen = connections.value?.some(item => connectionState(item) === 'active' && item.last_used_at);
    const detail = state === 'verifying'
      ? l(step === 'agent' ? (seen ? text.agentWaitingForTools : text.agentIssued) : text.verifying)
      : l(text[state]);
    return state !== 'done' && navigation.skipped.includes(step) ? `${l(text.skipped)} · ${detail}` : detail;
  }
  const leave = () => dismissSetup(ws, user);
  const index = setupSteps.findIndex(step => step === active);
  const next: SetupLocation = index === setupSteps.length - 1 ? 'summary' : setupSteps[index + 1];
  return <>
    <PageHeader title={l(text.title)} subtitle={l(text.intro)}>
      {active !== 'summary' && <Link className="vs-btn" to={base} state={{ skipSetupCheck: true }} onClick={leave}>{l(text.skip)}</Link>}
    </PageHeader>
    <div className="setup-layout">
      <nav aria-label={l(text.steps)} className="setup-progress"><ol role="list">{setupSteps.map((step, position) => <li key={step}>
        <button type="button" aria-current={active === step ? 'step' : undefined} onClick={() => select(step)}>
          <span className="setup-step-number" aria-hidden="true">{position + 1}</span>
          <span><strong>{l(text[step])}</strong><small data-status={status[step]} aria-live={active === step ? 'polite' : undefined}>{label(step)}</small></span>
        </button>
      </li>)}</ol></nav>
      {!active ? <Busy label={t('loading')} /> : <section className="vs-card setup-panel" aria-labelledby="setup-step-title">
        <header className="vs-card-head">
          <div>
            {active !== 'summary' && <small className="muted">{fill(l(text.progress), { step: index + 1, total: setupSteps.length })}</small>}
            <h2 tabIndex={-1} ref={heading} id="setup-step-title">{l(text[active])}</h2>
            {active !== 'summary' && <small className="setup-current-status" data-status={status[active]} aria-hidden="true">{label(active)}</small>}
          </div>
          <button className="vs-btn" type="button" onClick={() => { void client.refetchQueries({ queryKey: viewPrefix(ws), type: 'active' }); }}>{l(text.refresh)}</button>
        </header>
        {active === 'agent' && <><p>{l(text.agentIntro)}</p>
          <Loaded read={connections}>{items => {
            const usable = items.filter(item => connectionState(item) === 'active');
            return <><SetupAgent connections={usable} issued={agentEnrollment} onIssued={setAgentEnrollment} />{usable.length > 0 && <ul className="vs-list">{usable.map(item => <li key={item.id}>
              <strong>{item.label}</strong><StatusChip status={mcpUsed(item) ? 'connected' : 'pending'}
                label={mcpUsed(item) ? (agentState([item]) === 'active' ? text.agentRecent : text.agentQuiet)
                  : item.last_used_at ? text.agentWaitingForTools : text.agentIssued} />
            </li>)}</ul>}</>;
          }}</Loaded></>}
        {active === 'worker' && <><p>{l(text.workerPurpose)}</p><WorkerStep devices={devices} onCodeIssued={setPairingUntil} /></>}
        {active === 'summary' && (remaining.length ? <>
          <h3 className="vs-subhead">{l(text.remaining)}</h3>
          <ul className="vs-list setup-remaining">{remaining.map(step => <li key={step}>
            <button type="button" className="vs-btn" onClick={() => select(step)}>{l(text[step])}</button>
            <small data-status={status[step]}>{label(step)}</small>
          </li>)}</ul>
        </> : <p>{l(text.allDone)}</p>)}
        <footer className="vs-actions setup-footer">
          {active === 'summary' ? <>
            <button className="vs-btn" type="button" onClick={() => select('worker')}>{l(text.back)}</button>
            <Link className="vs-btn primary-soft" to={base} state={{ skipSetupCheck: true }} onClick={leave}>{l(remaining.length ? text.skip : text.finish)}</Link>
          </> : <>
            {index > 0 && <button className="vs-btn" type="button" onClick={() => select(setupSteps[index - 1])}>{l(text.back)}</button>}
            {status[active] !== 'done' && <button className="vs-btn" type="button" onClick={() => select(next, active)}>{l(text.skipStep)}</button>}
            {(next === 'summary' || status[active] === 'done') && <button className="vs-btn primary-soft" type="button" onClick={() => select(next)}>
              {l(next === 'summary' ? text.reviewSetup : text.next)}
            </button>}
          </>}
        </footer>
      </section>}
    </div>
  </>;
}

export function GetStartedPage() {
  const { l } = useText();
  const { base, workspace, session } = useViewContext();
  return canSetUp(workspace.role) ? <SetupProgress key={JSON.stringify([workspace.id, session.user.id])} /> : <>
    <PageHeader title={l(text.title)} subtitle={l(text.admin)}><Link className="vs-btn" to={base}>{l(text.finish)}</Link></PageHeader>
  </>;
}
