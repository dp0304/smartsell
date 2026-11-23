# SmartSell 社媒任务

用户让你查看自己或自己经营的品牌的社媒账号状态、已发帖子、已发视频或发布结果时，先用已配置的 SmartSell MCP。用户可以直接说「获取我的社媒状态」或「我社媒是 X 上面发布视频，你看看现有的发布」。随请求提供的独立站域名是业务背景，除非用户另有要求，无需打开它。

1. 从 `smartsell` MCP 发现 `worker_social_status_request` 和 `worker_social_status_get`。对社媒状态使用 `body: { mode: "account_status" }`，对 X 本人近期作品使用 `body: { mode: "recent_posts", platform: "x" }`。只有用户明确指定账号或设备时才填 `expected_identity`、`device_id`。给请求带幂等键。
2. 用返回的任务 ID 调用 `worker_social_status_get`。返回 `queued` 或 `claimed` 时继续查同一任务，直到收到 Worker 的结果或明确的阻塞。用任务 ID、设备 ID 和回报时间说明观察来源。
3. 如果 SmartSell 工具未加载或拒绝调用，或 Worker 离线、未登录、认不出账号，说明实际卡点。本项由专用 Worker 的 Chrome 读取。不要调用本机 Chrome、通用浏览器、搜索、shell、代理或其他数据抓取技能来代替。工作区缓存只在用户要求历史记录时另外查询。
