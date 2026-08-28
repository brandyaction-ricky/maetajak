#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"
readonly EXPECTED_MODE="${EXPECTED_MODE:-DRY_RUN}"
readonly LOG_WINDOW="${LOG_WINDOW:-3m}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this verification script as root." >&2
  exit 1
fi

cd "${APP_DIR}"
export MAETAJAK_ENV_FILE="${ENV_FILE}"

service_state="$(systemctl is-active maetajak-worker.service || true)"
if [[ "${service_state}" != "active" ]]; then
  echo "service=${service_state}" >&2
  exit 1
fi

logs="$(docker compose -f docker-compose.worker.yml logs --since "${LOG_WINDOW}" copy-worker 2>&1)"
if ! grep -Eq '"event":"worker_started".*"mode":"'"${EXPECTED_MODE}"'"' <<< "${logs}"; then
  echo "Worker did not start in expected mode ${EXPECTED_MODE}." >&2
  exit 1
fi
if ! grep -Eq '"event":"cycle_complete"' <<< "${logs}"; then
  echo "Worker has not completed a cycle." >&2
  exit 1
fi
if grep -Eq '"event":"(trading_cycle_error|member_sync_failed|worker_failure_report_error)"' <<< "${logs}"; then
  echo "Worker emitted a deployment-blocking error." >&2
  grep -E '"event":"(trading_cycle_error|member_sync_failed|worker_failure_report_error)"' <<< "${logs}" | tail -20 >&2
  exit 1
fi

echo "deployment_verified=true"
echo "mode=${EXPECTED_MODE}"
echo "service=active"
echo "commit=$(git rev-parse HEAD)"
