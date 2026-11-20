# AC07 账号执行位置迁移与设备回收

按 `plan.md` 5.2.12 和构思 AC07 验收。复用账号安全页、工作区会话、AC Ed25519 签名入口及 EX 调度和核实。设备、账号、手机及证据均为隔离的本地测试数据。

| 场景 | 本地结果 |
| --- | --- |
| 影响预览与排空 | 工作区 API 区分排队、已领取、保留核实的任务。开始后源和目标均不能领取新任务。源设备可按原 fence 通过签名核对并回报已领取任务。未排空时完成接口返回 `EXECUTION_DRAIN_REQUIRED`。 |
| 保留原尝试 | 待核实和结果未知均保留原尝试 ID 及源设备。重试返回 `OUTCOME_UNKNOWN`，调度和领取均未重派。未领取并确认未提交的工作可在目标以新尝试领取。 |
| 目标复验 | 测过 Android 元数据迁移至浏览器，以及同一电脑下两部 Android 元数据的迁移。旧身份核对、错误签名、错误设备和账号不匹配均无法完成迁移。目标使用正确签名完成业务身份核对后，管理员可切换执行位置，目标从 `assist` 起步。 |
| 设备与手机回收 | 源设备独立撤销后，其签名心跳和领取立即返回 `401`。手机 App 解绑预览禁止解除当前或迁移目标绑定。迁移后可解除旧绑定并查到 `revoked` 状态，界面提供退出 App 和撤销手机调试授权的操作指引。同宿主迁移只需解绑旧 App 时，宿主仍可用。 |

## 复验

使用 Node.js 24 和仓库现有依赖。

```sh
node --import tsx --test --test-name-pattern='^AC07 ' tests/acceptance/account-migration-http.test.mjs
node --import tsx --test apps/server/src/modules/execution/operations.test.ts tests/acceptance/workspace-access.test.mjs
pnpm exec vitest run apps/server/src/modules/account/account.test.ts apps/server/src/modules/account/commands.test.ts
pnpm exec playwright test tests/web-e2e/account-migration.spec.mjs
pnpm typecheck
```

此前的回归记录包括 AC07 签名 API 2 项、EX 31 项、账号 20 项和工作区访问 7 项通过，`pnpm typecheck` 通过。签名测试使用同一临时 SQLite 的两个 loopback HTTP 监听器，分别运行工作区 API 和现有 `mountAccountIngress`。默认开发启动提供工作区页面和 API，签名设备入口与连接器派发仍需宿主配置。取消 AC07 名称过滤运行整个签名测试文件时，新增的 3 项 D4 测试在开启自动模式时返回 `AUTO_TERMS_REQUIRED`，因此该次运行未覆盖后续许可断言。

## 2026-11-20 Chromium 入口复验

原版两项均在点击 `Account security` 时耗尽 6 秒动作预算。该版本通过 API 建立拥有者会话，预写语言后直接加载工作区首页。两次超时均从真实页面采样，`page.url()` 分别为 `http://127.0.0.1:53033/w/56d338a0-0cc1-4b0b-b7a7-f79e1ba5e382/home` 和 `http://127.0.0.1:54786/w/531ce3ea-06a7-450e-a626-f1be88a649d4/home`。文档和已完成的 Vite 脚本请求返回 `200`，`html lang` 仍为初始 HTML 的 `zh-Hant`，可见导航为空，应用未发出 `GET session` 和 catalog 请求。独立的冷启动探针中，首页 HTML 到达后 6 秒仍无导航，Vite 这次在导航开始后约 9.9 秒才发出首次应用 `GET session`。入口的间歇性取决于应用何时完成冷加载，文档 `200` 早于 React 工作区挂载。

用例修正限定在 `account-migration.spec.mjs`。隔离的本地 SQLite 使用现有夹具配置普通 `admin`，浏览器从 `/` 进入登录页，等待登录表单实际渲染，提交真实登录，再等待 catalog 驱动的「今日營運」标题。随后验证繁中安全链接，通过页面语言控件切换英文，点击同一个可访问入口并断言 URL 和恢复区可见。登录表单的可见性断言允许冷启动所需时间，后续操作仍使用原配置。`securityAvailable` 依赖 TOTP 数据、用户 ID 和 CSRF，`recoveryAvailable` 依赖工作区 `owner`/`admin` 和 CSRF。当前启动器的 TOTP 返回 `404`，实测恢复入口由 `recoveryAvailable` 提供。迁移、解绑和撤销仍保留原有权限及确认条件。

