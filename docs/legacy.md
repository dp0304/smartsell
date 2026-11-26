# 舊版部署與工作台

這份文件收錄第 2 階段之前保留的舊功能與舊的部署方式。第 1 階段的流程請看根目錄的 [README](../README.md)；第 1 階段的 Agent 連線不會列出這裡提到的舊工具，請不要照這些段落操作第 1 階段的貼文。

## 其他首次設定方式

`pnpm setup:local` 仍可用於在終端以電郵和至少 6 個字元的密碼建立第一個本機 SQLite 工作區。獨立啟動的 Commands API 或 Operation 核心若需要本機瀏覽器首次設定，須明確設定 `SMARTSELL_LOCAL_SETUP=1`，並使用相同的回環 Host 與 HTTP Origin。對外提供服務或使用反向代理發佈時請使用 `SETUP_TOKEN`。`pnpm dev` 與 `pnpm preview` 可用 `SMARTSELL_LOCAL_SETUP=0` 停用本機首次註冊。只要伺服器設定了 `SETUP_TOKEN`，首次設定就必須帶上該權杖。

`GET /api/v1/setup/status` 回傳 `data.initialized`、`data.token_required`、`data.registration_enabled` 和 `data.password_min_length`。本機瀏覽器以 `{username, password}` 呼叫 `POST /api/v1/setup`，成功時會取得正常的登入 Cookie。`POST /api/v1/session` 和 `POST /api/v1/login` 接受同一組欄位，也保留 `email` 登入欄位。使用者名稱帳號的 `session.user` 包含 `username` 和可用於顯示的 `name`，沒有電郵時 `email` 為空字串。

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

首次設定成功後，開啟 Web 並以建立的帳號登入。設定權杖僅用於初始化空白環境，完成後可從伺服器環境移除並重新啟動。Commands 的 PostgreSQL 部署需先套用 `112_bootstrap_username.sql` 和 `113_session_user_profile.sql`。

若需要調整監聽位址，`--host` 與 `--port` 控制 Web，`HOST` 與 `PORT` 控制 API。`DEV_ORIGINS` 可加入瀏覽器實際使用的來源，多個來源以逗號分隔。停止根指令會一併停止 API 和 Web。

```sh
PORT=3402 pnpm dev --host 127.0.0.1 --port 5180
pnpm build
PORT=3402 pnpm preview --host 127.0.0.1 --port 4180
```

`pnpm preview` 使用已建置的 Web 靜態產物並同時啟動 API，預設 Web 連接埠為 4173。Web 的預設入口是 `/`，兼容工作台位於 `/compat/workbench`。兩個入口互相連結並使用同一組登入和工作區。Commands 與 Operations 各自使用其業務資料模型，部分記錄不會在兩個介面間同步顯示。Team 管理範本使用 `/team/templates`，Asset 範本使用 `/templates`。可從該工作區的 `/catalog` 查詢角色可用的路徑。

獨立 Operation 核心的 TOTP 與 SaaS 企業身分設定請參閱 [Operation 身分驗證](identity-operation.md)。

## 第 2 階段之前保留的舊功能

以下功能不在第 1 階段的流程中，只為既有資料與除錯保留，第 2 階段整理或移除。第 1 階段的 Agent 連線不會列出這裡提到的舊工具（`smartsell_operations_describe`、`smartsell_operation_call`、`publishing_*`、`worker_social_status_*` 等），請不要照這些段落操作第 1 階段的貼文。

### 舊的錄入式工作台與提示詞接入

- 舊的錄入式工作台在 `/w/:ws`，網頁「設定 → 進階工作台」可以進入；導覽中的其他模組要按「顯示其他模組」才會出現。
- 「開始設定」與 Agent 頁的「進階：舊的接入方式（提示詞）」會產生一段終端機指令，以 Python relay 建立連線（需要 Python 3.9 以上）。完成後同樣以任何一次成功的工具呼叫（例如 `smartsell_overview`）驗證。Codex 的提示詞也會在 `CODEX_HOME/AGENTS.md` 寫入「SmartSell managed social routing」區塊，把社媒狀態的問題導向 `smartsell_overview`、`channels_list`、`channel_check`、`posts_list` 與 `post_get`；上一版的區塊會原地升級，手動改過的區塊會保留原文。

