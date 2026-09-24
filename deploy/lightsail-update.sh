#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this update script as root." >&2
  exit 1
fi

readonly DEPLOY_LOCK_FILE="/run/maetajak-deploy.lock"
# One deploy/activation at a time (the 3-minute auto-deploy timer included). A nested call from a
# script that already holds the lock (auto-deploy -> this script, promotion -> enable-live) inherits it.
acquire_deploy_lock() {
  local wait_seconds="${1:-${DEPLOY_LOCK_WAIT_SECONDS:-900}}"
  # Inherit only a lock that this process really holds on the lock file (FD 9 from the parent).
  if [[ "${MAETAJAK_DEPLOY_LOCK_HELD:-}" == "1" && /proc/self/fd/9 -ef "${DEPLOY_LOCK_FILE}" ]] && flock -n 9; then
    return 0
  fi
  exec 9>"${DEPLOY_LOCK_FILE}"
  if ! flock -w "${wait_seconds}" 9; then
    echo "Another maetajak deploy or LIVE activation is running (${DEPLOY_LOCK_FILE})." >&2
    exit 1
  fi
  export MAETAJAK_DEPLOY_LOCK_HELD=1
}
acquire_deploy_lock

cd "${APP_DIR}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to update because the server checkout has local changes." >&2
  exit 1
fi

previous_sha="$(git rev-parse HEAD)"
git fetch origin main
git merge --ff-only origin/main

export MAETAJAK_ENV_FILE="${ENV_FILE}"
docker compose -f docker-compose.worker.yml build --pull copy-worker
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
systemctl stop maetajak-worker.service
sleep 40
systemctl start maetajak-worker.service

echo "Updated ${previous_sha} -> $(git rev-parse HEAD)"
echo "If verification fails, stop the worker before performing a reviewed rollback."
