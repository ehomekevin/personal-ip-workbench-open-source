import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentRunInput, JobDetailResponse, JsonObject } from '../../packages/contracts/src/index.ts';
import { CodexAdapter } from '../../packages/adapters/src/agent/codex/index.ts';
import { ClaudeAdapter } from '../../packages/adapters/src/agent/claude/index.ts';
import { attachWritingSkill, readWritingSkill } from '../../packages/adapters/src/agent/skills.ts';
import { canonical, hash } from '../../packages/adapters/src/agent/codex/primitives.ts';
import { freezeCoreWritingSkill } from '../../packages/domain/src/content-agents/skill.ts';
import { writingSkillLabel } from '../../apps/web/src/features/create/ai-actions/index.ts';
import { defaultSkillCatalog } from '../../packages/domain/src/skills/index.ts';
import { projectRoot, schemaDirectory } from './harness.ts';

function fixedInput(): AgentRunInput { return { job_id: randomUUID(), kind: 'document_modify', task_instruction: 'Return 42', target_document_id: null, base_revision_id: null, input_manifest: { frozen: { content_purpose: 'core', writing_skill: freezeCoreWritingSkill() } }, allowed_tools: [], output_schema: { type: 'object', required: ['answer'], additionalProperties: false, properties: { answer: { type: 'string' } } } }; }
function nativeFixture() { const root = mkdtempSync(join(projectRoot, 'tests/service-agent/.writing-skill-')); mkdirSync(join(root, 'locks')); return { root, options: { workspace_id: randomUUID(), cwd: root, lock_root: join(root, 'locks'), schema_directory: schemaDirectory, executable: join(projectRoot, 'tests/service-agent/fake-codex.mjs'), timeout_ms: 3000 }, cleanup() { rmSync(root, { recursive: true, force: true }); } }; }
function completedThread(root:string,handle:Awaited<ReturnType<CodexAdapter['start']>>) { const native=JSON.parse(readFileSync(join(projectRoot,'tests/service-agent/native-fixture.json'),'utf8')),path=join(root,'completed-thread.json');writeFileSync(path,JSON.stringify({...native['thread/start'].thread,id:handle.runtime_session_id,turns:[{...native['turn/completed'].turn,id:handle.runtime_turn_id}]}));process.env.WP15_FAKE_THREAD_FILE=path; }
async function finish(adapter: Pick<CodexAdapter,'streamEvents'>, handle: Awaited<ReturnType<CodexAdapter['start']>>) { for await (const _ of adapter.streamEvents(handle)) { /* drain the native fixture */ } }

