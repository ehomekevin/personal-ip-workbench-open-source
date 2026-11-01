-- D07-008：新制作修订保存完整固定输入，旧准备修订保留未知。
ALTER TABLE content_plan_revisions ADD COLUMN input_manifest TEXT CHECK(input_manifest IS NULL OR json_valid(input_manifest));
ALTER TABLE production_plan_revisions ADD COLUMN input_manifest TEXT CHECK(input_manifest IS NULL OR json_valid(input_manifest));
