-- D07-007：资料正文属于 source_records；原始来源状态独立保留。
ALTER TABLE source_records ADD COLUMN payload TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload));
ALTER TABLE source_locations ADD COLUMN availability TEXT NOT NULL DEFAULT 'available' CHECK(availability IN ('available','offline','parse_error'));
ALTER TABLE source_locations ADD COLUMN raw_response_ref TEXT CHECK(raw_response_ref IS NULL OR json_valid(raw_response_ref));
-- 唯一约束发现历史冲突时事务回滚；不删除原记录或推测身份。
CREATE UNIQUE INDEX sources_identity ON sources(workspace_id,kind,url);
CREATE UNIQUE INDEX source_records_external_identity ON source_records(workspace_id,source_id,external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX source_locations_capture_identity ON source_locations(workspace_id,record_id,kind,coalesce(relative_path,''),coalesce(source_url,''),sha256);
CREATE UNIQUE INDEX index_entries_path_identity ON index_entries(workspace_id,path);
