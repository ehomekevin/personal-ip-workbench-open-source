import type {DatabaseSync} from 'node:sqlite';
import type {StudioSlot,StudioBrief} from '../../../contracts/src/image-studio.ts';
export interface StudioState {version:number;topic_id:string;slots:StudioSlot[];briefs:StudioBrief[];brief_invocations:Record<string,{id:string;state:'intent'|'running'|'completed'|'unknown'|'retryable';native:Record<string,unknown>;input:unknown;error:string|null}>;events:Array<{id:string;at:string;kind:string;payload:unknown}>;wiki_record:string|null}
const key=(workspace:string,topic:string)=>'wechat-image-studio.v1:'+workspace+':'+topic;
export function readStudio(db:DatabaseSync,workspace:string,topic:string):StudioState {const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(key(workspace,topic));return row?JSON.parse(String(row.value)):{version:1,topic_id:topic,slots:[],briefs:[],brief_invocations:{},events:[],wiki_record:null};}
export function writeStudio(db:DatabaseSync,workspace:string,value:StudioState){db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key(workspace,value.topic_id),JSON.stringify(value));}
// 真实生图提交计数按工作区、按渠道持久保存；只在同一写事务里与入队一起提交，入队失败随事务回滚。
export interface StudioGenerationBudget {codex:number;agy:number}
const budgetKey=(workspace:string)=>'image-studio-generation-budget.v1:'+workspace;
export function readGenerationBudget(db:DatabaseSync,workspace:string):StudioGenerationBudget {const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(budgetKey(workspace));const value=row?JSON.parse(String(row.value)):{};return{codex:Number(value.codex??0),agy:Number(value.agy??0)};}
export function recordGenerationSubmit(db:DatabaseSync,workspace:string,provider:'codex'|'agy'):StudioGenerationBudget {if(!db.isTransaction)throw new Error('Generation budget requires the writing transaction');const next=readGenerationBudget(db,workspace);next[provider]++;db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(budgetKey(workspace),JSON.stringify(next));return next;}
// 配图方案（A2）：独立 key、带版本；与配图槽位状态分开保存，写入须在调用方的写事务里。
import type {ImagePlanState} from '../../../contracts/src/image-plan.ts';
const planKey=(workspace:string,topic:string)=>'wechat-image-plan.v1:'+workspace+':'+topic;
export function readImagePlan(db:DatabaseSync,workspace:string,topic:string):ImagePlanState {const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(planKey(workspace,topic));return row?JSON.parse(String(row.value)):{schema_version:'image-plan/1',topic_id:topic,version:1,run:null,plan:null};}
export function writeImagePlan(db:DatabaseSync,workspace:string,value:ImagePlanState){if(!db.isTransaction)throw new Error('Image plan writes require the writing transaction');db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(planKey(workspace,value.topic_id),JSON.stringify(value));}
// 配图终稿（A2-2）：确认时冻结的一份，独立 key；写入须在调用方的写事务里。
import type {ImagePlanFinal} from '../../../contracts/src/image-plan.ts';
const finalKey=(workspace:string,topic:string)=>'wechat-image-plan-final.v1:'+workspace+':'+topic;
export function readImagePlanFinal(db:DatabaseSync,workspace:string,topic:string):ImagePlanFinal|null {const row=db.prepare('SELECT value FROM application_metadata WHERE key=?').get(finalKey(workspace,topic));return row?JSON.parse(String(row.value)) as ImagePlanFinal:null;}
export function writeImagePlanFinal(db:DatabaseSync,workspace:string,value:ImagePlanFinal){if(!db.isTransaction)throw new Error('Image plan final writes require the writing transaction');db.prepare('INSERT INTO application_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(finalKey(workspace,value.topic_id),JSON.stringify(value));}
