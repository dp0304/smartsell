# G1-engine (wave 6): job-engine findings, E36–E38, E41 — notes and requests to other groups

G1-engine owns `apps/server/src/modules/worker/**` (not `presence.ts`), `packages/contracts/src/phase1.ts`,
`apps/server/src/modules/workspace/views/hub-model.ts`, `apps/server/src/modules/posting/model.ts`, the `HUMAN_ONLY` list in
`apps/server/src/operations.ts`, `tests/phase1/**` and the tests next to these files. Everything under "Handoffs" is a change
in a file G1-engine does not own.

New tests: `apps/server/src/modules/worker/wave6.test.ts` (one test per finding), `tests/phase1/x-weighted-length.test.ts`,
two new tests in `tests/phase1/frozen-contract.test.ts`. Each scenario is the reviewer's repro (`verify/worker-engine/we.test.ts`,
`verify/web-views/forcerelease.mts`, `r9-xlen.ts`), which on the code before this wave printed the wrong states the new
assertions reject (quoted per finding below).

## Per finding

### WE-1 — a late fact downgraded an owner-confirmed post (fixed)
- `device-jobs.ts reportJob`: the late-fact branch runs only for the released statuses of §5.4.3 (cancelled, superseded,
  missed, failed, releasing). A fact on a `succeeded` job — read back or owner-confirmed — is recorded with
  `{applied:false, terminal:'succeeded'}` and `fence_override`, no status change, no alert. A `result` that names another
  post id than the recorded one adds `different_post:true, recorded_external_post_id` to the event (no alert: copy would be
  needed, see handoffs).
- `sync.ts syncTaskFromJob`: a `published` task never moves back (no re-point of `worker_job_id`, no transition), whatever a
  later fact of this or an older job says; an attempt still open on that job is ended (`unknown`/`abandoned`).
- Tests: `WE-1: an owner-confirmed post stays published …` (before: `outcome_unknown task outcome_unknown attempts [unknown]`
  plus urgent `unknown` and `late_fact_after_release`), `WE-1: a result the Worker reads back after the owner confirmed …`,
  `WE-1: a late fact from an older released job never moves a published task back …`.
- Not done: the optional "tell the Worker the job ended" field in the heartbeat. It is a contract addition without an
  E-number; the Worker still stops reading back on its own schedule (its lease reports get `JOB_FENCE_LOST`, facts are
  recorded only). Lead decision needed if wanted (e.g. `HeartbeatV2Response.ended_jobs?: {job_id, status}[]`).

### WE-2 — never-claimed parked job went releasing → unreported (fixed)
- `revoke.ts`: `neverClaimed(job)` (no `claimed_at`, `go_at`, `started_at`, `submitting_at`). `requestRevoke` ends such a job
  at once like a queued one (cancelled/superseded); `cancelWorkerTask` cancels the task at once for it.
- `lifecycle.ts`: safety net for rows written before the fix — a `releasing` job that was never claimed is settled at once
  (event `cancelled_unclaimed`); `provablyNotRun` is true when the job was never claimed.
- Test: `WE-2: a parked media job no machine ever claimed is cancelled at once …` (cancel and retry; before: `job unreported …
  task cancel_pending`, urgent 「未回報」), `WE-2 safety net …`.

### WE-3 — go on a releasing job (hub side fixed; Worker side is G3's)
- `device-jobs.ts goJob`: before the state check, a job with `revoke` (releasing, claimed/ready/needs_owner, or running
  without `submitting_at`) answers `{go:false, reason:'revoked', release:true}`; the Worker's `released` completes the cancel.
- `too_late`: the hub ends the job itself as `missed` (event `missed {reason:'late', via:'go'}`) because the Worker never runs
  a job after that answer; the hub no longer waits for a report that never comes.
- Tests: `WE-3: go on a job cancelled moments before not_before …` (before: `{go:false, reason:'invalid_state', release:false}`
  then `job unreported task cancel_pending`), `WE-3: a go answered too_late ends the job as missed …`.

### WE-4 — a started job re-prepared to ready/claimed was never timed out (fixed)
- `lifecycle.ts` rule 4 now covers every pre-submit state with `started_at` (claimed, ready, needs_owner, releasing) as well
  as `running`: past `not_after + grace` without `submitting` → `unreported`. The owner can then confirm or mark not published
  (force release is refused by E36 because it started).
