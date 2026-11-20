import { ADMIN, READ, type Operation } from '@smartsell/contracts';
import { archiveBrand, restoreBrand, saveBrand, saveMarket, updateWorkspace, workspace } from './brands.js';
import { modifyStep, onboarding, readDashboard, savedViews, saveDashboard, saveView } from './configuration.js';
import { listNotifications, listPreferences, markNotifications, notificationDigestSchedule, notificationDigestSubscriber,
  removeSubscription, savePreference, saveSubscription, subscriptions } from './notifications.js';
import { personalInbox, summary, today, workspaceContext } from './overview.js';
import { canFollow, search } from './search.js';
import { addDependencies, batchTasks, createTask, getTask, handover, listTasks, updateTask } from './tasks.js';
import { brandScope, internal, manage } from './shared.js';

export const operations: Operation[] = [
  { method: 'GET', path: '/', name: 'workspace_get', roles: READ, summary: 'Read workspace settings', run: workspace },
  { method: 'PATCH', path: '/', name: 'workspace_update', roles: ADMIN, summary: 'Update workspace settings', run: updateWorkspace },
  { method: 'GET', path: '/context', name: 'workspace_get_context', roles: READ, summary: 'Read brand, market and account context', run: workspaceContext },
  { method: 'GET', path: '/brands', name: 'workspace_brands_list', roles: READ, summary: 'List workspace brands', run: (ctx, { query }) => ctx.list('brand').filter(row => query.status === undefined || row.status === query.status) },
  { method: 'GET', path: '/brands/:id', name: 'workspace_brand_get', roles: READ, summary: 'Read a brand', run: (ctx, { params }) => ctx.get('brand', params.id!) },
  { method: 'POST', path: '/brands', name: 'workspace_brand_create', roles: manage, summary: 'Create a brand', run: saveBrand },
  { method: 'PATCH', path: '/brands/:id', name: 'workspace_brand_update', roles: manage, versionKind: 'brand', summary: 'Update a brand', run: saveBrand },
  { method: 'POST', path: '/brands/:id/archive', name: 'workspace_brand_archive', roles: manage, versionKind: 'brand', summary: 'Preview or archive a brand', run: archiveBrand },
  { method: 'POST', path: '/brands/:id/restore', name: 'workspace_brand_restore', roles: manage, versionKind: 'brand', summary: 'Restore an archived brand within license quota', run: restoreBrand },
  { method: 'GET', path: '/brands/:id/markets', name: 'workspace_markets_list', roles: READ, summary: 'List markets for a brand', run: (ctx, { params }) => {
    const brand = brandScope(ctx, params.id);
    return ctx.list('market').filter(row => row.brand_id === brand);
  } },
  { method: 'GET', path: '/markets/:id', name: 'workspace_market_get', roles: READ, summary: 'Read a market', run: (ctx, { params }) => ctx.get('market', params.id!) },
  { method: 'POST', path: '/brands/:id/markets', name: 'workspace_market_create', roles: manage, summary: 'Create a market', run: saveMarket },
  { method: 'PATCH', path: '/markets/:id', name: 'workspace_market_update', roles: manage, versionKind: 'market', summary: 'Update a market', run: (ctx, input) => saveMarket(ctx, input, ctx.get('market', input.params.id!)) },
  { method: 'GET', path: '/overview/today', name: 'workspace_get_today', roles: internal, summary: 'Aggregate current work and operational exceptions', run: today },
  { method: 'GET', path: '/overview/summary', name: 'workspace_get_summary', roles: internal, summary: 'Retrieve operational metrics with coverage', run: (ctx, input) => summary(ctx, input) },
  { method: 'GET', path: '/work-items', name: 'tasks_list', roles: READ, summary: 'List assigned and related work items', run: listTasks },
  { method: 'GET', path: '/work-items/:id', name: 'tasks_get', roles: READ, summary: 'Read a work item', run: (ctx, { params }) => getTask(ctx, params.id!) },
  { method: 'POST', path: '/work-items', name: 'tasks_create', roles: READ, summary: 'Create a work item', run: createTask },
  { method: 'PATCH', path: '/work-items/:id', name: 'tasks_update', roles: READ, versionKind: 'work_item', summary: 'Update a work item', run: (ctx, input) => updateTask(ctx, input) },
  { method: 'POST', path: '/work-items/batch', name: 'tasks_batch', roles: READ, summary: 'Preview or apply a versioned work-item batch', run: batchTasks },
  { method: 'POST', path: '/work-items/:id/complete', name: 'tasks_complete', roles: READ, versionKind: 'work_item', summary: 'Complete a work item', run: (ctx, input) => updateTask(ctx, input, 'done') },
  { method: 'POST', path: '/work-items/:id/reopen', name: 'tasks_reopen', roles: READ, versionKind: 'work_item', summary: 'Reopen a completed work item', run: (ctx, input) => updateTask(ctx, input, 'open') },
  { method: 'POST', path: '/work-items/:id/handover', name: 'tasks_handover', roles: manage, versionKind: 'work_item', summary: 'Hand over a work item and record its history', run: handover },
  { method: 'PUT', path: '/work-items/:id/dependencies', name: 'tasks_dependencies', roles: READ, versionKind: 'work_item', summary: 'Replace a work item prerequisite set', run: addDependencies },
  { method: 'GET', path: '/me/inbox', name: 'workspace_get_personal_inbox', roles: internal, summary: 'Merge personal tasks, approvals and mentions', run: personalInbox },
  { method: 'GET', path: '/notifications', name: 'notifications_list', roles: internal, summary: 'List personal in-app notifications', run: listNotifications },
  { method: 'POST', path: '/notifications/read', name: 'notifications_read', roles: internal, summary: 'Mark personal notifications as read', run: (ctx, input) => markNotifications(ctx, input, 'read_at') },
  { method: 'POST', path: '/notifications/archive', name: 'notifications_archive', roles: internal, summary: 'Archive personal notifications', run: (ctx, input) => markNotifications(ctx, input, 'archived_at') },
  { method: 'GET', path: '/me/notification-preferences', name: 'notifications_preferences_list', roles: internal, summary: 'Read personal notification preferences', run: listPreferences },
  { method: 'PUT', path: '/me/notification-preferences', name: 'notifications_preferences_update', roles: internal, summary: 'Set a personal notification preference', run: savePreference },
  { method: 'GET', path: '/subscriptions', name: 'workspace_subscriptions_list', roles: internal, summary: 'Read personal resource subscriptions', run: ctx => subscriptions(ctx).filter(row => canFollow(ctx, String(row.resource_type), String(row.resource_id))) },
  { method: 'POST', path: '/subscriptions', name: 'workspace_subscriptions_create', roles: internal, summary: 'Follow an accessible resource', run: (ctx, input) => saveSubscription(ctx, input, (type, resource) => canFollow(ctx, type, resource)) },
  { method: 'DELETE', path: '/subscriptions', name: 'workspace_subscriptions_remove', roles: internal, summary: 'Stop following a resource', run: removeSubscription },
  { method: 'DELETE', path: '/subscriptions/:id', name: 'workspace_subscriptions_delete', roles: internal, summary: 'Delete a personal subscription', run: removeSubscription },
  { method: 'GET', path: '/search', name: 'search_query', roles: READ, summary: 'Search accessible workspace resources', run: search },
  { method: 'GET', path: '/saved-views', name: 'workspace_saved_views_list', roles: internal, summary: 'List personal and shared saved views', run: savedViews },
  { method: 'POST', path: '/saved-views', name: 'workspace_saved_views_create', roles: internal, summary: 'Save a query as a personal or shared view', run: saveView },
  { method: 'PATCH', path: '/saved-views/:id', name: 'workspace_saved_views_update', roles: internal, versionKind: 'saved_view', summary: 'Update an owned saved view', run: saveView },
  { method: 'GET', path: '/onboarding/:flow', name: 'workspace_onboarding_get', roles: manage, summary: 'Read resumable workspace onboarding', run: onboarding },
  { method: 'POST', path: '/onboarding/:flow/steps/:step/check', name: 'workspace_onboarding_check', roles: manage, summary: 'Recheck an onboarding step against live records', run: (ctx, input) => modifyStep(ctx, input, false) },
  { method: 'POST', path: '/onboarding/:flow/steps/:step/skip', name: 'workspace_onboarding_skip', roles: manage, summary: 'Skip an onboarding step with reason', run: (ctx, input) => modifyStep(ctx, input, true) },
  { method: 'GET', path: '/dashboards/:id', name: 'workspace_dashboard_get', roles: internal, summary: 'Read and evaluate a personal dashboard', run: readDashboard },
  { method: 'PUT', path: '/dashboards/:id', name: 'workspace_dashboard_save', roles: internal, summary: 'Save personal dashboard metric queries', run: saveDashboard },
];

export const schedules = [notificationDigestSchedule];
export const subscribers = [notificationDigestSubscriber];
export { applyWorkspaceEvent, scanWorkspaceDue } from './notifications.js';
export type { WorkspaceOverviewContext } from './overview.js';
