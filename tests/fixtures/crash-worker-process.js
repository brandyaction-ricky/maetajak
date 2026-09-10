import { writeFileSync } from 'node:fs';
import { postgresClient as db } from './postgres-client.js';
import { faultRunner } from './fault-runner.js';

const [phase,ledger]=process.argv.slice(2);
const exchange={masterSize:40,memberSize:0,posts:0,orders:[]};
const r=faultRunner(db,exchange).runner;
const invoke=r.rpc.bind(r);
async function checkpoint() {
  writeFileSync(ledger,JSON.stringify(exchange));
  const keepAlive=setInterval(()=>{},1000);
  process.once('disconnect',()=>{clearInterval(keepAlive);process.exit(1);});
  process.send({checkpoint:phase});
  await new Promise(()=>{});
}
r.rpc=async(name,params)=>{
  if(phase==='before_authorization' && name==='authorize_copy_order_submission')await checkpoint();
  if(phase==='after_exchange' && name==='complete_copy_order_attempt')await checkpoint();
  const result=await invoke(name,params);
  if(phase==='after_authorization' && name==='authorize_copy_order_submission')await checkpoint();
  if(phase==='after_commit' && name==='complete_copy_order_attempt')await checkpoint();
  return result;
};
await r.syncOnce(); await r.submitOrders();
throw new Error('Requested crash checkpoint was not reached');
