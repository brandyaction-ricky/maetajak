#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this auto-deployment check as root." >&2
  exit 1
fi

cd "${APP_DIR}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "auto_deploy=blocked_local_changes" >&2
  exit 1
fi

git fetch --quiet origin main
local_sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
if [[ "${local_sha}" == "${remote_sha}" ]]; then
  echo "auto_deploy=no_change"
  exit 0
fi

if ! git merge-base --is-ancestor "${local_sha}" "${remote_sha}"; then
  echo "auto_deploy=blocked_non_fast_forward" >&2
  exit 1
fi

# Database changes must be applied and reviewed before a new Worker can use them.
if ! git diff --quiet "${local_sha}" "${remote_sha}" -- supabase/migrations; then
  echo "auto_deploy=blocked_database_migration" >&2
  exit 1
fi

if git diff --quiet "${local_sha}" "${remote_sha}" -- \
  deploy scripts worker Dockerfile.worker docker-compose.worker.yml package.json package-lock.json; then
  git merge --ff-only "${remote_sha}"
  echo "auto_deploy=code_only_fast_forward"
  echo "commit=${remote_sha}"
  exit 0
fi

exec "${APP_DIR}/deploy/lightsail-deploy-dry-run.sh"
