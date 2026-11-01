import { ContractError, type JsonObject, type PublishInput, type PublishMember, type PublishResult } from '@workbench/contracts';
import { PublisherBase, canonical, contextOf, continuationOf, digest, object, str, unitText, unknownAttempt, type FrozenPayload, type PublisherOptions, type Exchange } from './primitives.ts';
export * from './primitives.ts';
export const X_PUBLISHER_VERSION = 'wp21-x/1.0.0-openapi-2.170';
export const X_DOCUMENTS = { create:'https://docs.x.com/x-api/posts/create-post.md',query:'https://docs.x.com/x-api/posts/get-post-by-id.md',version:'2.170' };
const postId = (value: unknown): string | null => typeof value === 'string' && /^[0-9]{1,19}$/.test(value) ? value : null;
export class XPublisher extends PublisherBase {
  constructor(options: PublisherOptions) { super(options,'x',['text','thread'],X_PUBLISHER_VERSION); }
  private payload(input: PublishInput,payload: FrozenPayload): { body: JsonObject; member: PublishMember|null; parent: string|null } {
    if (payload.assets.size || payload.files.some(f=>f.mime.startsWith('image/')||f.mime.startsWith('video/'))) throw new ContractError('CAPABILITY_UNSUPPORTED','X 媒体上传路线尚未交付');
    if (input.format==='text') {
      const units=Array.isArray(payload.plan.units)?payload.plan.units.map(object):[];
      if(Object.keys(payload.plan).length&&units.length!==1)throw new ContractError('INPUT_STALE','单帖计划必须有一个冻结单元');
      return {body:{text:units.length?unitText(payload,units[0]!):payload.text,nullcast:false,for_super_followers_only:false},member:null,parent:null};
    }
    const allowed=contextOf(input).allowed_member_keys;
    if (!Array.isArray(allowed)||allowed.length!==1||typeof allowed[0]!=='string') throw new ContractError('RESULT_UNKNOWN','线程只能消费领域允许的一个成员');
    const members=input.members??[], member=members.find(m=>m.member_key===allowed[0]);
    if (!member||['published','unknown','sending','cancelled'].includes(member.state)) throw new ContractError('RESULT_UNKNOWN','成员已公开或结果未知，禁止重发');
    const units=Array.isArray(payload.plan.units)?payload.plan.units.map(object):[],unit=units.find(u=>u.unit_key===member.member_key);
    const fullText=payload.texts.get(member.text_revision_id);
    if (!unit||unit.position!==member.position||unit.text_revision_id!==member.text_revision_id||digest(canonical({unit,text:fullText??null}))!==member.payload_hash||member.reply_to_member_key!==(unit.reply_to_unit_key??null)) throw new ContractError('INPUT_STALE','线程成员与冻结计划 hash 不符');
    const parent=member.reply_to_member_key?members.find(m=>m.member_key===member.reply_to_member_key):null;
    if (parent&& (parent.state!=='published'||!postId(parent.platform_work_id))) throw new ContractError('RESULT_UNKNOWN','回复前件尚未确认公开');
    if (member.position>0&&!parent) throw new ContractError('INPUT_STALE','线程回复链不完整');
    const parentId=parent?.platform_work_id??null;
    return {body:{text:unitText(payload,unit),nullcast:false,for_super_followers_only:false,...(parentId?{reply:{in_reply_to_tweet_id:parentId}}:{})},member,parent:parentId};
  }
  override async validateInput(input: PublishInput): Promise<JsonObject> {
    const frozen=this.gate(input,'submit')!;
    if (input.format==='thread') {
      const keys=new Set<string>(); for(const member of input.members??[]) { if(keys.has(member.member_key)) throw new ContractError('INPUT_STALE','线程成员重复');keys.add(member.member_key);this.payload({...input,members:(input.members??[]).map(m=>m.member_key===member.member_key?{...m,state:'pending'}:m.member_key===member.reply_to_member_key?{...m,state:'published',platform_work_id:'1'}:m),scheduled_context:{allowed_member_keys:[member.member_key]}},frozen); }
      if (!keys.size) throw new ContractError('INPUT_STALE','线程缺少冻结成员');
    } else this.payload(input,frozen);
    return {valid:true,adapter_version:this.version,evidence_kind:this.evidenceKind};
  }
  async prepareDraft(input: PublishInput): Promise<PublishResult> {
    const frozen=this.gate(input,'prepareDraft')!;
    if(input.format==='text')this.payload(input,frozen);
    return this.result(input,'queued','no-draft-step',this.record(input,{operation:'prepareDraft',network_calls:0,reason:'X API 没有平台草稿步骤'}),{progress:'ready'});
  }
  async submit(input: PublishInput): Promise<PublishResult> {
    const frozen=this.gate(input,'submit')!, built=this.payload(input,frozen);
    // 未知旧发送必须进入 query；适配器不把本地 idempotency_key 当平台去重保证。
    if(!built.member&&(contextOf(input).remote_request_id||continuationOf(input).post_id||unknownAttempt(input,['submit_sending'])))return this.unknown(input,'existing_send_requires_query');
    this.gate(input,'queryResult',false);
    const sent=await this.exchange(input,'submit',{operation:'create_post',method:'POST',url:'https://api.x.com/2/tweets',json:built.body},'bearer');
    const failure=this.httpFailure(input,sent,true);if(failure)return built.member?{...failure,members:[{member_key:built.member.member_key,state:failure.state==='failed'?'failed':'unknown',confirmed_no_publication:failure.retryability.confirmed_no_publication??false}]}:failure;
    const id=postId(object(object(sent.response!.payload).data).id);
    if(!id)return this.unknown(input,'create_response_missing_post_id',sent.raw,{...(built.member?{members:[{member_key:built.member.member_key,state:'unknown'}]}:{})});
    const result=await this.lookup(input,id,built.member,built.parent);
    return {...result,raw_response_ref:this.record(input,{create_response_ref:sent.raw,query_response_ref:result.raw_response_ref,post_id:id}),...(result.state==='published'?{}:{continuation:{kind:'x_post_query',post_id:id},...(built.member?{members:[{member_key:built.member.member_key,state:'unknown',platform_work_id:id,reply_to_platform_work_id:built.parent}]}:{})})};
  }
  private async lookup(input: PublishInput,id: string,member: PublishMember|null,parent: string|null): Promise<PublishResult> {
    const url=new URL('https://api.x.com/2/tweets/'+id);url.searchParams.set('post.fields','created_at,conversation_id,scopes,withheld');url.searchParams.set('expansions','author_id,referenced_posts');url.searchParams.set('user.fields','protected');
    const read=await this.exchange(input,'queryResult',{operation:'lookup_post',method:'GET',url:url.toString()},'bearer'),failure=this.httpFailure(input,read,false);
    const result=failure??this.mapLookup(input,id,member,parent,read);
    if(result.state==='published')return result;
    // 只读查询失败不能抹掉已经取得的作品身份；领域会持久化本次 continuation。
    return {...result,continuation:{...continuationOf(input),kind:'x_post_query',post_id:id},...(member?{members:result.members??[{member_key:member.member_key,state:'unknown',platform_work_id:id,reply_to_platform_work_id:parent}]}:{})};
  }
  private mapLookup(input:PublishInput,id:string,member:PublishMember|null,parent:string|null,read:Exchange):PublishResult {
    const payload=object(read.response!.payload),post=object(payload.data),users=object(payload.includes).users,author=Array.isArray(users)?users.map(object).find(u=>u.id===post.author_id):undefined;
    const replies=Array.isArray(post.referenced_posts)?post.referenced_posts.map(object).filter(r=>r.type==='replied_to'):[];
    const identity=post.id===id&&post.author_id===this.options.account.platform_account_id;
    const publicVisible=identity&&author?.protected===false&&!Object.keys(object(author?.withheld)).length&&!Object.keys(object(post.withheld)).length&&object(post.scopes).followers!==true;
    const chain=member?parent?replies.length===1&&replies[0]!.id===parent:replies.length===0:true;
    if(!publicVisible||!chain)return this.unknown(input,!identity?'post_identity_mismatch':!chain?'reply_parent_unconfirmed':'visibility_unconfirmed',read.raw,{continuation:{kind:'x_post_query',post_id:id},...(member?{members:[{member_key:member.member_key,state:'unknown',platform_work_id:id}]}:{})});
    const url='https://x.com/i/web/status/'+id,publishedAt=str(post.created_at);if(publishedAt&&!Number.isFinite(Date.parse(publishedAt)))return this.unknown(input,'published_time_invalid',read.raw);
    const extra={...(publishedAt?{published_at:publishedAt}:{}),...(str(read.response!.headers?.['x-request-id'])?{remote_request_id:str(read.response!.headers?.['x-request-id'])!}:{})};
    return this.result(input,'published','public_confirmed',read.raw,{progress:'complete',...(member?{members:[{member_key:member.member_key,state:'published',platform_work_id:id,url,reply_to_platform_work_id:parent,...extra}]}:{work_ids:[id],url,...extra})});
  }
  async queryResult(input: PublishInput): Promise<PublishResult> {
    this.gate(input,'queryResult',false);
    if(input.format==='thread') {
      const members=input.members??[],results:JsonObject[]=[];const refs:JsonObject[]=[];
      for(const member of members) {
        if(member.state==='published')continue;const id=postId(member.platform_work_id);
        if(!id){if(['unknown','sending'].includes(member.state))results.push({member_key:member.member_key,state:'unknown'});continue;}
        const parent=member.reply_to_member_key?members.find(m=>m.member_key===member.reply_to_member_key)?.platform_work_id??null:null;
        const result=await this.lookup(input,id,member,parent);results.push(...(result.members??[{member_key:member.member_key,state:'unknown',platform_work_id:id}]));refs.push(result.raw_response_ref as unknown as JsonObject);
      }
      return this.result(input,results.length&&results.every(m=>m.state==='published')?'needs_action':'unknown','thread_query',this.record(input,{operation:'queryResult',response_refs:refs,query_only:true}),{members:results,continuation:{kind:'thread_members'}});
    }
    const id=postId(continuationOf(input).post_id);if(!id)return this.unknown(input,'missing_post_id_manual_reconcile');
    return this.lookup(input,id,null,null);
  }
}
export const createXPublisher = (options: PublisherOptions): XPublisher => new XPublisher(options);
