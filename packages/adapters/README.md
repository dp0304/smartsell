# SmartSell platform adapters

`@smartsell/adapters` exports the provider-keyed `platforms` registry, `probePlatform`, and `createPlatformAdapter`. `@smartsell/adapters/oauth` exports the authorization and identity discovery factory for server-side account services. Both entries require an injected transport for remote calls. `createFetchTransport({ origins })` provides a bounded HTTPS implementation with a deployment-managed origin allowlist, manual redirect handling and no application-level retries. Fixture callers can inject a transport directly.

## Capability readiness

`createPlatformAdapter` serves the worker publish and catalog contracts. `createAdapter` from `src/official.ts` also exposes phase-gated `sync`, provider OAuth and raw webhook handling. The table distinguishes the implemented paths from chapter 6 gaps. Configure the deployment phase where phase gating is required.

| Platform | Implemented by phase | Live dependencies and remaining scope |
| --- | --- | --- |
| Instagram | P0a Instagram Login, container publication and media readback, post and comment reads. The official adapter includes Stories and carousels. | Professional account, publishing and comment scopes, reachable media URLs, and Advanced Access for customer accounts. Unified and Facebook Login variants, insights, replies and P1 moderation and DMs remain pending. §6.2, P01–P06 |
| Facebook | P0a Page text, link and photo publication, post readback, feed sync and Page-owned comment reads. The official adapter supports native text scheduling and adds scheduled-post reads at P1. | Facebook Login for Business configuration, Page scopes and the `CREATE_CONTENT` Page task for writes. Video, Reels, multi-photo, cancellation confirmation, insights, comment replies and P1 edit/delete and messaging remain pending. §6.3, P07 |
| TikTok | P0a inbox video delivery and P0b audited Direct Post for video. Status polling distinguishes creator action, limited publication and public post IDs. | Login Kit posting scopes, verified media URL prefix and Direct Post audit. Photo posting and the separate, approved Accounts API app and token for works, metrics and comments remain pending. §6.4, P08–P14 |
| YouTube | P0a upload, optional private scheduling and channel-bound status readback. The worker uses multipart up to 32 MiB. The official adapter handles resumable sessions and Data API works and counters. P0b comment reads. | Google OAuth client, connected channel, relevant scopes and GCP project quota. Separate Analytics API, replies and P1 moderation and edit/delete remain pending. §6.6, P18–P22 |
| Shopify | P0b Admin GraphQL product and variant pagination, optional aggregate stock and signed catalog webhook verification. P1 bounded order and refund reads. A reported API version other than `2026-10` is rejected. | Installed custom app, granted scopes and fixed allowlisted egress for custom distribution. Bulk Operations, live scope discovery, contextual prices, location stock and trade webhook routing remain pending. D16, §6.11.2 |
| TikTok Shop | P0b authorized shop lookup, signed product and SKU reads and product-status webhook verification. P1 signed order and return/refund reads. | Approved seller app, market-specific authorization URL, correct app key/secret, shop ID and cipher, and granted permissions. Trade webhooks, finance and Affiliate access remain pending. §6.5, P15–P17 |
| Amazon SP-API | P1 marketplace-scoped listings with B2C offer and merchant stock, plus bounded Orders and Finances reads with selected non-restricted fields. | LWA seller grant, correct region and marketplace, and non-restricted app roles. Finances has a reporting lag. Reports, Catalog Items enrichment, FBA stock and EventBridge/SQS notifications remain pending. D19, §6.11.4 |
| Shopee | P1 worker catalog reads for normal items and models using supplied credentials. | Approved ERP System ISV app, partner credentials and shop token. Official authorization and identity discovery, incremental catalog, orders/returns and push remain pending. D18, §6.11.3 |
| Douyin | P0a manual publishing handoff. | Official posting scope, admission and per-post consent are P1 dependencies. Official publishing, sync and engagement remain unavailable. §6.7 |
| Xiaohongshu | P0a manual publishing handoff. | No verified official note publishing route. §6.8 |
| Lazada | P2 reserved. | OAuth, catalog, orders/refunds and push are deferred by D17. §6.11.3 |

The platform registry stores reference URLs. Fixture coverage verifies request and response handling. Live approval, permissions, versions and delivery still require a sandbox or authorized test account per provider.

## Execution and reconciliation

The trusted execution service resolves the account binding and immutable approved revision. It supplies the scoped credential, platform approvals, request ID, fencing token, and account- and operation-bound execution approval. It persists the receipt and prior outcome across attempts. An accepted or unknown submission requires readback before another submission can be considered. Missing access can return a manual handoff result after approval. Manual handoff never invokes a provider transport.

Verification checks the bound Instagram owner, Facebook Page, or YouTube channel before reporting a post as published. A lost write reference can require human reconciliation. Instagram's `PUBLISHED` container remains pending until its media ID is recovered. The compatibility adapter polls known YouTube session URLs with a zero-byte status probe and checks the channel when YouTube returns a video ID. It does not resend media. Treat resumable session URLs as sensitive receipt data.

The current server execution binding still needs to advance the Instagram prepare/publish sequence and reconcile TikTok receipts with multiple verified post IDs. Connector dispatch and device validation follow the separate D15, D20, and D21 workstreams.

## Offline verification

Run `pnpm --filter @smartsell/adapters test` on Node 24 with the workspace tools installed. The suite uses synthetic provider responses and a loopback HTTP fixture for the fetch transport. Coverage includes catalog and trade pagination, authorization and account binding, signed webhooks, publication readback, and transport failures before or after possible delivery. Fixture requests stay local.
