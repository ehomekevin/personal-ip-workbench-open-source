import type { AccountSummary, Page, Platform,JsonObject,SourceRecordSummary,SourceRecordDetail,AccountResearchView,AccountResearchPlan,AccountResearchReport,AccountResearchHistoryItem,JobDetailResponse } from '@workbench/contracts';
import type { FeatureAction, FeatureContext, DialogView } from '../../../transport/feature-ports.ts';
import { createTemplateHelpers } from '../../../components/templateHelpers.ts';
import { P } from '../../../components/metadata.ts';
import {renderBenchmarkStudy,renderBenchmarkRecord} from '../../../components/benchmarkMaterials.ts';
import {waitForegroundGeneration,type CandidatePreview} from '../../create/ai-actions/index.ts';
import {researchTabs,renderResearchIndex,renderResearchReport,type ResearchEvidenceView} from './research-view.ts';

type ReportView={item:AccountResearchHistoryItem;plan:AccountResearchPlan;evidence:ResearchEvidenceView[];report:AccountResearchReport|null;text:string;candidate:CandidatePreview|undefined};
type Study={account:AccountSummary;sync:JsonObject;rows:SourceRecordSummary[];next:string|null;busy:boolean;tab:'materials'|'report';research?:AccountResearchView;report?:ReportView};
const studies=new WeakMap<object,Study>();
const displayGenerations=new WeakMap<object,number>();
const ownedDialogs=new WeakMap<object,object>();
// Controller 通知实际呈现身份；自己的更新保留代次，其他弹窗替换立即失效。
export function notifyManualAccountDialogPresentation(client:object,dialog:object):void {
 if(ownedDialogs.get(dialog)===client){ownedDialogs.delete(dialog);return;}
 invalidateManualAccountDialog(client);
}
// 仅让当前账号抽屉失效，不改变应用 signal，也不取消后台任务。
export function invalidateManualAccountDialog(client:object):void {
 displayGenerations.set(client,(displayGenerations.get(client)??0)+1);
 studies.delete(client);
}
interface DisplayRequest {study?:Study;current():boolean;check():void}
function beginDisplay(context:FeatureContext,study?:Study):DisplayRequest {
 const generation=(displayGenerations.get(context.client)??0)+1;
 displayGenerations.set(context.client,generation);
 const display:DisplayRequest={study,current:()=>!context.signal.aborted&&context.ui.page==='sources'&&displayGenerations.get(context.client)===generation&&(!display.study||studies.get(context.client)===display.study),check(){if(!display.current())throw new DOMException('账号研究展示已失效','AbortError');}};
 return display;
}
function presentOwnedDialog(context:FeatureContext,display:DisplayRequest,dialog:DialogView):void {
 display.check();ownedDialogs.set(dialog,context.client);context.surface.presentDialog(dialog);
}
function displayContext(context:FeatureContext,display:DisplayRequest):FeatureContext {
 return {...context,surface:{...context.surface,presentDialog:dialog=>presentOwnedDialog(context,display,dialog)}};
}
async function checked<T>(pending:Promise<T>,display:DisplayRequest):Promise<T>{const value=await pending;display.check();return value;}
function presentStudy(context:FeatureContext,study:Study,display:DisplayRequest,error?:string){
 display.check();
 const {esc,btn}=createTemplateHelpers([]),report=study.report,job=report?.item,id=esc(study.account.id);
 const body=study.tab==='materials'?renderBenchmarkStudy(study.account,study.sync,study.rows,!!study.next):report?(report.report?renderResearchReport(report.report,report.plan,report.evidence,report.item):'<p class="note">'+esc(job?.state==='succeeded'?'历史报告未使用当前结构，保留原文供查阅。':'任务状态：'+job?.state+'；已有报告保留。')+'</p>'+(report.text?'<pre class="account-research-legacy">'+esc(report.text)+'</pre>':'')+(job?.error?'<p class="benchmark-error" role="alert">'+esc(job.error)+'</p>':'')):study.research?renderResearchIndex(study.research):'<p class="note">正在读取研究资料…</p>';
 let foot=btn('关闭','close-dialog');
 if(report){foot=btn('返回研究历史','benchmark-research',false,'data-account="'+id+'"');if(report.candidate&&!job?.adopted_revision_id&&report.candidate.status==='pending')foot+=btn('采用这份研究报告','benchmark-research-adopt',true,'data-account="'+id+'" data-candidate="'+esc(report.candidate.id)+'"');if(job&&['failed','waiting_input','waiting_quota'].includes(job.state))foot+=btn('恢复固定任务','benchmark-research-resume',true,'data-account="'+id+'" data-job="'+esc(job.job_id)+'"');if(job&&['queued','running','reconciling'].includes(job.state))foot+=btn('查看研究进度','benchmark-research-watch',true,'data-account="'+id+'" data-job="'+esc(job.job_id)+'"');}
 presentOwnedDialog(context,display,{title:(study.account.profile?.display_name??study.account.name)+' · 账号研究 · '+(study.tab==='materials'?'资料':'研究报告'),body:researchTabs(study.account.id,study.tab)+(error?'<p class="benchmark-error" role="alert">'+esc(error)+'</p>':'')+body,foot});
}
async function loadResearch(context:FeatureContext,study:Study,display:DisplayRequest){
 const view=await checked(context.client.request<AccountResearchView>('GET','/api/v1/accounts/'+encodeURIComponent(study.account.id)+'/research',undefined,{signal:context.signal}),display);
 study.research=view;return view;
}
async function showReport(context:FeatureContext,study:Study,jobId:string,display:DisplayRequest){
 const view=await loadResearch(context,study,display),item=view.history.find(h=>h.job_id===jobId);if(!item)throw new Error('研究任务不属于当前账号');
 const detail=await checked(context.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(jobId),undefined,{signal:context.signal}),display),manifest=JSON.parse(detail.job.input_manifest) as {research_context?:{plan:AccountResearchPlan};input_evidence?:ResearchEvidenceView[]};
 const candidates=await checked(context.client.request<{items:Array<{id:string;job_id:string}>}>('GET','/api/v1/documents/'+encodeURIComponent(item.document_id)+'/candidates',undefined,{signal:context.signal}),display),row=candidates.items.find(candidate=>candidate.job_id===item.job_id);
 const candidate=row?await checked(context.client.request<CandidatePreview>('GET','/api/v1/candidates/'+encodeURIComponent(row.id),undefined,{signal:context.signal}),display):undefined;
 let text=candidate?.text??'';
 if(item.adopted_revision_id)text=(await checked(context.client.request<{text:string}>('GET','/api/v1/documents/'+encodeURIComponent(item.document_id)+'/revisions/'+encodeURIComponent(item.adopted_revision_id),undefined,{signal:context.signal}),display)).text;
 let report:AccountResearchReport|null=null;try{const parsed=JSON.parse(text);if(parsed.schema_version===1&&Array.isArray(parsed.analyses)&&Array.isArray(parsed.recommendations))report=parsed;}catch{/* 保留历史 Markdown 的原文展示，不冒充新结构。 */}
 display.check();study.tab='report';study.report={item,plan:manifest.research_context?.plan??view.plan,evidence:manifest.input_evidence??[],report,text,candidate};presentStudy(context,study,display);
}
async function observeResearch(context:FeatureContext,study:Study,accepted:{job_id:string;document_id?:string},display:DisplayRequest){
 const relevant=()=>display.current();
 const completed=await waitForegroundGeneration(displayContext(context,display),accepted,'研究账号的创作与运营方法',relevant,true,{queued:'等待研究执行器领取…',running:'正在对照固定作品，拆解内容与运营方法…',note:'已冻结研究策略、正文来源与数据范围。完成后生成候选，采用前不替换历史报告。'});
 if(!completed||!relevant())return;
 // 结果读取期间保留前台身份；呈现报告时直接替换进度，避免内部 close 与用户关闭混用。
 await loadResearch(context,study,display);
 if(relevant()&&context.surface.isForegroundJobActive?.(accepted.job_id))await showReport(context,study,accepted.job_id,display);
}
async function openStudy(context:FeatureContext,id:string,display=beginDisplay(context)){
 const account=(await listManualAccounts(context,display)).find(a=>a.id===id);if(!account)throw new Error('对标账号不存在');
 const sync=await checked(context.client.request<JsonObject>('GET','/api/v1/accounts/'+encodeURIComponent(id)+'/feed-sync',undefined,{signal:context.signal}),display);
 const page=typeof sync.source_id==='string'?await checked(context.client.request<Page<SourceRecordSummary>>('GET','/api/v1/source-records?'+new URLSearchParams({source:sync.source_id,order:'published_desc',limit:'50'}),undefined,{signal:context.signal}),display):{items:[],next_cursor:null};
 display.check();const study:Study={account,sync,rows:page.items,next:page.next_cursor,busy:false,tab:'materials'};studies.set(context.client,study);display.study=study;presentStudy(context,study,display);
}

