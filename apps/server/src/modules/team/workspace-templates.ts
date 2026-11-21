import { ADMIN, APPROVE, READ, type Context, type Data, type Operation, type Row } from '@smartsell/contracts';
import { array, choice, record, row, text } from './model.js';

const labelKeys = ['markets', 'stages', 'milestones', 'report_sections', 'approval_policies'] as const;
type TemplateDefaults = Partial<Record<typeof labelKeys[number] | 'roles', string[]>>;

function defaults(value: unknown): TemplateDefaults {
  const input = record(value, 'defaults');
  const result: TemplateDefaults = {};
  // This allowlist is also used for imports and stored rows. Never copy raw payloads or workspace records.
  for (const key of labelKeys) {
    if (Object.hasOwn(input, key)) result[key] = array(input[key], key, value => text(value, key, 80), 20);
  }
  if (Object.hasOwn(input, 'roles')) result.roles = array(input.roles, 'roles', value => choice(value, 'role', READ), READ.length);
  return result;
}

function portable(value: Data) {
  return { name: text(value.name, 'name', 100), kind: choice(value.kind, 'kind', ['workspace', 'workflow', 'report']),
    defaults: defaults(value.defaults) };
}

function applyTemplate(ctx: Context, id: string) {
  const template = row(ctx, 'workspace_template', id);
  const structure = portable(template);
  const applied = ctx.create('applied_template_defaults', structure);
  const approvalPolicyIds = (structure.defaults.approval_policies ?? []).map(name =>
    ctx.create('approval_policy', { name, resource_type: 'planning.publish_target', conditions: {},
      steps: [{ order: 1, approvers: { roles: APPROVE }, min_approvals: 1, due_hours: 48 }],
      mode: 'required', active: false, change_tolerance: {} }).id);
  const operation = ctx.create('operation', { kind: 'team.template.apply', resource_id: applied.id, status: 'succeeded' });
  ctx.create('template_application', { template_id: template.id, template_version: template.version,
    target_workspace_id: ctx.workspaceId, operation_id: operation.id, defaults_id: applied.id,
    created_objects: { defaults_id: applied.id, approval_policy_ids: approvalPolicyIds } });
  ctx.emit('team.template.applied', { template_id: template.id, operation_id: operation.id });
  return { operation_id: operation.id, defaults: applied };
}

function metadata(row: Row) {
  return { id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at };
}

function applicationView(ctx: Context, application: Row) {
  const applied = ctx.get('applied_template_defaults', String(application.defaults_id));
  const created = application.created_objects as { approval_policy_ids: string[] } | undefined;
  return { ...metadata(application), template_id: application.template_id, template_version: application.template_version,
    target_workspace_id: ctx.workspaceId, operation_id: application.operation_id, defaults_id: applied.id,
    created_objects: { defaults_id: applied.id, approval_policy_ids: created?.approval_policy_ids ?? [] },
    applied: { ...metadata(applied), ...portable(applied) } };
}

export const workspaceTemplateOperations: Operation[] = [
  { name: 'team_templates_list', method: 'GET', path: '/templates', roles: ADMIN, summary: 'List workspace templates',
    run: ctx => ctx.list('workspace_template').map(template => ({ id: template.id, version: template.version, ...portable(template) })) },
  { name: 'team_template_create', method: 'POST', path: '/templates', roles: ADMIN, summary: 'Save or import approved structural defaults',
    run: (ctx, { body }) => ctx.create('workspace_template', portable(body)) },
  { name: 'team_template_export', method: 'GET', path: '/templates/:id/export', roles: ADMIN, summary: 'Export portable structural defaults',
    run: (ctx, { params }) => portable(row(ctx, 'workspace_template', params.id!)) },
  { name: 'team_template_apply', method: 'POST', path: '/templates/:id/apply', roles: ADMIN, summary: 'Apply a local or imported workspace template',
    run: (ctx, { params }) => applyTemplate(ctx, params.id!) },
  { name: 'team_template_applications_list', method: 'GET', path: '/templates/applications', roles: ADMIN, summary: 'Read applied workspace template defaults',
    run: ctx => ctx.list('template_application').map(application => applicationView(ctx, application)) },
];
