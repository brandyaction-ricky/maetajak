#!/usr/bin/env bash
set -Eeuo pipefail

readonly ENV_FILE="${MAETAJAK_ENV_FILE:-/etc/maetajak/worker.env}"
readonly MODE="${1:-}"
readonly APP_DIR="/opt/maetajak"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Worker environment file is missing." >&2
  exit 1
fi
if [[ "${MODE}" != "DRY_RUN" && "${MODE}" != "LIVE" && "${MODE}" != "OBSERVE" ]]; then
  echo "Mode must be OBSERVE, DRY_RUN, or LIVE." >&2
  exit 1
fi

# Deployments build the image explicitly before starting systemd. Keep the
# installed unit synchronized with the checked-out release so systemd does not
# repeat the build and hit its start timeout on small Lightsail instances.
install -m 644 -o root -g root \
  "${APP_DIR}/deploy/maetajak-worker.service" \
  /etc/systemd/system/maetajak-worker.service
systemctl daemon-reload

temp_env="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "${temp_env}"' EXIT
awk '!/^TRADING_MODE=/ && !/^RUN_READINESS_CHECK=/' "${ENV_FILE}" > "${temp_env}"
printf 'TRADING_MODE=%s\n' "${MODE}" >> "${temp_env}"
if [[ "${MODE}" == "DRY_RUN" ]]; then
  printf 'RUN_READINESS_CHECK=true\n' >> "${temp_env}"
else
  printf 'RUN_READINESS_CHECK=false\n' >> "${temp_env}"
fi
chown root:root "${temp_env}"
chmod 600 "${temp_env}"
mv -f "${temp_env}" "${ENV_FILE}"
trap - EXIT
