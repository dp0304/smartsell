# SmartSell

SmartSell 是社群電商營運工作台。REST 與 MCP 的介面以 `plan.md` §4.12–4.13 及 `@smartsell/contracts` 的 `Operation` 為準。REST 基底為 `/api/v1`，工作區資源走 `/api/v1/workspaces/{workspaceId}/…`，MCP 使用 `/mcp`。

## 產品怎麼用

SmartSell 的錄入與提交交給**使用者電腦上的 Agent**（Claude Code 或 Codex），透過 MCP 連到 SmartSell；**Web 是給人看現況與做決定的看板**。

- 看板：登入後的預設入口 `/app/:ws`，包含總覽、商品、推廣計劃、日曆、社媒成效、投放、待你決定、Agent、設定。
- 人只做 Agent 不被允許的事：在「待你決定」核准或退回、緊急暫停與解除、登記自有社群帳號、連接與撤銷 Agent。
- 進階工作台：舊的錄入式工作台保留在 `/w/:ws`，只在 Agent 不可用時使用。

連接 Agent：在 Web 的「Agent」頁按「產生連線權杖」，複製畫面上的指令（權杖只顯示一次，預設 90 天，可隨時撤銷）。Claude Code：

```sh
export SMARTSELL_TOKEN=<權杖>
claude mcp add --transport http smartsell <你的網址>/mcp --scope user --header "Authorization: Bearer $SMARTSELL_TOKEN"
```

Codex（`~/.codex/config.toml`）：

```toml
[mcp_servers.smartsell]
url = "<你的網址>/mcp"
bearer_token_env_var = "SMARTSELL_TOKEN"
```

把 `docs/agent-guide.md` 放進專案的 `AGENTS.md`／`CLAUDE.md`（或從 Agent 頁下載），Agent 就知道怎麼匯入商品、建推廣計劃、寫內容、排期送審與匯入成效。設計與介面契約見 `docs/agent-first-design.md`。

## 管理單一商品的跨平台發布

按商品和目標市場整理各社群渠道的文案與素材版本。為每則貼文選定發布帳號和排程時區，將指定版本與排程送審，由營運人員核准。

抖音和小紅書的影片目前可透過人工交接流程送審。核准後，由接手的營運人員到平台創作者後台核對帳號與核准版本，發布後登記 HTTPS 作品連結，以及平台提供的貼文 ID（如有）。Facebook、Instagram、YouTube 等平台可由已啟用的官方整合提交，前提是帳號已授權、內容格式符合該平台整合的要求。

平台受理或已排程後，仍須到平台確認作品已上線，才能記為已發布。若提交時斷線、結果不明，先沿用原任務核對平台狀態，確認原提交未發布且不會再發布後才重試。詳見[發布執行與結果核對](apps/server/src/modules/execution/README.md)。

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

## 示範資料

`pnpm seed:demo` 在本機開發伺服器建立示範品牌「Glow Lab 光研」，並完整走一遍 Agent 路徑：先以人的身分登入並建立 Agent 連線（標籤「示範資料 Agent」），之後所有錄入都由 Agent 透過 `/mcp` 完成，包括品牌與台灣、香港、美國三個市場，檔案匯入型店鋪與 6 個保養品（含低庫存、缺貨與未採集的市場），兩個推廣計劃（進行中與即將開始），內容、修訂、未來與過去 14 天的排期與送審，約 20 則既有貼文與每日成效匯入，以及投放帳戶、成效與投放方案。只有人能做的事由人以 REST 完成：登記自有社群帳號、核准發布、登記已發布的貼文，以及交辦任務給 Agent。

```sh
pnpm dev
pnpm seed:demo
pnpm seed:demo --origin http://127.0.0.1:5173 --email owner@example.com
```

密碼依序取自 `--password`、`SMARTSELL_SEED_PASSWORD`，或 `.local/dev-credentials.txt`（`email=…`、`password=…`）。品牌代號已存在時腳本不做任何變更；可用 `--slug` 另建一份。每個寫入都帶冪等鍵，已完成的步驟記在 `.local/seed-demo.<slug>.json`（權限 600，內含 Agent 權杖），中斷後重跑會從中斷處接續。執行結束會列出各檢視端點的筆數、Agent 被拒的操作與 `/app` 網址；權杖只顯示遮罩後的前綴。
