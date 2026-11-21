import { createHash } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Entity, Fields } from './modules/types.js';
import { externalParents, mappings, type Mapping } from './postgres-domain-mappings.js';
import type { Scope } from './store.js';

const snapshotModule = 'operation_runtime';
const snapshotKind = 'record';
const textIds = new Set(['external_account_id', 'external_principal_id', 'external_post_id', 'external_store_id',
  'external_product_id', 'external_variant_id', 'client_request_id', 'lease_owner_id']);
const constrainedKinds = new Set(['brand', 'product', 'campaign', 'content_revision']);
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const key = (kind: string, id: string) => JSON.stringify([kind, id]);
const recordKey = (kind: string, id: string) => `row/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`;
const mapping = (kind: string) => Object.hasOwn(mappings, kind) ? mappings[kind] : undefined;
const directModule = (kind: string) => kind.startsWith('approval_') ? 'core' : mapping(kind)?.table.split('.')[0];
interface LateLink { column: string; target: string; inverse?: string }
const lateLinks: Readonly<Partial<Record<string, LateLink[]>>> = {
  brand: [{ column: 'default_market_id', target: 'market', inverse: 'brand_id' }],
  content_variant: [{ column: 'current_revision_id', target: 'content_revision', inverse: 'variant_id' }],
  publish_target: [
    { column: 'execution_task_id', target: 'execution_task', inverse: 'publish_target_id' },
    { column: 'last_precheck_run_id', target: 'precheck_run', inverse: 'publish_target_id' },
  ],
  execution_task: [
    { column: 'active_attempt_id', target: 'execution_attempt', inverse: 'task_id' },
    { column: 'platform_post_id', target: 'platform_post', inverse: 'execution_task_id' },
  ],
};
const linksFor = (kind: string) => Object.hasOwn(lateLinks, kind) ? lateLinks[kind]! : [];

interface DomainRow {
  kind: string;
  id: string;
  created_at: string;
  updated_at: string;
  version: number;
  data: Fields;
}

