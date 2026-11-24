# Closure: S8 (Phase 1 end-to-end suite, contract tests, fix loop)

S8 wrote the §10.2 E2E suite (`tests/e2e-phase1/**`, run by `pnpm test:e2e-phase1`) and the §10.2 contract tests
(`tests/phase1/**`), then fixed the product wherever a case failed because the product was wrong. Requests to other
streams: `S8.md`. Results of the final runs are at the end.

## Cases and where they live

| File | Cases (one stack per file; files run in parallel processes) |
|---|---|
| `loop.test.ts` | E2E-1 main loop (MCP overview → `media_upload` of the 30 MB ffmpeg clip → one `post_schedule` for both channels; both post by T + 60 s; all five views agree and link), E2E-12 dry run, E2E-9 machine change (a) before the claim, (b) after the claim → 409 |
| `hub-down.test.ts` | E2E-2 (hub killed T − 20 s, restarted T + 40 s; X posted offline at T ± 15 s; `succeeded`, `go_source=offline` within 60 s; hub records: seq 1..n per fence, each event once, in order) with E2E-2c (TikTok paused at T − 60 s: held through the outage, `missed{paused}` at not_after, releasing the pause posts nothing) |
| `hub-down-assist.test.ts` | E2E-5 (login expired at the post-claim preflight, `login_required`, login card, alert + phone push naming Win-C and @fixture_tt), E2E-2b (risk ack withdrawn, hub down: Mac-B stops before Post, never clicks; `needs_owner/owner_click_required`, then `missed{owner_not_clicked}`) |
| `offline.test.ts` | E2E-3 → E2E-3c → E2E-3b on Win-C; E2E-4 captcha on Mac-B concurrently (no page load while waiting) |
| `hub-proves-off.test.ts` | E2E-3d (hub proves the machine never ran: `missed_machine_off`, never `unreported`, reschedule without force_release) with E2E-13 (partition, reschedule within tolerance → `releasing`, force_release, offline post, late fact: old job `succeeded` with fence override, successor cancelled, one post) |
| `unknown.test.ts` | E2E-7 (error after Post, nothing created: `outcome_unknown`; marked not published → reschedule posts once), E2E-6 (`created_hidden`: `result_pending` → `outcome_unknown`; hub and Mac-B restarts add no job and no post; `POST_RESULT_UNKNOWN`, retry 409 until marked not published) |
| `cancel.test.ts` | E2E-8 (cancel at T − 40 s → `cancelling`, dropped on the next heartbeat) with E2E-8b → E2E-10 (assist: cancel while waiting for the owner; two `click_post_soon` at T − prepare and T, owner clicks, `submitted_by=owner`) |
| `large.test.ts` | E2E-11, gated by `SMARTSELL_TEST_LARGE=1` |
| `tests/phase1/frozen-contract.test.ts` | Appendix A constants consistent with each other and §5; hub and Worker share one contract module |
| `tests/phase1/human-only.test.ts` | §4.6: the 15 `hub_*` HUMAN_ONLY names exactly, registered unprefixed; refused for an Agent grant by `runScopedOperation` and over MCP (`smartsell_operation_call`, real hub-mode server, real agent token); not refused for the owner |

"Notified" is asserted the §10.2 way everywhere: the alert arrives on `/api/v1/agent/alerts/stream` (agent token) with the
machine name and `@handle` in its text, plus the fake ntfy push where §10.2 asks for it (E2E-3) and in E2E-5.

## Product fixes (fix loop)

