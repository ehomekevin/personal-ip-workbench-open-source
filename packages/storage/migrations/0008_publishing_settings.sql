-- D07-010：唯一主存中的发布设置；历史修订、检查与发送范围不可变。
CREATE TABLE publishing_settings (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1),
 legacy_import_sha256 TEXT CHECK(legacy_import_sha256 IS NULL OR length(legacy_import_sha256)=64),
 imported_at TEXT, diagnostic_claims TEXT CHECK(diagnostic_claims IS NULL OR json_valid(diagnostic_claims))
) STRICT;
CREATE TABLE publishing_connections (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspaces(id), account_id TEXT NOT NULL,
 platform TEXT NOT NULL CHECK(platform IN ('x','wechat','douyin')),
 route TEXT NOT NULL CHECK((platform='x' AND route='x_v2') OR (platform='wechat' AND route='wechat_official') OR (platform='douyin' AND route='douyin_open')),
 version INTEGER NOT NULL DEFAULT 1 CHECK(version>=1), config_revision INTEGER NOT NULL DEFAULT 1 CHECK(config_revision>=1),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), active_config_revision INTEGER,
 runtime_state TEXT NOT NULL DEFAULT 'not_applied' CHECK(runtime_state IN ('not_applied','active','pending','apply_failed')),
 adapter_version TEXT, host_id TEXT, applied_at TEXT,
 error_code TEXT CHECK(error_code IS NULL OR error_code IN ('AUTH_REQUIRED','CAPABILITY_UNSUPPORTED','CAPABILITY_UNVERIFIED','STORAGE_UNAVAILABLE')),
 apply_generation INTEGER NOT NULL DEFAULT 0, next_check_sequence INTEGER NOT NULL DEFAULT 0, current_check_sequence INTEGER,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
 UNIQUE(workspace_id,id), UNIQUE(workspace_id,account_id,platform,route),
 FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id),
 FOREIGN KEY(workspace_id,id,config_revision) REFERENCES publishing_connection_revisions(workspace_id,connection_id,revision) DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(workspace_id,id,active_config_revision) REFERENCES publishing_connection_revisions(workspace_id,connection_id,revision) DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE TABLE publishing_connection_revisions (
 workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision>=1),
 credential_name TEXT CHECK(credential_name IS NULL OR (length(credential_name) BETWEEN 1 AND 128 AND credential_name NOT GLOB '*[^A-Z0-9_]*' AND substr(credential_name,1,1) GLOB '[A-Z]')),
 route TEXT NOT NULL, platform_account_id TEXT NOT NULL CHECK(length(trim(platform_account_id))>0), created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,connection_id,revision),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES publishing_connections(workspace_id,id)
) STRICT;
CREATE TABLE publishing_defaults (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), platform TEXT NOT NULL, format TEXT NOT NULL, account_id TEXT NOT NULL, connection_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,platform,format),
 CHECK((platform='x' AND format IN ('text','thread')) OR (platform='wechat' AND format='article') OR (platform='douyin' AND format='short_video')),
 FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id),
 FOREIGN KEY(workspace_id,connection_id) REFERENCES publishing_connections(workspace_id,id)
) STRICT;
CREATE TABLE publishing_connection_checks (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, connection_id TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>=1), config_revision INTEGER NOT NULL,
 connection_version INTEGER NOT NULL, checked_at TEXT NOT NULL, result TEXT NOT NULL CHECK(json_valid(result)), applied_to_current INTEGER NOT NULL CHECK(applied_to_current IN (0,1)),
 UNIQUE(workspace_id,connection_id,sequence),
 FOREIGN KEY(workspace_id,connection_id,config_revision) REFERENCES publishing_connection_revisions(workspace_id,connection_id,revision)
) STRICT;
CREATE TABLE publishing_capability_evidence (
 id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, account_id TEXT NOT NULL, platform TEXT NOT NULL, format TEXT NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('prepareDraft','submit','queryResult')), host_id TEXT NOT NULL, adapter_version TEXT NOT NULL,
 evidence_kind TEXT NOT NULL CHECK(evidence_kind='real_platform'), evidence_ref TEXT NOT NULL CHECK(length(trim(evidence_ref))>0), evidence_sha256 TEXT NOT NULL CHECK(length(evidence_sha256)=64),
 verified_at TEXT NOT NULL, limitations TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(limitations)),
 UNIQUE(workspace_id,id), FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id)
) STRICT;
CREATE TABLE publication_binding_scopes (
 workspace_id TEXT NOT NULL, intent_id TEXT NOT NULL, connection_id TEXT NOT NULL, config_revision INTEGER NOT NULL,
 account_id TEXT NOT NULL, platform TEXT NOT NULL, format TEXT NOT NULL, platform_account_id TEXT NOT NULL,
 adapter_version TEXT NOT NULL, host_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,intent_id),
 FOREIGN KEY(workspace_id,intent_id) REFERENCES publication_intents(workspace_id,id),
 FOREIGN KEY(workspace_id,account_id) REFERENCES accounts(workspace_id,id),
 FOREIGN KEY(workspace_id,connection_id,config_revision) REFERENCES publishing_connection_revisions(workspace_id,connection_id,revision)
) STRICT;
ALTER TABLE publication_attempts ADD COLUMN publishing_connection_id TEXT;
ALTER TABLE publication_attempts ADD COLUMN publishing_config_revision INTEGER;
ALTER TABLE publication_attempts ADD COLUMN publishing_adapter_version TEXT;
ALTER TABLE publication_attempts ADD COLUMN publishing_host_id TEXT;
CREATE TRIGGER publishing_revisions_immutable_update BEFORE UPDATE ON publishing_connection_revisions BEGIN SELECT RAISE(ABORT,'immutable publishing revision'); END;
CREATE TRIGGER publishing_revisions_immutable_delete BEFORE DELETE ON publishing_connection_revisions BEGIN SELECT RAISE(ABORT,'immutable publishing revision'); END;
CREATE TRIGGER publishing_checks_immutable_update BEFORE UPDATE ON publishing_connection_checks BEGIN SELECT RAISE(ABORT,'immutable publishing check'); END;
CREATE TRIGGER publishing_checks_immutable_delete BEFORE DELETE ON publishing_connection_checks BEGIN SELECT RAISE(ABORT,'immutable publishing check'); END;
CREATE TRIGGER publishing_scopes_immutable_update BEFORE UPDATE ON publication_binding_scopes BEGIN SELECT RAISE(ABORT,'immutable publication binding'); END;
CREATE TRIGGER publishing_scopes_immutable_delete BEFORE DELETE ON publication_binding_scopes BEGIN SELECT RAISE(ABORT,'immutable publication binding'); END;
CREATE TRIGGER publishing_evidence_immutable_update BEFORE UPDATE ON publishing_capability_evidence BEGIN SELECT RAISE(ABORT,'immutable publishing evidence'); END;
CREATE TRIGGER publishing_evidence_immutable_delete BEFORE DELETE ON publishing_capability_evidence BEGIN SELECT RAISE(ABORT,'immutable publishing evidence'); END;
CREATE TRIGGER publishing_revision_scope BEFORE INSERT ON publishing_connection_revisions WHEN NOT EXISTS (
 SELECT 1 FROM publishing_connections c WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.connection_id AND c.route=NEW.route
) BEGIN SELECT RAISE(ABORT,'publishing revision scope mismatch'); END;
CREATE TRIGGER publishing_default_scope_insert BEFORE INSERT ON publishing_defaults WHEN NOT EXISTS (
 SELECT 1 FROM publishing_connections c JOIN accounts a ON a.workspace_id=c.workspace_id AND a.id=c.account_id
 WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.connection_id AND c.account_id=NEW.account_id AND c.platform=NEW.platform
 AND a.platform=NEW.platform AND a.role='owner' AND a.identity_status='confirmed' AND length(trim(a.platform_account_id))>0
) BEGIN SELECT RAISE(ABORT,'publishing default scope mismatch'); END;
CREATE TRIGGER publishing_default_scope_update BEFORE UPDATE ON publishing_defaults WHEN NOT EXISTS (
 SELECT 1 FROM publishing_connections c JOIN accounts a ON a.workspace_id=c.workspace_id AND a.id=c.account_id
 WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.connection_id AND c.account_id=NEW.account_id AND c.platform=NEW.platform
 AND a.platform=NEW.platform AND a.role='owner' AND a.identity_status='confirmed' AND length(trim(a.platform_account_id))>0
) BEGIN SELECT RAISE(ABORT,'publishing default scope mismatch'); END;
CREATE TRIGGER publishing_attempt_scope BEFORE UPDATE OF publishing_connection_id,publishing_config_revision,publishing_adapter_version,publishing_host_id ON publication_attempts WHEN
 (OLD.publishing_connection_id IS NOT NULL AND (NEW.publishing_connection_id IS NOT OLD.publishing_connection_id OR NEW.publishing_config_revision IS NOT OLD.publishing_config_revision OR NEW.publishing_adapter_version IS NOT OLD.publishing_adapter_version OR NEW.publishing_host_id IS NOT OLD.publishing_host_id))
 OR NOT EXISTS (SELECT 1 FROM publication_binding_scopes b WHERE b.workspace_id=NEW.workspace_id AND b.intent_id=NEW.intent_id AND b.connection_id=NEW.publishing_connection_id AND b.config_revision=NEW.publishing_config_revision AND b.adapter_version=NEW.publishing_adapter_version AND b.host_id=NEW.publishing_host_id)
 BEGIN SELECT RAISE(ABORT,'publication attempt binding mismatch'); END;
