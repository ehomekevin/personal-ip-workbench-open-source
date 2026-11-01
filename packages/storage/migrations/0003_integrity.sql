-- D07-002：强化既有所有权与终态约束；不增加外部字段或端点。
CREATE TEMP TABLE migration_integrity_assert (violations INTEGER CHECK(violations=0));
INSERT INTO migration_integrity_assert SELECT COUNT(*) FROM documents d JOIN document_revisions r ON r.id=d.head_revision_id WHERE r.workspace_id<>d.workspace_id OR r.document_id<>d.id;
INSERT INTO migration_integrity_assert SELECT COUNT(*) FROM document_revisions r JOIN document_revisions p ON p.id=r.parent_revision_id WHERE p.workspace_id<>r.workspace_id OR p.document_id<>r.document_id;
INSERT INTO migration_integrity_assert SELECT COUNT(*) FROM candidates c JOIN document_revisions r ON r.id=c.revision_id WHERE r.workspace_id<>c.workspace_id OR r.document_id<>c.target_document_id;
DROP TABLE migration_integrity_assert;
CREATE UNIQUE INDEX write_intent_revision ON write_intents(workspace_id,planned_revision_id);
CREATE UNIQUE INDEX write_intent_path ON write_intents(workspace_id,path);
CREATE UNIQUE INDEX revision_file_identity ON document_revisions(workspace_id,file_path);
CREATE TRIGGER document_head_owner_insert BEFORE INSERT ON documents WHEN NEW.head_revision_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.head_revision_id AND r.workspace_id=NEW.workspace_id AND r.document_id=NEW.id) THEN RAISE(ABORT,'REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER document_head_owner_update BEFORE UPDATE OF head_revision_id ON documents WHEN NEW.head_revision_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.head_revision_id AND r.workspace_id=NEW.workspace_id AND r.document_id=NEW.id) THEN RAISE(ABORT,'REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER revision_parent_owner BEFORE INSERT ON document_revisions WHEN NEW.parent_revision_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.parent_revision_id AND r.workspace_id=NEW.workspace_id AND r.document_id=NEW.document_id) THEN RAISE(ABORT,'REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER agent_revision_committed_receipt BEFORE INSERT ON document_revisions WHEN NEW.origin='agent' BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM result_receipts r WHERE r.id=NEW.result_receipt_id AND r.workspace_id=NEW.workspace_id AND r.job_id=NEW.job_id AND r.attempt_id=NEW.attempt_id AND r.attempt_generation=NEW.attempt_generation AND r.state='committed') THEN RAISE(ABORT,'RECEIPT_NOT_COMMITTED') END;
END;
CREATE TRIGGER approval_core_owner BEFORE INSERT ON core_approvals BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM topics t JOIN document_revisions r ON r.document_id=t.core_document_id WHERE t.id=NEW.topic_id AND t.workspace_id=NEW.workspace_id AND r.workspace_id=NEW.workspace_id AND r.id=NEW.revision_id) THEN RAISE(ABORT,'CORE_REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER candidate_document_owner BEFORE INSERT ON candidates BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.revision_id AND r.workspace_id=NEW.workspace_id AND r.document_id=NEW.target_document_id) OR (NEW.base_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.base_revision_id AND r.workspace_id=NEW.workspace_id AND r.document_id=NEW.target_document_id)) THEN RAISE(ABORT,'REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER write_intent_parent_owner BEFORE INSERT ON write_intents WHEN NEW.expected_revision_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM document_revisions r WHERE r.id=NEW.expected_revision_id AND r.workspace_id=NEW.workspace_id AND r.document_id=NEW.document_id) THEN RAISE(ABORT,'REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER production_head_owner BEFORE UPDATE OF head_plan_revision_id ON production_plans WHEN NEW.head_plan_revision_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM production_plan_revisions r WHERE r.id=NEW.head_plan_revision_id AND r.workspace_id=NEW.workspace_id AND r.plan_id=NEW.id) THEN RAISE(ABORT,'PLAN_REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER content_head_owner BEFORE UPDATE OF head_content_revision_id ON content_plans WHEN NEW.head_content_revision_id IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM content_plan_revisions r WHERE r.id=NEW.head_content_revision_id AND r.workspace_id=NEW.workspace_id AND r.plan_id=NEW.id) THEN RAISE(ABORT,'PLAN_REVISION_OWNER_MISMATCH') END;
END;
CREATE TRIGGER shot_asset_media_range BEFORE INSERT ON shot_assets WHEN NEW.in_ms IS NOT NULL OR NEW.out_ms IS NOT NULL BEGIN
 SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM assets a WHERE a.id=NEW.asset_id AND a.workspace_id=NEW.workspace_id AND a.duration_ms IS NOT NULL AND (NEW.in_ms IS NULL OR NEW.in_ms<a.duration_ms) AND (NEW.out_ms IS NULL OR NEW.out_ms<=a.duration_ms)) THEN RAISE(ABORT,'MEDIA_RANGE_INVALID') END;
END;
CREATE TRIGGER attempt_terminal_no_reactivation BEFORE UPDATE OF state ON job_attempts WHEN OLD.state<>'active' AND NEW.state='active' BEGIN SELECT RAISE(ABORT,'ATTEMPT_TERMINAL'); END;
CREATE TRIGGER receipt_terminal_no_reactivation BEFORE UPDATE OF state ON result_receipts WHEN OLD.state IN ('committed','quarantined') AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'RECEIPT_TERMINAL'); END;
CREATE TRIGGER intent_terminal_no_reactivation BEFORE UPDATE OF state ON write_intents WHEN OLD.state IN ('committed','conflict','quarantined') AND NEW.state<>OLD.state BEGIN SELECT RAISE(ABORT,'WRITE_INTENT_TERMINAL'); END;
CREATE TRIGGER binding_terminal_no_reactivation BEFORE UPDATE OF state ON native_task_bindings WHEN OLD.state='closed' AND NEW.state='active' BEGIN SELECT RAISE(ABORT,'BINDING_TERMINAL'); END;
CREATE TRIGGER binding_fixed_identity BEFORE UPDATE ON native_task_bindings WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.observer_id IS NOT OLD.observer_id OR NEW.observer_epoch IS NOT OLD.observer_epoch OR NEW.host_connection_id IS NOT OLD.host_connection_id OR NEW.scope IS NOT OLD.scope OR NEW.native_namespace IS NOT OLD.native_namespace OR NEW.native_session_id IS NOT OLD.native_session_id OR NEW.native_turn_id IS NOT OLD.native_turn_id OR NEW.native_task_id IS NOT OLD.native_task_id BEGIN SELECT RAISE(ABORT,'FIXED_NATIVE_IDENTITY'); END;
CREATE TRIGGER job_fixed_input BEFORE UPDATE ON jobs WHEN NEW.workspace_id IS NOT OLD.workspace_id OR NEW.kind IS NOT OLD.kind OR NEW.target_id IS NOT OLD.target_id OR NEW.execution_mode IS NOT OLD.execution_mode OR NEW.input_manifest IS NOT OLD.input_manifest OR NEW.input_hash IS NOT OLD.input_hash BEGIN SELECT RAISE(ABORT,'FIXED_JOB_INPUT'); END;
