import { modules, type Module, type Resource } from './modules';

export interface ModuleRoute {
  module: Module;
  /** Omitted for the calendar landing page so it can use its default calendar view. */
  resource?: Resource;
  id?: string;
  /** A named view within the resource, such as a wizard or an entity subpage. */
  view?: string;
  /** Report version number in the URL. Resolve it against the report's version list. */
  version?: string;
}

type PageRoute = [pattern: string, resource: string, view?: string, defaultId?: string];

// Workspace section paths from plan §5, with explicit aliases for the other entry points.
// Match literal segments before identifier patterns, e.g. creators/board vs creators/:id.
const pageRoutes: Record<string, PageRoute[]> = {
  workspace: [
    ['home/summary', 'summary'], ['me', 'personal'], ['setup', 'setup', undefined, 'initial_setup_v1'],
    ['settings', 'brands'], ['settings/brands/:id', 'brands'],
  ],
  campaign: [
    ['campaigns/templates', 'templates'], ['campaigns/templates/:id', 'templates'], ['campaigns/:id', 'campaigns'],
    ['campaigns/:id/brief', 'campaigns', 'brief'], ['campaigns/:id/matrix', 'campaigns', 'matrix'],
    ['campaigns/:id/timeline', 'campaigns', 'timeline'], ['campaigns/:id/tracking', 'campaigns', 'tracking'],
    ['campaigns/:id/budget', 'campaigns', 'budget'], ['campaigns/:id/closeout', 'campaigns', 'closeout'],
  ],
  commerce: [
    ['commerce/stores', 'stores'], ['commerce/stores/:id', 'stores'], ['commerce/products', 'products'],
    ['commerce/products/:id', 'products'], ['commerce/products/:id/localization', 'products', 'localization'],
    ['commerce/mapping', 'mapping'], ['commerce/changes', 'changes'], ['commerce/promotions', 'promotions'],
    ['commerce/promotions/:id', 'promotions'], ['commerce/orders', 'orders'], ['commerce/orders/:id', 'orders'],
    ['commerce/refunds', 'refunds'],
  ],
  content: [
    ['content/ideas', 'ideas'], ['content/ideas/:id', 'ideas'], ['content/board', 'content', 'board'],
    ['content/library', 'content'], ['content/items', 'content'], ['content/items/:id', 'content'],
    ['content/items/:id/history', 'content', 'history'], ['content/items/:id/translations', 'content', 'translations'],
    ['content/pillars', 'pillars'], ['content/feeds', 'feeds'], ['content/feeds/:id', 'feeds'],
  ],
  planning: [
    ['calendar/targets', 'targets'], ['calendar/targets/:id', 'targets'], ['approvals', 'approvals'],
    ['calendar/plan/new', 'targets', 'new'], ['calendar/reconcile', 'reconcile'], ['calendar/queues', 'queues'],
    ['calendar/queues/:id', 'queues'], ['settings/publishing', 'policies'], ['settings/publishing/pauses', 'pauses'],
  ],
  execution: [
    ['execution/:id', 'tasks'], ['execution/manual', 'tasks', 'manual'], ['execution/manual/:id', 'tasks', 'manual'],
    ['execution/exceptions', 'exceptions'], ['posts', 'posts'], ['posts/:id', 'posts'],
  ],
  inbox: [
    ['inbox/c/:id', 'conversations'], ['inbox/coverage', 'coverage'], ['inbox/settings', 'tags'],
    ['inbox/settings/business-hours', 'businessHours'], ['inbox/settings/sla', 'sla'], ['inbox/settings/rules', 'autoRules'],
    ['inbox/cases', 'cases'], ['inbox/cases/:id', 'cases'], ['inbox/reports', 'inboxReports'], ['inbox/reviews', 'reviews'],
  ],
  analytics: [
    ['reports/:id', 'reports'], ['reports/:id/v/:version', 'reports'], ['data/performance', 'performance'],
    ['data/performance/posts/:id', 'performance'], ['data/accounts', 'accountPerformance'], ['data/metrics', 'metrics'],
    ['data/metrics/:id', 'metrics'], ['data/attribution', 'attribution'], ['data/revenue', 'revenue'],
    ['data/contribution', 'contribution'], ['data/cohorts', 'cohorts'], ['data/cohorts/:id', 'cohorts'],
    ['data/experiments', 'experiments'], ['data/experiments/:id', 'experiments'], ['data/audience', 'audience'],
  ],
  asset: [
    ['assets/:id', 'assets'], ['assets/rights', 'rights'], ['assets/rights/:id', 'rights'], ['assets/knowledge', 'knowledge'],
    ['assets/knowledge/:id', 'knowledge'], ['assets/templates', 'templates'], ['assets/templates/:id', 'templates'],
    ['assets/inbox', 'submissions'], ['assets/inbox/:id', 'submissions'],
  ],
  intel: [
    ['research/watchlist', 'watch'], ['research/watchlist/:id', 'watch'], ['research/boards', 'boards'],
    ['research/boards/:id', 'boards'], ['research/creatives', 'creatives'], ['research/compare', 'compare'],
    ['research/candidates', 'candidates'], ['research/candidates/:id', 'candidates'], ['research/trends', 'trends'],
    ['research/trends/:id', 'trends'], ['research/alerts', 'alerts'], ['research/listening', 'mentions'],
  ],
  creator: [
    ['creators/:id', 'creators'], ['creators/board', 'collabs'], ['collaborations', 'collabs'],
    ['collaborations/:id', 'collabs'], ['creators/shipments', 'shipments'], ['creators/commissions', 'commissions'],
    ['creators/settlements', 'settlements'], ['creators/live', 'live'],
  ],
  traffic: [
    ['traffic/links', 'links'], ['traffic/links/:id', 'links'], ['traffic/destinations', 'destinations'],
    ['traffic/checks', 'checks'], ['settings/traffic', 'domains'], ['settings/traffic/utm', 'utm'],
    ['traffic/pages', 'pages'], ['traffic/pages/:id/edit', 'pages', 'edit'], ['pages/:id/edit', 'pages', 'edit'],
    ['traffic/bio', 'bio'], ['traffic/bio/:id', 'bio'], ['traffic/forms', 'forms'], ['traffic/forms/:id', 'forms'],
    ['traffic/leads', 'leads'], ['traffic/leads/:id', 'leads'],
  ],
  ads: [
    ['ads/performance', 'performance'], ['ads/accounts', 'adaccounts'], ['ads/creatives', 'creatives'],
    ['ads/creatives/:id', 'creatives'], ['ads/proposals', 'proposals'], ['ads/proposals/:id', 'proposals'],
    ['ads/operations', 'operations'], ['ads/operations/:id', 'operations'], ['ads/experiments', 'adjustments'],
  ],
  lifecycle: [
    ['lifecycle/customers', 'customers'], ['lifecycle/customers/:id', 'customers'], ['customers/:id', 'customers'],
    ['lifecycle/consents', 'consent'], ['lifecycle/consents/texts', 'consentTexts'], ['lifecycle/segments', 'segments'],
    ['lifecycle/segments/:id', 'segments'], ['lifecycle/campaigns', 'espCampaigns'], ['lifecycle/campaigns/:id', 'espCampaigns'],
    ['lifecycle/flows', 'flows'], ['lifecycle/health', 'health'],
  ],
  ingest: [
    ['data/sources', 'sources'], ['data/sources/:id', 'sources'], ['data/imports', 'imports'],
    ['data/imports/new', 'imports', 'new'], ['data/imports/:id', 'imports'], ['data/backfills', 'backfills'],
    ['data/backfills/:id', 'backfills'], ['data/health', 'health'], ['data/health/issues', 'quality'],
    ['data/health/gaps', 'gaps'], ['data/sync-runs', 'sync'], ['data/sync-runs/:id', 'sync'],
    ['data/usage', 'usage'], ['data/usage/budgets', 'budgets'],
  ],
  agent: [
    ['automation/jobs', 'jobs'], ['automation/jobs/:id', 'jobs'], ['automation/change-sets', 'changeSets'],
    ['automation/change-sets/:id', 'changeSets'], ['automation/rules', 'rules'], ['automation/mcp', 'mcp'],
    ['automation/templates', 'templates'], ['automation/templates/:id', 'templates'], ['automation/models', 'models'],
    ['automation/models/routes', 'modelRoutes'],
  ],
  account: [
    ['settings/accounts/:id', 'accounts'], ['settings/accounts/:id/execution', 'accounts', 'execution'],
    ['settings/accounts/:id/migrate', 'accounts', 'migrate'], ['settings/connections', 'connections'],
    ['settings/connections/:id', 'connections'], ['settings/platform-apps', 'platformApps'], ['settings/devices', 'devices'],
    ['settings/devices/:id/mobile', 'mobile'], ['settings/account-blocks', 'blocks'],
    ['settings/connector-automation', 'connectorAutomation'],
  ],
  team: [
    ['team/workload', 'workload'], ['team/handovers', 'handover'], ['team/deliveries', 'delivery'],
    ['assets/shares', 'shares'], ['admin/templates', 'templates'], ['admin/branding', 'branding'],
  ],
  ops: [
    ['admin', 'health'], ['admin/health', 'system'], ['admin/system', 'system'], ['admin/settings', 'settings'], ['admin/members', 'tenantMembers'],
    ['admin/credentials', 'credentials'], ['admin/egress', 'egress'], ['admin/jobs', 'queues'], ['admin/audit', 'audit'],
    ['admin/data', 'retention'], ['admin/backup', 'backup'], ['admin/integrations', 'webhooks'],
    ['admin/releases', 'releases'], ['admin/license', 'license'],
  ],
};

