# 个人 IP 工作台 · Claude Desktop chat MCPB

This private desktop extension uses Claude Desktop's bundled Node runtime to expose the same shared workbench and registered tools. The server is a bundled JavaScript client, not a second application service. Connection configuration is selected during installation and remains outside the extension directory. Installing the package, listing tools, rendering the interface and tracking native tasks each require separate evidence.

本包是 Desktop chat 专用 MCPB；Cowork / Code 使用另一份 plugin ZIP。安装前，主服务必须已经运行，外部连接流程已生成 `host.surface=claude_desktop_chat` 的 descriptor，固定 service/workspace/contract 身份。不要在包内放凭据、数据库或绝对 Mac 路径。

正常入口：Claude Desktop > Settings > Extensions > Advanced settings > Install Extension，选择 `.mcpb`；审查程序访问与权限提示后，选择“主服务连接描述文件”。保持默认工具审批，不启用未知 observer 或 hooks。安装步骤不会由打包脚本执行。当前会话需要重启时，先取得用户允许。

安装后先调用 `get_context`，再 `open_workbench`。记录 resources/read 与实际内嵌面板/全屏交互、七页面、上传/媒体/外链/下载，以及内容视口 T26/T27 的独立证据。新 Node24 JS bundle 完成检查仍不代表当前 Desktop 已执行该 bundle。

禁用/移除用 Settings > Extensions 正常入口。升级先审查新版本，再使用宿主支持的更新或正常移除后安装新包，重新选择同一 descriptor 并核对身份。重装使用同一主服务；主服务数据库、稿件、媒体和发布记录不属于扩展，整个安装生命周期不会删它们。

远程 connector 从 Anthropic 云发起，不能连接此本机回环服务。本包没有公网 gateway。原生 task tracking 未经真实 observer 验证时保持 unverified；`begin_host_run` 必须拒绝，工具连接在线和模型自报不能替代观察。
