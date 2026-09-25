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
  assert.ok(script.includes('(export[[:space:]]+)?TRADING_MODE='), 'LIVE detection tolerates export/quotes/CRLF');
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
    assert.match(script, /\nacquire_deploy_lock( 0)?\n/, file);
  }
  const deploy = read('deploy/lightsail-deploy-dry-run.sh');
  assert.ok(deploy.indexOf('\nacquire_deploy_lock\n') < deploy.indexOf('trap keep_safe EXIT'),
    'a busy lock must exit before the trap that stops the running worker');
  // Enabling LIVE never waits behind another deploy (it must act on the build the operator checked).
  for (const file of ['deploy/lightsail-enable-live.sh', 'deploy/process-live-promotion-request.sh']) {
    assert.match(read(file), /\nacquire_deploy_lock 0\n/, file);
  }
  const live = read('deploy/lightsail-enable-live.sh');
  assert.ok(live.indexOf('\nacquire_deploy_lock 0\n') < live.indexOf('install -m 600'));
  assert.ok(live.indexOf('release=$(git') < live.indexOf('read -r -p'), 'the commit is shown before the confirmation');
});

test('the deploy lock serializes operators and is inherited only through the real lock descriptor', () => {
  const script = read('deploy/lightsail-deploy-dry-run.sh');
  const start = script.indexOf('acquire_deploy_lock() {');
  const fn = script.slice(start, script.indexOf('\n}\n', start) + 3);
  const dir = mkdtempSync(join(tmpdir(), 'maetajak-lock-'));
  const run = (body, env = {}) => spawnSync('bash', ['-c', `DEPLOY_LOCK_FILE="${join(dir, 'deploy.lock')}"; ${fn}\n${body}`],
    { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  try {
    const lock = join(dir, 'deploy.lock');
    const holder = `(flock 8; sleep 3) 8>"${lock}" & sleep 0.5; `;
    // Another operator holds the lock: wait 1 s, then give up.
    let r = run(`${holder}acquire_deploy_lock 1; echo acquired`);
    assert.equal(r.status, 1); assert.match(r.stderr, /Another maetajak deploy/);
    // A leaked MAETAJAK_DEPLOY_LOCK_HELD without the descriptor is not trusted.
    r = run(`${holder}acquire_deploy_lock 1; echo acquired`, { MAETAJAK_DEPLOY_LOCK_HELD: '1' });
    assert.equal(r.status, 1);
    // A nested script that inherits FD 9 on the held lock proceeds immediately.
    r = run(`exec 9>"${lock}"; flock 9; MAETAJAK_DEPLOY_LOCK_HELD=1 bash -c 'DEPLOY_LOCK_FILE="${lock}"; ${fn.replace(/'/g, `'"'"'`)}
acquire_deploy_lock 1; echo nested-ok'`);
    assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /nested-ok/);
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
