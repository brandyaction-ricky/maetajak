import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { newOperationConfirmationName, newOperationNameMatches, newOperationError } from '../src/new-operation.js';

// 2026-11-03 pre-go-live QA Q3 (admin "새 운용 시작" = CURRENT_MASTER, buys the Master's whole portfolio) and
// P2-5 (member start/resume confirmation and the start-time FUTURE_ONLY wording).
const main = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8');
const newOperation = readFileSync(new URL('../src/new-operation.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/prototype-theme.css', import.meta.url), 'utf8');

test('Q3: the confirmation name is the member name (trimmed); the typed name must match exactly', () => {
  const preview = { member_name: ' 홍길동 ', member_email: 'a@example.invalid' };
  assert.equal(newOperationConfirmationName(preview), '홍길동');
  assert.equal(newOperationNameMatches('홍길동', preview), true);
  assert.equal(newOperationNameMatches('  홍길동 ', preview), true);
  for (const typed of ['', null, undefined, '홍길', '홍길동동', 'a@example.invalid']) assert.equal(newOperationNameMatches(typed, preview), false, String(typed));
  // No name on file: the account identifier shown in the panel is what is typed.
  assert.equal(newOperationConfirmationName({ member_name: '', member_gate_uid: '12345678' }), newOperationConfirmationName({ member_gate_uid: '12345678' }));
  assert.notEqual(newOperationConfirmationName({ member_gate_uid: '12345678' }), '');
  assert.match(newOperationError('NAME_CONFIRMATION_MISMATCH'), /회원 이름이 일치하지 않습니다/);
});

test('Q3: the panel is styled as danger, requires the typed name before calling the RPC, and keeps the RPC call unchanged', () => {
  assert.match(newOperation, /<h4>새 운용 시작 \(마스터 현재 포지션 전부 매수\)<\/h4>/);
  assert.match(newOperation, /class="new-operation-form new-operation-danger"/);
  assert.match(newOperation, /<input name="confirm_name" type="text" autocomplete="off" required>/);
  assert.match(newOperation, /<button type="submit" class="btn red"[^>]*>마스터 현재 포지션 전부 매수로 새 운용 시작<\/button>/);
  const submit = newOperation.slice(newOperation.indexOf("root.addEventListener('submit'"));
  assert.ok(submit.indexOf('newOperationNameMatches(form.elements.confirm_name?.value, preview)') > 0);
  assert.ok(submit.indexOf('newOperationNameMatches(') < submit.indexOf("rpc('start_member_new_operation'"), 'name checked before the RPC');
  assert.match(submit, /rpc\('start_member_new_operation', \{ p_user_id: requestedUser,\s*p_request_id: requestId, p_expected_equity: preview\.equity,\s*p_expected_observed_at: preview\.observed_at, p_expected_fingerprint: preview\.fingerprint,\s*p_confirmation: `NEW_OPERATION:\$\{preview\.member_email\}`, p_reason: reason \}\)/);
  assert.match(css, /\.member-detail-summary \.member-danger-zone \{[^}]*border: 1px solid rgba\(255, 95, 109/);
  // The button stays covered by the modal's busy lock.
  assert.match(main, /#memberDetailModal \[data-new-operation-open\]/);
});

test('P2-5: never-started members see "카피 시작"; the label is refreshed when the modal opens', () => {
  assert.match(main, /data-copy-pause="RESUME">\$\{copyResumeLabel\(\)\}<\/button>/);
  assert.match(main, /function copyResumeLabel\(\) \{ return memberCopyNeverStarted \? '카피 시작' : '카피 재개'; \}/);
  assert.match(main, /if \(!resumeError\) memberCopyNeverStarted = isCopyNeverStarted\(resumes, currentProfile\);/);
  const render = main.slice(main.indexOf('function renderPauseModalStatus'), main.indexOf('function renderPauseModalStatus') + 300);
  assert.match(render, /resumeButton\.textContent = copyResumeLabel\(\)/);
  // isCopyNeverStarted, evaluated as written.
  const source = main.slice(main.indexOf('function isCopyNeverStarted'), main.indexOf('function copyResumeLabel'));
  const isCopyNeverStarted = new Function(`${source}; return isCopyNeverStarted;`)();
  assert.equal(isCopyNeverStarted([{ state: 'REQUIRED', requested_at: null, activated_at: null }], {}), true);
  assert.equal(isCopyNeverStarted([], { copy_started_at: null }), true);
  assert.equal(isCopyNeverStarted([{ state: 'PAUSED', requested_at: '2026-10-01T00:00:00Z', activated_at: '2026-10-01T00:01:00Z' }], {}), false);
  assert.equal(isCopyNeverStarted([{ state: 'REQUESTED', requested_at: '2026-11-03T00:00:00Z', activated_at: null }], {}), false);
  assert.equal(isCopyNeverStarted([{ state: 'REQUIRED' }], { copy_started_at: '2026-09-21T00:00:00Z' }), false);
});

test('P2-5: the confirmation runs before set_my_copy_pause(RESUME); cancelling sends nothing', () => {
  const handler = main.slice(main.indexOf("if (pauseButton && !copyPauseBusy) {"), main.indexOf("if (event.target.closest('[data-copy-pause-cancel]')"));
  assert.match(handler, /else if \(pauseButton\.dataset\.copyPause === 'RESUME'\) \{ if \(confirmMemberCopyStart\(\)\) await setCopyPause\('RESUME'\); \}/);
  const source = main.slice(main.indexOf('function copyResumeLabel'), main.indexOf('function renderPauseModalStatus'));
  const prompts = [];
  for (const [neverStarted, answer] of [[true, false], [false, true]]) {
    const window = { confirm: (text) => { prompts.push(text); return answer; } };
    const confirmMemberCopyStart = new Function('window', 'memberCopyNeverStarted', 'COPY_START_POLICY',
      `${source}; return confirmMemberCopyStart;`)(window, neverStarted, '카피를 시작(재개)하는 시점에 Master가 이미 보유한 포지션은 사지 않고, 이후 Master의 변화만 현재 자산 비율로 따라갑니다.');
    assert.equal(confirmMemberCopyStart(), answer);
  }
  assert.match(prompts[0], /^카피 시작 요청을 보낼까요\?/);
  assert.match(prompts[1], /^카피 재개 요청을 보낼까요\?/);
  for (const text of prompts) assert.match(text, /카피를 시작\(재개\)하는 시점에 Master가 이미 보유한 포지션은 사지 않고, 이후 Master의 변화만 현재 자산 비율로 따라갑니다\./);
});
