#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
for script in tests/acceptance/domain-postgres.sh tests/acceptance/with-postgres.sh \
  tests/acceptance/publishing-integrity.sh tests/identity/with-postgres.sh tests/media/with-minio.sh; do
  printf 'Running %s\n' "$script"
  bash "$script"
done
bash tests/acceptance/reviewer-sessions.sh
bash tests/acceptance/reviewer-sessions.sh membership
bash infra/smoke.sh command
bash infra/smoke.sh operation
