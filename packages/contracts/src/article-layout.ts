/** Article layout contract. 公众号排版（C1）经 /api/v1/article-layout 接入；排版只写自己的块版本，不回写平台稿。 */
export type ArticleTextKind = 'title' | 'lead' | 'heading' | 'paragraph' | 'opinion';
export interface ArticleTextBlock { id: string; kind: ArticleTextKind; text: string; original_text: string; source_prefix: string; source_suffix: string }
/** 网络找图的图源（C2）：来源名与原网页链接，来自配图终稿与配图记录，属于图片事实（编辑请求不能改）；AI 生图没有。 */
export interface ArticleImageCredit { label: string; url: string | null }
export interface ArticleImageReference { asset_id: string; version_id: string; sha256: string; url: string; pixel_width: number; pixel_height: number; source_sha256: string; credit?: ArticleImageCredit }
export interface ArticleImageBlock { id: string; kind: 'image'; image: ArticleImageReference; caption: string; original_caption: string; display_width_percent: number }
export interface ArticleBrandBlock { id: string; kind: 'divider' | 'follow' }
export type ArticleBlock = ArticleTextBlock | ArticleImageBlock | ArticleBrandBlock;
export interface ArticleStyle {
  mobile_width: number; page_padding: number; title_font: string; body_font: string;
  title_size: number; title_line_height: number; heading_size: number; heading_line_height: number;
  body_size: number; body_line_height: number; letter_spacing: number; paragraph_gap: number; section_gap: number;
  caption_size: number; caption_align: 'left' | 'center' | 'right'; text_color: string; accent_color: string;
  muted_color: string; panel_color: string; divider_color: string; radius: number;
}
export interface ArticleLayoutStandard { version: string; png_sha256: string; html_sha256: string }
/** Opaque upstream producer hash (Document/review hash); retain unchanged, never reinterpret as aggregate article text_hash. */
export interface ArticleReviewBinding { document_revision_id: string; text_hash: string; review_id: string; status: string }
export interface ArticleContentRevision {
  id: string; parent_id: string | null; document_revision_id: string | null; text_hash: string; source_text: string;
  text_blocks: ArticleTextBlock[]; captions: Array<{ block_id: string; caption: string; original_caption: string }>;
  content_order: string[]; created_at: string; reason: string;
}
export interface ArticleLayoutRevision {
  id: string; parent_id: string | null; style: ArticleStyle; order: string[]; images: ArticleImageBlock[];
  brands: ArticleBrandBlock[]; standard: ArticleLayoutStandard; images_hash: string; created_at: string; reason: string;
}
export interface LayoutCheckBinding {
  article_id: string; content_revision_id: string; layout_revision_id: string; text_hash: string; images_hash: string;
  standard_version: string; standard_png_sha256: string; standard_html_sha256: string;
  render_snapshot_sha256: string; block_structure_sha256: string;
}
/** Platform-neutral render data. Web consumers must not depend on native/server adapter types. */
export interface LayoutRenderSlice { path: string; sha256: string; width: number; height: number; offset_y: number; block_ids: string[] }
export interface LayoutRenderedBlock {
  id: string; kind: string; text?: string; image?: Record<string, unknown>;
  computed_style: Record<string, string | number | null>;
  bounds: { x: number; y: number; width: number; height: number };
}
export interface LayoutVisualInput {
  binding: LayoutCheckBinding; work_directory: string; render_pngs: LayoutRenderSlice[];
  standard_png: { path: string; sha256: string }; standard_html: { path: string; sha256: string };
  blocks: LayoutRenderedBlock[];
}
export interface LayoutCheckIssue {
  id: string; block_id: string | null; location: string;
  category: 'font' | 'color' | 'spacing' | 'overflow' | 'caption' | 'image' | 'readability' | 'structure';
  problem: string; standard_ref: string; suggestion: string; uncertainty: string | null;
}
export interface LayoutCheckResult { binding: LayoutCheckBinding; verdict: 'passed' | 'issues' | 'uncertain'; issues: LayoutCheckIssue[]; uncertainties: string[] }
export interface LayoutCheckAttempt {
  id: string; job_id: string; attempt_id: string; state: 'intent' | 'running' | 'completed' | 'unknown' | 'cancelled' | 'failed';
  binding: LayoutCheckBinding; native: { provider: string; thread_id: string | null; turn_id: string | null };
  input_manifest_sha256: string; result: LayoutCheckResult | null; created_at: string; updated_at: string;
  cost: number | null; error: string | null;
}
export interface ArticleConfirmation { id: string; actor: string; human_decision_ref: string; confirmed_at: string; binding: Omit<LayoutCheckBinding, 'render_snapshot_sha256' | 'block_structure_sha256'> & {
  /** 确认时的排版渲染/检查规则版本；规则（小节识别、图源显示等）变了，旧确认就不再是当前终稿。C2 早期的确认没有这一项。 */
  rules_version?: string } }
