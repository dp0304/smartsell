import type { Adapter, AdapterOptions, Capability, CapabilityDecl, CapabilityReport, ConnectionCtx, ProviderKey, ValidationIssue } from './adapter-types.ts';
import { providerCatalog, providers } from './provider-catalog.ts';
import { commercePage, commerceProviders, probeCommerce } from './provider-commerce.ts';
import { tradePage } from './provider-trade.ts';
import { readShopifyPromotion } from './shopify-promotion.ts';
import { AdapterError, classifyError, client, record, text } from './provider-http.ts';
import { createOAuth } from './provider-oauth.ts';
import { executeSocial, facebookPageToken, observeSocial, observeYoutubeMaintenance, probeSocial, socialPage, validateSocial } from './provider-social.ts';
import { createWebhook } from './provider-webhook.ts';

export type * from './adapter-types.ts';
export { providerCatalog, providers } from './provider-catalog.ts';
export { AdapterError, TransportError } from './provider-http.ts';
export { verifyShopifyCallback } from './provider-oauth.ts';

const identityProbes = new Set<ProviderKey>(['meta_instagram', 'meta_facebook', 'youtube', 'tiktok', 'douyin', ...commerceProviders]);
const aliases = new Map([['upload_draft', 'publish_upload'], ['posts', 'post_read'], ['products', 'product_read'], ['catalog', 'product_read'], ['orders', 'order_read'], ['refunds', 'refund_read'], ['metrics', 'insights_read']]);
const canonical = (operation: string) => aliases.get(operation) ?? operation;
const isRead = (operation: string) => operation.endsWith('_read');
const pageWriteAllowed = (tasks?: readonly string[]) => tasks?.includes('CREATE_CONTENT') === true;
const phases = { P0a: 0, P0b: 1, P1: 2, P2: 3 };

