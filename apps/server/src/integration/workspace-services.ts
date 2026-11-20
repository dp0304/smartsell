import { randomUUID } from 'node:crypto';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import type { Records } from '@smartsell/db';
import { makeContext } from '../context.js';
import { nowSeconds, type Grant, type Membership, type Workspace } from '../identity.js';
import { createAgentChangeTargets, expireActorLeases, expireCredentialLeases, processAgentEvent, processAgentSchedule, reapJobLeases } from '../modules/agent/operations.js';
import { assertEmergencyNotStopped, type OperationOpsContext } from '../modules/ops/index.js';
import { createTeamOperations } from '../modules/team/index.js';
import type { TeamHost } from '../modules/team/model.js';
import { semanticSearch, type CustomerEgress } from './customer-egress.js';
import type { Registered, Schedule, Subscriber } from '../operations.js';
import { agentModelRuntime } from './agent-model-runtime.js';
import { brandOperationAllowed, validateBrandScopes } from './brand-access.js';
import { portalTeam } from './portal-host.js';
import { assertUsageAllowed } from '../modules/ops/metering.js';
import { handoverCandidates, transferAcceptedTasks } from '../modules/workspace/tasks.js';

const membershipKey = (userId: string, workspaceId: string) => `member/${userId}/${workspaceId}`;
const tenantMemberKey = (tenantId: string, userId: string) => `tenant-member/${tenantId}/${userId}`;

export function workspaceServices(operations: readonly Registered[], egress?: CustomerEgress, allowUnscanned = false) {
  const authorizeNotificationComment = portalTeam(operations, undefined, allowUnscanned).authorizeComment!;
  const changeTargets = createAgentChangeTargets(operations);
  const models = agentModelRuntime();
  const inboxRead = operations.find(op => op.name === 'inbox_get_conversation');
  return (ctx: Context, identity?: Records, credentialId?: string) => {
    const activeMembers = identity?.list<Membership>('member/').filter(member => member.workspaceId === ctx.workspaceId) ?? [];
    const tenantScope = identity && makeContext({
      get: (key: string) => identity.get(`tenant-data/${ctx.tenantId}/${key}`),
      list: (prefix: string) => identity.list(`tenant-data/${ctx.tenantId}/${prefix}`),
      put: (key: string, value: unknown) => identity.put(`tenant-data/${ctx.tenantId}/${key}`, value),
      delete: (key: string) => identity.delete(`tenant-data/${ctx.tenantId}/${key}`),
    }, ctx, ctx.role);
    return Object.assign(ctx, {
      agentCredentialId: credentialId,
      agentModelServices: models.bind(ctx, egress?.hasModel(ctx) ? egress.model : undefined),
      async agentInboxRead(scoped: Context, id: string) {
        if (!inboxRead?.roles.includes(scoped.role)) throw new Problem(403, 'FORBIDDEN', 'Inbox read is unavailable');
        return inboxRead.run(scoped, { params: { id }, query: { limit: '10' }, body: {} });
      },
      opsServices: egress?.ops,
      agentChangeTargets: changeTargets,
      isActiveWorkspaceMember: (id: string) => identity
        ? !!identity.get<Membership>(membershipKey(id, ctx.workspaceId)) : id === ctx.actorId,
      tenantScope,
      tenantRole: credentialId ? undefined : identity?.get<{ role: Role }>(tenantMemberKey(ctx.tenantId, ctx.actorId))?.role,
      workspaceName: identity?.get<Workspace>(`workspace/${ctx.workspaceId}`)?.name,
      canReadWorkspaceResource(kind: string, row: Row) {
        if (['customer', 'conversation', 'creator', 'agent_job'].includes(kind)) {
          return ['owner', 'admin', 'manager'].includes(ctx.role) ||
            [row.assignee_id, row.assignee_user_id, row.owner_id, row.owner_user_id, row.created_by, row.created_by_user_id].includes(ctx.actorId);
        }
        return !['share', 'portal_invitation', 'portal_grant', 'share_access_log', 'comment', 'comment_thread'].includes(kind);
      },
      activeWorkspaceMembers: activeMembers,
      notificationRecipient(userId: string, operation: string) {
        const member = activeMembers.find(candidate => candidate.userId === userId);
        if (!member || member.role === 'agent' || !brandOperationAllowed(member.scopes, operation, 'GET')) return;
        return { ...ctx, actorId: userId, role: member.role };
      },
      authorizeNotificationComment,
      isActiveAgentCredential: (id: string, actorId: string) => {
        const hash = identity?.get<string>(`grant-index/${actorId}/${id}`);
        const grant = hash ? identity?.get<Grant>(`grant/${hash}`) : undefined;
        const command = identity?.get<{ actorId: string; workspaceId: string }>(`command-credential/${id}`);
        return (grant?.workspaceId === ctx.workspaceId && !grant.workspaceRemoved && grant.expires > nowSeconds()) ||
          (command?.actorId === actorId && command.workspaceId === ctx.workspaceId);
      },
      workspaceMemberRole: (id: string) => activeMembers.find(member => member.userId === id)?.role,
    } satisfies Partial<OperationOpsContext> & Record<string, unknown>);
  };
}

