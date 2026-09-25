#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"
readonly LEASE_WAIT_SECONDS="${LEASE_WAIT_SECONDS:-40}"
readonly VERIFY_WAIT_SECONDS="${VERIFY_WAIT_SECONDS:-20}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this deployment script as root." >&2
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

failed=true
keep_safe() {
  if [[ "${failed}" == "true" ]]; then
    systemctl stop maetajak-worker.service >/dev/null 2>&1 || true
    echo "Deployment failed. Worker remains stopped and live execution remains halted." >&2
  fi
}
trap keep_safe EXIT

cd "${APP_DIR}"
if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing to deploy because the server checkout has local changes." >&2
  exit 1
fi

export MAETAJAK_ENV_FILE="${ENV_FILE}"
previous_sha="$(git rev-parse HEAD)"

# Stop order-producing processes before changing code or configuration.
systemctl stop maetajak-worker.service
docker compose -f docker-compose.worker.yml run --rm \
  -e COPY_HALT_REASON=AUTOMATED_DRY_RUN_DEPLOYMENT \
  copy-worker npm run worker:halt
sleep "${LEASE_WAIT_SECONDS}"

git fetch origin main
git merge --ff-only origin/main
"${APP_DIR}/deploy/set-worker-mode.sh" DRY_RUN

docker compose -f docker-compose.worker.yml build --pull copy-worker
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
systemctl start maetajak-worker.service
sleep "${VERIFY_WAIT_SECONDS}"
EXPECTED_MODE=DRY_RUN "${APP_DIR}/deploy/lightsail-verify-deployment.sh"
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:alert-test
echo "alert_test=passed"

# Deployments always end in DRY_RUN. LIVE requires a separate operator action.
echo "live_resume=disabled"

failed=false
trap - EXIT
echo "deployed=${previous_sha}->$(git rev-parse HEAD)"
