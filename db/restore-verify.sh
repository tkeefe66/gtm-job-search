#!/bin/sh
# Explicit stored artifact on isolated PostgreSQL; see docs/recovery.md.
set -eu
exec node "$(dirname "$0")/restore-verify.mjs" "$@"