export const workspaceTeamWork: NonNullable<TeamHost['work']> = {
  workload(ctx) {
    return ctx.list('work_item').flatMap(row => typeof row.assignee_id === 'string' && !['done', 'cancelled'].includes(String(row.status))
      ? [{ assignee_id: row.assignee_id, kind: String(row.type), blocked: row.status === 'blocked' }] : []);
  },
  forHandover(ctx, from) {
    return handoverCandidates(ctx, from).map(row => ({ kind: 'work_item', id: row.id }));
  },
  transfer: transferAcceptedTasks,
};

export function releaseOperationMember(ctx: Context, userId: string) {
  expireActorLeases(ctx, userId);
  for (const row of ctx.list('portal_grant').filter(row => row.subject_id === userId && row.active === true)) {
    ctx.update('portal_grant', row.id, { active: false });
  }
}

export function workspaceTeam(identity: Records, host: TeamHost): TeamHost {
  return {
    ...host,
    work: host.work ?? workspaceTeamWork,
    members: {
      list(ctx) {
        return identity.list<Membership & { scopes?: string[] }>('member/')
          .filter(member => member.workspaceId === ctx.workspaceId)
          .map(member => ({ id: member.userId, user_id: member.userId, role: member.role, scopes: member.scopes ?? [] }));
      },
      invite(ctx, { email, role, scopes }) {
        if (scopes.length) throw new Problem(422, 'scope_not_supported', 'Resource-scoped grants are unavailable');
        const userId = identity.get<string>(`email/${email}`);
        if (!userId) throw new Problem(409, 'account_required', 'The recipient must first have a workspace account');
        const key = membershipKey(userId, ctx.workspaceId);
        if (identity.get(key)) throw new Problem(409, 'member_exists', 'The recipient is already a member');
        const tenantWorkspaces = new Set(identity.list<Workspace>('workspace/').filter(ws => ws.tenantId === ctx.tenantId).map(ws => ws.id));
        const occupied = new Set(identity.list<Membership>('member/').filter(member => tenantWorkspaces.has(member.workspaceId)).map(member => member.userId));
        const now = Date.parse(ctx.now);
        for (const invite of identity.list<{ workspaceId: string; userId: string; expires: number }>('workspace-invite/')) {
          if (invite.expires > now && tenantWorkspaces.has(invite.workspaceId)) occupied.add(invite.userId);
        }
        if (!occupied.has(userId)) assertUsageAllowed(ctx, 'seats', 1, occupied.size);
        const id = randomUUID();
        identity.put(`workspace-invite/${id}`, { workspaceId: ctx.workspaceId, userId, role, expires: now + 7 * 86400_000 });
        return { invitation_id: id };
      },
      setRole(ctx, member, role, scopes) {
        scopes = validateBrandScopes(ctx, role, scopes);
        if (member.role === 'owner' && role !== 'owner' && this.list(ctx).filter(row => row.role === 'owner').length <= 1) {
          throw new Problem(409, 'last_owner', 'The workspace must have an owner');
        }
        identity.put(membershipKey(member.user_id, ctx.workspaceId), { userId: member.user_id, workspaceId: ctx.workspaceId, role, scopes });
      },
      previewRemoval(ctx, member) {
        return handoverCandidates(ctx, member.user_id).map(row => ({ kind: 'work_item', id: row.id }));
      },
      remove(ctx, member) {
        if (member.role === 'owner' && this.list(ctx).filter(row => row.role === 'owner').length <= 1) {
          throw new Problem(409, 'last_owner', 'The workspace must have an owner');
        }
        identity.delete(membershipKey(member.user_id, ctx.workspaceId));
        for (const tokenHash of identity.list<string>(`grant-index/${member.user_id}/`)) {
          const grant = identity.get<Grant>(`grant/${tokenHash}`);
          if (grant?.workspaceId !== ctx.workspaceId) continue;
          if (grant.kind === 'pat') {
            identity.put(`grant/${tokenHash}`, { ...grant, workspaceRemoved: true });
          } else {
            identity.delete(`grant/${tokenHash}`);
            identity.delete(`grant-index/${member.user_id}/${grant.id}`);
          }
        }
        releaseOperationMember(ctx, member.user_id);
      },
    },
  };
}

