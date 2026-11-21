#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

[[ $(node -v) == v24.21.0 ]]
: "${SMARTSELL_AI07_CHROMIUM:?Provide the path to preinstalled Chromium headless shell}"
[[ -x "$SMARTSELL_AI07_CHROMIUM" ]]
socket=${SMARTSELL_AI07_DOCKER_SOCKET:-/var/run/docker.sock}
[[ -S "$socket" ]]
fixture=$(mktemp -d)
container=
mkdir "$fixture/docker" "$fixture/home" "$fixture/tmp"
local_docker() {
  env -i PATH="$PATH" HOME="$fixture/home" docker --config "$fixture/docker" --host "unix://$socket" "$@"
}
cleanup() {
  if [[ -n "$container" ]]; then local_docker stop "$container" >/dev/null; fi
  rm -rf -- "$fixture"
}
trap cleanup EXIT
container=$(local_docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=ai07-local postgres:17-alpine)
for ((attempt=0; attempt<30; attempt++)); do
  if local_docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
local_docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE ai07_operations OWNER app_owner;
CREATE DATABASE ai07_commands OWNER app_owner;
SQL
address=$(local_docker port "$container" 5432/tcp)
[[ "$address" == 127.0.0.1:* ]]
local_docker exec "$container" psql -X -U postgres -Atc 'SHOW server_version'
env -i PATH="$PATH" HOME="$fixture/home" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai07_operations" \
  node --import tsx packages/db/src/migrate.ts
env -i PATH="$PATH" HOME="$fixture/home" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai07_commands" \
  node --import tsx packages/db/src/migrate-core.ts

env -i PATH="$PATH" HOME="$fixture/home" TMPDIR="$fixture/tmp" NODE_ENV=test SMARTSELL_AGENT_MODELS='[]' \
  SMARTSELL_AI07_CHROMIUM="$SMARTSELL_AI07_CHROMIUM" \
  SMARTSELL_AI07_OPERATIONS_PG_URL="postgresql://app_rw:fixture-request@$address/ai07_operations" \
  SMARTSELL_AI07_COMMANDS_FIXTURE_URL="postgresql://app_owner:fixture-owner@$address/ai07_commands" \
  SMARTSELL_AI07_COMMANDS_PG_URL="postgresql://app_rw:fixture-request@$address/ai07_commands" \
  node --import tsx --test --test-name-pattern=AI07 apps/server/src/integration/agent-local.test.mjs
