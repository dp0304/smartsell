import type { ConnectionCtx, ExternalRef, PlatformAdapter } from '../../../../../packages/adapters/src/index.ts';
import type { OfficialAdapter, OfficialRequest } from './official.ts';

export interface OfficialPlatformBinding {
  connection(request: OfficialRequest): Promise<ConnectionCtx>;
  // Resolve frozen assets from server-owned storage and translate approved options to the provider DTO.
  payload(request: OfficialRequest): Promise<unknown>;
}

export function bindOfficialPlatform(adapter: PlatformAdapter, binding: OfficialPlatformBinding): OfficialAdapter {
  async function connection(request: OfficialRequest) {
    const provider = request.frozen.platform_provider ?? request.platform;
    if (provider !== adapter.provider) throw new Error('Platform adapter mismatch');
    const ctx = await binding.connection(request);
    if (ctx.accountId !== request.account_id || ctx.credential?.accountId !== request.account_id) throw new Error('Connection account mismatch');
    return ctx;
  }
  return {
    async submit(request) {
      let ctx: ConnectionCtx;
      let payload: unknown;
      try {
        ctx = await connection(request);
        payload = await binding.payload(request);
      } catch {
        return { status: 'not_submitted', code: 'preparation_failed', evidence: 'Credential or frozen payload preparation failed before invoking the platform adapter' };
      }
      const receipt = await adapter.execute('publish', payload, {
        ...ctx, client_request_id: request.client_request_id, fencing_token: request.fencing_token,
        approval: { accountId: ctx.accountId, operation: 'publish', clientRequestId: request.client_request_id },
      });
      if (receipt.status === 'manual_required') return { status: 'unknown', code: 'manual_verification_required' };
      return {
        status: ['accepted', 'published', 'running'].includes(receipt.status) ? 'accepted' : 'unknown',
        ...(receipt.ref ? { receipt_id: JSON.stringify(receipt.ref) } : {}),
        code: receipt.error?.errorClass,
      };
    },
    async observe(request, receiptId) {
      if (!receiptId) return { status: 'unknown', code: 'platform_reference_unavailable' };
      const ctx = await connection(request);
      const ref = JSON.parse(receiptId) as ExternalRef;
      if (ref.provider !== adapter.provider || ref.accountId !== ctx.accountId) return { status: 'unknown', code: 'platform_reference_mismatch' };
      const observation = await adapter.observe(ref, ctx);
      const post = observation.ref;
      if (observation.status === 'published' && post?.provider === adapter.provider && post.accountId === ctx.accountId) {
        return { status: 'published', external_post_id: post.id, evidence: `${post.provider}:${post.kind}:${post.id}` };
      }
      if (observation.status === 'failed') return { status: 'failed', evidence: `${ref.provider}:${ref.kind}:${ref.id}:failed` };
      if (observation.status === 'cancelled') return { status: 'cancelled', evidence: `${ref.provider}:${ref.kind}:${ref.id}:cancelled` };
      if (observation.status === 'running' || observation.status === 'accepted') return { status: 'pending' };
      return { status: 'unknown', code: observation.error?.errorClass ?? 'platform_outcome_inconclusive' };
    },
  };
}
