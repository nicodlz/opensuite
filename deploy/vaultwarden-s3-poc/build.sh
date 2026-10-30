#!/usr/bin/env bash
set -euo pipefail

# Evaluate upstream 1.37.4 without changing its source. The only Dockerfile
# changes pin the two upstream base-image tags and require the Cargo lockfile.
# Do not pass provider credentials or unrelated settings to Git or Docker.
safe_env=(env -i "PATH=$PATH")
for env_name in HOME USER LANG LC_ALL TMPDIR DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG XDG_RUNTIME_DIR SSL_CERT_FILE; do
  if [[ -v "$env_name" ]]; then
    safe_env+=("$env_name=${!env_name}")
  fi
done
work_dir=$(mktemp -d)
trap 'rm -rf "$work_dir"' EXIT
repo="$work_dir/vaultwarden"
"${safe_env[@]}" git clone --quiet --depth 1 --branch 1.37.4 https://github.com/dani-garcia/vaultwarden.git "$repo"
test "$("${safe_env[@]}" git -C "$repo" rev-parse HEAD)" = 7c188967e7a467b19b2757bc3326f9cf3ccae327
sed \
  -e 's|docker.io/library/rust:1.99.0-slim-trixie AS build|docker.io/library/rust:1.99.0-slim-trixie@sha256:2752b332db73fdbb7dc576f06c82ed1f312005784ef913d7e04a28f5f55dc581 AS build|' \
  -e 's|docker.io/library/debian:trixie-slim$|docker.io/library/debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4|' \
  -e 's/xx-cargo build --features/xx-cargo build --locked --features/g' \
  "$repo/docker/Dockerfile.debian" > "$work_dir/Dockerfile"
grep -q 'rust:1.99.0-slim-trixie@sha256:' "$work_dir/Dockerfile"
grep -q 'debian:trixie-slim@sha256:' "$work_dir/Dockerfile"
test "$(grep -c 'xx-cargo build --locked --features' "$work_dir/Dockerfile")" -eq 2
# Reject any unpinned FROM, including future upstream build stages.
if awk 'toupper($1) == "FROM" { for (i = 2; i <= NF; i++) { if ($i !~ /^--/) { if ($i !~ /@sha256:[0-9a-f]{64}$/) bad=1; break } } } END { exit !bad }' "$work_dir/Dockerfile"; then
  echo 'Unpinned Dockerfile base image' >&2
  exit 1
fi
start=$SECONDS
"${safe_env[@]}" docker buildx build --load --file "$work_dir/Dockerfile" \
  --build-arg DB=postgresql,s3 --build-arg VW_VERSION=1.37.4 \
  --tag esuno-vaultwarden-s3-poc-not-for-production:1.37.4 "$repo"
printf 'build elapsed: %s seconds\n' "$((SECONDS - start))"
"${safe_env[@]}" docker image inspect esuno-vaultwarden-s3-poc-not-for-production:1.37.4 --format 'image size: {{.Size}} bytes; id: {{.Id}}'
