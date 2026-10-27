#!/usr/bin/env bash
# Deploys or updates DMAIC Studio on this server:
#   1. updates these deploy files from GitHub
#   2. pulls the newest image from ghcr.io
#   3. backs up the database
#   4. restarts the app and Caddy and waits until the app is healthy
#
# Usage: ./deploy.sh [--stop-old] [--no-git-pull] [--skip-image-pull]
#   --stop-old         stop (not delete) containers from an earlier `docker run` setup
#                      that use the same database volume
#   --no-git-pull      do not update the deploy files from GitHub
#   --skip-image-pull  use the image already on this machine

# Everything runs inside main(), which bash reads in full before starting, so the
# `git pull` below can safely replace this file while it runs.
main() {
  set -euo pipefail
  cd "$(dirname "$0")"

  local stop_old=false git_pull=true image_pull=true arg
  for arg in "$@"; do
    case "$arg" in
      --stop-old) stop_old=true ;;
      --no-git-pull) git_pull=false ;;
      --skip-image-pull) image_pull=false ;;
      -h | --help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) fail "Unknown option: $arg (see ./deploy.sh --help)" ;;
    esac
  done

  if $git_pull && git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    step "Updating deploy files from GitHub"
    git pull --ff-only
    # Run the freshly pulled version of this script.
    exec "$0" --no-git-pull "$@"
  fi

  [ -f .env ] || fail "Create deploy/.env first:  cp .env.example .env   then set DMAIC_DOMAIN."
  set -a
  # shellcheck source=/dev/null
  . ./.env
  set +a
  if [ -z "${DMAIC_DOMAIN:-}" ] || [ "$DMAIC_DOMAIN" = "dmaic.example.com" ]; then
    fail "Set DMAIC_DOMAIN in deploy/.env."
  fi
  local volume="${DMAIC_VOLUME:-dmaic-data}"
  local keep="${KEEP_BACKUPS:-10}"
  local image="${DMAIC_IMAGE:-ghcr.io/deg333/dmaic:latest}"

  docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is required (the 'docker compose' command)."

  # Containers from a manual `docker run` setup would serve the same database next to this one.
  local old
  old=$(docker ps --filter "volume=$volume" --format '{{.Names}} {{.Label "com.docker.compose.project"}}' | awk '$2 != "dmaic" { print $1 }')
  if [ -n "$old" ]; then
    if ! $stop_old; then
      fail "These containers already use the '$volume' volume: $old
Run ./deploy.sh --stop-old to stop them (they are kept, not deleted), so this setup can take over."
    fi
    step "Stopping earlier container(s): $old"
    # shellcheck disable=SC2086
    docker stop $old >/dev/null
    # shellcheck disable=SC2086
    docker update --restart=no $old >/dev/null
  fi

  if ! docker volume inspect "$volume" >/dev/null 2>&1; then
    step "Creating database volume '$volume'"
    docker volume create "$volume" >/dev/null
  fi

  if $image_pull; then
    step "Pulling $image"
    docker compose pull app caddy || fail "Could not pull the image. If the package is private, run
  docker login ghcr.io -u deg333
with a GitHub token that has the read:packages scope, or make the package public on GitHub."
  fi

  backup "$volume" "$keep" "$image"

  step "Starting DMAIC Studio"
  docker compose up -d --remove-orphans --wait --quiet-pull

  check_site
  docker image prune -f >/dev/null
  local port_suffix=""
  [ "${HTTPS_PORT:-443}" = 443 ] || port_suffix=":$HTTPS_PORT"
  step "Done. DMAIC Studio is running at https://$DMAIC_DOMAIN$port_suffix"
}

step() { printf '\n==> %s\n' "$*"; }
fail() { printf '\nError: %s\n' "$*" >&2; exit 1; }

# Copies the database into the volume's backups/ folder and keeps the newest $keep copies.
backup() {
  local volume="$1" keep="$2" image="$3" stamp
  stamp=$(date -u +%Y%m%d-%H%M%S)
  local target="/data/backups/dmaic-$stamp.sqlite"
  if [ -n "$(docker compose ps -q --status running app 2>/dev/null)" ]; then
    step "Backing up the database to $target"
    # The running app makes a consistent copy while it keeps serving.
    docker compose exec -T app sh -c "mkdir -p /data/backups && dmaic-studio backup $target"
  else
    # Nothing is writing to the database, so copying the files is safe.
    local files
    files=$(docker run --rm -v "$volume:/data" --entrypoint sh "$image" -c 'ls /data/dmaic.sqlite 2>/dev/null || true')
    if [ -z "$files" ]; then
      step "No database yet; skipping backup"
      return
    fi
    step "Backing up the database to $target"
    docker run --rm -u 0 -v "$volume:/data" --entrypoint sh "$image" -c "
      mkdir -p /data/backups && chown 10001 /data/backups
      cp -p /data/dmaic.sqlite $target
      [ ! -f /data/dmaic.sqlite-wal ] || cp -p /data/dmaic.sqlite-wal $target-wal"
  fi
  docker run --rm -u 0 -v "$volume:/data" --entrypoint sh "$image" -c "
    cd /data/backups && ls -1t dmaic-*.sqlite | tail -n +$((keep + 1)) | while read -r old; do rm -f \"\$old\" \"\$old-wal\"; done"
}

# Confirms the site answers through Caddy over HTTPS.
check_site() {
  local port="${HTTPS_PORT:-443}" url="https://$DMAIC_DOMAIN:${HTTPS_PORT:-443}/api/health"
  step "Checking $url"
  for _ in $(seq 1 12); do
    if curl -fsS --max-time 5 --resolve "$DMAIC_DOMAIN:$port:127.0.0.1" "$url" >/dev/null 2>&1; then
      echo "OK"
      return
    fi
    sleep 5
  done
  if curl -fsSk --max-time 5 --resolve "$DMAIC_DOMAIN:$port:127.0.0.1" "$url" >/dev/null 2>&1; then
    echo "Warning: the app answers, but the HTTPS certificate is not trusted yet."
    echo "Check that DNS for $DMAIC_DOMAIN points at this server and ports 80/443 are open: docker compose logs caddy"
  else
    echo "Warning: the site did not answer. See: docker compose logs"
  fi
}

main "$@"
exit
