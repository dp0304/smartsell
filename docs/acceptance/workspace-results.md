# 工作區、Agent、團隊與營運驗收結果

本輪以 `plan.md` 的最終行為和 `evidence.json` 的缺口為準。Command 測試透過現有 `bootstrap.start` 在本機開 HTTP socket，重啟時沿用 SQLite。Operations 測試用現有 `createServer`、檔案庫及正式登入、成員授權和 MCP token；部分資料以 fixture 建立，行為斷言均經 HTTP/MCP。Chromium 測試透過專案本地啟動器使用主工作台。

## 優先項目

| 編號 | 可重現的結果 | 適用範圍 |
| --- | --- | --- |
| AI05 | 建立 Agent 工作時取得服務端 `operation_id`，領取後關閉並重啟服務。重送同一 idempotency key 回原 ID，新的 MCP 請求用原 ID 查到 `claimed` 與原版本。請求取消後用原租約 fencing token 確認，REST `/operations/:id` 及 MCP 均讀到 `cancelled`。再取消回同版本，全程只有一筆工作及各一筆建立、請求取消、取消事件。另用模板套用驗證通用作業 `succeeded` 可經 MCP 查回。 [Agent 案例](../../tests/acceptance/workspace-http.test.mjs#L72) · [通用作業案例](../../tests/acceptance/workspace-http.test.mjs#L222) | 已驗證 REST 建立、REST/MCP 恢復及取消。通用作業查詢支援 `operation` 記錄，Agent 工作有取消處理。各模組長任務全面遷入，以及統一 `202`、進度推送、宿主 Tasks 尚未驗收。 |
| TE06 | workspace、workflow、report 三種範本由來源工作區經 HTTP 匯出，在獨立目的工作區匯入並套用。來源含連接、密封秘密、客戶、權利授權、發布目標，以及注有相同欄位的舊範本。目的讀取或套用來源 ID 回 `404`，嵌套客戶物件與帶成員 ID 的角色物件遭拒。目的連接集合為空，持久記錄無五類來源資料或 canary。保留白名單結構、套用紀錄及預設停用的審批政策。重送及重啟維持原 `operation_id`。 [測試](../../tests/acceptance/workspace-http.test.mjs#L162) · [實作](../../apps/server/src/modules/team/workspace-templates.ts#L7) | 兩個實際 HTTP 服務與獨立 SQLite。可攜欄位是經管理員挑選的短文字標籤與角色列舉。品牌化、自訂網域與代理商批次設定另計。 |

## 本地驗收逐項證據

| 編號 | 結果與證據 |
| --- | --- |
| WS01、WS03、AI03 | 指定同工作區品牌的 viewer 透過正式角色 API 授權。REST 和 MCP 查 `新品` 的命中與計數相符，他品牌明確 REST 查詢 `404`，`resources/read` 拒絕他品牌知識及商品事實，素材和版本透過 REST 驗證。授權換到第二品牌後，原 session 與 token 立即依新授權讀取。改英文介面後，日本市場與內容語系保持不變。品牌滿額 `402 LICENSE_LIMIT`，已存品牌仍可用，封存後可新增。 [作用域](../../tests/acceptance/workspace-access.test.mjs#L63) · [品牌額度](../../tests/acceptance/workspace-access.test.mjs#L152) |
| WS02 | 實際 owner HTTP 啟用工作區緊急停止，Today 顯示一筆及 Workspace 來源，釋放後重載消失。領域回歸另測兩種停止來源合併，釋放工作區停止時保留 Ops 停止，來源不可用時總數為 `null`。 [Chromium](../../tests/web-e2e/primary.spec.mjs#L201) · [領域測試](../../apps/server/src/modules/workspace/operations.test.ts#L97) |
| WS04 | 透過發布提交產生真實審批通知與待辦，瀏覽器標記已讀後待辦仍在個人收件匣。發布審批完成後待辦自動結案，通知維持已讀。 [HTTP](../../tests/acceptance/workspace-access.test.mjs#L232) · [Chromium](../../tests/web-e2e/primary.spec.mjs#L117) |
| WS05 | 兩帳號缺互動觀測時摘要 `null`，瀏覽器顯示 `—` 和 `0 / 2`。經證據輸入記錄其中一個帳號的真零後，摘要顯示 `0` 和 `1 / 2`。 [Chromium](../../tests/web-e2e/primary.spec.mjs#L158) |
| WS06 | owner 檢查歷史同步步驟後停在 blocked；第二個管理員用本機單身份 fixture 切換身份並重新登入，讀取同一步驟 ID、略過並記錄該管理員，Today 顯示影響。 [Chromium](../../tests/web-e2e/primary.spec.mjs#L221) |
| AI02 | 完整 write MCP token 可使用 Agent 作業工具，但 discovery 與 call 均排除開啟／放寬自動模式、修改執行綁定、開啟手機與解除工作區停止。撤銷 token 後下次 MCP 請求立即 `401`。 [測試](../../tests/acceptance/workspace-access.test.mjs#L264) |
| AI04 | MCP 交接後保留待核實收據、摘要及原操作者，待辦保持 `verify_side_effects` 阻塞。再次領取和未明確確認的核實遭拒；人員確認後同一工作重開，歷史仍留原交接與核實記錄。 [測試](../../tests/acceptance/workspace-http.test.mjs#L110) |
| AI06 | 正式 HTTP 設定並啟用規則，現有排程器啟動後建立確定性待辦與 Agent 工作。等候原因是 `awaiting_agent_claim`，MCP 領取後為 `acting`，重啟後同一分鐘 bucket 仍只有一筆。 [測試](../../tests/acceptance/workspace-http.test.mjs#L135) |
| AI07 | 全新工作區 `/ai/status` 回 `enabled:false` 和空用途，供應商集合為空，核心待辦可建可讀。 [測試](../../tests/acceptance/workspace-access.test.mjs#L279) |
| AI08 | MCP 建立變更集，REST 可預覽 before/after；MCP 無套用工具。人員套用第一項並明確略過第三項，第二項因中途人工修改返回 `conflict`。之後拒絕剩餘項仍保留 `skipped`，人工與略過目標的資料均保留。 [測試](../../tests/acceptance/workspace-access.test.mjs#L287) |
| TE01、TE02、OP10 | 席位已滿時邀請回 `402 LICENSE_LIMIT`，移除成員後可邀請。早期 Operations runtime 實跑記錄移除後回 `401`。現行回歸確認移除後舊 PAT 回 `403`，見 [TE01 實跑紀錄](membership-access-results.md)。負載列出 Agent 指派，接收人接受移除轉派後，待辦原狀態、原建立人與轉派前後責任人保存。 [測試](../../tests/acceptance/workspace-access.test.mjs#L152) |
| OP10 唯讀 | 過寬限期后授權回 `read_only`，新增品牌 `402 LICENSE_READ_ONLY`。仍可匯出審計資料；經人員提供本地證據核實先前不確定的發布，原嘗試記錄轉為 `verified_absent`、核實完成，嘗試數維持一。 [測試](../../tests/acceptance/workspace-access.test.mjs#L201) |

## 復驗命令

使用 Node 24 與專案依賴。本機使用 `v24.22.3`，若 PATH 上的 Homebrew Node 無法載入 ICU，可先切換到已安裝的 Node 24。

```sh
node --import tsx --test tests/acceptance/workspace-http.test.mjs tests/acceptance/workspace-access.test.mjs \
  apps/server/src/modules/agent/operations.test.ts apps/server/src/modules/agent/agent-workflows.test.ts \
  apps/server/src/extensions/mcp-commands.test.ts apps/server/src/extensions/mcp-streamable.test.ts
pnpm exec playwright test tests/web-e2e/primary.spec.mjs --workers=1
pnpm typecheck
pnpm --filter @smartsell/web typecheck
pnpm exec tsx --test apps/server/src/modules/workspace/operations.test.ts apps/server/src/modules/workspace/workbench.test.ts
```

HTTP/MCP 與 Agent 回歸 **30/30**、Chromium **5/5**、工作區領域回歸 **16/16**，根工作區與 Web 型別檢查均通過。Chromium 首次合跑的登入測試仍等舊 `/api/v1/login`，實際已登入。測試改等現行 `/api/v1/session` 後整套重跑通過。另在獨立 Operations 進程以 `SMARTSELL_RUNTIME=operation SMARTSELL_DATA_FILE=<暫存路徑> PORT=<空閒端口> SETUP_TOKEN=<測試值> node --import tsx apps/server/src/command-main.ts` 啟動後，驗證健康入口 `200`、setup `201`、品牌 `200`、REST 與 MCP 搜尋均 `200` 及相同單一命中。

## 2026-11-20 主入口復驗

改動前在前景 Claude Code 2.1.311 確認 `CLAUDECODE=1`、`CLAUDE_CODE_ENTRYPOINT=sdk-cli`，使用 Node `v24.21.0`、pnpm `10.11.0` 及隔離本機資料。原測試在網址已切到 `/setup` 時便填寫兩個表單共用的 email 欄位。路由切換仍可能尚未完成，失敗快照中設定表單的 email 為空，其餘欄位已有值，瀏覽器未送出 `POST /api/v1/setup`。

測試現在等「首次設定」標題出現才填表，送出前核對 email，維持 setup `201`、獨立會話登入 `200` 和雙語介面斷言。一般 Playwright 重跑主入口 6/6 通過。`pnpm build` 通過，使用下列既有目標入口重跑，主入口與流量合計 9/9 通過。兩次均取消 `NODE_OPTIONS`。 [修正前日誌](../../.local/qa-turn/setup-traffic-before.log) · [一般執行日誌](../../.local/qa-turn/setup-traffic-after.log) · [建置版本日誌](../../.local/qa-turn/setup-traffic-built.log)

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
unset NODE_OPTIONS
pnpm build
pnpm test --built-web tests/web-e2e/primary.spec.mjs tests/web-e2e/traffic-metrics.spec.mjs
```

## 未結案範圍

- WS01/WS03/AI03 的正式品牌授權與 MCP resources 證據在 Operations runtime。Command MCP 仍有獨立工具清單及授權橋接缺口。全頁 1280px、Agent 的品牌資源預覽仍待補證據。
- WS02 剩下真實平台授權過期同步、條款通知與完成重新確認的端到端案例；Ops 與工作區停止重疊已有領域測試。WS06 的 Android 裝置、實際 App 身份核對及配對後權限需要測試手機與連接器。
- AI01 的瀏覽器助手建議轉審閱完整流仍待接入。AI02 已開啟的 SSE 連線撤權時限未測。AI06 自建 Runner 的正式執行仍待外部 Runner。AI07 供應商能力探測和兩種協議完整迴圈需要客戶授權的測試閘道；目前 UI 沒有消費 `/ai/status` 的模型入口可測啟停。AI08 真實留言到 Runner 的端到端流程、對外回覆與邀約變更集待驗。
- TE03–05 由團隊門戶工作追蹤，TE07 素材個別過期未在本輪複驗。OP01–09 的缺口保留在證據矩陣；其中真實商家、裝置、平台回執、雲端投遞環境與備份還原環境的子項需要各自的授權測試環境。OP10 的平台端實際 read-back 仍待平台 fixture 或授權商家；本輪完成的是有證據的人員核實。
