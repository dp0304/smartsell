# OP08 本地开放接口复验（2026-11-20）

已确认 `CLAUDECODE=1`，使用本机已安装的 Node v24.21.0。按 §4.12 Web API 规范、§4.13 MCP 规范及 OP08 验收项核对协议。测试以 `ROLE=all` 启动 `command-main.ts` 和 `kernel-main.ts`，分别使用一次性 SQLite 和文件库。请求只发到本机回环地址，夹具使用合成资料。[设计规范](../../plan.md#L889) · [OP08](../../plan.md#L8582)

## 本次接续复验（2026-11-20）

在 Claude Code 2.1.311 的 `sdk-cli` 会话中使用 Node v24.21.0 执行 `node scripts/test.mjs open-api-http.test.mjs`。测试通过回环 HTTP 驱动默认 Commands 和独立 Operations 两个实际服务，共 5 项，5 项通过，0 项失败、跳过或 TODO。两个 Campaign 分页子项均为普通断言。`pnpm typecheck` 通过。[独立验收测试](../../tests/acceptance/open-api-http.test.mjs)

两个入口的 `GET /campaigns?limit=1` 均返回一笔及顶层 `next_cursor`。按品牌筛选时，首尾两页各一笔，尾页游标为 `null`。通用签章游标绑定工作区、使用者、凭证、操作及筛选条件。实测篡改游标、改变筛选条件及跨使用者或凭证复用返回 422，不可见工作区返回 404。OpenAPI 描述 REST 的顶层分页响应及 Commands 兼容 POST 的嵌套分页响应，兼容 POST 也实测翻页。HTTP 测试从 Web 工作区解析 `@smartsell/sdk` 的公开入口，调用具名导出的 `getWorkspaceOpenApi` 和 `callWorkspace`。[REST runner](../../apps/server/src/operations.ts#L155) · [包入口](../../packages/sdk/src/index.ts#L4)

Campaign、Workspace 与 Kernel 相邻回归共 26 项，24 项通过，0 项失败，2 项 PostgreSQL 用例因本轮未配置 `SMARTSELL_TEST_DATABASE_URL` 跳过。

## 结果

### 首轮回环 HTTP 复验

`node --import tsx --test tests/acceptance/open-api-http.test.mjs` 共 2 项。独立 Operations 通过。Commands 的 OpenAPI、SDK 读写及兼容命令断言已执行，随后在准备 viewer 会话时，邀请路径 `POST /api/v1/workspaces/{ws}/members/invitations` 返回 404，权限不足分支待复验。

### 修正夹具后的回环 HTTP 复验

`node scripts/test.mjs open-api-http.test.mjs` 共 5 项，3 项通过，2 项为已复现失败的 TODO 子项。[独立验收测试](../../tests/acceptance/open-api-http.test.mjs)

| 入口 | 实测结果 |
|---|---|
| 两个入口 | 会话可读取 `GET /api/v1/workspaces/{ws}/openapi.json`，匿名 401，响应使用 `Cache-Control: no-store`。OpenAPI 3.1 的规范路由和操作 ID 逐项与 `/catalog` 一致。抽验品牌、上下文、内容、Campaign 的请求及响应 schema，并核对 `ETag`、`If-Match`、`Idempotency-Key` 和 RFC 9457 冲突响应。 |
| 两个入口 | SDK 实际建立、更新和读回品牌及 `ETag`。品牌与内容列表均完成 `next_cursor` 翻页，内容列表按品牌过滤，同工作区上下文返回指定品牌。无版本回 428、零版本回 422、过期版本回 409、缺 CSRF 回 403。相同幂等键重放返回原结果，换内容回 422。内容项及生产任务经 SDK 创建并读回。 |
| Commands | 会话写入需要 CSRF。`/commands/campaign/operation_campaign_create_draft` 接受具名字段和幂等键，SDK 可经规范 REST 路径读回。正式 `/members/invite` 创建的 viewer 在 OpenAPI 中只看见允许操作，实际写入回 403。单工作区 SQLite 夹具实测未知工作区上的发现、列表及上下文均回 404。 |
| 独立 Operations | OpenAPI 宣告会话及 Bearer。只读 PAT 和工具白名单会收窄文档，范围不足回 403。游标不可从会话移用到 PAT，PAT 自己可翻页。受限写 PAT 可建品牌，未授权的列表回 403。用实际存在的异租户工作区和品牌验证发现、列表、资源读取及上下文回 404。 |
| SDK 输入 | 无效工作区路径段在发请求前被拒绝。 |

此前定向 TypeScript 检查通过，全库检查在 `integration/customer-egress.ts` 和 `modules/workspace/search.ts` 报错。接续复验时全库检查已通过。

## 剩余分支

- **协议入口与覆盖范围。** README 与 §4.12 的工作区 REST 路径一致。OpenAPI 按当前主体过滤，`/catalog` 提供操作索引，Commands 兼容 POST 调用同一组业务操作。按 §4.13，`/mcp` 使用独立的 Streamable HTTP 协议。OAuth 授权码／PKCE、MCP、长任务与 SSE、版本弃用头及 Commands 多租户存储分支待验。此次 schema 抽验覆盖具名 DTO，目录里其余操作仍有通用 schema。[README](../../README.md) · [MCP 规范](../../plan.md#L926)
- **外部条件。** 既有证据包括本机 Webhook 签名、重试和去重，以及本机观测下的回呼轮询和出口 IP 拒绝分支。客户接收端自动暂停、真实 SQS／EventBridge、OV／EV 证书、平台回呼及 IP 拒绝观测仍待实际环境验证。本轮通过项只计本地 REST 与 SDK，不计模型提供商或外部 Webhook。[既有 OP08 证据](matrix.md#op)
