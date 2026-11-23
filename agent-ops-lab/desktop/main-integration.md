# SmartSell 桌面 Worker 主仓集成

## 实现边界

- 终端通过已有 SmartSell HTTP MCP 授权调用 `zhihu_stats_create`，指定操作者自己的配对设备，提交 `login_check` 或本人主页 slug。`zhihu_stats_get` 读取任务及结果。无设备则不下单；凭据未暴露工具时不切换到其他写入路径。
- 设备用既有签名协议自动领取，任务只给指定设备；签名结果受设备、租约和 fencing token 约束。只读任务和原有发布任务不得在同一设备并发执行。登录预检不采集指标；统计只在本机 Chrome 确认本人主页后读取可见计数。登录、验证挑战和身份不符不由 Worker 代办；不接受远端 URL、脚本、选择器或登录凭据。无法可靠识别的页面只在本机记录原因，不冒报 `login_required`，也不重复操作，等待租约到期。
- `login_required` 经签名回报后存为任务结果。Web → Agent → 知乎 Worker 异常读取当前操作者自己的记录，显示任务 ID、设备 ID 和首次回报时间；不读取 Chrome 登录态。
- `desktop_request_capability` 仅记录商品上架不受支持的回执；`desktop_get_capability_request` 可查回。相同幂等键不会新增记录，不创建 Worker 任务或更改平台商品。发布送审、人工审批、交接和发布边界不变。本次未扩展通用 MCP 审计。

## 主仓对应文件

| 链路 | 文件 |
|---|---|
| MCP 发现、注册、任务数据 | `apps/server/src/integration/command-mcp.ts`、`apps/server/src/modules/workspace/operations.ts`、`apps/server/src/modules/account/zhihu-stats.ts` |
| 签名设备路由和客户端 | `apps/server/src/modules/account/http.ts`、`apps/server/src/modules/account/connector-service.ts`、`apps/connector/src/device-client.ts` |
| 桌面串行执行与 Chrome | `apps/connector-desktop/src/controller.ts`、`main.ts`、`chrome.ts`、`zhihu-chrome.ts`、`zhihu-dom.ts`（均在桌面 `src/`） |
| Web 异常留痕 | `apps/web/src/view/pages/AgentPage.tsx`、`zhihu-login-incidents.tsx` |
| 商品能力回执 | `apps/server/src/modules/agent/desktop-capability.ts`、`operations.ts` |
| 内置技能 | 保留 `apps/connector-desktop/skills/` 下原有三份技能；数据采集和商品上架准备新增按当前 MCP 工具清单执行的分支，视频送审技能未改动。 |

## 验证来源

**隔离副本 `.local/mcp-lab-Lh53qf` 的原有实测**：见同目录 [README](README.md) 与隔离副本 `docs/zhihu-login-failure-lab.md`。此前同一台 Mac 上两个独立配对的 Electron Worker 用各自 Chrome 配置访问知乎官方页面，分别观察到真实登录阻塞；错误设备领不到任务，指定设备自动领取并签名报告，Web 刷新后仍有记录。没有登录后的本人统计实测，不代表物理双机或真实发布通过。未把实验 SQLite、浏览器配置、凭据、脚本或运行记录移植到主仓。

**主仓本地**：新建隔离工作区，真实 MCP 与本机签名请求，两套独立测试密钥和设备。Chrome 平台结果使用夹具模拟：A 回报 `blocked/login_required`，B 回报本人可见统计 `0` 与 `获得 12 次赞同`。MCP 读回精确值，Web Agent 初次打开及刷新均匹配 A 的任务、设备和时间；错误设备无任务。实际商品上架工具返回 `unsupported/product_listing_not_supported`，同幂等键重试及按 ID 读回一致，队列依然为空。未访问真实知乎账号、未在平台写入、未部署或推送。

- `SMARTSELL_E2E_PREVIEW=1` 定向运行 `tests/web-e2e/worker-onboarding.spec.mjs`：5 项通过，包括工具发现、两台签名设备、模拟回填、Web 留痕及原 onboarding 回归。
- `apps/server/src/modules/account/account.test.ts`、`apps/server/src/modules/commerce/worker-catalog.test.ts` 与 `tests/connector-desktop/` 的定向套件：覆盖错机、签名重放、过期租约、报告重试、急停、与发布互斥、Chrome DOM 识别、技能安装。PostgreSQL 商城回归 2 项未运行。最终桌面定向验证 37 项通过（含 3 项技能导出测试），包括活动租约阻止本机领取其他任务和安装更新。
- `apps/server/src/integration/agent-connections.test.ts` 与 `apps/server/src/modules/planning/publishing.test.ts`：34 项通过，包括 MCP 不得替代人工决定。
- `pnpm build` 构建桌面和 Web、检查主仓类型；`docker build -f infra/Dockerfile -t smartsell-main-integration-local .` 构建本地服务端镜像。未制作正式签名安装包，未推送。
