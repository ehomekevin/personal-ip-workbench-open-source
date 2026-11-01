import { ContractError } from '@workbench/contracts';

export const STUDIO_DESCRIPTION_LIMIT = 8000;
export const STUDIO_CONTEXT_LIMIT = 8000;
export const STUDIO_COMBINED_LIMIT = STUDIO_DESCRIPTION_LIMIT + STUDIO_CONTEXT_LIMIT;
export interface StudioPromptParent {
  asset_id:string|null;
  description:string;
  actual_size:{width:number;height:number}|null;
}
export interface StudioPromptBudget {
  description_chars:number;
  context_chars:number;
  combined_chars:number;
}
// The two fields have independent application limits. The joining newline is a
// transport separator, not user content or a native-model capacity claim.
export function buildStudioPromptContext(input:{paragraph:string;title:string;parent?:StudioPromptParent|null}):string {
  return '本篇段落：'+input.paragraph+'\n'+(input.title?'可选标题：'+input.title+'\n':'')+
    '品牌色海军蓝与青柠；不捏造未提供的Logo、人物或字体。不自动发布或替本人采用。'+
    (input.parent?'\n这是基于本篇实际保存图像版本的新生成任务：旧图asset='+input.parent.asset_id+'，原说明='+input.parent.description+'，实际尺寸='+JSON.stringify(input.parent.actual_size?{width:input.parent.actual_size.width,height:input.parent.actual_size.height}:null)+'；保留旧版，不宣称像素级编辑。':'');
}
export function studioPromptBudget(description:string,context:string):StudioPromptBudget {
  return {description_chars:description.length,context_chars:context.length,combined_chars:description.length+context.length};
}
export function validateStudioPromptBudget(description:string,context:string):StudioPromptBudget {
  const budget=studioPromptBudget(description,context);
  if(budget.description_chars>STUDIO_DESCRIPTION_LIMIT)throw new ContractError('VALIDATION_ERROR','画面说明最多 8000 字，当前 '+budget.description_chars+' 字；请缩短说明后再提交。',{field:'description',limit:STUDIO_DESCRIPTION_LIMIT,...budget});
  if(budget.context_chars>STUDIO_CONTEXT_LIMIT)throw new ContractError('VALIDATION_ERROR','关联段落、标题、品牌与旧版说明合计最多 8000 字，当前 '+budget.context_chars+' 字；请选较短段落或新建配图，原文会保留。',{field:'context_prompt',limit:STUDIO_CONTEXT_LIMIT,...budget});
  return budget;
}
