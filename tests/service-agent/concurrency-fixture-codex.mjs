#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
if (process.argv.includes('--version') || process.argv.includes('generate-json-schema')) { await import('./fake-codex.mjs'); }
else {
 const template = JSON.parse(readFileSync(new URL('./native-fixture.json', import.meta.url), 'utf8'));
 const clone = value => structuredClone(value), send = value => process.stdout.write(JSON.stringify(value)+'\n');
 let thread = randomUUID(), turn = '', control, frozen, timer;
 function fact(status) { if (control) writeFileSync(join(control.root, thread+'.json'), JSON.stringify({ ...clone(template['thread/start'].thread), id:thread, turns:[{...clone(template['turn/completed'].turn),id:turn,status,items:status==='completed'?[{...clone(template['item/completed'].item),text:JSON.stringify(output())}]:[]}] })); }
 function output() { return { documents:frozen.targets.map(target => ({document_id:target.document_id,text:'候选 '+control.label})),recommendations:[] }; }
 function finish(status='completed') { clearInterval(timer); if(status==='completed') { const item=clone(template['item/completed']);item.threadId=thread;item.turnId=turn;item.item.text=JSON.stringify(output());send({method:'item/completed',params:item}); }
   fact(status); const end=clone(template['turn/completed']);end.threadId=thread;end.turn.id=turn;end.turn.status=status;
   if(status==='failed') end.turn.error={message:'quota exceeded fixture',codexErrorInfo:null,additionalDetails:null};
   send({method:'turn/completed',params:end}); }
 createInterface({input:process.stdin}).on('line',line=>{
   const message=JSON.parse(line); if(!message.id)return;
   if(message.method==='initialize')return send({id:message.id,result:{userAgent:'C05 controlled fixture'}});
   if(['account/read','model/list','account/rateLimits/read'].includes(message.method))return send({id:message.id,result:clone(template[message.method])});
   if(message.method==='thread/read') { const path=join(process.cwd(),'control',message.params.threadId+'.json');return send({id:message.id,result:{thread:existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{...clone(template['thread/start'].thread),id:message.params.threadId,turns:[]}}}); }
   if(['thread/start','thread/resume'].includes(message.method)) {thread=message.params.threadId??thread;const value=clone(template['thread/start']);value.thread.id=thread;return send({id:message.id,result:value});}
   if(message.method==='turn/start') { const input=JSON.parse(message.params.input[0].text);control=JSON.parse(input.task_instruction);frozen=input.input_manifest.frozen;turn=randomUUID();
     writeFileSync(join(control.root,control.label+'.started'),JSON.stringify({at:Date.now(),pid:process.pid,thread,turn,executor:'codex'}));fact('inProgress');
     const started=clone(template['turn/started']);started.threadId=thread;started.turn.id=turn;send({method:'turn/started',params:started});const value=clone(template['turn/start']);value.turn.id=turn;send({id:message.id,result:value});
     timer=setInterval(()=>{if(existsSync(join(control.root,control.label+'.release'))){if(control.mode==='unknown'){clearInterval(timer);process.exit(0);}finish(control.mode==='quota'?'failed':'completed');}},10);return;
   }
   if(message.method==='turn/interrupt'){send({id:message.id,result:{}});finish('interrupted');return;}
   send({id:message.id,result:{}});
 });
 process.stdin.on('end',()=>{clearInterval(timer);process.exit(0);});
}
