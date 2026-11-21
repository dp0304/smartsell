import { createHash } from 'node:crypto';

export const browserApps = Object.freeze(['douyin', 'xhs'] as const);
export const mobileApps = Object.freeze(['douyin', 'xhs', 'tiktok', 'instagram', 'facebook'] as const);
export const browserPublishKinds = Object.freeze(['douyin.video.publish', 'xhs.note.publish'] as const);
export const mobilePublishKinds = Object.freeze(['douyin.app.publish', 'xhs.app.publish', 'tiktok.app.publish', 'instagram.app.publish', 'facebook.app.publish'] as const);
export const taskKinds = Object.freeze([...browserPublishKinds, ...mobilePublishKinds, 'session.verify_identity', 'mobile.verify_app_identity',
  'mobile.push_media', 'mobile.cleanup_media', 'post.capture_result', 'post.verify_visible'] as const);
export type PlatformApp = typeof mobileApps[number];
export type ConnectorMode = 'assist' | 'auto';
export type BrowserTarget = { channel: 'browser'; profile_id: string; app: typeof browserApps[number] };
export type MobileTarget = { channel: 'mobile'; mobile_device_id: string; app: PlatformApp };
export type Target = BrowserTarget | MobileTarget;
export type MediaRef = { id: string; sha256: string };
export type FrozenRevision = {
  id: string; title: string; body: string; tags: string[]; visibility: 'public' | 'private' | 'friends'; media: MediaRef[];
  draft?: { publish_id: string; allow_comments: boolean; allow_duet: boolean; allow_stitch: boolean; commercial_disclosure: boolean };
};
export type PublishPayload = { revision: FrozenRevision; approval: { id: string; resource_hash: string }; frozen_hash: string };
export type TaskBase = { schema_version: 1; workspace_id: string; attempt_id: string; connector_device_id: string;
  account_id: string; binding_id: string; platform_identity: string };
type Variant<K, T, P> = TaskBase & { kind: K; target: T; payload: P };
export type PublishTask = Variant<typeof browserPublishKinds[number], BrowserTarget, PublishPayload> | Variant<typeof mobilePublishKinds[number], MobileTarget, PublishPayload>;
export type ConnectorTask = PublishTask
  | Variant<'session.verify_identity', BrowserTarget, Record<string, never>>
  | Variant<'mobile.verify_app_identity', MobileTarget, Record<string, never>>
  | Variant<'mobile.push_media', MobileTarget, PublishPayload>
  | Variant<'mobile.cleanup_media', MobileTarget, { source_attempt_id: string; platform_post_id: string; media: MediaRef[] }>
  | Variant<'post.capture_result', Target, { source_attempt_id: string; platform_post_id?: string }>
  | Variant<'post.verify_visible', Target, { source_attempt_id: string; platform_post_id: string }>;
export type ConnectorClaim = { task: ConnectorTask; effective_mode: ConnectorMode; fencing_token: number; write_slot_token: number; lease_expires_at: string };
export type EvidenceKind = 'masked_screenshot' | 'masked_ui_hierarchy';
export type EvidenceRef = { kind: EvidenceKind; sha256: string; object_id: string };
export type PostResult = { platform_post_id: string; result_url: string; evidence: EvidenceRef[] };

