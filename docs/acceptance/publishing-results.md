# 发布链路本地验收交接

范围为 `plan.md` [§5.7.12 CO](../../plan.md#L4113)、[§5.8.12 AS](../../plan.md#L4491)、[§5.9.12 PL](../../plan.md#L4916) 和 [§5.10.12 EX](../../plan.md#L5498)。外部账号的实测门槛见 [gates.md](gates.md)。

## 复现环境

在仓库根目录使用 Node.js 24.21.0 和 pnpm 10.11.0。浏览器命令使用项目 Playwright 配置和 Chromium。`localDev` 启动实际 Vite 工作台和 SmartSell API，等待健康检查通过，使用隔离的 SQLite 文件。测试通过正式 HTTP 路由建立数据并重新获取持久状态。PL08 在该隔离数据库中初始化两条模拟的平台受理回执，随后通过正式接口暂停、核实和读回。平台契约测试把请求送入生产适配器的注入传输层，使用合成凭证与响应。

```sh
pnpm exec playwright install chromium
pnpm exec playwright test tests/web-e2e/publishing-price.spec.mjs
node --import tsx --test tests/integration-contract/publishing-price.test.ts
```

## CO04 商品事实与价格变更

- **兼容工作台本地通过。** 通过正式命令创建品牌、市场、店铺与商品，记录 USD 1000，再提交带原快照引用的 `Cup costs $10.00`。记录 USD 1200 后，浏览器打开并刷新真实的内容工作台。重新读取变体应得到 `readiness: stale`、同一个 `current_revision_id` 和 `{ kind: 'listing_changed', ref_id: first.id }`。重新取回原修订，比较整个对象相等。见 [Chromium 用例](../../tests/web-e2e/publishing-price.spec.mjs#L7)。
- **Operations 后台本地通过。** 走实际挂载的 `/variants/:id/listings` 与 `/content-items/draft`，轮询正常读接口等待 worker 消费 outbox，确认从 `draft` 变为 `stale`、原修订与 `ref_id` 保留。见 [后台用例](../../tests/web-e2e/publishing-price.spec.mjs#L61)。
- **Shopify 契约通过。** `read_products` 绑定请求用合成店铺凭证进行两次各一页的刷新。校验官方 GraphQL 路由、鉴权头、游标和价格字段，checkpoint 成功并保存 USD 1000 → 1200。旧快照失去 current 标记，已注册的内容处理器只更新变体状态，原修订对象完全相等。重放同事件后版本号不增长。见 [契约用例](../../tests/integration-contract/publishing-price.test.ts#L14) 与 [Shopify 官方 products 查询](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)。
- **平台待验。** 在已授权的 Shopify 或 TikTok Shop 测试店铺变更商品价格。保留真实采集批次 ID、原快照和新快照 ID、自动触发得到的 `stale` 结果与原文比较。平台权限、商家数据和同步时延需在该环境验证。

## CO 内容制作

```sh
node --import tsx --test apps/server/src/modules/content/content.test.ts
node --import tsx --test --test-name-pattern='A01|CO03' tests/acceptance/flows.test.mjs
pnpm exec playwright test tests/web-e2e/operator.spec.mjs --grep 'CO02 CO03 CO05 CO06 CO08'
```

| 条目 | 精确断言 | 外部验收条件 |
|---|---|---|
| CO01 | 同一选题转出的两项内容拥有不同 ID，两项均引用原 `idea_id`。 | — |
| CO02 | 工作台显示阻塞原因。拖动卡片后位置与服务器的制作阶段一致，发布目标列表为空。 | — |
| CO03 | Instagram、TikTok 变体分别保存和取回；预览有近似标识；TikTok 缺隐私、商业揭露时显示阻塞；真实 MCP 工具入口拒绝代选。 | 有直接发布审核的 TikTok 账号，核对实际可选隐私和披露组合。 |
| CO04 | 见上节。 | 授权商家改价全链路。 |
| CO05 | 原稿更新后法语和日语都显示待重审。手工保留法语市场改写后，再改母稿会重新进入待重审。两份译文各自的修订 ID 和文案保持原值。 | — |
| CO06 | 编辑预览对不支持的字幕、替代文字逐项告警，保留输入；未就绪衍生素材会阻断标记 ready。 | 目标平台逐个核对实际字幕与 alt text 的支持范围。 |
| CO07 | 恢复生成独立新修订；仅恢复即使旧批准失效，目标回 `draft` 并清除冻结及批准引用，旧批准入列返回 409。 | — |
| CO08 | 可见原内容及原修订血缘，复制进全新草稿；域测试核验撤销授权素材剔除、使用最新商品事实或快照、清空 TikTok 人工选择且需重审。作品维护结果由 EX 核实后显示。 | 在实际账号外改作品，通过 EX 读取并核验更改，再从内容详情重读。 |
| CO09 | RSS 重导去重，来源保留，导入本身没有授予转载权或创建正式内容。 | 已授权来源可单独核对真实 feed。 |

## AS 素材与知识

```sh
node --import tsx --test apps/server/src/modules/asset/asset.test.ts apps/server/src/modules/team/team.test.ts tests/media/files.test.mjs
pnpm exec playwright test tests/web-e2e/asset.spec.mjs
```

| 条目 | 精确断言 | 外部验收条件 |
|---|---|---|
| AS01 | 改名或移动资料夹后，反向查询仍指向原内容。 | — |
| AS02 | 删除就绪目标引用的已归档素材返回 `ASSET_REFERENCED`，保护版本保持原值。衍生失败和重试保留原件。 | — |
| AS03 | 同工作区两品牌中只返回请求品牌。有效正文附修订号 1，提议正文附修订号 2，并分开返回。 | — |
| AS04 | 动态快照 USD 2000 改为 2500 后，旧绑定提交返回 HTTP 409 `TEMPLATE_VALUES_CHANGED`，重新套用当前值后可提交。服务端还验证促销过期时拒绝提交，失败时不建立修订。 | 商家实时价格与促销状态按 PL04、EX02 的授权门槛读回。 |
| AS05 | 到期时刻即失效。错误渠道、地域、用途或版本均阻止授权。到期授权阻止自然发布排期提交和付费提案提交，两条路径均无新审批或执行操作。 | — |
| AS06 | 投稿待审核时素材库没有正式资产，接收后仍为草稿授权。相同分享令牌下载文件返回 200，提交发布目标返回 401。 | — |
| AS07 | 观察外部新版本和明确导入新版本后分别读回批准目标，原冻结版本保持不变。 | 已授权的 Canva 或云端来源取回实际新版本，核对批准目标继续引用原文件。 |

## PL 发布计划

```sh
pnpm test -- publishing.test.ts planning.test.ts
node --import tsx --test --test-name-pattern='PL05' tests/acceptance/flows.test.mjs
pnpm exec playwright test tests/web-e2e/operator.spec.mjs --grep 'PL01|PL07|PL08|PL09'
pnpm exec playwright test tests/web-e2e/portal.spec.mjs --grep PL06 --repeat-each=2
```

| 条目 | 精确断言 | 外部验收条件 |
|---|---|---|
| PL01 | 通过人工执行入口报告结果未知后，Chromium 日历网格同时显示排程的 `Outcome unknown` 和独立的制作期限。重读任务及目标均为 `outcome_unknown`，作品列表为空。 | — |
| PL02 | DST 春季不存在的时间须明确处理，秋季重复时间给出两种选择。周期生成独立目标，重跑去重并排除例外日期。 | — |
| PL03 | 同一幂等键重送去重；批次失败按目标可读，原子入列拒绝时不残留批准。 | — |
| PL04 | 已批准后撤销连接使临近执行预检失败；身份核对失败无提交。 | D14/D17 商家读回，D21 真机绑定、签名、设备离线、可用时段与限额。 |
| PL05 | 更换正文修订触发批准失效并禁止入列；角色和 MCP 凭证不能代写人工审批。 | — |
| PL06 | 客户门户在修订更新前可批准。刷新旧链接后，保留原文和对外反馈，显示版本已更新，隐藏内部备注、替代正文和审批按钮。读接口返回 `stale` 与 `approve: false`，旧链接批准返回 409，原审批因 `content_revision_changed` 失效。见 [门户用例](../../tests/web-e2e/portal.spec.mjs#L85)。 | — |
| PL07 | 授权契约校验实际 Account OAuth 路径、Meta Graph v24 Page token、`GET /1234/scheduled_posts` 与游标。唯一候选仅高亮；0.9 同分候选保持不确定、没有写入或关联。工作台对未授权 Page 显示 409，重读无本地认领记录。 | 已授权 Facebook Page 使用实际 `pages_manage_posts` 和 `pages_read_engagement` 读取现有排程。核对原计划未被覆写和候选未被自动认领。当前契约范围限 Facebook Page。 |
| PL08 | 回归用例验证暂停阻止提交。工作台暂停详情显示两条原生排程撤回，一条待核实，另一条提交独立缺席证据后为已取消。按目标 ID 复读两种状态，作品列表为空。注入执行器的契约用例还确认撤回响应丢失后只发送一次，独立证据确认后才取消。 | 默认运行时目前依赖人工核实。平台撤回适配器的生产挂接和真实平台逐条读回仍待验。 |
| PL09 | 到期的常青项自动退出，尚未发送的任务退场。母稿新修订后，同一排程目标生成新冻结 hash 和批准。浏览器展开发现过期槽位已排除并取回新批准。 | — |

## EX 发布执行

```sh
node --import tsx --test apps/server/src/modules/execution/operations.test.ts apps/server/src/modules/execution/workflow.test.ts
pnpm --filter @smartsell/connector test
pnpm exec playwright test tests/web-e2e/operator.spec.mjs --grep 'EX03|EX07'
```

| 条目 | 精确断言 | 外部验收条件 |
|---|---|---|
| EX01 | 错 hash 无法建任务。母稿改写后重读已排程任务，原冻结内容和 hash 保持相等。 | — |
| EX02 | 准备后商品事实漂移，提交入口把目标退回重审，适配器未收到提交。 | 授权商家实时停售或改价后从预检入口读回。 |
| EX03 | 模拟连接器中断两小时后按 `skip`、`notify` 或 `grace_window` 恢复。工作台显示等待迟到决策并隐藏人工接管。操作员选跳过后，读回任务 `expired`、零尝试、原时区与目标 `closed`、`expired_skipped`。 | 实际绑定装置断开、恢复与通知到达。 |
| EX04 | 同账号排他；自动许可按 `retry_at` 续申只消费一次，紧急停止压制自动提交，人工操作记 `human`。 | D21 同真机排他、媒体库可见性、签名、账号核身、进入人工接管。 |
| EX05 | 提交后断线隔离未知状态；读取确认后同一作品绑定原任务，提交计数为一。 | Android TikTok 收件箱按真实 `publish_id` 查证，不重复完成、上传或跨路径。 |
| EX06 | 未发送租约超期仅安全重试；已提交租约过期保留结果核实，迟到回执关联原尝试，`verified_absent` 之后才允许重新排队。 | 实机进程中断和上传会话恢复。 |
| EX07 | 工作台提交编辑结果时，缺少匹配的平台读回文案返回 HTTP 422，重读操作仍待处理。回填匹配文案和证据后，重读操作为 `verified`。证据确认删除后，仍可读回原始发布、编辑与删除快照和原有指标序列，浏览器显示指标值 42。执行用例还核对原冻结载荷和执行尝试。见 [维护契约](../../apps/server/src/modules/execution/operations.test.ts#L570) 和 [工作台用例](../../tests/web-e2e/operator.spec.mjs#L723)。 | 当前编辑与删除使用人工凭证回填。平台自动维护的账号权限、接口、异步读回及审计仍待验。 |
| EX08 | 未知结果禁止切换到人工或其他路径，直到证据确认。人工证据关联原目标。 | 在受控手机与浏览器实际切换并检查装置状态。 |

## 汇总检查

```sh
pnpm test -- publishing.test.ts planning.test.ts execution/operations.test.ts execution/workflow.test.ts content/content.test.ts asset/asset.test.ts team/team.test.ts publishing-price.test.ts flows.test.mjs files.test.mjs portal-http.test.mjs
pnpm exec playwright test tests/web-e2e/operator.spec.mjs tests/web-e2e/asset.spec.mjs tests/web-e2e/publishing-price.spec.mjs --grep 'CO02 CO03 CO05 CO06 CO08|CO04|AS03 and AS04|PL01|PL07|PL08|PL09|EX03|EX07'
pnpm exec playwright test tests/web-e2e/portal.spec.mjs --grep PL06 --repeat-each=2
```

- 定向回归通过 112 个 Node 测试和 27 个 Vitest 测试。两个 Node 用例分别因 PostgreSQL 公共路由环境与隔离 MinIO 环境未启用而跳过。工作台 Chromium 10/10，独立客户门户重复跑 2/2。
- 全量 Chromium 首轮 23 通过、1 失败。登录用例在重载时丢失未使用的响应正文，单独重跑 3/3 通过，移除正文读取后全量复跑中的登录用例通过。复跑共 24 通过、2 失败，失败项是 1280 px 操作台诊断测得 1288 px 内容宽度，以及 `primary.spec.mjs` 在收集后发生并行修改导致 WS06 找不到用例。发布范围用例在两次全量运行中均通过。布局诊断和当前 WS06 的定向复跑通过 2/2。
- `pnpm typecheck` 最近一次通过。`pnpm requirements` 最近一次提示 `docs/acceptance/matrix.md` 过期，生成矩阵交证据负责人随最新 `evidence.json` 一并更新。
- 浏览器使用独立测试工作区和本地模拟回执。平台契约和设备模拟的结果按上表登记，实际账号与装置的验收条件仍见对应行。

证据负责人可按本页的复现命令和断言更新对应 `evidence.json` 和生成矩阵。
