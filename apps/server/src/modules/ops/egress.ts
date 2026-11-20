import { admins, DomainError, text, type Context, type Fields } from '../types.js';
import { changed, choice, command, invalid, object, ops, policyId, policyScope, save, tenantAdmin, tenantDefault } from './command-support.js';

const kind = 'egress_policy';
const destinations = ['model_provider', 'mcp_client', 'data_vendor', 'outbound_webhook', 'platform_api', 'connector'] as const;
const classes = ['content', 'brand_knowledge', 'product', 'order', 'customer_pii', 'message', 'asset_file', 'metric', 'credential'] as const;
const effects = ['allow', 'allow_masked', 'deny'] as const;
export type EgressDestination = typeof destinations[number];
type Effect = typeof effects[number];
interface Rule { destination_kind: EgressDestination; destination_id: string | null; data_classes: string[]; effect: Effect }
const rank: Record<Effect, number> = { allow: 0, allow_masked: 1, deny: 2 };
const strongest = (a: Effect, b: Effect) => rank[a] >= rank[b] ? a : b;

function categoryList(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > classes.length) return invalid('Invalid data_classes');
  return [...new Set(value.map(category => choice(category, classes, 'data class')))];
}

function ruleEffect(policy: Fields | undefined, destination: EgressDestination, category: string, ref?: string): Effect | undefined {
  if (!Array.isArray(policy?.rules)) return;
  let exact: Effect | undefined;
  let broad: Effect | undefined;
  for (const rule of policy.rules as Rule[]) {
    if (rule?.destination_kind !== destination || !Array.isArray(rule.data_classes) || !rule.data_classes.includes(category)) continue;
    const effect = effects.includes(rule.effect) ? rule.effect : 'deny';
    if (rule.destination_id == null) broad = broad ? strongest(broad, effect) : effect;
    else if (rule.destination_id === ref) exact = exact ? strongest(exact, effect) : effect;
  }
  return exact ?? (destination === 'model_provider' && broad !== 'deny' ? undefined : broad);
}

export async function evaluateEgress(ctx: Context, destination: EgressDestination, categories: readonly string[], destinationRef?: string): Promise<Effect> {
  if (!destinations.includes(destination) || !Array.isArray(categories) || !categories.length
    || categories.some(category => category === 'credential' || !(classes as readonly string[]).includes(category))) return 'deny';
  const [workspaceRow, tenantRow] = await Promise.all([
    ctx.get(ops, kind, policyId(ctx.workspaceId)), tenantDefault(ctx, kind),
  ]);
  const workspace = workspaceRow?.data;
  const tenant = tenantRow?.data;
  const fallback = destination !== 'model_provider' && (workspace ?? tenant)?.default_effect === 'allow' ? 'allow' : 'deny';
  return categories.reduce<Effect>((result, category) => strongest(result,
    ruleEffect(workspace, destination, category, destinationRef) ?? ruleEffect(tenant, destination, category, destinationRef) ?? fallback), 'allow');
}

/** For outbound payloads whose masking cannot be verified, only an unqualified allow is sufficient. */
export async function requireEgress(ctx: Context, destination: 'model_provider' | 'mcp_client', categories: readonly string[], destinationRef?: string): Promise<void> {
  if (await evaluateEgress(ctx, destination, categories, destinationRef) !== 'allow') {
    throw new DomainError('EGRESS_BLOCKED', 'Outbound data is blocked by the egress policy', 403);
  }
}

export const egressCommands = {
  get_egress_policy: command(admins, async (ctx, input) => {
    const scope = policyScope(ctx, input);
    if (scope === null) {
      return await tenantAdmin(ctx).get(ops, kind, policyId(null)) ?? { data: { workspace_id: null, default_effect: 'deny', rules: [] }, version: 0 };
    }
    const policy = await ctx.get(ops, kind, policyId(scope));
    const inherited = await tenantDefault(ctx, kind);
    return policy ?? { data: { workspace_id: scope, default_effect: inherited?.data.default_effect ?? 'deny', rules: [] }, version: 0 };
  }),
  set_egress_policy: command(admins, async (ctx, input) => {
    const scope = policyScope(ctx, input);
    const store = scope === null ? tenantAdmin(ctx) : ctx;
    const defaultEffect = choice(input.default_effect, ['deny', 'allow'], 'default_effect');
    if (!Array.isArray(input.rules) || input.rules.length > 200) return invalid('Invalid rules');
    const rules: Rule[] = input.rules.map(value => {
      const rule = object(value, 'rule');
      const effect = choice(rule.effect, effects, 'effect');
      const dataClasses = categoryList(rule.data_classes);
      if (dataClasses.includes('credential') && effect !== 'deny') return invalid('Credentials must be denied');
      return {
        destination_kind: choice(rule.destination_kind, destinations, 'destination_kind'),
        destination_id: rule.destination_id == null ? null : text(rule, 'destination_id', 255),
        data_classes: dataClasses, effect,
      };
    });
    return changed(ctx, 'ops.egress_policy.updated', await save(store, kind, policyId(scope), {
      workspace_id: scope, default_effect: defaultEffect, rules,
    }, input.version), { workspace_id: scope });
  }),
  evaluate_egress: command(admins, async (ctx, input) => ({ effect: await evaluateEgress(ctx,
    choice(input.destination_kind, destinations, 'destination_kind'), categoryList(input.data_classes),
    input.destination_id == null ? undefined : text(input, 'destination_id', 255)) })),
};
