# G2-posting (wave 6): posting, planning and channel settings fixes

Scope: F1, F2, MCP-1, F3, WV-2 (server), COH-1 (server), F4, F5, F6, WE-6 (server), F9, MCP-4, F10, F12, COH-4 (server),
following E34–E44. Nothing was committed, downloaded or installed; no real platform was touched. Every fix has a test that
reproduces the reported scenario (it fails on the previous code for the reason given) and passes now.

Files changed (all in G2's ownership):

- `apps/server/src/modules/planning/index.ts`
- `apps/server/src/modules/posting/{unblock,update,schedule,schemas,views}.ts`
- `apps/server/src/modules/account/{channel-settings,channel-ops,machine-ops}.ts`
- `apps/server/src/modules/workspace/brands.ts` (`updateWorkspace`, the `workspace_update` handler)
- `packages/domain/src/publishing/index.ts`
- `apps/server/src/integration/mcp-hub-tools.ts` (one sentence in the `post_update` description)
- tests: `planning/publishing.test.ts`, `posting/posting.test.ts`, `account/channel-ops.test.ts`,
  `packages/domain/src/publishing/publishing.test.ts`

## Per finding

### F1 (E37): a rejected post is never resubmitted on its own

- `decide()` still stores 駁回 (and 'request changes') as `plan_status: 'changes_requested'`; the approval request says
  `rejected` (or `changes_requested`). That state is now terminal for every automatic path:
  - `posting/unblock.ts` `waiting()`: `changes_requested` is never waiting (it was), and `applyUnblock` no longer submits it.
  - `packages/domain` `invalidateTargets()` (new revision, rights or execution review): leaves `draft` and `changes_requested`
    as they are. It used to move a rejected post to `awaiting_approval` with no request, which an approval-mode switch to
    direct or the §4 rule would then have resubmitted and approved.
  - `applyApprovalModeChange`, the E35 release/resume sweep, `applyPlanningEvent` and `checkPolicyImpact` only touch
    `ready`/`paused`/`awaiting_approval`/`draft`, never `changes_requested` (unchanged, now covered by tests).
- Only an explicit action sends it again: `post_update` edit or reschedule (`updateTarget` turns it into `draft`, then
  `submit()`), or `publishing_request_approval`.
- `post_update` tool description gains: "A post the owner rejected is submitted again only when you reschedule or edit it."
- `posts_list` status enum (`posting/schemas.ts` `POST_STATUSES`) accepts `rejected` (E37); its max length follows the list.
- The derivation (`PostStatus 'rejected'`, `approval_rejected`) is G1's; see handoffs.
- Tests: posting "F1/E37 …" (reject → `daily_cap` change → posting.unblock → still rejected with one request; switch to direct
  → still rejected, no job; `edit_caption` → approved by channel policy); planning "E37 …" (settings changes, direct switch,
  `invalidateTargets`, then an explicit submit); domain "E37: a new revision leaves a rejected (changes_requested) target …".

### F2, MCP-1, F10 (E35): pause release and machine resume

- New `resubmitWaiting(ctx, match)` in planning (also registered as a planning hook). For hub-channel targets it submits
  `draft` ones with `auto_submit_on_unblock`, and `awaiting_approval` ones without a valid pending request (via
  `resubmitIfWaiting`). It skips posts still held by another active pause, posts with execution risk, and posts past
  `scheduled_at + lateness` (they derive as missed; 「改到…」 resubmits them).
  - `releasePause` calls it for every target in the released scope that was not one of the switch's own paused targets, in
    the release transaction.
  - `hub_machines_resume` (`account/machine-ops.ts`) calls it through `resubmitMachineTargets()` (`channel-settings.ts`) for
    the channels bound to that machine, in the resume transaction; the audit row records `resubmitted_posts`.
- F2/F4 shared fix (see F4): a blocked hub resubmission becomes `draft` (derived `blocked`, approval `not_submitted`), so a
  direct post rescheduled during a pause is never reported `awaiting_owner` and the owner is never offered an approval the
  hub refuses.
- F10: `releasePause` never closes a hub-channel target. Past its lateness limit it returns to `ready`; its job (still live or
  already `missed`) is reported missed by the lifecycle, so `post_update reschedule` works. Without such a job, the existing
  ready path runs (a dispatch into the past window, which the lifecycle reports missed; never a second run). An explicit
  `skip` release decision on a hub post cancels it (derived 「已取消」) instead of closing it (closed hub posts derived
  `draft`).
- The `pause_switch` blocker on a hub channel now reads 「已暫停：恢復前不會發出」 (E35 wording), with `scope_type` in the detail.
- `smartsell_overview` `channels[]` carries `pause {scope, reason, at}` when one is active (additive, the same shape as
  `channels_list`, E35). `can_schedule` stays true: under E35 a post scheduled during a pause is submitted on release.
- Tests: planning "E35: posts scheduled, rescheduled or switched to needs_approval during a pause …" (all three cases of the
  finding), "E35: on a direct channel …" (workspace pause released while a channel pause still holds), "E35: resuming a paused
  machine …", "E35/F10: a hub post that missed its window during a pause is not closed …", "E35: skipping a hub post …";
  posting "F2/MCP-1/E35 …" (real `post_schedule`, `pausePublishing`, `post_update`, overview pause, release) and "MCP-1/E35:
  a post scheduled while its machine is paused …".

### F3, WV-2, COH-1 (E34), server side

- `approvalDue()`: for a hub channel the request deadline is `scheduled_at + lateness_limit_min`, no `now + 48 h` cap. A
  pending request kept under the reschedule tolerance moves to the new deadline without the cap. `request.due_at`,
  `approvalDeadline`, the reminders (which read pending requests) and `approval_lapsed` therefore agree.
- `scanPlanningDue`: when a hub request expires while the post can still go out (only requests written before E34), it calls
  `resubmitIfWaiting` at once, so the post holds a fresh pending request until its real deadline.
- Existing test changed: "a needs_approval channel waits for the owner, with a deadline of min(48h, scheduled_at + lateness)"
  asserted the old far-post `due_at` (now + 48 h), which is the reported bug. It now asserts E34 (`2027-01-05T10:30Z`), that the
  request is still pending 49 h later and that the owner can approve. The near-post part is unchanged.
- New test: "E34: a request written with the old 48 h cap …".

### F4: a blocked resubmission is blocked, and its stale job is revoked

- `submit()` → `blockedResubmission()`: when precheck blocks a hub target that is `awaiting_approval` without a valid pending
  request (or an explicitly resubmitted `changes_requested`), it retires a stale pending request, sets `plan_status: 'draft'`
  (`frozen_hash` null, `auto_submit_on_unblock: true` so fixing the blocker, a release or a resume continues it) and calls
  `revokeForTarget(…, 'approval_invalidated')` in the same transaction (as E23): the matching job was kept while the post was
  still `ready`.
- `post_update edit_caption` with 150 CJK characters on a direct X post now answers `blocked` / `not_submitted` with the
  `caption_rules` blocker, and the old job is cancelled.
- Test: planning "F4: a direct post whose edit is blocked …" (job engine installed; also checks a fitting caption re-approves
  and dispatches one new job).

### F5: `post_schedule` replay

- `replay()` rebuilds `posts[]` from the stored `target_ids` with `agentPost()` (current status, approval, blockers); only the
  scheduling call's own warnings (`caption_empty`, `caption_title_ignored`, `login_check_unavailable`) and the queued login
  check id are kept from the snapshot.
- When every stored post is `cancelled` (and none has a platform post), the stored dedupe record is dropped and the call
  schedules anew. Anything else is never scheduled twice.
- Test: posting "F5: a replayed post_schedule reports each post as it is now …".

### F6, WE-6 (E38), server side

- `parseSettingsPatch` and the `hub_channels_update_settings` JSON schema take `lateness_limit_min` 2–240 (`LATENESS_MIN = 2`,
  exported from `channel-ops.ts`); 0 and 1 get 422 `INVALID_ARGUMENTS` with the path.
- Test: channel-ops "E38: lateness_limit_min below 2 minutes is refused …".

### F9, MCP-4 (E39)

- `post_update reschedule` without `timezone` reads `when` in the workspace zone (`workspaceZone(ctx)`), as the schema
  description and §7.2.7 say. No text change was needed.
- Test: posting "F9/E39 …" (post scheduled in America/New_York, rescheduled to `2027-01-06 10:00` → `02:00Z`, Asia/Shanghai).

### F12 (E44): platform video limits

- `packages/domain` `channelVideoLimits()` / `channelVideoCheck()`, applied in `assessTarget` to each primary video of a hub
  X/TikTok post (not while it is still uploading, not when it already failed):
  - X without Premium: longer than 140 s or larger than 512 MB → `media_spec` blocker. X Premium (E7: `caption_limit` 25,000):
    4 h or more, or larger than 16 GB → blocker. The X message tells the owner how to mark the account Premium.
  - TikTok (TikTok Studio web upload, which the Worker drives): longer than 30 minutes, or 10 GB or more → blocker.
  - Blocks only when certainly over: sizes in binary units, 1 s for container rounding of the duration.
  - No probed duration (ffprobe could not read the file, or the hub has no ffprobe): risk 「未取得影片長度與尺寸，無法在排程時檢查平台的影片限制」 (E3).
  - X aspect ratio outside 1:2.39–2.39:1: risk only. The same X help answer also lists a 1920×1200 maximum resolution, 40 fps
    and 25 Mbps; I could only read an archived copy and could not confirm whether the uploader rejects or transcodes such
    files, so none of these are blockers (resolution, frame rate and bitrate are not checked at all). TikTok's format
    (MP4/WebM) and 720×1280 floor are not checked either, for the same reason. Images are not checked.
- Sources, read through Exa on 2026-11-24:
  - X Help Center, "How to share and watch videos on X", https://help.x.com/en/using-x/x-videos. The direct fetch was
    unavailable; the archived copy https://archive.ph/PIT63 (2025-03-21) states: without Premium up to 140 seconds and 512 MB;
    Premium shorter than 4 hours and 16 GB; web aspect ratios 1:2.39 to 2.39:1. Two November 2026 pages that cite the same
    help article give the same 140 s / 512 MB figures (renderhour.com, 2026-11-19; thecontentpilotai.com, 2026-11-12).
  - TikTok Support, "Creator tools on TikTok", https://support.tiktok.com/en/using-tiktok/creating-videos/creator-tools-on-tiktok
    (the English page timed out; the German and Indonesian copies of the same article were read): web uploads must be MP4 or
    WebM, 720×1280 or higher, up to 30 minutes and less than 10 GB. Third-party pages checked in September and November 2026
    give the same numbers (auk.video; superdirector.app, 2026-11-18).
- Domain test fixture: the channel video now carries probed meta (30 s, 1080×1920); without it the fixture's "passes clean"
  tests would see the new E3 risk. Their intent is unchanged.
- Tests: domain "E44: X and TikTok video limits block only when the probed file is certainly over …"; posting "F12/E44: an
  oversized video for a standard X account is blocked at post_schedule …" (TikTok, same 15-minute file, still goes to approval).

### COH-4 (E42), server side

- The channel time zone was already editable through `PATCH /hub/channels/:id/settings` (`timezone`). New
  `followWorkspaceZone(ctx, from, to)` in `channel-settings.ts`: every hub channel whose `timezone` equals the previous workspace
  zone takes the new one, with `settings_generation` +1, the machine's sync generation bumped, an audit row and
  `account.channel_settings.changed` (so posting.unblock resubmits posts the old zone's window or cap had blocked). A channel the
  owner set to another zone keeps it. `updateWorkspace` (`workspace/brands.ts`, the `workspace_update` handler) calls it in the
  same transaction when `default_timezone` is in the patch.
- Test: channel-ops "E42: a channel keeps a zone the owner chose; channels still on the old workspace zone follow …".

### Copy

- `machine_paused` blocker text aligned with Appendix C.2: 「{machine} 已暫停，這則不會發出，直到你恢復機器。」.

## Deviations from E34–E46, with reasons

1. E35 lists `changes_requested` among the targets a release resubmits. In phase 1 `changes_requested` only comes from the
   owner's 駁回 or 'request changes', and E37 says a rejected post is never resubmitted by anything automatic. The release and
   resume sweep therefore skips `changes_requested`; E37 wins.
2. E35 says hub targets are not closed by a release and return to `ready`. That is done for the automatic path. An explicit
   `skip` decision in `publishing_release_pause {decisions}` (not used by the phase-1 web, which sends `{}`) cancels a hub post
   instead of closing it, because a closed hub post derived as `draft` and refused 「改到…」 with `POST_FINAL`.
3. E34 is applied as written; in addition `scanPlanningDue` resubmits hub requests that expire before their real deadline, which
   only happens to requests created before E34 (fix_hint of F3/COH-1).
4. F4: a blocked hub resubmission also sets `auto_submit_on_unblock: true`, so posts created outside `post_schedule` (REST
   `publishing_create_target` on a hub channel) are continued by unblock, release and resume after they had been submitted once.
5. E44: blockers only for duration and file size (X standard/Premium, TikTok web); the stated X aspect range is a risk. See F12.

## Handoffs (changes needed in files G2 does not own)

To G1 (engine, contracts derivation, `posting/model.ts`, views status):

1. E37 derivation: add `rejected` to `PostStatus` and `approval_rejected?: boolean` to `derivePostStatus` (return `rejected` for
   it, before `draft`/`blocked`). Pass it from both `postStatus` helpers (`apps/server/src/modules/posting/model.ts` and
   `apps/server/src/modules/workspace/views/hub-model.ts`) as:
   `approval_rejected: target.plan_status === 'changes_requested' && ['rejected', 'changes_requested'].includes(String(locate(ctx, 'approval_request', target.approval_request_id)?.status))`.
   G2 keeps `plan_status: 'changes_requested'` for both reject and request-changes; an explicit edit turns it into `draft`, so
   the derivation stops saying `rejected` as soon as the post is resent. (Drop `'changes_requested'` from the list if G1 wants
   only 駁回 to show as `rejected`.)
2. `apps/server/src/modules/workspace/views/posts.ts` `POST_STATUSES` (REST `views_posts_list?status=` parser): add `'rejected'`
   so the REST filter accepts what the MCP schema now accepts.
3. E38 (optional): settings saved before E38 may still hold 0 or 1. If wanted, read the limit as
   `Math.max(settings.lateness_limit_min, 2)` in `apps/server/src/modules/worker/dispatch.ts` (`not_after`) and in the Worker's
   offline rule; G2 left `approvalDeadline` unclamped so the hub and the Worker keep one value. The `max(now, not_before)`
   window rule of E38 is WE-7/F7 (G1).

To G4 (web and views):

4. WV-2/COH-1 view side (E34): Today's approval card offers 核准/駁回 only when the post's request is `pending` and `due_at > now`
   (build it from `postActions`), and `approvalOf` shows `request.due_at`. With E34 a new request's `due_at` equals
   `approvalDeadline`, and since F4 a hub post waiting for approval without a pending request is no longer left behind.
5. F6/WE-6 (E38): `apps/web/src/view/pages/ChannelPage.tsx` lateness input `min={2}` (the server now answers 422 below 2).
6. COH-4 (E42): a time-zone select on the channel page that sends `timezone` with the existing settings PATCH (If-Match as for
   the other fields). After a workspace zone change the channel's settings version moves, so the page must reload it.
7. E35 view side (WV-4): Today and the post page label held posts 「已暫停：恢復前不會發出」 and list each active pause. Blocked
   posts scheduled during a pause already carry that text as their `pause_switch` blocker. `channels_list.can_schedule` should
   stay true for a paused channel (posts scheduled meanwhile are submitted on release); the overview now shows `pause`.

To the owner of `apps/server/src/integration/workspace-services.ts` (agent.leases-and-approvals schedule):

8. Optional: lines ~184-188 expire pending requests without resubmitting. With E34 a hub request expires only at
   `scheduled_at + lateness`, so nothing is required; to also cover requests written before E34, call
   `resubmitIfWaiting(ctx, target.id)` after that expiry, as `scanPlanningDue` now does.

## Deferred

- A post already `ready` whose upload finishes later with a file over the platform limit is caught by the 1-hour preflight and
  the go check, not at upload time. Re-assessing ready posts on `asset.version.created` and withdrawing their approval would
  change the approval flow beyond E44's "at scheduling" scope.

## Tests run

- `node scripts/test.mjs apps/server/src/modules/posting apps/server/src/modules/planning apps/server/src/modules/account packages/domain/src/publishing apps/server/src/modules/workspace apps/server/src/modules/alerts apps/server/src/modules/worker apps/server/src/integration apps/server/src/modules/content apps/server/src/modules/execution apps/server/src/modules/asset`:
  413 node:test + 71 vitest, all pass (an earlier run failed one `worker/device-jobs.test.ts` check_login case while G1 was
  mid-change for WE-5; it passes now).
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck`: no errors in G2's files. The only remaining errors are in
  `apps/server/src/hub/tailscale.ts` (`funnel_on`, `funnel_warning`), which another group is editing for E46.
