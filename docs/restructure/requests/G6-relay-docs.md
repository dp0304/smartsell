# G6-relay-docs (wave 6): relay hand-off and complete retry, phase-1 docs and Skills

Findings: MCP-2, MCP-3 (relay and App layer), COH-2 (docs, Skills, Codex routing block). Also closes W-specs items 1–4.
No contract change (`packages/contracts/src/phase1.ts` untouched), so no new E-number is needed. No deviation from E34–E46.

Files changed (all in G6's list):

- `packages/agent-relay/src/{hub-api.ts,uploader.ts,continue-upload.ts,media-upload.ts}`, `packages/agent-relay/README.md`,
  `packages/agent-relay/test/upload.test.ts`, `packages/agent-relay/dist/smartsell-relay.mjs` (rebuilt with `node scripts/build.mjs`)
- `apps/connector-desktop/src/app/upload-handoff.ts`, `tests/connector-desktop/app/upload-handoff.test.ts`
- `apps/connector-desktop/skills/{catalog.json,*/SKILL.md}`, new `apps/connector-desktop/skills/skills-tools.test.mts`
- `apps/web/src/view/pages/setup-codex-routing.ts`, new `apps/web/src/view/pages/setup-codex-routing.test.ts`
- `README.md`, `docs/agent-guide.md`, `docs/restructure/requests/W-specs.md`

## MCP-2: the relay trusted a stale hand-off (fixed)

Checked against the code: `handedOff` was a process-lifetime set. Once the App had said yes, every later `media_upload` for that
upload skipped both the hand-off and `startRun`, only polled, and said 「The SmartSell app continues this upload…」 even after the App
had quit, restarted for an update or given up. On the App side a failed run only set `view.status='failed'` in memory.

Changes:

- `media-upload.ts`: an earlier yes is never trusted. On every call for a receiving session that has chunks (or that this
  process handed off before) the relay asks the App again. `accept()` says yes without starting a second upload while its run is
  alive, and starts a stopped run again. If the App says no or is not listening, the relay uploads the rest itself in the same call.
  While it only watches, it asks the App again whenever no bytes arrive for `handoffRecheckMs` (default 10 s), and takes over on a no.
  `handedOff` is now only a hint for whom to ask first.
- Two races in the same code are closed. A run handed off at the deadline leaves `runs` at once, so a call that arrives before the
  aborted run unwinds asks the App instead of joining a stopped run. The `finally` of an old run no longer deletes a newer run that
  has the same id.
- `upload-handoff.ts`: when the App gives up on a run, it aborts the hub session (see MCP-3) and only then marks the run failed.
  A run that has stopped never blocks the next hand-off: `accept()` already started it again, and this is now tested.
  Quitting or updating (`stop()` aborts our own signal) is not giving up, so nothing is aborted and the next App instance resumes it.

Tests (each failed before the fix):

- `packages/agent-relay/test/upload.test.ts`, 「MCP-2: after the App quit, the next media_upload for the same path asks again,
  gets no answer and uploads the rest itself」. Before the fix it returned `uploading`, `continues_in_background: true` and
  4194304 bytes, which is the reviewer's repro output.
- Same file, 「MCP-2: while it watches an upload the App took, the relay asks again when bytes stop arriving and takes over on a no」.
- `tests/connector-desktop/app/upload-handoff.test.ts`, 「MCP-2: the App restarts (update) in the middle of an upload; the
  relay's next media_upload asks the new App, which finishes it」. This runs the real hub routes, the real relay handler and two real
  `UploadHandoff` instances on the same socket.

## MCP-3: complete was not retried; a background give-up left the session receiving (fixed)

Checked against the code: `driveUpload` called `api.complete` once and rethrew NETWORK_ERROR and 5xx. The relay's background run
only logged the failure to stderr, and the App only marked it failed in memory. No `abort` was sent, so no `upload_failed` alert
fired and the asset stayed `uploading`.

Changes:

- `continue-upload.ts`: new `retryComplete` retries on network errors, 5xx, 408 and 429, on the tuning schedule (1–16 s in the
  foreground, then every 30 s for 30 minutes in the background). The delays are read on each failure, the same way parts read them.
  The hub's complete is idempotent (`agent-uploads.ts` answers 202 with the status once a session is no longer receiving).
  `UPLOAD_INCOMPLETE` and 409 handling is unchanged.
- `driveUpload` takes `abortOnGiveUp?: () => boolean`. When the run fails on its own (not through its signal) while the session is
  still receiving, it calls `abort(id, 'error')`, best effort, then rethrows. The hub then fails the media and raises
  `upload_failed` (§6.3 step 9). After the hub has accepted complete it never aborts, because the hub's abort handler would fail an
  assembling session that is in fact finishing.
  - The relay passes `() => run.background`. A foreground failure goes to the model as a tool error and the session stays resumable.
  - `continueUpload` always passes true, since it is a background run.
- `hub-api.ts`: `complete` and `abort` accept an optional `AbortSignal`. There is one shared `transientHubError()`, which
  `uploader.ts` also uses.
- `upload-handoff.ts`: `#giveUp()` reads the session and calls `abort(id,'error')` only when the session is still `receiving`.
  It skips `UPLOAD_SESSION_MISMATCH`, so it never fails someone else's session, and it skips a stop the App made itself. Because of
  the status check it is a no-op when `continueUpload` already aborted, and it also covers errors thrown outside `driveUpload`.
  `abortUpload` is injectable for tests.

Tests (each failed before the fix, except the "no abort" guards):

- `upload.test.ts`, 「MCP-3: complete is retried after a network error and a 503, like parts; the background upload becomes ready」.
  Before the fix it threw HUB_UNREACHABLE after one complete call, which is the reviewer's repro.
- 「MCP-3: a background upload that finally gives up aborts the hub session, so the media fails and the owner is alerted」 (hub
  session `failed`/`MEDIA_FAILED`, asset `failed`, last alert `upload_failed`).
- 「MCP-3: the relay aborts the hub session only when its background run gives up, never for a foreground error the model can retry」.
- `upload-handoff.test.ts`:
  - 「MCP-3: when the App gives up on a hand-off, it aborts the hub session; the next hand-off starts the upload again」.
  - 「MCP-3: no abort when the App itself stopped the upload (quit, update), when the hub already assembles it, or for a foreign session」.
  - 「MCP-3: the App gives up while the hub is reachable; the hub marks the media failed and alerts the owner」 (real hub).

`packages/agent-relay/dist/smartsell-relay.mjs` was rebuilt with the package's own `node scripts/build.mjs`, which uses the esbuild
pinned by `apps/connector-desktop`; nothing was downloaded. `cli.test.ts` 「the esbuild bundle is one zero-dependency file…」 passes.

## COH-2: docs and Skills sent the model to tools hub_v1 does not list (fixed as hygiene)

The verifier refuted the severity: a stock client cannot call unlisted tools, so the stated failure cannot happen. The hygiene fix
was still requested.

- **README.md:** the top now describes phase 1:
  - One hub and a Worker on each machine; X and TikTok; per-account approval mode with the web's own labels
    (「Codex 說要發就直接發」/「要我在網頁按核准」). The Worker clicks Post only after a recorded risk acknowledgement, and
    unknown results are never re-posted.
  - Steps: install the hub (link to `docs/hub-setup.md`), pair Workers on their own machines, add accounts in the Worker, then
    connect Codex/Claude Code through the laptop App or the Node relay token file (`~/.smartsell/token`, with both
    `codex mcp add` and `claude mcp add` lines).
  - Verify by any successful call, e.g. `smartsell_overview`; the wizard's line 「已有 Agent 透過 MCP 呼叫過 SmartSell。」 is quoted
    exactly. Then the list of the 11 hub tools.
  - Every UI label quoted was checked in `apps/web/src` and `apps/connector-desktop/{ui,src}`.

  The old workbench and prompt enrollment, 「管理單一商品的跨平台發布」, the PostgreSQL deployment and `seed:demo` moved under
  「進階：第 2 階段之前保留的舊功能」, which says phase-1 connections do not list those tools. `smartsell_operations_describe` is no
  longer the verification step (also F-web open item 1).
- **docs/agent-guide.md:** the phase-1 section stays first. It now has:
  - 「查帳號狀態與已排、已發的貼文」: overview, channels_list, channel_check → task_get, posts_list, post_get; no platform metrics in
    phase 1; products not in phase 1.
  - 「接入與驗證」: App or Node relay, verification by any successful call.
  - An explicit "never re-post an unknown result" rule.

  Everything else is fenced under 「進階：第 2 階段之前保留的舊工具」, with a warning not to put it into phase-1 project rules.
  The fence demotes the old headings by one level. The legacy §4 送審 flow (with 「已送審 N 則，請到『待你決定』核准」) and the
  `worker_social_status_*` section were removed and replaced by a pointer to the hub tools that says why the old flow fails on hub
  channels. 守則 4 no longer names 『待你決定』, which is not a phase-1 page. The old connect paragraph now verifies with any
  successful call and describes the new routing block.
  `apps/server/src/integration/agent-connections.test.ts` still passes: it only checks that the downloadable guide mentions
  `smartsell_operations_describe`, which the fenced section still does.
- **Bundled Worker Skills:** all three were updated, and none stopped shipping. Three tests I do not own hard-code these three ids
  and their install counts: `tests/connector-desktop/skills.test.mts` (5), `smoke.mjs` and `package-smoke.mjs` (6).
  - `smartsell-video-publish`: the full phase-1 posting flow with the 11 hub tools (overview → media_upload → one post_schedule →
    report), owner approval and `click_post`, POST_* codes, never re-post unknown, X/TikTok only.
  - `smartsell-data-collection`: account status and SmartSell's own posts through the hub tools. It says phase 1 does not read
    platform posts or metrics, and never to use a browser or report missing numbers as zero.
  - `smartsell-product-listing`: it cannot work in phase 1 (products and stores are phases 4–6, §1.2), so it is now a boundary
    Skill. It tells the model to say so honestly, change nothing and not improvise with other tools or a browser; a post about the
    product still works through the posting flow. If the lead prefers to stop shipping it, see handoff 4.
  - `catalog.json` titles and descriptions are now zh-Hant (E11).
  - New guard test `apps/connector-desktop/skills/skills-tools.test.mts`: no Skill may name a tool outside the 11. It flags all three
    old Skills (they named `publishing_create_target`, `worker_social_status_*` and `smartsell_operations_describe`).
- **Codex routing block** (`setup-codex-routing.ts`):
  - The new block (v3) sends social-status questions to `smartsell_overview`, `channels_list`, `channel_check` → `task_get`, and
    posts to `posts_list`/`post_get`. It says phase 1 reads no other platform posts or metrics, and keeps the "no browser, shell,
    curl or scraping; missing is not zero" rules.
  - The shipped blocks are kept byte for byte: v1, and v2 (v1 plus the UUID-key and historical-receipt edits, installed until now).
    They are exported as `previousCodexRoutings`; `previousCodexRouting` is now v2, the block shipped right before.
  - New test `setup-codex-routing.test.ts`:
    - Pins SHA-256 of v1 and v2.
    - Checks the shared markers and that the block names only hub tools.
    - Runs the installer's own `install_codex_routing()` from the shipped repair command, with the bytes that command carries,
      under python3 against a temporary `CODEX_HOME`. Fresh install, idempotent re-run, in-place upgrade of every previous block the
      command carries (byte for byte around it), and an edited block kept with 「SmartSell 路由標記已被編輯或重複，已保留原文。」.
  - Limit until handoff 1 lands: the installer in `setup-agent-prompt.ts` recognises only one previous block. So an AGENTS.md that
    still holds v1, never upgraded to v2, is now kept with that message instead of upgrading. The test switches to all previous blocks
    by itself once the command carries `previous_codex_routings`.

## W-specs items 1–4 (closed)

Each fix was checked in the current code:

- `setup-hub.tsx` token blob is `application/octet-stream`.
- `GetStartedPage.tsx` uses `<Loaded>`/`ProblemNotice`, and `issued` lives in `Wizard`.
- `setup-agent-prompt.ts` preflight requires `smartsell_overview`.
- No spec in `tests/web-e2e` has `test.fail`, `SMARTSELL_E2E_SHOW_KNOWN_BUGS`, `localLegacyToolList` or `SMARTSELL_MCP_LIST_LEGACY`.

W-specs.md now has a status table at the top, a 「closed」 mark on each item, the "unmasked" paragraph closed, and the
`view-shell:83` coverage row updated.

## Handoffs (files G6 does not own)

1. **To the owner of `apps/web/src/view/pages/setup-agent-prompt.ts` (web, G4-web or lead):** let the installer upgrade every
   shipped block, not just the latest. I checked this exact change in a scratch copy of the installer: v1 and v2 both upgrade to v3.
   - Import `previousCodexRoutings` instead of `previousCodexRouting`.
   - In `commandBlock`, replace
     `` `previous_codex_routing = ${JSON.stringify(previousCodexRouting)}` `` with
     `` `previous_codex_routings = ${JSON.stringify(previousCodexRoutings)}` `` (a JSON array of strings is a Python list literal).
   - In `install_codex_routing()`, replace the line
     `old = re.search(b"^" + re.escape(previous_codex_routing.encode("utf-8")) + b"$", content, re.MULTILINE)` with
     ```python
                 old = next((match for match in (re.search(b"^" + re.escape(previous.encode("utf-8")) + b"$", content, re.MULTILINE)
                                                 for previous in previous_codex_routings) if match), None)
     ```
   - `setup-codex-routing.test.ts` then covers v1 and v2 automatically.
2. **To the owner of `tests/web-e2e/view-shell.spec.mjs` (W-specs / G4-web):** 「guided enrollment registers both stdio clients and
   preflight leaves verification pending」 asserts bytes of the old block and will fail on the new one:
   - Line 256 `expect(installedRules).toContain('mode: "recent_posts", platform: "x"');` → import `codexRouting` from
     `setup-codex-routing.ts` and assert `expect(installedRules).toContain(codexRouting);` plus
     `expect(installedRules).not.toContain('worker_social_status');`.
   - Line 268 `expect(upgradedBlock).toContain('UUID v4');` →
     `` expect(upgradedBlock).toBe(`${userRules}\n\n${codexRouting}${userSuffix}`); ``.
   - Lines 266 and 269 need no change: `previousCodexRouting` is now v2, which still contains 「其他工作照常。」, and the upgrade path
     is tested with the real installer in `setup-codex-routing.test.ts`.
3. **To the owner of `apps/server/src/integration/agent-connections.ts` (server integration):** `agentInstructions` is the fallback
   for `setup.agents_md` when `docs/agent-guide.md` cannot be read, and its "Typical flows" still lead to
   `publishing_create_target`/`publishing_request_approval` and `smartsell_operations_describe`. Replace it with the phase-1 rules.
   `hubInstructions` from `mcp-hub-instructions.ts` is a ready short text. If the existing test keeps
   `assert.match(created.setup.agents_md, /smartsell_operations_describe/)`, that still holds, because the real guide is read.
4. **To the lead (decision, optional):** if `smartsell-product-listing` should stop shipping instead of being a boundary Skill:
   - Remove it from `apps/connector-desktop/skills/catalog.json` and delete its folder (G6).
   - Change the counts in `tests/connector-desktop/skills.test.mts` (5 → 3), `tests/connector-desktop/smoke.mjs` (6 → 4 twice) and
     `tests/connector-desktop/package-smoke.mjs` (6 → 4 twice, and drop it from the name list).
   - Update the README Skills paragraph and `skills-tools.test.mts` (G6).
5. **To the lead (note):** `agent-ops-lab/.claude/skills/smartsell-*` are installed copies of the old Skills inside that dev
   project, so they still name the legacy tools. The installer never overwrites them. Delete those three folders and re-run
   `smartsell-install-skills.mjs` to pick up the new ones.

## Seen while testing (other groups' work in progress, not caused by G6)

- `pnpm typecheck` (NODE_OPTIONS=--max-old-space-size=6144) exits 2 with five TS2559 errors, all in files edited for E36 this wave:
  - `apps/server/src/modules/worker/{index.ts:143,invariants.test.ts:158,retire.ts:62}`
  - `apps/server/src/modules/workspace/views/hub-model.ts:143,150`

  They say `Row` has no properties in common with `Partial<Pick<WorkerJobRecord, 'submitting_at'|'started_at'|'go_at'>>`.
  There are no errors in any G6 file. The root tsconfig includes all of them, including the new `.mts` test.
- `apps/server/src/hub/hub.test.ts` 「GET /api/v1/hub/info requires a session…」 failed in my second run: `hub-info.ts` now returns
  `funnel_on`/`funnel_warning` (E46, G5-ops). It passed in my first run, before that edit.

## Tests run

- `node scripts/test.mjs packages/agent-relay`: 27 pass, 1 skipped (`SMARTSELL_TEST_LARGE`).
- `node --import tsx --test tests/connector-desktop/app/upload-handoff.test.ts`: 8/8, three runs in a row.
- `node scripts/test.mjs packages/agent-relay tests/connector-desktop/app apps/web/src/view/pages/setup-codex-routing
  apps/web/src/view/pages/setup-agent-prompt apps/connector-desktop/skills tests/connector-desktop/skills
  apps/server/src/integration/agent-connections apps/server/src/integration/agent-uploads apps/server/src/integration/mcp-hub-tools
  apps/server/src/hub/hub.test` (22 files):
  - Run 1: 145 pass, 2 skipped, 1 fail. The failure was a timing race in my own new e2e test, now fixed.
  - Run 2: 145 pass, 2 skipped, 1 fail. The only failure was the G5-ops `hub/info` test described above.
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck`: exit 2, only the five errors listed above (none in G6 files).
