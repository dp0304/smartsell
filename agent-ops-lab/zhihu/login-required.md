# 从终端核对知乎登录异常

2026 年 11 月 22 日，北京时间。统计工作区的一次独立未登录测试使用了真实的本地 Claude Code、Electron Worker、Google Chrome 和 SmartSell 服务。演示脚本向 Claude Code 输入 `Use the allowed SmartSell tool.`，本地模型夹具选择 MCP 工具和参数。

| 时间 | 实际动作 | 可复核的返回 |
|---|---|---|
| 00:09:52.976 | CC 调用 `zhihu_stats_create`，模式为 `login_check` | 服务端返回 `queued`，任务 ID 为 `7730b0ba-037d-4dd5-8430-64b3f97a3be9` |
| 00:09:53.012 | 指定 Worker 签名领取任务 | 返回同一任务 ID，设备 ID 为 `1dd3b6aa-e2a1-4ddc-a22b-73519f6280c7` |
| 00:09:53.046 | Worker 识别知乎登录界面并签名上报 | 返回 `blocked` |
| 00:09:56.648 | CC 调用 `zhihu_stats_get` | 返回 `blocked` 和 `login_required` |
| 00:09:59.507 | 刷新 Web 控制台异常列表 | 同一 ID、设备和首次报告时间仍可见 |

本文件摘录真实调用。对应的终端和平台事件在 [login-required.ndjson](login-required.ndjson)。