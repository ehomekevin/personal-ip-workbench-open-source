-- D07-006：持久化完整输出集合，供正常提交和启动恢复核验同一语义 hash。
-- 历史收据无该字段时保留 NULL，不从旧 result_ids 或当前 attempt 猜测补填。
ALTER TABLE result_receipts ADD COLUMN output_payload TEXT
  CHECK (output_payload IS NULL OR json_valid(output_payload));
CREATE TRIGGER result_receipts_fixed_output_payload
BEFORE UPDATE OF output_payload ON result_receipts
WHEN NEW.output_payload IS NOT OLD.output_payload
BEGIN SELECT RAISE(ABORT,'FIXED_PROVENANCE'); END;
