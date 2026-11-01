import {ContractError,type ImagePlanFinal,type RequestContext} from '@workbench/contracts';
import type {ArticleLayoutSourceBinding,ArticleTextBlock,ArticleLayoutSnapshot} from '../../../contracts/src/article-layout.ts';
import {readImagePlanFinal,readStudio} from '../../../storage/src/image-studio/index.ts';
import {joinCaption} from './caption.ts';
import type {ApplicationContext} from '../ports/index.ts';
import type {ArticleAdoptedImageSource} from './service.ts';
import {isArticleTextBlock,sha256} from './index.ts';
// 公众号排版（C1）的图片 producer：只读「配图终稿」（POST /api/v1/image-studio/plan/confirm 冻结的那份），输出图片块输入。
// 位置按初始化时建立的「段落 → 文字块」映射换算；图片事实（资产、版本、文件摘要、像素）全部来自终稿，不接受编辑请求里的图片。
export const PLAN_FINAL_PRODUCER='image-plan-final/1';
export const layoutArticleId=(topic:string)=>'wechat-layout:'+topic;
export const layoutImageBlockId=(topic:string,itemId:string)=>'image-'+sha256(topic+'\0'+itemId).slice(0,24);
/** 网络图图注末尾追加图源（来源名 + 原网页链接，C2）；AI 生图只用方案图注。 */
export function layoutCaption(caption:string,credit:string|null,url:string|null=null):string{const c=credit?.trim();if(!c)return caption;return joinCaption(caption,{label:c,url});}
/** 网络图的原网页链接：只读配图记录里这一版的来源（不改配图数据）；读不到时只标来源名。 */
export type CreditUrlLookup=(item:ImagePlanFinal['items'][number])=>string|null;
export function studioCreditUrls(context:ApplicationContext,request:RequestContext,topic:string):CreditUrlLookup{
 let studio:ReturnType<typeof readStudio>|null=null;
 return item=>{if(!item.credit_label)return null;try{studio??=readStudio(context.db,request.workspace_id,topic);}catch{return null;}
  const url=studio.slots.find(s=>s.id===item.slot_id)?.versions.find(v=>v.id===item.version_id)?.source?.page_url;return typeof url==='string'&&/^https?:\/\//.test(url)?url:null;};
}
/**
 * 段落 → 文字块：配图方案的段落按空行切分（与配图工作台同一规则），按顺序在原文里定位每段首尾字符，
 * 找到包含它们的文字块（含标题/引用前缀）。一段被拆成多块时 first/last 不同；多段合成一块（如「我的看法」）时指向同一块。
 */
export function mapParagraphBlocks(text:string,paragraphs:Array<{id:string;text:string}>,snapshot:Pick<ArticleLayoutSnapshot,'blocks'|'content_order'>):Record<string,{first:string;last:string}>{
 const byId=new Map(snapshot.blocks.filter(isArticleTextBlock).map(b=>[b.id,b])),ranges:Array<{id:string;start:number;end:number}>=[];let offset=0;
 for(const id of snapshot.content_order){const b=byId.get(id) as ArticleTextBlock|undefined;if(!b)continue;const len=b.source_prefix.length+b.text.length+b.source_suffix.length;if(b.text.trim())ranges.push({id,start:offset,end:offset+len});offset+=len;}
 const at=(pos:number)=>ranges.find(r=>r.start<=pos&&pos<r.end)?.id,out:Record<string,{first:string;last:string}>={};let cursor=0;
 for(const p of paragraphs){const start=text.indexOf(p.text,cursor);if(start<0||!p.text)continue;const end=start+p.text.length;cursor=end;const first=at(start),last=at(end-1);if(first&&last)out[p.id]={first,last};}
 return out;
}
type ProducerImage=Awaited<ReturnType<ArticleAdoptedImageSource['load']>>['images'][number];
/** 终稿 → 图片块输入（方案顺序）。封面放在文章标题之后（没有标题时放最前）；锚点段落不在映射里时由排版追加到末尾。 */
export function imagesFromFinal(topic:string,final:ImagePlanFinal,source:Pick<ArticleLayoutSourceBinding,'paragraph_blocks'>,titleBlockId:string|null,creditUrl:CreditUrlLookup=()=>null):ProducerImage[]{
 return final.items.map(item=>{
  const map=source.paragraph_blocks[item.paragraph_id],placement:{anchor_block_id:string|null;position:'before'|'after'}=item.position==='cover'?(titleBlockId?{anchor_block_id:titleBlockId,position:'after'}:{anchor_block_id:null,position:'before'}):!map?{anchor_block_id:'missing:'+item.paragraph_id,position:'after'}:item.position==='before'?{anchor_block_id:map.first,position:'before'}:{anchor_block_id:map.last,position:'after'};
  return{id:layoutImageBlockId(topic,item.item_id),image:{asset_id:item.asset_id,version_id:item.version_id,sha256:item.sha256,url:item.url,pixel_width:item.pixel_width,pixel_height:item.pixel_height,source_sha256:final.id,...(item.credit_label?.trim()?{credit:{label:item.credit_label.trim(),url:creditUrl(item)}}:{})},caption:layoutCaption(item.caption,item.credit_label,item.credit_label?.trim()?creditUrl(item):null),...(placement.position==='after'?{after_block_id:placement.anchor_block_id}:{}),placement};
 });
}
/** 读当前配图终稿；终稿须属于这篇平台稿，且与排版初始化时的正文修订一致（段落映射才成立）。 */
export function readLayoutFinal(context:ApplicationContext,request:RequestContext,topic:string,expected:{document_id:string;document_revision_id?:string}):ImagePlanFinal{
 const final=readImagePlanFinal(context.db,request.workspace_id,topic);if(!final)throw new ContractError('VALIDATION_ERROR','还没有确认配图，先在配图里确认');
 if(final.document_id!==expected.document_id||expected.document_revision_id!==undefined&&final.document_revision_id!==expected.document_revision_id)throw new ContractError('INPUT_STALE','平台稿在排版开始后改过，这次确认的配图不能直接同步到排版');
 return final;
}
export class PlanFinalImageSource implements ArticleAdoptedImageSource {
 readonly context:ApplicationContext;readonly topic:string;readonly source:ArticleLayoutSourceBinding;readonly titleBlockId:string|null;
 constructor(context:ApplicationContext,topic:string,source:ArticleLayoutSourceBinding,titleBlockId:string|null){this.context=context;this.topic=topic;this.source=source;this.titleBlockId=titleBlockId;}
 async load(request:RequestContext,documentId:string){
  const final=readLayoutFinal(this.context,request,this.topic,{document_id:documentId,document_revision_id:this.source.document_revision_id});
  return{document_revision_id:final.document_revision_id,producer_version:PLAN_FINAL_PRODUCER,source_sha256:final.id,images:imagesFromFinal(this.topic,final,this.source,this.titleBlockId,studioCreditUrls(this.context,request,this.topic))};
 }
}
