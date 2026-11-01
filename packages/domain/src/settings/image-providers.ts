import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {ContractError,SaveImageProviderSettingsSchema,executorAvailability,imageGenerationLimit,type ExecutorHealth,type ImageProviderId,type ImageProviderSettingsResponse,type ImageProviderVerification,type SaveImageProviderSettingsRequest,type RequestContext} from '@workbench/contracts';
import {transaction} from '@workbench/storage/connection';
import {readCommittedIdempotent,storeIdempotent} from '@workbench/storage/revisions';
import {probeAgyAccess,type ImageAccessProbe} from '@workbench/adapters/media/image';
import {readGenerationBudget} from '../../../storage/src/image-studio/index.ts';
import {assertRequestIdentity} from '../documents/index.ts';
import type {ApplicationContext} from '../ports/index.ts';

type StoredVerification=Omit<ImageProviderVerification,'state'>&{state:'passed'|'failed'|'inconclusive'};
interface Stored {version:number;default_provider:ImageProviderId;enabled:{agy:boolean;codex:boolean};observations?:Partial<Record<ImageProviderId,{job_id:string;asset_id:string;model:string|null;operation:string}>>;verifications?:Partial<Record<ImageProviderId,StoredVerification>>;verify_runs?:Partial<Record<ImageProviderId,VerifyRun>>}
// 每次验证领取一个自增代次并记下当时的设置版本与租约到期时间（持久化，多实例共享）；租约内的重复请求不再探测。
interface VerifyRun {generation:number;settings_version:number;running_until:string|null}
// probeAgy/configured 仅供隔离测试注入；生产走本机命令行。
export interface ImageProviderSettingsOptions {probeAgy?:()=>Promise<ImageAccessProbe>;configured?:(provider:ImageProviderId)=>boolean;now?:()=>number;verify_lease_ms?:number;log?:(line:string)=>void}
const NOT_RUN:ImageProviderVerification={state:'not_run',reason:null,message:null,checked_at:null};
// 失败原因只给用户语言；原始输出不落库、不回前端。
const FAILURE:Record<'agy'|'codex',Record<NonNullable<ImageProviderVerification['reason']>,string>>={
  agy:{unconfigured:'本机未找到 AGY 命令行，请先安装',login:'AGY 登录已失效，请在本机重新登录 AGY',quota:'AGY 额度暂不可用，额度恢复后再验证',connection:'连不上 AGY 服务，请检查网络后重试'},
  codex:{unconfigured:'本机未找到 Codex 命令行，请先安装',login:'Codex 登录已失效，请在「AI 执行器」里打开登录',quota:'Codex 额度暂不可用，额度恢复后再验证',connection:'未能确认 Codex 登录状态，请稍后重试'},
};
export class ImageProviderSettings {
  readonly context:ApplicationContext;private readonly options:ImageProviderSettingsOptions;
  constructor(context:ApplicationContext,options:ImageProviderSettingsOptions={}){this.context=context;this.options=options;}
  private key(){return 'image-providers.v1:'+this.context.identity.workspace_id;}
  stored():Stored {const row=this.context.db.prepare('SELECT value FROM application_metadata WHERE key=?').get(this.key());return row?JSON.parse(String(row.value)):{version:1,default_provider:'codex',enabled:{agy:false,codex:false}};}
  private configured(provider:ImageProviderId){if(this.options.configured)return this.options.configured(provider);return existsSync(provider==='agy'?join(homedir(),'.local/bin/agy'):'/opt/homebrew/bin/codex');}
  get(request:RequestContext,codexExecutor:Pick<ExecutorHealth,'status'|'auth_state'>|null=null):ImageProviderSettingsResponse {
    assertRequestIdentity(this.context,request);const saved=this.stored(),used=readGenerationBudget(this.context.db,this.context.identity.workspace_id);
    return {version:saved.version,default_provider:saved.default_provider,channels:(['agy','codex'] as const).map(provider=>{
      const observation=saved.observations?.[provider],configured=this.configured(provider),verification:ImageProviderVerification=saved.verifications?.[provider]??NOT_RUN,passed=verification.state==='passed',failed=verification.state==='failed'?verification.reason:null,limit=imageGenerationLimit(this.context.config,provider);
      return {provider,label:provider==='agy'?'AGY · Nano Banana 2':'Codex 图像',enabled:saved.enabled[provider],configured,
        identity:passed?'authenticated':failed==='login'?'blocked':'unverified',connection:passed?'connected':failed==='connection'?'blocked':observation?'observed_success':'unverified',permission:failed==='quota'?'blocked':observation?'observed_allowed':'unverified',
        model:observation?.model??(provider==='agy'?'gemini-3.1-flash-image':null),
        operations:{generation:provider==='agy'||observation?'supported':'unverified',reference_edit:provider==='agy'?'supported':'unverified',mask:'unverified',writing:'unverified'},
        last_job_id:observation?.job_id??null,last_asset_id:observation?.asset_id??null,
        limitations:provider==='agy'?['生成与单参考编辑已由 probe/r1 验证；身份与当前授权分别核对','区域控制、其他文字或媒体能力未验']:['宿主图片与原生能力已验；原生工作台结果按实际任务记录','具体图像模型未返回时保持未知；写作任务工具限制独立保留'],
        verification,executor:provider==='codex'&&codexExecutor?{status:codexExecutor.status,auth_state:codexExecutor.auth_state}:null,budget:{used:used[provider],limit,remaining:limit===null?null:Math.max(0,limit-used[provider])},
      };
    })};
  }
  // GET 附带 Codex 执行器当前认证状态（不等待探测、复用 30 秒缓存）；AGY 不走执行器。
  async read(request:RequestContext):Promise<ImageProviderSettingsResponse> {
    assertRequestIdentity(this.context,request);const codex=(await this.context.getExecutorHealth()).find(e=>e.executor_id==='codex')??null;return this.get(request,codex);
  }
  save(request:RequestContext,input:SaveImageProviderSettingsRequest):ImageProviderSettingsResponse {
    assertRequestIdentity(this.context,request);SaveImageProviderSettingsSchema.parse(input);
    return transaction(this.context.db,()=>{const old=readCommittedIdempotent<ImageProviderSettingsResponse>(this.context.db,request,'image-providers.save',input);if(old)return old;
      const saved=this.stored();if(saved.version!==input.expected_version)throw new ContractError('VERSION_CONFLICT','图像渠道设置已变化，请刷新');
      this.write({...saved,version:saved.version+1,default_provider:input.default_provider,enabled:input.enabled});
      const response=this.get(request);storeIdempotent(this.context.db,request,'image-providers.save',input,response);return response;
    });
  }
  // 「验证连接」：只做身份/连接/权限只读探测（AGY 读模型列表；Codex 走执行器 account/read 与额度读取），不生图、不动预算；结果写回 readiness。
  async verify(request:RequestContext,provider:ImageProviderId):Promise<ImageProviderSettingsResponse> {
    assertRequestIdentity(this.context,request);if(provider!=='agy'&&provider!=='codex')throw new ContractError('NOT_FOUND','图像渠道不存在');
    const now=()=>this.options.now?.()??Date.now();
    const claim=transaction(this.context.db,()=>{const saved=this.stored(),run=saved.verify_runs?.[provider];if(run?.running_until&&Date.parse(run.running_until)>now())return null;
      const next:VerifyRun={generation:(run?.generation??0)+1,settings_version:saved.version,running_until:new Date(now()+(this.options.verify_lease_ms??60_000)).toISOString()};this.write({...saved,verify_runs:{...saved.verify_runs,[provider]:next}});return next;});
    if(!claim)return this.read(request);
    let verification:StoredVerification|null=null;
    try{
      let outcome:Pick<StoredVerification,'state'|'reason'>,timeout=false;
      if(!this.configured(provider))outcome={state:'failed',reason:'unconfigured'};
      else if(provider==='agy'){const probe=await (this.options.probeAgy??(()=>probeAgyAccess()))();outcome=probe.ok?{state:'passed',reason:null}:{state:probe.inconclusive?'inconclusive':'failed',reason:probe.reason};timeout=!probe.ok&&!!probe.timeout;}
      else {const codex=(await this.context.getExecutorHealth({wait_for:'codex',refresh:true})).find(e=>e.executor_id==='codex')??null,a=executorAvailability(codex);
        outcome=a.usable?{state:'passed',reason:null}:a.reason==='quota'?{state:'failed',reason:'quota'}:a.reason==='login'?{state:'failed',reason:'login'}:{state:'inconclusive',reason:'connection'};}
      verification={...outcome,message:timeout?'验证超时，未能确认 '+(provider==='agy'?'AGY':'Codex')+' 连接，请稍后重试':outcome.reason?FAILURE[provider][outcome.reason]:null,checked_at:new Date(now()).toISOString()};
    }finally{
      // 只有本次仍是最新代次、且设置版本未变时才写回；否则丢弃（旧探测晚返回不覆盖新结果）。
      transaction(this.context.db,()=>{const saved=this.stored(),run=saved.verify_runs?.[provider],latest=run?.generation===claim.generation,accept=!!verification&&latest&&saved.version===claim.settings_version;
        if(verification&&!accept)(this.options.log??(line=>process.stderr.write(line+'\n')))(JSON.stringify({event:'image_provider_verify_discarded',provider,generation:claim.generation,latest_generation:run?.generation??null,settings_version:claim.settings_version,current_settings_version:saved.version}));
        if(!latest&&!accept)return;
        this.write({...saved,...(accept?{verifications:{...saved.verifications,[provider]:verification!}}:{}),verify_runs:{...saved.verify_runs,[provider]:{...run!,running_until:null}}});});
    }
    return this.read(request);
  }
  assertEnabled(provider:ImageProviderId){if(!this.stored().enabled[provider])throw new ContractError('CAPABILITY_UNVERIFIED','先在 AI 设置启用所选图像渠道');}
  record(provider:ImageProviderId,job_id:string,asset_id:string,model:string|null,operation:string){
    const saved=this.stored();this.write({...saved,observations:{...saved.observations,[provider]:{job_id,asset_id,model,operation}}});
  }
  private write(value:Stored){this.context.db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(this.key(),JSON.stringify(value));}
}
