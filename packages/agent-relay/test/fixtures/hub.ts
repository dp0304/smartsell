// Test hub for S5: the real agent upload routes on Fastify, a real store (memory or SQLite-backed local store),
// the real root guard from auth.ts, and an in-test credential service standing in for S4's agent-credential.ts (C4).
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import type { Context, Row } from '../../../contracts/src/index.ts';
import { auth } from '../../../../apps/server/src/auth.ts';
import { configuration } from '../../../../apps/server/src/config.ts';
import { makeContext } from '../../../../apps/server/src/context.ts';
import { localStore } from '../../../../apps/server/src/local.ts';
import { MemoryStore } from '../../../../apps/server/src/memory.ts';
import { DomainError } from '../../../../apps/server/src/modules/types.ts';
import { operationRecords } from '../../../../apps/server/src/integration/operation-records.ts';
import { registerAgentUploads, type UploadPrincipal } from '../../../../apps/server/src/integration/agent-uploads.ts';
import type { PrepareOptions } from '../../../../apps/server/src/extensions/media-files.ts';
import { localStorage, type Storage } from '../../../media-store/src/index.ts';

type App = Parameters<typeof registerAgentUploads>[0];
const Fastify = createRequire(new URL('../../../../apps/server/package.json', import.meta.url))('fastify') as (options?: object) => App;

export interface HubOptions {
  store?: 'memory' | 'local';
  maxUploadBytes?: number;
  prepare?: PrepareOptions;
  /** Wrap the media storage (for example to slow writes down). */
  storage?: (storage: Storage) => Storage;
  /** Delay every part PUT by this many ms before the handler runs (a slow link). */
  partDelayMs?: number;
  relayBundlePath?: string;
}

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

export async function startHub(t: TestContext, options: HubOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'smartsell-s5-hub-'));
  const mediaDirectory = join(root, 'media');
  const store = options.store === 'local' ? localStore(join(root, 'state', 'hub.sqlite')) : new MemoryStore();
  const session = randomBytes(32).toString('hex');
  await store.setup({ email: 'owner@example.test', name: 'Owner', passwordHash: 'unused', workspaceName: 'S5' }, session);
  const user = (await store.session(session))!;
  const workspaceId = user.workspaces[0].id;
  const actorId = user.user.id;
  const token = `ss_command_${randomBytes(48).toString('base64url')}`;
  const transactions = { count: 0 };
  const principal: UploadPrincipal = {
    credentialId: 'credential-s5', actorId, workspaceId, label: 'Test relay',
    run: (write, fn) => store.workspace(session, workspaceId, async unit => {
      transactions.count++;
      const execute = async () => {
        const { records, flush } = await operationRecords(unit.context, !write);
        const ctx = makeContext(records, unit.context, unit.context.role);
        const result = await fn(ctx);
        if (write) await flush();
        return result;
      };
      // Writes go through a store command, as every Operation host does (media-host.ts, command-mcp.ts).
      return write ? await unit.command({ module: 'files', action: 'agent_upload', key: `internal/${randomUUID()}`, fingerprint: '' }, execute) as Awaited<ReturnType<typeof fn>> : execute();
    }),
  };
  const storage = (options.storage ?? (value => value))(localStorage(mediaDirectory));
  const config = configuration({ NODE_ENV: 'test', MEDIA_DIRECTORY: mediaDirectory, SMARTSELL_DATA_FILE: join(root, 'state', 'hub.sqlite') });
  const app = Fastify({ bodyLimit: 1024 * 1024, disableRequestLogging: true });
  // The real root guard (auth.ts): POST must be JSON; PUT octet-stream must pass (§2.4 item 7).
  const sessions = auth(store, config);
  const puts: { n: number; length: number }[] = [];
  app.addHook('onRequest', async request => {
    sessions.guard(request, true);
    const match = request.method === 'PUT' && /\/parts\/(\d+)$/.exec(request.url);
    if (match) {
      puts.push({ n: Number(match[1]), length: Number(request.headers['content-length']) });
      if (options.partDelayMs) await new Promise(resolve => setTimeout(resolve, options.partDelayMs));
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    return reply.code(500).send({ error: { code: 'internal_error', message: String(error) } });
  });
  const uploads = registerAgentUploads(app, {
    credentials: { async authenticate(request) { return request.headers.authorization === `Bearer ${token}` ? principal : undefined; } },
    media: { storage }, config: { mediaDirectory, maxUploadBytes: options.maxUploadBytes ?? config.maxUploadBytes },
    prepare: options.prepare, relayBundlePath: options.relayBundlePath,
    log: { error: (object, message) => { if (process.env.S5_DEBUG) console.error(message, object); } },
  });
  const origin = await app.listen({ host: '127.0.0.1', port: 0 });
  t.after(async () => {
    await uploads.idle();
    await app.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const tokenFile = join(root, 'token');
  await writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  /** Read rows in one short transaction. */
  const rows = (kind: string) => principal.run(false, ctx => ctx.list(kind) as Row[]);
  /** Owner alerts written by S10's helpers (owner_alert rows), oldest first. */
  const alerts = async () => (await rows('owner_alert')).sort((a, b) => Number(a.seq) - Number(b.seq));
  /** Domain events written to the workspace outbox, oldest first. */
  const events = () => store.workspace(session, workspaceId, async unit => {
    const { records } = await operationRecords(unit.context, true);
    return records.list<{ type: string; payload: Record<string, unknown>; occurred_at: string }>('outbox/')
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));
  });
  const write = <T>(fn: (ctx: Context) => T) => principal.run(true, fn);
  async function api(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(origin + path, { method, headers: { authorization: `Bearer ${token}`,
      ...(body !== undefined && !(body instanceof Uint8Array) && { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : body instanceof Uint8Array ? body as unknown as BodyInit : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, headers: response.headers, body: text ? JSON.parse(text) : undefined };
  }
  return { root, origin, token, tokenFile, principal, store, mediaDirectory, storage, uploads, alerts, puts, transactions, rows, events, write, api };
}
export type Hub = Awaited<ReturnType<typeof startHub>>;

/** A small valid-looking mp4: ftyp + an mdat of `size` bytes (deterministic filler). */
export function fakeMp4(size: number, seed = 1) {
  const bytes = Buffer.alloc(size);
  bytes.write('\x00\x00\x00\x18ftypisom\x00\x00\x02\x00isomiso2', 0, 'latin1');
  bytes.writeUInt32BE(size - 24, 24);
  bytes.write('mdat', 28, 'latin1');
  let state = seed >>> 0 || 1;
  for (let index = 32; index + 4 <= size; index += 4) {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    bytes.writeUInt32LE(state >>> 0, index);
  }
  return bytes;
}
