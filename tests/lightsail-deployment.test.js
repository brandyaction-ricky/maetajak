import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const deploymentFiles = [
  'deploy/lightsail-bootstrap.sh',
  'deploy/lightsail-configure.sh',
  'deploy/lightsail-status.sh',
  'deploy/lightsail-update.sh',
  'deploy/set-worker-mode.sh',
  'deploy/lightsail-verify-deployment.sh',
  'deploy/lightsail-deploy-dry-run.sh',
  'deploy/github-deploy-command.sh',
  'deploy/install-github-deploy-key.sh',
];

test('Lightsail shell scripts have valid Bash syntax', () => {
  for (const file of deploymentFiles) {
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  }
});

test('automated deployment fails closed in DRY_RUN and restricts SSH commands', () => {
  const deploy = readFileSync('deploy/lightsail-deploy-dry-run.sh', 'utf8');
  const verify = readFileSync('deploy/lightsail-verify-deployment.sh', 'utf8');
  const forcedCommand = readFileSync('deploy/github-deploy-command.sh', 'utf8');
  const workflow = readFileSync('.github/workflows/deploy-production-worker.yml', 'utf8');
  const promote = readFileSync('.github/workflows/promote-production-live.yml', 'utf8');

  assert.match(deploy, /systemctl stop maetajak-worker\.service/);
  assert.match(deploy, /worker:halt/);
  assert.match(deploy, /set-worker-mode\.sh" DRY_RUN/);
  assert.match(deploy, /lightsail-verify-deployment\.sh/);
  assert.match(verify, /member_sync_failed/);
  assert.match(forcedCommand, /SSH_ORIGINAL_COMMAND/);
  assert.match(forcedCommand, /Unsupported deployment command/);
  assert.doesNotMatch(forcedCommand, /eval/);
  assert.match(workflow, /supabase db push --db-url .* --dry-run/);
  assert.match(workflow, /environment: production-dry-run/);
  assert.match(promote, /environment: production-live/);
  assert.match(promote, /ENABLE_LIVE_COPY_TRADING/);
});

test('Lightsail configuration keeps server secrets outside the Git checkout', () => {
  const configure = readFileSync('deploy/lightsail-configure.sh', 'utf8');
  const compose = readFileSync('docker-compose.worker.yml', 'utf8');
  assert.match(configure, /CONFIG_DIR="\/etc\/maetajak"/);
  assert.match(configure, /ENV_FILE="\$\{CONFIG_DIR\}\/worker\.env"/);
  assert.match(configure, /chmod 600/);
  assert.match(configure, /TRADING_MODE=OBSERVE/);
  assert.match(compose, /MAETAJAK_ENV_FILE:-\.env\.worker/);
  assert.doesNotMatch(configure, /echo .*service_role_key/i);
});

test('systemd refuses to start a worker that fails preflight', () => {
  const service = readFileSync('deploy/maetajak-worker.service', 'utf8');
  assert.match(service, /ExecStartPre=.*worker:preflight/);
  assert.match(service, /Environment=MAETAJAK_ENV_FILE=\/etc\/maetajak\/worker\.env/);
});
