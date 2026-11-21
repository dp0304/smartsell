import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { Busy, StatusChip, type Tuple } from '@smartsell/ui';
import { ProblemNotice } from '../../api';
import { useCopy } from '../../i18n';
import { agentState, connectionState } from '../data/logic';
import type { AgentConnection } from '../data/types';
import { useView, useViewContext } from '../data/use-view';
import { Loaded, PageHeader, useText } from '../parts';
import { AgentConnect } from './AgentPage';
import { OverviewPage } from './OverviewPage';
import { SocialStep, WorkerStep } from './setup-connections';
import { setupText as text } from './setup-copy';
import { canSetUp, dismissSetup, mcpUsed, pairedDevice, setupDismissed, setupSteps, verifiedSession,
  type BrowserSession, type Device, type SetupStep, type Store, type WorkerCatalog } from './setup-data';
import { StoreStep } from './setup-store';
import type { Row } from './settings-logic';
import './setup.css';

function useSetupInventory(enabled = true, poll = false) {
  const options = { enabled, refetchInterval: poll ? 10_000 : undefined };
  const connections = useView<AgentConnection[]>('/agent-connections', {}, options);
  const devices = useView<Device[]>('/devices', {}, options);
  const accounts = useView<Row[]>('/social-accounts', {}, { enabled, allPages: true });
  const stores = useView<Store[]>('/stores', {}, { enabled, allPages: true });
  return { connections, devices, accounts, stores };
}

/** Only the normal sign-in redirect nominates the workspace index for an onboarding check. */
export function SetupLanding({ fromSignIn }: { fromSignIn: boolean }) {
  const { t } = useCopy();
  const { base, ws, session, workspace } = useViewContext();
  const eligible = fromSignIn && workspace.role === 'owner' && !setupDismissed(ws, session.user.id);
  const inventory = useSetupInventory(eligible);
  const brands = useView<Row[]>('/brands', {}, { enabled: eligible });
  const presence = useView<{ connections?: number | null; last_seen_at?: string | null }>('/views/agent-presence', {}, { enabled: eligible });
  if (!eligible) return <OverviewPage />;
  const resources = [...Object.values(inventory), brands];
  // Clear the sign-in state once resolved so later refreshes of the overview cannot redirect it.
  if (resources.some(read => read.isError || (Array.isArray(read.value) && read.value.length > 0)) ||
    presence.isError || presence.value?.connections || presence.value?.last_seen_at) return <Navigate to={base} replace />;
  if (resources.some(read => read.isPending) || presence.isPending) return <Busy label={t('loading')} />;
  const empty = resources.every(read => Array.isArray(read.value) && read.value.length === 0) && presence.value;
  return <Navigate to={empty ? `${base}/get-started` : base} replace />;
}

function stepFrom(value: string | null): SetupStep | undefined {
  return setupSteps.find(step => step === value);
}

