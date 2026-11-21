import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BarChart3, Bot, BriefcaseBusiness, CalendarDays, Globe, LayoutDashboard, ListChecks, LogOut, Megaphone, Menu, Package, Settings, SlidersHorizontal, Target, Wrench, X, Zap } from 'lucide-react';
import { asRecord, request } from '@smartsell/sdk';
import { isNum, type Tuple } from '@smartsell/ui';
import { useCopy } from '../i18n';
import { copy } from './copy';
import { activePreset, periodPresets, readPeriod, todayIn, withPeriod } from './data/period';
import { useView, useViewContext, workspaceZone } from './data/use-view';
import { agentState, periodDefaults, sectionOf } from './data/logic';
import type { AgentConnection, DecisionSummary } from './data/types';
import { useText } from './parts';
import { setupText } from './pages/setup-copy';
import { canSetUp } from './pages/setup-data';

export const navEntries = [
  { path: '', icon: LayoutDashboard, label: copy.nav.overview },
  { path: 'products', icon: Package, label: copy.nav.products },
  { path: 'plans', icon: Megaphone, label: copy.nav.plans },
  { path: 'calendar', icon: CalendarDays, label: copy.nav.calendar },
  { path: 'social', icon: BarChart3, label: copy.nav.social },
  { path: 'ads', icon: Target, label: copy.nav.ads },
  { path: 'decisions', icon: ListChecks, label: copy.nav.decisions },
  { path: 'agent', icon: Bot, label: copy.nav.agent },
  { path: 'settings', icon: Settings, label: copy.nav.settings },
  { path: 'get-started', icon: SlidersHorizontal, label: setupText.title },
] as const;

// Read by every page, so it is a small read model rather than the whole home view.
type AgentPresence = { connections?: number | null; last_seen_at?: string | null; timezone?: string };
const usePresence = () => useView<AgentPresence>('/views/agent-presence');

function AgentDot({ to }: { to: string }) {
  const { l } = useText();
  const read = useView<AgentConnection[]>('/agent-connections');
  // Connections are listed per person; the presence view knows whether any agent in the workspace is connected.
  const presence = usePresence().value;
  const own = agentState(Array.isArray(read.value) ? read.value : undefined);
  const state = own === 'active' || !presence?.connections ? own
    : presence.last_seen_at && Date.now() - Date.parse(presence.last_seen_at) < 30 * 60_000 ? 'active' : own === 'unknown' ? 'idle' : own === 'none' ? 'idle' : own;
  return <Link to={to} className={`vs-agent-dot state-${state}`} title={l(copy.agentStatus[state])}><i aria-hidden="true" /><span>{l(copy.agentStatus[state])}</span></Link>;
}

function BrandFilter() {
  const { l } = useText();
  const [params, setParams] = useSearchParams();
  const read = useView<Record<string, unknown>[]>('/brands');
  const brands = (Array.isArray(read.value) ? read.value : []).map(asRecord).filter(row => row.status === undefined || row.status === 'active');
  const current = params.get('brand') ?? '';
  if (brands.length < 2 && !current) return null;
  return <label className="vs-select"><span className="vs-sr">{l(copy.shell.brand)}</span>
    <select value={current} onChange={event => { const next = new URLSearchParams(params); if (event.target.value) next.set('brand', event.target.value); else next.delete('brand'); setParams(next); }}>
      <option value="">{l(copy.shell.allBrands)}</option>
      {brands.map(row => <option key={String(row.id)} value={String(row.id)}>{String(row.name ?? row.id)}</option>)}
    </select></label>;
}

const presetLabel: Record<number, Tuple> = { 7: copy.period.days7, 30: copy.period.days30, 90: copy.period.days90 };
function PeriodPicker({ defaultDays }: { defaultDays: number }) {
  const { l } = useText();
  const { ws } = useViewContext();
  const [params, setParams] = useSearchParams();
  const presence = usePresence();
  // Presence carries the workspace zone, so "today" is right even on pages without a zone of their own (ads, products).
  const today = todayIn(workspaceZone(ws) ?? presence.value?.timezone);
  const period = readPeriod(params, defaultDays);
  const active = activePreset(period, today);
  return <div className="vs-period" role="group" aria-label={l(copy.shell.period)}>
    {periodPresets.map(days => <button key={days} type="button" aria-pressed={active === days} onClick={() => setParams(withPeriod(params, days, today, defaultDays))}>{l(presetLabel[days])}</button>)}
    {active === null && period.from && <span className="vs-period-custom" title={l(copy.period.custom)}>{period.from} – {period.to}</span>}
  </div>;
}