export function bindTeamOperation(operation: Registered, host: TeamHost) {
  if (operation.module !== 'team') return operation;
  const owning = createTeamOperations(host).find(item => item.name === operation.name);
  return owning ? { ...operation, run: owning.run } : operation;
}

export function guardExternalOperation(ctx: Context, operation: Registered) {
  if (operation.external && operation.method !== 'GET') assertEmergencyNotStopped(ctx);
}

export const agentSubscriber: Subscriber = {
  id: 'agent', accepts: type => !type.startsWith('agent.rule_run.'),
  run(ctx, event) {
    return processAgentEvent(ctx, { id: String(event.id), type: String(event.type), data: (event.data ?? {}) as Data });
  },
};

export const workspaceSchedule: Schedule = {
  id: 'agent.leases-and-approvals',
  run(ctx) {
    reapJobLeases(ctx);
    const access = ctx as Context & { isActiveWorkspaceMember?(id: string): boolean; isActiveAgentCredential?(id: string, actor: string): boolean };
    for (const job of ctx.list('agent_job')) {
      if (!['claimed', 'in_progress'].includes(String(job.status)) || typeof job.lease_owner_id !== 'string') continue;
      if (access.isActiveWorkspaceMember?.(job.lease_owner_id) === false) expireActorLeases(ctx, job.lease_owner_id);
      else if (typeof job.lease_credential_id === 'string' && access.isActiveAgentCredential?.(job.lease_credential_id, job.lease_owner_id) === false) {
        expireCredentialLeases(ctx, job.lease_credential_id);
      }
    }
    processAgentSchedule(ctx);
    for (const row of ctx.list('approval_request')) {
      if (row.status !== 'pending' || !(Date.parse(String(row.due_at)) <= Date.parse(ctx.now))) continue;
      ctx.update('approval_request', row.id, { status: 'expired', invalidated_reason: 'deadline_elapsed' });
      ctx.emit('core.approval_request.expired', { request_id: row.id, resource_id: row.resource_id, reason: 'deadline_elapsed' });
    }
  },
};

export const semanticSearchOperation: Registered = {
  module: 'workspace', method: 'POST', path: '/search/semantic', name: 'search_semantic', mcp: false,
  roles: ['owner', 'admin', 'manager', 'editor', 'analyst', 'reviewer', 'viewer'],
  summary: 'Rank a bounded set of accessible results with an approved embedding provider',
  run(ctx, { query, body }) {
    if (typeof body.q !== 'string') throw new Problem(422, 'INVALID_INPUT', 'A search query is required');
    return semanticSearch(ctx, { ...query, q: body.q });
  },
};
