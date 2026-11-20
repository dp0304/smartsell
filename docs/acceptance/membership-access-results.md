# TE01 工作区成员移除验收

2026-11-20 在 PostgreSQL 17.11 上重复通过 [plan.md 5.18.12 的两项验收条件](../../plan.md#L8036)。稳定用例名为 `TE01 workspace removal denies an issued PAT and preserves other access and handover history`。[测试源码](../../tests/web-e2e/membership-access.spec.mjs#L31)

## 验收路径

- 复用 reviewer-sessions 的全新 PostgreSQL 容器、同源 HTTPS 和受限 `app_rw` 请求角色。`infra/start.sh` 以 `ROLE=api,mcp` 启动生产模式服务。系统初始化、邀请和接受邀请均走产品 API，owner 与 editor 分别登录并取得独立的 Secure/HttpOnly 会话 Cookie，各自通过产品 API 签发 PAT。MCP 调用使用只带 Bearer PAT 的独立请求上下文。
- 当前服务没有为现有账号创建第二工作区的产品入口。测试用 SQL 准备第二工作区及两条成员关系（owner 和 viewer），用 SQL 回加成员验证重新加入，并将一枚真实签发的 PAT 的过期时间设为过去。实际移除走成员 API 的预览与确认流程。任务、交接和凭证签发均走服务，历史及审计用只读 SQL 核对。
- 移除前，owner 和 editor 的 PAT 均可读取原工作区任务（`200`）。移除 editor 后，其旧 PAT 对原工作区返回 `403`，owner 的原 PAT 仍返回 `200`。editor 的原会话仍有效，且只列出保留的工作区。该工作区此前签发的只读 PAT 仍返回 `200`，取消任务的请求按 MCP 协议返回 `TOOL_UNAVAILABLE`，再读确认任务仍为 `open`。
- 无效、过期及经 `DELETE /tokens/:id` 明确撤销的凭证，在移除前后均返回 `401`，并附认证挑战。恢复成员关系后，原工作区的旧 PAT 仍返回 `403`，新签发的 PAT 可以读取。显式注销 editor 的会话后，绑定该会话且此前可用的两枚 PAT 均返回 `401`。SaaS 租户停用由单独的 SCIM 回归验证。
- 交接前待办的创建人和责任人为 editor。owner 接受交接后，创建人仍为 editor，当前责任人为 owner，状态保持 `in_progress`。交接及 `handed_over` 历史保留 editor → owner 和操作者。核对创建、移除、接受交接的审计，并按业务对象和操作者关联 `team.member.removed` 与 `team.handover.completed` 各自的审计记录。

## 命令与实际结果

仓库根目录使用 Node.js 24.21.0、pnpm 10.11.0、Chromium 和本地 `postgres:17-alpine` 镜像。

```bash
for run in 1 2; do
  bash tests/acceptance/reviewer-sessions.sh membership || exit $?
done
bash tests/acceptance/reviewer-sessions.sh
pnpm test tests/acceptance/workspace-access.test.mjs apps/server/src/modules/team/team.test.ts
bash tests/identity/with-postgres.sh
bash tests/acceptance/domain-postgres.sh
```

| 命令 | 实际结果 |
| --- | --- |
| `reviewer-sessions.sh membership`，第 1 次 | 容器 `0499693bf7e1`，初始化前 0 用户，`1 passed (3.0s)`，交接 `7e72cef4-8cf8-4fe8-9c1d-e88dd305819d`。 |
| `reviewer-sessions.sh membership`，第 2 次 | 容器 `58f8d0b39b9f`，初始化前 0 用户，`1 passed (2.9s)`，交接 `9351c8bf-16f1-4d15-9a86-c73fda1d5ec3`。 |
| `reviewer-sessions.sh` | `1 passed (4.1s)`。双人审批会话及自审拒绝。 |
| `pnpm test` 工作区及团队用例 | 24 通过，0 失败，0 跳过。覆盖品牌范围、成员移除、租约、交接与席位。 |
| `identity/with-postgres.sh` | 8 通过，0 失败，0 跳过。包含 `SaaS signed OIDC and SCIM over HTTP issue and revoke actual core sessions, PATs and OAuth grants`。 |
| `domain-postgres.sh` | 12 通过，0 失败，0 跳过。覆盖请求角色、迁移、事务与 RLS。 |

扩展交接断言时曾有 1 次失败，查询在 `ss.events` 中找不到交接完成事件。改为按实际持久化路径匹配 Operations outbox 的 `trace_id` 和 audit 的 `request_id` 后，两轮验收通过。
