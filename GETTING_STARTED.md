# Personal IP Workbench

面向个人创作者的本地工作台，提供选题、核心稿、多平台版本、配图、排期和复盘界面。前端使用 React，本地服务使用 Node.js 和 SQLite；MCP 插件连接同一套本地服务。

## 安装

使用 Node.js **26.9.0** 与 pnpm **10.32.1**，在仓库根目录运行：

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

安装检查当前项目目录，不要求特定机器或磁盘名称。目录必须实际存在且可读写；路径不能经过符号链接。macOS 外置卷未挂载时会拒绝启动，不会自动改存到另一位置。继续使用项目的 pnpm workspace 与锁文件。

## 先看界面：不接本地服务的演示

```sh
pnpm dev:web
```

打开 [前端演示](http://127.0.0.1:5173/?mode=demo)。默认模式使用合成演示数据，编辑记录保存在当前浏览器；不会因为点击页面就自动接入模型、采集或发布服务。停止时在终端按 `Ctrl+C`。

## 创建独立、持久化的本地工作区

在仓库根目录创建一套新配置，再构建前端：

```sh
pnpm init:workspace --mode real --dir ./runtime/local --port 4318
pnpm build:web
```

`--dir` 可换成你选定的新目录，`--port` 是本地 API 端口。初始化会生成新的工作区身份、独立的 `config.json`，并拒绝覆盖已有配置。服务首次启动后，SQLite、托管笔记和媒体分别保存在该目录下的 `state/`、`notes/`、`media/`，默认不连接源资料库。

**初始化默认 `--mode demo`；上面的持久化日用步骤显式选择 `real`。** 这里的 real 表示前端连接本地服务，不表示外部 provider 已连接。若已有 demo 配置曾启动并写入数据库，请另建一个 real 目录；不要只改旧数据库对应配置的 `mode` 或工作区 ID。

在同一仓库根目录运行本地页面和 API：

```sh
WORKBENCH_CONFIG_PATH="$(pwd -P)/runtime/local/config.json" \
WORKBENCH_WEB_ROOT="$(pwd -P)/apps/web/dist" \
WORKBENCH_WEB_PORT=5180 \
node scripts/runtime/local-server.ts
```

打开 [本地工作台](http://127.0.0.1:5180/)。此入口自动让页面连接上面配置的 API；仅监听 `127.0.0.1`。页面端口由 `WORKBENCH_WEB_PORT` 指定，API 端口来自配置中的 `listen.port`。自选目录时，请将 `WORKBENCH_CONFIG_PATH` 改为初始化生成文件的**绝对路径**。

可在另一个终端检查：

```sh
curl --fail http://127.0.0.1:5180/health
curl --fail http://127.0.0.1:5180/api/v1/identity
```

`health` 的 `status: ready` 表示本地服务就绪；外部模型与平台能力仍需在设置中分别配置、核对。停止时按 `Ctrl+C`，再次运行同一启动命令即可使用原来的本地数据。端口被占用时选择另一个端口，不要停止不属于此工作区的服务。

### 开发时分别运行 API 和前端

保留上面的 real 配置，在两个终端分别运行：

```sh
# 终端 A，仓库根目录
WORKBENCH_CONFIG_PATH="$(pwd -P)/runtime/local/config.json" pnpm dev:service
```

```sh
# 终端 B，仓库根目录
pnpm dev:web
```

打开 [连接 API 的开发页面](http://127.0.0.1:5173/?mode=real)。Vite 开发代理默认将 `/api` 与 `/health` 转发至 `127.0.0.1:4318`，因此这一方式要求 API 使用 4318；如要自选 API 端口，优先使用前面的 `local-server.ts` 入口。API 服务本身不提供前端静态页面。

## 检查与构建

```sh
pnpm check:source
pnpm typecheck
pnpm typecheck:ci
pnpm test:portable
pnpm build:web
```

`pnpm test` 也指向可移植测试。需要浏览器测试时先安装 Playwright Chromium：

```sh
pnpm exec playwright install chromium
pnpm test:e2e:portable
```

Linux 环境还需要 Playwright 对应的系统库，按其安装输出处理。`pnpm ci:check` 运行源码、类型和内部规则检查；`pnpm verify:local` 进一步包含本地集成、插件构建和浏览器检查。它们会生成本地验证记录，不代表真实模型、平台发布或宿主客户端已经验收。

本轮已在 macOS 上验证全新隔离配置的初始化、本地服务健康接口、前端连接与基础页面读取。Linux CI、完整跨平台安装、真实 provider 和完整产品独立 QA 不在这项启动验证的结论内。

## 可选连接与媒体能力

- Codex / Claude 执行器需要用户自己安装并配置对应 CLI 或宿主。API 补充路线需要单独配置凭据与预算；新配置默认关闭 API fallback。
- 资讯源、TikHub 和各平台发布能力需要各自的地址、账号与权限；基础本地启动不要求这些凭据。未配置时保留未连接状态，不会把示例账号当作真实发布目标。
- 生图、语音与数字人使用各自的可选 provider / 本地工具；部分音视频处理还需要 `ffmpeg` / `ffprobe`。这些工具、模型和订阅不随源码或 pnpm 依赖安装，界面存在不等于该能力已可用。
- MCP 插件先运行 `pnpm build:plugins`，再按生成包与所用宿主的配置要求接入。`pnpm dev:mcp` 运行生成的共享 MCP server；插件包生成不等于所有宿主均已验证兼容。

## 本地数据与许可证

配置、数据库、凭据、浏览器状态、私有文章和原始运行响应留在自己的工作目录，不提交到源码。提交前可使用本机安装的 Gitleaks 检查：

```sh
gitleaks dir . --config .gitleaks.toml --redact=100
gitleaks git . --config .gitleaks.toml --redact=100 --log-opts='--all'
```

自有代码采用 [MIT](LICENSE)。依赖和 Codex 协议 schema 保留各自许可，详见 [第三方说明](THIRD_PARTY_NOTICES.md)。
