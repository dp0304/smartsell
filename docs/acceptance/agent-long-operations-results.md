# AI05 長任務驗收紀錄

## 基線

依 `plan.md` §4.12、§4.13、§5.17.12 驗收正式長任務的 202／`operation_id`、重連查詢、取消、SSE／MCP 進度與選用 Tasks。`claude --version` 回報 Claude Code 2.1.311。執行採用 nvm 的 Node v24.21.0 與 pnpm 10.11.0。

- 既有 PostgreSQL AI05 子案已驗 Agent 草稿的 202、重啟及原 ID、一次 MCP 進度與原租約確認取消。
- 既有非 Agent 證據包含已成功的工作區範本套用查詢。本輪續驗進行中的資料採集、連續進度及 Tasks 正式入口。

## 2026-11-20 續驗

在 `CLAUDECODE=1` 的會話以 Claude Code 2.1.311、Node v24.21.0、pnpm 10.11.0 和 loopback PostgreSQL 17.11 執行。Commands 與 Operations 使用獨立空白資料庫。測試走正式 HTTP／MCP 路由、登入及 PAT 簽發。採集使用合成資料與本機 worker checkpoint，另以程序內 provider transport 模擬一頁在途回應。AI05 全程未呼叫外部模型或平台。

| 類別 | 實跑結果 |
| --- | --- |
| Agent 草稿及租約 | Commands 與 Operations 均回 202。重啟後以原憑證從新 MCP 會話取得原 `operation_id` 和同一 Task 句柄，原冪等鍵重送只留一筆。唯讀 PAT 可查，取消被拒。授權的取消先寫入請求，原租約以 fencing token 確認後進入 `cancelled`，三種事件各一次。 |
| 資料採集刷新 | 預設 Commands 回 202，由 `operation_id` 找回獨立的 `sync_run_id`。重啟後 Task 句柄及冪等重送對應同一筆 run。兩次本機 checkpoint 透過背景角色與正式寫入服務提交。舊版本取消回 `VERSION_CONFLICT`，正確版本取消成功，後續 checkpoint 被拒。另一筆完成的 run 由官方 MCP SDK 讀出 `completed` 及 `succeeded` 結果。 |
| 歷史回填 | 預設 Commands 正式 `/backfills` 回 202。兩份回填共享一個切片時，取消第一份保留另一份的切片，取消最後一份才取消共享 run。 |
| 在途採集 | Commerce worker 已領取頁面時，取消先進 `cancel_requested`。程序內 provider fixture 交付該頁後，worker 確認 `cancelled`，checkpoint 維持 0。worker 無法返回時，下次掃描可在租約失效後完成取消。 |

### 進度與授權

- 工作區 SSE 沿用 `workspace.changed`，只送 revision 與失效通知。預設 Commands 實測兩次 checkpoint 間以 `Last-Event-ID` 重連，新 revision 觸發重抓。
- 同一條 MCP `tasks/result` SSE 連線收到 `queued` v1、`running` v2／v3、`cancelled` v4，再收到原 `operation_id` 的結果並結束。等候另一筆回填時撤銷同一 PAT，下一次檢查以 `-32602` 結束串流，新請求回 401，另一份授權仍可查詢。
- 只有協商 `2025-11-25`、客戶端明示 Tasks，且當前憑證可使用 `jobs_get` 時才宣告 `taskSupport: optional`。官方 MCP SDK 在兩個入口驗證初始化、`tools/list`、Task 建立與 `tasks/get`。篡改、跨憑證與跨工作區的請求被拒。Task 是原 operation 的讀取句柄，取消經附版本的 `jobs_cancel` 或 REST，沿用原模組規則。
- 真實 Claude Code 2.1.311 的 `claude mcp list` 在隔離 CLI 設定下連上兩個入口。捕獲初始化報文的 `protocolVersion` 為 `2025-11-25`，無 Tasks 能力。普通 `jobs_get` 的後備路徑由官方 SDK 驗證。Claude Code 的原生 Tasks 及工具實際執行仍待可宣告該能力的宿主或無模型的工具執行入口驗證。

### 發布批次與提交後核實

同一 Claude Code 2.1.311 會話實測，父程序為 `claude`，`CLAUDECODE=1`，入口為 `sdk-cli`。以 nvm 的 Node v24.21.0、pnpm 10.11.0 執行既有 AI05 PostgreSQL fixture。預設 Commands 啟動 `bootstrap.start`，獨立 Operations 啟動 `startKernel`，兩者均使用 PostgreSQL 17.11 的獨立資料庫。Claude Code CLI 分別連線，工具查詢和 Tasks 決議由官方 MCP SDK 驗證。

