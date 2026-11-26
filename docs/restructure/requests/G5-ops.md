# G5-ops (wave 6): hub operations, alerts, login throttling — E43, E45, E46 — notes and handoffs

G5-ops owns `apps/server/src/modules/alerts/**`, `apps/server/src/hub/**`, `apps/server/hub.ts`, `apps/server/hub-init.ts`,
`apps/server/src/{auth,config,local}.ts`, `scripts/hub-{service,update,doctor}.mjs`, `scripts/install-hub.sh`,
`docs/hub-setup.md`, additive exports in `apps/server/src/modules/worker/presence.ts`, and the tests next to these files.
Nothing else was edited; everything under "Handoffs" is a change in a file G5-ops does not own.

New files: `apps/server/src/hub/backup.ts` (+ `backup.test.ts`), `apps/server/src/hub/supervisor.ts` (+ `supervisor.test.ts`),
`apps/server/src/auth.test.ts`. No real service was installed, no real update was run, nothing was downloaded: service and
update code is tested with a scripted `exec`, temp directories and fake `/readyz`; the supervisor's process plumbing with a
tiny temp script and with the real `hub.ts` on a loopback port.

How "fails before the fix" was checked: for `update.ts` and `auth.ts` the new tests were run against the pre-wave files
(kept in the session scratchpad) — 7 update tests and 3 auth tests fail there, all pass now. The alerts tests reproduce the
verifiers' repro scripts (`verify/alerts-ops/repro.mts`, `click-post.mts`) through the same code paths (`reportJob`,
`setJob`, `scanAlertReminders`, the schedule and the drain); the outputs those repros printed on the old code are exactly
what the new assertions reject.

## Per finding

### AO-1 — hub:update changed the live checkout before verifying; --check loaded nothing; no rollback, no DB copy (fixed, E45)
- `hub/update.ts` rewritten. Order: **0** `git rev-parse HEAD` (refuses to start without it) and
  `backups/pre-update-<time>.sqlite` (refuses to start if the copy fails) → **1** `git pull --ff-only` → **2** `pnpm install
  --frozen-lockfile`, relay → **3** Web type-check and build into `dist.staging` → **4** `hub.ts --check --hub-dir … --load`
  with the new code → **5** only now swap `dist` (old one kept as `dist.previous`) and place selectors (old file content kept)
  → **6** restart and wait for the *new* process (status.json pid must differ from the pre-restart pid, then `/readyz`).
