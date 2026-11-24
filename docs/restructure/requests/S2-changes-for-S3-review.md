# S2 changes in `planning/index.ts` and `packages/domain/src/publishing/**` — for S3 review (§11.1)

Scope: Worker-aware cancellation, pause, `hasExecutionRisk`, `blockUnsent` and approval resubmission. Every change below applies only to **hub channels** (an account with a `channel_settings` row) unless it says "all accounts". Legacy accounts (API, connector_task, mobile) keep their old behaviour; the existing planning, execution, content and acceptance suites pass unchanged.

Not changed: `hasExecutionRisk` (per §5.2 `running` is already outside the refreezable statuses), `cancel()` / `requestCancellation` (S3 owns the Worker-aware version in `execution/service.ts`), `activatePause`'s target transitions, `checkEditable`.

## `packages/domain/src/publishing/index.ts`

| Function | Before | After | Why |
|---|---|---|---|
| `assessTarget` | One path for every account: capability, binding mode, `device_online`, `session_identity`, `account_connection`, `account_block`, auto-submit permits, TikTok options as `caption_rules`. `route` ∈ api/connector/manual. | Hub channel → `channelChecks()` instead of that block: route `worker` (driver provider) or `manual` + risk `driver_unavailable` (mode `owner`); blockers `automation_notice`, `machine_binding`, `machine_paused`, `channel_defaults` (TikTok options on the **bound revision**), `daily_cap` (excludes the target itself), `publish_window`, `media_kind`; risks `machine_online` (schedule/approval only, via `ctx.presence` C14), `login_state`; info `automation_mode` with `effective_mode` ∈ auto/assist/owner. Inactive channel → `account_status` blocker. X caption = `xWeightedLength` ≤ `caption_limit ?? 280`; TikTok ≤ `caption_limit ?? 2200`. Media: `status ∈ {uploading, processing}` or declared SHA-256 without `file_object_id` → risk at schedule/approval, blocker at preflight/execution; `failed` → blocker; integrity check only once a file object exists. Hash/payload unchanged in shape (media bindings use the declared SHA-256, so the frozen hash does not move when an upload completes). | §4.4 table; R1-7, R1-18. |
| `assessTarget` (all accounts) | Media blocked when `asset.brand_id !== target.brand_id`; rights always checked. | An asset with `brand_id === null` or `ownership === 'owned'` passes the brand check and skips `checkAssetRights` (no `rights` item). Assets with any other brand are unchanged. | §3.8. Strict `=== null`: legacy fixtures without the field keep their old result. |
| `approvalValid` | Hash, status, policy version, standing grant. | Plus: `approved_via === 'channel_policy'` requires the channel to be `direct` now and `approval_generation === request.channel_approval_generation`. | §4.1. A `human`/`policy` approval is not affected by channel settings. |
| new exports | — | `channelSettingsFor`, `channelEffectiveMode` (§3.3 truth table), `deviceOnline`, `inPublishWindow`, `channelDayUsage`, `channelMediaRule`, `TIKTOK_REQUIRED_OPTIONS`, `ownedAsset`. | Shared with S3 (go checks, heartbeat mode) and S4 (`MEDIA_NOT_SUPPORTED`). |

## `apps/server/src/modules/planning/index.ts`

