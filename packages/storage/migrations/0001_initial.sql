-- D07-001 / Spec v0.5：全新库，不从历史 agent 推测归属。

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  title TEXT NOT NULL,
  timezone TEXT NOT NULL,
  paths TEXT NOT NULL CHECK (paths IS NULL OR json_valid(paths)),
  mode TEXT NOT NULL CHECK (mode IN ('real','demo')),
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  CHECK (workspace_id = id)
) STRICT;

CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  platform TEXT NOT NULL CHECK (platform IN ('xiaohongshu','wechat','x','douyin','bilibili')),
  platform_account_id TEXT,
  role TEXT NOT NULL CHECK (role IN ('owner','benchmark')),
  name TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  identity_status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE connectors (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  capability_status TEXT NOT NULL CHECK (capability_status IN ('unconfigured','unverified','supported','unsupported','degraded')),
  config_ref TEXT,
  last_success_at TEXT,
  last_error TEXT CHECK (last_error IS NULL OR json_valid(last_error)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  connector_id TEXT,
  external_id TEXT,
  url TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  last_sync_at TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, connector_id) REFERENCES connectors(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE source_records (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_id TEXT NOT NULL,
  external_id TEXT,
  canonical_url TEXT,
  record_kind TEXT NOT NULL,
  work_id TEXT,
  author_account_id TEXT,
  published_at TEXT,
  content_document_id TEXT,
  content_status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, author_account_id) REFERENCES accounts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, content_document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE source_locations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  relative_path TEXT,
  source_url TEXT,
  capture_time TEXT,
  sha256 TEXT NOT NULL CHECK (sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  parser_version TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, record_id) REFERENCES source_records(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE source_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_id TEXT NOT NULL,
  external_event_id TEXT NOT NULL,
  title TEXT NOT NULL,
  occurred_at TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE user_source_marks (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  record_id TEXT NOT NULL,
  read_at TEXT,
  favorite INTEGER NOT NULL CHECK (favorite IN (0,1)),
  used_at TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, record_id) REFERENCES source_records(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, record_id)
) STRICT;

CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  title TEXT NOT NULL,
  category TEXT NOT NULL,
  audience TEXT NOT NULL,
  angle TEXT NOT NULL,
  expected_effort_min INTEGER NOT NULL CHECK (expected_effort_min IS NULL OR expected_effort_min >= 0),
  core_document_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','archived')),
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, core_document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE topic_sources (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  topic_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  usage TEXT NOT NULL,
  locator TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_record_id) REFERENCES source_records(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, topic_id, source_record_id)
) STRICT;

CREATE TABLE documents (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  owner_entity_id TEXT,
  head_revision_id TEXT,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, head_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE document_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  document_id TEXT NOT NULL,
  parent_revision_id TEXT,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  origin TEXT NOT NULL CHECK (origin IN ('human','agent','import','restore')),
  change_kind TEXT NOT NULL CHECK (change_kind IN ('text','restore','core_alignment','merge')),
  job_id TEXT,
  attempt_id TEXT,
  attempt_generation INTEGER CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  result_receipt_id TEXT,
  based_on_core_revision_id TEXT,
  created_by TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, parent_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id) REFERENCES result_receipts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, based_on_core_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (origin <> 'agent' OR (job_id IS NOT NULL AND attempt_id IS NOT NULL AND attempt_generation IS NOT NULL AND result_receipt_id IS NOT NULL)),
  FOREIGN KEY (workspace_id, attempt_id, job_id, attempt_generation) REFERENCES job_attempts(workspace_id, id, job_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id, job_id, attempt_id, attempt_generation) REFERENCES result_receipts(workspace_id, id, job_id, attempt_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE core_approvals (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  topic_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  approved_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE variants (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  topic_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('xiaohongshu','wechat','x','douyin','bilibili')),
  format TEXT NOT NULL CHECK (format IN ('text','thread','article','image_post','short_video','long_video')),
  variant_key TEXT NOT NULL,
  document_id TEXT NOT NULL,
  based_on_core_revision_id TEXT NOT NULL,
  status TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, based_on_core_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, topic_id, platform, format, variant_key)
) STRICT;

CREATE TABLE candidates (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  target_document_id TEXT NOT NULL,
  base_revision_id TEXT,
  revision_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  result_receipt_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','adopted','rejected','conflict')),
  adopted_revision_id TEXT,
  adoption_mode TEXT CHECK (adoption_mode IN ('manual','auto_initial')),
  adopted_at TEXT,
  adopted_by TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, target_document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, base_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id) REFERENCES result_receipts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, adopted_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id, job_id, attempt_generation) REFERENCES job_attempts(workspace_id, id, job_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id, job_id, attempt_id, attempt_generation) REFERENCES result_receipts(workspace_id, id, job_id, attempt_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE recommendation_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL CHECK (kind IN ('topic','account')),
  input_manifest TEXT NOT NULL CHECK (input_manifest IS NULL OR json_valid(input_manifest)),
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE recommendation_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  run_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('topic','account')),
  payload TEXT NOT NULL CHECK (payload IS NULL OR json_valid(payload)),
  source_ids TEXT NOT NULL CHECK (source_ids IS NULL OR json_valid(source_ids)),
  rationale TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  result_receipt_id TEXT NOT NULL,
  status TEXT NOT NULL,
  adopted_target_id TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, run_id) REFERENCES recommendation_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id) REFERENCES result_receipts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE topic_asset_links (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  topic_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE assets (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  origin TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes IS NULL OR size_bytes >= 0),
  mime TEXT NOT NULL,
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  dimensions TEXT CHECK (dimensions IS NULL OR json_valid(dimensions)),
  status TEXT NOT NULL,
  job_id TEXT,
  generation_metadata TEXT CHECK (generation_metadata IS NULL OR json_valid(generation_metadata)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE content_plans (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  variant_id TEXT NOT NULL,
  head_content_revision_id TEXT,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, head_content_revision_id) REFERENCES content_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE content_plan_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  plan_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no IS NULL OR revision_no >= 1),
  parent_revision_id TEXT,
  variant_revision_id TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('text','thread','article','image_post','short_video','long_video')),
  schema_version TEXT NOT NULL,
  units TEXT NOT NULL CHECK (units IS NULL OR json_valid(units)),
  title_revision_id TEXT,
  caption_revision_id TEXT,
  cover_asset_id TEXT,
  input_hash TEXT NOT NULL CHECK (input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, plan_id) REFERENCES content_plans(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, parent_revision_id) REFERENCES content_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, title_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, caption_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, cover_asset_id) REFERENCES assets(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, plan_id, revision_no)
) STRICT;