export async function listManualAccounts(context: FeatureContext,display?:DisplayRequest): Promise<AccountSummary[]> {const rows:AccountSummary[]=[];let cursor:string|null=null;do{const params=new URLSearchParams({role:'benchmark'});if(cursor)params.set('cursor',cursor);const page=await context.client.request<Page<AccountSummary>>('GET','/api/v1/accounts?'+params,undefined,{signal:context.signal});display?.check();rows.push(...page.items);cursor=page.next_cursor;}while(cursor);return rows;}

export async function dispatchManualAccount(action: FeatureAction, context: FeatureContext): Promise<boolean> {
  const { esc, btn } = createTemplateHelpers([]);
  if (action.action === 'add-account') {
    invalidateManualAccountDialog(context.client);
    context.surface.presentDialog({ title: '添加对标账号', body: '<label class="field-label" for="account-name">账号名称</label><input class="field" id="account-name" placeholder="输入你想跟踪的账号"><label class="field-label" for="account-platform">平台</label><select class="field" id="account-platform" style="width:100%">' + Object.keys(P).map(platform => '<option value="' + platform + '">' + P[platform]!.name + '</option>').join('') + '</select><label class="field-label" for="account-url">主页链接</label><input class="field" id="account-url" placeholder="https://…"><p class="fine" style="margin-top:15px">保存后身份待核对，尚未采集。</p>', foot: btn('取消', 'close-dialog') + btn('添加到跟踪', 'save-account', true) }); return true;
  }
  if (action.action === 'save-account') {
    const name = String(action.fields['account-name'] ?? '').trim(), url = String(action.fields['account-url'] ?? '').trim(), platform = String(action.fields['account-platform'] ?? '') as Platform;
    if (!name || !url) { context.surface.toast('请填写账号名称和主页链接'); return true; }
    const saved=await context.client.request<{account_id:string}>('POST', '/api/v1/accounts', { role: 'benchmark', platform, name, url }, { signal: context.signal, idempotencyKey: crypto.randomUUID() });
    context.surface.closeDialog('completed'); context.surface.updateUi({ sourceTab: 'accounts' });
    try{await context.client.request('POST','/api/v1/accounts/'+encodeURIComponent(saved.account_id)+'/identity-check',{}, {signal:context.signal,idempotencyKey:crypto.randomUUID()});await openStudy(context,saved.account_id);context.surface.toast('平台资料已读取，可继续采集作品。');}catch(error){context.surface.toast('账号已保存，平台资料读取未完成：'+(error instanceof Error?error.message:'请重试'));}return true;
  }
  if (action.action === 'account-detail') {
    await openStudy(context,action.dataset.id??'');return true;
  }
  if(action.action.startsWith('benchmark-')&&action.action!=='benchmark-retro'){
   const study=studies.get(context.client),accountId=action.dataset.account??study?.account.id;
   if(!study||accountId!==study.account.id)throw new Error('请先打开对应账号研究');if(study.busy&&!['benchmark-list','benchmark-materials','benchmark-research','benchmark-report','benchmark-record'].includes(action.action))return true;
   const display=beginDisplay(context,study);
   study.busy=true;context.surface.dialogBusy?.(true);
   try{
    if(action.action==='benchmark-list')await openStudy(context,accountId,display);
    else if(action.action==='benchmark-materials'){study.tab='materials';study.report=undefined;presentStudy(context,study,display);}
    else if(action.action==='benchmark-research'){study.tab='report';study.report=undefined;await loadResearch(context,study,display);presentStudy(context,study,display);}
    else if(action.action==='benchmark-report')await showReport(context,study,action.dataset.job??study.research?.history[0]?.job_id??'',display);
    else if(action.action==='benchmark-research-run'){
     const view=await loadResearch(context,study,display);if(view.plan.blocked)throw new Error(view.plan.blocked);
     const settings=await checked(context.client.getSettings(context.signal),display),body={source_record_ids:view.plan.source_record_ids,input_version:view.plan.input_version,executor:settings.default_executor,...(context.skillSelection?.('research')?{skill_route:context.skillSelection('research')}:{})};
     const accepted=await checked(context.client.request<{job_id:string;document_id:string}>('POST','/api/v1/accounts/'+encodeURIComponent(accountId)+'/research',body,{signal:context.signal,idempotencyKey:crypto.randomUUID()}),display);await observeResearch(context,study,accepted,display);
    }else if(action.action==='benchmark-research-watch')await observeResearch(context,study,{job_id:action.dataset.job!},display);
    else if(action.action==='benchmark-research-resume'){
     if(!study.research?.history.some(h=>h.job_id===action.dataset.job))throw new Error('研究任务不属于当前账号');
     const detail=await checked(context.client.request<JobDetailResponse>('GET','/api/v1/jobs/'+encodeURIComponent(action.dataset.job!),undefined,{signal:context.signal}),display);await checked(context.client.request('POST','/api/v1/jobs/'+encodeURIComponent(action.dataset.job!)+'/resume',{expected_version:detail.job.version},{signal:context.signal,idempotencyKey:crypto.randomUUID()}),display);await observeResearch(context,study,{job_id:action.dataset.job!},display);
    }else if(action.action==='benchmark-research-adopt'){
     const report=study.report;if(!report?.candidate||report.candidate.id!==action.dataset.candidate||report.item.adopted_revision_id)throw new Error('请选择当前待采用的研究候选');
     await checked(context.client.request('POST','/api/v1/candidates/'+encodeURIComponent(report.candidate.id)+'/adoption',{expected_revision_id:report.candidate.base_revision_id},{signal:context.signal,idempotencyKey:crypto.randomUUID()}),display);await showReport(context,study,report.item.job_id,display);context.surface.toast('研究报告已采用；创作建议仍需你选择后实践。');
    }
    else if(action.action==='benchmark-profile'){await checked(context.client.request('POST','/api/v1/accounts/'+encodeURIComponent(accountId)+'/identity-check',{}, {signal:context.signal,idempotencyKey:crypto.randomUUID()}),display);await openStudy(context,accountId,display);context.surface.toast('平台资料已刷新。');}
    else if(action.action==='benchmark-sync'||action.action==='benchmark-backfill'){
     const older=action.action==='benchmark-backfill',accepted=await checked(context.client.request<{job_id:string}>('POST','/api/v1/accounts/'+encodeURIComponent(accountId)+'/feed-sync',older?{scope:'older_page'}:{},{signal:context.signal,idempotencyKey:crypto.randomUUID()}),display);
     const result=await waitForegroundGeneration(displayContext(context,display),accepted,older?'补采更早作品':'采集最新作品',()=>display.current(),true,{queued:'等待平台采集…',running:'正在读取平台作品、媒体与互动数据…',note:'每次读取一页，已有作品去重、指标追加快照，失败保留已有素材。'});
     if(result){await openStudy(context,accountId,display);context.surface.toast('平台作品已保存。');}
    }else if(action.action==='benchmark-more'&&study.next&&typeof study.sync.source_id==='string'){
     const page=await checked(context.client.request<Page<SourceRecordSummary>>('GET','/api/v1/source-records?'+new URLSearchParams({source:study.sync.source_id,order:'published_desc',limit:'50',cursor:study.next}),undefined,{signal:context.signal}),display),ids=new Set(study.rows.map(r=>r.id));study.rows.push(...page.items.filter(r=>!ids.has(r.id)));study.next=page.next_cursor;presentStudy(context,study,display);
    }else if(action.action==='benchmark-record'){
     const trusted=study.rows.some(r=>r.id===action.dataset.id)||study.research?.plan.samples.some(s=>s.source_id===action.dataset.id)||study.report?.plan.samples.some(s=>s.source_id===action.dataset.id);
     if(!trusted)throw new Error('作品不属于当前账号的已采集列表或固定研究样本');
     const record=await checked(context.client.request<SourceRecordDetail>('GET','/api/v1/source-records/'+encodeURIComponent(action.dataset.id!),undefined,{signal:context.signal}),display);context.signal.throwIfAborted();
     presentOwnedDialog(context,display,{title:record.title,body:renderBenchmarkRecord(record),foot:btn(study.tab==='report'?'返回研究报告':'返回账号资料',study.tab==='report'?'benchmark-research':'benchmark-materials',false,'data-account="'+esc(accountId)+'"')+btn('进入资料阅读器','read-news',true,'data-id="'+esc(record.id)+'"')});
    }
   }catch(error){if(display.current()){const message=error instanceof Error?error.message:'平台资料读取未完成，已有素材保留';presentStudy(context,study,display,message);context.surface.toast(message);}}
   finally{if(display.current()){study.busy=false;context.surface.dialogBusy?.(false);}}return true;
  }
  return false;
}
