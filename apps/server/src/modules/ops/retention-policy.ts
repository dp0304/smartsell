import { admins, DomainError, type Context, type Fields } from '../types.js';
import { changed, choice, command, flag, integer, invalid, ops, policyId, policyScope, save, tenantAdmin, tenantDefault } from './command-support.js';

const kind = 'retention_policy';
const classes = ['raw_record', 'tool_call', 'audit_event', 'evidence', 'asset_file', 'metric_observation', 'message',
  'customer_pii', 'export_file', 'operation', 'store_pii_amazon'] as const;
type DataClass = typeof classes[number];
const requiredDays = new Map<DataClass, number>([['raw_record', 90], ['tool_call', 180], ['audit_event', 730], ['store_pii_amazon', 30]]);

function defaults(dataClass: DataClass): Fields | undefined {
  const days = requiredDays.get(dataClass);
  if (days === undefined && dataClass !== 'evidence') return;
  const amazon = dataClass === 'store_pii_amazon';
  return { workspace_id: null, data_class: dataClass, retain_mode: days === undefined ? 'follow_resource' : 'fixed_days',
    retain_days: days ?? null, retain_anchor: amazon ? 'order_delivered_at' : 'created_at',
    workspace_override: amazon ? 'shorten_only' : 'any', legal_hold: false, action: 'delete' };
}

async function policies(ctx: Context, dataClass: DataClass) {
  const [localRow, tenantRow] = await Promise.all([
    ctx.get(ops, kind, policyId(ctx.workspaceId, dataClass)), tenantDefault(ctx, kind, policyId(null, dataClass)),
  ]);
  return { localRow, tenant: tenantRow?.data ?? defaults(dataClass) };
}

export async function getRetentionPolicy(ctx: Context, dataClass: string): Promise<Fields | undefined> {
  const key = choice(dataClass, classes, 'data_class');
  const { localRow, tenant } = await policies(ctx, key);
  if (!localRow) return tenant;
  const policy = localRow.data;
  if (key === 'store_pii_amazon') return { ...policy, retain_days: Math.min(30, tenant?.retain_days ?? 30, policy.retain_days) };
  return { ...policy, legal_hold: tenant?.legal_hold === true || policy.legal_hold === true };
}

export const retentionCommands = {
  get_retention_policies: command(admins, async (ctx, input) => {
    const scope = policyScope(ctx, input);
    const store = scope === null ? tenantAdmin(ctx) : ctx;
    const selected = input.data_class === undefined ? classes : [choice(input.data_class, classes, 'data_class')];
    const items = await Promise.all(selected.map(async dataClass => {
      const row = await store.get(ops, kind, policyId(scope, dataClass));
      const data = scope === null ? row?.data ?? defaults(dataClass) : await getRetentionPolicy(ctx, dataClass);
      return data && { id: row?.id, version: row?.version ?? 0, data };
    }));
    return { items: items.filter(item => item !== undefined) };
  }),
  set_retention_policy: command(admins, async (ctx, input) => {
    const scope = policyScope(ctx, input);
    const store = scope === null ? tenantAdmin(ctx) : ctx;
    const dataClass = choice(input.data_class, classes, 'data_class');
    const amazon = dataClass === 'store_pii_amazon';
    const retainMode = choice(input.retain_mode ?? 'fixed_days', ['fixed_days', 'follow_resource'], 'retain_mode');
    const retainDays = retainMode === 'fixed_days' ? integer(input.retain_days, 'retain_days', dataClass === 'asset_file' ? 0 : 1, 36_500) : null;
    if (retainMode === 'follow_resource' && (dataClass !== 'evidence' || input.retain_days != null)) return invalid('Invalid follow_resource policy');
    const action = choice(input.action, ['delete', 'anonymize', 'archive'], 'action');
    const legalHold = input.legal_hold === undefined ? false : flag(input.legal_hold, 'legal_hold');
    const anchor = amazon ? 'order_delivered_at' : 'created_at';
    const override = amazon ? 'shorten_only' : 'any';
    if ((input.retain_anchor !== undefined && input.retain_anchor !== anchor)
      || (input.workspace_override !== undefined && input.workspace_override !== override)) return invalid('Invalid retention anchor or override');
    if (dataClass === 'audit_event' && action === 'anonymize') return invalid('Audit events may only be archived or deleted after expiry');
    if (amazon) {
      const tenant = scope !== null ? (await policies(ctx, dataClass)).tenant : undefined;
      if (retainDays === null || retainDays > Math.min(30, tenant?.retain_days ?? 30) || action !== 'delete' || legalHold) {
        throw new DomainError('invalid_input', 'Amazon PII must be deleted within the inherited delivery-anchored deadline');
      }
    }
    return changed(ctx, 'ops.retention_policy.updated', await save(store, kind, policyId(scope, dataClass), {
      workspace_id: scope, data_class: dataClass, retain_mode: retainMode, retain_days: retainDays,
      retain_anchor: anchor, workspace_override: override, action, legal_hold: legalHold,
    }, input.version), { workspace_id: scope, data_class: dataClass });
  }),
};
