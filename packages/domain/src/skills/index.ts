import { readFileSync } from 'node:fs';
import { ContractError, PutSkillSettingsSchema, SkillRouteSchema, parseSkillMarkdown, type SkillCatalog, type SkillSettingsResponse, type PutSkillSettingsRequest, type SkillRouteSelection, type SkillPurpose, type RequestContext, type JsonObject } from '@workbench/contracts';
import { transaction, canonicalJson, sha256 } from '@workbench/storage/connection';
import { readIdempotent, storeIdempotent } from '@workbench/storage/revisions';
import { assertRequestIdentity } from '../documents/index.ts';
import type { ApplicationContext } from '../ports/index.ts';

export function defaultSkillCatalog(): SkillCatalog {
  const core = readFileSync(new URL('../content-agents/skills/workbench-core-writing/SKILL.md', import.meta.url), 'utf8');
  const skill = (name: string, label: string, description: string, content: string, purposes: SkillPurpose[]) => ({ name, label, description, content, purposes, version: parseSkillMarkdown(content).version, builtin: true });
  return { skills: [
    skill('workbench-core-writing', '观点成稿', '把资料和你的判断写成一篇完整母稿', core, ['core']),
    skill('workbench-reader-polish', '读者视角', '检查开头、论述和阅读节奏，去掉汇报腔', readFileSync(new URL('../content-agents/skills/workbench-reader-polish/SKILL.md', import.meta.url), 'utf8'), ['core','variant']),
    skill('workbench-platform-adapt', '平台表达', '根据本次平台和内容形式重新组织讲法', readFileSync(new URL('../content-agents/skills/workbench-platform-adapt/SKILL.md', import.meta.url), 'utf8'), ['variant']),
    skill('workbench-evidence-notes', '依据整理', '把事实、判断和待验证想法整理为内部记录', readFileSync(new URL('../content-agents/skills/workbench-evidence-notes/SKILL.md', import.meta.url), 'utf8'), ['wiki','report','research']),
  ], recipes: [
    { id: 'core-standard', label: '日常成稿', description: '从资料与判断开始，保留你的主要观点', purpose: 'core', skills: ['workbench-core-writing'] },
    { id: 'core-reader', label: '写给读者', description: '先成稿，再从读者视角打磨表达', purpose: 'core', skills: ['workbench-core-writing','workbench-reader-polish'] },
    { id: 'platform-reader', label: '平台新表达', description: '适配平台，再检查阅读或口播节奏', purpose: 'variant', skills: ['workbench-platform-adapt','workbench-reader-polish'] },
    ...(['wiki','report','research'] as const).map(purpose => ({ id: 'evidence-'+purpose, label: { wiki:'知识整理',report:'数据复盘',research:'对标研究' }[purpose], description: '整理固定依据，保留内部可核对引用', purpose, skills: ['workbench-evidence-notes'] })),
  ], defaults: { core: 'core-standard', variant: 'platform-reader', wiki: null, report: null, research: null } };
}
export function matchingSkillRouteKeys(purpose: SkillPurpose, platform?: string, category?: string): string[] {
  if (purpose === 'variant' && platform) return ['variant:'+platform,'variant'];
  const categoryKey = category === 'AI 实测' ? 'ai_test' : category === '热点资讯' ? 'news' : category === '个人思考' ? 'thinking' : undefined;
  return purpose === 'core' && categoryKey ? ['core:'+categoryKey,'core'] : [purpose];
}
export class SkillSettings {
  readonly context: ApplicationContext;
  constructor(context: ApplicationContext) { this.context=context; }
  get(request: RequestContext): SkillSettingsResponse {
    assertRequestIdentity(this.context, request);
    const row = this.context.db.prepare('SELECT version,catalog_json FROM skill_settings WHERE workspace_id=?').get(request.workspace_id);
    if (row) {
      const revision = this.context.db.prepare('SELECT catalog_json,sha256 FROM skill_settings_revisions WHERE workspace_id=? AND version=?').get(request.workspace_id,row.version);
      if (!revision || revision.catalog_json !== row.catalog_json || revision.sha256 !== sha256(String(row.catalog_json))) throw new ContractError('STORAGE_UNAVAILABLE', '技能配置修订校验失败');
    }
    return { identity: this.context.identity, version: row ? Number(row.version) : 1, ...(row ? JSON.parse(String(row.catalog_json)) : defaultSkillCatalog()), native_support: { codex:'supported',claude:'unverified' } };
  }
  put(request: RequestContext, input: PutSkillSettingsRequest): SkillSettingsResponse {
    assertRequestIdentity(this.context,request); PutSkillSettingsSchema.parse(input);
    return transaction(this.context.db, () => {
      const replay = readIdempotent<SkillSettingsResponse>(this.context.db,request,'skills.put',input); if (replay) return replay;
      const current = this.get(request); if (current.version !== input.expected_version) throw new ContractError('VERSION_CONFLICT','配方已在另一入口更新，先重新读取',{current_version:current.version});
      for (const builtin of defaultSkillCatalog().skills) if (!input.skills.some(item => canonicalJson(item) === canonicalJson(builtin))) throw new ContractError('VALIDATION_ERROR','内置技能保留原件，请复制后修改');
      for (const skill of input.skills) {
        if (skill.builtin && !defaultSkillCatalog().skills.some(item => item.name === skill.name)) throw new ContractError('VALIDATION_ERROR','自制技能不能冒充内置技能');
        const old = current.skills.find(item => item.name === skill.name);
        if (old && old.content !== skill.content && (skill.version === old.version || compareVersions(skill.version,old.version) <= 0)) throw new ContractError('VERSION_CONFLICT','技能正文变化时请使用更高版本',{skill:skill.name});
      }
      const catalog: SkillCatalog = { skills:input.skills, recipes:input.recipes, defaults:input.defaults }, json = canonicalJson(catalog), at = new Date().toISOString(), version = current.version+1;
      const initial = canonicalJson({ skills:current.skills,recipes:current.recipes,defaults:current.defaults });
      this.context.db.prepare('INSERT OR IGNORE INTO skill_settings_revisions VALUES (?,?,?,?,?)').run(request.workspace_id,current.version,initial,sha256(initial),at);
      this.context.db.prepare('INSERT INTO skill_settings_revisions VALUES (?,?,?,?,?)').run(request.workspace_id,version,json,sha256(json),at);
      this.context.db.prepare('INSERT INTO skill_settings VALUES (?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET version=excluded.version,catalog_json=excluded.catalog_json,updated_at=excluded.updated_at').run(request.workspace_id,version,json,at);
      const result = this.get(request); storeIdempotent(this.context.db,request,'skills.put',input,result); return result;
    });
  }
  freeze(request: RequestContext, purpose: SkillPurpose, context: { platform?: string; category?: string } = {}, selection?: SkillRouteSelection): JsonObject {
    const catalog = this.get(request); if (selection) { SkillRouteSchema.parse(selection); if (selection.settings_version !== catalog.version) throw new ContractError('VERSION_CONFLICT','本次技能选择基于旧配置，请刷新配方',{current_version:catalog.version}); }
    const keys = matchingSkillRouteKeys(purpose,context.platform,context.category), matched = keys.find(key => Object.hasOwn(catalog.defaults,key)), defaultId = matched ? catalog.defaults[matched] : undefined;
    const recipeId = selection?.recipe_id ?? (selection?.skills ? undefined : defaultId), recipe = recipeId ? catalog.recipes.find(item => item.id === recipeId) : undefined;
    if (recipeId && (!recipe || recipe.purpose !== purpose)) throw new ContractError('VALIDATION_ERROR','配方不适用于当前创作环节');
    const names = selection?.skills ?? recipe?.skills ?? [];
    if (!names.length) return {};
    const skills = names.map(name => { const skill = catalog.skills.find(item => item.name === name); if (!skill || !skill.purposes.includes(purpose)) throw new ContractError('VALIDATION_ERROR','技能不适用于当前创作环节',{skill:name}); return {name:skill.name,version:skill.version,sha256:sha256(skill.content),content:skill.content}; });
    if (skills.reduce((sum,skill)=>sum+new TextEncoder().encode(skill.content).length,0)>262144) throw new ContractError('VALIDATION_ERROR','这组技能正文超过 256 KiB，请减少技能或缩短正文');
    return { writing_skills:skills, skill_route:{ recipe_id:recipe?.id ?? null,label:recipe?.label ?? '本次组合',purpose,settings_version:catalog.version,matched_key:selection ? null : matched ?? null,source:selection?.skills ? 'temporary' : selection ? 'recipe' : 'default',skills:names } };
  }
}
function compareVersions(a: string,b: string): number { const aa=a.split('.').map(BigInt),bb=b.split('.').map(BigInt); for(let i=0;i<3;i++)if(aa[i]!==bb[i])return aa[i]!>bb[i]!?1:-1; return 0; }

export { SkillLibrary } from './library.ts';
