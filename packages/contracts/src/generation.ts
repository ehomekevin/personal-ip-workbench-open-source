import type { SkillRouteSelection } from './skills.ts';
import { objectSchema } from './validation.ts';
import { ContractError } from './errors.ts';
import type { Platform, ContentFormat, CreateTopicRequest, CreateAccountRequest } from './index.ts';
export type ContentExecutor = 'codex' | 'claude';
// 只冻结观察时限，不携带或覆盖 provider、model、reasoning_effort。
export interface TextObservationPolicy { idle_timeout_ms: number; max_duration_ms: number }
export const DEFAULT_TEXT_OBSERVATION: TextObservationPolicy = { idle_timeout_ms: 180000, max_duration_ms: 900000 };
export const TextObservationPolicySchema = objectSchema<TextObservationPolicy>(['idle_timeout_ms','max_duration_ms'], {
  idle_timeout_ms: { type: 'integer', minimum: 30000, maximum: 600000 },
  max_duration_ms: { type: 'integer', minimum: 60000, maximum: 1800000 },
}, value => { if (Number(value.idle_timeout_ms) > Number(value.max_duration_ms)) throw new ContractError('VALIDATION_ERROR','无进展等待不能超过本次最长观察时间'); });
export interface DocumentGenerationRequest { skill_route?: SkillRouteSelection; base_revision_id: string | null; source_ids: string[]; executor: ContentExecutor; instruction: string }
export interface VariantGenerationRequest { skill_route?: SkillRouteSelection; core_revision_id: string; base_revision_id: string | null; mode: 'initialize' | 'candidate'; source_ids: string[]; executor: ContentExecutor }
export interface TopicRecommendationRequest { source_ids: string[]; action_ids: string[]; executor: ContentExecutor }
export interface AccountRecommendationRequest { positioning: string; platforms: Platform[]; source_ids: string[]; executor: ContentExecutor }
export interface ResearchRequest { skill_route?: SkillRouteSelection; source_record_ids: string[]; executor: ContentExecutor; input_version?:string }
export interface WikiGenerationRequest { skill_route?: SkillRouteSelection; evidence_ids: string[]; target_document_id: string; base_revision_id: string | null; executor: ContentExecutor }
export interface ReportGenerationRequest { skill_route?: SkillRouteSelection; comparison_run_id: string; source_ids: string[]; executor: ContentExecutor }
export type RecommendationAdoptionRequest = { topic?: CreateTopicRequest; account?: CreateAccountRequest };
export interface GenerationAccepted { job_id: string; document_id?: string; report_id?: string; run_id?: string }
export interface HistoricalRevision {document_id:string;revision_id:string;parent_revision_id:string|null;text:string;hash:string}
