import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ContractError, emptyTopicOperations, SaveTopicOperationsSchema, EnsureTopicOperationsSchema, DecideTopicOperationsSchema, validateOperationsCandidate, DEFAULT_WRITING_EXECUTION, type RequestContext, type SaveTopicOperationsRequest, type TopicOperationsSnapshot, type TopicOperations, type OperationsCandidateView, type OperationsFollowupProposal, type EnsureTopicOperationsRequest, type DecideTopicOperationsRequest, type ReaderFeedback, type JsonObject, type Platform, type DocumentSnapshot, type SaveRevisionResponse } from '@workbench/contracts';
import type { ApplicationContext, ReaderFeedbackPort } from '../ports/index.ts';
import { Documents, assertRequestIdentity } from '../documents/index.ts';
import { readCommittedIdempotent, storeIdempotent, getDocumentRow, getRevisionRow } from '@workbench/storage/revisions';
import { transaction, canonicalJson, sha256 } from '@workbench/storage/connection';
import { workspaceSettings } from '@workbench/storage/settings';
import { parseRevision } from '@workbench/storage/files';
import { ContentGeneration, sourceEvidence, type ContentEvidence } from '../content-agents/index.ts';
import { SkillLibrary } from '../skills/library.ts';
import { Jobs } from '../jobs/index.ts';
import { Topics } from './index.ts';

interface OperationsRun { external_version:string;source_version:string;input_version:string;base_revision_id:string|null;document_id:string|null;job_id:string|null;feedback:ReaderFeedback[];feedback_status:string;limitations:string[];blocked:string|null;decision:'confirm'|'reject'|null;candidate_id:string|null;pending?:{data:TopicOperations;proposals:OperationsFollowupProposal[];source_ids:string[];saved:boolean;linked:string[]};error:string|null }
interface OperationsInputs { version:string;topic:JsonObject;core:JsonObject;sources:ContentEvidence[];works:Array<{id:string;platform:Platform;url:string;platform_item_id:string|null}>;limitations:string[] }
const runKey=(workspace:string,topic:string)=>'topic-operations.automation.v1:'+workspace+':'+topic;
const inputKey=(workspace:string,topic:string,input:string)=>'topic-operations.input.v1:'+workspace+':'+topic+':'+input;
const locks=new Map<string,Promise<unknown>>();
async function serial<T>(key:string,action:()=>Promise<T>):Promise<T>{const before=locks.get(key)??Promise.resolve();const next=before.catch(()=>{}).then(action);locks.set(key,next);try{return await next;}finally{if(locks.get(key)===next)locks.delete(key);}}

