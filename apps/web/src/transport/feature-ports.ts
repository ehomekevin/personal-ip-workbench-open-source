import { WORKBENCH_PAGES } from '@workbench/contracts';
import type { HostBridge, ServiceIdentity, WorkbenchPage, OpenWorkbenchRequest, Platform, SkillRouteSelection, SkillPurpose } from '@workbench/contracts';
import type { UiState, ViewContext, EditorFeedback } from '../app/view-model.ts';
import type { WorkbenchClient } from './workbench-client.ts';
import type { FeatureOperation } from './approved-operations.ts';
import type { DraftRegistry } from './drafts.ts';

export function parsePage(value:string|undefined):WorkbenchPage { return WORKBENCH_PAGES.includes(value as WorkbenchPage)?value as WorkbenchPage:'today'; }
// 球体只在 running 播放；queued/waiting/failed 用静态态。timing 只来自服务时间戳，不推算进度；details 是默认收起的诊断层。
export interface GenerationProgressView { state:'queued'|'running'|'waiting'|'failed'|'succeeded'; message:string; note:string; label?:string; timing?:{since:string;last_output_at:string|null;stale_after_ms?:number}; details?:{label:string;value:string}[]; /** 生图任务：用像素马赛克加载动效代替球体（素材须为同源图）。 */ image?:{images:string[];width:number;height:number} }
export interface DialogView { title:string; body:string; foot?:string; foregroundJob?:{id:string;version:number;keepOnDismiss?:boolean}; generationProgress?:GenerationProgressView; progressKey?:string }
export type UiViewPatch=Partial<Omit<UiState,'page'|'task'>>;
export type {EditorFeedback} from '../app/view-model.ts';
// 前台任务停止跟随的原因：cancel 只取消当前任务；user_close/escape/navigate 表示用户不再跟随。
export type ForegroundDismissReason='user_close'|'escape'|'cancel'|'navigate';
export interface UiSurface { dialogBusy?(busy:boolean):void; isForegroundJobActive?(jobId:string):boolean; foregroundCloseReason?(jobId:string):ForegroundDismissReason|undefined; updateUi(patch:UiViewPatch):void; editorFeedback(feedback:EditorFeedback):void; presentDialog(dialog:DialogView):void; closeDialog(reason:'user_close'|'cancel'|'escape'|'completed'):void; toast(message:string):void; navigate(page:WorkbenchPage):void; openPublishingSettings?(platform:Platform,accountId?:string):void }
export interface FeatureContext { client:WorkbenchClient; hostBridge?:HostBridge; identity:ServiceIdentity; ui:Readonly<UiState>; signal:AbortSignal; readSignal?:AbortSignal; surface:UiSurface; drafts:DraftRegistry; skillSelection?(purpose:SkillPurpose,platform?:Platform):SkillRouteSelection|undefined }
export interface FeatureAction { action:FeatureOperation; dataset:Readonly<Record<string,string>>; fields:Readonly<Record<string,string|boolean>>; files?:ReadonlyArray<File> }
export interface PageFeaturePort<P extends WorkbenchPage=WorkbenchPage> {
  page:P;
  load(context:FeatureContext):Promise<ViewContext>;
  loadMore?(context:FeatureContext):Promise<ViewContext>;
  dispatch(action:FeatureAction, context:FeatureContext):Promise<ViewContext|void>;
  input?(action:FeatureAction, context:FeatureContext):Promise<void>;
}
export type FeaturePorts = { [P in WorkbenchPage]?:PageFeaturePort<P> };
export interface WorkbenchInjection { mode:'demo'|'real'; client?:WorkbenchClient; hostBridge?:HostBridge; features?:FeaturePorts; initialPage?:WorkbenchPage; initialLocation?:OpenWorkbenchRequest }
