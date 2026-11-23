# SmartSell 终端运维验收

这个目录保存本次 Claude Code 的运维对话、逐工具调用结果、Worker 回执和平台审计记录。每条业务记录会注明执行环境、任务和设备、可复核的结果，以及需要登录或人工处理的步骤。

验收从终端发起。用户在指定 Worker 的 Google Chrome 内完成站点登录。视频发布、商品上架与网页采集分别以平台、店铺或来源的实际回执为准。

## 从哪里看

| 想核对的事 | 已有记录 |
|---|---|
| 怎么从终端验收全部 MCP 能力 | [新品上市全流程与逐项验收用例](acceptance/README.md) |
| 运营人员向 CC 说了什么，CC 怎么办、怎么回 | [视频、商品和采集的双轮终端对话](scenarios/README.md) |
| CC 和 Codex 能不能根据普通中文选择预设 | [两个客户端的实际对话和工具事件](client-check/README.md) |
| 三分钟的视频排期到点后发生了什么 | [同一目标的到点前、到点和到点后回读](scenarios/three-minute/README.md) |
| 每个具名 MCP 工具调用了几次，拿到什么回执 | [主仓报告](coverage/run-main-EH9S3A/REPORT.md) · [逐项终端记录](coverage/run-main-EH9S3A/TERMINAL.md) |
| 通用 MCP 工具能执行哪些业务操作 | [各模块的实调结果和覆盖矩阵](gateway/README.md) |
| 如何把终端回执和 Web 审计逐条对上 | [主仓平台入口和验证](audit/main-integration.md) · [隔离验收与复跑](audit/README.md) |
| 两个 Worker 同时在线时谁接单，需登录时平台显示什么 | [两实例实测](desktop/README.md) · [主仓接入验收](desktop/main-integration.md) |
| 本地 Mac 桌面包包含哪些预设 | [打包文件与校验记录](desktop/main-package.json) |
| 已登录知乎的用户统计是否通过桌面签名送回 CC | [同一任务的成功回执](zhihu/signed-run.md) · [另一次未登录异常](zhihu/login-required.md) |

主仓两个 MCP 入口分别验证了 98 和 42 个具名工具，名称去重后为 114 个。每个工具均有原生 Claude Code 回执。该轮的 183 条 CC 调用和 184 条 SDK 调用，在 Web 上逐条匹配请求 ID、授权、工具、结果和拒绝码。批量覆盖由原生 CC 配合本地脚本执行，三段运营对话另用原生 CC 与在线模型验证。

按工作台提示接入已授权的 SmartSell MCP，再从 terminal 运维目录照常启动原生 Claude Code 或 Codex。Agent 发起任务并查询同一任务的结果，工作台记录进度和异常。查自己的社媒账号状态或近期作品时，Agent 通过 SmartSell MCP 指派已配对的 Worker 观察。需要登录时，在指定 Worker 的 Chrome 完成登录。查询既有 SmartSell 排期时，Agent 核对同一排期的执行与发布回执。 [终端接入与任务示例](terminal/)

上表记录的是当时的对话和预设。这里和 terminal 目录中的项目 Skills 也包含当前的社媒 Worker 查询指引。

实测视频上传并送审，商品建品和 CSV 合并，授权样页采集，知乎本人统计和未登录异常。当前视频发布仍按已有审批和发布交接执行。外部商品上架返回 `unsupported`。设备路由使用一台 Mac 上两个配对的 Worker 验证，跨两台物理机器与 Windows 安装仍待实机验证。