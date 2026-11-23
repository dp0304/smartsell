#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Same isolated PostgreSQL roles as AI05. Reuse the cached image and discard the data on exit.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=research-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
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
CREATE DATABASE research_operations OWNER app_owner;
CREATE DATABASE research_commands OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
docker exec "$container" psql -X -U postgres -Atc 'SHOW server_version'
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/research_operations" pnpm db:migrate:kernel
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/research_commands" pnpm db:migrate

env -i PATH="$PATH" SMARTSELL_AGENT_MODELS='[]' \
  SMARTSELL_RESEARCH_OPERATIONS_PG_URL="postgresql://app_rw:fixture-request@$address/research_operations" \
  SMARTSELL_RESEARCH_BACKGROUND_PG_URL="postgresql://app_background:fixture-background@$address/research_commands" \
  SMARTSELL_RESEARCH_COMMANDS_PG_URL="postgresql://app_rw:fixture-request@$address/research_commands" \
  SMARTSELL_RESEARCH_CLAUDE="${SMARTSELL_RESEARCH_CLAUDE:-}" \
  node --import tsx --test tests/acceptance/research-operation-http.test.mjs
