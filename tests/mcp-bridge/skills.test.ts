import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { JsonObject, SkillSettingsResponse } from '../../packages/contracts/src/index.ts';
import { createMcpHostBridge, resolveWorkbenchRoute, routeRequest, WORKBENCH_TOOL_ROUTES } from '../../packages/host-bridge/src/core/index.ts';
import { defaultSkillCatalog } from '../../packages/domain/src/skills/index.ts';
import { fixture, call } from './harness.ts';

test('技能工具与文字生成的临时配方保持原 schema、顺序和幂等键',()=>{
  for(const [method,path,body,name]of [
    ['GET','/api/v1/settings/skills/library',undefined,'get_skill_library'],
    ['GET','/api/v1/settings/skills/library/local-id',undefined,'get_local_skill'],
    ['GET','/api/v1/settings/skills/samples?query=%E6%96%87%E9%A3%8E',undefined,'find_skill_samples'],
    ['GET','/api/v1/settings/skills',undefined,'get_skill_settings'],
    ['PUT','/api/v1/settings/skills',{expected_version:1,...defaultSkillCatalog()},'put_skill_settings'],
    ['POST','/api/v1/settings/skills/drafts',{instruction:'业务观点',samples:'',purpose:'core'},'create_skill_draft'],
    ['POST','/api/v1/documents/d/ai-edits',{base_revision_id:null,source_ids:[],executor:'codex',instruction:'成稿',skill_route:{settings_version:2,skills:['workbench-core-writing','workbench-reader-polish']}},'service_modify_document'],
  ]as const){const mapped=resolveWorkbenchRoute(method,path,body,{idempotencyKey:'skills-fixed'});assert.equal(mapped.name,name);const request=routeRequest(WORKBENCH_TOOL_ROUTES.find(item=>item.name===name)!,mapped.input);assert.deepEqual(request.body,body);if(method!=='GET')assert.equal(request.idempotencyKey,'skills-fixed');}
});

test('实际 MCP 入口共享技能版本、重放和冲突，UI bridge 接受 skills 子页的返回定位',async()=>{
  const f=await fixture();try{
    const a=await f.connect({web_url:'http://127.0.0.1:9999/'}),b=await f.connect();
    const library=await call(a,'get_skill_library');assert.equal(library.result.isError,undefined);assert.deepEqual((library.data.identity as JsonObject).workspace_id,f.app.identity.workspace_id);
    const locals=library.data.skills as JsonObject[];if(locals.length){const detail=await call(a,'get_local_skill',{id:locals[0]!.id});assert.equal(detail.data.sha256,locals[0]!.sha256);assert.equal(typeof detail.data.content,'string');}
    assert.equal((await call(a,'find_skill_samples',{query:'样本'})).error?.code,'CAPABILITY_UNVERIFIED');
    const initial=(await call(a,'get_skill_settings')).data as unknown as SkillSettingsResponse;
    const input={expected_version:initial.version,skills:initial.skills,recipes:initial.recipes,defaults:{...initial.defaults,'core:news':'core-reader'},idempotency_key:'skills-mcp-save'} as unknown as JsonObject;
    const saved=await call(a,'put_skill_settings',input);assert.equal(saved.result.isError,undefined);assert.deepEqual((await call(b,'put_skill_settings',input)).data,saved.data);
    assert.equal((await call(b,'put_skill_settings',{...input,idempotency_key:'skills-mcp-conflict'})).error?.code,'VERSION_CONFLICT');
    const app={callServerTool:async(input:{name:string;arguments:JsonObject})=>a.client.callTool(input),getHostContext:()=>undefined,getHostCapabilities:()=>({})} as unknown as App;
    const bridge=await createMcpHostBridge({app,expectedIdentity:f.app.identity,hostSurface:'codex_desktop',connectionMode:'local_stdio'});
    assert.deepEqual((await bridge.openWorkbench({page:'settings',settings_view:'skills'})).location,{page:'settings',settings_view:'skills'});
    const opened=await call(a,'open_workbench',{page:'settings',settings_view:'skills'});assert.equal(opened.data.standalone_url,'http://127.0.0.1:9999/?mode=real#settings/skills');
    await f.restart();assert.deepEqual((await call(b,'get_skill_settings')).data,saved.data);
  }finally{await f.cleanup();}
});
