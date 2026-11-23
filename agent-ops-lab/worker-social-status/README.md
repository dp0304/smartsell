# Worker 社媒状态验收

2026-11-23 在实际工作区里，用正常 Codex 配置和原配对 Worker 复跑了用户的两句原话。两轮都派发了新任务，没有调用 Codex 自己的浏览器或网页搜索。原工作台的签名回执显示 X 需要登录；真实本人帖子仍待该 Worker 的 Chrome 完成登录。 [原生 Codex 与原设备实测](../client-check/worker-routing-incident.md)

下方是独立验收工具。自动审批曾因本机模型代理上游未经核验，拒绝该工具的两次在线启动。离线工具覆盖了握手与发现，实际原生模型路径由上方的正常 Codex 会话单独验证。

## 复跑

从仓库根目录运行。需要 Node 24、工作树已有依赖，以及 macOS 上的 Google Chrome。原生模式还需要 `sandbox-exec` 和已安装的 Codex CLI。

```sh
node --import tsx agent-ops-lab/worker-social-status/accept.mjs
node --import tsx agent-ops-lab/worker-social-status/accept.mjs --native-offline
```

第一条直接调用产品 HTTP MCP。它运行当前检出的 Commands 服务，使用独立 SQLite 文件、随机本机端口和合成工作区。真实 `DesktopConnector` 配对和连接，使用真实 `ChannelSessions` 与 Ed25519 请求。`ChannelBrowser` 由专用的无头 Chrome 和 Playwright 路由替换。X 页面在导航时用合成 HTML 响应，脚本使用与 Desktop 打包相同的 esbuild 转换。Chrome 使用临时配置、禁用服务 Worker、拦截页面网络，并将其余网络指向不可用的本机代理。浏览器适配层以外使用当前产品实现。

第二条使用真实 `codex exec --json --ephemeral`。原生进程在全新的普通目录运行，临时 `CODEX_HOME` 由原生 `codex mcp add` 添加 SmartSell 和可计数的本机浏览器与搜索 canary。离线模型端口只返回 HTTP 401，既没有外连也没有模型合成回复。启动、发现和事件可单独检查。

真实模型复跑需先在授权环境核验 `SOCIAL_STATUS_MODEL_ORIGIN` 本机代理及其上游。`--native` 可以用专用验收模型凭据环境变量 `SOCIAL_STATUS_MODEL_API_KEY`，也支持在 macOS 文件沙箱下以 `SOCIAL_STATUS_REUSE_CODEX_AUTH=1` 对现有 `auth.json` 建立临时只读引用。入口从不复制现有配置或凭据。

```sh
SOCIAL_STATUS_MODEL='已批准的模型 ID' \
SOCIAL_STATUS_MODEL_ORIGIN='http://127.0.0.1:已批准的端口/模型基础路径' \
node --import tsx agent-ops-lab/worker-social-status/accept.mjs --native
```

可用 `SOCIAL_STATUS_CODEX` 指定 CLI 路径，默认是 `~/.nvm/versions/node/v22.17.0/bin/codex`。可用 `SOCIAL_STATUS_MODEL_CATALOG` 只读引用现有模型目录文件。两次均以原句开始独立会话。测试不会添加项目 Skill、`AGENTS.md` 或系统提示，模型只接收产品 MCP 自己提供的 instructions。

> 我的产品是一个独立站 makemylure.com 然后我社媒是 x 上面发布视频，你看看现有的发布
>
> 获取我的社媒状态

真实模型的通过条件包括每次都发现 canary 且实际调用为零，Codex 事件没有本机 shell 或浏览器搜索动作，named request 创建新任务并省略设备 ID，Worker 签名领取和提交，原生 named GET 读到同一任务终态，Web 读模型和审计吻合。第一句对应 `recent_posts/x`，第二句对应 `account_status`。两个 canary 工具各有一次显式自检，计数随后归零。模型请求或工具选择未完成的运行不能证明用户路径的零次本机直连。

## 已观测结果

- 基线在 `tools/list` 中缺少 `worker_social_status_request`。当前工作树加入两个工具后同一测试通过。 [初始基线](baseline-initial.json)
- 第一轮离线页面到达了签名上报，但 X 返回 `unverified`。定位到 `tsx` 转换向序列化脚本引入 `__name`。在验收代码中改用 Desktop 的 esbuild 配置后，通过实际 DOM 读到 `fixture_angler` 和两条本人帖子。视频标志分别为 `true` 和 `false`，第三方帖子未入结果。 [第一次失败](2026-11-23T08-17-56-500Z-fixture.json)
- 最新协议通过记录涵盖 `recent_posts` 完成、默认 `account_status` 中 X 已验证且其他未开页渠道 `unverified`、X 离线登录页返回 `login_required`。三条任务分别创建，排队结果没有帖子或状态缓存，报告时间晚于当次创建。Web REST GET 与 MCP GET 的完整任务一致，Web MCP 审计中的三类 request ID 与 named request、签名上报和终态 GET 响应一致。实际 Web 页面展开了三条签名回执，确认同一任务和设备、报告时间、两条帖子链接和一条视频证据，以及未登录提示。 [协议与 Web 回执](2026-11-23T08-36-19-915Z-fixture.json)
- 未鉴权 MCP 返回 HTTP 401，无设备返回 `SOCIAL_STATUS_WORKER_UNPAIRED`，旧版 Worker 返回 `SOCIAL_STATUS_WORKER_UNSUPPORTED`，只读令牌能发现 GET 但请求任务返回 `TOOL_UNAVAILABLE`。 [协议与拦截](2026-11-23T08-29-44-476Z-fixture.json)
- 离线原生 Codex 0.171.0 在空目录注册 MCP。两个原句各发现一次 SmartSell 和本机 canary 工具，各收到一次离线模型的 HTTP 401，真实 CLI 输出 `turn.failed`。两次都没有工具调用。这个结果只覆盖 CLI、MCP 握手与工具发现。首次可启动的 CLI 运行在工具发现前超时，证据一并保留。 [离线 CLI 握手](2026-11-23T08-37-02-839Z-native-offline.json) · [首次 CLI 超时](2026-11-23T08-24-56-855Z-native-offline.json)

每次运行写入一个新 JSON。相同的 `id-N` 在单次运行内表示同一原始标识。报告保留 HTTP 状态、事件种类、操作和审计关联、合成帖子、时间及助手输出摘要。临时状态、SQLite、Chrome 用户目录和凭据引用在退出时清理。
