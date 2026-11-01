import {existsSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,lstatSync,readFileSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalJson} from '../../../storage/src/connection/index.ts';
import {ContractError} from '@workbench/contracts';
import {safeManagedChild} from '../../../storage/src/files/index.ts';
export function imageStudioRecordPaths(root:string,topic:string,revision?:string){
 if(!/^[a-f0-9-]{36}$/.test(topic)||revision&&!/^[a-f0-9-]{36}$/.test(revision))throw new ContractError('VALIDATION_ERROR','记录归属身份无效');
 return{process:safeManagedChild(root,join(root,'image-studio',topic,'process.md')),wiki:revision?safeManagedChild(root,join(root,'wiki/image-studio',topic,revision+'.md')):null};
}
export function appendStudioProcess(root:string,topic:string,event:{id:string;at:string;kind:string;payload:unknown}){
 const path=imageStudioRecordPaths(root,topic).process;mkdirSync(dirname(path),{recursive:true});if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new ContractError('STORAGE_UNAVAILABLE','记录路径不是普通文件');
 // SQL event id permits repeat reads without writing the same event twice; no original note is replaced.
 if(existsSync(path)&&readFileSync(path,'utf8').includes('<!-- event:'+event.id+' -->'))return path;
 const fd=openSync(path,'a',0o600);try{writeFileSync(fd,'\n<!-- event:'+event.id+' -->\n## '+event.at+' · '+event.kind+'\n\n```json\n'+JSON.stringify(event.payload,null,2)+'\n```\n');fsyncSync(fd);}finally{closeSync(fd);}return path;
}
export function writeConfirmedStudioWiki(root:string,topic:string,revision:string,value:unknown){
 const digest=createHash('sha256').update(canonicalJson(value)).digest('hex');const base=imageStudioRecordPaths(root,topic,revision).wiki!;const path=safeManagedChild(root,base.replace(/\.md$/, '-'+digest+'.md'));if(existsSync(path)&&(!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()))throw new ContractError('STORAGE_UNAVAILABLE','终稿记录路径不是普通文件');mkdirSync(dirname(path),{recursive:true});const content='# 公众号配图 · 本人确认终稿\n\n'+JSON.stringify(value,null,2)+'\n';
 if(existsSync(path)){if(readFileSync(path,'utf8')!==content)throw new ContractError('VERSION_CONFLICT','该终稿Wiki记录已有不同内容，未覆盖');return path;}
 const fd=openSync(resolve(path),'wx',0o600);try{writeFileSync(fd,content);fsyncSync(fd);}finally{closeSync(fd);}return path;
}