真实浏览器探针从 `http://127.0.0.1:63568/` 进入 `http://127.0.0.1:63568/login`。登录后 `page.url()` 为 `http://127.0.0.1:63568/w/e55a3c0e-199c-404e-b7e9-106b3f201974/home`，切换语言时 URL 不变，`html lang` 从 `zh-Hant` 变为 `en`。点击安全链接后 `page.url()` 为 `http://127.0.0.1:63568/w/e55a3c0e-199c-404e-b7e9-106b3f201974/settings/security`，`html lang=en`，恢复区可见。目录内实测可见项如下，目标均以 `/w/e55a3c0e-199c-404e-b7e9-106b3f201974` 为前缀。

| 繁中名称 | 英文名称 | 角色 | 目标后缀 |
| --- | --- | --- | --- |
| 營運總覽 | Overview | link | `/home` |
| 品牌與工作區 | Brands & workspace | link | `/settings/brands` |
| 行銷活動 | Campaigns | link | `/campaigns` |
| 商品與市場 | Commerce | link | `/commerce` |
| 內容工作台 | Content studio | link | `/content` |
| 發布日曆 | Publishing calendar | link | `/calendar` |
| 執行監控 | Execution monitor | link | `/execution` |
| 統一收件箱 | Inbox | link | `/inbox` |
| 數據與報告 | Analytics & reports | link | `/reports` |
| 素材中心 | Asset library | link | `/assets` |
| 情報研究 | Research | link | `/research` |
| 達人合作 | Creator partnerships | link | `/creators` |
| 導流與線索 | Traffic & leads | link | `/traffic` |
| 廣告管理 | Paid advertising | link | `/ads` |
| 生命週期行銷 | Lifecycle marketing | link | `/lifecycle` |
| 採集與匯入 | Data & imports | link | `/data` |
| AI 與自動化 | AI & automation | link | `/automation` |
| 帳號與裝置 | Accounts & devices | link | `/settings/accounts` |
| 成員與交付 | Team & delivery | link | `/settings/members` |
| 系統管理 | System administration | link | `/settings/ops` |
| 帳號安全 | Account security | link | `/settings/security` |

| 探针请求 | HTTP | 浏览器观察 |
| --- | --- | --- |
| 首次设置（独立请求上下文） | `201` | 配置隔离工作区 |
| `GET /` 和 73 个脚本响应 | `200` | 首页文档先到达，之后挂载应用 |
| 登录前 `GET /api/v1/session` | `401` | 角色 `[]`，CSRF `false` |
| `POST /api/v1/session` | `200` | 登录后转到工作区首页 |
| 登录后 `GET /api/v1/session` | `200` | 工作区角色 `admin`，响应内 CSRF `false` |
| `GET /api/v1/session/csrf` | `200` | CSRF `true`，SDK 将其合并至应用会话 |
| 工作区 `GET /commands`、`/catalog`、`/overview/today` | `200` | catalog 加载完成，繁中及英文首页标题均已渲染 |
| 工作区 `GET /social-accounts`、`/devices`、`/mobile-devices`、`/mobile-app-bindings` | `200` | 点击安全链接后加载恢复区数据 |
| `GET /api/v1/auth/totp`、工作区 `GET /stream`、`GET /favicon.ico` | `404` | 控制台报告这些请求以及未登录会话的 `401` |

控制台另有 Vite 连接状态、React DevTools 和 i18next 信息，无 `pageerror` 或失败的网络传输事件。会话取证仅记录角色、状态码和 CSRF 存在布尔值。

用 Node.js 24.21.0 和当前 `localDev` → `dev-host.mjs` 启动器，独立执行三次 `pnpm exec playwright test tests/web-e2e/account-migration.spec.mjs --retries=0`。每轮用不同的 Playwright 输出目录，每个用例新建浏览器上下文、应用进程、回环端口、SQLite 和 Vite 缓存。

