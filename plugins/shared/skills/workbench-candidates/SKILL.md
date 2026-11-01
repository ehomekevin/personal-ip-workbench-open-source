---
name: workbench-candidates
description: 依据固定输入保存原生对话候选或显式委托服务任务，并保留稿件并发校验。
---

读取当前文稿 revision 和所选来源后才能提交修改。人工编辑使用 save_document，origin 固定 human，传当前 expected_revision_id；REVISION_CONFLICT 时保留待提交文字并重新读取，不覆盖新 head。
原生对话仅使用 begin_host_run、submit_host_output、resume_host_run。begin 的 native_task_binding_id 必须由已安装受信观察程序提供；不能自造 observer、任务身份、观察或续期。tracking 未验证或 observer 未就绪时，报告服务原始错误并停止原生路径，不改成额外模型调用。
submit 保留服务分配的 attempt_id、attempt_generation、input_hash 和 expected_version；返回 receipt 后读取 get_host_receipt。只有 committed 结果才是可采用候选；pending / quarantined 不表示成功，不把过期输出挂到新 attempt。
用户明确选择 service_adapter 才调用独立 service_* 工具；恢复该路线用 resume_service_job，不与 host_session 同时执行。用量未知为 null。
采用候选使用 adopt_candidate 并传当前 expected_revision_id；取消用 cancel_job 保留 expected_version。工作台取消只证明撤销提交权，不推导宿主推理或计费已停止。