CREATE TABLE production_plans (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  topic_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('topic_preparation','variant')),
  variant_id TEXT,
  head_plan_revision_id TEXT,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, head_plan_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope='topic_preparation' AND variant_id IS NULL) OR (scope='variant' AND variant_id IS NOT NULL))
) STRICT;

CREATE TABLE production_plan_revisions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  plan_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL CHECK (revision_no IS NULL OR revision_no >= 1),
  parent_revision_id TEXT,
  variant_revision_id TEXT,
  script_revision_id TEXT,
  source_preparation_revision_id TEXT,
  input_hash TEXT NOT NULL CHECK (input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, plan_id) REFERENCES production_plans(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, parent_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, script_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_preparation_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, plan_id, revision_no)
) STRICT;

CREATE TABLE shots (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  plan_revision_id TEXT NOT NULL,
  shot_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position IS NULL OR position >= 0),
  title TEXT NOT NULL,
  kind TEXT NOT NULL,
  duration_ms INTEGER NOT NULL CHECK (duration_ms IS NULL OR duration_ms >= 0),
  narration_revision_id TEXT,
  subtitle_revision_id TEXT,
  source_requirement TEXT NOT NULL CHECK (source_requirement IS NULL OR json_valid(source_requirement)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, plan_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, narration_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, subtitle_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, plan_revision_id, shot_key),
  UNIQUE (workspace_id, plan_revision_id, position)
) STRICT;

CREATE TABLE shot_assets (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  shot_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  role TEXT NOT NULL,
  in_ms INTEGER CHECK (in_ms IS NULL OR in_ms >= 0),
  out_ms INTEGER CHECK (out_ms IS NULL OR out_ms >= 0),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, shot_id) REFERENCES shots(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (in_ms IS NULL OR out_ms IS NULL OR out_ms > in_ms)
) STRICT;