| 轮次 | 迁移预览、开始及拒绝无新身份核对的完成请求 | 手机解绑及设备撤销 | 总耗时 |
| --- | --- | --- | --- |
| 1 | 通过（22.2 秒） | 通过（12.8 秒） | 37.6 秒 |
| 2 | 通过（9.5 秒） | 通过（27.4 秒） | 37.8 秒 |
| 3 | 通过（20.4 秒） | 通过（19.7 秒） | 43.2 秒 |

三轮均从真实导航进入恢复区，合计 6/6 通过。迁移预览返回 `200`，缺少新身份核对时完成请求返回 `409 FRESH_IDENTITY_CHECK_REQUIRED`，迁移仍为 `draining`，并保留待核实任务。手机解绑和设备撤销均验证了确认前按钮禁用、操作后的 UI 反馈及 API 读回状态。

## 合并源码的签名派发复验

Claude Code CLI `2.1.311` 修改了 HTTP 夹具，测试使用 Node `v24.21.0`。固定快照 `ad5eaed4000ddac6360ca726d473e2f7dbf2870e2890881f2c5a71208d76a393` 的日志记录了 9 项本文件失败及 1 项 OP10 失败。改动前在当前合并源码上执行 `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"`，再运行 `node --import tsx --test tests/acceptance/account-migration-http.test.mjs tests/acceptance/operations-authorization.test.mjs`，复现相同 10 项失败，另有 5 项通过、0 项跳过。 [固定快照日志，第 690–865 行](../../.local/qa-turn/verify-combined-log.eTL1u7#L690) · [本次基线](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/http-baseline.log)

原夹具的 `ROLE=all` 启动宿主后台循环。循环由真实计时器和写入通知触发，宿主发布派发器读取部署级连接器审批，与测试显式驱动的签名 worker 竞争同一队列。未配置宿主审批时，先派发的任务可能进入 `manual_fallback`，从迁移的排队视图消失，后续签名领取也会拿不到任务。媒体角色负责媒体队列，发布 drain 仍由 worker 角色控制。夹具改为仅开启 API，保留临时 SQLite、独立签名入口、Ed25519 校验、原测试时钟及任务授权。 [夹具](../../tests/acceptance/account-migration-http.test.mjs#L27) · [后台循环](../../apps/server/src/runtime.ts#L149) · [宿主派发](../../apps/server/src/integration/publish-host.ts#L56)

```sh
qa="$PWD/.local/qa-turn/publish-connector-regression.pf4Z6wmp"
test_path="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
env -i PATH="$test_path" MEDIA_DIRECTORY="$qa/media" node --import tsx --test tests/acceptance/account-migration-http.test.mjs tests/acceptance/operations-authorization.test.mjs
env -i PATH="$test_path" HOME="$HOME" MEDIA_DIRECTORY="$qa/publishing-media" bash tests/acceptance/publishing-integrity.sh
env -i PATH="$test_path" HOME="$HOME" pnpm typecheck
```

完整 HTTP 套件连续两次各 15 项通过（账号迁移 12 项、Operations 授权 3 项），0 项失败、0 项跳过。签名领取仍为必过断言，覆盖迁移排空、旧设备 fencing、账号写入槽、保留原尝试待核实、自动许可频率和时窗、每日上限及超过宽限期须明确决定。`publishing-integrity.sh` 使用缓存的 `postgres:17-alpine`，3 项通过、0 项失败、0 项跳过。类型检查退出码为 0。 [HTTP 日志](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/http-after.log) · [PostgreSQL 发布完整性日志](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/publishing-integrity.log) · [类型检查日志](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/typecheck.log) · [AI05 与 OP10 复验](operations-authorization-results.md)

## D4、D21 与实体验收

- D4 的账号级风险确认、限额、时段、急停及提交后核实继续使用现有机制。迁移目标以辅助模式启用，重新使用自动模式须遵循现有管理员确认和条款流程。法务条款、平台允许范围和实地自动执行需部署方验收。
- D21 的当前 CLI 支持 Windows/macOS 的交互式连接器和 Android 人员辅助流程。Android 为 P0b，iPhone 为 P1 且需要 macOS 宿主和客户有效开发者签章。连接、解锁、App 内身份核对、真实发布与平台读回、手机端调试授权撤除及 iOS 签章需在客户自有实机上验证。抖音和小红书的手机评论能力仍待评估。
