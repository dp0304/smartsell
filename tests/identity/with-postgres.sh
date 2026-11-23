#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Disposable databases and fixture-only passwords, reachable on loopback.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=identity-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
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
CREATE DATABASE identity_kernel_setup OWNER app_owner;
SQL
address=$(docker port "$container" 5432/tcp)
if [[ "${1:-}" != --kernel-first-owner-only ]]; then
  MIGRATION_DATABASE_URL="postgresql://postgres:identity-local@$address/identity_kernel" node --import tsx packages/db/src/migrate.ts
  IDENTITY_KERNEL_TEST_DATABASE_URL="postgresql://app_rw:fixture-only@$address/identity_kernel" \
    IDENTITY_TEST_DATABASE_URL="postgresql://postgres:identity-local@$address/identity_state" \
    node --import tsx --test --test-concurrency=1 tests/identity/*.test.ts
fi

MIGRATION_DATABASE_URL="postgresql://postgres:identity-local@$address/identity_kernel_setup" node --import tsx packages/db/src/migrate.ts
result=$(KERNEL_SETUP_TEST_DATABASE_URL="postgresql://app_rw:fixture-only@$address/identity_kernel_setup" \
  node --import tsx --test --test-reporter=tap \
    --test-name-pattern='^Kernel PostgreSQL creates one owner through the local HTTP entry and persists the username$' \
    apps/server/src/integration/first-owner.test.ts) || { printf '%s\n' "$result"; exit 1; }
printf '%s\n' "$result"
# A filter that matches nothing can also exit zero.
grep -qx '# pass 1' <<< "$result"
