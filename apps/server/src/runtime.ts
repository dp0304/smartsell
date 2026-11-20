import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Records, Scope, Store } from '@smartsell/db';
import type { Context } from '@smartsell/contracts';
import type { Workspace } from './identity.js';
import type { Config } from './config.js';
import { makeContext, type DomainEvent } from './context.js';
import type { CustomerEgress } from './integration/customer-egress.js';
import { workspaceServices } from './integration/workspace-services.js';
import { recordHeartbeat } from './modules/ops/deployment.js';
import type { Registered, Schedule, Subscriber } from './operations.js';

const systemPrincipal = '00000000-0000-0000-0000-000000000001';
interface Job { id: string; subscriber: string; eventId: string; attempts: number; runAt: number; status: 'queued' | 'failed' }

export type WorkspaceTransaction = <T>(run: (ctx: Context) => T | Promise<T>) => Promise<T>;
export type BackgroundDrain = (transact: WorkspaceTransaction) => Promise<void>;
export interface BackgroundStore {
  workspaces(): Promise<Workspace[]>;
  subscribe?: Store['subscribe'];
  transact<T>(ws: Workspace, readOnly: boolean, run: (records: Records, scope: Scope, identity?: Records) => T | Promise<T>): Promise<T>;
}

export function kernelBackgroundStore(store: Store): BackgroundStore {
  return {
    subscribe: store.subscribe?.bind(store),
    workspaces: () => store.transaction({ readOnly: true }, ({ identity }) => identity.list<Workspace>('workspace/')
      .filter(ws => identity.get<{ status: string }>(`tenant/${ws.tenantId}`)?.status === 'active')),
    transact: (ws, readOnly, run) => store.transaction({ readOnly, identityWrite: !readOnly }, async tx => {
      const scope = { workspaceId: ws.id, tenantId: ws.tenantId, actorId: systemPrincipal };
      return run(await tx.workspace(scope), scope, tx.identity);
    }),
  };
}

export function runOperationsHeartbeat(store: Store, config: Config, log: FastifyBaseLogger) {
  const nodeId = randomUUID();
  const roles = [...config.roles];
  const background = kernelBackgroundStore(store);
  const enrich = workspaceServices([]);
  let running: Promise<void> | undefined;
  async function record() {
    const tenants = new Set<string>();
    for (const ws of await background.workspaces()) {
      if (tenants.has(ws.tenantId)) continue;
      await background.transact(ws, false, (records, scope, identity) => {
        recordHeartbeat(enrich(makeContext(records, scope, 'owner'), identity), nodeId, roles, '0.1.0');
      });
      tenants.add(ws.tenantId);
    }
  }
  function tick() {
    running ??= record().catch(() => log.error('Could not persist operations heartbeat')).finally(() => { running = undefined; });
  }
  const timer = setInterval(tick, 15_000).unref();
  tick();
  return async () => { clearInterval(timer); await running; };
}

export function runBackground(store: Store, config: Config, subscribers: Subscriber[], schedules: Schedule[], log: FastifyBaseLogger,
  operations: readonly Registered[] = [], egress?: CustomerEgress, drain?: BackgroundDrain) {
  return runWorkspaceBackground(kernelBackgroundStore(store), config, subscribers, schedules, log, operations, egress, drain);
}

