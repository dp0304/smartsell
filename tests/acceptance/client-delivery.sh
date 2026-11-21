#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# A fresh Operations database per browser scenario, on a loopback-only published port.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=acceptance-local postgres:17-alpine)
trap 'docker stop "$container" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
SQL
address=$(docker port "$container" 5432/tcp)
run_scenario() {
  local database=$1 pattern=$2
  shift 2
  MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@${address}/${database}" pnpm db:migrate:kernel
  SMARTSELL_CLIENT_DELIVERY_PG_URL="postgresql://app_rw:fixture-request@${address}/${database}" \
    pnpm exec playwright test tests/web-e2e/portal.spec.mjs --grep "$pattern" --workers=1 --retries=0 "$@"
}
run_scenario client_review 'PL06' "$@"
run_scenario client_delivery 'TE03 TE04 TE05' "$@"
