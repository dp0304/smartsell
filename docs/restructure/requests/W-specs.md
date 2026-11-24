# W-specs (Playwright specs for the phase-1 owner dashboard): requests to other workstreams

W-specs owns `apps/web/test/**`, `tests/web-e2e/**` and the Playwright configs, plus accessibility names in `apps/web/src/**`
(not `ChannelPage.tsx` / `TodayPage.tsx`). Everything below is a change in a file W-specs does not own.

**Status (wave 6, G6-relay-docs): items 1–4 are closed.** F-web fixed all four in wave 5 (`docs/restructure/requests/F-web.md`).
Checked again against the current code:

| # | Fix in the code | Spec, no longer masked |
|---|---|---|
| 1 | `setup-hub.tsx` `AgentConnectWays` makes the token blob `application/octet-stream` with `download: 'token'`, so Chrome saves `token` | `phase1-dashboard.spec.mjs` 「Agent page: the relay token file is saved under the name the page tells the owner」, ordinary test |
| 2 | `GetStartedPage.tsx` renders machines, channels and push through `<Loaded>` (`ProblemNotice` with 重試); completion only from a successful read | `phase1-dashboard.spec.mjs` 「Wizard: a failed machine read is shown as an error, not as "no machines yet"」, ordinary test |
| 3 | `issued` lives in `Wizard` and goes to `AgentStep` as `issued`/`onIssued` | `view-shell.spec.mjs` 「the issued one-time prompt survives leaving the Codex step and coming back」, ordinary test |
| 4 | `setup-agent-prompt.ts` `preflight()` requires `smartsell_overview`; both check prompts call it; any successful call verifies (§7.4) | `view-shell.spec.mjs` 「the prompt enrollment passes its MCP preflight against the default phase-1 tool list」, ordinary test; the prompt-enrollment spec runs on the default dev server (`localLegacyToolList` and `SMARTSELL_MCP_LIST_LEGACY` are gone from `tests/web-e2e`) |

No spec in `tests/web-e2e` carries `test.fail` or reads `SMARTSELL_E2E_SHOW_KNOWN_BUGS` any more. The sections below are kept as
the record of what was reported.

## 1. Relay token file is saved as `token.txt`, while the page says `token` (S7, `apps/web/src/view/pages/setup-hub.tsx`) — **closed (F-web, wave 5)**

**Where:** wizard step 「連接 Codex」 and Agent page → 「方式二：Node relay」 → 「建立連線並下載權杖檔」 (§6.2 step 6).

**Reproduce:** open `/app/:ws/agent` in Google Chrome, click 「建立連線並下載權杖檔」. The status line says
「已建立「…」。權杖檔已下載為 token；把它移到 ~/.smartsell/token …」, but Chrome saves the file as `token.txt`
(`AgentConnectWays` downloads a `Blob` of type `text/plain` with `download="token"`; Chrome adds the extension for that MIME
type). An owner who follows the text moves a file named `token` that does not exist, and the relay command
(`--token-file ~/.smartsell/token`) then fails to read it.

**Fix (either):** create the blob as `application/octet-stream` so Chrome keeps `token`, or name the file `token.txt`
everywhere (status line and the two commands).

**Test:** `tests/web-e2e/phase1-dashboard.spec.mjs` 「Agent page: the relay token file is saved under the name the page tells
the owner」 is marked `test.fail` with this item; it turns red (unexpected pass) once fixed — then drop the `test.fail` line.

## 2. Wizard says 「還沒有機器」 when the machine read fails (S7, `apps/web/src/view/pages/GetStartedPage.tsx`) — **closed (F-web, wave 5)**

**Where:** `/app/:ws/get-started?step=machines` (and `?step=channels`, and the progress list).

