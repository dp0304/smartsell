# F-server (wave 5): closure and requests

F-server closed the wave-4 server requests: S8.md items 1, 3, 4 and 7, L-fix.md items 1 and 2, S8-RM.md item 3 (E30), and
the CI part of E28. Nothing was committed, downloaded or installed; no real platform was touched.

## What changed

### 1. `planning/publishing.test.ts` follows E23 (S8.md item 7)

The product is right; the two tests encoded the pre-E23 behaviour. `applyApprovalModeChange` (direct → needs_approval)
retires the channel-policy approval while the target is still `ready` (blockUnsent → `revokeForTarget`, which keeps a
matching unstarted job), then moves the target to `awaiting_approval` and calls `revokeForTarget(…, 'approval_invalidated')`
again in the same transaction (E23), before the new pending request is created.

- "switching direct → needs_approval withdraws …": the hook now records, per call, the post's state as the engine sees it.
  It asserts exactly one pair per post, in post order: `ready:invalidated` (retire), then `awaiting_approval:invalidated`
  (E23, before resubmission). Not loosened: a missing or extra call, or the E23 call after resubmission, fails it.
- "with the job engine installed, withdrawing a direct approval revokes the unstarted job in the same transaction (E23)"
  (renamed; the old title said the job is held): the queued job is `cancelled` with `revoke {reason: approval_invalidated,
  requested_at: now}` and `finished_at`, exactly one `revoke_requested` event (`cancelled_unclaimed`), no live publish job,
  the task is neither cancelled nor cancel-requested, the post waits with a pending request, and approving again dispatches
  a new queued job (new id, `worker_job_id` updated).
- New case "a claimed job is released, a started job follows §5.10 …": claimed → `releasing` and the post waits at once;
  running (started) → stays `running` with the revoke pending, the post stays `ready` with the approval invalidated and is
  not resubmitted (`requeued_posts: 0`), and the machine's sync generation is bumped (`job_revoked`) in both cases.

### 2. `hub_channels_check {open_login_window}` is gated in the shared runner (L-fix.md item 1, E32)

- `apps/server/src/operations.ts`: `AGENT_HUMAN_FIELDS.hub_channels_check = ['open_login_window']`. `posting/check.ts`
  keeps its `requireHuman` guard (comment updated: the runner refuses first, the guard is defence in depth).
- `tests/phase1/human-only.test.ts` (S8.md item 1):
  - shared runner: the real `hub_channels_check` operation with `run` stubbed refuses `open_login_window` = true, false,
    `'yes'` and `null` for an Agent grant with 403 `HUMAN_REQUIRED`, never runs it, and writes no record. The Agent's plain
    `{}` and the owner's `{open_login_window: true}` both reach `run()`. This discriminates the runner gate from the local
    guard, which the stub replaces.
  - over MCP (real hub-mode server, real agent token): `smartsell_operation_call {operation:'hub_channels_check',
    params:{id:<random>}, body:{open_login_window:true|false}}` → `HUMAN_REQUIRED`; the same call with `{}` reaches the
    handler (`CHANNEL_NOT_FOUND`); the owner's REST call with `open_login_window:true` on a random id gets 422, not 403.
  - nothing created: a last case stops the hub and reads its SQLite snapshot (`tests/e2e-phase1/hub-records.ts`): no
    `worker_job`, no `worker_job_event` (and the agent connection is there, so the reader sees real records).
- `operations-agent-boundary.test.ts` passes (`hub_channels_check` is Agent-callable).

### 3. Today: login cards and the channel_setup split (L-fix.md item 2, S8-RM.md item 3, E30)

`apps/server/src/modules/workspace/views/today.ts`:

- Every `login` card (post blocker `login_expired` / `identity_mismatch`, and session `login_required` / `identity_mismatch`
  / `challenge`) has `actions[0] = {kind:'open_login', label:'重新登入', method:'POST', path:'/hub/channels/<id>/check',
  body:{open_login_window:true}}`, then `check_login`, then `open`. The interim "在 … 的 SmartSell Worker 按「重新登入」" copy
  is gone; the texts are L-fix's suggestions (post card and `login_required`), and the `identity_mismatch` / `challenge`
  session cards now say what 「重新登入」 does on that machine.
