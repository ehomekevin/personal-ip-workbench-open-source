import { ContractError, type JsonObject, type PublishInput, type PublishResult } from '@workbench/contracts';
import { PublisherBase, contextOf, continuationOf, object, str, unitText, unknownAttempt, type Exchange, type FrozenFile, type FrozenPayload, type PublisherOptions } from '../x/primitives.ts';
export const WECHAT_PUBLISHER_VERSION = 'wp21-wechat/1.1.0-auth-2026-10-12';
const escapeHtml=(s:string)=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export class WechatPublisher extends PublisherBase {
  constructor(options:PublisherOptions){super(options,'wechat',['article'],WECHAT_PUBLISHER_VERSION);}
  private article(payload:FrozenPayload):{title:string;cover:FrozenFile;blocks:Array<{text:string|null;images:FrozenFile[]}>} {
    const title=payload.texts.get(String(payload.plan.title_revision_id)),cover=payload.assets.get(String(payload.plan.cover_asset_id));
    if(!title||Array.from(title).length>32||!cover||!cover.mime.startsWith('image/'))throw new ContractError('VALIDATION_ERROR','公众号必须有冻结标题（最多32字）与永久素材封面输入');
    if(!Array.isArray(payload.plan.units)||!payload.plan.units.length)throw new ContractError('INPUT_STALE','公众号缺少冻结文章单元');
    const blocks=payload.plan.units.map(value=>{const u=object(value),refs=Array.isArray(u.asset_refs)?u.asset_refs.map(object):[];return {text:u.text_revision_id?unitText(payload,u):null,images:refs.map(r=>{const a=payload.assets.get(String(r.asset_id));if(!a||a.sha256!==r.hash||!a.mime.startsWith('image/'))throw new ContractError('INPUT_STALE','正文图片与冻结素材 hash 不符');return a;})};});
    // 当前官方文档同时出现2kb和1M；超过更小上限需取得账号验证，不能猜测兼容。
    const text=blocks.map(b=>b.text?'<p>'+escapeHtml(b.text).replaceAll('\n','<br>')+'</p>':'').join('\n');
    const imageCount=blocks.reduce((n,b)=>n+b.images.length,0);
    // 联网前预留每张图片URL的256字节额度；返回URL超过额度就保留已上传身份，禁止草稿写入。
    if(Buffer.byteLength(text)+imageCount*268>2048)throw new ContractError('CAPABILITY_UNVERIFIED','公众号正文大小约束需要账号实证澄清');
    return {title,cover,blocks};
  }
  override async validateInput(input:PublishInput):Promise<JsonObject>{this.article(this.gate(input,'submit')!);return {valid:true,adapter_version:this.version,evidence_kind:this.evidenceKind};}
  private async request(input:PublishInput,operation:'prepareDraft'|'submit'|'queryResult',name:string,body:JsonObject):Promise<Exchange>{return this.exchange(input,operation,{operation:name,method:'POST',url:'https://api.weixin.qq.com/cgi-bin/'+name,json:body},'wechat');}
  private unconfirmedSubmit(input:PublishInput):boolean {
    if(continuationOf(input).unconfirmed_operation==='submit')return true;
    const attempts=contextOf(input).previous_attempts;
    return Array.isArray(attempts)&&attempts.map(object).some(a=>{
      if(!['sending','unknown'].includes(String(a.result_status)))return false;
      const operation=a.operation??a.action,phase=String(a.phase);
      if(operation==='submit'||['submit_sending','wechat_submit_unconfirmed','submit_response_missing_publish_id'].includes(phase))return true;
      if(['prepare','prepareDraft','query','queryResult'].includes(String(operation))||phase==='prepare_sending'||phase.startsWith('wechat_prepare_')||phase.startsWith('query_')||['query','reconciling','draft_identity_unconfirmed','draft_exists_publication_unresolved'].includes(phase))return false;
      // 旧attempt缺原始action且响应phase已改写时，不能把不明写入归为prepare。
      return true;
    });
  }
  private platformFailure(input:PublishInput,response:Exchange,writing:boolean):PublishResult|null {
    const http=this.httpFailure(input,response,writing);if(http)return http;const code=object(response.response!.payload).errcode;
    if(code===undefined||code===0)return null;
    if(!writing)return this.unknown(input,'query_platform_error',response.raw);
    if([53504,53505].includes(Number(code)))return this.result(input,'needs_action','manual_platform_draft_step',response.raw,{...(str(contextOf(input).draft_id)?{draft_id:str(contextOf(input).draft_id)!}:{}),continuation:{kind:'platform_manual',error_code:Number(code)}});
    if([40001,40014,42001,48001,53503,45009].includes(Number(code)))return this.result(input,'failed',[40001,40014,42001,48001].includes(Number(code))?'permission_denied':Number(code)===45009?'rate_limited':'platform_rejected',response.raw,{retryability:{retryable:false,confirmed_no_publication:true,error_code:Number(code)}});
    return this.unknown(input,'platform_error_inconclusive',response.raw);
  }
  async prepareDraft(input:PublishInput):Promise<PublishResult> {
    const payload=this.gate(input,'prepareDraft')!,article=this.article(payload),draft=str(contextOf(input).draft_id);
    if(draft)return this.result(input,'platform_draft','draft_ready',this.record(input,{operation:'prepareDraft',existing_draft_id:draft,network_calls:0}),{draft_id:draft});
    if(contextOf(input).remote_request_id||unknownAttempt(input,['prepare_sending','submit_sending']))return this.unknown(input,'existing_attempt_requires_query');
    const refs:JsonObject[]=[],images=new Map<string,string>();
    const upload=async(file:FrozenFile,name:string)=>{const r=await this.exchange(input,'prepareDraft',{operation:name,method:'POST',url:'https://api.weixin.qq.com/cgi-bin/'+name,upload:{field:'media',filename:file.relative_path.split('/').at(-1)!,mime:file.mime,bytes:file.bytes}},'wechat');refs.push(r.raw as unknown as JsonObject);return r;};
    const cover=await upload(article.cover,'material/add_material?type=image'),coverFailure=this.platformFailure(input,cover,true);if(coverFailure)return coverFailure;
    const coverId=str(object(cover.response!.payload).media_id);if(!coverId)return this.unknown(input,'cover_response_missing_media_id',cover.raw);
    for(const file of article.blocks.flatMap(b=>b.images))if(!images.has(file.sha256)){const uploaded=await upload(file,'media/uploadimg'),failure=this.platformFailure(input,uploaded,true);if(failure)return failure;const url=str(object(uploaded.response!.payload).url);if(!url||!/^https?:\/\//.test(url))return this.unknown(input,'inline_image_response_missing_url',uploaded.raw);if(Buffer.byteLength(escapeHtml(url))>256)return this.result(input,'needs_action','inline_image_url_size_unverified',this.record(input,{response_refs:refs,cover_media_id:coverId}),{continuation:{kind:'platform_manual',cover_media_id:coverId}});images.set(file.sha256,url);}
    const content=article.blocks.map(b=>(b.text?'<p>'+escapeHtml(b.text).replaceAll('\n','<br>')+'</p>':'')+b.images.map(f=>'<img src="'+escapeHtml(images.get(f.sha256)!)+'">').join('')).join('\n');
    if(Buffer.byteLength(content)>2048)throw new ContractError('CAPABILITY_UNVERIFIED','公众号最终 HTML 超过已保守核对的大小上限');
    const drafted=await this.request(input,'prepareDraft','draft/add',{articles:[{article_type:'news',title:article.title,content,thumb_media_id:coverId}]}),failure=this.platformFailure(input,drafted,true);refs.push(drafted.raw as unknown as JsonObject);if(failure)return failure;
    const draftId=str(object(drafted.response!.payload).media_id),raw=this.record(input,{operation:'prepareDraft',response_refs:refs,cover_media_id:coverId,draft_media_id:draftId});
    if(!draftId)return this.unknown(input,'draft_response_missing_media_id',raw);
    return this.result(input,'platform_draft','draft_ready',raw,{draft_id:draftId,progress:'ready',continuation:{kind:'wechat_draft',cover_media_id:coverId}});
  }
  async submit(input:PublishInput):Promise<PublishResult> {
    this.gate(input,'submit');const publishId=str(contextOf(input).remote_request_id),draftId=str(contextOf(input).draft_id);
    if(publishId)return this.result(input,'processing','publish_task_pending',this.record(input,{operation:'submit',existing_publish_id:publishId,network_calls:0}),{remote_request_id:publishId,...(draftId?{draft_id:draftId}:{}),continuation:{kind:'wechat_publish_query'}});
    if(this.unconfirmedSubmit(input))return this.unknown(input,'existing_submit_requires_query',undefined,{...(draftId?{draft_id:draftId}:{}),continuation:{...continuationOf(input),kind:'reconcile_only',unconfirmed_operation:'submit'}});
    if(!draftId)throw new ContractError('RESULT_UNKNOWN','缺少平台草稿 ID，禁止隐式新建另一草稿');
    const sent=await this.request(input,'submit','freepublish/submit',{media_id:draftId}),failure=this.platformFailure(input,sent,true);if(failure)return {...failure,draft_id:draftId,...(failure.state==='unknown'?{phase:'wechat_submit_unconfirmed',continuation:{...continuationOf(input),kind:'reconcile_only',unconfirmed_operation:'submit'}}:{})};
    const id=str(object(sent.response!.payload).publish_id);if(!id)return this.unknown(input,'submit_response_missing_publish_id',sent.raw,{draft_id:draftId,continuation:{...continuationOf(input),kind:'reconcile_only',unconfirmed_operation:'submit'}});
    return this.result(input,'processing','publish_task_pending',sent.raw,{remote_request_id:id,draft_id:draftId,continuation:{kind:'wechat_publish_query'}});
  }
  async queryResult(input:PublishInput):Promise<PublishResult> {
    this.gate(input,'queryResult',false);const publishId=str(contextOf(input).remote_request_id),draftId=str(contextOf(input).draft_id);
    if(!publishId&&!draftId)return this.unknown(input,'missing_platform_id_manual_reconcile');
    if(!publishId){
      const read=await this.request(input,'queryResult','draft/get',{media_id:draftId!}),failure=this.platformFailure(input,read,false),continuation={...continuationOf(input),kind:'wechat_draft'};
      if(failure)return {...failure,draft_id:draftId!,continuation};
      const list=object(read.response!.payload).news_item,item=Array.isArray(list)&&list.length===1?object(list[0]):{};
      const valid=(item.article_type===undefined||item.article_type==='news')&&!!str(item.title)?.trim()&&!!str(item.content)?.trim()&&!!str(item.thumb_media_id)?.trim();
      if(!valid)return this.unknown(input,'draft_identity_unconfirmed',read.raw,{draft_id:draftId!,continuation});
      if(this.unconfirmedSubmit(input))return this.unknown(input,'draft_exists_publication_unresolved',read.raw,{draft_id:draftId!,continuation:{...continuation,kind:'reconcile_only',unconfirmed_operation:'submit'}});
      return this.result(input,'platform_draft','draft_ready',read.raw,{draft_id:draftId!,continuation});
    }
    const read=await this.request(input,'queryResult','freepublish/get',{publish_id:publishId}),failure=this.platformFailure(input,read,false);if(failure)return {...failure,remote_request_id:publishId,...(draftId?{draft_id:draftId}:{}),continuation:{...continuationOf(input),kind:'wechat_publish_query'}};
    const body=object(read.response!.payload),status=body.publish_status,extra={remote_request_id:publishId,...(draftId?{draft_id:draftId}:{})};
    if(status===1)return this.result(input,'processing','platform_processing',read.raw,{...extra,continuation:{kind:'wechat_publish_query'}});
    if(status===0){const detail=object(body.article_detail),items=Array.isArray(detail.item)?detail.item.map(object):[],id=str(body.article_id),url=items.length===1?str(items[0]!.article_url):null;
      if(!id||!url||detail.count!==1||items[0]!.idx!==1)return this.unknown(input,'public_identity_or_url_missing',read.raw,extra);
      let valid=false;try{const p=new URL(url);valid=p.protocol==='https:'&&p.hostname==='mp.weixin.qq.com'&&!p.username&&!p.password&&p.pathname.startsWith('/s');}catch{}
      if(!valid)return this.unknown(input,'permanent_article_url_invalid',read.raw,extra);
      return this.result(input,'published','public_confirmed',read.raw,{...extra,work_ids:[id],url,progress:'complete'});
    }
    if([2,3,4,5,6].includes(Number(status)))return this.result(input,'needs_action',[5,6].includes(Number(status))?'previous_publication_removed':'publication_requires_manual_review',read.raw,{...extra,continuation:{kind:'platform_manual',publish_status:Number(status),fail_idx:Array.isArray(body.fail_idx)?body.fail_idx as number[]:[]}});
    return this.unknown(input,'publish_status_unverified',read.raw,extra);
  }
}
export const createWechatPublisher=(options:PublisherOptions):WechatPublisher=>new WechatPublisher(options);
