import { type Context, type Data, type Row } from '@smartsell/contracts';
import { change, choice, conflict, integer, invalid, operation, services, tenantScope, tenantStore, upsert, type OpsContext } from './support.js';

type ReferenceStore = Pick<Context, 'list'>;

const classes = ['raw_record', 'tool_call', 'audit_event', 'evidence', 'asset_file', 'metric_observation', 'message',
  'customer_pii', 'export_file', 'operation', 'store_pii_amazon'] as const;
type DataClass = typeof classes[number];
const DAY = 86_400_000;
const defaults: Partial<Record<DataClass, number | null>> = { raw_record: 90, tool_call: 180, audit_event: 730, evidence: null, store_pii_amazon: 30 };

export function getRetentionPolicy(ctx: Context, dataClass: string): Data | undefined {
  const kind = choice(dataClass, 'data_class', classes);
  const scoped = ctx.list('retention_policy').find(row => row.data_class === kind);
  const inherited = tenantScope(ctx)?.list('retention_policy').find(row => row.data_class === kind);
  if (scoped || inherited) {
    const policy = { ...(scoped ?? inherited), inherited: !scoped };
    if (kind === 'store_pii_amazon') {
      const days = [scoped?.retain_days, inherited?.retain_days].filter((value): value is number =>
        typeof value === 'number' && Number.isInteger(value) && value >= 0);
      return { ...policy, retain_days: Math.min(30, ...days) };
    }
    return policy;
  }
  if (defaults[kind] === undefined) return;
  const retain_days = defaults[kind];
  return { data_class: kind, retain_days, retain_mode: retain_days === null ? 'follow_resource' : 'fixed_days',
    retain_anchor: kind === 'store_pii_amazon' ? 'order_delivered_at' : 'created_at',
    workspace_override: kind === 'store_pii_amazon' ? 'shorten_only' : 'any', action: 'delete', legal_hold: false, inherited: true };
}

function setPolicy(ctx: Context, values: Data): Row {
  const dataClass = choice(values.data_class, 'data_class', classes);
  const scope = choice(values.scope ?? 'workspace', 'scope', ['workspace', 'default'] as const);
  const store = scope === 'default' ? tenantStore(ctx) : ctx;
  const retainMode = choice(values.retain_mode ?? 'fixed_days', 'retain_mode', ['fixed_days', 'follow_resource'] as const);
  if (retainMode === 'follow_resource' && dataClass !== 'evidence') invalid('Only evidence can follow its parent resource');
  const tenantDays = tenantScope(ctx)?.list('retention_policy').find(row => row.data_class === dataClass)?.retain_days;
  const amazonCeiling = scope === 'workspace' && typeof tenantDays === 'number' ? Math.min(30, tenantDays) : 30;
  const retainDays = retainMode === 'fixed_days' ? integer(values.retain_days, 'retain_days', 0, dataClass === 'store_pii_amazon' ? amazonCeiling : 36500) : null;
  const action = choice(values.action ?? 'delete', 'action', ['delete', 'anonymize', 'archive'] as const);
  if (dataClass === 'audit_event' && (action === 'anonymize' || Number(retainDays) < 730)) invalid('Audit records require at least 730 days and may only be archived or deleted');
  if (values.legal_hold !== undefined && typeof values.legal_hold !== 'boolean') invalid('legal_hold must be a boolean');
  if (dataClass === 'store_pii_amazon' && (retainDays === null || action !== 'delete' || values.legal_hold === true)) {
    invalid('Amazon misstored PII requires deletion within the mandatory deadline');
  }
  return change(ctx, 'ops.retention.policy_updated', 'retention_policy', upsert(store, 'retention_policy', { data_class: dataClass }, {
    workspace_id: scope === 'workspace' ? ctx.workspaceId : null, retain_mode: retainMode, retain_days: retainDays, action,
    retain_anchor: dataClass === 'store_pii_amazon' ? 'order_delivered_at' : 'created_at',
    workspace_override: dataClass === 'store_pii_amazon' ? 'shorten_only' : 'any', legal_hold: values.legal_hold ?? false,
  }));
}

