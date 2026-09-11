#!/usr/bin/env bash
# Builds the storage-node image locally and leaves it in the local docker daemon.
# Built for linux/amd64 because that is what every x86 NAS runs, and because a
# Mac building natively would produce an arm64 image the NAS silently cannot run.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env

PLATFORM="${BUILD_PLATFORM:-linux/amd64}"

say "building $IMAGE_NAME:$IMAGE_TAG for $PLATFORM"
run docker build \
  --platform "$PLATFORM" \
  -t "$IMAGE_NAME:$IMAGE_TAG" \
  -t "$IMAGE_NAME:latest" \
  "$REPO_DIR/node"

say "built $IMAGE_NAME:$IMAGE_TAG"
docker image ls "$IMAGE_NAME" --format '  {{.Repository}}:{{.Tag}}  {{.Size}}'
