# AC 接入与验证

## 主 API 的 `Commands` 契约

`src/registry.ts` 自动发现 `modules/account/index.ts` 的具名 `commands`。生产宿主可用 `register(registry, 'account', createAccountModule(services).commands)` 注册配置版，每个实例只注册一次。通过 `/api/v1/workspaces/:wid/commands/account/:action` 执行，使用工作区会话与 `Idempotency-Key`。`register_account` 需要工作区内的 `workspace.brand`。`check_capabilities` 接受 `{target: 'social_account' | 'store_connection', id}`。`record_manual_result` 返回 `verified: false`，平台核实由 EX 独立完成。

- `start_oauth` 接受 `provider`、`brand_id` 和可选 `platform_app_id`。`services.oauth.configure` 解析获批官方应用、授权 origin、固定回调和最小 scope。Shopify 需要租户 custom app 和当前固定出口白名单核验。宿主按 state 哈希定位工作区并在事务中调用 `internal.completeOAuth`。state 有效期十分钟，PKCE verifier 加密保存。`exchange` 负责官方交换、回调校验及身份探测，`saveCredential` 按租户、工作区、连接 ID 和授权版本保存，并与授权原子提交或在提交后激活暂存版本。
- 商品目录 worker 可调用 `internal.resolveStoreCatalog`，按工作区连接、凭据版本、scope 和审批重新计算官方唯读能力。
- EX 可调用 `internal.resolveOfficialConnection`，传入冻结的内部账号 ID、外部身份、provider 和 `publish`、`upload_draft` 或 `observe`。解析器按最新授权版本、scope 和到期时间重新检查。`account.connection.revoked` 的消费者须回收该版本凭据、阻塞尚未提交的任务，并安排平台撤权。已有外部引用的尝试可经仍有效的只读授权核实。EX 的 `bindPlatform` 默认走 `publish`。TikTok 收件匣需要宿主把 `platform_operation: 'upload_draft'` 写进获批的冻结任务。平台返回收件匣交付时，EX 保持待核实。
- 管理员调用 `create_pairing_code`，用户用本地 Ed25519 密钥证明持有。宿主在工作区事务中调 `internal.finishPairing` 完成一次性兑换。配对后的网关调用 `dispatchDevice(ctx, request, rawBody)`，签名覆盖 `deviceCommandBytes`。时间为 UTC ISO，允许偏差 30 秒。nonce 与签名使用无填充 base64url，JSON 请求体上限 8 KiB。宿主使用独立事务请求 ID，避免应用层幂等缓存绕过设备撤销，并按有效期清理 nonce。
- 移动绑定需要 `mobile_device_id` 和 `owned_mobile_confirmed`。`connectorCompatibility` 核对配对电脑、手机、App 绑定、兼容性与签章。`authorizeJob` 核对冻结任务、已批准工作流和用户发起记录。签名租约由宿主密钥签发。临提交许可在事务内保留和一次性消费。停机解除后之前保留的许可失效，本地动作仍由本人决定并执行。
- `terms` 提供法务定稿的当前 `zh-Hant` 和 `en` 全文，版本更新后由宿主调用 `internal.recheckTerms`。`license` 提供工作区额度，启用后缺记录或达上限返回 `402 LICENSE_UNAVAILABLE` 或 `402 LICENSE_LIMIT`，部署方负责跨工作区配额与唯一性。OP 用规则 ID 调 `internal.setOpsHalt` 逐工作区落地。

## 扁平记录兼容入口

`Operation[]` 与 `Commands` 使用不同记录格式和设备签名域，每个工作区选用一套账户存储和宿主入口。以 `operations` 接入工作区路由。生产宿主使用 `createOperations(services)` 注入平台适配器、回调 URI、KMS 交付的 32 字节密钥、现行条款、兼容性判定与经过验证的交互式会话来源。敏感操作要求可信会话来源，管理员角色本身不足以通过此检查。`mountAccountIngress` 提供 OAuth 回调、Webhook、配对、设备身份、领取、提交许可及回报路由，可通过本地 Fastify 测试运行。默认服务配置保持关闭。

