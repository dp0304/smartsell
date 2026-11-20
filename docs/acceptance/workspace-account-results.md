# SmartSell 工作區與帳號驗收（WS01、WS02、AC01）

原條件引自 `plan.md` §5.1.12、§5.2.12 驗收欄。桌面瀏覽器範圍依 §5.1.10 與 D20 桌面版驗收。以本輪實測為準，既有日誌供定位。執行環境為原工作樹、macOS 14.5、Node v24.21.0 與 pnpm 10.11.0。測試使用隔離本機狀態與合成授權，供應方交換、裝置狀態及提供者故障使用本地測試輸入。

| 條目 | 原條件 | 唯一用例標題 | 本輪結果 |
|---|---|---|---|
| WS01 | 切換品牌後清單只顯示該品牌資料 | `WS01 default brand switcher filters real content and UI locale preserves market and variant data` | 兩個品牌的內容經本地 API 建立，切換後各自只顯示所屬內容。 |
| WS01 | 以他品牌 ID 呼叫 API／MCP 回 404 | `WS01 WS03 AI03 share the same live brand scope for REST search and MCP resources` | REST 回 HTTP 404。MCP 工具回 `NOT_FOUND`，資源讀取回 JSON-RPC `-32602`。MCP 使用 JSON-RPC 錯誤語義，未觀測到 MCP transport 層的 HTTP 404。 |
| WS01 | 介面切換為 `en` 後任何內容變體與市場語言不變 | `WS01 default brand switcher filters real content and UI locale preserves market and variant data`、`WS01 \| Brand switch filters live content lists and preserves market and content language` | 切換前後讀回同一批變體與市場。日本／法國市場語言、變體語種與市場關聯一致，重新載入後仍保留已選品牌。 |
| WS01 | （P1）品牌數達 `brands` 額度時新增品牌回 `402 LICENSE_LIMIT`，既有品牌照常可用，封存一個品牌後可再新增 | `WS01 OP10 retains existing brands and frees capacity after archiving` | HTTP 通過。 |
| WS01 | 在 1280px 寬的支援桌面瀏覽器中全部頁面不需水平捲動（D20） | `WS01 \| Desktop route inventory fits 1280px in both interface languages`、`WS01 1280px document and navigation widths on primary pages (zh-Hant)`、`WS01 1280px document and navigation widths on primary pages (en)` | 部分實測，見瀏覽器分組與殘留。 |
| WS02 | 授權過期後 1 個同步週期內出現在總覽 | `WS02 account health expires an authorization on the next scheduled cycle` | 實際調度器按 60 秒間隔再跑一輪。確認 checkpoint、`reauthorization_required`、`needs_authorization`、一筆過期事件及總覽 `expired`。排程時鐘由測試推進。 |
| WS02 | 提供者故障時顯示「暫不可用」而非空白 | `WS02 overview degrades failed and timed-out providers while preserving healthy items` | HTTP 用真實聚合器處理拋錯與逾時，兩者均標為 `unavailable`，健康提供者的項目仍在。 |
| WS02 | 帳號自動模式被自動停止或任一層緊急停止生效時出現在總覽，同一工作區的 OP 停止與工作區停止只顯示一項並標示來源，自動停止項目在對應阻塞解決前不消失（P0b） | `WS02 account and layered workspace emergency stops release independently and auto-stop persists until block resolution`、`WS02 Today reflects the workspace emergency stop until released` | HTTP 檢查帳號、工作區、指定工作區 OP 與全域 OP 停止／解除。雙來源只出現一筆。四種阻塞由帳號服務建立，在未取得更新身分核對前持續顯示，解決後移除。瀏覽器核對工作區停止顯示及解除。 |
| WS02 | （P0b，D15）發布新條款版本後未重新確認的自動模式帳號以「條款過期待重新確認」出現在總覽（無阻塞），工作區管理員收到要求確認新條款的通知與一筆待辦（不出現「處理阻塞」字樣），重複的 `auto_stopped` 事件不產生第二筆待辦；管理員確認新條款並重新開啟後，總覽項目消失、待辦自動結案 | `WS02 administrator receives one nonblocking terms task and notification and re-enabling closes the task`、`WS02 Today renders scheduled expiry, provider degradation and administrator terms renewal` | HTTP 以獨立 `admin` 身分確認。真實 worker 消費兩筆不同 ID 的 `auto_stopped` 事件後仍只有一筆待辦和一則站內通知，重啟後由系統結案。瀏覽器同時檢查到期、故障提示和條款確認流程。 |
| AC01 | 同一帳號經兩次授權不產生重複主檔；改暱稱後歷史仍可關聯 | `AC01 two independent verified OAuth grants share one account and rename preserves post history` | HTTP 通過。兩組獨立 OAuth code、state、PKCE challenge 和連接 ID，經真實回調、驗證、連結端點指向同一帳號主檔。改名後按原帳號 ID 讀回同一筆歷史。Google token 與頻道回應由本機 transport 合成。 |

