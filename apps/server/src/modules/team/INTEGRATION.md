# Team and portal integration

Register `createTeamOperations(teamHost)` under the workspace REST operation dispatcher. Enforce each operation's `roles`, `versionKind`, and transactional idempotency at the dispatcher. The named `operations` export uses unconfigured adapters and fails with `503 not_configured` when an operation requires one. Team operations carry `mcp: false`. Apply that restriction to both MCP discovery and invocation. The older command dispatcher continues to consume `commands`.

Call `registerTeamPortal(app, portalHost)` on the standalone Fastify service. For other hosts, mount `createPortalHandler(portalHost)` at `/api/v1/portal/*` and preserve the request method, origin, headers and body in the Fetch `Request` adapter. The framework supplies an isolated portal session, verifies recipient email, and rechecks the workspace membership inside the scoped transaction. Resolve share IDs and invitation IDs against trusted storage. The transaction must commit access-log writes on successful reads and serialize against expiry or revocation, invitation use, and concurrent core decisions. Rate-limit at the gateway, and redact credentials and issuance bodies from logs. Keep team records out of generic records, search, exports, and notification payloads unless the host applies the same checks.

The portal host projection must recheck explicit sharing eligibility and return the pinned revision for the supplied audience and principal. The share stores an approved content hash and the attachment and comment versions selected at preview. Anonymous links can view or download the explicitly granted material. Authenticated feedback and approvals additionally require the current workspace grant, matching recipient and explicit permission. Core owns decision validity and repeat-submission behavior. The storage adapter issues short-lived HTTPS download URLs for the authorized attachment. Reports and creator submissions remain integration calls to their owning modules.

## Agency branding batch

From the repository root, run `node apps/server/src/modules/team/branding-batch.mjs https://staff.example.com branding.json` with `SMARTSELL_STAFF_SESSION_COOKIE` set to the signed-in staff session cookie as `name=value`. The command retrieves the CSRF token from the staff API. The account needs owner or admin access to each target workspace.

The manifest is a JSON array of 1–50 distinct workspace settings. Each row requires `workspace_id`, `label`, and `accent`. The optional `logo_data_url` and `portal_origin` fields preserve their current values when omitted and clear those values when set to `null`. Each custom portal origin must already be configured on the deployment and can be assigned to one workspace.

```json
[
  {
    "workspace_id": "00000000-0000-0000-0000-000000000001",
    "label": "North Studio",
    "accent": "#113355",
    "portal_origin": "https://client.example.com"
  }
]
```

The command prints the HTTP result for each workspace. Writes commit independently and processing continues after row failures. An exit code of 1 indicates an input, session, or row failure. For an `OUTCOME_UNKNOWN` row, check the workspace branding before retrying because the server may have committed the write.

# Legacy collaboration integration

Register `registerCollaboration(app, services)` from `src/extensions/collaboration.ts` on the Fastify instance. Register the five module `commands` under their module keys in the workspace command dispatcher. Keep extension paths outside that dispatcher.

## Host services

- `signingKey` is a persistent secret of at least 32 random bytes shared by replicas. Changing it invalidates outstanding tokens.
- `workspace(request, workspaceId, fn)` authenticates the local session cookie, applies the core CSRF/origin check where required, and reloads authoritative membership before invoking `fn` in the scoped transaction. Adapt core errors to `DomainError` if needed. The path/body workspace ID is only a selector. The context's actor, role and tenant are server-derived.
- `publicWork(locator, id, fn)` uses the fixed module/kind and exact 32-character opaque record ID to resolve one workspace. Return `undefined` if there is no unique match. Use a privileged entry point with no unscoped record-returning API and then invoke `fn` inside a scoped unit of work with a service actor. Reject malformed or ambiguous lookups. Keep lookup and transaction bound to the matching record, use a lock or equivalent transaction isolation for concurrent revocation and mutation, and roll back all effects on error.
- `changeMembership(ctx, change)` changes authoritative IAM in the same transaction rather than storing a shadow team role. Enforce administrator hierarchy, protect the last owner, and revoke removed members' workspace credentials and grants. Membership removal then releases inbox occupancy, revokes that member's shares and leaves a task handover. The route fails closed when the IAM hook is unavailable.
- The host adapters must provide an active audit/command context where `ctx.emit` is allowed. If the kernel uses `Unit.command`, enter it before invoking the callback and use a unique request key for audited actions. Validate the capability and live record again on every request, including retries.
- Apply `canReadCollaborationRecord(module, kind, role)` to generic record endpoints, exports and other workspace read surfaces. These record routes must always perform the normal workspace membership check first.
- Apply same-origin routing and request limits at the gateway. Keep request bodies, capability URLs, contact details and headers with credentials out of proxy/application logs. Deploy `apps/public` without workspace APIs on its origin. Its API routes use only the listed public paths.

## HTTP interfaces

| Method | Path | Input or output |
|---|---|---|
| GET | `/api/public/landing/:key` | Public landing version and consent options |
| POST | `/api/public/landing/:key` | `version_id`, contact fields, `service_contact`, separate `marketing` channel choices. Returns `{data:{accepted:true}}` |
| GET | `/r/:key` | `302` to the configured, verified destination and stored UTM values |
| POST | `/api/portal/share-token` | Session required. `{workspaceId,shareId}` returns `{data:{token}}` |
| POST | `/api/portal/share` | `{token,action?,text?}` returns the immutable delivery projection, externally visible comments and decision |
| POST | `/api/portal/creator-token` | Staff session required. `{workspaceId,deliverableId}` returns `{data:{linkId,token}}` |
| POST | `/api/portal/creator-submit` | `{token,post_url}` submits one deliverable revision and returns `{data:{accepted:true}}` |
| POST | `/api/portal/unsubscribe-token` | Admin session required. `{workspaceId,linkId}` returns `{data:{token}}` |
| POST | `/api/public/unsubscribe` | `{token}` returns `{data:{accepted:true}}`. GET never unsubscribes |
| POST | `/api/portal/membership` | Admin session required. `{workspaceId,memberId,action:'set_role',role}` or `{workspaceId,memberId,action:'remove'}` |
| GET | `/api/portal/workspaces/:workspaceId/leads/:id/contact` | Admin session required. Returns private lead contact fields with `Cache-Control: no-store` |

In production, set `SMARTSELL_TRAFFIC_CONTACT_KEY` to a persistent 32-byte base64url key for lead contact encryption.

Share and unsubscribe UI links use `/share#<token>` and `/unsubscribe#<token>` respectively. Capability tokens are purpose-bound and have a maximum lifetime of 15 minutes. Share access checks the record status, expiry, permission and published revision on every request. Share comments and decisions identify the capability that acted. The server does not attest to the identity of the person holding the link. Use an authenticated core approval flow when a named approver is required.
