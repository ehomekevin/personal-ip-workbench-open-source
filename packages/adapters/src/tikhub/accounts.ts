import {ContractError,type Platform} from '@workbench/contracts';
import type {ResolvedAccount} from './index.ts';
export interface AccountLookupOptions {token:string|null;fetcher:typeof fetch;timeout:number;now():number;fixture:boolean}
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const id=(v:unknown)=>typeof v==='string'?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):'';
export async function accountResponse(path:string,params:Record<string,string>,o:AccountLookupOptions){
 if(!o.token)throw new ContractError('AUTH_REQUIRED','请先配置 TikHub 密钥');
 const url='https://api.tikhub.io'+path+'?'+new URLSearchParams(params);let response:Response;
 try{response=await o.fetcher(url,{method:'GET',headers:{Authorization:'Bearer '+o.token},redirect:'error',signal:AbortSignal.timeout(o.timeout)});}catch{throw new ContractError('CAPABILITY_UNVERIFIED','TikHub 账号读取未完成，请检查网络后重试');}
 if([401,403].includes(response.status)){await response.body?.cancel();throw new ContractError('AUTH_REQUIRED','TikHub 密钥或平台权限需要核对');}
 if(!response.ok){await response.body?.cancel();throw new ContractError('CAPABILITY_UNVERIFIED','平台账号暂不可读，请稍后核对');}
 const reader=response.body?.getReader();if(!reader)throw new ContractError('CAPABILITY_UNVERIFIED','平台账号响应为空');let size=0,raw='',decoder=new TextDecoder();
 try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>262144)throw new ContractError('CAPABILITY_UNVERIFIED','账号响应超过允许大小');raw+=decoder.decode(part.value,{stream:true});}raw+=decoder.decode();}finally{await reader.cancel();}
 raw=raw.replaceAll(o.token,'[REDACTED]').replaceAll(JSON.stringify(o.token).slice(1,-1),'[REDACTED]');let payload:Record<string,any>;
 try{payload=object(JSON.parse(raw));}catch{throw new ContractError('CAPABILITY_UNVERIFIED','账号响应格式需要核对');}
 if(Number(payload.code)!==200)throw new ContractError('CAPABILITY_UNVERIFIED','平台没有返回可核对的账号');return {raw,data:object(payload.data),url};
}
export async function resolveOtherAccount(input:string,o:AccountLookupOptions):Promise<ResolvedAccount>{
 const u=new URL(input);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)throw new ContractError('VALIDATION_ERROR','请填写明确的 HTTPS 账号主页');
 let platform:Platform,platformId='',canonical='',display='',name='',result:Awaited<ReturnType<typeof accountResponse>>;
 if(u.hostname==='space.bilibili.com'){
  const m=u.pathname.match(/^\/(\d{1,30})\/?$/);if(!m)throw new ContractError('VALIDATION_ERROR','B 站主页需要明确 UID');
  result=await accountResponse('/api/v1/bilibili/web/fetch_user_profile',{uid:m[1]!},o);const p=object(result.data.data);
  if(result.data.code!==0||id(p.mid)!==m[1])throw new ContractError('CAPABILITY_UNVERIFIED','B 站返回的 UID 与登记主页不符');
  platform='bilibili';platformId=m[1]!;canonical='https://space.bilibili.com/'+platformId;display=platformId;name=typeof p.name==='string'?p.name:'';
 }else if(['xiaohongshu.com','www.xiaohongshu.com'].includes(u.hostname)){
  const m=u.pathname.match(/^\/user\/profile\/([a-fA-F0-9]{24})\/?$/);if(!m)throw new ContractError('VALIDATION_ERROR','请填写包含唯一账号 ID 的小红书主页');
  result=await accountResponse('/api/v1/xiaohongshu/app_v2/get_user_info',{user_id:m[1]!.toLowerCase()},o);const p=object(result.data.data);
  if(result.data.success!==true||result.data.code!==0||id(p.userid).toLowerCase()!==m[1]!.toLowerCase())throw new ContractError('CAPABILITY_UNVERIFIED','小红书返回的账号 ID 与主页不符');
  platform='xiaohongshu';platformId=id(p.userid).toLowerCase();canonical='https://www.xiaohongshu.com/user/profile/'+platformId;display=id(p.red_id);name=typeof p.nickname==='string'?p.nickname:'';
 }else if(['douyin.com','www.douyin.com'].includes(u.hostname)){
  const m=u.pathname.match(/^\/user\/([A-Za-z0-9_-]{16,256})\/?$/);if(!m)throw new ContractError('VALIDATION_ERROR','请填写包含 sec_uid 的抖音主页');
  result=await accountResponse('/api/v1/douyin/web/handler_user_profile',{sec_user_id:m[1]!},o);const p=object(result.data.user);
  if(result.data.status_code!==0||p.sec_uid!==m[1]||!/^\d{1,30}$/.test(id(p.uid)))throw new ContractError('CAPABILITY_UNVERIFIED','抖音返回的内部身份与主页不符');
  platform='douyin';platformId=id(p.uid);canonical='https://www.douyin.com/user/'+m[1];display=id(p.unique_id)||id(p.short_id);name=typeof p.nickname==='string'?p.nickname:'';
 }else throw new ContractError('CAPABILITY_UNSUPPORTED','当前支持 X、小红书、抖音和 B 站唯一主页核对');
 return {platform,platform_account_id:platformId,canonical_url:canonical,checked_at:new Date(o.now()).toISOString(),raw_body:result.raw,evidence_kind:o.fixture?'internal_rule':'real_platform',display_id:display,display_name:name,endpoint_url:result.url};
}
export async function discoverAccount(platform:'xiaohongshu'|'douyin',displayId:string,o:AccountLookupOptions):Promise<ResolvedAccount>{
 if(!/^[A-Za-z0-9_.-]{2,100}$/.test(displayId))throw new ContractError('VALIDATION_ERROR','请填写明确的展示号，不能按名称猜账号');
 let initial:Awaited<ReturnType<typeof accountResponse>>,url='';
 if(platform==='xiaohongshu'){
  initial=await accountResponse('/api/v1/xiaohongshu/app_v2/search_users',{keyword:displayId,page:'1'},o);const payload=object(initial.data.data),users=Array.isArray(payload.users)?payload.users:[];
  const matches=users.map(object).filter(u=>id(u.red_id)===displayId&&/^[a-fA-F0-9]{24}$/.test(id(u.id)));if(matches.length!==1)throw new ContractError('CAPABILITY_UNVERIFIED','展示号未返回唯一小红书账号，请补充主页');url='https://www.xiaohongshu.com/user/profile/'+matches[0]!.id;
 }else{
  initial=await accountResponse('/api/v1/douyin/web/handler_user_profile_v2',{unique_id:displayId},o);const p=object(initial.data.user_info);
  if(id(p.unique_id)!==displayId||!/^MS4w[A-Za-z0-9_-]{12,252}$/.test(id(p.sec_uid)))throw new ContractError('CAPABILITY_UNVERIFIED','抖音号没有返回匹配的唯一主页');url='https://www.douyin.com/user/'+p.sec_uid;
 }
 const result=await resolveOtherAccount(url,o);if(result.display_id!==displayId)throw new ContractError('CAPABILITY_UNVERIFIED','主页返回的展示号与原登记不符');return {...result,raw_body:JSON.stringify({discovery:JSON.parse(initial.raw),profile:JSON.parse(result.raw_body)})};
}
