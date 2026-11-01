import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {App} from '@modelcontextprotocol/ext-apps';
import {DEFAULT_WRITING_EXECUTION,type JsonObject,type WritingRuleSnapshot} from '../../packages/contracts/src/index.ts';
import {resolveWorkbenchRoute,routeRequest,WORKBENCH_TOOL_ROUTES,createMcpHostBridge} from '../../packages/host-bridge/src/core/index.ts';
import {createHostClient} from '../../apps/web/src/transport/workbench-client.ts';
import {createTopicsModule} from '../../apps/service/src/routes/topics.ts';
import {createWritingFlowModule} from '../../apps/service/src/routes/writing-flow.ts';
import {createHostCapabilitiesModule} from '../../apps/service/src/routes/host-capabilities.ts';
import {WritingFlow} from '../../packages/domain/src/writing-flow/index.ts';
import {Topics} from '../../packages/domain/src/topics/index.ts';
import {Documents} from '../../packages/domain/src/documents/index.ts';
import {sha256} from '../../packages/storage/src/connection/index.ts';
import {fixture,call} from './harness.ts';

test('完整稿 UI 的 summary 查询能映射到明确 MCP 工具；未知和重复 query 仍拒绝',()=>{
 const path='/api/v1/topics/topic/writing-runs?summary=1',mapped=resolveWorkbenchRoute('GET',path,undefined);
 assert.deepEqual(mapped,{name:'list_writing_runs',input:{id:'topic',summary:'1'}});
 assert.deepEqual(routeRequest(WORKBENCH_TOOL_ROUTES.find(route=>route.name===mapped.name)!,mapped.input),{method:'GET',path});
 const viewpointRoute=resolveWorkbenchRoute('POST','/api/v1/topics/topic/viewpoints',{});assert.equal(viewpointRoute.name,'ensure_topic_viewpoints');assert.equal(viewpointRoute.input.id,'topic');assert.equal(typeof viewpointRoute.input.idempotency_key,'string');
 assert.throws(()=>resolveWorkbenchRoute('GET',path+'&summary=1',undefined),{code:'VALIDATION_ERROR'});
 assert.throws(()=>resolveWorkbenchRoute('GET',path+'&path=/arbitrary.md',undefined),{code:'VALIDATION_ERROR'});
});
test('真实 UI host client → MCP → HTTP 查询固定运行summary，完整详情仍能独立读取',async()=>{
 const f=await fixture([createWritingFlowModule,createHostCapabilitiesModule,createTopicsModule]);
 try{
  const context=f.app.context,request=()=>({...f.app.identity,request_id:randomUUID(),idempotency_key:randomUUID(),request_identity_ref:'writing-mcp-test'}),topic=await new Topics(context).create(request(),{title:'完整稿插件查询测试',category:'个人思考',audience:'本人',source_ids:[]}),text='本人原意和真实来源。'.repeat(100),saved=await new Documents(context).save(request(),topic.core_document_id,{expected_revision_id:null,text,origin:'human'}),skill='---\nname: personal-ip-writing\ndescription: 本人原意\n---\n只采用本人事实。',rules:WritingRuleSnapshot={id:'mcp-rules',created_at:'2026-10-13T00:00:00Z',files:[],skill:{name:'personal-ip-writing',version:'0.1.0',content:skill,sha256:sha256(skill)},scope:'本人'};
  const run=new WritingFlow(context,{rules:()=>rules}).start(request(),topic.id,{base_revision_id:saved.revision_id,source_ids:[],executor:'codex',instruction:'完整稿插件接口测试',rule_set:'personal-ip-writing',execution_policy:DEFAULT_WRITING_EXECUTION}),connection=await f.connect(),summary=await call(connection,'list_writing_runs',{id:topic.id,summary:'1'});
  const viewpoints=await call(connection,'ensure_topic_viewpoints',{id:topic.id,idempotency_key:randomUUID()});assert.equal(viewpoints.result.isError,undefined,JSON.stringify(viewpoints));assert.equal(viewpoints.data.save_state,'empty');assert.ok(viewpoints.data.document_id);
  assert.equal(summary.result.isError,undefined);const items=summary.data.items as JsonObject[];assert.equal(items.length,1);assert.equal(items[0]!.id,run.id);assert.ok(!('rule_snapshot' in items[0]!));
  const app={callServerTool:async(input:{name:string;arguments:JsonObject})=>connection.client.callTool(input),getHostContext:()=>undefined,getHostCapabilities:()=>({})} as unknown as App,bridge=await createMcpHostBridge({app,expectedIdentity:f.app.identity,hostSurface:'codex_desktop',connectionMode:'local_stdio'}),client=createHostClient(bridge,resolveWorkbenchRoute);
  const viaUi=await client.request<{items:JsonObject[]}>('GET','/api/v1/topics/'+topic.id+'/writing-runs?summary=1');assert.equal(viaUi.items[0]!.id,run.id);assert.ok(!('rule_snapshot' in viaUi.items[0]!));
  const detail=await client.request<{id:string;rule_snapshot:WritingRuleSnapshot;input_draft:string}>('GET','/api/v1/writing-runs/'+run.id);assert.equal(detail.id,run.id);assert.equal(detail.rule_snapshot.skill.sha256,rules.skill.sha256);assert.equal(detail.input_draft,text);
 }finally{await f.cleanup();}
});
