# Agent／MCP 本機驗收紀錄

依 `plan.md` §5.17.12、`社媒運營系統_完整功能方案_繁體.md` AI02／03／04／05／08 與 `evidence.json` 的現有證據和缺口續跑。範圍是獨立本機 PostgreSQL、正常授權、合成測試資料和無模型外送。本檔紀錄本輪覆蓋範圍及尚待驗收的主張。

| 項目 | 本輪待驗 |
| --- | --- |
| AI02 | 真實授權撤銷後，已開啟的 SSE／MCP 在 60 秒內失效。 |
| AI03 | 同工作區兩個品牌的知識搜尋、MCP 資源和 Agent 上下文預覽隔離。 |
| AI04 | 兩份有效憑證同時領取只有一份成功；租約到期後，先按待核實狀態處理，再核對復領及舊租約。 |
| AI05 | 正式長任務回 202 和可恢復的 `operation_id`，核對進度與取消。 |
| AI08 | 真實收件記錄保留測試文字與來源，工具鏈把文字當資料，核對刪除意圖和寫入。 |

## 執行紀錄

以下保留前次測試結果。2026-11-20 續跑在改碼前執行 `printenv CLAUDECODE`，輸出為 `1`。本輪使用 Node v24.21.0、pnpm 10.11.0 和獨立 loopback PostgreSQL 17.11，模型對照僅使用本機 HTTP 替身。

- 已確認 Claude Code 會話並比對兩份原稿與現有證據。使用 nvm 已安裝的 Node v24.21.0、pnpm 10.11.0 及獨立 Docker PostgreSQL 17.11。服務與資料庫均綁定 loopback 臨時連接埠。
- `bash tests/acceptance/with-postgres.sh ai02` 通過兩案。從撤銷請求開始到 EOF，Operations workspace PAT 為 41 ms，Operations MCP PAT 為 1,994 ms，Commands MCP PAT 為 1,989 ms。Operations 登出至 workspace cookie stream EOF 為 86 ms。新請求回 401，同使用者另一份授權仍可使用。
- 現有 `agent-local.test.mjs` 的 OAuth／PKCE 撤銷和 AI08 本機存檔案例通過。整檔初跑為 2 通過、1 失敗，AI07 在 `/work-items` 建立測試資料時收到 422 `Invalid type`。
- AI04 中斷前在 MCP `jobs_get` 收到 `NOT_FOUND`。當時使用 editor，而工作未分派且由另一人建立。本輪基於接手時既有的 owner 與受邀 admin 兩份 PAT 重跑，並啟動實際 worker／scheduler，讓租約到期由正式維護流程落盤。
- `bash tests/acceptance/agent-lifecycle-postgres.sh` 在 PostgreSQL 17.11 通過 AI04 與 AI05。AI04 的 owner 取得 v2／fence 1，受邀 admin 同時領取回 `VERSION_CONFLICT`，用錯憑證續租回 `LEASE_LOST`。API／MCP 等待真實 120 秒租約到期，確認仍由原人持有、拒絕另一人領取，才啟動維護程序落盤為 v4／`lease_expired`。工作項為 `blocked/verify_side_effects`，沒有自動改派。未確認核實回 409，確認後回 `open` v5，第二人復領 v6／fence 2，舊 fence 回 `LEASE_LOST`。另一筆未領草稿保持 `open`，模型請求與 AI 用量皆為 0；明確請求的對照工作各產生 1 筆。
- AI04 維護程序自領取前啟用時另有阻塞：有效 PAT 的續租成功，約數秒內卻提前寫成 `lease_expired`。因此上述重跑在到期後才啟動維護。Commands 背景身分與 Agent 租約憑證整合需另行確認，正式長駐維護下的租約完整主張仍待驗。
- AI05 Agent 草稿正式 HTTP 建立回 202，重啟以同冪等鍵取得原 `operation_id`。`jobs_get` 的 SSE 回應先送帶 `progressToken` 的 `notifications/progress`，再送原任務結果，進度為 `claimed` 版本。`jobs_cancel` 先記錄請求，原租約確認才轉 `cancelled`，建立、取消請求、取消完成各一次。此案覆蓋查詢回應的 MCP 進度，持續推送、其他模組的 202 契約和宿主 Tasks 尚待驗。
- 本輪重跑 AI02 PostgreSQL 兩案皆通過。從撤銷請求開始到 EOF，Operations 工作區 PAT SSE 為 47 ms、Operations MCP 為 1,993 ms、Commands MCP 為 2,001 ms、Operations 登出工作區 cookie SSE 為 69 ms。撤銷憑證的重連／新請求回 401，同使用者的另一份授權仍可用。
- 最後一輪 `bash tests/acceptance/with-postgres.sh ai02` 通過 3 案，含 AI03。依相同順序，AI02 的 EOF 為 50、1,977、1,987、87 ms。OAuth／PKCE 的簽發、已開啟 MCP SSE 撤銷和 401 重連另在本機檔案庫通過。
- AI03 在正式 Operations／PostgreSQL 用 REST 建立兩個品牌的同名知識、核准第一版後再提第二版。品牌查詢及上下文預覽只返該品牌核准版及修訂號，搜尋另一品牌的標記或未核准版均為空。MCP `agent_preview_context`、knowledge 資源與 REST 預覽一致，此 PostgreSQL 夾具用的是 owner。品牌範圍 viewer 的 404、同一 PAT 受即時範圍變更約束，以及資源隔離在 `workspace-access.test.mjs` 的本機檔案庫重跑通過。該夾具先建立測試成員，再透過正常登入、角色設定和 PAT 簽發行使權限。
- `bash tests/acceptance/agent-lifecycle-postgres.sh ai08` 通過 1 案。正式 Operations 收件入口在 PostgreSQL 儲存「刪除所有排程」測試文字。Runner 第一次請求未帶該文字，讀取後僅在 `untrusted_content` 中提供文字、來源、對話／訊息 ID 及擷取時間。loopback 測試替身的正常摘要只留下成功的讀取審計，無刪除意圖。另一工作以替身送出未提供的刪除工具名，Runner 回 `TOOL_UNAVAILABLE`，審計為 `denied`／`side_effect=false`，無結果引用。兩輪後原排程 ID 及資料完全相同。此案驗證 Runner 的工具邊界，模型行為僅涵蓋測試替身。
- `workspace-access.test.mjs`／`workspace-http.test.mjs` 篩選 AI02／03／04／05／08 通過 7 案，含手機與帳號自動模式寫入從 MCP 排除、待核實效果交接、變更預覽／人工審閱與保留較新人工作業。
- `agent-local.test.mjs` 與 Agent 領域、MCP Streamable 回歸共 21 案通過。前次 AI07 碰到的測試資料型別和管理路徑已修正為 `todo` 與 `/admin/egress-policies/workspace`，仍使用本機替身。

