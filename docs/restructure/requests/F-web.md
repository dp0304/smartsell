# F-web (wave 5): owner-dashboard fixes for W-specs #1–#4 and L-fix #3

F-web owns `apps/web/**`, `tests/web-e2e/**` and `apps/web/test/**` this wave. No server file was changed.

## Done

### W-specs #1: the relay token file is saved as `token` (`apps/web/src/view/pages/setup-hub.tsx`)

`AgentConnectWays` now creates the token blob as `application/octet-stream` (was `text/plain`) with `download="token"`.
Chrome adds `.txt` only for `text/plain`, so the file the owner gets is `token`. That matches the status line
(「權杖檔已下載為 token；把它移到 ~/.smartsell/token …」) and the relay command (`--token-file ~/.smartsell/token`).
The file content is unchanged (`<token>\n`), and the wizard test still checks it byte for byte.

### W-specs #2: a failed machine read is an error, not "no machines yet" (`apps/web/src/view/pages/GetStartedPage.tsx`)

- The steps now receive the read itself (`ViewResult`), not `value`. `MachinesStep` renders the paired-machine list through
  `<Loaded>`, so a failed read shows `ProblemNotice` (role `alert`) with 重試 under 「已配對的機器」, and 「還沒有機器」 appears
  only after a successful empty read.
- `ChannelsStep` reads machines and then channels through `<Loaded>`. A failed machine read no longer says
  「先完成「連接機器」」, and a failed channel read no longer says 「這台機器還沒有帳號」. `NotificationsStep` shows the push count
  through `<Loaded>` the same way. `AgentStep` shows `ProblemNotice` with 重試 when `/agent-connections` failed.
- Step completion comes only from a successful read. `value` is kept across a failed refetch, so data from an earlier
  successful read still counts. A step whose read failed before it ever succeeded now shows 「無法讀取」 / "Could not read"
  (`data-status="failed"`, the existing critical style) in the progress list, not 待設定. The channel step also shows it when
  the machine read failed.

### W-specs #3: the one-time prompt survives 上一步／下一步 (`GetStartedPage.tsx`)

`issued` (the `AgentEnrollment` from `/agent-connections/enroll`) now lives in `Wizard` and goes to `AgentStep` →
`SetupAgent` as `issued`/`onIssued`. Leaving the Codex step and coming back shows the same command and code. `SetupAgent`'s
own expiry check (`expires_at`) still applies on remount, so a code that has expired in the meantime shows
「接入碼已到期。…」 instead of a stale code. The Agent page already kept `issued` at page level and is unchanged.

### W-specs #4: the prompt preflight and the check prompts use `smartsell_overview` (`apps/web/src/view/pages/setup-agent-prompt.ts`)

- `preflight()` now requires `smartsell_overview` in `tools/list` (was `smartsell_operations_describe`). Every phase-1
  connection (`tool_profile: 'hub_v1'`) lists it among the 11 hub tools (§7.1, §7.4).
- The installer's closing line and both check prompts (`agentCheckPrompt`, zh-Hant and English; it serves both Codex and
  Claude Code, including the repair and resume prompts) now tell the client to call `smartsell_overview` with empty
  arguments. Its schema is `z.object({}).strict()`.
- **Server side, checked and left unchanged:** `apps/server/src/integration/command-mcp.ts` (MCP audit `persist`, ~line 420)
  calls `verifyAgentConnection(context, selected.id)` for **any** tool call whose outcome is `success`.
  `verifyAgentConnection` in `apps/server/src/integration/agent-connections.ts` stamps `mcp_client_verified_at` and does not
  check the tool name. So a call to `smartsell_overview` already verifies the connection, as the phase-1 wizard spec shows
  (`agent.call('smartsell_overview')` → 「已有 Agent 透過 MCP 呼叫過 SmartSell。」). No server line was needed.

### L-fix #3: `RELOGIN` moved into `hub-copy.ts`

`RELOGIN` (button, hint, opened, offline, busy, done) is now exported from `apps/web/src/view/hub-copy.ts`
(`as const satisfies Table`). `ChannelPage.tsx` and `TodayPage.tsx` import it from there. `requestRelogin` and
`reloginMessage` stay exported from `ChannelPage.tsx`. The unused `hub.channels.relogin`, `hub.channels.reloginHint` and
`hub.channels.loginOpened` are deleted. `relogin.test.tsx` imports `RELOGIN` from `../hub-copy`.

