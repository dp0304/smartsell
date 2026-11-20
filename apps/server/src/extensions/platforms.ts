import { createPlatformAdapter, platforms, type AdapterTransport, type ConnectionCtx, type ExternalRef, type PlatformProvider } from '../../../../packages/adapters/src/index.js';
import { bindOfficialPlatform, type OfficialPlatformBinding } from '../modules/execution/platform-adapter.js';
import type { OfficialAdapter, OfficialRequest } from '../modules/execution/official.js';
export { platforms, createPlatformAdapter } from '../../../../packages/adapters/src/index.js';
export { createAuthorizationAdapter } from '../../../../packages/adapters/src/oauth.js';
export type { PlatformProvider, CapabilityReport, ConnectionCtx } from '../../../../packages/adapters/src/index.js';

export function findPlatform(key: unknown) {
  if (typeof key !== 'string' || !Object.hasOwn(platforms, key)) return undefined;
  return platforms[key as keyof typeof platforms];
}

/** Bind only to the committed execution worker and a scoped credential resolver. */
export function bindPlatform(provider: PlatformProvider, transport: AdapterTransport, binding: OfficialPlatformBinding): OfficialAdapter {
  const adapter = createPlatformAdapter(provider, transport);
  const verifiedAdapter = {
    ...adapter,
    async observe(ref: ExternalRef, ctx: ConnectionCtx) {
      const result = await adapter.observe(ref, ctx);
      if (result.status !== 'published' || result.ref?.kind !== 'tiktok_publish') return result;
      if (result.postIds?.length !== 1) return { status: 'unknown', substatus: 'post_identity_requires_reconciliation' };
      return { ...result, ref: { ...result.ref, id: result.postIds[0] } };
    },
  } satisfies typeof adapter;

  // The resolver sees the internal account ID. The provider receives only the verified external identity.
  const operationOf = (request: OfficialRequest) => request.frozen.platform_operation ?? 'publish';
  const connectionMatches = (request: OfficialRequest, ctx: ConnectionCtx) => {
    const configuredIdentity = ctx.credential?.configuration?.platformAccountId;
    return ctx.accountId === request.account_identity && ctx.credential?.accountId === request.account_identity &&
      (configuredIdentity === undefined || configuredIdentity === request.account_identity);
  };
  const forRequest = (request: OfficialRequest, ctx: ConnectionCtx) => bindOfficialPlatform({
    ...verifiedAdapter,
    execute(operation, input, execution) {
      if (operationOf(request) !== 'upload_draft') return adapter.execute(operation, input, execution);
      return adapter.execute('upload_draft', input, {
        ...execution, approval: execution.approval && { ...execution.approval, operation: 'upload_draft' },
      });
    },
  }, { connection: async () => ctx, payload: () => binding.payload(request) });
  const providerRequest = (request: OfficialRequest) => ({
    ...request,
    platform: request.frozen.platform_provider ?? request.platform,
    account_id: request.account_identity,
  });
  return {
    async submit(request) {
      const routed = providerRequest(request);
      const operation = operationOf(request);
      const blocked = (code: string) => ({ status: 'not_submitted' as const, code, evidence: `local_preflight:${code}` });
      if (routed.platform !== provider || !(operation === 'publish' || (operation === 'upload_draft' && provider === 'tiktok'))) return blocked('unsupported_operation');
      const ctx = await binding.connection(request);
      if (!connectionMatches(request, ctx)) return blocked('credential_unavailable');
      const report = await adapter.probe(ctx);
      const capability = report.capabilities.find((cap) => cap.executor === 'api' && cap.operation === operation);
      if (!capability?.available) return blocked(capability?.reason ?? 'capability_unavailable');
      return forRequest(request, ctx).submit(routed);
    },
    async observe(request, receiptId) {
      const routed = providerRequest(request);
      if (!receiptId || routed.platform !== provider) return { status: 'unknown', code: 'platform_reference_unavailable' };
      const ctx = await binding.connection(request);
      if (!connectionMatches(request, ctx)) return { status: 'unknown', code: 'credential_unavailable' };
      return forRequest(request, ctx).observe(routed, receiptId);
    },
  };
}
