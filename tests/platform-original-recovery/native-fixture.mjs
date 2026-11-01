#!/usr/bin/env node
import {readFileSync,appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createInterface} from 'node:readline';
import {randomUUID} from 'node:crypto';
import {CODEX_SCHEMA_HASHES} from '../../packages/adapters/src/agent/codex/schema-hashes.ts';
if(process.argv.includes('--version')){process.stdout.write('codex-cli 0.161.0\n');process.exit(0);}
if(process.argv.includes('generate-json-schema')){
 const out=process.argv[process.argv.indexOf('--out')+1];mkdirSync(join(out,'v2'),{recursive:true});
 for(const name of Object.keys(CODEX_SCHEMA_HASHES))writeFileSync(join(out,'v2',name+'.json'),readFileSync(fileURLToPath(new URL('../service-agent/schemas/v2/'+name+'.json',import.meta.url))));
 process.exit(0);
}
const base=JSON.parse(readFileSync(fileURLToPath(new URL('../service-agent/native-fixture.json',import.meta.url)),'utf8'));
const settings=()=>process.env.WB_RECOVERY_FIXTURE?JSON.parse(readFileSync(process.env.WB_RECOVERY_FIXTURE,'utf8')):{};
const trace=value=>{if(process.env.WB_RECOVERY_TRACE)appendFileSync(process.env.WB_RECOVERY_TRACE,JSON.stringify(value)+'\n',{mode:0o600});};
const copy=x=>JSON.parse(JSON.stringify(x));
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
let thread=randomUUID(),turn='',timer,progress;
trace({fixture_event:'spawn',pid:process.pid,ppid:process.ppid});
function terminal(status){const end=copy(base['turn/completed']);end.threadId=thread;end.turn.id=turn;end.turn.status=status;send({method:'turn/completed',params:end});}
const rl=createInterface({input:process.stdin});rl.on('line',line=>{
 const m=JSON.parse(line);trace(m);if(!m.id)return;const s=settings();
 if(m.method==='initialize'){send({id:m.id,result:{userAgent:'controlled original recovery fixture'}});return;}
 if(['account/read','account/rateLimits/read','model/list'].includes(m.method)){send({id:m.id,result:copy(base[m.method])});return;}
 if(m.method==='thread/read'){
  if(s.disconnectOnRead){process.exit(0);return;}
  if(s.readError){send({id:m.id,error:{code:-32000,message:'controlled read failure'}});return;}
  const value=s.thread??{...copy(base['thread/start'].thread),id:m.params.threadId,turns:[{...copy(base['turn/completed'].turn),id:turn,status:'inProgress',items:[]}]};
  setTimeout(()=>send({id:m.id,result:{thread:value}}),s.readDelay??0);return;
 }
 if(m.method==='thread/start'||m.method==='thread/resume'){
  thread=m.params.threadId??thread;const value=copy(base['thread/start']);value.thread.id=thread;send({id:m.id,result:value});return;
 }
 if(m.method==='turn/start'){
  turn=randomUUID();const value=copy(base['turn/start']);value.turn.id=turn;
  const started=copy(base['turn/started']);started.threadId=thread;started.turn.id=turn;send({method:'turn/started',params:started});send({id:m.id,result:value});
  if(s.progressInterval)progress=setInterval(()=>send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,itemId:'controlled-progress',delta:'controlled progress'}}),s.progressInterval);
  if(s.finalDelay!==undefined)timer=setTimeout(()=>{clearInterval(progress);const item=copy(base['item/completed']);item.threadId=thread;item.turnId=turn;item.item.text=JSON.stringify(s.output??{answer:'42'});send({method:'item/completed',params:item});terminal('completed');},s.finalDelay);
  return;
 }
 if(m.method==='turn/interrupt'){
  if(s.interruptError){send({id:m.id,error:{code:-32000,message:'controlled interrupt failure'}});return;}
  clearTimeout(timer);clearInterval(progress);send({id:m.id,result:{}});
  if(!s.ignoreInterrupt)terminal(s.interruptStatus??'interrupted');return;
 }
 send({id:m.id,result:{}});
});
rl.on('close',()=>{trace({fixture_event:'stdin_closed',pid:process.pid});clearTimeout(timer);clearInterval(progress);if(!settings().lingerOnEOF)process.exit(0);});
