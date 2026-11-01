---
name: workbench-context
description: 读取当前工作台真实资料、主题、版本、作品、指标和固定引用。
---

先用 `get_context` 核对工作区身份与选中输入，只查询用户选中的主题、文稿、任务或 source_ids。
使用已登记的 list_*、get_*、search 工具；固定文稿可使用 get_revision，来源正文使用 get_source_record。保留实际游标、revision、来源与缺失状态，未知数值保持 null。
采集使用 start_source_sync，统计使用 collect_metrics，比较使用 create_comparison；保存 job_id / run_id 后读取任务与结果。创建任务不等于采集成功，模型估算不能充当真实快照或 7d 观察。
原始 Vault 不自动作为整份模型输入。没有任意 URL 代理、SQL 或文件路径读取工具。