CREATE TABLE asset_candidates (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  job_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  target_plan_revision_id TEXT,
  target_shot_key TEXT,
  base_asset_id TEXT,
  status TEXT NOT NULL,
  adopted_plan_revision_id TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, target_plan_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, base_asset_id) REFERENCES assets(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, adopted_plan_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  variant_id TEXT NOT NULL,
  variant_revision_id TEXT NOT NULL,
  content_plan_revision_id TEXT,
  production_plan_revision_id TEXT,
  manifest_path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, content_plan_revision_id) REFERENCES content_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, production_plan_revision_id) REFERENCES production_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE daily_plans (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  local_date TEXT NOT NULL,
  timezone TEXT NOT NULL,
  budget_min INTEGER NOT NULL CHECK (budget_min IS NULL OR budget_min >= 0),
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, local_date, timezone)
) STRICT;

CREATE TABLE daily_plan_items (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  plan_id TEXT NOT NULL,
  topic_id TEXT,
  job_id TEXT,
  action_id TEXT,
  position INTEGER NOT NULL CHECK (position IS NULL OR position >= 0),
  effort_min INTEGER NOT NULL CHECK (effort_min IS NULL OR effort_min >= 0),
  status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, plan_id) REFERENCES daily_plans(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, action_id) REFERENCES retro_actions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, plan_id, position)
) STRICT;

CREATE TABLE schedules (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  variant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  variant_revision_id TEXT NOT NULL,
  artifact_id TEXT,
  due_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  local_time TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  state TEXT NOT NULL CHECK (state IN ('scheduled','due','executing','completed','missed','cancelled','needs_attention')),
  publication_intent_id TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, publication_intent_id) REFERENCES publication_intents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE publication_batches (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  triggered_by TEXT NOT NULL,
  requested_at TEXT NOT NULL,
  status TEXT NOT NULL,
  orchestrator_job_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, orchestrator_job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE publication_intents (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  batch_id TEXT,
  variant_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  content_plan_revision_id TEXT,
  artifact_id TEXT,
  core_approval_id TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK (input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued','uploading','platform_draft','processing','published','failed','unknown','cancelled','needs_action','superseded')),
  progress TEXT NOT NULL CHECK (progress IS NULL OR json_valid(progress)),
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  draft_id TEXT,
  work_id TEXT,
  replaces_intent_id TEXT,
  superseded_by_intent_id TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, batch_id) REFERENCES publication_batches(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, content_plan_revision_id) REFERENCES content_plan_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, core_approval_id) REFERENCES core_approvals(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, replaces_intent_id) REFERENCES publication_intents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, superseded_by_intent_id) REFERENCES publication_intents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE publication_members (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  intent_id TEXT NOT NULL,
  member_key TEXT NOT NULL,
  position INTEGER NOT NULL CHECK (position IS NULL OR position >= 0),
  text_revision_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK (payload_hash IS NULL OR (length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*')),
  reply_to_member_key TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','sending','published','failed','unknown','cancelled')),
  platform_work_id TEXT,
  work_id TEXT,
  remote_request_id TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, intent_id) REFERENCES publication_intents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, text_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, intent_id, member_key),
  UNIQUE (workspace_id, intent_id, position)
) STRICT;

