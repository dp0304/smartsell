# SmartSell 运营对话验收

这是三段独立的运营角色对话。每段两轮：先办理，再只读复核。原生 Claude Code 2.1.311 从本目录启动，`--input-format stream-json` 在同一个 CLI 会话续问，使用真实 Claude 模型与 SmartSell Streamable HTTP MCP。不是本地模型桩。对话和工具事件保留原文，凭据、租约字段和非用户可见推理除外。

## 本次证据入口

[独立断言通过结果](verified.json)汇总了最终业务与审计 ID。视频已送审、未发布；商品已完成内部建品和 CSV 合并 1 行、未对外上架；采集已入库并逐字段读回。

| 场景 | 运营对话（指令及实际答复） | 逐工具事件 | 独立平台回读 |
|---|---|---|---|
| 视频内容与排期 | [对话](runs/2026-11-21T16-23-16.667Z/01-video/conversation.json) | [CLI 事件](runs/2026-11-21T16-23-16.667Z/01-video/claude-code.jsonl) | [排期、任务、贴文](runs/2026-11-21T16-23-16.667Z/01-video/platform-readback.json) |
| 建品、CSV 导入与沙箱上架边界 | [对话](runs/2026-11-21T16-31-03.941Z/02-shop/conversation.json) | [CLI 事件](runs/2026-11-21T16-31-03.941Z/02-shop/claude-code.jsonl) | [商品、批次与逐行结果](runs/2026-11-21T16-31-03.941Z/02-shop/platform-readback.json) |
| 采集授权样页 | [对话](runs/2026-11-21T16-23-16.667Z/03-collect/conversation.json) | [CLI 事件](runs/2026-11-21T16-23-16.667Z/03-collect/claude-code.jsonl) | [研究条目、任务与来源](runs/2026-11-21T16-23-16.667Z/03-collect/platform-readback.json) |

- [首跑平台审计行](runs/2026-11-21T16-23-16.667Z/platform-audit-rows.json)／[活动 API](runs/2026-11-21T16-23-16.667Z/platform-activity.json)；[商品末轮平台审计行](runs/2026-11-21T16-31-03.941Z/platform-audit-rows.json)／[活动 API](runs/2026-11-21T16-31-03.941Z/platform-activity.json)。记录中含任务与工作项 ID、事件 ID 和 UTC 时间。运行目录时间戳为 UTC，在上海为 11 月 22 日。
- [实际 Chrome 来源截图](runs/2026-11-21T16-23-16.667Z/source-page.png)／[采集 JSON](runs/2026-11-21T16-23-16.667Z/source-capture.json)；[真实测试视频](runs/2026-11-21T16-23-16.667Z/video.mp4)／[字节上传 SDK 工具记录](runs/2026-11-21T16-23-16.667Z/sdk-fixtures.jsonl)。视频观看不是本轮浏览器验收项。上轮独立视频播放截图保存在本机。这次视频审批与发布以本轮回执为准。
- 商品过程失败也保留：[第一次缺 Claude Code 工具许可](runs/2026-11-21T16-23-16.667Z/02-shop/conversation.json)、[第二次库存列不是整数](runs/2026-11-21T16-26-46.652Z/02-shop/platform-readback.json)、[第三次测试店没有市场配置](runs/2026-11-21T16-28-29.531Z/02-shop/platform-readback.json)。每次用新隔离数据库，旧任务和批次不改不删。

## 边界与复跑

- **原生 Claude Code MCP**：业务工具、任务认领、持久化结果和操作者追问。**SDK**：只为素材做确定性字节上传注册，不把模型转抄的 base64 当成功。**REST**：工作区、店铺、市场、账号、任务等种子资源和最终独立读回。**Chrome**：抓取无登录、仅回环可访问的自建 HTTP 样页；没有接触第三方页面。没有模型桩、模拟外部回执、Connector 或设备 ID（`null`）。
- 社媒测试账号无连接和远端授权；只能送审，未核准、未发布。CSV 店仅 `file_import`，没有远端可写连接。两个外部步骤的缺口都提交在 SmartSell 任务的 `result_ref.note`，而不是留在终端里。没有外部测试平台，也没有伪造平台帖子、远端商品或回执。
- 运行需要 Node 24、Claude Code（已经登过支持所选模型的账号）、FFmpeg、已安装的 Chrome 和该隔离源码副本的依赖。默认回环端口 API `46431`、Web `46432`、样页 `46433`；可用 `LAB_API_PORT`、`LAB_WEB_PORT`、`LAB_FIXTURE_PORT` 覆盖。每次运行创建独立 `runs/<UTC时间>/runtime/`，数据库与本地文件不共享；程序结束撤销测试 Agent 连接并关停服务。`runtime/` 是本地运行资源，不是应该转发的证据文件。

```sh
cd agent-ops-lab/scenarios
node run.mjs                  # 三个双轮对话
node run.mjs 02-shop          # 只复跑店铺场景
node verify.mjs runs/2026-11-21T16-23-16.667Z runs/2026-11-21T16-31-03.941Z
```

`verify.mjs` 对独立回读做断言，不以模型回答替代结果。重新运行会产生新业务 ID 和时间，不覆盖原记录。可通过 `SMARTSELL_SOURCE` 和 `CHROME_PATH` 指定其它隔离源码副本及浏览器可执行文件。
