# SmartSell

SmartSell 第 1 階段給一人經營的跨境賣家用：家裡一台電腦當**中樞**（經 Tailscale 提供 `https://<中樞>.ts.net`），要發文的每台電腦各跑一個 **SmartSell Worker**；筆電上的 **Codex 或 Claude Code** 透過 MCP 上傳影片、排程貼文、查回結果，不必手動輸入。**網頁是給人看現況與做決定的地方**：今日、機器、帳號、日曆、貼文與通知。第 1 階段的設計與介面以 [`docs/restructure/phase1-design.md`](docs/restructure/phase1-design.md) 為準（附錄 E 的 lead 決定優先）。

第 1 階段由 Worker 在每個帳號自己的 Chrome profile 發到 **X** 與 **TikTok**。每個帳號的核准方式是「Codex 說要發就直接發」或「要我在網頁按核准」；Worker 只在那個帳號記錄過代按發布的風險確認後才自己按「發布」，否則到點由主人在那台機器上自己按。結果不明的貼文絕不自動重發，要主人到貼文頁確認。

## 第 1 階段怎麼用

1. **安裝中樞**：在當中樞的電腦照 [中樞安裝與維護](docs/hub-setup.md) 執行安裝腳本、`pnpm hub:init` 與 `pnpm hub:service install`，再開啟印出的設定網址建立擁有者。之後的設定都在網頁的「開始設定」精靈。
2. **配對機器**：在每台要發文的電腦（例如 Mac-B、Win-C）加入同一個 tailnet，從「開始設定 → 下載 SmartSell Worker」安裝 Worker，貼上中樞位址、取名，在那台電腦的瀏覽器登入中樞並按「核准」。配對只在要配對的那台電腦上完成。
3. **新增帳號**：在那台電腦的 Worker 按「新增帳號」，選 X 或 TikTok，在跳出的 Chrome 視窗自己登入（驗證碼與二次驗證由你完成），確認加入。到網頁的帳號頁完成就緒清單：核准方式（「Codex 說要發就直接發」或「要我在網頁按核准」）、代按發布的風險確認（或「我自己按發布」）、TikTok 預設選項、試跑。
4. **連接 Codex 或 Claude Code**（二擇一）：
   - 筆電安裝同一個 Worker App，首次開啟選「這台是我的筆電（只連 Codex，不發文）」，按「連接 Codex／Claude Code」。App 會寫好 MCP 設定，也會在 Codex 關閉後接手還沒傳完的上傳。
   - 沒有 App 時用 Node relay：在網頁 Agent 頁按「建立連線並下載權杖檔」，把檔案存成 `~/.smartsell/token`（權限 600），然後：

     ```sh
     curl -fsSL https://<中樞>/agent/relay.mjs -o ~/.smartsell/relay.mjs
     codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub https://<中樞> --token-file ~/.smartsell/token
     # Claude Code：claude mcp add --scope user smartsell -- node ~/.smartsell/relay.mjs --hub https://<中樞> --token-file ~/.smartsell/token
     ```

5. **確認連上**：完整重開 Codex 或 Claude Code，請它呼叫一次 SmartSell 的工具（例如 `smartsell_overview`）。任何一次成功的呼叫都算驗證；回到網頁，「開始設定」的 Codex 步驟會顯示「已有 Agent 透過 MCP 呼叫過 SmartSell。」。
6. **直接交代工作**：例如「把 ~/Movies/video.mp4 明天 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok」。Agent 會依伺服器說明呼叫工具，回報每則貼文的當地時間、機器、狀態與網址；核准、代按發布的風險、恢復暫停與確認結果都留給你在網頁上做。

Agent 看得到的工具只有 11 個：`smartsell_overview`、`machines_list`、`channels_list`、`channel_check`、`media_upload`、`post_schedule`、`post_update`、`posts_list`、`post_get`、`task_get`、`publishing_pause`。媒體檔由本機的 relay 分段上傳（SHA-256 校驗、可續傳），不經過模型。不需要修改 `AGENTS.md`；想把規則放進專案時，用 [Agent 工作指南](docs/agent-guide.md) 的第 1 階段一節。

### 選用：在專案安裝 Agent Skills

Worker 安裝包附有三份 Skills，只使用上面 11 個工具：`smartsell-video-publish`（上傳、排程、查回）、`smartsell-data-collection`（帳號狀態與 SmartSell 的貼文；第 1 階段不讀平台成效）、`smartsell-product-listing`（如實說明第 1 階段不管理商品與店鋪）。使用 Node.js 24，在 SmartSell 原始碼根目錄執行以下指令，裝到指定專案的 `.claude/skills/` 與 `.agents/skills/`；同名的既有 Skills 會保留。

```sh
pnpm --filter @smartsell/connector-desktop build
node apps/connector-desktop/dist/smartsell-install-skills.mjs /path/to/ops-project
```

