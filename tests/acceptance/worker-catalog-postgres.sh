#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=worker-catalog-fixture "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE smartsell_background NOLOGIN;
CREATE ROLE app_background LOGIN PASSWORD 'fixture-background';
GRANT smartsell_request, smartsell_background TO app_background;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE catalog_operations OWNER app_owner;
CREATE DATABASE catalog_commands OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/catalog_operations" pnpm db:migrate:kernel
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/catalog_commands" pnpm db:migrate
env -i PATH="$PATH" \
  SMARTSELL_WORKER_CATALOG_TEST_KERNEL_PG_URL="postgresql://app_rw:fixture-request@$address/catalog_operations" \
  SMARTSELL_WORKER_CATALOG_TEST_BACKGROUND_PG_URL="postgresql://app_background:fixture-background@$address/catalog_commands" \
  SMARTSELL_WORKER_CATALOG_TEST_COMMAND_PG_URL="postgresql://app_rw:fixture-request@$address/catalog_commands" \
  node scripts/test.mjs apps/server/src/modules/commerce/worker-catalog.test.ts