### 2026-11-20 續跑

- 從固定快照 `.local/qa-turn/verify-resume.log` 第 745–825 行重跑，改前 0 通過、4 失敗。Operations `/mcp` 的新 catalog 在檢查 PAT 前排除了工具。修復後 file kernel 的 `items_get`、CO03 的授權讀取與三個 `human_selection_required`、PL05 的 `publishing_get_target` 與四個審批排除斷言、IN04 的正常委派競爭與 `LEASE_HELD` 均通過。正式 `tasks_get`、A06 的租戶與 PAT 邊界、AI02 的連接器自動模式排除也通過，共 7 案。日誌為 `.local/qa-turn/mcp-pat-before.log` 和 `.local/qa-turn/mcp-pat-after.log`。
- AI04 在獨立 PostgreSQL 啟用 worker／scheduler 後重現未到期租約被持久化為 `lease_expired`。AI05 子案也收到提前變更的進度。Commands 後台原本以普通記錄查詢讀取個人 PAT，RLS 使查詢結果為空。新遷移只允許後台在已綁定的工作區交易取得有效 PAT 的 ID 與持有人 ID。測試確認 request 角色無執行權限、後台在範圍外或交易結束後查無結果，且無法直接讀取 PAT 記錄。改前日誌為 `.local/qa-turn/ai04-background-before.log`。
- `bash tests/acceptance/agent-lifecycle-postgres.sh` 在 PostgreSQL 17.11 通過 AI04 和 AI05（2 案，約 244 秒）。worker／scheduler 從每次啟動即運行，至少一個實際維護週期保留了未到期的續租。Owner 取得 v2／fence 1，另一份 PAT 領取回 `VERSION_CONFLICT`，錯憑證續租回 `LEASE_LOST`。到期後維護落盤為 v4／`lease_expired`，工作項為 `blocked/verify_side_effects`，原持有人未變。核實前拒絕再領及續租，未確認核實回 409；確認後開放 v5，另一人復領 v6／fence 2，舊 fence 被拒。撤銷復領者的 PAT 後，新 MCP 請求立即回 401，後台在該租約原到期前落盤回收，另一份 PAT 仍可查詢。未領草稿維持 `open`，模型請求及 AI 用量均為 0；明確請求的對照各為 1，模型只連本機替身。日誌為 `.local/qa-turn/ai04-background-after.log`。
- `bash tests/acceptance/with-postgres.sh ai02` 通過 3 案，含 AI03 子案。從撤銷或登出開始至 EOF，Operations 工作區 PAT SSE 為 37 ms、Operations MCP 為 1,995 ms、Commands MCP 為 1,996 ms、Operations 登出 SSE 為 53 ms。撤銷憑證的新請求回 401，另一份授權仍可用。日誌為 `.local/qa-turn/ai02-pat-after.log`。
- 本機 OAuth／PKCE MCP 與 PAT 工作區 SSE 撤銷也重跑通過。含連接器自動模式排除共 3 案，日誌為 `.local/qa-turn/ai02-local-after.log`。
- `pnpm typecheck` 通過。MCP Streamable／Commands 與 Agent 領域的 19 案通過，日誌為 `.local/qa-turn/mcp-pat-unit.log`。

