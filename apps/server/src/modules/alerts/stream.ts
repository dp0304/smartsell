import { once, EventEmitter } from 'node:events';
import type { Context } from '@smartsell/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { alertRows, latestAlertSeq, toOwnerAlert } from './raise.js';

export const ALERT_STREAM_PATH = '/api/v1/agent/alerts/stream';

/**
 * Structural copy of C4 (`integration/agent-credential.ts`, S4): an authenticated agent connection.
 * `run(false, …)` opens a read-only workspace transaction; nothing may wait or do IO inside it.
 */
export interface AlertStreamPrincipal {
  credentialId: string; actorId: string; workspaceId: string; label?: string;
  run<T>(write: boolean, fn: (ctx: Context) => T | Promise<T>): Promise<T>;
}
export interface AlertStreamCredentials { authenticate(req: FastifyRequest): Promise<AlertStreamPrincipal | undefined> }
export interface AlertStreamDeps {
  credentials: AlertStreamCredentials;
  /** Optional store wake-up (Store.subscribe) so new alerts go out without waiting for the next poll. */
  subscribe?: (wake: (workspaceId: string) => void) => () => void;
  pollMs?: number; heartbeatMs?: number; reauthMs?: number; replayLimit?: number;
}

const QUERY_KEYS = new Set(['last_event_id', 'machine_id']);

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  if (status === 401) reply.header('www-authenticate', 'Bearer');
  return reply.code(status).send({ error: { code, message } });
}

/**
 * GET /api/v1/agent/alerts/stream (Appendix B.1): read-only SSE feed of owner alerts for the laptop App and other
 * agent-token clients. Each event is `id: <seq>`, `event: owner_alert`, `data: OwnerAlert`. `Last-Event-ID` (or
 * `?last_event_id=` for clients that cannot set headers) resumes after that seq; without it the stream starts at the
 * newest alert, so a fresh subscriber does not replay history as OS notifications.
 */
export function registerAgentAlertStream(app: FastifyInstance, deps: AlertStreamDeps): void {
  const clients = new Set<AbortController>();
  const pollMs = deps.pollMs ?? 1000;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;
  const reauthMs = deps.reauthMs ?? 60_000;
  const replayLimit = deps.replayLimit ?? 200;
  app.addHook('preClose', async () => { for (const client of clients) client.abort(); });
  app.get(ALERT_STREAM_PATH, async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    const unknown = Object.keys(query).find(key => !QUERY_KEYS.has(key));
    if (unknown) return fail(reply, 422, 'INVALID_ARGUMENTS', `Unknown query parameter ${unknown}. Allowed: last_event_id, machine_id`);
    const header = req.headers['last-event-id'];
    const lastId = (Array.isArray(header) ? header[0] : header) ?? (typeof query.last_event_id === 'string' ? query.last_event_id : undefined);
    if (lastId !== undefined && !/^\d{1,15}$/.test(lastId)) return fail(reply, 422, 'INVALID_ARGUMENTS', 'Last-Event-ID must be a non-negative integer');
    const machineId = typeof query.machine_id === 'string' && query.machine_id ? query.machine_id : undefined;
    if (query.machine_id !== undefined && !machineId) return fail(reply, 422, 'INVALID_ARGUMENTS', 'machine_id must be a non-empty string');

    let principal: AlertStreamPrincipal | undefined;
    try { principal = await deps.credentials.authenticate(req); } catch (error) {
      const status = (error as { status?: number }).status;
      if (typeof status === 'number' && status >= 400 && status < 500) return fail(reply, status === 403 ? 403 : 401, status === 403 ? 'FORBIDDEN' : 'UNAUTHENTICATED', 'The agent connection is not allowed to read alerts');
      throw error;
    }
    if (!principal) return fail(reply, 401, 'UNAUTHENTICATED', 'Send Authorization: Bearer <agent connection token>');
    const reader = principal;
    const read = (after: number) => reader.run(false, ctx => alertRows(ctx, { after_seq: after, machine_id: machineId }).slice(0, replayLimit)
      .map(row => ({ seq: Number(row.seq), alert: toOwnerAlert(row) })));
    const initial = await reader.run(false, ctx => latestAlertSeq(ctx));
    let cursor = lastId === undefined ? initial : Math.min(Number(lastId), initial);

    const stop = new AbortController();
    clients.add(stop);
    const wake = new EventEmitter();
    const unsubscribe = deps.subscribe?.(workspaceId => { if (workspaceId === reader.workspaceId) wake.emit('changed'); });
    reply.hijack();
    reply.raw.on('close', () => stop.abort());
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', 'x-request-id': req.id,
      // One long-lived response per connection: closing it with the stream lets the hub shut down without waiting on keep-alive.
      connection: 'close',
    });
    reply.raw.write(`: connected\nretry: 2000\n${lastId === undefined ? `id: ${cursor}\n` : ''}\n`);
    let lastWrite = Date.now();
    let lastAuth = Date.now();
    try {
      while (!stop.signal.aborted) {
        const events = await read(cursor);
        for (const { seq, alert } of events) {
          if (!reply.raw.write(`id: ${seq}\nevent: owner_alert\ndata: ${JSON.stringify(alert)}\n\n`)) await once(reply.raw, 'drain', { signal: stop.signal });
          cursor = seq;
          lastWrite = Date.now();
        }
        if (Date.now() - lastWrite >= heartbeatMs) {
          reply.raw.write(': heartbeat\n\n');
          lastWrite = Date.now();
        }
        if (Date.now() - lastAuth >= reauthMs) {
          // A revoked or expired connection loses the stream within one re-check interval.
          if (!await deps.credentials.authenticate(req).catch(() => undefined)) break;
          lastAuth = Date.now();
        }
        if (events.length >= replayLimit) continue;
        const now = Date.now();
        const poll = AbortSignal.timeout(Math.max(10, Math.min(pollMs, heartbeatMs - (now - lastWrite), reauthMs - (now - lastAuth))));
        try { await once(wake, 'changed', { signal: AbortSignal.any([stop.signal, poll]) }); } catch (error) {
          if (!poll.aborted || stop.signal.aborted) throw error;
        }
      }
    } catch (error) {
      if (!stop.signal.aborted) req.log.debug({ err: error }, 'Alert stream closed');
    } finally {
      unsubscribe?.();
      clients.delete(stop);
      reply.raw.end();
    }
  });
}
