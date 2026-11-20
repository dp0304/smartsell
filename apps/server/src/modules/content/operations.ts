import { ADMIN, Problem, READ, WRITE, type Context as RestContext, type Operation, type Row } from '@smartsell/contracts';
import { onRevisionCreated } from '../../../../../packages/domain/src/publishing/index.js';
import { operations as executionOperations } from '../execution/ops.js';
import type { Commands, Context, Entity, Fields, Role } from '../types.ts';
import { scanContentFeeds } from './later.js';
import { handleContentEvent } from './revisions.js';

export function commandContext(ctx: RestContext): Context {
  const wrap = (module: string, kind: string, row: Row): Entity => {
    const { id, version, created_at, updated_at, ...data } = row;
    return { id, version, created_at, updated_at, data, module, kind, tenant_id: ctx.tenantId, workspace_id: ctx.workspaceId };
  };
  const credential = (ctx as RestContext & { agentCredentialId?: string }).agentCredentialId;
  return {
    ...(credential && { agentClientId: credential }),
    actorId: ctx.actorId, tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, now: ctx.now, role: ctx.role as Role,
    async get(module, kind, id) {
      try { return wrap(module, kind, ctx.get(kind, id)); }
      catch (error) { if (error instanceof Problem && error.status === 404) return undefined; throw error; }
    },
    async list(module, kind) { return ctx.list(kind).map(row => wrap(module, kind, row)); },
    async insert(module, kind, data) { return wrap(module, kind, ctx.create(kind, data)); },
    async update(module, kind, id, patch, version) {
      const row = ctx.get(kind, id);
      if (row.version !== version) throw new Problem(409, 'VERSION_CONFLICT', 'Resource version has changed', { current_version: row.version });
      return wrap(module, kind, ctx.update(kind, id, patch));
    },
    async emit(event, payload) {
      ctx.emit(event, payload);
      if (event === 'content.revision.created') {
        onRevisionCreated(ctx, ctx.get('content_variant', payload.variant_id), ctx.get('content_revision', payload.revision_id));
      }
    },
  };
}

const upstreamEvents = new Set([
  'commerce.fact.revised', 'commerce.fact.approved', 'commerce.fact.retracted', 'commerce.listing.changed',
  'asset.version.created', 'asset.rights_grant.expiring', 'asset.rights_grant.expired', 'asset.rights_grant.revoked',
  'asset.knowledge.activated', 'asset.knowledge.retired',
]);
export const scanContentDue = (ctx: RestContext) => scanContentFeeds(commandContext(ctx));
export const contentAcceptsEvent = (type: string) => upstreamEvents.has(type);
export function applyContentEvent(ctx: RestContext, event: Fields) {
  const type = typeof event.type === 'string' ? event.type : '';
  if (!contentAcceptsEvent(type)) return;
  return handleContentEvent(commandContext(ctx), type, event.payload ?? event.data ?? {});
}

export function toRest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toRest);
  if (!value || typeof value !== 'object') return value;
  const row = value as Partial<Entity>;
  if (row.data && typeof row.kind === 'string' && typeof row.module === 'string' && typeof row.version === 'number') {
    return { ...row.data, id: row.id, version: row.version, created_at: row.created_at, updated_at: row.updated_at };
  }
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, toRest(entry)]));
}

