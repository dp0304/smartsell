# SmartSell connector runbook

This fixture exercises the Windows and macOS desktop connector rules in plan §§4.16 and 6.9. The CLI runs an in-memory driver with synthetic accounts, media, approvals, and phones. The fixture performs no platform I/O. Result links use the reserved `.invalid` domain and evidence objects are discarded when the process exits.

## Run locally

Use Node 24 or later on macOS or Windows. From the workspace root, after installing workspace dependencies:

```sh
pnpm --filter @smartsell/connector start --help
pnpm --filter @smartsell/connector start fixture browser assist
pnpm --filter @smartsell/connector start fixture android auto
pnpm --filter @smartsell/connector start fixture tiktok auto
pnpm --filter @smartsell/connector start replay android
pnpm --filter @smartsell/connector test
```

The standalone equivalent is `node --experimental-transform-types --disable-warning=ExperimentalWarning apps/connector/src/cli.ts fixture android auto`. Open `fixture.command` on macOS or `fixture.cmd` on Windows for an interactive browser fixture. The launchers need Node 24 or later on the desktop session’s PATH. They also forward explicit CLI arguments from a terminal. For example, run `./apps/connector/fixture.command replay android` on macOS or `apps\connector\fixture.cmd replay android` in Windows Command Prompt. Relative input paths resolve from the directory where you launched the command.

In a terminal, assist prints `awaiting_user_click` and waits for the operator to type `publish`. A noninteractive assist invocation prints the pending state and exits without a submission. The local decision expires at the earlier of the assist deadline and the claim lease deadline. Auto requests and consumes a synthetic permit before submitting. A successful fixture submission emits `accepted` and `submitted_by` together with scoped masked evidence references.

`replay <browser|android|ios|tiktok>` uses a fixed synthetic clock and host. It injects a disconnect after one synthetic submission, advances the same attempt again, recovers the result by its original attempt ID, and checks the evidence hashes. Success returns exit code 0 with `status: replay_verified`, `submissions: 1`, and a separate visibility result. TikTok reports `official_publish_id_required` because visibility reconciliation belongs to the platform’s official publish ID flow. A replay that fails verification exits 1.

## Signed manual handoff

`check <trusted-local-context.json> <signed-lease.txt>` verifies the lease against a pinned issuer key and independently maintained local context. The context contains the exact lease scope, active desktop pairing and binding flags, `deviceOwned`, `consentConfirmed` for the scoped job, the local halt and platform status, and expected and observed account IDs. On mobile, it also requires `mobileDevice` with `expectedId` from the local binding, `observedId` from explicit local confirmation, and `owned`, `physical`, `paired` and `authorized` flags. A context without these ownership fields needs to be regenerated from trusted local state.

The allowlisted routes are browser official authorization, TikTok’s mobile share flow, and manual continuation in the supported platform’s official interface. Successful output identifies the platform, channel and workflow and asks the operator to continue manually. Device discovery and official platform interaction stay with the operator. The command verifies a snapshot and exits 1 on a failed gate. AC owns atomic consumption of the lease `jti` and result reconciliation, while D15 terms and risk acceptance remain account-policy decisions.

## Operator-assisted AC gateway

On Windows and macOS, `keygen`, `pair`, `phone`, `identity`, and `run` provide the signed AC gateway flow. `pair`, `phone`, `identity`, and `run` require an interactive terminal. Provision one local target with the AC origin, workspace, connector, binding, account, session and expected platform identity. Use a dedicated browser profile or a pre-approved Android phone. The mobile target file also specifies the paired hardware ID hash and approved USB or LAN connection. Enter the phone’s observed hardware ID locally when prompted.

`run` handles one claim. The operator confirms ownership and consent before seeing the approved content, stages in the official platform interface, then checks the device and account again before clicking Publish. The prompt expires with a margin for reporting under the original lease. A missing receipt or a lost report acknowledgement requires reconciliation of that attempt. Enable live acceptance only with AC/EX dispatch, a configured evidence verifier and receipt registration. iOS publication and visibility in the replay are synthetic, and TikTok visibility requires the official publish ID flow.

## Standalone signed gateway session

Use a deployed SmartSell AC gateway with `mountAccountIngress`, a verified TLS origin, and EX dispatch configured for the selected binding. HTTP is accepted for loopback test gateways. The command prefix below works from the workspace root. For a direct desktop terminal launch use `node --experimental-transform-types --disable-warning=ExperimentalWarning apps/connector/src/cli.ts` as the prefix.

