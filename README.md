# SmartSell

[English](README.en.md)

讓你自己電腦上的 AI 助手（Codex、Claude Code、WorkBuddy）指揮你的好幾台電腦，**在你自己平常用、已經登入的 Chrome 裡**替你發社群貼文，結果自動回報。網頁讓你看現況、做決定：今天要你處理什麼、每台機器與每個帳號的狀態、日曆與每則貼文的結果。

**給誰用：**一個人或小團隊經營的跨境賣家與創作者，有好幾個社群帳號、分散在好幾台電腦上，想用一句話交代「把這支影片明天 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok」，而不是一個一個後台手動上傳。

**第 1 階段能做的：**X 與 TikTok 的影片貼文排程、到點在綁定的那台電腦發出、把貼文網址讀回來；每個帳號可設「Agent 說要發就直接發」或「要我在網頁按核准」；沒登入、驗證碼、二次驗證一律停下來通知你，結果不明的貼文絕不自動重發。

```
你的筆電：Codex／Claude Code／WorkBuddy ──MCP──▶ 中樞（家裡常開的電腦，經 Tailscale）
                                                   │  帳號綁哪台機器就派給哪台
                                  ┌────────────────┴────────────────┐
                           Mac-B 的 SmartSell Worker          Win-C 的 SmartSell Worker
                           在你的 Chrome 裡發 X                在你的 Chrome 裡發 TikTok
```

> **請先了解平台規則。** X 的自動化規則禁止以腳本操作網站，TikTok 條款也限制自動化；帳號可能因此受限或停權。SmartSell 不偽造指紋、不規避偵測、不解驗證碼，代按發布前每個帳號都要你在網頁單獨確認風險；沒確認的帳號，Worker 會準備好貼文，停在「發布」前請你自己按。是否使用、用在哪些帳號，由你自行判斷並承擔。

設計與介面以 [`docs/restructure/phase1-design.md`](docs/restructure/phase1-design.md) 為準（附錄 E 的決定優先）；下一步的「主人自己的 Chrome」與手機遙控見 [`docs/restructure/core-automation-proposal.md`](docs/restructure/core-automation-proposal.md)。

## 取得原始碼

```sh
git clone https://github.com/dp0304/smartsell.git      # GitHub
git clone https://gitee.com/yueshutech/smartsell.git   # 中國大陸可用 Gitee（內容相同）
```

需要 Node.js 24 與 pnpm 10。中樞與 Worker 安裝包都從原始碼建置；目前還沒有預先建置好的安裝包可以下載。

## 第 1 階段怎麼用

1. **安裝中樞**：在當中樞的電腦（常開的 Mac 最簡單）照 [中樞安裝與維護](docs/hub-setup.md) 執行 `bash scripts/install-hub.sh`。它會檢查前置軟體（Node.js 24、pnpm、Tailscale），執行 `pnpm hub:init` 並安裝服務，最後印出一個設定網址；在已加入 tailnet 的瀏覽器打開它，建立擁有者帳號。之後的設定都在網頁的「開始設定」精靈。
2. **建置 Worker 安裝包**：在中樞的原始碼資料夾執行 `pnpm worker:release`（macOS 產生 mac-arm64 與 mac-x64；Windows 安裝包要在一台 Windows 電腦上執行 `pnpm worker:release --win`），照 [中樞安裝與維護](docs/hub-setup.md) 第 4 節放進中樞後，就能在「開始設定 → 下載 SmartSell Worker」下載。安裝包沒有 Apple／Windows 的程式碼簽章，第一次打開時系統會提醒。
3. **配對機器**：在每台要發文的電腦（例如 Mac-B、Win-C）加入同一個 tailnet，安裝並打開 Worker，貼上中樞位址、取名，在那台電腦的瀏覽器登入中樞並按「授權」。配對只在要配對的那台電腦上完成。
4. **選擇用哪個 Chrome 發文**：建議在 Worker 選「用我自己的 Chrome」，並照 App 的步驟安裝 SmartSell 擴充功能（約 1 分鐘），Worker 就會在你已經登入的 Chrome 裡操作；也可以維持每個帳號一個獨立的 Chrome。說明見 [SmartSell Worker](apps/connector-desktop/README.md)。
5. **新增帳號**：在那台電腦的 Worker 按「新增帳號」，選 X 或 TikTok。已經登入的帳號會馬上偵測到；沒登入就在跳出的 Chrome 視窗自己登入（驗證碼與二次驗證由你完成），確認加入。到網頁的帳號頁完成就緒清單：核准方式、代按發布的風險確認（或「我自己按發布」）、TikTok 預設選項、試跑。
6. **連接你的 AI 助手**（任選一種）：
   - 筆電安裝同一個 Worker App，首次開啟選「這台是我的筆電（只連 Codex，不發文）」，按「連接 Codex／Claude Code」。App 會寫好 MCP 設定，也會在 Codex 關閉後接手還沒傳完的上傳。
   - 沒有 App 時用 Node relay：在網頁 Agent 頁按「建立連線並下載權杖檔」，把檔案存成 `~/.smartsell/token`（權限 600），然後：

     ```sh
     curl -fsSL https://<中樞>/agent/relay.mjs -o ~/.smartsell/relay.mjs
     codex mcp add smartsell -- node ~/.smartsell/relay.mjs --hub https://<中樞> --token-file ~/.smartsell/token
     # Claude Code：claude mcp add --scope user smartsell -- node ~/.smartsell/relay.mjs --hub https://<中樞> --token-file ~/.smartsell/token
     ```

   - WorkBuddy：在「聯結器 → 自定義聯結器 → 新增 MCP」加入一個 stdio 項目，`command` 為 `node`，`args` 為 `["<你的家目錄>/.smartsell/relay.mjs", "--hub", "https://<中樞>", "--token-file", "<你的家目錄>/.smartsell/token"]`，儲存後按「信任」。
