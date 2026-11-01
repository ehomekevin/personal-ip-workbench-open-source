#!/usr/bin/env node
import { readFileSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_SCHEMA_HASHES } from '../../packages/adapters/src/agent/codex/schema-hashes.ts';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
if (process.argv.includes('--version')) { process.stdout.write('codex-cli 0.161.0\n'); process.exit(0); }
if (process.argv.includes('generate-json-schema')) {
 const output=process.argv[process.argv.indexOf('--out')+1];mkdirSync(join(output,'v2'),{recursive:true});
 for(const name of Object.keys(CODEX_SCHEMA_HASHES))writeFileSync(join(output,'v2',name+'.json'),readFileSync(fileURLToPath(new URL('./schemas/v2/'+name+'.json',import.meta.url))));
 if(process.env.WP15_SCHEMA_BAD==='1')writeFileSync(join(output,'v2','ThreadStartParams.json'),'{}');
 if(process.env.WP15_SCHEMA_TRACE)appendFileSync(process.env.WP15_SCHEMA_TRACE,'generate\n');
 process.exit(0);
}
const f = JSON.parse(readFileSync(fileURLToPath(new URL('./native-fixture.json', import.meta.url)), 'utf8'));
const mode = process.env.WP15_FAKE_MODE ?? 'success'; let thread = randomUUID(), turn = '', timer, resumed=false; const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const clone = value => JSON.parse(JSON.stringify(value));
createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line); if (process.env.WP15_FAKE_TRACE) appendFileSync(process.env.WP15_FAKE_TRACE, line+'\n'); if (!m.id) return;
 if (m.method === 'initialize') { send({ id: m.id, result: { userAgent: 'internal_rule fixture' } }); return; }
 if (m.method === 'account/read' || m.method === 'model/list' || m.method === 'account/rateLimits/read') { const value = clone(f[m.method]); if (m.method === 'account/rateLimits/read' && mode === 'quota') value.ordinaryUsageAllowed = false; send({ id: m.id, result: value }); return; }
 if(m.method==='thread/read'){
   const thread=process.env.WP15_FAKE_THREAD_FILE?JSON.parse(readFileSync(process.env.WP15_FAKE_THREAD_FILE,'utf8')):{...clone(f['thread/start'].thread),id:m.params.threadId,turns:[]};
   const readMode=process.env.WP15_FAKE_THREAD_MODE;
   if(readMode==='absent'){send({id:m.id,error:{message:'thread not found fixture'}});return;}
   if(readMode==='mismatch')thread.id='another-session';
   if(readMode==='turn_mismatch'&&thread.turns[0])thread.turns[0].id='another-turn';
   if(readMode==='unfinished'&&thread.turns[0])thread.turns[0].status='inProgress';
   setTimeout(()=>send({id:m.id,result:{thread}}),Number(process.env.WP15_FAKE_READ_DELAY??0));return;
 }
 if (m.method === 'thread/start' || m.method === 'thread/resume') { resumed=m.method==='thread/resume';if (m.params.threadId) thread = m.params.threadId; const value = clone(f['thread/start']); value.thread.id = thread; if (mode === 'wrong_provider') value.modelProvider = 'custom-paid-provider'; send({ id: m.id, result: value }); return; }
 if (m.method === 'turn/start') { if(resumed&&mode==='malformed_resume'){process.stdout.write('{malformed native response\n');return;}turn = randomUUID(); const value = clone(f['turn/start']); value.turn.id = turn; const started = clone(f['turn/started']); started.threadId = thread; started.turn.id = turn; send({ method: 'turn/started', params: started }); send({ id: m.id, result: value });
   if(mode==='progress')setTimeout(()=>send({method:'item/agentMessage/delta',params:{threadId:thread,turnId:turn,itemId:'progress',delta:'still working'}}),80);
   timer = setTimeout(() => { const item = clone(f['item/completed']); item.threadId = thread; item.turnId = turn; item.item.text = mode === 'schema' ? '{"wrong":1}' : '{"answer":"42"}'; send({ method: 'item/completed', params: item }); const usage = clone(f['thread/tokenUsage/updated']); usage.threadId = thread; usage.turnId = turn; send({ method: 'thread/tokenUsage/updated', params: usage }); send({ method: 'thread/tokenUsage/updated', params: usage }); const end = clone(f['turn/completed']); end.threadId = thread; end.turn.id = turn; end.turn.status = 'completed'; send({ method: 'turn/completed', params: end }); }, ['slow','progress'].includes(mode) ? 5000 : 50); return;
 }
 if (m.method === 'turn/interrupt') { clearTimeout(timer); send({ id: m.id, result: {} }); const end = clone(f['turn/completed']); end.threadId = thread; end.turn.id = turn; end.turn.status = 'interrupted'; send({ method: 'turn/completed', params: end }); return; }
 send({ id: m.id, result: {} });
});
