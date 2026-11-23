#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=agent-lifecycle-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if [[ ${1:-} == ai08 ]]; then
  docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE ai08_operations OWNER app_owner;
SQL
  address=$(docker port "$container" 5432/tcp)
  docker exec "$container" psql -X -U postgres -Atc 'SHOW server_version'
  MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai08_operations" pnpm db:migrate:kernel
  SMARTSELL_AI08_PG_URL="postgresql://app_rw:fixture-request@$address/ai08_operations" \
    node --import tsx --test --test-name-pattern='^AI08 ' apps/server/src/integration/agent-local.test.mjs
  exit
fi

docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE smartsell_background NOLOGIN;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
CREATE ROLE app_background LOGIN PASSWORD 'fixture-background';
GRANT smartsell_request TO app_rw, app_background;
GRANT smartsell_background TO app_background;
CREATE DATABASE ai04_acceptance OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
database="$address/ai04_acceptance"
docker exec "$container" psql -X -U postgres -Atc 'SHOW server_version'
MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$database" pnpm db:migrate
SMARTSELL_AGENT_MODELS='[]' \
SMARTSELL_AI04_PG_URL="postgresql://app_rw:fixture-request@$database" \
SMARTSELL_AI04_PG_BACKGROUND_URL="postgresql://app_background:fixture-background@$database" \
SMARTSELL_AI04_PG_INSPECT_URL="postgresql://postgres:agent-lifecycle-local@$database" \
  node --import tsx --test tests/acceptance/ai04-postgres-mcp.test.mjs "$@"
