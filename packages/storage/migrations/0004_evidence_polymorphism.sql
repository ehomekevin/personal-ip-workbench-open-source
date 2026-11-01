-- D07-004：证据定位是多态来源，不把修订/候选/作品冒充 sources。
-- 旧行先通过同一校验再复制；无法归属的历史行使整个迁移回滚。
CREATE TABLE evidence_links_v4 (
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
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TRIGGER evidence_source_insert BEFORE INSERT ON evidence_links_v4 BEGIN
  SELECT CASE WHEN NOT (
    (NEW.source_type='source' AND EXISTS(SELECT 1 FROM sources WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id)) OR
    (NEW.source_type='source_record' AND EXISTS(SELECT 1 FROM source_records WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id)) OR
    (NEW.source_type='document_revision' AND EXISTS(SELECT 1 FROM document_revisions WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id)) OR
    (NEW.source_type='candidate' AND EXISTS(SELECT 1 FROM candidates WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id)) OR
    (NEW.source_type IN ('work','identity_observation') AND EXISTS(SELECT 1 FROM works WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id)) OR
    (NEW.source_type='snapshot' AND EXISTS(SELECT 1 FROM snapshots WHERE workspace_id=NEW.workspace_id AND id=NEW.source_id))
  ) THEN RAISE(ABORT,'EVIDENCE_SOURCE_INVALID_OR_UNDECLARED') END;
  SELECT CASE WHEN NEW.owner_type='document_revision' AND NOT EXISTS(SELECT 1 FROM document_revisions WHERE workspace_id=NEW.workspace_id AND id=NEW.owner_id)
    THEN RAISE(ABORT,'EVIDENCE_OWNER_INVALID') END;
  SELECT CASE WHEN NEW.owner_type='work' AND NOT EXISTS(SELECT 1 FROM works WHERE workspace_id=NEW.workspace_id AND id=NEW.owner_id)
    THEN RAISE(ABORT,'EVIDENCE_OWNER_INVALID') END;
  SELECT CASE WHEN NEW.owner_type='document_revision' AND NEW.source_type='candidate' AND NOT EXISTS(
    SELECT 1 FROM document_revisions r JOIN candidates c ON c.workspace_id=r.workspace_id AND c.target_document_id=r.document_id
    WHERE r.workspace_id=NEW.workspace_id AND r.id=NEW.owner_id AND c.id=NEW.source_id
  ) THEN RAISE(ABORT,'EVIDENCE_CANDIDATE_WRONG_DOCUMENT') END;
END;
INSERT INTO evidence_links_v4 SELECT * FROM evidence_links;
DROP TABLE evidence_links;
ALTER TABLE evidence_links_v4 RENAME TO evidence_links;
-- 证据归属不可就地改写；更正追加新证据，保留原定位。
CREATE TRIGGER evidence_link_fixed BEFORE UPDATE ON evidence_links BEGIN
  SELECT RAISE(ABORT,'IMMUTABLE_EVIDENCE_LINK');
END;