- `GET /platform-catalog` 返回静态声明与分期。`GET /social-accounts/:id/capabilities` 按已关联身份探测。`GET /connections/:id/capabilities` 返回店铺连接的逐项诊断，多店铺连接须带 `external_account_id`。接口在工作区前缀下，授权连接诊断限管理员。适配器、权限或身份无法验证时，状态保持 `unverified`。手工登记、变更品牌和授权起始均校验工作区品牌。
- 撤销预览返回受影响的社媒账号、EX/连接器尝试和店铺 ID。撤销立即清除本地加密凭据并撤销账号关联。Shopify 固定出口的授权配置会在使用或刷新凭据时再次检查。
- Webhook 用原始字节验签。签名有效后，处理只匹配当前工作区内活跃授权所证实的账号。Shopify 路由须绑定独立的 custom app 和店铺，因 Shopify HMAC 不包含店铺请求头。事件只触发读回，已提交的发布由 EX 核实。
- 新版连接器同时报告尝试 fence 和写槽 fence。旧客户端只发送尝试 fence 时走兼容路径。许可已消费后收到阻塞报告会保留为 `outcome_unknown`，本地挑战仍进入人工阻塞队列。

## 验收覆盖

| 项目 | 已实现与剩余工作 |
| --- | --- |
| AC01 | 工作区账号目录、品牌与负责人字段、provider 稳定 ID 去重、授权账号选择、停用影响预览。跨工作区去重和 SaaS 额度需要 OP 与持久化约束。 |
| AC02 | OAuth state 单次消费、PKCE、身份发现、AES-GCM 凭据、本地撤销与续期。私有部署的 Shopify 商家自建应用走 `/connections/shopify/merchant`，以固定出口配置和店铺身份核实为前置条件。SaaS 由运营发放 Shopify custom distribution 安装链接。生产需接入应用注册、回调索引、续期调度和上游撤权。 |
| AC03 | 平台目录、授权和账号身份探测、执行器解析。启用生产适配器须提供获批权限。 |
| AC04–AC05 | 一次性配对码、Ed25519 持有证明与请求签名、心跳过期、独立账号会话、移动设备及 App 确认、提交前身份核对。宿主需配置设备索引和 OS 钥匙圈。 |
| AC06–AC07 | 阻塞、紧急停止、条款版本检查与重签、连续自动失败触发停止。工作区账号安全页提供影响预览、迁移排空及复验、独立设备撤销和手机 App 解绑指引。迁移后以辅助模式启用目标，未核实结果继续绑定原尝试。实体验收见 `docs/acceptance/account-migration-results.md`。 |
| EX01–EX02 | 冻结修订与素材 SHA-256、审批绑定、提交前重新核对。生产 PL/EX 注入实际审批、商品、市场与素材约束。 |
| EX03–EX04 | 双 fencing 字段、账号与手机版径互斥、时区窗口和三态许可、临提交单次消费。EX 宿主接管迟到策略、延后释放与再取得槽、租约续期。 |
| EX05–EX06 | 回执、证据、未知结果锁定及原尝试核实。生产 EX 消费结果事件和执行独立核实。 |
| EX07–EX08 | 目录按平台标示修改／删除状态，连接器提供人工接管和 TikTok 收件匣回退状态。EX 创建后维护请求及关联交接记录。 |

## 分期与进入生产的条件

