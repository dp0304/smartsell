# Agent operations integration

Register `operations` from `agent/index.ts`. The same entry point also has a legacy `commands` export. Use only one interface for the same route and storage flow.

| Host responsibility | Export or context field |
| --- | --- |
| MCP tool discovery and invocation | Filter Agent tools with `agentMcpNames` in both paths. Reject the remaining operations over MCP and agent credentials over REST. Human review, model settings, rules and approvals need an interactive member. Retain the usual membership and resource checks. |
| Lease identity | Set `AgentRequestContext.agentCredentialId` from the verified MCP grant. Keep the user ID in `actorId`. Call `expireActorLeases` on membership removal. Expiry and claims need serialized workspace transactions. |
| Agent assignment | Supply `AgentRequestContext.isActiveWorkspaceMember` from the live IAM transaction. |
| Content drafts | Set `ChangeContext.agentChangeTargets = createAgentChangeTargets(registeredOperations)`. The built-in work-item adapter uses the owning workspace service. The content adapters use the registered owning operations and only permit title or draft-text updates. Apply resource scope to reads and actual writes, including each change-set target. |
| Event delivery | Call `processAgentEvent(ctx, { id: event.id, type: event.type, data: event.payload })` in an authorized worker transaction. Process the existing outbox events, including Agent lifecycle events needed by the workbench. |
| Scheduled work | Invoke `reapJobLeases` and `processAgentSchedule` once per minute per workspace. Schedule keys use UTC interval buckets. Persist the host's dispatch and catch-up state separately. |
| Optional model runtime | Supply `ModelContext.agentModelServices` with a tenant-scoped secret resolver, endpoint allowlist enforcement at network dispatch, the appropriate provider SDK, a token counter and a page context exporter. Classify all outgoing fields on the server. Propagate only bounded data to the customer-configured destination. Do not enable SDK fallbacks or other recipients unless a future configuration authorizes them. |

Job mutation calls require the current row version and the active lease owner must also provide the fencing token. On expiry the job remains blocked until a reviewer reconciles its side effects. The review gate never implicitly retries external work.

Model routes start disabled. Creating an unused provider does not dispatch a request, and enabling a route requires a separately active provider. The runtime receives only permitted classes and placeholders for blocked optional fields. It must never receive unfiltered business context. Keep the write transaction or equivalent reservation serialized while applying the budget guard and recording the resulting usage. Never infer success for an ambiguous upstream result.

Only request a model after checking the authoritative application's export permission for each resource. Public and private workspace data must have distinct classifications even if both originate from a user-entered field. A failed provider call does not try another provider. The core workspace operations and external MCP clients do not depend on model configuration.

The portal is mounted independently through `team.createPortalHandler`. Refer to `apps/portal/README.md` for the package and origin configuration. Ops tenant-wide stops, retention and backup/restore use `OperationOpsContext`. Check `opsMcpNames` before registering OP tools and recheck the emergency stop immediately before dispatching an external side effect.
