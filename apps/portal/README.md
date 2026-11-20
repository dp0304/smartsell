# SmartSell desktop portal

The standalone desktop portal serves `index.html` at `/`, `/s/:id`, and `/invite/:id`, and serves `src/` as static assets. It needs no build step or external assets. The minimum supported width is 1280 CSS pixels. The interface supports Traditional Chinese and English.

Route only `/api/v1/portal/*` to `createPortalHandler` on this origin. Give portal identity its own host-only session, and serve the HTML with `Cache-Control: no-store`, `Referrer-Policy: no-referrer`, and `X-Frame-Options: DENY`. Configure a same-origin portal sign-in URL in the `portal-login` meta tag. The sign-in page uses a validated local `return_to` value and preserves the invitation fragment client-side through sign-in. Anonymous `/s/:id#<token>` reads omit cookies and carry the proof in `Authorization`. The browser clears the fragment from the address bar after capturing it in memory. Opening the original link again restores access on reload. Keep credential headers and invitation bodies out of logs. See the team integration notes for the server hooks.

## Legacy collaboration app

The separate `collaboration.html` entry point uses workspace sessions and the routes below. If enabled, host it on the trusted workbench origin. The isolated client portal origin proxies only its portal API and authentication routes.

| Browser path | Same-origin API |
| --- | --- |
| `/` | `GET`, `POST` and `DELETE /api/v1/session` restore, open and close the workspace session. |
| `/` | `GET /api/v1/workspaces/:wid/commands` determines which team commands to display. `POST /api/v1/workspaces/:wid/commands/team/:action` runs a command with an idempotency key. The `list_board` command reads tasks, deliveries and shares. |
| `/` | `POST /api/portal/share-token` issues a signed capability for an existing share. The UI builds `/share#<token>` on the portal origin. |
| `/share#<token>` | `POST /api/portal/share` opens the pinned delivery and sends permitted comments or review decisions. The fragment token is sent in the JSON request body. |
| `/creator#<token>` | `POST /api/portal/creator-submit` accepts `{token,post_url}` and returns `{data:{accepted:true}}`. |

The selected workspace comes from the authenticated session response. The API authorizes every workspace read and mutation. The portal sends the session's `csrf_token` as `X-CSRF-Token` on authenticated mutations when present. For signed shares, the server authorizes access and each action using the capability, and the portal only displays the details returned by the signed endpoint.

## Serve with a same-origin proxy

Example Caddy configuration run from the repository root with the SmartSell API running on port `3401`. Add `http://127.0.0.1:4175` to the API's `DEV_ORIGINS` for local development. Configure the corresponding trusted HTTPS origin in deployment.

```caddyfile
http://127.0.0.1:4175 {
    root * ./apps/portal
    header {
        Referrer-Policy no-referrer
        X-Content-Type-Options nosniff
        X-Frame-Options DENY
        Cache-Control no-store
    }
    @portalApi path /api/v1/session /api/v1/workspaces/* /api/portal/share /api/portal/share-token /api/portal/creator-submit
    handle @portalApi {
        reverse_proxy 127.0.0.1:3401
    }
    @pages path / /share /share/ /creator /creator/
    handle @pages {
        rewrite * /collaboration.html
        file_server
    }
    handle /assets/* {
        file_server
    }
    handle {
        respond 404
    }
}
```

Open `http://127.0.0.1:4175/` and use a test account initialized on the local API. To exercise the share flow, create and publish a delivery, preview it, create a share, and generate a link. Open that link in a separate guest window and submit only the actions granted during share creation. Keep credentials, request bodies and capability links out of proxy logs.
