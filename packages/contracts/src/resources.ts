import { Problem, READ, WRITE, type Data, type Operation, type Role } from './module.js';

export interface ResourceSpec {
  kind: string;
  path: string;
  name: string;
  required?: readonly string[];
  writable?: readonly string[];
  initial?: Data;
  roles?: readonly Role[];
}

const internal = new Set(['id', 'version', 'created_at', 'updated_at', 'tenant_id', 'workspace_id', 'actor_id', 'allowed_actions', '__proto__', 'prototype', 'constructor']);
const filters = ['brand_id', 'owner_id', 'market_id', 'campaign_id', 'social_account_id', 'platform', 'status'] as const;

/** Collect only declared fields; identity, tenancy and version are always server-owned. */
function fields(spec: ResourceSpec, body: Data, create: boolean): Data {
  const allowed = new Set([...(spec.required ?? []), ...(spec.writable ?? [])]);
  const values: Data = {};
  for (const [key, value] of Object.entries(body)) {
    if (!allowed.has(key) || internal.has(key)) {
      throw new Problem(422, 'VALIDATION_FAILED', `Field cannot be written: ${key}`, { field: key });
    }
    values[key] = typeof value === 'string' ? value.trim() : value;
  }
  for (const key of spec.required ?? []) {
    if ((create || Object.hasOwn(values, key)) && (values[key] === undefined || values[key] === null || values[key] === '')) {
      throw new Problem(422, 'VALIDATION_FAILED', `Required field: ${key}`, { field: key });
    }
  }
  if (!create && !Object.keys(values).length) throw new Problem(422, 'VALIDATION_FAILED', 'At least one change is required');
  return values;
}

/** Basic resources only. State transitions, approvals and external effects are explicit operations. */
export function crud(spec: ResourceSpec): Operation[] {
  const { kind, path, name } = spec;
  const writeRoles = spec.roles ?? WRITE;
  return [
    { method: 'GET', path, name: `${name}_list`, roles: READ, summary: `List ${kind}`, run(ctx, { query }) {
      return ctx.list(kind).filter(row => filters.every(f => !query[f] || row[f] === query[f]));
    } },
    { method: 'GET', path: `${path}/:id`, name: `${name}_get`, roles: READ, summary: `Read ${kind}`, run: (ctx, { params }) => ctx.get(kind, params.id) },
    { method: 'POST', path, name: `${name}_create`, roles: writeRoles, summary: `Create ${kind}`, run(ctx, { body }) {
      const record = ctx.create(kind, { ...spec.initial, ...fields(spec, body, true) });
      ctx.emit(`${kind}.created`, { id: record.id, version: record.version });
      return record;
    } },
    { method: 'PATCH', path: `${path}/:id`, name: `${name}_update`, roles: writeRoles, versionKind: kind, summary: `Update ${kind}`, run(ctx, { params, body }) {
      const record = ctx.update(kind, params.id, fields(spec, body, false));
      ctx.emit(`${kind}.updated`, { id: record.id, version: record.version });
      return record;
    } },
  ];
}
