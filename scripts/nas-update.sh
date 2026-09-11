#!/usr/bin/env bash
# Rebuild, ship, recreate. The update path for an already-deployed node.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env
preflight

nas "test -f '$NAS_APP_DIR/docker-compose.yml'" \
  || die "no deployment found at $NAS_APP_DIR — run ./scripts/nas-deploy.sh first"

"$SCRIPT_DIR/nas-build.sh"
"$SCRIPT_DIR/nas-push-image.sh"

say "pointing the deployment at $IMAGE_TAG"
nas_cp "$REPO_DIR/node/docker-compose.yml" "$NAS_APP_DIR/docker-compose.yml"
nas "cd '$NAS_APP_DIR' && sed -i.bak 's/^BREW_BUCKET_TAG=.*/BREW_BUCKET_TAG=$IMAGE_TAG/' .env || echo 'BREW_BUCKET_TAG=$IMAGE_TAG' >> .env"

say "recreating the container"
# Blob data lives in a bind mount, so recreating the container never touches it.
nas "cd '$NAS_APP_DIR' && $COMPOSE_CMD up -d --force-recreate"

sleep 3
if nas "wget -qO- http://127.0.0.1:${HOST_PORT:-8477}/healthz" 2>/dev/null | grep -q '"ok":true'; then
  say "updated to $IMAGE_TAG and healthy"
else
  warn "container recreated but not healthy yet — ./scripts/nas-logs.sh"
  exit 1
fi

say "pruning old images on the NAS"
nas "$NAS_DOCKER image prune -f >/dev/null" || true
