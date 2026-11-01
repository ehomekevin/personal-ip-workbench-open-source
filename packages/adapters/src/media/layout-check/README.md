# 公众号 AI 排版检查叶子 · WECHAT-LAYOUT-STUDIO-01/r1

本叶子读取已冻结的文章渲染 PNG 分片、实际 DOM 块/样式/坐标、原公众号标准 PNG 和 HTML。只有图像输入路线可以运行；DOM、提示词中写着“看图”、本机规则或 fixture 结果均不算真实视觉检查。本阶段实际 native 进程、模型提交、生图调用均为 0。

已只读核实 PATH 的 `codex-cli 0.161.0`、`2.1.283 (Claude Code)`；固定 `TurnStartParams` 声明 `localImage`，`ModelListResponse` 声明模型 `inputModalities`。现有普通 Codex 适配器只发送 text/skill；Claude 只发送 `-p` 文本且 tools 为空。新叶子直接使用 `CodexNative` 默认受限配置的 `localImage` 输入，不启用 image generation、view_image、shell 或 MCP，也不需要改原 `native.ts`。真正订阅身份、quota、Sol image modality 与 xhigh 在未来授权执行前由已有协议检查；本次未启动原生探针。

`LayoutVisualInput` 与 `layoutRenderSnapshotHash` / `layoutBlockStructureHash` 在 index.ts 导出。`render_pngs` 必须从 `offset_y=0` 连续覆盖所有块的自然高度；渲染 hash 排除文件路径并保留有序 SHA/尺寸/位置/块 IDs。PNG 必须有完整 CRC/像素流、正确尺寸和冻结文件 hash。标准 PNG/HTML hash 固定为原版来源。`blocks` 包含稳定 id、kind、实际 computed_style、文章内 bounds；文本和图像身份属于输入数据，不是指令。

`CodexLayoutCheckAdapter` 要求 durable `LayoutCheckJournal` 的 atomic `reserve` / `load` / `save`。reserve 拒绝已有 job 或 attempt；intent、原输入、hash、候选、原生 IDs、submit_count 与 proof 在提交前后持久保存。生产必须提供固定候选 `LayoutCheckPermit` 和至多两个授权 job IDs，并由 `reserve_submission` 持久预留预算。fixture 必须显式提供 `fixture:true` 和模拟 client；生产拒绝模拟 client。

每次 execute 只提交一个 `turn/start`，图像序列为全部文章分片加原标准 PNG。完成后必须 `thread/read`，验证唯一原 `userMessage` 的完整文本/图像输入与原 `thread/turn`，再解析只含排版 issue 的 schema。copyReview、rewrite、文案分数或其他额外字段不被接受。输出含块/位置/问题/标准出处/样式建议/不确定项，没有任何编辑文字、改图或应用样式的方法。调用者通过 domain 的 current-binding fence 将旧结果留在历史，不更新当前稿。

超时、断线、原始图像输入不符、schema 错误或未知结果保持 `unknown` 和已知 IDs；同 job/attempt 不能 execute 第二次。显式 query 只读原 turn，不 `thread/start`、resume 或重发。真实原生 token usage 可记录；未知 usage 和逐请求费用保留 null，不估算账单。完整 cached 结果也核验原输入/输出 hash 与 fixture/native 来源。

串行集成需要根执行者明确接线：adapter 包出口、bootstrap/job/routing 的当前 owner、正式渲染快照生产者、持久 journal/预算 port 和 domain 结果消费者。当前没有改这些共享文件。真实正常版/偏差版、正式服务运行、完整 UI、Obsidian/Wiki 与公众号后台均未由本叶子证明。

## leaf-qa-repair-03 · AL-QA-P2-03 / P2-04

`assertLayoutCheckExecutionProof` 校验完整 persisted execution。它从冻结 manifest 构造同一原 `text + localImage` 输入，核 PNG/标准/块与图像顺序/hash、native 输入 SHA、source/provider、固定 binding 和完成输出 SHA。journal 的 reserve/save/load、adapter cached query 与 server-only `storage/article-layout/proof.ts` 共用该边界。缩减的 `{attempt,fixture,proof:{original_input_verified:true}}` 和伪路径旧 fixture 不满足这个契约；测试须保留实际 PNG/标准文件和完整 execution，不能将真假来源改成 trusted 布尔值。

`turn/started` 首次 journal 保存直接在事件回调调用；异步后续保存串行排队，回执/结果保存前等待队列。SQLite 首次 save 在返回 Promise 前已提交。无法保证外部异步 journal 在直接进程退出前完成时，缺 turn ID 的 query 只读原已知 thread，要求唯一原完整输入才补回协议返回的 ID；空、错图、错文本、第二 userMessage、多个候选以及错 thread/provider/model 都不恢复，不 start/resume/retry。

固定 `ThreadReadResponse.json` 的 Thread.model 明确允许 null，且注明不是逐 turn 模型遥测。新运行持久保存已验证的 thread/start model/provider/thread/cwd 回执。读取 model 字符串须与固定 Sol 一致；null/缺失只能依对应原回执，不推断模型或增加 native 探针。`proof.thread_start` 对旧结构为可选，但不能用缺少它的记录推断未知 model。
