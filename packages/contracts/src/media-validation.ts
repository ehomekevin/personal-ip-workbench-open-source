import {objectSchema} from './validation.ts';
import type {ContentRenderRequest,ProductionRenderRequest,AssetGenerationRequest} from './media.ts';
import {ImageGenerationSchema} from './image-providers.ts';
const text={type:'string',minLength:1},mode={type:'string',enum:['preview','export']};
export const ContentRenderSchema=objectSchema<ContentRenderRequest>(['content_plan_revision_id','preset','mode'],{content_plan_revision_id:text,preset:text,mode});
export const ProductionRenderSchema=objectSchema<ProductionRenderRequest>(['production_plan_revision_id','preset','mode'],{production_plan_revision_id:text,preset:text,mode});
const H3GenerationSchema=objectSchema<AssetGenerationRequest>(['topic_id','purpose','prompt','input_asset_ids','generator'],{topic_id:text,purpose:text,prompt:text,input_asset_ids:{type:'array',maxItems:32,items:text},generator:{type:'string',enum:['h3']}});
export const AssetGenerationSchema={jsonSchema:{oneOf:[H3GenerationSchema.jsonSchema,ImageGenerationSchema.jsonSchema]},parse(value:unknown):AssetGenerationRequest{
  return value&&typeof value==='object'&&'generator' in value&&value.generator==='image'?ImageGenerationSchema.parse(value):H3GenerationSchema.parse(value);
}};
