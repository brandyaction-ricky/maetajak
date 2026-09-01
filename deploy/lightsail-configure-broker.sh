#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly ENV_FILE="/etc/maetajak/worker.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this configuration script as root." >&2
  exit 1
fi
if [[ ! -f "${ENV_FILE}" ]]; then
  echo "Worker environment file is missing." >&2
  exit 1
fi

read -r -p "Gate Broker commission UID [49084031]: " gate_broker_uid
gate_broker_uid="${gate_broker_uid:-49084031}"
read -r -s -p "Gate Broker read-only API key (hidden): " gate_broker_api_key
echo
read -r -s -p "Gate Broker secret key (hidden): " gate_broker_secret_key
echo

if [[ ! "${gate_broker_uid}" =~ ^[0-9]+$ ]]; then
  echo "Invalid Gate Broker UID." >&2
  exit 1
fi
if [[ ! "${gate_broker_api_key}" =~ ^[A-Za-z0-9_-]{16,}$ ]]; then
  echo "Invalid Gate Broker API key format." >&2
  exit 1
fi
if [[ ! "${gate_broker_secret_key}" =~ ^[A-Za-z0-9_-]{32,}$ ]]; then
  echo "Invalid Gate Broker secret key format." >&2
  exit 1
fi

umask 077
temp_env="$(mktemp /etc/maetajak/worker.env.broker.XXXXXX)"
trap 'rm -f "${temp_env:-}"' EXIT
awk '!/^GATE_BROKER_UID=/ && !/^GATE_BROKER_API_KEY=/ && !/^GATE_BROKER_SECRET_KEY=/' "${ENV_FILE}" > "${temp_env}"
{
  printf 'GATE_BROKER_UID=%s\n' "${gate_broker_uid}"
  printf 'GATE_BROKER_API_KEY=%s\n' "${gate_broker_api_key}"
  printf 'GATE_BROKER_SECRET_KEY=%s\n' "${gate_broker_secret_key}"
} >> "${temp_env}"
chown root:root "${temp_env}"
chmod 600 "${temp_env}"
mv -f "${temp_env}" "${ENV_FILE}"
trap - EXIT

cd "${APP_DIR}"
export MAETAJAK_ENV_FILE="${ENV_FILE}"
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
systemctl restart maetajak-worker.service

for _ in {1..20}; do
  if journalctl -u maetajak-worker.service --since "30 seconds ago" --no-pager \
    | grep -q 'gate_broker_metrics_synced'; then
    echo "Gate Broker metrics sync completed successfully."
    exit 0
  fi
  if journalctl -u maetajak-worker.service --since "30 seconds ago" --no-pager \
    | grep -q 'gate_broker_metrics_error'; then
    echo "Gate Broker metrics sync failed. Check the API key permission and IP whitelist." >&2
    journalctl -u maetajak-worker.service --since "30 seconds ago" --no-pager \
      | grep 'gate_broker_metrics_error' | tail -n 1 >&2
    exit 1
  fi
  sleep 1
done

echo "Worker restarted, but Broker sync did not finish within 20 seconds." >&2
exit 1
