import { readFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { ContractError, ACCOUNT_RESEARCH_VERSION, ACCOUNT_RESEARCH_RESPONSE_SCHEMAS, parseSkillMarkdown, type AccountResearchPlan, type AccountResearchView, type AccountResearchHistoryItem, type ResearchSample, type RequestContext, type JsonObject, type ContentExecutor } from '@workbench/contracts';
import { canonicalJson, sha256 } from '@workbench/storage/connection';
import { readSourcePayload } from '@workbench/storage/sources';
import { canonicalWorkId } from '@workbench/storage/identity';
import { workspaceSettings } from '@workbench/storage/settings';
import type { ApplicationContext } from '../ports/index.ts';
import { assertRequestIdentity } from '../documents/index.ts';
import { SkillLibrary } from '../skills/library.ts';
import { profileKey, readAccountProfile } from '../sources/account-profiles.ts';
import { evidenceFromSources, snapshotEvidence, type ContentEvidence } from './evidence.ts';

const obj=(v:unknown):JsonObject=>v&&typeof v==='object'&&!Array.isArray(v)?v as JsonObject:{};
const date=(v:unknown):string|null=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
const count=(v:unknown):string|null=>typeof v==='string'&&/^(0|[1-9]\d{0,29})$/.test(v)?v:null;
interface Comparison {group:string;id:string;key:string;value:string;window:number;distance:number}
interface Eligible {sample:ResearchSample;data:JsonObject;signature:string;comparison?:Comparison;comparisons:Comparison[]}
export interface FrozenAccountResearch {plan:AccountResearchPlan;evidence:ContentEvidence[];context:JsonObject;skill:JsonObject;bindings:JsonObject}

// 研究只读取已有材料和不可变快照。GET 不采集、不排队、不建立报告文稿。
export class AccountResearch {
 readonly context:ApplicationContext;readonly library:SkillLibrary;
 constructor(context:ApplicationContext,library=new SkillLibrary(context)){this.context=context;this.library=library;}
 async freeze(request:RequestContext,accountId:string,requested?:string[]):Promise<FrozenAccountResearch>{
  assertRequestIdentity(this.context,request);const db=this.context.db,w=request.workspace_id;
  const account=db.prepare('SELECT * FROM accounts WHERE workspace_id=? AND id=?').get(w,accountId);
  if(!account)throw new ContractError('NOT_FOUND','账号不存在');
  if(account.role!=='benchmark')throw new ContractError('VALIDATION_ERROR','账号研究只适用于对标账号');
  const local=this.library.get(request).skills.find(skill=>skill.name==='personal-ip-operations'&&skill.purposes.includes('research')&&skill.reuse_mode==='derive');
  const skill=local?await this.library.freeze(request,{purpose:'research',instruction:'研究固定对标资料，提出本人可试的方法',samples:'',base_local_skill:{id:local.id,sha256:local.sha256}}):{};
  const base=obj(skill.base_local_skill),skillFingerprint=sha256(canonicalJson(skill));
  const rows=db.prepare("SELECT r.*,w.id canonical_work_id,w.format work_format,w.platform,w.account_id,w.identity_status work_identity FROM source_records r JOIN works w ON w.workspace_id=r.workspace_id AND w.id=r.work_id WHERE r.workspace_id=? AND w.account_id=? ORDER BY r.published_at DESC,r.updated_at DESC,r.id").all(w,accountId);
  const eligible:Eligible[]=[],seen=new Set<string>();let excluded=0;
  const allCaptures:JsonObject[]=[];
  for(const row of rows){
   const payload=readSourcePayload(row),metadata=payload.provider_metadata,workId=canonicalWorkId(db,w,String(row.work_id));
   if(seen.has(workId)){excluded++;continue;}seen.add(workId);
   // 账号自己的回复与他人转发不是原创主题样本，引用正文保留独立归属。
   if(account.identity_status!=='confirmed'||row.work_identity!=='confirmed'||payload.identity_status!=='confirmed'||row.content_status==='parse_error'||metadata.in_reply_to_work_id||/reply|repost|retweet/i.test(String(row.record_kind))||(!payload.body?.trim()&&!payload.summary.trim())){excluded++;continue;}
   const format=typeof row.work_format==='string'?row.work_format:typeof metadata.format==='string'?metadata.format:null;
   const platformCaption=typeof metadata.platform_caption==='string'&&metadata.platform_caption.trim()?metadata.platform_caption:null;
   const transcript=obj(metadata.transcript),transcriptText=typeof transcript.text==='string'&&transcript.text.trim()&&transcript.status==='completed'?transcript.text:null;
   const basis:ResearchSample['content_basis']=row.platform==='douyin'&&format==='short_video'?(transcriptText?'transcript':platformCaption?'platform_caption':'description_only'):payload.body?.trim()?'full_text':'summary_only';
   const snapshots=db.prepare('SELECT * FROM snapshots WHERE workspace_id=? AND work_id=? ORDER BY collected_at,id').all(w,workId);
   const comparisons=new Map<string,Comparison>();
   for(const snapshot of snapshots){
    const metrics=db.prepare('SELECT m.definition_id,m.value,m.availability,m.reason,d.key,d.unit,d.scope,d.definition_version,d.raw_field FROM metric_values m JOIN metric_definitions d ON d.workspace_id=m.workspace_id AND d.id=m.definition_id WHERE m.workspace_id=? AND m.snapshot_id=? ORDER BY d.id').all(w,snapshot.id);
    allCaptures.push({id:snapshot.id,work_id:workId,raw_sha256:snapshot.raw_sha256,adapter_version:snapshot.adapter_version,observed_at:snapshot.observed_at,observed_time_basis:snapshot.observed_time_basis,collected_at:snapshot.collected_at,target_window:snapshot.target_window,observed_age_s:snapshot.observed_age_s,metrics} as JsonObject);
    const observed=date(snapshot.observed_at),published=date(row.published_at),collected=date(snapshot.collected_at),target=typeof snapshot.target_window==='number'?snapshot.target_window:null,age=typeof snapshot.observed_age_s==='number'?snapshot.observed_age_s:null;
    if(!format||!observed||!published||!collected||snapshot.observed_time_basis==='unknown'||target===null||age===null||Date.parse(observed)>Date.parse(collected)||Date.parse(observed)<Date.parse(published)||Math.floor((Date.parse(observed)-Date.parse(published))/1000)!==age)continue;
    const targetSeconds=target,distance=Math.abs(age-targetSeconds),tolerance=Math.min(3600,targetSeconds*.05);
    if(distance>tolerance)continue;
    const metric=metrics.find(metric=>metric.key===(row.platform==='douyin'?'plays':'views')&&metric.scope==='work'&&metric.unit==='count'&&metric.availability==='available'&&count(metric.value)!==null);
    if(!metric||(row.platform==='douyin'&&metric.value==='0'))continue;
    const group=format+':'+metric.definition_id+':'+target,previous=comparisons.get(group);if(previous&&previous.distance<distance)continue;
    comparisons.set(group,{group,id:String(snapshot.id),key:String(metric.key),value:String(metric.value),window:target,distance});
   }
   const data:JsonObject={title:payload.title,summary:payload.summary,body:payload.body,content_basis:basis,platform_caption:platformCaption,transcript:transcriptText?transcript:null,quoted_text:metadata.quoted_text??null,quoted_author:payload.quoted_author_name,media:payload.media,parser_warnings:payload.parser_warnings,provider_metadata:metadata};
   eligible.push({sample:{source_id:String(row.id),work_id:workId,title:payload.title,url:String(row.canonical_url),published_at:date(row.published_at),format,selection:'recent',content_basis:basis,evidence_keys:['source:'+row.id,'work:'+workId],comparison_group:null,snapshot_id:null,metric_key:null,metric_value:null},data,signature:sha256(canonicalJson(data)),comparisons:[...comparisons.values()]});
  }
  const latest=eligible.map(e=>e.sample.published_at).filter((v):v is string=>!!v).sort().at(-1)??null;
  const start=latest?new Date(Date.parse(latest)-30*86400000).toISOString():null;
  const recent=eligible.filter(e=>!start||!!e.sample.published_at&&e.sample.published_at>=start);
  const timezone=workspaceSettings(db,w).timezone,localDay=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
  const days=new Map<string,number>();for(const entry of recent)if(entry.sample.published_at){const day=localDay(entry.sample.published_at);days.set(day,(days.get(day)??0)+1);}
  const corpusScope:JsonObject={history_complete:false,timezone,window_start:start,window_end:latest,eligible_count:eligible.length,recent_count:recent.length,publication_day_count:days.size,publication_days:[...days].sort(([a],[b])=>a.localeCompare(b)).map(([day,count])=>({day,count})),timeline:eligible.map(entry=>({source_id:entry.sample.source_id,work_id:entry.sample.work_id,title:entry.sample.title,url:entry.sample.url,published_at:entry.sample.published_at,format:entry.sample.format,hashtags:obj(entry.data.provider_metadata).hashtags??[],content_sha256:entry.signature})),semantics:'时间线与标题用于已收录频率/栏目线索，只有 plan.samples 提供正文；不能声称完整历史或已读过其余全文。'};
  const inGroup=(entry:Eligible,comparison:Comparison):Eligible=>({...entry,comparison,sample:{...entry.sample,comparison_group:comparison.group,snapshot_id:comparison.id,metric_key:comparison.key,metric_value:comparison.value}});
  const groups=new Map<string,Eligible[]>();for(const e of recent)for(const comparison of e.comparisons){const group=groups.get(comparison.group)??[];group.push(inGroup(e,comparison));groups.set(comparison.group,group);}
  const comparableGroups=[...groups.values()].filter(group=>group.length>=4&&new Set(group.map(e=>e.comparison!.value)).size>1).sort((a,b)=>b.length-a.length||a[0]!.comparison!.window-b[0]!.comparison!.window||a[0]!.comparison!.group.localeCompare(b[0]!.comparison!.group));
  const preferredByFormat=new Map<string|null,Eligible[]>();for(const group of comparableGroups)if(!preferredByFormat.has(group[0]!.sample.format))preferredByFormat.set(group[0]!.sample.format,group);
  const selections=new Map<string,Eligible>();
  for(const group of [...preferredByFormat.values()].slice(0,2)){
   const ranked=[...group].sort((a,b)=>BigInt(a.comparison!.value)===BigInt(b.comparison!.value)?a.sample.source_id.localeCompare(b.sample.source_id):BigInt(a.comparison!.value)>BigInt(b.comparison!.value)?-1:1);
   for(const [entry,selection] of [[ranked[0]!,'higher_observed'],[ranked.at(-1)!,'lower_observed']] as const)selections.set(entry.sample.source_id,{...entry,sample:{...entry.sample,selection}});
  }
  for(const entry of recent.slice(0,8))if(!selections.has(entry.sample.source_id)){const preferred=preferredByFormat.get(entry.sample.format)?.find(e=>e.sample.source_id===entry.sample.source_id);selections.set(entry.sample.source_id,preferred??entry);}
  if(!selections.size)for(const entry of eligible.slice(0,8))selections.set(entry.sample.source_id,entry);
  let selected=[...selections.values()].slice(0,12);
  if(requested){const unique=[...new Set(requested)];if(unique.length>12||unique.some(id=>!eligible.some(e=>e.sample.source_id===id)))throw new ContractError('VALIDATION_ERROR','每份研究素材都须归属当前已核对账号；最多选择 12 篇');selected=unique.map(id=>selections.get(id)??{...eligible.find(e=>e.sample.source_id===id)!,sample:{...eligible.find(e=>e.sample.source_id===id)!.sample,selection:'contrast' as const}});}
  const sufficientGroups=new Set(comparableGroups.map(group=>group[0]!.comparison!.group));
  selected=selected.map(entry=>({...entry,sample:{...entry.sample,comparison_group:entry.comparison&&sufficientGroups.has(entry.comparison.group)?entry.comparison.group:null}}));
  const profile=readAccountProfile(this.context,account as {id:unknown;platform:unknown;platform_account_id:unknown;canonical_url:unknown});
  const profiles:JsonObject[]=[];for(const record of db.prepare('SELECT key,value FROM application_metadata WHERE key LIKE ? ORDER BY key').all(profileKey(w,accountId)+':%')){try{const p=obj(JSON.parse(String(record.value)));if(p.platform===account.platform&&p.platform_account_id===account.platform_account_id&&p.evidence_kind==='real_platform'&&date(p.collected_at))profiles.push(p);}catch{}}
  if(profile&&profile.evidence_kind==='real_platform'&&!profiles.some(p=>p.collected_at===profile.collected_at))profiles.push(profile as unknown as JsonObject);
  const accountCaptures:JsonObject[]=[];for(const row of db.prepare('SELECT * FROM account_snapshots WHERE workspace_id=? AND account_id=? ORDER BY collected_at,id').all(w,accountId)){
   const link=db.prepare("SELECT locator FROM evidence_links WHERE workspace_id=? AND owner_type='account_snapshot' AND owner_id=? ORDER BY id LIMIT 1").get(w,row.id);let locator:JsonObject={};try{locator=link?obj(JSON.parse(String(link.locator))):{};}catch{}
   const metrics=db.prepare('SELECT m.definition_id,m.value,m.availability,m.reason,d.key,d.unit,d.scope,d.definition_version FROM account_metric_values m JOIN metric_definitions d ON d.workspace_id=m.workspace_id AND d.id=m.definition_id WHERE m.workspace_id=? AND m.account_snapshot_id=? ORDER BY d.id').all(w,row.id);
   accountCaptures.push({...row,raw_sha256:locator.raw_sha256??null,evidence_kind:locator.evidence_kind??null,metrics} as JsonObject);
  }
  const repeated=[...new Set(allCaptures.map(c=>String(c.work_id)))].filter(id=>new Set(allCaptures.filter(c=>c.work_id===id).map(c=>String(c.collected_at))).size>=2);
  const validCapture=(capture:JsonObject,scope:'work'|'account')=>{
   const observed=date(capture.observed_at),collected=date(capture.collected_at);if(capture.observed_time_basis==='unknown'||!observed||!collected||Date.parse(observed)>Date.parse(collected)||typeof capture.raw_sha256!=='string')return false;
   if(scope==='account')return capture.evidence_kind==='real_platform';
   const published=eligible.find(e=>e.sample.work_id===capture.work_id)?.sample.published_at;return !!published&&Date.parse(observed)>=Date.parse(published)&&Math.floor((Date.parse(observed)-Date.parse(published))/1000)===capture.observed_age_s;
  };
  const findPair=(captures:JsonObject[],scope:'work'|'account'):JsonObject[]=>{
   const valid=captures.filter(c=>validCapture(c,scope));for(let i=0;i<valid.length;i++)for(const b of valid.slice(i+1)){const a=valid[i]!;if(a.observed_at===b.observed_at||a.raw_sha256===b.raw_sha256||a.adapter_version!==b.adapter_version)continue;
    const matches=(a.metrics as JsonObject[]).filter(m=>m.availability==='available'&&count(m.value)!==null&&m.scope===scope&&(scope==='account'?m.key==='followers':['views','plays'].includes(String(m.key))));
    if(matches.some(m=>(b.metrics as JsonObject[]).some(other=>other.definition_id===m.definition_id&&other.availability==='available'&&count(other.value)!==null)))return [a,b];
   }return [];
  };
  const workPairs=repeated.map(id=>findPair(allCaptures.filter(c=>c.work_id===id),'work')).filter(pair=>pair.length),knownWorkPairs=workPairs.map(pair=>String(pair[0]!.work_id));
  const accountPair=findPair(accountCaptures,'account'),knownAccountPairs=!!accountPair.length;
  const videos=selected.filter(e=>e.sample.format==='short_video'),transcribed=videos.filter(e=>['platform_caption','transcript'].includes(e.sample.content_basis));
  const limitations=['当前收录不是完整账号历史；频率只能描述已收录时间窗。','主题、发布时间和受众可能影响互动；样本差异不证明内容写法导致增长。','受众与咨询转化须有真实评论、本人数据或业务询问佐证；对标粉丝不等于本人受众。'];
  if(videos.length>transcribed.length)limitations.push('部分视频只有说明，不能据此拆完整口播、表演、镜头与节奏；需先补转写。');
  if(!comparableGroups.length)limitations.push('缺少同形式、同指标定义、真实发布后观察窗口的足量样本，不按互动值判定好坏。');
  if(!knownAccountPairs)limitations.push('尚无两次可比的账号观察快照；资料采集差值不能当作平台增粉实绩或创作因果。');
  const coverage:AccountResearchPlan['coverage']={eligible_count:eligible.length,sample_count:selected.length,excluded_count:excluded,full_text_count:selected.filter(e=>e.sample.content_basis==='full_text').length,video_count:videos.length,transcribed_video_count:transcribed.length,transcription_rate:videos.length?transcribed.length/videos.length:null,window_start:selected.map(e=>e.sample.published_at).filter((v):v is string=>!!v).sort()[0]??null,window_end:selected.map(e=>e.sample.published_at).filter((v):v is string=>!!v).sort().at(-1)??null,window_days:30};
  const trends:AccountResearchPlan['trends']={account:knownAccountPairs?'comparable':profiles.length>=2||accountCaptures.length>=2?'captures_only':'insufficient',works:knownWorkPairs.length?'comparable':repeated.length?'captures_only':'insufficient',profile_capture_count:profiles.length,account_snapshot_count:accountCaptures.length,repeated_work_count:repeated.length,reason:'只对相同身份、同指标定义和真实观察时点作描述性变化；collected_at 只标识采集，不替代 observed_at。'};
  const outputContract=ACCOUNT_RESEARCH_RESPONSE_SCHEMAS.AccountResearchReport!,contractHash=sha256(canonicalJson(outputContract));
  const version=sha256(canonicalJson({strategy_version:ACCOUNT_RESEARCH_VERSION,output_contract_sha256:contractHash,account,skill_fingerprint:skillFingerprint,corpus_scope:corpusScope,corpus:eligible.map(e=>({id:e.sample.source_id,hash:e.signature,published_at:e.sample.published_at})),selected:selected.map(e=>e.sample),profiles,allCaptures,accountCaptures}));
  const plan:AccountResearchPlan={account_id:accountId,strategy_version:ACCOUNT_RESEARCH_VERSION,input_version:version,source_record_ids:selected.map(e=>e.sample.source_id),samples:selected.map(e=>e.sample),coverage,comparisons:{status:comparableGroups.length?'available':'insufficient',groups:comparableGroups.length,reason:'近期同形式、同指标版本和目标窗口；实际发布后时长须在目标的 5% 内且至多差 1 小时，每组至少 4 篇并有数值差异。高低是观察值标签，不是质量或因果结论。'},trends,skill:local?{id:local.id,name:local.name,sha256:local.sha256}:null,limitations,blocked:account.identity_status!=='confirmed'?'先核对账号与作品身份':!local?'本地 personal-ip-operations 研究技能不可用':!selected.length?'尚无可读且已核对的账号作品':null};
  const evidence=selected.length?evidenceFromSources(this.context,request,plan.source_record_ids):[];
  for(const entry of selected){const source=evidence.find(e=>e.key==='source:'+entry.sample.source_id)!;source.data={...source.data,...entry.data};source.sha256=sha256(canonicalJson(source.data));}
  const snapshotIds=[...new Set([...selected.flatMap(e=>e.sample.snapshot_id?[e.sample.snapshot_id]:[]),...workPairs.slice(0,6).flatMap(pair=>pair.map(c=>String(c.id)))])];
  for(const id of snapshotIds){const e=snapshotEvidence(this.context,request,[id])[0]!,capture=allCaptures.find(c=>c.id===id)!;e.data={...e.data,...capture};e.sha256=sha256(canonicalJson(e.data));evidence.push(e);}
  for(const p of profiles.slice(-4)){const data={...p,observed_at:null,observed_time_basis:'unknown',content_semantics:'账号资料采集值，非平台观察时点'} as JsonObject;evidence.push({key:'account:'+accountId+':profile:'+sha256(canonicalJson(p)).slice(0,16),kind:'account',id:accountId,url:String(account.canonical_url),sha256:sha256(canonicalJson(data)),data});}
  const fixedAccountCaptures=[...new Map([...accountPair,...accountCaptures.slice(-2)].map(c=>[String(c.id),c])).values()];
  for(const p of fixedAccountCaptures){if(typeof p.raw_sha256!=='string')continue;const bytes=readFileSync(isAbsolute(String(p.raw_path))?String(p.raw_path):resolve(this.context.paths.state_root,String(p.raw_path)));if(sha256(bytes)!==p.raw_sha256)throw new ContractError('INPUT_STALE','账号快照原始响应 hash 不符');evidence.push({key:'account:'+accountId+':snapshot:'+p.id,kind:'account',id:accountId,url:String(account.canonical_url),sha256:sha256(canonicalJson(p)),data:p});}
  const summaryData={...plan,corpus_scope:corpusScope} as unknown as JsonObject,summary:ContentEvidence={key:'comparison:research-plan:'+version,kind:'comparison',id:version,url:null,sha256:sha256(canonicalJson(summaryData)),data:summaryData};evidence.push(summary);
  const parsed=typeof base.content==='string'?parseSkillMarkdown(base.content,'0.1.0'):null;
  const bindings:JsonObject=parsed?{writing_skills:[{name:parsed.name,version:parsed.version,sha256:base.sha256!,content:base.content!}],skill_route:{purpose:'research',source:'local_library',label:'个人 IP 运营 · 对标研究',skills:[parsed.name]}}:{};
  return {plan,evidence,skill,bindings,context:{schema_version:1,plan:plan as unknown as JsonObject,corpus_scope:corpusScope,output_contract:outputContract,output_contract_sha256:contractHash,evidence_keys:evidence.map(e=>e.key),goals:['AI 专业影响力','稳定高质量','涨粉','咨询与商单'],account:account as JsonObject,profile_captures:profiles,account_captures:accountCaptures,work_captures:allCaptures.filter(c=>selected.some(e=>e.sample.work_id===c.work_id)),skill_fingerprint:skillFingerprint}};
 }
 history(request:RequestContext,accountId:string):AccountResearchHistoryItem[]{
  assertRequestIdentity(this.context,request);const result:AccountResearchHistoryItem[]=[];
  const rows=this.context.db.prepare("SELECT j.*,d.id document_id,d.head_revision_id FROM documents d JOIN jobs j ON j.workspace_id=d.workspace_id AND (j.target_id=d.owner_entity_id OR j.target_id=d.id) AND json_extract(j.input_manifest,'$.targets[0].document_id')=d.id WHERE d.workspace_id=? AND d.owner_entity_id=? AND d.kind='account_research' AND json_extract(j.input_manifest,'$.content_purpose')='research' ORDER BY j.created_at DESC,j.id DESC LIMIT 30").all(request.workspace_id,accountId);
  for(const row of rows){const manifest=obj(JSON.parse(String(row.input_manifest)));if(manifest.content_purpose!=='research'||!Array.isArray(manifest.targets)||!manifest.targets.some(t=>obj(t).document_id===row.document_id))continue;
   const candidate=this.context.db.prepare('SELECT id,status,revision_id,adopted_revision_id FROM candidates WHERE workspace_id=? AND target_document_id=? AND job_id=? ORDER BY created_at DESC,id LIMIT 1').get(request.workspace_id,row.document_id,row.id);
   const frozen=obj(manifest.research_context),plan=obj(frozen.plan),skill=obj(obj(manifest.research_skill).base_local_skill),agent=obj(manifest.service_agent),policy=obj(agent.execution_policy);
   const attempt=this.context.db.prepare('SELECT checkpoint,error FROM job_attempts WHERE workspace_id=? AND job_id=? ORDER BY attempt_no DESC LIMIT 1').get(request.workspace_id,row.id);let actual:JsonObject={},error:string|null=null;
   try{const checkpoint=obj(JSON.parse(String(attempt?.checkpoint??'{}'))),handle=obj(checkpoint.agent_handle);actual=obj(handle.checkpoint);const failure=obj(JSON.parse(String(attempt?.error??'{}')));error=typeof failure.message==='string'?failure.message:null;}catch{}
   result.push({document_id:String(row.document_id),job_id:String(row.id),created_at:String(row.created_at),state:String(row.state),version:Number(row.version),executor:row.executor_id as ContentExecutor,input_version:typeof plan.input_version==='string'?plan.input_version:null,source_ids:Array.isArray(manifest.source_ids)?manifest.source_ids as string[]:[],candidate_id:candidate?String(candidate.id):null,candidate_status:candidate?String(candidate.status):null,revision_id:candidate?String(candidate.revision_id):row.head_revision_id as string|null,adopted_revision_id:candidate?.adopted_revision_id as string|null??null,skill_name:typeof skill.name==='string'?skill.name:null,skill_sha256:typeof skill.sha256==='string'?skill.sha256:null,model:typeof actual.model==='string'?actual.model:typeof policy.model==='string'?policy.model:null,reasoning_effort:typeof obj(actual.execution_policy).reasoning_effort==='string'?String(obj(actual.execution_policy).reasoning_effort):typeof policy.reasoning_effort==='string'?policy.reasoning_effort:null,error,coverage:plan.coverage as unknown as AccountResearchPlan['coverage']??null});
  }return result.slice(0,30);
 }
 async get(request:RequestContext,accountId:string):Promise<AccountResearchView>{
  assertRequestIdentity(this.context,request);if(!this.context.db.prepare("SELECT id FROM accounts WHERE workspace_id=? AND id=? AND role='benchmark'").get(request.workspace_id,accountId))throw new ContractError('NOT_FOUND','对标账号不存在');
  const history=this.history(request,accountId);try{const frozen=await this.freeze(request,accountId);return {plan:frozen.plan,history};}catch(error){
   // 当前采集资料损坏只阻止新研究，历史按既有任务的冻结输入和修订继续读取。
   if(error instanceof ContractError&&['IDENTITY_MISMATCH','VALIDATION_ERROR','NOT_FOUND'].includes(error.code))throw error;
   const message=error instanceof ContractError?error.message:'当前材料或原始响应无法核对，先修复资料后再研究';
   const row=history[0]?this.context.db.prepare('SELECT input_manifest FROM jobs WHERE workspace_id=? AND id=?').get(request.workspace_id,history[0].job_id):null,manifest=row?obj(JSON.parse(String(row.input_manifest))):{},prior=obj(obj(manifest.research_context).plan);
   const empty:AccountResearchPlan={account_id:accountId,strategy_version:ACCOUNT_RESEARCH_VERSION,input_version:sha256(canonicalJson({accountId,message})),source_record_ids:[],samples:[],coverage:{eligible_count:0,sample_count:0,excluded_count:0,full_text_count:0,video_count:0,transcribed_video_count:0,transcription_rate:null,window_start:null,window_end:null,window_days:30},comparisons:{status:'insufficient',groups:0,reason:'当前材料尚待核对'},trends:{account:'insufficient',works:'insufficient',profile_capture_count:0,account_snapshot_count:0,repeated_work_count:0,reason:'当前材料尚待核对'},skill:null,limitations:['当前材料尚待核对，不能开始新研究；历史报告保留。'],blocked:message};
   const plan=typeof prior.input_version==='string'?{...prior as unknown as AccountResearchPlan,blocked:message,limitations:[...(prior.limitations as string[]),'以下范围来自历史报告，当前材料尚待核对。']}:empty;return {plan,history};
  }
 }
 existing(request:RequestContext,accountId:string,executionFingerprint:string,executor:ContentExecutor):{job_id:string;document_id:string}|null {
  assertRequestIdentity(this.context,request);
  // 查重匹配完整任务集；history 的 30 条仅用于展示，改稿/新报告不能挤掉幂等身份。
  const row=this.context.db.prepare("SELECT j.id job_id,d.id document_id FROM documents d JOIN jobs j ON j.workspace_id=d.workspace_id AND (j.target_id=d.owner_entity_id OR j.target_id=d.id) AND json_extract(j.input_manifest,'$.targets[0].document_id')=d.id WHERE d.workspace_id=? AND d.owner_entity_id=? AND d.kind='account_research' AND json_extract(j.input_manifest,'$.content_purpose')='research' AND j.executor_id=? AND j.state!='cancelled' AND json_extract(j.input_manifest,'$.research_execution_fingerprint')=? ORDER BY j.created_at DESC,j.id DESC LIMIT 1").get(request.workspace_id,accountId,executor,executionFingerprint);
  return row?{job_id:String(row.job_id),document_id:String(row.document_id)}:null;
 }
}

export const ACCOUNT_RESEARCH_INSTRUCTION=`依据 research_context 和 research_skill 的冻结技能完成账号研究，报告正文 documents[].text 必须是 AccountResearchReport 的 JSON 字符串，不写 Markdown 或过程。
schema_version=1；summary 写关键发现；facts 每项 text/evidence_keys；analyses 每项 dimension(structure/expression/operations/audience/trends)、status(supported/insufficient)、text、evidence_keys，五个维度均须覆盖。structure 拆开头承诺、论述/步骤、证据、结果、CTA；expression 拆标题、语气、信息密度与可复制表达；operations 依据 corpus_scope 的完整已收录时间线拆频率、栏目线索与系列，再用样本正文拆主页/CTA/商业承接；标题线索不能冒称其余作品全文；audience 只按可见问题/评论/简介作判断；trends 严格依 plan.trends 的可比状态。
samples 每项 source_id、polarity(positive/negative/contrast)、aspect、analysis_scope(written_text/video_description/spoken_text)、performance_claim(comparable/not_comparable)、text、evidence_keys：拆至少两条不同作品的具体原句/结构。正负是表达机制的分析，低互动不能等于差稿；仅 comparison_group 有值的样本可写 comparable，且同组对照。视频 description_only 只能研究说明/选题，不能声称已听完整口播或看到镜头表演。引用内容明确归属，不把被引作者的正文当本账号原话。
hypotheses 每项 text/evidence_keys/missing_evidence；recommendations 每项 goal(professional_influence/consistent_quality/followers/consulting)、text、evidence_keys、action、prerequisite、measurement、adoption_status=proposed，四目标均覆盖。建议给本人可尝试的一次改动、完成成本与条件、下一篇怎样观察，不照抄账号设定或虚构咨询产品。无本人结果时说候选方法。
limitations 保留 plan.limitations 并补研究缺口。所有 evidence_keys 仅取 research_context.evidence_keys，事实必须有固定引用；样本必须引用 source:本条ID。样本数量、时间窗、转写率由 plan 冻结，不重算不改写；采集时间不替代指标观察时间，无两次真实可比快照不宣称增粉或趋势，任何对照不证明创作因果。只返回已有 documents/recommendations 输出 schema。`;
