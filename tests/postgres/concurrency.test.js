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
import { reversalRuntime } from '../fixtures/reversal-runtime.js';

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

for (const absent of [false,true]) {
  test(`twelve workers acquire exactly one ${absent ? 'absent' : 'expired'} PostgreSQL lease`, async () => {
    if (absent) await db.exec('delete from private.copy_worker_runtime');
    else await db.exec("update private.copy_worker_runtime set worker_id='expired-owner',heartbeat_at=clock_timestamp()-interval '1 minute'");
    const results = await Promise.allSettled(Array.from({length:12},(_,n)=>db.query(
      "select public.copy_worker_heartbeat($1,'0.5.0','https://api.gateio.ws','192.0.2.1','maetajak','LIVE',false) value", [`qa-lease-${n}`])));
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
    const rejected=results.filter(r=>r.status==='rejected'); assert.equal(rejected.length,11);
    for(const result of rejected) assert.match(result.reason.message,/WORKER_LEASE_HELD/);
    const owner=(await db.query('select worker_id from private.copy_worker_runtime')).rows[0].worker_id;
    await db.query("select public.copy_worker_heartbeat($1,'0.5.0','https://api.gateio.ws','192.0.2.1','maetajak','LIVE',false)",[owner]);
    assert.equal((await db.query('select worker_id from private.copy_worker_runtime')).rows[0].worker_id,owner);
  });
}

test('concurrent verification consumes a confirmed ownership fill exactly once',async()=>{
  const exchange={masterSize:40,memberSize:0,posts:0,orders:[]};
  const runner=faultRunner(db,exchange).runner;
  await runner.syncOnce(); await runner.submitOrders(); await runner.syncOnce();
  await db.exec("update private.copy_order_intents set position_match_at=clock_timestamp()-interval '3 seconds'");
  await runner.syncOnce();
  const results=await Promise.allSettled(Array.from({length:12},()=>record(db,cyclePayload({actualSize:10}))));
  // Older competing snapshots may be rejected; accepted snapshots cannot
  // apply the same fill twice or create an unexplained ownership transition.
  assert.ok(results.some(r=>r.status==='fulfilled'));
  assert.equal(Number((await db.query('select count(*) n from private.copy_ownership_fills')).rows[0].n),1);
  const proof=(await db.query('select status,copy_positions from private.copy_ownership_checkpoints')).rows[0];
  assert.equal(proof.status,'CONFIRMED'); assert.equal(proof.copy_positions[0].size,10);
  assert.equal(exchange.posts,1);
});

test('different symbol legs cannot claim the same member margin concurrently',async()=>{
  const p=cyclePayload({master:{positions:[position(40),{...position(40,'SOXL_USDT'),markPrice:50}]}});
  await record(db,p);
  assert.equal(Number((await db.query('select count(*) n from private.copy_order_intents')).rows[0].n),2);
  const results=await Promise.all(Array.from({length:12},()=>db.query('select * from public.claim_copy_order_intents(10)')));
  assert.equal(results.flatMap((r)=>r.rows).length,1);
});

test('twelve independent connections cannot claim an unreceipted current-seed intent',async()=>{
  await record(db,cyclePayload());
  await db.query('update private.copy_resume_sessions set sync_current_master=true where trading_account_id=$1',[ids.member]);
  const results=await Promise.all(Array.from({length:12},()=>db.query('select * from public.claim_copy_order_intents(10)')));
  assert.equal(results.flatMap(r=>r.rows).length,0);
  const intent=(await db.query('select status,submit_attempts,submission_authorized_at from private.copy_order_intents')).rows[0];
  assert.equal(intent.status,'PLANNED'); assert.equal(intent.submit_attempts,0); assert.equal(intent.submission_authorized_at,null);
});

