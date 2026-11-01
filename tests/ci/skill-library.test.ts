import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CONTRACT_VERSION, CreateSkillDraftSchema, type RequestContext, type CreateSkillDraftRequest } from '../../packages/contracts/src/index.ts';
import { configureDatabase, migrateDatabase, sha256 } from '../../packages/storage/src/connection/index.ts';
import { SkillLibrary } from '../../packages/domain/src/skills/index.ts';
import { ContentGeneration } from '../../packages/domain/src/content-agents/index.ts';
import type { ApplicationContext } from '../../packages/domain/src/ports/index.ts';

function fixture(){
  const root=realpathSync(mkdtempSync(join(tmpdir(),'workbench-skill-library-'))),local=join(root,'skills'),vault=join(root,'vault');
  const paths={source_vault_root:vault,managed_notes_root:join(root,'notes'),state_root:join(root,'state'),media_root:join(root,'media')};
  for(const path of [local,vault,...Object.values(paths),join(vault,'10-sources'),join(vault,'00-home'),join(local,'personal-ip-writing','references'),join(local,'h3-digital-human')])mkdirSync(path,{recursive:true});
  const skill='---\nname: personal-ip-writing\ndescription: 当前本地写作规则\n---\n\n保留真实归属，参考[写法](references/style.md)。';
  writeFileSync(join(local,'personal-ip-writing','SKILL.md'),skill);writeFileSync(join(local,'personal-ip-writing','references/style.md'),'具体操作连接实际结果。');
  writeFileSync(join(local,'h3-digital-human','SKILL.md'),'---\nname: h3-digital-human\ndescription: H3 节点依赖\n---\n\n需要本人参考与通过音轨。');
  const positive='---\ntitle: 正向表达\nauthor: 对标作者\nstatus: captured\n---\n\n外部案例，只借鉴事情如何推进。',negative='---\ntitle: 待改骨架\nauthor: 本人\nstatus: candidate\n---\n\nAI 起草骨架，没有本人实测结果。';
  writeFileSync(join(vault,'10-sources','样本-positive.md'),positive);writeFileSync(join(vault,'00-home','样本-negative.md'),negative);
  const db=new DatabaseSync(':memory:');configureDatabase(db);migrateDatabase(db);const workspace=randomUUID(),identity={workspace_id:workspace,service_instance_id:randomUUID(),contract_version:CONTRACT_VERSION};
  db.prepare('INSERT INTO workspaces(id,workspace_id,title,timezone,paths,mode,version) VALUES (?,?,?,?,?,?,1)').run(workspace,workspace,'技能库测试','UTC',JSON.stringify(paths),'demo');
  const context:ApplicationContext={db,identity,paths,config:{...identity,title:'技能库测试',timezone:'UTC',mode:'demo',paths,listen:{host:'127.0.0.1',port:0}},getExecutorHealth:async()=>[]};
  const library=new SkillLibrary(context,{roots:[local]}),request=(key=randomUUID()):RequestContext=>({...identity,request_id:randomUUID(),idempotency_key:key,request_identity_ref:'internal_rule'});
  return {root,local,vault,db,context,library,request,positive,negative,close(){db.close();rmSync(root,{recursive:true,force:true});}};
}

test('本地技能按真实正文发现，视频节点保留依赖且不冒充可执行',()=>{
  const f=fixture();try{const found=f.library.get(f.request()),writing=found.skills.find(item=>item.name==='personal-ip-writing')!;assert.equal(writing.reference_count,1);assert.equal(writing.reuse_mode,'derive');assert.equal(writing.default_selected,false);assert.equal(found.video_nodes.find(item=>item.id==='script')!.default_skill,null);assert.match(writing.selection_reason,/尚未评估/);assert.equal(f.library.source(f.request(),writing.id).sha256,writing.sha256);assert.deepEqual(found.video_nodes.find(item=>item.id==='avatar')!.skills,['h3-digital-human']);assert.ok(found.video_nodes.every(item=>item.execution_status==='not_connected'));assert.throws(()=>f.library.get({...f.request(),workspace_id:randomUUID()}));}finally{f.close();}
});

