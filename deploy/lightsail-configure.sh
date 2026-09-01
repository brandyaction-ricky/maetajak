#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly CONFIG_DIR="/etc/maetajak"
readonly ENV_FILE="${CONFIG_DIR}/worker.env"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this configuration script as root." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "Run lightsail-bootstrap.sh first." >&2
  exit 1
fi

read -r -p "Production Supabase URL: " supabase_url
read -r -s -p "Supabase service-role key (hidden): " service_role_key
echo
read -r -s -p "Alert webhook URL (hidden, required before LIVE): " alert_webhook_url
echo
read -r -s -p "Alert webhook bearer token (hidden, optional): " alert_webhook_bearer
echo
read -r -p "Gate Broker commission UID [49084031]: " gate_broker_uid
gate_broker_uid="${gate_broker_uid:-49084031}"
read -r -s -p "Gate Broker read API key (hidden, optional when Master UID matches): " gate_broker_api_key
echo
read -r -s -p "Gate Broker secret key (hidden, optional when Master UID matches): " gate_broker_secret_key
echo

if [[ ! "${supabase_url}" =~ ^https://[A-Za-z0-9-]+\.supabase\.co/?$ ]]; then
  echo "Invalid production Supabase URL." >&2
  exit 1
fi
if [[ -z "${service_role_key}" ]]; then
  echo "The Supabase service-role key is required." >&2
  exit 1
fi

worker_public_ip="$(curl --fail --silent --show-error --max-time 10 https://checkip.amazonaws.com | tr -d '[:space:]')"
if [[ ! "${worker_public_ip}" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
  echo "Could not determine the server public IPv4." >&2
  exit 1
fi

install -d -m 700 -o root -g root "${CONFIG_DIR}"
umask 077
temp_env="$(mktemp "${CONFIG_DIR}/worker.env.XXXXXX")"
trap 'rm -f "${temp_env:-}"' EXIT
{
  printf 'SUPABASE_URL=%s\n' "${supabase_url%/}"
  printf 'SUPABASE_SERVICE_ROLE_KEY=%s\n' "${service_role_key}"
  printf 'GATE_API_BASE_URL=https://api.gateio.ws\n'
  printf 'GATE_CHANNEL_ID=maetajak\n'
  printf 'GATE_BROKER_UID=%s\n' "${gate_broker_uid}"
  printf 'GATE_BROKER_API_KEY=%s\n' "${gate_broker_api_key}"
  printf 'GATE_BROKER_SECRET_KEY=%s\n' "${gate_broker_secret_key}"
  printf 'BROKER_SYNC_INTERVAL_MS=3600000\n'
  printf 'WORKER_ID=maetajak-lightsail-seoul-01\n'
  printf 'WORKER_VERSION=0.3.0\n'
  printf 'WORKER_PUBLIC_IP=%s\n' "${worker_public_ip}"
  printf 'TRADING_MODE=OBSERVE\n'
  printf 'RUN_READINESS_CHECK=false\n'
  printf 'POLL_INTERVAL_MS=5000\n'
  printf 'SYNC_INTERVAL_MS=5000\n'
  printf 'ALERT_WEBHOOK_URL=%s\n' "${alert_webhook_url}"
  printf 'ALERT_WEBHOOK_BEARER=%s\n' "${alert_webhook_bearer}"
  printf 'TELEGRAM_BOT_TOKEN=\n'
  printf 'TELEGRAM_CHAT_ID=\n'
} > "${temp_env}"
chown root:root "${temp_env}"
chmod 600 "${temp_env}"
mv -f "${temp_env}" "${ENV_FILE}"
trap - EXIT

cd "${APP_DIR}"
export MAETAJAK_ENV_FILE="${ENV_FILE}"
docker compose -f docker-compose.worker.yml build --pull copy-worker
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
systemctl restart maetajak-worker.service

echo "Worker started in OBSERVE mode with public IPv4 ${worker_public_ip}."
echo "Register this exact IPv4 on every Gate.io Master/member API whitelist."
echo "Check status with: sudo ${APP_DIR}/deploy/lightsail-status.sh"
