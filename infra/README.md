# SmartSell deployment

This runbook uses a single host with Node.js 24, pnpm 10.11.0, Docker Compose v2, and a TLS reverse proxy. The API and PostgreSQL publish to host loopback. The reverse proxy serves the static Web build and is the public listener. `infra/compose.yaml` provisions PostgreSQL with `infra/postgres/01-roles.sh`. The optional `server` profile runs the workspace migrations, API and Web service in containers.

## Build and provision PostgreSQL 17

From the repository root, install the locked dependencies and build the Web assets. Keep the installed workspace and source on the API host, which runs TypeScript through `tsx`.

```sh
pnpm install --frozen-lockfile
pnpm build
```

Inject `POSTGRES_PASSWORD`, `SMARTSELL_MIGRATION_PASSWORD`, and `SMARTSELL_RUNTIME_PASSWORD` from your secret manager. For the default `ROLE=all` Commands deployment, also set `SMARTSELL_BACKGROUND_PASSWORD`. Generate a distinct value for each with `openssl rand -hex 32`. Then start the pinned PostgreSQL image with its named data volume.

```sh
docker compose --project-name smartsell -f infra/compose.yaml up --detach --wait postgres
```

`PG_PORT` sets the host-side port and defaults to `5432`. The initialization script runs on an empty volume. It creates `app_owner` for migrations and `app_rw` for API requests. `app_owner` can create schemas in the application database. `app_rw` inherits `smartsell_request` and has no migration or RLS bypass privileges. For an existing or managed PG17 instance, have its administrator apply the role and database grants from `infra/postgres/01-roles.sh` using the target database name and your own secrets.

For a Commands deployment that runs background work, provision its separate database login before applying the domain migrations to an existing volume. API-only deployments can use `ROLE=api` without background credentials when commerce callbacks are unconfigured. See [domain database operations](../packages/db/domain/README.md).

The data volume survives `docker compose down`. Back it up before upgrades. To rotate database passwords on an initialized volume, change the login passwords in PostgreSQL and update the secret manager. Updating the Compose environment alone leaves the existing login passwords intact.

## Migrate and start

Provide these values to their respective commands through the deployment environment. URL-encode any reserved characters in database credentials.

| Variable | Inject into | Value |
| --- | --- | --- |
| `MIGRATION_DATABASE_URL` | Migration job | `postgresql://app_owner:<password>@127.0.0.1:5432/smartsell` |
| `DATABASE_URL` | API process | `postgresql://app_rw:<password>@127.0.0.1:5432/smartsell` |
| `BACKGROUND_DATABASE_URL` | Commands process with worker, scheduler or configured commerce callbacks | `postgresql://app_background:<password>@127.0.0.1:5432/smartsell` |
| `PUBLIC_ORIGIN` | API process | Browser-facing HTTPS origin, such as `https://smartsell.example.com` |
| `APP_SECRET` | API process | Persistent secret generated with `openssl rand -hex 32` |
| `MEDIA_DIRECTORY` | API process | Private, writable directory on persistent storage, such as `/var/lib/smartsell/media` |
| `SETUP_TOKEN` | API process during first setup | Independent secret generated with `openssl rand -hex 32` |
| `HOST`, `PORT` | API process | Default `127.0.0.1` and `3401` |

Run the migration job before starting or upgrading the API. The migration ledgers make repeat runs safe against the same migration files.

```sh
pnpm db:migrate
```

Start the shared API with `NODE_ENV=production pnpm start`. The Commands host mounts the workspace Operations routes against the same session and store. Under a process supervisor, `bash infra/start.sh` starts the same API in production mode and forwards `SIGTERM` directly to Node.

To run standalone Operations on the host, run `pnpm db:migrate:kernel` and start with `NODE_ENV=production pnpm start:kernel`. Commands and standalone Operations use separate storage schemas and independent accounts and sessions.

