import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const deploymentFiles = [
  'deploy/lightsail-bootstrap.sh',
  'deploy/lightsail-configure.sh',
  'deploy/lightsail-status.sh',
  'deploy/lightsail-update.sh',
];

test('Lightsail shell scripts have valid Bash syntax', () => {
  for (const file of deploymentFiles) {
    execFileSync('bash', ['-n', file], { stdio: 'pipe' });
  }
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
