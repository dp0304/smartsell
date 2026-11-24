import { ADMIN, Problem, WRITE, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { fromAgent, requireHuman } from '../../agent-actor.js';
import { audit } from './input.js';
import { resubmitMachineTargets, workerEngine } from './channel-settings.js';

/**
 * Machine operations (phase1-design §3.2, §4.6, Appendix B.3) under their full hub_* names, outside account's op() prefix.
 * Pausing is a stop and Agent-callable; renaming and resuming are a person's decision.
 */
const isObject = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
const unknownFields = (body: Data, allowed: string[]) => Object.keys(body).filter(key => !allowed.includes(key));
const invalid = (issues: { path: string; message: string }[]) => new Problem(422, 'INVALID_ARGUMENTS', `欄位不正確：${issues.map(issue => issue.path).join('、')}`, { issues });
const control = /[\u0000-\u001f\u007f]/;

function machine(ctx: Context, id: string) {
  const device = ctx.get('connector_device', id);
  if (device.status === 'revoked') throw new Problem(409, 'DEVICE_INACTIVE', '這台機器已撤銷');
  return device;
}

export function machineSummary(device: Row) {
  return {
    machine_id: device.id, name: String(device.display_name ?? device.name ?? ''), display_name: device.display_name ?? null, hostname: device.name ?? null,
    status: device.status, paused: device.paused === true, paused_reason: device.paused_reason ?? null, paused_by: device.paused_by ?? null,
    paused_at: device.paused_at ?? null, version: device.version,
  };
}

function updateMachine(ctx: Context, id: string, body: Data) {
  const extra = unknownFields(body, ['display_name']);
  const name = body.display_name;
  const valid = name === null || typeof name === 'string' && name.trim().length > 0 && name.trim().length <= 60 && !control.test(name);
  if (extra.length || !('display_name' in body) || !valid) {
    throw invalid([...extra.map(path => ({ path, message: '不認得的欄位' })), ...(!valid || !('display_name' in body) ? [{ path: 'display_name', message: '需為 1–60 字的名稱，或 null' }] : [])]);
  }
  const device = machine(ctx, id);
  const display_name = name === null ? null : String(name).trim();
  if ((device.display_name ?? null) === display_name) return machineSummary(device);
  const updated = ctx.update('connector_device', device.id, { display_name });
  audit(ctx, 'account.device.renamed', { device_id: device.id, display_name });
  ctx.emit('account.device.updated', { device_id: device.id, fields: ['display_name'] });
  return machineSummary(updated);
}

function pauseMachine(ctx: Context, id: string, body: Data) {
  const extra = unknownFields(body, ['reason']);
  const reason = body.reason;
  if (extra.length || reason !== undefined && (typeof reason !== 'string' || !reason.trim() || reason.length > 500 || control.test(reason))) {
    throw invalid([...extra.map(path => ({ path, message: 'Unknown field' })), ...(reason !== undefined ? [{ path: 'reason', message: 'reason must be 1–500 characters' }] : [])]);
  }
  const device = machine(ctx, id);
  if (device.paused === true) return machineSummary(device);   // keep who paused it first and why
  const credential = (ctx as Context & { agentCredentialId?: string }).agentCredentialId;
  const paused_by = fromAgent(ctx) ? `agent:${credential ?? ctx.actorId}` : ctx.actorId;
  const updated = ctx.update('connector_device', device.id, {
    paused: true, paused_reason: typeof reason === 'string' ? reason.trim() : null, paused_by, paused_at: ctx.now,
  });
  workerEngine().bumpSyncGeneration(ctx, [device.id], 'machine_paused');
  audit(ctx, 'account.device.paused', { device_id: device.id, paused_by, reason: updated.paused_reason });
  ctx.emit('account.device.paused', { device_id: device.id, paused_by });
  return machineSummary(updated);
}

function resumeMachine(ctx: Context, id: string, body: Data) {
  if (isObject(body) && Object.keys(body).length) throw invalid(Object.keys(body).map(path => ({ path, message: '不認得的欄位' })));
  const device = machine(ctx, id);
  if (device.paused !== true) return machineSummary(device);
  const updated = ctx.update('connector_device', device.id, { paused: false, paused_reason: null, paused_by: null, paused_at: null });
  workerEngine().bumpSyncGeneration(ctx, [device.id], 'machine_resumed');
  // E35: posts scheduled or sent back for approval while the machine was paused were blocked (machine_paused) before they had
  // an approval; submit them again in this transaction. Ready posts were only held and run on their own.
  const resubmitted = resubmitMachineTargets(ctx, device.id);
  audit(ctx, 'account.device.resumed', { device_id: device.id, previously_paused_by: device.paused_by ?? null, resubmitted_posts: resubmitted });
  ctx.emit('account.device.resumed', { device_id: device.id });
  return machineSummary(updated);
}

const machinePath = '/hub/machines/:id';
export const machineOperations: Operation[] = [
  {
    method: 'PATCH', path: machinePath, name: 'hub_machines_update', roles: ADMIN, summary: 'Rename a paired machine (person only)',
    contract: { bodyRequired: true, body: { type: 'object', additionalProperties: false, required: ['display_name'], properties: { display_name: { type: ['string', 'null'], maxLength: 60 } } } },
    run(ctx, input) { requireHuman(ctx, 'hub_machines_update'); return updateMachine(ctx, input.params.id!, input.body); },
  },
  {
    method: 'POST', path: `${machinePath}/pause`, name: 'hub_machines_pause', roles: WRITE,
    summary: 'Pause a machine: it keeps its jobs but will not start any until a person resumes it',
    contract: { body: { type: 'object', additionalProperties: false, properties: { reason: { type: 'string', maxLength: 500 } } } },
    run(ctx, input) { return pauseMachine(ctx, input.params.id!, input.body); },
  },
  {
    method: 'POST', path: `${machinePath}/resume`, name: 'hub_machines_resume', roles: ADMIN, summary: 'Resume a paused machine (person only)',
    run(ctx, input) { requireHuman(ctx, 'hub_machines_resume'); return resumeMachine(ctx, input.params.id!, input.body); },
  },
];
