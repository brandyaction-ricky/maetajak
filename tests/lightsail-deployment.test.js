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
  'deploy/process-live-promotion-request.sh',
  'deploy/lightsail-auto-deploy.sh',
  'deploy/install-auto-deploy.sh',
];

test('Lightsail shell scripts have valid Bash syntax', () => {
  for (const file of deploymentFiles) {
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  }
});

test('automated deployment fails closed in DRY_RUN and blocks database changes', () => {
  const deploy = readFileSync('deploy/lightsail-deploy-dry-run.sh', 'utf8');
  const verify = readFileSync('deploy/lightsail-verify-deployment.sh', 'utf8');
  const autoDeploy = readFileSync('deploy/lightsail-auto-deploy.sh', 'utf8');
  const timer = readFileSync('deploy/maetajak-auto-deploy.timer', 'utf8');
  const workflow = readFileSync('.github/workflows/deploy-production-worker.yml', 'utf8');

  assert.match(deploy, /systemctl stop maetajak-worker\.service/);
  assert.match(deploy, /worker:halt/);
  assert.match(deploy, /set-worker-mode\.sh" DRY_RUN/);
  assert.match(deploy, /lightsail-verify-deployment\.sh/);
  assert.match(deploy, /process-live-promotion-request\.sh/);
  assert.match(verify, /member_sync_failed/);
  assert.match(autoDeploy, /blocked_database_migration/);
  assert.match(autoDeploy, /git merge-base --is-ancestor/);
  assert.match(timer, /OnUnitActiveSec=3min/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /LIGHTSAIL_SSH_PRIVATE_KEY/);
});

test('LIVE promotion is expiring, single-use, and gated by healthy member planning', () => {
  const promotion = readFileSync('deploy/process-live-promotion-request.sh', 'utf8');
  const request = readFileSync('deploy/live-promotion.request', 'utf8');

  assert.match(promotion, /STATE_DIR="\/var\/lib\/maetajak\/live-promotions"/);
  assert.match(promotion, /live_promotion=already_completed/);
  assert.match(promotion, /live_promotion=expired/);
  assert.match(promotion, /cycle_complete/);
  assert.match(promotion, /dry_run_plan/);
  assert.match(promotion, /lightsail-enable-live\.sh/);
  assert.match(promotion, /EXPECTED_MODE=LIVE/);
  assert.match(request, /^token=[a-zA-Z0-9_-]{16,80}$/m);
  assert.match(request, /^expires_at=\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/m);
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