## 重跑命令

在 repo 根目錄以 Node v24.21.0、pnpm 10.11.0 執行。PostgreSQL 腳本使用本機已有的 `postgres:17-alpine` 映像（本輪為 17.11），每次啟動新的容器與 loopback 隨機連接埠。AI04 從啟動時即啟用 worker／scheduler，等待實際租約到期與後續撤銷維護週期，整組約需四分鐘。

```sh
bash tests/acceptance/with-postgres.sh ai02
bash tests/acceptance/agent-lifecycle-postgres.sh
bash tests/acceptance/agent-lifecycle-postgres.sh ai08
node --import tsx --test --test-name-pattern='file kernel|discovers every advertised|A06|CO03|PL05|IN04|AI02 keeps' \
  apps/server/test/kernel.test.ts tests/acceptance/flows.test.mjs \
  tests/acceptance/inbox-contested-http.test.mjs tests/acceptance/workspace-access.test.mjs
node --import tsx --test --test-name-pattern='AI02|AI03|AI04|AI05|AI08' \
  tests/acceptance/workspace-access.test.mjs tests/acceptance/workspace-http.test.mjs
node --import tsx --test apps/server/src/integration/agent-local.test.mjs \
  apps/server/src/extensions/mcp-streamable.test.ts \
  apps/server/src/modules/agent/operations.test.ts \
  apps/server/src/modules/agent/agent-workflows.test.ts
```

## 正式入口的剩餘範圍

| 項目 | 剩餘條件或實作觀察 |
| --- | --- |
| AI02 | 正式 PostgreSQL 長連線以 PAT／登出驗收，OAuth 撤銷使用檔案庫。連接管理頁、實機連接器狀態與 P1／P2 能力未在本輪重跑。 |
| AI03 | PostgreSQL 的 Operations 與預設 Commands 均已驗受限 viewer 的搜尋、上下文和 MCP 資源，詳見下方續驗。品牌範圍由成員角色 PATCH 設定。流程模板管理及各階段擴充未重跑。 |
| AI04 | Commands／PostgreSQL 的長駐維護、PAT 提前撤銷及到期核實已驗。本輪未驗部署環境套用遷移、跨程序重啟後的租約復原或非 PAT 憑證的同等維護行為。 |
| AI05 | `jobs_get` 帶進度 token 時已實測 MCP POST 的 SSE 回應。持續推送及各模組的統一 202 尚欠驗收。Tasks 的 `operationTaskKey`／`readOperation` 在 MCP 適配器屬可選，正式入口尚未接入，未宣告宿主 Tasks 通過。 |
| AI08 | 已驗實際收件記錄與零刪除副作用。外部模型是否在讀取後自行提出刪除意圖，以及 P1／P2 的完整能力未驗。 |

