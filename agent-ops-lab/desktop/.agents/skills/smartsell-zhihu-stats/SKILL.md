---
name: smartsell-zhihu-stats
description: Read visible Zhihu follower and upvote counts for your own profile, check the paired desktop Worker's Zhihu login, or look up one of those tasks. 知乎粉丝、获赞、登录检查。
argument-hint: "[login-check DEVICE_ID | stats DEVICE_ID PROFILE_SLUG | status TASK_ID]"
disable-model-invocation: true
---

# Zhihu stats and login check

Requested action: $ARGUMENTS

Use only the connected SmartSell MCP server's `zhihu_stats_create` and `zhihu_stats_get` tools. Resolve their names through the client if they are namespaced. If unavailable, stop and ask the user to connect SmartSell MCP for the Workspace; do not switch to generic operation, HTTP, browser, or shell tools.

- `/smartsell-zhihu-stats login-check DEVICE_ID`: call `zhihu_stats_create` with `{ "body": { "device_id": "DEVICE_ID", "mode": "login_check" }, "idempotency_key": "UNIQUE_KEY" }`. Do not send `profile_slug` or collect counts.
- `/smartsell-zhihu-stats stats DEVICE_ID PROFILE_SLUG`: call `zhihu_stats_create` with `{ "body": { "device_id": "DEVICE_ID", "profile_slug": "PROFILE_SLUG" }, "idempotency_key": "UNIQUE_KEY" }`. The slug is the public slug of the user's own account, not the full URL; send no `mode`.
- `/smartsell-zhihu-stats status TASK_ID`: call `zhihu_stats_get` with `{ "params": { "id": "TASK_ID" } }`. Save the task ID returned by creation for this lookup. Ask for missing or ambiguous input; do not guess IDs. The device must be active, paired to the Workspace, and owned by the connected actor. Keep the same idempotency key only when retrying the same request.

`queued` and `claimed` are pending, not success. Look up the same ID a bounded number of times or report it as pending and let the user check later. A completed login check confirms login and has no counts. For completed stats, report the returned `profile_slug`, `followers_text`, and `upvotes_text` as displayed, not inferred or converted to zero. For `blocked`, report the reason and any returned `reported_at`. On `login_required`, ask the user to sign in or complete verification themselves using the desktop Worker's **打开知乎登录页**. For `identity_mismatch`, ask them to verify the logged-in account. Report `expired` or `unavailable` honestly; don't queue replacement requests without asking. Never request credentials, cookies, or verification codes.
