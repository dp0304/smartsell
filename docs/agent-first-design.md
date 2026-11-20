# SmartSell 2.0：Agent 提交、Web 看板（設計與介面契約）

日期：2026-11-20。本文件是重構的單一依據；所有新端點與前端頁面以此為契約。

## 1. 定位

| 角色 | 做什麼 | 在哪裡 |
|---|---|---|
| 本地 Agent（Claude Code／Codex，在使用者電腦上） | 所有錄入與提交：建商品、匯入、建推廣計劃、寫內容、排期、送審、登記成效、建投放方案 | 透過 MCP 連到 SmartSell |
| 人（品牌老闆、營運） | 看現況；只做 Agent 不被允許的決定：審批、退回、核准投放、啟用授權、緊急停止、連接 Agent；也可以把任務交辦給 Agent | Web |
| Web | 一個「看板」：商品情況、推廣計劃、整體日曆、社媒成效、投放計劃、Agent 做了什麼、待你決定 | `/app/:ws/*`（新）；舊工作台 `/w/:ws/*` 降級為「進階工作台」 |

原則：
1. **看，不填。** 新介面沒有錄入表單。空白狀態要說明「請你的 Agent：『…』」，並附一鍵複製。
2. **人只做決定。** 每個決定前先看到 Agent 提了什麼（內容、差異、金額）；按一下完成；需要理由時才要求填理由。
3. **可追溯。** 每筆資料能看到是 Agent 還是人建立；Agent 活動流可逐筆查看。
4. **時間為主軸。** 日曆與時間線是核心。
5. **數字誠實。** 未知≠0：`value:null` 一律搭配 `availability`，畫面顯示「未採集」而不是 0；圖表缺資料畫斷點；附資料時間（as_of）。

## 2. 新導覽（`/app/:ws`）

| 路由 | 名稱 | 給人看什麼 |
|---|---|---|
| `/app/:ws` | 總覽 | 待你決定（前 5）、本週發布、核心指標（瀏覽、互動、粉絲、投放花費、訂單）與走勢、進行中的推廣計劃、Agent 最近做了什麼、異常 |
| `/app/:ws/products`、`/products/:id` | 商品 | 商品卡片牆（市場價格與庫存、正在推的計劃、近期內容、成效、銷售、需注意）；商品頁：變體×市場、推廣時間線、相關貼文成效 |
| `/app/:ws/plans`、`/plans/:id` | 推廣計劃 | 計劃卡片＋甘特；計劃頁：目標進度、內容矩陣、預算、商品、日程、投放 |
| `/app/:ws/calendar` | 日曆 | 月／週檢視：發布排期、已發布、活動期間、里程碑、製作期限、達人交付、直播、投放檔期、促銷 |
| `/app/:ws/social` | 社媒成效 | 各帳號瀏覽／互動／粉絲、逐日走勢、Top 作品、未採集提示 |
| `/app/:ws/ads` | 投放 | 投放帳戶、預算進度、花費走勢、投放方案（含估算與審批狀態） |
| `/app/:ws/decisions` | 待你決定 | 所有需要人決定的事，逐項預覽並一鍵決定 |
| `/app/:ws/agent` | Agent | 連接 Claude Code／Codex（產生權杖、設定指令）、連線狀態、活動流、交辦任務 |
| `/app/:ws/settings` | 設定 | 品牌與市場（唯讀摘要）、登記自有社群帳號（人才能做）、成員、進階工作台入口 |

頂欄：工作區、品牌篩選（`?brand=`）、期間（總覽／社媒／投放用，`?from&to`）、Agent 連線狀態燈、語言。全站登入後落點改為 `/app/:ws`。

## 3. 讀取端點契約（`GET /api/v1/workspaces/:ws/views/*`）

