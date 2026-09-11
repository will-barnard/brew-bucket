#!/usr/bin/env bash
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env
detect_compose
say "restarting storage node"
nas "cd '$NAS_APP_DIR' && $COMPOSE_CMD restart"
