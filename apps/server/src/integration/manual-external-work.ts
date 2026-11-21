import { ADMIN, Problem, type Context } from '@smartsell/contracts';
import type { Registered } from '../operations.js';

export function queueManualExternalWork(ctx: Context, input: {
  key: string; title: string; resourceType: string; resourceId: string;
  brandId?: unknown; assigneeId?: string; event: string; references: Record<string, string>;
  initiallyBlocked?: boolean;
}) {
  const dedupe_key = `manual-external:${input.key}`;
  const prior = ctx.list('work_item').find(row => row.dedupe_key === dedupe_key);
  if (prior) return prior;
  const task = ctx.create('work_item', {
    dedupe_key, type: 'followup', title: input.title, status: input.initiallyBlocked ? 'blocked' : 'open', priority: 'normal',
    blocked_reason: input.initiallyBlocked ? 'Await CRM delivery routing.' : null,
    resource_type: input.resourceType, resource_id: input.resourceId, brand_id: input.brandId ?? null,
    assignee_type: 'user', assignee_id: input.assigneeId ?? ctx.actorId, created_by_id: ctx.actorId,
    source_type: 'manual_external', source_ref: input.references,
    completion_criteria: { requires_provider_readback: true },
  });
  ctx.emit(input.event, { ...input.references, request_id: input.references.request_id ?? task.id });
  return task;
}

export const manualExternalReceipt: Registered = {
  module: 'workspace', method: 'POST', path: '/work-items/:id/external-receipt', name: 'record_manual_external_receipt',
  roles: ADMIN, mcp: false, versionKind: 'work_item', summary: 'Record store or ESP readback for a manual task',
  run(ctx, { params, body }) {
    const task = ctx.get('work_item', params.id!);
    if (task.source_type !== 'manual_external' || !['product_localization', 'esp_campaign_ref'].includes(String(task.resource_type))) {
      throw new Problem(404, 'EXTERNAL_TASK_NOT_FOUND', 'External task not found');
    }
    if (['done', 'cancelled'].includes(String(task.status))) throw new Problem(409, 'EXTERNAL_TASK_CLOSED', 'External task is closed');
    const { outcome, evidence_ref } = body;
    if (!['confirmed', 'failed', 'unknown'].includes(String(outcome)) || typeof evidence_ref !== 'string' || !evidence_ref.trim() || evidence_ref.length > 512) {
      throw new Problem(422, 'INVALID_EXTERNAL_RECEIPT', 'An outcome and provider evidence reference are required');
    }
    const receipt = ctx.create('manual_external_receipt', { work_item_id: task.id, outcome, evidence_ref: evidence_ref.trim(), verified_by: ctx.actorId });
    const status = outcome === 'confirmed' ? 'done' : 'blocked';
    return ctx.update('work_item', task.id, { status, external_receipt_id: receipt.id,
      blocked_reason: outcome === 'unknown' ? 'Provider outcome is unknown. Do not resend.' : outcome === 'failed' ? 'Provider readback indicates failure.' : null,
      ...(status === 'done' && { completed_at: ctx.now, completed_by_type: 'user', completed_by_id: ctx.actorId }) });
  },
};
