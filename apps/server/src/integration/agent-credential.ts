import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { READ, WRITE, Problem, type Context } from '@smartsell/contracts';
import type { FastifyRequest } from 'fastify';
import { makeContext } from '../context.js';
import { DomainError, type Entity } from '../modules/types.js';
import type { Registered } from '../operations.js';
import { unauthenticated, type Store, type Unit } from '../store.js';
import type { SealedCredential } from './agent-connections.js';
import { scopedBrandContext } from './brand-access.js';
import { operationRecords } from './operation-records.js';
import { workspaceServices } from './workspace-services.js';

/**
 * C4 (phase1-design §11.2, §6.4): the Agent credential behind `Authorization: Bearer ss_command_…`, extracted from
 * command-mcp.ts so the upload routes (S5) and the owner alert stream (S10) authenticate exactly like /mcp.
 */

export interface AgentPrincipal {
  credentialId: string; actorId: string; workspaceId: string; label?: string;
  /** Runs fn inside one workspace transaction with the role checked. fn must not wait or do IO (§0 rule 8). */
  run<T>(write: boolean, fn: (ctx: Context) => T | Promise<T>): Promise<T>;
}
export interface AgentCredentialService { authenticate(req: FastifyRequest): Promise<AgentPrincipal | undefined> }

export type ToolProfile = 'hub_v1' | 'legacy';
/** §7.4: connections created from phase 1 on carry tool_profile 'hub_v1'; a connection without the field is legacy. */
export const toolProfile = (row: Pick<Entity, 'data'> | undefined): ToolProfile => row?.data.tool_profile === 'hub_v1' ? 'hub_v1' : 'legacy';

const tokenPattern = /^ss_command_[A-Za-z0-9_-]{60,500}$/;

/** Seals and opens `ss_command_` tokens (AES-256-GCM under a key derived from the hub secret). */
export function agentTokenCodec(secret: string) {
  const key = createHmac('sha256', secret).update('smartsell:command-mcp:v1').digest();
  return {
    key,
    seal(credential: SealedCredential) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const bytes = Buffer.concat([cipher.update(JSON.stringify(credential)), cipher.final()]);
      return `ss_command_${Buffer.concat([nonce, cipher.getAuthTag(), bytes]).toString('base64url')}`;
    },
    open(token: string): SealedCredential | undefined {
      if (!tokenPattern.test(token)) return;
      try {
        const data = Buffer.from(token.slice('ss_command_'.length), 'base64url');
        const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
        cipher.setAuthTag(data.subarray(12, 28));
        const value = JSON.parse(Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString());
        return typeof value?.id === 'string' && typeof value?.workspaceId === 'string' && typeof value?.sessionHash === 'string' ? value : undefined;
      } catch { return undefined; }
    },
    bearer(req: Pick<FastifyRequest, 'headers'>) {
      const token = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1] ?? '';
      return this.open(token.trim());
    },
  };
}
export type AgentTokenCodec = ReturnType<typeof agentTokenCodec>;

/** The stored credential row, or 401: wrong actor, revoked or expired (the same rule /mcp applies). */
export async function credentialRow(unit: Unit, credential: SealedCredential): Promise<Entity> {
  const row = await unit.context.get('mcp_runtime', 'credential', credential.id);
  if (!row || row.data.actor_id !== unit.context.actorId || row.data.revoked === true || !(row.data.expires > Date.now())) throw unauthenticated();
  return row;
}

interface Options {
  store: Store;
  codec: AgentTokenCodec;
  operations?: readonly Registered[];
  /** Accept only agent connections (default). Legacy /tokens grants are scoped to their issued tool list. */
  connectionsOnly?: boolean;
}

export function createAgentCredentials({ store, codec, operations = [], connectionsOnly = true }: Options): AgentCredentialService {
  const enrich = workspaceServices(operations);
  return {
    async authenticate(req) {
      const credential = codec.bearer(req);
      if (!credential) return undefined;
      let label: string | undefined;
      let actorId: string;
      try {
        actorId = await store.workspace(credential.sessionHash, credential.workspaceId, async unit => {
          const row = await credentialRow(unit, credential);
          if (connectionsOnly && row.data.kind !== 'agent_connection') throw unauthenticated();
          if (row.data.access === 'read' || !READ.includes(unit.context.role)) throw unauthenticated();
          if (typeof row.data.label === 'string') label = row.data.label;
          return unit.context.actorId;
        }, credential.id);
      } catch (error) {
        if (error instanceof DomainError && error.status < 500) return undefined;
        throw error;
      }
      return {
        credentialId: credential.id, actorId, workspaceId: credential.workspaceId, ...(label && { label }),
        run: <T>(write: boolean, fn: (ctx: Context) => T | Promise<T>) => store.workspace(credential.sessionHash, credential.workspaceId, async unit => {
          // Re-check on every run: a connection revoked after authenticate() must stop background work too.
          await credentialRow(unit, credential);
          if (unit.context.actorId !== actorId) throw unauthenticated();
          if (write && !WRITE.includes(unit.context.role)) throw new Problem(403, 'PERMISSION_DENIED', 'This connection cannot write in this workspace');
          const execute = async () => {
            const { records, flush } = await operationRecords(unit.context, !write);
            let ctx: Context = enrich(makeContext(records, unit.context, unit.context.role, randomUUID()), undefined, credential.id);
            if (unit.brandScopes?.length) ctx = scopedBrandContext(ctx, unit.brandScopes);
            const result = await fn(ctx);
            if (write) {
              records.put('stream/revision', (records.get<number>('stream/revision') ?? 0) + 1);
              await flush();
            }
            return result;
          };
          // Writes need an active command in the memory and local stores (as every Operation host does).
          return write
            ? await unit.command({ module: 'agent', action: 'agent_credential_run', key: `internal/${randomUUID()}`, fingerprint: '' }, execute) as Awaited<T>
            : await execute();
        }, credential.id) as Promise<T>,
      };
    },
  };
}
