import { ContractError } from './errors.ts';
import { objectSchema } from './validation.ts';
import type { ServiceIdentity } from './common.ts';

export const SKILL_PURPOSES = ['core', 'variant', 'wiki', 'report', 'research'] as const;
export type SkillPurpose = typeof SKILL_PURPOSES[number];
export const SKILL_ROUTE_KEYS = ['core', 'core:ai_test', 'core:news', 'core:thinking', 'variant', 'variant:xiaohongshu', 'variant:wechat', 'variant:x', 'variant:douyin', 'variant:bilibili', 'wiki', 'report', 'research'] as const;
export interface SkillDefinition { name: string; label: string; description: string; version: string; content: string; purposes: SkillPurpose[]; builtin: boolean }
export interface SkillRecipe { id: string; label: string; description: string; purpose: SkillPurpose; skills: string[] }
export interface SkillCatalog { skills: SkillDefinition[]; recipes: SkillRecipe[]; defaults: Record<string, string | null> }
export interface SkillSettingsResponse extends SkillCatalog { identity: ServiceIdentity; version: number; native_support: { codex: 'supported'; claude: 'unverified' } }
export interface PutSkillSettingsRequest extends SkillCatalog { expected_version: number }
export interface SkillRouteSelection { settings_version: number; recipe_id?: string; skills?: string[] }
export interface SkillSampleSelection { id: string; sha256: string; polarity: 'positive'|'negative'; reason: string }
export interface CreateSkillDraftRequest { instruction: string; samples: string; purpose: SkillPurpose; base_local_skill?: {id:string;sha256:string}; sample_selections?: SkillSampleSelection[] }
export interface LocalSkillView { id:string; name:string; label:string; description:string; sha256:string; purposes:SkillPurpose[]; nodes:string[]; reference_count:number; default_selected:boolean; selection_reason:string; reuse_mode:'derive'|'workflow'|'host'; }
export interface SkillLibraryResponse { identity:ServiceIdentity; skills:LocalSkillView[]; vault_root:string|null; video_nodes:Array<{id:string;label:string;skills:string[];default_skill:string|null;required_input:string;execution_status:'not_connected'|'implemented'}> }
export interface SkillSampleView { id:string; sha256:string; title:string; relative_path:string; author:string|null; status:string|null; source_type:string|null; summary:string; }
export interface SkillSamplePage { identity:ServiceIdentity; items:SkillSampleView[]; matched:number; has_more:boolean; }
const name = { type: 'string', minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9-]*$' }, label = { type: 'string', minLength: 1, maxLength: 100 }, description = { type: 'string', minLength: 1, maxLength: 1000 }, version = { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$', maxLength: 32 }, purpose = { type: 'string', enum: SKILL_PURPOSES };
const recipeSchema = { type: 'object', required: ['id','label','description','purpose','skills'], additionalProperties: false, properties: { id: name, label, description, purpose, skills: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: name } } };
const definitionSchema = { type: 'object', required: ['name','label','description','version','content','purposes','builtin'], additionalProperties: false, properties: { name, label, description, version, content: { type: 'string', minLength: 1, maxLength: 65536 }, purposes: { type: 'array', minItems: 1, maxItems: 5, uniqueItems: true, items: purpose }, builtin: { type: 'boolean' } } };
const defaultsSchema = { type: 'object', additionalProperties: false, properties: Object.fromEntries(SKILL_ROUTE_KEYS.map(key => [key, { type: ['string','null'], minLength: 1, maxLength: 64 }])) };
export const SkillRouteSchema = objectSchema<SkillRouteSelection>(['settings_version'], { settings_version: { type: 'integer', minimum: 1 }, recipe_id: name, skills: { type: 'array', minItems: 1, maxItems: 6, uniqueItems: true, items: name } }, value => {
  if ((value.recipe_id === undefined) === (value.skills === undefined)) throw new ContractError('VALIDATION_ERROR', '本次配方需选择一个配方或一组技能');
  if (value.recipe_id !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(String(value.recipe_id))) throw new ContractError('VALIDATION_ERROR', '配方身份无效');
  if (Array.isArray(value.skills) && (new Set(value.skills).size !== value.skills.length || value.skills.some(item => !/^[a-z][a-z0-9-]{0,63}$/.test(String(item))))) throw new ContractError('VALIDATION_ERROR', '本次组合的技能重复或身份无效');
});
// Markdown 自包含技能；库版本可补给未声明 metadata.version 的标准 SKILL.md。
export function parseSkillMarkdown(content: string, fallbackVersion?: string): { name: string; description: string; version: string } {
  if (typeof content !== 'string' || new TextEncoder().encode(content).length > 65536) throw new ContractError('VALIDATION_ERROR', '技能正文最多 64 KiB');
  const matched = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(content), front = matched?.[1];
  if (!front || !matched?.[2]?.trim()) throw new ContractError('VALIDATION_ERROR', 'SKILL.md 需要 YAML 开头与技能正文');
  const unquote = (value: string) => value.replace(/^["']|["']$/g, '').trim();
  const block=/^description:\s*[>|][-+]?\s*\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))+)/m.exec(front);
  const skillName = unquote(/^name:\s*(.+)$/m.exec(front)?.[1] ?? ''), skillDescription = block?block[1]!.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).join(' '):unquote(/^description:\s*(.+)$/m.exec(front)?.[1] ?? '');
  const skillVersion = unquote(/^ {2}version:\s*(.+)$/m.exec(front)?.[1] ?? fallbackVersion ?? '');
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(skillName) || !skillDescription || !/^\d+\.\d+\.\d+$/.test(skillVersion)) throw new ContractError('VALIDATION_ERROR', '技能需要有效的 name、description 和版本');
  return { name: skillName, description: skillDescription, version: skillVersion };
}
export function validateSkillCatalog(catalog: SkillCatalog): void {
  const own = (value: object) => { if (![Object.prototype,null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => ['__proto__','constructor','prototype'].includes(key))) throw new ContractError('VALIDATION_ERROR', '技能配置对象无效'); };
  own(catalog); own(catalog.defaults);
  if (new Set(catalog.skills.map(skill => skill.name)).size !== catalog.skills.length || new Set(catalog.recipes.map(recipe => recipe.id)).size !== catalog.recipes.length) throw new ContractError('VALIDATION_ERROR', '技能或配方身份重复');
  for (const skill of catalog.skills) {
    own(skill); const parsed = parseSkillMarkdown(skill.content, skill.version);
    if (parsed.name !== skill.name || parsed.version !== skill.version || skill.purposes.some(item => !SKILL_PURPOSES.includes(item)) || new Set(skill.purposes).size !== skill.purposes.length) throw new ContractError('VALIDATION_ERROR', '技能身份或版本与正文不一致');
  }
  for (const recipe of catalog.recipes) {
    own(recipe); if (!/^[a-z][a-z0-9-]{0,63}$/.test(recipe.id) || new Set(recipe.skills).size !== recipe.skills.length) throw new ContractError('VALIDATION_ERROR', '配方身份或组合无效');
    if (recipe.skills.reduce((sum,name)=>sum+new TextEncoder().encode(catalog.skills.find(skill=>skill.name===name)?.content??'').length,0)>262144) throw new ContractError('VALIDATION_ERROR','这组技能正文超过 256 KiB，请减少技能或缩短正文');
    for (const item of recipe.skills) if (!catalog.skills.some(skill => skill.name === item && skill.purposes.includes(recipe.purpose))) throw new ContractError('VALIDATION_ERROR', '配方包含不存在或不适用的技能', { skill: item });
  }
  for (const [key,id] of Object.entries(catalog.defaults)) if (!SKILL_ROUTE_KEYS.includes(key as typeof SKILL_ROUTE_KEYS[number]) || id !== null && !catalog.recipes.some(recipe => recipe.id === id && recipe.purpose === key.split(':')[0])) throw new ContractError('VALIDATION_ERROR', '默认路由不属于对应创作环节');
  if (new TextEncoder().encode(JSON.stringify(catalog)).length > 1_000_000) throw new ContractError('VALIDATION_ERROR', '技能库超过 1 MB');
}
export const PutSkillSettingsSchema = objectSchema<PutSkillSettingsRequest>(['expected_version','skills','recipes','defaults'], { expected_version: { type: 'integer', minimum: 1 }, skills: { type: 'array', minItems: 1, maxItems: 40, items: definitionSchema }, recipes: { type: 'array', minItems: 1, maxItems: 30, items: recipeSchema }, defaults: defaultsSchema }, value => validateSkillCatalog(value as unknown as SkillCatalog));
export const SkillDefinitionSchema = objectSchema<SkillDefinition>(definitionSchema.required,definitionSchema.properties,value=>{
  const skill=value as unknown as SkillDefinition,parsed=parseSkillMarkdown(skill.content,skill.version);
  if(parsed.name!==skill.name||parsed.version!==skill.version||new Set(skill.purposes).size!==skill.purposes.length)throw new ContractError('VALIDATION_ERROR','技能身份、版本或适用环节无效');
});
const sourceBinding={type:'object',required:['id','sha256'],additionalProperties:false,properties:{id:{type:'string',minLength:1,maxLength:64},sha256:{type:'string',minLength:64,maxLength:64,pattern:'^[a-f0-9]{64}$'}}};
export const CreateSkillDraftSchema = objectSchema<CreateSkillDraftRequest>(['instruction','samples','purpose'], { instruction: { type: 'string', minLength: 1, maxLength: 10000 }, samples: { type: 'string', maxLength: 20000 }, purpose, base_local_skill:sourceBinding, sample_selections:{type:'array',minItems:1,maxItems:8,items:{...sourceBinding,required:['id','sha256','polarity','reason'],properties:{...sourceBinding.properties,polarity:{type:'string',enum:['positive','negative']},reason:{type:'string',minLength:1,maxLength:500}}}} },value=>{if(!String(value.instruction).trim())throw new ContractError('VALIDATION_ERROR','需要描述具体改进目标');if(Array.isArray(value.sample_selections)&&value.sample_selections.some(item=>!String((item as SkillSampleSelection).reason).trim()))throw new ContractError('VALIDATION_ERROR','样本需要具体选择理由');if(Array.isArray(value.sample_selections)&&new Set(value.sample_selections.map(item=>(item as SkillSampleSelection).id)).size!==value.sample_selections.length)throw new ContractError('VALIDATION_ERROR','样本不能重复归入正负两组');});
const existingSkillResponseSchemas = { SkillDefinition: definitionSchema, SkillRecipe: recipeSchema, SkillSettingsResponse: { type: 'object', required: ['identity','version','skills','recipes','defaults','native_support'], additionalProperties: false, properties: { identity: { $ref: '#/components/schemas/ServiceIdentity' }, version: { type: 'integer', minimum: 1 }, skills: { type: 'array', items: definitionSchema }, recipes: { type: 'array', items: recipeSchema }, defaults: defaultsSchema, native_support: { type: 'object', required: ['codex','claude'], additionalProperties: false, properties: { codex: { const: 'supported' }, claude: { const: 'unverified' } } } } } };

