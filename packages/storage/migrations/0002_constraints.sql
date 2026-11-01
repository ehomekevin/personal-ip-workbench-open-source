-- D07-001：跨工作区/代次/语义唯一性在数据库中执行。
ALTER TABLE workspaces ADD COLUMN default_executor TEXT NOT NULL DEFAULT 'codex' CHECK(default_executor IN ('codex','claude'));
ALTER TABLE workspaces ADD COLUMN api_fallback_enabled INTEGER NOT NULL DEFAULT 0 CHECK(api_fallback_enabled IN (0,1));
CREATE TABLE application_metadata (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL) STRICT;
CREATE UNIQUE INDEX accounts_identity ON accounts(workspace_id, platform, platform_account_id) WHERE platform_account_id IS NOT NULL;
CREATE UNIQUE INDEX works_canonical_identity ON works(workspace_id, platform, platform_work_id) WHERE platform_work_id IS NOT NULL AND canonical_work_id IS NULL;
CREATE UNIQUE INDEX works_pending_url ON works(workspace_id, platform, url) WHERE identity_status='pending' AND platform_work_id IS NULL AND canonical_work_id IS NULL;
CREATE UNIQUE INDEX attempts_one_active ON job_attempts(workspace_id, job_id) WHERE state='active';
CREATE UNIQUE INDEX native_turn_one_active ON native_task_bindings(workspace_id,host_connection_id,native_namespace,native_session_id,native_turn_id) WHERE state='active' AND scope='turn';
CREATE UNIQUE INDEX native_task_one_active ON native_task_bindings(workspace_id,host_connection_id,native_namespace,native_task_id) WHERE state='active' AND scope='task';
CREATE UNIQUE INDEX preparation_one_per_topic ON production_plans(workspace_id,topic_id) WHERE scope='topic_preparation';
CREATE UNIQUE INDEX variant_one_plan ON production_plans(workspace_id,variant_id) WHERE scope='variant';
CREATE UNIQUE INDEX schedule_active_intent ON schedules(workspace_id,publication_intent_id) WHERE state IN ('scheduled','due','executing');
CREATE UNIQUE INDEX publication_input_key ON publication_intents(workspace_id,idempotency_key);
CREATE TRIGGER works_alias_insert BEFORE INSERT ON works WHEN NEW.canonical_work_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM works w WHERE w.id=NEW.canonical_work_id AND w.workspace_id=NEW.workspace_id AND w.platform=NEW.platform AND w.canonical_work_id IS NULL) THEN RAISE(ABORT,'WORK_ALIAS_TARGET_INVALID') END;
END;
CREATE TRIGGER works_alias_update BEFORE UPDATE OF canonical_work_id,workspace_id,platform ON works WHEN NEW.canonical_work_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM works w WHERE w.id=NEW.canonical_work_id AND w.workspace_id=NEW.workspace_id AND w.platform=NEW.platform AND w.canonical_work_id IS NULL) OR EXISTS(SELECT 1 FROM works w WHERE w.canonical_work_id=NEW.id) THEN RAISE(ABORT,'WORK_ALIAS_TARGET_INVALID') END;
END;
CREATE TRIGGER jobs_generation_monotonic BEFORE UPDATE OF attempt_generation ON jobs WHEN NEW.attempt_generation<OLD.attempt_generation BEGIN SELECT RAISE(ABORT,'ATTEMPT_GENERATION_DECREASE'); END;
CREATE TRIGGER jobs_current_attempt_update BEFORE UPDATE OF current_attempt_id,attempt_generation ON jobs WHEN NEW.current_attempt_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM job_attempts a WHERE a.id=NEW.current_attempt_id AND a.workspace_id=NEW.workspace_id AND a.job_id=NEW.id AND a.attempt_generation=NEW.attempt_generation AND a.state='active') THEN RAISE(ABORT,'CURRENT_ATTEMPT_INVALID') END;
END;
CREATE TRIGGER candidates_committed_receipt BEFORE INSERT ON candidates BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM result_receipts r WHERE r.id=NEW.result_receipt_id AND r.workspace_id=NEW.workspace_id AND r.job_id=NEW.job_id AND r.attempt_id=NEW.attempt_id AND r.attempt_generation=NEW.attempt_generation AND r.state='committed') THEN RAISE(ABORT,'RECEIPT_NOT_COMMITTED') END;
END;
CREATE TRIGGER recommendation_committed_receipt BEFORE INSERT ON recommendation_candidates BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM result_receipts r WHERE r.id=NEW.result_receipt_id AND r.workspace_id=NEW.workspace_id AND r.attempt_id=NEW.attempt_id AND r.attempt_generation=NEW.attempt_generation AND r.state='committed') THEN RAISE(ABORT,'RECEIPT_NOT_COMMITTED') END;
END;
CREATE TRIGGER production_revision_scope BEFORE INSERT ON production_plan_revisions BEGIN
 SELECT CASE WHEN EXISTS(SELECT 1 FROM production_plans p WHERE p.id=NEW.plan_id AND p.workspace_id=NEW.workspace_id AND p.scope='variant') AND (NEW.variant_revision_id IS NULL OR NEW.script_revision_id IS NULL) THEN RAISE(ABORT,'VARIANT_PLAN_TEXT_REQUIRED') END;
