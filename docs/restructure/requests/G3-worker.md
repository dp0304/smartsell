# G3-worker (wave 6): Worker fixes WA-1 … WA-10 and the Worker side of WA-3 / WE-3

Scope: `apps/connector-desktop/**` (not `src/app/upload-handoff.ts` or `skills/**`), `apps/connector/**`,
`tests/connector-desktop/**`, `tests/fixtures/platforms/**`. Every finding was checked against the current code, reproduced
by a test that failed on the old behaviour (each one was re-run against the old code by temporarily restoring the old
lines; all new tests failed there and pass now), then fixed.

New test files: `tests/connector-desktop/job-runner-wave6.test.ts` (runner), `tests/connector-desktop/drivers-wave6.test.ts`
(drivers on scripted pages, virtual clock), `tests/connector-desktop/cdp-screenshot.test.ts`,
`tests/connector-desktop/app/needs-owner.test.ts`; new cases in `drivers-fixtures.test.ts` (real Chrome on the fixture
pages) and `supervisor.test.ts`.

Versions: selector data `2026.11.2` → `2026.11.3` (new steps and patterns below), drivers `x@2026.11.2`,
`tiktok@2026.11.2` (the flows changed, §8.18).

## Per finding

### WA-1 (high) TikTok read-back claimed an older video — fixed
- `drivers/tiktok.ts`: before the upload (so before any Post click; not in dry runs) `publish` reads the Studio content
  list (`#contentIds`): it waits until two reads of `tt.content_row` agree, or the empty-list text (`tt.content_empty`),
  max 10 s. The video ids go into the publish hint as `known_ids` (`[]` for an empty account; absent when the list could
  not be read). The runner stores the hint on the local job (`LocalJob.hint.known_ids`) and passes it to read-back.
- `readBack` now accepts a row only if: its id is not in `known_ids`; its time, when readable, is not before the click
  minus `READBACK_CLICK_SKEW_MS` (60 s; was `submittedAt − 120 s`); without the pre-click list, or below a row that
  existed before the click, a readable time is required; the caption prefix must match, and an **empty caption never
  matches on text** (only by a new id). Anything else is `not_yet`, never an older video.
- Runner: read-back's lower bound is the click: `submittedAt = submitting_at ?? submitted_at ?? started_at` (it was
  `submitted_at`, taken after a confirmation wait of up to 60 s). X's profile fallback uses the same skew.
- Tests: `drivers-wave6` (a) empty caption + untimed older row → not_yet, (b) repeated caption + untimed row → not_yet,
  (c) same-caption row 90 s before the click → not_yet, new id found without a time, empty caption only by new id,
  unknown row below a known one refused, strict path without a list; the snapshot is read before `setFiles` and handed
  to the hint; dry run reads no list. `drivers-fixtures` (Chrome): rows without `<time>` (new fixture switch
  `setContentRowTimes(false)`) + a seeded older video with the same caption (`seedPost`) + `created_hidden` → not_yet;
  same with `ok` → the new id; empty caption → not_yet. `job-runner-wave6`: the hint gets the click time and the ids.
- Residual: a crash between `submitting` and `submitted` loses the in-memory `known_ids`; read-back then uses the strict
  path (needs a readable time), i.e. it ends at `outcome_unknown` rather than guessing.
