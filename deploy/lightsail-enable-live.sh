#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"
readonly BACKUP_FILE="/etc/maetajak/worker.env.before-live"
activated=false

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this activation script as root." >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Worker environment file is missing." >&2
  exit 1
fi
readonly DEPLOY_LOCK_FILE="/run/maetajak-deploy.lock"
# One deploy/activation at a time (the 3-minute auto-deploy timer included). A nested call from a
# script that already holds the lock (auto-deploy -> this script, promotion -> enable-live) inherits it.
acquire_deploy_lock() {
  if [[ "${MAETAJAK_DEPLOY_LOCK_HELD:-}" == "1" ]]; then
    return 0
  fi
  exec 9>"${DEPLOY_LOCK_FILE}"
  if ! flock -w "${DEPLOY_LOCK_WAIT_SECONDS:-900}" 9; then
    echo "Another maetajak deploy or LIVE activation is running (${DEPLOY_LOCK_FILE})." >&2
    exit 1
  fi
  export MAETAJAK_DEPLOY_LOCK_HELD=1
}
acquire_deploy_lock

if ! grep -Eq '^TRADING_MODE=DRY_RUN$' "${ENV_FILE}" || ! grep -Eq '^RUN_READINESS_CHECK=true$' "${ENV_FILE}"; then
  echo "LIVE activation requires a completed DRY_RUN readiness configuration." >&2
  exit 1
fi

read -r -p "Type ENABLE_LIVE_COPY_TRADING to enable real Gate orders: " confirmation
if [[ "${confirmation}" != "ENABLE_LIVE_COPY_TRADING" ]]; then
  echo "LIVE activation cancelled." >&2
  exit 1
fi

install -m 600 -o root -g root "${ENV_FILE}" "${BACKUP_FILE}"
rollback() {
  if [[ "${activated}" != "true" && -f "${BACKUP_FILE}" ]]; then
    install -m 600 -o root -g root "${BACKUP_FILE}" "${ENV_FILE}"
    systemctl stop maetajak-worker.service || true
    sleep 40
    systemctl start maetajak-worker.service || true
    echo "LIVE activation failed. DRY_RUN configuration was restored." >&2
  fi
}
trap rollback ERR

cd "${APP_DIR}"
export MAETAJAK_ENV_FILE="${ENV_FILE}"
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:alert-test
echo "alert_test=passed"

temp_env="$(mktemp /etc/maetajak/worker.env.live.XXXXXX)"
awk '!/^TRADING_MODE=/ && !/^RUN_READINESS_CHECK=/' "${ENV_FILE}" > "${temp_env}"
{
  printf 'TRADING_MODE=LIVE\n'
  printf 'RUN_READINESS_CHECK=false\n'
} >> "${temp_env}"
chown root:root "${temp_env}"
chmod 600 "${temp_env}"
mv -f "${temp_env}" "${ENV_FILE}"

docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
systemctl stop maetajak-worker.service
sleep 40
systemctl start maetajak-worker.service
sleep 15
docker compose -f docker-compose.worker.yml run --rm \
  -e COPY_ACTIVATION_CONFIRMATION=ENABLE_LIVE_COPY_TRADING \
  copy-worker npm run worker:activate
activated=true
trap - ERR

"${APP_DIR}/deploy/lightsail-status.sh"
echo "LIVE copy trading is enabled. New Master position changes can create real member orders."
