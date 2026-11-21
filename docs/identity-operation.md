# Operation 身分驗證

本機使用 `pnpm --filter @smartsell/server dev:kernel` 啟動獨立 Operation API，並在另一個終端執行 `SMARTSELL_API_TARGET=http://127.0.0.1:3401 pnpm --filter @smartsell/web dev`。從工作區的「帳號安全」設定驗證器，完成確認後保存一次性復原碼。檔案模式使用 `.local/smartsell.json` 與同路徑的 `.identity-key`，備份與還原時應一起處理。

正式環境先執行 `pnpm db:migrate:kernel`，再以 `NODE_ENV=production pnpm start:kernel` 啟動。Operation 與 Commands 相容服務各自使用自己的帳號和會話資料。使用 PostgreSQL 時，所有 Operation API 副本都應使用相同的 `IDENTITY_ENCRYPTION_KEY`（32 位元組十六進位）。正式環境未設定時沿用 `APP_SECRET`，開發 PostgreSQL 則須設定獨立密鑰。

## SaaS 連線

`SMARTSELL_IDENTITY_DEPLOYMENT` 預設為 `private`，提供帳密與 TOTP。使用 HTTPS 的 `PUBLIC_ORIGIN` 並設定 `SMARTSELL_IDENTITY_DEPLOYMENT=saas` 後，可啟用 OIDC、SAML 與 SCIM。

使用與服務相同的資料庫、來源及加密密鑰設定後，在 `apps/server` 執行 `pnpm identity:configure /absolute/path/to/connection.json`。JSON 檔須包含 `tenantId`、`workspaceId`、`connectionId` 和正整數 `seatLimit`。操作人員可從 `smartsell.identity` 的 `workspace/<workspaceId>` 記錄取得 `tenantId`。

- OIDC 設 `protocol` 為 `oidc`，填入 `issuer`、`authorizationEndpoint`、`tokenEndpoint`、`jwksUri`、`clientId`、`signingAlgorithm`（`RS256`、`PS256` 或 `ES256`）及選填的 `clientSecret`。正式部署的權杖與 JWKS 端點須以 HTTPS 提供並解析到公開 IPv4 位址。
- SAML 設 `protocol` 為 `saml`，填入 `issuer`、`entryPoint`、`entityId`、`idpCert`、`nameIdFormat`，以及選填的 `requestSigningKey`。使用持久 NameID，並讓 IdP 簽署回應與 assertion。
- SCIM 使用 `scimTokenHash`，值為高熵 Bearer 權杖的 SHA-256 十六進位摘要。IdP 的 SCIM 基底是 `/api/v1/scim/<tenantId>/<connectionId>/v2`。使用者的 `externalId` 必須與 OIDC `sub` 或 SAML 持久 NameID 相同。

使用者由同源表單向 `/api/v1/auth/sso/<tenantId>/<connectionId>/<oidc|saml>/start` 提交 `POST`。將同一路徑的 `/start` 換成 `/callback`，即可得到 IdP 設定所需的回呼地址。SCIM 停用或移除使用者時，該租戶的會話、PAT、OAuth grant 及待交換授權碼會一併撤銷。用 `protocol: "disabled"` 和連線識別值可停用新的 SSO 與 SCIM 請求。

## 本機驗證

執行 `node --import tsx --test tests/identity/identity.test.ts tests/identity/http.test.ts`。若要執行正式 PostgreSQL 的雙進程用例，將 `IDENTITY_KERNEL_TEST_DATABASE_URL` 指向已完成 kernel 遷移且尚未 setup 的一次性資料庫。用例會在此資料庫建立帳號與驗證狀態。