const requestPostOperation = executionOperations.find(operation => operation.name === 'posts_request_operation')!;
const human = WRITE.filter(role => role !== 'agent');
export function makeOperations(commands: Commands): Operation[] {
  function route(method: Operation['method'], path: string, name: string, summary: string, options: {
    roles?: Operation['roles']; kind?: string; action?: string; select?: string; remap?: Record<string, string>;
  } = {}): Operation {
    const action = options.action ?? name;
    return { method, path, name, summary, roles: options.roles ?? (method === 'GET' ? READ : human), versionKind: options.kind,
      async run(ctx, input) {
        const fields: Fields = { ...input.query, ...input.body, ...input.params };
        for (const [from, to] of Object.entries(options.remap ?? {})) if (input.params[from] !== undefined) fields[to] = input.params[from];
        if (input.params.id) {
          const collection = path.split('/')[1];
          const resourceIds: Record<string, string> = { 'content-pillars': 'pillar_id', ideas: 'idea_id', 'content-items': 'content_item_id',
            'content-variants': 'variant_id', 'content-revisions': 'revision_id', 'translation-links': 'translation_link_id',
            'content-transcripts': 'transcript_id', feeds: 'feed_source_id', 'feed-items': 'feed_item_id', 'platform-posts': 'platform_post_id' };
          const field = collection && resourceIds[collection];
          if (field) fields[field] = input.params.id;
          if (name === 'content_create_translation') fields.source_variant_id = input.params.id;
          if (name === 'content_get') delete fields.variant_id;
        }
        if (input.expectedVersion !== undefined) fields.expected_version = input.expectedVersion;
        if (method === 'GET' && name === 'content_list_stale' && typeof fields.reason === 'string') fields.reason = fields.reason.split(',');
        // The reviewed change-set contract pins the row version and sends only its text patch.
        if (action === 'content_update_variant' && fields.base_revision_id === undefined && input.expectedVersion !== undefined && input.params.id &&
            Object.keys(input.body).length === 1 && typeof input.body.body_markdown === 'string') {
          const row = ctx.get('content_variant', input.params.id);
          fields.base_revision_id = row.version === input.expectedVersion ? row.current_revision_id ?? null : undefined;
          if (row.version !== input.expectedVersion) throw new Problem(409, 'VERSION_CONFLICT', 'Content has changed since editing started', { current_version: row.version, current_revision_id: row.current_revision_id, current_draft: row.draft_doc });
        }
        try {
          const result = await commands[action]!.run(commandContext(ctx), fields);
          if (action === 'content_request_post_maintenance') {
            const request = result as Entity;
            const { action: maintenance, new_revision_id } = request.data;
            const caption = maintenance === 'edit' ? ctx.get('content_revision', new_revision_id).body : undefined;
            const operation = await requestPostOperation.run(ctx, { ...input, body: {
              kind: maintenance === 'edit' ? 'edit_caption' : maintenance, reason: fields.reason ?? 'Content maintenance requested',
              ...(caption !== undefined ? { after_payload: { caption } } : {}),
            } }) as Row;
            return ctx.update('post_maintenance_request', request.id, { status: operation.status, post_operation_id: operation.id });
          }
          return toRest(options.select ? (result as Fields)[options.select] : result);
        } catch (error) {
          if (error instanceof Error && 'code' in error && 'status' in error && typeof error.code === 'string' && typeof error.status === 'number' && !(error instanceof Problem)) {
            throw new Problem(error.status, error.code, error.message, (error as { details?: Fields }).details);
          }
          throw error;
        }
      },
    };
  }
  return [
    route('GET', '/content-pillars', 'content_list_pillars', 'List content pillars'),
    route('POST', '/content-pillars', 'content_create_pillar', 'Create a content pillar', { roles: ADMIN }),
    route('GET', '/content-pillars/:id', 'content_get_pillar', 'Get a content pillar'),
    route('PATCH', '/content-pillars/:id', 'content_update_pillar', 'Update a content pillar', { kind: 'content_pillar', roles: ADMIN }),
    route('DELETE', '/content-pillars/:id', 'content_archive_pillar', 'Archive a content pillar', { kind: 'content_pillar', roles: ADMIN }),
    route('GET', '/ideas', 'idea_list', 'List content ideas'),
    route('POST', '/ideas', 'idea_create', 'Create an idea with evidence', { roles: WRITE }),
    route('POST', '/ideas/from-conversation', 'idea_create_from_conversation', 'Capture a customer question as an idea'),
    route('GET', '/ideas/:id', 'idea_get', 'Get a content idea'),
    route('PATCH', '/ideas/:id', 'idea_update', 'Update a content idea', { kind: 'idea' }),
    route('POST', '/ideas/:id/convert', 'idea_convert', 'Convert an idea to a content item'),
    route('GET', '/content-items', 'content_list', 'List content items'),
    route('GET', '/content-items/workload', 'content_production_workload', 'List outstanding production work by assignee', { roles: READ.filter(role => role !== 'agent') }),
    route('POST', '/content-items', 'content_create_item', 'Create a content item'),
    route('POST', '/content-items/draft', 'content_create_draft', 'Create agent drafts', { roles: WRITE }),
    route('GET', '/content-items/:id', 'content_get', 'Get content details'),
    route('PATCH', '/content-items/:id', 'content_item_update', 'Update a content item', { kind: 'content_item', action: 'content_update_item', roles: WRITE }),
    route('POST', '/content-items/:id/stage', 'content_set_stage', 'Advance production stage', { kind: 'content_item' }),
    route('POST', '/content-items/:id/variants', 'content_create_variant', 'Create a draft variant'),
    route('GET', '/content-items/:id/export', 'content_export_item', 'Export a portable content package', { roles: human }),
    route('POST', '/content-items/:id/duplicate', 'content_duplicate', 'Duplicate a content item with lineage'),
    route('POST', '/content-items/:id/handoff-checklist', 'content_record_handoff_checklist', 'Record handoff checklist results'),
    route('GET', '/content-variants/stale', 'content_list_stale', 'List stale content variants'),
    route('POST', '/content-variants/batch', 'content_batch_variants', 'Preview or commit batch draft changes', { roles: WRITE }),
    route('GET', '/content-variants/:id', 'content_get_variant', 'Get variant details and preview'),
    route('GET', '/content-variants/:id/product-facts', 'content_list_product_facts', 'List approved product facts available to a content variant'),
    route('POST', '/content-variants/:id/product-facts', 'content_insert_product_fact', 'Insert an approved product fact into the working draft', { kind: 'content_variant' }),
    route('GET', '/content-variants/:id/product-prices', 'content_list_product_prices', 'List current listing prices eligible for a content variant'),
    route('POST', '/content-variants/:id/product-prices', 'content_insert_product_price', 'Insert a current market price into the working draft', { kind: 'content_variant' }),
    route('PATCH', '/content-variants/:id', 'content_autosave_variant', 'Save a working draft', { kind: 'content_variant' }),
    route('POST', '/content-variants/:id/renditions', 'content_request_rendition', 'Request an asset rendition for working-draft media', { kind: 'content_variant' }),
    route('POST', '/content-variants/:id/agent-edit', 'content_update_variant', 'Commit a version-checked agent edit', { roles: WRITE, select: 'variant' }),
    route('POST', '/content-variants/:id/revisions', 'content_commit_revision', 'Commit an immutable revision'),
    route('GET', '/content-variants/:id/revisions', 'content_list_revisions', 'List immutable revisions'),
    route('GET', '/content-revisions/:id', 'content_get_revision', 'Get an immutable revision'),
    route('GET', '/content-revisions/:a/diff/:b', 'content_diff_revisions', 'Compare immutable revisions', { remap: { a: 'revision_a', b: 'revision_b' } }),
    route('POST', '/content-revisions/:id/restore', 'content_restore_revision', 'Restore a revision as a new revision'),
    route('POST', '/content-variants/:id/validate', 'content_validate_variant', 'Validate content and build a platform preview', { roles: READ }),
    route('POST', '/content-variants/:id/readiness', 'content_set_readiness', 'Mark a committed variant ready', { kind: 'content_variant' }),
    route('GET', '/content-variants/:id/translations', 'content_list_translations', 'List translation links'),
    route('POST', '/content-variants/:id/translations', 'content_create_translation', 'Create a localized variant', { roles: WRITE }),
    route('POST', '/translation-links/:id/accept-source-change', 'content_accept_source_change', 'Review the changed translation source', { kind: 'translation_link' }),
    route('POST', '/translation-links/:id/mark-divergence', 'content_mark_divergence', 'Record a deliberate market rewrite', { kind: 'translation_link' }),
    route('GET', '/feeds', 'content_list_feeds', 'List import feeds', { roles: ADMIN }),
    route('POST', '/feeds', 'content_create_feed', 'Create an import feed', { roles: ADMIN }),
    route('GET', '/feeds/:id', 'content_get_feed', 'Get an import feed', { roles: ADMIN }),
    route('PATCH', '/feeds/:id', 'content_update_feed', 'Edit an import feed', { kind: 'feed_source', roles: ADMIN }),
    route('DELETE', '/feeds/:id', 'content_archive_feed', 'Archive an import feed', { kind: 'feed_source', roles: ADMIN }),
    route('POST', '/feeds/:id/poll', 'content_poll_feed', 'Request a feed poll', { roles: ADMIN }),
    route('POST', '/feeds/:id/preview-import', 'content_preview_feed_import', 'Preview a link or normalized content file', { kind: 'feed_source', roles: ADMIN }),
    route('GET', '/feeds/:id/items', 'content_list_feed_items', 'Preview normalized feed items'),
    route('POST', '/feed-items/:id/import', 'content_import_feed_item', 'Import a feed item as an idea'),
    route('POST', '/platform-posts/:id/maintenance', 'content_request_post_maintenance', 'Request post maintenance'),
    route('GET', '/content-transcripts/:id', 'content_get_transcript', 'Read a transcription and review status'),
    route('PATCH', '/content-transcripts/:id', 'content_review_transcript', 'Review and correct a transcript', { kind: 'transcript' }),
    route('POST', '/content-transcripts', 'content_request_transcript', 'Request a transcript'),
  ];
}