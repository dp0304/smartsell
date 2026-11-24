import type { Context } from '@smartsell/contracts';
import type { ProviderKey, RawRequest } from '../../../../../packages/adapters/src/adapter-types.ts';
import type { Row } from '@smartsell/contracts';
import { deviceBodyLimits, handleDeviceRequest, type ConnectorServices, type DeviceAction } from './connector-service.ts';
import { authenticateDevice, pairDevice, type SignedDeviceRequest } from './device-control.ts';
import { refreshHostCaches } from '../worker/host-cache.ts';
import { fail, object, text } from './input.ts';
import { acceptWebhook, completeOAuth, digest, type AccountServices } from './oauth.ts';
import { WorkerCatalogRequestError, workerCatalogUploadBodyLimit } from '../commerce/worker-catalog.js';

export interface AccountGatewayDependencies {
  account: AccountServices;
  connector: ConnectorServices;
  /** Workspace writes and lookup-plus-consumption must serialize. Resolve the tenant from storage. */
  transaction<T>(workspaceId: string, run: (ctx: Context) => T | Promise<T>): Promise<T>;
  oauthWorkspace(provider: ProviderKey, stateHash: string): Promise<string | undefined>;
  pairingWorkspace(codeHash: string, workspaceHint?: string): Promise<string | undefined>;
  deviceWorkspace(deviceId: string, workspaceHint?: string): Promise<string | undefined>;
  /** Select from trusted app routing configuration. Never trust an unverified event's workspace. */
  webhookWorkspace(provider: ProviderKey, endpointId: string): Promise<{ workspaceId: string; appId?: string } | undefined>;
}

/** Route/controller boundary. Host mounts these with raw-body handling, rate limits and no-store responses. */
export function createAccountGateway(deps: AccountGatewayDependencies) {
  return {
    async oauthCallback(provider: ProviderKey, query: Readonly<Record<string, string>>) {
      const workspace = await deps.oauthWorkspace(provider, digest(text(query.state)));
      if (!workspace) fail('OAUTH_STATE_INVALID', 400);
      return deps.transaction(workspace, ctx => completeOAuth(ctx, provider, query, deps.account));
    },
    async webhookChallenge(provider: ProviderKey, endpointId: string, query: Readonly<Record<string, string>>) {
      const route = await deps.webhookWorkspace(provider, endpointId);
      if (!route) fail('WEBHOOK_ENDPOINT_NOT_FOUND', 404);
      const adapter = deps.account.adapter?.(provider, route.appId);
      if (!adapter || adapter.provider !== provider || !adapter.webhook?.challenge) fail('WEBHOOK_ENDPOINT_NOT_FOUND', 404);
      const challenge = adapter.webhook.challenge(query);
      if (!challenge || !/^\d{1,64}$/.test(challenge)) fail('WEBHOOK_CHALLENGE_INVALID', 403);
      return challenge;
    },
    async webhook(provider: ProviderKey, endpointId: string, request: RawRequest) {
      const route = await deps.webhookWorkspace(provider, endpointId);
      if (!route) fail('WEBHOOK_ENDPOINT_NOT_FOUND', 404);
      return deps.transaction(route.workspaceId, ctx => acceptWebhook(ctx, provider, route.appId, request, deps.account));
    },
    async pair(input: unknown, workspaceHint?: string) {
      const body = object(input);
      const workspace = await deps.pairingWorkspace(digest(text(body.pairing_code)), workspaceHint);
      if (!workspace) fail('PAIRING_CODE_INVALID', 401);
      return deps.transaction(workspace, ctx => pairDevice(ctx, body));
    },
    async device(action: DeviceAction, rawBody: Uint8Array, signed: SignedDeviceRequest, attemptId?: string, workspaceHint?: string, requestId?: string) {
      if (rawBody.byteLength > (action === 'catalog.upload' ? workerCatalogUploadBodyLimit : deviceBodyLimits[action] ?? 128_000)) fail('DEVICE_BODY_TOO_LARGE', 413);
      // latest_worker and driver_config come from files: read them before, never inside, the transaction (§0 rule 8).
      if (action === 'heartbeat') await refreshHostCaches();
      if (attemptId !== undefined) {
        let body: unknown;
        try { body = JSON.parse(Buffer.from(rawBody).toString('utf8')); } catch { fail('INVALID_DEVICE_BODY', 422); }
        if (object(body).attempt_id !== attemptId) fail('DEVICE_SCOPE_MISMATCH', 403);
      }
      const workspace = await deps.deviceWorkspace(text(signed.device_id), workspaceHint);
      if (!workspace) fail('DEVICE_NOT_FOUND', 401);
      const outcome = await deps.transaction(workspace, async ctx => {
        try {
          return { data: await handleDeviceRequest(ctx, action, rawBody, signed, deps.connector, requestId) };
        } catch (error) {
          if ((action === 'catalog.claim' || action === 'catalog.upload') && error instanceof WorkerCatalogRequestError) return { error };
          throw error;
        }
      });
      if ('error' in outcome) throw outcome.error;
      return outcome.data;
    },
    /**
     * A signed GET/PUT outside the JSON device routes (§5.4: media, evidence, driver-config). Verifies the signature and runs
     * `run` in one short transaction; streaming and storage IO happen after it returns.
     */
    async signed<T>(action: string, rawBody: Uint8Array, signed: SignedDeviceRequest, workspaceHint: string | undefined, bodyLimit: number,
      run: (ctx: Context, device: Row) => T | Promise<T>): Promise<T> {
      const workspace = await deps.deviceWorkspace(text(signed.device_id), workspaceHint);
      if (!workspace) fail('DEVICE_NOT_FOUND', 401);
      return deps.transaction(workspace, async ctx => run(ctx, authenticateDevice(ctx, action, rawBody, signed, bodyLimit)));
    },
    /** A follow-up write for an already authenticated signed request (evidence record after the bytes are stored). */
    async continued<T>(deviceId: string, workspaceHint: string | undefined, run: (ctx: Context, device: Row) => T | Promise<T>): Promise<T> {
      const workspace = await deps.deviceWorkspace(deviceId, workspaceHint);
      if (!workspace) fail('DEVICE_NOT_FOUND', 401);
      return deps.transaction(workspace, async ctx => {
        const device = ctx.get('connector_device', deviceId);
        if (device.status !== 'active') fail('DEVICE_INACTIVE', 401);
        return run(ctx, device);
      });
    },
  };
}
