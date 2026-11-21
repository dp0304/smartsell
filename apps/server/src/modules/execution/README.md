# 发布执行集成

命令走 `POST /api/v1/workspaces/:wid/commands/execution/:action`，JSON 为下表输入。写命令使用 `Idempotency-Key`。用新的键重新检查阻塞条件。记录走 `GET /api/v1/workspaces/:wid/records/execution/:kind`。

| action | 输入 | 结果 |
| --- | --- | --- |
| `enqueue` | `{target_id, late_policy?, grace_seconds?}` | 创建或返回目标唯一的 `execution_task`。`late_policy` 为 `grace_window`、`notify`、`skip`。 |
| `preflight` | `{target_id}` | 返回 `blockers[]`，每项含 `code` 和 `message`。 |
| `due_scan` | `{limit?}` | 管理员扫描。将到期的已批准目标加入队列并返回 `{tasks,has_more}`。 |
| `get_task` | `{task_id}` | 返回 `{task,target,attempts,verifications,handovers,post}`。 |
| `list_tasks` | `{target_id?,status?,offset?,limit?}` | 返回 `{tasks,has_more}`，允许按目标或状态筛选。 |
| `prepare_official` | `{task_id}` | 管理员准备。返回 `{task,attempt?}`。只有 `prepared` 的 attempt 可交给官方执行器。 |
| `begin_manual` | `{task_id}` | 分派人或管理员领取。返回 `{task,attempt?}`。只有 `manual_in_progress` 表示已取得操作权。 |
| `reconcile_manual` | `{task_id,attempt_id,fencing_token,outcome,evidence,permalink?,external_post_id?,confirm_no_pending_submission?}` | `published` 必须附 HTTPS 作品链接。`verified_absent` 需要管理员权限及 `confirm_no_pending_submission:true`。 |
| `report_manual_unknown` | `{task_id,attempt_id,fencing_token,evidence}` | 记录人工提交结果不明，保留账号写入槽等待核实。 |
| `cancel` | `{task_id,reason}` | 分派人或管理员取消。已经可能发送的任务变为 `cancel_pending`，等待平台结果。 |
| `recover_lease` | `{task_id}` | 管理员回收租约。确定尚未发送的准备可释放，其他尝试进入待核实。 |
| `allow_late` | `{task_id,reason,extension_seconds}` | 管理员为等待迟到决定的任务添加最长一小时的执行窗口。仍需通过所有预检。 |
| `handover_manual` | `{task_id,assignee_id,reason}` | 管理员转交人工。任何未决外部结果都会阻塞交接。 |
| `start_restore_hold` | `{reason}` | 停止发放新的提交权，建立 `recovery_check`。 |
| `list_recovery` | `{status?}` | 返回待核对项，支持 `pending`、`resolved` 或 `all`。 |
| `record_recovery` | `{check_id,outcome,evidence,permalink?,external_post_id?,confirm_no_pending_submission?}` | 管理员记录 `already_published` 或 `verified_absent`。前者需要现有作品记录或链接，后者需要确认原请求不会再发布。 |
| `release_restore_hold` | `{reason}` | 所有恢复检查完成后恢复派发。 |

主要记录有 `execution_task`、`execution_attempt`、`platform_post`、`verify_attempt`、`account_write_slot`、`quota_reservation`、`execution_handover`、`execution_guard` 和 `recovery_check`。执行结果以 `execution_task.data.status` 为准，`planning.publish_target` 保存独立的批准与排程意图。`blocked`、`outcome_unknown` 和 `cancel_pending` 可通过 `reason`、`blockers` 和尝试时间线展示。

人工结果示例

```json
{
  "task_id": "<task.id>",
  "attempt_id": "<attempt.id>",
  "fencing_token": 3,
  "outcome": "published",
  "permalink": "https://www.facebook.com/example/posts/123",
  "external_post_id": "123",
  "evidence": "已在目标主页核对发布账号、正文与媒体"
}
```

## 官方执行器与恢复

宿主为任务所在工作区注入 `{run}`，用同一个授权服务身份运行独立事务并等待提交。事件也须在事务里写入。用配置好的显式 `OfficialAdapter` 创建 `createOfficialWorker({run}, adapters)`。现有平台包可经 `bindOfficialPlatform(adapter, {connection,payload})` 接入。`connection` 从服务器凭据库读取与作用域、账号对应的凭据。`payload` 把已批准的冻结素材、内容及选项映射到供应商输入。需要平台容器的渠道须提供该账号已有的准备产物。适配器的错误及证据字段只放适合工作台显示的值。

1. 调用 `prepare_official`，再用返回的 `task.id` 和 `attempt.data.fencing_token` 调用 `worker.dispatch`。事务提交 `dispatched` 后才可调用适配器的 `submit`。供应商已接收的响应仍需核实。
2. 调用 `worker.verify(task.id)`。以持久化的回执或原 `client_request_id` 进行只读查询。无回执或查询范围不足时保留 `outcome_unknown`，由管理员按证据人工核实。`verified_absent` 只在平台可见性窗口结束、旧执行器已停止且原请求不会继续发布时成立。
3. 官方配额按工作区、平台账号与 UTC 日期计算。`reserved` 在等待核实时继续计数，`consumed` 表示已提交或可能计费，`released` 表示已确认没有发出。本地配额与平台官方配额独立。账号写入槽通过事务内唯一键和版本检查串行化。在多个工作区共用同一个平台账号的部署中，宿主须统一划分账号的写入归属。
4. 恢复前让旧执行器停止，并启动 `start_restore_hold`。还原点可能早于尝试记录，所以到期目标也需对账。官方核实和人工证据均可继续登记，所有检查完成后再解除暂停。

生产宿主负责定时调用、凭据注入及平台传输。本模块没有默认启用的官方适配器。设备或浏览器路径、平台排程撤回、已发表作品的远程编辑以及平台授信需要对应宿主或平台接入。
