# Personal IP Workbench

面向个人创作者的本地工作台，提供选题、核心稿、多平台版本、配图、排期和复盘界面。前端使用 React，本地服务使用 Node.js 和 SQLite；MCP 插件连接同一套本地服务。

## Windows x64 便携版

从[项目 Releases](https://github.com/ehomekevin/personal-ip-workbench-open-source/releases)下载 `personal-ip-workbench-0.1.0-windows-x64.zip` 和 `SHA256SUMS`。在下载目录打开 PowerShell，核对 ZIP 的 SHA-256 与清单中同名文件的一行一致。

```powershell
Get-FileHash -Algorithm SHA256 .\personal-ip-workbench-0.1.0-windows-x64.zip
Get-Content .\SHA256SUMS | Select-String 'windows-x64.zip'
```

将 ZIP **全部解压**到新的程序目录，双击 `Start.cmd`。它使用随包提供的 Node.js x64 和已构建的网页、服务，在本机启动工作台。默认网页地址为 `http://127.0.0.1:5180/`。保留启动窗口，退出时运行同一程序目录的 `Stop.cmd`。如果端口占用，先查看启动窗口的提示。可以在 PowerShell 中设置 `$env:WORKBENCH_WEB_PORT='5280'` 后运行 `.\Start.cmd`。首次创建工作区时可用 `$env:WORKBENCH_API_PORT='4328'` 选择 API 端口，已有工作区使用其 `config.json` 中的 `listen.port`。

工作区默认在 `%LOCALAPPDATA%\PersonalIPWorkbench`，程序与用户数据分别存放。停服后备份整个工作区，包含配置、SQLite 数据库及其侧文件、笔记和素材。若另行配置了外部资料或媒体路径，另行备份那些目录。可使用环境变量 `WORKBENCH_DATA_DIR` 指定独立的绝对目录，之后启动和停止均使用同一设置。

升级时先停旧版并备份数据，把新 ZIP 解压到另一个程序目录，再双击新版 `Start.cmd`，继续使用原工作区。需要回退时关闭新版，另存升级后工作区，在原数据路径恢复升级前备份，再从保留的旧程序目录启动。切换程序目录时不要删除工作区。基础编辑和保存可在空配置下使用，模型和发布账号在设置中按需连接。

## 安装稳定版源码包

准备 Node.js **26.9.0**、pnpm **10.32.1** 和可用的网络。源码包包含工作台、插件源文件、依赖锁文件和许可证；首次安装时 pnpm 下载依赖，模型、账号和第三方凭据由使用者自行配置。以下命令适用于 macOS 或 Linux 的终端。

在[项目 Releases](https://github.com/ehomekevin/personal-ip-workbench-open-source/releases) 选择稳定版本，在 Assets 中下载发行方提供的 `personal-ip-workbench-0.1.0.tar.gz` 与 `SHA256SUMS` 到同一个空目录。在该目录打开终端，先确认两个工具的版本，再校验下载。macOS 使用 `shasum`，Linux 可使用 `sha256sum`。

```sh
node --version
pnpm --version
grep '  personal-ip-workbench-0.1.0.tar.gz$' SHA256SUMS | shasum -a 256 -c -
# Linux 可将 shasum -a 256 -c - 换成 sha256sum -c -
```

校验输出须包含 `personal-ip-workbench-0.1.0.tar.gz: OK`。将不同版本的程序分别解压，工作区另存到版本目录外。以下命令在刚才的下载目录执行：

```sh
workbench_dir="$HOME/personal-ip-workbench"
mkdir -p "$workbench_dir/versions" &&
  test ! -e "$workbench_dir/versions/personal-ip-workbench-0.1.0" &&
  tar -xzf personal-ip-workbench-0.1.0.tar.gz -C "$workbench_dir/versions" &&
  cd "$workbench_dir/versions/personal-ip-workbench-0.1.0" &&
  pnpm install --frozen-lockfile
```

安装目录须可读写，路径不能经过符号链接。macOS 使用外置卷时请先挂载。若从仓库克隆源码，直接在源码根目录使用相同版本的工具执行安装命令。下文的网页和服务启动命令都在选定版本的源码根目录执行。

## 先看界面：不接本地服务的演示

```sh
pnpm dev:web
```

打开 [前端演示](http://127.0.0.1:5173/?mode=demo)。默认模式使用合成演示数据，编辑记录保存在当前浏览器；不会因为点击页面就自动接入模型、采集或发布服务。停止时在终端按 `Ctrl+C`。

## 创建独立、持久化的本地工作区

首次启动时固定工作区的位置。下例使用网页端口 5280、API 端口 4328，可换成其他空闲端口。

```sh
workbench_dir="$HOME/personal-ip-workbench"
pnpm init:workspace --mode real --dir "$workbench_dir/workspace" --port 4328
pnpm build:web
```

`--dir` 可换成你选定的新目录，`--port` 是本地 API 端口。初始化会生成新的工作区身份、独立的 `config.json`，并拒绝覆盖已有配置。服务首次启动后，SQLite、托管笔记和媒体分别保存在该目录下的 `state/`、`notes/`、`media/`，默认不连接源资料库。

**初始化默认 `--mode demo`；上面的持久化日用步骤显式选择 `real`。** 这里的 real 表示前端连接本地服务，不表示外部 provider 已连接。若已有 demo 配置曾启动并写入数据库，请另建一个 real 目录；不要只改旧数据库对应配置的 `mode` 或工作区 ID。

在同一仓库根目录运行本地页面和 API：

```sh
WORKBENCH_CONFIG_PATH="$HOME/personal-ip-workbench/workspace/config.json" \
WORKBENCH_WEB_ROOT="$(pwd -P)/apps/web/dist" \
WORKBENCH_WEB_PORT=5280 \
node scripts/runtime/local-server.ts
```

打开 [本地工作台](http://127.0.0.1:5280/)。此入口自动让页面连接上面配置的 API；仅监听 `127.0.0.1`。页面端口由 `WORKBENCH_WEB_PORT` 指定，API 端口来自配置中的 `listen.port`。自选目录时，请将 `WORKBENCH_CONFIG_PATH` 改为初始化生成文件的**绝对路径**。

可以先打开“设置与连接”，修改“每日人工时间 / 分钟”并点击“保存工作方式”，刷新页面确认保存的值仍在。可在另一个终端检查服务和工作区身份：

```sh
curl --fail http://127.0.0.1:5280/health
curl --fail http://127.0.0.1:5280/api/v1/identity
```

`health` 的 `status: ready` 表示本地服务就绪；外部模型与平台能力仍需在设置中分别配置、核对。停止时按 `Ctrl+C`，再次运行同一启动命令即可使用原来的本地数据。端口被占用时选择另一个端口，不要停止不属于此工作区的服务。

### 开发时分别运行 API 和前端

若希望分别运行开发前端和 API，请将 real 工作区停服，并将其 `config.json` 中 `listen.port` 设为默认开发代理使用的 4318，或使用另一套监听 4318 的独立工作区。在两个终端分别运行：

```sh
# 终端 A，仓库根目录
WORKBENCH_CONFIG_PATH="$HOME/personal-ip-workbench/workspace/config.json" pnpm dev:service
```

```sh
# 终端 B，仓库根目录
pnpm dev:web
```

打开 [连接 API 的开发页面](http://127.0.0.1:5173/?mode=real)。Vite 开发代理默认将 `/api` 与 `/health` 转发至 `127.0.0.1:4318`，因此这一方式要求 API 使用 4318；如要自选 API 端口，优先使用前面的 `local-server.ts` 入口。API 服务本身不提供前端静态页面。

## 手动升级与回退

网页工作台将构建时根 `package.json` 的版本与本项目[最新稳定 Release](https://github.com/ehomekevin/personal-ip-workbench-open-source/releases/latest) 比较。有新版本时可从提醒打开对应的发布说明。关闭提醒后可继续创作，下载和安装由你操作。成功响应或尚无稳定版时，浏览器将结果缓存 24 小时。连接超时或遇到限流时，最少隔 1 小时再查。关闭某个版本的提醒后，同一浏览器会记住这个选择。清除该站点的浏览器数据会重置这些记录。

1. 先阅读目标版本的升级说明，在其单独的下载目录按前文校验源码包。将新版解压到新的版本目录，在其中运行 `pnpm install --frozen-lockfile` 和 `pnpm build:web`，保留旧版本目录。
2. 保存当前工作，在启动旧服务的终端按 `Ctrl+C`，等待终端提示符返回。确认使用同一工作区的服务和插件任务均已停止，再复制整个工作区。这样会同时保留配置、数据库以及存在的 SQLite `-wal`、`-shm` 辅助文件、托管笔记和媒体。自定义配置指向工作区以外的资料库、媒体或凭据时，还应按其实际位置分别备份。demo 模式里的编辑保存在浏览器中，工作区备份仅覆盖磁盘文件。
3. 在新版程序目录使用原来的 `WORKBENCH_CONFIG_PATH` 和页面端口，照上文的 `node scripts/runtime/local-server.ts` 命令启动。保留原工作区身份，不重复运行 `init:workspace`。打开工作台确认设置、稿件和素材可读，再继续编辑。

默认目录的停服备份示例：

```sh
workbench_dir="$HOME/personal-ip-workbench"
backup_dir="$(mktemp -d "$workbench_dir/backup.XXXXXXXX")" &&
  cp -Rp "$workbench_dir/workspace" "$backup_dir/workspace" &&
  printf '升级前备份：%s\n' "$backup_dir"
```

需要回退时，先停止新版。恢复升级前备份会回到备份时点，先另存升级后产生的文件。下例沿用终端中刚才的 `backup_dir`；若重新打开终端，请先将它设为打印出的完整备份目录。将原工作区恢复到**原绝对路径**，再从旧程序目录按原命令启动，避免旧程序直接打开新版已升级的数据库。

```sh
workbench_dir="$HOME/personal-ip-workbench"
test -n "$backup_dir" && test -f "$backup_dir/workspace/config.json" &&
  saved_dir="$(mktemp -d "$workbench_dir/after-upgrade.XXXXXXXX")" &&
  mv "$workbench_dir/workspace" "$saved_dir/workspace" &&
  cp -Rp "$backup_dir/workspace" "$workbench_dir/workspace"
```

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
