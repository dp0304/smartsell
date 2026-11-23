# SmartSell 桌面业务技能联调

本记录来自隔离副本 `.local/mcp-lab-Lh53qf`，使用 Node 24.21.0、原生 Claude Code 2.1.311 和同一台 Mac 上两个独立配对的 Electron Worker。每个 Worker 使用自己的 Chrome 配置。Claude Code 通过项目级 HTTP MCP 实际下单和读回。模型响应由本机确定性测试桩驱动，平台状态来自实际本地 SmartSell 服务，知乎登录状态由可见 Google Chrome 打开官方页面后观察。

## 入口与技能

| 入口 | 地址或路径 |
| --- | --- |
| Web 工作台 → Agent → 知乎登录异常 | [打开本次工作区](https://127.0.0.1:52556/app/618a7a36-1f53-4a23-8e05-5f7494531d17/agent) |
| 项目级 Claude Code MCP | [`.mcp.json`](.mcp.json)，`https://127.0.0.1:52556/mcp` |
| 后端监听 | `http://127.0.0.1:52559`，供本机 HTTPS 入口转发 |
| 本机保留会话 | `tmux -L smartsell-zhihu-lab attach -t desktop-ops` |
| 测试运行数据 | `.local/mcp-lab-Lh53qf/.local/zhihu-demo-EOAOqJ`，相对仓库根目录 |
| Mac arm64 本地包 | `.local/mcp-lab-Lh53qf/apps/connector-desktop/release-local/mac-arm64/SmartSell Connector.app`，相对仓库根目录 |

从本目录启动 Claude Code 并加载项目设置。项目配置从环境读取 `SMARTSELL_MCP_URL` 和 `SMARTSELL_TOKEN`。本次使用隔离工作区签发的一天期 Agent 授权，测试进程通过 `NODE_EXTRA_CA_CERTS` 信任本次本地证书。登录工作台需要有权限的测试工作区会话。记录中的授权 UUID 是审计关联 ID。

| 能力 | Claude Code | Codex | 运行边界 |
| --- | --- | --- | --- |
| 知乎只读采集 | [技能](.claude/skills/smartsell-zhihu-stats/SKILL.md) | [技能](.agents/skills/smartsell-zhihu-stats/SKILL.md) | 指定配对 Worker，在可见专用 Chrome 登录。采集本人指标仍需要主页标识及归属校验。 |
| 抖音／小红书视频 | [技能](.claude/skills/smartsell-video-publish/SKILL.md) | [技能](.agents/skills/smartsell-video-publish/SKILL.md) | 提交已有视频版本送审。满足账号绑定、审批和租约条件后，Worker 自动领取，操作者核验并在官方页面手动提交。 |
| 商品上架 | [技能](.claude/skills/smartsell-product-listing/SKILL.md) | [技能](.agents/skills/smartsell-product-listing/SKILL.md) | 持久化 `unsupported` 回执供查询。 |

产品构建将能力目录和技能收录到 `dist/skills/`。在隔离副本根目录可用 `npm --prefix apps/connector-desktop run skills:export -- ../../agent-ops-lab/desktop` 导出这两个原生布局。本机实测了 Claude Code 技能加载。Codex CLI 未安装，验证范围为导出布局和文件一致性。

## 场景对话

以下问答由实际协议和 UI 记录整理。原始脱敏请求、响应和事件均可在对应行查看。所有时间为 2026-11-21 UTC。

### 指定设备做知乎登录预检

- **操作者**　让 A 检查知乎是否已登录。先让 B 在线，看看它是否会领取 A 的任务。
- **Claude Code / SmartSell**　`/smartsell-zhihu-stats login-check DEVICE_ID` 加载后调用 `zhihu_stats_create`。任务 `b37fb4b9-c8ff-4379-9f73-a485b27d0869` 分配给 A `663380fe-de5f-4745-9254-042c067febd5`。B 的签名领取在 `16:28:55.250Z` 返回 HTTP 200 和 `claim:null`，随后核对任务仍在 A 的队列。连接 A 后，A 签名心跳成功，立即自动领取。 [下单、错机及正确领取](zhihu-demo-EOAOqJ/protocol.ndjson#L24)
- **Worker A**　可见 Chrome 显示知乎登录页，签名上报 `{"status":"blocked","reason":"login_required"}`。平台首次记录时间 `16:28:56.719Z`。 [签名上报与观察](zhihu-demo-EOAOqJ/protocol.ndjson#L38) · [桌面画面 A](zhihu-demo-EOAOqJ/worker-a.png)
- **操作者**　B 也检查自己的登录状态，我想在 Web 刷新后仍能找到结果。
- **Worker B / 工作台**　B `a5ceb644-0283-4cd0-a076-5c736a96cf21` 在线期间自动领取专属任务 `84bed136-421f-47be-9966-29460c552c3d`。签名报告 HTTP 200，首次记录时间 `16:29:12.228Z`。MCP 查回同一任务；工作台初次打开与刷新后均显示一条匹配的「需要用户登录知乎」，任务、设备、时间一致。两个实例连接后均未操作领取或读取按钮。本轮执行的是登录预检，结果中没有用户指标。 [B 的领取、回报及刷新](zhihu-demo-EOAOqJ/protocol.ndjson#L53) · [桌面画面 B](zhihu-demo-EOAOqJ/worker-b.png) · [Web 异常行](zhihu-demo-EOAOqJ/web-login-required-84bed136-421f-47be-9966-29460c552c3d.png)

### 请求商品上架并查回执

- **操作者**　请求把测试商品上架到测试店铺。我重复发一次同样的请求后，还能查到第一次的结果吗？
- **Claude Code / SmartSell**　`desktop_request_capability` 在 `16:29:21.282Z` 记录回执 `c7a0d4e4-aaae-496b-8acd-ea6bc1490743`，状态 `unsupported`，原因为 `product_listing_not_supported`。重复使用同一幂等键及随后 `desktop_get_capability_request` 均得到同一 ID 和首次时间。此请求只写回执及审计，无 Worker 任务或平台商品变更。 [请求、重试与读回](zhihu-demo-EOAOqJ/protocol.ndjson#L66)

### 提交视频送审并查状态

- **操作者**　用隔离工作区里的视频版本发起送审，看看能走到哪一步。
- **Claude Code / SmartSell**　`publishing_create_target` 建立目标 `e5341337-2ab0-4185-9cdf-66c101731a69`。`publishing_request_approval` 对该隔离测试素材和账号执行真实预检，返回 `submission_status: blocked`。`publishing_get_target` 查得 `plan_status: draft`、`execution_status: null`。本轮止于预检，批准后的自动领取与人工交接由回归测试覆盖。 [送审及状态](zhihu-demo-EOAOqJ/protocol.ndjson#L85)

## 审计与构建核对

经认证的工作台 Activity API 在 `16:29:37.976Z` 返回下列三条记录，各出现一次。三条记录均为 `source=mcp`、`actor=agent`，关联授权 `366621e1-967f-41d6-bbca-b1afa7c94f83`。视频状态由送审和读回记录验证。 [Activity 核验](zhihu-demo-EOAOqJ/protocol.ndjson#L93)

| 资源 | 审计事件 ID |
| --- | --- |
| A 的知乎下单 | `ef2743d7-3d27-431f-91fb-129ad7c377dc` |
| B 的知乎下单 | `ac38abc9-32f5-47aa-af26-026aea185e29` |
| 商品不支持回执 | `8d351260-b3b7-4863-bbb4-e82e12ae69b8` |

Node 定向回归 36 项通过，覆盖设备路由、跨任务串行、报告重试和急停、能力回执幂等及审批边界。根项目和桌面类型检查通过；另外针对后续服务端源码运行了 MCP／Activity 及账号／发布测试。留存的服务进程用于复核上述实测协议，服务启动后另有源码更新。Mac arm64 本地包完成构建，包内入口、UI、能力目录的 SHA-256 与实测运行的桌面构建相符；三份技能与源码及两份导出逐字节相同。未实测物理双机、登录后的本人指标采集、批准后真实平台交接、Windows 或正式签名分发。本次使用隔离工作区，无生产账号、外部发布或部署。 [定向回归](zhihu-demo-EOAOqJ/regression.log) · [包一致性校验](zhihu-demo-EOAOqJ/package-integrity.txt)
