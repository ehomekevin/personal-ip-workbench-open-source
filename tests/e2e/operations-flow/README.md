运行：`node scripts/ci/operations-flow-e2e.ts`。

这个独立入口可用于本机或 CI。它只构建并启动当前 checkout 的假数据 Workbench，不启动主服务、不连接生产或 Provider；复用项目 pnpm、浏览器和原生缓存。端口默认 5197，可用 `FLOW_MOTION_E2E_PORT` 指定空闲端口。

测试覆盖 390/768/1275px 流程与吸附、占位保持、跨断点、键盘返回、弹窗与搜索、减少动态效果、候选与确认状态、长标题、主题切换、卸载与页面导航，以及真实 BFCache 返回。Chromium 使用正常浏览器的 headless 模式以支持 BFCache。

结果、坐标、截图和失败 trace 写到 `.ci-artifacts/flow-motion-e2e/`。这份验收只证明 UI 与生命周期；生成、采用候选、发布和真实评论读取由对应运营测试及主服务验收覆盖。