CREATE TRIGGER publishing_frozen_scope BEFORE INSERT ON publication_binding_scopes WHEN NOT EXISTS (
 SELECT 1 FROM publishing_connections c JOIN publishing_connection_revisions r ON r.workspace_id=c.workspace_id AND r.connection_id=c.id AND r.revision=NEW.config_revision
 JOIN publication_intents p ON p.workspace_id=c.workspace_id AND p.id=NEW.intent_id
 JOIN variants v ON v.workspace_id=p.workspace_id AND v.id=p.variant_id
 WHERE c.workspace_id=NEW.workspace_id AND c.id=NEW.connection_id AND c.account_id=NEW.account_id AND c.platform=NEW.platform
 AND p.account_id=NEW.account_id AND v.platform=NEW.platform AND v.format=NEW.format AND r.platform_account_id=NEW.platform_account_id
 AND c.active_config_revision=NEW.config_revision AND c.adapter_version=NEW.adapter_version AND c.host_id=NEW.host_id
) BEGIN SELECT RAISE(ABORT,'publication frozen scope mismatch'); END;
CREATE TRIGGER publishing_attempt_scope_insert BEFORE INSERT ON publication_attempts WHEN NEW.publishing_connection_id IS NOT NULL AND NOT EXISTS (
 SELECT 1 FROM publication_binding_scopes b WHERE b.workspace_id=NEW.workspace_id AND b.intent_id=NEW.intent_id AND b.connection_id=NEW.publishing_connection_id AND b.config_revision=NEW.publishing_config_revision AND b.adapter_version=NEW.publishing_adapter_version AND b.host_id=NEW.publishing_host_id
) BEGIN SELECT RAISE(ABORT,'publication attempt binding mismatch'); END;
