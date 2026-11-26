import { Fragment, Suspense, lazy, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Navigate, Route, Routes, useNavigate, useParams, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { Activity, Archive, BarChart3, CalendarDays, CheckSquare, ChevronDown, ChevronRight, Code2, Database, Globe, KeyRound, LayoutGrid, Link2, LogOut, Mail, Megaphone, Package, Pencil, RefreshCw, Search, Settings, Shield, Sparkles, Store, Users, UsersRound, Zap } from 'lucide-react';
import { ApiError, readSession, request, workspacePath, type Operation, type Session } from '@smartsell/sdk';
import { Busy, EmptyState } from '@smartsell/ui';
import { ApiContext, ProblemNotice, sessionKey, wsKey } from './api';
import { useCopy } from './i18n';
import { modules } from './modules';
import { ModulePage } from './WorkspaceViews';
import { AccountSecurity, readTotpStatus } from './account-security';
import { AccountRecovery } from './account-recovery';
import { AuthenticationForm } from './authentication-form';
import { resolveModuleRoute } from './module-routes';
import { Dashboard } from './dashboard';
import { WorkspaceOnboarding } from './workspace-onboarding';
import { BrandScope, useBrandScope } from './workspace-brand-scope';
import { AccessPage } from './access-page';
import { sections } from './catalog';
import { CommandPanel, useCommands } from './command-panel';
import type { Command, Entity } from './workbench-api';
import { ModulePage as RecordsPage } from './workbench-views';
import { Overview } from './overview-page';
import { CommandFailure, CommandLanguage, WorkspaceTools } from './workspace-tools';
import { compatibilityPath, sharedWorkspacePath } from './workspace-entry-paths';
import { setDeveloperMode, useDeveloperMode, usePreference } from './preferences';
import { PrimarySearch } from './primary-search';
import { parseWorkerConnect, WorkerConnectCard, WorkerConnectPage } from './worker-connect';
import { AgentConnectCard, AgentConnectPage, parseAgentConnect } from './agent-connect';
import './styles.css';

const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 15000 } } });
const icons = { workspace: Store, campaign: Megaphone, commerce: Package, content: Pencil, planning: CalendarDays, execution: Activity, inbox: Mail, analytics: BarChart3, asset: Archive, intel: Search, creator: UsersRound, traffic: Link2, ads: Zap, lifecycle: Globe, ingest: Database, agent: Sparkles, account: Shield, team: Users, ops: Settings };
// Grouped by how often operators open them: daily work first, settings folded away.
const groups = [
  ['nav.daily', ['inbox', 'planning', 'content', 'asset', 'execution']],
  ['nav.business', ['campaign', 'commerce', 'creator', 'ads', 'traffic', 'lifecycle']],
  ['nav.insight', ['analytics', 'intel']],
] as const;
const settingsModules = ['workspace', 'account', 'team', 'ingest', 'agent', 'ops'] as const;
const base = (ws: string) => `/w/${encodeURIComponent(ws)}`;
const viewBase = (ws: string) => `/app/${encodeURIComponent(ws)}`;
const ViewApp = lazy(() => import('./view/routes').then(module => ({ default: module.ViewApp })));

async function getSession(signal?: AbortSignal) {
  try { return await readSession(signal);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return { data: null };
    throw error;
  }
}
function Brand() { return <div className="brand"><span><Zap size={19} fill="currentColor" /></span>SmartSell</div>; }
function Language() {
  const { t, locale, setLanguage } = useCopy();
  return <label className="language"><Globe size={15} /><select aria-label={t('language')} value={locale} onChange={event => setLanguage(event.target.value)}><option value="zh-Hant">繁體中文</option><option value="en">English</option></select></label>;
}