END;
CREATE TRIGGER document_revisions_immutable_update BEFORE UPDATE ON document_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER document_revisions_immutable_delete BEFORE DELETE ON document_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER core_approvals_immutable_update BEFORE UPDATE ON core_approvals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER core_approvals_immutable_delete BEFORE DELETE ON core_approvals BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER content_plan_revisions_immutable_update BEFORE UPDATE ON content_plan_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER content_plan_revisions_immutable_delete BEFORE DELETE ON content_plan_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER production_plan_revisions_immutable_update BEFORE UPDATE ON production_plan_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER production_plan_revisions_immutable_delete BEFORE DELETE ON production_plan_revisions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER shots_immutable_update BEFORE UPDATE ON shots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER shots_immutable_delete BEFORE DELETE ON shots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER shot_assets_immutable_update BEFORE UPDATE ON shot_assets BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER shot_assets_immutable_delete BEFORE DELETE ON shot_assets BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER snapshots_immutable_update BEFORE UPDATE ON snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER snapshots_immutable_delete BEFORE DELETE ON snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER metric_values_immutable_update BEFORE UPDATE ON metric_values BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER metric_values_immutable_delete BEFORE DELETE ON metric_values BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER account_snapshots_immutable_update BEFORE UPDATE ON account_snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER account_snapshots_immutable_delete BEFORE DELETE ON account_snapshots BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER account_metric_values_immutable_update BEFORE UPDATE ON account_metric_values BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER account_metric_values_immutable_delete BEFORE DELETE ON account_metric_values BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER comparison_runs_immutable_update BEFORE UPDATE ON comparison_runs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER comparison_runs_immutable_delete BEFORE DELETE ON comparison_runs BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER action_adoptions_immutable_update BEFORE UPDATE ON action_adoptions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER action_adoptions_immutable_delete BEFORE DELETE ON action_adoptions BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER adoption_works_immutable_update BEFORE UPDATE ON adoption_works BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER adoption_works_immutable_delete BEFORE DELETE ON adoption_works BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER action_evaluations_immutable_update BEFORE UPDATE ON action_evaluations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER action_evaluations_immutable_delete BEFORE DELETE ON action_evaluations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER job_events_immutable_update BEFORE UPDATE ON job_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER job_events_immutable_delete BEFORE DELETE ON job_events BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER native_task_observations_immutable_update BEFORE UPDATE ON native_task_observations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER native_task_observations_immutable_delete BEFORE DELETE ON native_task_observations BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER source_event_records_immutable_update BEFORE UPDATE ON source_event_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER source_event_records_immutable_delete BEFORE DELETE ON source_event_records BEGIN SELECT RAISE(ABORT,'IMMUTABLE_RECORD'); END;
CREATE TRIGGER job_attempts_fixed_provenance BEFORE UPDATE ON job_attempts WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt_no IS NOT OLD.attempt_no OR NEW.attempt_generation IS NOT OLD.attempt_generation OR NEW.host_connection_id IS NOT OLD.host_connection_id OR NEW.native_task_binding_id IS NOT OLD.native_task_binding_id BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
CREATE TRIGGER result_receipts_fixed_provenance BEFORE UPDATE ON result_receipts WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.attempt_generation IS NOT OLD.attempt_generation OR NEW.input_hash IS NOT OLD.input_hash OR NEW.output_hash IS NOT OLD.output_hash OR NEW.commit_purpose IS NOT OLD.commit_purpose BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
CREATE TRIGGER write_intents_fixed_provenance BEFORE UPDATE ON write_intents WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.document_id IS NOT OLD.document_id OR NEW.expected_revision_id IS NOT OLD.expected_revision_id OR NEW.planned_revision_id IS NOT OLD.planned_revision_id OR NEW.path IS NOT OLD.path OR NEW.sha256 IS NOT OLD.sha256 OR NEW.commit_purpose IS NOT OLD.commit_purpose OR NEW.result_receipt_id IS NOT OLD.result_receipt_id OR NEW.job_id IS NOT OLD.job_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.attempt_generation IS NOT OLD.attempt_generation OR NEW.input_hash IS NOT OLD.input_hash OR NEW.output_hash IS NOT OLD.output_hash BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
CREATE TRIGGER publication_intents_fixed_provenance BEFORE UPDATE ON publication_intents WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.variant_id IS NOT OLD.variant_id OR NEW.account_id IS NOT OLD.account_id OR NEW.revision_id IS NOT OLD.revision_id OR NEW.content_plan_revision_id IS NOT OLD.content_plan_revision_id OR NEW.artifact_id IS NOT OLD.artifact_id OR NEW.core_approval_id IS NOT OLD.core_approval_id OR NEW.input_hash IS NOT OLD.input_hash OR NEW.idempotency_key IS NOT OLD.idempotency_key BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
CREATE TRIGGER publication_members_fixed_provenance BEFORE UPDATE ON publication_members WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.id IS NOT OLD.id OR NEW.intent_id IS NOT OLD.intent_id OR NEW.member_key IS NOT OLD.member_key OR NEW.position IS NOT OLD.position OR NEW.text_revision_id IS NOT OLD.text_revision_id OR NEW.payload_hash IS NOT OLD.payload_hash OR NEW.reply_to_member_key IS NOT OLD.reply_to_member_key BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
CREATE TRIGGER candidates_fixed_receipt BEFORE UPDATE ON candidates WHEN NEW.result_receipt_id IS NOT OLD.result_receipt_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.attempt_generation IS NOT OLD.attempt_generation BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
CREATE TRIGGER recommendation_candidates_fixed_receipt BEFORE UPDATE ON recommendation_candidates WHEN NEW.result_receipt_id IS NOT OLD.result_receipt_id OR NEW.attempt_id IS NOT OLD.attempt_id OR NEW.attempt_generation IS NOT OLD.attempt_generation BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;

CREATE UNIQUE INDEX http_idempotency_key ON idempotency_requests(workspace_id,key);
CREATE TRIGGER idempotency_fixed_request BEFORE UPDATE ON idempotency_requests WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.operation IS NOT OLD.operation OR NEW.key IS NOT OLD.key OR NEW.request_hash IS NOT OLD.request_hash BEGIN SELECT RAISE(ABORT,'FIXED_REQUEST'); END;
