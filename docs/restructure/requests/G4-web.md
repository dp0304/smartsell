# G4-web (wave 6): owner dashboard and read models — notes and handoffs

G4-web owns `apps/web/**`, `apps/server/src/modules/workspace/views/**` (including `hub-model.ts`), `apps/web/test/**` and
`tests/web-e2e/**`. Nothing else was edited; everything under "Handoffs" is a change in a file G4-web does not own. Nothing was
committed, downloaded or installed, and no real platform was touched.

Scope: WV-2, WV-3, WV-4, WV-5, WV-6, WV-7, WV-8, WV-9, WV-10, WV-11, WV-12, WV-13, F8, and the web/views parts of F1 (E37),
WV-1 (E36), F6 (E38), COH-3 (E41), COH-4 (E42), F2 (E35) and SEC-3 (E46), plus the handoffs to web/views in G1-engine,
G2-posting, G5-ops and G6-relay-docs.

## Files changed

- Views: `views/posts.ts`, `views/today.ts`, `views/machines.ts`, `views/timeline.ts`, `views/home.ts`, `views/activity.ts`;
  new test `views/wave6.test.ts` (one test per finding; each comment says what the old code returned).
- Web: `view/data/hub-types.ts`, `view/hub-copy.ts`, `view/hub-parts.tsx`, `view/copy.ts`, `view/routes.tsx`,
  `view/pages/{TodayPage,PostPage,post-detail,MachinesPage,ChannelPage,ChannelsPage,NotificationsPage,setup-hub,setup-agent-prompt,calendar-text,calendar-logic}.ts(x)`,
  `view/pages/hub.css`.
- Web tests: `view/pages/hub-pages.test.tsx` (8 new tests; the harness also seeds the all-pages cache key and fixes the
  browser zone to Asia/Shanghai), `view/pages/calendar-logic.test.ts` (1), `view/pages/setup-codex-routing.test.ts` (1 assertion).
- E2E: `tests/web-e2e/phase1-dashboard.spec.mjs` (5 new scenarios), `tests/web-e2e/view-shell.spec.mjs` (G6 handoff 2),
  `tests/web-e2e/editorial-workspace.spec.mjs` (sign-in helper, see "Existing tests changed").

## Per finding

### WV-2 (E34) — approve offered after the request lapsed (fixed)
- `posts.ts approvalOf`: the displayed deadline is the request's own `due_at`, also after it passed or was expired by the
  scan; without a request, `scheduled_at + lateness`. New `approvalOpen()` (pending and `due_at > now`), used by `postActions`.
- `today.ts postCard`: 核准／駁回 only while the request is open. Otherwise the card (urgent) says
  「核准期限（{due}）已過，這則目前不會發出；改期即可重新送審。」 with [改到…, 開啟貼文] (without a request:
  「這則目前沒有可以核准的請求，不會發出；改期即可重新送審。」).
- Web: approving with no pending request (409 INVALID_STATE) reads 「這則目前沒有可以核准的請求（期限已過或已處理），不會發出；改期即可重新送審。」.
- Tests: `wave6.test.ts` "WV-2 (E34) …" (a pre-E34 request with the 48 h cap, 49 h later, pending past due_at and then
  expired — before: [approve, reject, open] with 「請在 11-29 … 前核准」); web "WV-2/WV-9 …" (the lapsed card renders 改到…).

### WV-3 — 200 'blocked'/'expired' shown as 「已送出。」 (fixed)
- `hub-parts.tsx approvalNotice()` maps the approve/reject answer through `decisionOutcome()`: blocked → warning
  「沒有核准：{precheck blocker messages}」, expired → 「核准期限已過，這則不會發出；可以改期重新送審。」, otherwise 「已送出。」.
  A warning notice has `role="alert"`.
- Not changed: the activity feed still words the `publishing_approve` call as 「核准了發布」 (it is a call log without the
  outcome; the post and Today show the real state).