export interface ArticleLayoutEvent { id: string; at: string; kind: string; before_content_revision_id: string; after_content_revision_id: string; before_layout_revision_id: string; after_layout_revision_id: string; details: Record<string, unknown> }
export interface ArticleLayoutSnapshot {
  schema_version: 'article-layout.v1'; article_id: string; document_id: string; version: number;
  content_revision_id: string; document_revision_id: string | null; layout_revision_id: string;
  /** SHA-256 of canonical {source_text: exact source bytes, captions: stable-ID caption entries}; separate from Document file hash. */
  text_hash: string; images_hash: string; original_text: string; upstream_review: ArticleReviewBinding | null;
  standard: ArticleLayoutStandard; blocks: ArticleBlock[]; content_order: string[]; order: string[]; style: ArticleStyle;
  content_history: ArticleContentRevision[]; layout_history: ArticleLayoutRevision[];
  checks: LayoutCheckAttempt[]; active_render: { snapshot_sha256: string; block_structure_sha256: string } | null;
  confirmation: ArticleConfirmation | null; events: ArticleLayoutEvent[];
}
export type ArticleLayoutSaveResult = { state: 'saved'; snapshot: ArticleLayoutSnapshot } | { state: 'conflict'; current: ArticleLayoutSnapshot; local: ArticleLayoutSnapshot; reason: string };
export interface ArticleArchivePlan { article_id: string; confirmation_id: string; process_relative_path: string; wiki_relative_path: string; content_revision_id: string; layout_revision_id: string; text_hash: string; images_hash: string; production_write_authorized: false }

