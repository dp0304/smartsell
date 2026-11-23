#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

container=''
media_dir=''
test_pid=''
cleanup() {
  if [[ -n "$test_pid" ]]; then
    kill "$test_pid" 2>/dev/null || true
    wait "$test_pid" 2>/dev/null || true
  fi
  if [[ -n "$container" ]]; then docker stop "$container" >/dev/null || true; fi
  if [[ -n "$media_dir" ]]; then rm -rf -- "$media_dir"; fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
media_dir=$(mktemp -d)
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=ai05-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if (( attempt == 30 )); then
  printf 'AI05 PostgreSQL did not become ready\n' >&2
  exit 1
fi
docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE smartsell_background NOLOGIN;
CREATE ROLE app_background LOGIN PASSWORD 'fixture-background';
GRANT smartsell_request, smartsell_background TO app_background;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE ai05_operations OWNER app_owner;
CREATE DATABASE ai05_commands OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
docker exec "$container" psql -X -U postgres -Atc 'SHOW server_version'
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai05_operations" pnpm db:migrate:kernel
env -i PATH="$PATH" MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@$address/ai05_commands" pnpm db:migrate

env -i PATH="$PATH" MEDIA_DIRECTORY="$media_dir" SMARTSELL_AGENT_MODELS='[]' \
  SMARTSELL_AI05_OPERATIONS_PG_URL="postgresql://app_rw:fixture-request@$address/ai05_operations" \
  SMARTSELL_AI05_BACKGROUND_PG_URL="postgresql://app_background:fixture-background@$address/ai05_commands" \
  SMARTSELL_AI05_CLAUDE="${SMARTSELL_AI05_CLAUDE:-}" \
  SMARTSELL_AI05_COMMANDS_PG_URL="postgresql://app_rw:fixture-request@$address/ai05_commands" \
  node --import tsx --test --test-isolation=none tests/acceptance/ai05-postgres.test.mjs &
test_pid=$!
status=0
wait "$test_pid" || status=$?
test_pid=''
exit "$status"
