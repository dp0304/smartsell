# Campaign 本机验收

验收日期 2026-11-20。范围为 `plan.md` §5.5.12 的 CA01–CA06 和 `docs/acceptance/evidence.json` 对应的本机缺口。

## 重跑

在项目根目录使用 Node 24 和 pnpm。首次运行 Playwright 时可执行 `pnpm exec playwright install chromium`。

```sh
nvm use
pnpm exec playwright test tests/web-e2e/campaign.spec.mjs
node --import tsx --test apps/server/src/modules/campaign/*.test.ts
node --import tsx --test --test-name-pattern='kernel public traffic over a local TCP socket' apps/server/src/integration/traffic-host.test.ts
pnpm typecheck
```

逐条重跑可在 Playwright 命令后加 `--grep '^CA01'`，将编号换成对应条款。测试启动本机 Web 与 API，使用每条测试独立的 SQLite 和随机回环端口，通过默认 `/w/:wid/…` 工作台及实际 `/api/v1/workspaces/:wid/…` REST 路由执行。CA05 的域名验证、点击与商城核销回执由本地 fixture 注入。短链、内容、促销的读取和汇总均经过真实应用代码，公开短链重定向另以本地 TCP 测试覆盖。

## 逐条证据

完整默认工作台浏览器套件 **6/6 通过**，下表每行均为通过。早期并行冷启动运行出现页面加载超时，独立重跑完成全部六项。

| 条款 | 稳定测试名称 | 实际断言 |
| --- | --- | --- |
| CA01 | `CA01 \| Market goals require a unit and deadline and persist under one campaign` | REST 分别拒绝缺单位和缺截止时间的请求（422），无无效目标落库。同一活动保存两个不同市场的子目标，默认工作台保存后重载可分别读回。 |
| CA02 | `CA02 \| Completing a workspace milestone unlocks scheduling and preserves brief history` | 显示新批准版和被取代的 brief 原文。工作台通过 Workspace REST 启动并完成里程碑，显示可排期。制作期限、发布时间和发布目标状态保持，已发布数仍为 0。 |
| CA03 | `CA03 \| Channel matrix counts three accounts for one variant and flags unplanned content` | REST 和浏览器都看到同一变体的三个不同账号目标。无计划且无排期的变体同时显示 `Unplanned` 和 `Unscheduled`。 |
| CA04 | `CA04 \| Budget keeps planned, committed and spent separate and overrun permits other work` | 台账按原币最小单位列示。USD 1,000 计划、600 承诺和 800 实支产生 400 超额及待审记录。TWD 2,700 计划使用独立币种和换算日。超额后仍可从工作台保存活动目标。 |
| CA05 | `CA05 \| Short links and content lead back to one campaign with separate clicks and coupon uses` | 短链保留活动 UTM，短链及内容的详情均可返回同一活动。活动追踪将 1 次点击和 2 次优惠码使用分别显示和读回。 |
| CA06 | `CA06 \| Backfill creates a new report for a closed campaign and templates omit historical prices and rights` | 工作台完成带保留项的结案。补录第二个观测后生成第 2 版报告，数值从 15 更新为 75，原快照与引用不变，活动仍为 `closed`。从活动存为模板后实例化，保留相对时间与计划结构，新活动获得新追踪键，历史价格、授权和原发布目标不会带入。 |

活动领域回归 **20/20 通过**。其中 `closeout computes post goals at publication grain and records unsupported grains as unavailable` 验证作品级目标和不支持指标的覆盖状态，`campaign report backfill uses exact scope and excludes versions generated for another campaign` 验证报表范围与冻结版本归属。`kernel public traffic over a local TCP socket` **1/1 通过**。仓库 `pnpm typecheck` 通过。

## §7.1 跨境新品闭环与 Commands / REST 一致性

2026-11-20 在原工作树以 Node v24.21.0 实跑，目标验收 **2/2 通过**，Campaign 领域回归 **20/20 通过**。两条验收通过正式 Commands 服务的 HTTP 入口执行，使用独立的本机 SQLite、回环端口及合成数据。

```sh
nvm use 24.21.0
node --import tsx --test --test-name-pattern='plan §7\.1|shared business operations preserve' \
  tests/acceptance/launch-campaign.test.mjs tests/acceptance/workspace-http.test.mjs
node --import tsx --test apps/server/src/modules/campaign/*.test.ts
```

- `.local/qa-turn/verify-resume.log` 第 827–832 行的 `undefined.id` 来自旧测试读取 `data.campaign.id`。活动详情将 `id`、`version`、市场、商品和 brief 同层返回，当前测试逐一核对值。原工作树复跑继续到人工回覆后，释放租约因缺少 fencing token 返回 `409 LEASE_HELD`。验收现解析 `application/problem+json` 并核对错误码，再带当前 token 释放并核对 `{ released: true }`。
- §7.1 用同一活动关联 CSV 商品与 SKU、美国和日本市场、审批版 brief、制作里程碑及双语内容。独立审阅人批准发布目标后，验证预检、凭证登记的人工发布、执行尝试、作品评论分派及人工回覆交付。首次报告冻结为 15 次浏览，结案引用该版本。补录后第 2 版为 75 次，重启后读回两个报告版本与原结案快照，活动仍为 `closed`。
- `.local/qa-turn/verify-resume.log` 第 835–850 行的 `0 !== 2` 来自旧测试以 `campaign.updated` 筛选 outbox。正式事件为 `campaign.campaign.updated`，验收按该名称、活动 ID 和提交版本核对恰好两条事件。Commands 与 REST 对同一幂等键复放得到相同资源，同版本并发写入只有一个成功，两个入口读回相同的活动详情和 ETag。用例继续验证角色拒绝、CSRF、跨工作区拒绝，以及重启前创建的业务活动和旧记录仍可从各自入口读取。
- 这次 §7.1 HTTP 验收覆盖人工发布与回覆路径。活动导流另见 CA05 和本轮通过的 Campaign 领域测试。公开 Traffic 路径、真实平台调用和 P1 的创作者及订单结算环节未纳入本轮复跑。
