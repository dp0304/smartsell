# SmartSell 通用网关覆盖矩阵

每行来自本次 Agent 的实际发现。序号对应 [逐调用原始记录](calls.jsonl)，审计 ID 对应 [快照审计行](audit.json)。

| 模块 | 子操作 | 路由 | 结果 | 调用、返回条数或未调原因 |
|---|---|---|---|---|
| workspace | views_home | GET /views/home | fixture_reference_observed | #169 |
| workspace | views_products_list | GET /views/products | fixture_reference_observed | #170 · data.length=2 |
| workspace | views_product_get | GET /views/products/:id | fixture_reference_observed | #171 |
| workspace | views_plans_list | GET /views/plans | fixture_reference_observed | #172 · data.length=1 |
| workspace | views_plan_get | GET /views/plans/:id | fixture_reference_observed | #173 |
| workspace | views_calendar | GET /views/calendar | fixture_reference_observed | #174 |
| workspace | views_social | GET /views/social | fixture_reference_observed | #175 |
| workspace | views_ads | GET /views/ads | fixture_reference_observed | #176 |
| workspace | views_decisions_list | GET /views/decisions | fixture_reference_observed | #177 · data.length=2 |
| workspace | views_decisions_summary | GET /views/decisions/summary | response_only | #178 |
| workspace | views_activity | GET /views/activity | fixture_reference_observed | #179 · data.length=50 |
| workspace | views_agent_presence | GET /views/agent-presence | response_only | #180 |
| workspace | zhihu_stats_create | POST /zhihu-stats | business_verified | #105 |
| workspace | zhihu_stats_get | GET /zhihu-stats/:id | business_verified | #106 |
| workspace | workspace_get | GET / | response_only | #181 |
| workspace | workspace_update | PATCH / | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Update workspace settings」案例。 |
| workspace | workspace_get_context | GET /context | fixture_reference_observed | #182 |
| workspace | workspace_brands_list | GET /brands | business_verified | #4 · data.length=1 |
| workspace | workspace_brand_get | GET /brands/:id | business_verified | #3 |
| workspace | workspace_brand_create | POST /brands | business_verified | #1, #2 |
| workspace | workspace_brand_update | PATCH /brands/:id | business_verified | #107 |
| workspace | workspace_brand_archive | POST /brands/:id/archive | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Preview or archive a brand」案例。 |
| workspace | workspace_markets_list | GET /brands/:id/markets | business_verified | #7 · data.length=1 |
| workspace | workspace_market_get | GET /markets/:id | business_verified | #6 |
| workspace | workspace_market_create | POST /brands/:id/markets | business_verified | #5 |
| workspace | workspace_market_update | PATCH /markets/:id | business_verified | #108 |
| workspace | workspace_get_today | GET /overview/today | fixture_reference_observed | #183 |
| workspace | workspace_get_summary | GET /overview/summary | response_only | #184 |
| workspace | tasks_list | GET /work-items | fixture_reference_observed | #185 |
| workspace | tasks_get | GET /work-items/:id | business_verified | #137 |
| workspace | tasks_create | POST /work-items | business_verified | #109 |
| workspace | tasks_update | PATCH /work-items/:id | business_verified | #110 |
| workspace | tasks_batch | POST /work-items/batch | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Preview or apply a versioned work-item batch」案例。 |
| workspace | tasks_complete | POST /work-items/:id/complete | business_verified | #111 |
| workspace | tasks_reopen | POST /work-items/:id/reopen | business_verified | #112 |
| workspace | tasks_handover | POST /work-items/:id/handover | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Hand over a work item and record its history」案例。 |
| workspace | tasks_dependencies | PUT /work-items/:id/dependencies | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Replace a work item prerequisite set」案例。 |
| workspace | workspace_get_personal_inbox | GET /me/inbox | fixture_reference_observed | #186 |
| workspace | notifications_list | GET /notifications | response_only | #187 |
| workspace | notifications_read | POST /notifications/read | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Mark personal notifications as read」案例。 |
| workspace | notifications_archive | POST /notifications/archive | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Archive personal notifications」案例。 |
| workspace | notifications_preferences_list | GET /me/notification-preferences | valid_empty | #188 · data.length=0 |
| workspace | notifications_preferences_update | PUT /me/notification-preferences | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Set a personal notification preference」案例。 |
| workspace | workspace_subscriptions_list | GET /subscriptions | fixture_reference_observed | #189 · data.length=2 |
| workspace | workspace_subscriptions_create | POST /subscriptions | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Follow an accessible resource」案例。 |
| workspace | workspace_subscriptions_remove | DELETE /subscriptions | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Stop following a resource」案例。 |
| workspace | workspace_subscriptions_delete | DELETE /subscriptions/:id | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Delete a personal subscription」案例。 |
| workspace | search_query | GET /search | fixture_reference_observed | #190 |
| workspace | workspace_saved_views_list | GET /saved-views | fixture_reference_observed | #191 · data.length=1 |
| workspace | workspace_saved_views_create | POST /saved-views | business_verified | #148 |
| workspace | workspace_saved_views_update | PATCH /saved-views/:id | business_verified | #149 |
| workspace | workspace_onboarding_get | GET /onboarding/:flow | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Read resumable workspace onboarding」案例。 |
| workspace | workspace_onboarding_check | POST /onboarding/:flow/steps/:step/check | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Recheck an onboarding step against live records」案例。 |
| workspace | workspace_onboarding_skip | POST /onboarding/:flow/steps/:step/skip | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Skip an onboarding step with reason」案例。 |
| workspace | workspace_dashboard_get | GET /dashboards/:id | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Read and evaluate a personal dashboard」案例。 |
| workspace | workspace_dashboard_save | PUT /dashboards/:id | not_exercised | scope_excluded · 本回合未扩展工作区管理和个人设置。该项需独立的「Save personal dashboard metric queries」案例。 |
| account | account_list_social_accounts | GET /social-accounts | business_verified | #10 · data.length=1 |
| account | account_get_social_account | GET /social-accounts/:id | business_verified | #9 |
| account | account_update_social_account | PATCH /social-accounts/:id | business_verified | #8 |
| account | account_disable_social_account | POST /social-accounts/:id/disable | not_exercised | scope_excluded · 会改变测试账号启用状态并清空 Connector 调度，本轮只修改本地资料。 |
| account | account_get_capabilities | GET /social-accounts/:id/capabilities | response_only | #192 · data.length=16 |
| account | account_check_operation | GET /social-accounts/:id/operation-check | boundary_confirmed | #11 |
| account | account_probe_capabilities | POST /social-accounts/:id/capabilities/probe | not_exercised | external_unavailable · 缺少可授权探测的社媒连接与供应商沙箱。 |
| account | account_get_platform_catalog | GET /platform-catalog | response_only | #193 · data.length=12 |
| account | account_list_platform_apps | GET /platform-apps | valid_empty | #194 · data.length=0 |
| account | account_list_connections | GET /connections | valid_empty | #195 · data.length=0 |
| account | account_get_store_capabilities | GET /connections/:id/capabilities | not_exercised | missing_resource · CSV 店没有 connection_id，无法提供可读的店铺连接。 |
| account | account_probe_store_capabilities | POST /connections/:id/capabilities/probe | not_exercised | external_unavailable · 缺少可授权探测的远端商店连接。 |
| account | account_list_connection_accounts | GET /connections/:id/accounts | not_exercised | missing_resource · 测试社媒账号为本地登记，未关联包含发现账号的 OAuth 连接。 |
| account | account_list_devices | GET /devices | business_verified | #102 · data.length=1 |
| account | account_list_mobile_devices | GET /mobile-devices | valid_empty | #196 · data.length=0 |
| account | account_list_mobile_app_bindings | GET /mobile-app-bindings | valid_empty | #197 · data.length=0 |
| account | account_preview_mobile_app_unbind | GET /mobile-app-bindings/:id/impact | not_exercised | missing_resource · 仅配对合成桌面 Worker，缺少移动 App 绑定。 |
| account | account_list_browser_sessions | GET /browser-sessions | valid_empty | #198 · data.length=0 |
| account | account_preview_binding_migration | GET /social-accounts/:id/execution-binding/migration/preview | not_exercised | missing_resource · 缺少当前执行绑定和迁移目标绑定。 |
| account | account_get_binding_migration | GET /social-accounts/:id/execution-binding/migration | response_only | #199 |
| account | account_get_connector_auto_policy | GET /connector-auto-policy | response_only | #200 |
| account | account_list_account_blocks | GET /account-blocks | valid_empty | #201 · data.length=0 |
| account | account_assign_account_block | PATCH /account-blocks/:id | not_exercised | missing_state · 需要有明确原因及待分派的账号阻断记录。 |
| ingest | data_source_list | GET /data-sources | fixture_reference_observed | #202 · data.length=1 |
| ingest | data_source_get | GET /data-sources/:id | business_verified | #157 |
| ingest | data_source_create | POST /data-sources | business_verified | #156 |
| ingest | data_source_update | PATCH /data-sources/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐与不同允许用途、窗口或连接相匹配的来源。 |
| ingest | data_source_pause | POST /data-sources/:id/pause | not_exercised | fixture_unprepared · 尚未为此操作补齐与不同允许用途、窗口或连接相匹配的来源。 |
| ingest | import_template_list | GET /import-templates | business_verified | #75 · data.length=11 |
| ingest | import_list | GET /imports | fixture_reference_observed | #203 · data.length=3 |
| ingest | import_create | POST /imports | business_verified | #76, #77 |
| ingest | import_get | GET /imports/:id | business_verified | #84 |
| ingest | import_preview | PATCH /imports/:id | business_verified | #78 |
| ingest | import_rows | GET /imports/:id/rows | business_verified | #82 · data.length=1 |
| ingest | import_error_file | GET /imports/:id/error-file | not_exercised | fixture_unprepared · 尚未为此操作补齐专门含行级错误或可复用映射的 CSV 批次。 |
| ingest | import_confirm | POST /imports/:id/confirm | business_verified | #83 |
| ingest | import_cancel | POST /imports/:id/cancel | not_exercised | fixture_unprepared · 尚未构造能验证「Cancel an unconfirmed import batch」的 :id 记录及其业务状态。 |
| ingest | import_mapping_preset_list | GET /import-mapping-presets | business_verified | #80 · data.length=1 |
| ingest | import_mapping_preset_create | POST /import-mapping-presets | business_verified | #79 |
| ingest | sync_refresh | POST /data-sources/:id/refresh | not_exercised | fixture_unprepared · 尚未为此操作补齐与不同允许用途、窗口或连接相匹配的来源。 |
| ingest | sync_reconcile | POST /data-sources/:id/reconcile | not_exercised | fixture_unprepared · 尚未为此操作补齐与不同允许用途、窗口或连接相匹配的来源。 |
| ingest | data_source_coverage | GET /data-sources/:id/coverage | boundary_confirmed | #158 · data.length=1 |
| ingest | sync_run_list | GET /sync-runs | valid_empty | #204 · data.length=0 |
| ingest | sync_run_get | GET /sync-runs/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐允许执行的来源及对应同步任务／调度记录。 |
| ingest | sync_run_retry | POST /sync-runs/:id/retry | not_exercised | fixture_unprepared · 尚未为此操作补齐允许执行的来源及对应同步任务／调度记录。 |
| ingest | sync_schedule_list | GET /sync-schedules | valid_empty | #205 · data.length=0 |
| ingest | sync_schedule_create | POST /sync-schedules | not_exercised | fixture_unprepared · 尚未为此操作补齐允许执行的来源及对应同步任务／调度记录。 |
| ingest | sync_schedule_update | PATCH /sync-schedules/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐允许执行的来源及对应同步任务／调度记录。 |
| ingest | backfill_plan | POST /backfills | not_exercised | fixture_unprepared · 尚未为此操作补齐待补采的数据窗口、允许补采的来源及运行记录。 |
| ingest | backfill_list | GET /backfills | valid_empty | #206 · data.length=0 |
| ingest | backfill_get | GET /backfills/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐待补采的数据窗口、允许补采的来源及运行记录。 |
| ingest | backfill_resume | POST /backfills/:id/resume | not_exercised | fixture_unprepared · 尚未为此操作补齐待补采的数据窗口、允许补采的来源及运行记录。 |
| ingest | data_gap_list | GET /data-gaps | valid_empty | #207 · data.length=0 |
| ingest | data_gap_backfill | POST /data-gaps/:id/backfill | not_exercised | fixture_unprepared · 尚未为此操作补齐经导入或同步生成的目标质量事件、缺口或原始记录。 |
| ingest | webhook_delivery_list | GET /webhook-deliveries | valid_empty | #208 · data.length=0 |
| ingest | data_health_get | GET /data-health | fixture_reference_observed | #209 · data.length=1 |
| ingest | data_quality_issue_list | GET /data-quality/issues | fixture_reference_observed | #210 · data.length=1 |
| ingest | data_quality_issue_update | PATCH /data-quality/issues/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐经导入或同步生成的目标质量事件、缺口或原始记录。 |
| ingest | vendor_usage_list | GET /vendor-usage | valid_empty | #211 · data.length=0 |
| ingest | collection_budget_list | GET /collection-budgets | valid_empty | #212 · data.length=0 |
| ingest | data_provenance_get | GET /provenance | fixture_reference_observed | #213 · data.length=1 |
| ingest | raw_record_get | GET /raw-records/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐经导入或同步生成的目标质量事件、缺口或原始记录。 |
| commerce | commerce_store_list | GET /stores | business_verified | #52 · data.length=1 |
| commerce | commerce_store_create | POST /stores | business_verified | #49 |
| commerce | commerce_store_get | GET /stores/:id | business_verified | #51 |
| commerce | commerce_store_update | PATCH /stores/:id | business_verified | #50 |
| commerce | commerce_store_sync | POST /stores/:id/sync | not_exercised | external_unavailable · 本地 CSV 店只有导入能力，缺少可同步的授权来源。 |
| commerce | commerce_store_import | POST /stores/:id/imports | business_verified | #81 |
| commerce | commerce_store_market_list | GET /stores/:id/markets | business_verified | #54 · data.length=1 |
| commerce | commerce_store_market_configure | PUT /stores/:id/markets | business_verified | #53 |
| commerce | catalog_search | GET /products | business_verified | #74 · data.length=1 |
| commerce | commerce_product_create | POST /products | business_verified | #55 |
| commerce | catalog_get_product | GET /products/:id | business_verified | #73 |
| commerce | commerce_product_update | PATCH /products/:id | business_verified | #56 |
| commerce | commerce_product_usage | GET /products/:id/usage | business_verified | #124 |
| commerce | commerce_variant_create | POST /products/:id/variants | business_verified | #57, #65 |
| commerce | commerce_variant_update | PATCH /variants/:id | business_verified | #58 |
| commerce | market_snapshot | GET /variants/:id/listings | business_verified | #60 · data.length=1 |
| commerce | commerce_record_listing | POST /variants/:id/listings | business_verified | #59 |
| commerce | commerce_variant_group_suggest | GET /variant-groups/suggestions | valid_empty | #214 · data.length=0 |
| commerce | commerce_variant_group_list | GET /variant-groups | fixture_reference_observed | #215 · data.length=2 |
| commerce | commerce_variant_group_create | POST /variant-groups | business_verified | #61, #125 |
| commerce | commerce_variant_group_member_list | GET /variant-groups/:id/members | business_verified | #63 · data.length=1 |
| commerce | commerce_variant_group_link | POST /variant-groups/:id/members | business_verified | #62 |
| commerce | commerce_variant_group_link_batch | POST /variant-groups/:id/members/batch | business_verified | #66 |
| commerce | commerce_variant_group_unlink | DELETE /variant-groups/:id/members/:memberId | business_verified | #64 |
| commerce | catalog_list_facts | GET /products/:id/facts | valid_empty | #72 · data.length=0 |
| commerce | catalog_propose_fact | POST /products/:id/facts | business_verified | #67 |
| commerce | commerce_fact_revise | POST /facts/:id/revisions | business_verified | #68 |
| commerce | commerce_localization_list | GET /products/:id/localizations | business_verified | #71 · data.length=1 |
| commerce | catalog_update_localization | PUT /products/:id/localizations | business_verified | #69 |
| commerce | commerce_localization_submit | POST /localizations/:id/submit | business_verified | #70 |
| commerce | commerce_list_changes | GET /change-events | valid_empty | #216 · data.length=0 |
| commerce | commerce_change_acknowledge | POST /change-events/:id/acknowledge | not_exercised | missing_state · 缺少一次针对同一商品的源快照变化及其待确认事件。 |
| commerce | commerce_change_resolve | POST /change-events/:id/resolve | not_exercised | missing_state · 缺少指定变更事件和可验证的解决结果。 |
| commerce | commerce_change_dismiss | POST /change-events/:id/dismiss | not_exercised | missing_state · 缺少待处理的变更事件及业务上可忽略的理由。 |
| commerce | commerce_promotion_list | GET /promotions | fixture_reference_observed | #217 · data.length=1 |
| commerce | commerce_promotion_create | POST /promotions | business_verified | #150 |
| commerce | promotion_get | GET /promotions/:id | business_verified | #153 |
| commerce | commerce_promotion_update | PATCH /promotions/:id | business_verified | #151 |
| commerce | commerce_promotion_cancel | DELETE /promotions/:id | business_verified | #152 |
| commerce | commerce_localization_export | GET /localizations/:id/export | not_exercised | missing_state · 已验证翻译送审，缺少经人工批准的翻译版本。 |
| commerce | commerce_order_list | GET /orders | valid_empty | #218 · data.length=0 |
| commerce | commerce_order_get | GET /orders/:id | not_exercised | missing_resource · 本轮只导入商品，缺少带清结算数据的订单夹具。 |
| commerce | commerce_refund_list | GET /refunds | valid_empty | #219 · data.length=0 |
| commerce | orders_summary | GET /orders/summary | response_only | #220 |
| commerce | commerce_inventory_rule_list | GET /inventory-rules | valid_empty | #221 · data.length=0 |
| commerce | commerce_inventory_rule_create | POST /inventory-rules | not_exercised | scope_excluded · 库存阈值与通知／暂停策略属于配置变更，本轮覆盖价格及库存观测。 |
| campaign | campaign_list | GET /campaigns | fixture_reference_observed | #222 |
| campaign | campaign_create_draft | POST /campaigns | business_verified | #119 |
| campaign | campaign_update | PATCH /campaigns/:id | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Update campaign metadata」案例。 |
| campaign | campaign_transition | POST /campaigns/:id/transition | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Manually transition a campaign」案例。 |
| campaign | campaign_set_markets | PUT /campaigns/:id/markets | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Replace campaign markets」案例。 |
| campaign | campaign_set_products | PUT /campaigns/:id/products | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Replace campaign products」案例。 |
| campaign | campaign_goal_list | GET /campaigns/:id/goals | fixture_reference_observed | #223 · data.length=1 |
| campaign | campaign_goal_create | POST /campaigns/:id/goals | business_verified | #120 |
| campaign | campaign_goal_get | GET /campaigns/:id/goals/:goalId | fixture_reference_observed | #224 |
| campaign | campaign_goal_update | PATCH /campaigns/:id/goals/:goalId | business_verified | #121 |
| campaign | campaign_goal_withdraw | DELETE /campaigns/:id/goals/:goalId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Withdraw a goal while preserving history」案例。 |
| campaign | campaign_plan_slot_list | GET /campaigns/:id/plan-slots | fixture_reference_observed | #225 · data.length=1 |
| campaign | campaign_plan_slot_create | POST /campaigns/:id/plan-slots | business_verified | #122 |
| campaign | campaign_plan_slot_get | GET /campaigns/:id/plan-slots/:slotId | fixture_reference_observed | #226 |
| campaign | campaign_plan_slot_update | PATCH /campaigns/:id/plan-slots/:slotId | business_verified | #123 |
| campaign | campaign_plan_slot_delete | DELETE /campaigns/:id/plan-slots/:slotId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Delete a campaign plan slot」案例。 |
| campaign | campaign_brief_list | GET /campaigns/:id/briefs | valid_empty | #227 · data.length=0 |
| campaign | campaign_brief_create | POST /campaigns/:id/briefs | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Create a brief and optionally its initial revision」案例。 |
| campaign | brief_revision_list | GET /briefs/:id/revisions | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「List immutable brief revisions」案例。 |
| campaign | brief_update_draft | POST /briefs/:id/revisions | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Append a new immutable brief revision」案例。 |
| campaign | brief_revision_submit | POST /brief-revisions/:id/submit | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「submit a brief revision」案例。 |
| campaign | campaign_budget_line_list | GET /campaigns/:id/budget-lines | valid_empty | #228 · data.length=0 |
| campaign | campaign_budget_line_get | GET /campaigns/:id/budget-lines/:budgetLineId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Read budget_line」案例。 |
| campaign | campaign_budget_line_create | POST /campaigns/:id/budget-lines | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Record budget_line」案例。 |
| campaign | campaign_budget_line_update | PATCH /campaigns/:id/budget-lines/:budgetLineId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Revise budget_line」案例。 |
| campaign | campaign_budget_line_delete | DELETE /campaigns/:id/budget-lines/:budgetLineId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Delete an eligible budget_line」案例。 |
| campaign | campaign_cost_commitment_list | GET /campaigns/:id/cost-commitments | valid_empty | #229 · data.length=0 |
| campaign | campaign_cost_commitment_get | GET /campaigns/:id/cost-commitments/:commitmentId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Read cost_commitment」案例。 |
| campaign | campaign_cost_commitment_create | POST /campaigns/:id/cost-commitments | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Record cost_commitment」案例。 |
| campaign | campaign_cost_commitment_update | PATCH /campaigns/:id/cost-commitments/:commitmentId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Revise cost_commitment」案例。 |
| campaign | campaign_cost_commitment_delete | DELETE /campaigns/:id/cost-commitments/:commitmentId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Delete an eligible cost_commitment」案例。 |
| campaign | campaign_cost_entry_list | GET /campaigns/:id/cost-entries | valid_empty | #230 · data.length=0 |
| campaign | campaign_cost_entry_get | GET /campaigns/:id/cost-entries/:entryId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Read cost_entry」案例。 |
| campaign | campaign_cost_entry_create | POST /campaigns/:id/cost-entries | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Record cost_entry」案例。 |
| campaign | campaign_cost_entry_update | PATCH /campaigns/:id/cost-entries/:entryId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Revise cost_entry」案例。 |
| campaign | campaign_cost_entry_delete | DELETE /campaigns/:id/cost-entries/:entryId | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Delete an eligible cost_entry」案例。 |
| campaign | campaign_budget_summary | GET /campaigns/:id/budget-summary | fixture_reference_observed | #231 |
| campaign | campaign_budget_benchmarks | GET /campaigns/:id/budget-benchmarks | valid_empty | #232 · data.length=0 |
| campaign | campaign_budget_reallocation_request | POST /campaigns/:id/budget-reallocations | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Request approval to transfer budget between lines in the same currency」案例。 |
| campaign | campaign_budget_approval_list | GET /campaigns/:id/budget-approvals | valid_empty | #233 · data.length=0 |
| campaign | campaign_get_context | GET /campaigns/:id | fixture_reference_observed | #234 |
| campaign | campaign_matrix | GET /campaigns/:id/matrix | fixture_reference_observed | #235 |
| campaign | campaign_create_gap_items | POST /campaigns/:id/matrix/gaps/create-items | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Preview or create content and work items to fill plan gaps」案例。 |
| campaign | campaign_milestone_list | GET /campaigns/:id/milestones | valid_empty | #236 · data.length=0 |
| campaign | campaign_milestone_create | POST /campaigns/:id/milestones | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Add a production milestone in Workspace」案例。 |
| campaign | campaign_create_tasks | POST /campaigns/:id/tasks | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Create dependent production work items in Workspace」案例。 |
| campaign | campaign_tracking_summary | GET /campaigns/:id/tracking-summary | fixture_reference_observed | #237 |
| campaign | campaign_link_list | GET /campaigns/:id/links | valid_empty | #238 · data.length=0 |
| campaign | campaign_link_create | POST /campaigns/:id/links | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Create a Traffic short link with the immutable campaign UTM key」案例。 |
| campaign | campaign_attribution_compare | GET /campaigns/:id/attribution | response_only | #239 |
| campaign | campaign_tracking_get | GET /campaigns/:id/tracking-config | response_only | #240 |
| campaign | campaign_tracking_set | PUT /campaigns/:id/tracking-config | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Set conversion definitions and verified campaign landing targets」案例。 |
| campaign | campaign_closeout_get | GET /campaigns/:id/closeout | response_only | #241 |
| campaign | campaign_historical_baselines | GET /campaigns/:id/historical-baselines | valid_empty | #242 · data.length=0 |
| campaign | campaign_closeout_draft | POST /campaigns/:id/closeout/draft | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Preview facts and unresolved items for campaign closeout」案例。 |
| campaign | campaign_report_list | GET /campaigns/:id/reports | valid_empty | #243 · data.length=0 |
| campaign | campaign_report_backfill | POST /campaigns/:id/reports/:reportId/backfill | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Generate a new report version for a closed campaign」案例。 |
| campaign | campaign_template_derive | POST /campaigns/:id/templates | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Derive a reusable structure from a closed campaign」案例。 |
| campaign | campaign_template_list | GET /campaign-templates | valid_empty | #244 · data.length=0 |
| campaign | campaign_template_get | GET /campaign-templates/:id | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Read a campaign template」案例。 |
| campaign | campaign_template_create | POST /campaign-templates | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Save a reusable brief and relative campaign schedule」案例。 |
| campaign | campaign_template_update | PATCH /campaign-templates/:id | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Revise a campaign template」案例。 |
| campaign | campaign_template_delete | DELETE /campaign-templates/:id | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Delete an unused campaign template」案例。 |
| campaign | campaign_template_instantiate | POST /campaign-templates/:id/instantiate | not_exercised | scope_excluded · 本回合未扩展活动简报、预算和收尾。该项需独立的「Create a draft campaign, draft brief and dated plan from a template」案例。 |
| intel | watch_targets_list | GET /watch-targets | fixture_reference_observed | #245 · data.length=1 |
| intel | watch_target_create | POST /watch-targets | business_verified | #128 |
| intel | watch_target_get | GET /watch-targets/:id | fixture_reference_observed | #246 |
| intel | watch_target_update | PATCH /watch-targets/:id | business_verified | #129 |
| intel | observations_list | GET /watch-targets/:id/observations | business_verified | #131 · data.length=1 |
| intel | observation_record | POST /observations | business_verified | #130 |
| intel | research_boards_list | GET /research-boards | business_verified | #88 · data.length=1 |
| intel | research_board_create | POST /research-boards | business_verified | #85 |
| intel | research_board_get | GET /research-boards/:id | business_verified | #87 · data.items.length=1 |
| intel | research_board_update | PATCH /research-boards/:id | business_verified | #92 |
| intel | research_add_item | POST /research-boards/:id/items | business_verified | #86 |
| intel | research_create_note | POST /research-boards/:id/notes | business_verified | #89 |
| intel | research_item_update | PATCH /research-items/:id | business_verified | #91 |
| intel | research_item_delete | DELETE /research-items/:id | not_exercised | fixture_unprepared · 证据条目已被引用或转化。需独立的未引用条目验证删除。 |
| intel | research_item_convert | POST /research-items/:id/convert | business_verified | #96 |
| intel | research_search | GET /research/search | fixture_reference_observed | #247 |
| intel | research_item_evidence | GET /research-items/:id/evidence | business_verified | #90 |
| intel | creative_references_list | GET /creative-references | business_verified | #95 · data.length=1 |
| intel | creative_reference_create | POST /creative-references | business_verified | #93 |
| intel | creative_reference_annotate | PATCH /creative-references/:id | business_verified | #94 |
| intel | product_candidates_list | GET /product-candidates | fixture_reference_observed | #248 · data.length=1 |
| intel | product_candidate_create | POST /product-candidates | business_verified | #98 |
| intel | product_candidate_get | GET /product-candidates/:id | business_verified | #101 |
| intel | product_candidate_update | PATCH /product-candidates/:id | business_verified | #99 |
| intel | product_candidates_score | POST /product-candidates/:id/scores | business_verified | #100 |
| intel | observations_compare | GET /research/compare | business_verified | #132 · data.sample[0].sample_size=1, #133 · data.sample[0].sample_size=0 |
| intel | research_topics_list | GET /topics | valid_empty | #249 · data.length=0 |
| intel | research_topic_create | POST /topics | not_exercised | fixture_unprepared · 尚未为此操作补齐可复核采样定义与至少两个观察窗口。 |
| intel | research_topic_trend | GET /topics/:id/trend | not_exercised | fixture_unprepared · 尚未为此操作补齐可复核采样定义与至少两个观察窗口。 |
| intel | alert_rules_list | GET /alert-rules | valid_empty | #250 · data.length=0 |
| intel | alert_rule_create | POST /alert-rules | not_exercised | fixture_unprepared · 尚未为此操作补齐监控条件、阈值及可触发的样本。 |
| intel | alert_rule_update | PATCH /alert-rules/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐监控条件、阈值及可触发的样本。 |
| intel | alerts_list | GET /alerts | valid_empty | #251 · data.length=0 |
| intel | alerts_evaluate | POST /alerts/evaluate | not_exercised | missing_state · 需要已启用规则及满足触发条件的一组观测记录。 |
| intel | alert_update | PATCH /alerts/:id | not_exercised | missing_resource · 尚无实际触发的告警供确认或处理。 |
| intel | mentions_query | GET /mentions | business_verified | #135 · data.items.length=1 |
| intel | mention_record | POST /mentions | business_verified | #134 |
| intel | mention_labels_list | GET /mentions/:id/labels | not_exercised | fixture_unprepared · 有本次合成提及，尚无供对照的人工标签及被替换标签。 |
| intel | mention_label_update | PATCH /mentions/:id/labels | not_exercised | fixture_unprepared · 有本次合成提及，尚未补两次标注及覆盖历史断言。 |
| intel | mention_escalate | POST /mentions/:id/escalate | business_verified | #136 |
| intel | share_of_voice_get | GET /share-of-voice | not_exercised | fixture_unprepared · 需要定义来源清单、品牌比较对象及时间窗。单条提及不足以验证占比。 |
| content | content_list_pillars | GET /content-pillars | fixture_reference_observed | #252 · data.length=1 |
| content | content_create_pillar | POST /content-pillars | business_verified | #143 |
| content | content_get_pillar | GET /content-pillars/:id | fixture_reference_observed | #253 |
| content | content_update_pillar | PATCH /content-pillars/:id | business_verified | #144 |
| content | content_archive_pillar | DELETE /content-pillars/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | idea_list | GET /ideas | fixture_reference_observed | #254 · data.length=2 |
| content | idea_create | POST /ideas | business_verified | #145 |
| content | idea_create_from_conversation | POST /ideas/from-conversation | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | idea_get | GET /ideas/:id | business_verified | #97 |
| content | idea_update | PATCH /ideas/:id | business_verified | #146 |
| content | idea_convert | POST /ideas/:id/convert | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_list | GET /content-items | fixture_reference_observed | #255 · data.length=1 |
| content | content_production_workload | GET /content-items/workload | business_error | #256 |
| content | content_create_item | POST /content-items | business_verified | #23 |
| content | content_create_draft | POST /content-items/draft | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_get | GET /content-items/:id | business_verified | #28 |
| content | content_item_update | PATCH /content-items/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_set_stage | POST /content-items/:id/stage | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_create_variant | POST /content-items/:id/variants | business_verified | #24 |
| content | content_export_item | GET /content-items/:id/export | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_duplicate | POST /content-items/:id/duplicate | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_record_handoff_checklist | POST /content-items/:id/handoff-checklist | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_list_stale | GET /content-variants/stale | valid_empty | #257 · data.length=0 |
| content | content_batch_variants | POST /content-variants/batch | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_get_variant | GET /content-variants/:id | business_verified | #27 |
| content | content_list_product_facts | GET /content-variants/:id/product-facts | valid_empty | #258 · data.length=0 |
| content | content_insert_product_fact | POST /content-variants/:id/product-facts | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_list_product_prices | GET /content-variants/:id/product-prices | valid_empty | #259 · data.length=0 |
| content | content_insert_product_price | POST /content-variants/:id/product-prices | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_autosave_variant | PATCH /content-variants/:id | business_verified | #25 |
| content | content_request_rendition | POST /content-variants/:id/renditions | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_update_variant | POST /content-variants/:id/agent-edit | business_verified | #46 |
| content | content_commit_revision | POST /content-variants/:id/revisions | business_verified | #26 |
| content | content_list_revisions | GET /content-variants/:id/revisions | business_verified | #29 · data.length=1 |
| content | content_get_revision | GET /content-revisions/:id | business_verified | #47 |
| content | content_diff_revisions | GET /content-revisions/:a/diff/:b | business_verified | #48 |
| content | content_restore_revision | POST /content-revisions/:id/restore | not_exercised | fixture_unprepared · 尚未为此操作补齐可比较的两个修订或配对译文。 |
| content | content_validate_variant | POST /content-variants/:id/validate | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_set_readiness | POST /content-variants/:id/readiness | not_exercised | fixture_unprepared · 尚未为此操作补齐独立的内容稿件及该转换、审核或归档所需版本。 |
| content | content_list_translations | GET /content-variants/:id/translations | valid_empty | #260 · data.length=0 |
| content | content_create_translation | POST /content-variants/:id/translations | not_exercised | fixture_unprepared · 尚未为此操作补齐可比较的两个修订或配对译文。 |
| content | content_accept_source_change | POST /translation-links/:id/accept-source-change | not_exercised | fixture_unprepared · 尚未为此操作补齐可比较的两个修订或配对译文。 |
| content | content_mark_divergence | POST /translation-links/:id/mark-divergence | not_exercised | fixture_unprepared · 尚未为此操作补齐可比较的两个修订或配对译文。 |
| content | content_list_feeds | GET /feeds | valid_empty | #261 · data.length=0 |
| content | content_create_feed | POST /feeds | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_get_feed | GET /feeds/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_update_feed | PATCH /feeds/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_archive_feed | DELETE /feeds/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_poll_feed | POST /feeds/:id/poll | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_preview_feed_import | POST /feeds/:id/preview-import | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_list_feed_items | GET /feeds/:id/items | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_import_feed_item | POST /feed-items/:id/import | not_exercised | fixture_unprepared · 尚未为此操作补齐授权本地信息源和可重复读取的条目。 |
| content | content_request_post_maintenance | POST /platform-posts/:id/maintenance | not_exercised | fixture_unprepared · 尚未构造能验证「Request post maintenance」的 :id 记录及其业务状态。 |
| content | content_get_transcript | GET /content-transcripts/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐带音轨的授权媒体及本地转录能力。 |
| content | content_review_transcript | PATCH /content-transcripts/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐带音轨的授权媒体及本地转录能力。 |
| content | content_request_transcript | POST /content-transcripts | not_exercised | fixture_unprepared · 尚未为此操作补齐带音轨的授权媒体及本地转录能力。 |
| asset | asset_list_submission_boxes | GET /submission-boxes | valid_empty | #262 · data.length=0 |
| asset | asset_get_submission_box | GET /submission-boxes/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐独立投稿箱、投稿及审阅状态。 |
| asset | asset_list_external_sources | GET /external-sources | valid_empty | #263 · data.length=0 |
| asset | asset_begin_upload | POST /assets/uploads | not_exercised | fixture_unprepared · 尚未为此操作补齐独立可归档或移动的合成素材及关联状态。 |
| asset | asset_search | GET /assets | fixture_reference_observed | #264 · data.length=1 |
| asset | asset_create | POST /assets | business_verified | #16 |
| asset | asset_find_duplicates | GET /assets/:id/duplicates | valid_empty | #265 · data.length=0 |
| asset | asset_get | GET /assets/:id | business_verified | #17 |
| asset | asset_update | PATCH /assets/:id | business_verified | #19 |
| asset | asset_set_favorite | POST /assets/:id/favorite | not_exercised | fixture_unprepared · 尚未为此操作补齐独立可归档或移动的合成素材及关联状态。 |
| asset | asset_download_version | GET /asset-versions/:id/download | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配的素材版本、派生参数和回读产物或失败状态。 |
| asset | asset_list_versions | GET /assets/:id/versions | business_verified | #18 · data.length=1 |
| asset | asset_add_version | POST /assets/:id/versions | not_exercised | fixture_unprepared · 尚未为此操作补齐独立可归档或移动的合成素材及关联状态。 |
| asset | asset_usage | GET /assets/:id/usage | fixture_reference_observed | #266 |
| asset | asset_request_rendition | POST /asset-versions/:id/renditions | business_verified | #21 |
| asset | asset_request_rendition_batch | POST /asset-versions/:id/rendition-batch | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配的素材版本、派生参数和回读产物或失败状态。 |
| asset | asset_retry_rendition | POST /renditions/:id/retry | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配的素材版本、派生参数和回读产物或失败状态。 |
| asset | asset_get_rendition | GET /renditions/:id | business_verified | #22 |
| asset | asset_archive | POST /assets/:id/archive | not_exercised | fixture_unprepared · 尚未为此操作补齐独立可归档或移动的合成素材及关联状态。 |
| asset | asset_list_folders | GET /asset-folders | valid_empty | #267 · data.length=0 |
| asset | asset_get_folder | GET /asset-folders/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐独立可归档或移动的合成素材及关联状态。 |
| asset | rights_list | GET /rights-grants | fixture_reference_observed | #268 · data.length=1 |
| asset | rights_list_impacts | GET /rights-impacts | valid_empty | #269 · data.length=0 |
| asset | rights_get | GET /rights-grants/:id | business_verified | #20 |
| asset | rights_create_draft | POST /rights-grants | not_exercised | fixture_unprepared · 尚未为此操作补齐另一个素材授权草稿或可验证的适用范围及权益状态。 |
| asset | rights_revise | POST /rights-grants/:id/revisions | not_exercised | fixture_unprepared · 尚未为此操作补齐另一个素材授权草稿或可验证的适用范围及权益状态。 |
| asset | asset_check_usage | POST /rights/check | not_exercised | fixture_unprepared · 尚未为此操作补齐另一个素材授权草稿或可验证的适用范围及权益状态。 |
| asset | knowledge_list | GET /knowledge | fixture_reference_observed | #270 · data.length=1 |
| asset | knowledge_import | POST /knowledge/import | not_exercised | fixture_unprepared · 尚未为此操作补齐对应知识来源、导入正文或可审阅版本。 |
| asset | knowledge_get | GET /knowledge/:id | fixture_reference_observed | #271 |
| asset | knowledge_propose | POST /knowledge | business_verified | #147 |
| asset | knowledge_revise | POST /knowledge/:id/revisions | not_exercised | fixture_unprepared · 尚未为此操作补齐对应知识来源、导入正文或可审阅版本。 |
| asset | knowledge_get_context | GET /brands/:brandId/context | fixture_reference_observed | #272 |
| asset | template_list | GET /templates | valid_empty | #273 · data.length=0 |
| asset | template_get | GET /templates/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配工作流使用方式的模板及版本。 |
| asset | template_create | POST /templates | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配工作流使用方式的模板及版本。 |
| asset | template_update | PATCH /templates/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配工作流使用方式的模板及版本。 |
| asset | template_archive | DELETE /templates/:id | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配工作流使用方式的模板及版本。 |
| asset | template_render | POST /templates/:id/render | not_exercised | fixture_unprepared · 尚未为此操作补齐匹配工作流使用方式的模板及版本。 |
| planning | publishing_get_calendar | GET /calendar | fixture_reference_observed | #274 · data.targets.length=2 |
| planning | publishing_list_targets | GET /publish-targets | business_verified | #37 · data.length=1 |
| planning | publishing_get_target | GET /publish-targets/:id | business_verified | #36 |
| planning | publishing_create_target | POST /publish-targets | business_verified | #30 |
| planning | publishing_update_target | PATCH /publish-targets/:id | business_verified | #31 |
| planning | publishing_request_approval | POST /publish-targets/:id/submit | business_verified | #34 |
| planning | publishing_run_precheck | POST /publish-targets/:id/precheck | business_verified | #32 |
| planning | publishing_reschedule | POST /publish-targets/:id/reschedule | business_verified | #33 |
| planning | publishing_cancel | POST /publish-targets/:id/cancel | business_verified | #45 |
| planning | publishing_list_approvals | GET /approvals | business_verified | #38 · data.length=1 |
| planning | publishing_create_plan | POST /publish-plans | business_verified | #40 |
| planning | publishing_update_plan | PATCH /publish-plans/:id | business_verified | #41 |
| planning | publishing_preview_plan_items | POST /publish-plans/preview | computed_verified | #39 |
| planning | publishing_preview_plan | POST /publish-plans/:id/preview | computed_verified | #42 |
| planning | publishing_schedule | POST /publish-plans/:id/commit | business_verified | #43 |
| planning | publishing_get_plan | GET /publish-plans/:id | business_verified | #44 |
| planning | publishing_list_pauses | GET /pause-switches | valid_empty | #275 · data.length=0 |
| planning | publishing_get_pause | GET /pause-switches/:id | not_exercised | missing_resource · 本轮未启用发布暂停开关，缺少可查询的暂停记录。 |
| planning | publishing_pause | POST /pause-switches | not_exercised | scope_excluded · 暂停开关会改变发布范围的执行策略，本轮只操作单个合成目标。 |
| planning | publishing_list_slot_templates | GET /slot-templates | valid_empty | #276 · data.length=0 |
| planning | publishing_get_slot_template | GET /slot-templates/:id | not_exercised | missing_resource · 没有槽位模板，本轮排期使用显式时间。 |
| planning | publishing_list_schedule_rules | GET /schedule-rules | valid_empty | #277 · data.length=0 |
| planning | publishing_get_schedule_rule | GET /schedule-rules/:id | not_exercised | missing_resource · 没有周期排期规则，本轮使用一次性时间。 |
| planning | publishing_list_evergreen_queues | GET /evergreen-queues | valid_empty | #278 · data.length=0 |
| planning | publishing_get_evergreen_queue | GET /evergreen-queues/:id | not_exercised | missing_resource · 本轮没有常青内容队列。 |
| planning | publishing_list_evergreen_items | GET /evergreen-queues/:id/items | not_exercised | missing_resource · 需要含候选内容的常青队列。 |
| planning | publishing_list_review_rounds | GET /review-rounds | valid_empty | #279 · data.length=0 |
| planning | publishing_get_review_round | GET /review-rounds/:id | not_exercised | missing_resource · 单目标审批已有回读，缺少独立审核轮次。 |
| planning | publishing_list_post_matches | GET /reconciliation/candidates | valid_empty | #280 · data.length=0 |
| planning | publishing_suggest_post_match | GET /reconciliation/suggestions/:id | not_exercised | missing_resource · 缺少已发布贴文及可与其匹配的目标。本轮贴文读回为零。 |
| planning | publishing_suggest_evergreen_order | GET /evergreen-queues/:id/suggestions | not_exercised | missing_resource · 需要含多个可排序内容条目的常青队列。 |
| planning | publishing_suggest_slots | GET /slot-suggestions | valid_empty | #281 · data.length=0 |
| execution | publishing_list_execution | GET /execution-tasks | valid_empty | #282 · data.length=0 |
| execution | publishing_get_execution | GET /execution-tasks/:id | not_exercised | missing_state · 目标送审后保持待审，尚无已核准的发布执行任务。 |
| execution | publishing_list_exceptions | GET /execution-exceptions | valid_empty | #283 · data.length=0 |
| execution | publishing_run_now | POST /execution-tasks/:id/run-now | not_exercised | scope_excluded · 会调度执行器，缺少核准目标与隔离发布执行夹具。 |
| execution | publishing_retry | POST /execution-tasks/:id/retry | not_exercised | missing_state · 缺少已标记安全可重试的失败执行任务。 |
| execution | publishing_reconcile | POST /execution-tasks/:id/reconcile | not_exercised | missing_state · 缺少结果未知的任务和独立回执。 |
| execution | execution_cancel_task | POST /execution-tasks/:id/cancel | not_exercised | missing_state · 已覆盖待审批目标取消。执行层取消需已有任务。 |
| execution | posts_list | GET /platform-posts | valid_empty | #351 · data.length=0 |
| execution | posts_get | GET /platform-posts/:id | not_exercised | missing_resource · 本轮贴文列表确认为零，无贴文记录可精确查询。 |
| execution | posts_register_manual | POST /platform-posts/register | not_exercised | external_unavailable · 缺少可如实登记的合法沙箱贴文和证据。 |
| execution | publishing_preview_execution_batch | POST /execution-batches/preview | not_exercised | missing_state · 缺少可纳入批次的已有执行任务。 |
| execution | publishing_apply_execution_batch | POST /execution-batches/:id/apply | not_exercised | missing_state · 缺少已通过的执行批次预览和对应任务版本。 |
| inbox | inbox_list | GET /conversations | fixture_reference_observed | #284 |
| inbox | inbox_get_conversation | GET /conversations/:id | fixture_reference_observed | #285 |
| inbox | inbox_ingest_batch | POST /inbox/ingest | business_verified | #138 |
| inbox | inbox_update_conversation | PATCH /conversations/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Assign or change processing status」案例。 |
| inbox | inbox_batch_conversations | POST /conversations/batch | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Preview or apply conversation updates」案例。 |
| inbox | inbox_mark_read | POST /conversations/:id/read | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Set personal read position」案例。 |
| inbox | inbox_claim | POST /conversations/:id/occupancy | business_verified | #139 |
| inbox | inbox_release | DELETE /conversations/:id/occupancy | business_verified | #140 |
| inbox | inbox_add_note | POST /conversations/:id/notes | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Write an internal note」案例。 |
| inbox | inbox_draft_reply | POST /conversations/:id/reply-drafts | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Draft a reply」案例。 |
| inbox | inbox_update_reply_draft | PATCH /reply-drafts/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Edit a reply draft」案例。 |
| inbox | inbox_submit_reply_approval | POST /reply-drafts/:id/submit-approval | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Request approval」案例。 |
| inbox | inbox_send_reply | POST /reply-drafts/:id/send | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Stage an approved reply for manual delivery」案例。 |
| inbox | inbox_get_reply_status | GET /outbound-replies/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read reply state and attempts」案例。 |
| inbox | inbox_reconcile_reply | POST /outbound-replies/:id/reconcile | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Verify a reply against synchronized platform messages」案例。 |
| inbox | inbox_manual_complete_reply | POST /outbound-replies/:id/manual-complete | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Record manual delivery evidence」案例。 |
| inbox | inbox_cancel_reply | POST /outbound-replies/:id/cancel | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Cancel a staged or confirmed unsent reply」案例。 |
| inbox | inbox_create_sla_policy | POST /inbox/sla-policies | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Create business-hours or elapsed-time service targets」案例。 |
| inbox | inbox_update_sla_policy | PATCH /inbox/sla-policies/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Update service targets for future assignments」案例。 |
| inbox | inbox_sla_tick | POST /inbox/sla-policies/tick | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Evaluate service deadlines」案例。 |
| inbox | inbox_unsnooze | POST /inbox/unsnooze | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Reopen due snoozed conversations」案例。 |
| inbox | inbox_evaluate_auto_rules | POST /inbox/messages/:id/evaluate-rules | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Evaluate draft-only rules on a stored inbound message」案例。 |
| inbox | inbox_coverage | GET /inbox/coverage | fixture_reference_observed | #286 |
| inbox | inbox_get_sla_sample | GET /inbox/sla-sample | response_only | #287 |
| inbox | inbox_get_participant_link | GET /conversations/:id/customer-link | fixture_reference_observed | #288 |
| inbox | inbox_list_moderation | GET /conversations/:id/moderation | response_only | #289 |
| inbox | inbox_record_manual_moderation | POST /conversations/:id/moderation | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Record a completed manual comment moderation action without writing to the platform」案例。 |
| inbox | inbox_set_local_comment_access | PUT /inbox/local-comment-access | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Authorize loopback comment readback for a known comment account」案例。 |
| inbox | inbox_read_comment_state | POST /conversations/:id/moderation/readback | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read the authorized provider state after a manual comment action」案例。 |
| inbox | inbox_list_cases | GET /cases | fixture_reference_observed | #290 · data.length=1 |
| inbox | inbox_get_case | GET /cases/:id | business_verified | #142 |
| inbox | inbox_create_case | POST /cases | business_verified | #141 |
| inbox | inbox_handoff_case | POST /cases/:id/handoff | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Record a handoff request awaiting acknowledgment」案例。 |
| inbox | inbox_update_case | PATCH /cases/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Record external acknowledgment, resolution or closeout」案例。 |
| inbox | inbox_record_translation | POST /messages/:id/translations | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Attach a human translation while preserving the original」案例。 |
| inbox | inbox_list_translations | GET /messages/:id/translations | valid_empty | #291 · data.length=0 |
| inbox | inbox_list_review_sources | GET /inbox/review-sources | valid_empty | #292 · data.length=0 |
| inbox | inbox_register_review_source | POST /inbox/review-sources | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Register a manual public review import source」案例。 |
| inbox | inbox_import_review | POST /inbox/review-sources/:id/import | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Import a public rating and its source link」案例。 |
| inbox | inbox_list_reviews | GET /reviews | valid_empty | #293 · data.length=0 |
| inbox | inbox_get_review_summary | GET /inbox/review-summary | response_only | #294 |
| inbox | inbox_handoff_review | POST /reviews/:id/handoff | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Assign a public review for manual follow-up」案例。 |
| inbox | inbox_get_review | GET /reviews/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read the public review and manual reply verification history」案例。 |
| inbox | inbox_verify_review_reply | POST /reviews/:id/verify-reply | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Record manually observed platform reply evidence」案例。 |
| inbox | inbox_link_participant | POST /inbox/participants/:id/link-customer | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Link a participant to an evidenced customer identity」案例。 |
| inbox | inbox_unlink_participant | DELETE /inbox/participants/:id/link-customer | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Remove a manually linked customer identity」案例。 |
| inbox | inbox_update_note | PATCH /notes/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Manage an internal note」案例。 |
| inbox | inbox_delete_note | DELETE /notes/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Manage an internal note」案例。 |
| inbox | inbox_list_business_hours | GET /inbox/business-hours | valid_empty | #295 · data.length=0 |
| inbox | inbox_get_business_hours | GET /inbox/business-hours/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read business_hours configuration」案例。 |
| inbox | inbox_archive_business_hours | DELETE /inbox/business-hours/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Archive business_hours configuration」案例。 |
| inbox | inbox_list_sla_policies | GET /inbox/sla-policies | valid_empty | #296 · data.length=0 |
| inbox | inbox_get_sla_policy | GET /inbox/sla-policies/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read sla_policy configuration」案例。 |
| inbox | inbox_archive_sla_policy | DELETE /inbox/sla-policies/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Archive sla_policy configuration」案例。 |
| inbox | inbox_list_auto_rules | GET /inbox/auto-rules | valid_empty | #297 · data.length=0 |
| inbox | inbox_get_auto_rule | GET /inbox/auto-rules/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read auto_rule configuration」案例。 |
| inbox | inbox_archive_auto_rule | DELETE /inbox/auto-rules/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Archive auto_rule configuration」案例。 |
| inbox | inbox_create_business_hours | POST /inbox/business-hours | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Create a business-hours calendar」案例。 |
| inbox | inbox_update_business_hours | PATCH /inbox/business-hours/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Update a calendar for future service deadlines」案例。 |
| inbox | inbox_create_auto_rule | POST /inbox/auto-rules | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Create a paused draft-only reply rule」案例。 |
| inbox | inbox_enable_auto_rule | PATCH /inbox/auto-rules/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Edit, enable or pause a draft-only reply rule」案例。 |
| inbox | inbox_list_auto_rule_runs | GET /inbox/auto-rules/:id/runs | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「List rule outcomes and skip reasons」案例。 |
| inbox | inbox_list_auto_reply_review | GET /inbox/auto-reply-review | valid_empty | #298 · data.length=0 |
| inbox | inbox_get_reply_draft | GET /reply-drafts/:id | not_exercised | scope_excluded · 本回合未扩展客服流程与消息发送。该项需独立的「Read a reply draft and its review status」案例。 |
| inbox | inbox_get_conversation_sla | GET /conversations/:id/sla | response_only | #299 |
| creator | creators_search | GET /creators | fixture_reference_observed | #300 · data.length=1 |
| creator | creators_get | GET /creators/:id | fixture_reference_observed | #301 |
| creator | creators_create | POST /creators | business_verified | #126 |
| creator | creators_update | PATCH /creators/:id | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Update creator profile and contact preference」案例。 |
| creator | creators_record_audience | POST /creators/:id/audience-observations | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record an audience market share with its source and observation time」案例。 |
| creator | creators_list_contacts | GET /creators/:id/contacts | valid_empty | #302 · data.length=0 |
| creator | creators_import_contacts | POST /creators/:id/contacts/import | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Import creator contacts from CSV into a selected profile」案例。 |
| creator | creators_list_associations | GET /creators/:id/associations | valid_empty | #303 · data.length=0 |
| creator | creators_associate_profiles | POST /creators/:id/associations | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Associate duplicate creator profiles with evidence」案例。 |
| creator | creators_revoke_association | POST /creator-associations/:id/revoke | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Undo an association and retain its evidence」案例。 |
| creator | creators_link_account | POST /creators/:id/accounts | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Link a self-reported or publicly verifiable account」案例。 |
| creator | creators_verify_account | POST /creator-accounts/:id/verify | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record a manual creator account verification with supporting evidence」案例。 |
| creator | collaborations_list | GET /collaborations | fixture_reference_observed | #304 · data.length=1 |
| creator | collaborations_get | GET /collaborations/:id | fixture_reference_observed | #305 |
| creator | collaborations_create | POST /collaborations | business_verified | #168 |
| creator | collaborations_update | PATCH /collaborations/:id | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Plan next actions, complete or cancel a collaboration」案例。 |
| creator | outreach_draft | POST /collaborations/:id/outreach | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Draft an invitation without sending it」案例。 |
| creator | outreach_record_sent | POST /outreach/:id/record-sent | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record an invitation actually sent outside SmartSell」案例。 |
| creator | outreach_record_reply | POST /collaborations/:id/outreach/reply | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record an actual creator reply」案例。 |
| creator | collaborations_create_terms | POST /collaborations/:id/terms | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Create an immutable collaboration terms revision」案例。 |
| creator | collaborations_send_terms | POST /terms/:id/send | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record reference for the terms sent for signature」案例。 |
| creator | deliverables_create | POST /collaborations/:id/deliverables | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Request a collaboration deliverable」案例。 |
| creator | deliverables_list | GET /collaborations/:id/deliverables | valid_empty | #306 · data.length=0 |
| creator | deliverables_get | GET /deliverables/:id | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Read deliverable and its submission history」案例。 |
| creator | deliverables_change_deadline | PATCH /deliverables/:id/deadline | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Update a deliverable deadline and flag the linked publication for schedule review」案例。 |
| creator | deliverables_list_missing | GET /deliverables/missing | valid_empty | #307 · data.length=0 |
| creator | deliverables_submit | POST /deliverables/:id/versions | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Submit files or a source link for review」案例。 |
| creator | deliverables_link_rights | POST /deliverables/:id/link-rights | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Link AS grant references to deliverable assets」案例。 |
| creator | creators_assign_affiliate | POST /collaborations/:id/affiliate-assignments | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Assign an existing promotion code, short link or platform reference」案例。 |
| creator | creators_list_shipments | GET /sample-shipments | valid_empty | #308 · data.length=0 |
| creator | creators_create_shipment | POST /sample-shipments | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Plan the shipment of sample items」案例。 |
| creator | creators_update_shipment | PATCH /sample-shipments/:id | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record a manual logistics status and its reference」案例。 |
| creator | creators_list_live_sessions | GET /live-sessions | valid_empty | #309 · data.length=0 |
| creator | creators_get_live_session | GET /live-sessions/:id | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Read the live plan and current clip reuse rights」案例。 |
| creator | creators_plan_live_session | POST /live-sessions | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Plan a creator live session and run sheet」案例。 |
| creator | creators_update_live_session | PATCH /live-sessions/:id | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record live session scheduling and observed progress」案例。 |
| creator | creators_plan_clip_reuse | POST /live-sessions/:id/clip-reuse | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Plan reuse of a live clip after checking asset rights」案例。 |
| creator | creators_list_evaluations | GET /campaigns/:id/creator-evaluations | valid_empty | #310 · data.length=0 |
| creator | creators_evaluate | POST /campaigns/:id/creator-evaluations | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record scored dimensions and evidence for creator selection」案例。 |
| creator | creators_override_evaluation | POST /creator-evaluations/:id/overrides | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record a human evaluation override with an audit trail」案例。 |
| creator | commissions_list | GET /commission-entries | response_only | #311 |
| creator | commissions_reconcile_attribution | GET /collaborations/:id/attribution-reconciliation | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Compare collaboration accrual and imported commission observations by order」案例。 |
| creator | commissions_accrue | POST /commission-entries | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Calculate commission for a paid order line」案例。 |
| creator | commissions_import | POST /commission-entries/import | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Import an evidenced attribution to a paid order line」案例。 |
| creator | commissions_mature | POST /commission-entries/mature | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Mature observed commissions」案例。 |
| creator | commissions_reverse | POST /commission-entries/:id/reverse | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Append a refund or cancellation adjustment」案例。 |
| creator | commissions_record_platform_settlement | POST /commission-entries/:id/platform-settlement | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Record external platform settlement evidence」案例。 |
| creator | commissions_list_batches | GET /settlement-batches | valid_empty | #312 · data.length=0 |
| creator | commissions_create_batch | POST /settlement-batches | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Submit a self-settled commission batch for approval」案例。 |
| creator | commissions_batch_cancel | POST /settlement-batches/:id/cancel | not_exercised | scope_excluded · 本回合未扩展达人合作、物流和佣金。该项需独立的「Cancel a batch and release its entries」案例。 |
| traffic | links_list | GET /short-links | valid_empty | #313 · data.length=0 |
| traffic | links_create | POST /short-links | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Create a tracked short link」案例。 |
| traffic | links_get | GET /short-links/:id | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Read link and destination revisions」案例。 |
| traffic | links_update | PATCH /short-links/:id | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Pause or archive a short link」案例。 |
| traffic | links_change_destination | POST /short-links/:id/destination | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Append a destination revision」案例。 |
| traffic | links_get_stats | GET /short-links/:id/stats | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Separate observed redirects from likely human traffic」案例。 |
| traffic | links_batch | POST /short-links/batch | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Preview or create a batch of short links」案例。 |
| traffic | links_allowlist_list | GET /redirect-allowlist | valid_empty | #314 · data.length=0 |
| traffic | links_domains_list | GET /link-domains | valid_empty | #315 · data.length=0 |
| traffic | utm_list | GET /utm-templates | fixture_reference_observed | #316 · data.length=1 |
| traffic | utm_create | POST /utm-templates | business_verified | #162 |
| traffic | utm_update | PATCH /utm-templates/:id | business_verified | #163 |
| traffic | utm_remove | DELETE /utm-templates/:id | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Remove a UTM template」案例。 |
| traffic | utm_build | POST /utm-templates/preview | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Preview expanded UTM parameters」案例。 |
| traffic | links_destinations_list | GET /landing-destinations | valid_empty | #317 · data.length=0 |
| traffic | links_destination_create | POST /landing-destinations | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Register an allowed landing destination」案例。 |
| traffic | links_destination_update | PATCH /landing-destinations/:id | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Update a registered destination」案例。 |
| traffic | pages_list | GET /landing-pages | valid_empty | #318 · data.length=0 |
| traffic | pages_create_draft | POST /landing-pages | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Create a landing page draft」案例。 |
| traffic | pages_versions | GET /landing-pages/:id/versions | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「List immutable landing page versions」案例。 |
| traffic | pages_create_version | POST /landing-pages/:id/versions | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Append a page draft version」案例。 |
| traffic | pages_unpublish | POST /landing-pages/:id/unpublish | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Take a page offline」案例。 |
| traffic | links_list_checks | GET /page-checks | valid_empty | #319 · data.length=0 |
| traffic | links_probe | POST /page-checks/probe | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Observe a registered HTTPS destination」案例。 |
| traffic | links_check | POST /page-checks | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Run local checks and record manual evidence」案例。 |
| traffic | bio_list | GET /bio-pages | valid_empty | #320 · data.length=0 |
| traffic | bio_create | POST /bio-pages | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Create a bio page draft」案例。 |
| traffic | bio_publish | POST /bio-pages/:id/publish | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Publish or take a bio page offline」案例。 |
| traffic | bio_items | GET /bio-pages/:id/items | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「List scheduled bio items with current visibility」案例。 |
| traffic | pages_experiment_report | GET /landing-pages/:id/experiment | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Read reported page experiment samples and coverage」案例。 |
| traffic | forms_list | GET /forms | valid_empty | #321 · data.length=0 |
| traffic | forms_create | POST /forms | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Create a form draft」案例。 |
| traffic | forms_versions | GET /forms/:id/versions | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「List historical form versions」案例。 |
| traffic | forms_create_version | POST /forms/:id/versions | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Append an immutable form version」案例。 |
| traffic | forms_deactivate | POST /forms/:id/deactivate | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Stop accepting form submissions」案例。 |
| traffic | leads_list | GET /leads | valid_empty | #322 · data.length=0 |
| traffic | leads_get | GET /leads/:id | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Read a masked lead and its follow-up history」案例。 |
| traffic | leads_update | PATCH /leads/:id | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Assign or follow up on a lead」案例。 |
| traffic | leads_handoff | POST /leads/:id/handoff | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Queue a consent-checked CRM handoff」案例。 |
| traffic | leads_record_handoff_receipt | POST /leads/:id/handoff/receipt | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Record CRM provider readback for the current handoff」案例。 |
| traffic | leads_export | POST /leads/export | not_exercised | scope_excluded · 本回合未扩展落地页、表单和流量归因。该项需独立的「Export masked lead records with audit event」案例。 |
| ads | ads_list_accounts | GET /ad-accounts | business_verified | #155 · data.length=1 |
| ads | ads_register_account | POST /ad-accounts | business_verified | #154 |
| ads | ads_update_account | PATCH /ad-accounts/:id | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Update connection and spend cap references」案例。 |
| ads | ads_import_report | POST /ad-accounts/:id/import | business_verified | #159 |
| ads | ads_list_entities | GET /ad-entities | fixture_reference_observed | #323 · data.length=1 |
| ads | ads_query_performance | GET /ads/performance | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Read advertising observations and budget pacing」案例。 |
| ads | ads_list_creatives | GET /ad-creatives | fixture_reference_observed | #324 · data.length=1 |
| ads | ads_create_creative | POST /ad-creatives | business_verified | #160 |
| ads | ads_list_creative_variants | GET /ad-creatives/:id/variants | valid_empty | #325 · data.length=0 |
| ads | ads_create_creative_variant | POST /ad-creatives/:id/variants | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Append an immutable ad creative variant」案例。 |
| ads | ads_archive_creative | DELETE /ad-creatives/:id | business_verified | #161 |
| ads | ads_list_proposals | GET /ad-proposals | valid_empty | #326 · data.length=0 |
| ads | ads_create_proposal | POST /ad-proposals | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Create an immutable advertising change proposal revision」案例。 |
| ads | ads_get_proposal | GET /ad-proposals/:id | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Get proposal with revision and approval history」案例。 |
| ads | ads_revise_proposal | POST /ad-proposals/:id/revisions | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Append a revision and invalidate earlier approval」案例。 |
| ads | ads_submit_proposal | POST /ad-proposals/:id/submit-approval | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Submit the current revision for approval」案例。 |
| ads | ads_export_proposal | POST /ad-proposals/:id/export | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Export a revision-bound manual operation package」案例。 |
| ads | ads_record_manual_operation | POST /ad-proposals/:id/manual-operations | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Record an approved manual handoff with no provider execution」案例。 |
| ads | ads_get_operation | GET /ad-operations/:id | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Read an advertising operation and its observed attempts」案例。 |
| ads | ads_list_adjustments | GET /adjustment-suggestions | valid_empty | #327 · data.length=0 |
| ads | ads_suggest_adjustments | POST /adjustment-suggestions | not_exercised | scope_excluded · 本回合未扩展广告投放、审批和预算。该项需独立的「Record a reviewable advertising adjustment with evidence」案例。 |
| lifecycle | lifecycle_set_local_esp | PUT /esp-accounts/:id/local-config | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Authorize the local email ESP with an explicit test-address allowlist」案例。 |
| lifecycle | lifecycle_sync_local_esp_suppressions | POST /esp-accounts/:id/sync-suppressions | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Read opt-outs and suppressions from the authorized local ESP」案例。 |
| lifecycle | lifecycle_reconcile_local_esp | POST /esp-campaigns/:id/local-reconcile | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Read an independent ESP receipt and save actual delivery members」案例。 |
| lifecycle | lifecycle_list_esp_attempts | GET /esp-campaigns/:id/attempts | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Read the ESP submission and receipt history」案例。 |
| lifecycle | lifecycle_read_local_esp_flow | POST /esp-flows/:id/local-readback | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Read provider flow state independently of the campaign lifecycle」案例。 |
| lifecycle | customers_list | GET /customers | fixture_reference_observed | #328 · data.length=1 |
| lifecycle | customers_create | POST /customers | business_verified | #127 |
| lifecycle | customers_get | GET /customers/:id | fixture_reference_observed | #329 |
| lifecycle | customers_link_identity | POST /customers/:id/identities | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Link a pseudonymous identity with evidence」案例。 |
| lifecycle | customers_unlink_identity | DELETE /customer-identities/:id | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Unlink a customer identity」案例。 |
| lifecycle | customers_merge | POST /customers/merge | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Merge customer profiles with manual evidence」案例。 |
| lifecycle | customers_revert_merge | POST /customer-merges/:id/revert | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Restore customer profile and original identity ownership」案例。 |
| lifecycle | customers_get_consents | GET /customers/:id/consents | response_only | #330 |
| lifecycle | lifecycle_record_consent | POST /customers/:id/consents | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Append an evidence-backed consent event」案例。 |
| lifecycle | lifecycle_list_consent_conflicts | GET /consent-conflicts | valid_empty | #331 · data.length=0 |
| lifecycle | lifecycle_list_consent_texts | GET /consent-texts | fixture_reference_observed | #332 · data.length=1 |
| lifecycle | lifecycle_get_consent_text | GET /consent-texts/:id | business_verified | #165 |
| lifecycle | lifecycle_create_consent_text | POST /consent-texts | business_verified | #164 |
| lifecycle | lifecycle_record_suppression | POST /lifecycle/suppressions | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Record a source-specific channel suppression」案例。 |
| lifecycle | segments_list | GET /segments | fixture_reference_observed | #333 · data.length=1 |
| lifecycle | segments_get | GET /segments/:id | business_verified | #167 |
| lifecycle | segments_create | POST /segments | business_verified | #166 |
| lifecycle | segments_create_version | POST /segments/:id/versions | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Append an immutable segment definition」案例。 |
| lifecycle | segments_preview | POST /segments/:id/preview | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Preview audience with aggregate exclusion counts」案例。 |
| lifecycle | segments_list_snapshots | GET /segments/:id/snapshots | valid_empty | #334 · data.length=0 |
| lifecycle | lifecycle_list_esp_accounts | GET /esp-accounts | valid_empty | #335 · data.length=0 |
| lifecycle | lifecycle_create_esp_account | POST /esp-accounts | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Register an ESP reference for a channel」案例。 |
| lifecycle | lifecycle_list_campaigns | GET /esp-campaigns | valid_empty | #336 · data.length=0 |
| lifecycle | lifecycle_create_campaign_draft | POST /esp-campaigns | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Create a local lifecycle campaign draft」案例。 |
| lifecycle | lifecycle_get_campaign | GET /esp-campaigns/:id | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Get lifecycle campaign reference」案例。 |
| lifecycle | lifecycle_import_campaign_send | POST /esp-campaigns/:id/send-observation | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Import actual audience size from an ESP send report」案例。 |
| lifecycle | lifecycle_export_campaign | POST /esp-campaigns/:id/export | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Export local campaign configuration and fresh audience estimate」案例。 |
| lifecycle | lifecycle_cancel_campaign | POST /esp-campaigns/:id/cancel | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Cancel a local draft campaign」案例。 |
| lifecycle | lifecycle_list_flows | GET /esp-flows | valid_empty | #337 · data.length=0 |
| lifecycle | lifecycle_create_flow_draft | POST /esp-flows | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Save a local flow draft」案例。 |
| lifecycle | lifecycle_change_flow_status | POST /esp-flows/:id/status | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Change local review mode or require ESP capability」案例。 |
| lifecycle | lifecycle_get_health | GET /lifecycle/health | response_only | #338 |
| lifecycle | lifecycle_import_health | POST /lifecycle/health | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Import observed ESP delivery health counts」案例。 |
| lifecycle | lifecycle_create_frequency_rule | POST /lifecycle/frequency-rules | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Add an observed-send frequency cap」案例。 |
| lifecycle | lifecycle_import_send_observation | POST /lifecycle/send-observations | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Record an observed ESP send for frequency accounting」案例。 |
| lifecycle | lifecycle_request_customer_data | POST /customers/:id/erasure-requests | not_exercised | scope_excluded · 本回合未扩展客户生命周期和 ESP。该项需独立的「Open an export or erasure request」案例。 |
| analytics | metric_definitions_get | GET /metric-definitions | response_only | #339 |
| analytics | metric_definition_get | GET /metric-definitions/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read a metric definition and its revisions」案例。 |
| analytics | revise_metric_definition | POST /metric-definitions | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Create or revise a workspace metric definition」案例。 |
| analytics | analytics_record_observations | POST /metrics/observations | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Import normalized metric observations」案例。 |
| analytics | metrics_query | POST /metrics/query | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Query metrics with their coverage and evidence」案例。 |
| analytics | posts_performance_get | GET /performance/posts | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read per-post performance and comparable age buckets」案例。 |
| analytics | post_performance_history | GET /performance/posts/:id/history | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read the observation history of one post」案例。 |
| analytics | accounts_performance_get | GET /performance/accounts | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read account performance and trends」案例。 |
| analytics | links_performance_get | GET /performance/links | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read redirects, filtered clicks, and consented event counts」案例。 |
| analytics | reports_list | GET /reports | valid_empty | #340 · data.length=0 |
| analytics | reports_create | POST /reports | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Create a report definition」案例。 |
| analytics | report_definition_get | GET /reports/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read a report definition」案例。 |
| analytics | reports_update | PATCH /reports/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Edit a report definition」案例。 |
| analytics | report_versions_list | GET /reports/:id/versions | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「List frozen report snapshots」案例。 |
| analytics | reports_generate_version | POST /reports/:id/versions | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Queue generation of a frozen report draft」案例。 |
| analytics | reports_get | GET /report-versions/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read a frozen report snapshot」案例。 |
| analytics | report_provenance_get | GET /report-versions/:id/provenance | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Trace a frozen metric observation to its ingest evidence」案例。 |
| analytics | report_commerce_provenance_get | GET /report-versions/:id/commerce-provenance | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Trace a frozen commerce section to its original fact sources」案例。 |
| analytics | reports_update_narrative | PATCH /report-versions/:id/narrative | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Edit only a draft narrative」案例。 |
| analytics | reports_finalize | POST /report-versions/:id/finalize | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Finalize and lock a report snapshot」案例。 |
| analytics | reports_export | POST /report-versions/:id/export | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Export a finalized report snapshot」案例。 |
| analytics | reports_queue_export | POST /reports/:id/versions/:n/export | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Queue a file for this finalized report version」案例。 |
| analytics | report_exports_list | GET /reports/:id/versions/:n/exports | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「List exports of this report version」案例。 |
| analytics | report_templates_list | GET /report-templates | valid_empty | #341 · data.length=0 |
| analytics | report_templates_create | POST /report-templates | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Create a reusable report template」案例。 |
| analytics | reports_generate_due | POST /reports/scheduled/generate | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Generate drafts for due report schedules」案例。 |
| analytics | attribution_explain | GET /attribution/orders/:id/explain | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Explain one order’s attribution models and evidence」案例。 |
| analytics | attribution_query | POST /attribution/query | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Query each model’s credit and unattributed amounts separately」案例。 |
| analytics | attribution_models_get | GET /attribution-models | response_only | #342 · data.length=7 |
| analytics | attribution_models_revise | PATCH /attribution-models/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Create a new revision of a model window」案例。 |
| analytics | attribution_run | POST /attribution/runs | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Recompute order attribution from workspace evidence」案例。 |
| analytics | attribution_record_reported | POST /attribution/reported | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Import authorized provider-reported credits」案例。 |
| analytics | revenue_query | GET /revenue/daily | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read daily sales, refunds, and collection with coverage」案例。 |
| analytics | revenue_reconciliation_list | GET /revenue/reconciliation | valid_empty | #343 · data.length=0 |
| analytics | revenue_reconcile | POST /revenue/reconciliation | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Reconcile observed order totals against an authorized source total」案例。 |
| analytics | unit_costs_import | POST /unit-costs/import | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Import normalized unit costs」案例。 |
| analytics | contribution_record_inputs | POST /contribution/inputs | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Record normalized contribution evidence」案例。 |
| analytics | contribution_query | GET /contribution | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read estimated contribution and missing cost items」案例。 |
| analytics | cohorts_list | GET /cohorts | fixture_reference_observed | #344 · data.length=1 |
| analytics | cohort_get | GET /cohorts/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read one store’s first-purchase cohorts」案例。 |
| analytics | experiments_list | GET /experiments | valid_empty | #345 · data.length=0 |
| analytics | experiments_create | POST /experiments | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Register an experiment design」案例。 |
| analytics | experiment_get | GET /experiments/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read design and result snapshots」案例。 |
| analytics | experiment_update | PATCH /experiments/:id | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Edit an experiment before starting it」案例。 |
| analytics | experiment_stop | POST /experiments/:id/stop | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Transition an experiment to stop」案例。 |
| analytics | experiment_conclude | POST /experiments/:id/conclude | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Transition an experiment to conclude」案例。 |
| analytics | experiment_archive | POST /experiments/:id/archive | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Transition an experiment to archive」案例。 |
| analytics | experiment_record_result | POST /experiments/:id/results | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Store an immutable experiment evidence snapshot」案例。 |
| analytics | audience_insights_get | GET /audience-insights | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read audience snapshots by source」案例。 |
| analytics | audience_insights_record | POST /audience-insights | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Ingest normalized audience snapshots」案例。 |
| analytics | posting_time_get | GET /posting-time-recommendations | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Read saved posting-time recommendations」案例。 |
| analytics | posting_time_apply | POST /posting-time-recommendations/:id/apply | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Apply suggestions as planning slot templates」案例。 |
| analytics | posting_time_suggest | POST /posting-time-recommendations | not_exercised | scope_excluded · 本回合未扩展归因、报表和实验。该项需独立的「Calculate candidate publishing hours for comparable posts」案例。 |
| agent | agent_jobs_list | GET /agent-jobs | business_verified | #114 · data.length=1 |
| agent | agent_jobs_get | GET /agent-jobs/:id | business_verified | #118 |
| agent | agent_jobs_claim | POST /agent-jobs/:id/claim | business_verified | #115 |
| agent | agent_jobs_heartbeat | POST /agent-jobs/:id/heartbeat | business_verified | #116 |
| agent | agent_jobs_handoff | POST /agent-jobs/:id/handoff | not_exercised | scope_excluded · 本回合未扩展通用工作流治理。该项需独立的「handoff an Agent job」案例。 |
| agent | agent_jobs_submit_result | POST /agent-jobs/:id/submit | business_verified | #117 |
| agent | agent_jobs_confirm_cancel | POST /agent-jobs/:id/confirm-cancel | not_exercised | scope_excluded · 本回合未扩展通用工作流治理。该项需独立的「confirm-cancel an Agent job」案例。 |
| agent | jobs_get | GET /jobs/:id | not_exercised | scope_excluded · 本回合未扩展通用工作流治理。该项需独立的「Resume querying a durable operation」案例。 |
| agent | jobs_cancel | POST /jobs/:id/cancel | not_exercised | scope_excluded · 本回合未扩展通用工作流治理。该项需独立的「Request durable operation cancellation」案例。 |
| agent | change_sets_create | POST /change-sets | business_verified | #113 |
| agent | change_sets_get | GET /change-sets/:id | fixture_reference_observed | #346 |
| agent | workflow_templates_list | GET /workflow-templates | valid_empty | #347 · data.length=0 |
| agent | workflow_templates_get | GET /workflow-templates/:id | not_exercised | scope_excluded · 本回合未扩展通用工作流治理。该项需独立的「Read the current published workflow revision」案例。 |
| agent | agent_preview_context | GET /brands/:brandId/agent-context | fixture_reference_observed | #348 |
| agent | desktop_request_capability | POST /desktop-capability-requests | boundary_confirmed | #103 |
| agent | desktop_get_capability_request | GET /desktop-capability-requests/:id | boundary_confirmed | #104 |
| ops | ops_get_health | GET /admin/workspace-health | response_only | #349 |
| ops | audit_query | GET /admin/audit-events | valid_empty | #350 · data.length=0 |
| files | file_begin_upload | POST /files/uploads | business_verified | #12 |
| files | file_complete_upload | POST /files/uploads/:id/complete | business_verified | #13 |
| files | file_get | GET /files/:id | business_verified | #14 |
