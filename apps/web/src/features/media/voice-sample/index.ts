import { VoiceSampleSchema, type VoiceReadinessResponse, type JobDetailResponse, type Page, type JobsRow } from '@workbench/contracts';
import type { WorkbenchClient } from '../../../transport/workbench-client.ts';
import type { FeatureContext } from '../../../transport/feature-ports.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
const {esc,btn}=createTemplateHelpers([]);
interface Options {root:HTMLElement;client:WorkbenchClient;signal:AbortSignal;context():FeatureContext;active():boolean}
export class VoiceSamplePanel {
  readonly options:Options;private topics:Array<{id:string;title:string}>=[];private topic='';private text='';private frames=260;private readiness?:VoiceReadinessResponse;private job='';private pending?:{key:string;body:ReturnType<typeof VoiceSampleSchema.parse>};private busy=false;private connecting=0;private url='';
  constructor(options:Options){this.options=options;options.signal.addEventListener('abort',()=>this.release(),{once:true});}
  private release(){if(this.url)URL.revokeObjectURL(this.url);this.url='';}
  private field(id:string){return this.options.root.querySelector<HTMLInputElement|HTMLTextAreaElement|HTMLSelectElement>('#'+id)?.value??'';}
  private capture(){if(this.options.root.querySelector('#voice-transcript')){this.text=this.field('voice-transcript');const selected=this.field('voice-topic');if(selected!==this.topic){this.job='';this.pending=undefined;}this.topic=selected;this.frames=Number(this.field('voice-frames'));}}
  private show(error=''){
    const ready=this.readiness?.status==='ready',surface=this.options.context().surface;
    surface.presentDialog({title:'声音试听 · 先做一段',body:(error?'<p class="skills-dialog-error" role="alert" tabindex="-1">'+esc(error)+'</p>':'')+'<p class="fine">'+esc(this.readiness?.message??'正在检查声音服务…')+'</p><label class="skills-field">所属主题<select id="voice-topic">'+this.topics.map(t=>'<option value="'+esc(t.id)+'" '+(t.id===this.topic?'selected':'')+'>'+esc(t.title)+'</option>').join('')+'</select></label><label class="skills-field">这一段的口播台词<textarea id="voice-transcript" rows="5" placeholder="只放准备朗读的正文，不含标题、镜头或提示词。">'+esc(this.text)+'</textarea></label><label class="skills-field">生成窗口<select id="voice-frames">'+[124,141,158,175,192,209,226,243,260,277,294,311,328,345,362].map(frame=>'<option value="'+frame+'" '+(frame===this.frames?'selected':'')+'>'+Math.round(frame/24*10)/10+' 秒</option>').join('')+'</select></label><p class="fine">按台词朗读长度选择。保留本人参考与原速，生成后先核对和审听，再做下一段。</p>'+(!ready?'<p class="fine">服务恢复后检查连接，即可生成；你的台词会保留。</p>':''),foot:btn('返回','skills-library-open')+btn('检查连接','skills-voice-refresh')+(this.job?btn('查看上次任务','skills-voice-inspect'):'')+btn('生成这一段','skills-voice-submit',true,!ready||!this.topics.length?'disabled':'')});
    this.options.root.querySelector<HTMLElement>('[role="alert"]')?.focus();
  }
  async handle(action:string,topics:Array<{id:string;title:string}>):Promise<boolean>{
    if(!action.startsWith('skills-voice-'))return false;
    if(this.busy)return true;this.topics=topics;this.capture();this.topic=topics.some(t=>t.id===this.topic)?this.topic:topics[0]?.id??'';
    try{
      if(!this.options.client.assetContent){this.readiness={identity:this.options.context().identity,status:'unconfigured',message:'当前插件入口尚未接通声音试听，请在本机工作台使用',profile:null,running:null,pending:null};this.show();return true;}
      if(action==='skills-voice-open'||action==='skills-voice-refresh'){
        const connection=++this.connecting;this.show();const readiness=await this.options.client.request<VoiceReadinessResponse>('GET','/api/v1/media/voice',undefined,{signal:this.options.signal});if(connection!==this.connecting)return true;this.readiness=readiness;const identity=this.options.context().identity;if(this.readiness.identity.workspace_id!==identity.workspace_id||this.readiness.identity.service_instance_id!==identity.service_instance_id)throw new Error('声音服务不属于当前工作区');
        if(!this.job&&this.topic){let cursor:string|null=null;do{const page:Page<JobsRow>=await this.options.client.request('GET','/api/v1/jobs?kind=media_generate&target_id='+encodeURIComponent(this.topic)+(cursor?'&cursor='+encodeURIComponent(cursor):''),undefined,{signal:this.options.signal});for(const job of page.items)if(JSON.parse(job.input_manifest).operation==='h3_voice')this.job=job.id;cursor=page.next_cursor;}while(cursor&&!this.options.signal.aborted);}
        if(this.options.active()&&this.options.root.querySelector('#voice-transcript')){this.capture();this.show();}return true;
      }
      if(action==='skills-voice-submit'){
        const body=VoiceSampleSchema.parse({topic_id:this.topic,transcript:this.text,frames:this.frames});if(!this.pending||JSON.stringify(this.pending.body)!==JSON.stringify(body))this.pending={key:crypto.randomUUID(),body};this.busy=true;
        const result=await this.options.client.request<{job_id:string}>('POST','/api/v1/media/voice',this.pending.body,{signal:this.options.signal,idempotencyKey:this.pending.key});this.pending=undefined;this.job=result.job_id;
      }else if(action==='skills-voice-recover'){
        this.busy=true;const result=await this.options.client.request<{job_id:string}>('POST','/api/v1/media/voice/'+encodeURIComponent(this.job)+'/recover',{}, {signal:this.options.signal,idempotencyKey:crypto.randomUUID()});this.job=result.job_id;
      }
      if(this.job)await this.watch();return true;
    }catch(error){if(this.options.active()&&this.options.root.querySelector('#dialog-title')?.textContent?.includes('声音'))this.show(error instanceof Error?error.message:'声音任务未完成');return true;}finally{this.busy=false;}
  }
  private async watch(){
    const context=this.options.context();
    while(this.options.active()&&!this.options.signal.aborted){
      const detail=await this.options.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(this.job),undefined,{signal:this.options.signal});
      if(!this.options.active()||!this.options.root.querySelector('#dialog-title')?.textContent?.includes('声音'))return;
      if(JSON.parse(detail.job.input_manifest).operation!=='h3_voice')throw new Error('不是声音试听任务');
      if(detail.job.state==='succeeded'){
        const committed=detail.receipts.find(r=>r.state==='committed'),ids=(committed?.result_ids as {asset_ids?:string[]}|undefined)?.asset_ids;
        if(!ids?.[0])throw new Error('声音素材收据尚未提交');
        if(!this.options.client.assetContent)throw new Error('当前宿主未接通音频试听，请在本机工作台查看');
        this.release();const blob=await this.options.client.assetContent(ids[0],this.options.signal);if(!this.options.active()||!this.options.root.querySelector('#dialog-title')?.textContent?.includes('声音'))return;this.url=URL.createObjectURL(blob);
        context.surface.presentDialog({title:'这一段已生成 · 待审听',body:'<p class="fine">原始 FLAC 已完成解码检查。台词完整性与声音效果仍需核对，原稿保持。</p><audio controls preload="metadata" style="width:100%" src="'+esc(this.url)+'"></audio><p><a class="inline-link" download="h3-voice.flac" href="'+esc(this.url)+'">下载原始音频</a></p><p class="fine">审听后再决定下一段；这次不会自动制作整片。</p>',foot:btn('回到声音试听','skills-voice-open')});return;
      }
      if(['reconciling','waiting_input','failed','cancelled'].includes(detail.job.state)){
        context.surface.presentDialog({title:'声音任务需要核对',body:'<p role="alert">'+esc(typeof detail.error?.message==='string'?detail.error.message:'当前任务未生成可用音频')+'</p><p class="fine">原台词保留。已有回执时仅查询原任务，避免重复生成。</p>',foot:btn('回到台词','skills-voice-open')+(detail.job.state==='reconciling'&&!detail.job.cancel_requested_at?btn('核对原任务','skills-voice-recover',true):'')});return;
      }
      context.surface.presentDialog({title:'正在制作声音',body:'<div class="task-orb"><span>a.</span></div><p class="fine">'+esc(typeof detail.checkpoint?.message==='string'?detail.checkpoint.message:detail.job.state==='queued'?'等待声音执行器领取':'正在读取实际任务状态')+'</p><p class="fine">生成回执保留，返回页面后可继续查看。</p>',foot:btn('取消任务','cancel-task'),foregroundJob:{id:this.job,version:detail.job.version}});
      await new Promise<void>(done=>setTimeout(done,2000));if(!(context.surface.isForegroundJobActive?.(this.job)??true))return;
    }
  }
}
