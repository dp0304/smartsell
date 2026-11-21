import { required, text, type Commands, type Context, type Entity, type Fields } from '../types.js';
import { accountAccess, accountActions, activeAccountGrant, admin, ads, check, cmd, currency, eventData, expected, hash, inputRow, integer, matchingCampaign, obj, oneOf, optional, patch, read, refs, row, same, timestamp, timezone } from './domain.js';

export function permissions(value: unknown, now: string) {
  check(Array.isArray(value) && value.length <= 100, 'invalid_input', 'Invalid account permissions');
  const grants = value.map(raw => {
    const grant = obj(raw, 'permission');
    const actor_id = text(grant, 'actor_id', 200);
    const actions = refs(grant.actions, 'actions', 1).map(action => oneOf(action, accountActions, 'action'));
    const expires_at = grant.expires_at == null ? null : timestamp(grant.expires_at, 'expires_at');
    check(!expires_at || Date.parse(expires_at) > Date.parse(now), 'invalid_input', 'Permission has already expired');
    const max_spend_minor = actions.includes('spend') ? integer(grant.max_spend_minor, 'max_spend_minor', 1) : 0;
    return { actor_id, actions, expires_at, max_spend_minor };
  });
  check(new Set(grants.map(item => item.actor_id)).size === grants.length, 'invalid_input', 'Duplicate account permission actor');
  return grants;
}

async function connection(ctx: Context, data: Fields) {
  const value = await required(ctx, 'account', 'connection', data.connection_id);
  check(['ads', 'ad', 'advertising'].includes(value.data.purpose), 'CAPABILITY_UNAVAILABLE', 'A dedicated advertising connection is required', 409);
  same(value.data.provider, data.provider, 'Connection provider');
  same(value.data.brand_id, data.brand_id, 'Connection brand');
  const external = value.data.external_account_id ?? value.data.external_principal_id;
  if (external) same(external, data.external_account_id, 'Connection external account');
  return value;
}

export async function capabilities(ctx: Context, account: Entity) {
  if (!account.data.connection_id) return { read_capability: 'unavailable', write_capability: 'unavailable' };
  const connected = await ctx.get('account', 'connection', account.data.connection_id);
  if (!connected || !['active', 'connected', 'authorized'].includes(connected.data.status) ||
      (connected.data.expires_at && Date.parse(connected.data.expires_at) <= Date.parse(ctx.now))) {
    return { read_capability: 'unavailable', write_capability: 'unavailable' };
  }
  await connection(ctx, account.data);
  const find = async (key: string, operations: string[]) => {
    const id = account.data[key];
    if (!id) return 'unavailable';
    const cap = await ctx.get('account', 'capability', id);
    if (!cap || cap.data.connection_id !== connected.id ||
        cap.data.external_account_id !== account.data.external_account_id ||
        !operations.includes(cap.data.operation) || cap.data.social_account_id ||
        (cap.data.expires_at && Date.parse(cap.data.expires_at) <= Date.parse(ctx.now))) return 'unavailable';
    return cap.data.status === 'available' ? 'available' : 'unavailable';
  };
  return { read_capability: await find('read_capability_id', ['ads_read', 'ad_report_read', 'ads_report_read', 'ads.report.read']),
    write_capability: await find('write_capability_id', ['ads_write', 'ad_operation_write', 'ads_operation_write', 'ads.operation.write']) };
}

