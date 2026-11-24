# @smartsell/agent-relay

Local stdio MCP relay for Codex and Claude Code (phase1-design §6.1–§6.3, S5).

- Forwards every MCP message to `<hub>/mcp` with the agent connection token (JSON and SSE answers, `Mcp-Session-Id`, 16 MB limit, `serverInfo.name === 'smartsell'`).
- Handles `tools/call` for `media_upload` on this computer: absolute or `~/` path, deny list, magic-number type, SHA-256, resumable 1 MiB-chunk upload (1–8 chunks per PUT, adaptive), returns within `wait_seconds` (45 s default) and continues in the background.
- Parts, `complete` and status reads are retried on network errors, 5xx, 408 and 429 (1–16 s; in the background every 30 s for 30 minutes). A background run that finally gives up while the session is still receiving calls `abort {reason:'error'}`, so the hub fails the media and alerts the owner (`upload_failed`). A foreground failure goes to the model instead and the session stays resumable.
- Hand-off to the laptop App (C12) is asked again on every `media_upload` for a receiving session, and again while watching when no bytes arrive for 10 s (`handoffRecheckMs`). An earlier "yes" is never trusted: when the App is gone or no longer has the upload, this process uploads the rest itself.

## Run

```
node dist/smartsell-relay.mjs --hub https://<hub>.ts.net --token-file ~/.smartsell/token
node dist/smartsell-relay.mjs --config "<userData>/agent-relay/config.json"     # token in ./credential (0600)
"<SmartSell Worker>" --mcp-relay                                                  # App mode (S9 calls relayMain)
```

`pnpm --filter @smartsell/agent-relay build` writes `dist/smartsell-relay.mjs` (one ESM file, Node 20+, only `node:` imports); the hub serves it at `GET /agent/relay.mjs`. Without a build, `bin/smartsell-relay.mjs` runs `src/main.ts` directly on Node 22.18+.

## Library (Worker App, S9)

- `relayMain({ argv, stdin, stdout, stderr, defaultConfigPath })`: the `--mcp-relay` entry.
- `continueUpload({ hubOrigin, token, uploadId, path, sha256, bytes, mtimeMs, onProgress, signal })` (C5). Aborting `signal` (the App quitting or updating) stops without failing the session; giving up on its own aborts the hub session first, then rejects.
- `createHandoffServer(handoffSocketPath(dataDir), accept)` / `createHandoffClient(...)` (C12): one JSON line `{type:'handoff', upload_id, path, sha256, bytes, mtime_ms}`, answered by `{ok}`.
