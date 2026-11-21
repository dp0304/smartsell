# 公開導流接線

`src/traffic.ts` 匯出 `createPublicTrafficHandler(dispatch, resolveVisitor?)`。HTTP core 可將此 handler 掛到公開網域。它處理 `GET /p/:slug`、`GET /b/:handle`、`GET /:code` 和 `POST /f/:id/submit`，並使用 `assets/traffic.css`。`undefined` 代表請交給其他路由。

`dispatch(hostname, input, request)` 需以受信任的公開網域配置解析唯一工作區，在該工作區交易中呼叫 `trafficPublicBridge(ctx, input, secrets)`。網域應由已驗證的代理與入口配置決定。Core 應在交易前對表單送出套用速率限制，不記錄提交內容，並且勿在公開網域掛載工作區管理 API。Core 須配置穩定的 32-byte `piiKey` 並安全保存。管理端如需查看原始聯絡資料，`decryptLeadContact` 會檢查角色並寫入存取稽核事件。

選配 `resolveVisitor` 從已同意的第一方簽章工作階段取得隨機 `sessionRef`，並由 core 提供 `trackingKey`。請求參數與裸 Cookie 值不能當作同意憑據。若需要收集頁面觀測，core 可使用同一可信工作階段呼叫 bridge 的 `touchpoint`。沒有該工作階段的訪客會看到發布版本。

短鏈請配置已驗證且 TLS 已啟用的 `link_domain`。管理端 `links_allow_host` 為工作區管理員維護精確的目的地主機白名單。連接器可用 `recordLeadHandoffReceipt` 套用已驗證的 CRM 回執。

## 啟用公開主機

設定 `SMARTSELL_TRAFFIC_HOSTS` 為公開來源到工作區 UUID 的 JSON 對照，例如 `{"https://go.example.com":"00000000-0000-0000-0000-000000000002"}`。使用包含 `public` 的 `ROLE`，並提供穩定的 32-byte 十六進位 `SMARTSELL_TRAFFIC_PII_KEY` 或 `APP_SECRET`。公開主機使用獨立於管理端和 Portal 的主機名稱。將公開主機的請求轉送至後端，保留 `Host`，並在入口拒絕未配置的主機名稱及限制每個訪客的表單提交速率。

Commands 執行模式使用 PostgreSQL 時，資料庫擁有者需在 `ss.public_locators` 為已配置的工作區新增一筆紀錄。設定 `locator` 為 `traffic.workspace`、`id` 為工作區 UUID 的文字值，並從 `ss.workspaces` 取得該工作區的 `tenant_id` 和 `workspace_id`。舊版表單的聯絡資料繼續使用 `SMARTSELL_TRAFFIC_CONTACT_KEY`。

## 消費者頁面

從這個目錄提供 `index.html` 與 `/assets/`，並把 `/`、`/landing/:key` 和 `/unsubscribe` 重寫到 `index.html`。公開網域只需把 `/api/public/landing/:key`、`/api/public/unsubscribe` 和 `/r/:key` 反向代理到已掛載 `registerCollaboration` 的 API。表單沿用訪客實際看見的同意版本。退訂連結使用 `/unsubscribe#<token>`，頁面確認後才以 POST 提交。公開頁面只顯示一般結果，不回傳工作區識別碼或線索的聯絡資料。

以同源 HTTPS 提供頁面和 API，設定 `Referrer-Policy: no-referrer`、`Cache-Control: no-store`，並在閘道限制表單提交速率。不要記錄提交內容或能力憑證。