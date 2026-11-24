# S9 review of S6's C11 additions (`apps/connector-desktop/src/runtime/events.ts`)

Required by §11.1 ("S6 對 `runtime/events.ts`（C11）的變更必須由 S9 審查") and Appendix E6. Reviewed against the code S9 wrote on top of it (`src/app/worker-mode.ts`, `src/app/power.ts`, `src/app/update.ts`, `src/app/tray.ts`, `ui/renderer.js`) and its tests (`tests/connector-desktop/app/*.test.ts`).

**Verdict: approved.** Both additive events are used by the App shell as they are; nothing in the frozen five changed shape.

## Frozen C11 events (unchanged)

| Event | How the shell uses it | Notes |
|---|---|---|
| `jobs_held` | `PowerGuard.onJobsHeld` holds `prevent-app-suspension` while `publish_jobs > 0` | `emitJobsHeld` de-duplicates by value, so the blocker is not toggled on every tick. Good. |
| `local_alert` | OS notification; `owner_click` is normal urgency, `blocker`/`missed` urgent; click opens `web_url` (https/loopback only) | Body text is the Appendix C copy from the runner. Good. |
| `hub_unreachable` | One OS notification per outage (key = `since`) with the §5.9 sentence 「中樞 10 分鐘連不上，{machine} 有 N 則貼文待發；到點會依離線規則照發」 | The supervisor already emits once per outage; the key is a second guard. |
| `vault_locked` | Emitted **by the shell** on the shared bus when `vault.ts` throws `VaultLockedError` (no identity → no runtime yet); the shell notifies and the tray turns red | The runtime never emits it itself, which is correct: it cannot exist without the key. |
| `update_available` | `UpdateManager.offer()` (newer-than-running check, badge, one notification per version) | The payload has no `platform`; the shell derives it from the URL's last path segment (`/api/v1/worker-downloads/<platform>`) for the signed action `worker_download.read:<platform>`. Acceptable for Phase 1; see suggestion 3. |

## Additive events (E6)

### `connection` — approved

`{ state, next_retry_at, last_success_at, clock_offset_ms, clock_warning, message }` gives everything §8.17 item 1 needs (online/offline, reconnect countdown, clock skew) without polling, and `device_revoked` lets the shell raise the §8.2 notification 「此機器已在中樞被撤銷或停用」.

- `state: 'device_revoked'` is also used for `DEVICE_PROOF_EXPIRED` after the clock-corrected retry; `message` then explains the clock. The shell shows `message` verbatim, so the owner sees the right reason. Fine.
- Emitted on every successful heartbeat (15 s). The shell throttles UI pushes to 150 ms, so this is cheap.

### `jobs_changed` — approved

`{ jobs: LocalJobView[] }` is what the 「任務」 list renders (time, channel label, state, countdown, blocker message).

- `LocalJobView` has no `social_account_id` / `profile_key`; the shell reads them from `runtime.store.get(job_id).claimed.payload.channel` to wire 「開啟該 Chrome 處理」. Works, but see suggestion 1.

## Non-blocking suggestions (for whoever owns `runtime/**` in the integration wave, S3 in wave 2)

1. Add `social_account_id` and `profile_key` to `LocalJobView` (additive) so the shell does not need to reach into the store.
2. `RuntimeEventBus.off(event)` removes every listener of that event; the shell never calls it. If anything else needs to unsubscribe, return a disposer from `on()` instead.
3. If C11 is ever reopened: add `platform` to `update_available` (it is in heartbeat `latest_worker`), so the signed download action does not depend on the URL shape.