共通：
- 角色 `READ`（含 viewer）。敏感區塊依角色省略並以 `{visible:false}` 表示，不得回 0。
- 金額一律 `*_minor`（最小貨幣單位）＋ `currency`。
- 指標值型別 `Metric = { value: number|null, availability: 'observed'|'estimated'|'not_collected'|'no_permission'|'source_not_provided'|'sync_failed'|'not_applicable', previous_value?: number|null, change_ratio?: number|null }`。
- 時序 `Point = { date: 'YYYY-MM-DD', value: number|null, availability }`，**區間內每一天都要有點**，沒資料補 `value:null, availability:'not_collected'`。
- 期間參數 `from`、`to` 為 `YYYY-MM-DD`（含頭含尾），`tz` 預設工作區時區（無則 UTC）；預設最近 7 天（社媒、投放預設 30 天）。
- `brand_id` 篩選在後端做（不是前端過濾）。
- 回應外層：物件直接放 `data`；清單回陣列（由 dispatcher 包成 `{data,next_cursor}`）。所有檢視附 `as_of`。

### 3.1 `GET /views/home?brand_id&from&to`
```jsonc
{ "as_of","timezone","period":{"from","to"},
  "needs_you":{"total":3,"items":[DecisionItem /* 前 5 筆 */]},
  "this_week":{"scheduled":12,"published":7,"failed":0,"outcome_unknown":1,"upcoming":[CalendarEvent /* 未來 8 筆發布 */]},
  "kpis":[{"key":"views"|"engagements"|"followers"|"ad_spend"|"orders","value":null,"availability":"not_collected",
           "unit":"count"|"currency","currency":null,"previous_value":null,"change_ratio":null,"sparkline":[Point]}],
  "live_plans":[{"id","name","status","starts_at","ends_at","days_left","completeness_ratio":null,"published":0,"planned":0}],
  "agent":{"connections":1,"last_seen_at":null,"recent":[ActivityItem /* 6 筆 */]},
  "alerts":[{"kind","severity":"blocker"|"high"|"normal","title","resource":{"type","id"}}] }
```
KPI 的 `previous_value`／`change_ratio` 只比兩期都有資料的同一批日子與帳號（`ad_spend` 原樣取 `/views/ads` 的 `metrics.spend`，該檢視用同一規則）：本期某天有資料、前期同位置那天沒有，就不比（兩者皆 `null`，前端顯示「無前期可比」）；本期還沒採到的日子（例如今天）前期也不計。訂單最後有紀錄的那天（通常是今天）只收到紀錄當下為止，所以前期對應那天也只算到同一時刻，未過完的一天不會被當成下滑。粉絲是各帳號最新存量的加總，只有本期每個帳號在前期也有存量時才比；粉絲 `sparkline` 某帳號當天沒回報時沿用它最後的已知值（`estimated`），在每個帳號都有值之前該日為 `null`。

`GET /views/agent-presence` → `{"connections":1,"last_seen_at":null,"timezone","as_of"}`：外殼的 Agent 狀態燈每頁都讀，所以只讀連線與 Agent 活動，不載入整個首頁。`timezone` 為工作區時區；前端應把它記為工作區時區，讓沒有自帶時區的頁面（廣告、商品、計畫）直接開啟時也用它。

### 3.2 `GET /views/products?brand_id&store_id&q&attention=true` → `ProductCard[]`
```jsonc
ProductCard = { "id","title","status","brand_id","image_url":null,
  "store":{"id","name","provider","status"}|null, "variants":{"total":3},
  "markets":[{"market_id","market_name","channel","price":{"min_minor","max_minor","currency","publishable":false,"stale":true,"is_estimate":false}|null,
              "stock":{"status":"in_stock"|"low"|"out_of_stock"|"unknown"|"not_tracked","quantity":null,"availability"}}],
  "plans":{"live":[{"id","name","ends_at"}],"upcoming":0},
  "content":{"scheduled_next_7d":0,"published_30d":0,"next_scheduled_at":null},
  "performance":{"views":Metric,"engagements":Metric},
  "sales":{"visible":true,"currencies":[{"currency","orders","net_minor"}]},
  "attention":[{"kind":"change_event"|"fact_pending"|"localization_stale"|"price_unpublishable","severity","title"}],
  "created_via":"agent"|"human"|null }
```
`GET /views/products/:id` → `ProductCard` ＋
```jsonc
{ "variants":[{"id","sku","title","listings":[{"market_id","market_name","channel","price_minor":null,"currency","inventory_status","inventory_quantity":null,"availability","observed_at"}]}],
  "timeline":[{"at","kind":"plan"|"publish"|"post"|"change"|"fact","title","status","resource":{"type","id"}}],
  "posts":[TopPost], "plans":[PlanCard] }
```

