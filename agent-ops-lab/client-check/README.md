# 原生客户端 Skills 验收

两次验收均从 `agent-ops-lab` 根启动，用自然语言选择预设，不输入斜杠命令。只用合成数据；无真实平台访问、发布、上架或审批。没有重新构建桌面产品。

| 客户端 | 自然语言选择证据 | MCP 证据 |
| --- | --- | --- |
| [Codex CLI 0.171.0：对话](codex.md) · [事件摘录](codex-events.json) | 三个会话分别主动声明所选技能，随后原生 CLI 事件记录成功读取对应的 `.agents/skills/.../SKILL.md`，读取内容与项目内文件一致。没有独立的 `Skill` 工具调用事件。 | **真实 SmartSell 服务回读，合成数据**。主仓开发服务在回环地址运行，使用临时数据库，仅授予 `commerce_store_list`。原生 `mcp_tool_call` 读回一条 `file_import` / `import_only` 店铺。视频及指标的业务读取未授权，正确报告未知；没有用测试桩替代。 |
| [Claude Code 2.1.311：对话](claude-code.md) · [事件摘录](claude-code-events.json) | 从 `.claude/skills` 发现三个预设，分别出现对应的原生 `Skill` 调用。 | **合成 MCP 测试桩响应**：视频状态、任务交接、帖子指标及提供的 Chrome 核对信息均为合成，不是主仓服务、桌面 Worker 或真实 Chrome 的读回。 |

使用已登录的本机 nvm 版 Codex CLI；未全局安装、未重新授权账号、未绕过审批或沙箱。ChatGPT.app 内置版只检查了可执行性和版本（`0.171.0-alpha.13`），未用来跑验收。持久证据只保留脱敏摘录，不存储连接令牌或原始客户端会话。