- The `channel_setup` card is split (both keep `kind: 'channel_setup'`, so the web's badge and actions are unchanged):
  - `channel:<id>`, `blocks_scheduling: true`: only `channels[].blockers` (can_schedule false). Title
    「<channel> 還沒設定完成，還不能排程（n 項）」; urgent when the channel has posts in the next 48 h (as before).
  - `channel:<id>:reminder`, `blocks_scheduling: false`, always `normal`: the items that never stop scheduling, each worded
    with what really happens until the owner acts:
    - only the dry run missing → title 「建議：<channel> 試跑一次」, detail ends 「不影響排程與發布。」;
    - otherwise 「<channel> 的設定提醒（n 項，不影響排程）」 with: 還沒確認登入 (the machine checks before posting; a
      signed-out post stops and waits; the card gets a 「檢查登入」 action), 還沒選擇核准方式 (each post waits for approval
      until chosen; if the stored mode is already `direct`, it says posts go out without approval), 還沒確認代按發布的風險
      (until confirmed the owner presses 「發布」 on that machine), 還沒試跑 (「不影響排程與發布」).
  - The id `channel:<id>:reminder` sorts right after `channel:<id>` (a `channel_reminder:` prefix sorted before it).
- `blocks_scheduling: boolean` is on every attention item (`HubAttentionItem = AttentionItem & {blocks_scheduling}`), true
  only for the blocker card. `buildToday` / `buildOverview` return the extended types (additive; Appendix A unchanged).
- Agent projection (`apps/server/src/modules/posting/views.ts`, `attentionCompact`): `smartsell_overview.needs_owner[]`
  carries `blocks_scheduling`. The `smartsell_overview` description in `mcp-hub-tools.ts` is unchanged (S8-RM's two
  sentences kept; no new sentence, so the real-model gate results stay valid for the description).
- Tests: `views/today.test.ts` (2 new cases: login card actions and exact copy for all three session states and the post
  card; the split with the dry-run-only suggestion, the three-reminder card, a paused-machine blocker with
  `can_schedule false`, and `blocks_scheduling` true only for `channel:<id>`), `views/channels.test.ts` (split asserted on
  the TikTok card), `posting/posting.test.ts` (every `needs_owner` item has a boolean `blocks_scheduling`; only the blocked
  channel's blocker card is true).

### 4. Relay socket guard (S8.md item 3, E29 (2))

- `packages/agent-relay/src/socket-guard.ts`: a copy of `apps/connector/src/socket-guard.ts` (same `Symbol.for` key, so a
  process that loads both installs it once). `relayMain()` installs it first thing (covers `node smartsell-relay.mjs` and
  the Worker App's `--mcp-relay` mode).
- `packages/agent-relay/test/socket-guard.test.ts`: relayMain installs it (not installed by import), idempotent; the
  EINVAL simulation on a real socket; global `fetch` to a server that resets the connection, with every socket's
  `setsockopt` failing, rejects with no uncaught exception. Checked without the guard: the same script dies with the
  uncaught `setTypeOfService EINVAL` on this Mac (Node 24.16.0, undici 7.25.0).
- `packages/agent-relay/dist/smartsell-relay.mjs` rebuilt with the package's own `scripts/build.mjs` (local esbuild, run
  from the package directory so the path comments match). The diff against the old bundle is only the guard and its call.
  The Worker App's own copy (`apps/connector-desktop/dist/agent-relay/`) is rebuilt by that app's build; not touched.

### 5. `smartsell_overview.workspace.name` on a fresh hub (S8.md item 4)

Where the name lives: hub setup (`POST /api/v1/setup`, `auth.ts`) stores `workspaceName` in the local store's snapshot
(`MemoryStore.setup` → `state.workspaceInfo.name`). Operation reads get the name only from `ctx.workspaceName`, which
`workspace-services.ts` read from an identity record that the local/memory store does not have, so `workspace(ctx).name`
was `undefined` → `""` (REST views and MCP alike).

Fix (no new Operations record): `MemoryStore`'s unit context carries `workspaceName` (from `workspaceInfo`, same workspace
only); `workspace-services.ts` uses the identity record's name and falls back to it; `modules/types.ts` Context gains an
optional `workspaceName`. A saved workspace name (`workspace_update {name}`) still wins.

Why not create the Operations `workspace` record at setup: the get-started form (`GetStartedPage.tsx`) treats
`version > 0` as "the owner already saved settings" and would then default the time zone to `UTC` instead of the browser
zone; and `workspace_update` without If-Match conflicts once a row exists. Carrying the name avoids both.

Test: `integration/mcp-hub-tools.test.ts` §7.6 case asserts `MakeMyLure` (the setup name) in MCP `smartsell_overview`,
REST `views/overview` and `workspace_get` (the form's prefill), with a settings row that has no name (made by the time
zone PATCH). Checked that it fails (`''`) with the memory.ts line removed.

### 6. CI verify job (E28)

`.github/workflows/ci.yml`, job `verify`:

- `sudo apt-get install -y ffmpeg` after `playwright install --with-deps` (which already ran `apt-get update`), the same
  line the `services` job uses. ffmpeg is not on the ubuntu-24.04 image (its apt list has only `mediainfo`).
- A step that resolves `google-chrome-stable` / `google-chrome`, prints its version and exports `SMARTSELL_CHROME_PATH`;
  it fails the job if Chrome is missing, so the Chrome tests cannot silently skip.
- `timeout-minutes` 20 → 60.

What was checked (CI cannot run here):

- `tests/e2e-phase1/stack.ts` looks for Chrome at `SMARTSELL_CHROME_PATH`, the macOS paths, `/usr/bin/google-chrome-stable`,
  `/usr/bin/google-chrome`, and skips every E2E file (`stackUnavailable`) when none exists. It passes
  `SMARTSELL_TEST_MODE=1` and `SMARTSELL_CHROME_PATH` to the headless runners. ffmpeg: `video.ts` tries `/usr/bin/ffmpeg`;
  ffprobe is found on `PATH` (`/usr/bin`) by the hub.
- The Worker's launcher (`apps/connector-desktop/src/chrome.ts`): `findChrome` honours `SMARTSELL_CHROME_PATH` in test mode
  and otherwise looks in `/usr/bin/google-chrome-stable`, `/usr/bin/google-chrome`, `/opt/google/chrome/chrome` on Linux. It
  spawns Chrome with `--headless=new --remote-debugging-pipe` and no `--no-sandbox`.
- `scripts/playwright-browser.mjs` only serves the Playwright configs (`SMARTSELL_TEST_CHROME` / channel); the Workers never
  read it. So `SMARTSELL_TEST_CHROME` is the wrong variable for them, and it is not set.
- The ubuntu-24.04 runner image ships Google Chrome (runner-images `Ubuntu2404-Readme.md`, "Browsers and Drivers") with an
  AppArmor profile for `/opt/google/chrome`. Playwright's Chromium under `~/.cache/ms-playwright` would stop with "No usable
  sandbox!" on 24.04 (AppArmor's unprivileged user namespace restriction; runner-images #12096) because the Worker does not
  pass `--no-sandbox`. Playwright adds `--no-sandbox` to its own launches, so the Playwright specs are unaffected. That is
  why the Workers get the image's Chrome, not Playwright's Chromium.
- The runner's `pair` gets `--platform darwin|win32` from the stack, so Linux is accepted; the hub's startup checks treat
  Linux like macOS (0700 hub dir); `selectAllModifier` uses Control on Linux.

## For the lead

1. Design text: §9.2 / §7.2.1 for E30 as implemented (two `channel_setup` cards, ids `channel:<id>` and
   `channel:<id>:reminder`, `blocks_scheduling` on every attention item and on `needs_owner[]`). §9.2 login cards: `open_login`
   first (E21/E32).
2. CI is unverified until a run: if Chrome on the runner still fails to start (sandbox), the fallback is the Chromium doc's
   option of `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` in the job, not `--no-sandbox` in the product.
   Also watch the E2E timings on a 4-vCPU runner: `scripts/test.mjs` runs node files with `--test-concurrency=3` there, so the
   seven long E2E files share three slots with the rest of the node suite. If the suite gets close to 60 minutes, a separate
   job for `pnpm test:e2e-phase1` (all files in parallel) is the cleaner split.
3. Files outside the named list that F-server touched for item 5: `apps/server/src/memory.ts` (one spread in the unit
   context), `apps/server/src/integration/workspace-services.ts` (one fallback), `apps/server/src/modules/types.ts` (one
   optional field). For item 3: `apps/server/src/modules/posting/views.ts` (the agent projection) and its test
   `posting/posting.test.ts`, and `views/channels.test.ts`.

## For F-web (optional, nothing breaks without it)

- `AttentionItem` from `views_today` now has `blocks_scheduling: boolean`; TodayPage could show the reminder card
  (`channel:<id>:reminder`) quieter than a blocker. The reminder card may carry a `check_login` action (rendered by the
  existing generic button path).

## Tests run (this Mac, Node 24.16.0)

- `node scripts/test.mjs apps/server/src/modules/planning/publishing.test.ts` (vitest): 41 passed (2 rewritten, 1 new).
- `node scripts/test.mjs apps/server tests/phase1 tests/connector-desktop packages/agent-relay`: node 903 passed, 0 failed,
  16 skipped (15 PostgreSQL cases without a database, E2E-11 gated by `SMARTSELL_TEST_LARGE`); vitest 76 passed. This
  covers planning, operations, operations-agent-boundary, human-only, workspace views, posting, mcp-hub-tools and the relay.
- `node scripts/test.mjs apps/connector/test/socket-guard`: passed.
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck`: exit 0.
- Not run: `tests/e2e-phase1` (lead), CI (cannot run here), the real-model check (the tool description is unchanged, but
  `needs_owner` now carries `blocks_scheduling` and the reminder wording changed; whether to rerun §10.3 is the lead's call).
