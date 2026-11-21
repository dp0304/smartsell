import { languages, setLanguage } from './locale';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Boxes, Globe2, LogOut, Monitor, Search, Wrench } from 'lucide-react';
import { Link, Navigate, NavLink, Outlet, Route, Routes, useOutletContext, useHref, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api, ApiError, type Command, type Entity, type Session } from './workbench-api';
import { sections } from './catalog';
import { CommandPanel, useCommands } from './command-panel';
import { Dialog, Empty, Failure, useFormat } from './workbench-ui';
import { ModulePage } from './workbench-views';
import { Overview } from './overview-page';
import { AccessPage } from './access-page';
import { SearchPanel } from './search-panel';
import { has } from './workbench-data';
import { sharedWorkspacePath } from './workspace-entry-paths';
import { AuthenticationForm } from './authentication-form';

const sessionKey = ['workbench-session'];
const base = (id: string) => `/w/${encodeURIComponent(id)}`;
function Language() {
  const { locale, t } = useFormat();
  return <label className="wb-language"><Globe2 size={16} /><select aria-label={t('ui.language')} value={locale} onChange={event => setLanguage(event.target.value)}>{languages.map(({ code, name }) => <option key={code} value={code} lang={code}>{name}</option>)}</select></label>;
}
function Brand() {
  return <div className="wb-brand"><span><Boxes size={22} /></span><strong>SmartSell</strong></div>;
}
async function readWorkbenchSession(signal?: AbortSignal) {
  try { return await api.session(signal); }
  catch (error) { if (error instanceof ApiError && error.status === 401) return null; throw error; }
}

function Authentication({ setupPath, registerToMain }: { setupPath: boolean; registerToMain: boolean }) {
  const { locale } = useFormat();
  const client = useQueryClient();
  return <div className="wb-auth"><header><Brand /><Language /></header><main><section className="wb-auth-card">
    <AuthenticationForm setupPath={setupPath} compatibility locale={locale}
      readSession={readWorkbenchSession}
      onSession={async (session, mode) => {
        if (registerToMain && mode === 'register') {
          window.location.replace('/login');
          return;
        }
        await client.cancelQueries({ queryKey: sessionKey });
        client.setQueryData(sessionKey, session);
      }} />
  </section></main></div>;
}

function Shell({ session }: { session: Session }) {
  const { t } = useFormat();
  const { wid = '' } = useParams();
  const current = session.workspaces.find(workspace => workspace.id === wid);
  const commands = useCommands(current?.id ?? '', Boolean(current));
  const navigate = useNavigate();
  const loginHref = useHref('/login');
  const location = useLocation();
  const [searching, setSearching] = useState(false);
  const [drawer, setDrawer] = useState<{ command?: Command; row?: Entity }>();
  const [failure, setFailure] = useState<unknown>();
  const [signingOut, setSigningOut] = useState(false);
  const open = (command: Command, row?: Entity) => setDrawer({ command, row });
  const items = commands.data?.items ?? [];
  async function signOut() {
    setSigningOut(true);
    setFailure(undefined);
    try {
      await api.signOut();
      window.location.replace(loginHref);
    } catch (error) {
      setFailure(error);
      setSigningOut(false);
    }
  }
  return <div className="wb-shell"><aside className="wb-sidebar"><Brand /><nav aria-label={t('ui.workbench')}>{['work', 'channels', 'admin'].map(group => <div className="wb-navgroup" key={group}><h2>{t(`nav.${group}`)}</h2>{sections.filter(section => section.group === group).map(section => <NavLink key={section.path} to={`${base(wid)}/${section.path}`} end={section.path === 'settings'}><section.icon size={17} />{t(`nav.${section.path}`)}</NavLink>)}</div>)}</nav></aside>
    <div className="wb-main"><header className="wb-topbar"><label className="wb-workspace"><span>{t('ui.chooseWorkspace')}</span><select value={current?.id ?? ''} onChange={event => { setDrawer(undefined); setSearching(false); const suffix = location.pathname.split('/').slice(3).join('/'); navigate(`${base(event.target.value)}/${suffix || 'home'}`); }}>
      {!current && <option value="">{t('ui.select')}</option>}{session.workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}</select></label>
      <div className="wb-top-actions"><a href={current ? `${sharedWorkspacePath}${base(wid)}/home` : '/'}>{t('ui.defaultWorkspace')}</a>{has(items, 'workspace', 'search') && <button onClick={() => setSearching(true)}><Search size={16} />{t('ui.globalSearch')}</button>}<Language /><button onClick={() => setDrawer({})} disabled={!current}><Wrench size={16} />{t('ui.tools')}</button><span className="wb-user" aria-label={t('ui.account')}>{session.user.name ?? session.user.email}</span><button className="wb-icon" title={t('ui.signout')} aria-label={t('ui.signout')} onClick={() => void signOut()} disabled={signingOut}><LogOut size={18} /></button></div>
    </header><main className="wb-content">{failure != null && <Failure error={failure} retry={() => void signOut()} />}{current ? commands.isPending ? <p role="status">{t('ui.loading')}</p> : commands.isError ? <Failure error={commands.error} retry={() => void commands.refetch()} /> : <Outlet context={{ wid, commands: items, open, workspace: current, userId: session.user.id }} /> : <Empty>{t(session.workspaces.length ? 'ui.unknownWorkspace' : 'ui.noWorkspace')}</Empty>}</main></div>
    {searching && current && <SearchPanel key={wid} wid={wid} commands={items} close={() => setSearching(false)} />}
    {drawer && current && (commands.isError || commands.isPending ? <CommandUnavailable error={commands.error} reload={() => void commands.refetch()} close={() => setDrawer(undefined)} /> : <CommandPanel wid={wid} commands={items} initial={drawer.command} selected={drawer.row} close={() => setDrawer(undefined)} />)}
  </div>;
}

