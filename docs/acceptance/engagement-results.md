# Engagement 驗收結果

2026-11-20。依 `evidence.json` 的 IN／CR／AD／AN／LP／EM 缺口驗收。表內「HTTP」指本機真正掛載的路由，「瀏覽器」指實際啟動的工作台。外部資料使用本機 fixture 或人工證據流程。結果未寫入矩陣。

## 重跑命令

從專案根目錄用 Node 24 執行。本機用 `export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"` 避開 Homebrew Node 21 的缺失 ICU 函式庫。

```sh
# A. 收件箱、流量、SLA 與同意領域回歸
node --import tsx --test tests/acceptance/engagement-inbox-http.test.mjs apps/server/src/modules/inbox/{inbox,service-settings}.test.ts apps/server/src/modules/traffic/{traffic,operation-traffic}.test.ts apps/server/src/modules/lifecycle/workspace-lifecycle.test.ts
pnpm exec vitest run apps/server/src/modules/inbox/inbox-commands.test.ts
# B. 1 項瀏覽器流程
pnpm exec playwright test tests/web-e2e/inbox-engagement.spec.mjs
# C. 創作者登入 HTTP、領域與瀏覽器流程
node --import tsx --test tests/acceptance/creator-http.test.mjs apps/server/src/modules/creator/creator.test.ts
pnpm exec vitest run apps/server/src/modules/creator/creator-commands.test.ts
pnpm exec playwright test tests/web-e2e/creator.spec.mjs --output=/private/tmp/smartsell-creator-playwright
# D. 廣告領域、回環 HTTP 與瀏覽器
node --import tsx --test tests/acceptance/ads-http.test.mjs
pnpm --dir apps/server exec tsx --test src/modules/ads/ads.test.ts src/modules/ads/workspace-ads.test.ts
pnpm exec playwright test tests/web-e2e/ads.spec.mjs --output=/private/tmp/smartsell-ads-engagement
# F. 公開表單至 CRM 交接的回環 HTTP
node --import tsx --test --test-name-pattern='LP05' apps/server/src/integration/traffic-host.test.ts
# E. 分析與報表 HTTP、主工作台和相容工作台
node --import tsx --test apps/server/src/modules/analytics/*.test.ts tests/acceptance/portal-http.test.mjs
pnpm exec playwright test tests/web-e2e/analytics.spec.mjs --trace on --output=/private/tmp/smartsell-an-primary-playwright
SMARTSELL_TEST_WEB_PORT=49379 SMARTSELL_TEST_API_PORT=49339 pnpm --filter @smartsell/web exec playwright test test/analytics.spec.mjs --output=/private/tmp/smartsell-an-compat-playwright
pnpm exec playwright test tests/web-e2e/primary.spec.mjs --grep WS05 --output=/private/tmp/smartsell-an-primary-regression
pnpm --filter @smartsell/web typecheck
# 主工作台整合回歸（8/8）
pnpm exec playwright test tests/web-e2e/{ads,creator,inbox-engagement,analytics}.spec.mjs --workers=2 --output=/private/tmp/smartsell-engagement-final
```

A 的 Node 測試 30/30，收件箱與創作者共 6 項 Vitest 通過，C 的 Node 測試 14/14，D 的領域測試 12/12，E 的分析測試 19/19 及門戶 HTTP 2/2。F 通過本機回環 HTTP，PostgreSQL 對端未配置。工作台型別檢查通過。最後一次全庫 `pnpm typecheck` 報 `tests/identity/http.test.ts:107` 的 `TOTP | HOTP` 型別未縮窄，該檔案由本輪以外的工作處理。

## 六項優先缺口

