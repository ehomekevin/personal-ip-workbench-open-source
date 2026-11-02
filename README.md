# 创作者工作台 · Personal IP Workbench

给自己运营账号的创作者用的本地工作台。可以从一份资料起稿，分别维护公众号、小红书、X、抖音和 B 站版本，再按平台排期、记录反馈，把读者的问题带回下一篇。

一段会议录音，准备写成一篇公众号文章，再拆成一条小红书笔记。两篇稿子用的是同一个例子，开头、配图和发布时间却各不相同。创作者工作台让你在一个主题里保留原始资料、自己的判断和各个平台的稿子。下次打开，就能接着改上次那一稿。

[个人站中文上手说明](https://ai.flowo.design/products/creator-workbench/) · [安装与升级指南](GETTING_STARTED.md) · [查看发行版本](https://github.com/ehomekevin/personal-ip-workbench-open-source/releases)

![今日工作台，左侧可切换创作、排期与复盘，中间可继续上次的主题](docs/project-introduction/images/overview.png)

*这是工作台实际运行的演示界面。截图中的题目、资料和指标均为合成示例。*

## 跟着一条选题走一遍

打开演示工作台，进入「信息与对标」，选择「AI 会议纪要：先核对行动项，再谈省时」，点资料卡右下角的 **「转为创作选题」**。卡片保留了要核对的依据，如原始录音、人工纪要和 AI 纪要。示例中三项都标着「待补」，正好可以从这里记下还缺什么。

![选中的会议纪要资料卡、待补的三项依据，以及右下角的转为创作选题入口](docs/project-introduction/images/sources.png)

1. **把判断写进核心稿。** 在核心稿的「我的表达角度」写下你最想讲的一句，例如「纪要有没有用，要看散会后谁知道自己该做什么」。核心稿围绕一个片段展开，写清任务、负责人和待确认的问题。没核实的地方先留空，日后拿到录音再补。

   ![会议纪要主题的核心稿编辑页，上方可回看资料依据，下方可确认核心稿](docs/project-introduction/images/core-editor.png)

   *写到拿不准的地方，点编辑区上方的「资料依据」回看原条目。核完事实和观点，点「确认核心稿」，再选「制作平台版本」。*

2. **给两个平台不同的读法。** 公众号稿可以先列原话，再列对应的纪要，在讲到负责人时插入对照图。小红书稿可以把同一段改成三张检查卡，分别问「做什么」「谁来做」「何时交付」。平台稿分别保存，改短一张卡片时，公众号的段落和核心稿仍然可用。一个主题也可以维护 X、抖音和 B 站的版本。
3. **从排期接到下一条选题。** 在「排期与发布」为两篇稿子分别安排时间，发布后记录对应作品。到「数据复盘」时，可以把读者追问留作下一篇的起点。例如有人问「会议里根本没指定负责人怎么办」，就值得单独写一篇。

这些写法和读者问题用于演示创作过程。你可以换成自己的资料，手工推进整篇内容。连接 AI 后，生成的文字先作为候选，由你决定采用哪一版。

## 在自己的电脑上打开

**想先试界面**，准备 Node.js `26.9.0` 和 pnpm `10.32.1`，在终端启动演示页面。

```sh
git clone https://github.com/ehomekevin/personal-ip-workbench-open-source.git
cd personal-ip-workbench-open-source
pnpm install --frozen-lockfile
pnpm dev:web
```

打开终端显示的本机地址，默认进入 **demo**。这里的数据是示例，修改保存在当前浏览器，体验时不需要模型密钥。

**开始保存自己的稿件**，按[安装与升级指南](GETTING_STARTED.md)创建 **real** 工作区。页面连接本机服务，配置、SQLite 数据库、笔记和媒体保存在你选择的数据目录。换用新版程序时，沿用这个工作区即可继续编辑。

**Windows x64 用户**可在 [Releases](https://github.com/ehomekevin/personal-ip-workbench-open-source/releases) 查看正式提供的便携 ZIP 和校验清单。下载后按[便携版说明](GETTING_STARTED.md#windows-x64-便携版)核对文件，解压并双击 `Start.cmd`。若发行页还没有公开版本，可先使用上面的源码方式。

## 可选连接与开发说明

AI 写作、资料采集、生图、语音和平台发布分别使用你配置的执行器、服务或平台账号。启用外部服务时，相应任务输入会发送给它。能否直接发布取决于平台、账号权限和连接状态。部分音视频处理需要 `ffmpeg` 和 `ffprobe`。

工作台使用 React、TypeScript、Node.js 和 SQLite，提供 MCP 与宿主插件入口。自有代码采用 MIT，第三方组件保留各自许可。[模块与开发入口](docs/architecture.md) · [MIT 许可证](LICENSE) · [第三方说明](THIRD_PARTY_NOTICES.md)
