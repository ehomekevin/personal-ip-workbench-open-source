# Codex 私有包装

根项目 `pnpm build:plugins` 产出 `.ci-artifacts/plugins/shared/server/server.mjs` 与 `ui/workbench.html`。本目录只封装宿主规则，不维护业务 UI 或数据。

```sh
node plugins/codex/scripts/package.mjs --out .ci-artifacts/plugins/codex
node plugins/codex/scripts/validate.mjs .ci-artifacts/plugins/codex
```

`--runtime-root` 可指定另一份共同 runtime；`--server` / `--ui` / `--skills` 可显式替换输入。输出必须是新目录，脚本不会清理用户已有文件。相同输入的 ZIP SHA256 相同；清单路径相对包根。包包含共享 Node24 JS bundle、共享内联 HTML、共享 Skills 和 portable manifests，无 descriptor、凭据、运营库、固定绝对用户路径或 hooks。

安装与生命周期说明在 [template/README.md](template/README.md)，marketplace 模板在 [marketplace.example.json](marketplace.example.json)。校验器使用固定 `ajv-cli@5.0.0` 和本目录留存的官方 Agent Plugins 1.0.0 schemas；npm 使用原生共享缓存，无 root dependency 变更。Python 标准库独立检查 ZIP CRC；这不是宿主安装证明。

宿主专属 API：`@workbench/host-bridge/codex` 导出 `createCodexHostBridge` 与 `CODEX_DESKTOP_HOST_PROFILE`。factory 绑定 `codex_desktop/local_stdio`，由共同 MCP Apps bridge 检查固定服务身份；不会把 UI 广告转成已验证能力。
