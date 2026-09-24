import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// P1-2 / P1-3 (QA 2026-09-24): restarts and the auto-deploy timer must not switch LIVE off.
const read = (file) => readFileSync(file, 'utf8');

test('auto-deploy never redeploys the worker (DRY_RUN) while LIVE and honours maintenance + the deploy lock', () => {
  const script = read('deploy/lightsail-auto-deploy.sh');
  execFileSync('bash', ['-n', 'deploy/lightsail-auto-deploy.sh']);
  assert.match(script, /MAINTENANCE_FILE="\/etc\/maetajak\/maintenance"/);
  assert.match(script, /auto_deploy=maintenance/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /auto_deploy=busy/);
  assert.match(script, /\^TRADING_MODE=LIVE\$/);
  const pending = script.indexOf('auto_deploy=pending_live_worker_update');
  assert.ok(pending > 0);
  assert.ok(pending < script.indexOf('database_changes=false'), 'LIVE check runs before the DB readiness container');
  assert.ok(pending < script.lastIndexOf('exec "${APP_DIR}/deploy/lightsail-deploy-dry-run.sh"'));
  assert.match(script, /worker_changes}" == "true" && "\$\{live_mode}" == "true"/);
  assert.match(script, /scripts\/deploy-notice\.js/);
  assert.match(script, /reliability_patch/);
});

test('manual deploy, update, promotion and LIVE activation share one lock; the dry-run lock precedes its safety trap', () => {
  for (const file of ['deploy/lightsail-deploy-dry-run.sh', 'deploy/lightsail-enable-live.sh', 'deploy/lightsail-update.sh',
    'deploy/process-live-promotion-request.sh']) {
    execFileSync('bash', ['-n', file]);
    const script = read(file);
    assert.match(script, /acquire_deploy_lock\(\) \{/, file);
    assert.match(script, /\nacquire_deploy_lock\n/, file);
  }
  const deploy = read('deploy/lightsail-deploy-dry-run.sh');
  assert.ok(deploy.indexOf('\nacquire_deploy_lock\n') < deploy.indexOf('trap keep_safe EXIT'),
    'a busy lock must exit before the trap that stops the running worker');
  const live = read('deploy/lightsail-enable-live.sh');
  assert.ok(live.indexOf('\nacquire_deploy_lock\n') < live.indexOf('install -m 600'));
});

test('the deploy lock serializes operators and is inherited by nested scripts', () => {
  const script = read('deploy/lightsail-deploy-dry-run.sh');
  const start = script.indexOf('acquire_deploy_lock() {');
  const fn = script.slice(start, script.indexOf('\n}\n', start) + 3);
  const dir = mkdtempSync(join(tmpdir(), 'maetajak-lock-'));
  try {
    const lock = join(dir, 'deploy.lock');
    const holder = `(flock 8; sleep 3) 8>"${lock}" & sleep 0.5; `;
    const busy = spawnSync('bash', ['-c', `DEPLOY_LOCK_FILE="${lock}"; DEPLOY_LOCK_WAIT_SECONDS=1; ${fn}\n${holder}acquire_deploy_lock; echo acquired`],
      { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(busy.status, 1);
    assert.match(busy.stderr, /Another maetajak deploy/);
    const nested = spawnSync('bash', ['-c', `DEPLOY_LOCK_FILE="${lock}"; DEPLOY_LOCK_WAIT_SECONDS=1; ${fn}\n${holder}acquire_deploy_lock; echo acquired`],
      { encoding: 'utf8', env: { PATH: process.env.PATH, MAETAJAK_DEPLOY_LOCK_HELD: '1' } });
    assert.equal(nested.status, 0);
    assert.match(nested.stdout, /acquired/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a lease held by the previous worker process is waited out, not counted as a failed LIVE cycle', () => {
  const worker = read('worker/index.js');
  const lease = worker.indexOf("includes('WORKER_LEASE_HELD')");
  assert.ok(lease > 0);
  const handler = worker.slice(lease, worker.indexOf('state.leaseWaitSince = 0;', lease));
  assert.match(handler, /return;/);
  assert.doesNotMatch(handler, /reportCycle/);
  assert.match(worker, /WORKER_LEASE_CONFLICT/);
  // Accounting sync runs on its own timer, outside the order loop.
  assert.match(worker, /setInterval\(runPerformanceSync, performanceIntervalMs\)/);
  assert.doesNotMatch(worker.slice(worker.indexOf('export async function runTradingCycle'), worker.indexOf('export async function runPerformanceSync')),
    /syncMemberPerformance/);
});