const accountStatuses = ['active', 'restricted', 'disabled'] as const;
export const accounts: Commands = {
  register_account: cmd(admin, async (ctx, input) => {
    const brand_id = text(input, 'brand_id', 200);
    await required(ctx, 'workspace', 'brand', brand_id);
    const provider = text(input, 'provider', 60);
    check(/^[a-z][a-z0-9_]*_ads$/.test(provider), 'invalid_input', 'Invalid advertising provider');
    const external_account_id = text(input, 'external_account_id', 200);
    const data = {
      provider, external_account_id, brand_id,
      currency: currency(input.currency), timezone: timezone(input.timezone),
      connection_id: optional(input, 'connection_id', 200),
      read_capability_id: optional(input, 'read_capability_id', 200), write_capability_id: optional(input, 'write_capability_id', 200),
      status_snapshot: oneOf(input.status_snapshot ?? 'active', accountStatuses, 'status_snapshot'),
      spend_cap_snapshot: integer(input.spend_cap_minor, 'spend_cap_minor'),
      permissions: permissions(input.permissions ?? [], ctx.now),
    };
    check(data.connection_id || (!data.read_capability_id && !data.write_capability_id), 'invalid_input', 'Capabilities require a dedicated connection');
    check(!data.read_capability_id || data.read_capability_id !== data.write_capability_id, 'invalid_input', 'Read and write capabilities must be separate');
    if (data.connection_id) await connection(ctx, data);
    const id = hash(['ad_account', ctx.tenantId, provider, external_account_id]);
    check(!(await ctx.get(ads, 'ad_account', id)), 'conflict', 'Advertising account already exists', 409);
    const account = await ctx.insert(ads, 'ad_account', data, id);
    if (data.connection_id) await ctx.emit('ads.account.connected', eventData(ctx, account, { connection_id: data.connection_id }));
    await ctx.emit('ads.account.registered', eventData(ctx, account));
    return { ...account, capabilities: await capabilities(ctx, account) };
  }),
  set_account_permissions: cmd(admin, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input);
    expected(account, input);
    const updated = await patch(ctx, account, { permissions: permissions(input.permissions, ctx.now) });
    await ctx.emit('ads.account.permissions_changed', eventData(ctx, updated));
    return updated;
  }),
  update_account: cmd(admin, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input);
    expected(account, input);
    const patchData: Fields = {};
    for (const key of ['connection_id', 'read_capability_id', 'write_capability_id']) {
      if (Object.hasOwn(input, key)) patchData[key] = optional(input, key, 200);
    }
    if (Object.hasOwn(input, 'status_snapshot')) patchData.status_snapshot = oneOf(input.status_snapshot, accountStatuses, 'status_snapshot');
    if (Object.hasOwn(input, 'spend_cap_minor')) patchData.spend_cap_snapshot = integer(input.spend_cap_minor, 'spend_cap_minor');
    check(Object.keys(patchData).length, 'invalid_input', 'Supply an editable account field');
    const data = { ...account.data, ...patchData };
    check(data.connection_id || (!data.read_capability_id && !data.write_capability_id), 'invalid_input', 'Capabilities require a dedicated connection');
    check(!data.read_capability_id || data.read_capability_id !== data.write_capability_id, 'invalid_input', 'Read and write capabilities must be separate');
    if (data.connection_id) await connection(ctx, data);
    const updated = await patch(ctx, account, patchData);
    const summary = await capabilities(ctx, updated);
    if (data.connection_id && data.connection_id !== account.data.connection_id) {
      await ctx.emit('ads.account.connected', eventData(ctx, updated, { connection_id: data.connection_id }));
    }
    await ctx.emit('ads.account.capability_changed', eventData(ctx, updated, summary));
    return { ...updated, capabilities: summary };
  }),
  list_accounts: cmd(read, async ctx => {
    const items = [];
    for (const account of await ctx.list(ads, 'ad_account')) {
      const grant = activeAccountGrant(account.data.permissions, ctx.actorId, ctx.now);
      if (!grant?.actions.includes('read')) continue;
      const { permissions: _, ...data } = account.data;
      items.push({ ...account, data: { ...data, actions: grant.actions, max_spend_minor: grant.max_spend_minor, ...await capabilities(ctx, account) } });
    }
    return { items };
  }),
  list_entities: cmd(read, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'read');
    const campaignId = optional(input, 'campaign_id', 200);
    return { items: (await ctx.list(ads, 'ad_entity')).filter(item => item.data.ad_account_id === account.id && (!campaignId || item.data.campaign_id === campaignId)) };
  }),
  record_entity_snapshot: cmd(admin, async (ctx, input) => {
    const account = await inputRow(ctx, 'ad_account', input, 'ad_account_id');
    accountAccess(ctx, account, 'draft');
    const level = oneOf(input.level, ['campaign', 'ad_group', 'ad'] as const, 'level');
    const external_id = text(input, 'external_id', 200);
    const parent_entity_id = optional(input, 'parent_entity_id', 200);
    const campaign_id = optional(input, 'campaign_id', 200);
    const ad_creative_variant_id = optional(input, 'ad_creative_variant_id', 200);
    const platform_post_id = optional(input, 'platform_post_id', 200);
    if (campaign_id) await matchingCampaign(ctx, campaign_id, account.data.brand_id);
    if (platform_post_id) {
      const post = await required(ctx, 'execution', 'platform_post', platform_post_id);
      same(post.data.brand_id, account.data.brand_id, 'Platform post');
    }
    check(level === 'campaign' ? !parent_entity_id : !!parent_entity_id, 'invalid_input', 'Invalid parent for structure level');
    if (parent_entity_id) {
      const parent = await row(ctx, 'ad_entity', parent_entity_id);
      same(parent.data.ad_account_id, account.id, 'Entity parent');
      same(parent.data.level, level === 'ad' ? 'ad_group' : 'campaign', 'Entity parent level');
      same(campaign_id, parent.data.campaign_id, 'Entity campaign');
    }
    if (ad_creative_variant_id) {
      check(level === 'ad', 'invalid_input', 'A creative variant belongs to an ad');
      const variant = await row(ctx, 'ad_creative_variant', ad_creative_variant_id);
      same(variant.data.ad_account_id, account.id, 'Creative variant');
      same(variant.data.campaign_id, campaign_id, 'Creative variant campaign');
    }
    const budget = input.budget_snapshot == null ? null : obj(input.budget_snapshot, 'budget_snapshot');
    const budget_snapshot = budget && { amount_minor: integer(budget.amount_minor, 'amount_minor'), currency: currency(budget.currency),
      type: oneOf(budget.type, ['daily', 'lifetime'] as const, 'type') };
    if (budget_snapshot) same(budget_snapshot.currency, account.data.currency, 'Budget currency');
    const observed_at = timestamp(input.observed_at, 'observed_at');
    check(Date.parse(observed_at) <= Date.parse(ctx.now), 'invalid_input', 'Observation cannot be in the future');
    const source = oneOf(input.source, ['manual', 'import'] as const, 'source');
    const source_ref = source === 'import' ? text(input, 'source_ref', 200) : optional(input, 'source_ref', 200);
    if (source === 'import') await required(ctx, 'ingest', 'import_batch', source_ref!);
    const id = hash(['ad_entity', account.id, level, external_id]);
    const old = await ctx.get(ads, 'ad_entity', id);
    const data = { ad_account_id: account.id, brand_id: account.data.brand_id, level, external_id, parent_entity_id, campaign_id, ad_creative_variant_id,
      platform_post_id, name: text(input, 'name', 200), objective: optional(input, 'objective', 100), status_snapshot: text(input, 'status_snapshot', 100),
      budget_snapshot, observed_at, source, source_ref };
    if (old) {
      expected(old, input);
      check(observed_at > old.data.observed_at, 'invalid_state', 'Structure snapshot must be newer', 409);
    }
    const snapshot = old ? await patch(ctx, old, data) : await ctx.insert(ads, 'ad_entity', data, id);
    if (ad_creative_variant_id) {
      const usageId = hash(['creative_usage', ad_creative_variant_id, id]);
      if (!(await ctx.get(ads, 'ad_creative_usage', usageId))) {
        await ctx.insert(ads, 'ad_creative_usage', { ad_account_id: account.id, creative_variant_id: ad_creative_variant_id, ad_entity_id: id, first_observed_at: observed_at }, usageId);
      }
    }
    await ctx.emit('ads.entity.observed', eventData(ctx, snapshot));
    return snapshot;
  }),
};
