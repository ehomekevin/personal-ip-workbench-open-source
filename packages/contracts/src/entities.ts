// D07-001: SQL 原始行类型；JSON 列为序列化字符串，领域 port 返回解码后的读模型。
export interface EntityRow { id: string; workspace_id: string; created_at: string; updated_at: string }
export interface WorkspacesRow extends EntityRow {
  default_executor: 'codex' | 'claude';
  api_fallback_enabled: number;
  title: string;
  timezone: string;
  paths: string;
  mode: 'real' | 'demo';
  version: number;
}
export interface AccountsRow extends EntityRow {
  platform: 'xiaohongshu' | 'wechat' | 'x' | 'douyin' | 'bilibili';
  platform_account_id: string | null;
  role: 'owner' | 'benchmark';
  name: string;
  canonical_url: string;
  identity_status: string;
}
export interface ConnectorsRow extends EntityRow {
  kind: string;
  capability_status: 'unconfigured' | 'unverified' | 'supported' | 'unsupported' | 'degraded';
  config_ref: string | null;
  last_success_at: string | null;
  last_error: string | null;
}
export interface SourcesRow extends EntityRow {
  kind: string;
  connector_id: string | null;
  external_id: string | null;
  url: string;
  schema_version: string;
  last_sync_at: string | null;
}
export interface SourceRecordsRow extends EntityRow {
  payload: string;
  source_id: string;
  external_id: string | null;
  canonical_url: string | null;
  record_kind: string;
  work_id: string | null;
  author_account_id: string | null;
  published_at: string | null;
  content_document_id: string | null;
  content_status: string;
}
export interface SourceLocationsRow extends EntityRow {
  availability: 'available' | 'offline' | 'parse_error';
  raw_response_ref: string | null;
  record_id: string;
  kind: string;
  relative_path: string | null;
  source_url: string | null;
  capture_time: string | null;
  sha256: string;
  parser_version: string;
}
export interface SourceEventsRow extends EntityRow {
  source_id: string;
  external_event_id: string;
  title: string;
  occurred_at: string | null;
}
export interface UserSourceMarksRow extends EntityRow {
  record_id: string;
  read_at: string | null;
  favorite: number;
  used_at: string | null;
}
export interface TopicsRow extends EntityRow {
  title: string;
  category: string;
  audience: string;
  angle: string;
  expected_effort_min: number;
  core_document_id: string;
  status: 'active' | 'paused' | 'archived';
  version: number;
}
export interface TopicSourcesRow extends EntityRow {
  topic_id: string;
  source_record_id: string;
  usage: string;
  locator: string | null;
}
export interface DocumentsRow extends EntityRow {
  kind: string;
  owner_entity_id: string | null;
  head_revision_id: string | null;
  version: number;
}
export interface DocumentRevisionsRow extends EntityRow {
  document_id: string;
  parent_revision_id: string | null;
  file_path: string;
  sha256: string;
  origin: 'human' | 'agent' | 'import' | 'restore';
  change_kind: 'text' | 'restore' | 'core_alignment' | 'merge';
  job_id: string | null;
  attempt_id: string | null;
  attempt_generation: number | null;
  result_receipt_id: string | null;
  based_on_core_revision_id: string | null;
  created_by: string;
}
export interface CoreApprovalsRow extends EntityRow {
  topic_id: string;
  revision_id: string;
  approved_at: string;
  actor: string;
}
export interface VariantsRow extends EntityRow {
  topic_id: string;
  platform: 'xiaohongshu' | 'wechat' | 'x' | 'douyin' | 'bilibili';
  format: 'text' | 'thread' | 'article' | 'image_post' | 'short_video' | 'long_video';
  variant_key: string;
  document_id: string;
  based_on_core_revision_id: string;
  status: string;
  version: number;
}
export interface CandidatesRow extends EntityRow {
  target_document_id: string;
  base_revision_id: string | null;
  revision_id: string;
  job_id: string;
  attempt_id: string;
  attempt_generation: number;
  result_receipt_id: string;
  status: 'pending' | 'adopted' | 'rejected' | 'conflict';
  adopted_revision_id: string | null;
  adoption_mode: 'manual' | 'auto_initial' | null;
  adopted_at: string | null;
  adopted_by: string | null;
}
export interface RecommendationRunsRow extends EntityRow {
  kind: 'topic' | 'account';
  input_manifest: string;
  job_id: string;
  status: string;
}
export interface RecommendationCandidatesRow extends EntityRow {
  run_id: string;
  kind: 'topic' | 'account';
  payload: string;
  source_ids: string;
  rationale: string;
  attempt_id: string;
  attempt_generation: number;
  result_receipt_id: string;
  status: string;
  adopted_target_id: string | null;
}
export interface TopicAssetLinksRow extends EntityRow {
  topic_id: string;
  asset_id: string;
  purpose: string;
  evidence_kind: string;
}
export interface AssetsRow extends EntityRow {
  kind: string;
  origin: string;
  file_path: string;
  sha256: string;
  size_bytes: number;
  mime: string;
  duration_ms: number | null;
  dimensions: string | null;
  status: string;
  job_id: string | null;
  generation_metadata: string | null;
}
export interface ContentPlansRow extends EntityRow {
  variant_id: string;
  head_content_revision_id: string | null;
  version: number;
}
export interface ContentPlanRevisionsRow extends EntityRow {
  plan_id: string;
  revision_no: number;
  parent_revision_id: string | null;
  variant_revision_id: string;
  format: 'text' | 'thread' | 'article' | 'image_post' | 'short_video' | 'long_video';
  schema_version: string;
  units: string;
  title_revision_id: string | null;
  caption_revision_id: string | null;
  cover_asset_id: string | null;
  input_hash: string;
  input_manifest: string | null;
}
export interface ProductionPlansRow extends EntityRow {
  topic_id: string;
  scope: 'topic_preparation' | 'variant';
  variant_id: string | null;
  head_plan_revision_id: string | null;
  version: number;
}
export interface ProductionPlanRevisionsRow extends EntityRow {
  plan_id: string;
  revision_no: number;
  parent_revision_id: string | null;
  variant_revision_id: string | null;
  script_revision_id: string | null;
  source_preparation_revision_id: string | null;
  input_hash: string;
  input_manifest: string | null;
}
export interface ShotsRow extends EntityRow {
  plan_revision_id: string;
  shot_key: string;
  position: number;
  title: string;
  kind: string;
  duration_ms: number;
  narration_revision_id: string | null;
  subtitle_revision_id: string | null;
  source_requirement: string;
}
export interface ShotAssetsRow extends EntityRow {
  shot_id: string;
  asset_id: string;
  role: string;
  in_ms: number | null;
  out_ms: number | null;
}
export interface AssetCandidatesRow extends EntityRow {
  job_id: string;
  asset_id: string;
  target_plan_revision_id: string | null;
  target_shot_key: string | null;
  base_asset_id: string | null;
  status: string;
  adopted_plan_revision_id: string | null;
}
export interface ArtifactsRow extends EntityRow {
  variant_id: string;
  variant_revision_id: string;
  content_plan_revision_id: string | null;
  production_plan_revision_id: string | null;
  manifest_path: string;
  sha256: string;
  kind: string;
  status: string;
  producer_version: string;
}
export interface DailyPlansRow extends EntityRow {
  local_date: string;
  timezone: string;
  budget_min: number;
  version: number;
}
export interface DailyPlanItemsRow extends EntityRow {
  plan_id: string;
  topic_id: string | null;
  job_id: string | null;
  action_id: string | null;
  position: number;
  effort_min: number;
  status: string;
}
export interface SchedulesRow extends EntityRow {
  variant_id: string;
  account_id: string;
  variant_revision_id: string;
  artifact_id: string | null;
  due_at: string;
  timezone: string;
  local_time: string;
  version: number;
  state: 'scheduled' | 'due' | 'executing' | 'completed' | 'missed' | 'cancelled' | 'needs_attention';
  publication_intent_id: string;
}
export interface PublicationBatchesRow extends EntityRow {
  triggered_by: string;
  requested_at: string;
  status: string;
  orchestrator_job_id: string;
  version: number;
}
export interface PublicationIntentsRow extends EntityRow {
  batch_id: string | null;
  variant_id: string;
  account_id: string;
  revision_id: string;
  content_plan_revision_id: string | null;
  artifact_id: string | null;
  core_approval_id: string;
  input_hash: string;
  idempotency_key: string;
  state: 'queued' | 'uploading' | 'platform_draft' | 'processing' | 'published' | 'failed' | 'unknown' | 'cancelled' | 'needs_action' | 'superseded';
  progress: string;
  version: number;
  draft_id: string | null;
  work_id: string | null;
  replaces_intent_id: string | null;
  superseded_by_intent_id: string | null;
}
export interface PublicationMembersRow extends EntityRow {
  intent_id: string;
  member_key: string;
  position: number;
  text_revision_id: string;
  payload_hash: string;
  reply_to_member_key: string | null;
  state: 'pending' | 'sending' | 'published' | 'failed' | 'unknown' | 'cancelled';
  platform_work_id: string | null;
  work_id: string | null;
  remote_request_id: string | null;
  error: string | null;
}
export interface PublicationAttemptsRow extends EntityRow {
  intent_id: string;
  member_id: string | null;
  attempt_no: number;
  phase: string;
  request_fingerprint: string;
  remote_request_id: string | null;
  result_status: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  publishing_connection_id: string | null;
  publishing_config_revision: number | null;
  publishing_adapter_version: string | null;
  publishing_host_id: string | null;
}
export interface WorksRow extends EntityRow {
  platform: 'xiaohongshu' | 'wechat' | 'x' | 'douyin' | 'bilibili';
  platform_work_id: string | null;
  account_id: string | null;
  format: 'text' | 'thread' | 'article' | 'image_post' | 'short_video' | 'long_video' | null;
  format_source: string | null;
  topic_id: string | null;
  variant_id: string | null;
  revision_id: string | null;
  url: string;
  published_at: string | null;
  origin: string;
  identity_status: string;
  canonical_work_id: string | null;
  parent_work_id: string | null;
  position: number | null;
}
export interface WorkAliasesRow extends EntityRow {
  alias_work_id: string;
  canonical_work_id: string;
  source_url: string;
  resolution_evidence: string;
}
export interface MetricDefinitionsRow extends EntityRow {
  platform: 'xiaohongshu' | 'wechat' | 'x' | 'douyin' | 'bilibili';
  key: string;
  raw_field: string;
  unit: string;
  kind: string;
  denominator_key: string | null;
  visibility: string;
  definition_version: string;
  scope: string;
}
export interface SnapshotsRow extends EntityRow {
  work_id: string;
  source_id: string;
  collection_request_id: string;
  request_fingerprint: string;
  observed_at: string | null;
  observed_time_basis: 'provider' | 'collector_verified' | 'unknown';
  observed_time_reason: string | null;
  collected_at: string;
  target_window: number | null;
  observed_age_s: number | null;
  raw_path: string;
  raw_sha256: string;
  adapter_version: string;
  supersedes_snapshot_id: string | null;
}
export interface MetricValuesRow extends EntityRow {
  snapshot_id: string;
  definition_id: string;
  value: string | null;
  availability: 'available' | 'not_collected' | 'unavailable' | 'unsupported' | 'invalid';
  reason: string | null;
}
export interface AccountSnapshotsRow extends EntityRow {
  account_id: string;
  observed_at: string | null;
  observed_time_basis: 'provider' | 'collector_verified' | 'unknown';
  observed_time_reason: string | null;
  collected_at: string;
  raw_path: string;
  adapter_version: string;
}
export interface AccountMetricValuesRow extends EntityRow {
  account_snapshot_id: string;
  definition_id: string;
  value: string | null;
  availability: 'available' | 'not_collected' | 'unavailable' | 'unsupported' | 'invalid';
  reason: string | null;
}
export interface ComparisonRunsRow extends EntityRow {
  query_spec: string;
  selected_snapshot_ids: string;
  selected_inputs_by_cohort: string;
  excluded_work_ids: string;
  excluded_reasons: string;
  definition_versions: string;
  result: string;
}
export interface RetroReportsRow extends EntityRow {
  document_id: string;
  comparison_run_id: string;
  source_record_ids: string;
  status: string;
}
export interface RetroActionsRow extends EntityRow {
  report_id: string;
  report_revision_id: string;
  description: string;
  hypothesis: string;
  target_metric: string;
  observation_plan: string;
  status: 'proposed' | 'adopted' | 'observing' | 'evaluated' | 'stopped';
}
export interface ActionAdoptionsRow extends EntityRow {
  action_id: string;
  adoption_key: string;
  topic_id: string;
  variant_id: string | null;
  adopted_at: string;
  baseline_run_id: string | null;
  baseline_cohort_key: string | null;
  baseline_input_hash: string | null;
  observation_plan: string;
  plan_hash: string;
}
export interface AdoptionWorksRow extends EntityRow {
  adoption_id: string;
  work_id: string;
  link_evidence: string;
}
export interface ActionEvaluationsRow extends EntityRow {
  adoption_id: string;
  comparison_run_id: string;
  result: 'supported' | 'not_supported' | 'mixed' | 'insufficient';
  limitations: string;
  evaluated_at: string;
}
export interface BusinessEventsRow extends EntityRow {
  kind: string;
  occurred_at: string;
  work_id: string | null;
  topic_id: string | null;
  count: string | null;
  amount: string | null;
  note: string;
  attribution_status: string;
}
export interface JobsRow extends EntityRow {
  kind: string;
  target_id: string | null;
  executor_id: string | null;
  entrypoint: 'standalone_web' | 'codex_plugin' | 'claude_plugin' | 'claude_code_plugin';
  execution_mode: 'programmatic' | 'service_adapter' | 'host_session';
  current_attempt_id: string | null;
  attempt_generation: number;
  input_manifest: string;
  input_hash: string;
  state: 'queued' | 'running' | 'waiting_input' | 'waiting_quota' | 'cancel_requested' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
  due_at: string | null;
  retry_policy: string;
  presentation: 'foreground_dialog' | 'background' | 'host_conversation';
  cancel_requested_at: string | null;
  version: number;
}
export interface JobAttemptsRow extends EntityRow {
  job_id: string;
  attempt_no: number;
  attempt_generation: number;
  state: 'active' | 'succeeded' | 'failed' | 'expired' | 'cancelled' | 'superseded';
  lease_owner: string;
  lease_until: string;
  host_connection_id: string | null;
  native_task_binding_id: string | null;
  output_deadline: string | null;
  output_hash: string | null;
  checkpoint: string;
  runtime_session_id: string | null;
  runtime_turn_id: string | null;
  error: string | null;
}
export interface HostConnectionsRow extends EntityRow {
  service_instance_id: string;
  host_surface: string;
  plugin_id: string;
  plugin_version: string;
  runtime_version: string;
  connection_mode: string;
  request_identity_ref: string;
  status: string;
}
export interface HostCapabilityRecordsRow extends EntityRow {
  host_surface: string;
  runtime_version: string;
  connection_mode: string;
  operation: string;
  plugin_version: string;
  status: 'unconfigured' | 'unverified' | 'supported' | 'unsupported' | 'degraded';
  limitations: string;
  verified_at: string | null;
  evidence_ref: string | null;
  version: number;
}
export interface HostTaskObserversRow extends EntityRow {
  observer_epoch: string;
  host_connection_id: string;
  capability_record_id: string;
  capability_version: number;
  request_identity_ref: string;
  state: string;
}
export interface NativeTaskBindingsRow extends EntityRow {
  observer_id: string;
  observer_epoch: string;
  host_connection_id: string;
  scope: 'turn' | 'task';
  native_namespace: string;
  native_session_id: string | null;
  native_turn_id: string | null;
  native_task_id: string | null;
  current_attempt_id: string | null;
  latest_observation_id: string | null;
  last_renewed_observation_id: string | null;
  state: 'active' | 'closed';
}
export interface NativeTaskObservationsRow extends EntityRow {
  binding_id: string;
  observer_id: string;
  observer_epoch: string;
  sequence: number;
  native_state: 'running' | 'waiting_tool' | 'completed' | 'failed' | 'interrupted' | 'auth_required' | 'quota_exhausted' | 'disconnected';
  observed_at: string;
  received_at: string;
  native_evidence_ref: string;
}
export interface ResultReceiptsRow extends EntityRow {
  job_id: string;
  attempt_id: string;
  attempt_generation: number;
  input_hash: string;
  output_hash: string;
  commit_purpose: string;
  state: 'pending' | 'committed' | 'quarantined';
  result_ids: string;
  quarantine_reason: string | null;
  idempotency_requests: string;
  output_payload: string | null;
}
export interface JobEventsRow extends EntityRow {
  job_id: string;
  seq: number;
  attempt_no: number;
  type: 'queued' | 'started' | 'phase_changed' | 'progress' | 'candidate_ready' | 'artifact_ready' | 'needs_input' | 'quota_exhausted' | 'reconciling' | 'succeeded' | 'failed' | 'cancelled';
  payload: string;
  occurred_at: string;
}
export interface WriteIntentsRow extends EntityRow {
  document_id: string;
  expected_revision_id: string | null;
  planned_revision_id: string;
  path: string;
  sha256: string;
  pending_content: string | null;
  commit_purpose: 'human_revision' | 'agent_candidate' | 'agent_initialize';
  result_receipt_id: string | null;
  job_id: string | null;
  attempt_id: string | null;
  attempt_generation: number | null;
  input_hash: string | null;
  output_hash: string | null;
  state: 'pending' | 'committed' | 'conflict' | 'quarantined';
  error: string | null;
}
export interface IndexEntriesRow extends EntityRow {
  source_location_id: string;
  path: string;
  mtime: number;
  size: number;
  sha256: string;
  parser_version: string;
  status: string;
  search_text: string;
}
export interface SyncCheckpointsRow extends EntityRow {
  connector_id: string;
  stream_key: string;
  cursor: string | null;
  etag: string | null;
  watermark: string | null;
  last_complete_at: string | null;
}
export interface EvidenceLinksRow extends EntityRow {
  owner_type: string;
  owner_id: string;
  source_type: string;
  source_id: string;
  locator: string | null;
  quote_hash: string | null;
}
export interface SourceEventRecordsRow extends EntityRow {
  event_id: string;
  record_id: string;
}
export interface IdempotencyRequestsRow extends EntityRow {
  operation: string;
  key: string;
  request_hash: string;
  response: string | null;
  state: string;
}
export interface EntityRows {
  workspaces: WorkspacesRow;
  accounts: AccountsRow;
  connectors: ConnectorsRow;
  sources: SourcesRow;
  source_records: SourceRecordsRow;
  source_locations: SourceLocationsRow;
  source_events: SourceEventsRow;
  user_source_marks: UserSourceMarksRow;
  topics: TopicsRow;
  topic_sources: TopicSourcesRow;
  documents: DocumentsRow;
  document_revisions: DocumentRevisionsRow;
  core_approvals: CoreApprovalsRow;
  variants: VariantsRow;
  candidates: CandidatesRow;
  recommendation_runs: RecommendationRunsRow;
  recommendation_candidates: RecommendationCandidatesRow;
  topic_asset_links: TopicAssetLinksRow;
  assets: AssetsRow;
  content_plans: ContentPlansRow;
  content_plan_revisions: ContentPlanRevisionsRow;
  production_plans: ProductionPlansRow;
  production_plan_revisions: ProductionPlanRevisionsRow;
  shots: ShotsRow;
  shot_assets: ShotAssetsRow;
  asset_candidates: AssetCandidatesRow;
  artifacts: ArtifactsRow;
  daily_plans: DailyPlansRow;
  daily_plan_items: DailyPlanItemsRow;
  schedules: SchedulesRow;
  publication_batches: PublicationBatchesRow;
  publication_intents: PublicationIntentsRow;
  publication_members: PublicationMembersRow;
  publication_attempts: PublicationAttemptsRow;
  works: WorksRow;
  work_aliases: WorkAliasesRow;
  metric_definitions: MetricDefinitionsRow;
  snapshots: SnapshotsRow;
  metric_values: MetricValuesRow;
  account_snapshots: AccountSnapshotsRow;
  account_metric_values: AccountMetricValuesRow;
  comparison_runs: ComparisonRunsRow;
  retro_reports: RetroReportsRow;
  retro_actions: RetroActionsRow;
  action_adoptions: ActionAdoptionsRow;
  adoption_works: AdoptionWorksRow;
  action_evaluations: ActionEvaluationsRow;
  business_events: BusinessEventsRow;
  jobs: JobsRow;
  job_attempts: JobAttemptsRow;
  host_connections: HostConnectionsRow;
  host_capability_records: HostCapabilityRecordsRow;
  host_task_observers: HostTaskObserversRow;
  native_task_bindings: NativeTaskBindingsRow;
  native_task_observations: NativeTaskObservationsRow;
  result_receipts: ResultReceiptsRow;
  job_events: JobEventsRow;
  write_intents: WriteIntentsRow;
  index_entries: IndexEntriesRow;
  sync_checkpoints: SyncCheckpointsRow;
  evidence_links: EvidenceLinksRow;
  source_event_records: SourceEventRecordsRow;
  idempotency_requests: IdempotencyRequestsRow;
  publishing_settings: PublishingSettingsRow;
  publishing_connections: PublishingConnectionsRow;
  publishing_connection_revisions: PublishingConnectionRevisionsRow;
  publishing_defaults: PublishingDefaultsRow;
  publishing_connection_checks: PublishingConnectionChecksRow;
  publishing_capability_evidence: PublishingCapabilityEvidenceRow;
  publication_binding_scopes: PublicationBindingScopesRow;
}

