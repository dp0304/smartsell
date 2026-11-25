#!/usr/bin/env bash
# Media integration tests against a throwaway S3-compatible server.
# RustFS (Apache-2.0) replaces MinIO, whose community images were withdrawn from Docker Hub and quay.io in 2026-09.
set -euo pipefail
cd "$(dirname "$0")/../.."
access_key="ss$(openssl rand -hex 8)"
secret_key="$(openssl rand -hex 32)"
image=${SMARTSELL_TEST_S3_IMAGE:-rustfs/rustfs:1.0.6}
# The image runs as uid 10001 and exits with "Permission denied" on a root-owned /data, so the tmpfs is owned by it.
container=$(docker run --pull=never --detach --tmpfs /data:uid=10001,gid=10001,mode=750 --publish 127.0.0.1::9000 \
  --env RUSTFS_ACCESS_KEY="$access_key" --env RUSTFS_SECRET_KEY="$secret_key" \
  --env RUSTFS_CONSOLE_ENABLE=false --env RUSTFS_CHECK_UPDATE=false --env RUSTFS_OBS_LOGGER_LEVEL=error \
  "$image" /data)
trap 'docker rm --force "$container" >/dev/null' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
address=$(docker port "$container" 9000/tcp | head -n 1)
export MEDIA_TEST_S3_ENDPOINT="http://$address"
export MEDIA_TEST_S3_BUCKET=smartsell-media-test
export MEDIA_TEST_S3_ACCESS_KEY=$access_key MEDIA_TEST_S3_SECRET_KEY=$secret_key
for ((attempt=0; attempt<60; attempt++)); do
  if curl --fail --silent "$MEDIA_TEST_S3_ENDPOINT/health/ready" >/dev/null; then break; fi
  sleep 0.5
done
if ! curl --fail --silent "$MEDIA_TEST_S3_ENDPOINT/health/ready" >/dev/null; then
  printf 'RustFS did not become ready (%s):\n' "$(docker inspect --format '{{.State.Status}} exit={{.State.ExitCode}}' "$container")" >&2
  docker logs --tail 50 "$container" >&2
  exit 1
fi
# The RustFS image ships no client tools; create the bucket with a SigV4-signed PUT.
curl --fail --silent --show-error --aws-sigv4 'aws:amz:us-east-1:s3' --user "$access_key:$secret_key" \
  --request PUT "$MEDIA_TEST_S3_ENDPOINT/$MEDIA_TEST_S3_BUCKET" >/dev/null
node --import tsx --test tests/media/files.test.mjs tests/media/op05.test.mjs
