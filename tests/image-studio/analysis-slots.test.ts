import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {readdirSync} from 'node:fs';
import {fixture,projectRoot,schemaDirectory} from '../service-agent/harness.ts';
import {CodexAdapter} from '../../packages/adapters/src/agent/codex/index.ts';
import {poolAdmission} from '../../apps/service/src/bootstrap/execution.ts';
import {studioAnalysisAdapter} from '../../apps/service/src/routes/image-studio.ts';
import type {AgentRunInput,JobsRow} from '../../packages/contracts/src/index.ts';
// 公众号配图的文本分析与写作生成共用一个执行器槽位池：同一锁目录、同一 max_concurrent_generations、同一诊断 sink。
test('studio text analysis adapter occupies the shared generation slot pool under max_concurrent_generations',async()=>{
 const f=fixture(),context={...f.context,config:{...f.context.config,max_concurrent_generations:1}},original=process.env.WP15_FAKE_MODE;
 const wired=studioAnalysisAdapter(context) as unknown as CodexAdapter,locks=join(context.paths.state_root,'executor-locks');
 assert.equal(wired.options.concurrency_slots,1,'按服务配置的全局并发上限，而非默认 5');assert.equal(wired.options.lock_root,locks,'与执行调度共用锁目录');assert.equal(typeof wired.options.sink,'function','接上诊断 sink');
 // 用同一组生产选项替换为本地 fake 执行器，证明分析在途时占满唯一槽位，写作任务不能再被领取。
 const a=new CodexAdapter({...wired.options,cwd:f.staging,schema_directory:schemaDirectory,executable:join(projectRoot,'tests/service-agent/fake-codex.mjs')});
 const input:AgentRunInput={job_id:randomUUID(),kind:'image_studio_brief',target_document_id:null,base_revision_id:null,task_instruction:'fixture analysis',input_manifest:{schema_version:'image-studio-brief-run/1',fixed_input_hash:'sha256:fixture',source:'fixture'},allowed_tools:[],output_schema:{type:'object',required:['answer'],additionalProperties:false,properties:{answer:{type:'string'}}}};
 const writing={id:randomUUID(),execution_mode:'service_adapter',executor_id:'codex',input_manifest:'{}'} as unknown as JobsRow;
 try{process.env.WP15_FAKE_MODE='slow';assert.equal(poolAdmission(locks,context.identity.workspace_id,1)(writing),true,'分析开始前槽位空闲');
  const handle=await a.start(input);assert.ok(handle.runtime_session_id);assert.equal(readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,1,'分析持有一个槽位');
  assert.equal(poolAdmission(locks,context.identity.workspace_id,1)(writing),false,'槽位被分析占用时写作任务不领取');
  await a.cancel(handle).catch(()=>{});await a.close();assert.equal(readdirSync(locks).filter(name=>/\.slot-\d\.lock$/.test(name)).length,0,'关闭后释放槽位');assert.equal(poolAdmission(locks,context.identity.workspace_id,1)(writing),true);
 }finally{if(original===undefined)delete process.env.WP15_FAKE_MODE;else process.env.WP15_FAKE_MODE=original;await a.close();await wired.close();f.cleanup();}
});