### 3.3 `GET /views/plans?brand_id&status` → `PlanCard[]`（活動）
```jsonc
PlanCard = { "id","name","kind","status","brand_id","starts_at","ends_at","timezone","day":5,"days":14,
  "goals":[{"metric_key","unit","currency","target_value","value":null,"progress_percent":null,"coverage_status"}],
  "matrix":{"planned":12,"filled":7,"published":3,"scheduled":4,"in_production":0,"failed":0,"gap":5,"completeness_ratio":0.58|null},
  "budget":[{"currency","budget_minor","committed_minor","actual_minor","remaining_minor","overrun_minor","actual_complete":false}],
  "products":[{"product_id","title","role","stock_status"}],
  "next_publication":{"publish_target_id","scheduled_at","title"}|null,
  "needs_decision":2, "created_via":"agent"|"human"|null }
```
`GET /views/plans/:id` → `PlanCard` ＋ `{ "events":[CalendarEvent], "cells":[{"platform","social_account_id","account_name","planned_count","published","scheduled","in_production","failed","gap"}], "milestones":[{"id","title","due_at","status","blocked"}], "content":[{"content_item_id","title","production_stage","targets":[{"id","platform","scheduled_at","display_status"}]}], "ads":{"proposals":[AdProposal],"spend":[Pacing]} }`
`completeness_ratio` = Σmin(actual,planned)/Σplanned；planned=0 時為 null。

### 3.4 `GET /views/calendar?from&to&tz&brand_id&kinds&campaign_id`
```jsonc
{ "range":{"from","to","tz"},
  "events":[CalendarEvent], "sources":[{"kind","availability":"available"|"no_permission"}], "as_of" }
CalendarEvent = { "id":"publish:<target_id>", "kind":"publish"|"post"|"plan"|"milestone"|"production_due"|"deliverable_due"|"live"|"ad_flight"|"promotion",
  "starts_at","ends_at":null,"all_day":false,"title","status","platform":null,"brand_id":null,"campaign_id":null,"social_account_id":null,
  "resource":{"type","id"},"needs_human":"approval"|"late_decision"|"outcome_unknown"|null,"permalink":null }
```

### 3.5 `GET /views/social?from&to&tz&brand_id&platform&metric=views`
```jsonc
{ "period":{"from","to","tz"},"compare_period":{"from","to"},
  "accounts":[{"social_account_id","platform","display_name","handle","brand_id",
     "followers":Metric & {"delta":null},"metrics":{"views":Metric,"engagements":Metric,"reach":Metric,"engagement_rate":Metric},
     "posts_published":0,"last_observed_at":null}],
  "totals":{"views":Metric,"engagements":Metric},
  "series":{"metric":"views","total":[Point],"by_account":[{"social_account_id","label","points":[Point]}]},
  "top_posts":[TopPost], "unranked_count":0, "warnings":[], "as_of" }
TopPost = { "platform_post_id","social_account_id","platform","permalink","published_at","title","campaign_id","metrics":{"views":Metric,"engagements":Metric} }
```
排名只用已知值；未知值的貼文計入 `unranked_count`，不當 0 排名。
帳號的 `views`／`engagements` 的 `previous_value` 只加總前期中「本期同位置那天也有資料」的日子；本期有資料的某天在前期沒有，就回 `previous_value:null, change_ratio:null`，不拿半期跟全期比。`totals` 只在每個本期有值的帳號自己都可比時才比，否則同樣回 `null`。帳號的 `engagement_rate` 是比率，前期缺幾天仍可比，所以它的 `previous_value` 可能有值而同帳號 `views.previous_value` 為 `null`；跨帳號合併互動率時，前後兩期必須用同一批帳號，不能讓某帳號只出現在本期那一側。

