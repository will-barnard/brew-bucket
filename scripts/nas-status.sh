#!/usr/bin/env bash
# One-shot health and capacity check, without opening the web UI.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env
detect_compose

say "containers"
nas "cd '$NAS_APP_DIR' && $COMPOSE_CMD ps" || true

say "health"
nas "wget -qO- http://127.0.0.1:${HOST_PORT:-8477}/healthz" || warn "no response on :${HOST_PORT:-8477}"
echo

say "capacity (requires NODE_SHARED_SECRET)"
if [ -n "${NODE_SHARED_SECRET:-}" ]; then
  nas "wget -qO- --header='x-node-secret: $NODE_SHARED_SECRET' http://127.0.0.1:${HOST_PORT:-8477}/stat" || true
  echo
fi

say "blob count on disk"
nas "find '$NAS_STORAGE_PATH/blobs' -type f 2>/dev/null | wc -l" || true
say "bytes on disk"
nas "du -sh '$NAS_STORAGE_PATH' 2>/dev/null" || true
