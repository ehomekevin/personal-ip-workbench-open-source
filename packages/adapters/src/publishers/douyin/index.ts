import { ContractError, type JsonObject, type PublishInput, type PublishResult } from '@workbench/contracts';
import { PublisherBase, contextOf, continuationOf, object, str, unknownAttempt, type Exchange, type FrozenFile, type FrozenPayload, type PublisherOptions } from '../x/primitives.ts';
export const DOUYIN_PUBLISHER_VERSION='wp22-douyin/1.0.0-api-v1';
export class DouyinPublisher extends PublisherBase {
  constructor(options:PublisherOptions){super(options,'douyin',['short_video'],DOUYIN_PUBLISHER_VERSION);}
  private video(payload:FrozenPayload):{file:FrozenFile;text:string} {
    const file=payload.files.find(f=>f.relative_path==='video/douyin.mp4'&&f.mime==='video/mp4');
    if(!file)throw new ContractError('INPUT_STALE','抖音缺少冻结视频成品');
    if(file.bytes.length>300*1024*1024)throw new ContractError('CAPABILITY_UNSUPPORTED','超过300MB需要尚未交付的官方分片上传路线');
    const metadata=payload.files.find(f=>f.relative_path==='project/publishing-metadata.json');let title:unknown=null,caption:unknown=null;
    if(metadata){try{const m=object(JSON.parse(Buffer.from(metadata.bytes).toString('utf8')));title=m.title;caption=m.caption;}catch{throw new ContractError('INPUT_STALE','冻结发布元数据无效');}}
    const text=str(caption)??str(title)??payload.text;if(Array.from(text).length>1000)throw new ContractError('VALIDATION_ERROR','抖音冻结标题超过1000字');
    return {file,text};
  }
  override async validateInput(input:PublishInput):Promise<JsonObject>{this.video(this.gate(input,'submit')!);return {valid:true,adapter_version:this.version,evidence_kind:this.evidenceKind};}
  private url(route:string):string{const url=new URL('https://open.douyin.com/api/douyin/v1/video/'+route+'/');url.searchParams.set('open_id',this.options.account.platform_account_id);return url.toString();}
  private platformFailure(input:PublishInput,e:Exchange,writing:boolean):PublishResult|null {
    const http=this.httpFailure(input,e,writing);if(http)return http;
    const body=object(e.response!.payload),data=object(body.data),extra=object(body.extra),codes=[data.error_code,extra.error_code].filter(c=>c!==undefined);
    if(!codes.length)return this.unknown(input,'response_missing_error_code',e.raw);
    if(codes.every(c=>c===0))return null;
    if(!writing)return this.unknown(input,'query_platform_error',e.raw,{continuation:{...continuationOf(input),kind:'douyin_query'}});
    const code=codes.find(c=>c!==0);
    if([2100005,2190005,2190007,2114006,2114007,28001003,28001008,28001014,28001018,28003017].includes(Number(code)))return this.result(input,'failed',[28001003,28001008,28001014,28001018].includes(Number(code))?'permission_denied':[2114007,28003017].includes(Number(code))?'quota_exhausted':'platform_rejected',e.raw,{retryability:{retryable:false,confirmed_no_publication:true,error_code:Number(code)}});
    return this.unknown(input,'platform_error_inconclusive',e.raw,{continuation:{...continuationOf(input),kind:'douyin_query'}});
  }
  async prepareDraft(input:PublishInput):Promise<PublishResult> {
    const video=this.video(this.gate(input,'prepareDraft')!),continuation=continuationOf(input);
    if(str(continuation.video_file_id))return this.result(input,'queued','no-draft-step',this.record(input,{operation:'prepareDraft',file_already_uploaded:true,network_calls:0}),{continuation:continuation as JsonObject,progress:'ready'});
    if(contextOf(input).remote_request_id||unknownAttempt(input,['prepare_sending','submit_sending']))return this.unknown(input,'existing_attempt_requires_query');
    const upload=await this.exchange(input,'prepareDraft',{operation:'upload_video',method:'POST',url:this.url('upload_video'),upload:{field:'video',filename:'douyin.mp4',mime:video.file.mime,bytes:video.file.bytes}},'douyin'),failure=this.platformFailure(input,upload,true);if(failure)return failure;
    const fileId=str(object(object(object(upload.response!.payload).data).video).video_id);if(!fileId)return this.unknown(input,'upload_response_missing_file_id',upload.raw);
    // video_id 是加密文件身份，不是公开作品/草稿身份；不写入 work_ids/draft_id。
    return this.result(input,'queued','no-draft-step',upload.raw,{progress:{stage:'file_uploaded'},continuation:{kind:'douyin_uploaded_file',video_file_id:fileId,artifact_sha256:video.file.sha256}});
  }
  async submit(input:PublishInput):Promise<PublishResult> {
    const video=this.video(this.gate(input,'submit')!),continuation=continuationOf(input);
    if(str(continuation.item_id)||str(continuation.video_id)||unknownAttempt(input,['submit_sending']))return this.unknown(input,'existing_create_requires_query',undefined,{continuation:{...continuation,kind:'douyin_query'}});
    const fileId=str(continuation.video_file_id);if(!fileId||continuation.artifact_sha256!==video.file.sha256)throw new ContractError('RESULT_UNKNOWN','缺少同一冻结成品的已上传文件身份');
    const created=await this.exchange(input,'submit',{operation:'create_video',method:'POST',url:this.url('create_video'),json:{video_id:fileId,text:video.text,private_status:0}},'douyin'),failure=this.platformFailure(input,created,true);if(failure)return failure;
    const body=object(created.response!.payload),data=object(body.data),itemId=str(data.item_id),videoId=str(data.video_id),requestId=str(object(body.extra).logid);
    if(!itemId&&!videoId)return this.unknown(input,'create_response_missing_item_id',created.raw,{continuation:{...continuation,kind:'manual_platform_reconcile'}});
    const recovery={kind:'douyin_query',...(itemId?{item_id:itemId}:{}),...(videoId?{video_id:videoId}:{}),video_file_id:fileId,artifact_sha256:video.file.sha256};
    // 缺少请求ID时不能构造领域要求带处理任务身份的processing；作品候选ID继续用于只读恢复。
    if(!requestId)return this.unknown(input,'create_request_id_missing',created.raw,{continuation:recovery});
    return this.result(input,'processing','platform_review',created.raw,{remote_request_id:requestId,continuation:recovery});
  }
  async queryResult(input:PublishInput):Promise<PublishResult> {
    this.gate(input,'queryResult',false);const continuation=continuationOf(input),itemId=str(continuation.item_id),videoId=str(continuation.video_id);
    if(!itemId&&!videoId)return this.unknown(input,'missing_item_id_manual_reconcile',undefined,{continuation:{...continuation,kind:'manual_platform_reconcile'}});
    const read=await this.exchange(input,'queryResult',{operation:'video_basic_info',method:'POST',url:this.url('video_basic_info'),json:videoId?{video_ids:[videoId]}:{item_ids:[itemId!]}},'douyin'),failure=this.platformFailure(input,read,false);if(failure)return {...failure,continuation:{...continuation,kind:'douyin_query'}};
    const rows=object(object(read.response!.payload).data).list,row=Array.isArray(rows)?rows.map(object).find(r=>videoId?r.video_id===videoId:r.item_id===itemId):null;
    // 当前官方仅有示例值5；没有核对完整公开/审核/删除枚举，保留原值不硬映射。
    return this.unknown(input,row?'video_status_unverified':'query_identity_missing',read.raw,{continuation:{...continuation,kind:'douyin_query',...(row?{raw_video_status:row.video_status as number|string??null}:{})},...(str(contextOf(input).remote_request_id)?{remote_request_id:str(contextOf(input).remote_request_id)!}:{})});
  }
}
export const createDouyinPublisher=(options:PublisherOptions):DouyinPublisher=>new DouyinPublisher(options);
