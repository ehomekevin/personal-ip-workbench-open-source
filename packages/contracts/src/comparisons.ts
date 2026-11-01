import type { Platform, ContentFormat, MetricAvailability, Page, ListQuery, RequestContext } from './common.ts';

export type ComparisonKind = 'self_period' | 'benchmark_period' | 'peers' | 'work_evolution';
export type ComparisonAggregation = 'sum' | 'mean' | 'median';
export interface PublicationWindow { start: string; end: string }
export interface ComparisonParameters {
  platform: Platform; account_ids: string[]; format: ContentFormat; metric_definition_id: string;
  timezone: string; topic_ids: string[]; category: string | null; work_ids: string[]; match_reason: string | null;
  cohort_windows: { target: PublicationWindow; baseline: PublicationWindow | null };
  observation_window_h: number; tolerance_h: number; baseline_window_days: number; min_baseline_samples: number;
  aggregation: ComparisonAggregation; missing_policy: 'exclude'; data_version: 'comparison-v1';
}
export interface StandardComparisonQuery extends ComparisonParameters { mode: 'standard'; kind: ComparisonKind; as_of: string }
export interface EvaluationComparisonQuery extends ComparisonParameters {
  mode: 'adoption_evaluation'; kind: 'self_period'; as_of: string; target_as_of: string; adoption_id: string; plan_hash: string;
  baseline_run_id: string | null; baseline_cohort_key: string | null; baseline_input_hash: string | null;
}
export type QuerySpec = StandardComparisonQuery | EvaluationComparisonQuery;
export type CreateComparisonRequest = Omit<StandardComparisonQuery, 'mode' | 'as_of' | 'observation_window_h' | 'tolerance_h' | 'baseline_window_days' | 'min_baseline_samples' | 'aggregation' | 'missing_policy' | 'data_version' | 'topic_ids' | 'category' | 'work_ids' | 'match_reason'> & Partial<Pick<StandardComparisonQuery, 'mode' | 'as_of' | 'observation_window_h' | 'tolerance_h' | 'baseline_window_days' | 'min_baseline_samples' | 'aggregation' | 'missing_policy' | 'data_version' | 'topic_ids' | 'category' | 'work_ids' | 'match_reason'>>;
export interface FrozenMetricDefinition { id: string; platform: Platform; key: string; unit: string; kind: string; scope: string; definition_version: string }
export interface SelectedComparisonInput {
  canonical_work_id: string; source_work_id: string; account_id: string; platform: Platform; format: ContentFormat;
  platform_work_id: string; published_at: string | null; topic_id: string | null; category: string | null; url: string;
  identity_mapping: { source_work_id: string; canonical_work_id: string; source_identity_status: string; canonical_identity_status: string };
  snapshot_id: string; source_id: string; collection_request_id: string; request_fingerprint: string; raw_path: string; raw_sha256: string; adapter_version: string;
  observed_at: string; observed_time_basis: 'provider' | 'collector_verified'; observed_age_s: number | null; collected_at: string;
  metric_definition_id: string; definition_version: string; unit: string; value: string;
}
export interface ComparisonExclusion { cohort_key: string; canonical_work_id: string; source_work_id: string; snapshot_id: string | null; reason: string; availability: MetricAvailability | null; detail: string | null }
export interface FrozenComparisonCohort {
  key: string; role: 'target' | 'baseline'; account_id: string; window: PublicationWindow; as_of: string;
  source_run_id: string | null; source_cohort_key: string | null; selected_inputs: SelectedComparisonInput[];
  exclusions: ComparisonExclusion[]; definition: FrozenMetricDefinition; input_hash: string;
}
export interface ComparisonAggregate { sample_count: number; eligible_work_count: number; excluded_work_count: number; total: string | null; mean: string | null; median: string | null; value: string | null }
export interface ComparisonDelta { difference: string | null; percent: string | null; status: 'available' | 'undefined' | 'unavailable'; reason: string | null }
export interface PeriodComparisonResult { account_id: string; target_cohort_key: string; baseline_cohort_key: string; target: ComparisonAggregate; baseline: ComparisonAggregate; change: ComparisonDelta }
export interface PeerComparisonResult { account_id: string; canonical_work_id: string; snapshot_id: string; value: string; baseline_cohort_key: string; baseline_sample_count: number; baseline_median: string | null; ratio: string | null; reason: string | null }
export interface EvolutionComparisonPoint { snapshot_id: string; canonical_work_id: string; source_work_id: string; observed_at: string; collected_at: string; value: string; difference: string | null; reason: string | null }
export interface ComparisonResult { status: 'comparable' | 'insufficient'; periods: PeriodComparisonResult[]; peers: PeerComparisonResult[]; evolution: EvolutionComparisonPoint[]; limitations: string[]; input_hash: string }
export interface ComparisonRun { id: string; workspace_id: string; created_at: string; query_spec: QuerySpec; selected_snapshot_ids: string[]; selected_inputs_by_cohort: FrozenComparisonCohort[]; excluded_work_ids: string[]; excluded_reasons: ComparisonExclusion[]; definition_versions: FrozenMetricDefinition[]; result: ComparisonResult }
export interface FrozenComparisonBaseline { schema_version: 'comparison-baseline-v1'; source_run_id: string; source_cohort_key: string; parameters: ComparisonParameters; cohort: FrozenComparisonCohort; input_hash: string }
export interface EvaluationComparisonInput { adoption_id: string; plan_hash: string; parameters: ComparisonParameters; target_work_ids: string[]; target_as_of: string; baseline: FrozenComparisonBaseline | null }
export interface ComparisonListQuery extends ListQuery { platform?: Platform; account_id?: string; created_start?: string; created_end?: string }
export interface ComparisonPort { create(context: RequestContext, query: CreateComparisonRequest): ComparisonRun; get(context: RequestContext, id: string): ComparisonRun; list(context: RequestContext, query?: ComparisonListQuery): Page<ComparisonRun>; freezeCohort(context: RequestContext, runId: string, key: string): FrozenComparisonBaseline; createEvaluation(context: RequestContext, input: EvaluationComparisonInput): ComparisonRun }

