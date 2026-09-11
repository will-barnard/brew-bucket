#!/usr/bin/env bash
# Streams the locally built image to the NAS over ssh. No registry involved,
# which is the point: the NAS has no credentials and needs no outbound internet.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env
[ -n "${COMPOSE_CMD:-}" ] || preflight

docker image inspect "$IMAGE_NAME:$IMAGE_TAG" >/dev/null 2>&1 \
  || { say "image not built yet"; "$SCRIPT_DIR/nas-build.sh"; }

say "shipping $IMAGE_NAME:$IMAGE_TAG to the NAS (this is the slow part)"
# gzip -1: the image is mostly already-compressed layers, so heavier compression
# costs CPU for almost nothing on a LAN link.
docker save "$IMAGE_NAME:$IMAGE_TAG" "$IMAGE_NAME:latest" \
  | gzip -1 \
  | ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "gunzip | $NAS_DOCKER load"

say "image loaded on the NAS"