function expires(ctx: Context, kind: DataClass, row: Row, policy: Data): boolean {
  if (policy.retain_mode === 'follow_resource') {
    const parentKinds = ['work', 'content_item', 'publish_target'];
    return typeof row.resource_id === 'string' && parentKinds.includes(String(row.resource_type))
      && !ctx.list(String(row.resource_type)).some(parent => parent.id === row.resource_id);
  }
  if (typeof policy.retain_days !== 'number') return false;
  const days = kind === 'raw_record' && typeof row.cache_days === 'number' && row.cache_days >= 0
    ? Math.min(policy.retain_days, row.cache_days) : policy.retain_days;
  return Date.parse(row.created_at) + days * DAY <= Date.parse(ctx.now);
}

function assetResourceIds(ctx: ReferenceStore, row: Row) {
  const ids = new Set<unknown>([row.id]);
  if (typeof row.asset_id === 'string') ids.add(row.asset_id);
  const versionIds = new Set<unknown>();
  for (const rendition of ctx.list('asset_rendition')) {
    if (rendition.file_object_id !== row.id) continue;
    ids.add(rendition.id);
    if (typeof rendition.asset_version_id === 'string') versionIds.add(rendition.asset_version_id);
  }
  for (const version of ctx.list('asset_version')) {
    if (!versionIds.has(version.id) && ![version.file_object_id, version.thumbnail_file_id, version.thumbnail_file_object_id].includes(row.id)) continue;
    ids.add(version.id);
    if (typeof version.asset_id === 'string') ids.add(version.asset_id);
  }
  return ids;
}

const referenceMatches = (ids: Set<unknown>, record: Data) =>
  ['asset_id', 'asset_ids', 'asset_version_id', 'asset_version_ids', 'rendition_id', 'caption_rendition_id',
    'asset_file_id', 'asset_file_ids', 'file_object_id', 'evidence_id', 'resource_id', 'resource_ids', 'ref_id']
    .some(key => ids.has(record[key]) || (Array.isArray(record[key]) && record[key].some(id => ids.has(id))));

function scheduledReference(ctx: ReferenceStore, ids: Set<unknown>) {
  const matches = (row: Data) => referenceMatches(ids, row);
  const targetIds = new Set(ctx.list('publish_target_ref').filter(matches).map(ref => ref.publish_target_id ?? ref.target_id));
  const revisionIds = new Set(ctx.list('content_reference').filter(matches).map(ref => ref.revision_id)
    .filter((id): id is string => typeof id === 'string'));
  // A draft or pending approval can already pin media before planning writes the target references.
  for (const revision of ctx.list('content_revision')) {
    if (matches(revision) || (Array.isArray(revision.media) && revision.media.some(item => item && typeof item === 'object' && matches(item)))) {
      revisionIds.add(revision.id);
    }
  }
  const variantIds = new Set(ctx.list('content_variant').filter(matches).map(row => row.id));
  const terminal = ['cancelled', 'done', 'published', 'failed', 'skipped', 'verified'];
  return ctx.list('publish_target').some(target => !terminal.includes(String(target.plan_status ?? target.status))
    && (matches(target) || targetIds.has(target.id)
      || [target.variant_revision_id, target.content_revision_id, target.revision_id].some(id => typeof id === 'string' && revisionIds.has(id))
      || variantIds.has(String(target.content_variant_id ?? target.variant_id))));
}

export function scheduledAssetReference(ctx: ReferenceStore, row: Row) {
  return scheduledReference(ctx, assetResourceIds(ctx, row));
}

function references(ctx: Context, kind: DataClass, row: Row, policy: Data, hasHandler = Boolean(services(ctx).applyRetention)): string[] {
  const refs: string[] = [];
  if (row.legal_hold === true || policy.legal_hold === true || tenantScope(ctx)?.list('retention_policy')
    .some(item => item.data_class === kind && item.legal_hold === true)) refs.push('legal_hold');
  const resourceIds = kind === 'asset_file' ? assetResourceIds(ctx, row) : new Set<unknown>([row.id]);
  const matches = (other: Row) => referenceMatches(resourceIds, other);
  if (scheduledReference(ctx, resourceIds)) refs.push('scheduled_target');
  const grantIds = new Set(ctx.list('rights_grant_asset').filter(matches).map(link => link.rights_grant_id));
  if (ctx.list('rights_grant').some(grant => !['revoked', 'expired', 'draft'].includes(String(grant.status))
    && (!grant.expires_at || String(grant.expires_at) > ctx.now) && (matches(grant) || grantIds.has(grant.id)))) refs.push('active_rights');
  if (ctx.list('case').some(item => !['closed', 'resolved'].includes(String(item.status)) && matches(item))) refs.push('open_case');
  refs.push(...(services(ctx).retentionReferences?.(ctx, kind, row) ?? []));
  if ((['asset_file', 'evidence', 'export_file'].includes(kind) || policy.action !== 'delete') && !hasHandler) {
    refs.push('retention_handler_unavailable');
  }
  return [...new Set(refs)];
}

