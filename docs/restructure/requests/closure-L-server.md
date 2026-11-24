# Closure: L-server (server-side integration)

Every ledger item routed to Lead, S1, S2, S3, S4, S5 or S10 that is server-side, with its outcome. "Verified" means the item was
already implemented by its stream and L-server checked the code and its tests; "done" means L-server implemented it in this wave.
Requests L-server makes of others: `L-server.md`.

## Task items

| Item | Outcome |
|---|---|
| Appendix C codes from S3, S4, S5 (+ S2, S10, E13, E14) with zh-Hant owner copy | **done** — design doc Appendix C.3 (errors) and C.4 (`posts[].warnings`), C.2 `handle_changed` event copy |
| E9 `latest_worker` by heartbeat `arch` | **done** — `worker/host-cache.ts` `workerPlatformFor`, `device-jobs.ts` stores `connector_device.arch` on change; test in `device-jobs.test.ts` |
| E10 `handle_changed` alerts | **done** — copy (`alerts/copy.ts`), `alertHandleChanged` (`alerts/triggers.ts`, exported), called from `worker/device-jobs.ts` `noteHandle` and `worker/index.ts` `confirmResult`; test in `device-jobs.test.ts` |
| E12 | **skipped** — Worker-side (L-worker), as instructed |
| E13 `DELETE /api/v1/agent-connections/self` | **done** — strictly the token's own connection, audited (`agent_connection_self_revoke`, actor_type agent); the App's per-id path with Bearer is accepted only for the same connection; test in `agent-connections.test.ts` |
| E14 guard `execution/ops.ts` manual ops | **done** — 409 `WORKER_ROUTE_TASK` for run_now, retry, reconcile, late_decision, handover, manual_start/complete/abandon/bundle, batches and `posts_register_manual` with a Worker post; cancel stays; test `execution/worker-guard.test.ts` |
| S4 ledger 7 / S10: `app.close()` waits ~70 s after a cancelled alert stream | **done** — reproduced (70 002 ms), root cause: undici opens a spare socket after the cancel that never sends a request, which Node counts as a request in progress until `headersTimeout`. `buildApp` now destroys never-used sockets in `preClose`; close takes 0 ms; test `hub/shutdown.test.ts` |
| Verify S3.md items 1–5 in posting | **verified** — 1 `createCheckLoginJob` in `posting/check.ts` and the 12 h check in `posting/schedule.ts`; 2 `cancel_requested` → `cancelling` through `derivePostStatus`; 3 `when='now'` writes now + 30 s, which gives the same `not_before` as S3's rule; 4 `applyChannelDefaults` runs before `submit()`; 5 `hub_posts_retry` uses `updateTarget(..., { scheduled_at: now })` + `resubmitIfWaiting`. Added `posting/worker-cancel.test.ts` (real job engine: claimed → `cancelling` → `cancelled`) |
| Remove the `MEDIA_DIRECTORY` bridge in `hub/startup.ts` | **done** — S5 reads `config.mediaDirectory`; the only `mediaStorageFromEnv` caller (`modules/files/index.ts`) is not loaded by any registry; `hub.test.ts` audit entry removed and the start test now asserts `config.mediaDirectory` and no env bridge |
| `docs/hub-setup.md`: Win-C NSIS build + unsigned install, relay bundle | **done** — §4a (S9 item 9 text, E16 note, failure table), §4b (relay bundle, `RELAY_BUNDLE_MISSING`, curl check, E13 note), steps in §2 and §6, developer notes |
| Retire `package:worker-download` / `verify-desktop-package` Connector path | **done** — root script and `scripts/package-worker-download.mjs` removed; `scripts/verify-desktop-package.mjs` kept (CI uses it) and now reads `PRODUCT_NAME` (SmartSell Worker); CI codesign path renamed; README section points at `pnpm worker:release` |
| S1 lead: `traffic/landing.ts`, `customer-egress.ts`, `agent-model-runtime.ts` NODE_ENV reads | **done** — new `apps/server/src/production.ts` `productionSemantics(env)` (same rule as `config.production`, used by `config.ts` too); the three files no longer read `NODE_ENV`; `hub.test.ts` audit list updated and asserts `productionSemantics` equals `config.production` |
| Wire S7's web-url builder into configurePosting/configureAlerts | **done** — bootstrap calls `installWebLinks({ publicOrigin: config.origin })` (S7's `views/install.ts`: posting `webUrl`, alerts `webUrl` + `machineWarnings`) |
| Playwright with installed Chrome | **done** — `scripts/playwright-browser.mjs` (+ `.d.mts`, unit test) used by both configs; no browser downloaded. Run with Chrome 158 (channel `chrome`): apps/web/test 4 passed / 2 failed, tests/web-e2e 85 passed / 20 failed / 3 skipped; all 22 failures are assertions on the pre-phase-1 UI that S7 replaced (get-started steps, Overview heading, Main agent region, audit list) — routed to S7 (`L-server.md` 1) |
| Whole suite | node 1183 tests: 1147 pass / 0 fail / 36 skipped (baseline 1110 pass); vitest 162 pass; Playwright as above. `pnpm typecheck` clean |

