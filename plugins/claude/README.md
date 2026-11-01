# Claude 私有包装

本目录产出独立 Desktop chat MCPB 与 Cowork / Code 共享 ZIP，消费根项目构建的共同 Node24 JS bundle、内联七页面 UI 与 Skills。

```sh
pnpm build:plugins
node plugins/claude/scripts/package.mjs --out .ci-artifacts/plugins/claude
node plugins/claude/scripts/validate.mjs .ci-artifacts/plugins/claude
```

可用 `--runtime-root` 显式选择共同 runtime；输出必须是新目录。Desktop 设置中选择外部 descriptor 文件；common plugin 默认读取用户主目录下 `.config/personal-ip-workbench/connections/claude-plugin.json`，可由 `WORKBENCH_CONNECTION_PATH` 覆盖。连接文件与主服务数据均不进入包，脚本不会安装、启用、运行宿主任务或改默认审批。

Desktop 的 [安装与生命周期](desktop/README.md) 和 Cowork/Code 的 [分入口步骤](plugin/README.md) 独立。local plugin MCP 在 chat 被忽略；Cowork执行位置和网络可达必须实测。没有 remote connector/gateway，禁止将 Mac loopback 推定为云可达。

`@workbench/host-bridge/claude-desktop`、`/cowork`、`/claude-code` 分别导出 `createClaudeDesktopHostBridge`、`createCoworkHostBridge`、`createClaudeCodeHostBridge`，以及对应 `*_HOST_PROFILE`；每个 factory 都绑定自己的 surface/local_stdio。Code的完整可视容器不作目标，不能代替 chat/Cowork。

CLI验证器只做静态检查：本机 `claude plugin validate --strict --json`、固定 `@anthropic-ai/mcpb@2.1.2` manifest 校验和 Python ZIP CRC。实际安装、工具读写、渲染、原生 observer、候选 receipt 与数据保留分别查 WP25 三份台账；当前整体 blocked。
