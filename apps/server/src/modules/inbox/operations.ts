import { providerCatalog } from '../../../../../packages/adapters/src/provider-catalog.js';
import { serviceOperations } from './service.js';
import { settingsOperations, persistApprovedReplyTask } from './service-settings.js';
import { ADMIN, APPROVE, Problem, READ, WRITE, type Context, type Data, type Input, type Operation, type Row } from '@smartsell/contracts';
import { commands, evaluateStoredRules } from './index.js';
import { DomainError, type Context as CommandContext, type Entity, type Fields } from '../types.js';

const humans = ['owner', 'admin', 'manager', 'editor'] as const;

const nativeContexts = new WeakMap<CommandContext, Context>();
export const nativeOperationContext = (ctx: CommandContext) => nativeContexts.get(ctx);

/** Adapt the existing inbox domain to workspace operations without introducing a second state machine. */
export function commandContext(ctx: Context, module = 'inbox'): CommandContext {
  const locate = (kind: string, id: string) => ctx.list(kind).find(row => row.id === id || row.command_key === id);
  const entity = (kind: string, row: Row): Entity => {
    const { id, version, created_at, updated_at, command_key: _key, ...data } = row;
    return { id, version, created_at, updated_at, data, module, kind, tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId };
  };
  const adapter: CommandContext & { agentCredentialId?: string } = {
    agentCredentialId: (ctx as Context & { agentCredentialId?: string }).agentCredentialId,
    actorId: ctx.actorId, tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, now: ctx.now,
    role: ctx.role === 'manager' ? 'admin' : ctx.role === 'agent' ? 'editor' : ctx.role === 'analyst' ? 'viewer' : ctx.role,
    async get(_module, kind, id) { const row = locate(kind, id); return row && entity(kind, row); },
    async list(_module, kind) { return ctx.list(kind).map(row => entity(kind, row)); },
    async insert(_module, kind, data, key) { return entity(kind, ctx.create(kind, { ...data, ...(key && { command_key: key }) })); },
    async update(_module, kind, id, data, version) {
      const row = locate(kind, id);
      if (!row || row.version !== version) throw new DomainError('version_conflict', 'Record changed. Refresh and try again.', 409);
      return entity(kind, ctx.update(kind, row.id, data));
    },
    async emit(type, data) { ctx.emit(type, data); },
  };
  nativeContexts.set(adapter, ctx);
  return adapter;
}
export function unwrap(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unwrap);
  if (value && typeof value === 'object') {
    const data = value as Data;
    if (typeof data.module === 'string' && typeof data.kind === 'string' && data.id && data.data && typeof data.data === 'object') {
      return { ...data.data, id: data.id, version: data.version, created_at: data.created_at, updated_at: data.updated_at };
    }
    return Object.fromEntries(Object.entries(data).map(([key, item]) => [key, unwrap(item)]));
  }
  return value;
}
function op(method: Operation['method'], path: string, action: string, roles: Operation['roles'], summary: string,
  dto: (input: Input) => Fields = ({ body }) => body, options: Pick<Operation, 'versionKind' | 'external'> = {}): Operation {
  return { method, path, name: `inbox_${action}`, roles, summary, ...options, async run(ctx, input) {
    try {
      // Send validates its version after the lease and outstanding-attempt checks.
      if (action === 'send_reply' && input.expectedVersion === undefined) {
        throw new Problem(428, 'VERSION_REQUIRED', 'If-Match or expected_version is required');
      }
      const result = unwrap(await commands[action].run(commandContext(ctx), dto(input)));
      return action === 'approve_reply' ? persistApprovedReplyTask(ctx, result as Row) : result;
    }
    catch (error) {
      if (error instanceof DomainError) {
        if (action === 'send_reply' && error.code === 'version_conflict') {
          const current = ctx.get('reply_draft', input.params.id);
          throw new Problem(409, 'VERSION_CONFLICT', 'The resource version changed', {
            current_version: current.version, expected_version: input.expectedVersion, updated_at: current.updated_at,
          });
        }
        throw new Problem(error.status, error.code, error.message);
      }
      throw error;
    }
  } };
}
const conversation = ({ params, body, expectedVersion }: Input) => ({ ...body, conversation_id: params.id, expected_version: expectedVersion });
const draft = ({ params, body, expectedVersion, idempotencyKey }: Input) => ({ ...body, reply_draft_id: params.id, expected_version: expectedVersion, idempotency_key: idempotencyKey });
const reply = ({ params, body, expectedVersion }: Input) => ({ ...body, outbound_reply_id: params.id, expected_version: expectedVersion });

