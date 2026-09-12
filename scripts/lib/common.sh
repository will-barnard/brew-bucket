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

  # LogLevel=ERROR silences OpenSSH 10's post-quantum KEX warning, which older
  # NAS sshd builds trigger on every call. Real failures (auth, host key
  # changes) are errors and still print.
  SSH_OPTS=(-p "$NAS_PORT" -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR)
  [ -n "${NAS_SSH_KEY:-}" ] && SSH_OPTS+=(-i "${NAS_SSH_KEY/#\~/$HOME}")
  SSH_TARGET="$NAS_USER@$NAS_HOST"
}

nas() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "$@"; }

# Fetch a URL from the NAS itself. DSM ships wget on some versions and curl on
# others, so try both rather than betting on one.
nas_fetch() {
  nas "if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 10 '$1'; \
       elif command -v wget >/dev/null 2>&1; then wget -qO- -T 10 '$1'; \
       else echo 'NO_HTTP_CLIENT'; exit 1; fi"
}

# Same, with a header (used for the authenticated /stat probe).
nas_fetch_auth() {
  nas "if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 10 -H 'x-node-secret: $2' '$1'; \
       elif command -v wget >/dev/null 2>&1; then wget -qO- -T 10 --header='x-node-secret: $2' '$1'; \
       else echo 'NO_HTTP_CLIENT'; exit 1; fi"
}
nas_sh() { ssh "${SSH_OPTS[@]}" "$SSH_TARGET" bash -s; }
# Deliberately not scp. OpenSSH 9+ scp speaks the SFTP protocol, and DSM does
# not enable the sftp subsystem by default — you get "subsystem request failed
# on channel 0". Piping over a plain ssh channel needs nothing but a shell on
# the far end, which is the same thing every other call here already assumes.
nas_cp() {
  ssh "${SSH_OPTS[@]}" "$SSH_TARGET" "cat > '$2'" < "$1" \
    || die "failed to write $2 on the NAS"
}

# On Synology the docker socket is root-owned and there is often no docker
# group, so a non-interactive ssh needs `sudo docker` — but sudo without a tty
# only works with a NOPASSWD rule. Work out which spelling actually functions
# rather than guessing, and say precisely what to fix if none do.
resolve_docker() {
  local candidates=("$NAS_DOCKER" "/usr/local/bin/docker" "/usr/bin/docker")
  local c
  for c in "${candidates[@]}"; do
    [ -n "$c" ] || continue
    if nas "$c version >/dev/null 2>&1"; then
      NAS_DOCKER="$c"; export NAS_DOCKER; return 0
    fi
  done
  for c in "${candidates[@]}"; do
    [ -n "$c" ] || continue
    if nas "sudo -n $c version >/dev/null 2>&1"; then
      NAS_DOCKER="sudo -n $c"; export NAS_DOCKER
      warn "using 'sudo -n $c' — this user cannot reach the docker socket directly"
      return 0
    fi
  done
  die "docker is not usable as $NAS_USER over a non-interactive ssh session.
     Run ./scripts/nas-probe.sh for what is actually on the box. Usually one of:
       - add $NAS_USER to DSM's 'administrators' group, then add a NOPASSWD sudoers
         rule:  echo '$NAS_USER ALL=(ALL) NOPASSWD: /usr/local/bin/docker' | sudo tee /etc/sudoers.d/docker
       - or set NAS_DOCKER explicitly in $ENV_FILE"
}

# Synology and QNAP ship compose as a docker plugin on some versions and as a
# standalone binary on others. Resolve it once rather than guessing per call.
detect_compose() {
  COMPOSE_CMD="$(nas "command -v docker-compose >/dev/null 2>&1 && echo 'docker-compose' || echo '$NAS_DOCKER compose'" || true)"
  [ -n "$COMPOSE_CMD" ] || die "could not find docker compose on the NAS"
}

# Most x86 NAS boxes are amd64, but plenty of Synology/QNAP models are ARM.
# Guessing wrong produces `exec format error` from the container with no hint
# as to why, so ask the NAS what it is and build for that.
platform_from_arch() {
  case "$1" in
    x86_64|amd64)        echo linux/amd64 ;;
    aarch64|arm64)       echo linux/arm64 ;;
    armv7l|armv7|armhf)  echo linux/arm/v7 ;;
    *)                   echo '' ;;
  esac
}

# Best-effort: never fatal, so a build with the NAS offline still works.
nas_arch() { nas 'uname -m' 2>/dev/null | tr -d '\r' || true; }

resolve_platform() {
  local arch detected
  arch="$(nas_arch)"
  detected="$(platform_from_arch "$arch")"

  if [ -n "${BUILD_PLATFORM:-}" ]; then
    [ -z "$detected" ] || [ "$BUILD_PLATFORM" = "$detected" ] \
      || warn "building $BUILD_PLATFORM but the NAS reports $arch ($detected) — the container will not start unless you meant this"
  elif [ -n "$detected" ]; then
    BUILD_PLATFORM="$detected"
  elif [ -n "$arch" ]; then
    die "unrecognised NAS architecture '$arch' — set BUILD_PLATFORM in $ENV_FILE manually"
  else
    BUILD_PLATFORM=linux/amd64
    warn "could not reach the NAS to detect its architecture; assuming $BUILD_PLATFORM"
  fi
  # Exported so nas-build.sh and nas-push-image.sh inherit it instead of
  # re-probing over ssh.
  export BUILD_PLATFORM
}

preflight() {
  say "checking ssh to $SSH_TARGET"
  nas true || die "cannot ssh to $SSH_TARGET — check NAS_HOST/NAS_USER and that your key is authorized"
  resolve_docker
  detect_compose
  resolve_platform
  say "docker ok, compose is: $COMPOSE_CMD, building for $BUILD_PLATFORM"

  check_storage_path
}

# A bind mount onto a path that does not exist gets created as an empty
# directory by Docker, so a bad path looks like it worked and then silently
# stores nothing where you expected. Verify we can actually write there BEFORE
# building a 400MB image and shipping it over the wire.
check_storage_path() {
  local parent
  parent="$(dirname "$NAS_STORAGE_PATH")"

  # Already there (e.g. created as a DSM shared folder) is the happy path.
  nas "test -d '$NAS_STORAGE_PATH'" && return 0

  nas "test -d '$parent'" \
    || die "$parent does not exist on the NAS — check NAS_STORAGE_PATH points at a real volume"

  nas "test -w '$parent'" && return 0

  # On Synology, /volume1 is the volume root: only DSM-managed shared folders
  # live there and no user can mkdir into it. This is the single most common
  # way this deploy fails.
  if [ "$parent" = "/volume1" ] || [ "$parent" = "/volume2" ]; then
    die "cannot create '$NAS_STORAGE_PATH' — on DSM, $parent is the volume root and
     only shared folders created through DSM can live there.

     Pick one:
       a) Create a shared folder (recommended, and where bulk data belongs):
            DSM -> Control Panel -> Shared Folder -> Create
            Name: $(basename "$NAS_STORAGE_PATH")   Location: $parent
            Grant $NAS_USER read/write, then re-run this script.
       b) Or store blobs inside a shared folder you already have, e.g.
            NAS_STORAGE_PATH=$NAS_APP_DIR/data
          in $ENV_FILE. Same volume, same space, less tidy."
  fi

  die "$NAS_USER cannot write to '$parent' on the NAS — fix the permissions or choose another path in $ENV_FILE"
}