| Function | Before | After | Why |
|---|---|---|---|
| `blockUnsent` | Transitions the task to `blocked` (reason) when scheduled/queued/blocked and no execution risk. | If `task.route[0].executor === 'worker'`: never touches the task. Reason `approval_invalid` → `workerEngine().revokeForTarget(ctx, target, 'approval_invalidated')` (C3 hook); any other reason → nothing (go check + heartbeat hold stop execution; the precheck run is still recorded). Non-Worker tasks unchanged. | §4.4, §5.2 ("task state only via syncTaskFromJob"), §5.10. |
| `submit` | Automatic only by standing grant or optional policy; `approved_via: 'policy'`; `due_at = now + step hours`. | `isChannelDirect()` (direct mode and not blocked) also approves automatically with `approved_via: 'channel_policy'`, `channel_approval_generation`, no standing grant attached. `due_at = approvalDue()`. Exported. | §4.1, §4.2. |
| `approvalDue` (new, exported) | — | `min(now + step.due_hours, scheduled_at + lateness_limit_min)` for hub channels; `now + step.due_hours` otherwise. Also used for multi-step advance in `decide`. | §4.2: an approval after the deadline could not be published. `scanPlanningDue` and `decide` already expire requests past `due_at`. |
| `updateTarget` | Kept pending request keeps its `due_at`. | When a pending request is kept under the tolerance and the time moved, `due_at` moves to `min(created_at + step hours, new scheduled_at + lateness)`. Exported. Still does **not** call `submit()` itself (S4 does, per §7.2.7). | Moving 10:00 → 10:30 must not expire the approval at 10:30. |
| `resubmitIfWaiting` (new, exported) | — | For a hub channel in `awaiting_approval` without a valid pending request, before its deadline and with no execution risk: `submit()`. No-op otherwise. | §4 common rule (R1-6): every path that leaves `awaiting_approval` must leave a pending request. |
| `publishing_update_target`, `publishing_reschedule` ops | Left `awaiting_approval` with no request after an approval drop. | Call `resubmitIfWaiting` when `approval_retained === false` (hub channels only). | Same rule for the web's legacy edit paths. |
| `releasePause` | Approval-invalid-after-pause and rescheduled-outside-tolerance targets left without a request. | `resubmitIfWaiting` on both paths. Bumps the Worker sync generation for affected channel devices. | §4 rule; §5.4.1 `sync_generation` for pause changes. |
| `activatePause` | — | After pausing, bumps the sync generation for devices bound to hub channels in the scope. Target transitions unchanged (pause still never revokes). | §5.4.1, §5.10 "暫停不撤回". |
| `checkPolicyImpact` | Retire + `awaiting_approval`. | Then `resubmitIfWaiting`. | §4 rule. |
| `applyPlanningEvent` | `core.approval_request.invalidated` and binding/price changes leave `awaiting_approval` without a request. | `resubmitIfWaiting` after those transitions (after the precheck is recorded). A direct channel is re-approved if precheck passes; a needs_approval channel gets a pending request. | §4 rule. |
| `scanPlanningDue` | Emits `planning.target.assist_reminder` for assist targets. | Not for hub channels (S10 owns click-post reminders, §4.5/§5.9). Preflight and expiry otherwise unchanged; preflight `approval_invalid` → revoke via `blockUnsent`. | Avoid duplicate reminders. |
| exports | `operations`, events, scan | Also `targetValues`, `createTarget`, `submit`, `updateTarget`, `cancel`, `approvalDue`, `retireRequest`, `resubmitIfWaiting`. `registerPlanningHooks({ submit, retireRequest })` runs at module load. | C2. The hook breaks a load cycle (account → planning → execution → content → execution). |

## `apps/server/src/modules/account/channel-settings.ts` `applyApprovalModeChange` (runs inside the settings transaction)

- **needs_approval → direct**: for each `awaiting_approval` target without execution risk and before its deadline: if it holds a pending request and the schedule precheck would not block, retire it (`channel_approval_mode_changed`) and `submit()` (auto-approves). Blocked ones keep their pending request. Lapsed ones (past `scheduled_at + lateness`) are skipped: they derive as `missed` and "改到…" resubmits them.
- **direct → needs_approval**: for each `ready`/`paused` target whose current request is `approved_via='channel_policy'`: `retireRequest` (→ `blockUnsent` → `revokeForTarget` for a Worker task). If it has no execution risk: `awaiting_approval` + `submit()` (new pending request). With execution risk (a job already started) only the approval is withdrawn; §5.10 handles the job, and the target is not resubmitted until it resolves.
- A person's approval (`approved_via='human'`) is never touched in either direction.

## Points S3 should confirm

1. `revokeForTarget` must be safe to call from `blockUnsent` for a target whose only live job is the current, matching one (the rule in §5.10 is S3's), and must not throw for `submitting`/`result_pending`.
2. `ensureTask` writes `route[0].executor = 'worker'` for `assessed.route === 'worker'` (until then the task route is `manual_fallback` and S2's Worker branches in `blockUnsent` are inert).
3. With direct → needs_approval on a `running` job, the target stays `ready` with an invalidated request; go check 5 (`approvalValid`) and the heartbeat `hold` must stop it, and after the job is released the owner resubmits via "改到…" / `post_update`.