| 類別 | 實跑結果 |
| --- | --- |
| 發布計畫批次提交 | 兩個入口的 `/publish-plans/{id}/commit` 回 202，立即保存批次作業及逐項結果。部分提交樣本保存一筆 `approval_required` 與一筆 `failed`，待審項未產生執行任務。重啟後原冪等鍵、REST 和 MCP `jobs_get` 找回同一 `operation_id`，已完成的批次作業取消回 409。 |
| 執行批次套用 | 兩個入口的 `/execution-batches/{id}/apply` 回 202，保留批次物件、版本及逐項狀態、任務版本和核實作業 ID。批次進入 `applied`，各核實作業可分別追蹤。重啟後原冪等鍵及無鍵重送均返回原 ID，REST 可取回每項結果，MCP `jobs_get` 可查批次狀態。版本過期的預覽被拒，已失效的審批阻擋執行，人工轉交重放仍需人員會話。 |
| 已提交發布核實及取消 | `/execution-tasks/{id}/reconcile` 及預設入口的 Commands 核實別名回 202，保留 `task`、`version`、ETag，並重用同一次嘗試的 `operation_id`。換 MCP 會話及重啟服務後仍能查詢原作業與 Task 句柄。唯讀憑證與過期版本的取消被拒。REST 及 MCP `jobs_cancel` 先寫入 `cancel_requested`。本機替身讀回已發布時，任務收斂至 `published`；不確定時保持等待並拒絕重試，完整證據確認未發布後才進入 `cancelled`。每次以既有 worker 新建實例掃描，外部提交與撤回呼叫皆為 0。人工依據證據即時確認未發布的分支仍回 200，保留物件與版本。 |

檢查了現有 Web 核實動作與 SDK 的 HTTP 成功回應處理，並驗證 Commands 核實別名和正式 REST 呼叫。批次提交到審批、批次套用及對應核實作業是本輪的發布覆蓋範圍。核實 fixture 使用已提交的合成回執與程序內平台替身，搭配正式 HTTP／MCP 和真實 PostgreSQL。MCP 作業輸出沿用既有欄位白名單，完整逐項結果由 REST 查回。

### 目前缺口

- 資料採集涵蓋刷新與歷史回填。商店同步和公用採集 reconcile／resume 的完整 HTTP 行為仍待驗收。
- 自動發布的實際提交與平台 adapter、發布後貼文處置／核實、廣告佇列、匯入和檔案處理、報告產生／匯出、研究簡報與行銷活動結案，仍缺各自的端到端長任務證據。分析報告版本及匯出現走同步交易。整體 P0 依然部分覆蓋。
- P1 的持續進度實跑覆蓋 Commands 採集，既有一次性 MCP 查詢進度及 Operations 工作區 SSE 另有回歸。P2 目前提供 `jobs_get` 的選用 Tasks 查詢。原生 `tasks/list` 與 `tasks/cancel` 未宣告，取消仍走 `jobs_cancel`。

### 回歸

AI05 PostgreSQL 通過 2 案，既有 AI04／AI05 PostgreSQL 通過 2 案（約 244 秒），AI03 通過 2 案，AI02 套件通過 3 案。MCP、Agent、採集、Commerce worker 和工作區回歸通過 36 案。`pnpm typecheck` 通過。

### 重跑

```sh
SMARTSELL_AI05_CLAUDE="$(command -v claude)" bash tests/acceptance/ai05-postgres.sh
bash tests/acceptance/agent-lifecycle-postgres.sh
bash tests/acceptance/ai03-postgres.sh
bash tests/acceptance/with-postgres.sh ai02
pnpm typecheck
node --import tsx --test apps/server/src/extensions/mcp-streamable.test.ts \
  apps/server/src/extensions/mcp-commands.test.ts apps/server/src/modules/ingest/operations.test.ts \
  apps/server/src/modules/agent/operations.test.ts apps/server/src/integration/commerce-jobs.test.ts \
  tests/acceptance/workspace-http.test.mjs
```

## 2026-11-20 報告版本生成 P0 續驗

`plan.md` 第 7135 行的 `POST /reports/{id}/versions` 在 Commands 相容 REST 與獨立 Operations 都回 `202` 和 `data.operation_id`。Commands 原生 `analytics.reports_generate_version` 同樣回 `202`。Worker 使用既有持久化 outbox，將新版本與作業結果一併提交。`GET /operations/{id}`、`GET /jobs/{id}` 及 MCP `jobs_get` 可查詢狀態及 `result_ref`，版本內容仍由原讀取入口取得。主 Reports 工作台排隊時顯示作業 ID，授權角色可取消，完成後顯示草稿並更新版本列表。相容版 Reports 等待同一作業完成，再用原 Commands 流程讀取草稿與顯示定稿動作。

在真實 Claude Code 2.1.311 會話執行，父程序為 `/opt/homebrew/bin/claude`，`CLAUDECODE=1`，入口為 `sdk-cli`。應用與驗收使用 Node v24.21.0、pnpm 10.11.0。既有 AI05 fixture 以 loopback PostgreSQL 17.11 為 Commands 與 Operations 各開一個新建資料庫。實際 `claude mcp list` 對兩服務送出 MCP `2025-11-25` 初始化，無 Tasks 能力。REST 和 MCP 工具的狀態、版本引用及取消由正式 HTTP 路由與官方 MCP SDK 驗證。

