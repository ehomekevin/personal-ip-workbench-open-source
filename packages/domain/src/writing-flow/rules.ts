import {constants,lstatSync,openSync,closeSync,readFileSync,realpathSync} from 'node:fs';
import {defaultSkillCatalog} from '../skills/index.ts';import {join,relative,isAbsolute,sep} from 'node:path';
import {ContractError,parseSkillMarkdown,type JsonObject,type WritingRuleFile,type WritingRuleSnapshot,type WritingTarget} from '@workbench/contracts';import {sha256} from '@workbench/storage/connection';import type {ApplicationContext} from '../ports/index.ts';
export type {WritingRuleFile,WritingRuleSnapshot,WritingTarget} from '@workbench/contracts';
export function readPlainFile(path:string,max=262144):string {const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>max||realpathSync(path)!==path)throw new ContractError('STORAGE_UNAVAILABLE','写作规则或内容卡必须是可核对的普通文件');const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{return readFileSync(fd,'utf8');}finally{closeSync(fd);}}
export function vaultRoot(context:ApplicationContext):string {const root=context.paths.source_vault_root;if(!root)throw new ContractError('STORAGE_UNAVAILABLE','先配置本人 Obsidian 源库');return realpathSync(root);}
export function vaultFile(context:ApplicationContext,path:string):string {const root=vaultRoot(context),actual=join(root,path),rel=relative(root,actual);if(!path.endsWith('.md')||isAbsolute(path)||rel.startsWith('..'+sep)||rel==='..'||realpathSync(actual)!==actual)throw new ContractError('VALIDATION_ERROR','内容卡不在已配置的本人源库内');return actual;}
export function registeredTargets(context:ApplicationContext):WritingTarget[]{try{const value=JSON.parse(readPlainFile(join(context.paths.state_root,'writing-flow-targets.json')));if(value.workspace_id!==context.identity.workspace_id||!Array.isArray(value.targets)||value.targets.some((t:WritingTarget)=>typeof t.id!=='string'||typeof t.topic_id!=='string'||typeof t.document_id!=='string'||typeof t.relative_path!=='string'))throw new Error();return value.targets;}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return [];throw new ContractError('STORAGE_UNAVAILABLE','受控回写目标登记不可读');}}
export function freezeWritingRules(context:ApplicationContext,target?:WritingTarget):WritingRuleSnapshot {
 // Keep the legacy rule-set identifier, but ship its content with the distribution.
 // User-specific rules are explicitly selected through the configured skill catalog.
 const core=defaultSkillCatalog().skills.find(item=>item.name==='workbench-core-writing')!;
 const skill=core.content.replace(/^name: workbench-core-writing$/m,'name: personal-ip-writing'),parsed=parseSkillMarkdown(skill,core.version);
 if(parsed.name!=='personal-ip-writing')throw new ContractError('INPUT_STALE','内置写作 Skill 身份不符');
 const definitions:[string,WritingRuleFile['kind'],string][]=[['通用写作规则','skill',skill]];
 if(target)definitions.push(['当前内容卡','content_card',readPlainFile(vaultFile(context,target.relative_path))]);
 if(definitions.reduce((n,entry)=>n+Buffer.byteLength(entry[2]),0)>524288)throw new ContractError('VALIDATION_ERROR','本次写作规则与样本过大');
 const files=definitions.map(([name,kind,content])=>({name,kind,sha256:sha256(content),content}));return {id:sha256(JSON.stringify(files.map(({name,kind,sha256})=>({name,kind,sha256})))),created_at:new Date().toISOString(),files,skill:{name:parsed.name,version:parsed.version,sha256:sha256(skill),content:skill},scope:'本人表达与已认可偏好优先；待试想法不自动采用；样本只作表达参照，不借用经历。'};
}
export function ruleBindings(snapshot:WritingRuleSnapshot):JsonObject{return {writing_skills:[snapshot.skill],skill_purpose:'core',skill_route:{recipe_id:null,label:'本人写作规则 · 本次显式选择',purpose:'core',source:'writing_flow_explicit',settings_version:null,skills:['personal-ip-writing'],snapshot_id:snapshot.id}} as unknown as JsonObject;}
