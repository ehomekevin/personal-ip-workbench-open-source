import type {TopicSummary,Platform,ContentFormat} from '@workbench/contracts';
import type {TopicView,VariantView} from '../app/view-model.ts';
export const DEFAULT_FORMAT:Record<Platform,ContentFormat>={xiaohongshu:'image_post',wechat:'article',x:'text',douyin:'short_video',bilibili:'long_video'};
export function projectTopicSummary(topic:TopicSummary):TopicView{
 const state=topic.read_state,versions:Record<string,VariantView>={};
 for(const variant of state?.variants??[]){if(!variant.head_revision_id||variant.format!==DEFAULT_FORMAT[variant.platform])continue;versions[variant.platform]={title:topic.title,text:'',rev:variant.document_version,edited:false,status:variant.based_on_core_revision_id===state!.core_revision_id&&state!.core_confirmed?'已保存版本 · 打开读取':'核心稿已变化',contentLoaded:false,historyAvailable:!!variant.parent_revision_id};}
 return {id:topic.id,title:topic.title,category:topic.category,source:'',confirmed:state?.core_confirmed??false,coreRev:state?.core_version??0,core:'',versions,assets:[],shots:[],detailsLoaded:false};
}