// D07-011 / schema v8：发布设置子表使用实际复合身份，未继承不存在的公共时间列。
export interface PublishingSettingsRow { workspace_id: string; version: number; legacy_import_sha256: string | null; imported_at: string | null; diagnostic_claims: string | null }
export interface PublishingConnectionsRow {
 id: string; workspace_id: string; account_id: string; platform: 'x'|'wechat'|'douyin'; route: 'x_v2'|'wechat_official'|'douyin_open';
 version: number; config_revision: number; enabled: number; active_config_revision: number | null;
 runtime_state: 'not_applied'|'active'|'pending'|'apply_failed'; adapter_version: string | null; host_id: string | null; applied_at: string | null;
 error_code: 'AUTH_REQUIRED'|'CAPABILITY_UNSUPPORTED'|'CAPABILITY_UNVERIFIED'|'STORAGE_UNAVAILABLE'|null;
 apply_generation: number; next_check_sequence: number; current_check_sequence: number | null; created_at: string; updated_at: string;
}
export interface PublishingConnectionRevisionsRow { workspace_id: string; connection_id: string; revision: number; credential_name: string | null; route: string; platform_account_id: string; created_at: string }
export interface PublishingDefaultsRow { workspace_id: string; platform: string; format: string; account_id: string; connection_id: string }
export interface PublishingConnectionChecksRow { id: string; workspace_id: string; connection_id: string; sequence: number; config_revision: number; connection_version: number; checked_at: string; result: string; applied_to_current: number }
export interface PublishingCapabilityEvidenceRow { id: string; workspace_id: string; account_id: string; platform: string; format: string; operation: 'prepareDraft'|'submit'|'queryResult'; host_id: string; adapter_version: string; evidence_kind: 'real_platform'; evidence_ref: string; evidence_sha256: string; verified_at: string; limitations: string }
export interface PublicationBindingScopesRow { workspace_id: string; intent_id: string; connection_id: string; config_revision: number; account_id: string; platform: string; format: string; platform_account_id: string; adapter_version: string; host_id: string; created_at: string }