export const operations: Operation[] = [
  op('GET', '/conversations', 'list', READ, 'List conversations', ({ query }) => ({ ...query, limit: query.limit == null ? undefined : Number(query.limit) })),
  op('GET', '/conversations/:id', 'get_conversation', READ, 'Read conversation detail', input => ({ ...conversation(input), include_messages: input.query.include_messages !== 'false', after: input.query.after, limit: input.query.limit == null ? undefined : Number(input.query.limit) })),
  op('POST', '/inbox/ingest', 'ingest_batch', ADMIN, 'Import normalized inbound messages', ({ body }) => ({ messages: Array.isArray(body.messages) ? body.messages.map(message => ({ ...message, direction: 'inbound', source: 'import' })) : null })),
  op('PATCH', '/conversations/:id', 'update_conversation', humans, 'Assign or change processing status', conversation, { versionKind: 'conversation' }),
  op('POST', '/conversations/batch', 'batch_conversations', humans, 'Preview or apply conversation updates'),
  op('POST', '/conversations/:id/read', 'mark_read', READ, 'Set personal read position', conversation),
  op('POST', '/conversations/:id/occupancy', 'claim', WRITE, 'Take or renew a processing lease', conversation),
  op('DELETE', '/conversations/:id/occupancy', 'release', WRITE, 'Release or hand off processing lease', input => ({ ...conversation(input), handover_to_user_id: input.query.handover_to ?? input.body.handover_to_user_id })),
  op('POST', '/conversations/:id/notes', 'add_note', WRITE, 'Write an internal note', conversation),
  op('POST', '/conversations/:id/reply-drafts', 'draft_reply', WRITE, 'Draft a reply', conversation),
  op('PATCH', '/reply-drafts/:id', 'update_reply_draft', WRITE, 'Edit a reply draft', draft, { versionKind: 'reply_draft' }),
  op('POST', '/reply-drafts/:id/submit-approval', 'submit_reply_approval', WRITE, 'Request approval', draft, { versionKind: 'reply_draft' }),
  op('POST', '/reply-drafts/:id/approve', 'approve_reply', APPROVE, 'Approve a draft version', draft, { versionKind: 'reply_draft' }),
  op('POST', '/reply-drafts/:id/send', 'send_reply', humans, 'Queue an approved reply or stage a manual reply (requires expected version)', draft, { external: true }),
  op('GET', '/outbound-replies/:id', 'get_reply_status', READ, 'Read reply state and attempts', reply),
  op('POST', '/outbound-replies/:id/reconcile', 'reconcile_reply', humans, 'Verify a reply against synchronized platform messages', reply),
  op('POST', '/outbound-replies/:id/manual-complete', 'manual_complete_reply', humans, 'Record manual delivery evidence', reply, { versionKind: 'outbound_reply' }),
  op('POST', '/outbound-replies/:id/retry', 'retry_reply', humans, 'Queue a reply with confirmed non-delivery', reply, { versionKind: 'outbound_reply', external: true }),
  op('POST', '/outbound-replies/:id/cancel', 'cancel_reply', ADMIN, 'Cancel a staged or confirmed unsent reply', reply, { versionKind: 'outbound_reply' }),
  op('POST', '/inbox/sla-policies', 'create_sla_policy', ADMIN, 'Create business-hours or elapsed-time service targets'),
  op('PATCH', '/inbox/sla-policies/:id', 'update_sla_policy', ADMIN, 'Update service targets for future assignments',
    ({ params, body, expectedVersion }) => ({ ...body, policy_id: params.id, expected_version: expectedVersion }), { versionKind: 'sla_policy' }),
  op('POST', '/inbox/sla-policies/tick', 'sla_tick', ADMIN, 'Evaluate service deadlines'),
  op('POST', '/inbox/unsnooze', 'unsnooze', ADMIN, 'Reopen due snoozed conversations'),
  { method: 'POST', path: '/inbox/messages/:id/evaluate-rules', name: 'inbox_evaluate_auto_rules', roles: ADMIN, summary: 'Evaluate draft-only rules on a stored inbound message', async run(ctx, { params }) {
    try { return unwrap(await evaluateStoredRules(commandContext(ctx), params.id)); }
    catch (error) {
      if (error instanceof DomainError) throw new Problem(error.status, error.code, error.message);
      throw error;
    }
  } },
  { method: 'GET', path: '/inbox/coverage', name: 'inbox_coverage', roles: READ, summary: 'Read known inbox sync and capability coverage', run(ctx) {
    const accounts = ctx.list('social_account');
    const probes = ctx.list('capability').filter(row => row.source === 'account_probe' && row.executor === 'api');
    const capabilities = ctx.list('inbox_capability').map(row => ({
      social_account_id: row.social_account_id, capability: row.capability, status: row.status,
      reason: row.reason ?? null, last_synced_at: row.last_synced_at ?? null,
    }));
    for (const account of accounts) {
      if (account.status !== 'active') continue;
      const provider = providerCatalog[account.provider as keyof typeof providerCatalog];
      for (const [operation, capability] of [['comment_read', 'comment.read'], ['dm_read', 'dm.read']] as const) {
        if (capabilities.some(row => row.social_account_id === account.id && row.capability === capability)) continue;
        const declaration = provider?.capabilities.find(row => row.operation === operation && (row.executor === 'api' || (!row.executor && row.readiness === 'unsupported')));
        const reports = probes.filter(row => row.social_account_id === account.id && row.operation === operation);
        const status = declaration?.readiness === 'unsupported' ? 'unsupported' :
          ['available', 'read_only', 'needs_authorization', 'unsupported'].find(value => reports.some(row => row.status === value)) ?? 'unverified';
        capabilities.push({ social_account_id: account.id, capability, status,
          reason: reports.find(row => row.status === status)?.reason ?? null, last_synced_at: null });
      }
    }
    return { capabilities, unknown_when_missing: true,
      accounts: accounts.map(({ id, display_name, provider }) => ({ id, display_name, provider })) };
  } },
  ...serviceOperations,
  ...settingsOperations,
];