function decode(entity: Entity): DomainRow | undefined {
  if (entity.module !== snapshotModule) {
    if (entity.module === directModule(entity.kind)) return entity;
    return undefined;
  }
  if (entity.kind !== snapshotKind || typeof entity.data.value !== 'string') return undefined;
  const match = /^row\/([a-z_]+)\/([^/]+)$/.exec(entity.id);
  if (!match || !mapping(match[1]!)) return undefined;
  const kind = match[1]!;
  const value: unknown = JSON.parse(entity.data.value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { id, version, created_at, updated_at, ...data } = value as Fields;
  if (typeof id !== 'string' || entity.id !== recordKey(kind, id) || !Number.isSafeInteger(version) || version < 1 ||
      typeof created_at !== 'string' || typeof updated_at !== 'string') return undefined;
  return { kind, id, version, created_at, updated_at, data };
}

function domainId(scope: Scope, kind: string, id: unknown): string | null {
  if (typeof id !== 'string') return null;
  if (uuid.test(id)) return id.toLowerCase();
  // The account Command registry uses deterministic text keys. Keep them unchanged on the API.
  if (!['social_account', 'connection'].includes(kind) || !/^[0-9a-f]{64}$/.test(id)) return null;
  const hash = createHash('sha256').update(JSON.stringify([scope.workspaceId, kind, id])).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}

// Existing JSON is retained for compatibility with legacy records, API-only fields and older deployments.
// Projection is batched at command completion and uses the same transaction/savepoint as the source write.
export function domainPersistence(client: PoolClient, scope: Scope, mode: 'user' | 'system' | 'public') {
  const partition = [scope.tenantId, scope.workspaceId];
  const pending = new Map<string, DomainRow>();
  let ready: Promise<boolean> | undefined;
  const enabled = () => mode === 'public' ? Promise.resolve(false) : ready ??= client.query<{ ready: boolean }>(
    "SELECT to_regclass('workspace.brand') IS NOT NULL AS ready").then(({ rows }) => rows[0]!.ready);

  async function loadParent(kind: string, id: string) {
    const recent = pending.get(key(kind, id));
    if (recent) return recent;
    const { rows } = await client.query<Omit<Entity, 'created_at' | 'updated_at'> & { created_at: Date; updated_at: Date }>(`SELECT * FROM ss.entities
      WHERE tenant_id=$1 AND workspace_id=$2 AND ((module=$3 AND kind=$4 AND id=$5) OR (module=$6 AND kind=$7 AND id=$8))
      ORDER BY updated_at DESC`, [...partition, directModule(kind), kind, id, snapshotModule, snapshotKind, recordKey(kind, id)]);
    for (const row of rows) {
      const entry = decode({ ...row, created_at: row.created_at.toISOString(), updated_at: row.updated_at.toISOString() });
      if (entry) return entry;
    }
  }

  async function upsert(row: DomainRow, spec: Mapping, values: Fields, allowUpdate: boolean) {
    const columns = Object.keys(values).map(column => `"${column}"`);
    const columnsSql = columns.join(',');
    const update = columns.filter(column => !['"id"', '"tenant_id"', '"workspace_id"', '"created_at"', '"created_by_type"', '"created_by_id"'].includes(column));
    const conflict = !allowUpdate ? 'ON CONFLICT DO NOTHING' : spec.immutable ? 'ON CONFLICT (id) DO NOTHING' : `ON CONFLICT (id) DO UPDATE SET
      ${update.map(column => `${column}=EXCLUDED.${column}`).join(',')}
      WHERE domain_row.tenant_id=EXCLUDED.tenant_id AND domain_row.workspace_id=EXCLUDED.workspace_id`;
    await client.query('SAVEPOINT domain_row');
    try {
      await client.query(`INSERT INTO ${spec.table} AS domain_row (${columnsSql}) SELECT ${columnsSql}
        FROM jsonb_populate_record(NULL::${spec.table}, $1::jsonb) WHERE true ${conflict}`, [JSON.stringify(values)]);
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT domain_row');
      const code = (error as { code?: string }).code;
      // Some pre-domain values are representable only in the old JSON model. Preserve that source row.
      // Schema/permission or unexpected SQL failures still roll back the whole Command.
      if (allowUpdate && constrainedKinds.has(row.kind) && (code === '23503' || code === '23505')) throw error;
      if (!code || !(code.startsWith('22') || ['23502', '23503', '23505', '23514'].includes(code))) throw error;
      await client.query('RELEASE SAVEPOINT domain_row');
      return false;
    }
    await client.query('RELEASE SAVEPOINT domain_row');
    return Boolean((await client.query(`SELECT 1 FROM ${spec.table} WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3${spec.versionless ? '' : ' AND version=$4'}`,
      [...partition, values.id, ...(spec.versionless ? [] : [row.version])])).rowCount);
  }

  async function flush() {
    if (!pending.size || !await enabled()) return;
    const outcome = new Map<string, boolean>();
    const visiting = new Set<string>();
    const linked = new Map<string, DomainRow>();

    async function parent(kind: string, raw: unknown): Promise<string | null> {
      const id = domainId(scope, kind, raw);
      if (!id || typeof raw !== 'string') return null;
      const known = mapping(kind);
      if (!known) {
        const table = Object.hasOwn(externalParents, kind) && externalParents[kind];
        if (!table) return null;
        const { rows } = await client.query<{ allowed: boolean }>("SELECT has_table_privilege(to_regclass($1), 'SELECT') AS allowed", [table]);
        if (!rows[0]?.allowed) return null;
        return (await client.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND id=$2`, [scope.tenantId, id])).rowCount ? id : null;
      }
      const changed = pending.get(key(kind, raw));
      if (changed) return await project(changed, true) ? id : null;
      if ((await client.query(`SELECT 1 FROM ${known.table} WHERE tenant_id=$1 AND workspace_id=$2 AND id=$3`, [...partition, id])).rowCount) return id;
      const legacy = await loadParent(kind, raw);
      return legacy && await project(legacy, false) ? id : null;
    }

    async function project(row: DomainRow, isChanged: boolean): Promise<boolean> {
      const identity = key(row.kind, row.id);
      if (outcome.has(identity)) return outcome.get(identity)!;
      if (visiting.has(identity)) return false;
      visiting.add(identity);
      const success = await write(row, isChanged);
      visiting.delete(identity);
      outcome.set(identity, success);
      if (success && linksFor(row.kind).length) linked.set(identity, row);
      return success;
    }

    async function write(row: DomainRow, isChanged: boolean) {
      const spec = mapping(row.kind);
      const id = domainId(scope, row.kind, row.id);
      if (!spec || !id || (row.kind === 'approval_decision' && (mode !== 'user' || String(row.data.decided_by_user_id).toLowerCase() !== scope.actorId))) return false;
      const data = row.data;
      const actorId = domainId(scope, '', data.created_by_id) ?? (isChanged && row.version === 1 && mode === 'user' ? scope.actorId : null);
      const values: Fields = { id, tenant_id: scope.tenantId, workspace_id: scope.workspaceId, created_at: row.created_at };
      if (row.kind !== 'content_revision') values.updated_at = row.updated_at;
      if (!spec.versionless) values.version = row.version;
      if (!spec.actorless) {
        values.created_by_id = actorId;
        values.created_by_type = data.created_by_type === 'agent' ? 'agent_client' : data.created_by_type ?? (actorId ? 'user' : 'system');
      }
      for (const column of spec.columns) {
        const alias = spec.aliases?.[column];
        const raw = Object.hasOwn(data, column) ? data[column] : (alias ? data[alias] : undefined) ?? spec.defaults?.[column];
        const ref = spec.parents?.[column];
        if (linksFor(row.kind).some(link => link.column === column)) continue;
        values[column] = ref ? await parent(ref, raw) : column.endsWith('_id') && !textIds.has(column)
          ? domainId(scope, '', raw) : raw ?? null;
      }
      if (row.kind === 'execution_attempt' && !data.triggered_by_type) values.triggered_by_type = mode;
      if (row.kind === 'platform_post' && !values.source) {
        const method = data.submitted_by === 'api' ? 'platform_api' : ['human', 'auto'].includes(data.submitted_by) ? 'connector' :
          data.origin === 'manual_registered' || data.submitted_by === 'manual' ? 'manual' : 'derived';
        values.source = { method, provider: values.provider, external_id: values.external_post_id,
          observed_at: values.first_seen_at, estimate: false, evidence_ids: values.evidence_ids };
      }
      if (spec.required.some(column => values[column] == null)) return false;
      return upsert(row, spec, values, isChanged);
    }

    for (const row of pending.values()) await project(row, true);
    // These FK pairs form cycles. Write the independently valid rows first, then bind the scoped inverse link.
    for (const row of linked.values()) {
      const source = mapping(row.kind)!;
      const id = domainId(scope, row.kind, row.id);
      for (const link of linksFor(row.kind)) {
        if (!Object.hasOwn(row.data, link.column)) continue;
        const target = mapping(link.target)!;
        const targetId = await parent(link.target, row.data[link.column]);
        await client.query(`UPDATE ${source.table} source SET ${link.column}=(SELECT target.id FROM ${target.table} target
          WHERE target.tenant_id=$1 AND target.workspace_id=$2 AND target.id=$4 AND target.${link.inverse}=$3)
          WHERE source.tenant_id=$1 AND source.workspace_id=$2 AND source.id=$3 AND source.version=$5`, [...partition, id, targetId, row.version]);
      }
    }
  }

  return {
    track(entity: Entity) {
      if (mode === 'public') return;
      const row = decode(entity);
      if (row) pending.set(key(row.kind, row.id), row);
    },
    flush,
    clear: () => pending.clear(),
    async hydrate(entities: Entity[]): Promise<Entity[]> {
      const groups = new Map<Mapping, { entity: Entity; row: DomainRow; id: string }[]>();
      for (const entity of entities) {
        const row = decode(entity);
        if (!row) continue;
        const spec = mapping(row.kind);
        const id = domainId(scope, row.kind, row.id);
        if (!spec?.read || !id || (spec.versionless && (!spec.immutable || row.version !== 1))) continue;
        const group = groups.get(spec) ?? [];
        group.push({ entity, row, id });
        groups.set(spec, group);
      }
      if (!groups.size || !await enabled()) return entities;
      for (const [spec, group] of groups) {
        const { rows } = await client.query<{ id: string; version: number; data: Fields }>(`SELECT id, ${spec.versionless ? '1' : 'version'} AS version,
          to_jsonb(domain_row) AS data FROM ${spec.table} domain_row WHERE tenant_id=$1 AND workspace_id=$2 AND id=ANY($3::uuid[])`,
        [...partition, group.map(entry => entry.id)]);
        const byId = new Map(rows.map(row => [row.id, row]));
        for (const entry of group) {
          // A legacy writer or a row incompatible with typed constraints may leave a different version behind.
          const typed = byId.get(entry.id);
          if (!typed || typed.version !== entry.row.version) continue;
          const fields = { ...entry.row.data };
          for (const field of spec.read!) if (Object.hasOwn(fields, field)) fields[field] = typed.data[field];
          entry.entity.data = entry.entity.module === snapshotModule ? { ...entry.entity.data, value: JSON.stringify({
            ...fields, id: entry.row.id, version: entry.row.version, created_at: entry.row.created_at, updated_at: entry.row.updated_at,
          }) } : fields;
        }
      }
      return entities;
    },
  };
}
