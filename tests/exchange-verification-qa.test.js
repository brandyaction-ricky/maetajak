import test from 'node:test';
import assert from 'node:assert/strict';
import { assertOrderIdentity, assertSubmissionSnapshot, exchangeTradeAlert } from '../worker/execution-safety.js';
import { gateRequest, findFuturesOrderByText, getOrderTrades, normalizeGatePositions } from '../worker/gate.js';
import { sendWorkerAlert } from '../worker/alerts.js';
import { auditCopyState, compareAccountPositions } from '../scripts/audit-copy-state.js';
import { observedAccount, position } from './fixtures/verified-runtime.js';
import { TradingRunner } from '../worker/trading-runner.js';

const job = { contract:'BTC_USDT',position_side:'LONG',gate_order_text:'t-mtj-qa',gate_order_id:'100',delta_size:10,
  actual_size_at_plan:0,target_size:10,master_size_at_plan:40,target_leverage:10,quanto_multiplier:0.001,
  filled_size:10,result_status:'FILLED',details:{member:'합성 검수 회원'} };
const order = { id:'100',contract:'BTC_USDT',text:'t-mtj-qa',size:10,left:0,status:'finished',finish_as:'filled',fill_price:'50100' };
const auth = { apiKey:'TEST_ONLY',secretKey:'TEST_ONLY',channelId:'maetajak' };

test('foreign symbol, wrong direction, wrong ID, and incorrect reduce-only response are quarantined', () => {
  for (const altered of [{...order,contract:'ORCL_USDT'},{...order,text:'t-other'},{...order,id:'101'},{...order,size:-10}]) {
    assert.throws(()=>assertOrderIdentity(job,altered),/일치/);
  }
  assert.throws(()=>assertOrderIdentity({...job,reduce_only:true},order),/식별자/);
  assert.throws(()=>normalizeGatePositions([{contract:'BTC_USDT',size:1,mark_price:50000,mode:'dual_short'}]),/방향/);
});

test('pre-submit checks reject stale snapshots, insufficient margin, changed positions and open orders', () => {
  const master = observedAccount({positions:[position(40)]});
  for (const account of [observedAccount({available:0}),observedAccount({positions:[position(1)]}),
    observedAccount({open_orders:[{id:'other',contract:'SOXL_USDT'}]}),observedAccount({observed_started_at:'2020-01-01'})]) {
    assert.throws(()=>assertSubmissionSnapshot(job,account,master));
  }
  assert.throws(()=>assertSubmissionSnapshot(job,observedAccount(),observedAccount({positions:[]})),/마스터/);
  assertSubmissionSnapshot(job,observedAccount(),master);
  assert.throws(()=>assertSubmissionSnapshot({...job,delta_size:11},observedAccount(),master),/변화량/);
});

test('protected position additions budget the existing leverage without changing it', () => {
  const protectedJob = {...job,actual_size_at_plan:7,target_size:17,target_leverage:null,risk_leverage:2};
  assertSubmissionSnapshot(protectedJob,observedAccount({positions:[position(7)],available:300}),observedAccount({positions:[position(40)]}));
  assert.throws(()=>assertSubmissionSnapshot(protectedJob,observedAccount({positions:[position(7)],available:100}),observedAccount({positions:[position(40)]})),/증거금/);
});

test('Telegram uses actual average fill price and short covering reports BUY', () => {
  const details = exchangeTradeAlert(job,order);
  assert.equal(details.fill_notional_usdt,501); assert.equal(details.side,'BUY');
  const covered = exchangeTradeAlert({...job,position_side:'SHORT',reduce_only:true},{...order,reduce_only:true});
  assert.equal(covered.side,'BUY'); assert.equal(covered.result_status,'FILLED');
  assert.throws(()=>exchangeTradeAlert(job,{...order,left:10,finish_as:'ioc'}),/알림 기록/);
  assert.throws(()=>exchangeTradeAlert(job,{...order,fill_price:0}),/체결 금액/);
});

test('a DB-only fill cannot produce a Telegram success message', async () => {
  let sent=0; const completed=[];
  const runner=new TradingRunner({supabase:{},mode:'DRY_RUN',onSafetyEvent:async()=>{sent++;return {sent:true};},
    fetchImpl:async(url)=>new Response(JSON.stringify(url.includes('/my_trades')?[]:{...order,left:10,finish_as:'ioc'}))});
  runner.rpc=async(name,p)=>name==='claim_copy_entry_alerts'?[{...job,alert_id:1,api_key:'test',secret_key:'test'}]:completed.push(p);
  assert.equal(await runner.deliverEntryAlerts(),0); assert.equal(sent,0); assert.equal(completed[0].p_sent,false);
});