## 2026-11-20 AI03 品牌權杖續驗

本節更新上表的 AI03 證據。原稿 `plan.md` §5.17.12 要求品牌 A 的權杖無法經搜尋與資源取得品牌 B 的知識。構思 AI03 另要求可預覽助手讀到的版本。

- 全域 `GET /search` 現可搜尋知識標題及生效且核准的正文，回傳知識 ID、品牌 ID、修訂 ID、修訂號和最多 300 字元的摘錄。搜尋與上下文共用生效修訂的核准檢查。全文只在本機關鍵字路徑使用，知識摘錄未加入既有的模型嵌入候選。
- **Operations／PostgreSQL**。夾具先建立合成成員與另一個有資料的工作區，再透過正式登入、成員角色 API 和 `/tokens` 簽發 viewer 的唯讀 PAT。A、B 各有一條同名知識，核准 v1 後再提 v2。登入會話和同一 PAT 的 REST 搜尋只回 A 的核准 v1，B 的正文標記、另一工作區的標記和未核准 v2 無結果。明確指定 B 的搜尋回 404。A 的 MCP `resources/read`、`agent_preview_context` 與登入會話的 REST 預覽一致。B 或另一個工作區的資源回 `-32602`，預覽工具回 `NOT_FOUND`。同一成員可用會話讀取另一個工作區的知識，原 PAT 搜尋該工作區回 404。將成員範圍從 A 改成 B 後，原 PAT 即時失去 A 的資源並取得 B 的核准 v1。
- **預設 Commands／PostgreSQL**。確認正常登入的 owner 能用 `/search` 找到兩個品牌的核准 v1，再依品牌篩選並預覽 A 的版本。正常邀請並登入 viewer 後，品牌角色 PATCH 回 503，指定 AI03 知識工具的 PAT 簽發回 422，一般唯讀 PAT 直接呼叫 REST 搜尋回 401，MCP `resources/templates/list` 回 `-32601`。預設入口的單一品牌 PAT 端到端驗收仍待 Commands 接上成員資源範圍、REST PAT 與 MCP 知識資源。此次沿用既有授權政策與 MCP 工具清單。流程模板分期未包含在本節。
- 在 `CLAUDECODE=1` 下修改。Node v24.21.0、pnpm 10.11.0、PostgreSQL 17.11。兩套入口使用同一全新 loopback 容器內的獨立資料庫和一般 request 登入。執行程序使用合成資料與合成憑證，模型配置為空，沒有模型呼叫。`bash tests/acceptance/ai03-postgres.sh` 通過 2 案，另通過 `pnpm typecheck`、24 案相關單元回歸與 1 案檔案庫 AI03 回歸。
- 恢復後以 Node v24.21.0 在新建的隔離 PostgreSQL 重跑 `bash tests/acceptance/ai03-postgres.sh`，2 案皆通過。Operations 同一 PAT 呼叫 `GET /brands/{id}/context` 取得 A 的核准 v1，指定 B 或另一工作區均回 404。該 PAT 呼叫 Agent 專用 REST `/agent-context` 時，即使指定 A 也依既有憑證政策回 403。版本預覽以正式登入會話走該 REST 路由，PAT 則走 MCP `agent_preview_context`，兩者輸出一致。會話在它有成員資格的第二個工作區也能預覽該處的核准版。Commands 再次得到上述四項阻塞回應。

### 預設 Commands 正式入口續驗