function Language() {
  const { locale, setLanguage } = useCopy();
  const { l } = useText();
  return <label className="vs-select vs-language"><Globe size={15} aria-hidden="true" /><span className="vs-sr">{l(copy.shell.language)}</span>
    <select value={locale} onChange={event => setLanguage(event.target.value)}><option value="zh-Hant">繁體中文</option><option value="en">English</option></select></label>;
}

function SignOut() {
  const { session } = useViewContext();
  const { l } = useText();
  const [pending, setPending] = useState(false);
  async function logout() {
    setPending(true);
    try { await request('/api/v1/session', { method: 'DELETE', csrf: session.csrf_token }); window.location.replace('/login'); }
    catch { setPending(false); }
  }
  return <button type="button" className="vs-icon-button" disabled={pending} aria-label={l(copy.shell.signOut)} title={l(copy.shell.signOut)} onClick={() => void logout()}><LogOut size={16} /></button>;
}

export function ViewShell() {
  const { ws, session, workspace, base } = useViewContext();
  const { l } = useText();
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLElement>(null);
  const section = sectionOf(pathname);
  const summary = useView<DecisionSummary>('/views/decisions/summary');
  const pending = summary.value?.total;
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    closeButton.current?.focus();
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [open]);
  function closeMenu() {
    setOpen(false);
    menuButton.current?.focus();
  }
  const carry = new URLSearchParams([...params].filter(([key]) => ['brand', 'from', 'to'].includes(key))).toString();
  const user = session.user.name ?? session.user.email ?? '';
  return <div className="view-shell" data-menu={open ? 'open' : 'closed'}>
    <a className="vs-skip" href="#vs-content" onClick={event => { event.preventDefault(); setOpen(false); content.current?.focus(); }}>{l(copy.shell.skipToContent)}</a>
    <aside className="vs-nav" id="vs-nav">
      <Link className="vs-brand" to={{ pathname: base, search: carry }} onClick={open ? closeMenu : undefined}><span><Zap size={17} fill="currentColor" aria-hidden="true" /></span>SmartSell</Link>
      <button type="button" ref={closeButton} className="vs-icon-button vs-nav-close" aria-label={l(copy.nav.close)} onClick={closeMenu}><X size={18} /></button>
      <nav aria-label={l(copy.nav.label)}>
        {navEntries.map(entry => {
          if (entry.path === 'get-started' && !canSetUp(workspace.role)) return null;
          const current = section === entry.path;
          const Icon = entry.icon;
          return <Link key={entry.path} to={{ pathname: entry.path ? `${base}/${entry.path}` : base, search: carry ? `?${carry}` : '' }} aria-current={current ? 'page' : undefined} className={current ? 'active' : undefined} onClick={open ? closeMenu : undefined}>
            <Icon size={17} aria-hidden="true" /><span>{l(entry.label)}</span>
            {entry.path === 'decisions' && isNum(pending) && pending > 0 && <span className="vs-badge" aria-label={`${pending} ${l(copy.nav.pending)}`}>{pending > 99 ? '99+' : pending}</span>}
          </Link>;
        })}
      </nav>
      <div className="vs-nav-foot">
        <Link to={`/w/${encodeURIComponent(ws)}/home`} className="vs-advanced"><Wrench size={15} aria-hidden="true" />{l(copy.nav.advanced)}</Link>
        <div className="vs-user"><span className="vs-avatar" aria-hidden="true">{(user || 'S').slice(0, 1).toUpperCase()}</span><span title={session.user.email}>{user}</span><SignOut /></div>
      </div>
    </aside>
    <div className="vs-frame">
      <header className="vs-top">
        <button type="button" ref={menuButton} className="vs-icon-button vs-menu" aria-expanded={open} aria-controls="vs-nav" aria-label={l(open ? copy.nav.close : copy.nav.menu)} onClick={open ? closeMenu : () => setOpen(true)}>{open ? <X size={18} /> : <Menu size={18} />}</button>
        {session.workspaces.length > 1 ? <label className="vs-select vs-workspace"><BriefcaseBusiness size={16} aria-hidden="true" /><span className="vs-sr">{l(copy.shell.workspace)}</span>
          <select value={ws} onChange={event => navigate(`/app/${encodeURIComponent(event.target.value)}`)}>{session.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
        </label> : <strong className="vs-workspace" title={workspace.name}><BriefcaseBusiness size={16} aria-hidden="true" /><span>{workspace.name}</span></strong>}
        <BrandFilter />
        {Object.hasOwn(periodDefaults, section) && <PeriodPicker defaultDays={periodDefaults[section]} />}
        <span className="vs-top-spacer" />
        <AgentDot to={`${base}/agent`} />
        <Language />
      </header>
      <main className="vs-content" id="vs-content" ref={content} tabIndex={-1}><Outlet /></main>
    </div>
  </div>;
}
