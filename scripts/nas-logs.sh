#!/usr/bin/env bash
# Tail the storage node's logs. Pass -f to follow.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env
detect_compose
nas "cd '$NAS_APP_DIR' && $COMPOSE_CMD logs --tail=${TAIL:-200} $*"
