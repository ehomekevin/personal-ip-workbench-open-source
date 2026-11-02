# 创作有数 Windows 桌面版 0.1.2

下载候选的 setup.exe，在自己的 Windows 用户下安装，从开始菜单“创作有数”打开。普通退出会关闭本实例的本机服务。数据仍在 %LOCALAPPDATA%\PersonalIPWorkbench；原便携版使用自定义 WORKBENCH_DATA_DIR 的，请保持同一设置。先退出仍在使用此工作区的旧程序。安装、卸载和更新桌面程序不负责删除业务数据。

在候选 commit 的干净 Windows x64 checkout 中，用 PowerShell 7 执行：

~~~powershell
./scripts/release/windows-electron/build.ps1 -OutputDir "$env:TEMP/desktop-candidate"
~~~

脚本校验原 v0.1.1 发行包与 Node 26.9.0 的 SHA-256；业务源对应 3f85c440595f8fd3a114e34bfe3abc95edefbbd3。该包本身可在同一提交上用 pnpm 10.32.1、pnpm install --frozen-lockfile、pnpm build:web 和 scripts/release/windows/build.mjs 重建。桌面构建另从官方发行下载固定的 Electron 45.2.1、rcedit 2.0.0、Inno Setup 7.1.1，精确文件名、哈希及装配顺序见 build.ps1。业务依赖仍以仓库 pnpm-lock.yaml 为准；桌面壳无 npm 运行依赖。包内保留 Electron、Chromium、Node、业务依赖及 Inno Setup 的许可。安装器未配置 Authenticode 签名。

Windows 工作流生成安装器、同 commit 源码归档和 candidate.json（文件字节数、SHA-256、签名状态、commit/tree）。桌面验收使用单独的临时 Windows 用户数据和已发布 v0.1.1 原包，不应对日用工作区运行。CI 的窗口测试、开始菜单快捷方式测试和真实用户首次下载安装提示是不同的证据。
