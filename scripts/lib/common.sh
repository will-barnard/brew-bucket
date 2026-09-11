#!/usr/bin/env bash
# Shared helpers for the NAS deploy scripts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="${BREW_BUCKET_NAS_ENV:-$SCRIPT_DIR/nas.env}"

c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s!!%s %s\n'  "$c_ylw" "$c_off" "$*" >&2; }
die()  { printf '%sxx%s %s\n'  "$c_red" "$c_off" "$*" >&2; exit 1; }
run()  { printf '%s   $ %s%s\n' "$c_dim" "$*" "$c_off" >&2; "$@"; }

load_env() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE — copy scripts/nas.env.example and fill it in"
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a

  : "${NAS_HOST:?NAS_HOST is required}"
  : "${NAS_USER:?NAS_USER is required}"
  : "${NAS_APP_DIR:?NAS_APP_DIR is required}"
  : "${NAS_STORAGE_PATH:?NAS_STORAGE_PATH is required}"
  NAS_PORT="${NAS_PORT:-22}"
  NAS_DOCKER="${NAS_DOCKER:-docker}"
  IMAGE_NAME="${IMAGE_NAME:-brew-bucket-node}"
  IMAGE_TAG="${IMAGE_TAG:-$(git -C "$REPO_DIR" rev-parse --short HEAD 2>/dev/null || echo latest)}"

  SSH_OPTS=(-p "$NAS_PORT" -o BatchMode=yes -o ConnectTimeout=10)
  [ -n "${NAS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${NAS_SSH_KEY/#\~/$HOME}")
  SSH_TARGET="$NAS_USER@$NAS_HOST"
}

nas() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }
nas_sh() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s; }
nas_cp() { scp -P "$NAS_PORT" ${NAS_SSH_KEY:+-i "${NAS_SSH_KEY/#\~/$HOME}"} "$1" "$SSH_TARGET:$2"; }

# Synology and QNAP ship compose as a docker plugin on some versions and as a
# standalone binary on others. Resolve it once rather than guessing per call.
detect_compose() {
  COMPOSE_CMD="$(nas "command -v docker-compose >/dev/null 2>&1 && echo 'docker-compose' || echo '$NAS_DOCKER compose'" || true)"
  [ -n "$COMPOSE_CMD" ] || die "could not find docker compose on the NAS"
}

preflight() {
  say "checking ssh to $SSH_TARGET"
  nas true || die "cannot ssh to $SSH_TARGET — check NAS_HOST/NAS_USER and that your key is authorized"
  nas "$NAS_DOCKER version >/dev/null 2>&1" \
    || die "docker not usable as $NAS_USER on the NAS (try NAS_DOCKER=/usr/local/bin/docker, or add the user to the docker group)"
  detect_compose
  say "docker ok, compose is: $COMPOSE_CMD"
}
