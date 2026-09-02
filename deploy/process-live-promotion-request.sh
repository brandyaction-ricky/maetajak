#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly REQUEST_FILE="${APP_DIR}/deploy/live-promotion.request"
readonly STATE_DIR="/var/lib/maetajak/live-promotions"
readonly ENV_FILE="/etc/maetajak/worker.env"

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

cd "${APP_DIR}"
export MAETAJAK_ENV_FILE="${ENV_FILE}"

# Recheck the exact production logs immediately before enabling real orders.
EXPECTED_MODE=DRY_RUN LOG_WINDOW=5m "${APP_DIR}/deploy/lightsail-verify-deployment.sh"
logs="$(docker compose -f docker-compose.worker.yml logs --since 5m copy-worker 2>&1)"
if ! grep -Eq '"event":"cycle_complete".*"observed":[1-9][0-9]*.*"masterObserved":1' <<< "${logs}"; then
  echo "live_promotion=blocked_no_healthy_member_cycle" >&2
  exit 1
fi
if ! grep -Eq '"event":"dry_run_plan"' <<< "${logs}"; then
  # A maintenance deployment can legitimately have no new copy delta. Accept
  # only an explicitly clean no-op cycle; any intent or submission still
  # requires the normal dry-run plan evidence above.
  if ! grep -Eq '"event":"cycle_complete".*"intents":0.*"reconciled":0.*"submitted":0' <<< "${logs}"; then
    echo "live_promotion=blocked_no_member_plan" >&2
    exit 1
  fi
  echo "live_promotion=no_op_cycle_verified"
fi

printf 'ENABLE_LIVE_COPY_TRADING\n' | "${APP_DIR}/deploy/lightsail-enable-live.sh"
EXPECTED_MODE=LIVE LOG_WINDOW=3m "${APP_DIR}/deploy/lightsail-verify-deployment.sh"
install -m 600 -o root -g root /dev/null "${state_file}"
echo "live_promotion=completed"
echo "live_execution=true"