const routes = modules.flatMap(module => [
  { segments: module.route.split('/'), module, resource: module.key === 'planning' ? undefined : module.resources[0], view: undefined, defaultId: undefined },
  ...(pageRoutes[module.key] ?? []).map(([pattern, key, view, defaultId]) => {
    const resource = module.resources.find(entry => entry.key === key);
    if (!resource) throw new Error(`Unknown route resource ${module.key}.${key}`);
    return { segments: pattern.split('/'), module, resource, view, defaultId };
  }),
]).sort((a, b) => {
  const literals = (segments: string[]) => segments.filter(segment => !segment.startsWith(':')).length;
  return literals(b.segments) - literals(a.segments);
});

export const workspacePagePatterns = [...new Set(routes.map(route => route.segments.join('/')))];

function segmentValue(segment: string) {
  try {
    const value = decodeURIComponent(segment);
    return value && value !== '.' && value !== '..' && !/[/\\\u0000-\u001f\u007f]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Accepts a workspace section (`calendar/targets/123`) or a browser pathname (`/w/acme/calendar/targets/123`). */
export function resolveModuleRoute(path: string): ModuleRoute | undefined {
  const sections = path.split(/[?#]/, 1)[0].replace(/^\/+|\/+$/g, '').split('/').map(segmentValue);
  if (sections.some(segment => segment === undefined)) return;
  const segments = sections[0] === 'w' ? sections.slice(2) : sections;
  if (sections[0] === 'w' && segments[0] === 'admin') return;
  for (const route of routes) {
    if (route.segments.length !== segments.length || !route.segments.every((part, i) => part.startsWith(':') || part === segments[i])) continue;
    const id = segments[route.segments.indexOf(':id')] ?? route.defaultId;
    const version = segments[route.segments.indexOf(':version')];
    if (version && !/^[1-9]\d*$/.test(version)) return;
    return { module: route.module, ...(route.resource && { resource: route.resource }), ...(id && { id }),
      ...(route.view && { view: route.view }), ...(version && { version }) };
  }
}
