-- 技能库与路由采用整体 CAS；历史配置与任务中的技能快照保持不可变。
CREATE TABLE skill_settings (
 workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
 version INTEGER NOT NULL CHECK(version>=1), catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json)), updated_at TEXT NOT NULL
) STRICT;
CREATE TABLE skill_settings_revisions (
 workspace_id TEXT NOT NULL REFERENCES workspaces(id), version INTEGER NOT NULL CHECK(version>=1),
 catalog_json TEXT NOT NULL CHECK(json_valid(catalog_json)), sha256 TEXT NOT NULL CHECK(length(sha256)=64), created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,version)
) STRICT;
CREATE TRIGGER skill_revisions_immutable_update BEFORE UPDATE ON skill_settings_revisions BEGIN SELECT RAISE(ABORT,'immutable skill settings revision'); END;
CREATE TRIGGER skill_revisions_immutable_delete BEFORE DELETE ON skill_settings_revisions BEGIN SELECT RAISE(ABORT,'immutable skill settings revision'); END;