const localView={type:'object',required:['id','name','label','description','sha256','purposes','nodes','reference_count','default_selected','selection_reason','reuse_mode'],additionalProperties:false,properties:{id:label,name,label,description,sha256:{type:'string',minLength:64,maxLength:64,pattern:'^[a-f0-9]{64}$'},purposes:{type:'array',items:purpose},nodes:{type:'array',items:label},reference_count:{type:'integer',minimum:0},default_selected:{type:'boolean'},selection_reason:{type:'string'},reuse_mode:{type:'string',enum:['derive','workflow','host']}}};
const sampleView={type:'object',required:['id','sha256','title','relative_path','author','status','source_type','summary'],additionalProperties:false,properties:{id:label,sha256:{type:'string',minLength:64,maxLength:64,pattern:'^[a-f0-9]{64}$'},title:{type:'string'},relative_path:{type:'string'},author:{type:['string','null']},status:{type:['string','null']},source_type:{type:['string','null']},summary:{type:'string'}}};
export const SKILL_RESPONSE_SCHEMAS={...existingSkillResponseSchemas,LocalSkillView:localView,LocalSkillDetail:{...localView,required:[...localView.required,'content'],properties:{...localView.properties,content:{type:'string'}}},SkillLibraryResponse:{type:'object',required:['identity','skills','vault_root','video_nodes'],additionalProperties:false,properties:{identity:{$ref:'#/components/schemas/ServiceIdentity'},skills:{type:'array',items:localView},vault_root:{type:['string','null']},video_nodes:{type:'array',items:{type:'object',required:['id','label','skills','default_skill','required_input','execution_status'],additionalProperties:false,properties:{id:label,label,skills:{type:'array',items:name},default_skill:{type:['string','null']},required_input:{type:'string'},execution_status:{enum:['not_connected','implemented']}}}}}},SkillSamplePage:{type:'object',required:['identity','items','matched','has_more'],additionalProperties:false,properties:{identity:{$ref:'#/components/schemas/ServiceIdentity'},items:{type:'array',items:sampleView},matched:{type:'integer',minimum:0},has_more:{type:'boolean'}}}};
