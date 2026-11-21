#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

workdir=$(mktemp -d)
container='' api_pid='' web_pid=''
cleanup() {
  status=$?
  if [[ $status != 0 ]]; then
    for log in "$workdir/api.log" "$workdir/web.log"; do
      if [[ -f $log ]]; then tee /dev/null < "$log" >&2; fi
    done
  fi
  if [[ -n $web_pid ]]; then kill "$web_pid" 2>/dev/null || true; wait "$web_pid" 2>/dev/null || true; fi
  if [[ -n $api_pid ]]; then kill "$api_pid" 2>/dev/null || true; wait "$api_pid" 2>/dev/null || true; fi
  if [[ -n $container ]]; then docker stop "$container" >/dev/null || true; fi
  rm -rf -- "$workdir"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Same fresh tmpfs and restricted request role as domain-postgres.sh.
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data \
  --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=reviewer-local "${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}")
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
psql_local() { docker exec -i "$container" psql -X -U postgres -v ON_ERROR_STOP=1 "$@"; }
psql_local <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE app_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE app_rw LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO app_rw;
CREATE DATABASE reviewer_acceptance OWNER app_owner;
SQL
version=$(psql_local -Atc 'SHOW server_version')
[[ $version == 17.* ]]
printf 'Empty PostgreSQL %s container %s\n' "$version" "${container:0:12}"
address=$(docker port "$container" 5432/tcp)
MIGRATION_DATABASE_URL="postgresql://app_owner:fixture-owner@${address}/reviewer_acceptance" pnpm db:migrate
[[ $(psql_local -d reviewer_acceptance -Atc 'SELECT count(*) FROM ss.users') == 0 ]]
printf '%s\n' 'Migrated database has 0 users before HTTP setup'

read -r api_port web_port < <(node --input-type=module <<'JS'
import { createServer } from 'node:net';
const sockets = await Promise.all([0, 1].map(() => new Promise((resolve, reject) => {
  const socket = createServer().once('error', reject).listen(0, '127.0.0.1', () => resolve(socket));
})));
console.log(sockets.map(socket => socket.address().port).join(' '));
sockets.forEach(socket => socket.close());
JS
)
export SMARTSELL_REVIEWER_ORIGIN="https://127.0.0.1:$web_port"
export SETUP_TOKEN="$(openssl rand -hex 32)"
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=127.0.0.1' \
  -keyout "$workdir/key.pem" -out "$workdir/cert.pem" > /dev/null 2>&1
pnpm --filter @smartsell/web exec vite build --outDir "$workdir/dist"

role=api
spec=reviewer-sessions
if [[ ${1:-} == membership ]]; then
  role=api,mcp
  spec=membership-access
  export SMARTSELL_MEMBERSHIP_PG_CONTAINER="$container"
elif [[ ${1:-} == model-free ]]; then
  spec=model-free-workflow
  # The spec restarts the real API with a workspace-scoped loopback model binding after setup.
  export SMARTSELL_MODEL_FREE_PG_CONTAINER="$container" SMARTSELL_MODEL_FREE_API_PORT="$api_port"
  export HOST=127.0.0.1 PORT="$api_port" ROLE=api PUBLIC_ORIGIN="$SMARTSELL_REVIEWER_ORIGIN"
  export MEDIA_DIRECTORY="$workdir/media" APP_SECRET="$(openssl rand -hex 32)"
  export DATABASE_URL="postgresql://app_rw:fixture-request@${address}/reviewer_acceptance"
fi
if [[ $spec != model-free-workflow ]]; then
  HOST=127.0.0.1 PORT="$api_port" ROLE="$role" PUBLIC_ORIGIN="$SMARTSELL_REVIEWER_ORIGIN" \
    MEDIA_DIRECTORY="$workdir/media" APP_SECRET="$(openssl rand -hex 32)" \
    DATABASE_URL="postgresql://app_rw:fixture-request@${address}/reviewer_acceptance" \
    bash infra/start.sh >"$workdir/api.log" 2>&1 &
  api_pid=$!
fi
(
  cd apps/web
  SMARTSELL_API_TARGET="http://127.0.0.1:$api_port" ACCEPTANCE_DIR="$workdir" exec node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { preview } from 'vite';
const dir = process.env.ACCEPTANCE_DIR;
await preview({
  build: { outDir: `${dir}/dist` },
  preview: {
    host: '127.0.0.1', port: Number(new URL(process.env.SMARTSELL_REVIEWER_ORIGIN).port), strictPort: true,
    https: { key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) },
  },
});
JS
) >"$workdir/web.log" 2>&1 &
web_pid=$!
for ((attempt=0; attempt<60; attempt++)); do
  kill -0 "$web_pid"
  if [[ -n $api_pid ]]; then
    kill -0 "$api_pid"
    curl -fs "http://127.0.0.1:$api_port/readyz" > /dev/null || { sleep 1; continue; }
  fi
  if curl -fsk "$SMARTSELL_REVIEWER_ORIGIN/" > /dev/null; then break; fi
  sleep 1
done
if [[ -n $api_pid ]]; then curl -fsS "http://127.0.0.1:$api_port/readyz" > /dev/null; fi
curl -fskS "$SMARTSELL_REVIEWER_ORIGIN/" > /dev/null
pnpm exec playwright test "tests/web-e2e/$spec.spec.mjs" --output "$workdir/playwright"
