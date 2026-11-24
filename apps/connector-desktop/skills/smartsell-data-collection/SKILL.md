---
name: smartsell-data-collection
description: Use when the owner asks about their own social accounts or the posts SmartSell made — account or login status, which posts went out or are scheduled — or asks for metrics or platform data (查我的社媒狀態、帳號登入、發了哪些、排了哪些、成效數據；查我的社媒状态、发了哪些视频; check my social accounts, what was posted, metrics).
argument-hint: "[accounts or platform, local date range]"
---

# 帳號狀態與貼文查回（第 1 階段）

Use only the SmartSell MCP tools this connection lists (the 11 hub tools, starting with `smartsell_overview`). They read SmartSell's own records and the owner's machines, not the platforms' analytics.

1. **Account status.** `smartsell_overview` (empty arguments) gives machines, channels (`channel_id`), the workspace time zone and what waits for the owner. `channels_list` (optional `provider`, `machine_id`) gives each channel's machine, login state, mode, approval, limits and the blockers that stop scheduling. To confirm a login now, call `channel_check` with a `channel_id` you read: `done` has the result; `pending` → read the same `task_id` with `task_get` later; `machine_offline` → that machine is off, say so. Signing in again is the owner's step: 「重新登入」 on the account page brings that account's SmartSell Chrome sign-in window to the front on its machine.
2. **What SmartSell posted or will post.** `posts_list` (local dates `from`/`to`, `status`, `channel_id`, `machine_id`; default today to 7 days ahead) and `post_get` for one post. Report local time, machine, status and `web_url`. Only `published` went out; a post whose result is unknown stays unknown until the owner confirms it in `web_url`.
3. **What SmartSell does not read in phase 1:** posts made outside SmartSell, follower counts, views, likes and other metrics. Say plainly that SmartSell cannot see them yet. Do not fall back to a browser, the local Chrome, web search, shell, curl, proxies or scraping, and never report a missing number as zero.
4. Report errors with their code and message, and any `web_url` the tool gives. Machine and login problems are fixed by the owner.
