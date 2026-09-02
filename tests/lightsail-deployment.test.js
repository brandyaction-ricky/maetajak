import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const deploymentFiles = [
  'deploy/lightsail-bootstrap.sh',
  'deploy/lightsail-configure.sh',
  'deploy/lightsail-configure-broker.sh',
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

test('automated deployment verifies DRY_RUN and only resumes a previously healthy LIVE system', () => {
  const deploy = readFileSync('deploy/lightsail-deploy-dry-run.sh', 'utf8');
  const verify = readFileSync('deploy/lightsail-verify-deployment.sh', 'utf8');
  const autoDeploy = readFileSync('deploy/lightsail-auto-deploy.sh', 'utf8');
  const timer = readFileSync('deploy/maetajak-auto-deploy.timer', 'utf8');
  const workflow = readFileSync('.github/workflows/deploy-production-worker.yml', 'utf8');

  assert.match(deploy, /systemctl stop maetajak-worker\.service/);
  assert.match(deploy, /worker:halt/);
  assert.match(deploy, /set-worker-mode\.sh" DRY_RUN/);
  assert.match(deploy, /lightsail-verify-deployment\.sh/);
  assert.match(deploy, /worker:can-resume-live/);
  assert.match(deploy, /resume_previous_live/);
  assert.match(deploy, /live_resume=completed/);
  assert.match(deploy, /process-live-promotion-request\.sh/);
  assert.match(verify, /member_sync_failed/);
  assert.match(autoDeploy, /blocked_database_migration/);
  assert.match(autoDeploy, /clear_member_copy_baseline_legs/);
  assert.match(autoDeploy, /get_admin_gate_broker_metrics/);
  assert.match(autoDeploy, /upsert_gate_broker_metrics/);
  assert.match(autoDeploy, /database_migration_already_applied/);
  assert.match(autoDeploy, /git merge-base --is-ancestor/);
  assert.match(autoDeploy, /recover_inactive_worker/);
  assert.match(autoDeploy, /systemctl is-active maetajak-worker\.service/);
  assert.match(timer, /OnUnitActiveSec=3min/);
  assert.match(workflow, /npm test/);
  assert.doesNotMatch(workflow, /LIGHTSAIL_SSH_PRIVATE_KEY/);
});

test('LIVE resume eligibility checks both global execution and worker health', () => {
  const resumeCheck = readFileSync('scripts/check-live-resume.js', 'utf8');
  const migration = readFileSync('supabase/migrations/202609010002_live_resume_safety.sql', 'utf8');
  assert.match(resumeCheck, /get_copy_live_resume_eligibility/);
  assert.match(migration, /SERVICE_ROLE_REQUIRED/);
  assert.match(migration, /c\.execution_enabled/);
  assert.match(migration, /not c\.emergency_halted/);
  assert.match(migration, /r\.mode = 'LIVE'/);
  assert.match(migration, /heartbeat_at > now\(\) - interval '30 seconds'/);
  assert.match(migration, /r\.consecutive_failures = 0/);
  assert.match(migration, /revoke all .* authenticated/);
});

test('LIVE promotion is expiring, single-use, and gated by deployment verification', () => {
  const promotion = readFileSync('deploy/process-live-promotion-request.sh', 'utf8');
  const request = readFileSync('deploy/live-promotion.request', 'utf8');

  assert.match(promotion, /STATE_DIR="\/var\/lib\/maetajak\/live-promotions"/);
  assert.match(promotion, /live_promotion=already_completed/);
  assert.match(promotion, /live_promotion=expired/);
  assert.match(promotion, /lightsail-verify-deployment\.sh/);
  assert.match(promotion, /live_promotion=deployment_cycle_verified/);
  assert.doesNotMatch(promotion, /blocked_no_member_plan/);
  assert.match(promotion, /lightsail-enable-live\.sh/);
  assert.match(promotion, /EXPECTED_MODE=LIVE/);
  const enableLive = readFileSync('deploy/lightsail-enable-live.sh', 'utf8');
  assert.match(enableLive, /alert_test=delivery_warning/);
  assert.match(enableLive, /worker:preflight/);
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

test('Broker credential configuration is hidden, atomic, and verifies a real sync', () => {
  const configure = readFileSync('deploy/lightsail-configure-broker.sh', 'utf8');
  assert.match(configure, /read -r -s -p "Gate Broker read-only API key/);
  assert.match(configure, /read -r -s -p "Gate Broker secret key/);
  assert.match(configure, /mktemp \/etc\/maetajak\/worker\.env\.broker/);
  assert.match(configure, /chmod 600/);
  assert.match(configure, /gate_broker_metrics_synced/);
  assert.doesNotMatch(configure, /echo .*gate_broker_(api|secret)_key/i);
});

test('systemd refuses to start a worker that fails preflight', () => {
  const service = readFileSync('deploy/maetajak-worker.service', 'utf8');
  const mode = readFileSync('deploy/set-worker-mode.sh', 'utf8');
  assert.match(service, /ExecStartPre=.*worker:preflight/);
  assert.match(service, /Environment=MAETAJAK_ENV_FILE=\/etc\/maetajak\/worker\.env/);
  assert.match(service, /up -d --no-build/);
  assert.match(mode, /install -m 644 .*maetajak-worker\.service/s);
  assert.match(mode, /systemctl daemon-reload/);
});