### 3.6 `GET /views/ads?from&to&brand_id&campaign_id`
```jsonc
{ "accounts":[{"id","provider","name","currency","read_capability","last_import_at":null}],
  "pacing":[Pacing], "metrics":{"spend":Metric,"impressions":Metric,"clicks":Metric,"conversions":Metric},
  "series":{"spend":[Point]},
  "proposals":[AdProposal], "adjustments_proposed":0, "as_of" }
Pacing = { "campaign_id":null,"currency","budget_minor":null,"actual_spend_minor":null,"coverage_ratio":null,"delayed":null }
AdProposal = { "id","name","status","campaign_id","schedule":{"starts_at","ends_at","tz"}|null,"budget":{"type","amount_minor","currency"}|null,
  "estimates":[{"metric","value","source"}],"approval_status":null }
```

### 3.7 `GET /views/decisions?kind&brand_id` → `DecisionItem[]`；`GET /views/decisions/summary` → `{counts:{<kind>:n}, total, as_of}`
```jsonc
DecisionItem = { "id":"publish_approval:<id>", "kind":"publish_approval"|"change_set"|"agent_job_review"|"reply_draft"|"ad_proposal"|"brief_revision"|"budget_approval"|"fact_revision"|"knowledge_revision"|"localization"|"late_decision",
  "severity":"blocker"|"high"|"normal","title","summary":null,"created_at","due_at":null,"brand_id":null,"campaign_id":null,
  "requested_by":{"type":"agent"|"human"|"rule","label":null},
  "resource":{"type","id","version":null,"hash":null,"route":null},
  "preview":{"text":null,"fields":[{"label","before":null,"after":null}]},
  "actions":[{"key":"approve"|"reject"|"request_changes"|"apply"|"accept"|"return","label":["核准","Approve"],"method":"POST",
              "path":"/publish-targets/<id>/approve","version":7|null,"body":{"resource_hash":"…"},"requires_reason":false,"tone":"primary"|"danger"|"neutral"}] }
```
`path` 相對於 `/api/v1/workspaces/:ws`；前端照樣送出（`If-Match` 帶 `version`，body 合併使用者輸入的 `reason`）。Agent 憑證讀取時 `actions` 一律為 `[]`。

### 3.8 `GET /views/activity?actor=agent|human&since&limit` → `ActivityItem[]`
```jsonc
ActivityItem = { "id","occurred_at","actor":{"type":"agent"|"human","user_id","credential_id":null,"label":null},
  "source":"mcp"|"rest","action":"publishing_create_target","verb":"created"|"updated"|"submitted"|"approved"|"deleted"|"other",
  "summary":["建立了發布排期","Created a publish schedule"],"resource":{"type":null,"id":null,"title":null},"count":1 }
```
來源：每次寫入由 dispatcher 寫入一列 `activity_event`（見 4.4）。同一 credential、同一 action、10 分鐘內合併為一筆（`count`）。

## 4. Agent 接入（後端）

### 4.1 連線權杖
- `POST /api/v1/workspaces/:wid/agent-connections`（需 session＋CSRF）body `{label, client:'claude_code'|'codex'|'other', expires_days?:1..365=90}` → 201
  `{data:{id,label,client,token,mcp_url,expires_at,setup:{claude_code_command,claude_code_json,codex_toml,codex_command,agents_md}}}`；token 只回一次。