7. **確認連上**：完整重開你的 AI 助手，請它呼叫一次 SmartSell 的工具（例如 `smartsell_overview`）。回到網頁，「開始設定」的 Agent 步驟會顯示「已有 Agent 透過 MCP 呼叫過 SmartSell。」。
8. **直接交代工作**：例如「把 ~/Movies/video.mp4 明天 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok，文案：『新路亞實測』」。Agent 會回報每則貼文的當地時間、機器、狀態與網址；你沒給文案時，它會先問你要不要不帶文字直接發。核准、代按發布的風險、恢復暫停與確認結果都留給你在網頁上做。

Agent 看得到 11 個發文工具：`smartsell_overview`、`machines_list`、`channels_list`、`channel_check`、`media_upload`、`post_schedule`、`post_update`、`posts_list`、`post_get`、`task_get`、`publishing_pause`；另有 3 個遙控工具 `browser_open`、`browser_act`、`phone_act`，只在你為某台機器開啟遙控、列出允許的網站或 App 後才能用，讓 Agent 在那台機器的你自己的 Chrome 或 Android 手機上一步一步操作（例如電商後台），改東西前要先問你。媒體檔一律走 API、不經過模型：經 relay 時由本機的 relay 分段上傳（SHA-256 校驗、可續傳）；用戶端直接以 HTTP 連中樞時，`media_upload` 以檔名、大小與 SHA-256 換一個單次有效的上傳網址，由 Agent 在本機執行一行 `curl` 上傳。不需要修改 `AGENTS.md`；想把規則放進專案時，用 [Agent 工作指南](docs/agent-guide.md) 的第 1 階段一節。

### 選用：在專案安裝 Agent Skills

Worker 安裝包附有三份 Skills，只使用上面的發文工具：`smartsell-video-publish`（上傳、排程、查回）、`smartsell-data-collection`（帳號狀態與 SmartSell 的貼文；第 1 階段不讀平台成效）、`smartsell-product-listing`（如實說明第 1 階段不管理商品與店鋪）。使用 Node.js 24，在 SmartSell 原始碼根目錄執行以下指令，裝到指定專案的 `.claude/skills/` 與 `.agents/skills/`；同名的既有 Skills 會保留。

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

其他首次設定方式（終端機建立、設定權杖、使用者名稱規則、PostgreSQL 與相容工作台）見 [舊版部署與工作台](docs/legacy.md)。

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

## 文件

| 文件 | 內容 |
| --- | --- |
| [中樞安裝與維護](docs/hub-setup.md) | 安裝、Tailscale、備份、更新、Worker 安裝包 |
| [SmartSell Worker](apps/connector-desktop/README.md) | Worker App、你自己的 Chrome 與擴充功能 |
| [Agent 工作指南](docs/agent-guide.md) | 給 Codex／Claude Code 的規則 |
| [第 1 階段設計](docs/restructure/phase1-design.md) | 流程、資料模型、MCP 工具、驗收 |
| [核心技術方案](docs/restructure/core-automation-proposal.md) | 主人自己的 Chrome、遠端遙控、手機 |
| [舊版部署與工作台](docs/legacy.md) | 第 2 階段之前保留的舊功能 |
| [參與開發](CONTRIBUTING.md)、[回報安全問題](SECURITY.md) | |
