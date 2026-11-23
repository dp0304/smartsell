#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Use a disposable database on loopback, without pulling an image implicitly.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=acceptance-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if [[ ${1:-} == ai02 ]]; then
  docker exec -i "$container" psql --username postgres --set ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE ai02_operations OWNER app_owner;
CREATE DATABASE ai02_commands OWNER app_owner;
SQL
  address=$(docker port "$container" 5432/tcp)
  owner="postgresql://app_owner:fixture-owner@${address}"
  request="postgresql://app_rw:fixture-request@${address}"
  docker exec "$container" psql --username postgres -Atc 'SHOW server_version'
  MIGRATION_DATABASE_URL="$owner/ai02_operations" pnpm db:migrate:kernel
  MIGRATION_DATABASE_URL="$owner/ai02_commands" pnpm db:migrate
  SMARTSELL_AI02_OPERATIONS_DATABASE_URL="$request/ai02_operations" \
  SMARTSELL_AI02_COMMANDS_DATABASE_URL="$request/ai02_commands" \
    node --import tsx --test tests/acceptance/ai02-stream-revocation.test.mjs
  exit
fi

docker exec -i "$container" psql --username postgres --set ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE acceptance_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE acceptance_request LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO acceptance_request;
CREATE DATABASE smartsell_acceptance OWNER acceptance_owner;
CREATE DATABASE smartsell_dual_runtime OWNER acceptance_owner;
CREATE DATABASE smartsell_traffic OWNER acceptance_owner;
SQL
address=$(docker port "$container" 5432/tcp)
MIGRATION_DATABASE_URL="postgresql://acceptance_owner:fixture-owner@${address}/smartsell_acceptance" pnpm db:migrate
SMARTSELL_ACCEPTANCE_DATABASE_URL="postgresql://acceptance_request:fixture-request@${address}/smartsell_acceptance" \
  node --import tsx --test --test-name-pattern='^A05 ' tests/acceptance/flows.test.mjs

MIGRATION_DATABASE_URL="postgresql://acceptance_owner:fixture-owner@${address}/smartsell_dual_runtime" pnpm db:migrate
SMARTSELL_DUAL_RUNTIME_PG_URL="postgresql://acceptance_request:fixture-request@${address}/smartsell_dual_runtime" \
  node --import tsx --test --test-name-pattern='^Commands and Operations use the same PostgreSQL' tests/integration-contract/dual-runtime.test.ts

MIGRATION_DATABASE_URL="postgresql://acceptance_owner:fixture-owner@${address}/smartsell_traffic" pnpm db:migrate
TRAFFIC_TEST_DATABASE_URL="postgresql://acceptance_request:fixture-request@${address}/smartsell_traffic" \
  TRAFFIC_TEST_DATABASE_OWNER_URL="postgresql://acceptance_owner:fixture-owner@${address}/smartsell_traffic" \
  node --import tsx --test --test-name-pattern='^command PostgreSQL traffic scope' apps/server/src/integration/traffic-host.test.ts

docker exec "$container" createdb -U postgres -O acceptance_owner smartsell_command_identity
MIGRATION_DATABASE_URL="postgresql://acceptance_owner:fixture-owner@${address}/smartsell_command_identity" pnpm db:migrate
COMMAND_IDENTITY_TEST_DATABASE_URL="postgresql://acceptance_request:fixture-request@${address}/smartsell_command_identity" \
  node --import tsx --test --test-name-pattern='^Commands PostgreSQL:' apps/server/src/integration/command-identity.test.ts