## S1.md

| # | Item | Outcome |
|---|---|---|
| S5-1 | `mediaStorageFromConfig(config)` | **verified** (S5) — bridge removed by L-server |
| S5-2 | `config.maxUploadBytes` | **verified** — `media-host.ts` `maxBytes: config.maxUploadBytes` |
| S5-3 | `PUT` octet-stream parts | **verified** — `hub.test.ts` |
| S3-1 | `provideWorkerDownloadDeviceAuth` | **verified** — `worker/device-http.ts` |
| S3-2 | `latest_worker` from `workerReleases` | **verified**, extended by E9 |
| S3-3 | driver-config explicit error | **verified** — 404 `DRIVER_CONFIG_NOT_FOUND` |
| S3-4 | NonceStore by `config.hub` | **verified** — `bootstrap.ts` `configureDeviceNonces` |
| S3-5 | evidence `PUT` passes the guard | **verified** — `hub.test.ts` |
| Lead-1 | `landing.ts` NODE_ENV | **done** (productionSemantics) |
| Lead-2 | `customer-egress.ts`, `agent-model-runtime.ts` NODE_ENV | **done** (productionSemantics) |
| Lead-3 | `kernel.test.ts` fails on `worker` | **verified** — passes now (5 pass, 2 skipped) |

## S2.md and S2-changes-for-S3-review.md

| # | Item | Outcome |
|---|---|---|
| 1–5 | S3 hooks, Worker `ensureTask`, `ctx.presence`, shared helpers, review | **verified** — S3 installed the hooks (`worker/engine.ts`), routes Worker tasks, injects presence; review in `S3-review-of-S2.md` |
| 6–7 | S4 calls into S2, precheck keys | **verified** — posting uses `ensureChannelSettings`, `applyChannelDefaults`, single `submit()`, `channelMediaRule`; keys mapped to warnings (Appendix C.4) |
| 13 | `ProviderKey` lacks `x` | **rejected (no change)** — adding `x` to `ProviderKey` would make `createAdapters` build an API adapter for X; S2's `ProviderKey \| 'x'` in the catalog is the right scope for phase 1 |
| 14 | `kernel.test.ts` | **verified** passing |
| review points 1–3 | `revokeForTarget` safety, Worker route in `ensureTask`, direct → needs_approval on a running job | **verified** — fixed by S3 (`S3-review-of-S2.md` 1, 3, 4) |

## S3.md and S3-review-of-S2.md

| # | Item | Outcome |
|---|---|---|
| 1–5 | S4: check_login, cancelling, `when='now'`, defaults before submit, retry path | **verified** (see task table) |
| 14 | S10 wiring | **verified** |
| 15 | `handle_changed` alert kind | **done** (E10) |
| 16 | Appendix C codes | **done** (C.3) |
| 17 | heartbeat CPU architecture | **done** (E9) |
| 18 | `execution/ops.ts` guard | **done** (E14) |
| 19 | `hub/startup.ts` bridge | **done** (removed) |
| 8 (to S7) | `derivePostStatus` after force_release of an unreported job | **deferred** — needs an Appendix A (frozen) amendment or a view-side rule; routed to S7 / lead in `L-server.md` 2 |
| review "left for the lead" | `channelDayUsage` (precheck) vs go check 7 counting | **rejected (no change)** — different by design (§4.4 schedule-time estimate vs §5.4.4 execution count) |
| review "left for the lead" | `execution/ops.ts` | **done** (E14) |