// ——— 公众号排版接入（C1）：配图终稿 → 图文块；排版保存只写排版自己的块版本，不调用 Documents.save。 ———
import {objectSchema} from './validation.ts';
/** 初始化时按段落顺序建立的段落 → 文字块映射（first/last：段落首尾所在的文字块），与配图终稿 id 一起存在排版记录里。 */
export interface ArticleLayoutSourceBinding {topic_id:string;document_id:string;document_revision_id:string;final_id:string;paragraph_blocks:Record<string,{first:string;last:string}>;synced_at:string}
/** synced：排版用的就是最新配图终稿；final_updated：配图已重新确认，可重新同步；plan_changed：配图确认后又改过但还没重新确认；unknown：配图状态暂时读不到。 */
export type ArticleLayoutImageSync='synced'|'final_updated'|'plan_changed'|'unknown';
/** images.credit_missing（C2）：在配图终稿里找不到来源的图片块，图源补不齐，提示重新同步配图。credit_pending：已确认的旧记录不自动补图源，这些图重新同步配图即可补全。 */
export interface ArticleLayoutView {topic_id:string;topic_title:string;snapshot:ArticleLayoutSnapshot;images:{state:ArticleLayoutImageSync;final_confirmed_at:string|null;count:number;credit_missing:string[];credit_pending:string[]}}
export interface ArticleLayoutOpenRequest {topic_id:string}
export interface ArticleLayoutSaveRequest {topic_id:string;expected_version:number;snapshot:ArticleLayoutSnapshot}
export interface ArticleLayoutImageSyncRequest {topic_id:string;expected_version:number}
/** 确认排版（C2）：本机 15 条检查没有阻断项时，把当前文字 + 版式冻结为排版终稿；之后任何修改都会让确认失效。 */
export interface ArticleLayoutConfirmRequest {topic_id:string;expected_version:number}
/** Immutable server-owned render context. v1 execution/proof remains intact. */
export interface ArticleLayoutVisualContext {
 schema_version:'article-layout-visual-context.v2';workspace_id:string;topic_id:string;topic_title:string;
 snapshot_version:number;content_revision_id:string;layout_revision_id:string;text_hash:string;images_hash:string;
 source:ArticleLayoutSourceBinding;rules_version:string;renderer_version:string;snapshot_sha256:string;
}
export interface ArticleLayoutVisualRenderRequest {topic_id:string;expected_version:number}
export interface ArticleLayoutVisualCheckRequest extends ArticleLayoutVisualRenderRequest {render_id:string}
export interface ArticleLayoutVisualQueryRequest {topic_id:string;job_id:string}
export interface ArticleLayoutVisualRenderView {render_id:string;topic_id:string;snapshot_version:number;context_sha256:string;created_at:string}
export interface ArticleLayoutVisualJobView {
 topic_id:string;job_id:string;attempt_id:string|null;render_id:string;snapshot_version:number;context_sha256:string;
 state:'queued'|'running'|'unknown'|'completed'|'cancelled'|'failed'|'stale';phase:string;
 result:LayoutCheckResult|null;current:boolean;can_query:boolean;error:string|null;
}
export interface ArticleLayoutVisualStatus {available:boolean;reason:string|null;latest:ArticleLayoutVisualJobView|null}
const topicId={type:'string',minLength:1,maxLength:100},expected={type:'integer',minimum:1};
export const ArticleLayoutOpenSchema=objectSchema<ArticleLayoutOpenRequest>(['topic_id'],{topic_id:topicId});
export const ArticleLayoutSaveSchema=objectSchema<ArticleLayoutSaveRequest>(['topic_id','expected_version','snapshot'],{topic_id:topicId,expected_version:expected,snapshot:{type:'object'}});
export const ArticleLayoutImageSyncSchema=objectSchema<ArticleLayoutImageSyncRequest>(['topic_id','expected_version'],{topic_id:topicId,expected_version:expected});
export const ArticleLayoutConfirmSchema=objectSchema<ArticleLayoutConfirmRequest>(['topic_id','expected_version'],{topic_id:topicId,expected_version:expected});
export const ArticleLayoutVisualRenderSchema=objectSchema<ArticleLayoutVisualRenderRequest>(['topic_id','expected_version'],{topic_id:topicId,expected_version:expected});
export const ArticleLayoutVisualCheckSchema=objectSchema<ArticleLayoutVisualCheckRequest>(['topic_id','expected_version','render_id'],{topic_id:topicId,expected_version:expected,render_id:topicId});
export const ArticleLayoutVisualQuerySchema=objectSchema<ArticleLayoutVisualQueryRequest>(['topic_id','job_id'],{topic_id:topicId,job_id:topicId});
const visualString={type:'string'},visualNullable={type:['string','null']};
const visualObject=(properties:Record<string,unknown>)=>({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const visualBinding=visualObject(Object.fromEntries(['article_id','content_revision_id','layout_revision_id','text_hash','images_hash','standard_version','standard_png_sha256','standard_html_sha256','render_snapshot_sha256','block_structure_sha256'].map(k=>[k,visualString])));
const visualResult=visualObject({binding:visualBinding,verdict:{enum:['passed','issues','uncertain']},issues:{type:'array',items:visualObject({id:visualString,block_id:visualNullable,location:visualString,category:{enum:['font','color','spacing','overflow','caption','image','readability','structure']},problem:visualString,standard_ref:visualString,suggestion:visualString,uncertainty:visualNullable})},uncertainties:{type:'array',items:visualString}});
const visualJob=visualObject({topic_id:visualString,job_id:visualString,attempt_id:visualNullable,render_id:visualString,snapshot_version:expected,context_sha256:visualString,state:{enum:['queued','running','unknown','completed','cancelled','failed','stale']},phase:visualString,result:{oneOf:[visualResult,{type:'null'}]},current:{type:'boolean'},can_query:{type:'boolean'},error:visualNullable});
const loose={type:'object',additionalProperties:true};
export const ARTICLE_LAYOUT_RESPONSE_SCHEMAS={
 ArticleLayoutVisualRenderView:visualObject({render_id:visualString,topic_id:visualString,snapshot_version:expected,context_sha256:visualString,created_at:visualString}),
 ArticleLayoutVisualJobView:visualJob,
 ArticleLayoutVisualStatus:visualObject({available:{type:'boolean'},reason:visualNullable,latest:{oneOf:[visualJob,{type:'null'}]}}),
 ArticleLayoutView:{type:'object',additionalProperties:false,required:['topic_id','topic_title','snapshot','images'],properties:{topic_id:{type:'string'},topic_title:{type:'string'},snapshot:loose,images:{type:'object',additionalProperties:false,required:['state','final_confirmed_at','count','credit_missing','credit_pending'],properties:{state:{enum:['synced','final_updated','plan_changed','unknown']},final_confirmed_at:{type:['string','null']},count:{type:'integer'},credit_missing:{type:'array',items:{type:'string'}},credit_pending:{type:'array',items:{type:'string'}}}}}},
 ArticleLayoutSaveResult:{type:'object',additionalProperties:false,required:['state'],properties:{state:{enum:['saved','conflict']},snapshot:loose,current:loose,local:loose,reason:{type:'string'}}},
};
