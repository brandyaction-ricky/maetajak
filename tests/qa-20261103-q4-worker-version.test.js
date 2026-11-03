import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 2026-11-03 pre-go-live QA Q4: the deploy writes WORKER_VERSION=<package.json version>+<git short SHA>.
const read = (path) => readFileSync(path, 'utf8');
const helper = (fn, ...args) => spawnSync('bash', ['-c', `source deploy/worker-version.sh && ${fn} "$@"`, 'q4', ...args], { encoding: 'utf8' });
// Mirror of private.copy_worker_version_supported() (20261103020000): the DB must accept what the deploy writes.
const dbAccepts = (v) => v === '0.5.0' || /^0\.6\.0(\+[0-9A-Za-z][0-9A-Za-z.-]{0,59})?$/.test(v);

test('Q4: package.json and package-lock.json are 0.6.0', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.version, '0.6.0');
  assert.equal(lock.version, '0.6.0');
  assert.equal(lock.packages[''].version, '0.6.0');
});

test('Q4: the version is <package version>+<12-char git SHA> of the checkout, accepted by the DB gate', () => {
  const result = helper('maetajak_worker_version', '.');
  assert.equal(result.status, 0, result.stderr);
  const sha = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(result.stdout.trim(), `0.6.0+${sha}`);
  assert.ok(result.stdout.trim().length <= 80);
  assert.ok(dbAccepts(result.stdout.trim()));
});

test('Q4: without git the suffix is +nogit; an unreadable package version fails the deploy', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q4-nogit-'));
  copyFileSync('package.json', join(dir, 'package.json'));
  const noGit = helper('maetajak_worker_version', dir);
  assert.equal(noGit.status, 0, noGit.stderr);
  assert.equal(noGit.stdout.trim(), '0.6.0+nogit');
  assert.ok(dbAccepts(noGit.stdout.trim()));
  // git missing from PATH entirely behaves the same (only sed/head/cut available), even inside the repository.
  const bin = mkdtempSync(join(tmpdir(), 'q4-bin-'));
  for (const tool of ['sed', 'head', 'cut']) symlinkSync(execFileSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(), join(bin, tool));
  const noGitBinary = spawnSync('bash', ['-c', `source deploy/worker-version.sh && PATH="$2" maetajak_worker_version "$1"`, 'q4', '.', bin],
    { encoding: 'utf8' });
  assert.equal(noGitBinary.stdout.trim(), '0.6.0+nogit', noGitBinary.stderr);
  const bad = mkdtempSync(join(tmpdir(), 'q4-bad-'));
  writeFileSync(join(bad, 'package.json'), '{ "name": "maetajak" }\n');
  const failed = helper('maetajak_worker_version', bad);
  assert.notEqual(failed.status, 0);
  assert.equal(failed.stdout, '');
});

test('Q4: writing the version replaces only WORKER_VERSION, keeps the rest and the 600 mode', () => {
  const dir = mkdtempSync(join(tmpdir(), 'q4-env-'));
  const env = join(dir, 'worker.env');
  writeFileSync(env, 'SUPABASE_URL=https://x.supabase.co\nWORKER_VERSION=0.5.0\nTRADING_MODE=DRY_RUN\n', { mode: 0o600 });
  const result = helper('maetajak_write_worker_version', env, '.');
  assert.equal(result.status, 0, result.stderr);
  const lines = read(env).trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['SUPABASE_URL=https://x.supabase.co', 'TRADING_MODE=DRY_RUN']);
  assert.match(lines[2], /^WORKER_VERSION=0\.6\.0\+[0-9a-f]{12}$/);
  assert.equal(lines.filter((l) => l.startsWith('WORKER_VERSION=')).length, 1);
  assert.equal(statSync(env).mode & 0o777, 0o600);
});

test('Q4: every deploy path computes the version; nothing pins 0.5.0; the worker falls back to package.json', () => {
  for (const file of ['deploy/set-worker-mode.sh', 'deploy/lightsail-configure.sh', 'deploy/lightsail-update.sh']) {
    const script = read(file);
    assert.match(script, /source "\$\{APP_DIR\}\/deploy\/worker-version\.sh"/, file);
    assert.doesNotMatch(script, /WORKER_VERSION=0\.5\.0/, file);
    execFileSync('bash', ['-n', file]);
  }
  execFileSync('bash', ['-n', 'deploy/worker-version.sh']);
  assert.match(read('deploy/set-worker-mode.sh'), /printf 'WORKER_VERSION=%s\\n' "\$\{worker_version\}"/);
  // set-worker-mode runs after the deploy's `git merge --ff-only`, so the SHA is the deployed commit.
  const deploy = read('deploy/lightsail-deploy-dry-run.sh');
  assert.ok(deploy.indexOf('git merge --ff-only origin/main') < deploy.indexOf('set-worker-mode.sh" DRY_RUN'));
  assert.ok(deploy.indexOf('set-worker-mode.sh" DRY_RUN') < deploy.indexOf('docker compose -f docker-compose.worker.yml build'));
  assert.match(read('deploy/lightsail-auto-deploy.sh'), /Number\(version\.worker_build_version_gate\) >= 1/);
  assert.match(read('.env.worker.example'), /^WORKER_VERSION=$/m);
  const index = read('worker/index.js');
  assert.match(index, /process\.env\.WORKER_VERSION \|\| process\.env\.npm_package_version \|\| packageVersion\(\) \|\| 'dev'\)\.slice\(0, 80\)/);
  assert.doesNotMatch(read('docker-compose.worker.yml'), /WORKER_VERSION/);
  assert.doesNotMatch(read('Dockerfile.worker'), /WORKER_VERSION/);
});

test('Q4 review F4: every start path runs the preflight, after WORKER_VERSION is written; docs require the migrations first', () => {
  for (const [file, versionStep] of [['deploy/lightsail-deploy-dry-run.sh', 'set-worker-mode.sh" DRY_RUN'],
    ['deploy/lightsail-update.sh', 'maetajak_write_worker_version'], ['deploy/lightsail-enable-live.sh', null]]) {
    const script = read(file);
    const preflight = script.indexOf('npm run worker:preflight');
    assert.ok(preflight > 0, file);
    if (versionStep) assert.ok(script.indexOf(versionStep) < preflight, `${file}: version written before preflight`);
    // The main start (enable-live also starts the restored DRY_RUN worker inside its failure trap, earlier in the file).
    const starts = [...script.matchAll(/^systemctl (re)?start maetajak-worker\.service$/gm)].map((m) => m.index);
    assert.ok(starts.length && preflight < starts.at(-1), `${file}: preflight before start`);
  }
  assert.match(read('deploy/maetajak-worker.service'), /ExecStartPre=.*worker:preflight/);
  const doc = read('docs/WORKER_DEPLOYMENT.md');
  assert.match(doc, /\*\*`main`에 병합하기 전에\*\* 운영 DB에 `20261103010000_disable_email_auto_approve\.sql`, `20261103020000_worker_build_version_gate\.sql`, `20261103030000_master_last_legs_and_requeue\.sql`/);
});