function Authentication({ setupPath, registerToMain, workerConnection }: { setupPath: boolean; registerToMain: boolean; workerConnection?: boolean }) {
  const { t } = useCopy();
  const developer = useDeveloperMode();
  return <div className={workerConnection ? 'auth-page worker-connect-login' : 'auth-page'}><aside className="auth-side"><Brand /><h1>{t('authWelcome')}</h1></aside>
    <main className="auth-main"><Language /><section className="auth-card">
      <AuthenticationForm setupPath={setupPath} showCompatibility={developer}
        readSession={async () => (await getSession()).data}
        onSession={async (session, mode) => {
          if (registerToMain && mode === 'register') {
            window.location.replace('/login');
            return;
          }
          await client.cancelQueries({ queryKey: sessionKey });
          client.setQueryData(sessionKey, { data: session });
        }} />
    </section></main></div>;
}

const INVITATION_TOKEN_KEY = 'smartsell:invite-token';

/** The member invitation token from the link fragment, or the one this tab already read (S15). */
function invitationToken(hash: string) {
  const fromLink = /^[A-Za-z0-9_-]{43}$/.test(hash.slice(1)) ? hash.slice(1) : undefined;
  try {
    if (fromLink) window.sessionStorage.setItem(INVITATION_TOKEN_KEY, fromLink);
    else return window.sessionStorage.getItem(INVITATION_TOKEN_KEY) ?? undefined;
  } catch { /* storage unavailable: a reload needs the link again */ }
  return fromLink;
}

function MemberInvitation() {
  const { t, label } = useCopy();
  const { hash } = useLocation();
  const navigate = useNavigate();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const flight = useRef(false);
  const title = label(['接受成員邀請', 'Accept member invitation']);
  // S15: read the invitation token once, keep it for this tab (a reload still works) and take it out of the address bar.
  const [tokenFromLink] = useState(() => invitationToken(hash));
  useEffect(() => {
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname + window.location.search);
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (flight.current) return;
    const form = event.currentTarget;
    const { email, name, password, token } = Object.fromEntries(new FormData(form));
    const passwordInput = form.elements.namedItem('password');
    if (passwordInput instanceof HTMLInputElement) passwordInput.value = '';
    flight.current = true;
    setPending(true);
    setError(undefined);
    try {
      await request('/api/v1/member-invitations/accept', {
        method: 'POST', body: { email, name, password, token: tokenFromLink ?? token },
      });
      try { window.sessionStorage.removeItem(INVITATION_TOKEN_KEY); } catch { /* storage unavailable */ }
      navigate('/login', { replace: true });
    } catch (failure) { setError(failure); }
    finally { flight.current = false; setPending(false); }
  }

  return <div className="auth-page"><aside className="auth-side"><Brand /><h1>{t('authWelcome')}</h1></aside>
    <main className="auth-main"><Language /><section className="auth-card"><h2>{title}</h2>
      <form className="fields" onSubmit={submit}><fieldset disabled={pending}>
        {!tokenFromLink && <label className="field">{label(['邀請權杖', 'Invitation token'])}<input name="token" type="password" autoComplete="off" required pattern="[A-Za-z0-9_\-]{43}" maxLength={43} /></label>}
        <label className="field">{t('email')}<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
        <label className="field">{t('displayName')}<input name="name" required maxLength={120} autoComplete="name" /></label>
        <label className="field">{t('password')}<input name="password" type="password" required minLength={12} autoComplete="new-password" /></label>
        <button className="primary" type="submit">{pending ? t('saving') : title}</button>
      </fieldset></form>{error !== undefined && <ProblemNotice error={error} />}
      <Link to="/login">{t('login')}</Link>
    </section></main></div>;
}

function DeveloperToggle() {
  const { t } = useCopy();
  const developer = useDeveloperMode();
  return <button className={developer ? 'icon-button developer-on' : 'icon-button'} aria-pressed={developer} aria-label={t('developerMode')} title={t(developer ? 'developerModeOn' : 'developerMode')}
    onClick={() => setDeveloperMode(!developer)}><Code2 size={16} /></button>;
}

