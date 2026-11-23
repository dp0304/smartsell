# SmartSell 通用网关覆盖矩阵

每行来自本次 Agent 的实际发现。序号对应 [逐调用原始记录](calls.jsonl)，审计 ID 对应 [快照审计行](audit.json)。

| 模块 | 子操作 | 路由 | 结果 | 调用序号或未调原因 |
|---|---|---|---|---|
| workspace | views_home | GET /views/home | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_products_list | GET /views/products | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_product_get | GET /views/products/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| workspace | views_plans_list | GET /views/plans | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_plan_get | GET /views/plans/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| workspace | views_calendar | GET /views/calendar | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_social | GET /views/social | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_ads | GET /views/ads | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_decisions_list | GET /views/decisions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_decisions_summary | GET /views/decisions/summary | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_activity | GET /views/activity | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | views_agent_presence | GET /views/agent-presence | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | zhihu_stats_create | POST /zhihu-stats | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | zhihu_stats_get | GET /zhihu-stats/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| workspace | workspace_get | GET / | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | workspace_update | PATCH / | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_get_context | GET /context | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | workspace_brands_list | GET /brands | business_verified | #4 |
| workspace | workspace_brand_get | GET /brands/:id | business_verified | #3 |
| workspace | workspace_brand_create | POST /brands | response_only | #1, #2 |
| workspace | workspace_brand_update | PATCH /brands/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_brand_archive | POST /brands/:id/archive | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_markets_list | GET /brands/:id/markets | business_verified | #7 |
| workspace | workspace_market_get | GET /markets/:id | business_verified | #6 |
| workspace | workspace_market_create | POST /brands/:id/markets | response_only | #5 |
| workspace | workspace_market_update | PATCH /markets/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_get_today | GET /overview/today | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | workspace_get_summary | GET /overview/summary | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | tasks_list | GET /work-items | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | tasks_get | GET /work-items/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| workspace | tasks_create | POST /work-items | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | tasks_update | PATCH /work-items/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | tasks_batch | POST /work-items/batch | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | tasks_complete | POST /work-items/:id/complete | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | tasks_reopen | POST /work-items/:id/reopen | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | tasks_handover | POST /work-items/:id/handover | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | tasks_dependencies | PUT /work-items/:id/dependencies | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_get_personal_inbox | GET /me/inbox | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | notifications_list | GET /notifications | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | notifications_read | POST /notifications/read | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | notifications_archive | POST /notifications/archive | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | notifications_preferences_list | GET /me/notification-preferences | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | notifications_preferences_update | PUT /me/notification-preferences | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_subscriptions_list | GET /subscriptions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | workspace_subscriptions_create | POST /subscriptions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_subscriptions_remove | DELETE /subscriptions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_subscriptions_delete | DELETE /subscriptions/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | search_query | GET /search | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | workspace_saved_views_list | GET /saved-views | not_exercised | 缺少该视图的查询条件或业务断言。 |
| workspace | workspace_saved_views_create | POST /saved-views | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_saved_views_update | PATCH /saved-views/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_onboarding_get | GET /onboarding/:flow | not_exercised | 缺少 :flow 对应的可验证资源或查询条件。 |
| workspace | workspace_onboarding_check | POST /onboarding/:flow/steps/:step/check | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_onboarding_skip | POST /onboarding/:flow/steps/:step/skip | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| workspace | workspace_dashboard_get | GET /dashboards/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| workspace | workspace_dashboard_save | PUT /dashboards/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| account | account_list_social_accounts | GET /social-accounts | business_verified | #8 |
| account | account_get_social_account | GET /social-accounts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_update_social_account | PATCH /social-accounts/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| account | account_disable_social_account | POST /social-accounts/:id/disable | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| account | account_get_capabilities | GET /social-accounts/:id/capabilities | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_check_operation | GET /social-accounts/:id/operation-check | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_probe_capabilities | POST /social-accounts/:id/capabilities/probe | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| account | account_get_platform_catalog | GET /platform-catalog | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_list_platform_apps | GET /platform-apps | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_list_connections | GET /connections | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_get_store_capabilities | GET /connections/:id/capabilities | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_probe_store_capabilities | POST /connections/:id/capabilities/probe | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| account | account_list_connection_accounts | GET /connections/:id/accounts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_list_devices | GET /devices | business_verified | #51 |
| account | account_list_mobile_devices | GET /mobile-devices | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_list_mobile_app_bindings | GET /mobile-app-bindings | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_preview_mobile_app_unbind | GET /mobile-app-bindings/:id/impact | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_list_browser_sessions | GET /browser-sessions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_preview_binding_migration | GET /social-accounts/:id/execution-binding/migration/preview | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_get_binding_migration | GET /social-accounts/:id/execution-binding/migration | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_get_connector_auto_policy | GET /connector-auto-policy | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_list_account_blocks | GET /account-blocks | not_exercised | 缺少该视图的查询条件或业务断言。 |
| account | account_assign_account_block | PATCH /account-blocks/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | data_source_list | GET /data-sources | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | data_source_get | GET /data-sources/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | data_source_create | POST /data-sources | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | data_source_update | PATCH /data-sources/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | data_source_pause | POST /data-sources/:id/pause | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | import_template_list | GET /import-templates | business_verified | #40 |
| ingest | import_list | GET /imports | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | import_create | POST /imports | response_only | #41 |
| ingest | import_get | GET /imports/:id | business_verified | #45 |
| ingest | import_preview | PATCH /imports/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | import_rows | GET /imports/:id/rows | business_verified | #43 |
| ingest | import_error_file | GET /imports/:id/error-file | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | import_confirm | POST /imports/:id/confirm | response_only | #44 |
| ingest | import_cancel | POST /imports/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | import_mapping_preset_list | GET /import-mapping-presets | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | import_mapping_preset_create | POST /import-mapping-presets | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | sync_refresh | POST /data-sources/:id/refresh | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | sync_reconcile | POST /data-sources/:id/reconcile | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | data_source_coverage | GET /data-sources/:id/coverage | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | sync_run_list | GET /sync-runs | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | sync_run_get | GET /sync-runs/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | sync_run_retry | POST /sync-runs/:id/retry | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | sync_schedule_list | GET /sync-schedules | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | sync_schedule_create | POST /sync-schedules | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | sync_schedule_update | PATCH /sync-schedules/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | backfill_plan | POST /backfills | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | backfill_list | GET /backfills | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | backfill_get | GET /backfills/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | backfill_resume | POST /backfills/:id/resume | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | data_gap_list | GET /data-gaps | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | data_gap_backfill | POST /data-gaps/:id/backfill | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | webhook_delivery_list | GET /webhook-deliveries | not_exercised | 需要逐项核实连接、外部副作用与执行授权。本轮没有第三方测试连接。 |
| ingest | data_health_get | GET /data-health | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | data_quality_issue_list | GET /data-quality/issues | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | data_quality_issue_update | PATCH /data-quality/issues/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ingest | vendor_usage_list | GET /vendor-usage | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | collection_budget_list | GET /collection-budgets | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | data_provenance_get | GET /provenance | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ingest | raw_record_get | GET /raw-records/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_store_list | GET /stores | business_verified | #31 |
| commerce | commerce_store_create | POST /stores | response_only | #30 |
| commerce | commerce_store_get | GET /stores/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_store_update | PATCH /stores/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_store_sync | POST /stores/:id/sync | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_store_import | POST /stores/:id/imports | response_only | #42 |
| commerce | commerce_store_market_list | GET /stores/:id/markets | business_verified | #33 |
| commerce | commerce_store_market_configure | PUT /stores/:id/markets | response_only | #32 |
| commerce | catalog_search | GET /products | business_verified | #39 |
| commerce | commerce_product_create | POST /products | response_only | #34 |
| commerce | catalog_get_product | GET /products/:id | business_verified | #38 |
| commerce | commerce_product_update | PATCH /products/:id | response_only | #35 |
| commerce | commerce_product_usage | GET /products/:id/usage | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_variant_create | POST /products/:id/variants | response_only | #36 |
| commerce | commerce_variant_update | PATCH /variants/:id | response_only | #37 |
| commerce | market_snapshot | GET /variants/:id/listings | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_record_listing | POST /variants/:id/listings | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_variant_group_suggest | GET /variant-groups/suggestions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_variant_group_list | GET /variant-groups | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_variant_group_create | POST /variant-groups | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_variant_group_member_list | GET /variant-groups/:id/members | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_variant_group_link | POST /variant-groups/:id/members | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_variant_group_link_batch | POST /variant-groups/:id/members/batch | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_variant_group_unlink | DELETE /variant-groups/:id/members/:memberId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | catalog_list_facts | GET /products/:id/facts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | catalog_propose_fact | POST /products/:id/facts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_fact_revise | POST /facts/:id/revisions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_localization_list | GET /products/:id/localizations | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | catalog_update_localization | PUT /products/:id/localizations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_localization_submit | POST /localizations/:id/submit | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_list_changes | GET /change-events | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_change_acknowledge | POST /change-events/:id/acknowledge | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_change_resolve | POST /change-events/:id/resolve | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_change_dismiss | POST /change-events/:id/dismiss | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_promotion_list | GET /promotions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_promotion_create | POST /promotions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | promotion_get | GET /promotions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_promotion_update | PATCH /promotions/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_promotion_cancel | DELETE /promotions/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| commerce | commerce_localization_export | GET /localizations/:id/export | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_order_list | GET /orders | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_order_get | GET /orders/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_refund_list | GET /refunds | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | orders_summary | GET /orders/summary | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_inventory_rule_list | GET /inventory-rules | not_exercised | 缺少该视图的查询条件或业务断言。 |
| commerce | commerce_inventory_rule_create | POST /inventory-rules | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_list | GET /campaigns | not_exercised | 缺少该视图的查询条件或业务断言。 |
| campaign | campaign_create_draft | POST /campaigns | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_update | PATCH /campaigns/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_transition | POST /campaigns/:id/transition | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_set_markets | PUT /campaigns/:id/markets | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_set_products | PUT /campaigns/:id/products | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_goal_list | GET /campaigns/:id/goals | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_goal_create | POST /campaigns/:id/goals | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_goal_get | GET /campaigns/:id/goals/:goalId | not_exercised | 缺少 :id、:goalId 对应的可验证资源或查询条件。 |
| campaign | campaign_goal_update | PATCH /campaigns/:id/goals/:goalId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_goal_withdraw | DELETE /campaigns/:id/goals/:goalId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_plan_slot_list | GET /campaigns/:id/plan-slots | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_plan_slot_create | POST /campaigns/:id/plan-slots | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_plan_slot_get | GET /campaigns/:id/plan-slots/:slotId | not_exercised | 缺少 :id、:slotId 对应的可验证资源或查询条件。 |
| campaign | campaign_plan_slot_update | PATCH /campaigns/:id/plan-slots/:slotId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_plan_slot_delete | DELETE /campaigns/:id/plan-slots/:slotId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_brief_list | GET /campaigns/:id/briefs | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_brief_create | POST /campaigns/:id/briefs | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | brief_revision_list | GET /briefs/:id/revisions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | brief_update_draft | POST /briefs/:id/revisions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | brief_revision_submit | POST /brief-revisions/:id/submit | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_budget_line_list | GET /campaigns/:id/budget-lines | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_budget_line_get | GET /campaigns/:id/budget-lines/:budgetLineId | not_exercised | 缺少 :id、:budgetLineId 对应的可验证资源或查询条件。 |
| campaign | campaign_budget_line_create | POST /campaigns/:id/budget-lines | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_budget_line_update | PATCH /campaigns/:id/budget-lines/:budgetLineId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_budget_line_delete | DELETE /campaigns/:id/budget-lines/:budgetLineId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_cost_commitment_list | GET /campaigns/:id/cost-commitments | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_cost_commitment_get | GET /campaigns/:id/cost-commitments/:commitmentId | not_exercised | 缺少 :id、:commitmentId 对应的可验证资源或查询条件。 |
| campaign | campaign_cost_commitment_create | POST /campaigns/:id/cost-commitments | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_cost_commitment_update | PATCH /campaigns/:id/cost-commitments/:commitmentId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_cost_commitment_delete | DELETE /campaigns/:id/cost-commitments/:commitmentId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_cost_entry_list | GET /campaigns/:id/cost-entries | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_cost_entry_get | GET /campaigns/:id/cost-entries/:entryId | not_exercised | 缺少 :id、:entryId 对应的可验证资源或查询条件。 |
| campaign | campaign_cost_entry_create | POST /campaigns/:id/cost-entries | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_cost_entry_update | PATCH /campaigns/:id/cost-entries/:entryId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_cost_entry_delete | DELETE /campaigns/:id/cost-entries/:entryId | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_budget_summary | GET /campaigns/:id/budget-summary | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_budget_benchmarks | GET /campaigns/:id/budget-benchmarks | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_budget_reallocation_request | POST /campaigns/:id/budget-reallocations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_budget_approval_list | GET /campaigns/:id/budget-approvals | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_get_context | GET /campaigns/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_matrix | GET /campaigns/:id/matrix | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_create_gap_items | POST /campaigns/:id/matrix/gaps/create-items | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_milestone_list | GET /campaigns/:id/milestones | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_milestone_create | POST /campaigns/:id/milestones | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_create_tasks | POST /campaigns/:id/tasks | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_tracking_summary | GET /campaigns/:id/tracking-summary | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_link_list | GET /campaigns/:id/links | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_link_create | POST /campaigns/:id/links | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_attribution_compare | GET /campaigns/:id/attribution | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_tracking_get | GET /campaigns/:id/tracking-config | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_tracking_set | PUT /campaigns/:id/tracking-config | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_closeout_get | GET /campaigns/:id/closeout | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_historical_baselines | GET /campaigns/:id/historical-baselines | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_closeout_draft | POST /campaigns/:id/closeout/draft | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_report_list | GET /campaigns/:id/reports | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_report_backfill | POST /campaigns/:id/reports/:reportId/backfill | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_template_derive | POST /campaigns/:id/templates | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_template_list | GET /campaign-templates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| campaign | campaign_template_get | GET /campaign-templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_template_create | POST /campaign-templates | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_template_update | PATCH /campaign-templates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_template_delete | DELETE /campaign-templates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| campaign | campaign_template_instantiate | POST /campaign-templates/:id/instantiate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | watch_targets_list | GET /watch-targets | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | watch_target_create | POST /watch-targets | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | watch_target_get | GET /watch-targets/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | watch_target_update | PATCH /watch-targets/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | observations_list | GET /watch-targets/:id/observations | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | observation_record | POST /observations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | research_boards_list | GET /research-boards | business_verified | #49 |
| intel | research_board_create | POST /research-boards | response_only | #46 |
| intel | research_board_get | GET /research-boards/:id | business_verified | #48 |
| intel | research_board_update | PATCH /research-boards/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | research_add_item | POST /research-boards/:id/items | response_only | #47 |
| intel | research_create_note | POST /research-boards/:id/notes | response_only | #50 |
| intel | research_item_update | PATCH /research-items/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | research_item_delete | DELETE /research-items/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | research_item_convert | POST /research-items/:id/convert | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | research_search | GET /research/search | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | research_item_evidence | GET /research-items/:id/evidence | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | creative_references_list | GET /creative-references | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | creative_reference_create | POST /creative-references | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | creative_reference_annotate | PATCH /creative-references/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | product_candidates_list | GET /product-candidates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | product_candidate_create | POST /product-candidates | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | product_candidate_get | GET /product-candidates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | product_candidate_update | PATCH /product-candidates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | product_candidates_score | POST /product-candidates/:id/scores | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | observations_compare | GET /research/compare | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | research_topics_list | GET /topics | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | research_topic_create | POST /topics | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | research_topic_trend | GET /topics/:id/trend | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | alert_rules_list | GET /alert-rules | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | alert_rule_create | POST /alert-rules | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | alert_rule_update | PATCH /alert-rules/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | alerts_list | GET /alerts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | alerts_evaluate | POST /alerts/evaluate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | alert_update | PATCH /alerts/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | mentions_query | GET /mentions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | mention_record | POST /mentions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | mention_labels_list | GET /mentions/:id/labels | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | mention_label_update | PATCH /mentions/:id/labels | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | mention_escalate | POST /mentions/:id/escalate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| intel | share_of_voice_get | GET /share-of-voice | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_list_pillars | GET /content-pillars | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_create_pillar | POST /content-pillars | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_get_pillar | GET /content-pillars/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_update_pillar | PATCH /content-pillars/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_archive_pillar | DELETE /content-pillars/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | idea_list | GET /ideas | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | idea_create | POST /ideas | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | idea_create_from_conversation | POST /ideas/from-conversation | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | idea_get | GET /ideas/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | idea_update | PATCH /ideas/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | idea_convert | POST /ideas/:id/convert | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_list | GET /content-items | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_production_workload | GET /content-items/workload | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_create_item | POST /content-items | response_only | #17 |
| content | content_create_draft | POST /content-items/draft | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_get | GET /content-items/:id | business_verified | #22 |
| content | content_item_update | PATCH /content-items/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_set_stage | POST /content-items/:id/stage | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_create_variant | POST /content-items/:id/variants | response_only | #18 |
| content | content_export_item | GET /content-items/:id/export | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_duplicate | POST /content-items/:id/duplicate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_record_handoff_checklist | POST /content-items/:id/handoff-checklist | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_list_stale | GET /content-variants/stale | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_batch_variants | POST /content-variants/batch | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_get_variant | GET /content-variants/:id | business_verified | #21 |
| content | content_list_product_facts | GET /content-variants/:id/product-facts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_insert_product_fact | POST /content-variants/:id/product-facts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_list_product_prices | GET /content-variants/:id/product-prices | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_insert_product_price | POST /content-variants/:id/product-prices | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_autosave_variant | PATCH /content-variants/:id | response_only | #19 |
| content | content_request_rendition | POST /content-variants/:id/renditions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_update_variant | POST /content-variants/:id/agent-edit | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_commit_revision | POST /content-variants/:id/revisions | response_only | #20 |
| content | content_list_revisions | GET /content-variants/:id/revisions | business_verified | #23 |
| content | content_get_revision | GET /content-revisions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_diff_revisions | GET /content-revisions/:a/diff/:b | not_exercised | 缺少 :a、:b 对应的可验证资源或查询条件。 |
| content | content_restore_revision | POST /content-revisions/:id/restore | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_validate_variant | POST /content-variants/:id/validate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_set_readiness | POST /content-variants/:id/readiness | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_list_translations | GET /content-variants/:id/translations | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_create_translation | POST /content-variants/:id/translations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_accept_source_change | POST /translation-links/:id/accept-source-change | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_mark_divergence | POST /translation-links/:id/mark-divergence | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_list_feeds | GET /feeds | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_create_feed | POST /feeds | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_get_feed | GET /feeds/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_update_feed | PATCH /feeds/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_archive_feed | DELETE /feeds/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_poll_feed | POST /feeds/:id/poll | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_preview_feed_import | POST /feeds/:id/preview-import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_list_feed_items | GET /feeds/:id/items | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_import_feed_item | POST /feed-items/:id/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_request_post_maintenance | POST /platform-posts/:id/maintenance | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_get_transcript | GET /content-transcripts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_review_transcript | PATCH /content-transcripts/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| content | content_request_transcript | POST /content-transcripts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_list_submission_boxes | GET /submission-boxes | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | asset_get_submission_box | GET /submission-boxes/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | asset_list_external_sources | GET /external-sources | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | asset_begin_upload | POST /assets/uploads | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_search | GET /assets | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | asset_create | POST /assets | response_only | #13 |
| asset | asset_find_duplicates | GET /assets/:id/duplicates | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | asset_get | GET /assets/:id | business_verified | #14 |
| asset | asset_update | PATCH /assets/:id | response_only | #16 |
| asset | asset_set_favorite | POST /assets/:id/favorite | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_download_version | GET /asset-versions/:id/download | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | asset_list_versions | GET /assets/:id/versions | business_verified | #15 |
| asset | asset_add_version | POST /assets/:id/versions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_usage | GET /assets/:id/usage | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | asset_request_rendition | POST /asset-versions/:id/renditions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_request_rendition_batch | POST /asset-versions/:id/rendition-batch | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_retry_rendition | POST /renditions/:id/retry | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_get_rendition | GET /renditions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | asset_archive | POST /assets/:id/archive | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_list_folders | GET /asset-folders | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | asset_get_folder | GET /asset-folders/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | rights_list | GET /rights-grants | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | rights_list_impacts | GET /rights-impacts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | rights_get | GET /rights-grants/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | rights_create_draft | POST /rights-grants | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | rights_revise | POST /rights-grants/:id/revisions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | asset_check_usage | POST /rights/check | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | knowledge_list | GET /knowledge | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | knowledge_import | POST /knowledge/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | knowledge_get | GET /knowledge/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | knowledge_propose | POST /knowledge | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | knowledge_revise | POST /knowledge/:id/revisions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | knowledge_get_context | GET /brands/:brandId/context | not_exercised | 缺少 :brandId 对应的可验证资源或查询条件。 |
| asset | template_list | GET /templates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| asset | template_get | GET /templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | template_create | POST /templates | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | template_update | PATCH /templates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | template_archive | DELETE /templates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| asset | template_render | POST /templates/:id/render | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_get_calendar | GET /calendar | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_list_targets | GET /publish-targets | business_verified | #29 |
| planning | publishing_get_target | GET /publish-targets/:id | business_verified | #28 |
| planning | publishing_create_target | POST /publish-targets | response_only | #24 |
| planning | publishing_update_target | PATCH /publish-targets/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_request_approval | POST /publish-targets/:id/submit | response_only | #26 |
| planning | publishing_run_precheck | POST /publish-targets/:id/precheck | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_reschedule | POST /publish-targets/:id/reschedule | response_only | #25 |
| planning | publishing_cancel | POST /publish-targets/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_list_approvals | GET /approvals | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_create_plan | POST /publish-plans | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_update_plan | PATCH /publish-plans/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_preview_plan_items | POST /publish-plans/preview | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_preview_plan | POST /publish-plans/:id/preview | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_schedule | POST /publish-plans/:id/commit | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_get_plan | GET /publish-plans/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_pauses | GET /pause-switches | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_get_pause | GET /pause-switches/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_pause | POST /pause-switches | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| planning | publishing_list_slot_templates | GET /slot-templates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_get_slot_template | GET /slot-templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_schedule_rules | GET /schedule-rules | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_get_schedule_rule | GET /schedule-rules/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_evergreen_queues | GET /evergreen-queues | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_get_evergreen_queue | GET /evergreen-queues/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_evergreen_items | GET /evergreen-queues/:id/items | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_review_rounds | GET /review-rounds | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_get_review_round | GET /review-rounds/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_post_matches | GET /reconciliation/candidates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| planning | publishing_suggest_post_match | GET /reconciliation/suggestions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_suggest_evergreen_order | GET /evergreen-queues/:id/suggestions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_suggest_slots | GET /slot-suggestions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| execution | publishing_list_execution | GET /execution-tasks | not_exercised | 缺少该视图的查询条件或业务断言。 |
| execution | publishing_get_execution | GET /execution-tasks/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| execution | publishing_list_exceptions | GET /execution-exceptions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| execution | publishing_run_now | POST /execution-tasks/:id/run-now | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| execution | publishing_retry | POST /execution-tasks/:id/retry | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| execution | publishing_reconcile | POST /execution-tasks/:id/reconcile | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| execution | execution_cancel_task | POST /execution-tasks/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| execution | posts_list | GET /platform-posts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| execution | posts_get | GET /platform-posts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| execution | posts_register_manual | POST /platform-posts/register | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| execution | publishing_preview_execution_batch | POST /execution-batches/preview | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| execution | publishing_apply_execution_batch | POST /execution-batches/:id/apply | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list | GET /conversations | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_conversation | GET /conversations/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_ingest_batch | POST /inbox/ingest | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_update_conversation | PATCH /conversations/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_batch_conversations | POST /conversations/batch | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_mark_read | POST /conversations/:id/read | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_claim | POST /conversations/:id/occupancy | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_release | DELETE /conversations/:id/occupancy | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_add_note | POST /conversations/:id/notes | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_draft_reply | POST /conversations/:id/reply-drafts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_update_reply_draft | PATCH /reply-drafts/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_submit_reply_approval | POST /reply-drafts/:id/submit-approval | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_send_reply | POST /reply-drafts/:id/send | not_exercised | 需要逐项核实连接、外部副作用与执行授权。本轮没有第三方测试连接。 |
| inbox | inbox_get_reply_status | GET /outbound-replies/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_reconcile_reply | POST /outbound-replies/:id/reconcile | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_manual_complete_reply | POST /outbound-replies/:id/manual-complete | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_cancel_reply | POST /outbound-replies/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_create_sla_policy | POST /inbox/sla-policies | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_update_sla_policy | PATCH /inbox/sla-policies/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_sla_tick | POST /inbox/sla-policies/tick | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_unsnooze | POST /inbox/unsnooze | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_evaluate_auto_rules | POST /inbox/messages/:id/evaluate-rules | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_coverage | GET /inbox/coverage | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_sla_sample | GET /inbox/sla-sample | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_participant_link | GET /conversations/:id/customer-link | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_list_moderation | GET /conversations/:id/moderation | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_record_manual_moderation | POST /conversations/:id/moderation | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_set_local_comment_access | PUT /inbox/local-comment-access | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_read_comment_state | POST /conversations/:id/moderation/readback | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_cases | GET /cases | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_case | GET /cases/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_create_case | POST /cases | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_handoff_case | POST /cases/:id/handoff | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_update_case | PATCH /cases/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_record_translation | POST /messages/:id/translations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_translations | GET /messages/:id/translations | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_list_review_sources | GET /inbox/review-sources | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_register_review_source | POST /inbox/review-sources | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_import_review | POST /inbox/review-sources/:id/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_reviews | GET /reviews | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_review_summary | GET /inbox/review-summary | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_handoff_review | POST /reviews/:id/handoff | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_get_review | GET /reviews/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_verify_review_reply | POST /reviews/:id/verify-reply | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_link_participant | POST /inbox/participants/:id/link-customer | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_unlink_participant | DELETE /inbox/participants/:id/link-customer | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_update_note | PATCH /notes/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_delete_note | DELETE /notes/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_business_hours | GET /inbox/business-hours | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_business_hours | GET /inbox/business-hours/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_archive_business_hours | DELETE /inbox/business-hours/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_sla_policies | GET /inbox/sla-policies | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_sla_policy | GET /inbox/sla-policies/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_archive_sla_policy | DELETE /inbox/sla-policies/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_auto_rules | GET /inbox/auto-rules | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_auto_rule | GET /inbox/auto-rules/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_archive_auto_rule | DELETE /inbox/auto-rules/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_create_business_hours | POST /inbox/business-hours | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_update_business_hours | PATCH /inbox/business-hours/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_create_auto_rule | POST /inbox/auto-rules | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_enable_auto_rule | PATCH /inbox/auto-rules/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| inbox | inbox_list_auto_rule_runs | GET /inbox/auto-rules/:id/runs | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_list_auto_reply_review | GET /inbox/auto-reply-review | not_exercised | 缺少该视图的查询条件或业务断言。 |
| inbox | inbox_get_reply_draft | GET /reply-drafts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_get_conversation_sla | GET /conversations/:id/sla | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_search | GET /creators | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | creators_get | GET /creators/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_create | POST /creators | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_update | PATCH /creators/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_record_audience | POST /creators/:id/audience-observations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_list_contacts | GET /creators/:id/contacts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_import_contacts | POST /creators/:id/contacts/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_list_associations | GET /creators/:id/associations | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_associate_profiles | POST /creators/:id/associations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_revoke_association | POST /creator-associations/:id/revoke | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_link_account | POST /creators/:id/accounts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_verify_account | POST /creator-accounts/:id/verify | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | collaborations_list | GET /collaborations | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | collaborations_get | GET /collaborations/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | collaborations_create | POST /collaborations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | collaborations_update | PATCH /collaborations/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | outreach_draft | POST /collaborations/:id/outreach | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | outreach_record_sent | POST /outreach/:id/record-sent | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | outreach_record_reply | POST /collaborations/:id/outreach/reply | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | collaborations_create_terms | POST /collaborations/:id/terms | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | collaborations_send_terms | POST /terms/:id/send | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | deliverables_create | POST /collaborations/:id/deliverables | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | deliverables_list | GET /collaborations/:id/deliverables | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | deliverables_get | GET /deliverables/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | deliverables_change_deadline | PATCH /deliverables/:id/deadline | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | deliverables_list_missing | GET /deliverables/missing | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | deliverables_submit | POST /deliverables/:id/versions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | deliverables_link_rights | POST /deliverables/:id/link-rights | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_assign_affiliate | POST /collaborations/:id/affiliate-assignments | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_list_shipments | GET /sample-shipments | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | creators_create_shipment | POST /sample-shipments | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_update_shipment | PATCH /sample-shipments/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_list_live_sessions | GET /live-sessions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | creators_get_live_session | GET /live-sessions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_plan_live_session | POST /live-sessions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_update_live_session | PATCH /live-sessions/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_plan_clip_reuse | POST /live-sessions/:id/clip-reuse | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_list_evaluations | GET /campaigns/:id/creator-evaluations | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_evaluate | POST /campaigns/:id/creator-evaluations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | creators_override_evaluation | POST /creator-evaluations/:id/overrides | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_list | GET /commission-entries | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | commissions_reconcile_attribution | GET /collaborations/:id/attribution-reconciliation | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | commissions_accrue | POST /commission-entries | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_import | POST /commission-entries/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_mature | POST /commission-entries/mature | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_reverse | POST /commission-entries/:id/reverse | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_record_platform_settlement | POST /commission-entries/:id/platform-settlement | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_list_batches | GET /settlement-batches | not_exercised | 缺少该视图的查询条件或业务断言。 |
| creator | commissions_create_batch | POST /settlement-batches | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| creator | commissions_batch_cancel | POST /settlement-batches/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_list | GET /short-links | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | links_create | POST /short-links | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_get | GET /short-links/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | links_update | PATCH /short-links/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_change_destination | POST /short-links/:id/destination | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_get_stats | GET /short-links/:id/stats | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | links_batch | POST /short-links/batch | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_allowlist_list | GET /redirect-allowlist | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | links_domains_list | GET /link-domains | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | utm_list | GET /utm-templates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | utm_create | POST /utm-templates | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | utm_update | PATCH /utm-templates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | utm_remove | DELETE /utm-templates/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | utm_build | POST /utm-templates/preview | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_destinations_list | GET /landing-destinations | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | links_destination_create | POST /landing-destinations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_destination_update | PATCH /landing-destinations/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | pages_list | GET /landing-pages | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | pages_create_draft | POST /landing-pages | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | pages_versions | GET /landing-pages/:id/versions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | pages_create_version | POST /landing-pages/:id/versions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | pages_unpublish | POST /landing-pages/:id/unpublish | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_list_checks | GET /page-checks | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | links_probe | POST /page-checks/probe | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | links_check | POST /page-checks | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | bio_list | GET /bio-pages | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | bio_create | POST /bio-pages | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | bio_publish | POST /bio-pages/:id/publish | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | bio_items | GET /bio-pages/:id/items | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | pages_experiment_report | GET /landing-pages/:id/experiment | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | forms_list | GET /forms | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | forms_create | POST /forms | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | forms_versions | GET /forms/:id/versions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | forms_create_version | POST /forms/:id/versions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | forms_deactivate | POST /forms/:id/deactivate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | leads_list | GET /leads | not_exercised | 缺少该视图的查询条件或业务断言。 |
| traffic | leads_get | GET /leads/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | leads_update | PATCH /leads/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | leads_handoff | POST /leads/:id/handoff | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | leads_record_handoff_receipt | POST /leads/:id/handoff/receipt | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| traffic | leads_export | POST /leads/export | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_list_accounts | GET /ad-accounts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_register_account | POST /ad-accounts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_update_account | PATCH /ad-accounts/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_import_report | POST /ad-accounts/:id/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_list_entities | GET /ad-entities | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_query_performance | GET /ads/performance | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_list_creatives | GET /ad-creatives | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_create_creative | POST /ad-creatives | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_list_creative_variants | GET /ad-creatives/:id/variants | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ads | ads_create_creative_variant | POST /ad-creatives/:id/variants | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_archive_creative | DELETE /ad-creatives/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_list_proposals | GET /ad-proposals | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_create_proposal | POST /ad-proposals | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_get_proposal | GET /ad-proposals/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ads | ads_revise_proposal | POST /ad-proposals/:id/revisions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_submit_proposal | POST /ad-proposals/:id/submit-approval | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_export_proposal | POST /ad-proposals/:id/export | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_record_manual_operation | POST /ad-proposals/:id/manual-operations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| ads | ads_get_operation | GET /ad-operations/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ads | ads_list_adjustments | GET /adjustment-suggestions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_suggest_adjustments | POST /adjustment-suggestions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_set_local_esp | PUT /esp-accounts/:id/local-config | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_sync_local_esp_suppressions | POST /esp-accounts/:id/sync-suppressions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_reconcile_local_esp | POST /esp-campaigns/:id/local-reconcile | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_list_esp_attempts | GET /esp-campaigns/:id/attempts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_read_local_esp_flow | POST /esp-flows/:id/local-readback | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | customers_list | GET /customers | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | customers_create | POST /customers | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | customers_get | GET /customers/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | customers_link_identity | POST /customers/:id/identities | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | customers_unlink_identity | DELETE /customer-identities/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | customers_merge | POST /customers/merge | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | customers_revert_merge | POST /customer-merges/:id/revert | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | customers_get_consents | GET /customers/:id/consents | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_record_consent | POST /customers/:id/consents | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_list_consent_conflicts | GET /consent-conflicts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | lifecycle_list_consent_texts | GET /consent-texts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | lifecycle_get_consent_text | GET /consent-texts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_create_consent_text | POST /consent-texts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_record_suppression | POST /lifecycle/suppressions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | segments_list | GET /segments | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | segments_get | GET /segments/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | segments_create | POST /segments | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | segments_create_version | POST /segments/:id/versions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | segments_preview | POST /segments/:id/preview | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | segments_list_snapshots | GET /segments/:id/snapshots | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_list_esp_accounts | GET /esp-accounts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | lifecycle_create_esp_account | POST /esp-accounts | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_list_campaigns | GET /esp-campaigns | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | lifecycle_create_campaign_draft | POST /esp-campaigns | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_get_campaign | GET /esp-campaigns/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_import_campaign_send | POST /esp-campaigns/:id/send-observation | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_export_campaign | POST /esp-campaigns/:id/export | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_cancel_campaign | POST /esp-campaigns/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_list_flows | GET /esp-flows | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | lifecycle_create_flow_draft | POST /esp-flows | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_change_flow_status | POST /esp-flows/:id/status | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_get_health | GET /lifecycle/health | not_exercised | 缺少该视图的查询条件或业务断言。 |
| lifecycle | lifecycle_import_health | POST /lifecycle/health | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_create_frequency_rule | POST /lifecycle/frequency-rules | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_import_send_observation | POST /lifecycle/send-observations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| lifecycle | lifecycle_request_customer_data | POST /customers/:id/erasure-requests | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | metric_definitions_get | GET /metric-definitions | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | metric_definition_get | GET /metric-definitions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | revise_metric_definition | POST /metric-definitions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | analytics_record_observations | POST /metrics/observations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | metrics_query | POST /metrics/query | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | posts_performance_get | GET /performance/posts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | post_performance_history | GET /performance/posts/:id/history | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | accounts_performance_get | GET /performance/accounts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | links_performance_get | GET /performance/links | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | reports_list | GET /reports | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | reports_create | POST /reports | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | report_definition_get | GET /reports/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | reports_update | PATCH /reports/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | report_versions_list | GET /reports/:id/versions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | reports_generate_version | POST /reports/:id/versions | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | reports_get | GET /report-versions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | report_provenance_get | GET /report-versions/:id/provenance | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | report_commerce_provenance_get | GET /report-versions/:id/commerce-provenance | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | reports_update_narrative | PATCH /report-versions/:id/narrative | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | reports_finalize | POST /report-versions/:id/finalize | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | reports_export | POST /report-versions/:id/export | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | reports_queue_export | POST /reports/:id/versions/:n/export | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | report_exports_list | GET /reports/:id/versions/:n/exports | not_exercised | 缺少 :id、:n 对应的可验证资源或查询条件。 |
| analytics | report_templates_list | GET /report-templates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | report_templates_create | POST /report-templates | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | reports_generate_due | POST /reports/scheduled/generate | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | attribution_explain | GET /attribution/orders/:id/explain | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | attribution_query | POST /attribution/query | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | attribution_models_get | GET /attribution-models | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | attribution_models_revise | PATCH /attribution-models/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | attribution_run | POST /attribution/runs | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | attribution_record_reported | POST /attribution/reported | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | revenue_query | GET /revenue/daily | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | revenue_reconciliation_list | GET /revenue/reconciliation | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | revenue_reconcile | POST /revenue/reconciliation | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | unit_costs_import | POST /unit-costs/import | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | contribution_record_inputs | POST /contribution/inputs | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | contribution_query | GET /contribution | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | cohorts_list | GET /cohorts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | cohort_get | GET /cohorts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | experiments_list | GET /experiments | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | experiments_create | POST /experiments | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | experiment_get | GET /experiments/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | experiment_update | PATCH /experiments/:id | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | experiment_stop | POST /experiments/:id/stop | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | experiment_conclude | POST /experiments/:id/conclude | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | experiment_archive | POST /experiments/:id/archive | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | experiment_record_result | POST /experiments/:id/results | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | audience_insights_get | GET /audience-insights | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | audience_insights_record | POST /audience-insights | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | posting_time_get | GET /posting-time-recommendations | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | posting_time_apply | POST /posting-time-recommendations/:id/apply | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| analytics | posting_time_suggest | POST /posting-time-recommendations | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | agent_jobs_list | GET /agent-jobs | not_exercised | 缺少该视图的查询条件或业务断言。 |
| agent | agent_jobs_get | GET /agent-jobs/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| agent | agent_jobs_claim | POST /agent-jobs/:id/claim | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | agent_jobs_heartbeat | POST /agent-jobs/:id/heartbeat | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | agent_jobs_handoff | POST /agent-jobs/:id/handoff | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | agent_jobs_submit_result | POST /agent-jobs/:id/submit | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | agent_jobs_confirm_cancel | POST /agent-jobs/:id/confirm-cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | jobs_get | GET /jobs/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| agent | jobs_cancel | POST /jobs/:id/cancel | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | change_sets_create | POST /change-sets | not_exercised | 缺少该写入的有效请求、依赖状态及结果断言。 |
| agent | change_sets_get | GET /change-sets/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| agent | workflow_templates_list | GET /workflow-templates | not_exercised | 缺少该视图的查询条件或业务断言。 |
| agent | workflow_templates_get | GET /workflow-templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| agent | agent_preview_context | GET /brands/:brandId/agent-context | not_exercised | 缺少 :brandId 对应的可验证资源或查询条件。 |
| agent | desktop_request_capability | POST /desktop-capability-requests | boundary_confirmed | #52 |
| agent | desktop_get_capability_request | GET /desktop-capability-requests/:id | boundary_confirmed | #53 |
| ops | ops_get_health | GET /admin/workspace-health | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ops | audit_query | GET /admin/audit-events | not_exercised | 缺少该视图的查询条件或业务断言。 |
| files | file_begin_upload | POST /files/uploads | response_only | #9 |
| files | file_complete_upload | POST /files/uploads/:id/complete | response_only | #10 |
| files | file_get | GET /files/:id | business_verified | #11 |