- Test: `WE-4: a started job the Worker re-prepared after a resume …` (before: `3 days later: ready task running`, every exit
  `JOB_INVALID_STATE`).

### WE-5 — a failed login check stayed live for ~50 min (fixed)
- `device-jobs.ts`: `login_state` other than `verified` ends the check as `failed` with `result.login_state` and the blocker
  (channel page, `channel_check`, `login_check_failed` alert keep working — `checkView` shows `job_status:'failed'` and the
  blocker). A `prepare_blocked` on a check ends it too, except `chrome_unavailable`/`profile_in_use`, which the Worker keeps and
  retries on the machine. A `needs_owner` check is no longer re-issued by claim recovery (heartbeat `claimable`, `jobs.claim`).
- `dispatch.ts createCheckLoginJob`: a check being withdrawn is not reused; 「重新登入」 while a held check waits for Chrome
  supersedes it and creates a sign-in-window check.
- `revoke.ts`: `blocksMachineMove(job)` — only a real post a machine holds (or may have run) blocks 換機器; login checks and
  dry runs of the old machine are withdrawn (`superseded`), never-claimed posts move. `moveQueuedChannelJobs` uses it and also
  moves a hub-parked (never-claimed) media job. `lifecycle.ts`: a withdrawn check whose machine never lets go ends after its
  window (`lease_expired`).
- Tests: the two `WE-5` tests in `wave6.test.ts` (before: `re-issued 8 times in 2 minutes; fence now 9`, 「重新登入」 returned the
  same job with `open_login_window:false`). Existing test changed: `device-jobs.test.ts` "report transitions for every event"
  asserted `login_state{challenge}` → `needs_owner` and that 「重新登入」 reuses that check — the buggy behaviour; it now asserts
  `failed` with blocker and `result.login_state`, that an *open* check is still reused, and that an ended one is not.

### WE-7 / F7 (E38) — window and daily cap judged at the early go instant (fixed)
- `device-jobs.ts limitReason`: window and daily cap at `max(now, not_before)`.
- Test: `WE-7/F7 (E38) …` (window 11:00–21:00 with go at 10:59:59.950 — before: `outside_window … job missed`; and a 00:00 post
  whose go arrives at 23:59:59.5 is counted on its own day).

### WE-8 — a "now" post with a video still uploading was parked and alerted at once (fixed; design deviation)
- `lifecycle.ts` rule 7: while the media's newest upload session is still `receiving`/`assembling`/`processing`, the job stays
  queued and is parked as `needs_owner(media_unavailable)` (which raises the urgent alert) only at
  `max(not_before, not_after − 10 min)` (`UPLOAD_PARK_BEFORE_DEADLINE_MS`). Without a live upload (failed, none) the design's
  rule (park at `not_before − prepare_lead_min`) is unchanged.
- Deviation from §5.2/§5.13 item 7 (which park at `not_before − prepare_lead` regardless): the review judged that wrong for
  the main "Codex posts this video now" flow; no E-number covers it. The post shows 「已排程」 while it waits; the post page's
  media row shows the upload progress. Lead: please confirm or add an E-number.
- Test: `WE-8: a post due now whose video is still uploading waits …` (before: `5 s later: needs_owner media_unavailable` and
  `worker_blocker|urgent`).

### WE-9 — stale offline run hidden by an undelivered heartbeat answer (fixed)
- `device-jobs.ts staleOfflineRun`: besides the old checks, an offline `started` is stale when the hub's last view (computed
  before the run) said `hold:true`, or when the mode the Worker reports differs from that view — both prove the Worker ran on
  an older view (the answer carrying the change was lost). Views computed after the run are not used.
- Test: `WE-9 …` (before: `stale event? false run_mode auto alerts 0`). The existing "run on current settings is not flagged"
  test still passes.

### WE-10 — idempotent go resend after a revoke (fixed)
- `goJob`: the revoke check comes first (above); the idempotent resend for `running`/`go_source:'hub'` also answers any hold
  the hub knows now (paused → `release:false`; approval lost, rebound → `release:true`); otherwise the same `go:true`.
- Test: `WE-10 …` (before: resend after cancel `{go:true, mode:auto}`).

