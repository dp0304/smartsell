# SmartSell 工程介面

`apps/server/src/modules/types.ts` 定義工作區命令的交易介面。各業務模組於 `apps/server/src/modules/<module>/index.ts` 匯出具名 `commands: Commands`，操作名採 snake_case。`ctx.update` 合併欄位並檢查版本。每個命令應自己的 DTO 驗證、權限與業務狀態判定，並利用 `ctx.emit` 產生領域事件。

工作台以相同來源存取 `/api/v1`。`POST /session` 接受 `{email,password}`；`GET /session` 回傳 `{user,workspaces:[{id,name,role}]}`，`DELETE /session` 登出。`POST /setup` 接受 `{email,password,name,workspaceName}`，僅可在尚無擁有者時初始化。工作區查詢 `GET /workspaces/:wid/records/:module/:kind` 回傳 `{items:Entity[]}`。執行命令 `POST /workspaces/:wid/commands/:module/:action` 使用 `Idempotency-Key`，JSON body 直接為輸入，成功回應 `{data: result}`。`GET /workspaces/:wid/commands` 回傳 `{items:[{module,action}]}`，依呼叫者權限篩選。錯誤使用 `{error:{code,message}}`。正式環境由伺服器管理登入狀態與授權。