function CommandUnavailable({ error, reload, close }: { error: unknown; reload: () => void; close: () => void }) {
  const { t } = useFormat();
  return <Dialog title={t('ui.tools')} close={close}>{error ? <Failure error={error} retry={reload} /> : <p role="status">{t('ui.loading')}</p>}</Dialog>;
}
function OverviewRoute() { const { wid, commands } = useOutletContext<{ wid: string; commands: Command[] }>(); return <Overview key={wid} wid={wid} commands={commands} />; }
function ModuleRoute({ section }: { section: Parameters<typeof ModulePage>[0]['section'] }) {
  const context = useOutletContext<Omit<Parameters<typeof ModulePage>[0], 'section'>>();
  const scope = useOutletContext<Parameters<typeof AccessPage>[0]>();
  if (section.path === 'access') return <AccessPage key={context.wid} {...scope} />;
  return <ModulePage key={`${context.wid}:${section.path}`} {...context} section={section} />;
}
function AdminRoute({ session }: { session: Session }) {
  const id = session.workspaces[0]?.id;
  return <Navigate replace to={id ? `${base(id)}/settings/system` : '/w/-/home'} />;
}

export function Workbench() {
  const { t } = useFormat();
  const location = useLocation();
  const session = useQuery({ queryKey: sessionKey, queryFn: ({ signal }) => readWorkbenchSession(signal), retry: false });
  const returnTo = new URLSearchParams(location.search).get('next');
  const next = returnTo?.startsWith('/w/') ? returnTo : undefined;
  const ws = session.data?.workspaces[0]?.id;
  const home = ws ? `${base(ws)}/home` : '/w/-/home';
  return <><div className="wb-narrow" role="status"><Monitor size={16} />{t('ui.desktop')}</div>{session.isPending ? <div className="wb-boot" role="status">{t('ui.loading')}</div> : session.isError ? <div className="wb-boot"><Failure error={session.error} retry={() => void session.refetch()} /><Link to="/login">{t('ui.signin')}</Link><Language /></div> : <Routes>
    <Route path="/login" element={session.data ? <Navigate to={next ?? home} replace /> : <Authentication setupPath={false} registerToMain={!next} />} />
    <Route path="/setup" element={session.data ? <Navigate to={next ?? home} replace /> : <Authentication setupPath registerToMain={!next} />} />
    {session.data ? <><Route path="/w/:wid" element={<Shell session={session.data} />}><Route index element={<Navigate to="home" replace />} /><Route path="home/*" element={<OverviewRoute />} />{sections.filter(section => 'module' in section).map(section => <Route key={section.path} path={`${section.path}/*`} element={<ModuleRoute section={section} />} />)}<Route path="settings/members/*" element={<ModuleRoute section={sections.find(section => section.path === 'access')!} />} /><Route path="posts/*" element={<ModuleRoute section={sections.find(section => section.path === 'execution')!} />} /><Route path="*" element={<Navigate to="home" replace />} /></Route><Route path="/admin/*" element={<AdminRoute session={session.data} />} /><Route path="*" element={<Navigate to={home} replace />} /></> : <Route path="*" element={<Navigate to={`/login${location.pathname.startsWith('/w/') ? `?next=${encodeURIComponent(location.pathname + location.search + location.hash)}` : ''}`} replace />} />}
  </Routes>}</>;
}