- Commands 使用成員角色 PATCH 儲存 viewer 的品牌授權。預設入口的 REST 和 MCP 共用 Operations 的品牌篩選與核准版本投影。Commands PAT 的工作區與工具授權依簽發記錄，成員角色與品牌範圍於每次使用時重讀。
- 在 Claude Code 2.1.311 會話以 Node v24.21.0、pnpm 10.11.0 和隔離的 loopback PostgreSQL 17.11 執行 `bash tests/acceptance/ai03-postgres.sh`。Commands 和 Operations 各通過 1 案。兩案都以正式登入和 `/tokens` 簽發唯讀 PAT，使用合成資料，無外部模型請求。第二工作區的會籍由測試夾具配置，知識、商品事實及其版本走正式 API 建立。
- 同一枚 Commands PAT 只取得 A 的核准 v1。REST 和 MCP 搜尋排除其他品牌及草稿。明確指定 B 或另一工作區時，REST 回 404，MCP 資源回 `-32602`，Agent 預覽工具回 `NOT_FOUND`。商品事實資源排除草稿文字與修訂 ID。登入會話可讀取它另有成員資格的第二個工作區。將 viewer 的品牌範圍從 A 改為 B 後，原 PAT 下一次請求即失去 A，並可取得 B 的核准知識、預覽與商品事實。
- 只授予搜尋工具的 PAT 讀品牌上下文回 403，MCP 資源樣板清單為空，該 PAT 撤銷後 REST 搜尋回 401。Agent 專用 REST 預覽沿用會話授權，PAT 由 MCP 取得相同的核准預覽。
- `pnpm typecheck` 通過，`with-postgres.sh ai02` 通過 3 案，`with-postgres.sh` 的相容性回歸通過 3 案，`domain-postgres.sh` 通過 12 案。MCP、工作區與相關領域回歸通過 70 案，另以專用的 loopback 資料庫補跑 PostgreSQL 核心 RLS 與提交後通知，2 案均通過。

## 2026-11-20 AI07 雙協定 Runner 續驗

依 `plan.md` §5.17.12 與構思 AI07，在 Claude Code 2.1.311 編修。改碼前確認父程序為 `/opt/homebrew/bin/claude`，`CLAUDECODE=1`。驗收使用 Node v24.21.0、pnpm 10.11.0、PostgreSQL 17.11 和獨立無頭 Chromium。

- 首跑兩個正式入口在能力探測均回 502。修正共享解析器從回應的 `model` 欄位取得實際模型標識，欄位省略時保留請求中的模型名稱。空輸出仍記入用量，工具探測明確儲存 `tool_calling: false`。截斷回應交回人工處理，工作保留 `open` 且省略 `result_ref`。
- `bash tests/acceptance/ai07-postgres.sh` 通過 **2/2**。預設 Commands 與 Operations 各使用全新資料庫、正式登入及工作區 API。兩種回環 HTTP 替身分別核對 Chat Completions 與 Anthropic Messages 的路徑、合成憑證標頭及工具結果格式。能力探測只送合成指令，空輸出及無效工具 ID 無法啟用 Runner。
- 每個入口的兩種協定均完成三次模型請求。Runner 讀取指定待辦、提出改名、提交人工審閱。人工套用前待辦維持原標題。重播相同冪等鍵不會再呼叫替身。每次成功執行有兩筆無副作用工具審計和三筆互相連結的模型請求／用量紀錄，共 42 tokens。審計區分路由指定模型與替身回報的實際模型版本，請求紀錄不含待辦標題。
- 預算耗盡及外送拒絕均在派送前阻擋，請求審計顯示 `dispatched: false`，無用量紀錄。已讀取但未獲准外送的品牌上下文未出現在任何後續請求。越界提案被拒絕並留下工具審計。四輪上限、截斷、替身 HTTP 錯誤及重導向均交回人工處理，沒有自動切換供應商。
- Chromium 在預設 Commands 的實際工作台確認，空配置仍可開啟待辦與 Agent 工作詳情，頁面助手與執行 Agent 按鈕隱藏。配置允許的 `draft`／`plan` 路由後，兩個入口可開啟。獨立空配置人工流程回歸 **1/1**，模型與 Agent 回歸 **17/17**，`pnpm typecheck` 通過。

測試程序以空環境及臨時 home 啟動，Chromium 使用 mock keychain 並阻擋工作台 origin 之外的頁面請求。PostgreSQL、應用與模型 HTTP 替身使用 `127.0.0.1`。所有帳號與資料均為合成。腳本沿用本機快取映像，結束後移除臨時容器及夾具。驗收結果適用於本機 HTTP 替身。真實供應商、外部閘道與正式憑證未納入驗收。

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
# SMARTSELL_AI07_DOCKER_SOCKET 指向本機 Docker Unix socket。
# SMARTSELL_AI07_CHROMIUM 指向已安裝的 Chromium headless shell。
bash tests/acceptance/ai07-postgres.sh
```
