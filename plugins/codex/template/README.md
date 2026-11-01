# 个人 IP 工作台 · Codex 私有插件

This private plugin opens the shared Personal IP Workbench and forwards registered MCP tools to an already running application service. It contains no business database, connection credential, user document or model worker. Installation, native visual rendering, tool persistence and native task tracking are separate verification steps. The package alone does not certify host support.

连接文件由工作台的外部连接流程建立，存放在安装目录之外。默认读取用户主目录下 `.config/personal-ip-workbench/connections/codex_desktop.json`；需要其他位置时由宿主进程提供 `WORKBENCH_CONNECTION_PATH`。服务器核对 descriptor 的 `plugin_id`、service/workspace/contract 与 `host.surface`，不自动启动主服务或额外 Agent。

私有安装：将整个目录放入自己的 marketplace root 下 `plugins/personal-ip-workbench`；把附带的 marketplace 示例合并到 `.agents/plugins/marketplace.json`，保留原有条目。当前包仅供本机 Codex Desktop 使用。插件名保持 `personal-ip-workbench`，本地 marketplace 名为 `personal-ip-workbench-private`。完成包审查后，在宿主 Plugins 中安装；官方本地发现流程可能需要重启桌面应用，必须在当前会话可安全结束且用户允许后执行。

禁用：在对应项目 `.codex/config.toml` 中把 `[plugins."personal-ip-workbench@personal-ip-workbench-private"]` 的 `enabled` 设为 `false`，或使用宿主正常禁用入口。工具保持宿主默认审批；包无 hooks，不请求 observer 权限。

升级：审查新包、增加版本号、替换 marketplace 指向的插件目录，按宿主刷新/重启流程加载，重新核对身份。卸载用宿主正常移除入口，再按需移除 marketplace 条目；重装使用同一 descriptor。安装目录仅有程序与 Skills，禁用/升级/移除不会删除主服务数据库、稿件、媒体或发布记录。不要删除 descriptor 或主服务数据来完成卸载。

验证：调用 `get_context`，再调用 `open_workbench`，确认实际宿主内呈现七页面并能交互；外部链接或工具列表只属于部分证据。`begin_host_run` 在对应原生 observer 未就绪时必须拒绝，不可把连接在线视为 tracking 或改用额外 Agent。
