import test from 'node:test';
import assert from 'node:assert/strict';
import {ImageGenerationSchema,imageProviderPrompt} from '../../packages/contracts/src/image-providers.ts';
import {buildStudioPromptContext,validateStudioPromptBudget,studioPromptBudget} from '../../packages/domain/src/artifact-execution/image-studio/prompt.ts';

const image={generator:'image' as const,provider:'agy' as const,operation:'generate' as const,topic_id:'topic',purpose:'正文图',prompt:'说明',input_asset_ids:[],parent_asset_id:null,document_revision_id:'revision',plan_revision_id:null};
const binding={slot_id:'slot',version_id:'version',document_id:'document',paragraph_id:'paragraph',placement_paragraph_id:'anchor',position:'after' as const,title:'标题',parent_version_id:null,references:[]};
test('说明8000与独立上下文可完整通过，默认图片prompt边界不放宽',()=>{
  const description='说明'.repeat(4000),context=buildStudioPromptContext({paragraph:'真实文章段落',title:'合法长说明'});
  assert.doesNotThrow(()=>validateStudioPromptBudget(description,context));
  const request={...image,prompt:description,studio_binding:{...binding,context_prompt:context}};
  assert.deepEqual(ImageGenerationSchema.parse(request),request);
  assert.equal(imageProviderPrompt(request),description+'\n'+context);
  assert.throws(()=>ImageGenerationSchema.parse({...image,prompt:description+'长'}),/字符串过长/);
});
test('旧请求缺context时prompt字节不变，空或过长新context合同拒绝',()=>{
  const original='  原说明\n末尾空格  ';
  assert.equal(imageProviderPrompt({...image,prompt:original}),original);
  assert.equal(imageProviderPrompt({...image,prompt:original,studio_binding:binding}),original);
  for(const context_prompt of ['', '长'.repeat(8001)])assert.throws(()=>ImageGenerationSchema.parse({...image,studio_binding:{...binding,context_prompt}}));
});
test('两字段内容总边界16000，拼接换行单列为传输分隔符',()=>{
  const description='说'.repeat(8000),context='段'.repeat(8000);
  assert.deepEqual(validateStudioPromptBudget(description,context),{description_chars:8000,context_chars:8000,combined_chars:16000});
  assert.equal(imageProviderPrompt({...image,prompt:description,studio_binding:{...binding,context_prompt:context}}).length,16001);
});
test('过长说明或组合上下文以可用中文边界拒绝，没有截断人工内容',()=>{
  const description='完整说明'.repeat(2001),context=buildStudioPromptContext({paragraph:'全文'.repeat(4000),title:'原标题'});
  assert.throws(()=>validateStudioPromptBudget(description,'段落'),/画面说明最多 8000 字/);
  assert.throws(()=>validateStudioPromptBudget('说明',context),/关联段落、标题、品牌与旧版说明合计最多 8000 字/);
  assert.equal(description.length,8004);assert.ok(context.includes('全文'.repeat(4000)));
});
test('旧版描述完整计入上下文，尺寸结构稳定供界面与服务计数',()=>{
  const parent={asset_id:'real-old-asset',description:'  旧说明原文  ',actual_size:{width:1600,height:900,aspect_ratio:'16:9'}};
  const context=buildStudioPromptContext({paragraph:'  当前段落  ',title:' 标题 ',parent});
  assert.ok(context.includes(parent.description));assert.ok(context.includes('  当前段落  '));assert.ok(context.includes(' 标题 '));
  assert.ok(context.includes('实际尺寸={"width":1600,"height":900}'));
  assert.deepEqual(studioPromptBudget(' 原说明 ',context),{description_chars:5,context_chars:context.length,combined_chars:5+context.length});
});
