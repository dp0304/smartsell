# SmartSell Worker（macOS／Windows）

SmartSell Worker 是裝在每台要發文的電腦上的 App。它和中樞配對後，常駐在系統匣，到點替這台電腦綁定的帳號在 Chrome 裡發文（第 1 階段：X 與 TikTok），再把貼文網址讀回中樞。同一個 App 也可以裝在你的筆電，選「這台是我的筆電」，只負責連接 Codex／Claude Code 與顯示通知，不發文。

整體流程與中樞安裝見根目錄的 [README](../../README.md) 與 [中樞安裝與維護](../../docs/hub-setup.md)；設計以 [`docs/restructure/phase1-design.md`](../../docs/restructure/phase1-design.md) 為準。

## 在哪個 Chrome 發文

Worker 有兩種方式，在 App 的「用哪個 Chrome 發文」切換：

| 方式 | 說明 |
|---|---|
| **你自己的 Chrome（建議）** | Worker 透過 SmartSell 擴充功能，在你平常用、已經登入的 Google Chrome 裡操作，不用再登入一次。它只在自己開的「SmartSell」視窗與分頁裡做事，不碰你正在看的分頁。沒登入的帳號會停下來，通知你在那台電腦的 Chrome 登入。 |
| 每個帳號一個獨立的 Chrome | 第 1 階段原本的方式：Worker 為每個帳號開一個獨立的 Chrome 設定資料夾，你要在那個視窗另外登入一次。 |

### 安裝 SmartSell 擴充功能（用你自己的 Chrome 時）

1. 在 App 按「改用我自己的 Chrome（建議）」。App 會把擴充功能放到「文件／SmartSell Worker／chrome-extension」，並在這台電腦的 Chrome 登記 SmartSell（原生訊息主機 `com.smartsell.worker`）。
2. 在 Chrome 網址列輸入 `chrome://extensions`，打開右上角的「開發人員模式」。
3. 按「載入未封裝項目」，選上面那個資料夾。
4. 在 SmartSell Worker 擴充功能按「詳細資料」，開啟「允許存取檔案網址」（上傳影片需要）。
5. App 顯示「已連上你的 Chrome」就完成了。Chrome 要開著，Worker 才能發文。

注意：

- Worker 操作時，Chrome 頂端會顯示「SmartSell Worker 已開始對這個瀏覽器進行偵錯」。這是 Chrome 對 `chrome.debugger` 的固定提示；按「取消」會中斷那一則，而且不會自動重發。
- 同一個平台的第二個帳號，要放在另一個 Chrome 設定檔，並在那個設定檔也安裝一次擴充功能；有好幾個設定檔時，App 會請你為每個帳號選一個。
- 擴充功能只和這台電腦的 Worker 通訊（透過 Chrome 的原生訊息，不開任何網路連接埠）。它只操作自己開的分頁，只允許驅動用到的 DevTools 指令，不能導向 `file:` 或 `chrome:` 網址，也不修改瀏覽器的任何識別資訊（不偽造指紋、不改 `navigator.webdriver`、不解驗證碼）。
- 「擬人」指的是讓頁面像被人操作一樣正常反應（真實的點擊與逐字輸入、步驟之間有停頓、每帳號每日上限），不是保證平台偵測不到。X 與 TikTok 的條款都限制自動化，代按發布前每個帳號都要在網頁確認風險。

## 開發與測試

使用 Node 24，在根目錄裝好依賴後：

```sh
pnpm --filter @smartsell/connector-desktop typecheck
pnpm --filter @smartsell/connector-desktop build
node --import tsx --test tests/connector-desktop/*.test.ts tests/connector-desktop/app/*.test.ts
```

- `tests/connector-desktop/drivers-fixtures.test.ts` 用本機的模擬 X／TikTok 頁面跑真實驅動（需要 Google Chrome）。
- `tests/connector-desktop/drivers-fixtures-own-chrome.test.ts` 與 `own-chrome.test.ts` 跑同一批驅動，但改用「你自己的 Chrome」：Playwright 的 Chromium 載入真正的擴充功能，原生訊息主機登記在測試用的設定資料夾，不會寫進你自己的 Chrome（需要 `pnpm exec playwright install chromium`）。
- `tests/e2e-phase1/own-chrome.test.ts` 從 MCP 排程一路跑到兩台機器在各自的「主人 Chrome」發出、網址回到中樞。
- 無介面的 Worker（CI 與 E2E 用）：用法見 `src/headless/runner.ts` 開頭的說明；設定 `SMARTSELL_BROWSER=own_chrome` 改走擴充功能。

本機啟動 App：`pnpm --filter @smartsell/connector-desktop start`（缺 Electron 執行檔時先執行 `node apps/connector-desktop/node_modules/electron/install.js`）。

## 打包

在根目錄執行 `pnpm worker:release`（macOS 產生 mac-arm64 與 mac-x64；在 Windows 加 `--win` 產生 win-x64），輸出到 `dist/worker-release/`，放進中樞的 `worker-downloads/` 後即可從「開始設定」下載，步驟見 [中樞安裝與維護](../../docs/hub-setup.md) 第 4 節。第 1 階段的安裝包沒有 Apple Developer ID 與 Windows 程式碼簽章；正式簽章與自動更新的設定見 `scripts/package-config.mjs`。更新另有 Ed25519 發行簽章：`worker:release` 以 `SMARTSELL_RELEASE_SIGNING_KEY`（預設 `~/.smartsell/worker-release-key.pem`）簽 `latest-<platform>.json`，並以 `SMARTSELL_RELEASE_PUBLIC_KEY` 把公鑰內建進 App（`RELEASE.releasePublicKey`）；內建公鑰的 App 拒絕簽章不符的更新（安全審核 S1，§8.18）。

## 選用：在專案安裝 Agent Skills

```sh
node apps/connector-desktop/dist/smartsell-install-skills.mjs /path/to/ops-project
```

會把 `smartsell-video-publish`、`smartsell-data-collection`、`smartsell-product-listing` 三份 Skills 裝到該專案的 `.claude/skills/` 與 `.agents/skills/`，同名的既有內容會保留。

## 舊工作線

抖音、小紅書的人工交接、知乎與商品匯入等舊功能在 App 的「進階 → 舊工作線」，預設關閉，只為既有資料保留，第 2 階段整理。
