#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

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
CREATE DATABASE ambassador_acceptance OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@${address}/ambassador_acceptance" pnpm db:migrate:kernel
SMARTSELL_AMBASSADOR_PG_URL="postgresql://app_rw:fixture-request@${address}/ambassador_acceptance" \
SMARTSELL_AMBASSADOR_PG_INSPECT_URL="postgresql://postgres:acceptance-local@${address}/ambassador_acceptance" \
  node --import tsx --test tests/acceptance/ambassador-http.test.mjs
