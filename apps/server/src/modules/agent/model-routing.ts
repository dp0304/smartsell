import { requireEgress } from '../ops/egress.js';
import { requireUsageCapacity } from '../ops/usage.js';
import { admins, DomainError, readers, required, text, type Commands, type Context, type Fields } from '../types.js';

export const modelPurposes = ['draft', 'translate', 'classify', 'analyze', 'plan'] as const;
export type ModelPurpose = typeof modelPurposes[number];
export type ModelProtocol = 'openai_chat' | 'anthropic_messages';
export const modelDataClasses = ['content', 'brand_knowledge', 'product', 'order', 'customer_pii', 'message', 'asset_file', 'metric'] as const;
export type ModelDataClass = typeof modelDataClasses[number];
const providerKind = 'model_provider';
const routeKind = 'model_route';
export const usageKind = 'ai_usage';

export interface ModelProvider {
  kind: 'openai_compatible' | 'anthropic_compatible' | 'anthropic' | 'internal_gateway';
  protocol: ModelProtocol;
  endpoint_ref: string;
  credential_ref: string;
  allowed_data_classes: ModelDataClass[];
  capabilities: { tools: boolean; structured_output: boolean; prompt_cache: boolean; effort: boolean };
  monthly_token_budget: number | null;
  pricing: { input_minor_per_million: number; output_minor_per_million: number; cache_read_minor_per_million: number } | null;
  enabled: boolean;
}

interface ModelRoute {
  purpose: ModelPurpose;
  provider_id: string;
  model: string;
  params: { max_tokens: number; effort?: 'low' | 'medium' | 'high' };
  fallback: null;
  enabled: boolean;
}

function invalid(field: string): never {
  throw new DomainError('invalid_input', `Invalid ${field}`, 400);
}

function object(value: unknown, name: string, allowed: readonly string[]): Fields {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    invalid(name);
  }
  return value as Fields;
}

function choice<T extends string>(value: unknown, name: string, options: readonly T[]): T {
  if (!(options as readonly unknown[]).includes(value)) invalid(name);
  return value as T;
}

function bool(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid(name);
  return value;
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) invalid(name);
  return value;
}

function opaqueRef(input: Fields, key: string): string {
  const ref = text(input, key, 128);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(ref)) invalid(key);
  return ref;
}

export function validateModelCategories(value: unknown): ModelDataClass[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > modelDataClasses.length) invalid('categories');
  const categories = value.map(item => choice(item, 'data class', modelDataClasses));
  if (new Set(categories).size !== categories.length) invalid('categories');
  return categories;
}

function admin(ctx: Context): void {
  if (!admins.includes(ctx.role)) throw new DomainError('forbidden', 'Model administration requires an administrator', 403);
}

async function configureProvider(ctx: Context, input: Fields) {
  admin(ctx);
  object(input, 'provider', ['id', 'version', 'kind', 'protocol', 'endpoint_ref', 'credential_ref', 'allowed_data_classes',
    'capabilities', 'enabled', 'monthly_token_budget', 'pricing']);
  const kind = choice(input.kind, 'kind', ['openai_compatible', 'anthropic_compatible', 'anthropic', 'internal_gateway'] as const);
  const protocol = choice(input.protocol, 'protocol', ['openai_chat', 'anthropic_messages'] as const);
  if ((kind === 'openai_compatible' && protocol !== 'openai_chat')
    || ((kind === 'anthropic_compatible' || kind === 'anthropic') && protocol !== 'anthropic_messages')) invalid('protocol');
  const caps = object(input.capabilities ?? {}, 'capabilities', ['tools', 'structured_output', 'prompt_cache', 'effort']);
  const rates = input.pricing == null ? null : object(input.pricing, 'pricing', [
    'input_minor_per_million', 'output_minor_per_million', 'cache_read_minor_per_million',
  ]);
  const data: ModelProvider = {
    kind, protocol, endpoint_ref: opaqueRef(input, 'endpoint_ref'), credential_ref: opaqueRef(input, 'credential_ref'),
    allowed_data_classes: validateModelCategories(input.allowed_data_classes),
    capabilities: {
      tools: bool(caps.tools, 'capabilities.tools', false),
      structured_output: bool(caps.structured_output, 'capabilities.structured_output', false),
      prompt_cache: bool(caps.prompt_cache, 'capabilities.prompt_cache', false),
      effort: bool(caps.effort, 'capabilities.effort', false),
    },
    enabled: bool(input.enabled, 'enabled', true),
    monthly_token_budget: input.monthly_token_budget == null ? null : integer(input.monthly_token_budget, 'monthly_token_budget', 1),
    pricing: rates && {
      input_minor_per_million: integer(rates.input_minor_per_million, 'input_minor_per_million', 0),
      output_minor_per_million: integer(rates.output_minor_per_million, 'output_minor_per_million', 0),
      cache_read_minor_per_million: integer(rates.cache_read_minor_per_million, 'cache_read_minor_per_million', 0),
    },
  };
  let row;
  if (input.id === undefined) {
    if (input.version !== undefined) invalid('version');
    row = await ctx.insert('agent', providerKind, data);
  } else {
    const previous = await required(ctx, 'agent', providerKind, opaqueRef(input, 'id'));
    // A new endpoint needs its own destination ID and egress approval.
    if (previous.data.endpoint_ref !== data.endpoint_ref || previous.data.protocol !== protocol || previous.data.kind !== kind) {
      throw new DomainError('model_destination_immutable', 'Create a new provider to change its endpoint, kind, or protocol', 409);
    }
    row = await ctx.update('agent', providerKind, previous.id, data, integer(input.version, 'version', 1));
  }
  await ctx.emit('agent.model_provider.configured', { provider_id: row.id, enabled: data.enabled });
  return row;
}