| # | Found by | Root cause | Fix | Test |
|---|---|---|---|---|
| 1 | E2E-1 (X never posted the real 1080×1920 clip; hub ended `outcome_unknown`) | `CdpPage.#clickPoint` (`apps/connector-desktop/src/drivers/cdp-page.ts`) swallowed a failed `DOM.getNodeForLocation`, which is what CDP answers for a point outside the viewport. The X driver's `clickable()` check therefore passed for a Post button below a non-scrolling dialog, `onBeforeClick` wrote `submitting`, the mouse events hit nothing, and the hub had to treat a click that never happened as possibly sent. Second half: the fixture X composer (`tests/fixtures/platforms/x-pages.ts`) was a fixed dialog with no max-height or scrolling, so a real portrait video pushed Post off-screen (X's composer scrolls and caps previews). | `#clickPoint` throws `NodeNotClickable('offscreen')` when no node can be hit at the point, so the driver stops **before** `onBeforeClick` with `driver_outdated` at `x.post_button` (before_submit, owner-resume). The fixture composer now has `max-height` + `overflow-y:auto` and a capped preview; new X scenario `post_offscreen` keeps the unreachable layout for the regression test. | `tests/connector-desktop/cdp-click-offscreen.test.ts` (post_offscreen → blocked `driver_outdated`, 0 `onBeforeClick`, no click event, no post; real 1080×1920 clip → one click, one post, hash intact). Existing driver, fixture and headless-stack tests pass (57). |
| 2 | E2E-2, E2E-2c (both headless Workers died when the hub was killed) | Node 24.16's bundled undici 7.25 calls `socket.setTypeOfService(0)` unguarded before every HTTP/1.1 write; on macOS `setsockopt(IP_TOS)` returns `EINVAL` when the peer reset the connection between connect and that write, and `net.Socket#setTypeOfService` throws it inside undici's socket callback — an uncaught exception that kills the process instead of failing the request (nodejs/undici#5544; fixed upstream in undici 7.30.2 / 8.x, not in any Node 24 used here). A hub restart (or a dropped tailnet path) produces exactly this. | `apps/connector/src/socket-guard.ts`: `guardSocketTypeOfService()` wraps `net.Socket.prototype.setTypeOfService` and ignores only errors whose `syscall` is `setTypeOfService` (QoS marking is best-effort, as in the fixed undici); argument errors still throw. `device-client.ts` installs it when it loads, so the App and the headless runner both have it. The request then fails as a normal network error, which the supervisor's back-off and the offline-go rule already handle. | `apps/connector/test/socket-guard.test.ts` (installed by device-client, idempotent; a native EINVAL on a real socket no longer throws; NaN still throws; unrelated errors not swallowed). E2E-2 and E2E-2c pass. |
| 3 | E2E-13 (after the late facts the successor job was **claimed** by Mac-B) | `hub_jobs_force_release` cancels the old job; as the old job had not started, `releaseSuccessors` releases the successor (`waits_released_at`). When the late facts arrive, `lateFact` calls `releaseSuccessors` again, but that only considers successors that are still waiting — the released one stayed queued and claimable. Had the old job ended `outcome_unknown` (no read-back), the target would still be `ready` and the successor could post a second time, against §5.4.3 ("取消還沒開跑的後繼 job") and §5.11 rule 5. The existing lifecycle test's comment said the successor is cancelled but did not assert it. | `worker/successors.ts` `cancelSuccessorsAfterLateFact(ctx, predecessor)`, called from `device-jobs.ts` `lateFact` after the predecessor is updated: every successor of that predecessor that has not started gets `successor_cancelled_predecessor_posted`; a queued one is cancelled at once, one a machine already holds is revoked (`superseded`; go is denied meanwhile, the heartbeat lists it in `revoked_jobs`). Started successors are left to their facts. | `apps/server/src/modules/worker/lifecycle.test.ts`: the force_release case now asserts the successor is `cancelled`, has the event and is not claimable; new case: the machine claims the released successor before its late facts arrive → `releasing` (reason `superseded`), go denied, in `revoked_jobs`, `released` → `superseded`. Worker module tests pass (45 + the new case). |

No other product file was changed. Test-harness notes that are not product bugs: Playwright empties `test-results/` when it
starts (W-specs runs it concurrently), so the clip cache and E2E logs live under `$TMPDIR`; the hub's push is sent by its
drain shortly after the alert commits, so push assertions wait for it; the post-claim preflight is skipped when the same
channel passed a check within 30 minutes (§8.5), so cases wait for the claim and the final prepare rather than a preflight.
E2E-4's "no reload while waiting" compares only X page loads: in full runs Win-C's concurrent E2E-3 loads TikTok pages on
the same fixture server (an early run counted those and failed; the product never reloaded the X tab).

## Decisions taken in tests (no design change)

- `submitted_by` and `fence_override` are not in any view; E2E-10 and E2E-13 read them from the hub's records with the hub
  stopped (`stack.records()`), never while it runs (a reader on the rollback-journal SQLite file could make a running hub's
  commit fail). E2E-13 checks the §5.4.3 flag where the design puts it — the job and the late fact events — not
  `result.fence_override`, which the hub sets only when `result` is itself the first late fact.
- E2E-3c: rescheduling a missed post to now + 90 s stays within the ±60 min tolerance, so `approval_retained` is `true`
  there; the test asserts the automatic approval only when it is `false`, as §10.2 words it, and always asserts a new job
  and exactly one post.
- E2E-11's "heartbeats do not time out during assembly and ffprobe": on this machine the 1 GiB upload, assembly and probe
  finish in seconds, between two 15 s heartbeats. The test therefore probes the hub with a read transaction every 200 ms
  through the whole window (slowest must be < 3 s; the heartbeat timeout is 10 s), and asserts no failed heartbeat for both
  Workers up to their next heartbeat after the upload is ready.

## Results (2026-11-24, this Mac, Google Chrome headless, ffmpeg 30 MB clip)

| Command | Result |
|---|---|
| `pnpm test:e2e-phase1` run 1 | 24 pass, 0 fail; E2E-11 skipped (gate) |
| run 2 | 23 pass, 1 fail — E2E-4 counted the concurrent E2E-3's TikTok page loads (test scope, fixed; not a product failure) |
| runs 3 and 4, back to back after that fix | 24 pass, 0 fail each (≈ 11.8 min wall time each); E2E-11 skipped (gate) |
| `SMARTSELL_TEST_LARGE=1 node --import tsx --test tests/e2e-phase1/large.test.ts` (run twice) | pass: relay killed at 40.6 % (416/1024 chunks held), second run resumed at 436,207,616 bytes, every answer < 4 KB, ready 14 s after the start, 16 hub probes during assembly/probe with the slowest 3 ms, no failed heartbeat on either Worker |
| `node --import tsx --test tests/phase1/*.test.ts` | 11 pass |
| Unit tests next to the fixes (`tests/connector-desktop`, `apps/connector`, `apps/server/src/modules/worker`, `account.test`, `account-migration-http`) | node 284 pass / 0 fail, vitest 49 pass; worker module 46 pass after fix 3 |
| `node scripts/test.mjs` (whole suite, includes the E2E files) | node 1242 tests: 1206 pass / 0 fail / 36 skipped; vitest 160 pass / 2 fail (`apps/server/src/modules/planning/publishing.test.ts`, see `S8.md` 7 — fails the same with S8's changes backed out); Playwright apps/web/test 6 pass, tests/web-e2e 114 pass / 4 fail / 3 skipped (W-specs is rewriting those specs concurrently; S8 did not touch them) |
| `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck` | 0 errors |
