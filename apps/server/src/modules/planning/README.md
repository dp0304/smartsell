# Publishing planning commands

The application registers these actions under `planning` at `POST /api/v1/workspaces/:wid/commands/planning/:action`. Send JSON and use the workspace `Idempotency-Key` mechanism to replay writes. Every target update uses the version returned with its current entity.

| Action | Input |
| --- | --- |
| `set_publishing_profile` | `account_id`, optional `platform`, `timezone`, `active`, `official_capability`, `manual_capability`, `adapter_key`, `quota_limit`, `account_identity`, `connection_expires_at`, `formats`, `markets`, `visibilities`. Supply `expected_version` to replace a profile. |
| `set_approval_policy` | Optional `approver_id`, `reschedule_tolerance_minutes` (0–60, default 60), and `expected_version` when replacing the policy. |
| `create_plan` | `name`. Returns a draft plan. |
| `create_target` | `account_id` (or `social_account_id`), `content_variant_id`, `route` (`official` or `manual`), `visibility`, a schedule, and optional `plan_id`, `revision_id`, `options`. |
| `preview_plan` | `plan_id`. Returns precheck results and versions for draft targets in the plan. |
| `commit_plan` | `plan_id`, plan `expected_version`, `items` containing `{target_id, expected_version}` for each draft target (1–50). Submits the whole set in one transaction. |
| `precheck` | `target_id` and optional `stage` (`schedule`, `approval`, `preflight`, `execution`). Records blockers, risks, repair hints and the check validity window. |
| `submit`, `schedule` | `target_id`, `expected_version`. A draft with a passing precheck enters `awaiting_approval`. `schedule` also returns an already pending or scheduled target. |
| `approve`, `reject`, `request_changes` | `target_id`, `expected_version`, optional `frozen_hash`. Rejection and change requests require `reason`. Approval schedules the target. |
| `list_approvals` | Empty object. Shows pending items the caller can decide. |
| `change_target`, `reschedule` | `target_id`, `expected_version`, plus editable target fields or a new schedule, respectively. |
| `cancel` | `target_id`, `expected_version`, `reason`. Once an execution task exists, use the execution cancellation or handoff flow. |
| `pause` | `reason` and optional `scope` (`workspace`, `account`, `campaign`, `brand`). Non-workspace scopes require `scope_id`. |
| `release_pause` | `pause_id`, `expected_version`. Use `dry_run: true` without a version to preview missed scheduled targets. |
| `list_targets`, `calendar` | Optional `from`, `to`, `status`, `account_id` (or `social_account_id`), `brand_id`, `campaign_id`, `owner_id`. `calendar` accepts `view` (`list`, `day`, `week`, `month`). |
| `get_target` | `target_id`. Returns target, approval, prechecks, execution task and platform post if present. |

Pass either `scheduled_at` with an explicit UTC offset or a `local_scheduled_at` in `YYYY-MM-DDTHH:mm` format. `schedule_tz` (alias `tz`) is an IANA zone and defaults to the account's zone. A DST gap requires `dst_choice: shift_forward` to select the first valid local minute. A repeated local time requires `earlier_occurrence` or `later_occurrence`.

A publishing profile configures a social account. Linked profiles use the account record for default timezone and external identity. Official publishing requires a registered social account, an active provider connection that covers the account, explicit `official_capability: true`, `adapter_key` and a positive integer `quota_limit`. A standalone manual profile supplies its own platform and timezone. Reviewers may decide only if they are neither the target owner, the submitter, nor the revision author. The approval policy can also assign a reviewer. A time-only change can retain approval within the original review's same-local-day window. Changes to other reviewed settings require resubmission.

## Execution contract

`planning.publish_target` becomes executable when `data.status === 'scheduled'`. `data.scheduled_at` is UTC ISO 8601. `data.approval_id` points to `planning.approval`. `data.frozen_hash` is the SHA-256 of the canonical JSON object in `data.frozen`. That object carries account ID, identity, platform, route, the exact content revision and references, visibility, options, and schedule. The content platform is in `platform` and the provider registry key is in `platform_provider`. Official targets also carry `adapter_key` and `quota_limit`.

`checkExecution(ctx, target)` in `index.ts` returns `{blockers: {code, message}[]}` after rechecking the frozen object and approval against current dependencies. Asset rights use `ctx.now` at execution. The execution module owns due time, late policy, external cancellation, and manual result registration. Its task and post records are joined into the calendar. To preserve these records, a pause or change never replaces an existing execution task.

The async command workflow supports all-or-nothing plan submission. Recurring expansion, evergreen queues, customer review, standing grants and platform connector-specific preflights require additional integrations.
