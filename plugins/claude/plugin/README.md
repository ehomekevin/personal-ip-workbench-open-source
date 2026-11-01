# 个人 IP 工作台 · Cowork / Claude Code 私有插件

This private plugin shares one workbench, one application service and one data store across supported entry points. Its local MCP server runs only as a client of the service. It does not start a model worker or copy business data. Claude Desktop chat needs the separate MCPB extension; successfully loading this plugin in Claude Code does not verify Cowork visuals or native tracking.

共享包使用 `.claude-plugin/plugin.json` 与根目录 `.mcp.json`。本地 MCP 只针对本机 Cowork / Claude Code；Desktop chat 忽略这类本地 MCP，需要独立 MCPB。云 Cowork 未验证可达性时保持 blocked，不能假定能读取 Mac 的 descriptor 或连接 Mac 回环地址。

配置：外部连接流程建立 descriptor，默认文件是用户主目录下 `.config/personal-ip-workbench/connections/claude-plugin.json`；descriptor 的 `host.surface` 必须明确为 `claude_cowork` 或 `claude_code`。两个入口分别配置时，用 `WORKBENCH_CONNECTION_PATH` 指向各自文件。凭据仅在服务 HTTP 头使用，不返回给模型。

Claude Code 试装：在仓库根执行 `WORKBENCH_CONNECTION_PATH=/your/private/connection.json claude --plugin-dir /your/staged/plugin`，在新会话 `/mcp` 中核对服务器连接。该命令不会安装到全局或启动另一模型工作流。正式安装可使用本人私有 marketplace，保持插件名不变；禁用/升级/移除使用 Claude Code 正常 plugin 命令。需保留插件缓存时使用官方 `plugin uninstall --keep-data`，业务数据始终在主服务目录之外。

Cowork 试装：在 Customize > Plugins > Add > Upload plugin 选择本包 ZIP，核对本机执行环境、连接文件可读和 loopback 可达，再开始新的 Cowork 任务。不要把 Code 成功外推为 Cowork 成功。上传和权限/信任步骤需具体包审查后的宿主确认；本包不会自行安装、启动任务或改变默认工具权限。

升级/禁用/移除/重装只操作宿主插件；主服务数据与 descriptor 均在安装目录之外。更新后重新调用 `get_context` 核对 service/workspace/contract。wrong-service 拒绝、保存冲突、资源渲染、媒体、原生候选与 observer 各自验收；没有真实 tracking 时 `begin_host_run` 正确拒绝，不走自动付费 fallback。
