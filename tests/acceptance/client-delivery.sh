#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

# Keep each run and each scenario's Playwright output in its own directory.
output_root=${TMPDIR:-/tmp}
playwright_args=()
while (($#)); do
  case "$1" in
    --output)
      output_root=${2:?--output requires a directory}
      shift 2
      ;;
    --output=*)
      output_root=${1#--output=}
      : "${output_root:?--output requires a directory}"
      shift
      ;;
    *)
      playwright_args+=("$1")
      shift
      ;;
  esac
done
mkdir -p -- "$output_root"
output_root=$(cd -- "$output_root" && pwd -P)
output=$(mktemp -d "$output_root/smartsell-client-delivery.XXXXXX")
printf 'Playwright output: %s\n' "$output"

# A fresh Operations database per browser scenario, on a loopback-only published port.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=acceptance-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
trap 'docker stop "$container" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
if ((attempt == 30)); then
  printf 'The fixture PostgreSQL server did not become ready\n' >&2
  exit 1
fi
psql_local() { docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 "$@"; }
version=$(psql_local -Atc 'SHOW server_version')
printf 'Fixture PostgreSQL %s\n' "$version"
# Kernel migrations give app_rw the request grants and RLS policies.
psql_local <<'SQL'
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
CREATE DATABASE client_review OWNER app_owner;
CREATE DATABASE client_delivery OWNER app_owner;
REVOKE CONNECT ON DATABASE client_review, client_delivery FROM PUBLIC;
GRANT CONNECT ON DATABASE client_review, client_delivery TO app_rw;
SQL
address=$(docker port "$container" 5432/tcp)
run_scenario() {
  local database=$1 scenario=$2 report="$output/$1.json"
  MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@${address}/${database}" pnpm db:migrate:kernel
  SMARTSELL_CLIENT_DELIVERY_PG_URL="postgresql://app_rw:fixture-request@${address}/${database}" \
    PLAYWRIGHT_JSON_OUTPUT_FILE="$report" \
    pnpm exec playwright test tests/web-e2e/portal.spec.mjs ${playwright_args[@]+"${playwright_args[@]}"} \
      --grep "$scenario \|" --workers=1 --retries=0 --forbid-only --reporter=list,json --output "$output/$database"
  node --input-type=module - "$report" "$scenario" <<'JS'
import { readFileSync } from 'node:fs';

const [path, scenario] = process.argv.slice(2);
const { stats, suites } = JSON.parse(readFileSync(path, 'utf8'));
function results(suite) {
  return [...suite.specs.flatMap(spec => spec.tests.flatMap(test => test.results)), ...(suite.suites ?? []).flatMap(results)];
}
const passed = suites.flatMap(results).filter(result => result.status === 'passed').length;
const { expected, skipped, unexpected: failed, flaky } = stats;
console.log(`${scenario}: ${passed} passed, ${skipped} skipped, ${failed} failed, ${flaky} flaky`);
if (passed !== 1 || expected !== 1 || skipped !== 0 || failed !== 0 || flaky !== 0) process.exitCode = 1;
JS
  if [[ $(psql_local -d "$database" -Atc "SELECT value FROM smartsell.identity WHERE id = 'setup'") != true ]]; then
    printf '%s: portal setup was not persisted in PostgreSQL\n' "$database" >&2
    return 1
  fi
}
run_scenario client_review 'PL06'
run_scenario client_delivery 'TE03 TE04 TE05'
printf 'PostgreSQL acceptance: 2 passed, 0 skipped\n'
