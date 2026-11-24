# Closure: L-worker (Worker-side integration)

Scope: every Worker-side item of the wave 1–2 ledgers (`S1.md`, `S2.md`, `S3.md`, `S4.md`, `S5.md`, `S6.md`, `S9.md`,
`S9-review-of-C11.md`, `S10.md`) and the integration-wave decisions E9, E11, E12, E13, E16. Requests that L-worker
cannot close in its own files are in `L-worker.md`. Status: **done**, **rejected** (with reason) or
**deferred-to-phase-2** (with reason). Test counts are at the end.

## Integration-wave items

| Item | Status | What changed |
|---|---|---|
| `runtime/contracts.ts` → `export * from '@smartsell/contracts'` (S6 #9, S9 req 1) | done | The by-path re-export is gone; the workspace link `apps/connector-desktop/node_modules/@smartsell/contracts` resolves for tsx, tsc and esbuild (the packaged build and `--smoke` pass). |
| `Profiles.close(profileKey)` for profile-key adoption on re-registration (S9 req 2, S2 #11) | done | `runtime/profiles.ts`: `close()` refuses while a driver holds the profile, closes that Chrome, **waits for the process to exit** (`BrowserHandle.exited`), removes `.smartsell.lock` and drops the slot. `app/worker-mode.ts#adoptProfileKey` is now async, awaits it before renaming the folder, and tells the owner when the rename could not happen. The "restart the App once" fallback is gone. |
| `LocalJobView` gains `social_account_id`, `profile_key` (S9 req 5, C11 review 1) | done | `runtime/events.ts`, `job-runner.ts#views()`; the shell no longer reads the job store for 「開啟該 Chrome 處理」. |
| C11 review suggestion 2 (`off` removes every listener) | done | `on()` returns a disposer that removes only that listener (C11 callers may ignore the return value); `off()` kept. |
| C11 review suggestion 3 (`update_available.platform`) | done | Optional `platform` from heartbeat `latest_worker.platform`; `UpdateManager` passes it to the signed download (`worker_download.read:<platform>`), falling back to the URL segment. |
| E9: send `arch` in heartbeat v2 | done | `Supervisor` adds `arch: 'arm64' | 'x64'` from `process.arch` (omitted on other CPUs); `createWorkerRuntime({ arch })` can override; `--smoke` reports it. Hub side landed concurrently from L-server (`host-cache.ts#workerPlatformFor`: heartbeat `arch`, else the stored one, else arm64). |
| E9: drop S9's `platformKey` filter once the hub picks by arch | rejected | Kept as a guard, re-documented: hubs and Workers update independently, and a hub without E9 offers mac-arm64 to every Mac; installing it on an Intel Mac would replace a working App with one that cannot start. With an E9 hub the guard never triggers. |
| E12: back up `~/.codex/config.toml` before writing the marked block | done | `app/agent-connect.ts#writeCodexConfig`: an existing file is copied to `config.toml.smartsell-backup-<YYYYMMDDTHHMMSSZ>` (a `-N` suffix within the same second, 0600, `wx`), the rewrite keeps the file's mode and its line endings, nothing is written when the block is unchanged. `upsertCodexConfig` also removes inline (`smartsell = {…}`) and dotted (`smartsell.x =`, root `mcp_servers.smartsell.x =`) definitions so the server is never defined twice; every other table stays byte for byte. Tested with a temp HOME. The UI shows the backup path. |
| E13: revoke the previous connection with `DELETE /api/v1/agent-connections/self` and the OLD token | done | `revokePreviousConnection()`; called only after the new token and config are written and the client is configured. 2xx → `revoked`; 401 → `already_invalid`; 404 (hub without the endpoint), 5xx or a network error → `not_revoked` (logged, the UI tells the owner to revoke on the web). `ConnectResult` adds `previous_status`, `codex_backup`. L-server's endpoint (`agent-connections.ts#selfRevoke`, landed concurrently) answers exactly 204 / 401 `UNAUTHENTICATED`, which is what the client maps. |
| `configureWorkerHost` bundled clip metadata (S3 ledger, S9 req 3) | done (hub side, L-server) | Checked: the hub hashed `resources/test-clip.mp4` itself (real SHA-256 and size); L-server has since switched it to `host-cache.ts#readBundledClip`, which reads `test-clip.json` as well. Worker side needs nothing: the media cache serves the bundled clip without a download. |
| Device-protocol mismatches between `src/runtime` and S3's hub | done | Checked S6 ledger #1–#7 against `modules/worker/{device-jobs,device-http,media,host-cache}.ts` and `account/http.ts`: `SEQ_GAP.expected` in the envelope, 409 `JOB_FENCE_LOST` for a stale media fence, `jobs[]` only lists held non-terminal jobs, raw driver-config bytes hashed as advertised, evidence 2xx, unknown heartbeat fields ignored (so `arch` is safe), `channels.register` returns `profile_key`. One mismatch fixed: 403 `MEDIA_FORBIDDEN` (media of an ended/moved job) was classified as "device revoked"; it is now a job-level refusal. `apps/server/src/modules/worker/loop.test.ts` (real runtime + fixtures + hub) passes. |
| E11 (Worker UI zh-Hant) | done (S9) | New owner copy added here is zh-Hant. |
| E16 (pinned Electron for releases) | done | The verification build below used the cached 45.3.3 zip with `--allow-electron-version` (allowed for local verification only); no Electron or other binary was downloaded. |

## Driver review against `platform-drivers-research.md`

| Rule | Status | Finding / change |
|---|---|---|
| Never auto-retry a post | done (verified) | One `click()` after `onBeforeClick()`; any outcome after it is a fact (`submitted` → read-back only, `blocked{after_submit}` → done). TikTok "Post now" is the same publish (at most once). Covered by fixture `post_error_not_created`, `challenge_after_post`, runner tests. |
| TikTok code 7 / "Something went wrong" → stop, owner clicks Post | done (fixed) | The after-submit blocker now says the video is uploaded and asks the owner to click Post in that machine's TikTok Studio window or confirm nothing went out (platform message included). The runner **pins that Chrome** so the idle close does not destroy the uploaded draft; a pin ends when the next job leases the profile. |
| X media before text; line-by-line insert with read-back | done (verified, one fix) | Order and the single End/Space/Backspace correction match §8.8. Fix: CDP key events sent `nativeVirtualKeyCode` = Windows key codes, which on macOS name other keys (27 = "-", 13 = "W") and stalled the next mouse event for 5 s after every Escape; dropped (as Puppeteer does). |
| captcha / 2FA / login / risk → stop and hand to the owner | done (fixed) | Before the click this held. **After** the click a captcha or sign-in wall was not detected (the driver returned `submitted` and read-back navigated away). X `#confirmation` and TikTok `#successSeen` now run blocker detection and return `blocked{code, after_submit}` (hub: `outcome_unknown`), with zh-Hant copy that never promises an automatic continuation. X also checks blockers while waiting for media processing. |
| Read-only observation while waiting | done (verified) | `observeUntilCleared` only reads; fixture tests assert unchanged page-load counts (captcha, login, `challenge_after_post`). New: 「開啟該 Chrome 處理」 brings the observed tab to the front without the driver lock (it used to wait for the lock, i.e. until the observation ended), and `Profiles.acquire` honours its abort signal while queued. |
| X Grok/overlay → Escape once, then x.ready again (§8.8 step 2) | done (fixed + fixture) | Escape was only tried at the textbox, after media was attached, where Escape opens X's discard sheet. Now step 2 runs at x.ready (before media); the textbox fallback stops if Escape opened the discard sheet. Fixture `grok_overlay`. |
| TikTok cookie banner → essential cookies only | done (fixed + fixture) | The banner is a custom element with a shadow root; the CSS fallback could not reach its buttons. Added a role fallback (`Decline optional cookies`); fixture `cookie_banner` asserts "Allow all" is never pressed. |
| TikTok legacy upload iframe | done (deviation) | Fixture `legacy_iframe`. The layout is recognised (`tt.legacy_frame`, trace `fallback`) and the driver stops with `driver_outdated` step `tt.ready` **before** uploading: the rest of that form (upload state, caption, privacy, Post) cannot be read or operated inside the frame (no frame-scoped selectors; CDP calls run in the main frame's isolated world). Before, the video would have been uploaded into the frame and the job would time out at `tt.uploaded`. |
| Disclosure / AI-label toggles | done (fixture) | New fixture test: Show more → "Disclose post content" on, "Your brand" on, "Branded content" off, AI switch confirmed with Turn on; privacy, comments and reuse read back. |
| Upload timeout classification (§8.11) | done (fixed) | A timeout without any signal was `failed{upload_rejected}` ("the platform rejected this video"). Now `driver_outdated` (`x.upload_done` / `tt.uploaded`, owner can resume), except when X reported processing that never finished (still `upload_rejected`). |

## Ledger items routed to the Worker

| Source | Item | Status |
|---|---|---|
| S1 「給 S6」#1 | `selectors.json` stays at `apps/connector-desktop/src/drivers/`, JSON with top-level `version` | done (now `2026.11.2`) |
| S1 「給 S9」#1–#2 | `worker:release` command and `latest-<platform>.json` keys | done (S9); re-checked with the rebuilt package |
| S2 #11 | adopt the hub's `profile_key` | done (Profiles.close + awaited adoption) |
| S3 #13, #17 | Mac CPU for `latest_worker` | done (E9 `arch`; hub selection landed from L-server) |
| S4 #9 | App revokes the previous connection | done (E13 client; L-server's endpoint landed) |
| S5 #13 | `payload.media[].file_id` null while uploading | done (verified: `MediaUnavailable` until a `file_id` arrives) |
| S5 #16–#18 | relay mode, upload hand-off, Windows Node relay | done (S9); `app/*` tests pass |
| S6 #1–#7 | hub device endpoints | done (verified, see protocol row) |
| S6 #8 | `channels.register` selection fields | done (verified in `channel-registration.ts`) |
| S6 #9 | contracts dependency | done |
| S6 #10–#12 | RELEASE.packaged, createWorkerRuntime, C11 review | done (S9); smoke reports `RELEASE.packaged=true` |
| S6 #13–#14 | fixtures and headless runner for S8 | done; five additive scenarios (`L-worker.md` #8) |
| S6 untested branches | legacy iframe, cookie banner, Grok Escape, disclosure/AI | done (fixture tests) |
| S9 req 1–5 | to S3 (runtime owner) | done (1, 2, 5 here; 3 and the hub half of 4 by L-server) |
| S9 req 6 | S4 self-revoke | done (E13 client) |
| S9 req 7–8 | S7 agent-connect page | 7 superseded by E13 (the connection id is not needed to revoke); 8 unchanged — S7's |
| S9 req 9 | `docs/hub-setup.md` Windows section | routed — not a Worker file (docs owned by S1/L-server) |
| S9 req 10 | old-bundle scripts | done for `tests/connector-desktop/package-smoke.mjs` (`SmartSell Worker.app`, `--unsigned`); root scripts routed (`L-worker.md` #4) |
| S9 req 11 | headless `--smoke` | done; re-run on the rebuilt package |
| S9 lead 12–14 | arch, UI language, Codex config | done by E9 / E11 / E12 |
| S9-review-of-C11 1–3 | LocalJobView, disposer, update platform | done |
| S10 #16 | alert stream subscription | done (S9) |

## Deferred to phase 2

| Item | Reason |
|---|---|
| Operating the TikTok form inside the legacy iframe | Needs per-frame isolated worlds in `CdpPage` and frame-scoped selectors for every upload-page step; TikTok removed that layout (research §TikTok 1). Phase 1 stops safely with `driver_outdated`. |
| Windows build, install and reboot verification (M1) | Needs a physical Windows machine (§8.18); not available here. |

## Verification (this wave, on this Mac)

| Command | Result |
|---|---|
| `NODE_OPTIONS=--max-old-space-size=4096 pnpm typecheck` | 0 errors |
| `node scripts/test.mjs tests/connector-desktop` | 223 pass, 0 fail, 0 skipped (baseline 209; real headless Chrome against the fixture platforms) |
| `node scripts/test.mjs packages/agent-relay apps/connector/ apps/server/src/modules/worker/loop.test.ts` | node 23 pass, 0 fail, 1 skipped (E2E-11 1 GB scale, needs `SMARTSELL_TEST_LARGE=1`); vitest 31 pass |
| `node --import tsx scripts/worker-release.mjs --arch arm64 --out <scratchpad>/release --electron-zip-dir ~/Library/Caches/electron/<hash> --electron-version 45.3.3 --allow-electron-version` | unsigned `SmartSell-Worker-0.2.0-mac-arm64.dmg` (120,732,893 bytes) + `.zip`, `latest-mac-arm64.json` with the six keys; verification build only (cached 45.3.3, not the pinned 45.4.1, per E16) |
| `"SmartSell Worker.app/Contents/MacOS/SmartSell Worker" --smoke --smartsell-user-data=<tmp> --smoke-out=<tmp>/report.json` | exit 0, `ok: true`: 13 checks incl. `RELEASE.packaged=true`, test switches refused, test clip hash, relay bundle, selectors `2026.11.2`, heartbeat `arch=arm64` |
| `"SmartSell Worker" --mcp-relay --version` | `0.1.0` |
