# 双人审批真实成员验收

## 范围与入口

使用 PostgreSQL 17.11、生产模式共享 Commands/Operations 服务（`ROLE=api`）和同源 HTTPS Web 构建。API 由 `infra/start.sh` 启动，以受限 `app_rw` 登录。Vite preview 在回环地址提供静态文件和 API 代理。Playwright 仅对该测试的临时自签名证书启用 `ignoreHTTPSErrors`。数据库初始化复用 `domain-postgres.sh` 的一次性容器与迁移角色分离方式。迁移完成后，由只读查询确认 `ss.users` 为 0。

- `POST /api/v1/setup` 创建工作区与提交人。提交人和审核人都通过 `/compat/workbench/login` 调用 `POST /api/v1/session` 独立登录。
- 共享运行时的 `/members/invite` 原先缺少生产成员存储绑定和工作区邀请接受入口。现在管理员可在现有 `POST /api/v1/workspaces/:ws/members/invite` 为新邮箱指定角色，响应返回 `data.invitation_token`，由邀请人经私密渠道转交。受邀人向 `POST /api/v1/member-invitations/accept` 提交 `{ token, email, name, password }`，成功返回 `204`，接受后使用普通登录。邀请有效期七天，仅限指定邮箱和新账号，一次性使用。接受邀请时重新检查邀请人的角色，并在同一事务创建账号与成员关系。此次补齐的范围是 PostgreSQL 共享运行时的新成员邀请、接受和成员列表。接受入口为 REST。
- 验收同时确认错误邮箱、重复接受及用提交人密码登录审核人账号均被拒绝。审核人的 `reviewer` 角色来自邀请，且调用成员邀请接口返回 `403`。`GET /members` 同时列出两个不同的用户 ID 及各自角色。
- 提交人通过工作台 UI 提交已提交修订的固定文案。UI 隐藏自审按钮。使用同一个提交人会话及该版本的冻结哈希直接调用审批命令，返回 `403 self_review_forbidden`。两个会话随后读回同一个 `pending` 请求，目标仍为 `awaiting_approval`，`decided_by` 未设置。
- 审核人从工作台的审批请求详情打开审批表单。测试核对 UI 实际发出的 `target_id`、`expected_version` 和 `frozen_hash`，确认 HTTP `200`。两个浏览器上下文分别刷新页面，再各自读回审批请求和发布目标。请求版本 `1 → 2`，状态 `pending → approved`，目标版本 `2 → 3`，状态 `awaiting_approval → scheduled`。两边都校验修订 ID、冻结内容及哈希、`requested_by` 和 `decided_by`，并确认两个独立的 Secure/HttpOnly 会话 Cookie 保持原值。

## 复验命令

在仓库根目录使用 Node.js 24、pnpm 10.11.0、Docker 和已缓存的 `postgres:17-alpine` 镜像。首次运行需要安装锁定依赖和 Chromium。

```bash
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
for run in 1 2; do
  printf '\nAcceptance run %s\n' "$run"
  bash tests/acceptance/reviewer-sessions.sh || exit $?
done
```

每次执行新建、迁移并清理自己的数据库容器，使用独立回环端口和临时构建目录。脚本通过 HTTP 设置账号和业务数据，仅将数据库管理连接用于建库、迁移和空库检查。测试脚本输出审批记录标识和绑定摘要，不输出密码、邀请令牌或会话值。

## 实测证据（2026-11-20）

| 字段 | 第 1 次 | 第 2 次 |
| --- | --- | --- |
| PostgreSQL 容器 | `8f50b39877e5` | `d23904a071d8` |
| 初始化前用户数 | `0` | `0` |
| 工作区 | `8ab6783e-766c-4e35-804f-310bf7af54d7` | `0010fb56-5214-4dc8-a023-511c05cc6cff` |
| `requested_by` | `eb26a201-6ceb-4f96-b642-2ba02006339e` | `9bb371bf-ee99-4e3c-bc9f-60dcb2b24c9d` |
| `decided_by` | `f5cf22a5-0304-4169-853d-6afb44b54a95` | `190dfe31-d923-420e-a04f-81f43136afc2` |
| 审批请求 | `05d259a8-12ce-45e5-9f4f-b3ba9dfd3ae9` | `806e5987-aac1-44e1-a3d0-60f59376c275` |
| 目标 | `577ce9ad-adf3-4fd4-8e45-4f128b6d0b00` | `6ada67db-7e23-4461-94df-33c95e44bc53` |
| 内容修订 | `1d34493d-92fc-4488-b501-094ebca5d620` | `dc7e3d34-6e5d-4bfc-80e9-0435b597d4e8` |
| 冻结哈希 | `b51fe4c19971d2e2bb696c0f331c53b33aa2904d485ae94756950b443611132c` | `100855ae89821cd47b25e4eea091eed8e445b109be8524c72f0f5c2bc2cd7b1a` |
| 自审 | `403 self_review_forbidden` | `403 self_review_forbidden` |
| 登录会话 | 两边均保留原 Cookie | 两边均保留原 Cookie |
| Playwright | `1 passed (26.6s)` | `1 passed (37.7s)` |

已有 `bash tests/acceptance/domain-postgres.sh` 回归通过，共 12 项测试，覆盖数据库迁移及回滚、域流程和隔离。服务端类型检查及团队和审批模块的 15 项测试也通过。
