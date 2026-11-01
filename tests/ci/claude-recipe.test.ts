import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {attachClaudeRecipe} from '../../packages/adapters/src/agent/claude/skills.ts';
import {ClaudeAdapter} from '../../packages/adapters/src/agent/claude/index.ts';
import {hash} from '../../packages/adapters/src/agent/codex/primitives.ts';
const content=(name:string,body:string)=>'---\nname: '+name+'\ndescription: text-only test\nmetadata:\n  version: 0.1.0\n---\n'+body;
function manifest(body='First use facts.'){return {frozen:{content_purpose:'core',writing_skills:['first','second'].map((name,i)=>{const c=content(name,i?'Then revise.':body);return {name,version:'0.1.0',content:c,sha256:hash(c)};})}};}
test('Claude 原生配方按冻结顺序编译、hash 不变，忽略工具权限前言，禁止动态命令和替换',()=>{
 const root=mkdtempSync(join(process.cwd(),'.ci-artifacts/claude-recipe-'));try{
 const m=manifest(),r=attachClaudeRecipe(m,root)!;assert.equal(r.command,'/workbench-content:workbench-route');const c=readFileSync(join(r.plugin_dir,'skills/workbench-route/SKILL.md'),'utf8');assert.ok(c.indexOf('First use facts.')<c.indexOf('Then revise.'));assert.equal(hash(c),r.compiled_sha256);assert.deepEqual(r.skills.map(s=>s.sha256),m.frozen.writing_skills.map(s=>s.sha256));assert.deepEqual(attachClaudeRecipe(m,root),r);
 assert.throws(()=>attachClaudeRecipe(manifest('!`touch should-not-run`'),root),{code:'CAPABILITY_UNSUPPORTED'});assert.throws(()=>attachClaudeRecipe(manifest('$ARGUMENTS'),root),{code:'CAPABILITY_UNSUPPORTED'});
 const path=join(r.plugin_dir,'skills/workbench-route/SKILL.md');chmodSync(path,0o600);writeFileSync(path,'changed');assert.throws(()=>attachClaudeRecipe(m,root),{code:'INPUT_STALE'});
 }finally{rmSync(root,{recursive:true,force:true});}
});
test('Claude 适配器使用原生 slash recipe 和 plugin-dir，不把 Skill 仅当普通提示词',async()=>{
 const root=mkdtempSync(join(process.cwd(),'.ci-artifacts/claude-recipe-')),trace:any[]=[];const a=new ClaudeAdapter({workspace_id:randomUUID(),cwd:root,lock_root:join(root,'locks'),executable:join(process.cwd(),'tests/service-agent/fake-claude.mjs'),timeout_ms:3000,sink:entry=>trace.push(entry)});
 try{const h=await a.start({job_id:randomUUID(),kind:'document_modify',task_instruction:'Return 42',target_document_id:null,base_revision_id:null,input_manifest:manifest(),allowed_tools:[],output_schema:{type:'object',required:['answer'],additionalProperties:false,properties:{answer:{type:'string'}}}});for await(const _ of a.streamEvents(h)){};const r=h.checkpoint.skill_execution as any;assert.equal(r.mode,'claude_native_recipe');assert.equal(r.skills.length,2);assert.equal(h.checkpoint.billing_route,'claude_subscription');const args=trace.find(e=>e.direction==='spawn').message.args;assert.ok(args[1].startsWith('/workbench-content:workbench-route '));assert.ok(!args[1].includes('First use facts.'));assert.ok(!args[1].includes('Then revise.'));assert.ok(args.includes('--plugin-dir'));assert.ok(!args.includes('--safe-mode'));assert.equal(args[args.indexOf('--tools')+1],'');}
 finally{await a.close();rmSync(root,{recursive:true,force:true});}
});