### 舊的單一商品跨平台發布

按商品和目標市場整理各社群渠道的文案與素材版本。為每則貼文選定發布帳號和排程時區，將指定版本與排程送審，由營運人員核准。

抖音和小紅書的影片目前可透過人工交接流程送審。核准後，由接手的營運人員到平台創作者後台核對帳號與核准版本，發布後登記 HTTPS 作品連結，以及平台提供的貼文 ID（如有）。Facebook、Instagram、YouTube 等平台可由已啟用的官方整合提交，前提是帳號已授權、內容格式符合該平台整合的要求。

平台受理或已排程後，仍須到平台確認作品已上線，才能記為已發布。若提交時斷線、結果不明，先沿用原任務核對平台狀態，確認原提交未發布且不會再發布後才重試。詳見[發布執行與結果核對](../apps/server/src/modules/execution/README.md)。

### 舊的多人部署（PostgreSQL）

第 1 階段的中樞是單一程序與 SQLite，請照 [中樞安裝與維護](hub-setup.md)。以下是舊的多人部署方式。

1. 在建置環境執行 `pnpm install --frozen-lockfile` 與 `pnpm build`。
2. 準備 PostgreSQL 17 或以上版本，以及獨立遷移和執行帳號。由資料庫管理員先建好遷移所用的 `app_owner` 與執行所用的 `app_rw` 登入角色。授予 `app_owner` 在目標資料庫建立 schema 的權限。`app_rw` 不可為 superuser、具備 `BYPASSRLS` 或繼承 `app_owner`。注入連到遷移角色的 `MIGRATION_DATABASE_URL`，在根目錄執行 `pnpm db:migrate`。Commands 遷移來源為 `packages/db/migrations/` 和 `packages/db/domain/`。
3. 在服務環境注入 `NODE_ENV=production`、`DATABASE_URL`、HTTPS 的 `PUBLIC_ORIGIN`，以及以 `openssl rand -hex 32` 產生的 `APP_SECRET`。`PUBLIC_ORIGIN` 請使用瀏覽器可存取的對外來源。服務執行時需要工作區原始碼及已安裝的執行依賴。使用 `pnpm start` 啟動與 `pnpm dev`、`pnpm preview` 和 Compose 相同的 Commands API，並在同一工作區掛接 Operations。
4. 透過反向代理或靜態檔案服務提供 `apps/web/dist`，並將同來源的 `/api` 及 `/mcp` 轉給 API。單頁應用程式的其他路徑回退到 `index.html`。前置代理終結 TLS 時應保留請求來源資訊。
5. 首次建立管理員時另行注入獨立產生的 `SETUP_TOKEN`，完成後移除並重新啟動。透過部署環境的祕密管理設定資料庫 URL、權杖與密鑰，避免寫入版本庫或前端建置變數。

### 舊的示範資料

`pnpm seed:demo` 在本機開發伺服器建立示範品牌「Glow Lab 光研」，並完整走一遍 Agent 路徑：先以人的身分登入並建立 Agent 連線（標籤「示範資料 Agent」），之後所有錄入都由 Agent 透過 `/mcp` 完成，包括品牌與台灣、香港、美國三個市場，檔案匯入型店鋪與 6 個保養品（含低庫存、缺貨與未採集的市場），兩個推廣計劃（進行中與即將開始），內容、修訂、未來與過去 14 天的排期與送審，約 20 則既有貼文與每日成效匯入，以及投放帳戶、成效與投放方案。只有人能做的事由人以 REST 完成：登記自有社群帳號、核准發布、登記已發布的貼文，以及交辦任務給 Agent。

```sh
pnpm dev
pnpm seed:demo
pnpm seed:demo --origin http://127.0.0.1:5173 --email owner@example.com
```

密碼依序取自 `--password`、`SMARTSELL_SEED_PASSWORD`，或 `.local/dev-credentials.txt`（`email=…`、`password=…`）。品牌代號已存在時腳本不做任何變更；可用 `--slug` 另建一份。每個寫入都帶冪等鍵，已完成的步驟記在 `.local/seed-demo.<slug>.json`（權限 600，內含 Agent 權杖），中斷後重跑會從中斷處接續。執行結束會列出各檢視端點的筆數、Agent 被拒的操作與 `/app` 網址；權杖只顯示遮罩後的前綴。