**Reproduce:** pair a machine and let it heartbeat (Today shows it 在線). Make `GET /api/v1/workspaces/:ws/views/machines` fail
(hub restarting, proxy error; in the test `page.route(..., route => route.abort())`) and open the machine step. It says
「還沒有機器。照上面的步驟在那台機器完成配對。」, the channel step says 「先完成「連接機器」。」 and 連接機器 shows 待設定 — a false
state with no error and no retry. `MachinesStep`/`ChannelsStep` receive `machines.value` only, so "unknown" reads as "none".
The pre-phase-1 wizard showed 「無法讀取機器狀態」 for this case (old spec `worker-onboarding` 「Could not read worker status」).

**Fix:** pass the read to the steps and render `<Loaded>`/`ProblemNotice` (with 重試) when it failed; compute `done` only from
a successful read.

**Test:** `tests/web-e2e/phase1-dashboard.spec.mjs` 「Wizard: a failed machine read is shown as an error, not as "no machines
yet"」 (`test.fail`, turns red once fixed).

## 3. The one-time prompt is lost when the owner leaves the Codex step and comes back (S7, `GetStartedPage.tsx`) — **closed (F-web, wave 5)**

**Where:** wizard step 「連接 Codex」 → 「進階：舊的接入方式（提示詞）」 (the prompt enrollment kept under 「進階」, §9.8).

**Reproduce:** generate a Codex prompt (「產生接入提示詞」), press 上一步 then 下一步, open 「進階」 again: the command and the
one-time code are gone (only 「產生新的接入提示詞」 or the check prompt), although the code is still valid for 10 minutes. The
owner has to issue another enrollment. `AgentStep` keeps `issued` in its own state and unmounts on every step change; the
pre-phase-1 wizard kept it at page level (old spec `view-shell` 「暫時跳過這一步 → 上一步 keeps the prompt」).

**Fix:** lift `issued` into `Wizard` (as the old `SetupProgress` did) and pass it down.

**Test:** `tests/web-e2e/view-shell.spec.mjs` 「the issued one-time prompt survives leaving the Codex step and coming back」
(`test.fail`).

## 4. The prompt enrollment's preflight fails against phase-1 connections (S7 `setup-agent-prompt.ts`, or S4 `command-mcp.ts`) — **closed (F-web, wave 5)**

**Where:** wizard 「連接 Codex」 → 「進階：舊的接入方式（提示詞）」, and Agent page → 「進階：舊的接入方式」 (both still offered, §9.8).

**Reproduce:** generate a Codex prompt and run it in a terminal (with `codex` on PATH). It stops with
「MCP 預檢未通過。請確認服務位址、TLS、連線是否到期及工作區權限，再執行同一區塊重試。」 and registers nothing. The preflight
(`setup-agent-prompt.ts` `preflight()`) requires `smartsell_operations_describe` in `tools/list`, and the check prompt asks the
client to find and call that tool; but every connection created from phase 1 on (including `/agent-connections/enroll`) has
`tool_profile: 'hub_v1'` and lists only the 11 hub tools (§7.4, `command-mcp.ts:181`). So the advanced path can never
complete, and a real client would not find the tool the check prompt names.

**Fix (either):** S7 — make the preflight accept the hub tool list (e.g. require `smartsell_overview`) and change both check
prompts to call `smartsell_overview`; or S4/lead — give prompt enrollments the `legacy` tool profile. The first matches §7.1.

**Test:** `tests/web-e2e/view-shell.spec.mjs` 「the prompt enrollment passes its MCP preflight against the default phase-1 tool
list」 (`test.fail`). The full prompt-enrollment spec in the same file runs on a dev server with the §7.4 debugging switch
`SMARTSELL_MCP_LIST_LEGACY=1` (`localLegacyToolList` in `tests/web-e2e/local-dev.mjs`) so its other checks keep running; drop
the switch when this is fixed.

## Running the known-bug tests unmasked (closed)

There are no masked known-bug tests any more: the four former `test.fail` tests are ordinary tests since F-web's wave-5 fixes, and
`SMARTSELL_E2E_SHOW_KNOWN_BUGS` is no longer read by any spec. Run them as usual:
`SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs tests/web-e2e/phase1-dashboard tests/web-e2e/view-shell`.

## Coverage map: the 22 specs that asserted the pre-phase-1 UI (E26)

