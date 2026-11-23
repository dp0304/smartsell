#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=domain-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_local() { docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 "$@"; }
psql_local <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE domain_owner LOGIN PASSWORD 'domain-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'domain-request';
CREATE ROLE smartsell_background NOLOGIN;
CREATE ROLE app_background LOGIN PASSWORD 'domain-background';
GRANT smartsell_request TO app_rw, app_background;
GRANT smartsell_background TO app_background;
CREATE DATABASE domain_full OWNER domain_owner;
CREATE DATABASE domain_flow OWNER domain_owner;
CREATE DATABASE domain_rollback OWNER domain_owner;
CREATE DATABASE domain_upgrade OWNER domain_owner;
CREATE DATABASE legacy_identity_upgrade OWNER domain_owner;
SQL
address=$(docker port "$container" 5432/tcp)
owner="postgresql://domain_owner:domain-owner@${address}"
request="postgresql://app_rw:domain-request@${address}"
migrate() { MIGRATION_DATABASE_URL="$owner/$1" pnpm --filter @smartsell/db migrate:all; }

SMARTSELL_LEGACY_PG_MIGRATION_URL="$owner/legacy_identity_upgrade" \
  SMARTSELL_LEGACY_PG_ADMIN_URL="postgresql://postgres:domain-local@${address}/legacy_identity_upgrade" \
  SMARTSELL_LEGACY_PG_REQUEST_URL="$request/legacy_identity_upgrade" \
  node --import tsx --test apps/server/src/integration/legacy-identity-upgrade.test.ts

# Create a collision late in the new schema migration. Earlier core DDL and the
# ledger must roll back as a unit while the preexisting object survives.
psql_local -d domain_rollback -c 'CREATE SCHEMA ops AUTHORIZATION domain_owner'
error_log=$(mktemp)
if migrate domain_rollback >"$error_log" 2>&1; then
  rm "$error_log"
  printf '%s\n' 'Expected the migration to fail on the fixture schema collision' >&2
  exit 1
fi
if ! grep -F 'schema "ops" already exists' "$error_log"; then
  rm "$error_log"
  exit 1
fi
rm "$error_log"
[[ $(psql_local -d domain_rollback -Atc "SELECT to_regnamespace('ops') IS NOT NULL AND to_regnamespace('ss') IS NULL AND to_regnamespace('core') IS NULL AND to_regnamespace('ss_migrations') IS NULL") == t ]]
psql_local -d domain_rollback -c 'DROP SCHEMA ops'
migrate domain_rollback

# Model the previous release using its unmodified migrations and ledger.
(
  cd packages/db
  MIGRATION_DATABASE_URL="$owner/domain_upgrade" node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
const client = new pg.Client({ connectionString: process.env.MIGRATION_DATABASE_URL });
await client.connect();
await client.query(`BEGIN; CREATE SCHEMA ss_migrations; CREATE TABLE ss_migrations.applied (
  name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
for (const name of (await readdir('migrations')).filter(name => /^00[1-8]_.*\.sql$/.test(name)).sort()) {
  const sql = await readFile(`migrations/${name}`, 'utf8');
  await client.query(sql);
  await client.query('INSERT INTO ss_migrations.applied (name, checksum) VALUES ($1,$2)', [name, createHash('sha256').update(sql).digest('hex')]);
}
await client.query("SELECT ss.bootstrap('legacy@example.test','Legacy','fixture-hash','Existing workspace')");
await client.query('COMMIT');
await client.end();
JS
)
psql_local -d domain_upgrade <<'SQL'
INSERT INTO ss.entities (tenant_id,workspace_id,module,kind,id,data,created_at,updated_at)
SELECT tenant_id,id,'workspace','brand',gen_random_uuid()::text,'{"name":"Existing brand"}',now(),now() FROM ss.workspaces;
INSERT INTO ss.audit (tenant_id,workspace_id,actor_id,role,module,action,created_at)
SELECT w.tenant_id,w.id,m.user_id,m.role,'workspace','legacy_fixture',TIMESTAMPTZ '2020-01-01 00:00:00+00'
FROM ss.workspaces w JOIN ss.memberships m ON m.workspace_id=w.id;
SQL
migrate domain_upgrade
[[ $(psql_local -d domain_upgrade -Atc "SELECT count(*)=1 FROM core.audit_event d JOIN ss.audit a USING(id) WHERE d.action='legacy_fixture' AND d.occurred_at=a.created_at AND d.actor_id=a.actor_id") == t ]]
[[ $(psql_local -d domain_upgrade -Atc "SELECT count(*)=1 FROM ss.entities e JOIN workspace.workspace w ON (e.tenant_id,e.workspace_id)=(w.tenant_id,w.id) JOIN core.tenant t ON t.id=w.tenant_id WHERE e.data->>'name'='Existing brand' AND w.name='Existing workspace'") == t ]]

migrate domain_full
migrate domain_full
SMARTSELL_TEST_PG_URL="$request/domain_full" SMARTSELL_TEST_PG_ADMIN_URL="postgresql://postgres:domain-local@${address}/domain_full" \
  SMARTSELL_TEST_PG_BACKGROUND_URL="postgresql://app_background:domain-background@${address}/domain_full" \
  node --import tsx --test apps/server/src/postgres.test.ts
migrate domain_flow
SMARTSELL_TEST_PG_URL="$request/domain_flow" SMARTSELL_TEST_PG_ADMIN_URL="$owner/domain_flow" \
  node --import tsx --test apps/server/src/postgres-domain-flow.test.ts
SMARTSELL_TEST_PG_URL="$request/domain_full" SMARTSELL_TEST_PG_ADMIN_URL="$owner/domain_full" \
  node --import tsx --test --test-concurrency=1 packages/db/domain/schema.test.ts packages/db/domain/partitions.test.ts
migrate domain_full