- Failure in 2–4 (`failBeforeRestart`): `git reset --keep <prev>` (keeps the owner's own edits; refuses rather than clobber),
  `pnpm install --frozen-lockfile --offline` (falls back to online), relay rebuild, staging removed; `dist`/selectors were
  never touched. So the old version is also what runs after the next reboot. Text keeps 「中樞服務沒有重新啟動，舊版本繼續執行」
  and now says the source/dependencies went back (or exactly what to run if that failed).
- New version not ready within 60 s: stop (bootout / `schtasks /End`), wait until `/readyz` is down and the new pid is gone,
  revert files as above, compare the snapshot digest of the live DB with the pre-update copy; if the new code changed it,
  `restoreDatabase` moves the live file (and its `-journal`) aside as `smartsell.sqlite.failed-update-<time>` (never
  deleted) and puts the copy back; start the service, confirm `/readyz`, print 「[已回復] …」. Exit code 1 either way.
- `hub/startup.ts`: `--load` (only with `--check`) runs `runLoadCheck`: imports `bootstrap.js`, `discover()` (production:
  missing command modules are errors) and `discoverOperations()` (load failures are errors) — the same rules `start()`
  applies — and decodes a **private copy** of the data (`backups/.load-check-*.sqlite`, removed afterwards) with the new
  store code. It never listens and never opens the live file. `hub:service install` also uses `--check … --load`.
- `--skip-pull`: the source cannot be reverted (no earlier commit known); dependencies/dist/selectors are, and the message
  says so.
- Tests: `tools.test.ts` — `hub:update: a failed Web build never restarts the service` (now also asserts `git reset --keep
  <prev>`, and that a failed pull or a missing HEAD changes nothing), `AO-1 (a)` (install fails after the pull moved HEAD),
  `AO-1 (b)` (load check fails: live Web app and selectors stay old), `AO-1: a new version that does not come up …` (stop,
  revert, DB restored, changed file kept, start; and the "data unchanged" variant), `AO-1: a good update …`;
  `hub.test.ts` — `AO-1: --check --load …` (load failure → HUB_LOAD_FAILED; undecodable data → HUB_DATA_UNREADABLE; live
  file byte-identical; copy removed; plain `--check` unchanged) and `AO-1: the real hub.ts --check --load …` (real process,
  every module); `backup.test.ts` — digests and `restoreDatabase`.
- Existing tests changed: the two old `hub:update` tests' scripted exec now answers `git rev-parse HEAD` (a new step 0); the
  old pull-failure assertion `calls == ['git pull --ff-only']` became `['git rev-parse HEAD', 'git pull --ff-only']`.

### AO-2 — Windows RestartOnFailure never restarts a crashed hub (fixed, E45)
- `hub/supervisor.ts` + `hub.ts --supervise`: the task's action is now `node --import tsx …\hub.ts --supervise --hub-dir …`.
  The supervisor runs the hub as a child with an IPC channel; non-zero exit or signal → restart after 10 s, doubling to
  5 min, reset after a 10-minute run; exit 0 (config_error, normal stop) → supervisor exits 0 (no loop, §2.5 unchanged).
  Supervisor stopped (SIGINT/SIGTERM/SIGBREAK) → it disconnects the IPC channel, which `hub.ts` treats like SIGTERM;
  supervisor killed outright (`schtasks /End` = TerminateProcess) → the channel closes and the hub still stops gracefully.
  `RestartOnFailure` stays in the XML for a supervisor that fails to launch.
- `hub/doctor.ts` (Windows): a task whose XML has no `--supervise` is an `[錯誤]` with the reinstall command; one with it is
  `[OK]`. `hub:update` on Windows warns about an old task and waits for the old hub to release the port between `/End` and
  `/Run`.
- Tests: `supervisor.test.ts` (backoff/caps/reset, exit 0 ends, stop never respawns even mid-backoff, real child plumbing),
  `hub.test.ts` `AO-2: hub.ts --supervise ends … configuration error` and `AO-2: under the supervisor the hub stops
  gracefully when the supervisor is stopped, and when it is killed outright` (real hub, SIGTERM and SIGKILL),
  `hub-service.test.mjs` snapshots, `tools.test.ts` doctor test.
- Existing tests changed: the `LOGON_XML`/`BOOT_XML` snapshots gain `--supervise` (the fix itself).
- Not verified on a real Windows machine (none here); the IPC-disconnect behaviour was verified on macOS with SIGKILL.

### AO-3 — macOS plist pinned the versioned Homebrew keg (fixed, E45)
- `hub/service.ts`: `stableNodePath()` maps `<prefix>/Cellar/<formula>/<ver>/bin/node` to `<prefix>/opt/<formula>/bin/node`
  when that link exists; `context()` uses it (new deps `execPath`, `exists`), so the plist's ProgramArguments[0] and first
  PATH entry are stable. `plistProgram()` / `serviceNodeIssue()`: node gone → error, versioned keg → warning.
- `hub:doctor` reports both; `hub:update` re-renders and re-loads the service file through `planInstall` instead of
  `kickstart` when the node is gone (or versioned and a stable path is available — never in a loop).
- Tests: `hub-service.test.mjs` `AO-3 (E45) …` (serviceMain writes the opt path from a Cellar execPath; the check runs with
  the same node) and `AO-3: an installed plist …`; `tools.test.ts` `AO-3: hub:update rewrites a service file …` and the
  doctor test. `install-hub.sh` needed no change.

### AO-4 — false "machine offline" for every machine after a hub outage (fixed)
- `presence.ts` (additive): `presenceSince()` = when this process started tracking presence; `resetPresence(at?)` resets it.
- `alerts/reminders.ts`: `scanAlertReminders(ctx, { hubStartedAt })`; offline time counts from `max(last seen, hub start)`.
  Both startup paths pass it: the `alerts.reminders` schedule and the alerts drain (`createAlertsDrain`, injectable
  `hubStartedAt`). The dedupe key still uses the real last-seen time; a machine silent 10 minutes after the restart alerts
  with 「從 08:52 起沒有連線」. Direct calls without the option keep the old rule (hub up all along).
- Test: `triggers.test.ts` `AO-4: after a hub outage …` (the design's §5.1 timeline; both the schedule and the drain).

### AO-5 — a second blocker of the same type on the same job raised nothing (fixed)
- `alerts/triggers.ts` `blockerEpisode()`: number of the job's `prepared`/`started` events (applied) — the reports that end a
  needs_owner episode. Stable while the job stays blocked (the blocking report itself is not counted, and is written after
  the alert), different after the owner solved one and the Worker went on. Key `${job}:${code}:${resume_token}` plus
  `:e<n>` when n > 0 (old keys unchanged for episode 0). A retried event for a transition the job has already left raises
  nothing. Derived only from data already on the job/events; no worker file touched.
- Test: `AO-5: a second captcha … (real report path)` (22:00 preflight captcha → prepared → 08:30 final captcha = 2 alerts;
  a repeated report while blocked and a stale retried event = none). The existing "same blocker again on the same job"
  case (status flip with no `prepared` event) still dedupes and was not changed.

### AO-6 — assist reminder said "ready" when it wasn't, and swallowed the real ready alert (fixed)
- `scanClickPost`: the 「已準備好…按「發布」」 copy and the `:due` key only when the job is `needs_owner` /
  `owner_click_required`. Otherwise, 2 minutes after not_before and if the job is not blocked by something else (which has
  its own alert) and was never ready, `clickPostNotReadyAlert` (key `:due_timer`, normal): 「Win-C 還沒準備好 TikTok
  @fixture_tt 的草稿（截止 09:30）。」 The Worker's real report still raises the urgent `:due` alert.
- Test: `AO-6: an assist job not prepared at not_before …`. E2E-10 (`tests/e2e-phase1/cancel.test.ts`) still expects 2
  click_post_soon alerts; it was run after this change (see "Tests run").

### AO-7 — Worker settling an unreported post as failed raised nothing (fixed)
- `triggers.ts` `failed`: silent only when `owner_marked_not_published` is set or that event exists (§5.14). A Worker's
  failure from `unreported`/`outcome_unknown` raises `worker_blocker` (urgent): title 「X @fixture_x（Mac-B）的貼文沒有發出
  （Mac-B 後來回報）。」, body `STATUS_COPY.failed_late_report` with a reason from the new `FAILED_REASON` map (never the
  ambiguous platform_error wording).
- Test: `AO-7: …` (real `setJob` → unreported, real `reportJob` failed). Existing test changed: in `worker_blocker: …`
  the "owner's own mark-not-published" case now sets `owner_marked_not_published: true` like `markNotPublished` does —
  the old case encoded the bug (any failed-from-unknown was assumed to be the owner).

### AO-8 — no backups, no fullfsync (fixed, E45)
- `local.ts` `applyDurability()`: `busy_timeout=5000` everywhere; on darwin `fullfsync=ON`, `checkpoint_fullfsync=ON`.
  `localStore(path, { existing, platform })`; the returned store exposes `pragma()` for tests.
- `hub/backup.ts`: `VACUUM INTO` a pre-created 0600 `.partial`, renamed into place, in a 0700 `backups/`. Daily copy
  (`smartsell-<local date>.sqlite`, newest 7 kept) by `createBackupSchedule` in `startup.ts` (a minute after start, then
  hourly; failures logged, never fatal; stopped on close). Pre-update copies (newest 3, separate from the daily 7).
  Leftover `.partial`/`.load-check-*` older than a day are pruned.
- `hub:doctor`: newest backup and its age (none or > 48 h → warning).
- Tests: `backup.test.ts` (fullfsync on darwin only; rotation; modes; a copy taken during another connection's open write
  transaction is the committed state and the store keeps working; schedule logs failures), doctor test.

### COH-5 → E43 — machine_setup pushed every day forever (fixed as E43 says)
- `scanMachineSetup`: an alert only when a warning first appears, when its text (numbers ignored: idle minutes, clock
  offset, versions) changes, or when it returns after being gone ≥ 1 hour (`setup_absent_since` / `setup_cleared_at` on the
  latest alert row; written only on those changes). Alerts from before E43 (daily keys) count as already told. Today and
  the machine page are unchanged (S7 views).
- Existing test changed (it encoded the daily cadence the lead replaced): `machine_setup (E43): …` — 2 alerts stay 2 over
  two more days; number-only changes do not re-alert; FileVault turning off does; 30-minute absence does not; 61-minute
  absence does; a pre-E43 row is respected.
- Not done (not in E43): making `machine_setup` a switchable preference — it needs a contract and web change.

### SEC-1 → E46 — Agent read the Bark key / ntfy topic (fixed)
- `push.ts` `maskPushUrl()`/`channelView`: for an Agent credential (`fromAgent(ctx)`) the URL is origin + `****` + last 4
  characters of a secret ≥ 12 characters (`****` otherwise); for ntfy a base path stays and the query (`?auth=…`) becomes
  `?****`; Bark keeps only the masked key. People on the settings page still get the full URL. The op summary says so.
- Test: `push.test.ts` `E46 (SEC-1): …` (the verifier's PoC values: `https://api.day.app/****Y123`, `https://ntfy.sh/****3a9c`).

### SEC-2 — X-Forwarded-For spoofing: unlimited guesses, and lock-out by filling the map (fixed)
- `auth.ts` `createThrottle()`: a full map sweeps expired entries, then evicts the oldest window, instead of answering 429 to
  every newcomer. Per-address limit unchanged (10/min).
- Per sign-in name: 20 failures per 15 minutes → 429 before any password work, from every address. Existing accounts and
  made-up names are counted in separate maps (same answers, so no enumeration; made-up names cannot age out the owner's
  counter). A successful sign-in clears the count.
- `trustProxy: '127.0.0.1'` kept; semantics documented in `config.ts` and `docs/hub-setup.md` §9.
- Tests: `auth.test.ts` (unit; 25 guesses with rotating XFF → 20×401 then 429; 10,050 spoofed malformed requests → all 422
  and the owner still signs in from the tailnet address). The existing `hub.test.ts` trustProxy test passes unchanged.
- Known trade-off (documented): someone who can reach the login endpoint can make the owner's *new* sign-ins answer 429
  for up to 15 minutes by failing 20 times; existing sessions are not affected.
- **Superseded by the security review S3:** the hard limit is now per (sign-in name, client address): 20 failures in 15
  minutes refuse only that address for that name. Past 20 failures for a name from all addresses together, every attempt
  for it waits 1 s, doubling per failure up to 10 s, before any password work, and at most 4 such attempts per name run at
  once (more answer 429). The right password from another address therefore still signs in, a few seconds later. Tests:
  `auth.test.ts` `S3: …`.

### SEC-3 → E46 — Funnel not detected (fixed; wizard copy is G4's)
- `tailscale.ts` `funnelExposure()`: any `AllowFunnel` host:port (top level or Foreground) whose web handler proxies to the
  hub port or whose TCP forward reaches it. `parseServeStatus` adds `funnel: true, funnel_host_port` (sparse); `serve_ok`
  keeps its §2.7 meaning. `TAILSCALE_TEXT.funnelOn()`: for 443 the fix is re-running `tailscale serve --bg --https=443 …`
  (Tailscale docs: the last command for a port decides serve vs funnel; `funnel … off` would remove the hub's serve too);
  for 8443/10000 `tailscale funnel --https=<port> off`. Checked with Exa (tailscale.com/docs/reference/tailscale-cli/funnel
  and the Funnel feature page).
- Surfaced in: the monitor snapshot (`funnel_on`, `funnel_warning`, logged once per change), `/api/v1/hub/info`
  `tailscale.funnel_on: boolean|null` and `tailscale.funnel_warning: string|null` (additive), `hub:doctor` (`[錯誤]`),
  `hub:service status`, `hub:init` (a funnel left on another port).
- Tests: `tailscale.test.ts` `SEC-3 (E46): …`, `hub.test.ts` hub/info (deepEqual updated for the two new fields — the
  field addition itself), doctor test.

## Deviations from E34–E46 (and why)
- E45 「保留 7 份」: 7 daily copies; pre-update copies are kept apart (3), so updates never push daily copies out.
- E46 「健康檢查…要警告」: `serve_ok` keeps its §2.7 definition (443 → hub); Funnel is a separate `funnel_on` field plus
  doctor `[錯誤]`, so the wizard does not show the "serve is down" text for a working, but public, hub.
- E45 rollback also restores the data copy only when the new code changed the data and the new process is confirmed gone;
  otherwise the data file is left alone and the message says how to restore by hand.

## Handoffs
- **G4 (web wizard, `apps/web/src/view/pages/setup-hub.tsx`, `apps/web/src/view/data/hub-types.ts`):** add
  `funnel_on?: boolean | null; funnel_warning?: string | null` to `HubInfo['tailscale']` and, when
  `info.tailscale?.funnel_on === true`, show a warning callout (`hub-callout warn`) with `info.tailscale.funnel_warning`
  (zh-Hant, already contains the command). Suggested title copy: 「中樞被公開到網際網路」.
- **Lead / design doc (`docs/restructure/phase1-design.md`):** §2.5 step 6 — `--check --load` (loads modules, decodes a data
  copy); §2.8 Windows — action is `hub.ts --supervise`, RestartOnFailure kept only for launch failures; §2.13 hub:update —
  steps 0–6 and the rollback above; §5.9 table — `machine_setup` 「警告第一次出現、內容改變或消失一小時後再出現時」 (E43);
  Appendix B.3 — `hub_alerts_get_channels` masks the Bark key / ntfy topic for Agent credentials (E46).
- **S10 / lead (optional, not in E43):** `machine_setup` as a switchable alert preference would need
  `AlertPreferences` in `packages/contracts/src/phase1.ts` and the web settings page.

## Tests run
- `node scripts/test.mjs apps/server/src/modules/alerts/ apps/server/src/hub/ scripts/hub-service apps/server/src/auth.test apps/server/src/modules/worker/ apps/server/src/core.test apps/server/src/local-invitation` — 182 pass, 0 fail.
- `node scripts/test.mjs apps/server/src/modules/workspace apps/server/src/integration apps/server/src/modules/posting apps/server/src/modules/account` — 198 pass (9 skipped, Postgres), vitest 22 pass.
- `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome node scripts/test.mjs tests/e2e-phase1/cancel.test.ts` (E2E-8, E2E-8b, E2E-10 with the AO-6 change) — 4 pass.
- `NODE_OPTIONS=--max-old-space-size=6144 pnpm typecheck` — clean.
