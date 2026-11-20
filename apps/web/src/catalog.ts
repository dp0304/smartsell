import { Activity, Archive, BarChart3, CalendarDays, ClipboardCheck, Database, House, Inbox, Link2, Megaphone, Package, PenLine, Radar, Settings2, Shield, Sparkles, Users } from 'lucide-react';

export const sections = [
  { path: 'home', icon: House, group: 'work' },
  { path: 'me', icon: ClipboardCheck, group: 'work', module: 'workspace', views: ['work_item', 'notification'] },
  { path: 'campaigns', icon: Megaphone, group: 'work', module: 'campaign', views: ['campaign'] },
  { path: 'content', icon: PenLine, group: 'work', module: 'content', views: ['content_item', 'idea', 'content_variant', 'variant_revision'] },
  { path: 'calendar', icon: CalendarDays, group: 'work', module: 'planning', views: ['publish_target'] },
  { path: 'approvals', icon: ClipboardCheck, group: 'work', module: 'planning', views: ['approval_request', 'publish_target'] },
  { path: 'execution', icon: Activity, group: 'work', module: 'execution', views: ['execution_task', 'platform_post'] },
  { path: 'inbox', icon: Inbox, group: 'channels', module: 'inbox', views: ['conversation', 'tag'] },
  { path: 'commerce', icon: Package, group: 'channels', module: 'commerce', views: ['product', 'store', 'import_batch', 'product_change'] },
  { path: 'assets', icon: Archive, group: 'channels', module: 'asset', views: ['asset', 'rights_grant', 'knowledge_entry', 'template'] },
  { path: 'creators', icon: Users, group: 'channels', module: 'creator', views: ['collaboration', 'creator'] },
  { path: 'research', icon: Radar, group: 'channels', module: 'intel', views: ['watch_target', 'research_board', 'product_candidate'] },
  { path: 'traffic', icon: Link2, group: 'channels', module: 'traffic', views: ['short_link', 'landing_page'] },
  { path: 'lifecycle', icon: Users, group: 'channels', module: 'lifecycle', views: ['esp_flow', 'customer', 'consent', 'segment'] },
  { path: 'ads', icon: Megaphone, group: 'channels', module: 'ads', views: ['ad_account', 'ad_entity', 'adjustment_suggestion'] },
  { path: 'data', icon: Database, group: 'admin', module: 'ingest', views: ['data_source', 'import_batch', 'sync_run', 'quality_issue', 'import_template'] },
  { path: 'reports', icon: BarChart3, group: 'admin', module: 'analytics', views: ['report', 'metric_definition'] },
  { path: 'automation', icon: Sparkles, group: 'admin', module: 'agent', views: ['automation_rule', 'agent_job', 'change_set'] },
  { path: 'access', icon: Shield, group: 'admin', module: 'team', views: ['member', 'task', 'handover', 'delivery'] },
  { path: 'settings', icon: Settings2, group: 'admin', module: 'workspace', views: ['brand', 'market', 'settings'] },
  { path: 'settings/accounts', icon: Users, group: 'admin', module: 'account', views: ['social_account', 'connection', 'device', 'account_block'] },
  { path: 'settings/system', icon: Activity, group: 'admin', module: 'ops', views: ['setting', 'job', 'audit'] },
] as const;
export type Section = typeof sections[number];

export interface Field {
  name: string;
  label?: readonly [string, string];
  type?: 'textarea' | 'number' | 'datetime-local' | 'date' | 'url' | 'email' | 'checkbox' | 'select' | 'json' | 'csv' | 'lines';
  optional?: boolean;
  choices?: readonly string[];
  ref?: readonly [module: string, kind: string];
  default?: string;
  secret?: boolean;
  seed?: string | false;
  shape?: 'object' | 'array' | 'nullable-id';
  min?: number;
  max?: number;
  integer?: boolean;
  mustCheck?: boolean;
}
export interface Action {
  fields: Field[];
  confirm?: boolean;
  target?: string;
  targetModule?: string;
  targetField?: string;
  tab?: string;
  label?: readonly [string, string];
  validate?: (body: Record<string, unknown>) => string | undefined;
}
export { actions } from './action-index';

export function titleCase(key: string) {
  return key.replaceAll('_', ' ').replace(/^./, value => value.toUpperCase());
}