test('concurrent authorization cannot revive a claim after resume consent is invalidated',async()=>{
  await record(db,cyclePayload());
  const [job]=(await db.query('select * from public.claim_copy_order_intents(10)')).rows;
  await db.query('update private.copy_resume_sessions set sync_current_master=true where trading_account_id=$1',[ids.member]);
  const results=await Promise.all(Array.from({length:12},()=>db.query('select public.authorize_copy_order_submission($1,$2) allowed',[job.intent_id,ids.version])));
  assert.equal(results.filter(r=>r.rows[0].allowed).length,0);
  const intent=(await db.query('select status,submission_authorized_at,last_error_code from private.copy_order_intents')).rows[0];
  assert.equal(intent.status,'CANCELLED'); assert.equal(intent.submission_authorized_at,null);
  assert.equal(intent.last_error_code,'SUBMISSION_AUTHORIZATION_REVOKED');
});

test('concurrent ordinary RESUME requests share one future-only generation without implicit consent',async()=>{
  await db.query("update private.copy_resume_sessions set state='PAUSED' where trading_account_id=$1",[ids.member]);
  await db.query('update public.profiles set copy_paused=true where id=$1',[ids.user]);
  const results=await Promise.all(Array.from({length:12},()=>db.query('select private.request_member_copy_resume($1) value',[ids.user])));
  const versions=new Set(results.map(r=>r.rows[0].value.sessions[0].version));
  assert.equal(versions.size,1); assert.ok(!versions.has(ids.version));
  const session=(await db.query('select state,sync_current_master from private.copy_resume_sessions')).rows[0];
  assert.equal(session.state,'REQUESTED'); assert.equal(session.sync_current_master,false);
  assert.equal(Number((await db.query('select count(*) n from private.copy_operation_history')).rows[0].n),0);
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

for (const sign of [1,-1]) for (const entryFirst of [true,false]) test(`${sign}: twelve PostgreSQL claimers enforce observed close dependency with entry UUID ${entryFirst ? 'first' : 'last'}`, async()=>{
  const f=reversalRuntime(db,sign); await f.initialize(); f.exchange.masterSize=-sign*40;
  const runner=f.makeRunner({},true); await runner.syncOnce(); await f.orderCandidates(entryFirst);
  const claim=async()=> (await Promise.all(Array.from({length:12},()=>db.query('select * from public.claim_copy_order_intents(1)')))).flatMap(r=>r.rows);
  const authorize=async job=> (await Promise.all(Array.from({length:12},()=>db.query('select public.authorize_copy_order_submission($1,$2) allowed',[job.intent_id,ids.version])))).filter(r=>r.rows[0].allowed).length;
  const [close,...extra]=await claim(); assert.ok(close); assert.equal(extra.length,0); assert.equal(close.reduce_only,true);
  assert.equal(Number(close.delta_size),-sign*10); assert.equal(await authorize(close),1);
  assert.equal((await claim()).length,0,'SUBMITTING close blocks every competing entry');
  // Synthetic terminal exchange result; only fixture exposure changes here.
  await db.query("select public.complete_copy_order_attempt($1,'FILLED','TEST_CLOSE',$2,50100,201,'filled',null,$3)",
    [close.intent_id,-sign*10,{finish_as:'filled',left:0,terminal:true}]);
  f.legs[f.oldSide]=0;
  assert.equal((await claim()).length,0,'terminal fill still needs safe observations');
  await f.confirm(runner); await runner.syncOnce();
  const [entry,...duplicates]=await claim(); assert.ok(entry); assert.equal(duplicates.length,0); assert.equal(entry.reduce_only,false);
  assert.equal(Number(entry.delta_size),-sign*10); assert.equal(await authorize(entry),1);
});

for (const sign of [1,-1]) test(`${sign}: concurrent PostgreSQL workers cannot enter opposite leg while a close outcome is UNKNOWN`, async()=>{
  const f=reversalRuntime(db,sign); await f.initialize(); f.exchange.masterSize=-sign*40;
  const runner=f.makeRunner({exchange:'timeout'},true); await runner.syncOnce(); await runner.submitOrders();
  assert.equal((await db.query('select status from private.copy_order_intents where reduce_only')).rows[0].status,'UNKNOWN');
  const restarted=f.makeRunner({},true); await restarted.syncOnce();
  const results=await Promise.all(Array.from({length:12},()=>db.query('select * from public.claim_copy_order_intents(1)')));
  assert.equal(results.flatMap(r=>r.rows).length,0); assert.equal(f.submissions.length,2); assert.equal(f.legs[f.newSide],0);
});