export function createAdapter(provider: ProviderKey, options: AdapterOptions = {}): Adapter {
  if (!Object.hasOwn(providerCatalog, provider)) throw new AdapterError('unsupported', 'unknown_provider');
  const definition = providerCatalog[provider];
  const request = client(provider, options.transport);
  const oauth = createOAuth(provider, options, request);
  const phaseAllows = (decl: CapabilityDecl) => options.phase === undefined ||
    (Object.hasOwn(phases, options.phase) && phases[decl.phase] <= phases[options.phase]);
  const webhooks = definition.capabilities.filter(decl => decl.operation.endsWith('_webhook'));
  const webhook = !webhooks.length || webhooks.some(phaseAllows) ? createWebhook(provider, options) : undefined;
  const now = options.now ?? Date.now;
  const configured = () => Boolean(options.transport && options.credentials?.clientId && options.credentials?.clientSecret);
  const tokenFor = (connection: ConnectionCtx) => {
    if (!configured()) throw new AdapterError('unsupported', 'unconfigured');
    const token = text(connection.accessToken);
    if (!token) throw new AdapterError('auth_expired', 'missing_access_token');
    return token;
  };
  function capabilityStatus(decl: CapabilityDecl, conn: ConnectionCtx, verified: boolean): Capability['status'] {
    if (decl.readiness === 'unsupported') return 'unsupported';
    if (!phaseAllows(decl)) return 'unsupported';
    if (decl.executor === 'manual') return 'manual_only';
    if (decl.readiness !== 'implemented' || decl.executor !== 'api') return 'unverified';
    if (decl.operation.endsWith('_webhook')) return 'unverified';
    if (!verified || !decl.requires_scopes?.every(scope => scope.split('|').some(alternative => conn.scopes?.includes(alternative)))) return 'needs_authorization';
    if (decl.requires_review && conn.directPostAudited !== true) return 'unverified';
    if (provider === 'meta_facebook' && !isRead(decl.operation) && !pageWriteAllowed(conn.pageTasks)) return 'needs_authorization';
    if (provider === 'tiktok' && !options.credentials?.tiktokVerifiedMediaOrigins?.length) return 'unverified';
    return isRead(decl.operation) ? 'read_only' : 'available';
  }
  const matrix = () => definition.capabilities.map(decl => ({ ...decl, requires_scopes: decl.requires_scopes && [...decl.requires_scopes] }));
  const capabilities = (conn: ConnectionCtx, verified: boolean) => matrix().map(decl => ({ ...decl, status: capabilityStatus(decl, conn, verified) }));
  function validate(operation: string, input: unknown, report: CapabilityReport): ValidationIssue[] {
    operation = canonical(operation);
    const object = record(input);
    const format = text(object.format);
    const usable = report.capabilities.some(decl => decl.operation === operation && decl.executor === 'api' && (decl.content_format === '*' || decl.content_format === format) && decl.status === 'available');
    if (report.provider !== provider || !usable) return [{ code: 'capability_unavailable', field: 'operation' }];
    return validateSocial(provider, operation, object, now());
  }
  const adapter: Adapter = {
    provider, api_version: definition.api_version, authStrategy: definition.authStrategy,
    oauth, webhook, staticMatrix: matrix, validate, classifyError,
    async probe(conn) {
      const report = (status: CapabilityReport['status'], ctx: ConnectionCtx, reason?: string, accounts?: CapabilityReport['accounts']): CapabilityReport => ({
        provider, status, reason, accounts, externalAccountId: ctx.externalAccountId, capabilities: capabilities(ctx, status === 'ready' && Boolean(ctx.externalAccountId)),
      });
      if (!identityProbes.has(provider)) return report('unsupported', conn, 'official_probe_unavailable');
      if (!configured()) return report('unconfigured', conn, 'unconfigured');
      if (!conn.accessToken) return report('blocked', conn, 'missing_access_token');
      try {
        const accounts = commerceProviders.has(provider) ? await probeCommerce(provider, options, request, conn, conn.accessToken) : await probeSocial(provider, request, conn, conn.accessToken);
        if (!accounts.length) return report('blocked', conn, 'identity_unverified', accounts);
        const selected = conn.externalAccountId ? accounts.find(entry => entry.externalAccountId === conn.externalAccountId) : accounts.length === 1 ? accounts[0] : undefined;
        if (!selected) return conn.externalAccountId ? report('blocked', conn, 'account_binding_mismatch', accounts) : report('ready', conn, 'account_selection_required', accounts);
        return report('ready', { ...conn, ...selected }, undefined, accounts);
      } catch (error) {
        const classification = classifyError(error);
        return report(classification.errorClass === 'unsupported' ? 'unconfigured' : 'blocked', conn, classification.reason ?? classification.errorClass);
      }
    },
    async execute(operation, input, ctx) {
      try {
        const name = canonical(operation);
        if (!text(ctx.client_request_id) || !(text(ctx.fencing_token) || (typeof ctx.fencing_token === 'number' && Number.isSafeInteger(ctx.fencing_token) && ctx.fencing_token > 0))) throw new AdapterError('invalid_input', 'execution_context_required');
        if (ctx.previousOutcome === 'outcome_unknown' || ctx.previousOutcome === 'accepted') throw new AdapterError('unsupported', 'observe_before_resubmit');
        const approval = ctx.approval;
        if (!text(ctx.externalAccountId) || !approval || approval.provider !== provider || approval.externalAccountId !== ctx.externalAccountId ||
          approval.operation !== name || approval.clientRequestId !== ctx.client_request_id) throw new AdapterError('permission_denied', 'execution_approval_required');
        if (ctx.credentialState !== 'active' || (ctx.credentialExpiresAt !== undefined &&
          (!Number.isFinite(ctx.credentialExpiresAt) || ctx.credentialExpiresAt <= now()))) throw new AdapterError('auth_expired', 'credential_unavailable');
        const token = tokenFor(ctx);
        const report: CapabilityReport = { provider, status: 'ready', capabilities: capabilities(ctx, Boolean(text(ctx.externalAccountId))) };
        const issues = validate(name, input, report);
        if (issues.length) throw new AdapterError(issues[0].code === 'capability_unavailable' ? 'unsupported' : 'invalid_input', issues[0].code === 'capability_unavailable' ? 'capability_unavailable' : issues[0].field);
        const scopedToken = provider === 'meta_facebook' ? await facebookPageToken(request, ctx, token, true) : token;
        return await executeSocial(provider, name, record(input), ctx, options, request, scopedToken);
      } catch (error) {
        const classified = classifyError(error);
        return { status: classified.errorClass === 'outcome_unknown' ? 'unknown' : 'failed', error: classified };
      }
    },
    async observe(query, ctx) {
      const reference = 'kind' in query ? query : query.externalRef;
      if (!reference) return { status: 'unknown', subStatus: 'external_ref_missing' };
      try {
        const token = tokenFor(ctx);
        const scopedToken = provider === 'meta_facebook' ? await facebookPageToken(request, ctx, token) : token;
        return await observeSocial(provider, reference, ctx, request, scopedToken);
      } catch (error) { return { status: 'unknown', externalRef: reference, error: classifyError(error) }; }
    },
    observeMaintenance: provider === 'youtube' && definition.capabilities.some(decl => decl.operation === 'edit_post' && phaseAllows(decl)) ? async (operation, reference, caption, ctx) => {
      if (!definition.capabilities.some(decl => decl.operation === operation && capabilityStatus(decl, ctx, Boolean(ctx.externalAccountId)) === 'available')) return 'inconclusive';
      try { return await observeYoutubeMaintenance(operation, reference, caption, ctx, request, tokenFor(ctx)); }
      catch { return 'inconclusive'; }
    } : undefined,
    readPromotion: provider === 'shopify' ? async (id, ctx) => {
      if (!ctx.scopes?.includes('read_discounts') || !ctx.externalAccountId) throw new AdapterError('permission_denied', 'discount_read_scope_required');
      return readShopifyPromotion(request, tokenFor(ctx), ctx, id);
    } : undefined,
    async *sync(resource, cursor, ctx) {
      const op = canonical(resource);
      const token = tokenFor(ctx);
      if (!definition.capabilities.some(decl => decl.operation === op && isRead(op) && capabilityStatus(decl, ctx, Boolean(text(ctx.externalAccountId))) === 'read_only')) throw new AdapterError('unsupported', 'sync_capability_unavailable');
      const scopedToken = provider === 'meta_facebook' ? await facebookPageToken(request, ctx, token) : token;
      const seen = new Set<string>();
      if (cursor !== null) seen.add(cursor);
      do {
        const page = op === 'order_read' || op === 'refund_read'
          ? await tradePage(provider, op, options, request, ctx, scopedToken, cursor)
          : commerceProviders.has(provider) ? await commercePage(provider, options, request, ctx, scopedToken, cursor)
          : await socialPage(provider, op, cursor, ctx, request, scopedToken);
        if (page.nextCursor !== null && seen.has(page.nextCursor)) throw new AdapterError('transient', 'cursor_did_not_advance');
        if (page.nextCursor !== null) seen.add(page.nextCursor);
        yield page;
        cursor = page.nextCursor;
      } while (cursor !== null);
    },
  };
  return adapter;
}

export function createAdapters(optionsByProvider: Partial<Record<ProviderKey, AdapterOptions>> = {}): Record<ProviderKey, Adapter> {
  return Object.fromEntries(providers.map(provider => [provider, createAdapter(provider, optionsByProvider[provider])])) as Record<ProviderKey, Adapter>;
}
