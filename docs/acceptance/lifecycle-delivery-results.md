# EM01–EM05 本機投遞驗收

驗收依據為原稿 [5.15.12](../../plan.md#L6868)。執行前確認 `claude --version` 為 `2.1.311 (Claude Code)`，Node 使用本機 NVM 的 `v24.21.0`，pnpm 為 `10.11.0`。

[互動驗收紀錄](engagement-results.md#L73) 已有渠道同意獨立、暱稱不自動合併、預覽快照保留、本地草稿與 Campaign／Flow 獨立等證據。[本機 ESP HTTP 用例](../../apps/server/src/modules/lifecycle/local-esp-http.test.mjs) 已有對帳、排除、取消與讀回斷言，本輪重跑後記錄結果。

本輪用合成客戶及本機回環 ESP 收據核對正式工作台和後端。外部 ESP 憑證、客戶資料及發送權限不在本輪驗收範圍內。

## 本機通過的證據

2026-11-20 重跑 lifecycle 領域及回環 HTTP 共 7/7。Chromium 透過正式工作台及後端完成同一流程，開發版和建置預覽版各 1/1。

| 條目 | 補上的本機證明 |
| --- | --- |
| EM01 | 合成 Email 退訂回執同步後，工作台客戶明細顯示 Email 已撤回、SMS 仍訂閱。回環 ESP 只收到仍符合資格的地址。HTTP 另驗證退信抑制及非 `.test` 地址拒絕。 |
| EM02 | 同一分群的工作台分列預覽、提交估算及實際發送。原預覽為 2 人，提交估算顯示撤回排除 1 人，ESP 實際發送為 1 人。 |
| EM03 | 工作台分列本地計畫時間、Campaign 紀錄狀態、ESP 讀回狀態、收據及送達數。測試寄送有獨立收據。提交結果未知時不能重送，查詢失敗可重查，ESP 回報明確失敗後才可另行提交。排期由獨立收據確認，發送收據後送達欄仍為 `—`，送達報表到達後才顯示 `1`。請求撤回後顯示待確認，收到取消收據後 Campaign 才改為取消。 |
| EM04 | Flow 的本地草稿、人工檢閱及 ESP 狀態分列。ESP 讀回 `paused` 時，本地草稿及人工檢閱保留，另一筆 Campaign 仍為 `sent`。 |
| EM05 | 健康頁標示 SMS 未接入及 Email 只涵蓋匯入的 ESP 報表。以正式 REST 匯入合成報表後，工作台分欄顯示開信 `7`、點擊 `3`、購買 `0`，未提供的退信數顯示 `—`。領域回歸驗證頻次只計已觀測發送。 |

[Chromium 流程](../../tests/web-e2e/lifecycle-delivery.spec.mjs#L116) · [回環 HTTP](../../apps/server/src/modules/lifecycle/local-esp-http.test.mjs#L8) · [領域回歸](../../apps/server/src/modules/lifecycle/workspace-lifecycle.test.ts#L38)

## 執行條件與接線

Chromium 以合成工作區擁有者登入，透過正式 REST 建立測試資料，並由工作台按鈕觸發預覽、提交、重查、撤回與 Flow 查詢。後端使用正式 `start()` 入口及暫存 SQLite，ESP 固定在 `127.0.0.1` 的臨時 HTTP 埠，只接收明確允許的 `.test` 地址。ESP 端點以合成收據回應，健康報表由 REST 匯入合成數據。全程無真實客戶、真實寄送或外部寫入。

正式工作台後端原先未掛載本機 ESP 提交及撤回。接線限定為兩條 lifecycle 路由，僅在非生產模式且設定 `SMARTSELL_LOCAL_ESP_ORIGIN` 時掛載，沿用既有角色、CSRF、版本及冪等檢查。ESP 運輸仍驗證回環 IP、明確埠及禁止轉址。 [路由接線](../../apps/server/src/operation-server.ts#L79) · [回環限制](../../apps/server/src/modules/lifecycle/local-esp.ts#L9)

真實對端仍待授權驗收。需測試 ESP 帳戶的分群、抑制、Campaign 收據及送達報表、Flow 狀態的讀取權，並另行明確授權測試地址、測試寄送、排期及取消的寫入能力。購買數仍需核對授權的商家或 ESP 報表來源。此輪的 Chromium 建置版使用本機開發後端，外部對端、PostgreSQL 與生產部署均未驗收。

## 重跑

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
claude --version
node --version
node --import tsx --test apps/server/src/modules/lifecycle/*.test.ts apps/server/src/modules/lifecycle/local-esp-http.test.mjs
pnpm exec playwright test tests/web-e2e/lifecycle-delivery.spec.mjs --workers=1 --output="$(mktemp -d /tmp/smartsell-lifecycle-pw.XXXXXX)"
pnpm --filter @smartsell/web build
SMARTSELL_E2E_PREVIEW=1 pnpm exec playwright test tests/web-e2e/lifecycle-delivery.spec.mjs --workers=1 --output="$(mktemp -d /tmp/smartsell-lifecycle-preview.XXXXXX)"
pnpm --filter @smartsell/web typecheck
```

工作台建置與型別檢查通過。全庫 `pnpm typecheck` 初跑通過，接線後重跑出現範圍外的 analytics 測試 `unknown` 型別錯誤（TS2345、TS18046）。 [診斷位置](../../apps/server/src/modules/analytics/operations.test.ts#L130)
