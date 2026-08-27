#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"
readonly CONFIG_DIR="/etc/maetajak"
readonly ENV_FILE="${CONFIG_DIR}/worker.env"
readonly REPOSITORY="https://github.com/brandyaction-ricky/maetajak.git"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this bootstrap script as root." >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates \
  curl \
  docker-compose-v2 \
  docker.io \
  git \
  jq \
  unattended-upgrades

systemctl enable --now docker
dpkg-reconfigure -f noninteractive unattended-upgrades

if [[ -e "${APP_DIR}" && ! -d "${APP_DIR}/.git" ]]; then
  echo "${APP_DIR} exists but is not the maetajak Git repository." >&2
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  git clone --depth 1 --branch main "${REPOSITORY}" "${APP_DIR}"
else
  git -C "${APP_DIR}" fetch --depth 1 origin main
  git -C "${APP_DIR}" merge --ff-only origin/main
fi

install -d -m 700 -o root -g root "${CONFIG_DIR}"
if [[ ! -f "${ENV_FILE}" ]]; then
  install -m 600 -o root -g root "${APP_DIR}/.env.worker.example" "${ENV_FILE}"
fi

install -m 644 -o root -g root \
  "${APP_DIR}/deploy/maetajak-worker.service" \
  /etc/systemd/system/maetajak-worker.service
systemctl daemon-reload
systemctl enable maetajak-worker.service

echo "Bootstrap complete. The worker is installed but intentionally not started."
echo "Next: run sudo ${APP_DIR}/deploy/lightsail-configure.sh"
