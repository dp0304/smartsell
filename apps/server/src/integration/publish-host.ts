import type { Context } from '@smartsell/contracts';
import type { FastifyInstance } from 'fastify';
import { fields, opaqueId, parseChoice } from '../../../../packages/connector-tasks/src/tasks.js';
import type { AccountServices } from '../modules/account/oauth.js';
import type { ConnectorServices } from '../modules/account/connector-service.js';
import { runPostMaintenance } from '../modules/execution/post-maintenance.js';
import type { Registered, Schedule } from '../operations.js';
import type { BackgroundDrain, BackgroundStore } from '../runtime.js';
import type { CustomerEgress } from './customer-egress.js';
import { publishConnector, publishDrain } from './publish-connector.js';
import { mountPublishDevice } from './publish-device.js';
import { youtubePublishing, type PublishMedia } from './publish-youtube.js';
import type { Storage } from '../../../../packages/media-store/src/storage.js';
import { configureWorkerHost, type WorkerHostOptions } from '../modules/worker/model.js';
import { runWorkerLifecycle } from '../modules/worker/lifecycle.js';
import { refreshHostCaches } from '../modules/worker/host-cache.js';

const providers = ['xiaohongshu', 'douyin'] as const;
const channels = ['browser', 'mobile'] as const;
const modes = ['assist', 'auto'] as const;

/** Deployment-side approvals. An account's risk acknowledgement cannot add a platform grant. */
export function publishDevicePolicy(raw: string | undefined, termsRaw: string | undefined) {
  const records: unknown = JSON.parse(raw ?? '[]');
  if (!Array.isArray(records)) throw new Error('Invalid SMARTSELL_CONNECTOR_APPROVALS');
  const approvals = records.map(record => {
    const row = fields(record, ['workspace_id', 'binding_id', 'device_id', 'platform_identity', 'provider', 'channel', 'mode', 'client_version', 'approval_reference'], ['mobile_device_id']);
    const provider = parseChoice(row.provider, providers, 'provider');
    const channel = parseChoice(row.channel, channels, 'channel');
    const mobile = row.mobile_device_id === undefined ? undefined : opaqueId(row.mobile_device_id, 'mobile_device_id');
    if ((channel === 'mobile') !== Boolean(mobile)) throw new Error('Invalid connector approval target');
    opaqueId(row.approval_reference, 'approval_reference');
    return {
      workspace: opaqueId(row.workspace_id, 'workspace_id'), binding: opaqueId(row.binding_id, 'binding_id'),
      device: opaqueId(row.device_id, 'device_id'), identity: opaqueId(row.platform_identity, 'platform_identity'),
      version: opaqueId(row.client_version, 'client_version'), provider, channel, mobile,
      mode: parseChoice(row.mode, modes, 'mode'),
    };
  });
  const terms = termsRaw === undefined ? undefined : (() => {
    const input = fields(JSON.parse(termsRaw), ['version', 'text']);
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 20_000) throw new Error('Invalid connector terms');
    return Object.freeze({ version: opaqueId(input.version, 'version'), text: input.text });
  })();
  return {
    terms: () => terms,
    connectorConfigured(ctx: Context, bindingId: string, mode: 'assist' | 'auto') {
      if (mode === 'auto' && !terms) return false;
      const binding = ctx.list('account_execution_binding').find(row => row.id === bindingId);
      const account = ctx.list('social_account').find(row => row.id === binding?.social_account_id);
      const device = ctx.list('connector_device').find(row => row.id === binding?.device_id);
      return account?.status === 'active' && device?.status === 'active' && approvals.some(grant =>
        (mode === 'assist' || grant.mode === 'auto') && grant.workspace === ctx.workspaceId && grant.binding === bindingId &&
        grant.device === device.id && grant.version === device.client_version && grant.identity === account.external_account_id &&
        grant.provider === account.provider && grant.channel === binding?.connector_channel && grant.mobile === (binding?.mobile_device_id ?? undefined));
    },
  } satisfies Pick<ConnectorServices, 'connectorConfigured' | 'terms'>;
}

/**
 * The Worker job engine's host wiring (§5.13, §6.6, §8.11, §8.18): test timing, release and selector directories, and the
 * media storage used for signed downloads and evidence. Values not given keep the previous configuration.
 */
export type WorkerHostConfig = WorkerHostOptions;

export function createPublishHost(account: AccountServices, media?: PublishMedia & { storage?: Storage },
  policy = publishDevicePolicy(process.env.SMARTSELL_CONNECTOR_APPROVALS, process.env.SMARTSELL_CONNECTOR_TERMS), worker: WorkerHostConfig = {}) {
  const services = { ...account, ...policy };
  configureWorkerHost({ ...worker, ...(media?.storage && !worker.storage && { storage: media.storage }) });
  void refreshHostCaches(true);
  return {
    policy,
    bindOperation(op: Registered): Registered {
      if (op.module !== 'execution') return op;
      return { ...op, run(ctx, input) {
        return op.run(Object.assign(ctx, { postMaintenanceServices: account }), input);
      } };
    },
    schedules(items: Schedule[]) { return items.filter(item => item.id !== 'execution.due'); },
    mount(app: FastifyInstance, store: BackgroundStore, egress?: CustomerEgress) { mountPublishDevice(app, store, services, egress, { storage: media?.storage ?? worker.storage }); },
    drain: (async transact => {
      // §5.13: the Worker job lifecycle (missed, unreported, outcome_unknown, successors) in its own short transaction.
      await refreshHostCaches();
      await runWorkerLifecycle(transact);
      await runPostMaintenance(transact, account);
      const youtube = media && youtubePublishing(transact, account, media);
      await publishDrain(publishConnector(services), youtube ? [youtube] : [])(transact);
    }) satisfies BackgroundDrain,
  };
}