export function runWorkspaceBackground(store: BackgroundStore, config: Config, subscribers: Subscriber[], schedules: Schedule[], log: FastifyBaseLogger,
  operations: readonly Registered[] = [], egress?: CustomerEgress, drain?: BackgroundDrain) {
  const enrich = workspaceServices(operations, egress, !config.production);
  const worker = config.roles.has('worker');
  const scheduler = config.roles.has('scheduler');
  const media = config.roles.has('media');
  if (!worker && !scheduler && !media) return async () => {};
  let running: Promise<void> | undefined;
  let stopped = false;
  const subscribersById = new Map(subscribers.map(subscriber => [subscriber.id, subscriber]));

  async function cycle() {
    const workspaces = await store.workspaces();
    for (const ws of workspaces) {
      if (stopped) return;
      const now = Date.now();
      if (scheduler) {
        for (const schedule of schedules) {
          try {
            await store.transact(ws, false, async (records, scope, identity) => {
              const key = `schedule/${schedule.id}`;
              const interval = schedule.intervalMs ?? 60_000;
              const previous = records.get<number>(key) ?? 0;
              const ctx = makeContext(records, scope, 'owner');
              const scheduledAt = schedule.utcDaily ? Date.parse(ctx.now) : now;
              const due = schedule.utcDaily ? Math.floor(scheduledAt / 86_400_000) > Math.floor(previous / 86_400_000) : now - previous >= interval;
              if (!due) return;
              await schedule.run(enrich(ctx, identity));
              records.put(key, scheduledAt);
            });
          } catch (error) { log.error({ err: error, schedule: schedule.id }, 'Scheduled operation failed'); }
        }
      }
      await store.transact(ws, false, records => {
        for (const event of records.list<DomainEvent>('outbox/').filter(event => !event.dispatched_at).slice(0, 100)) {
          for (const subscriber of subscribers.filter(subscriber => subscriber.accepts(event.type))) {
            const id = `${subscriber.id}/${event.id}`;
            if (!records.get(`job/${id}`) && !records.get(`consumed/${id}`)) {
              records.put(`job/${id}`, { id, eventId: event.id, subscriber: subscriber.id, attempts: 0, runAt: Date.now(), status: 'queued' } satisfies Job);
            }
          }
          records.put(`outbox/${event.id}`, { ...event, dispatched_at: new Date().toISOString() });
        }
      });
      if (!worker && !media) continue;
      const jobs = await store.transact(ws, true, records => records.list<Job>('job/')
        .filter(job => job.status === 'queued' && job.runAt <= Date.now())
        .filter(job => subscribersById.get(job.subscriber)?.queue === 'media' ? media : worker).slice(0, 25));
      for (const job of jobs) {
        if (stopped) return;
        let attempted: Job | undefined;
        try {
          await store.transact(ws, false, async (records, scope, identity) => {
            const current = records.get<Job>(`job/${job.id}`);
            if (current?.status !== 'queued' || current.runAt > Date.now()) return;
            attempted = current;
            const event = records.get<DomainEvent>(`outbox/${job.eventId}`);
            const subscriber = subscribersById.get(job.subscriber);
            if (!records.get(`consumed/${job.id}`)) {
              if (!subscriber || !event) throw new Error('Missing outbox event or subscriber');
              await subscriber.run(enrich(makeContext(records, scope, 'owner', event.trace_id), identity), {
                ...event, data: event.payload, occurredAt: event.occurred_at, actorId: event.actor_id,
              });
              records.put(`consumed/${job.id}`, { consumed_at: new Date().toISOString() });
            }
            records.delete(`job/${job.id}`);
          });
        } catch (error) {
          const failed = attempted;
          const subscriber = subscribersById.get(job.subscriber);
          log.error({ job_id: job.id, ...(subscriber?.sensitive ? {} : { err: error }) }, 'Outbox job failed');
          if (failed) await store.transact(ws, false, async (records, scope, identity) => {
            const key = `job/${job.id}`;
            const current = records.get<Job>(key);
            if (!current || current.attempts !== failed.attempts || current.runAt !== failed.runAt) return;
            const attempts = current.attempts + 1;
            const terminal = attempts >= 5;
            if (terminal && subscriber?.onTerminalFailure) {
              const event = records.get<DomainEvent>(`outbox/${current.eventId}`);
              await subscriber.onTerminalFailure(enrich(makeContext(records, scope, 'owner'), identity), attempts, { type: event?.type, data: event?.payload });
            }
            records.put(key, { ...current, attempts, runAt: Date.now() + 1000 * 2 ** attempts, status: terminal ? 'failed' : 'queued' } satisfies Job);
          });
        }
      }
      if (worker && !stopped && drain) await drain(run => store.transact(ws, false, (records, scope, identity) =>
        run(enrich(makeContext(records, scope, 'owner'), identity))));
    }
  }

  function tick() {
    if (!running && !stopped) running = cycle().catch(error => log.error(error, 'Background cycle failed')).finally(() => { running = undefined; });
  }
  const timer = setInterval(tick, 1000).unref();
  const unsubscribe = store.subscribe?.(tick);
  tick();
  return async () => {
    stopped = true;
    unsubscribe?.();
    clearInterval(timer);
    await running;
  };
}
