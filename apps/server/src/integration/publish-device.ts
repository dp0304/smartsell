import type { FastifyInstance } from 'fastify';
import { Problem, type Context } from '@smartsell/contracts';
import { makeContext } from '../context.js';
import type { BackgroundStore } from '../runtime.js';
import { mountAccountIngress } from '../modules/account/http.js';
import type { ConnectorServices } from '../modules/account/connector-service.js';
import { authorizeConnectorAttempt } from '../modules/execution/connector.js';
import { workspaceServices } from './workspace-services.js';
import type { CustomerEgress } from './customer-egress.js';
import type { WorkerDeviceFiles } from '../modules/worker/device-http.js';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

export function mountPublishDevice(app: FastifyInstance, store: BackgroundStore, services: Omit<ConnectorServices, 'authorizeTask'>, egress?: CustomerEgress,
  files: WorkerDeviceFiles = {}) {
  const enrich = workspaceServices([], egress);
  const workspace = async (hint?: string) => hint && uuid.test(hint) ? (await store.workspaces()).find(row => row.id === hint) : undefined;
  const route = async (_id: string, hint?: string) => (await workspace(hint))?.id;
  mountAccountIngress(app, {
    account: services,
    connector: { ...services, authorizeTask: authorizeConnectorAttempt },
    pairingWorkspace: route,
    deviceWorkspace: route,
    // S5: a read-only one-row lookup for the signature check that runs before the locked transaction.
    async deviceKey(id: string, deviceId: string) {
      const ws = await workspace(id);
      if (!ws || !store.peek || !uuid.test(deviceId)) return ws && store.peek ? { device: undefined } : undefined;
      return store.peek(ws, async get => ({ device: await get('connector_device', deviceId) }));
    },
    oauthWorkspace: async () => undefined,
    webhookWorkspace: async () => undefined,
    async transaction<T>(id: string, run: (ctx: Context) => T | Promise<T>) {
      const ws = await workspace(id);
      if (!ws) throw new Problem(401, 'DEVICE_NOT_AUTHORIZED', 'Device workspace unavailable');
      return store.transact(ws, false, (records, scope, identity) => run(enrich(makeContext(records, scope, 'owner'), identity)));
    },
  }, { deviceOnly: true, files });
}
