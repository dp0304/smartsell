import { sendReportExport } from './modules/analytics/report-export.js';
import { workspaceStream } from './stream.js';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { workspaceMemberInvite } from './modules/team/index.js';
import { Problem, READ, workspaceOpenApiFile, type Input } from '@smartsell/contracts';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Config } from './config.js';
import { denied, invalid, originGuard } from './identity.js';
import { operationRecords, operationRevision } from './integration/operation-records.js';
import { sharedBusinessCommand, sharedBusinessOperation, sharedBusinessVersion } from './integration/shared-business.js';
import { compatibleMediaPolicies, createMediaHost, mountCompatibleMedia } from './integration/media-host.js';
import { metadata, restInput, runScopedOperation, type Registered } from './operations.js';
import { bindTeamOperation, releaseOperationMember, workspaceServices, workspaceTeamWork } from './integration/workspace-services.js';
import { releaseMemberOccupancy } from './modules/inbox/index.js';
import type { CustomerEgress } from './integration/customer-egress.js';
import type { Unit } from './store.js';
import type { registerCommandMcp } from './integration/command-mcp.js';
import { brandOperationAllowed, validateBrandScopes } from './integration/brand-access.js';
import { workspaceOpenApi, workspaceOpenApiRoute } from './workspace-openapi.js';

interface Options {
  config: Config;
  operations: Registered[];
  egress?: CustomerEgress;
  media?: ReturnType<typeof createMediaHost>;
  workspace<T>(request: FastifyRequest, wid: string, run: (unit: Unit) => Promise<T>): Promise<T>;
  csrf(request: FastifyRequest): void;
  patRead?: ReturnType<typeof registerCommandMcp>;
}

export interface ExecuteMeta { requestId: string; source: 'rest' | 'mcp'; grantId?: string; credentialLabel?: string }
export type OperationExecutor = (unit: Unit, op: Registered, input: Input, meta: ExecuteMeta) =>
  Promise<{ body: { data: unknown; next_cursor?: string | null }; etag?: string; status: number }>;

const prefix = '/api/v1/workspaces/:ws';
const reserved = new Set(['agent-connections', 'catalog', 'commands', 'records', 'stream', 'tokens', workspaceOpenApiFile]);
const methods = new Set(['GET', 'POST', 'PATCH', 'PUT', 'DELETE']);

function problem(reply: FastifyReply, req: FastifyRequest, error: unknown) {
  if (!(error instanceof Problem)) throw error;
  return reply.code(error.status).type('application/problem+json').send({
    type: 'about:blank', title: error.code, status: error.status, code: error.code, detail: error.message,
    details: error.details, request_id: req.id, error: { code: error.code, message: error.message },
  });
}

