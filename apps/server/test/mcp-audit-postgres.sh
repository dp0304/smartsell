#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../../.."
pg_image=${SMARTSELL_TEST_PG_IMAGE:-postgres:17-alpine}
endpoint=${DOCKER_HOST:-}
if [[ -n ${MCP_AUDIT_DOCKER_SOCKET:-} ]]; then
  endpoint="unix://$MCP_AUDIT_DOCKER_SOCKET"
elif [[ -z "$endpoint" || -n ${DOCKER_CONTEXT:-} ]]; then
  endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null) || endpoint=unix:///var/run/docker.sock
fi
if [[ "$endpoint" != unix:///* || ! -S "${endpoint#unix://}" ]]; then
  printf '%s\n' 'Select a local Docker Unix socket or set MCP_AUDIT_DOCKER_SOCKET.' >&2
  exit 1
fi
docker=(env -u DOCKER_CONTEXT -u DOCKER_HOST docker --host "$endpoint")
fixture="smartsell-mcp-audit-$(node -p 'require("node:crypto").randomUUID()')"
fixture_secret() { node -p 'require("node:crypto").randomBytes(32).toString("hex")'; }
export POSTGRES_PASSWORD
POSTGRES_PASSWORD=$(fixture_secret)
owner_secret=$(fixture_secret)
request_secret=$(fixture_secret)

"${docker[@]}" run --pull never --rm --detach --name "$fixture" --env POSTGRES_PASSWORD \
  --tmpfs /var/lib/postgresql/data --publish 127.0.0.1::5432 "$pg_image" >/dev/null
trap '"${docker[@]}" rm -f "$fixture" >/dev/null 2>&1 || true' EXIT
ready=false
for ((attempt=0; attempt<60; attempt++)); do
  if "${docker[@]}" exec "$fixture" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then ready=true; break; fi
  sleep 0.5
done
[[ "$ready" == true ]] || { printf '%s\n' 'The temporary PostgreSQL instance did not start.' >&2; exit 1; }

if ! printf "CREATE ROLE app_owner LOGIN PASSWORD '%s';\nCREATE ROLE app_rw LOGIN PASSWORD '%s';\nCREATE DATABASE mcp_audit_transport OWNER app_owner;\nCREATE DATABASE mcp_audit_crash OWNER app_owner;\n" \
  "$owner_secret" "$request_secret" | "${docker[@]}" exec -i "$fixture" psql -X -q -U postgres -v ON_ERROR_STOP=1 >/dev/null 2>&1; then
  printf '%s\n' 'Failed to initialize the temporary database roles.' >&2
  exit 1
fi
binding=$("${docker[@]}" port "$fixture" 5432/tcp)
[[ "$binding" =~ ^127\.0\.0\.1:[0-9]+$ ]] || exit 1
for scenario in transport crash; do
  MIGRATION_DATABASE_URL="postgresql://app_owner:$owner_secret@$binding/mcp_audit_$scenario" pnpm db:migrate:kernel
done
MCP_AUDIT_TEST_POSTGRES_URL="postgresql://app_rw:$request_secret@$binding/mcp_audit_fixture" \
  node --import tsx --test apps/server/src/integration/mcp-audit-reliability.test.ts
