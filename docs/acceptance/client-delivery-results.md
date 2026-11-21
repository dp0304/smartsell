# SmartSell 客戶交付驗收（TE03–TE07、PL06）

2026-11-20 01:17:07Z 起，以 Node v24.21.0 執行 `bash tests/acceptance/client-delivery.sh`。腳本在同一個臨時 PostgreSQL 17 容器中為兩個情境各建一個全新資料庫，以 `app_owner` 遷移、`app_rw` 執行服務請求。瀏覽器使用 Playwright Chromium，門戶使用本機回環 HTTPS 及自簽憑證。兩個情境皆通過（PL06 4.7 秒，TE03–05 5.1 秒），零重試。原始條件見 [設計方案](../../plan.md#L8042)、[原始構思](../../社媒運營系統_完整功能方案_繁體.md#L536)及[既有證據](evidence.json#L4982)。

| 編號 | 實跑證據 | 待驗範圍 |
| --- | --- | --- |
| TE03 | 具名客戶接受邀請後可搜尋已分享報告及附件，下載內容與原檔逐位元組相符。邀請領取前的報告請求、未分享草稿與檔案、以及分享範圍外下載均回 `404`。邀請、清單和報告頁在獨立 SPA 的 1280px 視窗無水平捲動。舊版 `/share` 的長描述已修正並復測。 [瀏覽器用例](../../tests/web-e2e/portal.spec.mjs#L216) · [跨租戶 HTTP 用例](../../tests/acceptance/portal-http.test.mjs#L120) · [舊版修復復測](#2026-11-20-te03-舊版簽名交付修復復測) | D20 平台覆蓋與歷史七瀏覽器量測見下方。 |
| TE04 | 具名門戶頁面、討論 API 和報告詳情 API 均排除內部備註。已排隊的報告通知與每日摘要在改權後排除失權報告，詳見下方補驗。 [瀏覽器用例](../../tests/web-e2e/portal.spec.mjs#L323) · [每日摘要補驗](#2026-11-20-te04-每日通知摘要續驗) | 提及與分享通知的外部送件、真實通知供應商與外部送達。 |
| TE05 | `produced`、人工 `sent` 及客戶 `confirmed` 分步記錄，各階段才填入對應時間。客戶看到提醒並確認後，員工 API、門戶詳情及頁面時間線三者逐值一致。回補由 0 變成 7 並產生新報告版本，原連結重載仍顯示原版 0。 [瀏覽器用例](../../tests/web-e2e/portal.spec.mjs#L276) | — |
| TE06 | 本機已驗範本資料隔離、品牌與自訂網域綁定、代理商批次設定，以及兩個自訂域經 Compose 部署入口的租戶隔離。 [範本實跑紀錄](workspace-results.md) · [部署入口續驗](#2026-11-20-te06-compose-部署入口續驗) | 公網 DNS、公開信任的 TLS 憑證及實際上線環境的反向代理配置。 |
| TE07 | 主會話於 01:12:40Z 以真實 PostgreSQL 驗證 3/3。有效素材包只移除個別權利到期的素材，仍可使用其他素材。領取只記錄領取活動，明確回填才建立分享紀錄。 [HTTP／PostgreSQL 用例](../../tests/acceptance/ambassador-http.test.mjs#L85) | — |
| PL06 | 新修訂出現後，原客戶連結仍顯示固定版本和對外回饋，隱藏內部備註，提示版本更新並移除批准與要求修改按鈕。直接送出舊版批准返回 `409`，原批准請求標為失效。 [瀏覽器用例](../../tests/web-e2e/portal.spec.mjs#L105) | — |

首跑重現了 Playwright 對 ISO 字串使用 `toBeLessThan` 的型別錯誤。修正後以解析所得的毫秒值檢查順序，同毫秒的分步操作可有相同時間戳，另以狀態與欄位檢查確認各步獨立。加入 PL06 時，共用資料庫曾使第二個情境初始化回 `409`，分庫遷移後兩組皆通過。先前回報的 `POST /platform-posts/register` `500` 本輪未重現。[驗收入口](../../tests/acceptance/client-delivery.sh) · [時間線斷言](../../tests/web-e2e/portal.spec.mjs#L340)

## 2026-11-20 TE04、TE06 補驗

已確認 `CLAUDECODE=1`，以 Node v24.21.0 執行。01:12:40Z 的主會話實跑為 TE07，3/3 通過。下列為本次新增證據。兩個用例在暫時 PostgreSQL 17 的獨立資料庫執行，由 `app_owner` 遷移，服務以 `app_rw` 連線。

| 項目 | 實跑入口與結果 | 待驗範圍 |
| --- | --- | --- |
| TE04 排隊後改權 | `node --import tsx --test --test-name-pattern='TE04 queued report' tests/acceptance/portal-http.test.mjs`，PostgreSQL 與本機檔案儲存各 1/1 通過。以工作區 HTTP API 讓同一收件人訂閱兩份可讀報告並定稿，確認兩筆 `analytics.report-subscriptions` 工作均已排隊，接著透過 `PATCH /members/:id/roles` 將 `analyst` 改為 `viewer`。財務版本改為回應 `403`，一般版本仍可讀。啟動實際 `runBackground` worker 後，兩筆工作皆消費，只有一般報告產生通知事件與 `in_app/delivered` 紀錄。測試專用訂閱者將該事件交給現有簽名 HTTP 派送器，回環合成對端驗簽並回 `204`，實收恰好一筆一般報告通知。 [驗收用例](../../tests/acceptance/portal-http.test.mjs#L266) · [報告訂閱者](../../apps/server/src/integration/report-subscriptions.ts#L7) | 本列驗證單筆報告訂閱通知；每日摘要見下方續驗。提及與分享的外部送件及實際消息外送尚待驗。 |
| TE06 門戶品牌與網域 | `pnpm exec playwright test tests/web-e2e/portal.spec.mjs --grep 'TE06' --workers=1 --retries=0`，Chromium 1/1 通過。從工作區 `PUT /branding` 分別綁定兩個 `.example.test` Host。未綁定的 `/api/v1/portal/branding` 回 `404`，重複綁定回 `409 PORTAL_DOMAIN_IN_USE`。實際客戶 SPA 顯示各自品牌名稱和色彩，北站 PNG 成功解碼，南站無標誌且顯示自己的品牌。北站登入並接受邀請後只列出北站工作區，讀取南站簽名分享回 `404`，南站本身可開啟該分享。將北站 Session cookie 複製到南站，`/me` 回 `401`。 [瀏覽器用例](../../tests/web-e2e/portal.spec.mjs#L375) | Host 使用 Chromium 本機解析覆寫和回環自簽 HTTPS。Compose 路由驗證見下方續驗。 |
| TE06 代理商批次設定 | 入口盤點涵蓋 Team 操作註冊和員工端品牌頁。目前有單工作區 `GET /branding`、`PUT /branding` 與既有範本操作。未找到代理商跨工作區批次設定的 API 或介面。逐工作區綁定已由上列用例實跑。 [Team 品牌操作](../../apps/server/src/modules/team/index.ts#L289) · [員工端路由](../../apps/web/src/module-routes.ts#L119) | 批次設定待實作與驗收。 |

PostgreSQL 復跑時，先在暫時容器建立兩個由 `app_owner` 擁有的資料庫，分別用 `MIGRATION_DATABASE_URL` 執行 `pnpm db:migrate:kernel`，再將各用例的 `SMARTSELL_CLIENT_DELIVERY_PG_URL` 指向對應資料庫的 `app_rw` 連線。已通過的 PL06、TE03–05 具名交付和 TE07 未重跑。

## 2026-11-20 TE06 代理商批次設定續驗

`CLAUDECODE=1`，Node v24.21.0。沿用上列 TE04 報告通知和 TE06 品牌與網域的實跑證據。

| 項目 | 實跑入口與結果 | 待驗範圍 |
| --- | --- | --- |
| TE06 代理商批次設定 | `node --import tsx --test --test-name-pattern='TE06 agency branding batch' tests/acceptance/portal-http.test.mjs`，PostgreSQL 17（`te06_batch`，服務以 `app_rw` 連線）與本機檔案儲存各 1/1 通過。測試啟動實際 Fastify 服務並執行 `branding-batch.mjs` 子程序，從 `GET /api/v1/session` 取得 CSRF token，以 `PUT /api/v1/workspaces/:ws/branding` 逐筆寫入。重複工作區的輸入在寫入前遭拒。同一批次中兩個有權工作區各回 `200`，以 `GET /branding` 確認各自的品牌設定與不同的網域。`viewer` 回 `403`，無成員資格的外租戶回 `404`，撞域回 `409 PORTAL_DOMAIN_IN_USE`。批次繼續處理後續列並以狀態碼 `1` 回報部分失敗。單筆重跑可更新品牌名稱與解除綁定，結束狀態碼為 `0`。根目錄 `pnpm typecheck` 通過。 [驗收用例](../../tests/acceptance/portal-http.test.mjs#L204) · [批次命令用法](../../apps/server/src/modules/team/INTEGRATION.md#agency-branding-batch) | 本輪交付入口為員工 CLI，依工作區獨立提交。門戶部署入口見下方續驗。 |

## 2026-11-20 TE04 每日通知摘要續驗

Claude Code 2.1.311（`CLAUDECODE=1`），Node v24.21.0。Workspace 模組已匯出 `workspace.notification-digest` 排程與訂閱者，由產品啟動時註冊。使用 `PUT /me/notification-preferences` 設定 `type_pattern: notification_digest`，排程每日按 UTC 選取未讀、未封存的報告通知與提及通知。可啟用 `in_app`，或選擇訂閱 `workspace.notification_digest.ready` 且通過工作區外送政策的 `chat_webhook` 目的地。簽名摘要只包含資源引用。 [排程註冊](../../apps/server/src/modules/workspace/index.ts#L9) · [摘要排程及處理器](../../apps/server/src/modules/workspace/notifications.ts#L303)

`node --import tsx --test --test-name-pattern='TE04 daily digest' tests/acceptance/portal-http.test.mjs` 在本機檔案儲存與獨立 PostgreSQL 17.11 資料庫各通過 1/1。使用實際 Fastify API 註冊回環 Webhook、設定摘要偏好、訂閱並定稿兩份報告。三位合成收件人起初皆可讀財務與一般報告，排程為每人將兩個項目入列。 [驗收用例](../../tests/acceptance/portal-http.test.mjs#L380)

- 第一位收件人在摘要 worker 消費前由 `analyst` 改為 `viewer`。財務版本 API 回 `403`，通知 API 與回環端都只收到一般報告。
- 第二位收件人在簽名 Webhook 入列後、HTTP 派送前改為 `viewer`。通知 API 從兩項縮為一項，回環端只收到一般報告。
- 角色未變更的收件人仍在通知 API 與回環端收到兩份報告。回環端逐筆驗證 HMAC，恰收三份摘要，`GET /signed-webhook-deliveries` 各記錄一筆 `204`。 [改權與回執斷言](../../tests/acceptance/portal-http.test.mjs#L480)

同輪也復跑既有單筆報告通知用例，PostgreSQL 及本機檔案儲存均通過。相關 HTTP、Workspace、Team 協作及簽名測試共 23/23 通過，Web 型別檢查通過。根目錄 `pnpm typecheck` 仍有 Commerce `revisions.ts:12` 的 `TS2345`。本輪使用合成帳號和回環接收端，提及與分享的外部送件及真實通知供應商仍待驗。

## 2026-11-20 TE06 Compose 部署入口續驗

已確認 Claude Code 2.1.311（`CLAUDECODE=1`）。驗收驅動、API 容器及 Web 建置均使用 Node v24.21.0。`bash tests/acceptance/te06-compose.sh` 結束碼 `0`。腳本依序啟動 Operations overlay 和預設 Commands Compose，以兩份全新的 PostgreSQL 17 資料卷執行。HTTPS 終結器在本機以受此測試信任的自簽憑證接收 SNI／Host，保留 Host 與 Origin，再經 Compose Nginx 的實際 `web.conf`／`web-proxy.conf` 轉送。 [驗收命令](../../tests/acceptance/te06-compose.sh) · [部署設定](../../infra/README.md#route-https-to-the-compose-web-service)

- **Operations 自訂域**。Compose 將 `PORTAL_CUSTOM_ORIGINS` 傳給 `server`。北、南兩個 Host 各自回傳門戶 HTML、JavaScript 和 CSS。允許但未綁定的 Host 查品牌回 `404`，嘗試綁定未允許的域回 `422`，未允許的 Host 請求 HTML、資源及 API 時在 TLS 終結器回 `421`。透過員工 API 綁定後，兩個 Host 各回自己的品牌名稱及色彩，`X-Forwarded-Host` 不影響實際 Host 選出的品牌。 [驗收斷言](../../tests/acceptance/te06-compose.mjs)
- **登入與分享隔離**。兩個合成租戶各簽發邀請，客戶在對應 Host 交換簽名 assertion 並領取邀請後只看見自己的工作區。錯置 Origin 或 assertion 回 `404`，將一站的 host-only Session cookie 帶到另一站或預設門戶時回 `401`。兩站各自開啟簽名報告，同一憑證用在另一站回 `404`。 [驗收斷言](../../tests/acceptance/te06-compose.mjs)
- **單門戶及工作台**。未設定自訂域的預設 Commands Compose 可從預設門戶開啟一筆實際簽名分享，並可載入舊版分享與創作者頁面。正確 Host 和 Origin 才能通過舊版代理規則。兩個自訂 Host 即使送出預設門戶 Origin，舊版 API 仍回 `403`。工作台可正常登入，門戶 Origin 對工作台登入的請求回 `403`，門戶埠上的工作台 Session 路徑回 `404`。 [Nginx 路由](../../infra/web.conf)

最終實跑使用 `smartsell-te06-352df00cb01a66c5`。腳本兩階段皆執行 `docker compose down --volumes`，確認無容器引用後移除本次專用的兩個映像。結束後以 `docker compose ls -a` 及容器、資料卷、網路、映像清單核對，本輪所有 `smartsell-te06-*` 測試資源均已移除，既有 `smartsell-kernel-check` 和其他 Compose 專案仍在。公網上線仍需各域 DNS、公開信任的 TLS 憑證及實際環境的 Host 路由配置。

## 2026-11-20 TE03／D20 桌面門戶補驗

**修復前量測有一個失敗狀態。** TE03 原文為「門戶在 1280px 寬的支援桌面瀏覽器中不需水平捲動」。D20 §5.1.10 以 CSS 像素計，Windows／macOS 的 Chrome、Edge、Firefox 須覆蓋當期最新兩個主版本，macOS Safari 亦須覆蓋最新兩個主版本。發版檢查可用 WebKit 近似 Safari，另須於 macOS 實機 Safari 冒煙。低於 1280px 仍保留桌面版面並提示使用電腦瀏覽器。消費者公開頁屬 LP 的適配範圍。 [TE03 原條件](../../plan.md#L8042) · [D20 規格](../../plan.md#L1494) · [發版檢查](../../plan.md#L10415)

macOS 14.5 arm64、Node v24.21.0，以 Claude Code 2.1.311 的獨立代理核對路由。瀏覽器使用隔離的無頭工作階段及合成帳號。獨立門戶以回環 HTTPS 提供現行 HTML／CSS／JS，實際掛載產品 `createPortalHost`、門戶 API 和簽名下載授權，工作區資料在隔離檔案儲存預置，檔案內容由合成媒體後端提供。舊版頁面由實際 Commands 測試主機提供現行資源及 API。完整 Operations 主機在初次啟動時遇到缺少 `report-export.js`，後續重試時來源檔已存在，另跑完整 Operations 的 TE03 跨租戶 HTTP 用例通過。此輪沿用既有 PostgreSQL、PL06／TE03–05 交付及 TE06 部署證據。 [門戶主機](../../apps/server/src/integration/portal-host.ts#L110) · [舊版主機](../../tests/web-e2e/collaboration-host.ts) · [完整 Operations 權限日誌](../../.local/qa-turn/te03-d20.dAc6fI/operations-te03.log)

等待實際資料與頁面狀態顯示後，逐頁記錄 `innerWidth`、根節點 `clientWidth`、根節點及 `body` 的 `scrollWidth`、嘗試橫捲後的 `scrollX` 與桌面提示。每列的 **47/48** 都是 37 個獨立 SPA 狀態、10 個其他舊版狀態通過，另有 1 個舊版長描述失敗。通過的狀態中四項寬度皆為 **1280px**，`scrollX` 為 **0**，桌面提示隱藏。兩套門戶各抽一個 1279px 狀態，七個環境都保留 **1280px** 版面、可橫捲 **1px** 並顯示桌面提示。 [逐狀態量測原始輸出](../../.local/qa-turn/te03-d20.dAc6fI/)

| macOS 瀏覽器／引擎 | 版本與來源 | 1280px 通過狀態 | 長描述 `scrollWidth`／可橫捲量 |
| --- | --- | ---: | ---: |
| Google Chrome | 158.0.8127.36，本機 Stable | 47/48 | 5966px／4686px |
| Google Chrome for Testing | 157.0.8103.78，Google 官方前一主版測試發行 | 47/48 | 5966px／4686px |
| Microsoft Edge | 158.0.4370.33，Microsoft 官方 Stable | 47/48 | 5966px／4686px |
| Mozilla Firefox | 160.0.1，Mozilla 正式版，GeckoDriver 0.37.1 | 47/48 | 5963px／4683.17px |
| Mozilla Firefox | 159.0，Mozilla 正式前一主版，GeckoDriver 0.37.1 | 47/48 | 5963px／4683.17px |
| Playwright Firefox Nightly | 159.0，相容性補充 | 47/48 | 5963px／4683.17px |
| Playwright WebKit | 2215，瀏覽器回報 26.0，相容性補充 | 47/48 | 5966px／4686px |

獨立 SPA 覆蓋根頁及搜尋、邀請和分享詳情，包含繁中／英文、未登入、空清單、搜尋有結果及無結果、接受邀請及錯誤收件人、具名及簽名報告、附件下載、外部留言、交付提醒及確認時間線、有效及過時審批、撤回、創作者邀請及交付表單。舊版覆蓋 Nginx 部署的 `/share`、`/creator` 及 README 的 Caddy 舊版根頁，包含簽名交付、留言及審閱表單、撤回、創作者交付表單與收件狀態，以及工作區登入、空／有資料看板及展開表單。此探針取樣已載入的頁面狀態，未枚舉暫態載入、錯誤分支或可選部署登入頁的所有組合。 [Nginx 門戶路由](../../infra/web.conf#L35) · [Caddy 相容路由](../../apps/portal/README.md#L21)

**重現失敗**：以舊版 Commands 建立描述為 `'WideText'.repeat(90)`（720 字元，API 上限 4000）的交付，發布後開啟 `/share#<簽名憑證>`。一般短描述的同類交付寬度為 **1280px**。長描述由舊版標題區的 `.heading .copy` 渲染，連續字串撐出頁面，七個環境均實際可橫捲。 [可接受的描述長度](../../apps/server/src/modules/team/commands.ts#L134) · [標題區樣式](../../apps/portal/assets/styles.css#L33) · [Chrome 量測及失敗斷言](../../.local/qa-turn/te03-d20.dAc6fI/chrome-legacy.log)

**權限回歸通過。** 七個環境中合成客戶均只搜尋到授權項目，外租戶報告、未共享草稿、未共享附件與內部備註均無搜尋結果。直查外租戶、草稿和未共享檔案的詳情、討論及下載均回 `404`。授權報告與對外留言可讀，內部備註未出現在頁面及 API 回應。授權附件逐位元組相符，跨檔案索取及撤回後使用已簽發的檔案 URL 回 `404`。錯誤收件人領取邀請回 `404`，舊版審批請求回 `409`，創作者跨讀客戶附件回 `404`。舊版交付撤回與創作者憑證用過後重送均回 `404`。完整 Operations 的跨租戶報告用例另以 Node 檔案儲存執行，**1 通過、0 失敗**。 [跨租戶用例](../../tests/acceptance/portal-http.test.mjs#L144) · [本輪權限與逐頁數據](../../.local/qa-turn/te03-d20.dAc6fI/chrome.json)

**尚待驗證**：本機 Safari 17.5（19618.2.12.11.6）的 `safaridriver` 建立 Session 時回 HTTP `500 session not created`，明示未啟用 `Allow remote automation`。這次沒有 Safari 頁面量測，也沒有真實 Windows 環境或可校驗的官方 macOS Edge 157 安裝包。官方暫時下載已依廠商 SHA-256 或應用程式簽章檢驗，瀏覽器、驅動與大型封裝已清理。產品修復及重新量測見下一節。

## 2026-11-20 TE03 舊版簽名交付修復復測

實際執行程序為 Claude Code 2.1.311（`CLAUDECODE=1`），測試使用 Node v24.21.0。新增 Playwright 用例以回環 HTTP 建立、發布、預覽交付、建立分享並簽發憑證，再經 `/share#<簽名憑證>` 讀取產品 API 和頁面。套用樣式前，獨立 Chromium 重現 720 字元描述使 `clientWidth` 維持 **1280px**、根節點與 `body` 的 `scrollWidth` 擴至 **5966px**，可橫捲 **4686px**。修復僅在簽名交付標題區的描述套用 `overflow-wrap: anywhere`，保留原有空白與換行規則。 [頁面](../../apps/portal/assets/app.js#L496) · [樣式](../../apps/portal/assets/styles.css#L34) · [回歸用例](../../tests/web-e2e/collaboration-public.spec.mjs#L162)

| 本輪復測環境 | 版面及既有簽名分享撤回用例 | 1280px 長描述 `clientWidth`／`scrollWidth`／`scrollX` |
| --- | ---: | ---: |
| 獨立 Playwright Chromium 159.0.8154.6 | 2/2 | 1280／1280／0 |
| 本機 Google Chrome Stable 158.0.8127.36 | 2/2 | 1280／1280／0 |
| 專案快取 Playwright WebKit 2215（26.0，使用 Playwright 1.56.1） | 2/2 | 1280／1280／0 |
| 專案快取 Playwright Firefox Nightly 159.0 | 2/2 | 1280／1280／0 |

四個環境的根節點與 `body` 均量得 `scrollWidth = 1280`。繁中／英文混合的短描述保持一行，長描述完整顯示於多行，文字的實際矩形均落在段落內。交付項目與門戶首頁連結仍可見，1280px 時隱藏桌面提示。1279px 時顯示提示，`clientWidth = 1279`、`scrollWidth = 1280`、`scrollX = 1`，`body` 仍為 1280px。 [逐瀏覽器量測](../../.local/qa-turn/te03-share-fix.b019zJ/measurements.json)

另一份本機 WebKit 2251 在建立頁面時發生 `Page.overrideSetting: Unknown setting: PushAPIEnabled`，兩個用例均停在頁面初始化，未產生量測。上節七瀏覽器的未受影響狀態與權限結果沿用既有實跑證據。其餘已清理的瀏覽器及驅動未重新下載，Windows、實機 Safari 和官方 Edge 157 的 D20 證據仍待補。本輪使用合成資料及本機服務，未建立容器映像。 [復測日誌](../../.local/qa-turn/te03-share-fix.b019zJ/current.log#L1806)