export class ConnectorSchemaError extends Error {
  constructor(field: string) { super(`Invalid connector field: ${field}`); this.name = 'ConnectorSchemaError'; }
}
export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ConnectorSchemaError('object');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (!required.includes(key) && !optional.includes(key)) || !descriptor?.enumerable || !('value' in descriptor)) {
      throw new ConnectorSchemaError('unexpected key');
    }
  }
  for (const key of required) if (!Object.hasOwn(value, key)) throw new ConnectorSchemaError(key);
  return value as Record<string, unknown>;
}
export function opaqueId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_@-][A-Za-z0-9_.:@-]{0,127}$/.test(value)) throw new ConnectorSchemaError(field);
  return value;
}
export function sha256(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new ConnectorSchemaError(field);
  return value;
}
export function timestamp(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)) throw new ConnectorSchemaError(field);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== (value.length === 20 ? value.replace(/Z$/, '.000Z') : value)) throw new ConnectorSchemaError(field);
  return value;
}
export function positiveInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new ConnectorSchemaError(field);
  return value;
}
export function parseChoice<const T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const match = choices.find(choice => choice === value);
  if (match === undefined) throw new ConnectorSchemaError(field);
  return match;
}
function text(value: unknown, field: string, max: number, min = 0): string {
  if (typeof value !== 'string' || value.length < min || value.length > max || /\u0000/.test(value)) throw new ConnectorSchemaError(field);
  return value;
}
function flag(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ConnectorSchemaError(field);
  return value;
}
function list<T>(value: unknown, max: number, parse: (item: unknown) => T): T[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > max || Reflect.ownKeys(value).length !== value.length + 1) throw new ConnectorSchemaError('array');
  return Array.from({ length: value.length }, (_, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !('value' in descriptor)) throw new ConnectorSchemaError('array entry');
    return parse(descriptor.value);
  });
}
export function parsePostResult(value: unknown, expectedPost?: string): PostResult {
  const row = fields(value, ['platform_post_id', 'result_url', 'evidence']);
  const platform_post_id = opaqueId(row.platform_post_id, 'platform_post_id');
  if (expectedPost !== undefined && platform_post_id !== expectedPost) throw new ConnectorSchemaError('platform_post_id');
  const url = URL.parse(text(row.result_url, 'result_url', 2048, 1));
  if (!url || url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || url.search || url.pathname === '/') {
    throw new ConnectorSchemaError('result_url');
  }
  const evidence = list(row.evidence, 8, item => {
    const ref = fields(item, ['kind', 'sha256', 'object_id']);
    return { kind: parseChoice(ref.kind, ['masked_screenshot', 'masked_ui_hierarchy'], 'evidence.kind'),
      sha256: sha256(ref.sha256, 'evidence.sha256'), object_id: opaqueId(ref.object_id, 'evidence.object_id') };
  });
  if (!evidence.length || new Set(evidence.map(ref => ref.object_id)).size !== evidence.length) throw new ConnectorSchemaError('evidence');
  return { platform_post_id, result_url: url.href, evidence };
}
function parseMedia(value: unknown): MediaRef[] {
  const media = list(value, 20, item => {
    const { id, sha256: digest } = fields(item, ['id', 'sha256']);
    return { id: opaqueId(id, 'media.id'), sha256: sha256(digest, 'media.sha256') };
  });
  if (new Set(media.map(item => item.id)).size !== media.length) throw new ConnectorSchemaError('duplicate media');
  return media;
}
export function parseFrozenRevision(value: unknown): FrozenRevision {
  const row = fields(value, ['id', 'title', 'body', 'tags', 'visibility', 'media'], ['draft']);
  const revision: FrozenRevision = {
    id: opaqueId(row.id, 'revision.id'), title: text(row.title, 'title', 300), body: text(row.body, 'body', 10000),
    tags: list(row.tags, 30, item => text(item, 'tag', 100, 1)),
    visibility: parseChoice(row.visibility, ['public', 'private', 'friends'], 'visibility'), media: parseMedia(row.media),
  };
  if (Object.hasOwn(row, 'draft')) {
    const draft = fields(row.draft, ['publish_id', 'allow_comments', 'allow_duet', 'allow_stitch', 'commercial_disclosure']);
    revision.draft = { publish_id: opaqueId(draft.publish_id, 'publish_id'), allow_comments: flag(draft.allow_comments, 'allow_comments'),
      allow_duet: flag(draft.allow_duet, 'allow_duet'), allow_stitch: flag(draft.allow_stitch, 'allow_stitch'), commercial_disclosure: flag(draft.commercial_disclosure, 'commercial_disclosure') };
  }
  return revision;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
export function frozenRevisionHash(value: unknown): string { return createHash('sha256').update(canonical(parseFrozenRevision(value))).digest('hex'); }
function parsePublish(value: unknown, app: PlatformApp): PublishPayload {
  const row = fields(value, ['revision', 'approval', 'frozen_hash']);
  const revision = parseFrozenRevision(row.revision);
  const approval = fields(row.approval, ['id', 'resource_hash']);
  const resource_hash = sha256(approval.resource_hash, 'resource_hash');
  const frozen_hash = sha256(row.frozen_hash, 'frozen_hash');
  if (resource_hash !== frozen_hash || frozenRevisionHash(revision) !== frozen_hash) throw new ConnectorSchemaError('approval/frozen hash');
  if (app === 'tiktok' ? !revision.draft || revision.media.length : revision.draft || !revision.media.length) throw new ConnectorSchemaError('platform revision');
  return { revision, approval: { id: opaqueId(approval.id, 'approval.id'), resource_hash }, frozen_hash };
}
function parseTarget(value: unknown): Target {
  const row = fields(value, ['channel', 'app'], ['profile_id', 'mobile_device_id']);
  if (row.channel === 'browser' && !Object.hasOwn(row, 'mobile_device_id')) {
    return { channel: 'browser', app: parseChoice(row.app, browserApps, 'app'), profile_id: opaqueId(row.profile_id, 'profile_id') };
  }
  if (row.channel === 'mobile' && !Object.hasOwn(row, 'profile_id')) {
    return { channel: 'mobile', app: parseChoice(row.app, mobileApps, 'app'), mobile_device_id: opaqueId(row.mobile_device_id, 'mobile_device_id') };
  }
  throw new ConnectorSchemaError('target');
}
export function parseConnectorTask(value: unknown): ConnectorTask {
  const row = fields(value, ['schema_version', 'kind', 'workspace_id', 'attempt_id', 'connector_device_id', 'account_id', 'binding_id', 'platform_identity', 'target', 'payload']);
  if (row.schema_version !== 1) throw new ConnectorSchemaError('schema_version');
  const kind = parseChoice(row.kind, taskKinds, 'kind');
  const target = parseTarget(row.target);
  const base = {
    schema_version: 1 as const, workspace_id: opaqueId(row.workspace_id, 'workspace_id'), attempt_id: opaqueId(row.attempt_id, 'attempt_id'),
    connector_device_id: opaqueId(row.connector_device_id, 'connector_device_id'), account_id: opaqueId(row.account_id, 'account_id'),
    binding_id: opaqueId(row.binding_id, 'binding_id'), platform_identity: opaqueId(row.platform_identity, 'platform_identity'),
  };
  switch (kind) {
    case 'session.verify_identity':
      if (target.channel !== 'browser') break;
      fields(row.payload, []);
      return { ...base, target, kind, payload: {} };
    case 'mobile.verify_app_identity':
      if (target.channel !== 'mobile') break;
      fields(row.payload, []);
      return { ...base, target, kind, payload: {} };
    case 'post.capture_result': {
      const ref = fields(row.payload, ['source_attempt_id'], ['platform_post_id']);
      return { ...base, target, kind, payload: { source_attempt_id: opaqueId(ref.source_attempt_id, 'source_attempt_id'),
        ...(Object.hasOwn(ref, 'platform_post_id') && { platform_post_id: opaqueId(ref.platform_post_id, 'platform_post_id') }) } };
    }
    case 'post.verify_visible': {
      if (target.app === 'tiktok') break;
      const ref = fields(row.payload, ['source_attempt_id', 'platform_post_id']);
      return { ...base, target, kind, payload: { source_attempt_id: opaqueId(ref.source_attempt_id, 'source_attempt_id'), platform_post_id: opaqueId(ref.platform_post_id, 'platform_post_id') } };
    }
    case 'mobile.cleanup_media': {
      if (target.channel !== 'mobile' || target.app === 'tiktok') break;
      const ref = fields(row.payload, ['source_attempt_id', 'platform_post_id', 'media']);
      const media = parseMedia(ref.media);
      if (!media.length) throw new ConnectorSchemaError('cleanup media');
      return { ...base, target, kind, payload: { source_attempt_id: opaqueId(ref.source_attempt_id, 'source_attempt_id'), platform_post_id: opaqueId(ref.platform_post_id, 'platform_post_id'), media } };
    }
    case 'mobile.push_media':
      if (target.channel !== 'mobile' || target.app === 'tiktok') break;
      return { ...base, target, kind, payload: parsePublish(row.payload, target.app) };
    case 'douyin.video.publish':
    case 'xhs.note.publish':
      if (target.channel !== 'browser' || !kind.startsWith(`${target.app}.`)) break;
      return { ...base, target, kind, payload: parsePublish(row.payload, target.app) };
    default:
      if (target.channel !== 'mobile' || !kind.startsWith(`${target.app}.`)) break;
      return { ...base, target, kind, payload: parsePublish(row.payload, target.app) };
  }
  throw new ConnectorSchemaError('task channel or platform');
}
export function parseConnectorClaim(value: unknown): ConnectorClaim {
  const row = fields(value, ['task', 'effective_mode', 'fencing_token', 'write_slot_token', 'lease_expires_at']);
  return { task: parseConnectorTask(row.task), effective_mode: parseChoice(row.effective_mode, ['assist', 'auto'], 'effective_mode'),
    fencing_token: positiveInteger(row.fencing_token, 'fencing_token'), write_slot_token: positiveInteger(row.write_slot_token, 'write_slot_token'),
    lease_expires_at: timestamp(row.lease_expires_at, 'lease_expires_at') };
}
