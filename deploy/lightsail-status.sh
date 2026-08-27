#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this status script as root." >&2
  exit 1
fi

configured_ip="$(sed -n 's/^WORKER_PUBLIC_IP=//p' "${ENV_FILE}" | head -n 1)"
outbound_ip="$(curl --fail --silent --show-error --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"

echo "service=$(systemctl is-active maetajak-worker.service || true)"
echo "configured_ip=${configured_ip:-missing}"
echo "outbound_ip=${outbound_ip:-unknown}"
if [[ -n "${configured_ip}" && "${configured_ip}" != "${outbound_ip}" ]]; then
  echo "ip_match=false"
  exit 1
fi
echo "ip_match=true"

if grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' "${ENV_FILE}" && grep -Eq '^TELEGRAM_CHAT_ID=.+$' "${ENV_FILE}"; then
  echo "alerts_configured=true"
  echo "alert_provider=telegram"
elif grep -Eq '^ALERT_WEBHOOK_URL=https://.+$' "${ENV_FILE}"; then
  echo "alerts_configured=true"
  echo "alert_provider=webhook"
else
  echo "alerts_configured=false"
  echo "alert_provider=missing"
fi

cd "${APP_DIR}"
MAETAJAK_ENV_FILE="${ENV_FILE}" docker compose -f docker-compose.worker.yml ps
MAETAJAK_ENV_FILE="${ENV_FILE}" docker compose -f docker-compose.worker.yml logs --tail=50 copy-worker
