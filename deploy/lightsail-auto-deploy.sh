#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"
readonly DEPLOY_LOCK_FILE="/run/maetajak-deploy.lock"
# `touch /etc/maetajak/maintenance` pauses this timer (no fast-forward, no recovery, no redeploy)
# while an operator works on the box; remove the file to resume.
readonly MAINTENANCE_FILE="/etc/maetajak/maintenance"
readonly NOTICE_STATE_FILE="/var/lib/maetajak/auto-deploy-pending-notice"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this auto-deployment check as root." >&2
  exit 1
fi

if [[ -f "${MAINTENANCE_FILE}" ]]; then
  echo "auto_deploy=maintenance"
  exit 0
fi

# One deploy/activation at a time. A manual script holding the lock wins; retry on the next tick.
exec 9>"${DEPLOY_LOCK_FILE}"
if ! flock -n 9; then
  echo "auto_deploy=busy"
  exit 0
fi
export MAETAJAK_DEPLOY_LOCK_HELD=1

live_mode=false
if grep -Eq '^TRADING_MODE=LIVE$' "${ENV_FILE}" 2>/dev/null; then
  live_mode=true
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

worker_changes=false
if ! git diff --quiet "${local_sha}" "${remote_sha}" -- \
  deploy scripts worker Dockerfile.worker docker-compose.worker.yml package.json package-lock.json; then
  worker_changes=true
fi

# A worker redeploy always ends in DRY_RUN, i.e. it switches real copying off. Never do that on a
# timer while LIVE: report once per commit and leave the running release untouched until an operator
# runs the DRY_RUN deploy + LIVE activation procedure.
if [[ "${worker_changes}" == "true" && "${live_mode}" == "true" ]]; then
  echo "auto_deploy=pending_live_worker_update"
  echo "commit=${remote_sha}"
  install -d -m 700 -o root -g root "$(dirname "${NOTICE_STATE_FILE}")"
  if [[ "$(cat "${NOTICE_STATE_FILE}" 2>/dev/null || true)" != "${remote_sha}" ]]; then
    export MAETAJAK_ENV_FILE="${ENV_FILE}"
    if docker compose -f docker-compose.worker.yml run --rm \
      -e DEPLOY_NOTICE_EVENT=AUTO_DEPLOY_PENDING_LIVE -e DEPLOY_NOTICE_COMMIT="${remote_sha}" \
      copy-worker node scripts/deploy-notice.js >/dev/null 2>&1; then
      printf '%s\n' "${remote_sha}" > "${NOTICE_STATE_FILE}"
    fi
  fi
  exit 0
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
      "/rpc/upsert_copy_current_state",
      "/rpc/get_copy_safety_version",
      "/rpc/get_copy_resume_context",
      "/rpc/authorize_copy_order_submission",
      "/rpc/record_verified_copy_worker_cycle",
      "/rpc/get_copy_state_reconciliation",
    ];
    if (requiredRpcs.some((path) => !schema.paths?.[path])) process.exit(1);
    const versionResponse = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/get_copy_safety_version`, {
      method: "POST", headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" }, body: "{}",
    });
    const version = versionResponse.ok ? await versionResponse.json() : {};
    if (version.schema_version !== 3 || version.worker_version !== "0.5.0"
      || !version.current_state_atomic || !version.trade_alert_exchange_verification
      || !(Number(version.reliability_patch) >= 1)) process.exit(1);
  ' >/dev/null; then
    echo "auto_deploy=blocked_database_migration" >&2
    exit 1
  fi
  database_changes=true
fi

if [[ "${worker_changes}" == "false" ]]; then
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
