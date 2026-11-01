import {existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {ContractError,type JsonObject} from '@workbench/contracts';
import {readWritingSkills} from '../skills.ts';
import {hash} from '../codex/primitives.ts';
// 只编译冻结的自包含文本 Skill；不复用插件 hooks、工具权限或动态命令。
export function attachClaudeRecipe(manifest:JsonObject,cwd:string){
 const skills=readWritingSkills(manifest);if(!skills.length)return null;
 const bodies=skills.map(s=>{const body=/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(s.content)?.[1];if(!body||/!`|\$ARGUMENTS|\$\d|\$\{CLAUDE_/.test(body))throw new ContractError('CAPABILITY_UNSUPPORTED','Claude 文本配方只支持自包含 Skill，不执行动态命令或运行时替换');return '## '+s.name+' · '+s.version+'\n'+body;});
 const content='---\nname: workbench-route\ndescription: Execute the frozen workbench content recipe in order\ndisable-model-invocation: true\n---\n按下列顺序完成一个最终候选。服从任务的正文规则和输出 schema；不访问外部文件或工具，不写过程报告。\n\n'+bodies.join('\n\n')+'\n\n## 固定任务与材料\n$ARGUMENTS\n';
 const root=join(cwd,'.workbench-claude'),files:{path:string;content:string}[]=[{path:join(root,'.claude-plugin','plugin.json'),content:JSON.stringify({name:'workbench-content',version:'0.1.0',description:'Frozen text-only workbench recipe'})},{path:join(root,'skills','workbench-route','SKILL.md'),content}];
 for(const file of files){let dir=cwd;for(const part of file.path.slice(cwd.length+1).split('/').slice(0,-1)){dir=join(dir,part);if(!existsSync(dir))mkdirSync(dir,{mode:0o700});if(lstatSync(dir).isSymbolicLink()||!lstatSync(dir).isDirectory()||realpathSync(dir)!==dir)throw new ContractError('INPUT_STALE','Claude 技能目录已变化');}if(!existsSync(file.path))writeFileSync(file.path,file.content,{mode:0o444,flag:'wx'});if(lstatSync(file.path).isSymbolicLink()||!lstatSync(file.path).isFile()||hash(readFileSync(file.path))!==hash(file.content))throw new ContractError('INPUT_STALE','Claude 原生配方与冻结输入不符');}
 return {plugin_dir:root,command:'/workbench-content:workbench-route',compiled_sha256:hash(content),skills:skills.map(({name,version,sha256})=>({name,version,sha256}))};
}