| 條目 | 通過的斷言 | 待驗收 |
| --- | --- | --- |
| IN06 | A 的回環 HTTP 驗證評論可進人工處置、私訊與跨對話訊息被拒、未人工確認被拒。處置保留原文、訊息版本與操作者，原文後續在平台編輯時審計快照不變。B 驗證工作台只顯示平台原文和人工記錄入口。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L42) | 授權真實帳戶的官方隱藏、刪除、封鎖能力與讀回。現有程式沒有官方管理寫入適配器。 |
| IN07 | A 驗證兩個同暱稱渠道參與者身分不同且各自無客戶。缺人工依據的關聯回 422，明確關聯後另一位仍未關聯，撤銷保留原身分、操作者與原因。B 實際提交關聯與撤銷。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L66) | CRM 雙向身分同步。 |
| IN10 | A 驗證公開評價與私訊分庫，評價型訊息不能走對話匯入，不回傳多餘的 Email，刪評路由 404。人工交接及平台回覆核對保留觀測紀錄。B 驗證評分尺度、只讀文案、指派入口與無刪評操作。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L97) | 真實評價來源的唯讀同步、授權回覆與獨立讀回。 |
| CR01 | C 的登入 HTTP 驗證同名與同 handle 保持獨立，重複外部帳號 ID 被拒。受眾觀測保留來源、時間和真零。CSV 匯入明確選定的檔案，重複值略過。人工關聯與撤銷有證據、操作者與原因，兩份檔案及其歸屬均保留。瀏覽器實際操作聯絡資料匯入。 [HTTP](../../tests/acceptance/creator-http.test.mjs) · [瀏覽器](../../tests/web-e2e/creator.spec.mjs) | 真實平台帳號與獨立受眾來源核實。 |
| CR07 | C 驗證 API 目錄只有直播企劃和人工觀測，無開播命令。跨活動預熱被拒，開播及結束觀測需要平台證據。片段權利須涵蓋版本、剪輯、用途、平台、市場及預定日期，撤權後讀回阻擋。工作台能查流程表、預熱及建立片段任務。 [HTTP](../../tests/acceptance/creator-http.test.mjs#L156) | 授權平台帳戶的場次、回放與平台統計讀回。 |
| AN07 | E 的 HTTP 和兩個工作台驗證短歷史與未知歷史顯示原因，首購低信心可見，Amazon、Shopee、Lazada 排除於首購群組。預設至少三個曆月的前置歷史，可按報表需要調整。觀測期未到時復購率留空，能區分成熟後真零。 [HTTP](../../apps/server/src/modules/analytics/analytics-http.test.ts#L47) | 商戶授權 Shopify `customerOrderIndex`、`read_all_orders` 和可用訂單歷史的讀回。 |

## 客戶情境與其餘條目

| 條目 | 通過的斷言與範圍 | 待驗收 |
| --- | --- | --- |
| IN01／IN02 | A 的 HTTP 區分 `no_permission`、`unsupported` 與未驗證。B 觀察不支援及未驗證狀態，並實際指派、改狀態、標記已讀。時間線列出操作者、時間與前後值，已讀維持處理狀態。 | 真實回呼、真機停止原因及無權限文案的瀏覽器覆核。 |
| IN03 | A 透過 outbox 向回環模擬執行器發出一次 HTTP 請求並核對讀回。捕捉到的送出內容只有核准回覆及路由欄位，備註仍保留在收件箱。B 驗證備註區與人工翻譯開關，原文一直可見。 | 真實平台投遞與經核准的 AI `translate`／`analyze` 用途路由。 |
| IN08 | A 驗證等待客戶暫停 3,900 秒、解決期限後移與逾期事件只發一次。報表回傳樣本 1、首次回覆 1、解決 0 及政策暫停 3,900 秒。B 驗證無政策樣本數和排除秒數顯示。 | 更大資料量與外部服務宿主的排程驗收。 |
| IN09 | A 驗證一般收件後案件與客戶列表為空，另驗證案件外部接收後才允許解決，解決與關閉獨立。 | 真實 CRM 收件與回寫。 |
| IN04／IN05 | A 回歸覆蓋人工租約與證據、傳送未知時阻止盲目重試以及擋住過期回執。 | 雙人和 Agent 同時競爭、真機共用槽、停止原因與額度，以及平台逐次讀回。 |
| IN11 | A 驗證人工占用與已回覆分別留下略過原因，同事件重放後仍各一筆，沒有新草稿，前後同意狀態和同意帳本相同。B 在工作台顯示人工占用的略過原因。 | 真實渠道回呼驗收。 |
| CR03／CR05／CR09／CR10 | C 驗證接洽草稿、寄出、回覆為獨立狀態且顯示重複警示。出貨地址遮罩且簽收不改交付物及應付款。平台已結佣金拒進自付批次。未簽署阻擋寄樣及驗收，條款兩版可比對。 | 真實信件投遞與回覆、物流觀測、商戶實際對帳。 |
| CR02／CR04 | C 驗證未知和零分各自顯示，人工覆寫記錄前後值、操作者及原因，保留原評估。交付期限變動透過瀏覽器表單，主 REST 讀回受影響排期並產生一筆站內通知，原排程時間保留。 | 跨工作區通知與外部排程接收方。 |
| CR06 | D 回環 HTTP 驗證僅有自然發布權利的創作者素材在選入付費提案時回 409。補同版付費權利可建立並核准，撤回後官方與人工交接入口均回 409，沒有新廣告操作。 | 授權平台送審與讀回。 |
| CR08 | C 驗證同一 Amazon 訂單的訂單衍生金額 100 與平台匯入觀測 120 分欄，回應無買家個資。主工作台實際查詢該路由，瀏覽器斷言空狀態與分欄核對提示。 [HTTP](../../tests/acceptance/creator-http.test.mjs#L168) | 商家報表的實際核對與含交易的瀏覽器資料驗收。 |
| AD01 | D 驗證同工作區 editor 僅列出有授權的帳號和活動。跨品牌表現、提案及版本寫入回 404。只讀授權不能建立草稿，撤權後同一請求不可重放。瀏覽器以 PATCH 實際保存並讀回授權。 | 真實廣告 OAuth、scopes 與外部帳號資料。 |
| AD02／AD04／AD06 | D 瀏覽器驗證查詢送出帳號及日期，展示報表時區與來源口徑，缺花費與真零分開，覆蓋率 50% 時有缺天警告。估算、計畫預算、上限及實支分列，不支援欄位 disabled。建議顯示觀測證據、限制與人工清單，採納只建草稿。領域測試驗證 pacing 1.2、超預算拒絕及採納不產生廣告操作。 | 真實帳號報表與投放回執。 |
| AD03／AD05 | D 驗證核准後撤權阻擋交接，人工重試保留 client reference 並拒舊 attempt token。 | 現有程式沒有廣告官方寫入適配器。送審、狀態讀回及未知回執重送去重仍待允許的官方對端。 |
| AN04 | E 驗證 UTM、優惠碼、平台自報同時出現時交易只計一次，兩單 150 USD minor units。各可對帳模型獨立保留未歸因 49。相容工作台顯示分欄。 [HTTP](../../apps/server/src/modules/analytics/analytics-http.test.ts#L114) | 真實商家資料的模型讀回與對帳。 |
| AN08／AN10 | E 驗證定稿保留樣本限制，非零但低門檻的樣本回傳改用人工排程的原因，畫面列出來源。 | 真實觀測規模與樣本分布。 |
| AN01／AN02 | E 實際打開主工作台指標與表現頁。介面保留原始名稱、定義版次，區分未收集、無權、來源未提供與觀測零。同齡比較顯示觀測偏差，各平台保持獨立分組。 | 真實來源的定義映射與偏差分布。 |
| AN03 | E 領域斷言同一同意會話內重試去重，不同會話各自保留，拒絕同意的事件不計。 | 公開宿主目前缺少實際跨裝置追蹤路徑，瀏覽器驗收待接入。 |
| AN05 | E 本機 HTTP 驗證 Shopify、TikTok Shop、Amazon、Shopee 的取消與退款不重複扣減，晚到的退款歸回訂單日。Amazon 和 Shopee 使用 CSV 單位轉換。瀏覽器顯示申請中、成功退款與覆蓋不足。 | Shopify 和 TikTok Shop 的原生單位換算、四平台商家授權讀回。 |
| AN06／AN09 | E 瀏覽器顯示貢獻估算口徑，區分佣金缺失與運費真零，成本完整後得 200。定稿連結可回到原結果與觀測，回補將新版改為 7 時舊版仍為 0。 | 舊版快照的來源追溯限於當初保存的引用。 |
| LP01／LP02／LP03／LP04／LP06 | A 驗證賣場 CTA 只導官方商品網址，改址保留版本且分跳轉與疑似真人，市場選單只使用已存網址，未勾不加入同意且服務／行銷用途獨立，無法判定返回 unknown 且分流穩定。公開表單驗證呈現版本，私有聯絡資料加密，列表遮罩。 [領域與公開輸出](../../apps/server/src/modules/traffic/operation-traffic.test.ts#L104) | 公開頁組同時驗收瀏覽器價格來源與日期、無結帳、過期和下架、語言保留、同意雙選實際送出和流量不足呈現。商戶網域相關請用允許測試的網域。 |
| LP05 | F 從公開表單送件至登入 API 讀回，名單保持遮罩，只有具服務同意的 Email 可交接。工作台提供待回執／結果未知提示與證據填寫入口。HTTP 驗證 pending 與 unknown 維持 `qualified`，重送與提前標成交回 409，證據確認後才能成交。 | 瀏覽器的回執表單流程與真實 CRM 投遞讀回。 |
| EM01 | A 驗證不同渠道與用途獨立、撤回 Email 保留 SMS，並驗證相同暱稱不自動合併。 | 真實 ESP 抑制同步與撤回後的發送。 |
| EM02／EM03／EM04／EM05 | A 回歸驗證預覽快照不變、重算僅有彙總、不支援排期時保留本地草稿、Campaign 與 Flow 狀態獨立、頻率只計已觀察發送。 [領域](../../apps/server/src/modules/lifecycle/workspace-lifecycle.test.ts#L38) | 營銷投遞組接續驗收 ESP 排期、抑制、回執、送達對帳、覆蓋提示和開信／點擊／購買欄位。 |

## 本輪新增斷言與重跑命令

使用 Node 24.21.0，在專案根目錄執行。回環平台、素材及證據均為本機測試資料。

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
# G. 62/62
node --import tsx --test tests/acceptance/{engagement-inbox,creator,ads,inbox-contested}-http.test.mjs apps/server/src/modules/{creator/creator,inbox/inbox,inbox/service-settings,traffic/traffic,traffic/operation-traffic,lifecycle/workspace-lifecycle,ads/ads,ads/workspace-ads}.test.ts
# H. 3/3
pnpm exec playwright test tests/web-e2e/{creator,inbox-engagement,ads}.spec.mjs --workers=1 --output=/private/tmp/smartsell-engagement-final-browser
# I. 21/21 + 2/2
pnpm exec tsx --test apps/server/src/modules/analytics/*.test.ts
pnpm exec playwright test tests/web-e2e/analytics.spec.mjs --grep 'AN04|AN07' --trace on --output /tmp/smartsell-analytics-final
# J. 2/2 + 2/2
node --import tsx --test --test-name-pattern='LP05|kernel public traffic' apps/server/src/integration/traffic-host.test.ts
node --import tsx --test tests/acceptance/portal-http.test.mjs
# K. 2/2
pnpm exec playwright test tests/web-e2e/collaboration-public.spec.mjs --grep 'LP04|TE03' --workers=1 --output=/private/tmp/smartsell-engagement-public-regression
# L. 報表工作台整套 7/8，失敗案例單跑 1/1
pnpm exec playwright test tests/web-e2e/analytics.spec.mjs --workers=1 --output=/private/tmp/smartsell-engagement-analytics-full
pnpm exec playwright test tests/web-e2e/analytics.spec.mjs --grep 'uses REST to show cohort' --trace on --output=/private/tmp/smartsell-engagement-cohort-rerun
```

`pnpm typecheck` 的較晚一次執行未通過，診斷位於並行修改中的 `apps/web/src/campaign-workspace.tsx:136` 等處。完整報表瀏覽器回歸中，既有首購測試曾因工作台無法連到本機 API 而失敗，L 使用相同案例單跑通過。

| 條目 | 本輪通過的斷言 | 外部驗收 |
| --- | --- | --- |
| IN06 | G 驗證操作結果帶原文、版本及操作者，平台改文後原快照仍保留。H 提交人工處置表單，畫面回讀原文及操作者。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L55) | 平台管理能力、授權與官方讀回。 |
| IN07／EM01 | G、H 驗證同暱稱個別保存，真人核對後只關聯所選參與者，撤銷保留原因及操作者。G 驗證 Email 退訂獨立於 SMS。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L79) | CRM 身分同步、ESP 抑制同步與投遞。 |
| IN10 | G 驗證異站匯入拒絕、公開評價不進私訊、回應不帶多餘 Email、原評價重匯保留人工回覆核對，核對後重送交接回 409。H 實際提交人工指派與回覆核對表單並讀回依據。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L110) | 真實評價來源與獨立回覆讀回。 |
| CR01 | G 驗證來源參照隨觀測保存。H 在主工作台提交受眾觀測並讀回 0%、來源及時間，兩個同名檔案分別建立，人工關聯後可撤銷，另一檔案的受眾資料仍獨立。 [HTTP](../../tests/acceptance/creator-http.test.mjs#L55) · [瀏覽器](../../tests/web-e2e/creator.spec.mjs) | 受眾及帳號來源授權核對。 |
| CR07 | G 驗證開播及結束兩筆觀測並存，以及片段目的、版本、時間和撤權檢查。H 從主工作台建立企劃、讀回流程表與預熱，提交平台觀測，片段缺權時實際收到 409 且讀回無片段。 [HTTP](../../tests/acceptance/creator-http.test.mjs#L263) | 平台直播、回放與場次統計讀回。 |
| AN07 | I 的領域與主工作台驗證同步歷史中斷後以最後連續區間重算可用起點。七月仍顯示 Low 及原因，九月可達 High。查詢尾端未取得連續涵蓋時維持 Low 並顯示歷史起點未知。 [領域](../../apps/server/src/modules/analytics/operations.test.ts#L54) · [瀏覽器](../../tests/web-e2e/analytics.spec.mjs#L147) | Shopify 讀取權限、歷史完整性及首購序號。 |
| IN04／IN05 | G 以兩個真人 REST 工作階段及一個授權 MCP Agent 競爭同一對話租約，只有正確持有者建立回覆。模擬平台收到請求後逾時，核對一次 POST、一次嘗試及一次逾時回執。未知期間不得重送，遲到讀回可以核實，明確確認未送達後才允許一次重試，舊回執被拒。 [HTTP](../../tests/acceptance/inbox-contested-http.test.mjs#L149) | 官方渠道逐次讀回與真機共用槽、許可及額度。 |
| IN03／IN08 | G 擷取送出請求，核對只帶核准回覆與路由資料。SLA HTTP 確認樣本數和政策暫停秒數。H 驗證備註留在獨立區、人工翻譯展開時原文仍可見，無政策樣本和排除秒數均呈現。 [HTTP](../../tests/acceptance/engagement-inbox-http.test.mjs#L150) | 真實投遞及經核准的模型用途路由。 |
| AN04／情境 9.4 #8 | I 在主工作台實際查詢具 UTM、優惠碼及平台自報的交易。兩筆交易只計 150 USD minor units，三模型分別顯示 101／49、101／49、123／未知，無跨模型加總。 [瀏覽器](../../tests/web-e2e/analytics.spec.mjs#L100) | 商家平台報表對帳。 |
| CR05／CR10／情境 9.4 #9 | G 回環 HTTP 驗證簽收只更新樣品，交付物仍未驗收且沒有新增應付款，未簽條款阻擋寄樣及驗收。 [HTTP](../../tests/acceptance/creator-http.test.mjs#L220) | 真實物流與商戶對帳。 |
| AD01／AD03／CR06 | G、H 驗證角色與品牌隔離、授權寫入與讀回、撤權及素材付費權利閘門。 [HTTP](../../tests/acceptance/ads-http.test.mjs) | 官方廣告送審、核對和未知結果重試。 |
| LP04／EM01／情境 9.4 #10 | K 在 Chromium 實際提交服務及行銷同意，再以簽署連結退出其中一個渠道。回讀確認另一個渠道保留。 [瀏覽器](../../tests/web-e2e/collaboration-public.spec.mjs#L51) | ESP 抑制同步及真實發送。 |
| LP05／公開分享隱私 | J、K 驗證公開表單到工作區 CRM 交接、同意前置條件及遮罩。匿名分享路由只供核准欄位，撤銷後既有分享憑證失效。 [表單 HTTP](../../apps/server/src/integration/traffic-host.test.ts#L136) · [分享 HTTP](../../tests/acceptance/portal-http.test.mjs#L47) | CRM 服務真實回執及 PostgreSQL 外部配置。 |
