# AI01 無模型新品活動驗收

驗收範圍為 AI01 與構思 §11.3 第一列「全程不使用 Agent 建立新品活動」，涵蓋選商品、寫內容、送審、排期、發布、回覆及查看基礎成效。[AI01](../../plan.md#L7797) · [構思 §11.3](../../社媒運營系統_完整功能方案_繁體.md#L759)

## 既有驗收證據

2026-11-20，Node v24.21.0，本機獨立 SQLite 與合成資料。§7.1 與 Commands／REST 一致性驗收合計 2/2 通過，Campaign 領域回歸 20/20 通過。

| 步驟 | 既有正式 HTTP 證據 |
|---|---|
| 商品、活動、內容 | 同一活動關聯 CSV 商品、SKU、兩個市場、已批准的 brief、里程碑及雙語內容。 |
| 送審、排期、發布 | 獨立審閱人批准目標，通過預檢，登記人工發布憑證並查核執行紀錄。 |
| 回覆、成效 | 針對活動作品的評論分派及登記人工回覆。報告凍結 15 次瀏覽，補錄後第 2 版為 75 次，重啟後兩版和結案快照皆可讀回。 |

此組結果的操作面為正式 Commands HTTP，測試對端與資料皆為本機合成夾具。本輪沿用此證據，不重跑 §7.1。[§7.1 測試](../../tests/acceptance/launch-campaign.test.mjs) · [實跑紀錄](campaign-results.md#71-跨境新品闭环与-commands--rest-一致性)

## 工作台實測（2026-11-20）

**AI01／構思 §11.3「全程不使用 Agent 建立新品活動」通過，Chromium 1/1。** 以本機 Claude Code 2.1.311 編修與執行，使用 Node v24.21.0、一次性 PostgreSQL 17.11 及回環 TLS。工作區 owner 及 reviewer 以不同使用者和獨立瀏覽器工作階段登入，驗證各自的角色。

| 步驟 | 實際操作面與驗證結果 |
|---|---|
| 配置並移除模型 | 以正式工作區 HTTP API 註冊並啟用回環供應商、確認外送政策、建立 `draft` 用途路由，驗證 `/ai/status` 顯示 `draft` 可用。owner 從 Web「AI 與自動化」依序確認刪除用途路由、供應商，分別成功發出 `DELETE`。API 回讀兩張清單皆空、AI 停用，PostgreSQL 唯讀查核供應商的外送規則已移除。以空模型綁定重啟 API，再次確認清單皆空和 AI 停用。 |
| 選商品、寫內容 | owner 在「行銷活動」建立活動、按 SKU 搜尋並加入主打商品。在「內容工作台」手寫 Facebook 文案、建立變體並儲存修訂。 |
| 送審、排期 | owner 從修訂建立 UTC 排期並送審。reviewer 在「發布日曆 → 我的審批」批准，確認目標轉為就緒，保留原排期和凍結雜湊。 |
| 人工發布 | owner 從排期開啟執行任務、轉人工並回填合成連結、實際發布時間與憑證檔案 ID。作品與排期相連並標記 `manual_confirmed`。 |
| 人工回覆 | owner 在「收件箱」取得回覆租約、手寫並送審。reviewer 批准後，owner 準備人工回覆，回填合成回覆連結並確認，驗證送達狀態及 `manual_evidence`。 |
| 查看基礎成效 | owner 在「執行監控 → 平台作品」開啟同一作品，「成效歷史」顯示 `norm.post.views` 為 37。 |

正式 HTTP API 提供測試前置與外部輸入，包括 reviewer 邀請及受邀帳號建立、品牌／店鋪／商品／社群帳號、合成 PNG 憑證上傳、匯入留言及指標觀測。瀏覽器封鎖工作台來源以外的請求並記錄嘗試，發布和回覆只回填合成回執。全程觀測到 0 筆站外請求、0 筆助手或 Agent 變更請求、0 次回環模型請求。流程結束時，Agent 工作和 AI 使用量皆為空，模型供應商及用途路由清單仍為空。

### 重跑紀錄

| 實跑 | 結果 |
|---|---|
| `.local/qa-turn/post-restart-model-free.log` | 0/1。舊版清理呼叫未定義的 `setup.close()`，遮蓋原始失敗。 |
| `.local/qa-turn/ai01-claude-resume-01.log` | 0/1。經模型移除、人工發布與回覆後，測試找不到 `Publishing activity` 導覽項目。 |
| `.local/qa-turn/ai01-claude-resume-02.log` | 0/1。完成移除後的空模型綁定重啟及人工流程，最後仍找不到名稱為 `Execution` 的導覽項目。 |
| `.local/qa-turn/ai01-claude-resume-03.log` | 1/1（12.5 秒）。走實際的 `Execution monitor → Platform posts`，完成成效與零呼叫斷言。 |

同一 Node 版本下，既有 Agent 領域回歸 5/5 通過（`pnpm --filter @smartsell/server exec tsx --test src/modules/agent/operations.test.ts`）。

使用 Node v24.21.0、已安裝的 Playwright Chromium 及本機 `postgres:17-alpine` 映像重現。夾具使用本機映像。

```sh
node -v
bash tests/acceptance/reviewer-sessions.sh model-free
```

[瀏覽器測試](../../tests/web-e2e/model-free-workflow.spec.mjs) · [獨立審閱人、TLS 與 PostgreSQL 夾具](../../tests/acceptance/reviewer-sessions.sh)