Build with `pnpm build` and expose the same `apps/web/dist/` used by `pnpm preview` at `PUBLIC_ORIGIN`. The default Web entry is `/` and the linked compatibility workbench is at `/compat/workbench`. Proxy `/api`, `/mcp`, `/oauth`, `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, and `/r/` to the loopback API without rewriting their paths. Preserve the browser `Origin` header, allow streaming responses on enabled streaming endpoints, and fall back to `index.html` for Web routes. Keep the probes on the backend listener for the local supervisor. Set up the initial account in the Web UI at the HTTPS origin. The API accepts the setup token in `x-setup-token` on `POST /api/v1/setup`. Remove `SETUP_TOKEN` and restart after setup.

## Run the API in Compose

To run the API and Web service in Compose, export `POSTGRES_PASSWORD`, `SMARTSELL_MIGRATION_PASSWORD` and `SMARTSELL_RUNTIME_PASSWORD` as separate hex strings. Also export `SMARTSELL_BACKGROUND_PASSWORD` for the default `ROLE=all` deployment. The profile uses the hex passwords directly in its internal connection URLs. Set `PUBLIC_ORIGIN`, `APP_SECRET` and the first-run `SETUP_TOKEN`. Set `PORTAL_ORIGIN` if you use the portal. From the repository root, build the images and wait for the services to become healthy.

```sh
docker compose --project-name smartsell -f infra/compose.yaml --profile server up --detach --build --wait
curl --fail --show-error http://127.0.0.1:3401/readyz
```

Compose runs the core migrations once PostgreSQL is healthy and starts the Commands API when they succeed. `PORT` sets the host-side loopback API port. The `media-data` volume persists uploaded files across container recreations. Back it up along with PostgreSQL. After first setup, remove `SETUP_TOKEN` from the deployment environment and recreate the `server` service.

### Route HTTPS to the Compose Web service

Terminate TLS at the deployment reverse proxy and route only the explicitly configured hosts. Preserve the original `Host` authority, including a nondefault port, and the browser `Origin`. Requests for other hosts should receive a rejection from the TLS listener or an HTTP error from its default virtual host. Keep the Compose ports on loopback.

| External HTTPS origin | Loopback upstream |
| --- | --- |
| `PUBLIC_ORIGIN` | `127.0.0.1:${WEB_PORT:-8080}` |
| `PORTAL_ORIGIN` and each entry in `PORTAL_CUSTOM_ORIGINS` | `127.0.0.1:${PORTAL_PORT:-8081}` |

Set `PORTAL_ORIGIN` to a dedicated default portal origin. The base Compose deployment runs Commands and serves the legacy single portal. For the `/api/v1/portal/` API and branded domains, deploy the standalone [Operations Compose overlay](operations.md#smartsell-operations-api) with its own database volume and accounts.

Set `PORTAL_CUSTOM_ORIGINS` to comma-separated, distinct HTTPS origins without paths or trailing slashes, for example `https://north.example.com,https://south.example.com`. Recreate `server` after changing the list, and bind each listed origin to its workspace through `PUT /api/v1/workspaces/:id/branding` on the Operations workbench. The list can be omitted for a single portal. Set an independent 32-byte hex `PORTAL_ASSERTION_KEY` if using signed portal sign-in assertions. Public operation requires DNS and a trusted TLS certificate covering each configured hostname.

The Web service serves the portal SPA and forwards `/api/v1/portal/` on port 8081 with the original Host and Origin. The Operations API checks the configured origin and its workspace binding. On Commands, the legacy `/api/portal/share` and `/api/portal/creator-submit` POST routes accept the default portal Host and Origin, rewrite the Origin upstream, and drop cookies and authorization headers. When a workbench browser sends an Origin on a session POST, it must match `PUBLIC_ORIGIN`.

With Node v24.21.0, OpenSSL and Docker Compose v2, run `bash tests/acceptance/te06-compose.sh` to exercise the Compose route through a loopback TLS terminator and PostgreSQL. It builds dedicated images, uses generated secrets and ephemeral ports, and checks cleanup on exit.

## Local SQLite preview

With Node.js 24 and the workspace dependencies installed, build the Web assets and start the preview from the repository root. Leave the production database and origin settings unset for this preview.

```sh
pnpm build
SETUP_TOKEN="$(openssl rand -hex 32)"
export SETUP_TOKEN
SMARTSELL_DATA_FILE=.local/smartsell.sqlite pnpm preview
```

Open `http://127.0.0.1:4173` and enter the generated token in the setup form, or run this curl request from a shell with the same `SETUP_TOKEN`. These credentials are for a disposable local workspace.

```sh
curl --fail-with-body --show-error http://127.0.0.1:4173/api/v1/setup \
  -H 'Origin: http://127.0.0.1:4173' \
  -H 'Content-Type: application/json' \
  -H "x-setup-token: $SETUP_TOKEN" \
  --data '{"email":"local@example.invalid","password":"local-preview-only","name":"Local Admin","workspaceName":"Local Preview"}'
```

Successful setup returns `201`. Stop the preview, unset `SETUP_TOKEN`, and restart with the same SQLite file to continue using the workspace.

## Health and offline smoke

Run probes against the loopback API listener. `/healthz` is process liveness. `/readyz` checks the migrated database and request role and returns `503` on failure after the server has started.

```sh
curl --fail --show-error http://127.0.0.1:3401/healthz
curl --fail --show-error http://127.0.0.1:3401/readyz
```

With the locked dependencies installed and the exact PostgreSQL image from `infra/compose.yaml` cached in Docker, run `bash infra/smoke.sh`. It uses `--pull never`, disposable credentials, a unique Compose project, and temporary loopback ports. It checks repeatable migrations, runtime role privileges, first setup, login after API restart with the setup token removed, secure session cookies, the Web operation catalog, and authenticated workspace access. It also stops PostgreSQL to check that readiness returns `503` while liveness remains healthy. It deletes its own database volume at exit. The smoke talks directly to the loopback backend and does not exercise the TLS proxy or browser. CI prepares the image on its runner and executes the same smoke script alongside `pnpm verify`.
