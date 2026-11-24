import type { ComponentType } from 'react';
import { Navigate, Route, Routes, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ApiError, request, workspacePath, type Operation, type Session } from '@smartsell/sdk';
import { ViewLang, ViewLinkProvider } from '@smartsell/ui';
import { ApiContext, wsKey } from '../api';
import { useCopy } from '../i18n';
import { useViewStream } from './data/stream';
import { ViewContext } from './data/use-view';
import { RouterLink } from './parts';
import { SetupShell, ViewShell } from './ViewShell';
import { GetStartedPage } from './pages/GetStartedPage';
import { ManageStoresPage } from './pages/worker-management';
import { OverviewPage } from './pages/OverviewPage';
import { SetupLanding } from './pages/setup-landing';
import { ProductsPage } from './pages/ProductsPage';
import { ProductPage } from './pages/ProductPage';
import { PlansPage } from './pages/PlansPage';
import { PlanPage } from './pages/PlanPage';
import { CalendarPage } from './pages/CalendarPage';
import { SocialPage } from './pages/SocialPage';
import { AdsPage } from './pages/AdsPage';
import { DecisionsPage } from './pages/DecisionsPage';
import { AgentPage } from './pages/AgentPage';
import { SettingsPage } from './pages/SettingsPage';
import { TodayPage } from './pages/TodayPage';
import { MachinePage, MachinesPage } from './pages/MachinesPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { ChannelPage } from './pages/ChannelPage';
import { PostPage } from './pages/PostPage';
import { NotificationSettingsPage, NotificationsPage } from './pages/NotificationsPage';
import './view.css';

export const appPath = (ws: string) => `/app/${encodeURIComponent(ws)}`;

/**
 * WV-8: a detail page mounts anew for each id, so nothing of the previous item (forms, notices, 改到… time, the 換機器 choice)
 * carries over when the bell, a link or back/forward moves from one post, machine or channel to another.
 */
function KeyedById({ page: Page }: { page: ComponentType }) {
  const { id = '' } = useParams();
  return <Page key={id} />;
}

/** The dashboard mounted at /app/:ws/*; it owns its own stream subscription and query keys. */
export function ViewApp({ session, compatibility = false }: { session: Session; compatibility?: boolean }) {
  const { ws = '' } = useParams();
  const { locale } = useCopy();
  const [params] = useSearchParams();
  const workspace = session.workspaces.find(item => item.id === ws);
  useViewStream(workspace ? ws : '');
  // Same key and request as the advanced workbench, so reused workbench components find their catalog.
  const catalog = useQuery({ queryKey: [...wsKey(ws), 'catalog'], enabled: Boolean(workspace), queryFn: async ({ signal }) => {
    const { data } = await request<Operation[]>(`${workspacePath(ws)}/catalog`, { signal });
    if (!Array.isArray(data)) throw new ApiError(502, { code: 'INVALID_RESPONSE' });
    return data.filter(op => op && typeof op.name === 'string' && typeof op.module === 'string');
  } });
  if (!workspace) return <Navigate to={appPath(session.workspaces[0].id)} replace />;
  const base = appPath(ws);
  return <ViewLang lang={locale === 'en' ? 'en' : 'zh'}><ViewLinkProvider link={RouterLink}>
    <ViewContext.Provider value={{ ws, session, workspace, base }}>
      <ApiContext.Provider value={{ ws, session, catalog: catalog.data ?? [], brandId: params.get('brand') ?? undefined, compatibility: false }}>
        <Routes>
          <Route element={<SetupShell />}>
            <Route path="get-started" element={<GetStartedPage />} />
          </Route>
          <Route element={compatibility ? undefined : <SetupLanding />}>
            <Route element={<ViewShell />}>
              <Route index element={<TodayPage />} />
              <Route path="overview" element={<OverviewPage />} />
              <Route path="machines" element={<MachinesPage />} />
              <Route path="machines/:id" element={<KeyedById page={MachinePage} />} />
              <Route path="channels" element={<ChannelsPage />} />
              <Route path="channels/:id" element={<KeyedById page={ChannelPage} />} />
              <Route path="posts/:id" element={<KeyedById page={PostPage} />} />
              <Route path="notifications" element={<NotificationsPage />} />
              <Route path="settings/notifications" element={<NotificationSettingsPage />} />
              <Route path="products" element={<ProductsPage />} />
              <Route path="products/stores" element={<ManageStoresPage phase="store" />} />
              <Route path="products/stores/imports" element={<ManageStoresPage key="imports" phase="import" />} />
              <Route path="products/:id" element={<ProductPage />} />
              <Route path="plans" element={<PlansPage />} />
              <Route path="plans/:id" element={<PlanPage />} />
              <Route path="calendar" element={<CalendarPage />} />
              <Route path="social" element={<SocialPage />} />
              <Route path="ads" element={<AdsPage />} />
              <Route path="decisions" element={<DecisionsPage />} />
              <Route path="agent" element={<AgentPage />} />
              <Route path="settings/worker-accounts" element={<Navigate to={`${base}/channels`} replace />} />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to={base} state={{ skipSetupCheck: true }} replace />} />
            </Route>
          </Route>
        </Routes>
      </ApiContext.Provider>
    </ViewContext.Provider>
  </ViewLinkProvider></ViewLang>;
}
