// QA-only regression. Real candidate SQL/Worker with independent dual-leg mock.
// Deterministic UUID ordering models one valid order of simultaneous candidates.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createVerifiedDatabase, seedVerifiedAccount, ids, position } from './fixtures/verified-runtime.js';
import { faultRunner } from './fixtures/fault-runner.js';

test('QA-REVERSAL: existing confirmed COPY must close before the opposite entry is submitted', async () => {
  for (const sign of [1, -1]) {
    const db = await createVerifiedDatabase();
    try {
      await seedVerifiedAccount(db);
      const exchange = { masterSize: sign * 40, memberSize: 0, posts: 0, orders: [] };
      const legs = { LONG: 0, SHORT: 0 };
      const submissions = [];
      const { runner } = faultRunner(db, exchange);
      const read = runner.readAccount.bind(runner);
      runner.readAccount = async (account) => {
        const result = await read(account);
        if (account.trading_account_id === ids.member) result.positions = Object.values(legs).filter(Boolean).map(n => position(n));
        return result;
      };
      const transport = runner.fetchImpl;
      runner.fetchImpl = async (url, request = {}) => {
        if (request.method === 'POST' && new URL(url).pathname.endsWith('/orders')) {
          const body = JSON.parse(request.body);
          const size = Number(body.size);
          const side = body.reduce_only ? (size < 0 ? 'LONG' : 'SHORT') : (size > 0 ? 'LONG' : 'SHORT');
          submissions.push({ size, reduce_only: body.reduce_only, side, before: { ...legs } });
          const result = await transport(url, request);
          legs[side] += size;
          return result;
        }
        return transport(url, request);
      };
      const confirm = async () => {
        await runner.syncOnce();
        await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds' where observation_confirmed_at is null");
        await runner.syncOnce();
      };
      await runner.syncOnce(); await runner.submitOrders(); await confirm();
      assert.equal(legs[sign > 0 ? 'LONG' : 'SHORT'], sign * 10);
      assert.equal((await db.query('select status from private.copy_ownership_checkpoints')).rows[0].status, 'CONFIRMED');
      await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false)", [ids.user]);
      await db.exec("select public.set_my_copy_pause('HOLD'); select public.set_my_copy_pause('RESUME'); select set_config('request.jwt.claim.role','service_role',false)");
      runner.readResumeSnapshot = async (masterContext, memberContext) => {
        const startedAt = Date.now();
        const [master, member] = await Promise.all([runner.readAccount(masterContext), runner.readAccount(memberContext)]);
        return { startedAt, master, member, openOrders: [] };
      };
      await runner.syncOnce();
      assert.equal((await db.query('select state from private.copy_resume_sessions')).rows[0].state, 'ACTIVE');
      await runner.syncOnce(); await runner.submitOrders();
      assert.equal(submissions.length, 1, 'ordinary resume must itself submit zero orders');
      exchange.masterSize = -sign * 40;
      await runner.syncOnce();
      // Same-cycle created_at values tie. UUIDs are not semantic priorities.
      // Choose a valid tie ordering with the opening candidate first. No size,
      // intent evidence, fill, eligibility, or application function is changed.
      await db.exec("update private.copy_order_intents set id=case when reduce_only then 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid else '00000000-0000-4000-8000-000000000001'::uuid end where status='PLANNED'");
      const plans = (await db.query("select id,position_side,delta_size,reduce_only,status,created_at from private.copy_order_intents where status='PLANNED' order by created_at,id")).rows;
      await runner.submitOrders();
      const intents = (await db.query('select position_side,delta_size,reduce_only,status,submission_authorized_at from private.copy_order_intents order by created_at,id')).rows;
      console.log('QA-REVERSAL EVIDENCE', JSON.stringify({ sign, masterSize: exchange.masterSize, plans, submissions, legs, intents }));
      assert.ok(submissions.length >= 2, 'a Master reversal must make progress closing existing COPY');
      assert.equal(submissions[1].reduce_only, true, 'first reversal order must close the old leg, never open the opposite leg while old COPY remains');
      assert.equal(submissions[1].size, -sign * 10);
      assert.equal(legs[sign > 0 ? 'LONG' : 'SHORT'], 0);
    } finally { await db.close(); }
  }
});
