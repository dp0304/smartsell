#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")/.."
work=$(mktemp -d)
source_project="smartsell-ops-$(openssl rand -hex 8)"
target_project="smartsell-ops-$(openssl rand -hex 8)"
source_env="$work/source.env"
target_env="$work/target.env"
snapshot="$work/snapshot"
offline_overlay="$work/offline.yaml"
compose() {
  local project=$1 config=$2
  shift 2
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file "$config" --project-name "$project" \
    -f infra/compose.yaml --profile server "$@"
}
cleanup() {
  local status=$?
  local project stack config
  trap - EXIT
  for project in "$source_project" "$target_project"; do
    stack=source_stack
    config=$source_env
    if [[ $project == "$target_project" ]]; then stack=target_stack; config=$target_env; fi
    [[ -f $config ]] || continue
    if (( status != 0 )); then
      "$stack" logs --no-color --tail=30 server > "$work/server.log" 2>&1 || true
      # Report only setup diagnostics, never request logs or connection strings.
      grep -E 'Error:|at |requires|[Uu]nable|missing' "$work/server.log" | grep -vE '://|[a-f0-9]{32}' >&2 || true
    fi
    "$stack" down --volumes || status=1
  done
  docker image rm "$source_project-server:smoke" "$source_project-web:smoke" >/dev/null 2>&1 || true
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for name in POSTGRES_PASSWORD SMARTSELL_MIGRATION_PASSWORD SMARTSELL_RUNTIME_PASSWORD SMARTSELL_BACKGROUND_PASSWORD APP_SECRET SETUP_TOKEN IDENTITY_ENCRYPTION_KEY PORTAL_ASSERTION_KEY SMARTSELL_COMMERCE_ENCRYPTION_KEY; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
done > "$source_env"
printf 'PUBLIC_ORIGIN=https://workbench.example.invalid\nPORTAL_ORIGIN=https://review.example.invalid\nPG_PORT=0\nPORT=0\nWEB_PORT=0\nPORTAL_PORT=0\nSMARTSELL_SERVER_IMAGE=%s-server:smoke\nSMARTSELL_WEB_IMAGE=%s-web:smoke\n' "$source_project" "$source_project" >> "$source_env"
grep -vE '^(POSTGRES_PASSWORD|SMARTSELL_(MIGRATION|RUNTIME|BACKGROUND)_PASSWORD)=' "$source_env" > "$target_env"
for name in POSTGRES_PASSWORD SMARTSELL_MIGRATION_PASSWORD SMARTSELL_RUNTIME_PASSWORD SMARTSELL_BACKGROUND_PASSWORD; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
done >> "$target_env"
source_stack() { compose "$source_project" "$source_env" "$@"; }
target_stack() {
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file "$target_env" --project-name "$target_project" \
    -f infra/compose.yaml -f infra/compose.recovery.yaml -f "$offline_overlay" --profile server "$@"
}
loopback_url() {
  local address=$($1 port "$2" "$3")
  [[ $address == 127.0.0.1:* ]] || return 1
  printf 'http://%s\n' "$address"
}
fixture() {
  local stack=$1 phase=$2
  SMARTSELL_OPS_WEB_URL=$(loopback_url "$stack" web 8080) \
  SMARTSELL_OPS_PORTAL_URL=$(loopback_url "$stack" web 8081) \
  node infra/ops-compose-smoke.mjs "$phase" "$work" "$source_env"
}
# Leave Web's loopback listener reachable while isolating all restored application processes.
cat > "$offline_overlay" <<'YAML'
services:
  postgres:
    networks: [recovery]
    ports: !reset []
  migrate:
    networks: [recovery]
  server:
    networks: [recovery]
    ports: !reset []
  web:
    networks: [default, recovery]
networks:
  recovery:
    internal: true
YAML

source_stack build migrate web
source_stack up --detach --no-build --pull never --wait --wait-timeout 120
fixture source_stack source
source_stack exec -T postgres psql -X -U postgres -d smartsell -v ON_ERROR_STOP=1 < infra/ops-restore-fixture.sql
bash infra/ops-snapshot.sh backup "$source_project" "$source_env" "$snapshot"
bash infra/ops-snapshot.sh restore "$target_project" "$target_env" "$snapshot"
target_stack up --detach --no-build --pull never --wait --wait-timeout 120
recovery_network="${target_project}_recovery"
[[ $(docker network inspect --format '{{.Internal}}' "$recovery_network") == true ]]
[[ $(docker inspect --format '{{range $name, $_ := .NetworkSettings.Networks}}{{$name}}{{end}}' "$(target_stack ps -q server)") == "$recovery_network" ]]
printf 'Restored application server is attached only to its internal recovery network\n'
fixture target_stack restored