- Tests: web "WV-3 …" (pure function); E2E "Today: approving while the machine is paused says why nothing was approved, never 已送出 (WV-3)".

### WV-4 (E35) — a pause was invisible (fixed)
- `posts.ts`: additive `pause` on PostSummary (only while held): `{scope, reason, by, at, resume_web_url, pause_id}` for a
  post in draft/blocked/awaiting_approval/scheduled/ready that an active pause_switch covers (its own `paused_by_switch_id`
  first, else `activePause`), or whose machine is paused (`scope:'machine'`, resume link to the machine page).
  `pauseView()`/`pauseCovers()` follow the planning module's scope rule.
- `today.ts pauseItems()`: one Today item per active pause_switch that covers a hub channel or holds a post — kind
  `publishing_paused` (additive), `id pause:<id>`, `blocks_scheduling:false` (E35: posts scheduled meanwhile are submitted on
  release), urgent while a held post is due within 48 h. Title 「全部發布已暫停：N 則貼文恢復前不會發出」 (or 「X @h 已暫停…」,
  「品牌「…」已暫停…」), detail 「Agent 在 11-24 12:00 暫停（reason）。最早一則是 …。恢復後，暫停期間排好的貼文會重新送出；
  已超過遲到上限的會顯示「沒有發出」，可以改期。」, action 到設定頁恢復 (settings#st-pause). The Agent's overview gets the same item.
- `counts()`: a held post is not counted as scheduled.
- Web: Today rows and channel posts show an 「已暫停」 badge; the post page shows 「已暫停：恢復前不會發出」 with who/when/why and
  the resume link (`PauseNote`).
- Tests: `wave6.test.ts` "WV-4 (E35) …" (workspace pause by the Agent, machine pause, channel pause by a person); web "WV-4 (E35) …", "post page: E35 pause note …".

### WV-5 — unknown card always said 「目前離線」 (fixed)
- `today.ts`: unreported + machine online → 「{machine} 沒有回報這則的結果。請到平台確認：有就貼上網址，沒有就按「確認沒發出」；
  系統不會自動重發。」; offline keeps the Appendix C sentence.
- `timeline.ts`: the `unreported` event reads 「{machine} 沒有在期限內回報結果；結果不明，系統不會自動重發」 (the hub cannot know
  the machine was offline, §5.6).
- Test: `wave6.test.ts` "WV-5 …".

### WV-6 — times in the post's zone under another page zone (fixed)
- `postSummaryOf(ctx, target, zone?)`: local fields in `zone` (default: the post's own zone, so the Agent's
  `local_time "… <zone>"` and the post page, which names its zone, are unchanged).
- `buildToday(ctx, tz)` renders every post, card text, deadline and machine 「下一則」 in the page zone (`tz` or the workspace
  zone, the zone `timezone`/`date` already used); `buildOverview` uses the workspace zone.
- `machineSummaryOf(ctx, device, zone = workspace)`: `next_job.local_time` in that zone (was the post's zone). The Agent's
  `machines_list.next_job.local_time` and overview `next_job_local` are therefore in the workspace zone (overview names it).
- Web: Today's upcoming list says 「時間以 {zone} 顯示」; the machines, machine and channels pages render from the ISO instants
  (`next_job.at`, `not_before`, `scheduled_at`) in the browser zone and say so; the channel page renders everything in the
  channel's own zone (its subtitle names it, E42).
- Tests: `wave6.test.ts` "WV-6 …" (Asia/Taipei workspace, post in America/New_York, `?tz=`); web machine/channel page tests.

### WV-7 — 「下一則」 showed an unknown/old job (fixed)
- `machines.ts`: next job only among queued/claimed/ready (before `not_after`) and running.
- Test: `wave6.test.ts` "WV-7 …" (before: yesterday's outcome_unknown post).

### WV-8 — detail pages kept the previous item's state (fixed)
- `routes.tsx KeyedById`: posts/:id, machines/:id and channels/:id mount anew per id. `PostActions` is keyed by post_id;
  `PostPage`, `PostDetail` (calendar drawer) and the machine/channel pages never render placeholder data of another id.
- Test: E2E "Post page: moving to another post from the bell, and back, starts each page fresh (WV-8)" (open 改到… on post A,
  bell → post B: panel closed, B's own time; back → A fresh).

### WV-9 — card buttons latched as 「已送出。」 (fixed)
- `TodayPage.tsx`: the success is a notice tied to the card's current content (`cardSignature`), the button stays usable.
- `today.ts`: 恢復 is offered only while `job.not_after > now` (as `postActions`).
- Tests: `wave6.test.ts` "WV-9 …"; web "WV-2/WV-9 …"; E2E "Today: 檢查登入 on a login card stays usable … (WV-9)" (pressed twice).

### WV-10 — approval time in UTC (fixed)
- `post-detail.tsx`: `isoLocal(decided_at, post.timezone)` (also shown for 已駁回).
- Test: web "post page: … WV-10 …" (01:15Z → 09:15 Asia/Shanghai).

### WV-11 — English Agent errors; 改到… defaulted to the past (fixed)
- `hub-copy.ts ownerErrorText` (zh-Hant first, Appendix C wording where it exists) for TIME_IN_PAST, TIME_NONEXISTENT,
  TIME_AMBIGUOUS, TIMEZONE_INVALID, POST_FINAL, POST_LOCKED, POST_RESULT_UNKNOWN, POST_NOT_FOUND, INVALID_STATE (approve/reject
  get the approval sentence), JOB_INVALID_STATE, APPROVAL_STALE, LEASE_HELD, DUPLICATE_DECISION, RETRY_NOT_ALLOWED,
  RESUME_NOT_ALLOWED, POSSIBLY_SENT, CONFIRM_TEXT_MISMATCH ({expected}), HUMAN_REQUIRED, VERSION_CONFLICT, HANDLE_MISMATCH,
  HANDLE_UNKNOWN, RISK_TERMS_OUTDATED, AUTOMATION_NOTICE_OUTDATED, ACCOUNT_OWNERSHIP_REQUIRED, DRY_RUN_IN_PROGRESS,
  MACHINE_BINDING_REQUIRED, DRIVER_UNAVAILABLE, MACHINE_NOT_FOUND, INVALID_ARGUMENTS. `ownerProblemText()`: zh prefers
  `details.owner_message`; unknown codes fall back to the plain problem. `WriteError` (every hub page) uses it.
- `defaultRescheduleTime()`: the post's own time while it is ahead, else the next full hour in the post's zone.
- Test: web "WV-11 …".

### WV-12 — Overview 「本週」 disagreed with Today (fixed)
- `home.ts publications()` (now exported): failed counts `missed`, outcome_unknown counts `unknown`. Labels aligned with
  Today: 「沒有發出」「結果不明」 (`copy.ts`).
- Test: `wave6.test.ts` "WV-12 …".

### WV-13 — bell and notifications only saw 50 alerts (fixed in the web)
- The bell's count reads `/views/alerts?unread=true` with every page; the notifications page reads every page.
- Test: the existing notifications test now goes through the all-pages read (harness seeds both keys); the E2E bell test passes.
  See handoff to G5 for a cheaper count.

### F8 — posts_list with one bound (fixed)
- `listPosts`: only `from` → `from … from+7`; only `to` → `min(today, to−7) … to`; after defaults an inverted range answers
  422 INVALID_ARGUMENTS (path `to`); `postsQuery` reports the inverted REST range on `to` too. Covers REST and MCP (same builder).
- Test: `wave6.test.ts` "F8 …" (before: `{from:'2026-12-10'}` → to 12-01, total 0).

### F1 (E37) — web part (fixed)
- `postStatusText.rejected` 「已駁回」 (neutral); post page note 「你駁回了這則，它不會發出。要發的話，按「改到…」選時間就會重新送審。」;
  calendar word and never overdue; `postActions` for `rejected`: [reschedule, cancel]; `POST_STATUSES` accepts it; no Today card,
  not counted (Today counts, channel scheduled_today and next_post exclude it); no owner click window.
- Tests: `wave6.test.ts` "E37 …"; web "post page: … E37 …"; `calendar-logic.test.ts` "E37 …".

### WV-1 (E36) — web part (fixed)
- `postActions`: force_release only when `canForceRelease(job)` (hub never saw it start) and the machine is offline.
- Copy: `forceHint` says the hub has no record that it started; POSSIBLY_SENT owner copy; `missedReasonText`/timeline
  `released_unconfirmed`; a legacy released_unconfirmed missed card offers only 開啟貼文 and says 「…可能已經發出。請先到平台確認，再決定要不要改期。」.
- Tests: `wave6.test.ts` "E36 …", "E41/E36 timeline …"; web "post page: … E36 …", "WV-11 …".

### F6 (E38) — web part (fixed)
- Lateness input `min={2}` with the hint 「最少 2 分鐘（網路延遲與時鐘誤差）」. Tests: web channel page test; E2E "Channel page: … (E42, E38)".

### COH-3 (E41) — web part (fixed)
- Machine page 「撤銷這台機器」: honest consequences (cannot reach the hub; not-started posts wait for 換機器 or are missed;
  started posts are never re-sent and need checking; every channel must move; cannot be undone), typed machine name,
  `POST /hub/machines/:id/retire {confirm:true}`; the answer is shown (posts waiting, posts to confirm as links, channels to
  move as links). Timeline `machine_retired` and missed reason `machine_retired` worded; activity 「撤銷了機器」.
- Tests: web "E41 machine page …"; `wave6.test.ts` "E41/E36 timeline …", "E41: the activity feed …"; E2E "Machine page: 撤銷這台機器 … (E41)".
- The Worker App message and hub-setup.md are G3/G6 (their notes).

### COH-4 (E42) — web part (fixed)
- Channel settings form: 「時區」 select (IANA zones from `Intl.supportedValuesOf`), sent with the existing PATCH (If-Match).
- Tests: web channel page test; E2E "Channel page: the channel time zone is picked on the page and saved … (E42, E38)".

### F2 (E35) — web/views part (fixed through WV-4)
- Pause items, held-post notes and counts as above. `channelBlockers` still does not list a pause_switch: E35 (and G2) keep
  `can_schedule:true` for a paused channel because posts scheduled meanwhile are submitted on release. The stuck-post fix is G2's.

### SEC-3 (E46) — wizard warning (fixed)
- `HubInfo.tailscale.funnel_on/funnel_warning`; `HubAddress` shows a critical callout 「中樞被公開到網際網路」 with the hub's
  sentence (zh) or an English fallback. Test: web "E46 …".

### Handoffs addressed to G4 in other notes
- G1 1–6: done (postActions E36/E37, POST_STATUSES, counts, copy, timeline, activity, machine page). G1 7 (`channel-registration.ts`) is not a G4 file: still open for the account owner.
- G2 2, 4–7: done. G5 (wizard Funnel): done. G6 1 (`setup-agent-prompt.ts` upgrades every shipped block; test now asserts the
  command carries all of them — it failed before) and 2 (`view-shell.spec.mjs` asserts the v3 block; it was the one baseline E2E failure): done.

## Deviations from E34–E46
1. E35 is implemented with two additive view fields not yet in Appendix A: `PostSummary.pause` and the Today/overview item kind
   `publishing_paused` (typed in `today.ts`/`hub-types.ts`, like E18/E30's additions). A machine pause also fills `pause`
   (`scope:'machine'`), since a resume releases it the same way (E35).
2. F8 one-sided ranges (not in §7.2.8): only `to` starts at `min(today, to − 7 days)` (the verifier's fix_hint).
3. WV-6: machine `next_job.local_time` is now in the workspace zone for every reader (the Agent included), not the post's zone.
4. WV-5 copy for an online machine and the neutral timeline text for `unreported` are new owner copy (Appendix C only has the offline sentence).

## Handoffs (files G4 does not own)
- **G2-posting — `apps/server/src/modules/posting/views.ts attentionCompact`:** the item's `message` is now worded in the
  workspace zone (WV-6). Make its `local_time`/`deadline_local` match: `postSummaryOf(ctx, ctx.get('publish_target', item.post.id), workspaceZone(ctx))`.
  Optional: relay the E35 `publishing_paused` items (they already pass through with `kind`, `title`, `message`, `web_url`).
- **G5-ops — `apps/server/src/modules/alerts/index.ts views_alerts` (optional, WV-13):** an unread total (e.g. a small
  `GET /views/alerts/unread-count` or an `unread` field) would let the bell skip reading every unread page.
- **Account owner — `apps/server/src/modules/account/channel-registration.ts`:** G1 handoff 7 (re-adding an account bound to a retired machine).
- **Lead — `docs/restructure/phase1-design.md`:** Appendix A `PostSummary.pause?` and AttentionItem kind `publishing_paused` (E35);
  §9.2 the pause item and the lapsed-approval card; §9.3 「撤銷這台機器」; §7.2.8 one-sided `posts_list` ranges (F8); Appendix C.2
  the online-unreported sentence, the lapsed-approval sentence, missed `released_unconfirmed`/`machine_retired`; Appendix C owner
  copy for the codes listed under WV-11 that have none yet (TIME_*, POST_FINAL, POST_RESULT_UNKNOWN, APPROVAL_STALE, RETRY_NOT_ALLOWED, POSSIBLY_SENT, …).

## Existing tests changed (none weakened)
- `hub-pages.test.tsx` harness: also seeds the all-pages cache key (the notifications page now reads every page, WV-13) and
  fixes `process.env.TZ` so the browser-zone pages do not depend on the host.
- `setup-codex-routing.test.ts`: one stricter assertion (the command carries every shipped block).
- `view-shell.spec.mjs`: asserts the current v3 routing block instead of v1/v2 bytes (G6 handoff 2; it failed on the baseline).
- `editorial-workspace.spec.mjs` `signIn`: after sign-in it accepted only `/app/<ws>`, but the dashboard index sends an
  unconfigured workspace on to `/app/<ws>/get-started` as soon as its setup reads answer (setup-landing.tsx, unchanged), so the
  check raced the redirect: it failed in 2 of 3 full runs and passed alone. It now accepts either landing and still opens
  `/w/<ws>/home` as before; nothing the spec checks afterwards changed.

## Tests run
- Before the changes (baseline): `node scripts/test.mjs apps/web/src apps/server/src/modules/workspace/views` 199/199;
  `tests/web-e2e` 113 passed, 1 failed (view-shell, G6 handoff 2), 3 skipped.
- New tests fail on the old code: every `wave6.test.ts` case failed for the reported reason before the fix (10/10 at first,
  WV-12 and the later additions likewise); the web tests import helpers and copy that did not exist; the codex-routing
  assertion was checked against the old installer line (fails) and the new one (passes).
- `node scripts/test.mjs apps/web/src apps/server/src/modules/workspace` — 237 pass, 0 fail (three runs).
- `node scripts/test.mjs apps/server/src/modules apps/server/src/integration tests/phase1` — node:test 628 pass, 0 fail
  (11 skipped, Postgres); vitest 84 pass.
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs apps/web/test` — 6/6 passed, twice.
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs tests/web-e2e` — after the editorial-workspace fix, twice in a row:
  119 passed, 3 skipped, 0 failed (before it: 119/0, then 118 + the editorial race twice).
- `node scripts/test.mjs tests/web-e2e/phase1-dashboard` alone (12 scenarios incl. the 5 new ones) — pass.
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck` — clean.
