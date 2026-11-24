# S8-RM (real-model check §10.3, owner checklist §10.4): ledger

S8-RM owns `scripts/real-model-check.mjs`, `tests/real-model/**` (`config.json`, `results/`, `real-model-check.test.mjs`),
`docs/restructure/phase1-owner-checklist.md` and this file. Under the §10.3 fix rule it also edited one tool description in
`apps/server/src/integration/mcp-hub-tools.ts` (below). Everything else here is a request to another stream or the lead.

## What S8-RM provides

- **`pnpm real-model-check [-- options]`** (`node --import tsx scripts/real-model-check.mjs`), §10.3:
  - per run a fresh S8 stack (`startStack({ clip: false })` from `tests/e2e-phase1/stack.ts`: fresh hubDir, hub child process,
    Asia/Shanghai, Mac-B with X `fixture_x`, Win-C with TikTok `fixture_tt`, both direct + risk ack, fixtures, fake ntfy);
  - a temp working dir holding only `video.mp4` (the §10.2 ffmpeg clip, 30,456,429 bytes) as the client's cwd;
  - a temp `mcp.json` (`{"mcpServers":{"smartsell":{"command":<node>,"args":[<relay bundle>,"--hub",<origin>,"--token-file",<tmp>/token]}}}`);
  - the §10.3 Claude Code command line verbatim (`claudeArgs()`, unit-tested), stream-json parsing, the five pass conditions,
    the modelUsage check against `tests/real-model/config.json`, and `tests/real-model/results/<ISO>-<client>.json` with the
    call sequences, non-MCP calls, errors, cost, duration, turns, model, client version and the summary table;
  - `--client codex`: `codex exec --json --skip-git-repo-check -C <work> [-m <model>] <prompt>` with a temp `CODEX_HOME` whose
    `config.toml` names only `smartsell` (`approval_policy = "never"`, `sandbox_mode = "read-only"`,
    `default_tools_approval_mode = "approve"`, timeouts 20/120 s); JSONL `mcp_tool_call` items of server `smartsell` are the
    MCP calls. Without the CLI it exits 2 with "codex CLI not found … Nothing was run." (checked here: no Codex on this Mac).
  - Options: `--model`, `--prompts P1,P2`, `--runs`, `--parallel`, `--label`, `--claude-bin`, `--codex-bin`, `--timeout-sec`,
    `--keep`, `--no-write`. Exit 0 gate passed, 1 gate failed (or fewer than 5 runs), 2 not run or round void.
- **`tests/real-model/real-model-check.test.mjs`** (node:test, no model, no stack; runs in `pnpm test`): verbatim command line,
  "明天 9:00" in Asia/Shanghai, P1 (a)/(b)/invented caption, P2 pass and every P2 failure kind, >6 calls, server and client-side
  `INVALID_ARGUMENTS`, `TOOL_UNAVAILABLE`, business errors not counted, media-read and base64 detection, model check, max turns,
  Codex JSONL parsing, summary table. 15 tests.
- **`docs/restructure/phase1-owner-checklist.md`**: §10.4's twelve steps as a zh-Hant runbook, with the M1 items other streams
  left for the owner's machines (real `tailscale serve`, launchd/schtasks + reboot, NSIS on Win-C, pinned Electron 45.4.1 per
  E16, Gatekeeper/SmartScreen/keychain, Worker reboot auto-start, selector calibration via dry run + `hub:update`) and the M5
  Codex run (`pnpm real-model-check -- --client codex`), plus a record table.

## How §10.3 was read (decisions in the script; lead may want them in the design text)

1. **Environment.** The client gets a cleared environment: `HOME USER LOGNAME SHELL PATH TMPDIR LANG TERM` plus
   `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` (no self-update download, no telemetry). Names are
   recorded in each results file (`client_env_keys`). `HOME` stays the owner's: with a temp `HOME` Claude Code 2.1.329 answers
   "Not logged in · Please run /login" (probe, $0). So Claude Code also loads the owner's user settings and user `CLAUDE.md`
   (the script never reads them); `--strict-mcp-config` is verified per run from the init event (only `smartsell` may be
   loaded, else harness error). Codex gets a temp `CODEX_HOME`; the owner's `auth.json` is symlinked in, never read.