test('原生 turn 显式附带固定 skill；恢复沿用旧正文，损坏快照拒绝启动', async () => {
  const f = nativeFixture(), trace = join(f.root, 'native.jsonl'), adapter = new CodexAdapter(f.options); process.env.WP15_FAKE_TRACE = trace;
  try {
    const input = fixedInput(), handle = await adapter.start(input); await finish(adapter, handle); await adapter.close();
    const messages = readFileSync(trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)), turn = messages.find(m => m.method === 'turn/start'), skill = turn.params.input.find((i: JsonObject) => i.type === 'skill');
    assert.equal(skill.name, 'workbench-core-writing'); assert.equal(hash(readFileSync(skill.path)), (readWritingSkill(input.input_manifest)!).sha256);
    assert.equal(handle.checkpoint.input_hash, hash(canonical(input.input_manifest))); assert.equal((handle.checkpoint.writing_skill as JsonObject).invocation, 'codex_native_skill_input');
    completedThread(f.root,handle);const resumed = new CodexAdapter(f.options); try { const next = await resumed.resume(JSON.parse(JSON.stringify(handle)), {}); await finish(resumed, next); assert.equal(next.runtime_session_id, handle.runtime_session_id); assert.equal(next.runtime_turn_id, handle.runtime_turn_id); assert.deepEqual(next.checkpoint.writing_skill, handle.checkpoint.writing_skill);assert.equal(readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(message=>message.method==='turn/start').length,1); } finally { await resumed.close(); }
    const detail = { checkpoint: { agent_handle: handle as unknown as JsonObject } } as unknown as JobDetailResponse; assert.equal(writingSkillLabel(detail), 'workbench-core-writing · v1.1.0');
    chmodSync(skill.path, 0o644); writeFileSync(skill.path, 'tampered'); const before = readFileSync(trace, 'utf8'); await assert.rejects(adapter.resume(JSON.parse(JSON.stringify(handle)), {}), { code: 'INPUT_STALE' }); assert.equal(readFileSync(trace, 'utf8'), before);
  } finally { await adapter.close(); delete process.env.WP15_FAKE_TRACE;delete process.env.WP15_FAKE_THREAD_FILE; f.cleanup(); }
});
test('篡改技能正文、身份和目录链接被拒绝；不存在的绑定不创建技能', () => {
  const f = nativeFixture(); try {
    const manifest = fixedInput().input_manifest; const frozen = manifest.frozen as JsonObject; const binding = frozen.writing_skill as JsonObject;
    binding.content = String(binding.content) + '\nchanged'; assert.throws(() => readWritingSkill(manifest), { code: 'INPUT_STALE' });
    frozen.writing_skill = { ...freezeCoreWritingSkill(), name: '../untrusted' }; assert.throws(() => attachWritingSkill(manifest, f.root), { code: 'INPUT_STALE' });
    frozen.writing_skill = freezeCoreWritingSkill(); const other = join(f.root, 'other'); mkdirSync(other); symlinkSync(other, join(f.root, '.agents')); assert.throws(() => attachWritingSkill(manifest, f.root), { code: 'INPUT_STALE' });
    assert.equal(attachWritingSkill({ frozen: { content_purpose: 'core' } }, f.root), undefined); assert.equal(writingSkillLabel({ checkpoint: {} } as JobDetailResponse), undefined);
  } finally { f.cleanup(); }
});
test('Claude 使用冻结 Skill 的原生配方入口，仍保持订阅与无工具范围', async () => {
  const f = nativeFixture(), adapter = new ClaudeAdapter({ ...f.options, executable: join(projectRoot, 'tests/service-agent/fake-claude.mjs') }); try { const h=await adapter.start(fixedInput());await finish(adapter,h);assert.equal((h.checkpoint.skill_execution as JsonObject).mode,'claude_native_recipe');assert.equal(h.checkpoint.billing_route,'claude_subscription'); } finally { await adapter.close(); f.cleanup(); }
});
test('组合逐个传入原生 skill，顺序固定；恢复使用原组合并拒绝损坏的第二份快照',async()=>{
  const f=nativeFixture(),trace=join(f.root,'combination.jsonl'),adapter=new CodexAdapter(f.options);process.env.WP15_FAKE_TRACE=trace;
  try{const input=fixedInput(),frozen=input.input_manifest.frozen as JsonObject;delete frozen.writing_skill;frozen.writing_skills=defaultSkillCatalog().skills.slice(0,2).map(skill=>({name:skill.name,version:skill.version,content:skill.content,sha256:hash(skill.content)}));const handle=await adapter.start(input);await finish(adapter,handle);await adapter.close();
    const turn=readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).find(message=>message.method==='turn/start'),skills=turn.params.input.filter((item:JsonObject)=>item.type==='skill');assert.deepEqual(skills.map((skill:{name:string})=>skill.name),['workbench-core-writing','workbench-reader-polish']);assert.equal((handle.checkpoint.writing_skills as unknown[]).length,2);assert.ok(writingSkillLabel({checkpoint:{agent_handle:handle}} as unknown as JobDetailResponse)?.includes(' → '));
    completedThread(f.root,handle);const resumed=new CodexAdapter(f.options);try{const next=await resumed.resume(JSON.parse(JSON.stringify(handle)),{});await finish(resumed,next);assert.deepEqual(next.checkpoint.writing_skills,handle.checkpoint.writing_skills);assert.equal(next.runtime_turn_id,handle.runtime_turn_id);assert.equal(readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line)).filter(message=>message.method==='turn/start').length,1);}finally{await resumed.close();}
    chmodSync(skills[1].path,0o644);writeFileSync(skills[1].path,'broken second skill');const before=readFileSync(trace,'utf8');await assert.rejects(adapter.resume(JSON.parse(JSON.stringify(handle)),{}),{code:'INPUT_STALE'});assert.equal(readFileSync(trace,'utf8'),before);
    const claude=new ClaudeAdapter({...f.options,executable:join(projectRoot,'tests/service-agent/fake-claude.mjs')});try{const h=await claude.start(input);await finish(claude,h);assert.deepEqual(((h.checkpoint.skill_execution as JsonObject).skills as JsonObject[]).map(s=>s.name),['workbench-core-writing','workbench-reader-polish']);}finally{await claude.close();}
  }finally{await adapter.close();delete process.env.WP15_FAKE_TRACE;delete process.env.WP15_FAKE_THREAD_FILE;f.cleanup();}
});
test('新完整稿执行冻结档位与时间；恢复先读同一turn结果，未知状态不会重发',async()=>{
 const f=nativeFixture(),trace=join(f.root,'recovery.jsonl'),record=join(f.root,'native-thread.json'),adapter=new CodexAdapter(f.options);process.env.WP15_FAKE_TRACE=trace;
 try{const input=fixedInput(),frozen=input.input_manifest.frozen as JsonObject;frozen.service_agent={execution_policy:{model:'gpt-6.1-sol',reasoning_effort:'high',idle_timeout_ms:180000,max_duration_ms:900000}};const handle=await adapter.start(input);await finish(adapter,handle);await adapter.close();const calls=()=>readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(calls().find(m=>m.method==='turn/start').params.effort,'high');assert.equal((handle.checkpoint.execution_policy as JsonObject).max_duration_ms,900000);
  const fixture=JSON.parse(readFileSync(join(projectRoot,'tests/service-agent/native-fixture.json'),'utf8')),thread={...fixture['thread/start'].thread,id:handle.runtime_session_id,turns:[{...fixture['turn/completed'].turn,id:handle.runtime_turn_id}]};writeFileSync(record,JSON.stringify(thread));process.env.WP15_FAKE_THREAD_FILE=record;
  const recovered=new CodexAdapter(f.options);try{const next=await recovered.resume(JSON.parse(JSON.stringify(handle)),{});await finish(recovered,next);assert.equal(next.runtime_turn_id,handle.runtime_turn_id);assert.equal(calls().filter(m=>m.method==='turn/start').length,1);}finally{await recovered.close();}
  thread.turns[0].status='inProgress';writeFileSync(record,JSON.stringify(thread));const unknown=new CodexAdapter(f.options);try{await assert.rejects(unknown.resume(JSON.parse(JSON.stringify(handle)),{}),{code:'RESULT_UNKNOWN'});assert.equal(calls().filter(m=>m.method==='turn/start').length,1);}finally{await unknown.close();}
 }finally{await adapter.close();delete process.env.WP15_FAKE_TRACE;delete process.env.WP15_FAKE_THREAD_FILE;f.cleanup();}
});
test('已确认中断才发恢复turn；核对期间的新进展不会被旧idle deadline终止',async()=>{
 const f=nativeFixture(),trace=join(f.root,'deadline.jsonl'),record=join(f.root,'deadline-thread.json'),adapter=new CodexAdapter(f.options);process.env.WP15_FAKE_TRACE=trace;process.env.WP15_FAKE_MODE='progress';process.env.WP15_FAKE_THREAD_FILE=record;process.env.WP15_FAKE_READ_DELAY='150';
 try{const input=fixedInput(),frozen=input.input_manifest.frozen as JsonObject;frozen.service_agent={execution_policy:{model:'gpt-6.1-sol',reasoning_effort:'high',idle_timeout_ms:180000,max_duration_ms:900000}};const handle=await adapter.start(input);const fixture=JSON.parse(readFileSync(join(projectRoot,'tests/service-agent/native-fixture.json'),'utf8')),thread={...fixture['thread/start'].thread,id:handle.runtime_session_id,turns:[{...fixture['turn/completed'].turn,id:handle.runtime_turn_id,status:'inProgress'}]};writeFileSync(record,JSON.stringify(thread));process.env.WP15_FAKE_THREAD_FILE=record;process.env.WP15_FAKE_READ_DELAY='150';
  const internals=adapter as any,run=internals.runs.get(handle.runtime_turn_id);await internals.observeDeadline(run,'idle');assert.equal(run.terminal,false);assert.ok(run.progressGeneration>1);await adapter.cancel(handle);await assert.rejects(finish(adapter,handle),{code:'HOST_INTERRUPTED'});await adapter.close();
  thread.turns[0].status='interrupted';writeFileSync(record,JSON.stringify(thread));delete process.env.WP15_FAKE_MODE;delete process.env.WP15_FAKE_READ_DELAY;const resumed=new CodexAdapter(f.options);try{const next=await resumed.resume(JSON.parse(JSON.stringify(handle)),{});await finish(resumed,next);assert.equal(next.runtime_session_id,handle.runtime_session_id);assert.notEqual(next.runtime_turn_id,handle.runtime_turn_id);const calls=readFileSync(trace,'utf8').trim().split('\n').map(l=>JSON.parse(l));assert.equal(calls.filter(m=>m.method==='turn/start').length,2);}finally{await resumed.close();}
 }finally{await adapter.close();delete process.env.WP15_FAKE_TRACE;delete process.env.WP15_FAKE_MODE;delete process.env.WP15_FAKE_THREAD_FILE;delete process.env.WP15_FAKE_READ_DELAY;f.cleanup();}
});
test('最长时间在idle核对期间到达也不会丢失；硬截止准确中断同一turn',async()=>{
 const f=nativeFixture(),trace=join(f.root,'hard-deadline.jsonl'),record=join(f.root,'hard-thread.json'),adapter=new CodexAdapter(f.options);process.env.WP15_FAKE_TRACE=trace;process.env.WP15_FAKE_MODE='progress';process.env.WP15_FAKE_THREAD_FILE=record;process.env.WP15_FAKE_READ_DELAY='150';
 try{const input=fixedInput(),frozen=input.input_manifest.frozen as JsonObject;frozen.service_agent={execution_policy:{model:'gpt-6.1-sol',reasoning_effort:'high',idle_timeout_ms:180000,max_duration_ms:900000}};const handle=await adapter.start(input),fixture=JSON.parse(readFileSync(join(projectRoot,'tests/service-agent/native-fixture.json'),'utf8'));writeFileSync(record,JSON.stringify({...fixture['thread/start'].thread,id:handle.runtime_session_id,turns:[{...fixture['turn/completed'].turn,id:handle.runtime_turn_id,status:'inProgress'}]}));
  const internals=adapter as any,run=internals.runs.get(handle.runtime_turn_id),observing=internals.observeDeadline(run,'idle');await internals.observeDeadline(run,'duration');await observing;assert.ok(run.progressGeneration>1);assert.equal(run.terminal,true);await assert.rejects(finish(adapter,handle),(error:any)=>error.code==='HOST_INTERRUPTED'&&error.details.observation==='duration'&&error.details.no_new_turn_started===true);await adapter.close();
  const calls=readFileSync(trace,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(calls.filter(m=>m.method==='turn/start').length,1);assert.equal(calls.filter(m=>m.method==='turn/interrupt').length,1);assert.ok([1,2].includes(calls.filter(m=>m.method==='thread/read').length)); // 中断终态先到时不再读；否则仅再核一次。
 }finally{await adapter.close();delete process.env.WP15_FAKE_TRACE;delete process.env.WP15_FAKE_MODE;delete process.env.WP15_FAKE_THREAD_FILE;delete process.env.WP15_FAKE_READ_DELAY;f.cleanup();}
});
