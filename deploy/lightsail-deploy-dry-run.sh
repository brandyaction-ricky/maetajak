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

failed=true
resume_previous_live=false
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

# A deployment may automatically resume only the exact production system that
# was already healthy and executing LIVE immediately before this deployment.
# A manually halted, unhealthy, DRY_RUN, or OBSERVE system stays fail-closed.
if grep -Eq '^TRADING_MODE=LIVE$' "${ENV_FILE}" && \
  docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:can-resume-live; then
  resume_previous_live=true
  echo "previous_live=verified"
else
  echo "previous_live=not_eligible"
fi

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

# Restore LIVE automatically only when the pre-deployment production state was
# verified healthy. First-time and manually halted promotions still require the
# reviewed, expiring, single-use request below.
if [[ "${resume_previous_live}" == "true" ]]; then
  printf 'ENABLE_LIVE_COPY_TRADING\n' | "${APP_DIR}/deploy/lightsail-enable-live.sh"
  EXPECTED_MODE=LIVE LOG_WINDOW=3m "${APP_DIR}/deploy/lightsail-verify-deployment.sh"
  echo "live_resume=completed"
else
  "${APP_DIR}/deploy/process-live-promotion-request.sh"
fi

failed=false
trap - EXIT
echo "deployed=${previous_sha}->$(git rev-parse HEAD)"