test('Telegram HTTP 200 requires confirmed message ID, preserves zero fill and removes secret fields', async () => {
  for (const payload of [{ok:false,error_code:429},{ok:true,result:{}},null]) {
    const r=await sendWorkerAlert({telegramBotToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef',telegramChatId:'-1001234567890',
      event:'COPY_ORDER_FAILED',fetchImpl:async()=>new Response(JSON.stringify(payload))});
    assert.equal(r.sent,false);
  }
  let body;
  const r=await sendWorkerAlert({telegramBotToken:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdef',telegramChatId:'-1001234567890',
    event:'COPY_ORDER_FAILED',details:{filled_size:0,fill_notional_usdt:0,api_key:'NEVER_PRINT',secret_key:'NEVER_PRINT'},
    fetchImpl:async(_url,options)=>{body=JSON.parse(options.body);return new Response('{"ok":true,"result":{"message_id":42}}');}});
  assert.equal(r.sent,true); assert.match(body.text,/체결 수량: 0/); assert.match(body.text,/0.00 USDT/); assert.doesNotMatch(body.text,/NEVER_PRINT/);
});

test('the production Gate timeout signal aborts a hanging POST after five seconds without retry', async () => {
  let calls=0; const began=Date.now();
  // A referenced timer keeps the test process alive while AbortSignal.timeout
  // uses an unreferenced timer internally. It is cleared on completion.
  const keepAlive=setTimeout(()=>{},7000);
  try {
    await assert.rejects(gateRequest({...auth,method:'POST',path:'/api/v4/futures/usdt/orders',body:{},
      fetchImpl:async(_url,options)=>{calls++;return new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}}),
    (e)=>e.code==='GATE_TIMEOUT' && e.outcomeUnknown);
    assert.equal(calls,1); assert.ok(Date.now()-began>=4900 && Date.now()-began<6500);
  } finally {clearTimeout(keepAlive);}
});

test('order lookup pages beyond the latest 100 trades and never uses not-found as permission to POST', async () => {
  const methods=[];
  const found=await findFuturesOrderByText({...auth,text:job.gate_order_text,contract:job.contract,fetchImpl:async(url,options)=>{
    methods.push(options.method); const u=new URL(url);
    if(u.pathname.endsWith(job.gate_order_text))return new Response('{"label":"ORDER_NOT_FOUND"}',{status:404});
    if(u.searchParams.get('status')==='open')return new Response('[]');
    return new Response(JSON.stringify(Number(u.searchParams.get('offset'))===0?
      Array.from({length:100},(_,i)=>({...order,id:String(i+1000),text:'t-other'})):[order]));
  }});
  assert.equal(found.id,'100'); assert.ok(methods.length>=4 && methods.every((m)=>m==='GET'));
});

test('trade evidence rejects unrelated order IDs and incomplete pagination', async () => {
  await assert.rejects(getOrderTrades({...auth,orderId:'100',contract:'BTC_USDT',fetchImpl:async()=>new Response(JSON.stringify([
    {id:'trade-1',order_id:'other',contract:'BTC_USDT',size:10,price:50000}]))}),/체결 목록/);
});

test('read-only audit detects SOXL 100 in DB versus zero at Gate and makes no write calls', async () => {
  const account={trading_account_id:'member',role:'MEMBER',status:'VERIFIED',observed_at:new Date().toISOString(),
    positions:[{contract:'SOXL_USDT',position_side:'LONG',size:100,engine_size:100}]};
  assert.equal(compareAccountPositions(account,observedAccount()).length,1);
  const calls=[];
  const report=await auditCopyState({rpc:async(name)=>{calls.push(name); return name==='get_copy_worker_context'?{members:[{trading_account_id:'member'}]}:
    {schema_version:3,accounts:[account],unresolved_orders:0,pending_fill_observations:0};},readAccount:async()=>observedAccount()});
  assert.equal(report.ok,false); assert.equal(report.accounts[0].status,'MISMATCH'); assert.equal(report.accounts[0].mismatches[0].gate_size,0);
  assert.deepEqual(calls,['get_copy_state_reconciliation','get_copy_worker_context']);
});
