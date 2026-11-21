import { z } from 'zod';
import type { Operation } from './module.js';

export type JsonSchema = Record<string, unknown>;
export const openObject = { type: 'object', additionalProperties: true } as const;
export const workspaceApiPrefix = '/api/v1/workspaces';
export const workspaceOpenApiFile = 'openapi.json';
export const pageSize = { default: 50, maximum: 200 } as const;
export const idempotencyPattern = '^[!-~]{1,200}$';
export const versionHeaderPattern = '^(?:"0*[1-9][0-9]*"|0*[1-9][0-9]*)$';
const version = z.number().int().positive();
const text = z.string();
const row = z.looseObject({ id: text, version, created_at: text, updated_at: text });
const brand = row.extend({ name: text, slug: text, status: text });
const brandInput = z.looseObject({ name: text, slug: text, default_market_id: text.nullable().optional() });
const workspaceContext = z.looseObject({
  workspace_id: text, role: text, timezone: text, currency: text, ui_locale: text, task_scope: text.optional(),
  brands: z.array(brand),
  markets: z.array(row.extend({ brand_id: text, name: text, country_code: text, primary_language: text })),
  accounts: z.array(z.looseObject({ id: text, brand_id: text.nullable().optional(), provider: text, status: text })),
});
const campaign = row.extend({ name: text, brand_id: text, kind: text, timezone: text, status: text });
const campaignInput = z.looseObject({ name: text, brand_id: text, kind: text, timezone: text,
  starts_at: text.nullable().optional(), ends_at: text.nullable().optional(), owner_user_id: text.nullable().optional(),
  audience_note: text.nullable().optional(), objective_summary: text.nullable().optional(), utm_key: text.optional(),
  markets: z.array(z.looseObject({ market_id: text })).optional(), products: z.array(z.looseObject({ product_id: text })).optional(),
  goals: z.array(z.looseObject({})).optional(), plan_slots: z.array(z.looseObject({})).optional(),
});
const contentItem = row.extend({ brand_id: text, title: text, production_stage: text });
const contentInput = z.looseObject({ brand_id: text, title: text,
  campaign_id: text.nullable().optional(), pillar_id: text.nullable().optional(), idea_id: text.nullable().optional(),
  owner_user_id: text.nullable().optional(), production_due_at: text.nullable().optional(),
  variants: z.array(z.looseObject({})).optional(), tasks: z.array(z.looseObject({ title: text })).optional(),
});
const target = row.extend({ social_account_id: text, content_variant_id: text, plan_status: text });
const targetInput = z.looseObject({ social_account_id: text, content_variant_id: text,
  scheduled_at: text.nullable().optional(), local_scheduled_at: text.nullable().optional(), schedule_tz: text.nullable().optional(),
  revision_id: text.nullable().optional(), variant_revision_id: text.nullable().optional(),
  promotion_ids: z.array(text).nullable().optional(),
});
const reportExportFormat = z.enum(['pdf', 'csv', 'xlsx']);
const operationStatus = z.looseObject({ operation_id: text, status: text, version, cancel_requested_at: text.nullable(),
  result_ref: z.union([z.object({ report_id: text, version_id: text, version_no: version, format: reportExportFormat.optional() }), z.object({ research_digest_id: text })]).optional(), error_code: text.optional() });

interface Dto {
  method: Operation['method'];
  path: string;
  input?: z.ZodType<Record<string, unknown>>;
  bodyRequired?: boolean;
  output: z.ZodType;
  query?: readonly string[];
  version?: 'required' | 'optional';
}

