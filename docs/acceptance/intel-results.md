# Intel LI01–LI07 本地交付與驗收

逐條對照 `plan.md` §5.6.12 與 `docs/acceptance/evidence.json` 的 LI01–LI07。桌面驗收使用預設 `/w/:ws/research`，經工作區 REST catalog 與既有 Intel operation 持久化。MCP 驗收使用預設 `/mcp`，以工作區 Bearer 憑證呼叫同一批研究記錄。測試中的 URL、供應商合約、觀測與提及均為本地受控資料。模型路由測試使用可控 adapter。

| 條目 | §5.6.12 驗收要點原文 | 本地結果與可追溯證據 |
|---|---|---|
| LI01 | 每個對象顯示資料取得方式與可用範圍；人工與自動觀測可區分 | 桌面顯示取得方式、來源狀態、使用範圍、負責人及頻率。人工輸入、DS `competitor_observation` CSV 與抽樣供應商記錄分別保留 provenance。見 B1、D1。 |
| LI02 | 比較只用相同年齡桶；私密指標顯示「來源未提供」 | 時間線可按日期、作品在觀測時的年齡、指標與可用性篩選，保留數字零。比較表按作品年齡桶，分列實測與估算樣本。見 B1、D1。 |
| LI03 | 趨勢附樣本量與比較期間；Agent 結論有可回看證據 | 桌面顯示比較的兩段 UTC 區間、樣本、增量及觀測 ID。筆記以研究項目 ID 引證，可展開回查原始觀測快照。MCP 可精確檢索並按當前來源政策解析引證。見 B2、D2、H1。 |
| LI04 | 參考連結不出現在素材庫可用清單；Agent 標註可辨識；未配置模型時結構標註仍可人工完成 | 創意參考保留 `reference_only`，素材權利查詢使用獨立的素材記錄。研究頁支援人工拆解，顯示整體與欄位作者以及最後標註者。MCP 標註以憑證歸因至 Agent，人工補註保留混合作者。研究項可轉交選題或拍攝簡報。見 B2、D2、H1。 |
| LI05 | 估算與實際報價分欄；採納／淘汰理由必填 | 兩種成本獨立以貨幣最小單位保存，候選詳情展示報價、四維評分、決策理由與商品關聯。服務驗證決策權限、證據及商品記錄。見 B3、D3。 |
| LI06 | 資料中斷產生 `source_stale` 而非競品停止；重複事件合併 | 預設背景 runtime 執行來源時效檢查，現有 ingest 事件亦可觸發。同一中斷共用警示，配置的工作區成員按偏好收到去重的站內通知。研究板支援按期間手動產生並下載 JSON 簡報，來源匯出政策在服務端檢查。見 D4。 |
| LI07 | 聲量附查詢定義與樣本；人工修正保留原模型標註；未配置 `classify` 路由時不出現模型分類入口，人工標註與升級照常 | 查詢與聲量樣本回傳查詢定義、覆蓋範圍及證據 ID。原始模型值、有效值、信心、路由及人工修正鏈可在標註歷史回查。桌面依記錄與路由可用性展示分類操作，人工標註及升級工作項可獨立操作。見 B3、D5。 |

## 穩定用例

- **B1** `tests/web-e2e/intel.spec.mjs` `desktop shows source coverage, missing private metrics and the selected post age`
- **B2** `tests/web-e2e/intel.spec.mjs` `desktop resolves a saved evidence snapshot, displays periods and keeps creative links out of assets`
- **B3** `tests/web-e2e/intel.spec.mjs` `desktop retains separate costs and decision rationale and escalates manually without a model`
- **D1** `apps/server/src/modules/intel/intel-operations.test.ts` `the approved CSV import feeds the REST timeline with provenance and explicit missing metrics`、`observation sink is immutable, preserves missing metrics and compares within an age bucket`
- **D2** 同一 operation suite 的 `agent conclusions resolve exact evidence and respect revoked source permissions`、`creative references support mixed authorship and are excluded from the asset picker`、`topic trend returns explicit ranges and exact observations for each sample`
- **D3** 同一 operation suite 的 `research evidence remains traceable through conversion and the candidate decision`，以及 `apps/server/src/modules/intel/workflows.test.ts` `requires independent scored dimensions, decision authority and a real product`
- **D4** 同一 operation suite 的 `scheduled freshness and failure events share an alert and deliver one in-app notification per member`、`vendor policy blocks export and freshness gaps suppress signal alerts`
- **D5** `apps/server/src/modules/intel/intel-mentions.test.ts` `classifies through AI07 and retains the original output across human corrections`、`without a classify route, no model work is scheduled and manual labeling and escalation work`、`voice shares retain the query definition and the evidence for the deduplicated sample`
- **H1** `tests/acceptance/intel-mcp-http.test.mjs` `default HTTP MCP drafts on REST boards, resolves exact evidence and annotates the same creative references`、`default HTTP MCP rechecks live display and model processing policy for sourced evidence`

## 重跑

```sh
node --import tsx --test apps/server/src/modules/intel/intel-{operations,mentions}.test.ts tests/acceptance/intel-mcp-http.test.mjs
pnpm exec vitest run apps/server/src/modules/intel/workflows.test.ts
pnpm --dir apps/web exec vite build
SMARTSELL_E2E_PREVIEW=1 pnpm exec playwright test tests/web-e2e/intel.spec.mjs
```

Node 24 驗收通過 18 個 operation、模型 adapter 及真實 HTTP MCP 用例，另通過 7 個 command 領域用例與 3 個 Chromium 桌面用例。桌面用例使用編譯後的預設入口及隔離的本地服務，並驗證簡報 JSON 下載。Vite 開發模式的重跑曾在載入模組時出現 `ERR_CONNECTION_REFUSED`。

LI04 的 `analyze` 路由以已保存且獲准處理的觀測做結構分析，保留人工欄位。`apps/server/src/modules/intel/intel-mentions.test.ts` 的 `analyzes only a saved observation and preserves human creative fields` 使用可控 adapter 驗證此流程。

真實供應商／官方帳戶、跨來源覆蓋、真實模型憑證及營運通知渠道需各自部署驗收。LI04 的 AN08 實驗比較、LI06 排程摘要及 LI07 的異常規則／品牌暫停聯動也尚未驗收。追溯團隊可依上述外部及後續條件判定 `evidence.json` 狀態。