- 先以 API 和 MCP 角色提交並確認排隊，再重啟。相同冪等鍵找回原 ID，換內容重用鍵遭拒。REST 和 MCP 各取消一筆待處理作業，過期版本及唯讀憑證的取消遭拒。啟動 worker 後成功作業只新增一版，取消作業沒有產生版本。再次重啟並重送仍能取得原作業 ID 與原版本。
- PostgreSQL 實跑驗證 editor 無法定稿、owner 帶過期版本無法定稿、owner 帶正確版本可以定稿。Commands worker 讀到實際寫入的觀測值 42，後續新增觀測後原版結果仍相同。瀏覽器實跑涵蓋 DS07 原始採集、匯入與交易來源，補採及留存清理過後已交付版本仍指向原先凍結的證據。Operations 的即時交易報告沿用 worker 取樣時的現在時間，因現行交易來源不支援歷史快照。指標報告與 Commands 報告使用提交時確定的截止時間。
- AI05 PostgreSQL 共 6 案通過。本輪指定 Playwright 回歸共 7 案通過，涵蓋主工作台及相容版、CA06 補採、客戶交付和版本審批。分析、交付與行銷回歸 37 案，以及 MCP、Agent、OpenAPI 與分析契約回歸 43 案均通過，兩組有重疊。`pnpm typecheck` 通過。Fixture 容器隨腳本退出，沒有建立或拉取 Docker 映像。

### 報告匯出

現有同步 CSV／PDF 的凍結版本匯出、來源權限及客戶下載回歸已通過。第 7139 行的非同步匯出仍是獨立缺口。

### 重跑報告生成驗收

```sh
nvm use 24.21.0
SMARTSELL_AI05_CLAUDE="$(command -v claude)" bash tests/acceptance/ai05-postgres.sh
pnpm exec playwright test tests/web-e2e/{analytics,campaign,portal}.spec.mjs \
  --grep 'DS07|AI05 compatibility|Backfill creates a new report|named client searches|pinned revision' --workers=1
pnpm typecheck
```

## 2026-11-20 報告版本匯出 P0 續驗

`plan.md` 第 7139 行的 `POST /reports/{id}/versions/{n}/export` 在 Commands 相容 REST 及獨立 Operations 均為 PDF、CSV、XLSX 回傳 `202` 與 `data.operation_id`。操作保存指定的報告 ID、版本 ID、版號及格式。正式 Reports 可在重載後找回原作業、取消排隊中的作業，並從工作區下載入口取得完成檔案。原本依版本 ID 的同步入口和相容版 Commands 下載流程繼續提供 CSV／PDF。XLSX 使用既有 ZIP 套件，Unicode 及以 `=` 開頭的儲存格以文字保存。

- 在 Node v24.21.0、pnpm 10.11.0 與 loopback PostgreSQL 17.11 實跑 AI05 共 **8 案通過**。兩個入口各用一個獨立資料庫。匯出案例先在無 worker 的 API 排隊，再由新的程序處理，最後從另一個程序讀回原 `operation_id` 與相同下載位元組。REST `/operations`、`/jobs` 及官方 MCP SDK `jobs_get` 讀回版本 1，處理作業前已定稿更新的版本。CSV 與 PDF 和同步入口逐位元組相符。用既有 XLSX 匯入解析器讀回完整的中英文、符號及 emoji 純文字。
- 相同冪等鍵重送取得原 ID，換格式重用鍵回 422。過期版本的取消回 409，授權取消成功後下載回 404。模擬目標物件已寫入、資料庫尚未提交的中斷，worker 核對長度及雜湊並保留原物件。取消後由 outbox 清理未提交的物件。提交及下載拒絕無匯出權限的角色。排隊後撤銷來源的 export 許可，或原申請人無有效成員資格，worker 將作業標記為失敗。完成後撤銷來源許可，下載及原冪等鍵重送均回 403。兩個入口的通用檔案 API 拒絕讀取報告匯出檔，獨立 Operations 的分享預覽也拒絕將其當作可分享資產。
- 正式 Playwright **5 案通過**，涵蓋正常產生與定稿兩版後從版本 1 匯出 XLSX、重載取回作業與下載、重載後取消排隊中的匯出、相容版工作台的同步 CSV 下載，以及客戶入口的釘選版本與既有下載。分析、工作區 OpenAPI 及 portal HTTP 回歸 **38 案通過**，`pnpm typecheck` 通過。

PostgreSQL fixture 使用本機快取的 `postgres:17-alpine`，以 `--pull=never` 啟動，另建臨時本機媒體目錄。腳本結束時清理專用容器及目錄。驗收使用合成資料與 loopback 服務。

### 重跑報告匯出驗收

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
bash tests/acceptance/ai05-postgres.sh
pnpm exec playwright test tests/web-e2e/{analytics,portal}.spec.mjs \
  --grep 'official Reports (resumes|cancels)|AI05 compatibility|pinned revision|named client searches' --workers=1
node --import tsx --test apps/server/src/modules/analytics/{analytics,analytics-http,operations}.test.ts \
  tests/acceptance/{portal-http,open-api-http}.test.mjs
pnpm typecheck
```