## 命令與分組結果

在 repo 根目錄執行。Chrome 和 Firefox 為本機實際啟動的版本，Firefox 使用既有 Playwright Nightly。

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node -v
pnpm -v
pnpm --filter @smartsell/web build
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  node --import tsx --test --test-name-pattern 'WS01|WS02|AC01' tests/acceptance/workspace-access.test.mjs
export WORKSPACE_FIREFOX_EXECUTABLE="$PWD/.local/qa-turn/editorial-firefox-runtime/firefox-1572/firefox/Nightly.app/Contents/MacOS/firefox"
SMARTSELL_E2E_PREVIEW=1 pnpm exec playwright test \
  --config tests/web-e2e/workspace-account.playwright.config.mjs \
  --project=chromium --project=chrome --project=firefox --grep 'WS01|WS02' --workers=2
pnpm exec playwright test --config tests/web-e2e/workspace-account.playwright.config.mjs \
  --project=edge --project=webkit --grep WS01 --workers=2

# macOS 14 相容 WebKit，使用本輪暫存的現行 spec 與本機既有 runner
PLAYWRIGHT_BROWSERS_PATH="$PWD/.local/qa-turn/editorial-webkit-runtime" SMARTSELL_E2E_PREVIEW=1 \
  node .local/qa-turn/editorial-webkit-tool/node_modules/@playwright/test/cli.js test \
  --config .local/qa-turn/editorial-webkit-tool/workspace-account-final.XNNRza/playwright.config.mjs \
  --grep 'WS01|WS02'

pnpm exec vitest run apps/server/src/modules/account/account.test.ts
node --import tsx --test apps/server/src/modules/workspace/operations.test.ts
```

- 建置成功，見 `.local/qa-turn/workspace-account-resume-build.log`。目標 HTTP 分組通過 8 項，見 `.local/qa-turn/workspace-account-final-http.log`。合併回歸命令 `env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" node --import tsx --test tests/acceptance/workspace-access.test.mjs tests/acceptance/workspace-http.test.mjs` 為 25 通過、1 失敗。失敗用例 `shared business operations preserve the same resource, version and policy across Commands and REST` 在 `workspace-http.test.mjs:383` 的 `campaign.updated` 事件數預期 2、實得 0，與中斷前 `verify-resume.log` 一致。
- 建置產物在 Chromium 159.0.8154.6、Google Chrome 158.0.8127.36、Firefox Nightly 159.0 各完成 7 項，共 21 項，見 `.local/qa-turn/workspace-account-final-browsers.log`。路由清單用例各量測 221 個已登入路由 × 2 介面語言和 2 個登入前入口。主頁用例各量測 157 頁／語言，另檢查導覽與頂列寬度。部分參數路由使用不存在的 ID，覆蓋該路由的空資料／找不到畫面。品牌與內容詳情使用實際 fixture ID。兩個路由計數互有重疊。三個瀏覽器均看到站內通知、個人待辦與總覽條款確認入口，提交後總覽項目移除且待辦結案。
- Edge 測試在找不到 `Microsoft Edge.app` 時停止。repo 的 Playwright 1.65.1 WebKit 專案在建立頁面時遇到 `Page.overrideSetting` 的 `Unknown setting: PushAPIEnabled`，見 `.local/qa-turn/workspace-account-resume-desktop.log`。既有 Playwright 1.56.1 與相容 WebKit 2215（瀏覽器回報 26.0）通過同樣 7 項及上述路由數量，見 `.local/qa-turn/workspace-account-final-webkit.log`。這一組在忽略目錄暫存三個現行 spec，僅調整相對匯入路徑以使用既有舊版 runner。
- 帳號 Vitest 領域測試 16 項通過。工作區 Node test 領域測試 8 項通過。
- 門戶補充命令 `env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" pnpm exec playwright test tests/web-e2e/portal.spec.mjs --grep 'PL06|named client' --workers=1`。兩次執行各 1 通過、1 失敗，見 `.local/qa-turn/workspace-account-final-portal.log`。`PL06 | the client portal keeps the pinned revision visible and rejects stale approval` 通過，含共享詳情 1280 px 量測。`TE03 TE04 TE05 | named client searches, downloads and reopens the confirmed report after backfill` 通過邀請、清單、下載頁的寬度斷言，隨後在 `portal.spec.mjs:341` 以 `toBeLessThan` 比較 ISO 時間字串時觸發 matcher 型別錯誤。門戶僅記上述實測路徑。

