import { lstatSync,openSync,readFileSync,writeFileSync,closeSync,renameSync,unlinkSync,mkdirSync,constants,fstatSync,fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { credentialPath,saveTikHubCredential,readTikHubCredential } from '../tikhub-credentials.ts';
import { DatabaseSync } from 'node:sqlite';
export const LOCAL_CREDENTIAL_KINDS=['tikhub','openai','anthropic','x','douyin','wechat','ark_agent_plan'] as const;
export type LocalCredentialKind=typeof LOCAL_CREDENTIAL_KINDS[number];
const leaf=(kind:LocalCredentialKind)=>kind==='tikhub'?'tikhub-api-key':kind==='wechat'?'wechat.json':kind+'-credentials.json';
export function localCredentialPath(root:string,kind:LocalCredentialKind){return join(credentialPath(root),'..',leaf(kind));}
function load(root:string,kind:LocalCredentialKind):Record<string,unknown>|null {
  const path=localCredentialPath(root,kind),info=lstatSync(path,{throwIfNoEntry:false});if(!info)return null;
  if(!info.isFile()||info.isSymbolicLink()||(info.mode&0o077)!==0||info.size>16384)throw new Error('私有凭据无效');
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const st=fstatSync(fd);if(!st.isFile()||(st.mode&0o077)!==0||st.size>16384)throw new Error();return JSON.parse(readFileSync(fd,'utf8'));}finally{closeSync(fd);}
}
export function readLocalCredential(root:string,kind:LocalCredentialKind,accountId?:string,workspaceId?:string):string|null{
  if(kind==='tikhub')return readTikHubCredential(root);const c=load(root,kind);if(!c||workspaceId&&c.workspace_id!==workspaceId)return null;
  let value:unknown;
  if((kind==='x'||kind==='douyin')&&c.accounts&&typeof c.accounts==='object'){
    const accounts=c.accounts as Record<string,{key?:unknown}>;value=accountId?accounts[accountId]?.key:Object.values(accounts).find(a=>typeof a.key==='string')?.key;
  }else{if(accountId&&c.account_id!==accountId)return null;value=kind==='wechat'?c.app_secret:c.key;}
  return typeof value==='string'&&/^[\x21-\x7e]{1,4096}$/.test(value)?value:null;
}
export function saveLocalCredential(root:string,kind:LocalCredentialKind,key:unknown,accountId?:string){
  if(kind==='tikhub'){saveTikHubCredential(root,key);return;}
  if(typeof key!=='string'||!/^[\x21-\x7e]{1,4096}$/.test(key.trim()))throw new Error('密钥格式无效');
  const path=localCredentialPath(root,kind),directory=join(path,'..');let value:Record<string,unknown>;
  if(kind==='wechat'){const existing=load(root,kind);if(!existing||accountId&&existing.account_id!==accountId)throw new Error('先连接当前公众号账号');value={...existing,app_secret:key.trim()};}
  else{
    const db=new DatabaseSync(join(root,'workbench.sqlite'),{readOnly:true});try{
      const workspace=db.prepare('SELECT id FROM workspaces LIMIT 1').get();if(!workspace)throw new Error();
      if(['x','douyin'].includes(kind)){const row=db.prepare('SELECT platform,role FROM accounts WHERE workspace_id=? AND id=?').get(workspace.id,accountId??'');if(!row||row.platform!==kind||row.role!=='owner')throw new Error('请选择本工作区的本人账号');}
      if(kind==='x'||kind==='douyin'){
        const old=load(root,kind);if(old&&old.workspace_id!==workspace.id)throw new Error('凭据属于另一工作区');
        const accounts:Record<string,{key:string}>=old?.accounts&&typeof old.accounts==='object'?structuredClone(old.accounts) as Record<string,{key:string}>:{};
        if(typeof old?.account_id==='string'&&typeof old.key==='string')accounts[old.account_id]={key:old.key};
        accounts[accountId!]={key:key.trim()};value={workspace_id:String(workspace.id),accounts};
      }else value={workspace_id:String(workspace.id),account_id:accountId??null,key:key.trim()};
    }finally{db.close();}
  }
  const encoded=JSON.stringify(value);if(Buffer.byteLength(encoded)>16384)throw new Error('凭据配置过大，已有账号凭据保留');
  mkdirSync(directory,{recursive:true,mode:0o700});const temporary=join(directory,'.credential-'+randomUUID()),fd=openSync(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{try{writeFileSync(fd,encoded);fsyncSync(fd);}finally{closeSync(fd);}renameSync(temporary,path);}finally{if(lstatSync(temporary,{throwIfNoEntry:false}))unlinkSync(temporary);}
}
export function credentialAccounts(root:string,kind:LocalCredentialKind){if(!['wechat','x','douyin'].includes(kind))return[];const db=new DatabaseSync(join(root,'workbench.sqlite'),{readOnly:true});try{return db.prepare("SELECT id,name FROM accounts WHERE platform=? AND role='owner' ORDER BY created_at,id").all(kind);}finally{db.close();}}
