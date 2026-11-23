---
name: smartsell-video-publish
description: Submit an existing Douyin or Xiaohongshu video revision for SmartSell approval or check its status. The operator publishes it. 抖音和小红书视频发布送审。 For account-wide checks of existing videos or social account status, follow the paired Worker path.
argument-hint: "[request ACCOUNT_ID VARIANT_ID REVISION_ID SCHEDULED_AT | status TARGET_ID]"
---

# 视频发布送审

## 自己的社媒账号状态与近期作品

For “查我的社媒状态” or “X 账号现有视频”, use the paired Worker through `worker_social_status_request` and poll `worker_social_status_get` for the same task ID. The Worker supports `account_status` and `recent_posts` according to the live schema. Follow the Worker-only request and reporting steps in the sibling data collection Skill. A specific existing SmartSell schedule is checked through its own target and linked publication receipt. [数据采集与核对](../smartsell-data-collection/SKILL.md)

## SmartSell 排期

Use the connected SmartSell MCP for the requested workspace. For this invocation, consult the client's live MCP tool list (or `smartsell_operations_describe` for the named operations) and the advertised schema. Tool names may be namespaced by the client. Use only the operations below. If the required operations for the selected action are missing, the readback is incompatible, or any permission is denied, stop and report the blocker; do not fall back to HTTP, shell, generic write tools, or platform automation.

- **request**: Use the user's explicit request to schedule and submit as intent; don't ask them to repeat it. Resolve the named account, committed video revision, and time with offset from authorized context and available reads. Only Douyin and Xiaohongshu are covered. If exposed, use `account_list_social_accounts` to cross-check the account and `check_operation` to check `operation: "publish"`, `content_format: "video"` (use the live schema). Prefer a matching verified browser identity and ready assist path from an authorized read. Compare the expected account, device and recency when the evidence exposes them. A registered account, local Chrome page, or available tool alone is not login or identity proof. If there is no separate authorized identity read, use the normal submission precheck to establish server readiness; do not claim that it re-read the current Chrome session. If evidence indicates a wrong or stale identity, missing access, or login/MFA is required, stop and hand the specific check back to the operator.
  1. Call `publishing_create_target` with `body: { social_account_id, content_variant_id, revision_id, scheduled_at, connector_mode_pref: "assist" }` and an `idempotency_key`, following the live schema. Keep the returned target ID and numeric `version`.
  2. Call `publishing_request_approval` with `params: { id: TARGET_ID }`, `expected_version` equal to that version, `body: {}`, and a different `idempotency_key`. Reuse a key only for a retry of the same mutation. On a stale version, read the target back and report the conflict; do not resubmit a changed target.
  3. If submission is blocked, report the blockers and target ID. If awaiting approval, point the approver to SmartSell Workbench. If ready under policy, report that state without implying a person approved it or that it was published.
- **status**: Read the known target using `publishing_get_target` and its advertised schema. Report plan, approval, and execution separately. Preserve `outcome_unknown` as unknown; ask the operator to reconcile it, not to resubmit.

Stop after submission or readback. The operator follows the approved desktop task and publishes manually on the official platform. Never approve on the user's behalf, click Publish, or bypass login or platform verification.