function SignOut({ session }: { session: Session }) {
  const { t } = useCopy();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  async function logout() {
    setPending(true); setError(undefined);
    try {
      await request('/api/v1/session', { method: 'DELETE', csrf: session.csrf_token });
      window.location.replace('/login');
    } catch (failure) { setError(failure); }
    finally { setPending(false); }
  }
  return <><button className="icon-button" aria-label={t('logout')} title={t('logout')} disabled={pending} onClick={() => void logout()}><LogOut size={16} /></button>{error !== undefined && <ProblemNotice error={error} />}</>;
}

function Workspace({ session, compatibility, administrative = false }: { session: Session; compatibility: boolean; administrative?: boolean }) {
  const { ws: routeWorkspace, '*': section = 'home' } = useParams();
  const ws = administrative ? session.workspaces[0].id : routeWorkspace ?? '';
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const { t } = useCopy();
  const developer = useDeveloperMode();
  const workspace = session.workspaces.find(item => item.id === ws);
  const access = ['access', 'settings/access'].includes(section);
  const params = new URLSearchParams(search);
  const records = params.get('source') === 'commands';
  let alternateQuery = search;
  if (records) {
    params.delete('source');
    alternateQuery = params.size ? `?${params}` : '';
  }
  const alternateEntry = `${compatibility ? '' : sharedWorkspacePath}${pathname}${alternateQuery}${hash}`;
  const dashboard = administrative ? undefined : section === 'me' ? 'personal' : section === 'home/summary' ? 'summary' : section === 'home' ? 'today' : undefined;
  const resolved = resolveModuleRoute(pathname);
  const active = resolved?.module;
  const catalog = useQuery({ queryKey: [...wsKey(ws), 'catalog'], enabled: Boolean(workspace), queryFn: async ({ signal }) => {
    const { data } = await request<Operation[]>(`${workspacePath(ws)}/catalog`, { signal });
    if (!Array.isArray(data)) throw new ApiError(502, { code: 'INVALID_RESPONSE' });
    return data.filter(op => op && typeof op.name === 'string' && typeof op.module === 'string');
  } });
  const brand = useBrandScope({ ws, session, catalog: catalog.data ?? [] });
  const [refreshing, setRefreshing] = useState(false);
  const security = useQuery({
    queryKey: ['account-security', session.user.id],
    enabled: Boolean(session.csrf_token && session.user.id),
    queryFn: ({ signal }) => readTotpStatus(signal),
  });
  const workspaceId = workspace?.id;
  useEffect(() => {
    if (!workspaceId || typeof EventSource === 'undefined') return;
    const stream = new EventSource(`${workspacePath(workspaceId)}/stream`);
    stream.addEventListener('workspace.changed', () => void client.invalidateQueries({ queryKey: wsKey(workspaceId) }));
    return () => stream.close();
  }, [workspaceId]);
  const noCatalog = catalog.error instanceof ApiError && [404, 405].includes(catalog.error.status);
  const settingsActive = access || section === 'settings/security' || settingsModules.some(key => key === active?.key);
  const [settingsPreference, setSettingsPreference] = usePreference('nav.settings', 'closed');
  const settingsOpen = settingsActive || settingsPreference === 'open';
  const securityAvailable = Boolean(security.data && session.csrf_token && session.user.id);
  const recoveryAvailable = Boolean(session.csrf_token && (workspace?.role === 'owner' || workspace?.role === 'admin'));
  if (!workspace) return <Navigate to={`${base(session.workspaces[0].id)}/home`} replace />;
  async function refresh() {
    setRefreshing(true);
    try {
      await client.invalidateQueries({ queryKey: sessionKey });
      await client.invalidateQueries({ queryKey: wsKey(ws) });
    } finally { setRefreshing(false); }
  }
  return <div className="app-shell"><aside className="sidebar"><Brand />
    <label className="workspace-select"><span>{t('workspace')}</span><select value={ws} onChange={event => navigate(`${base(event.target.value)}/home`)}>{session.workspaces.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    <nav className="nav" aria-label={t('allModules')}><Link className={dashboard ? 'active' : ''} to={`${base(ws)}/home`}><LayoutGrid size={17} />{t('home')}</Link>
      {groups.map(([group, keys]) => <section key={group}><h2>{t(group)}</h2>{keys.map(key => {
        const module = modules.find(item => item.key === key)!;
        const Icon = icons[key];
        const current = active?.key === key && !(key === 'planning' && section === 'approvals');
        return <Fragment key={key}><Link className={current ? 'active' : ''} aria-current={current ? 'page' : undefined} to={`${base(ws)}/${module.route}`}><Icon size={17} />{t(`module.${key}`)}</Link>
          {key === 'planning' && <Link className={section === 'approvals' ? 'active nav-sub' : 'nav-sub'} aria-current={section === 'approvals' ? 'page' : undefined} to={`${base(ws)}/approvals`}><CheckSquare size={15} />{t('nav.approvals')}</Link>}</Fragment>;
      })}</section>)}
      <section className="nav-settings"><h2><button type="button" aria-expanded={settingsOpen} onClick={() => setSettingsPreference(settingsOpen && !settingsActive ? 'closed' : 'open')}>
        {settingsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{t('nav.settings')}</button></h2>
        {settingsOpen && <>{settingsModules.map(key => {
          const module = modules.find(item => item.key === key)!;
          const Icon = icons[key];
          return <Link key={key} className={active?.key === key ? 'active' : ''} aria-current={active?.key === key ? 'page' : undefined} to={`${base(ws)}/${module.route}`}><Icon size={17} />{t(`module.${key}`)}</Link>;
        })}
        <Link className={access ? 'active' : ''} aria-current={access ? 'page' : undefined} to={`${base(ws)}/access`}><KeyRound size={17} />{t('nav.access')}</Link>
        {(securityAvailable || recoveryAvailable) && <Link className={section === 'settings/security' ? 'active' : ''} to={`${base(ws)}/settings/security`} aria-current={section === 'settings/security' ? 'page' : undefined}><Shield size={17} />{t('security.title')}</Link>}</>}
      </section></nav>
    <div className="sidebar-footer"><span className="avatar">{(session.user.name ?? session.user.email ?? 'S').slice(0, 1).toUpperCase()}</span><span title={session.user.email}>{session.user.name ?? session.user.email}</span><DeveloperToggle /><SignOut session={session} /></div>
  </aside><div className="main-frame"><header className="topbar"><div className="breadcrumb"><span>{workspace.name}</span><span>/</span><strong>{active ? t(`module.${active.key}`) : t('home')}</strong></div><div className="toolbar"><BrandScope scope={brand} />{(developer || compatibility) && <a className="button" href={alternateEntry}>{t(compatibility ? 'backToWorkspaceView' : 'compatibilityWorkbench')}</a>}{compatibility && <a className="button" href={`${compatibilityPath}${base(ws)}/home`}>{t('commandRecords')}</a>}{catalog.data && <ApiContext.Provider value={{ ws, session, catalog: catalog.data, brandId: brand.brandId, compatibility }}><PrimarySearch /></ApiContext.Provider>}<CommandLanguage><WorkspaceTools key={ws} ws={ws} /></CommandLanguage><button className="icon-button" disabled={refreshing} aria-label={t('refresh')} title={t('refresh')} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'rotating' : undefined} /></button><Language /></div></header>
    <main className="workspace-main">{section === 'settings/security' && (securityAvailable || recoveryAvailable || (security.isPending && security.fetchStatus !== 'idle')) ? <div className="account-security-page">
      {security.isPending && security.fetchStatus !== 'idle' && <Busy label={t('loading')} />}
      {securityAvailable && session.csrf_token && session.user.id && <AccountSecurity key={session.user.id} userId={session.user.id} csrf={session.csrf_token} />}
      {recoveryAvailable && session.csrf_token && <AccountRecovery key={`${ws}/${session.user.id}`} workspace={workspace} csrf={session.csrf_token} />}
    </div> : access ? <CommandLanguage><AccessPage key={ws} workspace={{ ...workspace, role: workspace.role ?? '' }} userId={session.user.id ?? ''} /></CommandLanguage> :
      records || noCatalog ? <CommandLanguage><RecordsRoute key={`${ws}/${section}`} ws={ws} workspace={{ ...workspace, role: workspace.role ?? '' }} userId={session.user.id ?? ''} path={section} module={active?.key} /></CommandLanguage> :
      catalog.isPending ? <Busy label={t('loading')} /> : catalog.isError ? <ProblemNotice error={catalog.error} retry={() => void catalog.refetch()} /> :
      <ApiContext.Provider value={{ ws, session, catalog: catalog.data ?? [], brandId: brand.brandId, compatibility }}>
        {active?.key === 'workspace' && (section === 'setup' || new URLSearchParams(search).get('tab') === 'setup') ? <WorkspaceOnboarding key={ws} /> : dashboard ? <Dashboard key={ws} view={dashboard} /> : active ? <ModulePage key={`${ws}-${pathname}-${brand.brandId}`} module={active} initialTab={resolved.resource?.key} initialId={resolved.id} initialVersion={resolved.version} initialView={resolved.view} /> : <Navigate to={`${base(ws)}/home`} replace />}
      </ApiContext.Provider>}
    </main></div></div>;
}

function RecordsRoute({ ws, workspace, userId, path, module }: {
  ws: string; workspace: Parameters<typeof AccessPage>[0]['workspace']; userId: string; path: string; module?: string;
}) {
  const { t } = useCopy();
  const commands = useCommands(ws);
  const location = useLocation();
  const [drawer, setDrawer] = useState<{ command: Command; record?: Entity }>();
  if (commands.isPending) return <Busy label={t('loading')} />;
  if (commands.isError) return <CommandFailure error={commands.error} retry={() => void commands.refetch()} />;
  const section = sections.find(item => item.path === path) ?? sections.find(item => 'module' in item && item.module === module);
  const items = commands.data.items;
  if (path.startsWith('home')) return <Overview wid={ws} commands={items} />;
  if (!section || !('module' in section)) return <EmptyState title={t('noAccess')} />;
  return <>
    <div className="panel-head record-source"><span>{t('commandRecords')}</span>{new URLSearchParams(location.search).get('source') === 'commands' && <Link to={location.pathname}>{t('backToWorkspaceView')}</Link>}</div>
    <RecordsPage wid={ws} workspace={workspace} userId={userId} commands={items} section={section} open={(command, record) => setDrawer({ command, record })} />
    {drawer && <CommandPanel wid={ws} commands={items} initial={drawer.command} selected={drawer.record} close={() => setDrawer(undefined)} />}
  </>;
}

function App({ compatibility }: { compatibility: boolean }) {
  const { t, label } = useCopy();
  const location = useLocation();
  const returnable = (path?: string | null) => Boolean(path && (path.startsWith('/w/') || path.startsWith('/app/')));
  const workerIntent = location.pathname === '/worker-connect' && !location.hash ? parseWorkerConnect(location.search) : undefined;
  const agentIntent = location.pathname === '/agent-connect' && !location.hash ? parseAgentConnect(location.search) : undefined;
  const returnHash = location.hash.startsWith('#worker-pair=') ? '' : location.hash;
  const next = returnable(location.pathname) || workerIntent || agentIntent
    ? `?next=${encodeURIComponent(location.pathname + location.search + returnHash)}` : '';
  const returnTo = new URLSearchParams(location.search).get('next');
  const workerReturn = returnTo?.startsWith('/worker-connect?') && !returnTo.includes('#') && parseWorkerConnect(returnTo.slice('/worker-connect'.length));
  const agentReturn = returnTo?.startsWith('/agent-connect?') && !returnTo.includes('#') && parseAgentConnect(returnTo.slice('/agent-connect'.length));
  const signedInDestination = returnable(returnTo) || workerReturn || agentReturn ? returnTo! : '/';
  const session = useQuery({ queryKey: sessionKey, queryFn: ({ signal }) => getSession(signal) });
  const data = session.data?.data;
  const ws = data?.workspaces?.[0]?.id;
  const auth = (setupPath: boolean) => data?.user ? <Navigate to={signedInDestination} replace /> :
    session.isPending ? <Busy label={t('loading')} /> : session.isError ? <main className="entry-error"><Brand />
      <ProblemNotice error={session.error} retry={() => void session.refetch()} /><Language /></main> :
        <Authentication setupPath={setupPath} registerToMain={compatibility && signedInDestination === '/'} workerConnection={Boolean(workerReturn || agentReturn)} />;
  return <><div className="narrow-notice">{t('narrow')}</div><Routes>
    <Route path="/setup" element={auth(true)} />
    <Route path="/login" element={auth(false)} />
    <Route path="/worker-connect" element={!workerIntent ? <WorkerConnectCard language={<Language />}>
      <p role="alert">{label(['連接請求無效，請回到桌面程式重新開始。', 'Invalid connection request. Start again from the desktop app.'])}</p>
    </WorkerConnectCard> : session.isPending ? <div className="worker-connect"><Busy label={t('loading')} /></div> : session.isError ? <WorkerConnectCard language={<Language />}>
      <ProblemNotice error={session.error} retry={() => void session.refetch()} />
    </WorkerConnectCard> : data?.user ? <WorkerConnectPage key={location.key} session={data} intent={workerIntent} language={<Language />} />
      : <Navigate to={`/login${next}`} replace />} />
    <Route path="/agent-connect" element={!agentIntent ? <AgentConnectCard language={<Language />}>
      <p role="alert">{label(['連接請求無效，請回到 SmartSell App 重新開始。', 'Invalid connection request. Start again from the SmartSell App.'])}</p>
    </AgentConnectCard> : session.isPending ? <div className="worker-connect"><Busy label={t('loading')} /></div> : session.isError ? <AgentConnectCard language={<Language />}>
      <ProblemNotice error={session.error} retry={() => void session.refetch()} />
    </AgentConnectCard> : data?.user ? <AgentConnectPage key={location.key} session={data} intent={agentIntent} language={<Language />} />
      : <Navigate to={`/login${next}`} replace />} />
    <Route path="/invite" element={<MemberInvitation />} />
    {ws && data && <Route path="/app/:ws/*" element={<Suspense fallback={<Busy label={t('loading')} />}><ViewApp session={data} compatibility={compatibility} /></Suspense>} />}
    {ws && data && <Route path="/w/:ws/*" element={<Workspace session={data} compatibility={compatibility} />} />}
    {ws && data && <Route path="/admin/*" element={<Workspace session={data} compatibility={compatibility} administrative />} />}
    <Route path="*" element={session.isPending ? <Busy label={t('loading')} /> : session.isError ? <main className="entry-error"><Brand /><ProblemNotice error={session.error} retry={() => void session.refetch()} /><div className="toolbar"><Link className="button" to="/login">{t('login')}</Link><Link className="button" to="/setup">{t('setup')}</Link><a className="button" href="/compat/workbench/login">{t('compatibilityWorkbench')}</a><Language /></div></main> : ws ? <Navigate to={compatibility ? `${base(ws)}/home` : viewBase(ws)} state={location.pathname === '/' ? undefined : { skipSetupCheck: true }} replace /> : data?.user ? <main className="entry-error"><EmptyState title={t('noWorkspaces')} /><SignOut session={data} /></main> : <Navigate to={`/login${next}`} replace />} />
  </Routes></>;
}

export function mountPrimary(root: HTMLElement, basename?: string) {
  createRoot(root).render(<QueryClientProvider client={client}><BrowserRouter basename={basename}><App compatibility={Boolean(basename)} /></BrowserRouter></QueryClientProvider>);
}