async function configureRoute(ctx: Context, input: Fields) {
  admin(ctx);
  object(input, 'route', ['version', 'purpose', 'provider_id', 'model', 'params', 'enabled']);
  const purpose = choice(input.purpose, 'purpose', modelPurposes);
  const provider = await required(ctx, 'agent', providerKind, opaqueRef(input, 'provider_id'));
  const params = object(input.params, 'params', ['max_tokens', 'effort']);
  const data: ModelRoute = {
    purpose, provider_id: provider.id, model: text(input, 'model', 256), enabled: bool(input.enabled, 'enabled', true), fallback: null,
    params: { max_tokens: integer(params.max_tokens, 'params.max_tokens', 1, 1_000_000) },
  };
  if (params.effort !== undefined) {
    if (provider.data.protocol !== 'anthropic_messages' || provider.data.capabilities?.effort !== true) invalid('params.effort');
    data.params.effort = choice(params.effort, 'params.effort', ['low', 'medium', 'high'] as const);
  }
  const current = await ctx.get('agent', routeKind, purpose);
  if (!current && input.version !== undefined) invalid('version');
  const row = current
    ? await ctx.update('agent', routeKind, purpose, data, integer(input.version, 'version', 1))
    : await ctx.insert('agent', routeKind, data, purpose);
  await ctx.emit('agent.model_route.configured', { purpose, provider_id: provider.id, enabled: data.enabled });
  return row;
}

export async function resolveModelRoute(ctx: Context, purpose: ModelPurpose) {
  choice(purpose, 'purpose', modelPurposes);
  const route = await ctx.get('agent', routeKind, purpose);
  const provider = route?.data.enabled === true ? await ctx.get('agent', providerKind, route.data.provider_id) : undefined;
  if (!route || provider?.data.enabled !== true) {
    throw new DomainError('AI_NOT_CONFIGURED', 'No enabled model route for this purpose', 409);
  }
  return { route: route.data as ModelRoute, provider: provider.data as ModelProvider, providerId: provider.id };
}

export async function guardModelEgress(ctx: Context, providerId: string, provider: ModelProvider, categories: readonly ModelDataClass[]) {
  if (categories.some(category => !provider.allowed_data_classes.includes(category))) {
    throw new DomainError('EGRESS_DENIED', 'Provider does not permit all required data categories', 403);
  }
  await requireEgress(ctx, 'model_provider', categories, providerId);
}

export async function providerMonthTokens(ctx: Context, providerId: string): Promise<number> {
  const month = ctx.now.slice(0, 7);
  return (await ctx.list('agent', usageKind)).filter(row => row.data.provider_id === providerId
    && typeof row.data.occurred_at === 'string' && row.data.occurred_at.startsWith(month))
    .reduce((tokens, row) => tokens + row.data.input_tokens + row.data.output_tokens, 0);
}

export async function guardModelBudget(ctx: Context, providerId: string, provider: ModelProvider) {
  if (provider.monthly_token_budget !== null && await providerMonthTokens(ctx, providerId) >= provider.monthly_token_budget) {
    throw new DomainError('MODEL_BUDGET_EXHAUSTED', 'Provider monthly token budget is exhausted', 402);
  }
  await requireUsageCapacity(ctx, 'model_tokens', 1);
}

export const modelCommands: Commands = {
  configure_model_provider: { roles: admins, run: configureProvider },
  configure_model_route: { roles: admins, run: configureRoute },
  model_availability: {
    roles: readers,
    async run(ctx, input) {
      object(input, 'availability', ['purpose', 'categories']);
      const purpose = choice(input.purpose, 'purpose', modelPurposes);
      const requested = input.categories === undefined ? undefined : validateModelCategories(input.categories);
      try {
        const { provider, providerId } = await resolveModelRoute(ctx, purpose);
        if (requested) await guardModelEgress(ctx, providerId, provider, requested);
        else {
          // Without categories, report whether at least one allowed class may be sent.
          let allowed = false;
          for (const category of provider.allowed_data_classes) {
            try { await guardModelEgress(ctx, providerId, provider, [category]); allowed = true; break; }
            catch (error) { if (!(error instanceof DomainError) || error.status !== 403) throw error; }
          }
          if (!allowed) throw new DomainError('EGRESS_DENIED', 'Provider egress is blocked', 403);
        }
        await guardModelBudget(ctx, providerId, provider);
        return { purpose, available: true };
      } catch (error) {
        if (!(error instanceof DomainError) || ![402, 403, 409].includes(error.status)) throw error;
        return { purpose, available: false, reason: error.code };
      }
    },
  },
  model_configuration: {
    roles: admins,
    async run(ctx, input) {
      admin(ctx);
      object(input, 'configuration query', []);
      return { providers: await ctx.list('agent', providerKind), routes: await ctx.list('agent', routeKind) };
    },
  },
  model_usage: {
    roles: admins,
    async run(ctx, input) {
      admin(ctx);
      object(input, 'usage query', ['provider_id', 'purpose', 'month']);
      const provider = input.provider_id === undefined ? undefined : opaqueRef(input, 'provider_id');
      const purpose = input.purpose === undefined ? undefined : choice(input.purpose, 'purpose', modelPurposes);
      const month = input.month === undefined ? ctx.now.slice(0, 7) : text(input, 'month', 7);
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) invalid('month');
      const items = (await ctx.list('agent', usageKind)).filter(row => (!provider || row.data.provider_id === provider)
        && (!purpose || row.data.purpose === purpose) && row.data.occurred_at.startsWith(month));
      const budgets = (await ctx.list('agent', providerKind)).filter(row => !provider || row.id === provider)
        .map(row => ({ provider_id: row.id, monthly_token_budget: row.data.monthly_token_budget }));
      return { month, items, budgets };
    },
  },
};
