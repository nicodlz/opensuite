#!/usr/bin/env bash
set -euo pipefail

# Evaluate upstream 1.37.4 without changing its source. The only Dockerfile
# changes pin the two upstream base-image tags that were not digest-pinned.
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
repo="$work_dir/vaultwarden"
git clone --quiet --depth 1 --branch 1.37.4 https://github.com/dani-garcia/vaultwarden.git "$repo"
test "$(git -C "$repo" rev-parse HEAD)" = 7c188967e7a467b19b2757bc3326f9cf3ccae327
sed \
  -e 's|docker.io/library/rust:1.99.0-slim-trixie AS build|docker.io/library/rust:1.99.0-slim-trixie@sha256:2752b332db73fdbb7dc576f06c82ed1f312005784ef913d7e04a28f5f55dc581 AS build|' \
  -e 's|docker.io/library/debian:trixie-slim$|docker.io/library/debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4|' \
  "$repo/docker/Dockerfile.debian" > "$work_dir/Dockerfile"
grep -q 'rust:1.99.0-slim-trixie@sha256:' "$work_dir/Dockerfile"
grep -q 'debian:trixie-slim@sha256:' "$work_dir/Dockerfile"
start=$SECONDS
docker buildx build --load --file "$work_dir/Dockerfile" \
  --build-arg DB=postgresql,s3 --build-arg VW_VERSION=1.37.4 \
  --tag opensuite-vaultwarden-s3-poc:1.37.4 "$repo"
printf 'build elapsed: %s seconds\n' "$((SECONDS - start))"
docker image inspect opensuite-vaultwarden-s3-poc:1.37.4 --format 'image size: {{.Size}} bytes; id: {{.Id}}'