2. **`mcp.json` paths.** §10.3 shows `node packages/agent-relay/dist/smartsell-relay.mjs` relative; the client's cwd is the
   video dir, so the script writes the absolute node binary and bundle path (same command otherwise).
3. **MCP call count** = `tool_use` names starting `mcp__smartsell__` (subagent calls would count too). Claude Code 2.1.329 defers
   the MCP tools behind `ToolSearch`; that call is recorded as non-MCP and not counted.
4. **Condition 2.** `INVALID_ARGUMENTS` = the hub's error code or Claude Code's client-side `InputValidationError`;
   `TOOL_UNAVAILABLE` = the hub's code or "No such tool available". Other errors (e.g. `PATH_NOT_ABSOLUTE`) are recorded only.
5. **Condition 3.** Fails on `Read`/`Grep` of the media, a Bash/Codex command that runs a content reader (`cat base64 xxd od
   hexdump head tail strings curl wget dd openssl python node ffprobe ffmpeg sha256sum …`) on the media, any encoder anywhere,
   or a >4 KB / `data:` / long base64 value in MCP arguments. `pwd`, `ls`, `realpath`, `Glob` are recorded only.
6. **P1 (a)** = no `post_schedule` call, zero `publish_target` rows, and the last reply offers posting without text and asks
   for an answer (`asksAboutText`, zh + en). A question mark is not required. The heuristic was wrong twice and was fixed in
   the checker (not in the product), see rounds below; every result file keeps `final_text` for audit.
7. **Condition 5** reads the hub through the owner views (`/views/posts`, `/views/posts/:id`: status, channel, machine,
   rendered caption, media SHA-256, `web_url`), then stops the hub (SIGTERM) and reads `publish_target` rows from its records:
   exactly 2, one per expected channel, `scheduled_at` = tomorrow 09:00 Asia/Shanghai (01:00Z; "tomorrow" is taken at the start
   of the run, and also at its end if it crossed midnight), status `scheduled`, exactly the uploaded video, P2 caption exactly
   `新路亞實測 🎣 #fishing #lure` (P1 (b): empty), and the last reply contains both posts' `web_url`.
8. **modelUsage.** Every run checks that `modelUsage` has the configured ID and every assistant message names it; a mismatch
   on the first run voids the round (exit 2). In all 60 runs the keys were exactly `[REAL_MODEL_ID]`.
9. **Harness errors** (stack start, client API/auth error, MCP server not connected) are retried once and recorded
   (`harness_attempts`). None occurred.