1. Create the device key in a directory private to the desktop user. On Windows, restrict the directory with the user’s ACL before generating the key. On macOS the CLI also checks the key file owner and permissions. Store the key locally and use a separate key per paired workspace device.

   ```sh
   pnpm --filter @smartsell/connector start keygen desktop-key.pem
   pnpm --filter @smartsell/connector start pair https://gateway.example.invalid workspace-123 "Publishing PC" desktop-key.pem
   ```

   Obtain the short-lived pairing code through AC, confirm ownership in the terminal, and enter the code when prompted. Save the returned `device_id`. All examples use placeholder values.

2. For browser use, create a dedicated profile and an AC browser session for the account. For Android use, provision the following `local-phone.json` yourself. `hardware_id_hash` is lowercase SHA-256 of the UTF-8 hardware identifier held in the local allowlist. Use only physical, unmodified, client-owned phones with the authorized link and compatible App setup. `connection` is `usb` or explicitly approved same-LAN `lan`.

   ```json
   {
     "origin": "https://gateway.example.invalid",
     "workspace_id": "workspace-123",
     "connector_device_id": "desktop-123",
     "hardware_id_hash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
     "connection": "usb"
   }
   ```

   ```sh
   pnpm --filter @smartsell/connector start phone local-phone.json desktop-key.pem "Approved Android Model" A123 14
   ```

   Confirm the actual paired hardware ID when prompted. The initial report returns `detected` and a mobile device ID. Have an AC administrator approve and bind the phone and App, then report again to reach `ready`. Report it immediately before mobile identity verification and task processing. AC expires the phone heartbeat after 90 seconds, so refresh from a separate terminal if staging takes longer. The CLI relies on operator observation of the connection and official interface.

3. Provision `local-target.json` from the approved binding and keep it separate from cloud task payloads. `platform_identity` is the stable platform account ID, distinct from the AC account row ID. For browser, `profile_id` is the AC browser session ID. For mobile, set `target` to `{"channel":"mobile","app":"tiktok","mobile_device_id":"phone-123"}`, set `session_id` to the AC mobile App binding ID, and add `android` with the same `hardware_id_hash` and `connection` from `local-phone.json`.

   ```json
   {
     "origin": "https://gateway.example.invalid",
     "workspace_id": "workspace-123",
     "connector_device_id": "desktop-123",
     "binding_id": "binding-123",
     "account_id": "account-123",
     "session_id": "browser-session-123",
     "platform_identity": "platform-account-123",
     "target": { "channel": "browser", "app": "douyin", "profile_id": "browser-session-123" }
   }
   ```

   ```sh
   pnpm --filter @smartsell/connector start identity local-target.json desktop-key.pem
   pnpm --filter @smartsell/connector start run local-target.json desktop-key.pem
   ```

4. Run against the binding that EX has queued for this paired desktop. The CLI requests one task for the locally configured binding via the AC claim filter. It rejects a claim outside the single local allowlist and prompts for local consent, verifies the observed account, and checks signed readiness against AC before staging and again before submitting. Provide local file paths when prompted so the CLI can hash the approved assets. On Android, move the verified assets to the phone yourself and verify their album presence. For TikTok, locate exactly one matching inbox draft and review its approved settings. Click Publish once in the official interface only when prompted. The standalone path is assist-only, including when the claim advertises `auto`. The signed `ConnectorRun` integration below is the path for drivers using automatic submit permits.

5. Capture and mask a screenshot or UI hierarchy and register it through the workspace evidence flow. Paste a one-line result with `platform_post_id`, `result_url`, and `evidence`. Each evidence reference has `kind`, `sha256`, and `object_id`. Use the direct HTTPS post permalink on the official platform host. Its path must contain the supplied post ID. Remove trackers, query strings and fragments. Short links and query-only permalinks are outside the standalone receipt allowlist. The CLI sends references to AC and leaves capture and upload to the workspace evidence flow. If the platform result or report acknowledgement is uncertain, reconcile the original attempt in EX. `post.capture_result` recovers a receipt for that attempt. `post.verify_visible` asks the operator to check the exact post in the official interface and report whether it is visible. TikTok still uses the official publish ID for visibility. If a verification challenge appears before the click, report its observed reason and stop. Use `unknown` if a click may have happened. Keep the terminal private because it displays frozen content and collects identity and evidence data.

This entry point supports Windows and macOS desktops, dedicated browser profiles, and operator-assisted Android workflows. Automated physical-device control, iPhone signing and device integration, and direct evidence storage are host integrations. Use the fixture to test permits, device preflight and recovery without platform accounts.

## Operator acceptance test