(a) behaviour kept, steps moved to the §9 pages; (b) kept behind 顯示其他模組 or a deep link; (c) removed by design, replaced by
the phase-1 equivalent.

| Spec | Protects | Now |
|---|---|---|
| `apps/web/test/rest-workbench` | empty workspace opens setup; advanced workbench writes; skip lands on the dashboard index | (a) five-step wizard (`phase1-shell.mjs` `expectWizardStep`), 「Finish later」 → Today (§9.1) |
| `apps/web/test/worker-social-audit` | MCP audit receipts per task; Zhihu incident shown | (a) audit on the Agent page's 開發者 tab (§9.8, B29); (b) Zhihu incident only with 顯示其他模組, asserted hidden before |
| `account-migration` ×2 | admin reaches Account security in the advanced workbench | (a) wizard → Today; (b) advanced workbench from Settings → 進階工作台 (the sidebar link is hidden, §9.1) |
| `command-identity:92` | invited reviewer lands on the dashboard index in its own session | (a) Today, and no 「開始設定」 for a reviewer |
| `operator:188` | default setup → dashboard → advanced workbench links | (a) wizard step 1 of 5, Today (developer mode keeps the sidebar link) |
| `primary:113,162×3,235` | first-run setup and sign-in in both languages, the three roots | (a) wizard with all five steps 待設定/選填, Today reads `views_today`, advanced workbench via Settings |
| `view-shell:83` | prompt enrollment for Codex and Claude, preflight, verification only after a tool call, repair | (b) under 「進階：舊的接入方式（提示詞）」; runs on the default dev server since #4 was fixed (the §7.4 debug switch is gone), and #3 and #4 have their own ordinary specs |
| `view-shell:263` | Agent enters a launch over MCP; owner sees and approves it | (a) approval card on Today (待你決定 merged into 要你處理, §9.1); (b) overview, products, plans, decisions behind 顯示其他模組; tools/list = 11 hub tools, older tools called by name (§7.4) |
| `worker-onboarding:273` | empty workspace enters onboarding after registration, root and re-login | (a) wizard reads all return 200 after each re-login; 390 px fits |
| `worker-onboarding:316` | skipping completes nothing; deep links resolve after login | (a) 下一步 leaves steps 待設定; old `?step=worker|social|store|import` open 連接機器; products deep link (b) |
| `worker-onboarding:383` | installer download; pairing link only on request; machine states | (c) §2.9: no pairing link at all — asserted no textbox, no code request; machines appear by themselves, online/offline/revoked; failed-read case is bug #2 |
| `worker-onboarding:572` | enabling channel registration for one existing worker | (c) §2.9 single pairing path with the grant, §1.2 no old devices: only a granted machine can register (403 otherwise), channels land under their machine |
| `worker-onboarding:633` | wizard completion; signed CSV/XLSX catalog imports | (a) Codex step via the §6.2 relay token file, two machines; (c) web social-account registration → Worker channels (§8.16, §9.8); (b) store imports via `/products` deep link unchanged |
| `worker-onboarding:838,871` | store management recovery | unchanged; fixture now pairs through the grant and connects the Agent over REST |
| `worker-onboarding:911` | Zhihu jobs and the web login incident | (b) incident list only with 顯示其他模組; Zhihu tools hidden from tools/list but callable (§7.4) |
| `worker-onboarding:970` | existing data skips the wizard | (a) lands on Today |

New phase-1 specs (`tests/web-e2e/phase1-dashboard.spec.mjs`): first-run wizard to Today with a real paired machine, its
channel and a verified Codex connection; approving a Codex-scheduled post from Today; the channel page's risk acknowledgement
with the typed handle (and withdrawal); the post page timeline from signed job reports with reschedule and cancel (取消中 →
已取消); the bell with one alert marked read, then 全部標為已讀. Data comes only from the signed device protocol, the relay's
`media_upload` code and MCP `post_schedule` against the local dev server (`tests/web-e2e/phase1-fixture.mjs`).
