#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")/../.."
if [[ $(node --version) != v24.21.0 ]]; then
  printf 'TE06 requires Node v24.21.0 on PATH\n' >&2
  exit 1
fi

work=$(mktemp -d)
project="smartsell-te06-$(openssl rand -hex 8)"
settings="$work/compose.env"
mode=operations
compose() {
  if [[ $mode == operations ]]; then
    set -- -f infra/compose.operations.yaml "$@"
  fi
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file "$settings" --project-name "$project" \
    -f infra/compose.yaml --profile server "$@"
}
cleanup() {
  local status=$? image
  trap - EXIT
  if [[ -f $settings ]]; then
    if (( status != 0 )); then
      compose ps -a >&2 || true
      compose logs --no-color --tail=25 migrate server web >&2 || true
    fi
    compose down --volumes || status=1
    for image in "$project-server:smoke" "$project-web:smoke"; do
      if docker image inspect "$image" >/dev/null 2>&1; then
        if [[ -n $(docker ps -aq --filter "ancestor=$image") ]]; then
          printf 'Retained image with a container reference: %s\n' "$image" >&2
          status=1
        else
          docker image rm "$image" || status=1
        fi
      fi
    done
    if [[ -n $(docker ps -aq --filter "label=com.docker.compose.project=$project") ||
          -n $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ||
          -n $(docker network ls -q --filter "label=com.docker.compose.project=$project") ]]; then
      printf 'Compose resources remain for %s\n' "$project" >&2
      status=1
    elif (( status == 0 )); then
      printf 'Cleaned Compose project %s, its volumes, network and dedicated images\n' "$project"
    fi
  fi
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

for name in POSTGRES_PASSWORD SMARTSELL_MIGRATION_PASSWORD SMARTSELL_RUNTIME_PASSWORD SMARTSELL_BACKGROUND_PASSWORD APP_SECRET SETUP_TOKEN PORTAL_ASSERTION_KEY; do
  printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
done > "$settings"
cat >> "$settings" <<EOF
PUBLIC_ORIGIN=https://workbench.example.test
PORTAL_ORIGIN=https://review.example.test
PORTAL_CUSTOM_ORIGINS=https://north.example.test,https://south.example.test
PG_PORT=0
PORT=0
WEB_PORT=0
PORTAL_PORT=0
SMARTSELL_SERVER_IMAGE=$project-server:smoke
SMARTSELL_WEB_IMAGE=$project-web:smoke
EOF
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=workbench.example.test' \
  -addext 'subjectAltName=DNS:workbench.example.test,DNS:review.example.test,DNS:north.example.test,DNS:south.example.test,DNS:unknown.example.test' \
  -keyout "$work/tls.key" -out "$work/tls.crt" 2> "$work/openssl.log" || { cat "$work/openssl.log" >&2; exit 1; }

printf 'Starting isolated Compose project %s\n' "$project"
compose config --quiet
compose build migrate web
run_stack() {
  compose up --detach --no-build --wait --wait-timeout 120
  local workbench portal
  workbench=$(compose port web 8080)
  portal=$(compose port web 8081)
  node tests/acceptance/te06-compose.mjs "$work" "$project" "$mode" "$workbench" "$portal"
}
run_stack
compose down --volumes
mode=commands
grep -v '^PORTAL_CUSTOM_ORIGINS=' "$settings" > "$work/single.env"
mv "$work/single.env" "$settings"
run_stack
