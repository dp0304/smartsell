#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export MINIO_ROOT_USER="ss$(openssl rand -hex 8)"
export MINIO_ROOT_PASSWORD="$(openssl rand -hex 32)"
image=${SMARTSELL_TEST_MINIO_IMAGE:-minio/minio:RELEASE.2025-02-28T09-55-16Z}
container=$(docker run --rm --pull=never --detach --tmpfs /data --publish 127.0.0.1::9000 \
  --env MINIO_ROOT_USER --env MINIO_ROOT_PASSWORD "$image" server /data)
trap 'docker stop "$container" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
address=$(docker port "$container" 9000/tcp)
export MEDIA_TEST_S3_ENDPOINT="http://$address"
export MEDIA_TEST_S3_BUCKET=smartsell-media-test
export MEDIA_TEST_S3_ACCESS_KEY=$MINIO_ROOT_USER MEDIA_TEST_S3_SECRET_KEY=$MINIO_ROOT_PASSWORD
for ((attempt=0; attempt<40; attempt++)); do
  if curl --fail --silent "$MEDIA_TEST_S3_ENDPOINT/minio/health/ready" >/dev/null; then break; fi
  sleep 0.5
done
curl --fail --silent "$MEDIA_TEST_S3_ENDPOINT/minio/health/ready" >/dev/null
docker exec --env MEDIA_TEST_S3_BUCKET "$container" sh -ec '
  export MC_HOST_local="http://$MINIO_ROOT_USER:$MINIO_ROOT_PASSWORD@127.0.0.1:9000"
  mc mb "local/$MEDIA_TEST_S3_BUCKET" >/dev/null
'
node --import tsx --test tests/media/files.test.mjs tests/media/op05.test.mjs
