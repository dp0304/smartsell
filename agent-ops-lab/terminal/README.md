# 用 Codex 或 Claude Code 运行 SmartSell

从这个目录启动 Claude Code 或 Codex，用自然语言交代要处理的内容、店铺或数据来源。目录为两个客户端各提供三份 Skills。需要工作区或 Worker 数据时，使用工作台为该 Agent 授权的 SmartSell MCP 连接。

在 SmartSell Web 的「开始设置」选择对应客户端，按页面指示在 Agent 电脑的交互式终端中完成接入。需要原生 CLI 和 Python 3.9 或更新版本。一次性接入码只填在终端的隐藏输入提示中。接入程序为这条连接配置私有的本机 MCP stdio relay。远程工作区使用 HTTPS，HTTP 只用于同一机器和网络环境上的 loopback 地址。让凭据留在该连接的本机私有设置中，无需手动编辑全局配置，也无需把凭据贴入对话、终端输出或日志。

接入程序的预检只检查端点和工具目录。退出旧会话，在此目录照常重启原生 `claude` 或 `codex`，通过已授权的 MCP 连接用空参数实际调用 `smartsell_operations_describe`。成功后回 Web 点「重新检查状态」。旧版 Codex 接入按工作台的修复提示处理同一条连接，修复会沿用该连接已有的本机凭据。 [Agent 接入与操作指南](../../docs/agent-guide.md)

| 终端任务 | Agent 会核对什么 |
|---|---|
| 查一条已送审的视频到底发出去没有 | 按同一排期目标查询审批、执行和平台作品回执。 [视频 Skill](.claude/skills/smartsell-video-publish/SKILL.md) |
| 查我的社媒状态，或查 X 账号现在有哪些视频 | 仅通过 SmartSell MCP 在自己的已配对 Worker 上请求 `account_status` 或 `recent_posts`，按同一任务 ID 查设备、实测状态、观测时间和阻塞原因。已存贴文和指标标明缓存。 [采集 Skill](.agents/skills/smartsell-data-collection/SKILL.md) |
| 查某店铺的 SKU，导入商品或查询上架回执 | 匹配店铺和指定 Worker，按同一业务 ID 查导入或上架结果。 [商品 Skill](.claude/skills/smartsell-product-listing/SKILL.md) |
| 检查指定 Worker 的知乎登录状态，或核对已授权来源的销量 | 查询相应只读任务、观测时间和覆盖范围，区分实测零值、缺失和无权限。 [采集 Skill](.agents/skills/smartsell-data-collection/SKILL.md) |

本次离线演练中，原生 Claude Code 对第一、第二项分别调用了 `smartsell-video-publish` 和 `smartsell-product-listing`。原生 Codex 对第三项实际读取了本目录 `.agents/skills/smartsell-data-collection/SKILL.md`。演练验证了工具选择和回执的判读方法。历史在线业务证据可在[验收记录](../README.md)查找。