CREATE TABLE publication_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  intent_id TEXT NOT NULL,
  member_id TEXT,
  attempt_no INTEGER NOT NULL CHECK (attempt_no IS NULL OR attempt_no >= 1),
  phase TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  remote_request_id TEXT,
  result_status TEXT NOT NULL,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  started_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, intent_id) REFERENCES publication_intents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, member_id) REFERENCES publication_members(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE works (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  platform TEXT NOT NULL CHECK (platform IN ('xiaohongshu','wechat','x','douyin','bilibili')),
  platform_work_id TEXT,
  account_id TEXT,
  format TEXT CHECK (format IN ('text','thread','article','image_post','short_video','long_video')),
  format_source TEXT,
  topic_id TEXT,
  variant_id TEXT,
  revision_id TEXT,
  url TEXT NOT NULL,
  published_at TEXT,
  origin TEXT NOT NULL,
  identity_status TEXT NOT NULL,
  canonical_work_id TEXT,
  parent_work_id TEXT,
  position INTEGER CHECK (position IS NULL OR position >= 0),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, canonical_work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, parent_work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (canonical_work_id IS NULL OR canonical_work_id <> id)
) STRICT;

CREATE TABLE work_aliases (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  alias_work_id TEXT NOT NULL,
  canonical_work_id TEXT NOT NULL,
  source_url TEXT NOT NULL,
  resolution_evidence TEXT NOT NULL CHECK (resolution_evidence IS NULL OR json_valid(resolution_evidence)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, alias_work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, canonical_work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, alias_work_id)
) STRICT;

CREATE TABLE metric_definitions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  platform TEXT NOT NULL CHECK (platform IN ('xiaohongshu','wechat','x','douyin','bilibili')),
  key TEXT NOT NULL,
  raw_field TEXT NOT NULL,
  unit TEXT NOT NULL,
  kind TEXT NOT NULL,
  denominator_key TEXT,
  visibility TEXT NOT NULL,
  definition_version TEXT NOT NULL,
  scope TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  work_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  collection_request_id TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  observed_at TEXT,
  observed_time_basis TEXT NOT NULL CHECK (observed_time_basis IN ('provider','collector_verified','unknown')),
  observed_time_reason TEXT,
  collected_at TEXT NOT NULL,
  target_window INTEGER CHECK (target_window IS NULL OR target_window >= 0),
  observed_age_s INTEGER CHECK (observed_age_s IS NULL OR observed_age_s >= 0),
  raw_path TEXT NOT NULL,
  raw_sha256 TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  supersedes_snapshot_id TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, supersedes_snapshot_id) REFERENCES snapshots(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, source_id, request_fingerprint, raw_sha256),
  CHECK ((observed_time_basis='unknown' AND observed_at IS NULL AND observed_time_reason IS NOT NULL AND length(observed_time_reason)>0) OR (observed_time_basis<>'unknown' AND observed_at IS NOT NULL)),
  CHECK (observed_at IS NOT NULL OR observed_age_s IS NULL)
) STRICT;

CREATE TABLE metric_values (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  snapshot_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  value TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('available','not_collected','unavailable','unsupported','invalid')),
  reason TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, snapshot_id) REFERENCES snapshots(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, definition_id) REFERENCES metric_definitions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, snapshot_id, definition_id),
  CHECK ((availability='available' AND value IS NOT NULL AND decimal_valid(value)=1) OR (availability<>'available' AND value IS NULL AND reason IS NOT NULL AND length(reason)>0))
) STRICT;

CREATE TABLE account_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  account_id TEXT NOT NULL,
  observed_at TEXT,
  observed_time_basis TEXT NOT NULL CHECK (observed_time_basis IN ('provider','collector_verified','unknown')),
  observed_time_reason TEXT,
  collected_at TEXT NOT NULL,
  raw_path TEXT NOT NULL,
  adapter_version TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, account_id) REFERENCES accounts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((observed_time_basis='unknown' AND observed_at IS NULL AND observed_time_reason IS NOT NULL AND length(observed_time_reason)>0) OR (observed_time_basis<>'unknown' AND observed_at IS NOT NULL))
) STRICT;

CREATE TABLE account_metric_values (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  account_snapshot_id TEXT NOT NULL,
  definition_id TEXT NOT NULL,
  value TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('available','not_collected','unavailable','unsupported','invalid')),
  reason TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, account_snapshot_id) REFERENCES account_snapshots(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, definition_id) REFERENCES metric_definitions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, account_snapshot_id, definition_id),
  CHECK ((availability='available' AND value IS NOT NULL AND decimal_valid(value)=1) OR (availability<>'available' AND value IS NULL AND reason IS NOT NULL AND length(reason)>0))
) STRICT;

