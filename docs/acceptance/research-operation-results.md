# P1 研究簡報長任務驗收

2026-11-20 於 Claude Code 2.1.311 會話，使用 Node v24.21.0、pnpm 10.11.0 和 PostgreSQL 17.11。沿用 AI05 的隔離測試配置，用本機既有 `postgres:17-alpine` 映像建立兩個獨立的暫存資料庫，分別啟動 Commands (`bootstrap.start`) 和 Operations (`startKernel`) 的正式 HTTP 入口。應用只使用合成觀測與本機合約 fixture。手動觀測經 REST 建立，供應商估算經現有觀測寫入器注入合成資料。Claude Code CLI 在隔離設定目錄對兩套 `/mcp` 執行 `mcp add` 與 `mcp list`，兩次均顯示 `Connected`，`jobs_get` 和 `jobs_cancel` 則由 MCP SDK 經真實 HTTP 驗證。全程未設定模型，也未呼叫真實平台或供應商。

## 範圍與結果

對照 `plan.md` 第 3714 行、§4.12 與 §5.17.12 的 AI05。

| 驗收項目 | Commands 與 Operations 實測 |
| --- | --- |
| 正式接受、權限與版本 | `POST /research-digests` 回 `202`，`data` 只有 `operation_id`。`If-Match` 使用研究板版本，缺少回 `428 VERSION_REQUIRED`，過期回 `409 VERSION_CONFLICT`。有研究板草稿權限的人工角色可提交，證據未獲匯出授權回 `403 EGRESS_BLOCKED`。降為 viewer 後重送回 `403 PERMISSION_DENIED`。 |
| 重送與重啟 | 同一 `Idempotency-Key` 並發重送回同一 ID，變更請求內容後使用同一 key 回 `422 IDEMPOTENCY_MISMATCH`。停掉 API 並重啟後，REST 和 MCP 仍可讀回已排隊的原作業。worker 完成後再次重啟，原 ID、結果引用與簡報內容保持一致，每個資料庫的正式研究簡報共一筆。 |
| 取消 | REST 取消缺少版本回 `428`，錯版本回 `409`。只有 `jobs_get` 的唯讀憑證不能呼叫 `jobs_cancel`。授權寫入憑證配合正確版本取消後，worker 啟動時作業仍為 `cancelled`，無結果引用，亦無額外簡報記錄。 |
| worker 重新驗證 | 入隊後把提交者從 editor 降為 viewer，作業 `failed / FORBIDDEN`。入隊後更新研究板，作業 `failed / VERSION_CONFLICT`。入隊後撤回來源匯出許可，作業 `failed / EGRESS_BLOCKED`，既有簡報的讀取同樣被拒絕。三筆均無新增簡報。 |
| 引用與數值 | `GET /operations/:id` 和 MCP `jobs_get` 提供相同的 `result_ref.research_digest_id`。`GET /research-digests/:id` 保留 `sections.facts`、`sections.estimates`、`sections.recommendations`，逐項核對事實引用的觀測 ID、URL、likes 42，估算引用的觀測 ID、估算標記、sales 20，以及建議所引用的研究筆記 ID 和文字。 |
| 兼容入口 | Commands 原生 `generate_research_digest` 仍可透過原先的條目清單輸入取得 `200`，驗證 `status: ready`、`evidence_refs` 和原有 `sections`。工作台的研究板使用正式研究簡報路由，送出研究板版本，再以作業 ID 查詢及下載 JSON。 |

## 可對照的實測記錄

| 服務 | `operation_id` | `research_digest_id` | 事實觀測（likes 42） | 估算觀測（sales 20） | 建議筆記 |
| --- | --- | --- | --- | --- | --- |
| Commands | `7507e605-21a9-487f-b1eb-ab5bd8294fad` | `99311360-33b4-4f0c-bb89-d34bef5e1390` | `f4902bbe-86d3-4e44-a2d1-b9f13298cf4f` | `e98018fb-0a10-441b-9ce0-ac67eec105ac` | `f3a8bfe1-88db-4732-bdfb-317269193911` |
| Operations | `6fee8b11-2066-4d73-80ce-5275a4743a75` | `43463ac9-6923-4ef0-88ef-94088ba7e215` | `3c99c9ec-1f38-4e75-8590-4a162e65243b` | `c413ec94-0210-4931-98be-e26910c954d9` | `36392206-3d13-41e0-8046-dee18ea4cf4f` |

這些 ID 來自已清理的隔離資料庫。重跑會產生新 ID，測試輸出保留當次的引用關係和數值。

## 執行命令

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
SMARTSELL_RESEARCH_CLAUDE="$(command -v claude)" bash tests/acceptance/research-operation-postgres.sh
node --import tsx --test apps/server/src/modules/intel/intel-{operations,mentions}.test.ts tests/acceptance/intel-mcp-http.test.mjs
node scripts/vitest.mjs '' "$PWD/apps/server/src/modules/intel/workflows.test.ts"
pnpm exec playwright test tests/web-e2e/intel.spec.mjs --workers=1 --output /tmp/smartsell-research-playwright
pnpm exec tsc --noEmit
```

PostgreSQL 端到端測試 2／2，Intel 和 MCP 回歸 18／18，舊版 Intel 工作流程 7／7，工作台 Playwright 3／3，共 30 項通過。工作台測試實際提交研究簡報並檢查下載 JSON 的觀測引用。TypeScript 型別檢查通過。資料庫 fixture 使用快取映像與 tmpfs，結束時移除本次容器。沒有建置或下載映像。

## 仍缺的驗收

本次使用 REST 和 MCP 輪詢。未測研究簡報的 MCP Tasks 及 SSE 進度通知，也未測 worker 執行中強制中斷。現有工作台顯示作業 ID 並在頁內輪詢，頁面重新載入後的恢復可使用 REST 或 MCP 及原作業 ID。