- `GET /api/v1/workspaces/:wid/agent-connections` → `{data:[{id,label,client,created_at,expires_at,last_used_at,revoked}]}`
- `DELETE /api/v1/workspaces/:wid/agent-connections/:id` → 204（撤銷＝該 Agent 立即停權，並回收其工作租約）
- 實作：每個連線建立一個**獨立的長效 session**（與瀏覽器 session 無關，登出瀏覽器不影響），權杖封裝該 session hash＋工作區＋credential id；`issueSession` 增加 TTL 參數；PostgreSQL 新增 migration 提供長效 session 函式。開發環境的 `APP_SECRET` 持久化到 `.local/`，重啟後權杖仍有效。
- `last_used_at` 在 MCP 驗證時更新（至少間隔 5 分鐘）。

### 4.2 MCP 工具（預設部署 `/mcp`）
- 所有寫入走 **Operations**（Web 讀的同一份資料）。
- 工具：精選工具（每個 Operation 一個，涵蓋品牌／市場、店鋪與商品、變體與市場價格、匯入、活動與目標與商品、內容與變體與修訂、排期與送審、投放方案、短連結、成效匯入、Agent 工作 claim／submit）＋兩個通用工具：
  - `smartsell_operations_describe({module?, q?})`：列出此權杖可用的 Operation（name、method、path、summary、input schema）。
  - `smartsell_operation_call({operation, params?, query?, body?, expected_version?, idempotency_key?})`：執行任一可用 Operation，回 `{data, next_cursor?, etag?}`；錯誤回 `{code, message, details}`（保留欄位錯誤，讓 Agent 能自行修正）。
- 伺服器 `instructions` 提供精簡工作守則（同 `docs/agent-guide.md` 的摘要）。
- Agent 工作（交辦）工具全部走 Operations 的 `agent_jobs_*`。

### 4.3 只能由人決定（集中檢查）
Agent 連線以建立者本人的角色執行，所以角色清單擋不住 Agent；以下規則以「憑證」判定，不看角色。

`runScopedOperation` 在 `principal.grantId` 存在時拒絕 `HUMAN_ONLY` 內的 Operation（403 `HUMAN_REQUIRED`），REST 以 PAT 呼叫亦同，另含所有 `mcp === false` 的 Operation：

- 審批與退回：`publishing_approve, publishing_reject, publishing_request_changes, publishing_batch_approve, change_sets_apply, change_sets_reject, inbox_approve_reply, inbox_reject_auto_reply, commerce_fact_approve, commerce_fact_reject, commerce_localization_approve, commerce_localization_reject, knowledge_approve, knowledge_reject, brief_revision_approve, brief_revision_request_changes, product_candidate_decide, data_gap_accept`
- 重新核准（來源改過後沿用舊譯文、再寫回商店）：`commerce_localization_accept, commerce_localization_writeback`
- Agent 工作驗收：`agent_jobs_accept, agent_jobs_return, agent_jobs_finish, agent_jobs_reconcile`
- 預算、投放、佣金與付款：`campaign_budget_approval_decide, ads_decide_proposal, ads_decide_adjustment, commissions_approve, commissions_batch_approve, commissions_batch_record_payment, campaign_closeout, collection_budget_set`（採集預算上限）
- 授權與合作：`rights_activate, rights_revoke, submission_accept, submission_accept_batch, submission_reject, collaborations_mark_terms_signed, deliverables_review, deliverables_verify_publication`
- 對外上線：`pages_publish, pages_configure_experiment, experiment_start, bio_add_item, bio_edit_item, bio_remove_item, forms_activate`（實驗開始後，公開頁面才依設定分流）
- 寄送顧客郵件：`lifecycle_test_send_campaign, lifecycle_schedule_campaign, lifecycle_submit_local_esp`
- 安全設定（轉址白名單、短網址網域）：`links_allow_host, links_revoke_host, links_domain_create, links_domain_verify`
- 帳號與連線：`account_register_owned_social_account, account_link_accounts, account_start_oauth, account_connect_shopify_merchant, commerce_store_connect, account_register_platform_app, account_update_platform_app, account_revoke_connection, account_revoke_device, account_approve_mobile_device, account_enable_social_account, account_resolve_account_block, account_enable_auto_mode, account_update_auto_mode, account_release_account_auto, account_release_workspace_auto`
- 發布執行：`publishing_release_pause, publishing_manual_complete, posts_complete_operation, publishing_confirm_post_match, publishing_reject_post_match`
- 團隊：`team_member_remove`
- 解除人做的暫停或封存：`data_source_resume, workspace_brand_restore`（還原品牌也會占用授權額度）
- 無法復原的撤回：`commerce_fact_retract`（撤回後不能再修訂，也不能用同一個事實鍵重建，所以不算「停」；Agent 要改事實請用 `commerce_fact_revise` 送審）

