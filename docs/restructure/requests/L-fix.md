# L-fix (wave 4: lead decisions E21, E26): requests to other streams

L-fix owns `apps/server/src/modules/posting/check.ts`, the `hub_channels_check` body in `posting/schemas.ts`,
`apps/web/src/view/pages/{ChannelPage,TodayPage}.tsx`, `scripts/package-worker-download.mjs`, the root `package.json` scripts
block, their tests and this file. Everything below is a change in a file L-fix does not own.

## What L-fix provides (E21 「重新登入」)

- **`POST /api/v1/workspaces/:ws/hub/channels/:id/check`** (`hub_channels_check`) accepts an optional body
  `{ open_login_window?: boolean }` (strict: any other field is 422 `INVALID_ARGUMENTS`).
  - **People only.** An Agent credential (or the legacy `agent` role) that sends the field — `true`, `false` or anything
    else — gets 403 `HUMAN_REQUIRED` before parsing, through REST and through MCP (`smartsell_operation_call`), and
    nothing is created. Today this is the local guard in `checkChannel` (`requireHuman` from `agent-actor.ts`); see item 1
    for the runner-level gate. The Agent's MCP tool `channel_check` is unchanged: its strict schema has no such field
    (422 with issue path `open_login_window`), and a plain check (`{}`) still works for Agents.
  - `true` calls `workerEngine().createCheckLoginJob(ctx, account, { openLoginWindow: true })` on the channel's bound
    machine. C3 semantics apply: an open check is reused; a still-`queued` plain check is upgraded to
    `open_login_window: true` (new `payload_hash`); a check the machine already holds keeps its payload.
  - The answer is the §7.2.4 view plus **`open_login_window: boolean`** — whether the job the machine will run opens the
    sign-in window. `false` means the machine already holds a plain check, so no window opens this time. The field is
    present only when the request carried `open_login_window: true`; the MCP `channel_check` output is unchanged.
- **Web:** the channel page header has 「檢查登入」 「重新登入」 「換機器」; Today's `login` cards (and any card carrying an
  `open_login` action) have one 「重新登入」 button. Both call the endpoint above and say what happens from the answer:
  window opening on `<machine>` (sign in in that machine's SmartSell Chrome window, within 10 minutes; a still-signed-in
  channel only gets its state updated), machine offline (opens when it is back within 10 minutes, otherwise press again),
  or a check already running there (no window this time, press again after it). Shared pieces:
  `RELOGIN`, `requestRelogin`, `reloginMessage` exported from `pages/ChannelPage.tsx`.

## Lead / S0 (`apps/server/src/operations.ts`)

1. **Gate the field in the shared runner.** Add `hub_channels_check: ['open_login_window']` to `AGENT_HUMAN_FIELDS`, so
   `humanDecision()` refuses it in `runScopedOperation` before `run()` like `data_source_create.allowed_uses`.
   L-fix's guard in `check.ts` stays as defence in depth and gives the same 403 `HUMAN_REQUIRED`. The existing
   `operations-agent-boundary.test.ts` check (every `AGENT_HUMAN_FIELDS` name must be Agent-callable) holds:
   `hub_channels_check` is Agent-callable. Tests already covering the behaviour end to end:
   `apps/server/src/modules/posting/check.test.ts`.

## S7 / owner of `apps/server/src/modules/workspace/views/today.ts`

2. **Remove the interim Worker-App copy and offer the action.** The Today `login` cards still tell the owner to press
   「重新登入」 in the Worker App:
   - line 69 (post blocker `login_expired` / `identity_mismatch`): `… 在 {machine} 的 SmartSell Worker 按這個帳號的「重新登入」，登入後按「檢查登入」。`
   - line 131 (channel session `login_required`): `… 請在 {machine} 的 SmartSell Worker 按「重新登入」，登入後按「檢查登入」。`

   Suggested replacements (zh-Hant):
   - line 69: `${blocker?.message ?? ''} 按「重新登入」，${machine} 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 ${machine} 登入；登入後這裡會自動更新。`
   - line 131: `${where} 上的 ${label} 登入已失效，排到這個帳號的貼文發不出去。按「重新登入」，${where} 會開啟這個帳號的 SmartSell Chrome 登入視窗，請到 ${where} 登入。`

   And put `{ kind: 'open_login', label: '重新登入', method: 'POST', path: `/hub/channels/${id}/check`, body: { open_login_window: true } }`
   first in each `login` card's `actions` (the kind is already in Appendix A `AttentionItem`). `TodayPage` renders it as the
   single 「重新登入」 button (it never renders `open_login` as a second generic button), and already shows the button on
   every `login` card until then. No view test asserts the current strings (checked `views/*.test.ts`).

## S7 (`apps/web/src/view/hub-copy.ts`)

3. `hub.channels.relogin`, `hub.channels.reloginHint` and `hub.channels.loginOpened` are no longer used (the page-owned
   `RELOGIN` copy in `ChannelPage.tsx` replaces them, because the message depends on the hub's answer). Delete them, or move
   `RELOGIN` into `hub-copy.ts` and have `ChannelPage.tsx` import it (L-fix can make the page side of that change).

## Lead (design text)

4. §4.6 says `AGENT_HUMAN_FIELDS` gains nothing; E21 adds `hub_channels_check.open_login_window`. §7.2.4 / Appendix B.3:
   the REST body of `hub_channels_check` is `{open_login_window?: boolean}` (person only) and its answer adds
   `open_login_window: boolean` when that field was `true`.

## E26 (no request; status)

5. Already done in the tree by L-server before this wave (`closure-L-server.md`): `scripts/package-worker-download.mjs` and the
   root `package:worker-download` script are removed; `pnpm worker:release` (`scripts/worker-release.mjs`, product
   `SmartSell Worker`) is the release flow; README and `docs/hub-setup.md` say so. L-fix verified that nothing references the
   removed script (`grep` over `apps`, `tests`, `scripts`, `.github`), that `.github/workflows/ci.yml`'s `desktop-package` job
   (`package.mjs mac|win --local-dir` → `scripts/verify-desktop-package.mjs` → `codesign … 'SmartSell Worker.app'`) is
   consistent with `PRODUCT_NAME = 'SmartSell Worker'` in `apps/connector-desktop/scripts/package-config.mjs`, and left the
   root `package.json` unchanged. Nothing was built or downloaded.
