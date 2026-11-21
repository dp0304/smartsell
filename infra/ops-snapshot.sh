#!/usr/bin/env bash
set -euo pipefail
umask 077
cd -- "$(dirname -- "$0")/.."

usage() {
  local label=Usage
  case ${SMARTSELL_CLI_LANGUAGE:-en} in
    zh-Hans|zh-Hant) label=用法 ;;
  esac
  printf '%s: %s [backup|restore] smartsell-PROJECT ABSOLUTE_ENV_FILE ABSOLUTE_SNAPSHOT_DIR\n' "$label" "$0"
}
if [[ $# == 1 && $1 == --help ]]; then
  usage
  exit 0
fi
if [[ $# != 4 || ! $2 =~ ^smartsell-[a-z0-9][a-z0-9-]*$ || $3 != /* || $4 != /* ]]; then
  usage >&2
  exit 2
fi
mode=$1 project=$2 env_file=$3 snapshot=$4
compose() {
  # Ignore inherited deployment settings and Compose overrides.
  env -i PATH="$PATH" HOME="$HOME" docker compose --env-file "$env_file" \
    --project-name "$project" --file infra/compose.yaml --profile server "$@"
}
pg_copy() {
  compose run --rm --no-deps -T --entrypoint sh postgres -ec "$1"
}
media_copy() {
  compose run --rm --no-deps -T --entrypoint sh server -ec "$1"
}

case "$mode" in
  backup)
    mkdir -m 700 -- "$snapshot"
    # Quiesce every writer before the physical snapshot. Leave the project stopped.
    compose stop web server
    compose exec -T postgres pg_isready -q
    compose stop postgres
    pg_copy 'test ! -e "$PGDATA/postmaster.pid"; pg_controldata "$PGDATA" | grep -q "Database cluster state:.*shut down$"; tar -C "$PGDATA" -cf - .' > "$snapshot/postgres.tar"
    media_copy 'tar -C "$MEDIA_DIRECTORY" -cf - .' > "$snapshot/media.tar"
    cp -- "$env_file" "$snapshot/source.env"
    chmod 600 "$snapshot/source.env"
    printf '%s\n' "$project" > "$snapshot/source-project"
    (cd "$snapshot" && shasum -a 256 postgres.tar media.tar source.env source-project > SHA256SUMS)
    ;;
  restore)
    (cd "$snapshot" && shasum -a 256 -c SHA256SUMS >/dev/null)
    [[ $(< "$snapshot/source-project") != "$project" ]]
    [[ -z $(docker ps -aq --filter "label=com.docker.compose.project=$project") ]]
    [[ -z $(docker volume ls -q --filter "label=com.docker.compose.project=$project") ]]
    [[ -z $(docker network ls -q --filter "label=com.docker.compose.project=$project") ]]
    pg_copy 'test -z "$(ls -A "$PGDATA")"; tar -C "$PGDATA" -xpf -; test "$(head -n 1 "$PGDATA/PG_VERSION")" = "$PG_MAJOR"' < "$snapshot/postgres.tar"
    media_copy 'test -z "$(ls -A "$MEDIA_DIRECTORY")"; tar -C "$MEDIA_DIRECTORY" -xpf -; touch "$MEDIA_DIRECTORY/.restore-hold"' < "$snapshot/media.tar"
    compose up --detach --wait --wait-timeout 90 postgres
    # App roles are fenced before the target process can start. This seeds the
    # Commands protection; run execution/start_restore_hold to enumerate checks.
    compose exec -T postgres psql -X -U postgres -d smartsell -v ON_ERROR_STOP=1 <<'SQL'
\getenv owner_password SMARTSELL_MIGRATION_PASSWORD
\getenv request_password SMARTSELL_RUNTIME_PASSWORD
\getenv admin_password POSTGRES_PASSWORD
\getenv background_password SMARTSELL_BACKGROUND_PASSWORD
SELECT :'background_password' <> '' AS has_background \gset
BEGIN;
ALTER ROLE app_owner PASSWORD :'owner_password';
ALTER ROLE app_rw PASSWORD :'request_password';
ALTER ROLE postgres PASSWORD :'admin_password';
\if :has_background
ALTER ROLE app_background PASSWORD :'background_password';
\endif
INSERT INTO ss.entities (tenant_id, workspace_id, module, kind, id, data, created_at, updated_at)
SELECT tenant_id, id, 'ops', 'deployment_setting', 'safe_mode',
       jsonb_build_object('key', 'safe_mode', 'workspace_id', id, 'enabled', true,
                          'value', true, 'reason', 'physical restore'), now(), now()
  FROM ss.workspaces
ON CONFLICT (tenant_id, workspace_id, module, kind, id) DO UPDATE
SET data = excluded.data, version = ss.entities.version + 1, updated_at = now();
COMMIT;
SQL
    case ${SMARTSELL_CLI_LANGUAGE:-en} in
      zh-Hans) printf '目标快照已恢复，工作区安全模式已启用。请通过 compose.recovery.yaml 启动。\n' ;;
      zh-Hant) printf '目標快照已還原，工作區安全模式已啟用。請透過 compose.recovery.yaml 啟動。\n' ;;
      *) printf 'Target snapshot restored with workspace safe mode enabled. Start via compose.recovery.yaml.\n' ;;
    esac
    ;;
  *) exit 2 ;;
esac
