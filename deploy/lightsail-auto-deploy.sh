#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"

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
  if [[ "$(systemctl is-active maetajak-worker.service || true)" != "active" ]]; then
    echo "auto_deploy=recover_inactive_worker"
    exec "${APP_DIR}/deploy/lightsail-deploy-dry-run.sh"
  fi
  echo "auto_deploy=no_change"
  exit 0
fi

if ! git merge-base --is-ancestor "${local_sha}" "${remote_sha}"; then
  echo "auto_deploy=blocked_non_fast_forward" >&2
  exit 1
fi

database_changes=false
# Database changes may advance only after the production PostgREST schema
# proves the reviewed hedge-mode RPC is already installed. This keeps DB-first
# deployment fail-closed without requiring a manual server fast-forward.
if ! git diff --quiet "${local_sha}" "${remote_sha}" -- supabase/migrations; then
  export MAETAJAK_ENV_FILE="${ENV_FILE}"
  if ! docker compose -f docker-compose.worker.yml run --rm copy-worker node --input-type=module -e '
    const response = await fetch(`${process.env.SUPABASE_URL}/rest/v1/`, {
      headers: {
        apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });
    const schema = response.ok ? await response.json() : {};
    const requiredRpcs = [
      "/rpc/clear_member_copy_baseline_legs",
      "/rpc/get_or_initialize_member_copy_baselines",
      "/rpc/get_admin_gate_broker_metrics",
      "/rpc/upsert_gate_broker_metrics",
    ];
    if (requiredRpcs.some((path) => !schema.paths?.[path])) process.exit(1);
  ' >/dev/null; then
    echo "auto_deploy=blocked_database_migration" >&2
    exit 1
  fi
  database_changes=true
fi

if git diff --quiet "${local_sha}" "${remote_sha}" -- \
  deploy scripts worker Dockerfile.worker docker-compose.worker.yml package.json package-lock.json; then
  git merge --ff-only "${remote_sha}"
  if [[ "${database_changes}" == "true" ]]; then
    echo "auto_deploy=database_migration_already_applied"
  else
    echo "auto_deploy=code_only_fast_forward"
  fi
  echo "commit=${remote_sha}"
  exit 0
fi

exec "${APP_DIR}/deploy/lightsail-deploy-dry-run.sh"
