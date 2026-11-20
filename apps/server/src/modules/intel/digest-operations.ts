import { Problem, type Context, type Data, type Operation, type Role, type Row } from '@smartsell/contracts';
import type { Subscriber } from '../../operations.js';
import { generateDigest, prepareDigest } from './intel-research.js';

export const researchDigestKind = 'intel.generate_research_digest';
export const researchDigestRoles: readonly Role[] = ['owner', 'admin', 'manager', 'editor', 'analyst'];
const requested = `${researchDigestKind}.requested`;

export const queueResearchDigest: Operation['run'] = (ctx, { body, expectedVersion }) => {
  const { board, bounds } = prepareDigest(ctx, body, expectedVersion);
  const { id } = ctx.create('operation', { kind: researchDigestKind, status: 'queued', requested_by: ctx.actorId,
    board_id: board.id, board_version: board.version, period: bounds });
  ctx.emit(requested, { operation_id: id });
  return { operation_id: id };
};

export function assertResearchDigestOperationVisible(ctx: Context) {
  if (!researchDigestRoles.includes(ctx.role)) throw new Problem(404, 'NOT_FOUND', 'Operation not found');
}

export function cancelResearchDigest(ctx: Context, row: Row) {
  if (row.status === 'cancelled') return row;
  if (row.status !== 'queued') throw new Problem(409, 'STATE_CONFLICT', 'Research digest generation has already finished');
  return finish(ctx, row, { status: 'cancelled', cancel_requested_at: ctx.now });
}

function queued(ctx: Context, event: Data) {
  const id = (event.data as Data | undefined)?.operation_id;
  if (typeof id !== 'string') return;
  const row = ctx.get('operation', id);
  if (row.kind === researchDigestKind && row.status === 'queued') return row;
}

function finish(ctx: Context, row: Row, fields: Data) {
  const operation = ctx.update('operation', row.id, fields);
  ctx.emit(`${researchDigestKind}.${fields.status}`, { operation_id: row.id });
  return operation;
}

export const researchDigestSubscriber: Subscriber = {
  id: researchDigestKind,
  sensitive: true,
  accepts: type => type === requested,
  run(ctx, event) {
    const row = queued(ctx, event);
    if (!row) return;
    const members = (ctx as Context & { activeWorkspaceMembers?: { userId: string; role: Role; scopes?: string[] }[] }).activeWorkspaceMembers;
    const member = members?.find(member => member.userId === row.requested_by);
    if (!member || member.scopes?.length || !researchDigestRoles.includes(member.role)) {
      finish(ctx, row, { status: 'failed', error_code: 'FORBIDDEN' });
      return;
    }
    const actor = { ...ctx, actorId: member.userId, role: member.role };
    try {
      const prepared = prepareDigest(actor, row, Number(row.board_version));
      const digest = generateDigest(actor, prepared);
      finish(ctx, row, { status: 'succeeded', result_ref: { research_digest_id: digest.id } });
    } catch (error) {
      if (!(error instanceof Problem)) throw error;
      finish(ctx, row, { status: 'failed', error_code: error.code });
    }
  },
  onTerminalFailure(ctx, _attempts, event) {
    const row = queued(ctx, event);
    if (row) finish(ctx, row, { status: 'failed', error_code: 'RESEARCH_DIGEST_FAILED' });
  },
};