CREATE TABLE comparison_runs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  query_spec TEXT NOT NULL CHECK (query_spec IS NULL OR json_valid(query_spec)),
  selected_snapshot_ids TEXT NOT NULL CHECK (selected_snapshot_ids IS NULL OR json_valid(selected_snapshot_ids)),
  selected_inputs_by_cohort TEXT NOT NULL CHECK (selected_inputs_by_cohort IS NULL OR json_valid(selected_inputs_by_cohort)),
  excluded_work_ids TEXT NOT NULL CHECK (excluded_work_ids IS NULL OR json_valid(excluded_work_ids)),
  excluded_reasons TEXT NOT NULL CHECK (excluded_reasons IS NULL OR json_valid(excluded_reasons)),
  definition_versions TEXT NOT NULL CHECK (definition_versions IS NULL OR json_valid(definition_versions)),
  result TEXT NOT NULL CHECK (result IS NULL OR json_valid(result)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE retro_reports (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  document_id TEXT NOT NULL,
  comparison_run_id TEXT NOT NULL,
  source_record_ids TEXT NOT NULL CHECK (source_record_ids IS NULL OR json_valid(source_record_ids)),
  status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, comparison_run_id) REFERENCES comparison_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE retro_actions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  report_id TEXT NOT NULL,
  report_revision_id TEXT NOT NULL,
  description TEXT NOT NULL,
  hypothesis TEXT NOT NULL,
  target_metric TEXT NOT NULL,
  observation_plan TEXT NOT NULL CHECK (observation_plan IS NULL OR json_valid(observation_plan)),
  status TEXT NOT NULL CHECK (status IN ('proposed','adopted','observing','evaluated','stopped')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, report_id) REFERENCES retro_reports(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, report_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE action_adoptions (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  action_id TEXT NOT NULL,
  adoption_key TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  variant_id TEXT,
  adopted_at TEXT NOT NULL,
  baseline_run_id TEXT,
  baseline_cohort_key TEXT,
  baseline_input_hash TEXT CHECK (baseline_input_hash IS NULL OR (length(baseline_input_hash)=64 AND baseline_input_hash NOT GLOB '*[^0-9a-f]*')),
  observation_plan TEXT NOT NULL CHECK (observation_plan IS NULL OR json_valid(observation_plan)),
  plan_hash TEXT NOT NULL CHECK (plan_hash IS NULL OR (length(plan_hash)=64 AND plan_hash NOT GLOB '*[^0-9a-f]*')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, action_id) REFERENCES retro_actions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, variant_id) REFERENCES variants(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, baseline_run_id) REFERENCES comparison_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, action_id, adoption_key)
) STRICT;

CREATE TABLE adoption_works (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  adoption_id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  link_evidence TEXT NOT NULL CHECK (link_evidence IS NULL OR json_valid(link_evidence)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, adoption_id) REFERENCES action_adoptions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, adoption_id, work_id)
) STRICT;

CREATE TABLE action_evaluations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  adoption_id TEXT NOT NULL,
  comparison_run_id TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('supported','not_supported','mixed','insufficient')),
  limitations TEXT NOT NULL CHECK (limitations IS NULL OR json_valid(limitations)),
  evaluated_at TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, adoption_id) REFERENCES action_adoptions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, comparison_run_id) REFERENCES comparison_runs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE business_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  work_id TEXT,
  topic_id TEXT,
  count TEXT,
  amount TEXT,
  note TEXT NOT NULL,
  attribution_status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, work_id) REFERENCES works(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, topic_id) REFERENCES topics(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  kind TEXT NOT NULL,
  target_id TEXT,
  executor_id TEXT,
  entrypoint TEXT NOT NULL CHECK (entrypoint IN ('standalone_web','codex_plugin','claude_plugin','claude_code_plugin')),
  execution_mode TEXT NOT NULL CHECK (execution_mode IN ('programmatic','service_adapter','host_session')),
  current_attempt_id TEXT,
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  input_manifest TEXT NOT NULL CHECK (input_manifest IS NULL OR json_valid(input_manifest)),
  input_hash TEXT NOT NULL CHECK (input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('queued','running','waiting_input','waiting_quota','cancel_requested','reconciling','succeeded','failed','cancelled')),
  due_at TEXT,
  retry_policy TEXT NOT NULL CHECK (retry_policy IS NULL OR json_valid(retry_policy)),
  presentation TEXT NOT NULL CHECK (presentation IN ('foreground_dialog','background','host_conversation')),
  cancel_requested_at TEXT,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, current_attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  job_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL CHECK (attempt_no IS NULL OR attempt_no >= 1),
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  state TEXT NOT NULL CHECK (state IN ('active','succeeded','failed','expired','cancelled','superseded')),
  lease_owner TEXT NOT NULL,
  lease_until TEXT NOT NULL,
  host_connection_id TEXT,
  native_task_binding_id TEXT,
  output_deadline TEXT,
  output_hash TEXT CHECK (output_hash IS NULL OR (length(output_hash)=64 AND output_hash NOT GLOB '*[^0-9a-f]*')),
  checkpoint TEXT NOT NULL CHECK (checkpoint IS NULL OR json_valid(checkpoint)),
  runtime_session_id TEXT,
  runtime_turn_id TEXT,
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, host_connection_id) REFERENCES host_connections(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, native_task_binding_id) REFERENCES native_task_bindings(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, job_id, attempt_generation),
  UNIQUE (workspace_id, id, job_id, attempt_generation)
) STRICT;