### WV-1 (E36) — force release of a possibly-sent job (engine part fixed; web part is G4's)
- `phase1.ts`: `hubSawStart(job)` (E36): `go_at`, `started_at` or `submitting_at` recorded.
- `worker/index.ts forceRelease`: such a job → 409 `POSSIBLY_SENT`, message 「這則可能已經發出，請先到平台確認：有就貼上網址，沒有就按「確認沒有發出」」
  (`POSSIBLY_SENT_TEXT`), details `{job_id, post_id, use:['hub_posts_confirm_result','hub_posts_mark_not_published']}`. Releases
  without a start on record are unchanged, so `side_effect_possible:false` on their attempt stays honest.
- `hub-model.ts`: `canForceRelease(job)` (releasing/unreported and `!hubSawStart`) for `postActions`;
  `forceReleasedUnstarted(job)`; `missedReason` says `machine_was_off` only for a release without a start on record.
- Legacy rows (force-released before E36 although started) still derive `missed` (E17 input passed as is, otherwise the post
  would show a 「已排程」 that never comes) but with `missed_reason: 'released_unconfirmed'`, which needs owner copy (handoff).
  This is my reading of E36 for data written before it; new rows cannot reach that state.
- `invariants.test.ts` (existing): its random `force` action now picks only a job the hub never saw start, as the web will.
- Tests: the two `WV-1 (E36)` tests (before: `after force release: missed missed_reason machine_was_off actions [reschedule]`).

### F1 (E37) — derivation part (fixed; reject terminality is G2's, label is G4's)
- `phase1.ts`: `PostStatus` gains `'rejected'`; `derivePostStatus` gains `approval_rejected?: boolean` and returns `rejected`
  after the live-job and cancelled checks and before missed/failed/scheduled/draft, unless `plan_status` is ready, paused or
  awaiting_approval (a newer request). `plan_status === 'rejected'` also derives it, in case G2 introduces that plan status.
- Both wrappers compute it the same way: `hub-model.ts approvalRejected(ctx, target)` (the linked request is `rejected` and no
  newer request exists for the target) — `postStatus` in `hub-model.ts` and `posting/model.ts` (which imports it).
- Tests: `F1 (E37) …` in `wave6.test.ts` (web and Agent wrappers), `E37: …` in `tests/phase1/frozen-contract.test.ts`.

### F11 — X weighted length (fixed)
- `phase1.ts xWeightedLength` now follows twitter-text v3, checked with Exa against twitter-text's `config/v3.json`
  (`scale 100, defaultWeight 200, emojiParsingEnabled true, transformedURLLength 23`, light ranges 0–4351, 8192–8205,
  8208–8223, 8242–8247), `config/README.md` (emoji incl. ZWJ sequences count as one default-weight unit),
  `js/src/parseTweet.js` (NFC; URL entities first, then emoji, then per code point) and `extractUrlsWithIndices.js` /
  `regexp/{extractUrl,validDomain,validAsciiDomain,validUrlPath,validUrlPathEndingChars,validUrlPrecedingChars,validGTLD,validCCTLD}.js`
  (protocol-less ASCII domains with a valid TLD; not after `-_./`; not after `@`/alphanumerics; trailing punctuation not part
  of the path; balanced parentheses kept). The gTLD/ccTLD lists are twitter-text's ASCII entries.
- Emoji: grapheme clusters (`Intl.Segmenter`) matching `\p{RGI_Emoji}` (`v` flag) count 2; a fallback for runtimes without
  `v`. Known approximations: IDN TLDs and non-Latin domain labels are not extracted; a bare `©`/`®` without VS16 counts 1.
- Test: `tests/phase1/x-weighted-length.test.ts` (before: `makemylure.com -> 14`, family emoji `11`, thumbs-up skin tone `4`).

