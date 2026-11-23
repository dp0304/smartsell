# Codex 查看 X 现有发布时走了哪条路

2026 年 11 月 23 日，用户在已接入 SmartSell 的 Codex 会话中请它查看自己的独立站在 X 上已经发布的视频。以下时间均为北京时间。原会话标识为 `01a20742-31f9-7223-89bf-3e03e6d2f744`。

| 时间 | 原生客户端事件 | 能确认的事实 |
|---|---|---|
| 15:20:05 | 用户询问 MakeMyLure 的现有 X 发布 | 请求涉及已有帖子和视频。只查登录状态不能完成这个问题。 |
| 15:20:10 | `tool_search_call` 搜索 `smartsell workspace_get_context account_list_social_accounts posts_list content_list` | 这次搜索返回 0 个工具。 |
| 15:21:23 至 15:21:46 | Codex 用本机 shell 查询工作区记录，并向站外服务发起请求 | 工作区读回有空列表。空列表只能说明相应记录尚未存入 SmartSell。 |
| 15:21:57 | `web_search_exa` | 搜索由 Codex 直接发起。 |
| 15:22:11 至 15:22:24 | `js` 打开 `x.com`，随后使用 Playwright | 这段网页读取没有对应 Worker 的任务 ID、设备领取或签名回执。 |

## 在同一台 Mac 的连接对照

普通新开的 Codex 会话未发现可调用的 SmartSell 工具。旧版安装器把凭据环境变量放在专用启动器中。使用该启动器时，客户端仍出现 HTTP 502。独立探测同一个 `localhost:5174/mcp` 地址时，直连得到预期的 HTTP 401 和 Bearer 授权挑战，沿系统默认代理得到 HTTP 502。保持原有授权、仅在单次启动中把回环地址加入 `NO_PROXY` 后，原生 Codex 成功调用了 `workspace_get_context`。这项对照只验证接入和授权。

当时本机工作台有一台已配对的 Worker 在发送心跳，库内有 0 条社媒账号和 0 条帖子记录。旧 MCP 有知乎任务，但没有读取 X 本人现有帖子的 Worker 工具。

## 新版在真实 Codex 中的复测

- 重用原接入授权切换到新版 MCP 注册后，普通 Codex 进程调用 `smartsell_operations_describe` 成功。启动时没有使用专用启动器或临时代理配置。
- 普通请求「获取我的社媒状态」触发 `worker_social_status_request`，请求内容为 `{ "mode": "account_status" }`。工作台可读地返回 `SOCIAL_STATUS_WORKER_OFFLINE`，未产生任务 ID。本地命令只读取了采集 Skill。
- 第一次复跑 MakeMyLure 原话时，Codex 仍先读本机的通用 `social` 技能，然后调用浏览器。我停止了该轮。加入运维项目路由规则后，同一句通过 `worker_social_status_request` 发送 `{ "mode": "recent_posts", "platform": "x" }`，同样收到 Worker 离线。工具记录里没有站外浏览或搜索动作。本地命令只读取了采集 Skill。

## 原配对 Worker 在线后的端到端回执

macOS 允许新版 Worker 读取原配对后，Worker 重新连接了同一工作台。原生 Codex 在运维项目重跑 MakeMyLure 原话，向 `worker_social_status_request` 发 `{ "mode": "recent_posts", "platform": "x" }`。同一任务 `f6e7d265-51f9-4dd5-8eb5-ea3b55badddd` 经过 `queued → claimed → blocked`。Codex 的本地命令只读取 Skill。设备 `paired-worker-1` 启动了专用 Chrome 进程，签名报告在北京时间 16:35:04.471 入库。

| 动作 | 回读结果 | 工作台请求 ID |
|---|---|---|
| Codex 发起 `worker_social_status_request` | `queued` | `8e6b572e-5c0a-42b6-adb2-52a979816ad9` |
| Codex 调用 `worker_social_status_get` | `queued` | `8f563e87-db3f-4a9b-8b61-9c2f2295fa51` |
| Codex 再次读同一任务 | `claimed` | `e7b12082-d7cb-479c-84f7-87b3f650fae9` |
| 配对 Worker 签名调用 `/api/v1/device/social-status/report` | `blocked`，X `unverified` | `259abf32-c9b8-413e-a0a9-832a43eea523` |
| Codex 读回最终回执 | `blocked`，X `unverified`，暂无帖子结果 | `63952860-fc5d-4060-82a2-f7403a16c81d` |

现场看到的是 `x.com/` 上的中文登录落地页。该版本只识别带登录路径的 X 页面，故回报为 `unverified`。

## 普通 Codex 到现有 Worker 的最终复测

原 Codex 接入保留了同一 SmartSell 授权。给普通会话配置的社媒规则引导它为每次新问题派发新任务。复测从用户原来的 `testsmarts` 目录启动，保留该客户端的浏览器工具配置。两轮均调用 SmartSell 完成派发和读回。每轮在本机只用 `uuidgen` 生成独立的任务请求键。

| 原话 | 任务 ID | Worker 回报（北京时间） | 结果 |
|---|---|---|---|
| 我的产品是一个独立站 makemylure.com 然后我社媒是 x 上面发布视频，你看看现有的发布 | `fc8aa51a-4ef7-4d96-a659-310660f46fc4` | 17:12:04.201 | X `login_required`，无可核实帖子 |
| 获取我的社媒状态 | `a0e638fa-9b3d-472d-8024-677dc27a3421` | 17:13:04.207 | X `login_required`，另七个平台 `unverified` |

X 任务的发起请求 ID 是 `3659bc96-c70a-4194-9f90-fcb9a196cd93`，Worker 签名上报请求 ID 是 `75f6b77c-f0eb-4123-9fc5-e51dbe62c96d`，Codex 最终读回请求 ID 是 `3daf9d00-acab-4211-9738-df7afc64ec0e`。三个请求都关联了上表第一条任务及原配对设备。用原工作台的登录会话核对了 HTTP 200 的审计及任务详情，并在 Agent 页展开该签名回执，实际看到「請在這台 Worker 電腦的 Chrome 登入」。

同版 Worker 冷启动的第一轮曾回报 `unverified`，Chrome 稳定后的两个新任务均回报 `login_required`。这台 Worker 仍需用户登录 X 才能查看本人作品。已登录样页验收返回两条本人帖子，其中一条含视频证据。另一个独立测试用空白 Chrome 配置访问实际 X 登录页，走真实签名协议并检查 Web 界面。 [已登录样页](../worker-social-status/2026-11-23T09-12-48-828Z-fixture.json) · [实际公开登录页](../worker-social-status/live-public-x.json)
