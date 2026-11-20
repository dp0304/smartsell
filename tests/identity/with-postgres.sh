#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Disposable databases and fixture-only passwords, reachable on loopback.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=identity-local postgres:17-alpine)
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$container" psql --quiet -U postgres -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE app_owner NOLOGIN;
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-only';
CREATE DATABASE identity_kernel OWNER app_owner;
CREATE DATABASE identity_state;
SQL
address=$(docker port "$container" 5432/tcp)
MIGRATION_DATABASE_URL="postgresql://postgres:identity-local@$address/identity_kernel" node --import tsx packages/db/src/migrate.ts
IDENTITY_KERNEL_TEST_DATABASE_URL="postgresql://app_rw:fixture-only@$address/identity_kernel" \
  IDENTITY_TEST_DATABASE_URL="postgresql://postgres:identity-local@$address/identity_state" \
  node --import tsx --test --test-concurrency=1 tests/identity/*.test.ts