Agent 可以「停」（緊急停止、暫停、下架、停用、取消），不能「解除」：
- `pages_unpublish, forms_deactivate, lifecycle_cancel_campaign, lifecycle_cancel_local_esp, jobs_cancel, data_source_pause, experiment_stop` 仍可由 Agent 呼叫。
- 同一個端點同時能「上線」與「停」時，Agent 只能送「停」（`AGENT_STOP_ONLY`）：`bio_publish` 只接受 `unpublish: true`；`lifecycle_change_flow_status` 不接受 `live`；`links_update` 只接受 `status` 為 `paused` 或 `expired`（改回 `active` 是解除；`archived` 之後連結不能再改，也只能由人做）。
- 停用社群帳號可以；重新啟用（`account_enable_social_account`）只能由人。
- 只讀取或觀察狀態的審核層級寫入，Agent 也可以呼叫：`links_probe`（檢查目的地網址）、`lifecycle_reconcile_local_esp`、`lifecycle_read_local_esp_flow`（與郵件服務對帳、讀取流程狀態）。
- Agent 送的頁面檢查結果只是回報：它回報的「通過」會記成「未知」（`reported_result` 保留原值、`source: 'agent'`），要由人確認後頁面才算檢查通過。

端點內的決定：`ads_update_account` 帶 `permissions`（誰可以核准、執行或花費這個廣告帳戶）時，Agent 會收到 `HUMAN_REQUIRED`；其他欄位 Agent 仍可修改。`AGENT_HUMAN_FIELDS` 以同樣方式集中擋欄位：`data_source_create`、`data_source_update` 帶 `allowed_uses`（資料可否顯示、分享、匯出、公開或交給模型處理，等於資料授權條款）時只能由人。

模組內判斷「是不是 Agent」一律用 `fromAgent(ctx)`（`apps/server/src/agent-actor.ts`：舊的 `agent` 角色或帶 Agent 憑證），不要只看 `ctx.role === 'agent'`。它決定兩件事：Agent 只讀得到人核准過的知識與商品譯文（`knowledge_get`、`knowledge_get_context`、`catalog_get_product`、`commerce_localization_list`、`catalog_list_facts`）；`created_by_type`、`completed_by_type`、`source_type`、`origin`、`ai_generated` 等歸屬欄位記成 Agent；Agent 寫的知識 `source.kind` 只會是 `agent` 或 `document_import`，不能自稱 `human`。權限檢查仍看人的角色。

防漏測試：`apps/server/src/operations-agent-boundary.test.ts` 列舉所有 Operation，下列寫入若 Agent 可呼叫，就必須在測試裡的清單寫明理由，否則測試失敗：審核層級（角色含 `reviewer`、不含 `editor`）的寫入要列在「停／讀」清單；只有 owner／admin 能做的寫入（設定、整合、匯入），以及名稱帶有 publish、activate、enable、resume、restore、start、allow、verify、accept、confirm、schedule、send、connect、authorize、retry、apply 等字的寫入，要列在依理由分組的 `AGENT_SETTINGS`。藏在一般更新裡的解除（例如 `links_update` 改回 `active`）名稱看不出來，測試抓不到：新增或修改這類 Operation 時，請自己加進 `AGENT_STOP_ONLY` 或 `AGENT_HUMAN_FIELDS`。新增審批、發布類 Operation 時，請加進 `HUMAN_ONLY`，或在清單寫明為何 Agent 可以做。

