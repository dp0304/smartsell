#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
mode=${1:-all}
case "$mode" in
  all|integration|recovery) ;;
  *) printf 'Usage: pnpm verify:services [integration|recovery|all]\n' >&2; exit 2 ;;
esac
if [[ $(node --version) != v24.21.0 ]]; then
  printf 'The service fixtures require Node v24.21.0 on PATH\n' >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
pg_image=''
fixture_env() {
  env -i PATH="$PATH" HOME="$HOME" TMPDIR="$work" CI=1 \
    PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-}" SMARTSELL_TEST_PG_IMAGE="$pg_image" "$@"
}
compose() {
  fixture_env POSTGRES_PASSWORD=compose-fixture SMARTSELL_MIGRATION_PASSWORD=compose-fixture \
    SMARTSELL_RUNTIME_PASSWORD=compose-fixture SMARTSELL_BACKGROUND_PASSWORD=compose-fixture \
    docker compose --env-file /dev/null -f infra/compose.yaml --profile server "$@"
}
ensure_image() {
  if ! fixture_env docker image inspect "$1" > /dev/null 2>&1; then
    fixture_env docker pull "$1"
  fi
}

docker_host=$(fixture_env docker context inspect --format '{{.Endpoints.docker.Host}}')
if [[ $docker_host != unix://* || ! -S ${docker_host#unix://} ]]; then
  printf 'Select a local Docker context with a Unix socket\n' >&2
  exit 1
fi
fixture_env docker info --format '{{.ServerVersion}}'
compose config --quiet
pg_image=$(compose config --images | grep '^postgres:.*@sha256:')
ensure_image "$pg_image"

status=0
run() {
  printf '\nRunning %s\n' "$*"
  fixture_env bash "$@" || status=1
}

run_tests() {
  printf '\nRunning %s\n' "$*"
  local log="$work/test-results.log"
  if ! fixture_env "$@" 2>&1 | tee "$log"; then
    status=1
    return
  fi
  # The pinned Node spec and Playwright list reporters summarize fixture skips.
  if ! grep -Eq '^ℹ pass [1-9][0-9]*$|^[[:space:]]+[1-9][0-9]* passed([[:space:]]|$)' "$log" ||
    grep -Eq '^ℹ skipped [1-9][0-9]*$|^[[:space:]]+[1-9][0-9]* skipped([[:space:]]|$)' "$log"; then
    printf 'Expected passing tests with zero skips in %s\n' "$*" >&2
    status=1
  fi
}

if [[ $mode != recovery ]]; then
  minio_image=minio/minio:RELEASE.2025-02-28T09-55-16Z
  ensure_image "$minio_image"
  ffmpeg -version > /dev/null
  ffprobe -version > /dev/null
  if ! ffmpeg -hide_banner -protocols > "$work/ffmpeg-protocols" || ! grep -qx '  fd' "$work/ffmpeg-protocols"; then
    printf 'FFmpeg with the fd protocol is required for the media integration suite\n' >&2
    exit 1
  fi
  chromium=$(fixture_env node -e 'process.stdout.write(require("@playwright/test").chromium.executablePath())')
  if [[ ! -x $chromium ]]; then
    printf 'Install Chromium with pnpm exec playwright install chromium\n' >&2
    exit 1
  fi
  run infra/smoke.sh command
  run infra/smoke.sh operation
  for script in tests/acceptance/domain-postgres.sh tests/acceptance/with-postgres.sh \
    tests/acceptance/publishing-integrity.sh tests/identity/with-postgres.sh \
    tests/acceptance/ai03-postgres.sh tests/acceptance/agent-lifecycle-postgres.sh \
    tests/acceptance/ai05-postgres.sh tests/acceptance/research-operation-postgres.sh \
    tests/acceptance/ambassador-postgres.sh tests/acceptance/worker-catalog-postgres.sh; do
    run_tests bash "$script"
  done
  run_tests MCP_AUDIT_DOCKER_SOCKET="${docker_host#unix://}" bash apps/server/test/mcp-audit-postgres.sh
  run_tests bash tests/acceptance/with-postgres.sh ai02
  run_tests bash tests/acceptance/agent-lifecycle-postgres.sh ai08
  run_tests SMARTSELL_AI07_CHROMIUM="$chromium" SMARTSELL_AI07_DOCKER_SOCKET="${docker_host#unix://}" \
    bash tests/acceptance/ai07-postgres.sh
  run_tests SMARTSELL_TEST_MINIO_IMAGE="$minio_image" bash tests/media/with-minio.sh
  run tests/acceptance/client-delivery.sh --output "$work/client-delivery"
  run_tests bash tests/acceptance/reviewer-sessions.sh
  run_tests bash tests/acceptance/reviewer-sessions.sh membership
  run_tests bash tests/acceptance/reviewer-sessions.sh model-free
fi

if [[ $mode != integration ]]; then
  run infra/ops-compose-smoke.sh
  run tests/acceptance/te06-compose.sh
fi
exit "$status"