- The real Studio row has no machine-readable time as far as the research doc shows; `tt.content_empty`'s texts are
  待校準 (calibrate in the owner's dry run / first post).

### WA-2 (high) the publish lock was held through the owner-click wait — fixed
- `runtime/job-runner.ts`: `onOwnerWait` now pins the lease, records the profile in `#ownerWaiting`, **releases the
  machine's publish lock**, brings the tab to the front and raises the blocker. The lease stays held and pinned, so the
  draft tab is untouched; the later `unlock()` calls are idempotent.
- A later job of the **same** account waits for that draft in `#go` *before* taking the lock (it could not run anyway:
  the profile is leased), so it cannot hold the lock while queued behind the owner's wait. It is woken when the wait ends.
- Tests (`job-runner-wave6`): assist A + auto B on another account → B goes at its not_before and gets its result while A
  waits; two assist accounts both get their own draft and `owner_click` alert; a same-account job C waits outside the
  lock while B still goes on time, and runs after the owner clicks A.

### WA-3 / WE-3 (Worker side) go:false invalid_state / too_late dropped silently — fixed
- `#go`: `invalid_state` (the hub is releasing the job, or no longer runs it here) reports `released` (lease report) and
  ends locally; `too_late` reports `missed` through `#missed` (reason `late`, or `paused` / `machine_was_off` when that
  is what happened) with the local alert; any other unknown deny reason reports `released`. `fence_lost` stays silent
  (the job belongs to another machine; a report would be refused).
- Tests: invalid_state → `['prepared','prepared','released']`, no publish; too_late → `missed{late}`; fence_lost silent;
  an unreachable hub is still the offline path.
- Hub side is G1-engine's (see handoffs). Case (b) of WA-3 (restart after an offline `started`) now reports `released`
  too; whether the hub should instead answer go idempotently there is G1's call.

### WA-4 (medium) evidence over 4 MiB / missing file stalled the outbox — fixed
- `runtime/supervisor.ts#uploadEvidence`: reading the file (ENOENT/EISDIR …) and the 4 MiB limit are checked before the
  request; such a screenshot is marked `rejected` and logged (`evidence not sent`), like a hub 4xx, and the report that
  cites it is still sent; the outbox moves on. Only an unreachable hub stops the drain.
- `runtime/protocol.ts#uploadEvidence`: a local refusal (size → `EVIDENCE_TOO_LARGE`, or the device client's synchronous
  id/fence validation → `EVIDENCE_INVALID`) is a `client` HubError, never classified as `network`.
- `drivers/cdp-page.ts#screenshot`: the scale is divided by `window.devicePixelRatio` (§8.13: at most 1600 image pixels on
  a Retina screen), and a capture above 3.5 MiB is taken again at lower quality and scale (up to 3 retries).
- Not done (not needed): skipping a blocked job's entries in the drain; with local failures no longer blocking, only a
  hub-wide failure stops it, which blocks every job alike.
- Tests: `supervisor.test.ts` (4.5 MiB screenshot: report and other job's facts delivered, small screenshot still
  uploaded, big one rejected + logged; deleted file → rejected, report delivered; HubProtocol classification),
  `cdp-screenshot.test.ts` (scale 0.5 at DPR 2; re-capture above the budget).

### WA-5 (medium) TikTok caption hand-off before the options were set — fixed
- `drivers/tiktok.ts#publish`: privacy, comments, reuse, disclosure and the AI label are set and read back **before** a
  rejected caption is handed to the owner; an option that cannot be set stops as `driver_outdated` (before_submit) and
  nothing is handed over. The copy 「頁面已填好」 is now true except for the caption it names.
- Tests: `drivers-wave6` (at hand-off the page shows Only you and comments on; a privacy menu that never opens →
  driver_outdated `tt.visibility`, no hand-off); `drivers-fixtures` new TikTok scenario `text_rejected`: the owner's post
  is `SELF_ONLY` (before: TikTok's carried-over Everyone).

### WA-6 (medium) terminal facts lost after a cleanup error or crash — fixed
- `#finish(id, state, reason, report?, change?)`: the terminal fact is written as `pending_report` (with its `event_id`)
  in the **same atomic job write** as the final state, then moved to the outbox with that event_id, then cleared; cache
  release and staging removal come last and are best-effort (logged, never thrown). `start()` re-queues any
  `pending_report` left by a crash, skipping it when an outbox entry with that event_id already exists (never twice).
  Every terminal path (result, outcome_unknown, after_submit blocked, failed, missed, released, dry_run_done,
  login_state, preflight prepare_blocked, emergency stop) goes through it. `#releaseLocal` writes `released_jobs` before
  the final state. `JobStore.enqueue` takes an optional `eventId`.
- Tests: `media.release` throws EBUSY once → `result` still queued; a fault before the outbox write → the restarted
  runner queues `result` exactly once (and a third start adds nothing); a pending record whose outbox file exists is not
  re-sent.
- Note §8.4 "LocalJob first, then outbox" still holds (the fact is part of the LocalJob write).

### WA-7 (medium) → E40 X "Who can reply" — fixed (as E40)
- `selectors.json`: steps `x.reply_settings` (role=button in the compose dialog, name `can reply|可以回复|可以回覆`; CSS
  fallback by text) and `x.reply_menu_item` (`[data-testid="Dropdown"] [role="menuitem"]`, fallback role=menuitem);
  patterns `reply_option_{following,verified,mentioned}` (menu item names) and `reply_state_{…}` (the control's label
  after the choice, used for read-back). English, Simplified and Traditional Chinese; the zh names are 待校準.
- `drivers/x.ts#replySettings`: skipped for `everyone`; otherwise opens the control (focusing the textbox first when the
  control is not shown yet, e.g. no caption), picks the option, reads the control's label back; any failure →
  `driver_outdated` (before_submit, step `x.reply_settings`, copy 「設定誰可以回覆」). Runs before the caption hand-off
  and before the click, and in dry runs (so the owner's dry run calibrates it).
- Fixture: the X composer has the "Everyone can reply" control and menu (en + zh_hant), `CreateTweet` records
  `reply_settings` on the post; new scenario `reply_control_missing`.
- Tests: `drivers-wave6` (set + read back before the single click; `everyone` untouched; missing control and a choice
  that does not read back → driver_outdated, no click; applied before a caption hand-off); `drivers-fixtures` (post
  carries `following` / `mentioned` in English and zh-Hant; `reply_control_missing` → driver_outdated, nothing posted).

### WA-8 (low) owner-click wait not shown as needing the owner — fixed
- `app/worker-mode.ts`: `needs_owner` comes from `needsOwner(job)`: blocked, or a draft waiting for the owner's click
  (`owner_click_required`, `caption_rejected`), never the emergency stop's `owner_stopped`. The row gets 「開啟該 Chrome
  處理」, the channel row `blocked`, the tray count (shell.ts reads the same snapshot).
- Runner: the owner-click tab is brought to the front when the wait begins; `local_alert` carries `job_id` (additive,
  optional field on the C11 event); the shell gives blocker/owner_click notifications an `action` that opens that job's
  Chrome (`Notifier` runs `action` on click when there is no web_url).
- Tests: `app/needs-owner.test.ts`, `job-runner-wave6` (bringToFront, alert job_id, view state).

### WA-9 (low) pre-click platform_error said "maybe posted" — fixed
- `drivers/messages.ts`: a phase-aware template for `platform_error` before the click (prepare / before_submit), used by
  the Worker's local notification and App row (the hub replaces the message with its own copy, see handoff 2):
  「{channel} 出現錯誤頁面，已停止，這則還沒有發出。請到 {machine} 查看；確定沒問題後可按「恢復」再試一次（截止 {deadline}）。」
  After the click, and without a phase, the current conservative text stays.
- Tests: `drivers-wave6` (both pre-click phases, after_submit, no phase; X `prepare` on a "Something went wrong" page).
- **Lead, Appendix C.2:** split the `platform_error` row into two: `platform_error`（prepare／before_submit）= the text
  above; `platform_error`（after_submit）= the existing 「{channel} 回報錯誤，可能已經發出，也可能沒有。請到貼文頁貼上網址，或確認沒有發出；系統不會自動重發。」.

### WA-10 (verifier: high) a refused owner click became missed{owner_not_clicked} — fixed
- Root cause found while writing the Chrome test: both drivers `return this.#ownerWait(…)` inside `try { … } finally
  { watcher.stop() }` without `await`, so the CreateTweet / project/post watchers stopped the moment every owner wait
  began; in real Chrome no response was ever seen during an owner wait (only toasts / the success page). Now awaited;
  `FakeCdpPage.watchResponses().stop()` now behaves like CDP so unit tests catch this.
- X `#confirmation`: a `rest_id` in any response, then a new toast, are checked before a refusal (an earlier refusal no
  longer hides a later success); a refusal is returned without a screenshot.
- Owner wait (both drivers): a CreateTweet / project/post answer means the owner clicked. A later success still wins;
  otherwise the wait ends (deadline, or a revocation after that click) with `blocked{platform_error|risk_prompt,
  after_submit}` (one screenshot) — no discard, the window stays as it is — which the runner reports as an after_submit
  fact (hub: `outcome_unknown`), never `missed{owner_not_clicked}`. Auto mode: a refusal still stops at once.
- Fixture: X scenario `post_error_once` (first CreateTweet refused, a second click succeeds).
- Also (robustness, same area): after an auto click whose toast carries no status link, the driver waits up to 3 s more
  for CreateTweet's `rest_id`, so read-back opens the post by id. Under load the toast could be read before the
  response body; `cdp-click-offscreen.test.ts` ("the CreateTweet result was read") failed once that way in a full run.
- Tests: `drivers-wave6` (X refusal then success → submitted by owner with the id; refusal only → risk_prompt
  after_submit, no Escape, one screenshot; auto: later success after a refusal; TikTok code 7 → after_submit, no discard;
  TikTok refusal then success → owner), `drivers-fixtures` (X and TikTok `post_error_not_created` in assist → after_submit,
  draft kept; X `post_error_once` two owner clicks → owner's post), `job-runner-wave6` (after_submit fact, not missed).

## Deviations from E34–E46
- E40: implemented as written. Additionally applied before the caption hand-off (same rule as WA-5) and in dry runs.
- None otherwise (E34–E39, E41–E46 have no Worker part in this group).

## Existing tests changed (none weakened)
- `fakes/fake-cdp-page.ts`: a stopped response watcher no longer sees later responses (stricter, matches CDP).
- `fakes/runner-harness.ts`: the go script function also gets the request body; `ScriptedDriver` records read-back
  hints; runner logs are captured.
- `drivers.test.ts`: the scripted TikTok page has an empty content list (publish now reads it first; without it the
  snapshot waits its 10 s timeout).
- `supervisor.test.ts`: `setup()` accepts a `log` sink.
- `app/release.test.ts`: the scripted `exec` answers `git rev-parse HEAD` with a commit id. Another group's E45 change to
  `apps/server/src/hub/update.ts` now records the current commit first (for the rollback) and stopped at once on the
  empty answer, so "hub:update builds the relay after install and never restarts when that build fails" failed before
  reaching install; with a realistic answer every assertion of that test holds unchanged. (Not my product code; E45's
  owner may want to check this.)

## Handoffs (files I do not own)
1. **G1-engine — `apps/server/src/modules/worker/device-jobs.ts#goJob`:** answer `deny('revoked', true)` for a job with
   `revoke` set or status `releasing` *before* the `['claimed','ready','needs_owner']` status check (WE-3). The Worker now
   also reports `released` for `invalid_state`, so either order ends the cancel, but `revoked` keeps the hub's own record
   right. For WA-3 (b): make go idempotent for `status === 'running' && go_source === 'offline'` when the same device and
   fence ask (return `go:true` with the run mode). If not, note that the Worker's `released` for that case reaches
   `applyReport('released')` with no revoke and ends as `cancelled`; `missed` may be the better hub status there.
2. **Owners of `apps/server/src/modules/worker/model.ts` and `apps/server/src/modules/alerts/{copy.ts,triggers.ts}`
   (hub copy):** the hub does not keep the Worker's message — `model.ts#fullBlocker` and `triggers.ts` replace it with
   `BLOCKER_COPY[code]` whatever the phase. For WA-9 to reach the web, the owner alert and the phone push, both must
   pick the `platform_error` text by `phase`: prepare/before_submit → 「{channel} 出現錯誤頁面，已停止，這則還沒有發出。請到
   {machine} 查看；確定沒問題後可按「恢復」再試一次（截止 {deadline}）。」, after_submit → the existing text; likewise
   `BLOCKER_SHORT.platform_error` (pre-click: 「平台出現錯誤頁面，還沒有發出」). The Worker's own `message` (local
   notification, Worker App row) already follows this.
3. **Lead — `docs/restructure/phase1-design.md`:**
   - §8.8 table: add `x.reply_settings` (role=button「Everyone can reply」/「所有人都可以回覆」in the dialog, 待校準) and
     `x.reply_menu_item` (`[data-testid="Dropdown"] [role="menuitem"]`), necessity "only when `reply_settings !==
     'everyone'`"; flow: a step between 5 and 6 "set Who can reply, read the label back; failure → driver_outdated
     (before_submit)" (E40). Read-back: profile fallback bound is click − 60 s … click + 10 min.
   - §8.9: flow step 0 "read the content list's video ids (`tt.content_row` / `tt.content_empty`)"; step order "options
     (step 5) before the caption hand-off"; read-back paragraph as in WA-1 above (new id, time not before click − 60 s,
     empty caption only by a new id, no readable time and no list → not_yet).
   - §8.6: `submitted.hint` may carry `known_ids`; `readBack` hint `submittedAt` is the click time (`submitting_at`).
   - §8.5: the publish lock is released when an owner-click wait begins; a later job of the same account waits for that
     draft without the lock. Owner-wait outcome after a refused owner click: `blocked{…, after_submit}`.
   - §8.4: terminal facts are written with the final state (`pending_report`) and recovered on restart.
   - §8.13: "at most 1600 image pixels (device pixels)"; a capture over 3.5 MiB is retaken smaller; evidence the hub
     cannot take (over 4 MiB, file gone) is skipped, the report still goes.
   - Appendix C.2: the `platform_error` split (WA-9).

## Tests run
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs tests/connector-desktop apps/connector tests/fixtures`:
  node:test 287 / 287 pass (was 228 before this wave; includes the Chrome fixture drivers), vitest 31 / 31 pass.
- `node --import tsx --test tests/e2e-phase1/loop.test.ts` (one E2E file: E2E-1, E2E-12, E2E-9): 3 / 3 pass.
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck`: passes.
- Every new test was also run against the old behaviour (old lines restored temporarily): each one failed there.
