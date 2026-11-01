import { existsSync,realpathSync,lstatSync,accessSync,constants,writeFileSync,unlinkSync } from 'node:fs';
import { dirname,resolve,relative,sep,isAbsolute,join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertStorageRoot } from '@workbench/storage/connection';
let input='';for await(const chunk of process.stdin)input+=chunk;
try{
  const {paths,registered=[],check=false}=JSON.parse(input);
  const physical=(path:string)=>{if(!isAbsolute(path)||/[\x00-\x1f]/.test(path))throw new Error('路径必须是有效的绝对路径');let at=resolve(path);while(!existsSync(at)&&dirname(at)!==at){if(lstatSync(at,{throwIfNoEntry:false})?.isSymbolicLink())throw new Error('路径包含无法解析的链接');at=dirname(at);}return resolve(realpathSync(at),relative(at,resolve(path)));};
  const overlaps=(a:string,b:string)=>a===b||a.startsWith(b+sep)||b.startsWith(a+sep);
  for(const name of ['managed_notes_root','media_root','state_root']){let at=paths[name];while(!existsSync(at)&&dirname(at)!==at)at=dirname(at);assertStorageRoot(at);}
  const roots=Object.entries(paths).filter(([,v])=>v!==null).map(([k,v])=>[k,physical(v as string)]);
  for(let i=0;i<roots.length;i++)for(let j=i+1;j<roots.length;j++)if(overlaps(roots[i]![1]!,roots[j]![1]!))throw new Error('源库和工作台各写根必须独立');
  if(paths.source_vault_root&&registered.some((path:string)=>overlaps(physical(paths.source_vault_root),physical(dirname(dirname(dirname(path)))))))throw new Error('源库不能覆盖已登记的历史受管理修订根');
  const results:Record<string,string>={};
  if(check)for(const [name,path]of roots){if(!lstatSync(path!).isDirectory())throw new Error('配置路径不是可用目录');accessSync(path!,constants.R_OK);if(name!=='source_vault_root'){const temporary=join(path!,'.configuration-check-'+randomUUID());try{writeFileSync(temporary,'configuration check',{flag:'wx',mode:0o600});results[name!]='可读写';}finally{if(existsSync(temporary))unlinkSync(temporary);}}else results[name!]='可只读访问';}
  process.stdout.write(JSON.stringify({valid:true,results}));
}catch{process.stdout.write(JSON.stringify({error:'路径无效、不可访问或发生重叠，请检查挂载、路径和目录权限'}));}
