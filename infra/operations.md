# SmartSell Operations API

The standalone Operations kernel has its own database schema and sessions. The [deployment runbook](README.md) covers the shared Commands and Operations API used by both Web entries.

With Node.js 24 and the workspace dependencies installed, run `pnpm --filter @smartsell/server dev:kernel` from the repository root. The API defaults to `127.0.0.1:3401`. Set `HOST`, `PORT`, or `SMARTSELL_DATA_FILE` to override the listen address, port, or state file. Local data persists in `.local/smartsell.json` by default. Use a single process and a loopback host for local storage.

```sh
curl --fail-with-body http://127.0.0.1:3401/api/v1/setup \
  -H 'Content-Type: application/json' \
  --data '{"email":"local@example.invalid","password":"local-test-password","workspace_name":"Local"}'
```

Use the session cookie and the `data.csrf_token` from setup or `GET /api/v1/session`. Send the CSRF token as `X-CSRF-Token` on browser mutations. The workspace catalog lists operation paths and marks versioned mutations. Send `If-Match` with the row's version and reuse the same `Idempotency-Key` when retrying the same mutation. `GET /api/v1/workspaces/{workspace_id}/stream` provides workspace invalidations.

Create a workspace PAT with `POST /api/v1/workspaces/{workspace_id}/tokens` and send it as a Bearer token to `/mcp`. The PAT can restrict access to read operations and specific tool names. OAuth clients can use the authorization server metadata and S256 PKCE.

For a single-host production deployment, export distinct hex PostgreSQL passwords (`POSTGRES_PASSWORD`, `SMARTSELL_MIGRATION_PASSWORD`, and `SMARTSELL_RUNTIME_PASSWORD`), a persistent `APP_SECRET` from `openssl rand -hex 32`, and the HTTPS `PUBLIC_ORIGIN`. Supply an independent `SETUP_TOKEN` during first setup. `IDENTITY_ENCRYPTION_KEY` can hold a separate persistent encryption key. Proxy `/api`, `/mcp`, `/oauth`, and `/.well-known` through the configured TLS endpoint. Disable proxy buffering for SSE.

```sh
docker compose -f infra/compose.yaml -f infra/compose.operations.yaml --profile server up -d --build
curl --fail http://127.0.0.1:3401/readyz
```

The overlay applies the standalone kernel migrations before starting the Operations API as `app_rw`. Send `X-Setup-Token` on first setup, then remove the token and recreate the API container. On a host, use `MIGRATION_DATABASE_URL` with `pnpm db:migrate:kernel` and `DATABASE_URL` with `pnpm start:kernel`.

## Commerce collection

Both startup modes register commerce background work. For split Operations deployments, enable `scheduler` to queue interval runs and `worker` to collect pages and consume events. Configure official app credentials in `SMARTSELL_COMMERCE_PROVIDER_CREDENTIALS` and tenant-bound Shopify installs in `SMARTSELL_SHOPIFY_APPS`. Use the same persistent key configuration on the API and workers. `SMARTSELL_COMMERCE_ENCRYPTION_KEY` accepts a dedicated 32-byte hex key. The OAuth callback is `GET /api/v1/oauth/callback/:provider`. Shopify product webhooks use `POST /api/v1/webhooks/commerce/shopify/:appId` with the configured shop domain and provider signature.

`SMARTSELL_SHOPEE_CATALOG_GRANTS` accepts operator-provisioned read grants scoped to the tenant, workspace, source, connection, store, and shop. Shopee orders and refunds use report imports. Amazon refund polling uses a settlement delay of at least 48 hours. To use XLSX in a report import, submit `xlsx_base64` in place of the CSV or file ID. The preview uses the first worksheet and the same mapping and confirmation flow as CSV.

`ROLE=all` starts the API, MCP, public routes, ingress, scheduler, worker, and media services in one process. PostgreSQL deployments can select comma-separated roles. The worker consumes ordinary subscriber jobs, and the media role consumes thumbnail jobs. PostgreSQL notifications wake dispatch and SSE after commit. The periodic poll recovers missed notifications.

Run `node apps/server/test/http-smoke.mjs` against a fresh Operations instance. It performs first setup and verifies REST, PAT, and MCP over HTTP. Override the address with `SMARTSELL_SMOKE_URL` and supply `SETUP_TOKEN` for a production-configured fixture.

Run `bash infra/smoke.sh operation` to provision an isolated PostgreSQL 17 container, run the production Operations HTTP smoke, verify login after restart, and execute the PostgreSQL integration tests and direct RLS assertions. It uses the cached PostgreSQL image from `compose.yaml` and discards its temporary data on exit.

Run the integration suite with `pnpm --filter @smartsell/server test`. Set `SMARTSELL_TEST_DATABASE_URL` to an empty, migrated PostgreSQL 17+ fixture using `app_rw` to enable the Operations PostgreSQL, notification, and direct RLS assertions. Configure the legacy PostgreSQL integration tests with `SMARTSELL_TEST_PG_URL`, `SMARTSELL_TEST_PG_ADMIN_URL`, and `SMARTSELL_TEST_PG_BACKGROUND_URL` when testing the isolated background role.
