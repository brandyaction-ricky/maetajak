#!/usr/bin/env bash
set -Eeuo pipefail

# This is intended for an SSH authorized_keys forced command. The deploy key
# cannot obtain an interactive shell or execute arbitrary input.
case "${SSH_ORIGINAL_COMMAND:-}" in
  deploy-dry-run)
    exec sudo /opt/maetajak/deploy/lightsail-deploy-dry-run.sh
    ;;
  verify-dry-run)
    exec sudo env EXPECTED_MODE=DRY_RUN /opt/maetajak/deploy/lightsail-verify-deployment.sh
    ;;
  promote-live)
    exec bash -c "printf '%s\\n' ENABLE_LIVE_COPY_TRADING | sudo /opt/maetajak/deploy/lightsail-enable-live.sh"
    ;;
  status)
    exec sudo /opt/maetajak/deploy/lightsail-status.sh
    ;;
  *)
    echo "Unsupported deployment command." >&2
    exit 64
    ;;
esac
