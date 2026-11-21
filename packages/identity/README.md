# 身份扩展接线

## 注册和核心会话

在 `apps/server/src/app.ts` 的 `buildApp` 注册 `registerEnterpriseIdentity(app, options)`，把返回的钩子传给核心 `auth`。`options.deployment` 由服务端部署配置选择。`private` 只注册 TOTP。`saas` 提供 `enterprise` 时注册 OIDC、SAML 和 SCIM。应用启动时保证 `origin` 与配置中的公共 origin 一致。

- 核心密码登录先完成现有账号状态、节流和密码校验，再调用 `afterPassword({ accountId, credentialVersion })`。返回 `required: true` 时只返回短期 challenge，此时不可写 session 或 cookie。客户端将 challenge 与一个二级凭证交给 `POST /api/v1/auth/totp/challenge`。凭证失败会消耗本次 challenge，重试须重新走密码入口。
- `core.issueMfaSession` 收到验证通过的账号 ID、密码凭证版本、因子 ID 和验证方式后调用核心发行器。核心须在发行时检查账号状态和密码版本，使用返回的 `factorId(accountId)` 比对当前因子。首次启用、撤销因子和 session 发行应使用同一个账号锁或等效事务协调机制。常规密码直接发行路径也要在此保护下确认当前无 TOTP，避免首次启用与密码登录竞争。
- `core.withReauthenticatedAccount` 用现有 cookie session 找到账号，对同一账号重验密码并应用核心密码节流，在保护账号安全配置的锁内执行回调。可用端点为 `POST /api/v1/auth/totp/enroll`、`/confirm`、`/revoke`、`/recovery/revoke`。完整路径均以 `/api/v1/auth/totp` 为前缀。注册与确认返回的 `otpauth` URI 和恢复码属于用户敏感数据。响应带有 `Cache-Control: no-store`。
- 现有 `onRequest` 可用 `enterpriseIdentityOwnsRequestGuard(request)` 决定是否调用核心浏览器 CSRF／JSON guard。这个路由元数据只标记 SSO 启动、SAML ACS 和 SCIM。启动路由自行检查同源 Origin。ACS 验证浏览器 cookie、一次性 RelayState 和签名响应。SCIM 独立验证 Bearer。保留外层通用请求大小、流量限制和安全响应头。

## SaaS 客户配置

- `enterprise.connection({ tenantId, connectionId })` 读取运营后台显式审核、启用的客户连接。连接被停用则返回 `null`。配置、密钥材料或 SCIM 令牌变更时更新 `revision`。租户与连接 ID 只接受 1–128 个字母、数字、下划线或连字符。
- OIDC 显式配置 issuer、authorization endpoint、token endpoint、JWKS URI、client ID 和签名算法，支持 secret basic 或公开客户端。客户端固定使用 authorization code + S256 PKCE。`enterprise.transport` 使用运营批准的出站策略按租户与连接检查 token/JWKS 的目标和实际连接地址，拒绝本地、私网、保留地址及跨端点重定向。保留传入的请求超时信号和 `redirect: 'manual'` 语义。扩展会再次检查端点、HTTP 方法和重定向响应。
- SAML 注册连接专属 SP entity ID、IdP issuer、登录入口、受信任公钥证书及稳定的 NameID 格式。验证要求 SP 发起、响应和断言均有签名、明确的目标 ACS、签名内的 bearer recipient 和请求 ID，并检查时效和 audience。可配置 SP AuthnRequest 签名密钥。当前支持 HTTP-Redirect 启动和 HTTP-POST ACS。
- SSO 起点是 `POST /api/v1/auth/sso/{tenantId}/{connectionId}/{oidc|saml}/start`。浏览器可提交同源表单并跟随 303。将对应的 `/callback` 注册为 OIDC redirect URI 或 SAML ACS。一次浏览器启动一个流程。应用和代理的日志须排除这些端点的查询参数、请求体、Authorization、Cookie、Set-Cookie 与重定向 Location。生产环境关闭 `NODE_DEBUG=node-saml`。
- `enterprise.issueFederatedSession` 在核心同一事务内锁定／校验连接 revision、租户成员状态及绑定，再发行会话。唯一外部身份绑定为 `(tenantId, connectionId, subject)`，`subject` 取验证后的 OIDC `sub` 或 SAML `NameID`。预置绑定时应使用连接专属的稳定标识，禁止按邮箱自动链接，角色来自核心成员关系。使用同一条锁定／重查路径处理 SCIM 停用与发行竞争。

## SCIM 与持久化

- 为每个连接单独生成 32 字节随机 SCIM 凭证，通过客户配置渠道交付，服务端连接仅存 SHA-256 摘要。客户须将 SCIM `externalId` 映射到与该连接登录 subject 一致的稳定 ID。配置变更后应用 revision 检查。
- `/api/v1/scim/{tenantId}/{connectionId}/v2/Users` 支持创建、查询、分页和 `id`／`externalId`／`userName` 的 `eq` 过滤。单个资源支持 GET、PUT、PATCH 和 DELETE。PATCH 可更新 `active`、`userName` 和 `displayName`。当前互通范围为 Users，不含 Groups、Bulk 和配置发现。
- `enterprise.members` 适配核心租户成员存储。每个方法按租户和连接查询资源，写入事务同时复核 revision。创建和重新启用执行核心席位限制和默认角色规则，`externalId` 绑定不可更换。`active: false` 与 DELETE 同时停用成员授权并撤销其在该租户的 session 权限、PAT、OAuth access／refresh 和待兑换授权。确认核心的 session、PAT 及 OAuth 鉴权在停用后立即拒绝，并在重新启用时继续拒绝旧凭证。保留其他租户的凭证权限。DELETE 保留 subject 绑定记录以防重新分配给另一账号。
- 用迁移账号执行 [`schema.sql`](schema.sql)，为应用运行角色授予 `ss_identity` 的 schema USAGE，`state` 表 SELECT／INSERT／UPDATE 和 `flow` 表 SELECT／INSERT／DELETE。生产使用所有实例共享的 `PostgresIdentityState`，从稳定的 32 字节密钥配置 `encryptionKey`。定期调用 `purgeExpiredFlows()` 清理一次性记录。在换密钥前安排密钥迁移，避免丢失现有 TOTP 因子。

## 验证

从仓库根目录执行 `pnpm exec tsx --test tests/identity/*.test.ts`。SAML 测试依赖本地 OpenSSL 生成临时证书。需要运行 PostgreSQL 用例时，用 `IDENTITY_TEST_DATABASE_URL` 指向一次性测试数据库。OIDC 和 SAML 使用本地签发的记录调用真实验签库。会话发行、核心成员关系和撤销调用由测试适配器验证。