### Specs

- `tests/web-e2e/phase1-dashboard.spec.mjs`: both `test.fail` lines are removed. The failed-read test also checks that
  連接機器 and 新增帳號 show 「無法讀取」, that the channel step shows the error and not 「先完成「連接機器」」, and that after
  `page.unroute` 重試 brings Mac-B back with 連接機器 已完成.
- `tests/web-e2e/view-shell.spec.mjs`: both `test.fail` lines are removed. The prompt-enrollment spec runs on the default
  dev server (`test`, not `legacyToolList`). Its native client call is now `smartsell_overview`, it checks that `tools/list`
  equals the 11 hub tools exactly, and it checks that the check prompt names `smartsell_overview`.
- `tests/web-e2e/local-dev.mjs`: `localLegacyToolList` and the `listLegacyTools` / `SMARTSELL_MCP_LIST_LEGACY` launch option
  are removed. Nothing else used them. The server-side `SMARTSELL_MCP_LIST_LEGACY` switch and its server tests are untouched.
- `tests/web-e2e/phase1-shell.mjs`: `wizardText` gains the `unread` status (「無法讀取」 / "Could not read") for
  `expectStepStatus`.
- New unit tests: `apps/web/src/view/pages/setup-agent-prompt.test.ts` covers the preflight tool name and both check
  prompts in both languages. `setup-page.test.tsx` gains "a failed machine read is an error with 重試 …", and its render
  helper takes `failing` paths (`retryOnMount: false` keeps an errored query errored in the static render).
- `SMARTSELL_E2E_SHOW_KNOWN_BUGS` is no longer referenced by any spec.

## Test runs

- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck`: exit 0, before and after the last edit.
- `node scripts/test.mjs apps/web/src`: 123/123 pass, twice.
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs apps/web/test`: 6/6 pass, twice.
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs tests/web-e2e/phase1-dashboard tests/web-e2e/view-shell`:
  11/11 pass, including the four former `test.fail` tests as ordinary tests.
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs tests/web-e2e`: the last two consecutive runs (5 and 6)
  were 114/114 each. Earlier runs:
  - Runs 1 and 3: 114/114.
  - Run 2: 113/114. The failure was `portal.spec.mjs` TE06, where tearing down the spec's own `localPortal` fixture exceeded
    the 60 s timeout. That fixture does not use `local-dev.mjs` or any file changed here. It passed in every other run.
  - Run 4: killed by a signal (exit 144) in the middle, at the same moment another session started its own full
    `tests/web-e2e` run. Runs 5 and 6 waited for that run to finish first.

## Open: outside F-web's files

1. **Docs / lead:** `README.md:13` and `docs/agent-guide.md:41` still tell the owner to call `smartsell_operations_describe`
   after the prompt enrollment. With W-specs #4 fixed, the web prompts say `smartsell_overview`. Any successful tool call
   verifies, so the old wording still works, but it names a tool `tools/list` no longer shows.
2. **W-specs ledger:** items 1–4 can be marked closed in `docs/restructure/requests/W-specs.md`, including the paragraph
   "Running the known-bug tests unmasked" and the `view-shell:83` row "runs with the §7.4 debug switch because of #4".
   That file belongs to W-specs, so F-web did not edit it.
3. **Codex routing block (S7 / lead, no change made):** `setup-codex-routing.ts` (installed into `AGENTS.md` by the Codex
   prompt) still routes social-status questions to `worker_social_status_request` / `worker_social_status_get`. Those are
   legacy tools: callable by name but not listed to hub_v1 connections. Changing the block also changes the managed-block
   upgrade bytes (`previousCodexRouting`), so it needs a deliberate decision rather than a drive-by edit.
4. **Flaky teardown (portal owner):** `tests/web-e2e/portal.spec.mjs` TE06 once exceeded the 60 s timeout while tearing
   down its own `localPortal` fixture (run 2 above). A likely cause is the HTTPS portal server's `close()` waiting on
   keep-alive connections. It was not reproduced and not touched here.