CREATE TABLE host_connections (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  service_instance_id TEXT NOT NULL,
  host_surface TEXT NOT NULL,
  plugin_id TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  connection_mode TEXT NOT NULL,
  request_identity_ref TEXT NOT NULL,
  status TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE host_capability_records (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  host_surface TEXT NOT NULL,
  runtime_version TEXT NOT NULL,
  connection_mode TEXT NOT NULL,
  operation TEXT NOT NULL,
  plugin_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('unconfigured','unverified','supported','unsupported','degraded')),
  limitations TEXT NOT NULL CHECK (limitations IS NULL OR json_valid(limitations)),
  verified_at TEXT,
  evidence_ref TEXT,
  version INTEGER NOT NULL CHECK (version IS NULL OR version >= 1),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE host_task_observers (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  observer_epoch TEXT NOT NULL,
  host_connection_id TEXT NOT NULL,
  capability_record_id TEXT NOT NULL,
  capability_version INTEGER NOT NULL CHECK (capability_version IS NULL OR capability_version >= 0),
  request_identity_ref TEXT NOT NULL,
  state TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, host_connection_id) REFERENCES host_connections(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, capability_record_id) REFERENCES host_capability_records(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, id, observer_epoch)
) STRICT;

CREATE TABLE native_task_bindings (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  observer_id TEXT NOT NULL,
  observer_epoch TEXT NOT NULL,
  host_connection_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('turn','task')),
  native_namespace TEXT NOT NULL,
  native_session_id TEXT,
  native_turn_id TEXT,
  native_task_id TEXT,
  current_attempt_id TEXT,
  latest_observation_id TEXT,
  last_renewed_observation_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('active','closed')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, observer_id) REFERENCES host_task_observers(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, host_connection_id) REFERENCES host_connections(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, current_attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, latest_observation_id) REFERENCES native_task_observations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, last_renewed_observation_id) REFERENCES native_task_observations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK (length(native_namespace)>0),
  CHECK ((scope='turn' AND native_session_id IS NOT NULL AND length(native_session_id)>0 AND native_turn_id IS NOT NULL AND length(native_turn_id)>0 AND native_task_id IS NULL) OR (scope='task' AND native_task_id IS NOT NULL AND length(native_task_id)>0 AND native_turn_id IS NULL)),
  FOREIGN KEY (workspace_id, observer_id, observer_epoch) REFERENCES host_task_observers(workspace_id, id, observer_epoch) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE native_task_observations (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  binding_id TEXT NOT NULL,
  observer_id TEXT NOT NULL,
  observer_epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence IS NULL OR sequence >= 1),
  native_state TEXT NOT NULL CHECK (native_state IN ('running','waiting_tool','completed','failed','interrupted','auth_required','quota_exhausted','disconnected')),
  observed_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  native_evidence_ref TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, binding_id) REFERENCES native_task_bindings(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, observer_id) REFERENCES host_task_observers(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, binding_id, sequence),
  FOREIGN KEY (workspace_id, observer_id, observer_epoch) REFERENCES host_task_observers(workspace_id, id, observer_epoch) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE result_receipts (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  job_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_generation INTEGER NOT NULL CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  input_hash TEXT NOT NULL CHECK (input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  output_hash TEXT NOT NULL CHECK (output_hash IS NULL OR (length(output_hash)=64 AND output_hash NOT GLOB '*[^0-9a-f]*')),
  commit_purpose TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','committed','quarantined')),
  result_ids TEXT NOT NULL CHECK (result_ids IS NULL OR json_valid(result_ids)),
  quarantine_reason TEXT,
  idempotency_requests TEXT NOT NULL CHECK (idempotency_requests IS NULL OR json_valid(idempotency_requests)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, job_id, attempt_id, attempt_generation),
  UNIQUE (workspace_id, id, job_id, attempt_id, attempt_generation),
  UNIQUE (workspace_id, id, job_id, attempt_id, attempt_generation, input_hash, output_hash),
  FOREIGN KEY (workspace_id, attempt_id, job_id, attempt_generation) REFERENCES job_attempts(workspace_id, id, job_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE job_events (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL CHECK (seq IS NULL OR seq >= 1),
  attempt_no INTEGER NOT NULL CHECK (attempt_no IS NULL OR attempt_no >= 1),
  type TEXT NOT NULL CHECK (type IN ('queued','started','phase_changed','progress','candidate_ready','artifact_ready','needs_input','quota_exhausted','reconciling','succeeded','failed','cancelled')),
  payload TEXT NOT NULL CHECK (payload IS NULL OR json_valid(payload)),
  occurred_at TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, job_id, seq)
) STRICT;

CREATE TABLE write_intents (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  document_id TEXT NOT NULL,
  expected_revision_id TEXT,
  planned_revision_id TEXT NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  pending_content TEXT,
  commit_purpose TEXT NOT NULL CHECK (commit_purpose IN ('human_revision','agent_candidate','agent_initialize')),
  result_receipt_id TEXT,
  job_id TEXT,
  attempt_id TEXT,
  attempt_generation INTEGER CHECK (attempt_generation IS NULL OR attempt_generation >= 0),
  input_hash TEXT CHECK (input_hash IS NULL OR (length(input_hash)=64 AND input_hash NOT GLOB '*[^0-9a-f]*')),
  output_hash TEXT CHECK (output_hash IS NULL OR (length(output_hash)=64 AND output_hash NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL CHECK (state IN ('pending','committed','conflict','quarantined')),
  error TEXT CHECK (error IS NULL OR json_valid(error)),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, document_id) REFERENCES documents(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, expected_revision_id) REFERENCES document_revisions(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id) REFERENCES result_receipts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, job_id) REFERENCES jobs(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, attempt_id) REFERENCES job_attempts(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((commit_purpose='human_revision' AND result_receipt_id IS NULL AND job_id IS NULL AND attempt_id IS NULL AND attempt_generation IS NULL AND input_hash IS NULL AND output_hash IS NULL) OR (commit_purpose IN ('agent_candidate','agent_initialize') AND result_receipt_id IS NOT NULL AND job_id IS NOT NULL AND attempt_id IS NOT NULL AND attempt_generation IS NOT NULL AND input_hash IS NOT NULL AND output_hash IS NOT NULL)),
  FOREIGN KEY (workspace_id, attempt_id, job_id, attempt_generation) REFERENCES job_attempts(workspace_id, id, job_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id, job_id, attempt_id, attempt_generation) REFERENCES result_receipts(workspace_id, id, job_id, attempt_id, attempt_generation) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, result_receipt_id, job_id, attempt_id, attempt_generation, input_hash, output_hash) REFERENCES result_receipts(workspace_id, id, job_id, attempt_id, attempt_generation, input_hash, output_hash) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE index_entries (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  source_location_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mtime INTEGER NOT NULL CHECK (mtime IS NULL OR mtime >= 0),
  size INTEGER NOT NULL CHECK (size IS NULL OR size >= 0),
  sha256 TEXT NOT NULL CHECK (sha256 IS NULL OR (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*')),
  parser_version TEXT NOT NULL,
  status TEXT NOT NULL,
  search_text TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_location_id) REFERENCES source_locations(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE sync_checkpoints (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  connector_id TEXT NOT NULL,
  stream_key TEXT NOT NULL,
  cursor TEXT,
  etag TEXT,
  watermark TEXT,
  last_complete_at TEXT,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, connector_id) REFERENCES connectors(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, connector_id, stream_key)
) STRICT;

CREATE TABLE evidence_links (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  locator TEXT,
  quote_hash TEXT CHECK (quote_hash IS NULL OR (length(quote_hash)=64 AND quote_hash NOT GLOB '*[^0-9a-f]*')),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, source_id) REFERENCES sources(workspace_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE source_event_records (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  event_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, event_id) REFERENCES source_events(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (workspace_id, record_id) REFERENCES source_records(workspace_id, id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, event_id, record_id)
) STRICT;

CREATE TABLE idempotency_requests (
  id TEXT PRIMARY KEY NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (request_hash IS NULL OR (length(request_hash)=64 AND request_hash NOT GLOB '*[^0-9a-f]*')),
  response TEXT CHECK (response IS NULL OR json_valid(response)),
  state TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED,
  UNIQUE (workspace_id, operation, key)
) STRICT;
