import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { ContractError, type JsonObject, type RequestContext } from '@workbench/contracts';
import { canonicalJson, sha256 } from '@workbench/storage/connection';
import { canonicalWorkId } from '@workbench/storage/identity';
import { readSourcePayload } from '@workbench/storage/sources';
import type { ApplicationContext } from '../ports/index.ts';

export interface ContentEvidence { key: string; kind: 'source' | 'work' | 'snapshot' | 'action' | 'comparison' | 'account'; id: string; url: string | null; sha256: string; data: JsonObject }
export function uniqueIds(ids: string[]): string[] {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id.trim()) || ids.length > 100) throw new ContractError('VALIDATION_ERROR', '依据 ID 集合无效');
  return [...new Set(ids)].sort();
}
export function sourceEvidence(context: ApplicationContext, request: RequestContext, ids: string[]): ContentEvidence[] {
  return uniqueIds(ids).map(id => {
    const row = context.db.prepare('SELECT * FROM source_records WHERE workspace_id=? AND id=?').get(request.workspace_id, id);
    if (!row) throw new ContractError('NOT_FOUND', '固定资料不存在');
    const payload = readSourcePayload(row), locations = context.db.prepare('SELECT id,source_url,relative_path,sha256,availability FROM source_locations WHERE workspace_id=? AND record_id=? ORDER BY id').all(request.workspace_id, id);
    if (!payload.body?.trim() && !payload.summary.trim()) throw new ContractError('VALIDATION_ERROR', '资料没有可读取的正文或摘要');
    const data: JsonObject = { title: payload.title, summary: payload.summary, body: payload.body, author_name: payload.author_name, published_at: row.published_at as string | null, content_status: String(row.content_status), work_id: row.work_id as string | null, parser_warnings: payload.parser_warnings, content_semantics: payload.parser_warnings.some(warning => warning.includes('站点解读不代表每篇外站全文')) ? '个人站事件解读' : payload.body ? '资料正文' : '摘要', locations: locations as unknown as JsonObject[] };
    return { key: `source:${id}`, kind: 'source', id, url: row.canonical_url as string | null, sha256: sha256(canonicalJson(data)), data };
  });
}
export function workEvidence(context: ApplicationContext, request: RequestContext, ids: string[]): ContentEvidence[] {
  return uniqueIds(ids.map(id => canonicalWorkId(context.db, request.workspace_id, id))).map(id => {
    const row = context.db.prepare('SELECT * FROM works WHERE workspace_id=? AND id=?').get(request.workspace_id, id)!;
    const account = row.account_id ? context.db.prepare('SELECT id,platform,platform_account_id,canonical_url,name,identity_status FROM accounts WHERE workspace_id=? AND id=?').get(request.workspace_id, String(row.account_id)) : null;
    if (row.identity_status !== 'confirmed' || !row.platform_work_id || !account || account.identity_status !== 'confirmed' || account.platform !== row.platform) throw new ContractError('CAPABILITY_UNVERIFIED', '研究作品或作者身份尚未核对');
    const url = String(row.url); if (!/^https?:\/\//.test(url)) throw new ContractError('VALIDATION_ERROR', '研究必须引用可打开的真实作品 URL');
    const data: JsonObject = { platform: String(row.platform), platform_work_id: String(row.platform_work_id), account_id: String(row.account_id), account_url: account.canonical_url as string | null, account_name: String(account.name), format: row.format as string | null, published_at: row.published_at as string | null, url };
    return { key: `work:${id}`, kind: 'work', id, url, sha256: sha256(canonicalJson(data)), data };
  });
}
export function snapshotEvidence(context: ApplicationContext, request: RequestContext, ids: string[]): ContentEvidence[] {
  return uniqueIds(ids).map(id => {
    const row = context.db.prepare('SELECT * FROM snapshots WHERE workspace_id=? AND id=?').get(request.workspace_id, id);
    if (!row) throw new ContractError('NOT_FOUND', '固定快照不存在');
    const work = workEvidence(context, request, [String(row.work_id)])[0]!;
    const raw = readFileSync(isAbsolute(String(row.raw_path)) ? String(row.raw_path) : resolve(context.paths.state_root, String(row.raw_path)));
    if (sha256(raw) !== row.raw_sha256) throw new ContractError('INPUT_STALE', '快照原始响应 hash 不符');
    const metrics = context.db.prepare('SELECT definition_id,value,availability,reason FROM metric_values WHERE workspace_id=? AND snapshot_id=? ORDER BY definition_id').all(request.workspace_id, id);
    const data: JsonObject = { work_id: String(row.work_id), observed_at: row.observed_at as string | null, observed_time_basis: String(row.observed_time_basis), collected_at: String(row.collected_at), raw_sha256: String(row.raw_sha256), metrics: metrics as unknown as JsonObject[] };
    return { key: `snapshot:${id}`, kind: 'snapshot', id, url: work.url, sha256: sha256(canonicalJson(data)), data };
  });
}
export function actionEvidence(context: ApplicationContext, request: RequestContext, ids: string[]): ContentEvidence[] {
  return uniqueIds(ids).map(id => {
    const row = context.db.prepare('SELECT report_id,report_revision_id,description,hypothesis,target_metric,observation_plan,status FROM retro_actions WHERE workspace_id=? AND id=?').get(request.workspace_id, id);
    if (!row) throw new ContractError('NOT_FOUND', '固定复盘建议不存在');
    const data = { ...row, observation_plan: JSON.parse(String(row.observation_plan)) } as JsonObject;
    return { key: `action:${id}`, kind: 'action', id, url: null, sha256: sha256(canonicalJson(data)), data };
  });
}
export function evidenceFromSources(context: ApplicationContext, request: RequestContext, ids: string[]): ContentEvidence[] {
  const sources = sourceEvidence(context, request, ids), works = sources.flatMap(item => typeof item.data.work_id === 'string' ? [item.data.work_id] : []);
  return [...sources, ...workEvidence(context, request, works)];
}
export type CitationPolicy = 'public_copy_v1' | 'internal_citations_v1';
export function citationInstruction(evidence: ContentEvidence[], policy: CitationPolicy = 'internal_citations_v1'): string {
  if (policy === 'public_copy_v1') return `只依据固定 input_evidence 和 materials，不访问外部工具。sources 和固定依据由工作台内部保存，documents[].text 是面向读者的正文：不插入内部引用标识、资料 URL、证据清单或编辑自检说明；原稿已有的内部标记也不带入新稿。需要事实归属时用自然表述交代谁做了什么，不要写「所给摘要称」「未核对原文」或反复声明「不是本人实测」。不要虚构作品、实测、数字或作者身份；外部案例不能变成本人经历，摘要不能扩写为未提供的细节。分析和建议用自然语气表达，依据不足时收窄或省略主张，不补造结论。只有用户明确要求提供资料链接时才在正文保留固定资料的自然链接。`;
  return `只依据固定 input_evidence 和 materials，不访问外部工具。引用写成 [${evidence[0]?.key ?? 'source:ID'}](固定URL)，没有 URL 时写 [source:ID] 等固定 key。不要虚构作品、实测、数字、作者身份或引用 URL。摘要不能冒充原文，pending 不能冒充确认。事实、分析和假设必须明确区分；缺依据说明证据不足。可用引用：${evidence.map(item => `[${item.key}]${item.url ? `(${item.url})` : ''}`).join(' ')}。`;
}
export function auditPublicCopy(text: string, evidence: ContentEvidence[]): void {
  if (/\[(?:source|work|snapshot|action|comparison):[^\]\s]+\]/i.test(text) || /(?:source|work|snapshot|action|comparison):[a-f0-9]{8}-[a-f0-9-]{27,}/i.test(text) || evidence.some(item => text.includes(item.key))) throw new ContractError('VALIDATION_ERROR', '发布正文不能包含内部引用标识');
  auditCitationUrls(text, evidence);
}
function auditCitationUrls(text: string, evidence: ContentEvidence[]): void {
  for (const match of text.matchAll(/\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)) if (!evidence.some(item => item.url === match[1])) throw new ContractError('VALIDATION_ERROR', '输出包含未固定的引用 URL');
}
export function auditCitations(text: string, evidence: ContentEvidence[], strictSections = false): void {
  const used: string[] = [];
  for (const match of text.matchAll(/\[((?:source|work|snapshot|action|comparison):[^\]\s]+)\](?:\(([^)]+)\))?/g)) {
    const item = evidence.find(item => item.key === match[1]); if (!item || (item.url ? match[2] !== item.url : match[2] !== undefined)) throw new ContractError('VALIDATION_ERROR', '输出引用不属于冻结依据或 URL 已改变', { citation: match[1]! });
    used.push(item.key);
  }
  if (evidence.length && !used.length) throw new ContractError('VALIDATION_ERROR', '输出缺少固定依据引用');
  auditCitationUrls(text, evidence);
  if (strictSections) {
    if (!['事实', '分析', '假设'].every(section => new RegExp(`^## ${section}\\s*$`, 'm').test(text))) throw new ContractError('VALIDATION_ERROR', '报告和 Wiki 必须分开事实、分析和假设');
    const facts = /(?:^|\n)## 事实\s*\n([\s\S]*?)(?=\n## |$)/.exec(text)?.[1] ?? '';
    for (const line of facts.split('\n').filter(line => line.trim())) if (!line.includes('证据不足') && !/\[(?:source|work|snapshot|action|comparison):/.test(line)) throw new ContractError('VALIDATION_ERROR', '事实项必须带固定引用或说明证据不足');
  }
}
