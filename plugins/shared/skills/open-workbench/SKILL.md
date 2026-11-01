---
name: open-workbench
description: 在当前宿主打开同一工作区的个人 IP 工作台七页面。
---

用户请求打开工作台或某页时，调用 `get_context` 核对固定工作区，然后调用 `open_workbench`。
page 仅可为 today、sources、create、schedule、retro、knowledge、settings。已选主题或版本用真实 topic_id、variant_id 传入；工具会在主服务验证归属。
UI resource 为 `ui://personal-ip-workbench/0.1.0.html`。工具或资源调用成功不代表宿主内可视已验收；根据返回的逐操作能力记录报告实际状态。可视未验证时可说明返回的独立工作台入口，但不能把链接当作内嵌通过。
不启动同步、生成或发布，不建立另一份工作区，不使用 SQL、shell 或直接文件改写绕过主服务。
