import test,{before,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync,mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { postgresClient as db } from '../fixtures/postgres-client.js';
import { migrationFiles,seedVerifiedAccount,cyclePayload,record,ids,position } from '../fixtures/verified-runtime.js';
import { faultRunner } from '../fixtures/fault-runner.js';

before(async()=>{
  await db.exec(readFileSync('tests/fixtures/copy-runtime-schema.sql','utf8'));
  await db.exec('insert into public.copy_system_control default values');
  for(const file of migrationFiles) await db.exec(readFileSync(`supabase/migrations/${file}`,'utf8'));
});
beforeEach(async()=>{
  await db.exec(`do $$ declare t record; begin for t in select schemaname,tablename from pg_tables
    where schemaname in ('public','private') loop execute format('truncate table %I.%I cascade',t.schemaname,t.tablename); end loop; end $$;
    insert into public.copy_system_control default values;`);
  await seedVerifiedAccount(db);
});

test('twelve independent PostgreSQL connections claim and authorize a single order exactly once',async()=>{
  await record(db,cyclePayload());
  const results=await Promise.all(Array.from({length:12},()=>db.query('select * from public.claim_copy_order_intents(10)')));
  const jobs=results.flatMap((r)=>r.rows); assert.equal(jobs.length,1);
  const permits=await Promise.all(Array.from({length:12},()=>db.query('select public.authorize_copy_order_submission($1,$2) allowed',[jobs[0].intent_id,ids.version])));
  assert.equal(permits.filter((r)=>r.rows[0].allowed).length,1);
});

test('different symbol legs cannot claim the same member margin concurrently',async()=>{
  const p=cyclePayload({master:{positions:[position(40),{...position(40,'SOXL_USDT'),markPrice:50}]}});
  await record(db,p);
  assert.equal(Number((await db.query('select count(*) n from private.copy_order_intents')).rows[0].n),2);
  const results=await Promise.all(Array.from({length:12},()=>db.query('select * from public.claim_copy_order_intents(10)')));
  assert.equal(results.flatMap((r)=>r.rows).length,1);
});

test('a fresh cycle supersedes an unsubmitted plan without weakening duplicate auto-halt',async()=>{
  await record(db,cyclePayload());
  await record(db,cyclePayload());
  const intents=(await db.query("select status,submit_attempts,last_error_code from private.copy_order_intents order by created_at")).rows;
  assert.deepEqual(intents.map((i)=>i.status),['CANCELLED','PLANNED']);
  assert.equal(intents[0].submit_attempts,0);
  assert.equal(intents[0].last_error_code,'SUPERSEDED_BY_FRESH_PLAN');
  const duplicate=(await db.query(`select coalesce(max(n),0) n from (
    select count(*) n from private.copy_order_intents
    where status in ('PLANNED','SUBMITTING','ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','UNKNOWN') and delta_size<>0
    group by trading_account_id,contract,position_side,actual_size_at_plan,sign(delta_size),reduce_only
  ) groups`)).rows[0];
  assert.equal(Number(duplicate.n),1);
  const control=(await db.query('select execution_enabled,emergency_halted from public.copy_system_control')).rows[0];
  assert.equal(control.execution_enabled,true); assert.equal(control.emergency_halted,false);
});

for(const phase of ['before_authorization','after_authorization','after_exchange','after_commit']) {
  test(`SIGKILL at ${phase} recovers from durable SQL state without duplicating an exchange order`,async()=>{
    const dir=mkdtempSync(join(tmpdir(),'maetajak-qa-crash-')); const ledger=join(dir,'exchange.json');
    const child=fork('tests/fixtures/crash-worker-process.js',[phase,ledger],{stdio:['ignore','pipe','pipe','ipc']});
    let stderr=''; child.stderr.on('data',(b)=>{stderr+=b;});
    const timeout=setTimeout(()=>child.kill('SIGKILL'),15000);
    try {
      const reached=await Promise.race([once(child,'message').then(([m])=>m),once(child,'exit').then(()=>{throw new Error(stderr || 'Worker exited before checkpoint');})]);
      assert.equal(reached.checkpoint,phase);
      const exited=once(child,'exit'); child.kill('SIGKILL'); const [,signal]=await exited; assert.equal(signal,'SIGKILL');
      const exchange=JSON.parse(readFileSync(ledger,'utf8'));
      await db.exec("update private.copy_order_intents set submitted_at=clock_timestamp()-interval '1 minute',updated_at=clock_timestamp()-interval '1 minute' where status='SUBMITTING'; update private.copy_reconciliation_jobs set run_after=clock_timestamp()-interval '1 second',claimed_at=null");
      const restarted=faultRunner(db,exchange).runner;
      await restarted.reconcileOrders(); await restarted.syncOnce(); await restarted.submitOrders();
      assert.equal(exchange.posts,phase==='after_authorization'?0:1);
      const statuses=(await db.query('select status from private.copy_order_intents')).rows.map((r)=>r.status);
      assert.ok(statuses.includes(phase==='after_authorization'?'UNKNOWN':'FILLED'));
    } finally {clearTimeout(timeout); if(child.exitCode==null && child.signalCode==null)child.kill('SIGKILL'); rmSync(dir,{recursive:true,force:true});}
  });
}
