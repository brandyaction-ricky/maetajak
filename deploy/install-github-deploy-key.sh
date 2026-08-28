#!/usr/bin/env bash
set -Eeuo pipefail

readonly DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
readonly PUBLIC_KEY="${1:-}"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this installer as root." >&2
  exit 1
fi
if [[ ! "${PUBLIC_KEY}" =~ ^ssh-ed25519[[:space:]][A-Za-z0-9+/=]+([[:space:]].*)?$ ]]; then
  echo "Pass one valid ssh-ed25519 public key as the first argument." >&2
  exit 1
fi

deploy_home="$(getent passwd "${DEPLOY_USER}" | cut -d: -f6)"
if [[ -z "${deploy_home}" ]]; then
  echo "Deployment user does not exist." >&2
  exit 1
fi

ssh_dir="${deploy_home}/.ssh"
authorized_keys="${ssh_dir}/authorized_keys"
install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${ssh_dir}"
touch "${authorized_keys}"
chown "${DEPLOY_USER}:${DEPLOY_USER}" "${authorized_keys}"
chmod 600 "${authorized_keys}"

key_material="${PUBLIC_KEY#ssh-ed25519 }"
key_material="${key_material%% *}"
if ! grep -Fq "${key_material}" "${authorized_keys}"; then
  printf '%s\n' "command=\"/opt/maetajak/deploy/github-deploy-command.sh\",restrict ${PUBLIC_KEY}" >> "${authorized_keys}"
fi

echo "github_deploy_key_installed=true"
echo "deploy_user=${DEPLOY_USER}"
