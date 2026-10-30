#!/bin/sh
set -eu
. "$(dirname "$0")/common.sh"
trap 'clean_stage' EXIT HUP INT TERM
# Explicit one-time creation; an unavailable or wrong repository never triggers init.
compose run --rm --no-deps -T backup-restic 'exec restic init'