10. Raw transcripts (init event trimmed: it lists the owner's local skills and plugins) stay in
    `$TMPDIR/smartsell-real-model/<ISO>-<client>/`, outside the repo.

## Rounds (Claude Code 2.1.329, this Mac, 2026-11-24; every results file kept in `tests/real-model/results/`)

| Results file | Model | P1 | P2 | MCP calls (P1 / P2) | Errors | Avg cost P1 / P2 | Notes |
|---|---|---|---|---|---|---|---|
| `2026-11-24T09-01-46-539Z-claude.json` | claude-sonnet-5-5 (gate) | 5/5 | 5/5 | 2 / 3 | 0 | $0.082 / $0.094 | Round 1, surface as delivered. Gate passed. |
| `2026-11-24T09-03-27-364Z-claude.json` | claude-opus-5-5 (confirmation) | 4/5 | 5/5 | 2 / 3 | 0 | $0.211 / $0.220 | P1-2 scored FAIL by a checker bug: the reply asked "請直接給我文案；或者回覆「不加文字」，就只發影片" without a question mark. Re-scored with the final checker: 5/5. Gate passed either way. |
| `2026-11-24T09-05-12-435Z-claude.json` | claude-sonnet-5-5 | 5/5 | 5/5 | 2 / 3 | 0 | $0.081 / $0.094 | Round 2 with the question-mark fix (its label says "final checker"; one more checker fix followed). |
| `2026-11-24T09-06-12-233Z-claude.json` | claude-opus-5-5 | 4/5 | 5/5 | 2 / 3 | 0 | $0.174 / $0.201 | P1-5 scored FAIL by a second checker gap ("要不要附文字或 hashtag？…回「不用文案」"). Re-scored with the final checker: 5/5. |
| `2026-11-24T09-10-44-237Z-claude.json` | claude-sonnet-5-5 (gate, final) | 5/5 | 5/5 | 2 / 3 | 0 | $0.080 / $0.092 | Round 3: final checker + the `smartsell_overview` description change. Gate passed. |
| `2026-11-24T09-11-36-943Z-claude.json` | claude-opus-5-5 (confirmation, final) | 5/5 | 5/5 | 2 / 3 | 0 | $0.173 / $0.200 | Confirmation round with the final script and surface. Gate passed. |

Every run of every round: sequence `smartsell_overview → media_upload` (P1, then the question) or
`smartsell_overview → media_upload → post_schedule` (P2, one call for both channels), absolute path built from the cwd, zero
`INVALID_ARGUMENTS` / `TOOL_UNAVAILABLE` / any other MCP error, no media read or base64, `media_upload` answered `ready` in one
call. No P1 run invented a caption (all 30 asked). Total spend ≈ $8.50 for the 60 runs (plus a $0.06 auth probe and a
$0.27 two-run smoke test).

## The one MCP-surface change

**Stumble:** `smartsell_overview.needs_owner` lists a `channel_setup` item titled 「… 還沒設定完成（1 項）」 with
`message: "還沒試跑"` (S7's `views/today.ts`: blockers and non-blocking reminders share one item). With the description as
delivered, 4 of 40 replies told the owner the reminder "可能會影響明天能不能自動發出" / "這可能影響發布", i.e. that the
scheduled post might not go out, which is false (`can_schedule` is true; only `channels[].blockers` stop scheduling).

**Fix (general, not prompt-specific):** the `smartsell_overview` description in `apps/server/src/integration/mcp-hub-tools.ts`
now ends: "Only a channel's blockers (can_schedule false) stop scheduling; other channel_setup items in needs_owner are setup
reminders. Whether a post waits for the owner shows in its approval and owner_action." After it: 0 of 20 replies said the
post might not go out (sonnet and opus round 3); the S4 tests stay green (`node scripts/test.mjs mcp-hub-tools modules/posting`:
31 pass). Nothing else in `mcp-hub-tools.ts`, `mcp-hub-instructions.ts` or `schemas.ts` was changed: no run stumbled on them.

## Requests

### Lead (design text)

1. §7.2.1: the `smartsell_overview` description text now has the two sentences above (§10.3 fix). Please copy them into
   §7.2.1 or tell S8-RM to revert.
2. §10.3: please record the readings above that go beyond the text — owner `HOME` for Claude Code's login (item 1), absolute
   paths in `mcp.json` (2), `ToolSearch` not counted (3), client-side `InputValidationError` counted as `INVALID_ARGUMENTS` (4),
   the P1 (a) rule (6), condition 5 read from views + records with "both posts' `web_url`" (7), modelUsage checked on every
   run (8), one retry for harness errors (9).

### S7 (`modules/workspace/views/today.ts`, `modules/posting/views.ts`)

3. The `channel_setup` attention item mixes blockers (which also appear in `channels[].blockers`) with reminders such as
   「還沒試跑」, under the title 「還沒設定完成」. Models (and probably the owner) read it as a threat to the next post. Suggest
   splitting the reminders into their own wording, e.g. title 「建議：試跑一次」 with detail 「不影響排程與發布」, or an
   additive `blocks_scheduling: boolean` on the agent projection, so the description sentence is no longer needed.

### S8 (FYI)

4. `startStack` is reused unchanged (one stack per run, `clip: false`, the clip copied into the client's own cwd). The
   stack's own MCP client only lists tools; it makes no calls. Nothing requested.

### Owner (M5, in the checklist)

5. Run `pnpm real-model-check -- --client codex` on the laptop (checklist step 7.2) and keep the results file. The Codex
   config keys and JSONL shapes follow the Codex docs (config reference and `codex exec --json` events as of 2026); they could
   not be run here. If Codex rejects `default_tools_approval_mode` or declines MCP calls, the run shows it (failed items /
   harness error) and the results file plus transcripts should come back to S8-RM.
