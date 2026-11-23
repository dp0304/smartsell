# 三分钟视频排期复跑

仅运行 `01-video`，使用独立的本地 SmartSell 服务和没有远端凭据的测试账号。Claude Code 通过 MCP 创建排期并送审；不审批、不发布。排期在创建工具请求转发时计算，服务端的 `created_at` 和 `scheduled_at` 用于测量实际间隔，时区为 `Asia/Shanghai`。同一个 `target_id` 在到点前、到点及至少 15 秒后各读取一次。回执保留平台活动记录的事件 ID 和时间。

## 实测结果

[脱敏回执](2026-11-21T16-42-33.867Z.receipt.json)，目标 `eb26df5a-cea0-46b9-b10b-ee5169ad7a63`。2026-11-22 上海时间 `00:43:16.344` 创建，排期 `00:46:16.340`，实际间隔 `179,996 ms`，比三分钟短 `4 ms`。排期以服务端持久化 UTC 时间为准；回执的上海时间由同一时间戳转换。

| 同目标查询 | 上海时间 | 相对排期 | 平台状态 |
| --- | --- | ---: | --- |
| 到点前 | `00:43:52.259` | `−144,081 ms` | `awaiting_approval` |
| 到点 | `00:46:16.343` | `+3 ms` | `awaiting_approval` |
| 到点后 | `00:46:31.341` | `+15,001 ms` | `awaiting_approval` |

三次查询均无执行状态、平台帖子或发布回执。平台活动 API 对该目标记录了各一次 MCP 创建和送审，无审批通过或发布。回执只保留业务 ID、时刻、结果和审计，不含凭据或运行环境。

## 复跑命令

从项目根目录运行。需要 Node 24、已登录的 Claude Code、FFmpeg、Chrome 和已安装依赖的隔离源码。三组端口须空闲，可换成其它回环端口。

```sh
cd agent-ops-lab/scenarios
LAB_API_PORT=47431 LAB_WEB_PORT=47432 LAB_FIXTURE_PORT=47433 node run.mjs 01-video
```

保持终端运行至到点后查询完成。每次都会生成新目标和独立的 `三分钟回执`（本目录的 `<UTC运行时间>.receipt.json`）。不要分发 `runs/` 下的 `runtime/` 目录。原三段对话和 `verified.json` 不会被覆盖。