| 平台 | 分期与门槛 |
| --- | --- |
| Instagram、Facebook | P0a 获批专业账号／粉专的官方 API。媒体中继、Meta 审核、账号权限和配额须单独确认。P0b Android 可作为欠缺官方能力时的备援，iPhone P1。 |
| TikTok | P0a 上传创作者收件匣。P0b Direct Post 需要审计及显式选择可见性。P0b Android 完成同一已交付草稿，P1 iPhone。数据 API 需要权限审批。 |
| YouTube | P0a 上传及读回，P0b Analytics／留言按权限接入。须验证上传审计和配额，续传调度尚待接入。 |
| 抖音、小红书 | 抖音官方能力依资质和按帖同意。小红书通用创作者发布 API 标记未核实。P0b PC 或 Android 连接器路径，P1 iPhone。手机评论采集及回复保留到 P1 验证。 |
| TikTok Shop、Shopify | P0a 商品文件导入，P0b 商品唯读同步，P1 订单及退款。Shopify 每客户一个 custom app，需固定出口及白名单确认。TikTok Shop 推播签名仍需官方验证。 |
| Amazon、Shopee、Lazada | P1 Amazon 先行，使用非受限 SP-API 角色及最小字段。跨区域市场和通知另行验证。Shopee 在 Shopify／TikTok Shop 上线后申请 ISV ERP System，订单和退款仍待接入。Lazada 文件导入及 API 均为 P2。 |

D1 使用最小必要字段，D2／D14／D16–D19 由上表覆盖。D3／D12 的工期依 V0 审核结果估算。D4／D15 需要经过法务定稿且版本化的风险条款。D5／D13 的 `zh-Hant` 与 `en` 属于界面装配。D6–D9 由 IAM、部署、计量及 AI 路由宿主处理。D10 的原始响应、审计和证据保留由 OP 策略执行。D11 产品名为 SmartSell。D20 支持 Windows／macOS。D21 Android 为 P0b，iPhone 为 P1 且限 macOS 和有效开发者签章。两条手机路径都依赖客户自有实机的明确配对和平台授权。

## 法务验收

D15 条款需涵盖平台处置风险、客户对发布内容和授权的责任、账号与实机归属、频率和时段限制、三层急停、自动停止与管理员重启。明确禁止规避平台风控、代解挑战、收集凭据、指纹改造和任意设备命令。说明设备解绑与撤权、证据脱敏和保留期限，以及客户签章的责任和到期处理。条款发布时同步更新版本并通知管理员重签。已发生的提交按原尝试继续核实。条款样例仅用于离线测试，法务定稿和平台审核由实际部署方验收。

## 宿主接线

- 事务应按工作区序列化，并对 OAuth、配对码、设备 nonce 和提交许可做唯一约束。工作区由状态哈希或可信设备／Webhook 索引定位。原始请求体、OAuth code、配对码及签名头从日志中排除。
- EX 提供 `authorizeTask`，检查审批、冻结哈希、活跃执行和写入槽。设备领取可签名传入 `binding_id`，限制到该设备下的单个绑定。在尝试进入待核实后，使用 `reconcileConnectorTask` 记录独立核实，校验成功时传入确认的作品 ID 供素材回收使用。许可延期事件由 EX 处理槽续期和迟到策略。
- 提供 `verifyEvidence`，检查工作区文件所有权、对象类别和 SHA-256。提交或恢复回执至少需一个已登记的脱敏证据对象。准备脱敏截屏与 UI 树，并按保留期限设置回收。连接器结果仅作核实线索。
- Shopify/TikTok Shop/Amazon 的官方读取使用服务端注入的适配器及 `connectionContext`。商业账号由 PC 模块关联。平台的真实资格、配额、API 回执和授权撤销在 V0 环境核对。
- 独立 CLI 和 macOS／Windows 启动器见 `apps/connector/RUNBOOK.md`。仓库中的 Electron 人工交接调用方可继续使用兼容报告。生产安装签名、平台浏览器驱动、受控 Android／WDA 驱动、签章到期监控、WSS 派发和证据上传仍须宿主接线与实机验收。

```sh
pnpm exec vitest run apps/server/src/modules/account packages/adapters apps/connector
```