function SetupProgress() {
  const { l } = useText();
  const { t } = useCopy();
  const { base, ws, session } = useViewContext();
  const [params, setParams] = useSearchParams();
  const inventory = useSetupInventory(true, true);
  const { connections, devices, accounts, stores } = inventory;
  const brands = useView<Row[]>('/brands', {}, { allPages: true });
  const sessions = useView<BrowserSession[]>('/browser-sessions', {}, { refetchInterval: 10_000 });
  const catalog = useView<WorkerCatalog>('/worker-catalog', {}, { refetchInterval: 10_000 });
  const supported = Object.values(inventory);
  const [initial, setInitial] = useState<SetupStep>();
  const heading = useRef<HTMLHeadingElement>(null);
  const explicitStep = stepFrom(params.get('step'));
  const active = explicitStep ?? initial;
  const reads = [...supported, sessions, catalog, brands];
  const loading = reads.some(read => read.isPending);
  const done = {
    agent: connections.value?.some(mcpUsed),
    worker: pairedDevice(devices.value),
    social: accounts.value?.some(account => {
      const found = sessions.value?.filter(item => item.social_account_id === account.id);
      return account.status === 'active' && found?.length === 1 && verifiedSession(found[0], devices.value);
    }),
    store: catalog.value?.jobs?.some(job => job.status === 'imported'),
  };
  const suggested = setupSteps.find(step => !done[step]) ?? 'store';
  useEffect(() => {
    if (!initial && (explicitStep || !loading)) setInitial(explicitStep ?? suggested);
  }, [explicitStep, initial, loading, suggested]);
  useEffect(() => { if (active) heading.current?.focus(); }, [active]);
  const status: Record<SetupStep, Tuple> = {
    agent: connections.isError ? text.unavailable : done.agent ? text.agentSeen : connections.value?.some(item => connectionState(item) === 'active') ? text.agentIssued : text.waiting,
    worker: devices.isError ? text.unavailable : devices.value?.some(item => item.status === 'active' && item.online === true) ? text.online : done.worker ? text.paired : text.waiting,
    social: accounts.isError || sessions.isError ? text.unavailable : done.social ? text.verified : sessions.value?.length ? text.bound : accounts.value?.length ? text.registered : text.waiting,
    store: stores.isError || catalog.isError ? text.unavailable : done.store ? text.imported : catalog.value?.bindings?.length ? text.bound : text.waiting,
  };
  function select(step: SetupStep) {
    setParams(current => { const next = new URLSearchParams(current); next.set('step', step); return next; });
  }
  const leave = () => dismissSetup(ws, session.user.id);
  const index = active ? setupSteps.indexOf(active) : -1;
  return <>
    <PageHeader title={l(text.title)} subtitle={l(text.intro)}><Link className="vs-btn" to={base} onClick={leave}>{l(text.skip)}</Link></PageHeader>
    <div className="setup-layout">
      <nav aria-label={l(text.steps)} className="setup-steps"><ol>{setupSteps.map((step, position) => <li key={step}>
        <button type="button" aria-current={active === step ? 'step' : undefined} onClick={() => select(step)}>
          <span className="setup-step-number" aria-hidden="true">{position + 1}</span>
          <span><strong>{l(text[step])}</strong><small>{l(status[step])}</small></span>
        </button>
      </li>)}</ol></nav>
      {!active ? <Busy label={t('loading')} /> : <section className="vs-card setup-panel" aria-labelledby="setup-step-title">
        <header className="vs-card-head"><h2 tabIndex={-1} ref={heading} id="setup-step-title">{index + 1}. {l(text[active])}</h2>
          <button className="vs-btn" type="button" onClick={() => { for (const read of reads) void read.refetch(); }}>{l(text.refresh)}</button></header>
        {active === 'agent' && <><p>{l(text.agentIntro)}</p><AgentConnect guided connections={connections.value} />
          <Loaded read={connections}>{items => {
            const usable = items.filter(item => connectionState(item) === 'active');
            return usable.length > 0 && <ul className="vs-list">{usable.map(item => <li key={item.id}>
              <strong>{item.label}</strong><StatusChip status={mcpUsed(item) ? 'connected' : 'pending'}
                label={!mcpUsed(item) ? text.agentIssued : agentState([item]) === 'active' ? text.agentRecent : text.agentQuiet} />
            </li>)}</ul>;
          }}</Loaded></>}
        {active === 'worker' && <WorkerStep devices={devices} />}
        {(active === 'social' || active === 'store') && devices.isError && <ProblemNotice error={devices.error} retry={() => void devices.refetch()} />}
        {active === 'social' && <SocialStep devices={devices.value ?? []} accounts={accounts} sessions={sessions} brands={brands} />}
        {active === 'store' && <StoreStep devices={devices.value ?? []} stores={stores} brands={brands} catalog={catalog} />}
        <footer className="vs-actions setup-footer">
          {index > 0 && <button className="vs-btn" type="button" onClick={() => select(setupSteps[index - 1])}>{l(text.back)}</button>}
          {index < setupSteps.length - 1 ? <button className="vs-btn primary-soft" type="button" onClick={() => select(setupSteps[index + 1])}>{l(text.next)}</button>
            : <Link className="vs-btn primary-soft" to={base} onClick={leave}>{l(text.finish)}</Link>}
        </footer>
      </section>}
    </div>
  </>;
}

export function GetStartedPage() {
  const { l } = useText();
  const { base, workspace, session } = useViewContext();
  return canSetUp(workspace.role) ? <SetupProgress key={`${workspace.id}/${session.user.id}`} /> : <>
    <PageHeader title={l(text.title)} subtitle={l(text.admin)}><Link className="vs-btn" to={base}>{l(text.finish)}</Link></PageHeader>
  </>;
}