// D07-007：领域运行解析与公开 JSON schema 消费同一份参数定义。
export const COMPARISON_JSON_SCHEMA = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "kind",
    "platform",
    "account_ids",
    "format",
    "metric_definition_id",
    "timezone",
    "cohort_windows"
  ],
  "properties": {
    "mode": {
      "type": "string",
      "enum": [
        "standard"
      ]
    },
    "kind": {
      "type": "string",
      "enum": [
        "self_period",
        "benchmark_period",
        "peers",
        "work_evolution"
      ]
    },
    "platform": {
      "type": "string",
      "enum": [
        "xiaohongshu",
        "wechat",
        "x",
        "douyin",
        "bilibili"
      ]
    },
    "account_ids": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "minItems": 1
    },
    "format": {
      "type": "string",
      "enum": [
        "text",
        "thread",
        "article",
        "image_post",
        "short_video",
        "long_video"
      ]
    },
    "metric_definition_id": {
      "type": "string"
    },
    "timezone": {
      "type": "string"
    },
    "topic_ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "category": {
      "type": [
        "string",
        "null"
      ]
    },
    "work_ids": {
      "type": "array",
      "items": {
        "type": "string"
      }
    },
    "match_reason": {
      "type": [
        "string",
        "null"
      ]
    },
    "cohort_windows": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "target",
        "baseline"
      ],
      "properties": {
        "target": {
          "type": "object",
          "required": [
            "start",
            "end"
          ],
          "properties": {
            "start": {
              "type": "string",
              "format": "date-time"
            },
            "end": {
              "type": "string",
              "format": "date-time"
            }
          }
        },
        "baseline": {
          "type": [
            "object",
            "null"
          ]
        }
      }
    },
    "as_of": {
      "type": "string",
      "format": "date-time"
    },
    "observation_window_h": {
      "type": "integer",
      "minimum": 1,
      "default": 72
    },
    "tolerance_h": {
      "type": "integer",
      "minimum": 0,
      "default": 6
    },
    "baseline_window_days": {
      "type": "integer",
      "minimum": 1,
      "default": 28
    },
    "min_baseline_samples": {
      "type": "integer",
      "minimum": 5,
      "default": 5
    },
    "aggregation": {
      "type": "string",
      "enum": [
        "sum",
        "mean",
        "median"
      ]
    },
    "missing_policy": {
      "type": "string",
      "enum": [
        "exclude"
      ]
    },
    "data_version": {
      "type": "string",
      "enum": [
        "comparison-v1"
      ]
    }
  }
} as const;
