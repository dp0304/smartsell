# 公开入口和服务后台

Commands 使用 `pnpm start`，Kernel 使用 `pnpm start:kernel`。两者均挂载公开页面、短链与表单。部署时为公开域名配置 `SMARTSELL_TRAFFIC_HOSTS` 和稳定的 `SMARTSELL_TRAFFIC_PII_KEY`，并按公开入口文档登记 Commands 在 PostgreSQL 上使用的 `traffic.workspace` 定位记录。反向代理应保留可信的 `Host`。详见 [公开入口配置](../apps/public/README.md)。

Commands 生产部署先执行 `pnpm db:migrate`，其中 `007_operation_background.sql` 为定时器和派发器提供事务级 Operation 记录访问。启动组合需要 `api,public,worker,scheduler` 或 `all`。定时任务按工作区运行，后台停机等待进行中的任务完成。

## SLA、审核和报告

以下路由均在 `/api/v1/workspaces/:ws` 下，写操作使用会话 CSRF 保护，版本化操作使用 `If-Match`。

- 在 `/inbox/business-hours` 创建时区、营业窗口和日期例外，在 `/inbox/sla-policies` 配置目标。后台按分钟检查 SLA 并恢复到期的暂缓会话。
- 在 `/inbox/auto-rules` 配置草稿规则，在 `/inbox/auto-reply-review` 查看待审项。批准生成一条绑定到已审核草稿版本的持久手动任务。
- 报告的 `schedule` 接受 `interval_days`（1、7 或 30）、带偏移的 `next_at` 和可选 `tz`。默认沿用工作区时区，跨夏令时保留本地执行时间。到期生成草稿，停机期间错过的周期合并为一次生成。用户通过 `/subscriptions` 关注 `resource_type=report` 和对应 `resource_id`。定稿后按当前成员权限、静音及通知偏好派发站内通知。

## 已授权的签名 Webhook

用 `SMARTSELL_CUSTOMER_EGRESS` 注册服务端批准的接收方。每项包含 `tenantId`、`workspaceId`、`kind`（`webhook`）、`url`、`secretId` 与 `secretEnv`。在相应工作区通过 `/webhook-subscriptions` 注册同一 URL 和密钥引用，并通过 `/egress-policies/workspace` 授权相应 `outbound_webhook` 目的地的 `internal` 数据类。

| 事件 | 对外数据 |
| --- | --- |
| `analytics.report_version.finalized` | 报告与定稿版本 ID |
| `commerce.localization.manual_required` | 工作请求与商品 ID |
| `lifecycle.esp_campaign.manual_required` | 工作请求与 ESP 营销活动 ID |
| `traffic.lead.handoff_requested` | 线索与 CRM 交接 ID，目的地须匹配订阅并通过当前服务同意及抑制检查 |

`/signed-webhook-deliveries` 提供幂等键、负载摘要、响应状态和可选回执 ID。投递先提交持久认领记录，再发起签名 HTTP 请求。连接中断、超时和不可确认的响应进入 `unknown`，需要接收端核对。`delivered` 表示 HTTP 接收成功。CRM 业务结果通过 `/leads/:id/handoff/receipt` 记录提供方证据。门店和 ESP 手动待办通过 `/work-items/:id/external-receipt` 记录证据。工作流产生的任务涵盖已批准的本地化、ESP 发送准备及 CRM 交接。实际付款和对第三方签约须另行明确授权。

本地可运行 `node --import tsx --test apps/server/src/integration/signed-webhook-process.test.ts`。测试启动真实服务和回环接收端，在显式启用 `SMARTSELL_WEBHOOK_LOOPBACK=1` 的开发环境中验证签名、摘要、回执，以及服务重启后的去重。