// 运营记录沿用主服务的文稿、不可变修订与版本检查；不建立第二份运营存储。
export class TopicOperationsStore {
  readonly documents:Documents;
  readonly context:ApplicationContext;
  readonly skillLibrary:SkillLibrary;readonly feedbackPort:ReaderFeedbackPort|undefined;
  constructor(context:ApplicationContext,options:{skill_library?:SkillLibrary;feedback?:ReaderFeedbackPort}={}) { this.context=context;this.documents=new Documents(context);this.skillLibrary=options.skill_library??new SkillLibrary(context);this.feedbackPort=options.feedback??context.reader_feedback; }
  private readRevision(request:RequestContext,documentId:string,revisionId:string):{text:string;hash:DocumentSnapshot['hash']} {
    const row=getRevisionRow(this.context.db,request.workspace_id,revisionId,documentId),identity={workspace_id:request.workspace_id,document_id:documentId,revision_id:revisionId};
    this.documents.files.validateRevisionPath(row.file_path,identity);
    let bytes:Buffer;try{bytes=readFileSync(row.file_path);}catch{throw new ContractError('STORAGE_UNAVAILABLE','固定运营材料缺失，请先恢复文稿后重试');}
    if(sha256(bytes)!==row.sha256)throw new ContractError('STORAGE_UNAVAILABLE','固定运营材料已被修改，请先恢复文稿后重试');
    const parsed=parseRevision(bytes.toString('utf8'));if(parsed.metadata.workspace_id!==identity.workspace_id||parsed.metadata.document_id!==documentId||parsed.metadata.revision_id!==revisionId)throw new ContractError('STORAGE_UNAVAILABLE','固定运营材料身份不符');
    return {text:parsed.text,hash:row.sha256 as DocumentSnapshot['hash']};
  }
  private readDocument(request:RequestContext,id:string):DocumentSnapshot {
    const row=getDocumentRow(this.context.db,request.workspace_id,id);
    if(!row.head_revision_id)return {document_id:id,head_revision_id:null,version:row.version,text:'',hash:null,save_state:'empty'};
    return {document_id:id,head_revision_id:row.head_revision_id,version:row.version,...this.readRevision(request,id,row.head_revision_id),save_state:'committed'};
  }
  private documentId(request:RequestContext,topicId:string):string|null {
    assertRequestIdentity(this.context,request);
    if(!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,topicId))throw new ContractError('NOT_FOUND','主题不存在');
    const row=this.context.db.prepare("SELECT id FROM documents WHERE workspace_id=? AND owner_entity_id=? AND kind='topic_operations' ORDER BY created_at,id LIMIT 1").get(request.workspace_id,topicId);
    return row?String(row.id):null;
  }
  private async record(request:RequestContext,topicId:string):Promise<TopicOperationsSnapshot> {
    const id=this.documentId(request,topicId);
    if(!id)return {topic_id:topicId,document:null,data:emptyTopicOperations()};
    const document=this.readDocument(request,id);
    let data:SaveTopicOperationsRequest['data'];
    try{data=JSON.parse(document.text);SaveTopicOperationsSchema.parse({expected_revision_id:document.head_revision_id,data});}
    catch{throw new ContractError('STORAGE_UNAVAILABLE','运营记录无法读取，请保留当前输入');}
    return {topic_id:topicId,document,data};
  }
  private run(request:RequestContext,topicId:string):OperationsRun|null {const row=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(runKey(request.workspace_id,topicId));return row?JSON.parse(String(row.value)):null;}
  private persist(request:RequestContext,topicId:string,run:OperationsRun):void {const put=this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');put.run(runKey(request.workspace_id,topicId),canonicalJson(run));if(run.input_version)put.run(inputKey(request.workspace_id,topicId,run.input_version),canonicalJson(run));}
  private async inputs(request:RequestContext,topicId:string):Promise<OperationsInputs> {
    this.documentId(request,topicId);const db=this.context.db,row=db.prepare('SELECT id,title,category,audience,angle,core_document_id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,topicId)!;
    const core=this.readDocument(request,String(row.core_document_id)),limitations:string[]=[],sources:ContentEvidence[]=[];
    for(const source of db.prepare('SELECT source_record_id FROM topic_sources WHERE workspace_id=? AND topic_id=? ORDER BY source_record_id').all(request.workspace_id,topicId)){try{sources.push(...sourceEvidence(this.context,request,[String(source.source_record_id)]));}catch{limitations.push('部分已关联资料没有可读取正文，不能据此补造细节');}}
    const works=db.prepare("SELECT w.id,w.platform,w.url,w.platform_work_id FROM works w JOIN accounts a ON a.workspace_id=w.workspace_id AND a.id=w.account_id WHERE w.workspace_id=? AND w.topic_id=? AND w.published_at IS NOT NULL AND w.identity_status='confirmed' AND a.identity_status='confirmed' AND a.role='owner' AND w.url LIKE 'https://%' ORDER BY w.id").all(request.workspace_id,topicId).map(work=>({id:String(work.id),platform:work.platform as Platform,url:String(work.url),platform_item_id:work.platform_work_id as string|null}));
    if(!works.length)limitations.push('当前主题尚无已绑定且已核对的本人发布作品，读者反馈合法为空');
    const topic={id:row.id,title:row.title,category:row.category,audience:row.audience,angle:row.angle} as JsonObject,coreInput={document_id:core.document_id,revision_id:core.head_revision_id,text:core.text} as JsonObject;
    return {version:sha256(canonicalJson({topic,core:coreInput,sources,works})),topic,core:coreInput,sources,works,limitations:[...new Set(limitations)]};
  }
  private async candidate(request:RequestContext,run:OperationsRun):Promise<OperationsCandidateView|null> {
    if(!run.document_id||!run.job_id)return null;
    const row=this.context.db.prepare('SELECT * FROM candidates WHERE workspace_id=? AND target_document_id=? AND job_id=? ORDER BY created_at DESC,id DESC LIMIT 1').get(request.workspace_id,run.document_id,run.job_id);if(!row)return null;
    const preview=this.readRevision(request,run.document_id,String(row.revision_id));
    let value:unknown;try{value=JSON.parse(preview.text);}catch{throw new ContractError('VALIDATION_ERROR','运营候选无法读取为固定 JSON');}
    const manifest=JSON.parse(String(this.context.db.prepare('SELECT input_manifest FROM jobs WHERE workspace_id=? AND id=?').get(request.workspace_id,run.job_id)!.input_manifest));
    return {id:String(row.id),status:run.decision==='confirm'?'adopted':run.decision==='reject'?'rejected':row.status as OperationsCandidateView['status'],base_operations_revision_id:run.base_revision_id,data:validateOperationsCandidate(value,run.feedback.map(f=>f.id),manifest.operations_context.evidence_keys),feedback:run.feedback};
  }
  // GET 只投影持久状态，不创建任务、不采集评论，也不恢复写入。
  async get(request:RequestContext,topicId:string):Promise<TopicOperationsSnapshot> {
    const current=await this.record(request,topicId),inputs=await this.inputs(request,topicId),run=this.run(request,topicId);
    if(!run)return {...current,automation:{source_version:inputs.version,input_version:inputs.version,state:'missing',job_id:null,job_version:null,candidate:null,limitations:inputs.limitations,feedback_status:inputs.works.length?'待采集':'尚无本人发布作品',error:null}};
    const detail=run.job_id?new Jobs(this.context).get(request,run.job_id):null,candidate=await this.candidate(request,run);
    const changed=inputs.version!==run.external_version||(!run.decision&&(current.document?.head_revision_id??null)!==run.base_revision_id);
    const state=run.pending&&(!run.pending.saved||run.pending.linked.length<run.pending.proposals.length)?run.error?'failed':'candidate':run.decision==='confirm'?'confirmed':run.decision==='reject'?'rejected':changed?'stale':run.blocked?'blocked':candidate?'candidate':detail?.job.state==='succeeded'?'failed':(['queued','running','waiting_input','waiting_quota','failed'].includes(detail?.job.state??'')?detail!.job.state:'failed');
    return {...current,automation:{source_version:run.source_version,input_version:run.input_version,state:state as NonNullable<TopicOperationsSnapshot['automation']>['state'],job_id:run.job_id,job_version:detail?.job.version??null,candidate,limitations:[...new Set([...run.limitations,...(candidate?.data.limitations??[])])],feedback_status:run.feedback_status,error:run.error??run.blocked??(detail?.error?String(detail.error.message??detail.error.code??'任务未完成'):null)}};
  }
  ensure(request:RequestContext,topicId:string,input:EnsureTopicOperationsRequest={}):Promise<TopicOperationsSnapshot> {
    EnsureTopicOperationsSchema.parse(input);return serial(runKey(request.workspace_id,topicId),async()=>{
      const current=await this.record(request,topicId),inputs=await this.inputs(request,topicId),old=this.run(request,topicId),rerunRejected=input.retry===true&&old?.decision==='reject',rerunCancelled=input.retry===true&&!!old?.job_id&&new Jobs(this.context).get(request,old.job_id).job.state==='cancelled';
      if(old?.pending){await this.resumeDecision(request,topicId,old);return this.get(request,topicId);}
      if(old&&old.external_version===inputs.version&&!input.refresh_feedback&&!old.blocked&&!rerunRejected&&!rerunCancelled){
        if(input.retry&&old.job_id&&!old.decision){const job=new Jobs(this.context).get(request,old.job_id).job;if(['failed','waiting_input','waiting_quota'].includes(job.state)){new Jobs(this.context).resume({...request,idempotency_key:'operations-retry:'+old.job_id+':'+job.version},old.job_id,{expected_version:job.version});return this.get(request,topicId);}}
        if(old.decision||old.base_revision_id===(current.document?.head_revision_id??null))return this.get(request,topicId);
        if(old.job_id&&['queued','running'].includes(new Jobs(this.context).get(request,old.job_id).job.state))return this.get(request,topicId);
      }
      // 作品未变时复用已采集原文；显式刷新才重新读取平台，刷新时间不参与内容 hash。
      const feedback=new Map<string,ReaderFeedback>(current.data.feedback.map(f=>[f.id,f]));let feedbackStatus=inputs.works.length?'尚未接通评论采集':'尚无本人发布作品',limitations=[...inputs.limitations];
      if(old)for(const f of old.feedback)if(!feedback.has(f.id)&&(f.provenance!=='platform'||inputs.works.some(work=>work.id===f.work_id)))feedback.set(f.id,f);
      if(old&&old.external_version===inputs.version&&!input.refresh_feedback){feedbackStatus=old.feedback_status;limitations.push(...old.limitations);}
      else if(inputs.works.length&&this.feedbackPort){const results=await Promise.all(inputs.works.map(async work=>{try{return await this.feedbackPort!.collect(work);}catch{return {status:'unavailable' as const,feedback:[],limitations:['评论采集失败，保留已采集反馈；可稍后刷新']};}}));for(const result of results){limitations.push(...result.limitations);for(const f of result.feedback)if(f.provenance==='platform'&&f.work_id&&inputs.works.some(w=>w.id===f.work_id)&&f.platform_comment_id&&f.text.trim())feedback.set(f.id,feedback.get(f.id)??f);}feedbackStatus=results.some(r=>r.status==='unavailable')?'部分作品评论暂不可读取':results.every(r=>r.status==='unsupported')?'当前平台尚未支持评论采集':feedback.size?'已读取真实反馈':'已采集，暂无读者评论';}
      else if(inputs.works.length)limitations.push('评论采集入口未配置，不能用对标互动替代本人读者反馈');
      if(feedback.size>1000)limitations.push('本轮最多保留1000条反馈，优先保留已确认原文，剩余评论待后续整理');const raw=[...feedback.values()].slice(0,1000).sort((a,b)=>a.id.localeCompare(b.id)),sourceVersion=sha256(canonicalJson({external:inputs.version,feedback:raw.map(({recorded_at,kind,...f})=>f)}));
      if(old&&old.source_version===sourceVersion&&old.external_version===inputs.version&&!old.blocked&&!rerunRejected&&!rerunCancelled&&(old.decision||old.base_revision_id===(current.document?.head_revision_id??null))){old.feedback_status=feedbackStatus;old.limitations=[...new Set(limitations)];transaction(this.context.db,()=>this.persist(request,topicId,old));return this.get(request,topicId);}
      const run:OperationsRun={external_version:inputs.version,source_version:sourceVersion,input_version:'',base_revision_id:current.document?.head_revision_id??null,document_id:null,job_id:null,feedback:raw,feedback_status:feedbackStatus,limitations:[...new Set(limitations)],blocked:null,decision:null,candidate_id:null,error:null};
      const executor=workspaceSettings(this.context.db,request.workspace_id).default_executor;let frozen:JsonObject;
      try{const skill=this.skillLibrary.get(request).skills.find(s=>s.name==='personal-ip-operations');if(!skill)throw new ContractError('CAPABILITY_UNVERIFIED','缺少个人 IP 运营技能，安装后重新整理');frozen=await this.skillLibrary.freeze(request,{instruction:'根据当前主题自动补齐运营候选',samples:'',purpose:'report',base_local_skill:{id:skill.id,sha256:skill.sha256}});const health=(await this.context.getExecutorHealth({wait_for:executor})).find(item=>item.executor_id===executor);if(!['supported','unverified'].includes(health?.status??'')||!['subscription','chatgpt_subscription','claude_subscription'].includes(health?.billing_route??''))throw new ContractError('CAPABILITY_UNVERIFIED','订阅执行器尚未就绪，请先完成连接后重试');}
      catch(error){run.blocked=error instanceof Error?error.message:'运营技能或订阅执行器不可用';run.input_version=sha256(canonicalJson({sourceVersion,base:run.base_revision_id,blocked:run.blocked}));transaction(this.context.db,()=>this.persist(request,topicId,run));return this.get(request,topicId);}
      run.input_version=sha256(canonicalJson({sourceVersion,base:run.base_revision_id,skill:frozen,rerun_of:rerunRejected?old?.candidate_id:rerunCancelled?old?.job_id:null}));
      transaction(this.context.db,()=>{
        const live=this.run(request,topicId);if(live?.input_version===run.input_version&&!live.blocked)return;
        const earlier=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(inputKey(request.workspace_id,topicId,run.input_version));if(earlier){const prior=JSON.parse(String(earlier.value)) as OperationsRun;if(!prior.blocked){prior.feedback_status=run.feedback_status;prior.limitations=run.limitations;this.persist(request,topicId,prior);return;}}
        const recordId=this.documentId(request,topicId),head=recordId?this.context.db.prepare('SELECT head_revision_id FROM documents WHERE workspace_id=? AND id=?').get(request.workspace_id,recordId)!.head_revision_id:null;if(head!==run.base_revision_id)throw new ContractError('REVISION_CONFLICT','运营记录在自动整理前已变化，请重新打开');
        run.document_id=randomUUID();this.context.db.prepare("INSERT INTO documents(id,workspace_id,kind,owner_entity_id,version) VALUES (?,?,'topic_operations_candidate',?,1)").run(run.document_id,request.workspace_id,topicId);
        const evidenceKeys=['topic:'+topicId,...(inputs.core.revision_id?['core:'+String(inputs.core.revision_id)]:[]),...inputs.sources.map(s=>s.key),...inputs.works.map(w=>'work:'+w.id),...raw.map(f=>'feedback:'+f.id)];
        const operationsContext={topic:inputs.topic,core:inputs.core,confirmed_operations:current.data,feedback:raw,evidence_keys:evidenceKeys,limitations:run.limitations,base_operations_revision_id:run.base_revision_id,source_version:run.source_version};
        const instruction='依据冻结的 personal-ip-operations 技能及参考文件，为当前主题整理运营候选。技能中的 Vault 路径和主页只作历史工作方法，本任务只能读取 input_manifest.operations_context 与 input_evidence，禁止扫描外部 Vault。以读者要完成的任务、实际卡点、本人新增帮助组织简报；保留 confirmed_operations 中人工写好的事实和判断，没有材料就留空并在 limitations 写明最小补证动作。不能编造受众已验证、本人实测、发布、指标或评论。feedback_labels 只分类当前真实 feedback，保留原文，不生成新评论，作者自答与泛赞不作为需求验证；没有反馈允许为空。followups 最多推荐3条，可合法为空，每条说明与本题不同的新增帮助，并给 evidence_keys 中真实支持依据；没有本人新增价值就不给后续题。所有内容待本人确认，不能创建主题或确认发布。documents[].text 必须为 JSON 字符串，结构 '+JSON.stringify({schema_version:1,brief:emptyTopicOperations().brief,feedback_labels:[{id:'固定真实反馈id',kind:'question'}],followups:[{id:'proposal-1',title:'候选题目',new_help:'具体新增帮助与完成条件',evidence_keys:['本次固定依据key']}],limitations:['缺口与补证动作']})+'。这不是文章正文，不插入引用格式或代码围栏。';
        run.job_id=new ContentGeneration(this.context).enqueueInTransaction(request,'document_modify',topicId,executor,'candidate',[{document_id:run.document_id,base_revision_id:null,core_revision_id:null}],inputs.sources,instruction,{content_purpose:'operations',operations_generation:true,execution_policy:structuredClone(DEFAULT_WRITING_EXECUTION) as unknown as JsonObject,operations_skill:frozen,operations_context:operationsContext as unknown as JsonObject},{}).job_id;
        this.persist(request,topicId,run);
      });return this.get(request,topicId);
    });
  }
  decide(request:RequestContext,topicId:string,input:DecideTopicOperationsRequest):Promise<TopicOperationsSnapshot>{
    DecideTopicOperationsSchema.parse(input);return serial(runKey(request.workspace_id,topicId),async()=>{
      const replay=readCommittedIdempotent<TopicOperationsSnapshot>(this.context.db,request,'operations.decide:'+topicId,input);if(replay)return replay;
      const run=this.run(request,topicId),current=await this.record(request,topicId),candidate=run?await this.candidate(request,run):null;
      if(!run||!candidate||candidate.id!==input.candidate_id)throw new ContractError('NOT_FOUND','候选不属于当前主题或已被新输入替代');
      if(run.decision){if(run.decision!==input.decision)throw new ContractError('REVISION_CONFLICT','候选已经决定，不能倒改确认');if(run.pending)await this.resumeDecision(request,topicId,run);return this.get(request,topicId);}
      if((current.document?.head_revision_id??null)!==input.expected_revision_id||run.base_revision_id!==input.expected_revision_id||(await this.inputs(request,topicId)).version!==run.external_version)throw new ContractError('REVISION_CONFLICT','运营记录或所用材料已变化，当前输入保留，请重新整理');
      if(input.decision==='reject'){run.decision='reject';run.candidate_id=candidate.id;transaction(this.context.db,()=>{this.context.db.prepare("UPDATE candidates SET status='rejected' WHERE workspace_id=? AND id=?").run(request.workspace_id,candidate.id);this.persist(request,topicId,run);});return this.get(request,topicId);}
      const feedbackIds=input.feedback_ids??candidate.feedback.filter(f=>!f.is_author).map(f=>f.id);if(feedbackIds.some(id=>!candidate.feedback.some(f=>f.id===id)))throw new ContractError('VALIDATION_ERROR','只能确认本次真实反馈');
      const proposals=input.followups??candidate.data.followups;if(proposals.some(p=>!candidate.data.followups.some(c=>c.id===p.id)))throw new ContractError('VALIDATION_ERROR','只能确认本轮已有后续建议');const keys=JSON.parse(String(this.context.db.prepare('SELECT input_manifest FROM jobs WHERE workspace_id=? AND id=?').get(request.workspace_id,run.job_id)!.input_manifest)).operations_context.evidence_keys;
      validateOperationsCandidate({...candidate.data,brief:input.brief??candidate.data.brief,followups:proposals},candidate.feedback.map(f=>f.id),keys);
      const data=structuredClone(current.data);data.brief=input.brief??candidate.data.brief;const labels=new Map(candidate.data.feedback_labels.map(f=>[f.id,f.kind]));for(const f of candidate.feedback.filter(f=>feedbackIds.includes(f.id)))if(!data.feedback.some(old=>old.id===f.id))data.feedback.push({...f,kind:labels.get(f.id)??f.kind});data.confirmed_generation={candidate_id:candidate.id,source_version:run.source_version};
      run.decision='confirm';run.candidate_id=candidate.id;run.pending={data,proposals,source_ids:this.context.db.prepare('SELECT source_record_id FROM topic_sources WHERE workspace_id=? AND topic_id=? ORDER BY source_record_id').all(request.workspace_id,topicId).map(s=>String(s.source_record_id)),saved:false,linked:[]};transaction(this.context.db,()=>this.persist(request,topicId,run));
      await this.resumeDecision(request,topicId,run);const result=await this.get(request,topicId);transaction(this.context.db,()=>storeIdempotent(this.context.db,request,'operations.decide:'+topicId,input,result));return result;
    });
  }
  private async resumeDecision(request:RequestContext,topicId:string,run:OperationsRun):Promise<void>{
    if(!run.pending||!run.candidate_id)return;const pending=run.pending,candidateId=run.candidate_id;
    try{
      if(!pending.saved){await this.save({...request,idempotency_key:'ops-confirm:'+candidateId},topicId,{expected_revision_id:run.base_revision_id,data:pending.data});pending.saved=true;this.persist(request,topicId,run);}
      const row=this.context.db.prepare('SELECT category,audience FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,topicId)!;
      for(const proposal of pending.proposals){
        if(pending.linked.includes(proposal.id))continue;
        const next=await new Topics(this.context).create({...request,idempotency_key:'ops-followup:'+candidateId+':'+sha256(proposal.id)},{title:proposal.title,category:String(row.category),audience:String(row.audience),angle:proposal.new_help,source_ids:pending.source_ids});
        const current=await this.record(request,topicId);if(!current.data.followups.some(f=>f.topic_id===next.id)){const data=structuredClone(current.data);data.followups.push({topic_id:next.id,title:proposal.title,new_help:proposal.new_help,candidate_id:candidateId,proposal_id:proposal.id,source_version:run.source_version});await this.save({...request,idempotency_key:'ops-link:'+candidateId+':'+sha256(proposal.id+':'+current.document!.head_revision_id)},topicId,{expected_revision_id:current.document?.head_revision_id??null,data});}
        pending.linked.push(proposal.id);this.persist(request,topicId,run);
      }
      this.context.db.prepare("UPDATE candidates SET status='adopted',adoption_mode='manual',adopted_at=?,adopted_by=? WHERE workspace_id=? AND id=?").run(new Date().toISOString(),request.request_identity_ref??'human',request.workspace_id,candidateId);delete run.pending;run.error=null;this.persist(request,topicId,run);
    }catch(error){if(error instanceof ContractError&&error.code==='REVISION_CONFLICT'&&!pending.saved){run.decision=null;delete run.pending;}run.error=error instanceof Error?error.message:'确认后的选题建立中断，重新打开后继续';this.persist(request,topicId,run);throw error;}
  }
  async save(request:RequestContext,topicId:string,input:SaveTopicOperationsRequest):Promise<TopicOperationsSnapshot> {
    SaveTopicOperationsSchema.parse(input);this.documentId(request,topicId);
    const operation='topic-operations.save:'+topicId;
    const replay=readCommittedIdempotent<TopicOperationsSnapshot>(this.context.db,request,operation,input);if(replay)return replay;
    const text=JSON.stringify(JSON.parse(canonicalJson(input.data)),null,2),scoped={...request,idempotency_key:request.idempotency_key?request.idempotency_key+':document':null};
    // 底层修订提交与外层receipt之间可能崩溃。先恢复相同固定保存，不能把已完成的确认误判为旧版本覆盖。
    const created=input.expected_revision_id===null?readCommittedIdempotent<DocumentSnapshot>(this.context.db,scoped,'documents.create',{kind:'topic_operations',owner_entity_id:topicId,initial_text:text}):null;
    const currentId=this.documentId(request,topicId),saved=currentId&&input.expected_revision_id!==null?readCommittedIdempotent<SaveRevisionResponse>(this.context.db,scoped,'documents.save:'+currentId,{expected_revision_id:input.expected_revision_id,text,origin:'human'}):null;
    if(created||saved){
      let document=created!;
      if(saved){const read=this.readRevision(request,currentId!,saved.revision_id);document={document_id:currentId!,head_revision_id:saved.revision_id,version:saved.version,text:read.text,hash:saved.hash,save_state:'committed'};}
      const recovered={topic_id:topicId,document,data:input.data};transaction(this.context.db,()=>storeIdempotent(this.context.db,request,operation,input,recovered));return recovered;
    }
    const ids=new Set<string>();
    for(const feedback of input.data.feedback){
      if(ids.has(feedback.id)||!feedback.text.trim()||!Number.isFinite(Date.parse(feedback.recorded_at))||Date.parse(feedback.recorded_at)>Date.now())throw new ContractError('VALIDATION_ERROR','反馈内容、时间或标识无效');
      ids.add(feedback.id);
    }
    for(const next of input.data.followups){
      if(!next.title.trim()||!next.new_help.trim()||!this.context.db.prepare('SELECT id FROM topics WHERE workspace_id=? AND id=?').get(request.workspace_id,next.topic_id))throw new ContractError('VALIDATION_ERROR','后续选题需关联已有主题并说明新增帮助');
    }
    const current=await this.record(request,topicId);
    if((current.document?.head_revision_id??null)!==input.expected_revision_id)throw new ContractError('REVISION_CONFLICT','运营记录已变化，请重新读取；当前输入仍保留');
    // get 在 await 后重新核对首次创建，两个首次写入不能分别创建运营文稿。
    const existing=this.documentId(request,topicId);
    if(!current.document&&existing)throw new ContractError('REVISION_CONFLICT','运营记录已由另一处创建，请重新读取');
    const document=current.document
      ? (await this.documents.save(scoped,current.document.document_id,{expected_revision_id:input.expected_revision_id,text,origin:'human'}),await this.documents.get(request,current.document.document_id))
      : await this.documents.create(scoped,{kind:'topic_operations',owner_entity_id:topicId,initial_text:text});
    const result={topic_id:topicId,document,data:input.data};transaction(this.context.db,()=>storeIdempotent(this.context.db,request,operation,input,result));return result;
  }
}