Use a staging workspace, a paired Windows or macOS desktop, synthetic media and test identities. Start with an isolated fake creator page or app to test staging and receipt handling without publishing to a real platform. For the physical Android check, use a client-owned test handset paired through the OS over USB or an explicitly approved same-LAN link. Verify the hardware identifier locally and record only the test attempt ID, decision and redacted evidence references in the test log.

1. Pair the desktop and report the Android handset. Confirm a valid binding can claim. Enter a wrong hardware ID, then unplug the handset and report it unavailable by leaving the hardware prompt blank. Repeat with a revoked desktop. Confirm each case prevents the publish prompt. Restore the pairing and verify the bound account again before continuing.
2. Queue one approved revision and confirm the displayed content and media hashes. Substitute a different asset and verify the CLI stops before the final prompt. Exercise a changed account and a simulated challenge. Verify AC records the blocker and that the connector did not submit.
3. Stage the approved content and confirm that the signed standalone CLI requests an operator click even when AC advertises `auto`. Exercise auto separately with the offline fixture and permit tests. They cover deferral, denial, consumption and recovery after a lost result.
4. In the test interface, make one submission and report a masked receipt. Verify AC keeps the attempt pending EX verification. Simulate a disconnect after the click, then recover the original receipt through `post.capture_result`. Verify there is still one submission. For a non-TikTok post, exercise `post.verify_visible` against the original post ID.

## Device and workflow preconditions

- D20 limits the desktop process to Windows and macOS. The browser target must match an active desktop pairing and a dedicated profile assigned to one verified account.
- D21 requires a paired, owned, physical phone with an active authorized connection, an unlocked screen, and a compatible App. The same phone and App can have one binding. Android requires 8+ over USB or 11+ over an explicitly confirmed same-LAN connection. The iOS fixture models P1, requires macOS and iOS 18+, and checks customer signing, developer-account confirmation, trust, and signing expiry.
- Match the hardware and platform identity to the binding. During staging and before submit, check the active approval against the canonical frozen revision. Verify every media SHA-256 and confirm mobile album presence. The TikTok flow operates on one uniquely matched inbox draft and uses the approved privacy and interaction settings.
- Tasks accept opaque IDs and a fixed set of fields. Keep credentials, platform sessions, and device keys local. The exposed task set excludes remote commands, arbitrary navigation, challenge solving, and the P1 comment and metric workflows awaiting evaluation.

## Interpret results and recover

| Connector state | Response |
| --- | --- |
| `awaiting_submit_permit` | Advance at `retry_at` on the same attempt. AC/EX owns lease, write-slot, and lateness decisions. |
| `awaiting_user_click` | Review locally and submit explicitly. The default timeout is 30 minutes. When closing the staged screen, capture and verify any submission already observed. |
| `blocked` with challenge or identity mismatch | Stop execution and report the reason. The authorized operator handles the prompt, unlock, or login locally. AC owns account blocks and administrator re-enablement. TikTok draft completion returns to `awaiting_creator_action`. |
| `accepted` or `outcome_unknown` | Reconcile through EX. Use result capture against the original attempt to recover missing evidence. Avoid retransmission or switching paths while the outcome is uncertain. TikTok visibility is reconciled through the official publish ID flow. |
| `media_cleaned` | The fixture removed media matching the original attempt, verified post, opaque asset ID, and SHA-256. |

## AC and EX integration

- `@smartsell/connector-tasks` exports `parseConnectorTask`, `parseConnectorClaim`, and `frozenRevisionHash`. Hash the parsed revision by UTF-8 SHA-256 of compact JSON with recursively sorted keys and original array order. Both hashes in the publish envelope must match that digest. Check the actual approval is current and authorized separately.
- `SignedDeviceClient` accepts an injected gateway transport that receives the action, exact raw body bytes, and Ed25519 envelope. `createPairingRequest` produces the AC pairing proof after local ownership confirmation. The caller supplies the platform-held key and the independently verified pairing and binding state.
- Pass `client.ready.bind(client)` as `ConnectorRun`’s readiness callback for a signed claim. Call `advance()` at the retry deadline or on local progress. Apply heartbeat mode updates with `applyHeartbeat` when available. Send terminal `run.report()` through `client.report`. The signed client and server share the permit and consume decision shapes. If a bearer gateway is configured, `HttpSubmitPermitClient` restricts requests to the two permit endpoints and rejects redirects.
- The gateway and AC/EX own task delivery, proof validation, leases and fences, quotas, emergency stops, eligibility, and result reconciliation. Production key storage, gateway mounting, real device or browser access, and presigned evidence upload are separate integration points. The fixture stores redacted synthetic screenshot and mobile hierarchy bytes with hashes and capture context. Register an approved evidence object with the gateway before reporting it to an AC verifier.