已下載 Worker 的使用者也可以直接執行安裝包內的 `resources/app.asar.unpacked/dist/smartsell-install-skills.mjs`。macOS 的資源目錄是 `.app/Contents/Resources`。舊版安裝過的同名 Skills 不會被覆蓋，要先刪除專案內那三個資料夾再安裝。

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

執行 `pnpm dev` 或 `pnpm preview` 後，使用本機 Web 網址開啟「首次設定」。當 Web 和 API 都只監聽回環位址，且請求符合伺服器信任的本機 Host 和 Origin 時，首次註冊可輸入使用者名稱和至少 6 個字元的密碼（可以全為數字）。若設定了 `SETUP_TOKEN`，還須提供初始設定權杖。註冊會建立第一位擁有者及預設的 SmartSell 工作區。對外部署的首次註冊及成員邀請仍要求至少 12 個字元。後續以同一個使用者名稱登入，既有帳號仍可使用電郵。使用者名稱不分大小寫，支援 Unicode 字母與數字，也可在首字元之後使用 `.`、`_`、`-`。

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

獨立 Operation 核心的 TOTP 與 SaaS 企業身分設定請參閱 [Operation 身分驗證](docs/identity-operation.md)。

## 桌面 Worker 下載

Worker 安裝包以 `pnpm worker:release` 建置（macOS 上產生 mac-arm64 與 mac-x64，Windows 上加 `--win` 產生 win-x64），輸出到 `dist/worker-release/`，連同 `latest-<platform>.json` 放進中樞的 `worker-downloads/` 後即可下載；步驟見 [中樞安裝與維護](docs/hub-setup.md) 第 4 節。登入後可從「開始設定 → 下載 SmartSell Worker」下載，或開啟同站的 `/api/v1/worker-downloads/<platform>`。舊的 `pnpm package:worker-download` 已移除。

正式部署可將 `SMARTSELL_WORKER_DOWNLOAD_DIR` 指向由部署人員管理、應用程式唯讀的目錄，放入已交付的安裝包。支援 `SmartSell-Worker-mac-arm64.zip`、`SmartSell-Worker-mac-x64.zip` 和 `SmartSell-Worker-win-x64.exe`。使用 Compose 時，在 `server` 服務的 override 設定此環境變數，並以 `:ro` 掛載安裝包目錄。登入後呼叫 `GET /api/v1/worker-downloads` 可取得實際可下載的清單。跨機配對時，桌面程式需要能連到工作台的 HTTPS 網址。

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

## 進階：第 2 階段之前保留的舊功能

以下功能不在第 1 階段的流程中，只為既有資料與除錯保留，第 2 階段整理或移除。第 1 階段的 Agent 連線不會列出這裡提到的舊工具（`smartsell_operations_describe`、`smartsell_operation_call`、`publishing_*`、`worker_social_status_*` 等），請不要照這些段落操作第 1 階段的貼文。

### 舊的錄入式工作台與提示詞接入

- 舊的錄入式工作台在 `/w/:ws`，網頁「設定 → 進階工作台」可以進入；導覽中的其他模組要按「顯示其他模組」才會出現。
- 「開始設定」與 Agent 頁的「進階：舊的接入方式（提示詞）」會產生一段終端機指令，以 Python relay 建立連線（需要 Python 3.9 以上）。完成後同樣以任何一次成功的工具呼叫（例如 `smartsell_overview`）驗證。Codex 的提示詞也會在 `CODEX_HOME/AGENTS.md` 寫入「SmartSell managed social routing」區塊，把社媒狀態的問題導向 `smartsell_overview`、`channels_list`、`channel_check`、`posts_list` 與 `post_get`；上一版的區塊會原地升級，手動改過的區塊會保留原文。

### 舊的單一商品跨平台發布

按商品和目標市場整理各社群渠道的文案與素材版本。為每則貼文選定發布帳號和排程時區，將指定版本與排程送審，由營運人員核准。

抖音和小紅書的影片目前可透過人工交接流程送審。核准後，由接手的營運人員到平台創作者後台核對帳號與核准版本，發布後登記 HTTPS 作品連結，以及平台提供的貼文 ID（如有）。Facebook、Instagram、YouTube 等平台可由已啟用的官方整合提交，前提是帳號已授權、內容格式符合該平台整合的要求。

平台受理或已排程後，仍須到平台確認作品已上線，才能記為已發布。若提交時斷線、結果不明，先沿用原任務核對平台狀態，確認原提交未發布且不會再發布後才重試。詳見[發布執行與結果核對](apps/server/src/modules/execution/README.md)。

### 舊的多人部署（PostgreSQL）

第 1 階段的中樞是單一程序與 SQLite，請照 [中樞安裝與維護](docs/hub-setup.md)。以下是舊的多人部署方式。

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
