# OP02、OP03、OP05、OP10 專項驗收

範圍為設計原稿 [5.19.12](../../plan.md#51912-功能分期與驗收) 中的四項驗收。使用 Node `v24.21.0`、隔離本機服務及合成資料。此文件記錄證據與待驗範圍，共用矩陣由原負責流程維護。

| 項目 | 驗收結果 | 證據範圍 |
| --- | --- | --- |
| OP02 | SaaS SCIM 停用後，原有 PAT 與 OAuth access token 首次重用於 `/mcp` 均回 `401`。同次停用阻擋已領取、正在準備的發布任務及仍排隊的任務，合成 adapter 提交數為零。私有部署管理頁的 Chromium 測試通過。 | 本機驗收涵蓋 API worker 的領取前及提交前關卡。 |
| OP03 | 帳號撤銷後，已排隊任務以 `connection_revoked` 阻擋，worker 輪詢及直接派送均保持零提交、零嘗試及零作品。唯一合成值未出現在憑證清單、REST/MCP 的成功及錯誤回應、REST 審計及兩條錯誤日誌。 | 遮罩結論限於受測輸出。 |
| OP05 | 預覽依工作區覆寫重算。Operations 與預設 Commands 的正式 API 均將排程素材的實際 `file_object` 標示為 `scheduled_target`，批准清除後仍能讀回原始 PNG。Amazon 每日清理另有本機證據。 | 兩種啟動模式均使用隔離的本機 MinIO、合成帳號及透過正式 API 建立的素材、修訂和排程。 |
| OP10 | 席位達額回 `402`，移除成員後可邀請。進入 `read_only` 後，匯出包含指定審計列，worker 以原回執核實已發布作品。核實前後只有同一筆嘗試，提交數為零。 | 回執與作品來自本機合成 adapter，實際平台讀回與正式環境匯出未驗。 |

## 可追溯證據

- **OP02**。停用前，同一組 PAT 與 OAuth access token 可取得 MCP 工具清單。SCIM `PATCH active=false` 完成後，兩枚憑證的下一次 MCP 請求皆回 `401`。正在準備及尚在排隊的任務均記錄 `approval_invalid`。後者未建立嘗試，前者的原嘗試轉為 `abandoned`、未進入提交且釋放帳號寫入槽。獨立的 standing grant 測試亦覆蓋兩道關卡。私有管理頁的瀏覽器測試涵蓋 `zh-Hant` 與 `en` 的部署健康、部署設定、租戶成員頁，均未出現 SSO 文字或入口。 [HTTP 和 worker 測試](../../tests/identity/http.test.ts#L247) · [授權關卡測試](../../apps/server/src/modules/execution/operations.test.ts#L546) · [複驗日誌](../../.local/qa-turn/ops-authorization-continuation.log) · [UI 測試](../../tests/web-e2e/editorial-workspace.spec.mjs#L80) · [Chromium 日誌](../../.local/qa-turn/ops-authorization-browser.log)
- **OP03**。撤銷測試走帳號模組的連線撤銷操作，驗證密封值清空與舊工作零提交。遮罩測試以每次生成的唯一合成值覆蓋庫存、連線清單與撤銷、REST 審計、REST `500`、MCP 工具成功與錯誤，以及兩條實際請求錯誤分支送給 logger 的參數。合成庫存與上游錯誤由測試注入。 [撤銷測試](../../apps/server/src/modules/execution/operations.test.ts#L575) · [遮罩測試](../../tests/acceptance/operations-authorization.test.mjs#L57) · [複驗日誌](../../.local/qa-turn/ops-authorization-continuation.log)
- **OP05 回歸**。修正前，Operations 在 0 天保留政策下，`/admin/purge-runs` 的候選及阻擋清單均缺少實際檔案 ID，檔案預覽只回 `asset_version`。修正後，兩種啟動模式均透過預簽 MinIO PUT 上傳 68 bytes 的 PNG，完成檔案、素材版本、內容修訂及排程，並將目標批准至 `ready`。Operations 的 `/admin/purge-runs` 和兩種模式的 `/files/retention/preview` 都列出該檔案及 `scheduled_target`。既有 `asset_file` 資料仍由原有路徑處理。 [修正前日誌](../../.local/qa-turn/retention-s3.YLbrT2) · [MinIO 測試](../../tests/media/op05.test.mjs) · [舊資料測試](../../tests/acceptance/operations-authorization.test.mjs#L110)
- **OP05 覆寫及批准**。兩種模式均驗證保留期由 30 天改為 0 天後重算，改回 30 天後跳過舊候選。預覽後新增法定保留同樣阻止清除，涵蓋 Operations 的租戶繼承及 Commands 的工作區設定。解除保留後，批准清除未被引用的檔案。排程 PNG 經過清除及清理後仍能下載，內容與原始檔案逐 byte 相符。MinIO 套件 9 項通過，另有 40 項針對性測試通過，涵蓋原有保留流程、授權及 Amazon 每日清理。`pnpm typecheck` 通過。 [MinIO 日誌](../../.local/qa-turn/op05-minio.log) · [回歸日誌](../../.local/qa-turn/op05-targeted.log) · [型別檢查](../../.local/qa-turn/op05-typecheck.log) · [Amazon 驗收](ingest-quality-results.md)
- **預設 Commands 操作方式**。由工作區的 `GET /commands` 確認 `ops.get_retention_policies`、`ops.set_retention_policy`，再向 `/commands/ops/<action>` 送出具有 `Idempotency-Key` 的 POST。設定工作區素材政策可送 `{"data_class":"asset_file","retain_days":0,"action":"delete"}`。由 `/catalog` 查詢檔案操作，使用 `GET /files/retention/preview` 及 `POST /files/retention/purge`，後者傳入審閱過的 `files`，每筆含 `id` 及 `version`。預設主機的原始 `/admin/retention-policies` 回 `404`，本機工作區帳號要求設定租戶預設則回 `403`。 [Commands 目錄及授權驗證](../../tests/media/op05.test.mjs#L52)
- **OP10**。既有 REST 測試覆蓋席位達額、釋放和唯讀後的 `verified_absent` 核實。新增測試透過正式 API 確認 `read_only`、匯出狀態為 `completed`，且匯出內容含指定審計 ID、動作及原嘗試 ID。正式 worker 經 `observe` 讀取一次，帶入同一工作、原 `client_request_id` 和原回執。原嘗試由 `accepted` 轉為 `verified_published`，核實結果為 `published`，合成作品連結至原工作，待確認副作用清單為空。核實前後均只有同一筆嘗試，`submit` 呼叫數為零。 [既有席位測試](../../tests/acceptance/workspace-access.test.mjs#L179) · [既有缺席核實](../../tests/acceptance/workspace-access.test.mjs#L250) · [新增回執測試](../../tests/acceptance/operations-authorization.test.mjs#L139) · [Node v24.21.0 執行日誌](../../.local/qa-turn/ops-authorization-op10.NAJYC41I/result.log)

基準來源為 [共用證據矩陣](evidence.json) 及 [中斷前的證據彙整](../../.local/qa-turn/ops-final.json)。本次續作只執行新增的 OP10 測試，結果為 1 通過、0 失敗。較早的 58 項測試日誌有 57 通過及 1 跳過，跳過項目為 PostgreSQL 跨程序 TOTP。所有補驗均使用本機合成資料。

## 合併源碼的 OP10 與發布復驗

固定快照的 OP10 預期 `200`，實際收到 `202`。本次以 Claude Code CLI `2.1.311` 修正斷言。空請求的 `POST /execution-tasks/:id/reconcile` 先建立非同步核實操作並回傳 `operation_id`，因此 HTTP 回應為 `202 Accepted`。測試仍以該 ID 核對完成結果，並驗證原工作 ID、原嘗試 ID、原 `client_request_id`、原回執及零 `submit` 呼叫。 [固定快照日誌，第 848–865 行](../../.local/qa-turn/verify-combined-log.eTL1u7#L848) · [OP10 測試](../../tests/acceptance/operations-authorization.test.mjs#L139) · [HTTP 契約](../../apps/server/src/operations.ts#L208)

```sh
qa="$PWD/.local/qa-turn/publish-connector-regression.pf4Z6wmp"
test_path="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
env -i PATH="$test_path" MEDIA_DIRECTORY="$qa/media" node --import tsx --test tests/acceptance/account-migration-http.test.mjs tests/acceptance/operations-authorization.test.mjs
env -i PATH="$test_path" HOME="$HOME" SMARTSELL_AI05_CLAUDE=/opt/homebrew/bin/claude bash tests/acceptance/ai05-postgres.sh
env -i PATH="$test_path" HOME="$HOME" MEDIA_DIRECTORY="$qa/publishing-media" bash tests/acceptance/publishing-integrity.sh
env -i PATH="$test_path" HOME="$HOME" pnpm typecheck
```

Node `v24.21.0` 下完整 HTTP 測試 15 項通過，其中 Operations 授權 3 項。兩個 PostgreSQL 腳本各自啟用隔離的快取映像 `postgres:17-alpine`（17.11），AI05 4 項通過，發布完整性 3 項通過。三組測試均 0 項失敗、0 項跳過，型別檢查退出碼為 0。兩種 AI05 介面均收到實際 Claude Code 的 MCP `initialize`（協議 `2025-11-25`，客戶端宣告 `tasks: false`）。發布批次及重啟後核實由測試的 MCP SDK 客戶端覆蓋。 [HTTP 日誌](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/http-after.log) · [AI05 Claude 主機日誌](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/ai05-postgres-claude.log) · [發布完整性日誌](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/publishing-integrity.log) · [型別檢查日誌](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/typecheck.log)

以 `docker build --pull=false --file infra/Dockerfile --tag smartsell-publish-qa:pf4z6wmp .` 建立專用映像。隔離容器回報 Node `v24.21.0`，Commands 主機使用測試用記憶體儲存啟動後，`GET /healthz` 回 `200`。確認無容器引用後執行 `docker image rm smartsell-publish-qa:pf4z6wmp`。 [建置日誌](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/docker-rebuild.log) · [容器驗證](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/docker-smoke-final.log) · [清理日誌](../../.local/qa-turn/publish-connector-regression.pf4Z6wmp/docker-cleanup-final.log)
