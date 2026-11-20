import { useQuery } from '@tanstack/react-query';
import { api, recordOptions, type Command, type Entity, type Payload } from './workbench-api';

export const commandId = (command: Command) => `${command.module}.${command.action}`;
export const has = (commands: Command[], module: string, action: string) => commands.some(item => item.module === module && item.action === action);

// The command registry is permission-filtered. Only declared read commands are called when opening a view.
export function useCommandRead<T>(wid: string, commands: Command[], module: string, action: string, body: Payload = {}, enabled = true) {
  const permitted = has(commands, module, action);
  const query = useQuery({
    queryKey: ['workspace', wid, 'read', module, action, body],
    queryFn: ({ signal }) => api.execute(wid, { module, action }, body, crypto.randomUUID(), signal) as Promise<T>,
    enabled: enabled && permitted,
  });
  return { ...query, permitted };
}

const readers: Record<string, string> = {
  'planning.approval_request': 'list_approvals', 'planning.publish_target': 'list_targets',
  'workspace.market': 'list_markets', 'workspace.settings': 'get_workspace',
  'workspace.notification': 'list_notifications',
  'inbox.conversation': 'list', 'content.content_item': 'content_list',
  'commerce.product': 'catalog_search', 'campaign.campaign': 'list',
  'agent.agent_job': 'jobs_list', 'agent.automation_rule': 'automation_rules_list',
  'ads.ad_account': 'list_accounts', 'creator.collaboration': 'collaborations_list', 'creator.creator': 'creators_search',
};

export function asEntity(value: unknown, module: string, kind: string): Entity | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const row = value as Payload;
  const id = row.id ?? row.batch_id ?? row.key;
  if (typeof id !== 'string') return;
  const data = row.data && typeof row.data === 'object' && !Array.isArray(row.data) ? row.data as Payload : row;
  return { id, module, kind, data, version: typeof row.version === 'number' ? row.version : 0,
    created_at: typeof row.created_at === 'string' ? row.created_at : '', updated_at: typeof row.updated_at === 'string' ? row.updated_at : '' };
}

export function values(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  const obj = value as Payload;
  return Array.isArray(obj.items) ? obj.items : Array.isArray(obj.rows) ? obj.rows : [value];
}

export function useRecordList(wid: string, commands: Command[], module: string, kind: string, filters: Payload = {}) {
  const action = readers[`${module}.${kind}`];
  const via = useCommandRead<unknown>(wid, commands, module, action ?? '', filters, Boolean(action));
  const generic = useQuery({ ...recordOptions(wid, module, kind), enabled: !action || !via.permitted });
  return action && via.permitted ? {
    ...via, data: via.data === undefined ? undefined : values(via.data).flatMap(row => asEntity(row, module, kind) ?? []),
  } : generic;
}
