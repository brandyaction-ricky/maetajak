#!/usr/bin/env bash
# Sourced by the deploy scripts (2026-11-03 Q4). WORKER_VERSION identifies the deployed build in
# copy_worker_runtime.worker_version: "<package.json version>+<git short SHA>" of the checkout being deployed,
# e.g. "0.6.0+1a2b3c4d5e6f". Without git (or outside a checkout) the suffix is "+nogit". At most 80 characters
# (the DB keeps left(p_worker_version, 80)); private.copy_worker_version_supported() decides which builds may order.

# maetajak_worker_version APP_DIR -> prints the version string; fails when package.json has no x.y.z version.
maetajak_worker_version() {
  local app_dir="${1:?app dir}" version sha
  version="$(sed -n 's/^  "version": "\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)",*$/\1/p' "${app_dir}/package.json" 2>/dev/null | head -n 1)"
  if [[ ! "${version}" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "Cannot read the worker version from ${app_dir}/package.json." >&2
    return 1
  fi
  sha="$(git -C "${app_dir}" rev-parse --short=12 HEAD 2>/dev/null || true)"
  [[ "${sha}" =~ ^[0-9a-f]{7,40}$ ]] || sha="nogit"
  printf '%s+%s\n' "${version}" "${sha}" | cut -c1-80
}

# maetajak_write_worker_version ENV_FILE APP_DIR -> replaces WORKER_VERSION in the env file atomically (root 600).
maetajak_write_worker_version() {
  local env_file="${1:?env file}" app_dir="${2:?app dir}" worker_version temp_file
  worker_version="$(maetajak_worker_version "${app_dir}")" || return 1
  temp_file="$(mktemp "${env_file}.XXXXXX")"
  if ! { awk '!/^WORKER_VERSION=/' "${env_file}" && printf 'WORKER_VERSION=%s\n' "${worker_version}"; } > "${temp_file}"; then
    rm -f "${temp_file}"
    return 1
  fi
  chown root:root "${temp_file}" 2>/dev/null || true
  chmod 600 "${temp_file}"
  mv -f "${temp_file}" "${env_file}"
  echo "worker_version=${worker_version}"
}
