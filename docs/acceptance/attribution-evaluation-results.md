# 歸因、受眾、評估與報表追溯本地驗收

依原稿與既有專項紀錄復驗剩餘讀回路徑。[原稿](../../plan.md) · [互動與評估驗收](engagement-results.md) · [本地互動驗收](engagement-local-results.md) · [採集品質驗收](ingest-quality-results.md)

| 條目 | 本地結果 |
| --- | --- |
| AN04 | 對同一組交易與證據，比較不帶買家選填欄位和帶合成姓名、電郵、電話、地址、郵遞區號的輸入。重複外部單號仍只算一筆，兩筆合計為 150 USD 最小單位。六個模型的查詢與訂單解釋相同，僅被寫入訂單的參照版號遞增。無證據訂單的未歸因為 49，平台自報的未歸因維持未知。回應無買家欄位或值。主工作台另驗證交易總額與三種重疊信用分列。 [HTTP](../../apps/server/src/modules/analytics/analytics-http.test.ts#L141) · [瀏覽器](../../tests/web-e2e/analytics.spec.mjs#L106) |
| AN10 | 預設 Reports 的受眾頁同時分欄顯示平台、自有互動及第三方估計，欄位保留各自口徑、來源引用與觀察時間。1 筆可比較作品低於 30 筆門檻時，畫面顯示樣本、期間和人工排程說明，未提供可套用的建議。足樣本時可套用至可編輯的排期時段範本。 [瀏覽器](../../tests/web-e2e/audience.spec.mjs#L63) |
| CR02 | 以既有委派 Agent 憑證送出帶證據的維度，由評估服務計得 40。另一位登入的操作員將 `brand_fit` 從 80 改為 60，總分變為 30，決策由 `shortlist` 改為 `hold`。同一評估讀回原分、證據、原作者、Agent 憑證識別、修正理由、操作者、時間與審計前後值。未知維度與真零分保持可區分。Agent 憑證嘗試人工覆寫時回傳 403。 [REST](../../tests/acceptance/creator-http.test.mjs#L152) |
| DS07 | 收入列與歸因的交易總額、模型欄位可追溯至凍結時保存的交易事實引用。瀏覽器與 REST 核對訂單和退款的原始匯入批次、列及內容。修正檔重匯後，原凍結結果及批次保持不變。領域用例執行實際到期清理，核對原始列內容已清除，兩種報表仍讀回原批次、列號和「已依保留政策刪除」。舊版僅顯示原先保存的參照，無採集鏈時回傳 `not_captured`。僅保存同步批次的資料顯示該批次與 `not_retained`。敘事段落沒有數值血緣入口。 [瀏覽器及 REST](../../tests/web-e2e/analytics.spec.mjs#L249) · [清理用例](../../apps/server/src/modules/analytics/operations.test.ts#L138) |

## 復驗

在專案根目錄以 Node v24.21.0、pnpm 10.11.0 及 Playwright Chromium 執行。瀏覽器用例各自啟動本地工作台與隔離資料。交易、受眾與評估證據均為本地測試資料，Agent 評估透過既有委派與計分流程完成，沒有呼叫模型供應商。

```sh
node --import tsx --test \
  apps/server/src/modules/analytics/analytics-http.test.ts \
  apps/server/src/modules/analytics/operations.test.ts \
  tests/acceptance/creator-http.test.mjs \
  apps/server/src/modules/creator/creator.test.ts
pnpm exec playwright test tests/web-e2e/analytics.spec.mjs tests/web-e2e/audience.spec.mjs \
  -g 'DS07|AN04|AN10' --workers=1 --output=/tmp/smartsell-attribution-evaluation
pnpm --filter @smartsell/web typecheck
```

首次專項復驗有 32 個 API 與領域用例通過，Web 套件型別檢查通過。該輪 AN10 在 Reports 導覽時逾時，工作區 `pnpm typecheck` 亦曾報錯。後續編譯修復後，固定快照 `416f5fa0396f5792eb2d69cbef419df33c206399a0a5cf1b125bdfa666f4a2a5` 的工作區建置通過。

2026-11-20 09:13（UTC+8），以工作台建置產物重跑瀏覽器，共 5 通過。含 AN04 的交易總額與模型分欄、DS07 的訂單／退款來源及舊報表引用、AN10 的來源分欄與人工排程。09:15 另重跑前述前三個 API／領域測試檔案，27 通過，沒有跳過。採用以下命令。

```sh
SMARTSELL_E2E_PREVIEW=1 pnpm exec playwright test tests/web-e2e/analytics.spec.mjs tests/web-e2e/audience.spec.mjs \
  -g 'DS07|AN04|AN10' --workers=1 --retries=0
node --import tsx --test apps/server/src/modules/analytics/analytics-http.test.ts \
  apps/server/src/modules/analytics/operations.test.ts tests/acceptance/creator-http.test.mjs
```

## DS07 報表來源凍結修復

Reports 的 Operations REST 與 Commands HTTP 產生結構化指標時，保存計算使用的觀測及其原始來源定位。同步證據保存來源、批次、原始紀錄識別與映射版本。匯入證據保存批次、原始列識別、列號與映射版本。原始內容留在採集層，由現行權限與保留期限控制讀取。已知觀測缺少可追溯證據時仍回傳 `not_retained`。舊版本保留其保存的觀測或交易參照，缺少凍結採集鏈時回傳 `not_captured`。敘事段落沒有數值追溯入口。

| 原稿條件 | 本地復驗結果 |
| --- | --- |
| 1. 從報表數值回到批次與原始紀錄 | 通過。以 Reports 介面產生活動 KPI、客戶月報圖表及自訂表格並定稿，再將觀測改綁到不同來源、同步批次、原始紀錄與映射版本。三份報表從瀏覽器和 REST 讀回原數值 42、原批次、映射版本 4 和原始內容。Commands HTTP 在獨立 SQLite 也產生並讀回同三類定稿。另覆核指標匯入列、電商營收及歸因的訂單與退款來源、僅保存同步批次、未捕獲及舊版本的退回語義。 [瀏覽器與 REST](../../tests/web-e2e/analytics.spec.mjs#L450) · [Commands HTTP](../../apps/server/src/modules/analytics/analytics-http.test.ts#L74) · [原始匯入與舊版本](../../apps/server/src/modules/analytics/operations.test.ts#L155) |
| 2. 到期資料清除後顯示「已依保留政策刪除」 | 通過。將原始紀錄與每日排程設為到期後，由本地 `ingest.purge_expired` 排程執行清除。原始紀錄 REST 回傳 404，替代紀錄仍可讀。三份定稿保留原數值、批次與映射，瀏覽器顯示刪除說明且原始內容已消失。Commands 以 SQLite 中的實際清理標記讀回 `deleted`。核准的保留清除也能從既有清除紀錄讀回刪除狀態。匯入列案例另核對原始欄位已清空，批次、列號與映射仍可查。 [瀏覽器與 REST](../../tests/web-e2e/analytics.spec.mjs#L450) · [Commands HTTP](../../apps/server/src/modules/analytics/analytics-http.test.ts#L74) · [匯入列清理](../../apps/server/src/modules/analytics/operations.test.ts#L156) · [核准的保留清除](../../apps/server/src/modules/analytics/operations.test.ts#L205) |
| 3. Amazon 誤存買家資料的每日清理、審計及 30 天上限 | 本地合成資料復驗通過。涵蓋 `raw_record`、`webhook_delivery`、`import_row`、審計及送達或接收時間起算的期限。工作區可以縮短期限。真實 Amazon SP-API 授權與樣本驗證沿用既有外部驗證紀錄。 [每日任務](../../apps/server/src/modules/ingest/amazon-privacy.test.ts#L96) · [保留上限](../../apps/server/src/modules/ingest/amazon-privacy.test.ts#L189) · [採集品質驗收](ingest-quality-results.md) |

本輪使用 Node v24.21.0。API 與領域測試共 47 項通過，無失敗或跳過。工作區與 Web 型別檢查通過。Chromium 共 8 項通過，包含 DS07、AN04、AN09、AN10 和客戶 portal 回補後的凍結交付讀回。所有測試資料與 HTTP 請求均留在本機。

```sh
node --import tsx --test apps/server/src/modules/analytics/{analytics,analytics-http,operations}.test.ts \
  apps/server/src/modules/ingest/{amazon-privacy,scenarios,operations}.test.ts
pnpm exec playwright test tests/web-e2e/{analytics,audience,portal}.spec.mjs \
  -g 'DS07|AN04|AN09|AN10|TE03 TE04 TE05' --workers=1 --retries=0
pnpm typecheck
pnpm --filter @smartsell/web typecheck
```
