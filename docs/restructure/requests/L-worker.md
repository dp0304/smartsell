# L-worker (Worker-side integration): requests to other streams

L-worker owns `apps/connector-desktop/**`, `apps/connector/**`, `tests/connector-desktop/**`, `tests/fixtures/platforms/**`,
`packages/agent-relay/**` and `scripts/worker-release.mjs` in the integration wave. Item-by-item closure of the wave 1–2
ledgers is in `closure-L-worker.md`. Everything below is a change in a file L-worker does not own, or a contract other
streams now code against.

## L-server

Status at the end of this wave: items 1–3 have landed in the tree from L-server concurrently (`host-cache.ts#workerPlatformFor`
/ `latestWorker(device, arch)` with `device.arch` stored from the heartbeat; `agent-connections.ts#selfRevoke` answering
204 / 401 `UNAUTHENTICATED`; `host-cache.ts#readBundledClip` reading `test-clip.json`). The Worker-side code matches them.
Items 4–6 remain open.

1. **E9, hub side (`apps/server/src/modules/worker/host-cache.ts#latestWorker`, `device-jobs.ts#heartbeatV2`).** Every
   heartbeat v2 from the Worker now carries `arch: 'arm64' | 'x64'` (from `process.arch`; omitted on any other CPU).
   Please keep the last value per device (presence or `connector_device`, like `client_version`) and pick
   `mac-arm64` / `mac-x64` by it; without `arch`, macOS keeps the current default (arm64). Until then the App keeps
   ignoring an offer for another package (`UpdateManager.platformKey`), so an Intel Mac is never offered the arm64 build;
   that guard stays after E9 as protection against a hub without it (installing a package the CPU cannot run would
   replace a working App).
2. **E13 endpoint (`apps/server/src/integration/agent-connections.ts`).** The laptop App calls
   `DELETE /api/v1/agent-connections/self` with `Authorization: Bearer <the previous connection's own token>`, after the
   new connection is redeemed and written. The App reads: 2xx → revoked; 401 → the token is already revoked/expired
   (`previous_status: 'already_invalid'`); 404 (endpoint missing) or anything else → not revoked, and the App tells the
   owner to revoke it on the web. Please answer 204 (or 200) on success and 401 `UNAUTHENTICATED` for an unknown,
   revoked or expired token; only that connection may be revoked.
3. **Dry-run payload media (`apps/server/src/bootstrap.ts#bundledClip`, `modules/worker/dispatch.ts`).** The hub already
   hashes `resources/test-clip.mp4` itself, so `sha256`/`bytes` are real (S9 ledger item 3 is satisfied for the hash).
   Optional: fill `width: 720, height: 1280, duration_ms: 4000` from `apps/connector-desktop/resources/test-clip.json`
   instead of `null` (the TikTok driver uses `duration_ms` for the "Reuse of content > 60 s" rule; `null` counts as short,
   which is right for this 4 s clip, so nothing breaks today).
4. **Root scripts still naming the old App (S9 ledger item 10).** `scripts/package-worker-download.mjs`,
   `scripts/verify-desktop-package.mjs` and the root `package.json` script `package:worker-download` build or expect
   `SmartSell Connector.app` through `--local-dir`. The product is `SmartSell Worker` and `pnpm worker:release` replaces
   them: please retire them or point them at `worker:release`. (`tests/connector-desktop/package-smoke.mjs`, which L-worker
   owns, is updated: `SmartSell Worker.app`, `--unsigned` skips the Developer ID check.)
5. **Job-scoped 403s (FYI).** The Worker treats any 403 on a signed request as "device revoked" (§8.2) except
   `MEDIA_FORBIDDEN` (`media.read` of a job that ended, moved or does not list the file), which is now handled as a
   job-level refusal (the job waits as `media_unavailable`) instead of stopping the connection. A new job-scoped 403 code
   would need the same treatment; 404/409 need nothing.
6. **Selector data file 2026.11.2 (FYI for `pnpm hub:update`).** `apps/connector-desktop/src/drivers/selectors.json` is now
   version `2026.11.2`: new required step `tt.legacy_frame` (the older TikTok iframe layout), the frame fallbacks were moved
   out of `tt.ready` / `tt.file_input`, and `tt.popup_buttons` gained a role fallback for TikTok's shadow-DOM cookie banner.
   Workers on 2026.11.1 accept the new file (extra steps are allowed). No hub change needed.

## S7 (web)

7. `apps/web/src/agent-connect.tsx`: the `connection=<id>` fragment parameter (S9 ledger item 7) is no longer needed to revoke
   the previous connection (E13 uses the old token itself). The App still stores it in `config.json` when present.

## S8 (E2E and contract tests)

8. New fixture scenarios (additive to §8.15): X `grok_overlay` (a side panel covers the composer until Escape),
   `challenge_after_post` (an Arkose frame instead of a result after Post); TikTok `cookie_banner` (custom element with an
   open shadow root; the driver declines optional cookies), `legacy_iframe` (form inside
   `iframe[data-tt="Upload_index_iframe"]`; the driver stops with `driver_outdated` step `tt.ready` before uploading),
   `challenge_after_post`. TikTok `FixturePost.options` also records `brand`, `branded`, `ai_generated`. Fixture X pages
   record a `post_clicked` event per click.
9. A captcha, verification, sign-in wall or risk prompt seen **after** the Post click is now reported as
   `blocked{<code>, after_submit}` (a fact: the hub makes it `outcome_unknown`), not left to read-back.

## Lead (design text)

10. Decisions taken in code, listed as deviations in `closure-L-worker.md`: the TikTok legacy iframe stops early as
    `driver_outdated`; upload timeouts are `driver_outdated` (§8.11) unless X reported processing; post-click blockers
    stop as after-submit facts; the Intel-Mac update guard stays after E9; `nativeVirtualKeyCode` is no longer sent with
    CDP key events (it carried Windows key codes, which on macOS name other keys and stalled the next mouse event 5 s).
