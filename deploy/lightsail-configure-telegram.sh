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

read -r -s -p "Telegram Bot Token (hidden): " telegram_bot_token
echo
if [[ ! "${telegram_bot_token}" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  echo "Invalid Telegram Bot Token format." >&2
  exit 1
fi

cd "${APP_DIR}"
telegram_chat_id="$(MAETAJAK_ENV_FILE="${ENV_FILE}" docker compose -f docker-compose.worker.yml run --rm -T \
  -e TELEGRAM_BOT_TOKEN="${telegram_bot_token}" copy-worker node --input-type=module <<'NODE'
const token = process.env.TELEGRAM_BOT_TOKEN;
const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
if (!response.ok) process.exit(2);
const body = await response.json();
const chats = (body.result || []).flatMap((update) => {
  const message = update.message || update.channel_post || update.edited_message;
  return message?.chat?.id ? [{ id: String(message.chat.id), date: Number(message.date || 0) }] : [];
}).sort((a, b) => b.date - a.date);
if (!chats[0]) process.exit(3);
process.stdout.write(chats[0].id);
NODE
)" || {
  echo "Could not find a Telegram chat. Open the bot, send /start, then run this script again." >&2
  exit 1
}

temp_env="$(mktemp /etc/maetajak/worker.env.telegram.XXXXXX)"
trap 'rm -f "${temp_env:-}"' EXIT
awk '!/^TELEGRAM_BOT_TOKEN=/ && !/^TELEGRAM_CHAT_ID=/' "${ENV_FILE}" > "${temp_env}"
{
  printf 'TELEGRAM_BOT_TOKEN=%s\n' "${telegram_bot_token}"
  printf 'TELEGRAM_CHAT_ID=%s\n' "${telegram_chat_id}"
} >> "${temp_env}"
chown root:root "${temp_env}"
chmod 600 "${temp_env}"
mv -f "${temp_env}" "${ENV_FILE}"
trap - EXIT

export MAETAJAK_ENV_FILE="${ENV_FILE}"
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:preflight
docker compose -f docker-compose.worker.yml run --rm copy-worker npm run worker:alert-test
systemctl restart maetajak-worker.service

echo "Telegram alert configured and test message sent."
