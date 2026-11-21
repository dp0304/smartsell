# 採集品質與商品事實驗收

## 計畫對照與本地結果

| 項目 | 實作與驗證 |
|---|---|
| DS02 | 回補以來源覆蓋切分缺失範圍，工作台顯示分片進度與「不可恢復」的區段。正式 worker 測試以 Shopify 訂單讀取模擬多分片，同批中途失敗後續跑，只向來源重送失敗分片的原始時間窗與已保存游標。已完成分片的目標、嘗試次數與請求數不變。瀏覽器從正式工作台驗讀超期區段。 |
| DS06 | 報表圖表以數值與狀態區分真零、未採集、無權限、來源未提供與估算。Chromium 開啟以私有 SQLite 內的模擬觀測生成的正式報表版本，核對標記及文字。 |
| DS07 | 選取報表指標值可展開該值採用的觀測，核對來源、同步批次和映射版號。證據保留期間可讀取經授權的原始紀錄。清除後顯示保留政策標記，已凍結的報表數值與來源鏈仍可查。Amazon 輸入採必要欄位白名單。每日工作清理舊 `raw_record`、`webhook_delivery` 與 `import_row` 的買家資料並留下審計，期限以送達時間或缺少送達時間時的接收時間起算，上限 30 天。 |
| DS08 | 正式採集品質掃描合併重複異常，工作區事件消費者為品質問題建立一筆待辦並指派有工作區權限的負責人，採用 owner、admin、manager 的優先順序。同一 worker 測試實際檢查超限後的暫停、降頻、到期續處理以及排程延後。資料源頁顯示採集預算造成的停派或降頻。 |
| PC04 | 工作稿可插入核准商品事實並保存引用修訂。操作員可查看版號、採集時間與引用值。REST 寫入會拒絕推測類事實，並驗證拒絕時工作稿與引用沒有部分寫入。 |

計畫依據為 [§5.3.12](../../plan.md#L2764)、[§5.3.11](../../plan.md#L2671) 及 [§5.4.12](../../plan.md#L3208)。

## 復驗命令

在專案根目錄使用 Node.js 24 執行。Worker 測試建立一次性檔案庫，瀏覽器測試每案建立私有 SQLite 工作區。來源請求由本地 transport 或 loopback HTTP 模擬。

```sh
node --import tsx --test apps/server/src/modules/ingest/{amazon-privacy,operations,scenarios}.test.ts apps/server/src/modules/analytics/{operations,analytics,analytics-http}.test.ts apps/server/src/modules/content/content.test.ts apps/server/src/integration/commerce-jobs.test.ts
node node_modules/@playwright/test/cli.js test tests/web-e2e/ingest-quality.spec.mjs --workers=1 --repeat-each=2 --output=/tmp/smartsell-ingest-playwright-repeat
pnpm exec playwright test tests/web-e2e/analytics.spec.mjs -g 'DS06 and DS07|AN09 finalized' --workers=1 --output=/tmp/smartsell-ds06-ds07-final-click
pnpm exec playwright test --config=playwright.config.ts tests/web-e2e/primary.spec.mjs -g PC04 --repeat-each=2 --output "$(mktemp -d -t smartsell-pc04)"
```

| 命令 | 實跑結果 |
|---|---|
| 上述服務端合併測試 | 67 通過，0 失敗。 |
| 採集工作台 Chromium | 連續兩次通過。三項瀏覽器合跑時採集頁曾出現「無法連線 API」，同次測試的報表與商品事實通過。 |
| 報表 Chromium | 2 通過，含 AN09 凍結報表回歸。 |
| 商品事實 Chromium | 連續兩次通過。 |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 退出碼 2，診斷集中在 `apps/web/src/campaign-workspace.tsx` 的欄位與型別。 |
| `node scripts/requirements.mjs --check` | 複驗已通過來源證據驗證，最終退出碼 1，因共同產物 `docs/acceptance/matrix.md` 待重新生成。 |

## 平台實測前置

- DS02 與 DS06 仍需來源授權、實際回補窗口與欄位權限樣本，才能確認各平台的滾動保留期限、游標行為及撤回權限後的回應。現有專項溯源覆蓋指標報表，舊報表只有其既存的觀測引用。其他報表類型及跨報表血緣仍需各自的證據。
- DS07 的 Amazon 清理證據使用合成的非美國郵遞區號與巢狀買家欄位。實測仍需核准的 Amazon SP-API 角色與 marketplace、可合法使用的訂單／通知或報表錄製樣本，以及部署的排程和保留策略設定。平台核准與實測證據請併入現有外部驗證流程。
- DS08 的限流及用量測試使用本地計量。供應商實際費率、平台配額及其回傳的節流行為仍需合約與授權環境驗證。PC04 的本地驗收使用人工作成的商品事實，來源驅動的事實變更檢查與事實衝突偵測屬後續分期。