function preview(ctx: Context, kind: DataClass) {
  if (kind === 'store_pii_amazon') invalid('Amazon PII is removed by the ingestion compliance job');
  const policy = getRetentionPolicy(ctx, kind) ?? invalid('Configure a retention policy first');
  const candidates: { resource_id: string; version: number }[] = [];
  const blocked_by: { resource_id: string; reasons: string[] }[] = [];
  const media = kind === 'asset_file' ? (ctx as OpsContext).assetFileRetention : undefined;
  const files = new Map(media ? ctx.list('file_object').map(row => [row.id, row]) : []);
  const record = (row: Row, reasons: string[]) => {
    if (reasons.length > 0) blocked_by.push({ resource_id: row.id, reasons });
    else candidates.push({ resource_id: row.id, version: row.version });
  };
  for (const row of ctx.list(kind)) {
    if (!files.has(row.id) && expires(ctx, kind, row, policy)) record(row, references(ctx, kind, row, policy));
  }
  for (const item of media?.candidates(ctx) ?? []) {
    const row = files.get(item.id);
    if (row) record(row, [...new Set([...references(ctx, kind, row, policy, true), ...item.blocked_by])]);
  }
  return { policy, candidates, blocked_by };
}

export const retentionOperations = [
  operation('GET', '/retention-policies', 'ops_list_retention_policy', 'Read effective workspace retention policies', ctx => classes
    .map(kind => getRetentionPolicy(ctx, kind)).filter(Boolean)),
  operation('PUT', '/retention-policies', 'ops_set_retention_policy', 'Set retention policy', (ctx, {body}) => setPolicy(ctx, body)),
  operation('GET', '/purge-runs', 'ops_list_purge_run', 'List retention runs', ctx => ctx.list('purge_run')),
  operation('POST', '/purge-runs', 'ops_preview_purge_run', 'Preview eligible and blocked retention records', (ctx, {body}) => {
    const dataClass = choice(body.data_class, 'data_class', classes);
    return ctx.create('purge_run', { data_class: dataClass, status: 'previewed', preview: preview(ctx, dataClass) });
  }),
  operation('POST', '/purge-runs/:id/approve', 'ops_approve_purge_run', 'Approve and execute the reviewed retention run', (ctx, {params}) => {
    const run = ctx.get('purge_run', params.id);
    if (run.status === 'completed') return run;
    if (run.status !== 'previewed') conflict('invalid_purge_state', 'A purge preview is required');
    const kind = choice(run.data_class, 'data_class', classes);
    const prior = run.preview as ReturnType<typeof preview>;
    const current = preview(ctx, kind);
    if (prior.policy.action !== current.policy.action) conflict('retention_policy_changed', 'The purge action changed. Create a new preview');
    const fresh = new Map(current.candidates.map(item => [item.resource_id, item.version]));
    const purged: string[] = [];
    const skipped: string[] = [];
    const media = kind === 'asset_file' ? (ctx as OpsContext).assetFileRetention : undefined;
    const fileIds = new Set(media ? ctx.list('file_object').map(row => row.id) : []);
    const files: { id: string; version: number }[] = [];
    for (const candidate of prior.candidates) {
      if (fresh.get(candidate.resource_id) !== candidate.version) {
        skipped.push(candidate.resource_id);
        continue;
      }
      if (media && fileIds.has(candidate.resource_id)) {
        files.push({ id: candidate.resource_id, version: candidate.version });
        continue;
      }
      const handler = services(ctx).applyRetention;
      if (handler) handler(ctx, kind, ctx.get(kind, candidate.resource_id), String(current.policy.action));
      else ctx.remove(kind, candidate.resource_id);
      purged.push(candidate.resource_id);
    }
    if (files.length && media) {
      const result = media.purge(ctx, files);
      purged.push(...result.deleted);
      skipped.push(...result.skipped);
    }
    return change(ctx, 'ops.retention.purge_completed', 'purge_run', ctx.update('purge_run', run.id, {
      status: 'completed', approved_by: ctx.actorId, completed_at: ctx.now, purged, skipped, blocked_by: current.blocked_by,
    }), { data_class: kind, purged_count: purged.length, skipped_count: skipped.length });
  }),
];
