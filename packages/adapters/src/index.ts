import { fetchCatalog } from './catalog.ts';
import { classifyError, createRequester, fail, text } from './adapter-http.ts';
import { platforms } from './platforms.ts';
import { observe, publish, validatePublish } from './publishing.ts';
import type { AdapterTransport, CapabilityDecl, CapabilityReport, ConnectionCtx, ExecCtx, ExecutionReceipt, ExternalRef, OperationKey, Phase, PlatformProvider, SyncPage } from './types.ts';

export { platforms } from './platforms.ts';
export { createFetchTransport, type FetchTransportOptions } from './fetch-transport.ts';
export { createAdapter, createAdapters, providerCatalog, providers, TransportError, verifyShopifyCallback } from './official.ts';
export type { Adapter, AdapterOptions, ProviderKey } from './official.ts';
export { AdapterError, classifyError } from './adapter-http.ts';
export * from './types.ts';

const phase: Record<Phase, number> = { P0a: 0, P0b: 1, P1: 2, P2: 3 };
const googleScope = 'https://www.googleapis.com/auth/';
function hasScope(scopes: readonly string[], scope: string): boolean {
  if (scopes.includes(scope)) return true;
  return (scope === `${googleScope}youtube.upload` || scope === `${googleScope}youtube.readonly`) &&
    ['youtube', 'youtube.force-ssl', 'youtubepartner'].some(candidate => scopes.includes(`${googleScope}${candidate}`));
}
function unavailable(capability: CapabilityDecl, ctx: ConnectionCtx): string | undefined {
  if (!text(ctx.accountId)) return 'missing_account_id';
  const currentPhase = ctx.phase ?? 'P0a';
  if (!Object.hasOwn(phase, currentPhase) || phase[currentPhase] < phase[capability.phase]) return 'phase_unavailable';
  if (capability.executor === 'connector') {
    const device = ctx.device;
    if (!device || !text(device.id) || device.accountId !== ctx.accountId || device.channel !== capability.channel ||
      device.online !== true || device.compatible !== true || device.identityVerified !== true ||
      (device.hostOS !== 'windows' && device.hostOS !== 'macos')) return 'verified_device_required';
    if (device.channel === 'mobile' && device.mobileOS !== 'android' &&
      !(device.mobileOS === 'ios' && device.hostOS === 'macos' && phase[ctx.phase ?? 'P0a'] >= phase.P1)) return 'mobile_environment_unavailable';
  }
  if (!capability.implemented) return 'implementation_unavailable';
  if (capability.executor !== 'api') return;
  const credential = ctx.credential;
  if (!credential || credential.accountId !== ctx.accountId || !text(credential.accessToken) || credential.state !== 'active' ||
    (credential.expiresAt !== undefined && (!Number.isFinite(credential.expiresAt) || credential.expiresAt <= Date.now()))) return 'credential_unavailable';
  if (capability.approval && !credential.approvals?.includes(capability.approval)) return 'platform_approval_required';
  if (capability.scopes?.some(scope => !hasScope(credential.scopes, scope))) return 'missing_scope';
}

export function probePlatform(provider: PlatformProvider, ctx: ConnectionCtx): CapabilityReport {
  return { provider, accountId: ctx.accountId, capabilities: platforms[provider].capabilities.map(capability => {
    const reason = unavailable(capability, ctx);
    return { ...capability, available: reason === undefined, ...(reason ? { reason } : {}) };
  }) };
}

export function createPlatformAdapter(provider: PlatformProvider, transport?: AdapterTransport) {
  const platform = platforms[provider];
  const request = createRequester(provider, transport);
  const probe = (ctx: ConnectionCtx) => probePlatform(provider, ctx);
  const apiCapabilities = (operation: OperationKey, report: CapabilityReport) =>
    report.capabilities.filter(capability => capability.operation === operation && capability.executor === 'api');
  const validate = (operation: OperationKey, input: unknown, report: CapabilityReport) => {
    if (report.provider !== provider || !apiCapabilities(operation, report).some(capability => capability.available)) {
      return [{ field: 'operation', reason: 'official_api_unavailable' }];
    }
    return validatePublish(provider, operation, input);
  };
  function requireApi(operation: OperationKey, ctx: ConnectionCtx): void {
    const capabilities = apiCapabilities(operation, probe(ctx));
    if (capabilities.some(capability => capability.available)) return;
    const reasons = capabilities.map(capability => capability.reason);
    if (reasons.includes('platform_approval_required') || reasons.includes('missing_scope')) fail('permission_denied', 'official_api_permission_required');
    if (reasons.includes('credential_unavailable')) fail('auth_expired', 'credential_unavailable');
    fail('unsupported', 'official_api_unavailable');
  }
  return {
    provider,
    authStrategy: platform.authStrategy,
    staticMatrix: () => platform.capabilities,
    probe,
    validate,
    classifyError,
    async execute(operation: OperationKey, input: unknown, ctx: ExecCtx): Promise<ExecutionReceipt> {
      if (ctx.previousOutcome === 'outcome_unknown') return { status: 'unknown', substatus: 'verification_required' };
      if (ctx.previousOutcome === 'accepted') return { status: 'accepted', substatus: 'verification_required' };
      if (operation !== 'publish' && operation !== 'prepare_publish' && operation !== 'upload_draft') {
        return { status: 'failed', error: { errorClass: 'unsupported', reason: 'invalid_execution_operation' } };
      }
      const approval = ctx.approval;
      if (!text(ctx.accountId) || !text(ctx.client_request_id) ||
        !(text(ctx.fencing_token) || (typeof ctx.fencing_token === 'number' && Number.isSafeInteger(ctx.fencing_token) && ctx.fencing_token > 0)) ||
        !approval || approval.accountId !== ctx.accountId || approval.operation !== operation || approval.clientRequestId !== ctx.client_request_id) {
        return { status: 'failed', error: { errorClass: 'permission_denied', reason: 'execution_approval_required' } };
      }
      const report = probe(ctx);
      const official = apiCapabilities(operation, report).find(capability => capability.available);
      const manual = report.capabilities.some(capability => capability.operation === 'publish' && capability.executor === 'manual' && capability.available);
      if ((!official || !transport) && manual) return { status: 'manual_required', reason: official ? 'transport_unavailable' : 'official_api_unavailable' };
      try {
        requireApi(operation, ctx);
        const issues = validate(operation, input, report);
        if (issues.length) fail('invalid_input', `${issues[0].field}:${issues[0].reason}`);
        return await publish(provider, operation, input, ctx, request);
      } catch (error) {
        const classified = classifyError(error);
        return { status: classified.errorClass === 'outcome_unknown' ? 'unknown' : 'failed', error: classified };
      }
    },
    async observe(ref: ExternalRef, ctx: ConnectionCtx) {
      requireApi('observe', ctx);
      return observe(provider, ref, ctx, request);
    },
    async *sync(resource: 'catalog', cursor: string | null, ctx: ConnectionCtx): AsyncIterable<SyncPage> {
      if (resource !== 'catalog') fail('unsupported', 'unsupported_sync_resource');
      const seen = new Set<string>();
      let next = cursor;
      do {
        requireApi('catalog', ctx);
        if (next !== null) seen.add(next);
        const page = await fetchCatalog(provider, next, ctx.credential!, request);
        if (page.nextCursor !== null && seen.has(page.nextCursor)) fail('transient', 'catalog_cursor_repeated');
        yield page;
        next = page.nextCursor;
      } while (next !== null);
    },
  };
}

export type PlatformAdapter = ReturnType<typeof createPlatformAdapter>;