### COH-3 (E41) — `hub_machines_retire` (engine part fixed; button, App and docs copy are others')
- `worker/retire.ts`, registered in `worker/index.ts` as `POST /api/v1/workspaces/:ws/hub/machines/:id/retire`, name
  `hub_machines_retire`, roles ADMIN, person only (`requireHuman` + `HUMAN_ONLY`). Body `{confirm: true}` (strict; anything else
  422 `INVALID_ARGUMENTS`). One transaction:
  - device `status:'revoked'`, `revoked_at`, `revoked_by` (its signed requests then get 401 `DEVICE_INACTIVE`; it leaves
    machines views and `machine_setup` alerts, which already filter `status === 'active'`);
  - its live jobs: `outcome_unknown`/`unreported` stay (owner settles); `submitting`/`result_pending` → `outcome_unknown`;
    a post the hub saw start → `unreported` (never re-posted, never force-releasable); a post being revoked ends as its revoke
    says; a post it held but never started → back to `queued` with a new fence and `claimed_at:null` (so 換機器 moves it and a
    cancel ends it at once); queued and hub-parked posts stay; login checks and dry runs → `cancelled`. Each touched job gets
    event `machine_retired {previous_status, outcome, machine_name}`;
  - its accounts: `account_execution_binding.machine_retired_at`, browser sessions revoked, `account.binding.changed`
    `{…, machine_retired:true}` per binding (the views already show `machine_binding_missing` for a revoked machine);
  - legacy `connector_task` drained, `sync_generation` bumped (`machine_retired`), audit `account.device.retired`, event
    `account.device.retired`.
  - Answer: `{machine_id, name, status:'revoked', already_retired, jobs:{waiting_for_machine, ended, to_confirm}, channels:[{social_account_id,label}], posts_to_confirm:[post ids]}`.
    A second call answers `already_retired:true` and changes nothing.
  - A queued post whose account is never moved is missed at `not_after` with `missed_unclaimed {reason:'machine_retired'}`
    (`lifecycle.ts`), and `hub-model.ts missedReason` answers `machine_retired` (not 「機器當時沒開」, which would be untrue).
- `tests/phase1/human-only.test.ts`: `hub_machines_retire` added to the design list (E41).
- Tests: the two `COH-3 (E41)` tests in `wave6.test.ts`.

## Deviations from E34–E46

- WE-8 parking rule (above) is outside the E-list: lead to confirm.
- E36 for legacy rows: `missed` + `released_unconfirmed` (above).
- E41: the binding keeps `device_id` (pointing at the revoked device, marked `machine_retired_at`) so queued posts can follow
  the account with 換機器; `confirm:true` is required in the body (irreversible: the machine must pair again).

## Handoffs

### G4 (web views and web)
1. `apps/server/src/modules/workspace/views/posts.ts postActions`: offer `force_release` only when
   `canForceRelease(job)` (from `hub-model.ts`) and the machine is offline — replace both
   `job?.status === 'unreported' && machineOff` and `job?.status === 'releasing' && machineOff` with
   `canForceRelease(job) && machineOff` (E36). Add a `case 'rejected':` (E37) with the actions G2 decides (at least
   `reschedule` and `cancel`; editing/resubmitting via `post_update`), and add `'rejected'` to `POST_STATUSES` (line ~273) so the
   `status` filter accepts it.
2. `today.ts` / `channels.ts` counts: decide whether `rejected` counts anywhere (today it falls in none of the buckets).
3. `apps/web/src/view/hub-copy.ts`: post status label for `rejected` (approvalText already has 「已駁回」); `missedReasonText`
   entries `released_unconfirmed: ['已強制釋放；它可能已經發出，請先到平台確認再改期', 'Force-released; it may have gone out — check the platform before rescheduling']`
   and `machine_retired: ['機器已撤銷，帳號還沒換到別台機器', 'The machine was retired and the account was not moved']`; `timeline.ts`
   `MISSED` gets the same two reasons;
   `forceHint` wording per E36; error copy for `POSSIBLY_SENT` (the server message already carries the owner sentence).
4. `timeline.ts text()`: `case 'machine_retired': return detail.outcome === 'requeued' ? \`你撤銷了 ${machine}，這則等待新的機器\` : detail.outcome === 'unreported' || detail.outcome === 'outcome_unknown' ? \`你撤銷了 ${machine}；它可能已經發出，請到平台確認\` : \`你撤銷了 ${machine}，這個工作已結束\`;`
   (otherwise the raw event name shows).
5. `activity.ts`: label for `hub_machines_retire` (e.g. `['other', '撤銷了機器', 'Retired a machine']`).
6. Machine page (`MachinesPage.tsx`): 「撤銷這台機器」 → `POST /hub/machines/:id/retire {confirm:true}` with a confirm dialog;
   show `posts_to_confirm` (links) and `channels` ("these accounts need another machine: 換機器").
7. `apps/server/src/modules/account/channel-registration.ts bindSocial` (if G4 owns it, else the account owner): a binding whose
   device is `revoked` (or has `machine_retired_at`) must not answer `WORKER_CHANNEL_ALREADY_BOUND` when a new Worker adds the
   account — treat it like 換機器 (update the binding, require no blocking jobs via `blocksMachineMove`, move queued jobs with
   `moveQueuedChannelJobs`, clear `machine_retired_at`).