## 2026-11-20 相容工作台瀏覽器復跑

以固定快照 `.local/qa-turn/verify-resume.log` 定位後，在目前工作樹以 Node v24.21.0、pnpm 10.11.0 和本機 Playwright Chromium 重新執行四個目標檔案。修改前建置成功，瀏覽器結果為 8 通過、10 失敗。`workbench.spec.mjs` 在目前基線已通過。其餘重現相容根入口載入共享介面、雙向連結仍按舊目的地驗證，以及 `Owner` 和 `Content studio` 定位歧義。基線見 `.local/qa-turn/workspace-account-compat-baseline.log`。

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
pnpm --filter @smartsell/web build
env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" \
  pnpm test --built-web apps/web/test/analytics.spec.mjs apps/web/test/default-tools.spec.mjs \
  apps/web/test/workbench.spec.mjs tests/web-e2e/operator.spec.mjs
```

- `pnpm --filter @smartsell/web build` 通過，見 `.local/qa-turn/workspace-account-compat-final-build.log`。以建置產物執行，Web 三檔各通過 1 項，Operator 通過 15 項，合計 **18 通過、0 失敗**。完整輸出見 `.local/qa-turn/workspace-account-compat-final.log`。
- `/compat/workbench` 完成首次設定、獨立瀏覽器登入、中英切換和登出後重新登入。主工作區與 `/compat/workbench/workspace` 往返保留同一工作區、品牌頁路徑、查詢參數與錨點，重新載入後仍可讀取原品牌。共享視圖也可進入原有命令工作台並返回。
- 目前角色區塊顯示 Owner。Viewer 的工具清單隱藏品牌新增，Owner 自審遭拒且獨立 Reviewer 完成核准。Content studio 在相容工作台渲染製作看板，原有拖曳、無障礙提示、翻譯重審及複用斷言全部通過。

## 2026-11-20 Microsoft Edge 實跑

從 Microsoft 發版目錄取得 macOS Edge 158.0.4370.33 套件，校驗 SHA-256 後在專案暫存目錄解包。Playwright 用暫存設定指定該執行檔，沿用現行 viewport 和同一組 WS01／WS02 斷言。

- 工作台 Edge **7 通過**。路由用例完成 221 個登入路由乘兩個介面語言與兩個登入入口。兩個主頁用例另各量測 157 頁。原資料／空狀態案例與前一輪相同。紀錄 `.local/qa-turn/edge-workspace-results.log`。
- 以 `bash tests/acceptance/client-delivery.sh --config <Edge 設定>` 在獨立 PostgreSQL 跑 PL06 及具名客戶報告交付，Edge **2 通過**。紀錄 `.local/qa-turn/edge-portal-results.log`。
- 原生 Safari 17.5 的 WebDriver 回覆 `session not created`，本機尚未啟用 Safari 遠端自動化。

## 2026-11-20 D20 門戶補驗

Claude Code 協作核對路由，以 Node v24.21.0 補測獨立門戶、舊版簽名分享、創作者提交及相容工作區根頁。每個環境的 48 個 1280 CSS px 取樣狀態有 47 個通過。舊版簽名交付的 720 字元連續描述可令頁面橫捲，macOS 實測文件寬度為 5963–5966px。正式 Firefox 160.0.1／159.0、Chrome 158 與官方 Chrome for Testing 157、Edge 158 已納入此次門戶證據。Playwright Nightly 和 WebKit 的結果列為相容性補充。兩套門戶各抽測一個 1279px 狀態，均保留 1280px 版面並顯示桌面提示。此次沿用上方 WS01／WS02 工作台結果。 [門戶逐版本結果與權限回歸](client-delivery-results.md#2026-11-20-te03d20-桌面門戶補驗)

## 2026-11-20 AC02 撤銷授權續驗

本機核實了原生 Claude Code CLI 2.1.311、Node v24.21.0（nvm）與 pnpm 10.11.0。另以 Claude Code CLI 指定 `claude-opus-5-5` 完成授權路徑核對，紀錄於 `.local/qa-turn/account-revocation-claude-review.log`。

在目前工作樹重現上輪 `.local/qa-turn/account-revocation-independent.cuJMNl` 的 0 通過、1 失敗。原用例第 214 行對 active 且已確認出口的 Shopify `merchant_custom` app 請求 `/connections/oauth/start`，收到 `409 PLATFORM_APP_NOT_READY`。正式 adapter 已支援該 app 的授權。依 D16，商家組織自建 app 從 `/connections/shopify/merchant` 以 `client_credentials` 取得權杖並探測店鋪身分。瀏覽器安裝網址屬於 Partner custom distribution，網址路徑斷言放在既有 Partner OAuth／HMAC 回調用例。基線輸出見 `.local/qa-turn/account-revocation-resume-baseline.log`。

- AC02 用正式 Commands 入口啟動兩個本機工作區，各有獨立 SQLite、登入和品牌。未啟用 app、未確認的固定出口、其他工作區的 app ID 和不符的店鋪均被拒絕，請求日誌為空。啟用後，merchant 端點以表單交換一次權杖，只向同一店鋪探測一次身分。店鋪可讀回原連接和 app ID，社群帳號清單保持空白。
- 撤銷預覽保留原狀。實際撤銷清除權杖，重複請求只產生一筆撤銷事件及一筆審計事件。排隊任務重啟前後均為 `blocked / connection_revoked`，嘗試次數為 0。已接受任務保留原嘗試、回執、請求雜湊及 fencing token，核實結果為 `inconclusive`，拒絕重試。此階段沒有新增供應方請求。相同頻道的獨立只讀 grant 讀回原回執，任務轉為 `published / system_verified`，再次重啟後讀回同一筆 `platform_post`。全程只有一次 upload init、一次 upload submit 和一次只讀核實。另一工作區的授權保持 active，撤銷 Shopify 店鋪連接也未影響 YouTube grant。
- 最終 AC02 連續三次各 1 通過、0 失敗、0 跳過。Shopify 授權、商品同步及執行邊界 43 通過。WS01／WS02／AC01 HTTP 8 通過。`pnpm typecheck` 通過。紀錄於 `.local/qa-turn/account-revocation-resume-final.log`、`account-revocation-resume-boundaries.log`、`account-revocation-resume-workspace.log` 和 `account-revocation-resume-typecheck.log`。
- 平台資料交換全部使用本機合成 transport。此次使用本機 Node 服務及 SQLite，Docker 映像清單前後一致。兩份原稿及中央驗收文件的 SHA-256 與 Git HEAD 前後一致。

## 殘留

- D20 仍有舊版門戶橫捲缺陷。完整矩陣尚缺真實 Windows、macOS Edge 前一主版本及原生 Safari 發版前冒煙。Safari 17.5 實機 `safaridriver` 仍因 `Allow remote automation` 未啟用而無法建立工作階段。正式 Firefox 兩個主版及 Chrome for Testing 前一主版的本輪資料僅涵蓋門戶，工作台的對應版本組合仍待覆核。 [D20 桌面及版本規格](../../plan.md#L1494) · [發版驗收](../../plan.md#L10415)
- 外部 Google／YouTube 帳號同意、真實憑證更新、平台端阻塞、實體裝置、法務發布及任何站外通知均未測。條款版本替換、故障注入和身分核對狀態變更在本地 fixture 執行，兩個帳號維護週期與事件消費以實際服務執行結果計入。
