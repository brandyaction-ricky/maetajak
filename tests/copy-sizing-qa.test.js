import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions } from '../worker/trading-runner.js';
import { cyclePayload, ids, position, contractInfo } from './fixtures/verified-runtime.js';

function anchored(masterSize, actualSize, previousMaster, targetSize, extra = {}) {
  const side = previousMaster < 0 ? 'SHORT' : 'LONG';
  return cyclePayload({ masterSize, actualSize, member: { previous_states: [{ contract: 'BTC_USDT', position_side: side,
    actual_size: actualSize, state: 'SYNCED', ...extra.previous }], target_anchors: [{ contract: 'BTC_USDT', position_side: side,
    resume_version: ids.version, master_copyable_size: previousMaster, target_size: targetSize }], ...extra.member }, ...extra.payload }).members[0].planned_positions[0];
}

for (const sign of [1,-1]) {
  const side = sign > 0 ? 'LONG' : 'SHORT';
  test(`${side}: $20,000 Master at 10% yields $500 / $5,000 member at 10%, independently of leverage`, () => {
    for (const leverage of [1,3,10,50]) {
      const p = cyclePayload({ masterSize: sign * 40, master: { positions: [{ ...position(sign * 40), leverage }] } }).members[0].planned_positions[0];
      assert.equal(p.target_size, sign * 10); assert.equal(Math.abs(p.target_size) * 50000 * 0.001 / 5000, 0.1);
      assert.equal(p.target_leverage, leverage); assert.equal(p.intent.reduce_only, false);
    }
  });
  test(`${side}: staged entries scale cumulative exposure without repeating earlier fills`, () => {
    const p = anchored(sign * 80, sign * 10, sign * 40, sign * 10);
    assert.equal(p.target_size, sign * 20); assert.equal(p.intent.delta_size, sign * 10);
    const done = anchored(sign * 80, sign * 20, sign * 80, sign * 20);
    assert.equal(done.intent, undefined);
  });
  test(`${side}: missed or partial entry followed by Master reduction never creates a replacement entry`, () => {
    const partial = anchored(sign * 20, sign * 6, sign * 40, sign * 10);
    assert.equal(partial.target_size, sign * 3); assert.equal(partial.intent.delta_size, -sign * 3);
    assert.equal(partial.intent.reduce_only, true);
    const missed = anchored(sign * 20, 0, sign * 40, sign * 10);
    assert.equal(missed.target_size, 0); assert.equal(missed.intent, undefined);
  });
  test(`${side}: a changed member fill price cannot change contract count`, () => {
    const p = anchored(sign * 80, sign * 10, sign * 40, sign * 10,
      { member: { positions: [{ ...position(sign * 10), entryPrice: 55000, markPrice: 50100 }] } });
    assert.equal(p.target_size, sign * 20); assert.equal(p.intent.delta_size, sign * 10);
  });
  test(`${side}: reduced risk target stays reduced after equity recovers`, () => {
    const capped = anchored(sign * 40, sign * 10, sign * 40, sign * 10, { member: { total: 500, max_position_ratio: 30 } });
    assert.equal(capped.target_size, sign * 3);
    const recovered = anchored(sign * 40, sign * 3, sign * 40, sign * 3);
    assert.equal(recovered.target_size, sign * 3); assert.equal(recovered.intent, undefined);
  });
}

test('configured copy percentages scale nominal exposure once, with rounding toward zero', () => {
  for (const [ratio, target] of [[50,5],[100,10],[150,15],[200,20],[33,3]]) {
    const p = cyclePayload({ member: { copy_ratio: ratio } }).members[0].planned_positions[0];
    assert.equal(p.target_size, target);
  }
});

test('insufficient margin caps the entry, preserves the decision and never spends expected close proceeds', () => {
  const p = cyclePayload({ member: { available: 10 } }).members[0].planned_positions[0];
  assert.equal(p.target_size, 1); assert.equal(p.sizing_reason, 'INSUFFICIENT_AVAILABLE_MARGIN');
  const recovered = anchored(40,1,40,1); assert.equal(recovered.intent, undefined);
  const zero = cyclePayload({ member: { available: 0 } }).members[0].planned_positions[0];
  assert.equal(zero.target_size, 0); assert.equal(zero.intent, undefined);
});

test('multiple symbols reserve one shared margin balance and hedge legs share one gross symbol cap', () => {
  const run = (masterPositions, available, maxRatio = 30) => planMemberPositions({ cycleId: 'sizing-budget', system: {},
    contracts: new Map(['BTC_USDT','ETH_USDT'].map((c) => [c,contractInfo])),
    master: { total: 20000, positions: masterPositions }, member: { user_id: 'member', total: 5000, available,
      positionMode: 'dual', positions: [], copy_ratio: 100, max_position_ratio: maxRatio } });
  const two = run([position(40),position(40,'ETH_USDT')],75);
  const required = two.reduce((sum,p) => sum + Math.abs(p.delta_size) * 50 * 1.005 * (0.1 + 0.001),0);
  assert.ok(required <= 75); assert.equal(two[0].target_size,10); assert.equal(two[1].target_size,4);
  const hedge = run([position(80),position(-80)],4500);
  assert.equal(hedge.reduce((sum,p) => sum + Math.abs(p.target_size)*50,0),1500);
  assert.equal(hedge[1].sizing_reason,'SYMBOL_GROSS_EXPOSURE_LIMIT');
});

test('ORCL and HOOD cannot appear as entries without corresponding Master positions', () => {
  const p = planMemberPositions({ cycleId:'no-stray',system:{},contracts:new Map(['ORCL_USDT','HOOD_USDT'].map((c)=>[c,contractInfo])),
    master:{total:20000,positions:[]},member:{user_id:'member',resume_version:ids.version,total:5000,positions:[],copy_ratio:100,max_position_ratio:30,
      target_anchors:['ORCL_USDT','HOOD_USDT'].map((contract)=>({contract,position_side:'LONG',resume_version:ids.version,master_copyable_size:100,target_size:25}))} });
  assert.ok(p.every((x)=>!x.intent && x.target_size===0));
  assert.equal(p.length,2);
});

test('manual stray positions and open exchange orders pause copying without consuming a Master change', () => {
  const manual = cyclePayload({ member:{positions:[position(3,'SOXL_USDT')]} }).members[0].planned_positions.find((p)=>p.contract==='SOXL_USDT');
  assert.equal(manual.state,'MANUAL_OVERRIDE'); assert.equal(manual.intent,undefined); assert.equal(manual.anchor_update_allowed,false);
  const open = anchored(80,10,40,10,{member:{open_orders:[{id:'pending',contract:'BTC_USDT'}]}});
  assert.equal(open.state,'PAUSED'); assert.equal(open.intent,undefined); assert.equal(open.anchor_update_allowed,false);
});

test('loss limits permit risk-reducing Master closures while blocking all additions', () => {
  const reduction = anchored(20,10,40,10,{member:{reduce_only:true,risk_halt_reason:'DAILY_LOSS_LIMIT'}});
  assert.equal(reduction.intent.delta_size,-5); assert.equal(reduction.intent.reduce_only,true);
  const addition = anchored(80,10,40,10,{member:{reduce_only:true}});
  assert.equal(addition.intent,undefined);
});