/** The named schemas describe stable wire fields. Module validation still owns domain rules. */
export const workspaceDtos = {
  workspace_get_context: { method: 'GET', path: '/context', output: workspaceContext, query: ['brand_id', 'task_scope'] },
  workspace_brands_list: { method: 'GET', path: '/brands', output: z.array(brand), query: ['status'] },
  workspace_brand_get: { method: 'GET', path: '/brands/:id', output: brand },
  workspace_brand_create: { method: 'POST', path: '/brands', input: brandInput, bodyRequired: true, output: brand },
  workspace_brand_update: { method: 'PATCH', path: '/brands/:id', input: brandInput.partial(), output: brand },
  campaign_list: { method: 'GET', path: '/campaigns',
    output: z.array(campaign), query: ['brand_id', 'status', 'active_on'] },
  campaign_create_draft: { method: 'POST', path: '/campaigns', input: campaignInput, bodyRequired: true, output: campaign },
  content_list: { method: 'GET', path: '/content-items', output: z.array(contentItem),
    query: ['brand_id', 'campaign_id', 'pillar_id', 'production_stage', 'owner_user_id', 'platform', 'locale', 'readiness'] },
  content_create_item: { method: 'POST', path: '/content-items', input: contentInput, bodyRequired: true,
    output: z.looseObject({ item: contentItem, variants: z.array(row), revisions: z.array(row), tasks: z.array(row) }) },
  publishing_list_targets: { method: 'GET', path: '/publish-targets', output: z.array(target),
    query: ['brand_id', 'social_account_id', 'campaign_id', 'campaign_ids', 'status', 'owner_id', 'from', 'to'] },
  publishing_create_target: { method: 'POST', path: '/publish-targets', input: targetInput, bodyRequired: true, output: target },
  publishing_request_approval: { method: 'POST', path: '/publish-targets/:id/submit', output: target, version: 'optional' },
  publishing_approve: { method: 'POST', path: '/publish-targets/:id/approve', output: target, version: 'required',
    input: z.looseObject({ resource_hash: text.nullable().optional(), approval_request_id: text.nullable().optional(), note: text.nullable().optional() }) },
  catalog_search: { method: 'GET', path: '/products', output: z.array(row.extend({ title: text, as_of: text })),
    query: ['brand_id', 'store_id', 'status', 'sku', 'query', 'market_id', 'available_only'] },
  reports_generate_version: { method: 'POST', path: '/reports/:id/versions',
    input: z.looseObject({ data_cutoff_at: text.optional() }), output: z.object({ operation_id: text }) },
  research_digest_create: { method: 'POST', path: '/research-digests', input: z.object({ board_id: text, period: z.object({ from: text, to: text }) }),
    output: z.object({ operation_id: text }), version: 'required', bodyRequired: true },
  research_digest_get: { method: 'GET', path: '/research-digests/:id', output: row },
  reports_queue_export: { method: 'POST', path: '/reports/:id/versions/:n/export', bodyRequired: true,
    input: z.object({ format: reportExportFormat }), output: z.object({ operation_id: text }) },
  report_exports_list: { method: 'GET', path: '/reports/:id/versions/:n/exports', output: z.object({
    items: z.array(z.object({ operation_id: text, format: reportExportFormat, status: text, version, error_code: text.optional() })),
  }) },
  operation_status_get: { method: 'GET', path: '/operations/:id', output: operationStatus },
  operation_status_cancel: { method: 'POST', path: '/operations/:id/cancel', output: operationStatus, version: 'required' },
  jobs_get: { method: 'GET', path: '/jobs/:id', output: operationStatus },
  jobs_cancel: { method: 'POST', path: '/jobs/:id/cancel', output: operationStatus, version: 'required' },
} as const satisfies Record<string, Dto>;
export type WorkspaceDtoName = keyof typeof workspaceDtos;
export type WorkspaceDtoOutput<N extends WorkspaceDtoName> = z.output<(typeof workspaceDtos)[N]['output']>;
export type WorkspaceDtoInput<N extends WorkspaceDtoName> = (typeof workspaceDtos)[N] extends { input: infer S extends z.ZodType }
  ? z.input<S> : Record<string, unknown>;

export function workspaceDto(op: Pick<Operation, 'name' | 'method' | 'path'>): Dto | undefined {
  const dto = Object.hasOwn(workspaceDtos, op.name) ? workspaceDtos[op.name as WorkspaceDtoName] : undefined;
  if (dto?.method === op.method && dto.path === op.path) return dto;
}

export function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema, ...json } = z.toJSONSchema(schema, { target: 'draft-2020-12', io });
  return json;
}
