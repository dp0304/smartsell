# SmartSell

SmartSell 是社群電商營運工作台。REST 與 MCP 的介面以 `plan.md` §4.12–4.13 及 `@smartsell/contracts` 的 `Operation` 為準。REST 基底為 `/api/v1`，工作區資源走 `/api/v1/workspaces/{workspaceId}/…`，MCP 使用 `/mcp`。

## 本機開發與首次設定

安裝 Node.js 24 與 pnpm 10.11.0。在已安裝 nvm 的機器上可從專案根目錄執行以下指令。

```sh
nvm install
nvm use
node --version
pnpm --version
pnpm install --frozen-lockfile
```

根目錄的 `pnpm-lock.yaml` 管理所有 workspace 依賴。若透過 Corepack 管理 pnpm，可先執行 `corepack enable pnpm`。本機啟動時，API 預設監聽 `127.0.0.1:3401`，Web 預設監聽 `127.0.0.1:5173`，並以相同來源代理 `/api` 與 `/mcp`。未設定 `DATABASE_URL` 時，本機 API 使用 `.local/smartsell.sqlite` 保存狀態。

本機預覽可在專案的終端建立第一個工作區。依提示輸入電郵、名稱及密碼後，再啟動工作台。這個流程只操作本機開發用的 SQLite，已建立的工作區可以直接登入。

```sh
pnpm setup:local
pnpm dev
```

也可以使用瀏覽器的「首次設定」頁。啟動前在同一個終端產生設定權杖。在 macOS 上可用 `printf %s "$SETUP_TOKEN" | pbcopy` 把權杖貼入設定頁。

```sh
export SETUP_TOKEN="$(openssl rand -hex 32)"
pnpm dev
```

首次設定端點使用 `X-Setup-Token`。在另一個終端的執行環境注入與伺服器相同的 `SETUP_TOKEN`，以及 `OWNER_EMAIL`、`OWNER_PASSWORD`（至少 12 個字元）、`OWNER_NAME`、`WORKSPACE_NAME`，再從根目錄執行下列指令。正式環境可將 `SETUP_ORIGIN` 設為部署的 HTTPS 來源。

```sh
node --input-type=module <<'JS'
const { SETUP_TOKEN, OWNER_EMAIL, OWNER_PASSWORD, OWNER_NAME, WORKSPACE_NAME } = process.env;
if (![SETUP_TOKEN, OWNER_EMAIL, OWNER_PASSWORD, OWNER_NAME, WORKSPACE_NAME].every(Boolean)) {
  throw new Error('Missing setup environment variables');
}
const origin = new URL(process.env.SETUP_ORIGIN ?? 'http://127.0.0.1:5173').origin;
const response = await fetch(`${origin}/api/v1/setup`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Setup-Token': SETUP_TOKEN, Origin: origin },
  body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD, name: OWNER_NAME, workspaceName: WORKSPACE_NAME }),
});
if (!response.ok) throw new Error(`Setup failed (HTTP ${response.status})`);
console.log('Setup complete');
JS
```

首次設定成功後，開啟 `http://127.0.0.1:5173` 並以建立的帳號登入。設定權杖僅用於初始化空白環境，完成後可從伺服器環境移除並重新啟動。

若需要調整監聽位址，`--host` 與 `--port` 控制 Web，`HOST` 與 `PORT` 控制 API。`DEV_ORIGINS` 可加入瀏覽器實際使用的來源，多個來源以逗號分隔。停止根指令會一併停止 API 和 Web。

```sh
PORT=3402 pnpm dev --host 127.0.0.1 --port 5180
pnpm build
PORT=3402 pnpm preview --host 127.0.0.1 --port 4180
```

`pnpm preview` 使用已建置的 Web 靜態產物並同時啟動 API，預設 Web 連接埠為 4173。Web 的預設入口是 `/`，兼容工作台位於 `/compat/workbench`。兩個入口互相連結並使用同一組登入和工作區。Commands 與 Operations 各自使用其業務資料模型，部分記錄不會在兩個介面間同步顯示。Team 管理範本使用 `/team/templates`，Asset 範本使用 `/templates`。可從該工作區的 `/catalog` 查詢角色可用的路徑。

獨立 Operation 核心的 TOTP 與 SaaS 企業身分設定請參閱 [Operation 身分驗證](docs/identity-operation.md)。

## 驗證

| 指令 | 用途 |
| --- | --- |
| `pnpm requirements` | 檢查需求與證據索引 |
| `pnpm typecheck` | 檢查工作區的 TypeScript 程式、測試與設定 |
| `pnpm test` | 發現並執行 Node Test Runner、Vitest 與 Playwright 測試 |
| `pnpm test -- contracts` | 依檔案路徑篩選測試 |
| `pnpm build` | 完整型別檢查後執行各 workspace 的建置，Web 產物位於 `apps/web/dist` |
| `pnpm verify` | 執行需求檢查、建置和測試。Playwright 使用與 `pnpm preview` 相同的 Web 產物，與 GitHub Actions 一致 |

首次執行 Playwright 測試前，先用 `pnpm exec playwright install chromium` 安裝 Chromium。CI 使用 `--with-deps` 一併安裝 Linux 系統依賴。

## 部署

1. 在建置環境執行 `pnpm install --frozen-lockfile` 與 `pnpm build`。
2. 準備 PostgreSQL 17 或以上版本，以及獨立遷移和執行帳號。由資料庫管理員先建好遷移所用的 `app_owner` 與執行所用的 `app_rw` 登入角色。授予 `app_owner` 在目標資料庫建立 schema 的權限。`app_rw` 不可為 superuser、具備 `BYPASSRLS` 或繼承 `app_owner`。注入連到遷移角色的 `MIGRATION_DATABASE_URL`，在根目錄執行 `pnpm db:migrate`。現行遷移來源為 `packages/db/sql/`。
3. 在服務環境注入 `NODE_ENV=production`、`DATABASE_URL`、HTTPS 的 `PUBLIC_ORIGIN`，以及以 `openssl rand -hex 32` 產生的 `APP_SECRET`。`PUBLIC_ORIGIN` 請使用瀏覽器可存取的對外來源。服務執行時需要工作區原始碼及已安裝的執行依賴。使用 `pnpm start` 啟動與 `pnpm dev`、`pnpm preview` 和 Compose 相同的 Commands API，並在同一工作區掛接 Operations。
4. 透過反向代理或靜態檔案服務提供 `apps/web/dist`，並將同來源的 `/api` 及 `/mcp` 轉給 API。單頁應用程式的其他路徑回退到 `index.html`。前置代理終結 TLS 時應保留請求來源資訊。
5. 首次建立管理員時另行注入獨立產生的 `SETUP_TOKEN`，完成後移除並重新啟動。透過部署環境的祕密管理設定資料庫 URL、權杖與密鑰，避免寫入版本庫或前端建置變數。
