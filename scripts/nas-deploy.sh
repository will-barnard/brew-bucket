#!/usr/bin/env bash
# First-time setup on the NAS: creates directories, writes .env and
# docker-compose.yml, ships the image over ssh, and starts the container.
# Safe to re-run; it is the same path nas-update.sh takes minus the config write.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env
preflight

[ -n "${NODE_SHARED_SECRET:-}" ] || die "NODE_SHARED_SECRET is empty in $ENV_FILE — generate one with: openssl rand -hex 32"

say "creating $NAS_APP_DIR and $NAS_STORAGE_PATH on the NAS"
nas "mkdir -p '$NAS_APP_DIR' '$NAS_STORAGE_PATH'" \
  || die "could not create directories — check the path exists on a real volume"

say "writing docker-compose.yml"
nas_cp "$REPO_DIR/node/docker-compose.yml" "$NAS_APP_DIR/docker-compose.yml"

say "writing .env"
# Written via stdin rather than scp so secrets never land in a local temp file.
nas "cat > '$NAS_APP_DIR/.env' && chmod 600 '$NAS_APP_DIR/.env'" <<ENVEOF
STORAGE_PATH=$NAS_STORAGE_PATH
NODE_SHARED_SECRET=$NODE_SHARED_SECRET
DIRECT_URL_SECRET=${DIRECT_URL_SECRET:-}
DIRECT_ENABLED=${DIRECT_ENABLED:-true}
BIND_ADDRESS=${BIND_ADDRESS:-0.0.0.0}
HOST_PORT=${HOST_PORT:-8477}
BREW_BUCKET_TAG=$IMAGE_TAG
ENVEOF

"$SCRIPT_DIR/nas-push-image.sh"

say "starting the storage node"
nas "cd '$NAS_APP_DIR' && $COMPOSE_CMD up -d"

say "waiting for health"
for i in $(seq 1 20); do
  if nas_fetch "http://127.0.0.1:${HOST_PORT:-8477}/healthz" 2>/dev/null | grep -q '"ok":true'; then
    say "storage node is up"
    nas_fetch "http://127.0.0.1:${HOST_PORT:-8477}/healthz"; echo
    cat <<NEXT

Next: register this node in the brew-bucket UI (Nodes -> Add node)

  Name            nas
  Internal URL    http://$NAS_HOST:${HOST_PORT:-8477}
  Direct base URL http://$NAS_HOST:${HOST_PORT:-8477}   (leave blank to disable direct transfers)

The mini reaches the internal URL; LAN clients get handed the direct URL.
NEXT
    exit 0
  fi
  sleep 2
done
warn "node did not report healthy within 40s — check: ./scripts/nas-logs.sh"
exit 1