### 4.4 歸屬與活動
- `runScopedOperation` 每次寫入除既有 `audit/<id>` 外，另寫 `row/activity_event/<id>`（Context 可 `ctx.list('activity_event')` 讀到）：
  `{id, version:1, created_at, updated_at, occurred_at, action, actor_id, actor_type:'agent'|'human', credential_id, credential_label, source:'mcp'|'rest', request_id, resource_id, resource_type, brand_id}`
  `resource_type` 由回傳資料推斷（若有 `kind`／已知 Operation 前綴則填，否則 null）。
- `ctx.create()` 在 Agent 呼叫時於新列加上 `created_via:'agent'`；人呼叫時 `created_via:'human'`。

## 5. 資料修正
1. `platform_post` 建立時（`execution/service.ts` savePost 與登記貼文）帶入 `brand_id`、`campaign_id`、`content_item_id`（由 publish_target／social_account 推得）。
2. 匯入範本 `social_post_report`、`social_account_report` 增加選填欄 `period_kind`（`day`|`lifetime`，預設 `day`）。
3. `workspace/overview.ts` 的 `creator.due` 納入 `requested` 狀態。
4. Agent 可登記**外部既有貼文**（`posts_register_manual`）以便匯入成效：Agent 登記的貼文 `verification:'agent_reported'`、`registered_via:'agent'`；執行任務的人工完成仍只限人。

## 6. 前端架構
- 新殼：`apps/web/src/view/`（ViewShell、routes、copy、hooks、pages、components、view.css）。掛在 `main.tsx` 的 `/app/:ws/*`；登入後與 `/` 導向 `/app/:ws`。舊 `/w/:ws/*` 原封保留為「進階工作台」。
- 資料：`useView(path, query)`（TanStack Query，key `['workspace', ws, 'view', path, query]`，`placeholderData: keepPreviousData`）；SSE `workspace.changed` 防抖 1.5 秒後只失效 `view` 前綴。
- 圖表：自製 SVG（無新依賴）。系列色（深色底，依序使用，不循環）：`#3987e5, #d95926, #199e70, #c98500, #d55181, #008300, #9085e9, #e66767`；狀態色 good `#0ca30c`／warning `#fab219`／serious `#ec835a`／critical `#d03b3b`，必搭配圖示或文字。線 2px、點 ≥8px 並帶 2px 表面色外圈、長條 ≤24px 且端點 4px 圓角、格線 1px 實線低對比；單一系列不放圖例，≥2 系列必有圖例；滑過顯示 tooltip（值在前、名稱在後），且每張圖都有可切換的表格檢視；`null` 畫斷點，不畫 0；不做雙 Y 軸。
- 響應式：新殼在 ≥360px 可用（手機可看），不受舊殼 1280px 限制。
- 文字：繁中為主、英文為輔，用 `label(['中','En'])`。

## 7. 工作流分工（檔案所有權）
| 工作流 | 擁有的檔案 |
|---|---|
| A1 Agent 接入 | `apps/server/src/operations.ts`、`operation-server.ts`、`integration/command-mcp.ts`、`integration/agent-connections.ts`（新）、`extensions/mcp-*.ts`、`integration/operation-mcp.ts`、`integration/agent-job-mcp.ts`、`store.ts`、`memory.ts`、`local.ts`、`postgres.ts`、`app.ts`、`config.ts`、`bootstrap.ts`、`packages/db/migrations/111_*.sql`、`docs/agent-guide.md`、對應測試 |
| A2 檢視端點 | `apps/server/src/modules/workspace/views/*.ts` 與其測試 |
| A3 資料修正 | `modules/execution/service.ts`、`modules/execution/ops.ts`、`modules/ingest/templates.ts`、`modules/ingest/import-sinks.ts`、`modules/workspace/overview.ts` 與其測試 |
| F 前端 | `apps/web/src/view/**`、`apps/web/src/main.tsx`（只改路由與落點）、`packages/ui/src/view.tsx` |
