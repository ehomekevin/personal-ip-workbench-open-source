import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContractError, parseSkillMarkdown, SKILL_PURPOSES, type JsonObject } from '@workbench/contracts';
import { hash, object } from './codex/primitives.ts';

export interface WritingSkill { name: string; version: string; sha256: string; content: string }
export interface AttachedWritingSkill { name: string; version: string; sha256: string; path: string }
// 技能来自领域层冻结的受信工作流，资料正文不能指定路径或技能。
function readLegacyWritingSkill(manifest: JsonObject): WritingSkill | undefined {
  if (!object(manifest.frozen) || !Object.hasOwn(manifest.frozen, 'writing_skill')) return undefined;
  const value = manifest.frozen.writing_skill;
  if (!object(value) || Object.keys(value).length !== 4 || value.name !== 'workbench-core-writing' || typeof value.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(value.version) || typeof value.sha256 !== 'string' || typeof value.content !== 'string' || Buffer.byteLength(value.content) > 65_536 || hash(value.content) !== value.sha256 || !value.content.startsWith('---\nname: ' + value.name + '\n') || !value.content.includes('\n  version: ' + value.version + '\n') || manifest.frozen.content_purpose !== 'core') throw new ContractError('INPUT_STALE', '固定写作技能的身份、版本或正文 hash 不符');
  return value as unknown as WritingSkill;
}
export function readWritingSkills(manifest: JsonObject): WritingSkill[] {
  if (!object(manifest.frozen) || !Object.hasOwn(manifest.frozen, 'writing_skills')) { const legacy=readLegacyWritingSkill(manifest); return legacy ? [legacy] : []; }
  const frozen=manifest.frozen, values=frozen.writing_skills;
  if (Object.hasOwn(frozen,'writing_skill') || !Array.isArray(values) || !values.length || values.length>6 || !SKILL_PURPOSES.includes(String(frozen.skill_purpose ?? frozen.content_purpose) as typeof SKILL_PURPOSES[number])) throw new ContractError('INPUT_STALE','固定技能组合或适用环节无效');
  const skills=values.map(value=>{
    if(!object(value)||Object.keys(value).length!==4||typeof value.name!=='string'||typeof value.version!=='string'||typeof value.content!=='string'||typeof value.sha256!=='string'||hash(value.content)!==value.sha256)throw new ContractError('INPUT_STALE','固定技能组合身份或正文 hash 不符');
    let parsed;try{parsed=parseSkillMarkdown(value.content,value.version);}catch{throw new ContractError('INPUT_STALE','固定技能 Markdown 无效');}
    if(parsed.name!==value.name||parsed.version!==value.version)throw new ContractError('INPUT_STALE','固定技能名称或版本与正文不符');
    return value as unknown as WritingSkill;
  });
  if(new Set(skills.map(skill=>skill.name)).size!==skills.length||skills.reduce((total,skill)=>total+Buffer.byteLength(skill.content),0)>262144)throw new ContractError('INPUT_STALE','固定技能重复或总大小超限');
  return skills;
}
export function readWritingSkill(manifest: JsonObject): WritingSkill | undefined { return readWritingSkills(manifest)[0]; }
export function attachWritingSkills(manifest: JsonObject,cwd:string): AttachedWritingSkill[] { return readWritingSkills(manifest).map(skill=>attachSkill(skill,cwd)); }
export function attachWritingSkill(manifest: JsonObject,cwd:string): AttachedWritingSkill | undefined { return attachWritingSkills(manifest,cwd)[0]; }
function attachSkill(skill: WritingSkill, cwd: string): AttachedWritingSkill {
  // 原生运行器显式读取固定快照，不授予模型文件工具。
  let directory = cwd;
  for (const part of ['.agents', 'skills', skill.name]) {
    directory = join(directory, part);
    if (!existsSync(directory)) mkdirSync(directory);
    if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) throw new ContractError('INPUT_STALE', '技能快照目录已变化');
  }
  const path = join(directory, 'SKILL.md');
  if (!existsSync(path)) writeFileSync(path, skill.content, { flag: 'wx', mode: 0o444 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isFile() || hash(readFileSync(path)) !== skill.sha256) throw new ContractError('INPUT_STALE', '技能快照文件与固定输入不符');
  return { name: skill.name, version: skill.version, sha256: skill.sha256, path };
}
