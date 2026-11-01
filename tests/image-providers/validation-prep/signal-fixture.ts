// Own-process fault fixture: no provider, service, private workspace or native query.
import {appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {runOnce,type RunPort} from './runner.ts';
const out=process.argv[2]!,controller=new AbortController(),stop=()=>controller.abort(new Error('Own local SIGTERM; external state unknown'));
process.once('SIGTERM',stop);
const port:RunPort={setup:async()=>{},submit:async()=>{appendFileSync(join(out,'fixture-posts.txt'),'POST\n');return{job_id:'fixture-signal-job'};},snapshot:()=>({workspace_id:'fixture-signal-workspace',job_id:'fixture-signal-job',attempt_id:'fixture-signal-attempt',thread_id:'fixture-signal-thread',turn_id:'fixture-signal-turn'}),
 observe:async(_,signal)=>{process.stdout.write('ready\n');return new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));},verify:async()=>{throw new Error('Signal fixture never succeeds');},capture:async()=>{},close:async()=>{}};
try{await runOnce(port,{out,mode:'fixture',requirement_version:'IMAGE-CODEX-VALIDATION-PREP/r1',max_observations:1,operation_timeout_ms:5000,poll_ms:0,signal:controller.signal});}
catch(error){process.stderr.write(String(error)+'\n');process.exitCode=2;}
finally{process.removeListener('SIGTERM',stop);}
