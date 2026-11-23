---
name: smartsell-video-publish
description: Schedule an existing video revision for human-assisted publishing on Douyin or Xiaohongshu, submit it for SmartSell approval, or check its status. 抖音和小红书视频发布送审。
argument-hint: "[request ACCOUNT_ID VARIANT_ID REVISION_ID SCHEDULED_AT | status TARGET_ID]"
disable-model-invocation: true
---

# Human-assisted video publishing

Requested action: $ARGUMENTS

Use only `publishing_create_target`, `publishing_request_approval`, and `publishing_get_target` from the connected SmartSell MCP server. Resolve names through the client if they are namespaced. If unavailable, ask the user to connect SmartSell MCP for the Workspace; do not use generic operations, HTTP, browser, or shell as a fallback.

- `/smartsell-video-publish request ACCOUNT_ID VARIANT_ID REVISION_ID SCHEDULED_AT`: use a registered Douyin or Xiaohongshu account, an existing video variant and its committed revision for that account, and an ISO 8601 scheduled time with an explicit offset. Ask for missing or ambiguous values instead of guessing. The designated desktop connector and social account must be ready for human assist.
  1. Call `publishing_create_target` with `{ "body": { "social_account_id": "ACCOUNT_ID", "content_variant_id": "VARIANT_ID", "revision_id": "REVISION_ID", "scheduled_at": "SCHEDULED_AT", "connector_mode_pref": "assist" }, "idempotency_key": "CREATE_KEY" }`.
  2. Save the returned target ID and numeric `version`. Call `publishing_request_approval` with `params: { id: TARGET_ID }`, `expected_version` set to that numeric version, `body: {}`, and `idempotency_key: SUBMIT_KEY`. Use a different key for each mutation; reuse it only on retry of the same request. If the version is stale, read back the target and report the conflict; do not blindly submit a changed target.
  3. If `submission_status` is `blocked`, report the precheck blockers and retain the target ID. If `plan_status` is `awaiting_approval`, direct the approver to SmartSell Workbench's review queue. If `ready` was returned under an existing policy, report that state, not that a person approved or published it. Approval and scheduling do not prove publication.
- `/smartsell-video-publish status TARGET_ID`: call `publishing_get_target` with `{ "params": { "id": "TARGET_ID" } }`. Report the plan, approval, and execution states separately. Preserve `outcome_unknown` as unknown and direct the operator to reconcile it; do not resubmit.

Stop after submission or readback. The human follows the approved desktop task, opens the official creator page, selects the local media and publishes there themselves. Never approve, click Publish, bypass login or platform verification, or claim the video was published from a submission result. This workflow does not cover TikTok, Instagram, Facebook, or commerce listings.