test('正负样本保留归属、理由、正文与 hash；变化和视频规则拒绝错误提炼',async()=>{
  const f=fixture();try{
    const page=await f.library.samples(f.request(),'样本'),base=f.library.get(f.request()).skills.find(item=>item.name==='personal-ip-writing')!;
    assert.equal(page.items.length,2);const selections=page.items.map(item=>({id:item.id,sha256:item.sha256,polarity:(item.title==='正向表达'?'positive':'negative') as 'positive'|'negative',reason:item.title==='正向表达'?'借鉴操作与结果的衔接':'规避把 AI 骨架写成本人亲历'}));
    const body:CreateSkillDraftRequest={instruction:'补足事情推进',samples:'',purpose:'core',base_local_skill:{id:base.id,sha256:base.sha256},sample_selections:selections},frozen=await f.library.freeze(f.request(),body);
    const frozenBase=frozen.base_local_skill as {content:string;references:Array<{content:string;sha256:string}>};assert.ok(frozenBase.content.includes('保留真实归属'));assert.equal(frozenBase.references[0]!.sha256,sha256(frozenBase.references[0]!.content));
    const samples=frozen.samples as Array<{content:string;sha256:string;reason:string}>;assert.deepEqual(new Set(samples.map(item=>item.content)),new Set([f.positive,f.negative]));assert.ok(samples.every(item=>item.sha256===sha256(item.content)&&item.reason));
    const avatar=f.library.get(f.request()).skills.find(item=>item.name==='h3-digital-human')!;await assert.rejects(f.library.freeze(f.request(),{...body,base_local_skill:{id:avatar.id,sha256:avatar.sha256}}),{code:'CAPABILITY_UNVERIFIED'});
    writeFileSync(join(f.vault,'10-sources','样本-positive.md'),f.positive+'\n新内容');await assert.rejects(f.library.freeze(f.request(),body),{code:'INPUT_STALE'});
    writeFileSync(join(f.local,'personal-ip-writing','SKILL.md'),frozenBase.content+'\n规则变化');await assert.rejects(f.library.freeze(f.request(),{...body,sample_selections:undefined}),{code:'INPUT_STALE'});
  }finally{f.close();}
});

test('样本查询不读取符号链接及过大文件，未知身份拒绝；理由不能为空',async()=>{
  const f=fixture();try{writeFileSync(join(f.root,'outside.md'),'库外内容');symlinkSync(join(f.root,'outside.md'),join(f.vault,'10-sources','越界样本.md'));writeFileSync(join(f.vault,'10-sources','过大样本.md'),'x'.repeat(65537));const page=await f.library.samples(f.request(),'样本');assert.equal(page.items.length,2);await assert.rejects(f.library.freeze(f.request(),{instruction:'测试',samples:'',purpose:'core',sample_selections:[{id:sha256('未知'),sha256:sha256('未知'),polarity:'positive',reason:'借鉴'}]}),{code:'NOT_FOUND'});assert.throws(()=>CreateSkillDraftSchema.parse({instruction:'改进',samples:'',purpose:'core',sample_selections:[{id:sha256('a'),sha256:sha256('b'),polarity:'positive',reason:'  '}]}),{code:'VALIDATION_ERROR'});}finally{f.close();}
});

test('实际技能候选入队冻结来源，幂等重放不重新读取变化的源文件',async()=>{
  const f=fixture();try{const base=f.library.get(f.request()).skills.find(item=>item.name==='personal-ip-writing')!,page=await f.library.samples(f.request(),'样本'),selected=page.items.find(item=>item.title==='正向表达')!,input:CreateSkillDraftRequest={instruction:'改进事情推进',samples:'',purpose:'core',base_local_skill:{id:base.id,sha256:base.sha256},sample_selections:[{id:selected.id,sha256:selected.sha256,polarity:'positive',reason:'借鉴实际动作'}]},generation=new ContentGeneration(f.context,{skill_library:f.library}),request=f.request(),accepted=await generation.draftSkill(request,input);
    const job=f.db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id)!;assert.ok(String(job.input_manifest).includes('skill_derivation'));const manifest=JSON.parse(String(job.input_manifest));assert.equal(manifest.skill_derivation.samples[0].content,f.positive);assert.equal(manifest.writing_skills,undefined);assert.equal(f.db.prepare('SELECT head_revision_id FROM documents WHERE id=?').get(accepted.document_id!)!.head_revision_id,null);
    writeFileSync(join(f.local,'personal-ip-writing','SKILL.md'),'已变化');assert.deepEqual(await generation.draftSkill(request,input),accepted);assert.deepEqual(f.db.prepare('SELECT input_manifest FROM jobs WHERE id=?').get(accepted.job_id),job);
  }finally{f.close();}
});
