import { once, EventEmitter } from 'node:events';
import type { Store } from '@smartsell/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { header, invalid, membership, originGuard, type Auth } from './identity.js';
import type { Config } from './config.js';

export function streamRoutes(app: FastifyInstance, store: Store, auth: Auth, config: Config) {
  workspaceStream(app, config, (req, wsId) => store.transaction({ readOnly: true }, async tx => {
    const principal = auth.authenticate(tx.identity, req);
    const ws = membership(tx.identity, principal, wsId);
    const scoped = await tx.workspace({ workspaceId: ws.id, tenantId: ws.tenantId, actorId: principal.user.id });
    return scoped.get<number>('stream/revision') ?? 0;
  }), store.subscribe?.bind(store));
}

export function workspaceStream(app: FastifyInstance, config: Config,
  readRevision: (request: FastifyRequest, workspaceId: string) => Promise<number>, subscribe?: Store['subscribe']) {
  const clients = new Set<AbortController>();
  app.addHook('preClose', async () => { for (const client of clients) client.abort(); });
  app.get<{ Params: { ws: string } }>('/api/v1/workspaces/:ws/stream', async (req, reply) => {
    originGuard(req, config);
    const wsId = req.params.ws;
    const lastId = header(req, 'last-event-id');
    if (lastId !== undefined && (!/^\d+$/.test(lastId) || !Number.isSafeInteger(Number(lastId)))) throw invalid('Invalid Last-Event-ID');
    const revision = () => readRevision(req, wsId);
    let current = await revision();
    let previous = lastId === undefined ? current : Math.min(current, Number(lastId));
    const stop = new AbortController();
    clients.add(stop);
    const wake = new EventEmitter();
    const unsubscribe = subscribe?.(workspaceId => {
      if (workspaceId === wsId) wake.emit('changed');
    });
    reply.hijack();
    reply.raw.on('close', () => stop.abort());
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no', 'x-request-id': req.id,
    });
    const baseline = lastId === undefined ? `id: ${current}\n` : '';
    reply.raw.write(`: connected\nretry: 2000\n${baseline}\n`);
    let lastHeartbeat = Date.now();
    try {
      while (!stop.signal.aborted) {
        if (current > previous) {
          if (!reply.raw.write(`id: ${current}\nevent: workspace.changed\ndata: {"type":"workspace.changed"}\n\n`)) break;
          previous = current;
          lastHeartbeat = Date.now();
        } else if (Date.now() - lastHeartbeat >= 15000) {
          if (!reply.raw.write(': heartbeat\n\n')) break;
          lastHeartbeat = Date.now();
        }
        const poll = AbortSignal.timeout(1000);
        try {
          await once(wake, 'changed', { signal: AbortSignal.any([stop.signal, poll]) });
        } catch (error) {
          if (!poll.aborted || stop.signal.aborted) throw error;
        }
        if (!stop.signal.aborted) current = await revision();
      }
    } catch (error) {
      if (!stop.signal.aborted) req.log.debug({ err: error }, 'Workspace stream closed');
    } finally {
      unsubscribe?.();
      clients.delete(stop);
      reply.raw.end();
    }
  });
}
