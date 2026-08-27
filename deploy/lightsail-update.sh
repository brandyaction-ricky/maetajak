#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this update script as root." >&2
  exit 1
fi

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
systemctl restart maetajak-worker.service

echo "Updated ${previous_sha} -> $(git rev-parse HEAD)"
echo "If verification fails, stop the worker before performing a reviewed rollback."