### G2 (posting / channel settings)
1. `apps/server/src/modules/posting/schemas.ts`: add `'rejected'` to `POST_STATUSES` (E37) so `posts_list {status}` accepts it.
2. `apps/server/src/modules/account/channel-ops.ts bindMachine` (line ~229): the local active-jobs check should be the same
   rule as `blocksMachineMove(job)` in `worker/revoke.ts` (also exported from `worker/index.ts`) — either import it or inline it:
   `ACTIVE_JOB_STATUSES.includes(status) && job.kind === 'publish_post' && job.dry_run !== true && !(neverClaimed(job) && ['queued','needs_owner'].includes(status))`
   with `neverClaimed = !claimed_at && !go_at && !started_at && !submitting_at`. Then a login check or dry run never blocks
   換機器 with 「這 1 則貼文」 and `post_ids: []` (WE-5); `moveQueuedChannelJobs` (called right after) already withdraws those on
   the old machine and moves never-claimed posts. Also clear `machine_retired_at` on the binding when it is re-bound (E41).

### G3 (Worker)
- WE-3 Worker side: `job-runner.ts #go` — for `invalid_state` and the default branch (`too_late`) report something the hub can
  use instead of finishing silently: `too_late` → `missed{reason:'late'}` (the hub now ends the job itself, so a later report is
  answered `JOB_FENCE_LOST` and dropped — harmless); `revoked` with `release:true` already reports `released`.
- COH-3: `worker-mode.ts` forget() message and `ui/renderer.js` role chooser: point to the machine page's 「撤銷這台機器」.

### G5 (alerts)
- `apps/server/src/modules/alerts/triggers.ts` `missed` alert: its own `missedReason`/`MISSED_REASON` should know
  `machine_retired` (event `missed_unclaimed {reason:'machine_retired'}`) — 「機器已撤銷，帳號還沒換到別台機器」 — instead of falling back
  to 「超過遲到上限」 or 「機器當時沒開」.

### G6 (docs)
- `docs/hub-setup.md:97` (re-pair all Workers): after re-pairing, retire the old machine rows with 「撤銷這台機器」 (E41).

### Lead (design doc)
- Appendix A: `PostStatus` `rejected` and `derivePostStatus.approval_rejected` (E37, rule as implemented above);
  `hubSawStart` (E36).
- Appendix C.3: `POSSIBLY_SENT` 409 — "The post may already be live. Ask the owner to check the platform: confirm its URL or mark
  it not published." / 「這則可能已經發出，請先到平台確認：有就貼上網址，沒有就按「確認沒有發出」」.
- §4.6 table and Appendix B.3: `hub_machines_retire` `POST /hub/machines/:id/retire {confirm:true}` (E41).
- §5.4.4: item 1 is now preceded by the revoke check (WE-3/WE-10) and `too_late` ends the job as missed; §5.4.3 `login_state`
  non-verified → `failed` (WE-5); §5.13 item 4 covers started claimed/ready/needs_owner/releasing (WE-4); item 7 upload rule
  (WE-8, to confirm).

## Tests run

- `node scripts/test.mjs apps/server/src/modules/worker/ tests/phase1/ apps/server/src/modules/posting apps/server/src/modules/workspace/views apps/server/src/modules/alerts apps/server/src/modules/account apps/server/src/modules/execution apps/server/src/modules/planning apps/server/src/modules/content packages/domain packages/contracts apps/server/src/integration/mcp-hub`
  — node:test 354 pass, 2 skipped, 0 fail; vitest 71 pass (includes the Worker runtime loop test with fixture platforms).
- Mutation check: reverting each fix (WE-1 lateFact condition, WE-2 neverClaimed, WE-3 revoke-first, WE-4 rule 4, E36 refusal,
  WE-5 terminal login_state, E38 `max(now, not_before)`, WE-8 upload rule, WE-9 delivered-view rule, E37 `approvalRejected`) makes
  the matching `wave6.test.ts` test fail; restored afterwards.
- One E2E file, `tests/e2e-phase1/cancel.test.ts` (E2E-8 cancel near go, E2E-8b assist cancel, E2E-10 owner click): 4/4 pass.
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck`: clean for every file G1-engine touched; the only errors left are in
  `apps/server/src/hub/tailscale.ts` and `apps/server/src/hub/update.ts` (another group's work in progress).
