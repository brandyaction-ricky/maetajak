import { spawn } from 'node:child_process';

function qaUrl() {
  const value=process.env.COPY_QA_DATABASE_URL;
  if (!value) throw new Error('COPY_QA_DATABASE_URL is required for PostgreSQL concurrency tests');
  const url=new URL(value);
  if (!['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.pathname!=='/maetajak_qa') {
    throw new Error('Concurrency tests require an isolated localhost maetajak_qa database');
  }
  return value;
}
export function psql(input) {
  return new Promise((resolve,reject)=>{
    const child=spawn('psql',['-X','-q','-A','-t','-v','ON_ERROR_STOP=1',qaUrl()],{stdio:['pipe','pipe','pipe']});
    let out=''; let err='';
    child.stdout.on('data',(b)=>{out+=b;}); child.stderr.on('data',(b)=>{err+=b;});
    child.on('error',reject); child.on('close',(code)=>code===0?resolve(out.trim()):reject(new Error(err || 'QA psql failed')));
    child.stdin.end("set request.jwt.claim.role='service_role';\n"+input);
  });
}
function literal(value) {
  if(value==null)return 'null';
  if(typeof value==='number') {if(!Number.isFinite(value))throw new Error('Invalid QA number');return String(value);}
  if(typeof value==='boolean')return String(value);
  return "'"+(typeof value==='string'?value:JSON.stringify(value)).replaceAll("'","''")+"'";
}
export const postgresClient={
  exec:psql,
  query:async(sql,params=[])=>{
    // Fixtures contain no dollar-quoted function bodies when parameters are
    // bound. Values go through SQL literal quoting and never through a shell.
    const q=sql.replace(/\$(\d+)/g,(_,n)=>literal(params[Number(n)-1])).trim().replace(/;$/,'');
    if(!/^select\b/i.test(q)) {await psql(q+';');return {rows:[]};}
    const result=await psql(`select coalesce(json_agg(row_to_json(r)),'[]') from (${q}) r;`);
    return {rows:JSON.parse(result || '[]')};
  },
};
