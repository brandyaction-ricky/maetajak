import test from 'node:test';
import assert from 'node:assert/strict';
import { planMemberPositions } from '../worker/trading-runner.js';

const contract = 'BTC_USDT';
const contracts = new Map([[contract, {
  quantoMultiplier: 0.001, sizeStep: 1, orderSizeMin: 1,
}]]);

function plan({ sign = 1, masterSize = 50, actualSize = 50, anchorSize = 50,
  protectedSize = 0, memberEquity = 7000, masterEquity = 5000,
  maxPositionRatio = 100, previousStates = [], sizeStep = 1,
  orderSizeMin = sizeStep } = {}) {
  const positionSide = sign > 0 ? 'LONG' : 'SHORT';
  return planMemberPositions({
    cycleId: 'synthetic-close-regression',
    system: { emergency_halted: false },
    contracts: new Map([[contract, { ...contracts.get(contract), sizeStep, orderSizeMin }]]),
    master: {
      total: masterEquity,
      positions: masterSize ? [{ contract, size: sign * masterSize, markPrice: 50000 }] : [],
    },
    member: {
      user_id: 'synthetic-member', total: memberEquity,
      copy_ratio: 100, max_position_ratio: maxPositionRatio, resume_version: 'resume-1',
      positions: [{ contract, size: sign * actualSize, markPrice: 50000 }],
      previous_states: previousStates,
      member_position_baselines: protectedSize ? [{ contract, size: sign * protectedSize }] : [],
      target_anchors: [{
        contract, position_side: positionSide, resume_version: 'resume-1',
        master_copyable_size: sign * 100, target_size: sign * anchorSize,
        protected_member_size: sign * protectedSize,
      }],
    },
  })[0];
}

for (const sign of [1, -1]) {
  const side = sign > 0 ? 'LONG' : 'SHORT';

  test(`${side}: a 50% Master reduction halves copied quantity despite equity drift`, () => {
    for (const [masterEquity, memberEquity] of [[5000, 7000], [20000, 3000], [10000, 5000]]) {
      const position = plan({ sign, masterEquity, memberEquity });
      assert.equal(position.target_size, sign * 25);
      assert.equal(position.intent.delta_size, -sign * 25);
      assert.equal(position.intent.reduce_only, true);
    }
  });

  test(`${side}: proportional reduction preserves holdings protected at resume`, () => {
    const position = plan({ sign, actualSize: 70, anchorSize: 70, protectedSize: 20 });
    assert.equal(position.target_size, sign * 45);
    assert.equal(position.intent.delta_size, -sign * 25);
    assert.equal(position.intent.reduce_only, true);
  });

  test(`${side}: a stricter risk cap can further reduce only copied holdings`, () => {
    const position = plan({ sign, actualSize: 70, anchorSize: 70, protectedSize: 20,
      memberEquity: 1000, maxPositionRatio: 10 });
    assert.equal(position.target_size, sign * 20);
    assert.equal(position.intent.delta_size, -sign * 50);
    assert.equal(position.intent.reduce_only, true);
  });

  test(`${side}: Master full close submits the final single contract`, () => {
    const position = plan({ sign, masterSize: 0, actualSize: 1, anchorSize: 1 });
    assert.equal(position.target_size, 0);
    assert.equal(position.state, 'DRIFT');
    assert.equal(position.intent.delta_size, -sign);
    assert.equal(position.intent.reduce_only, true);
  });

  test(`${side}: full close removes the last copied contract above protected holdings`, () => {
    const position = plan({ sign, masterSize: 0, actualSize: 21, anchorSize: 21, protectedSize: 20 });
    assert.equal(position.target_size, sign * 20);
    assert.equal(position.intent.delta_size, -sign);
    assert.equal(position.intent.reduce_only, true);
  });

  test(`${side}: a tradable fractional last lot is closed`, () => {
    const position = plan({ sign, masterSize: 0, actualSize: 0.1, anchorSize: 0.1, sizeStep: 0.1 });
    assert.equal(position.intent.delta_size, -sign * 0.1);
    assert.equal(position.intent.reduce_only, true);
  });

  test(`${side}: decimal subtraction cannot hide the last copied lot`, () => {
    const position = plan({ sign, masterSize: 0, actualSize: 0.3, anchorSize: 0.3,
      protectedSize: 0.2, sizeStep: 0.1 });
    assert.equal(position.target_size, sign * 0.2);
    assert.equal(position.intent.delta_size, -sign * 0.1);
    assert.equal(position.intent.reduce_only, true);
  });

  test(`${side}: an unresolved order still blocks a proportional close`, () => {
    const position = plan({ sign, previousStates: [{
      contract, position_side: side, state: 'SYNCED', actual_size: sign * 50,
      has_unresolved_order: true,
    }] });
    assert.equal(position.state, 'PAUSED');
    assert.equal(Object.hasOwn(position, 'intent'), false);
  });

  test(`${side}: below-minimum dust cannot create an invalid exchange order`, () => {
    const position = plan({ sign, masterSize: 0, actualSize: 0.1, anchorSize: 0.1,
      sizeStep: 0.1, orderSizeMin: 1 });
    assert.equal(Object.hasOwn(position, 'intent'), false);
  });
}