## S4.md

| # | Item | Outcome |
|---|---|---|
| 1–3 | S3: check_login reuse, records the Agent reads, Problem shapes | **verified** — `dispatch.ts` reuses an open check; Problems carry `status`/`code` |
| 4 | `hub.test.ts` audit fails on `worker/model.ts` | **verified** — no longer reads `NODE_ENV`; audit passes |
| 6 | `webUrl` registration | **done** (bootstrap → S7 `installWebLinks`) |
| 7 | alert stream teardown | **done** (shutdown fix) |
| 8 | stream `subscribe` | **deferred-to-phase-2** — the `Store` interface has no change feed; adding one touches the memory, local and Postgres stores. The 1 s poll keeps alerts within one second, inside §5.9's needs |
| 9 | self-revoke for the App | **done** (E13) |
| 12 | codes and warnings not in Appendix C | **done** (C.3, C.4) |
| 13 | additive output fields | **deferred to lead** — §7.2 is not L-server's section; listed in `L-server.md` 4 |

## S5.md

| # | Item | Outcome |
|---|---|---|
| 1–5 | S4: mount uploads, principal rules, `RELAY_REQUIRED`, output schema, `PATH_NOT_ABSOLUTE` text | **verified** — `command-mcp.ts` mounts `registerAgentUploads` and the alert stream; `mcp-hub-tools.ts` answers `RELAY_REQUIRED` with install steps |
| 6 | relay bundle in hub:init/update/install | **verified** (S9 under E8) and documented (hub-setup §4b) |
| 7 | bridge and audit entry | **done** |
| 8 | `files.cleanup` schedule | **verified** — `bootstrap.ts` schedules `media.schedule` |
| 9–10 | upload states, `meta=null` | **verified** (S2 precheck; E3) |
| 11 | `revisions.ts` skips `agent_upload` versions | **verified** — `content/revisions.ts:260` |
| 12–14 | S3 device download, `media_pending`, parser scope | **verified** — `worker/device-http.ts` uses `parseByteRange` + `openMediaRange`; `media.upload.ready` subscriber |
| 19 | `alertUploadFailed` | **verified** |
| 20 | Appendix C codes | **done** (C.3) |
| 21 | ffprobe-unreadable → ready | **done** — decided as E3, documented in C.3 |

## S6.md (server-side items)

| # | Item | Outcome |
|---|---|---|
| 1–7 | SEQ_GAP `expected`, media fence 409, heartbeat `jobs[]`, driver-config bytes, `Date` on 401, evidence 4xx, per-fence seq | **verified** — `device-jobs.ts`, `media.ts`, `host-cache.ts`; covered by `device-jobs.test.ts`, `device-http.test.ts` |
| 8 | registration selections | **verified** (S2 tests) |

## S9.md (server-side items)

| # | Item | Outcome |
|---|---|---|
| 3 | dry-run media from `test-clip.json` | **done** — `worker/host-cache.ts` `readBundledClip` (manifest hash, size, width, height, duration; falls back to hashing the mp4); dispatch fills the dimensions; test in `lifecycle.test.ts` |
| 4, Lead-12 | Intel Macs never offered updates | **done** (E9) |
| 6 | Bearer self-revoke | **done** (E13, both paths) |
| 9 | hub-setup Windows section | **done** |
| 10 | retire `package:worker-download` | **done** |
| Lead-13, Lead-14 | UI language, Codex config | **no server action** (E11, E12 decided; Worker-side) |
| 1, 2, 5 | `runtime/**` changes | **not L-server** (L-worker owns `apps/connector-desktop/**`) |

## S10.md

| # | Item | Outcome |
|---|---|---|
| 1–2 | alerts drain, `configureAlerts({ secretKey, publicOrigin })` | **verified** (bootstrap) |
| 3 | mount the alert stream | **verified**; `subscribe` deferred (see S4 8) |
| 4–8 | S3 status events, missed reasons, successor, stale settings | **verified** (S3) |
| 9–10 | S5 upload alerts | **verified** |
| 11 | `configureAlerts({ effectiveMode })` | **done** — bootstrap |
| 12 | approval request fields | **verified** — alerts reminder tests pass |
| 13 | `webUrl`, `machineWarnings` from S7 | **done** — bootstrap → `installWebLinks` |