/** Mount Operations beside Commands on the Command session and workspace transaction. */
export function registerOperationRoutes(app: FastifyInstance, { config, operations, workspace, csrf, patRead, egress, media = createMediaHost(config) }: Options) {
  if (!config.roles.has('api')) return;
  operations = [...operations, ...media.operations].map(sharedBusinessOperation);
  workspaceStream(app, config, (req, wid) => workspace(req, wid, unit => operationRevision(unit.context)));
  const enrich = workspaceServices(operations, egress, !config.production);
  const invitationToken = (id: string) => createHmac('sha256', config.secret).update(`workspace-member-invite:${id}`).digest('base64url');
  const names = new Set<string>();
  const routes = new Set<string>();
  for (const op of operations) {
    const route = `${op.method} ${op.path.replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':param').replace(/\/$/, '')}`;
    const segments = op.path.split('/').filter(Boolean);
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(op.name) || typeof op.run !== 'function' || !methods.has(op.method) ||
      !/^\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*)(?:\/(?:[A-Za-z0-9_-]+|:[A-Za-z_][A-Za-z0-9_]*))*$|^\/$/.test(op.path) ||
      !op.roles.length || op.roles.some(role => !READ.includes(role)) ||
      segments[0]?.startsWith(':') || reserved.has(segments[0]) || segments.includes(':ws')) {
      throw new Error(`Invalid or reserved workspace operation ${op.module}.${op.name} (${route})`);
    }
    if (routes.has(route) || names.has(op.name)) throw new Error(`Duplicate workspace operation ${op.module}.${op.name} (${route})`);
    routes.add(route);
    names.add(op.name);
  }

  mountCompatibleMedia(app, config, media, (req, wid, run) => workspace(req, wid, unit => {
    if (unit.brandScopes?.length) throw denied();
    return run(unit);
  }), csrf);
  // Tenant administration requires an Operation identity transaction. A workspace role alone is insufficient.
  const mounted = operations.flatMap(op => {
    if (op.module === 'inbox' && op.name === 'inbox_send_reply') {
      return [{ ...op, summary: 'Stage an approved reply for manual delivery', run(ctx, input) {
        if (input.body.mode !== undefined && input.body.mode !== 'manual') {
          throw new Problem(422, 'CAPABILITY_UNAVAILABLE', 'This server supports manual reply delivery only');
        }
        return op.run(ctx, input);
      } } satisfies Registered];
    }
    const localEspWrite = !config.production && Boolean(process.env.SMARTSELL_LOCAL_ESP_ORIGIN) && op.module === 'lifecycle' &&
      ['lifecycle_submit_local_esp', 'lifecycle_cancel_local_esp'].includes(op.name);
    return (!op.external || op.module === 'agent' || localEspWrite) && !(op.module === 'ops' && op.mcp !== true) ? [op] : [];
  });
  const visible = (op: Registered, { context, brandScopes }: Unit) =>
    op.roles.includes(context.role) && brandOperationAllowed(brandScopes, op.name, op.method);
  const entries = mounted.map(op => ({ op, command: sharedBusinessCommand(op) }));
  app.get<{ Params: { ws: string } }>(`${prefix}/catalog`, async (req, reply) => {
    try {
      originGuard(req, config);
      return await workspace(req, req.params.ws, async unit => ({
        data: entries.filter(({ op }) => visible(op, unit)).map(({ op, command }) => ({
          ...metadata(op),
          ...(command && { compatibility_command: {
            action: command.action, fields: command.fields, requires_version: command.requires_version,
          } }),
        })),
      }));
    } catch (error) { return problem(reply, req, error); }
  });

  app.get<{ Params: { ws: string } }>(workspaceOpenApiRoute, async (req, reply) => {
    try {
      originGuard(req, config);
      return await workspace(req, req.params.ws, async unit => workspaceOpenApi({ config, surface: 'commands',
        operations: mounted.filter(op => visible(op, unit)),
        aliases: entries.filter(({ op, command }) => command && visible(op, unit)).flatMap(({ op, command }) => command ? [{ op, command }] : []),
      }));
    } catch (error) { return problem(reply, req, error); }
  });

  /** The single write path for REST and MCP: binding, Operation records, scoped run, flush, Command audit. */
  async function execute(unit: Unit, op: Registered, input: Input, meta: ExecuteMeta) {
    const { context } = unit;
    if (!visible(op, unit)) throw denied();
    const readOnly = op.method === 'GET';
    let operation = op;
    if (op.name === 'team_members_list' && unit.listMembers) {
      operation = { ...op, run: async () => (await unit.listMembers!()).map(member => ({ ...member, id: member.user_id, scopes: member.scopes ?? [] })) };
    } else if (op.name === 'team_member_invite' && unit.inviteMember) {
      operation = { ...op, async run(ctx, { body }) {
        const { email, role, scopes } = workspaceMemberInvite(ctx, body);
        if (scopes.length) throw invalid('Resource-scoped grants are unavailable');
        if (role !== 'admin' && role !== 'editor' && role !== 'reviewer' && role !== 'viewer') throw denied();
        const id = randomUUID();
        const tokenHash = createHash('sha256').update(invitationToken(id)).digest('hex');
        await unit.inviteMember!({ id, email, role, tokenHash });
        ctx.emit('team.member.invited', { invitation_id: id, role });
        return { invitation_id: id };
      } };
    } else if (['team_member_roles_update', 'team_member_remove'].includes(op.name) && unit.listMembers && unit.changeMembership) {
      const members = (await unit.listMembers()).map(member => ({ ...member, id: member.user_id, scopes: member.scopes ?? [] }));
      operation = bindTeamOperation(op, {
        work: workspaceTeamWork,
        members: {
          list: () => members,
          invite: () => { throw invalid('Use the invitation endpoint'); },
          async setRole(ctx, member, role, scopes) {
            if (role !== 'admin' && role !== 'editor' && role !== 'reviewer' && role !== 'viewer') throw denied();
            const brandScopes = validateBrandScopes(ctx, role, scopes);
            await unit.changeMembership!({ memberId: member.user_id, action: 'set_role', role, scopes: brandScopes });
          },
          previewRemoval: (ctx, member) => workspaceTeamWork.forHandover(ctx, member.user_id),
          async remove(ctx, member) {
            await unit.changeMembership!({ memberId: member.user_id, action: 'remove' });
            releaseOperationMember(ctx, member.user_id);
            await releaseMemberOccupancy(context, member.user_id);
            await context.emit('team.member.removed', { member_id: member.user_id });
          },
        },
      });
    } else if (op.name === 'team_handover_accept' && unit.listMembers) {
      operation = bindTeamOperation(op, { work: workspaceTeamWork });
    }
    const run = async () => {
      const { records, flush } = await operationRecords(context, readOnly);
      const policies = op.module === 'files' && ['file_delete', 'file_retention_preview', 'file_retention_purge'].includes(op.name)
        ? await compatibleMediaPolicies(context) : undefined;
      const outcome = await runScopedOperation(records, context, { actorId: context.actorId, grantId: meta.grantId, credentialLabel: meta.credentialLabel },
        context.role, meta.requestId, media.bind(operation, policies), input, meta.source, config, enrich, undefined, unit.brandScopes);
      if (!readOnly) await flush();
      return outcome;
    };
    // The operation runner owns caller idempotency. Command reserves an internal audit ID for this transaction.
    const outcome = readOnly ? await run()
      : await unit.command({ module: op.module, action: op.name, key: `operation/${randomUUID()}`, fingerprint: '' }, run) as Awaited<ReturnType<typeof run>>;
    return { ...outcome, etag: outcome.etag ?? sharedBusinessVersion(op, outcome.body.data) };
  }

  const commands = [];
  for (const { op, command } of entries) {
    function handler(alias?: typeof command) {
      return async (req: FastifyRequest<{ Params: { ws: string } }>, reply: FastifyReply) => {
        try {
          originGuard(req, config);
          const readOnly = op.method === 'GET';
          const fromPat = !alias && (readOnly || op.name === 'worker_catalog_request_import') && req.headers.authorization
            ? await patRead?.(req, req.params.ws, op.name) : undefined;
          const result = fromPat ?? await workspace(req, req.params.ws, async unit => {
            if (!visible(op, unit)) throw denied();
            if (!readOnly) {
              csrf(req);
              if (req.body !== undefined && req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
                throw invalid('Expected application/json');
              }
            }
            return execute(unit, op, alias ? alias.input(req) : restInput(req), { requestId: req.id, source: 'rest' });
          });
          const data = result.body.data;
          if (op.name === 'report_export_download') return sendReportExport(reply, data);
          const etag = result.etag ?? sharedBusinessVersion(op, data);
          if (etag) reply.header('etag', etag);
          if (op.name === 'team_member_invite' && data && typeof data === 'object' &&
            'invitation_id' in data && typeof data.invitation_id === 'string') {
            // Keep the credential out of the stored idempotency response and audit records.
            return reply.code(result.status).send({ data: { ...data, invitation_token: invitationToken(data.invitation_id) } });
          }
          // Compatibility commands keep their existing nested page envelope.
          const body = alias && op.listForRest ? { data: result.body } : result.body;
          return reply.code(result.status).send(body);
        } catch (error) { return problem(reply, req, error); }
      };
    }
    app.route({ method: op.method, url: `${prefix}${op.path === '/' ? '' : op.path}`, exposeHeadRoute: false, handler: handler() });
    if (command) {
      app.post(`${prefix}/commands/${command.module}/${command.action}`, handler(command));
      commands.push(command);
    }
  }
  return { commands, mounted, execute };
}
