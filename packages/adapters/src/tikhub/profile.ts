import {ContractError,type AccountPlatformProfile,type Platform} from '@workbench/contracts';
const object=(v:unknown):Record<string,any>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,any>:{};
const text=(v:unknown):string|null=>typeof v==='string'&&v.trim()?v.trim():null;
const id=(v:unknown):string=>typeof v==='string'?v:typeof v==='number'&&Number.isSafeInteger(v)?String(v):'';
const count=(v:unknown):string|null=>typeof v==='string'&&/^(0|[1-9]\d{0,29})$/.test(v)?v:typeof v==='number'&&Number.isSafeInteger(v)&&v>=0?String(v):null;
export function publicUrl(v:unknown,image=false):string|null{if(typeof v!=='string'||v.length>8192)return null;try{const u=new URL(v);return (image?u.protocol==='https:':['https:','http:'].includes(u.protocol))&&!u.username&&!u.password?u.href:null;}catch{return null;}}
const picture=(v:unknown):string|null=>publicUrl(typeof v==='string'?v:object(v).url_list?.[0],true);

export function parseAccountProfile(platform:Platform,platformId:string,url:string,body:unknown,at:string,evidenceKind:'real_platform'|'internal_rule'):AccountPlatformProfile|null{
 if(platform==='wechat')return null;
 const root=object(body),data=object(root.profile?.data??root.data);
 if(evidenceKind==='internal_rule'&&!root.data&&!root.profile)return null;
 let p:Record<string,any>,display:string|null=null;
 const profile:AccountPlatformProfile={platform,platform_account_id:platformId,display_name:null,display_id:null,avatar_url:null,banner_url:null,bio:null,website:null,public_location:null,followers:null,following:null,works:null,likes:null,verified:null,verification_label:null,joined_at:null,collected_at:at,evidence_kind:evidenceKind,raw_response_ref:null};
 if(platform==='x'){
  p=data;const handle=new URL(url).pathname.split('/')[1]!.toLowerCase();
  if(p.status!=='active'||id(p.rest_id)!==platformId||id(p.profile).toLowerCase()!==handle)throw new ContractError('CAPABILITY_UNVERIFIED','平台资料与所选 X 账号不符');
  Object.assign(profile,{display_name:text(p.name),display_id:text(p.profile),avatar_url:picture(p.avatar),banner_url:picture(p.header_image),bio:text(p.desc),website:publicUrl(p.website),public_location:text(p.location),followers:count(p.sub_count),following:count(p.friends),works:count(p.statuses_count),verified:typeof p.blue_verified==='boolean'?p.blue_verified:null,verification_label:text(p.verification_type)||(p.blue_verified?'X 蓝标':null),joined_at:typeof p.created_at==='string'&&Number.isFinite(Date.parse(p.created_at))?new Date(p.created_at).toISOString():null});
 }else if(platform==='douyin'){
  p=object(data.user);if(id(p.uid)!==platformId||id(p.sec_uid)!==new URL(url).pathname.split('/')[2])throw new ContractError('CAPABILITY_UNVERIFIED','平台资料与所选抖音账号不符');
  display=text(p.unique_id)||text(p.short_id);
  Object.assign(profile,{display_name:text(p.nickname),display_id:display,avatar_url:picture(p.avatar_300x300)||picture(p.avatar_larger)||picture(p.avatar_thumb),banner_url:picture(Array.isArray(p.cover_url)?p.cover_url[0]:p.cover_url),bio:text(p.signature),public_location:text(p.ip_location),followers:count(p.follower_count),following:count(p.following_count),works:count(p.aweme_count),likes:count(p.total_favorited),verified:text(p.custom_verify)||text(p.enterprise_verify_reason)?true:null,verification_label:text(p.custom_verify)||text(p.enterprise_verify_reason)});
 }else if(platform==='bilibili'){
  p=object(data.data);if(id(p.mid)!==platformId)throw new ContractError('CAPABILITY_UNVERIFIED','平台资料与所选 B 站账号不符');
  Object.assign(profile,{display_name:text(p.name),display_id:platformId,avatar_url:picture(p.face),banner_url:picture(p.top_photo),bio:text(p.sign),followers:count(p.follower),following:count(p.following),works:count(p.archive_count),verified:object(p.official).role>0?true:null,verification_label:text(object(p.official).title)});
 }else if(platform==='xiaohongshu'){
  p=object(data.data);if(id(p.userid).toLowerCase()!==platformId.toLowerCase())throw new ContractError('CAPABILITY_UNVERIFIED','平台资料与所选小红书账号不符');
  Object.assign(profile,{display_name:text(p.nickname),display_id:text(p.red_id),avatar_url:picture(p.imageb)||picture(p.images)||picture(p.image),bio:text(p.desc),followers:count(p.fans),following:count(p.follows),works:count(p.notes),likes:count(p.liked),verification_label:text(p.official_verify)});
 }else return null;
 return profile;
}
