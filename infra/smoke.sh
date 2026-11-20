#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")/.."

runtime=${1:-command}
case "$runtime" in
  command|operation) ;;
  *) printf 'Usage: bash infra/smoke.sh [command|operation]\n' >&2; exit 2 ;;
esac
node -e 'if (process.versions.node.split(".")[0] !== "24") throw new Error("Node.js 24 is required")'
workdir=$(mktemp -d)
project="smartsell-smoke-$(openssl rand -hex 8)"
admin_password=$(openssl rand -hex 32)
migration_password=$(openssl rand -hex 32)
runtime_password=$(openssl rand -hex 32)
background_password=$(openssl rand -hex 32)
app_secret=$(openssl rand -hex 32)
setup_token=$(openssl rand -hex 32)
api_pid=''

compose() {
  POSTGRES_PASSWORD=$admin_password SMARTSELL_MIGRATION_PASSWORD=$migration_password \
    SMARTSELL_RUNTIME_PASSWORD=$runtime_password SMARTSELL_BACKGROUND_PASSWORD=$background_password PG_PORT=0 \
    docker compose --project-name "$project" --file infra/compose.yaml "$@"
}

stop_api() {
  if [[ -n $api_pid ]]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
    api_pid=''
  fi
}

cleanup() {
  local status=$?
  trap - EXIT
  stop_api
  if (( status != 0 )); then
    if [[ -f $workdir/server.log ]]; then
      printf '\nAPI log\n' >&2
      tee /dev/null < "$workdir/server.log" >&2
    fi
    compose logs --tail=30 postgres >&2 || true
  fi
  compose down --volumes || status=1
  rm -rf -- "$workdir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Require a cached image so the smoke never pulls from a registry.
compose up --detach --pull never --wait --wait-timeout 90 postgres
pg_address=$(compose port postgres 5432)
[[ $pg_address == 127.0.0.1:* ]]
migration_task=db:migrate
if [[ $runtime == operation ]]; then migration_task=db:migrate:kernel; fi
export MIGRATION_DATABASE_URL="postgresql://app_owner:$migration_password@$pg_address/smartsell"
pnpm "$migration_task"
# Applying the same artifact twice verifies that the migration ledger can be reused.
pnpm "$migration_task"

if [[ $runtime == command ]]; then
role_ok=$(compose exec -T -e PGPASSWORD="$runtime_password" postgres \
  psql -X -h 127.0.0.1 -U app_rw -d smartsell -Atq -v ON_ERROR_STOP=1 -c "
    SELECT current_user = 'app_rw'
      AND pg_has_role('smartsell_request', 'USAGE')
      AND NOT pg_has_role('smartsell_background', 'MEMBER')
      AND NOT has_function_privilege('ss.operation_workspaces()', 'EXECUTE')
      AND NOT has_function_privilege('ss.lock_operation_workspace(uuid)', 'EXECUTE')
      AND NOT has_function_privilege('ss.operation_members(uuid)', 'EXECUTE')
      AND NOT pg_has_role('app_owner', 'MEMBER')
      AND NOT has_database_privilege(current_database(), 'CREATE')
      AND NOT has_schema_privilege('ss_migrations', 'USAGE')
      AND NOT EXISTS (SELECT FROM pg_roles WHERE rolname = current_user
        AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication));")
[[ $role_ok == t ]]
role_ok=$(compose exec -T -e PGPASSWORD="$background_password" postgres \
  psql -X -h 127.0.0.1 -U app_background -d smartsell -Atq -v ON_ERROR_STOP=1 -c "
    SELECT current_user = 'app_background'
      AND pg_has_role('smartsell_request', 'USAGE')
      AND pg_has_role('smartsell_background', 'USAGE')
      AND has_function_privilege('ss.operation_workspaces()', 'EXECUTE')
      AND has_function_privilege('ss.lock_operation_workspace(uuid)', 'EXECUTE')
      AND has_function_privilege('ss.operation_members(uuid)', 'EXECUTE');")
[[ $role_ok == t ]]
printf 'PG17 migrations and runtime role checks passed\n'
fi

api_port=$(node --input-type=module -e '
  import { createServer } from "node:net";
  const server = createServer();
  server.listen(0, "127.0.0.1", () => {
    console.log(server.address().port);
    server.close();
  });')
url="http://127.0.0.1:$api_port"
origin=https://smartsell-smoke.invalid
curl_local() { curl --disable --noproxy '*' --silent --show-error --max-time 10 "$@"; }

start_api() {
  # An empty first argument leaves setup disabled on restart.
  (
    unset SETUP_TOKEN SMARTSELL_STORE SMARTSELL_OPERATION_API MEDIA_S3_ENDPOINT BACKGROUND_DATABASE_URL
    unset SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS SMARTSELL_SHOPIFY_APPS
    export MEDIA_DIRECTORY="$workdir/media"
    if [[ -n $1 ]]; then export SETUP_TOKEN=$1; fi
    export HOST=127.0.0.1 PORT=$api_port PUBLIC_ORIGIN=$origin APP_SECRET=$app_secret ROLE=$2
    export DATABASE_URL="postgresql://app_rw:$runtime_password@$pg_address/smartsell"
    if [[ $2 == all ]]; then
      export BACKGROUND_DATABASE_URL="postgresql://app_background:$background_password@$pg_address/smartsell"
    fi
    if [[ $runtime == operation ]]; then
      export NODE_ENV=production
      unset MIGRATION_DATABASE_URL
      cd apps/server
      exec node --import tsx src/kernel-main.ts
    fi
    exec bash infra/start.sh
  ) >> "$workdir/server.log" 2>&1 &
  api_pid=$!
  local i
  for (( i=0; i<40; i++ )); do
    kill -0 "$api_pid" 2>/dev/null || return 1
    if curl_local --fail --max-time 1 "$url/readyz" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  printf 'API readiness timed out\n' >&2
  return 1
}

request() {
  local expected=$1 actual
  shift
  actual=$(curl_local --output "$workdir/body" --dump-header "$workdir/headers" --write-out '%{http_code}' "$@")
  if [[ $actual != "$expected" ]]; then
    printf 'Expected HTTP %s, got %s for %s\n' "$expected" "$actual" "${*: -1}" >&2
    return 1
  fi
}

if [[ $runtime == operation ]]; then
  start_api "$setup_token" all
  SETUP_TOKEN=$setup_token SMARTSELL_SMOKE_URL=$url node apps/server/test/http-smoke.mjs
  stop_api
  start_api '' api
  request 200 -H 'Content-Type: application/json' \
    --data '{"email":"smoke@example.invalid","password":"fixture-local-password"}' "$url/api/v1/login"
  printf 'Operations login persisted across process restart\n'
  compose exec -T postgres createdb -U postgres -O app_owner smartsell_kernel_test
  MIGRATION_DATABASE_URL="${MIGRATION_DATABASE_URL%/*}/smartsell_kernel_test" pnpm "$migration_task"
  SMARTSELL_TEST_DATABASE_URL="postgresql://app_rw:$runtime_password@$pg_address/smartsell_kernel_test" \
    pnpm --filter @smartsell/server exec tsx --test test/kernel.test.ts
  exit 0
fi

password="smoke-$(openssl rand -hex 16)"
login=$(printf '{"email":"smoke@example.invalid","password":"%s"}' "$password")
setup=$(printf '{"email":"smoke@example.invalid","password":"%s","name":"Smoke User","workspaceName":"Smoke Workspace"}' "$password")
printf 'x-setup-token: %s\n' "$setup_token" > "$workdir/setup-header"
json_headers=(-H "Origin: $origin" -H 'Content-Type: application/json')

start_api "$setup_token" all
for route in /healthz /readyz; do
  request 200 "$url$route"
  node --input-type=module - "$workdir/body" <<'JS'
import { readFileSync } from 'node:fs';
const { status } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (status !== 'ok') throw new Error('Expected healthy API response');
JS
done
request 401 "$url/api/v1/session"
request 403 "${json_headers[@]}" --data "$setup" "$url/api/v1/setup"
request 201 "${json_headers[@]}" -H "@$workdir/setup-header" --data "$setup" "$url/api/v1/setup"
printf 'API probes and first-run setup passed\n'

stop_api
start_api '' api
request 403 "${json_headers[@]}" -H "@$workdir/setup-header" --data "$setup" "$url/api/v1/setup"
request 200 "${json_headers[@]}" --data "$login" "$url/api/v1/session"
# TLS terminates at the production proxy. Check Secure and forward this ephemeral
# cookie explicitly over the loopback-only backend connection for this test.
node --input-type=module - "$workdir/headers" > "$workdir/session-header" <<'JS'
import { readFileSync } from 'node:fs';
const header = readFileSync(process.argv[2], 'utf8').split(/\r?\n/).find(line => /^set-cookie:/i.test(line));
const token = header?.match(/^set-cookie:\s*(__Host-smartsell_session=[A-Za-z0-9_-]{43});/i)?.[1];
if (!token || !/; Secure(?:;|$)/i.test(header) || !/; HttpOnly(?:;|$)/i.test(header)) {
  throw new Error('Missing secure session cookie');
}
console.log(`Cookie: ${token}`);
JS
request 200 -H "@$workdir/session-header" "$url/api/v1/session"
workspace=$(node --input-type=module - "$workdir/body" <<'JS'
import { readFileSync } from 'node:fs';
const { user, workspaces } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const workspace = workspaces?.find(w => w.name === 'Smoke Workspace');
if (user?.email !== 'smoke@example.invalid' || !/^[\da-f-]{36}$/i.test(workspace?.id ?? '')) {
  throw new Error('Expected saved smoke user and workspace');
}
console.log(workspace.id);
JS
)
workspace_api="$url/api/v1/workspaces/$workspace"
request 200 -H "@$workdir/session-header" "$workspace_api/catalog"
node --input-type=module - "$workdir/body" <<'JS'
import { readFileSync } from 'node:fs';
const { data } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (!Array.isArray(data) || data.length === 0) throw new Error('Expected an authenticated Web operation catalog');
JS
request 200 -H "@$workdir/session-header" "$workspace_api/commands"
brand='{"name":"Smoke Brand","slug":"smoke-brand"}'
create_brand=("${json_headers[@]}" -H "@$workdir/session-header" -H 'Idempotency-Key: smoke-brand')
request 200 "${create_brand[@]}" --data "$brand" "$workspace_api/commands/workspace/create_brand"
cp "$workdir/body" "$workdir/brand-response"
request 200 "${create_brand[@]}" --data "$brand" "$workspace_api/commands/workspace/create_brand"
node --input-type=module - "$workdir/brand-response" "$workdir/body" <<'JS'
import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const [first, replay] = process.argv.slice(2).map(path => JSON.parse(readFileSync(path, 'utf8')));
deepStrictEqual(first, replay);
JS
request 409 "${create_brand[@]}" --data '{"name":"Different Brand","slug":"other"}' "$workspace_api/commands/workspace/create_brand"
request 200 -H "@$workdir/session-header" "$workspace_api/records/workspace/brand"
node --input-type=module - "$workdir/body" <<'JS'
import { readFileSync } from 'node:fs';
const { items } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (items?.length !== 1 || items[0].data.name !== 'Smoke Brand' || items[0].version !== 1) {
  throw new Error('Expected one committed brand');
}
JS
admin_brand=$(compose exec -T postgres psql -X -U postgres -d smartsell -Atq -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM ss.entities WHERE workspace_id = '$workspace' AND module = 'workspace' AND kind = 'brand' AND version = 1")
[[ $admin_brand == 1 ]]
unscoped=$(compose exec -T -e PGPASSWORD="$runtime_password" postgres psql -X -h 127.0.0.1 -U app_rw -d smartsell -Atq -v ON_ERROR_STOP=1 \
  -c "SELECT count(*) FROM ss.entities WHERE workspace_id = '$workspace' AND module = 'workspace' AND kind = 'brand'")
[[ $unscoped == 0 ]]
printf 'PostgreSQL stores one committed brand and the unscoped request role sees no rows\n'

request 200 -H "@$workdir/session-header" "$url/api/v1/session/csrf"
node -e 'const {csrf_token} = JSON.parse(require("node:fs").readFileSync(0)); if (!csrf_token) process.exit(1); console.log(`X-CSRF-Token: ${csrf_token}`)' \
  < "$workdir/body" > "$workdir/csrf-header"
printf 'SmartSell media smoke fixture\n' > "$workdir/expected-bytes"
node -e 'const b = require("node:fs").readFileSync(0); console.log(JSON.stringify({ purpose: "asset", mime_type: "text/plain", size_bytes: b.length, sha256: require("node:crypto").createHash("sha256").update(b).digest("hex") }))' \
  < "$workdir/expected-bytes" > "$workdir/upload-spec"
media_headers=("${json_headers[@]}" -H "@$workdir/session-header" -H "@$workdir/csrf-header")
request 403 "${json_headers[@]}" -H "@$workdir/session-header" --data-binary "@$workdir/upload-spec" "$workspace_api/files/uploads"
request 200 "${media_headers[@]}" -H 'Idempotency-Key: smoke-upload' --data-binary "@$workdir/upload-spec" "$workspace_api/files/uploads"
upload_id=$(node -e 'const {id} = JSON.parse(require("node:fs").readFileSync(0)).data; if (!/^[a-z0-9_-]{1,128}$/i.test(id)) process.exit(1); console.log(id)' < "$workdir/body")
node -e 'console.log(JSON.stringify({base64: require("node:fs").readFileSync(0).toString("base64")}))' \
  < "$workdir/expected-bytes" > "$workdir/upload-bytes"
request 200 "${media_headers[@]}" -H 'Idempotency-Key: smoke-complete' --data-binary "@$workdir/upload-bytes" "$workspace_api/files/uploads/$upload_id/complete"
file_id=$(node -e 'const {id} = JSON.parse(require("node:fs").readFileSync(0)).data; if (!/^[a-z0-9_-]{1,128}$/i.test(id)) process.exit(1); console.log(id)' < "$workdir/body")
request 200 -H "@$workdir/session-header" "$workspace_api/files/$file_id/download"
download_path=$(node -e 'const u = new URL(JSON.parse(require("node:fs").readFileSync(0)).data.url, "https://fixture.invalid"); console.log(u.pathname + u.search)' < "$workdir/body")
request 200 -H "@$workdir/session-header" "$url$download_path"
cmp "$workdir/body" "$workdir/expected-bytes"
printf 'CSRF, checksum-verified media upload and authenticated download passed\n'
request 204 -X DELETE -H "Origin: $origin" -H "@$workdir/session-header" "$url/api/v1/session"
request 401 -H "@$workdir/session-header" "$url/api/v1/session"
request 200 "${json_headers[@]}" --data "$login" "$url/api/v1/login"
printf 'Secure login, Web login and catalog, scoped commands, idempotent replay, and logout passed\n'

compose stop postgres
request 200 "$url/healthz"
request 503 "$url/readyz"
printf 'Liveness stayed healthy and readiness reported 503 after PostgreSQL stopped\n'
