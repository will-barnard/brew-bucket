#!/usr/bin/env bash
# Run this FIRST, before nas-deploy.sh. Answers the three questions the deploy
# needs and cannot safely guess: can we get in, what architecture is it, and
# where should blobs live.
. "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
load_env

say "ssh $SSH_TARGET -p $NAS_PORT"
nas true || die "cannot ssh in — check the host/user/port and that your key is authorized (ssh-copy-id -p $NAS_PORT $SSH_TARGET)"
echo "  ok"

say "identity"
nas 'uname -a; echo; cat /etc/*release 2>/dev/null | head -4' || true

say "architecture"
arch="$(nas_arch)"
plat="$(platform_from_arch "$arch")"
if [ -n "$plat" ]; then
  echo "  $arch → will build $plat"
else
  warn "  unrecognised architecture '$arch' — set BUILD_PLATFORM in $ENV_FILE manually"
fi

say "docker"
echo "  binaries present:"
nas 'for p in /usr/local/bin/docker /usr/bin/docker /bin/docker /volume1/@appstore/ContainerManager/usr/bin/docker /volume1/@appstore/Docker/usr/bin/docker; do [ -x "$p" ] && echo "    $p"; done' || true

docker_ok=""
for cand in "$NAS_DOCKER" /usr/local/bin/docker /usr/bin/docker; do
  [ -n "$cand" ] || continue
  if nas "$cand version --format '{{.Server.Version}}'" 2>/dev/null | sed 's/^/  direct: /'; then
    docker_ok="$cand"; break
  fi
done
if [ -z "$docker_ok" ]; then
  for cand in "$NAS_DOCKER" /usr/local/bin/docker /usr/bin/docker; do
    [ -n "$cand" ] || continue
    if nas "sudo -n $cand version --format '{{.Server.Version}}'" 2>/dev/null | sed 's/^/  via sudo: /'; then
      docker_ok="sudo -n $cand"
      warn "  direct access failed; set NAS_DOCKER=\"sudo -n $cand\" in $ENV_FILE"
      break
    fi
  done
fi
if [ -n "$docker_ok" ]; then
  echo "  usable as: $docker_ok"
  NAS_DOCKER="$docker_ok"
  detect_compose && echo "  compose: $COMPOSE_CMD"
else
  warn "  docker is not reachable as $NAS_USER over a non-interactive ssh session."
  cat <<'HINT'
    On DSM the docker socket is root-owned. Two ways through:
      1. Add the user to the "administrators" group in DSM (Control Panel ->
         User & Group), then on the NAS:
           echo 'USER ALL=(ALL) NOPASSWD: /usr/local/bin/docker' | sudo tee /etc/sudoers.d/brew-bucket-docker
           sudo chmod 440 /etc/sudoers.d/brew-bucket-docker
         then set NAS_DOCKER="sudo -n /usr/local/bin/docker"
      2. Or, if DSM created a docker group:  sudo synogroup --member docker USER
HINT
fi

say "http client on the NAS (used for health checks)"
nas 'command -v curl || command -v wget || echo "    NEITHER — health checks will not work"' || true

say "DSM firewall"
echo "  if Control Panel -> Security -> Firewall is enabled, port ${HOST_PORT:-8477}"
echo "  must be allowed from the LAN, or the mini cannot reach the node."

say "candidate storage volumes (largest first)"
# Deliberately vendor-agnostic: Synology uses /volume*, QNAP /share/*,
# unRAID /mnt/user, TrueNAS /mnt/<pool>. Report whatever is actually mounted
# rather than assuming a layout.
nas "df -h 2>/dev/null | awk 'NR==1 || \$6 ~ \"^/(volume|share|mnt|data|tank|storage)\"' | sort -k2 -h -r" || true

say "current value in $ENV_FILE"
echo "  NAS_STORAGE_PATH=$NAS_STORAGE_PATH"
if nas "test -d '$(dirname "$NAS_STORAGE_PATH")'"; then
  echo "  parent exists — nas-deploy.sh will create the directory"
  nas "test -w '$(dirname "$NAS_STORAGE_PATH")'" \
    && echo "  and it is writable by $NAS_USER" \
    || warn "  but $NAS_USER cannot write there — the deploy will fail"
else
  warn "  parent does NOT exist — pick a path under one of the volumes above"
fi

say "secrets"
[ -n "${NODE_SHARED_SECRET:-}" ] \
  && echo "  NODE_SHARED_SECRET is set (${#NODE_SHARED_SECRET} chars)" \
  || warn "  NODE_SHARED_SECRET is empty — generate it before deploying"

echo
say "if everything above looks right: ./scripts/nas-deploy.sh"
