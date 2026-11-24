# L-server (server-side integration closure): requests to other workstreams

L-server owns the server, hub and test-infra files except `apps/web/**`, `modules/workspace/views/**`, `modules/workspace/overview.ts`,
`modules/posting/{views,posts}.ts` (S7) and the Worker tree (L-worker). Everything below is a change in a file L-server does not own,
or something another stream should know. Closure of every routed ledger item: `closure-L-server.md`.

## What L-server provides now

- **E13** `DELETE /api/v1/agent-connections/self` with `Authorization: Bearer <that connection's token>` (204; 401 `UNAUTHENTICATED` for a
  missing, unknown, expired or already revoked token). The per-id path `DELETE /api/v1/workspaces/:ws/agent-connections/:id` also accepts
  the Bearer token when no browser session is sent, but only for the token's own connection (403 `PERMISSION_DENIED` otherwise). Both
  write the activity event `agent_connection_self_revoke` (actor_type `agent`, `credential_id` = the revoked connection) and set
  `agent_connection.revoked_via = 'self'`. Code: `apps/server/src/integration/agent-connections.ts`.
- **E9** `latest_worker` follows heartbeat `arch` (`connector_device.arch` is written only when it changes); macOS without `arch` = arm64;
  only the matching package is offered (`modules/worker/host-cache.ts` `workerPlatformFor`).
- **E10** `alertHandleChanged(ctx, { social_account_id, from, to, machine_id?, job_id? })` (`modules/alerts`), called wherever the
  `handle_changed` job event is written (prepare/check_login reports and `hub_posts_confirm_result`). A first handle (from `null`) raises
  nothing. Copy: Appendix C.2 `（事件）handle_changed`.
- **E14** `execution/ops.ts` refuses every legacy task action except `cancel` on a Worker-route task with 409 `WORKER_ROUTE_TASK`
  (`details.use`, `details.owner_message`); `allowed_actions` of such a task is `['cancel']`.
- **Shutdown**: `buildApp` destroys sockets that never sent a byte when the app closes (a cancelled SSE body left undici's spare socket
  holding `app.close()` for ~70 s). Regression test `apps/server/src/hub/shutdown.test.ts`.
- **Web links**: bootstrap calls S7's `installWebLinks({ publicOrigin: config.origin })` and gives S10 `effectiveMode` (S10 ledger 11).
- **Production semantics without a Config**: `apps/server/src/production.ts` `productionSemantics(env)` (= `config.production`), used by
  customer egress, the Agent model runtime and lead contacts instead of `NODE_ENV`.
- **Playwright**: `scripts/playwright-browser.mjs` picks `SMARTSELL_TEST_CHROME`, then `SMARTSELL_PLAYWRIGHT_CHANNEL`, then the bundled
  Chromium, then the installed Google Chrome (channel `chrome`). Both configs (`playwright.config.ts`, `apps/web/playwright.config.mjs`) use it.

## S7 (web and read models)

1. **Playwright specs encode the pre-phase-1 UI.** With the installed Chrome (channel `chrome`) the full run on 2026-11-24 gave
   apps/web/test 4 passed / 2 failed and tests/web-e2e 85 passed / 20 failed / 3 skipped. Every failure is a page-structure assertion
   on S7's new shell: the get-started wizard now has 5 steps (specs expect 2, "Step 1 of 2", the "Main agent" / "Desktop worker"
   regions, the link 「稍後設定，前往總覽」), the home page is 今日 instead of the "Overview" heading, and the MCP tool audit list /
   Workbench module entries moved (`apps/web/test/{rest-workbench,worker-social-audit}.spec.mjs`). Failing specs:
   `tests/web-e2e/{account-migration (2), command-identity, operator, primary (5), view-shell (2), worker-onboarding (9)}.spec.mjs`.
   They need S7 to update the specs to the §9 pages (or keep the old entry points). No failure traced to a server change; an earlier
   run failed only because `pages/hub.css` did not exist yet (S7 has since added it).
2. (S3 ledger 8, unchanged) `derivePostStatus` after `hub_jobs_force_release` of an **unreported** job returns `scheduled` (job
   `cancelled`, plan `ready`). Either show it as `missed` in the views or ask the lead to amend Appendix A; the server keeps §5.14
   (`unreported` → `cancelled`).

## Lead (design text outside Appendix C)

3. Appendix B.1: add `DELETE /api/v1/agent-connections/self` (E13), owner S4 / integration wave, and note that the per-id
   `DELETE …/agent-connections/:id` accepts the connection's own Bearer token. L-server only edited Appendix C.
4. §7.2 (S4 ledger 13): document S4's additive output fields (`post_schedule.content_ids`, `posts[].plan_tag`, `posts[].blocker`,
   `posts_list.{from,to,timezone}`, `smartsell_overview.upcoming`, `channel_check.{job_status,blocker}`, `publishing_pause` machine
   `pause_id`). The warning codes are in Appendix C.4.
5. Appendix C.3 now lists every code S2–S5, S10, E13 and E14 added, with zh-Hant owner copy; C.2 has the `handle_changed` event copy.

## L-worker

6. Nothing blocking: the Worker already sends heartbeat `arch` and uses `/api/v1/agent-connections/self`. `.github/workflows/ci.yml`
   and `scripts/verify-desktop-package.mjs` now expect `SmartSell Worker.app` (from `PRODUCT_NAME` in
   `apps/connector-desktop/scripts/package-config.mjs`); keep `package.mjs mac|win --local-dir` producing that name.

## S8 (E2E, next wave)

7. Hub restarts in the E2E stack no longer wait on cancelled alert streams. `pnpm test:e2e-phase1` is
   `node --import tsx --test tests/e2e-phase1/*.test.ts` (fails with "no test files" until the directory exists).
8. Playwright: set nothing, or `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome` to force the installed Chrome; never download browsers.
