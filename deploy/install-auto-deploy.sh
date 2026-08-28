#!/usr/bin/env bash
set -Eeuo pipefail

readonly APP_DIR="/opt/maetajak"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi

install -m 644 "${APP_DIR}/deploy/maetajak-auto-deploy.service" /etc/systemd/system/maetajak-auto-deploy.service
install -m 644 "${APP_DIR}/deploy/maetajak-auto-deploy.timer" /etc/systemd/system/maetajak-auto-deploy.timer
systemctl daemon-reload
systemctl enable --now maetajak-auto-deploy.timer
systemctl start maetajak-auto-deploy.service
systemctl status maetajak-auto-deploy.timer --no-pager
