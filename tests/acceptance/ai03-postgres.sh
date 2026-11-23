#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=ai03-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE ai03_operations OWNER app_owner;
CREATE DATABASE ai03_commands OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
docker exec "$container" psql -X -U postgres -Atc 'SHOW server_version'
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai03_operations" pnpm db:migrate:kernel
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai03_commands" pnpm db:migrate

env -i PATH="$PATH" SMARTSELL_AGENT_MODELS='[]' \
  SMARTSELL_AI03_OPERATIONS_PG_URL="postgresql://app_rw:fixture-request@$address/ai03_operations" \
  SMARTSELL_AI03_COMMANDS_FIXTURE_URL="postgresql://app_owner:fixture-owner@$address/ai03_commands" \
  SMARTSELL_AI03_COMMANDS_PG_URL="postgresql://app_rw:fixture-request@$address/ai03_commands" \
  node --import tsx --test tests/acceptance/ai03-postgres.test.mjs
