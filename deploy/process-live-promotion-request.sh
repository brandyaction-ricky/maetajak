#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly REQUEST_FILE="${APP_DIR}/deploy/live-promotion.request"
readonly STATE_DIR="/var/lib/maetajak/live-promotions"
readonly ENV_FILE="/etc/maetajak/worker.env"

# Automatic deployments never authorize LIVE, including legacy request files.
if [[ "${MAETAJAK_ALLOW_LIVE_PROMOTION:-false}" != "true" ]]; then
  echo "live_promotion=operator_action_required"
  exit 0
fi

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this promotion processor as root." >&2
  exit 1
fi

if [[ ! -f "${REQUEST_FILE}" ]]; then
  echo "live_promotion=not_requested"
  exit 0
fi

token="$(sed -n 's/^token=//p' "${REQUEST_FILE}" | head -n 1)"
expires_at="$(sed -n 's/^expires_at=//p' "${REQUEST_FILE}" | head -n 1)"
if [[ ! "${token}" =~ ^[a-zA-Z0-9_-]{16,80}$ ]] || [[ -z "${expires_at}" ]]; then
  echo "live_promotion=invalid_request" >&2
  exit 1
fi

install -d -m 700 -o root -g root "${STATE_DIR}"
state_file="${STATE_DIR}/${token}"
if [[ -f "${state_file}" ]]; then
  echo "live_promotion=already_completed"
  exit 0
fi

expires_epoch="$(date -u -d "${expires_at}" +%s 2>/dev/null || true)"
now_epoch="$(date -u +%s)"
if [[ -z "${expires_epoch}" ]] || (( now_epoch > expires_epoch )); then
  echo "live_promotion=expired" >&2
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
# Never wait behind another deploy: LIVE must be enabled on the build the operator just checked.
acquire_deploy_lock 0

cd "${APP_DIR}"
export MAETAJAK_ENV_FILE="${ENV_FILE}"

# Recheck the exact production logs immediately before enabling real orders.
EXPECTED_MODE=DRY_RUN LOG_WINDOW=5m "${APP_DIR}/deploy/lightsail-verify-deployment.sh"
logs="$(docker compose -f docker-compose.worker.yml logs --since 5m copy-worker 2>&1)"
echo "live_promotion=deployment_cycle_verified"

printf 'ENABLE_LIVE_COPY_TRADING\n' | "${APP_DIR}/deploy/lightsail-enable-live.sh"
EXPECTED_MODE=LIVE LOG_WINDOW=3m "${APP_DIR}/deploy/lightsail-verify-deployment.sh"
install -m 600 -o root -g root /dev/null "${state_file}"
echo "live_promotion=completed"
echo "live_execution=true"
