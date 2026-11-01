import { ContractError, type JsonObject, type NormalizedSourceRecord, type SourceRecordPayload } from '@workbench/contracts';
export const CREATOR_FEED_VERSION='creator-feed/2';
const obj=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const text=(v:unknown)=>typeof v==='string'?v:null;
const array=(v:unknown):JsonObject[]=>Array.isArray(v)?v.map(obj):[];
const strings=(v:unknown):string[]=>Array.isArray(v)?v.filter((s):s is string=>typeof s==='string'):[];
const date=(v:unknown):string|null=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const version=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{12,64}$/.test(v);
const score=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=100?v:null;
export const creatorId=(v:unknown):v is string=>typeof v==='string'&&/^(event|practice)_[A-Za-z0-9_-]{1,200}$/.test(v);
function fail(message:string):never{throw new ContractError('CAPABILITY_UNVERIFIED','创作者候选流：'+message);}
function url(v:unknown):string|null{try{const u=new URL(String(v));return ['https:','http:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function lines(v:unknown):string{if(typeof v==='string')return v;if(Array.isArray(v))return v.map(lines).filter(Boolean).join('\n');if(v&&typeof v==='object')return Object.entries(v).filter(([k])=>!k.endsWith('En')).map(([k,p])=>k+'：'+lines(p)).filter(l=>!l.endsWith('：')).join('\n');return '';}
function candidate(input:JsonObject,origin:string):void{
  if(!creatorId(input.id)||!['event','practice'].includes(String(input.type))||!String(input.id).startsWith(String(input.type)+'_')||!text(input.title)?.trim()||!version(input.contentVersion))fail('候选身份或内容版本无效');
  const selection=obj(input.selection),ids=obj(input.ids),links=obj(input.links);
  if(!['hot','practical','practice'].includes(String(selection.lane))||!Array.isArray(selection.reasons)||!selection.reasons.length||array(selection.reasons).some(r=>!text(r.text)?.trim()))fail('缺少入选依据');
  if(links.detail!==`${origin}/api/v1/creator-feed/${input.id}.json`)fail('详情链接不符合已准入路径');
  const site=url(links.site);if(!site||new URL(site).origin!==origin)fail('缺少本站稳定链接');
  if(input.type==='event'){
    if(!text(ids.eventId)||input.id!=='event_'+ids.eventId||!Array.isArray(ids.aliases)||!Array.isArray(ids.reportIds)||selection.lane==='practice')fail('事件标识或车道无效');
    const quality=obj(input.quality),event=obj(quality.eventScore);if(event.scope!=='event'||event.scale!=='0-100'||score(event.value)===null)fail('事件质量归属无效');
  }else{
    const practice=obj(input.practice);if(input.id!=='practice_'+ids.practiceKey||selection.lane!=='practice'||!['high','medium','unknown'].includes(String(practice.confidence))||!Number.isSafeInteger(practice.stepCount)||Number(practice.stepCount)<3)fail('玩法未满足结构准入条件');
  }
  if(!date(obj(input.times).firstReportAt)||!date(obj(input.times).lastActivityAt))fail('候选时间不明确');
}
export function parseCreatorFeed(value:JsonObject,origin:string):JsonObject[]{
  if(value.kind!=='creator-feed'||value.schemaVersion!==1||value.complete!==true||!/^cfs_[a-f0-9]{10,64}$/.test(String(value.snapshotId))||!version(value.contentVersion)||!text(value.ruleVersion)||!date(value.generatedAt)||!date(value.staleAfter)||Date.parse(String(value.staleAfter))<=Date.parse(String(value.generatedAt))||value.sourceDataUpdatedAt!==null&&!date(value.sourceDataUpdatedAt))fail('完整快照或版本/时间合同无效');
  if(!Array.isArray(value.candidates)||!Number.isSafeInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>30||value.count!==value.candidates.length||value.candidates.length>Number(value.limit)||value.sort!=='lane_then_lane_rank')fail('候选数量或排序不符合合同');
  const rows=array(value.candidates).sort((a,b)=>Number(a.rank)-Number(b.rank));
  if(new Set(rows.map(r=>r.id)).size!==rows.length)fail('候选 ID 重复');
  rows.forEach((row,i)=>{candidate(row,origin);if(row.rank!==i+1)fail('候选列表位置不连续');});return rows;
}
function body(input:JsonObject):string{
  const c=obj(input.content),sections:string[]=[];
  if(input.type==='practice'){
    if(text(c.result))sections.push('预期结果\n'+c.result);
    for(const [key,label] of [['needs','准备条件'],['steps','操作步骤']] as const){const a=Array.isArray(c[key])?c[key]:[];if(a.length)sections.push(label+'\n'+a.map((v,i)=>(i+1)+'. '+lines(v)).join('\n'));}
    const prompts=array(c.prompts);if(prompts.length)sections.push('提示词原文\n'+prompts.map((p,i)=>[(i+1)+'. '+(text(p.original)??''),text(p.noteZh),text(obj(p.source).author),url(obj(p.source).url)].filter(Boolean).join('\n')).join('\n\n'));
    if(Array.isArray(c.pitfalls)&&c.pitfalls.length)sections.push('注意事项\n'+lines(c.pitfalls));
  }else{
    if(text(c.reason))sections.push('站点解读理由\n'+c.reason);
    if(text(c.latest))sections.push('最新进展\n'+c.latest);
    const labels:Record<string,string>={tldr:'要点',what:'发生了什么',facts:'关键事实',background:'背景',impact:'影响',quotes:'站点引用',next:'后续关注'};
    for(const [key,v]of Object.entries(obj(c.brief))){const rendered=(key==='facts'||key==='quotes')&&Array.isArray(v)?v.map(p=>{const part=obj(p);return (key==='facts'?[text(part.k),text(part.v)]:[text(part.who),text(part.say)]).filter(Boolean).join('：')||lines(p);}).filter(Boolean).join('\n'):lines(v);if(!key.endsWith('En')&&rendered)sections.push((labels[key]??key)+'\n'+rendered);}
    if(Array.isArray(c.conflicts)&&c.conflicts.length)sections.push('来源分歧\n'+lines(c.conflicts));
  }
  const reports=array(input.reports);if(reports.length)sections.push('原始出处\n'+reports.map(r=>[text(r.title),text(r.source),url(r.originalUrl)].filter(Boolean).join('\n')).join('\n\n'));
  return sections.join('\n\n')||text(input.summary)||'';
}
export function normalizeCreatorCandidate(input:JsonObject,envelope:JsonObject,detail=false,origin:string):NormalizedSourceRecord{
  candidate(input,origin);const selection=obj(input.selection),quality=obj(input.quality),times=obj(input.times),links=obj(input.links),ids=obj(input.ids),evidence=obj(input.evidence);
  const reasons=array(selection.reasons).map(r=>String(r.text)).join('；');
  const metadata:JsonObject={candidate_id:input.id,type:input.type,ids,quality,signals:obj(input.signals),times,progress:input.progress??null,practice:input.practice??null,relations:input.relations??null,selection,evidence,content_version:input.contentVersion,snapshot_id:envelope.snapshotId,rule_version:envelope.ruleVersion,generated_at:envelope.generatedAt,source_data_updated_at:envelope.sourceDataUpdatedAt??null,stale_after:envelope.staleAfter??null,detail_url:links.detail,site_url:links.site,...(detail?{detail_content_version:input.contentVersion,detail_snapshot_id:envelope.snapshotId,content:obj(input.content),reports:array(input.reports)}:{})};
  const payload:SourceRecordPayload={title:String(input.title),summary:text(input.summary)??'',body:detail?body(input):null,category:input.type==='practice'?'AI 实测':'热点资讯',author_name:null,reply_author_name:null,quoted_author_name:null,external_links:[...new Set([url(links.original),...array(input.reports).map(r=>url(r.originalUrl)),...array(obj(input.content).sources).map(s=>url(s.url))].filter((v):v is string=>v!==null))],media:[],identity_status:'pending',parser_warnings:[input.type==='practice'?'玩法来自个人站 AI 整理，尚未本人实测。':'个人站事件解读不代表每篇外站全文，也不代表本人已验证。',...(detail?[]:['正文尚未读取；列表仅含摘要。'])],provider_metadata:{creator_feed:metadata,event_id:text(ids.eventId),source_name:strings(obj(input.signals).sourceNames).join(' / ')||'personal_site',published_time_basis:'provider_firstReportAt',curation:{rank:input.rank,score:input.type==='event'?score(obj(quality.eventScore).value):null,reason:reasons,selected:true,status:'active',generated_at:envelope.generatedAt,type:input.type,lane:selection.lane,stale_after:envelope.staleAfter,source_updated_at:envelope.sourceDataUpdatedAt??null},...(detail?{body_parser_version:CREATOR_FEED_VERSION}:{})}};
  return {external_id:String(input.id),canonical_url:String(links.site),record_kind:input.type==='practice'?'site_practice':'site_event',published_at:date(times.firstReportAt),payload,identity:null};
}
export function parseCreatorDetail(value:JsonObject,id:string,expectedVersion:string|undefined,origin:string):NormalizedSourceRecord{
  if(value.kind!=='creator-feed-detail'||value.schemaVersion!==1||!text(value.snapshotId)||!date(value.generatedAt)||!text(value.ruleVersion))fail('详情合同无效');
  const c=obj(value.candidate);if(c.id!==id)fail('详情身份与请求不同');
  if(expectedVersion&&c.contentVersion!==expectedVersion)throw new ContractError('INPUT_STALE','个人站内容版本已变化，请刷新候选列表后重试');
  const content=obj(c.content),steps=content.steps;
  if(c.type==='practice'&&(!Array.isArray(steps)||Number(obj(c.practice).stepCount)!==steps.length||array(content.prompts).some(p=>!text(p.original))))fail('玩法详情的步骤或提示词不完整');
  return normalizeCreatorCandidate(c,value,true,origin);
}
