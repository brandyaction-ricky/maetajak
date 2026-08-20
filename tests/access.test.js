import test from 'node:test';
import assert from 'node:assert/strict';
import { getAccessDecision } from '../src/access.js';

test('only approved profiles can enter', () => {
  for (const approval_status of ['PENDING', 'REJECTED', 'SUSPENDED', undefined]) {
    assert.equal(getAccessDecision({ approval_status, role: 'MEMBER' }).allowed, false);
  }
  assert.equal(getAccessDecision({ approval_status: 'APPROVED', role: 'MEMBER' }).allowed, true);
});

test('admin navigation requires an approved ADMIN profile', () => {
  assert.deepEqual(getAccessDecision({ approval_status: 'APPROVED', role: 'ADMIN' }), { allowed: true, role: 'admin' });
  assert.equal(getAccessDecision({ approval_status: 'PENDING', role: 'ADMIN' }).allowed, false);
  assert.equal(getAccessDecision({ approval_status: 'APPROVED', role: 'MEMBER' }).role, 'member');
});
