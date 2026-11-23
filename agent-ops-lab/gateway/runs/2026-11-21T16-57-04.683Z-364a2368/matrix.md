# SmartSell 通用网关覆盖矩阵

每行来自本次 Agent 的实际发现。序号对应 [逐调用原始记录](calls.jsonl)，审计 ID 对应 [快照审计行](audit.json)。

| 模块 | 子操作 | 路由 | 结果 | 调用序号或未调原因 |
|---|---|---|---|---|
| workspace | views_home | GET /views/home | fixture_reference_observed | #117 |
| workspace | views_products_list | GET /views/products | fixture_reference_observed | #118 |
| workspace | views_product_get | GET /views/products/:id | fixture_reference_observed | #119 |
| workspace | views_plans_list | GET /views/plans | fixture_reference_observed | #120 |
| workspace | views_plan_get | GET /views/plans/:id | fixture_reference_observed | #121 |
| workspace | views_calendar | GET /views/calendar | fixture_reference_observed | #122 |
| workspace | views_social | GET /views/social | fixture_reference_observed | #123 |
| workspace | views_ads | GET /views/ads | fixture_reference_observed | #124 |
| workspace | views_decisions_list | GET /views/decisions | fixture_reference_observed | #125 |
| workspace | views_decisions_summary | GET /views/decisions/summary | response_only | #126 |
| workspace | views_activity | GET /views/activity | fixture_reference_observed | #127 |
| workspace | views_agent_presence | GET /views/agent-presence | response_only | #128 |
| workspace | zhihu_stats_create | POST /zhihu-stats | business_verified | #62 |
| workspace | zhihu_stats_get | GET /zhihu-stats/:id | business_verified | #63 |
| workspace | workspace_get | GET / | response_only | #129 |
| workspace | workspace_update | PATCH / | not_exercised | 尚未为「Update workspace settings」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_get_context | GET /context | fixture_reference_observed | #130 |
| workspace | workspace_brands_list | GET /brands | business_verified | #4 |
| workspace | workspace_brand_get | GET /brands/:id | business_verified | #3 |
| workspace | workspace_brand_create | POST /brands | business_verified | #1, #2 |
| workspace | workspace_brand_update | PATCH /brands/:id | business_verified | #64 |
| workspace | workspace_brand_archive | POST /brands/:id/archive | not_exercised | 尚未为「Preview or archive a brand」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_markets_list | GET /brands/:id/markets | business_verified | #7 |
| workspace | workspace_market_get | GET /markets/:id | business_verified | #6 |
| workspace | workspace_market_create | POST /brands/:id/markets | business_verified | #5 |
| workspace | workspace_market_update | PATCH /markets/:id | business_verified | #65 |
| workspace | workspace_get_today | GET /overview/today | fixture_reference_observed | #131 |
| workspace | workspace_get_summary | GET /overview/summary | response_only | #132 |
| workspace | tasks_list | GET /work-items | fixture_reference_observed | #133 |
| workspace | tasks_get | GET /work-items/:id | fixture_reference_observed | #134 |
| workspace | tasks_create | POST /work-items | business_verified | #66 |
| workspace | tasks_update | PATCH /work-items/:id | business_verified | #67 |
| workspace | tasks_batch | POST /work-items/batch | not_exercised | 尚未为「Preview or apply a versioned work-item batch」准备有效请求、依赖状态和结果断言。 |
| workspace | tasks_complete | POST /work-items/:id/complete | business_verified | #68 |
| workspace | tasks_reopen | POST /work-items/:id/reopen | business_verified | #69 |
| workspace | tasks_handover | POST /work-items/:id/handover | not_exercised | 尚未为「Hand over a work item and record its history」准备有效请求、依赖状态和结果断言。 |
| workspace | tasks_dependencies | PUT /work-items/:id/dependencies | not_exercised | 尚未为「Replace a work item prerequisite set」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_get_personal_inbox | GET /me/inbox | fixture_reference_observed | #135 |
| workspace | notifications_list | GET /notifications | fixture_reference_observed | #136 |
| workspace | notifications_read | POST /notifications/read | not_exercised | 尚未为「Mark personal notifications as read」准备有效请求、依赖状态和结果断言。 |
| workspace | notifications_archive | POST /notifications/archive | not_exercised | 尚未为「Archive personal notifications」准备有效请求、依赖状态和结果断言。 |
| workspace | notifications_preferences_list | GET /me/notification-preferences | valid_empty | #137 |
| workspace | notifications_preferences_update | PUT /me/notification-preferences | not_exercised | 尚未为「Set a personal notification preference」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_subscriptions_list | GET /subscriptions | fixture_reference_observed | #138 |
| workspace | workspace_subscriptions_create | POST /subscriptions | not_exercised | 尚未为「Follow an accessible resource」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_subscriptions_remove | DELETE /subscriptions | not_exercised | 尚未为「Stop following a resource」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_subscriptions_delete | DELETE /subscriptions/:id | not_exercised | 尚未为「Delete a personal subscription」准备有效请求、依赖状态和结果断言。 |
| workspace | search_query | GET /search | fixture_reference_observed | #139 |
| workspace | workspace_saved_views_list | GET /saved-views | fixture_reference_observed | #140 |
| workspace | workspace_saved_views_create | POST /saved-views | business_verified | #98 |
| workspace | workspace_saved_views_update | PATCH /saved-views/:id | business_verified | #99 |
| workspace | workspace_onboarding_get | GET /onboarding/:flow | not_exercised | 缺少 :flow 对应的可验证资源或查询条件。 |
| workspace | workspace_onboarding_check | POST /onboarding/:flow/steps/:step/check | not_exercised | 尚未为「Recheck an onboarding step against live records」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_onboarding_skip | POST /onboarding/:flow/steps/:step/skip | not_exercised | 尚未为「Skip an onboarding step with reason」准备有效请求、依赖状态和结果断言。 |
| workspace | workspace_dashboard_get | GET /dashboards/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| workspace | workspace_dashboard_save | PUT /dashboards/:id | not_exercised | 尚未为「Save personal dashboard metric queries」准备有效请求、依赖状态和结果断言。 |
| account | account_list_social_accounts | GET /social-accounts | business_verified | #8 |
| account | account_get_social_account | GET /social-accounts/:id | fixture_reference_observed | #141 |
| account | account_update_social_account | PATCH /social-accounts/:id | not_exercised | 尚未为「update social account」准备有效请求、依赖状态和结果断言。 |
| account | account_disable_social_account | POST /social-accounts/:id/disable | not_exercised | 尚未为「disable social account」准备有效请求、依赖状态和结果断言。 |
| account | account_get_capabilities | GET /social-accounts/:id/capabilities | response_only | #142 |
| account | account_check_operation | GET /social-accounts/:id/operation-check | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_probe_capabilities | POST /social-accounts/:id/capabilities/probe | not_exercised | 尚未为「probe capabilities」准备有效请求、依赖状态和结果断言。 |
| account | account_get_platform_catalog | GET /platform-catalog | response_only | #143 |
| account | account_list_platform_apps | GET /platform-apps | valid_empty | #144 |
| account | account_list_connections | GET /connections | valid_empty | #145 |
| account | account_get_store_capabilities | GET /connections/:id/capabilities | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_probe_store_capabilities | POST /connections/:id/capabilities/probe | not_exercised | 尚未为「probe store capabilities」准备有效请求、依赖状态和结果断言。 |
| account | account_list_connection_accounts | GET /connections/:id/accounts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_list_devices | GET /devices | business_verified | #59 |
| account | account_list_mobile_devices | GET /mobile-devices | valid_empty | #146 |
| account | account_list_mobile_app_bindings | GET /mobile-app-bindings | valid_empty | #147 |
| account | account_preview_mobile_app_unbind | GET /mobile-app-bindings/:id/impact | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_list_browser_sessions | GET /browser-sessions | valid_empty | #148 |
| account | account_preview_binding_migration | GET /social-accounts/:id/execution-binding/migration/preview | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| account | account_get_binding_migration | GET /social-accounts/:id/execution-binding/migration | response_only | #149 |
| account | account_get_connector_auto_policy | GET /connector-auto-policy | response_only | #150 |
| account | account_list_account_blocks | GET /account-blocks | valid_empty | #151 |
| account | account_assign_account_block | PATCH /account-blocks/:id | not_exercised | 尚未为「assign account block」准备有效请求、依赖状态和结果断言。 |
| ingest | data_source_list | GET /data-sources | fixture_reference_observed | #152 |
| ingest | data_source_get | GET /data-sources/:id | business_verified | #105 |
| ingest | data_source_create | POST /data-sources | business_verified | #104 |
| ingest | data_source_update | PATCH /data-sources/:id | not_exercised | 尚未为「Update source resources and allowed uses」准备有效请求、依赖状态和结果断言。 |
| ingest | data_source_pause | POST /data-sources/:id/pause | not_exercised | 尚未为「Pause new collection requests」准备有效请求、依赖状态和结果断言。 |
| ingest | import_template_list | GET /import-templates | business_verified | #43 |
| ingest | import_list | GET /imports | fixture_reference_observed | #153 |
| ingest | import_create | POST /imports | business_verified | #44, #45 |
| ingest | import_get | GET /imports/:id | business_verified | #50 |
| ingest | import_preview | PATCH /imports/:id | business_verified | #46 |
| ingest | import_rows | GET /imports/:id/rows | business_verified | #48 |
| ingest | import_error_file | GET /imports/:id/error-file | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| ingest | import_confirm | POST /imports/:id/confirm | business_verified | #49 |
| ingest | import_cancel | POST /imports/:id/cancel | not_exercised | 尚未为「Cancel an unconfirmed import batch」准备有效请求、依赖状态和结果断言。 |
| ingest | import_mapping_preset_list | GET /import-mapping-presets | valid_empty | #154 |
| ingest | import_mapping_preset_create | POST /import-mapping-presets | not_exercised | 尚未为「Save a validated batch mapping for later reuse」准备有效请求、依赖状态和结果断言。 |
| ingest | sync_refresh | POST /data-sources/:id/refresh | not_exercised | 尚未为「Queue collection for an authorized source」准备有效请求、依赖状态和结果断言。 |
| ingest | sync_reconcile | POST /data-sources/:id/reconcile | not_exercised | 尚未为「Queue read-only reconciliation of a source window」准备有效请求、依赖状态和结果断言。 |
| ingest | data_source_coverage | GET /data-sources/:id/coverage | boundary_confirmed | #106 |
| ingest | sync_run_list | GET /sync-runs | valid_empty | #155 |
| ingest | sync_run_get | GET /sync-runs/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | sync_run_retry | POST /sync-runs/:id/retry | not_exercised | 尚未为「Queue a failed run from its last durable page」准备有效请求、依赖状态和结果断言。 |
| ingest | sync_schedule_list | GET /sync-schedules | valid_empty | #156 |
| ingest | sync_schedule_create | POST /sync-schedules | not_exercised | 尚未为「Set collection cadence for a resource」准备有效请求、依赖状态和结果断言。 |
| ingest | sync_schedule_update | PATCH /sync-schedules/:id | not_exercised | 尚未为「Update collection frequency and window overlap」准备有效请求、依赖状态和结果断言。 |
| ingest | backfill_plan | POST /backfills | not_exercised | 尚未为「Plan bounded historical collection slices」准备有效请求、依赖状态和结果断言。 |
| ingest | backfill_list | GET /backfills | valid_empty | #157 |
| ingest | backfill_get | GET /backfills/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ingest | backfill_resume | POST /backfills/:id/resume | not_exercised | 尚未为「Resume unfinished historical collection slices」准备有效请求、依赖状态和结果断言。 |
| ingest | data_gap_list | GET /data-gaps | valid_empty | #158 |
| ingest | data_gap_backfill | POST /data-gaps/:id/backfill | not_exercised | 尚未为「Schedule a backfill for an open gap」准备有效请求、依赖状态和结果断言。 |
| ingest | webhook_delivery_list | GET /webhook-deliveries | valid_empty | #159 |
| ingest | data_health_get | GET /data-health | fixture_reference_observed | #160 |
| ingest | data_quality_issue_list | GET /data-quality/issues | fixture_reference_observed | #161 |
| ingest | data_quality_issue_update | PATCH /data-quality/issues/:id | not_exercised | 尚未为「Record disposition of a quality issue」准备有效请求、依赖状态和结果断言。 |
| ingest | vendor_usage_list | GET /vendor-usage | valid_empty | #162 |
| ingest | collection_budget_list | GET /collection-budgets | valid_empty | #163 |
| ingest | data_provenance_get | GET /provenance | fixture_reference_observed | #164 |
| ingest | raw_record_get | GET /raw-records/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_store_list | GET /stores | business_verified | #34 |
| commerce | commerce_store_create | POST /stores | business_verified | #33 |
| commerce | commerce_store_get | GET /stores/:id | fixture_reference_observed | #165 |
| commerce | commerce_store_update | PATCH /stores/:id | not_exercised | 尚未为「Update store settings or disable the source」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_store_sync | POST /stores/:id/sync | not_exercised | 尚未为「Request an ingest synchronization」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_store_import | POST /stores/:id/imports | business_verified | #47 |
| commerce | commerce_store_market_list | GET /stores/:id/markets | business_verified | #36 |
| commerce | commerce_store_market_configure | PUT /stores/:id/markets | business_verified | #35 |
| commerce | catalog_search | GET /products | business_verified | #42 |
| commerce | commerce_product_create | POST /products | business_verified | #37 |
| commerce | catalog_get_product | GET /products/:id | business_verified | #41 |
| commerce | commerce_product_update | PATCH /products/:id | business_verified | #38 |
| commerce | commerce_product_usage | GET /products/:id/usage | business_verified | #81 |
| commerce | commerce_variant_create | POST /products/:id/variants | business_verified | #39 |
| commerce | commerce_variant_update | PATCH /variants/:id | business_verified | #40 |
| commerce | market_snapshot | GET /variants/:id/listings | valid_empty | #166 |
| commerce | commerce_record_listing | POST /variants/:id/listings | not_exercised | 尚未为「Record a local market observation」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_variant_group_suggest | GET /variant-groups/suggestions | valid_empty | #167 |
| commerce | commerce_variant_group_list | GET /variant-groups | fixture_reference_observed | #168 |
| commerce | commerce_variant_group_create | POST /variant-groups | business_verified | #82 |
| commerce | commerce_variant_group_member_list | GET /variant-groups/:id/members | valid_empty | #169 |
| commerce | commerce_variant_group_link | POST /variant-groups/:id/members | not_exercised | 尚未为「Confirm a manual variant mapping」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_variant_group_link_batch | POST /variant-groups/:id/members/batch | not_exercised | 尚未为「Confirm a reviewed batch of variant mappings」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_variant_group_unlink | DELETE /variant-groups/:id/members/:memberId | not_exercised | 尚未为「Unlink a mapping without removing its history」准备有效请求、依赖状态和结果断言。 |
| commerce | catalog_list_facts | GET /products/:id/facts | valid_empty | #170 |
| commerce | catalog_propose_fact | POST /products/:id/facts | not_exercised | 尚未为「Propose a draft product fact」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_fact_revise | POST /facts/:id/revisions | not_exercised | 尚未为「Add a draft revision to a fact」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_localization_list | GET /products/:id/localizations | valid_empty | #171 |
| commerce | catalog_update_localization | PUT /products/:id/localizations | not_exercised | 尚未为「Draft a translation without changing the approved revision」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_localization_submit | POST /localizations/:id/submit | not_exercised | 尚未为「Review localization: submit」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_list_changes | GET /change-events | valid_empty | #172 |
| commerce | commerce_change_acknowledge | POST /change-events/:id/acknowledge | not_exercised | 尚未为「acknowledge a commerce change」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_change_resolve | POST /change-events/:id/resolve | not_exercised | 尚未为「resolve a commerce change」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_change_dismiss | POST /change-events/:id/dismiss | not_exercised | 尚未为「dismiss a commerce change」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_promotion_list | GET /promotions | fixture_reference_observed | #173 |
| commerce | commerce_promotion_create | POST /promotions | business_verified | #100 |
| commerce | promotion_get | GET /promotions/:id | fixture_reference_observed | #174 |
| commerce | commerce_promotion_update | PATCH /promotions/:id | business_verified | #101 |
| commerce | commerce_promotion_cancel | DELETE /promotions/:id | not_exercised | 尚未为「Cancel a local promotion and preserve usage history」准备有效请求、依赖状态和结果断言。 |
| commerce | commerce_localization_export | GET /localizations/:id/export | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| commerce | commerce_order_list | GET /orders | valid_empty | #175 |
| commerce | commerce_order_get | GET /orders/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| commerce | commerce_refund_list | GET /refunds | valid_empty | #176 |
| commerce | orders_summary | GET /orders/summary | response_only | #177 |
| commerce | commerce_inventory_rule_list | GET /inventory-rules | valid_empty | #178 |
| commerce | commerce_inventory_rule_create | POST /inventory-rules | not_exercised | 尚未为「Configure an inventory notification or pause rule」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_list | GET /campaigns | fixture_reference_observed | #179 |
| campaign | campaign_create_draft | POST /campaigns | business_verified | #76 |
| campaign | campaign_update | PATCH /campaigns/:id | not_exercised | 尚未为「Update campaign metadata」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_transition | POST /campaigns/:id/transition | not_exercised | 尚未为「Manually transition a campaign」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_set_markets | PUT /campaigns/:id/markets | not_exercised | 尚未为「Replace campaign markets」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_set_products | PUT /campaigns/:id/products | not_exercised | 尚未为「Replace campaign products」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_goal_list | GET /campaigns/:id/goals | fixture_reference_observed | #180 |
| campaign | campaign_goal_create | POST /campaigns/:id/goals | business_verified | #77 |
| campaign | campaign_goal_get | GET /campaigns/:id/goals/:goalId | fixture_reference_observed | #181 |
| campaign | campaign_goal_update | PATCH /campaigns/:id/goals/:goalId | business_verified | #78 |
| campaign | campaign_goal_withdraw | DELETE /campaigns/:id/goals/:goalId | not_exercised | 尚未为「Withdraw a goal while preserving history」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_plan_slot_list | GET /campaigns/:id/plan-slots | fixture_reference_observed | #182 |
| campaign | campaign_plan_slot_create | POST /campaigns/:id/plan-slots | business_verified | #79 |
| campaign | campaign_plan_slot_get | GET /campaigns/:id/plan-slots/:slotId | fixture_reference_observed | #183 |
| campaign | campaign_plan_slot_update | PATCH /campaigns/:id/plan-slots/:slotId | business_verified | #80 |
| campaign | campaign_plan_slot_delete | DELETE /campaigns/:id/plan-slots/:slotId | not_exercised | 尚未为「Delete a campaign plan slot」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_brief_list | GET /campaigns/:id/briefs | valid_empty | #184 |
| campaign | campaign_brief_create | POST /campaigns/:id/briefs | not_exercised | 尚未为「Create a brief and optionally its initial revision」准备有效请求、依赖状态和结果断言。 |
| campaign | brief_revision_list | GET /briefs/:id/revisions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | brief_update_draft | POST /briefs/:id/revisions | not_exercised | 尚未为「Append a new immutable brief revision」准备有效请求、依赖状态和结果断言。 |
| campaign | brief_revision_submit | POST /brief-revisions/:id/submit | not_exercised | 尚未为「submit a brief revision」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_budget_line_list | GET /campaigns/:id/budget-lines | valid_empty | #185 |
| campaign | campaign_budget_line_get | GET /campaigns/:id/budget-lines/:budgetLineId | not_exercised | 缺少 :id、:budgetLineId 对应的可验证资源或查询条件。 |
| campaign | campaign_budget_line_create | POST /campaigns/:id/budget-lines | not_exercised | 尚未为「Record budget_line」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_budget_line_update | PATCH /campaigns/:id/budget-lines/:budgetLineId | not_exercised | 尚未为「Revise budget_line」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_budget_line_delete | DELETE /campaigns/:id/budget-lines/:budgetLineId | not_exercised | 尚未为「Delete an eligible budget_line」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_cost_commitment_list | GET /campaigns/:id/cost-commitments | valid_empty | #186 |
| campaign | campaign_cost_commitment_get | GET /campaigns/:id/cost-commitments/:commitmentId | not_exercised | 缺少 :id、:commitmentId 对应的可验证资源或查询条件。 |
| campaign | campaign_cost_commitment_create | POST /campaigns/:id/cost-commitments | not_exercised | 尚未为「Record cost_commitment」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_cost_commitment_update | PATCH /campaigns/:id/cost-commitments/:commitmentId | not_exercised | 尚未为「Revise cost_commitment」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_cost_commitment_delete | DELETE /campaigns/:id/cost-commitments/:commitmentId | not_exercised | 尚未为「Delete an eligible cost_commitment」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_cost_entry_list | GET /campaigns/:id/cost-entries | valid_empty | #187 |
| campaign | campaign_cost_entry_get | GET /campaigns/:id/cost-entries/:entryId | not_exercised | 缺少 :id、:entryId 对应的可验证资源或查询条件。 |
| campaign | campaign_cost_entry_create | POST /campaigns/:id/cost-entries | not_exercised | 尚未为「Record cost_entry」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_cost_entry_update | PATCH /campaigns/:id/cost-entries/:entryId | not_exercised | 尚未为「Revise cost_entry」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_cost_entry_delete | DELETE /campaigns/:id/cost-entries/:entryId | not_exercised | 尚未为「Delete an eligible cost_entry」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_budget_summary | GET /campaigns/:id/budget-summary | fixture_reference_observed | #188 |
| campaign | campaign_budget_benchmarks | GET /campaigns/:id/budget-benchmarks | valid_empty | #189 |
| campaign | campaign_budget_reallocation_request | POST /campaigns/:id/budget-reallocations | not_exercised | 尚未为「Request approval to transfer budget between lines in the same currency」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_budget_approval_list | GET /campaigns/:id/budget-approvals | valid_empty | #190 |
| campaign | campaign_get_context | GET /campaigns/:id | fixture_reference_observed | #191 |
| campaign | campaign_matrix | GET /campaigns/:id/matrix | fixture_reference_observed | #192 |
| campaign | campaign_create_gap_items | POST /campaigns/:id/matrix/gaps/create-items | not_exercised | 尚未为「Preview or create content and work items to fill plan gaps」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_milestone_list | GET /campaigns/:id/milestones | valid_empty | #193 |
| campaign | campaign_milestone_create | POST /campaigns/:id/milestones | not_exercised | 尚未为「Add a production milestone in Workspace」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_create_tasks | POST /campaigns/:id/tasks | not_exercised | 尚未为「Create dependent production work items in Workspace」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_tracking_summary | GET /campaigns/:id/tracking-summary | fixture_reference_observed | #194 |
| campaign | campaign_link_list | GET /campaigns/:id/links | valid_empty | #195 |
| campaign | campaign_link_create | POST /campaigns/:id/links | not_exercised | 尚未为「Create a Traffic short link with the immutable campaign UTM key」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_attribution_compare | GET /campaigns/:id/attribution | response_only | #196 |
| campaign | campaign_tracking_get | GET /campaigns/:id/tracking-config | response_only | #197 |
| campaign | campaign_tracking_set | PUT /campaigns/:id/tracking-config | not_exercised | 尚未为「Set conversion definitions and verified campaign landing targets」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_closeout_get | GET /campaigns/:id/closeout | response_only | #198 |
| campaign | campaign_historical_baselines | GET /campaigns/:id/historical-baselines | valid_empty | #199 |
| campaign | campaign_closeout_draft | POST /campaigns/:id/closeout/draft | not_exercised | 尚未为「Preview facts and unresolved items for campaign closeout」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_report_list | GET /campaigns/:id/reports | valid_empty | #200 |
| campaign | campaign_report_backfill | POST /campaigns/:id/reports/:reportId/backfill | not_exercised | 尚未为「Generate a new report version for a closed campaign」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_template_derive | POST /campaigns/:id/templates | not_exercised | 尚未为「Derive a reusable structure from a closed campaign」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_template_list | GET /campaign-templates | valid_empty | #201 |
| campaign | campaign_template_get | GET /campaign-templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| campaign | campaign_template_create | POST /campaign-templates | not_exercised | 尚未为「Save a reusable brief and relative campaign schedule」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_template_update | PATCH /campaign-templates/:id | not_exercised | 尚未为「Revise a campaign template」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_template_delete | DELETE /campaign-templates/:id | not_exercised | 尚未为「Delete an unused campaign template」准备有效请求、依赖状态和结果断言。 |
| campaign | campaign_template_instantiate | POST /campaign-templates/:id/instantiate | not_exercised | 尚未为「Create a draft campaign, draft brief and dated plan from a template」准备有效请求、依赖状态和结果断言。 |
| intel | watch_targets_list | GET /watch-targets | fixture_reference_observed | #202 |
| intel | watch_target_create | POST /watch-targets | business_verified | #85 |
| intel | watch_target_get | GET /watch-targets/:id | fixture_reference_observed | #203 |
| intel | watch_target_update | PATCH /watch-targets/:id | not_exercised | 尚未为「Update a watch target」准备有效请求、依赖状态和结果断言。 |
| intel | observations_list | GET /watch-targets/:id/observations | business_verified | #87 |
| intel | observation_record | POST /observations | business_verified | #86 |
| intel | research_boards_list | GET /research-boards | business_verified | #54 |
| intel | research_board_create | POST /research-boards | business_verified | #51 |
| intel | research_board_get | GET /research-boards/:id | business_verified | #53 |
| intel | research_board_update | PATCH /research-boards/:id | business_verified | #58 |
| intel | research_add_item | POST /research-boards/:id/items | business_verified | #52 |
| intel | research_create_note | POST /research-boards/:id/notes | business_verified | #55 |
| intel | research_item_update | PATCH /research-items/:id | business_verified | #57 |
| intel | research_item_delete | DELETE /research-items/:id | not_exercised | 尚未为「Remove an unreferenced research item」准备有效请求、依赖状态和结果断言。 |
| intel | research_item_convert | POST /research-items/:id/convert | not_exercised | 尚未为「Convert research to a content idea or campaign hypothesis」准备有效请求、依赖状态和结果断言。 |
| intel | research_search | GET /research/search | fixture_reference_observed | #204 |
| intel | research_item_evidence | GET /research-items/:id/evidence | business_verified | #56 |
| intel | creative_references_list | GET /creative-references | valid_empty | #205 |
| intel | creative_reference_create | POST /creative-references | not_exercised | 尚未为「Create a link-only creative reference」准备有效请求、依赖状态和结果断言。 |
| intel | creative_reference_annotate | PATCH /creative-references/:id | not_exercised | 尚未为「Annotate a creative reference」准备有效请求、依赖状态和结果断言。 |
| intel | product_candidates_list | GET /product-candidates | valid_empty | #206 |
| intel | product_candidate_create | POST /product-candidates | not_exercised | 尚未为「Propose a product candidate」准备有效请求、依赖状态和结果断言。 |
| intel | product_candidate_get | GET /product-candidates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | product_candidate_update | PATCH /product-candidates/:id | not_exercised | 尚未为「Update candidate research fields or advance its state」准备有效请求、依赖状态和结果断言。 |
| intel | product_candidates_score | POST /product-candidates/:id/scores | not_exercised | 尚未为「Score one candidate dimension without deciding」准备有效请求、依赖状态和结果断言。 |
| intel | observations_compare | GET /research/compare | not_exercised | 缺少该视图的查询条件或业务断言。 |
| intel | research_topics_list | GET /topics | valid_empty | #207 |
| intel | research_topic_create | POST /topics | not_exercised | 尚未为「Define a topic and its eligible sample」准备有效请求、依赖状态和结果断言。 |
| intel | research_topic_trend | GET /topics/:id/trend | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | alert_rules_list | GET /alert-rules | valid_empty | #208 |
| intel | alert_rule_create | POST /alert-rules | not_exercised | 尚未为「Create a monitoring alert rule」准备有效请求、依赖状态和结果断言。 |
| intel | alert_rule_update | PATCH /alert-rules/:id | not_exercised | 尚未为「Update a monitoring alert rule」准备有效请求、依赖状态和结果断言。 |
| intel | alerts_list | GET /alerts | valid_empty | #209 |
| intel | alerts_evaluate | POST /alerts/evaluate | not_exercised | 尚未为「Evaluate configured alert rules」准备有效请求、依赖状态和结果断言。 |
| intel | alert_update | PATCH /alerts/:id | not_exercised | 尚未为「Acknowledge, assign, resolve or dismiss an alert」准备有效请求、依赖状态和结果断言。 |
| intel | mentions_query | GET /mentions | response_only | #210 |
| intel | mention_record | POST /mentions | not_exercised | 尚未为「Record a public brand mention」准备有效请求、依赖状态和结果断言。 |
| intel | mention_labels_list | GET /mentions/:id/labels | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| intel | mention_label_update | PATCH /mentions/:id/labels | not_exercised | 尚未为「Append a human label and preserve superseded labels」准备有效请求、依赖状态和结果断言。 |
| intel | mention_escalate | POST /mentions/:id/escalate | not_exercised | 尚未为「Escalate a mention to a workspace follow-up task」准备有效请求、依赖状态和结果断言。 |
| intel | share_of_voice_get | GET /share-of-voice | not_exercised | 缺少该视图的查询条件或业务断言。 |
| content | content_list_pillars | GET /content-pillars | fixture_reference_observed | #211 |
| content | content_create_pillar | POST /content-pillars | business_verified | #93 |
| content | content_get_pillar | GET /content-pillars/:id | fixture_reference_observed | #212 |
| content | content_update_pillar | PATCH /content-pillars/:id | business_verified | #94 |
| content | content_archive_pillar | DELETE /content-pillars/:id | not_exercised | 尚未为「Archive a content pillar」准备有效请求、依赖状态和结果断言。 |
| content | idea_list | GET /ideas | fixture_reference_observed | #213 |
| content | idea_create | POST /ideas | business_verified | #95 |
| content | idea_create_from_conversation | POST /ideas/from-conversation | not_exercised | 尚未为「Capture a customer question as an idea」准备有效请求、依赖状态和结果断言。 |
| content | idea_get | GET /ideas/:id | fixture_reference_observed | #214 |
| content | idea_update | PATCH /ideas/:id | business_verified | #96 |
| content | idea_convert | POST /ideas/:id/convert | not_exercised | 尚未为「Convert an idea to a content item」准备有效请求、依赖状态和结果断言。 |
| content | content_list | GET /content-items | fixture_reference_observed | #215 |
| content | content_production_workload | GET /content-items/workload | business_error | #216 |
| content | content_create_item | POST /content-items | business_verified | #20 |
| content | content_create_draft | POST /content-items/draft | not_exercised | 尚未为「Create agent drafts」准备有效请求、依赖状态和结果断言。 |
| content | content_get | GET /content-items/:id | business_verified | #25 |
| content | content_item_update | PATCH /content-items/:id | not_exercised | 尚未为「Update a content item」准备有效请求、依赖状态和结果断言。 |
| content | content_set_stage | POST /content-items/:id/stage | not_exercised | 尚未为「Advance production stage」准备有效请求、依赖状态和结果断言。 |
| content | content_create_variant | POST /content-items/:id/variants | business_verified | #21 |
| content | content_export_item | GET /content-items/:id/export | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| content | content_duplicate | POST /content-items/:id/duplicate | not_exercised | 尚未为「Duplicate a content item with lineage」准备有效请求、依赖状态和结果断言。 |
| content | content_record_handoff_checklist | POST /content-items/:id/handoff-checklist | not_exercised | 尚未为「Record handoff checklist results」准备有效请求、依赖状态和结果断言。 |
| content | content_list_stale | GET /content-variants/stale | valid_empty | #217 |
| content | content_batch_variants | POST /content-variants/batch | not_exercised | 尚未为「Preview or commit batch draft changes」准备有效请求、依赖状态和结果断言。 |
| content | content_get_variant | GET /content-variants/:id | business_verified | #24 |
| content | content_list_product_facts | GET /content-variants/:id/product-facts | valid_empty | #218 |
| content | content_insert_product_fact | POST /content-variants/:id/product-facts | not_exercised | 尚未为「Insert an approved product fact into the working draft」准备有效请求、依赖状态和结果断言。 |
| content | content_list_product_prices | GET /content-variants/:id/product-prices | valid_empty | #219 |
| content | content_insert_product_price | POST /content-variants/:id/product-prices | not_exercised | 尚未为「Insert a current market price into the working draft」准备有效请求、依赖状态和结果断言。 |
| content | content_autosave_variant | PATCH /content-variants/:id | business_verified | #22 |
| content | content_request_rendition | POST /content-variants/:id/renditions | not_exercised | 尚未为「Request an asset rendition for working-draft media」准备有效请求、依赖状态和结果断言。 |
| content | content_update_variant | POST /content-variants/:id/agent-edit | not_exercised | 尚未为「Commit a version-checked agent edit」准备有效请求、依赖状态和结果断言。 |
| content | content_commit_revision | POST /content-variants/:id/revisions | business_verified | #23 |
| content | content_list_revisions | GET /content-variants/:id/revisions | business_verified | #26 |
| content | content_get_revision | GET /content-revisions/:id | fixture_reference_observed | #220 |
| content | content_diff_revisions | GET /content-revisions/:a/diff/:b | not_exercised | 缺少 :a、:b 对应的可验证资源或查询条件。 |
| content | content_restore_revision | POST /content-revisions/:id/restore | not_exercised | 尚未为「Restore a revision as a new revision」准备有效请求、依赖状态和结果断言。 |
| content | content_validate_variant | POST /content-variants/:id/validate | not_exercised | 尚未为「Validate content and build a platform preview」准备有效请求、依赖状态和结果断言。 |
| content | content_set_readiness | POST /content-variants/:id/readiness | not_exercised | 尚未为「Mark a committed variant ready」准备有效请求、依赖状态和结果断言。 |
| content | content_list_translations | GET /content-variants/:id/translations | valid_empty | #221 |
| content | content_create_translation | POST /content-variants/:id/translations | not_exercised | 尚未为「Create a localized variant」准备有效请求、依赖状态和结果断言。 |
| content | content_accept_source_change | POST /translation-links/:id/accept-source-change | not_exercised | 尚未为「Review the changed translation source」准备有效请求、依赖状态和结果断言。 |
| content | content_mark_divergence | POST /translation-links/:id/mark-divergence | not_exercised | 尚未为「Record a deliberate market rewrite」准备有效请求、依赖状态和结果断言。 |
| content | content_list_feeds | GET /feeds | valid_empty | #222 |
| content | content_create_feed | POST /feeds | not_exercised | 尚未为「Create an import feed」准备有效请求、依赖状态和结果断言。 |
| content | content_get_feed | GET /feeds/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_update_feed | PATCH /feeds/:id | not_exercised | 尚未为「Edit an import feed」准备有效请求、依赖状态和结果断言。 |
| content | content_archive_feed | DELETE /feeds/:id | not_exercised | 尚未为「Archive an import feed」准备有效请求、依赖状态和结果断言。 |
| content | content_poll_feed | POST /feeds/:id/poll | not_exercised | 尚未为「Request a feed poll」准备有效请求、依赖状态和结果断言。 |
| content | content_preview_feed_import | POST /feeds/:id/preview-import | not_exercised | 尚未为「Preview a link or normalized content file」准备有效请求、依赖状态和结果断言。 |
| content | content_list_feed_items | GET /feeds/:id/items | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_import_feed_item | POST /feed-items/:id/import | not_exercised | 尚未为「Import a feed item as an idea」准备有效请求、依赖状态和结果断言。 |
| content | content_request_post_maintenance | POST /platform-posts/:id/maintenance | not_exercised | 尚未为「Request post maintenance」准备有效请求、依赖状态和结果断言。 |
| content | content_get_transcript | GET /content-transcripts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| content | content_review_transcript | PATCH /content-transcripts/:id | not_exercised | 尚未为「Review and correct a transcript」准备有效请求、依赖状态和结果断言。 |
| content | content_request_transcript | POST /content-transcripts | not_exercised | 尚未为「Request a transcript」准备有效请求、依赖状态和结果断言。 |
| asset | asset_list_submission_boxes | GET /submission-boxes | valid_empty | #223 |
| asset | asset_get_submission_box | GET /submission-boxes/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | asset_list_external_sources | GET /external-sources | valid_empty | #224 |
| asset | asset_begin_upload | POST /assets/uploads | not_exercised | 尚未为「Reserve an asset upload」准备有效请求、依赖状态和结果断言。 |
| asset | asset_search | GET /assets | fixture_reference_observed | #225 |
| asset | asset_create | POST /assets | business_verified | #13 |
| asset | asset_find_duplicates | GET /assets/:id/duplicates | valid_empty | #226 |
| asset | asset_get | GET /assets/:id | business_verified | #14 |
| asset | asset_update | PATCH /assets/:id | business_verified | #16 |
| asset | asset_set_favorite | POST /assets/:id/favorite | not_exercised | 尚未为「Set your asset favorite」准备有效请求、依赖状态和结果断言。 |
| asset | asset_download_version | GET /asset-versions/:id/download | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| asset | asset_list_versions | GET /assets/:id/versions | business_verified | #15 |
| asset | asset_add_version | POST /assets/:id/versions | not_exercised | 尚未为「Attach a new immutable file version」准备有效请求、依赖状态和结果断言。 |
| asset | asset_usage | GET /assets/:id/usage | fixture_reference_observed | #227 |
| asset | asset_request_rendition | POST /asset-versions/:id/renditions | business_verified | #18 |
| asset | asset_request_rendition_batch | POST /asset-versions/:id/rendition-batch | not_exercised | 尚未为「Queue up to twenty rendition recipes for a version」准备有效请求、依赖状态和结果断言。 |
| asset | asset_retry_rendition | POST /renditions/:id/retry | not_exercised | 尚未为「Retry a failed rendition」准备有效请求、依赖状态和结果断言。 |
| asset | asset_get_rendition | GET /renditions/:id | business_verified | #19 |
| asset | asset_archive | POST /assets/:id/archive | not_exercised | 尚未为「Archive an asset」准备有效请求、依赖状态和结果断言。 |
| asset | asset_list_folders | GET /asset-folders | valid_empty | #228 |
| asset | asset_get_folder | GET /asset-folders/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | rights_list | GET /rights-grants | fixture_reference_observed | #229 |
| asset | rights_list_impacts | GET /rights-impacts | valid_empty | #230 |
| asset | rights_get | GET /rights-grants/:id | business_verified | #17 |
| asset | rights_create_draft | POST /rights-grants | not_exercised | 尚未为「Draft an asset rights grant」准备有效请求、依赖状态和结果断言。 |
| asset | rights_revise | POST /rights-grants/:id/revisions | not_exercised | 尚未为「Propose revised grant terms」准备有效请求、依赖状态和结果断言。 |
| asset | asset_check_usage | POST /rights/check | not_exercised | 尚未为「Check scoped asset use rights」准备有效请求、依赖状态和结果断言。 |
| asset | knowledge_list | GET /knowledge | fixture_reference_observed | #231 |
| asset | knowledge_import | POST /knowledge/import | not_exercised | 尚未为「Import extracted entries as proposals」准备有效请求、依赖状态和结果断言。 |
| asset | knowledge_get | GET /knowledge/:id | fixture_reference_observed | #232 |
| asset | knowledge_propose | POST /knowledge | business_verified | #97 |
| asset | knowledge_revise | POST /knowledge/:id/revisions | not_exercised | 尚未为「Propose a revision to brand knowledge」准备有效请求、依赖状态和结果断言。 |
| asset | knowledge_get_context | GET /brands/:brandId/context | fixture_reference_observed | #233 |
| asset | template_list | GET /templates | valid_empty | #234 |
| asset | template_get | GET /templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| asset | template_create | POST /templates | not_exercised | 尚未为「Create a reusable template」准备有效请求、依赖状态和结果断言。 |
| asset | template_update | PATCH /templates/:id | not_exercised | 尚未为「Edit a template」准备有效请求、依赖状态和结果断言。 |
| asset | template_archive | DELETE /templates/:id | not_exercised | 尚未为「Archive a template」准备有效请求、依赖状态和结果断言。 |
| asset | template_render | POST /templates/:id/render | not_exercised | 尚未为「Render a template with approved source values」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_get_calendar | GET /calendar | fixture_reference_observed | #235 |
| planning | publishing_list_targets | GET /publish-targets | business_verified | #32 |
| planning | publishing_get_target | GET /publish-targets/:id | business_verified | #31 |
| planning | publishing_create_target | POST /publish-targets | business_verified | #27 |
| planning | publishing_update_target | PATCH /publish-targets/:id | not_exercised | 尚未为「publishing update target」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_request_approval | POST /publish-targets/:id/submit | business_verified | #29 |
| planning | publishing_run_precheck | POST /publish-targets/:id/precheck | not_exercised | 尚未为「publishing run precheck」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_reschedule | POST /publish-targets/:id/reschedule | business_verified | #28 |
| planning | publishing_cancel | POST /publish-targets/:id/cancel | not_exercised | 尚未为「publishing cancel」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_list_approvals | GET /approvals | valid_empty | #236 |
| planning | publishing_create_plan | POST /publish-plans | not_exercised | 尚未为「publishing create plan」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_update_plan | PATCH /publish-plans/:id | not_exercised | 尚未为「publishing update plan」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_preview_plan_items | POST /publish-plans/preview | not_exercised | 尚未为「publishing preview plan items」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_preview_plan | POST /publish-plans/:id/preview | not_exercised | 尚未为「publishing preview plan」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_schedule | POST /publish-plans/:id/commit | not_exercised | 尚未为「publishing schedule」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_get_plan | GET /publish-plans/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_pauses | GET /pause-switches | valid_empty | #237 |
| planning | publishing_get_pause | GET /pause-switches/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_pause | POST /pause-switches | not_exercised | 尚未为「publishing pause」准备有效请求、依赖状态和结果断言。 |
| planning | publishing_list_slot_templates | GET /slot-templates | valid_empty | #238 |
| planning | publishing_get_slot_template | GET /slot-templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_schedule_rules | GET /schedule-rules | valid_empty | #239 |
| planning | publishing_get_schedule_rule | GET /schedule-rules/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_evergreen_queues | GET /evergreen-queues | valid_empty | #240 |
| planning | publishing_get_evergreen_queue | GET /evergreen-queues/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_evergreen_items | GET /evergreen-queues/:id/items | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_review_rounds | GET /review-rounds | valid_empty | #241 |
| planning | publishing_get_review_round | GET /review-rounds/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_list_post_matches | GET /reconciliation/candidates | valid_empty | #242 |
| planning | publishing_suggest_post_match | GET /reconciliation/suggestions/:id | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| planning | publishing_suggest_evergreen_order | GET /evergreen-queues/:id/suggestions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| planning | publishing_suggest_slots | GET /slot-suggestions | valid_empty | #243 |
| execution | publishing_list_execution | GET /execution-tasks | valid_empty | #244 |
| execution | publishing_get_execution | GET /execution-tasks/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| execution | publishing_list_exceptions | GET /execution-exceptions | valid_empty | #245 |
| execution | publishing_run_now | POST /execution-tasks/:id/run-now | not_exercised | 尚未为「Run prechecks and dispatch the available execution path」准备有效请求、依赖状态和结果断言。 |
| execution | publishing_retry | POST /execution-tasks/:id/retry | not_exercised | 尚未为「Queue a verified-safe retry」准备有效请求、依赖状态和结果断言。 |
| execution | publishing_reconcile | POST /execution-tasks/:id/reconcile | not_exercised | 尚未为「Request verification of an unresolved outcome」准备有效请求、依赖状态和结果断言。 |
| execution | execution_cancel_task | POST /execution-tasks/:id/cancel | not_exercised | 尚未为「Cancel before submission or request confirmation」准备有效请求、依赖状态和结果断言。 |
| execution | posts_list | GET /platform-posts | valid_empty | #246 |
| execution | posts_get | GET /platform-posts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| execution | posts_register_manual | POST /platform-posts/register | not_exercised | 尚未为「Register a post and its evidence; an agent can report an existing external post for metrics import」准备有效请求、依赖状态和结果断言。 |
| execution | publishing_preview_execution_batch | POST /execution-batches/preview | not_exercised | 尚未为「Preview the effect of an execution batch」准备有效请求、依赖状态和结果断言。 |
| execution | publishing_apply_execution_batch | POST /execution-batches/:id/apply | not_exercised | 尚未为「Apply a current batch preview」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list | GET /conversations | fixture_reference_observed | #247 |
| inbox | inbox_get_conversation | GET /conversations/:id | fixture_reference_observed | #248 |
| inbox | inbox_ingest_batch | POST /inbox/ingest | business_verified | #88 |
| inbox | inbox_update_conversation | PATCH /conversations/:id | not_exercised | 尚未为「Assign or change processing status」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_batch_conversations | POST /conversations/batch | not_exercised | 尚未为「Preview or apply conversation updates」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_mark_read | POST /conversations/:id/read | not_exercised | 尚未为「Set personal read position」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_claim | POST /conversations/:id/occupancy | business_verified | #89 |
| inbox | inbox_release | DELETE /conversations/:id/occupancy | business_verified | #90 |
| inbox | inbox_add_note | POST /conversations/:id/notes | not_exercised | 尚未为「Write an internal note」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_draft_reply | POST /conversations/:id/reply-drafts | not_exercised | 尚未为「Draft a reply」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_update_reply_draft | PATCH /reply-drafts/:id | not_exercised | 尚未为「Edit a reply draft」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_submit_reply_approval | POST /reply-drafts/:id/submit-approval | not_exercised | 尚未为「Request approval」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_send_reply | POST /reply-drafts/:id/send | not_exercised | 需要逐项核实连接、外部副作用与执行授权。本轮没有第三方测试连接。 |
| inbox | inbox_get_reply_status | GET /outbound-replies/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_reconcile_reply | POST /outbound-replies/:id/reconcile | not_exercised | 尚未为「Verify a reply against synchronized platform messages」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_manual_complete_reply | POST /outbound-replies/:id/manual-complete | not_exercised | 尚未为「Record manual delivery evidence」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_cancel_reply | POST /outbound-replies/:id/cancel | not_exercised | 尚未为「Cancel a staged or confirmed unsent reply」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_create_sla_policy | POST /inbox/sla-policies | not_exercised | 尚未为「Create business-hours or elapsed-time service targets」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_update_sla_policy | PATCH /inbox/sla-policies/:id | not_exercised | 尚未为「Update service targets for future assignments」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_sla_tick | POST /inbox/sla-policies/tick | not_exercised | 尚未为「Evaluate service deadlines」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_unsnooze | POST /inbox/unsnooze | not_exercised | 尚未为「Reopen due snoozed conversations」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_evaluate_auto_rules | POST /inbox/messages/:id/evaluate-rules | not_exercised | 尚未为「Evaluate draft-only rules on a stored inbound message」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_coverage | GET /inbox/coverage | fixture_reference_observed | #249 |
| inbox | inbox_get_sla_sample | GET /inbox/sla-sample | response_only | #250 |
| inbox | inbox_get_participant_link | GET /conversations/:id/customer-link | fixture_reference_observed | #251 |
| inbox | inbox_list_moderation | GET /conversations/:id/moderation | response_only | #252 |
| inbox | inbox_record_manual_moderation | POST /conversations/:id/moderation | not_exercised | 尚未为「Record a completed manual comment moderation action without writing to the platform」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_set_local_comment_access | PUT /inbox/local-comment-access | not_exercised | 尚未为「Authorize loopback comment readback for a known comment account」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_read_comment_state | POST /conversations/:id/moderation/readback | not_exercised | 尚未为「Read the authorized provider state after a manual comment action」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_cases | GET /cases | fixture_reference_observed | #253 |
| inbox | inbox_get_case | GET /cases/:id | business_verified | #92 |
| inbox | inbox_create_case | POST /cases | business_verified | #91 |
| inbox | inbox_handoff_case | POST /cases/:id/handoff | not_exercised | 尚未为「Record a handoff request awaiting acknowledgment」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_update_case | PATCH /cases/:id | not_exercised | 尚未为「Record external acknowledgment, resolution or closeout」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_record_translation | POST /messages/:id/translations | not_exercised | 尚未为「Attach a human translation while preserving the original」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_translations | GET /messages/:id/translations | valid_empty | #254 |
| inbox | inbox_list_review_sources | GET /inbox/review-sources | valid_empty | #255 |
| inbox | inbox_register_review_source | POST /inbox/review-sources | not_exercised | 尚未为「Register a manual public review import source」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_import_review | POST /inbox/review-sources/:id/import | not_exercised | 尚未为「Import a public rating and its source link」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_reviews | GET /reviews | valid_empty | #256 |
| inbox | inbox_get_review_summary | GET /inbox/review-summary | response_only | #257 |
| inbox | inbox_handoff_review | POST /reviews/:id/handoff | not_exercised | 尚未为「Assign a public review for manual follow-up」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_get_review | GET /reviews/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_verify_review_reply | POST /reviews/:id/verify-reply | not_exercised | 尚未为「Record manually observed platform reply evidence」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_link_participant | POST /inbox/participants/:id/link-customer | not_exercised | 尚未为「Link a participant to an evidenced customer identity」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_unlink_participant | DELETE /inbox/participants/:id/link-customer | not_exercised | 尚未为「Remove a manually linked customer identity」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_update_note | PATCH /notes/:id | not_exercised | 尚未为「Manage an internal note」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_delete_note | DELETE /notes/:id | not_exercised | 尚未为「Manage an internal note」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_business_hours | GET /inbox/business-hours | valid_empty | #258 |
| inbox | inbox_get_business_hours | GET /inbox/business-hours/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_archive_business_hours | DELETE /inbox/business-hours/:id | not_exercised | 尚未为「Archive business_hours configuration」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_sla_policies | GET /inbox/sla-policies | valid_empty | #259 |
| inbox | inbox_get_sla_policy | GET /inbox/sla-policies/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_archive_sla_policy | DELETE /inbox/sla-policies/:id | not_exercised | 尚未为「Archive sla_policy configuration」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_auto_rules | GET /inbox/auto-rules | valid_empty | #260 |
| inbox | inbox_get_auto_rule | GET /inbox/auto-rules/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_archive_auto_rule | DELETE /inbox/auto-rules/:id | not_exercised | 尚未为「Archive auto_rule configuration」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_create_business_hours | POST /inbox/business-hours | not_exercised | 尚未为「Create a business-hours calendar」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_update_business_hours | PATCH /inbox/business-hours/:id | not_exercised | 尚未为「Update a calendar for future service deadlines」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_create_auto_rule | POST /inbox/auto-rules | not_exercised | 尚未为「Create a paused draft-only reply rule」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_enable_auto_rule | PATCH /inbox/auto-rules/:id | not_exercised | 尚未为「Edit, enable or pause a draft-only reply rule」准备有效请求、依赖状态和结果断言。 |
| inbox | inbox_list_auto_rule_runs | GET /inbox/auto-rules/:id/runs | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_list_auto_reply_review | GET /inbox/auto-reply-review | valid_empty | #261 |
| inbox | inbox_get_reply_draft | GET /reply-drafts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| inbox | inbox_get_conversation_sla | GET /conversations/:id/sla | response_only | #262 |
| creator | creators_search | GET /creators | fixture_reference_observed | #263 |
| creator | creators_get | GET /creators/:id | fixture_reference_observed | #264 |
| creator | creators_create | POST /creators | business_verified | #83 |
| creator | creators_update | PATCH /creators/:id | not_exercised | 尚未为「Update creator profile and contact preference」准备有效请求、依赖状态和结果断言。 |
| creator | creators_record_audience | POST /creators/:id/audience-observations | not_exercised | 尚未为「Record an audience market share with its source and observation time」准备有效请求、依赖状态和结果断言。 |
| creator | creators_list_contacts | GET /creators/:id/contacts | valid_empty | #265 |
| creator | creators_import_contacts | POST /creators/:id/contacts/import | not_exercised | 尚未为「Import creator contacts from CSV into a selected profile」准备有效请求、依赖状态和结果断言。 |
| creator | creators_list_associations | GET /creators/:id/associations | valid_empty | #266 |
| creator | creators_associate_profiles | POST /creators/:id/associations | not_exercised | 尚未为「Associate duplicate creator profiles with evidence」准备有效请求、依赖状态和结果断言。 |
| creator | creators_revoke_association | POST /creator-associations/:id/revoke | not_exercised | 尚未为「Undo an association and retain its evidence」准备有效请求、依赖状态和结果断言。 |
| creator | creators_link_account | POST /creators/:id/accounts | not_exercised | 尚未为「Link a self-reported or publicly verifiable account」准备有效请求、依赖状态和结果断言。 |
| creator | creators_verify_account | POST /creator-accounts/:id/verify | not_exercised | 尚未为「Record a manual creator account verification with supporting evidence」准备有效请求、依赖状态和结果断言。 |
| creator | collaborations_list | GET /collaborations | fixture_reference_observed | #267 |
| creator | collaborations_get | GET /collaborations/:id | fixture_reference_observed | #268 |
| creator | collaborations_create | POST /collaborations | business_verified | #116 |
| creator | collaborations_update | PATCH /collaborations/:id | not_exercised | 尚未为「Plan next actions, complete or cancel a collaboration」准备有效请求、依赖状态和结果断言。 |
| creator | outreach_draft | POST /collaborations/:id/outreach | not_exercised | 尚未为「Draft an invitation without sending it」准备有效请求、依赖状态和结果断言。 |
| creator | outreach_record_sent | POST /outreach/:id/record-sent | not_exercised | 尚未为「Record an invitation actually sent outside SmartSell」准备有效请求、依赖状态和结果断言。 |
| creator | outreach_record_reply | POST /collaborations/:id/outreach/reply | not_exercised | 尚未为「Record an actual creator reply」准备有效请求、依赖状态和结果断言。 |
| creator | collaborations_create_terms | POST /collaborations/:id/terms | not_exercised | 尚未为「Create an immutable collaboration terms revision」准备有效请求、依赖状态和结果断言。 |
| creator | collaborations_send_terms | POST /terms/:id/send | not_exercised | 尚未为「Record reference for the terms sent for signature」准备有效请求、依赖状态和结果断言。 |
| creator | deliverables_create | POST /collaborations/:id/deliverables | not_exercised | 尚未为「Request a collaboration deliverable」准备有效请求、依赖状态和结果断言。 |
| creator | deliverables_list | GET /collaborations/:id/deliverables | valid_empty | #269 |
| creator | deliverables_get | GET /deliverables/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | deliverables_change_deadline | PATCH /deliverables/:id/deadline | not_exercised | 尚未为「Update a deliverable deadline and flag the linked publication for schedule review」准备有效请求、依赖状态和结果断言。 |
| creator | deliverables_list_missing | GET /deliverables/missing | valid_empty | #270 |
| creator | deliverables_submit | POST /deliverables/:id/versions | not_exercised | 尚未为「Submit files or a source link for review」准备有效请求、依赖状态和结果断言。 |
| creator | deliverables_link_rights | POST /deliverables/:id/link-rights | not_exercised | 尚未为「Link AS grant references to deliverable assets」准备有效请求、依赖状态和结果断言。 |
| creator | creators_assign_affiliate | POST /collaborations/:id/affiliate-assignments | not_exercised | 尚未为「Assign an existing promotion code, short link or platform reference」准备有效请求、依赖状态和结果断言。 |
| creator | creators_list_shipments | GET /sample-shipments | valid_empty | #271 |
| creator | creators_create_shipment | POST /sample-shipments | not_exercised | 尚未为「Plan the shipment of sample items」准备有效请求、依赖状态和结果断言。 |
| creator | creators_update_shipment | PATCH /sample-shipments/:id | not_exercised | 尚未为「Record a manual logistics status and its reference」准备有效请求、依赖状态和结果断言。 |
| creator | creators_list_live_sessions | GET /live-sessions | valid_empty | #272 |
| creator | creators_get_live_session | GET /live-sessions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| creator | creators_plan_live_session | POST /live-sessions | not_exercised | 尚未为「Plan a creator live session and run sheet」准备有效请求、依赖状态和结果断言。 |
| creator | creators_update_live_session | PATCH /live-sessions/:id | not_exercised | 尚未为「Record live session scheduling and observed progress」准备有效请求、依赖状态和结果断言。 |
| creator | creators_plan_clip_reuse | POST /live-sessions/:id/clip-reuse | not_exercised | 尚未为「Plan reuse of a live clip after checking asset rights」准备有效请求、依赖状态和结果断言。 |
| creator | creators_list_evaluations | GET /campaigns/:id/creator-evaluations | valid_empty | #273 |
| creator | creators_evaluate | POST /campaigns/:id/creator-evaluations | not_exercised | 尚未为「Record scored dimensions and evidence for creator selection」准备有效请求、依赖状态和结果断言。 |
| creator | creators_override_evaluation | POST /creator-evaluations/:id/overrides | not_exercised | 尚未为「Record a human evaluation override with an audit trail」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_list | GET /commission-entries | response_only | #274 |
| creator | commissions_reconcile_attribution | GET /collaborations/:id/attribution-reconciliation | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| creator | commissions_accrue | POST /commission-entries | not_exercised | 尚未为「Calculate commission for a paid order line」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_import | POST /commission-entries/import | not_exercised | 尚未为「Import an evidenced attribution to a paid order line」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_mature | POST /commission-entries/mature | not_exercised | 尚未为「Mature observed commissions」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_reverse | POST /commission-entries/:id/reverse | not_exercised | 尚未为「Append a refund or cancellation adjustment」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_record_platform_settlement | POST /commission-entries/:id/platform-settlement | not_exercised | 尚未为「Record external platform settlement evidence」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_list_batches | GET /settlement-batches | valid_empty | #275 |
| creator | commissions_create_batch | POST /settlement-batches | not_exercised | 尚未为「Submit a self-settled commission batch for approval」准备有效请求、依赖状态和结果断言。 |
| creator | commissions_batch_cancel | POST /settlement-batches/:id/cancel | not_exercised | 尚未为「Cancel a batch and release its entries」准备有效请求、依赖状态和结果断言。 |
| traffic | links_list | GET /short-links | valid_empty | #276 |
| traffic | links_create | POST /short-links | not_exercised | 尚未为「Create a tracked short link」准备有效请求、依赖状态和结果断言。 |
| traffic | links_get | GET /short-links/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | links_update | PATCH /short-links/:id | not_exercised | 尚未为「Pause or archive a short link」准备有效请求、依赖状态和结果断言。 |
| traffic | links_change_destination | POST /short-links/:id/destination | not_exercised | 尚未为「Append a destination revision」准备有效请求、依赖状态和结果断言。 |
| traffic | links_get_stats | GET /short-links/:id/stats | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | links_batch | POST /short-links/batch | not_exercised | 尚未为「Preview or create a batch of short links」准备有效请求、依赖状态和结果断言。 |
| traffic | links_allowlist_list | GET /redirect-allowlist | valid_empty | #277 |
| traffic | links_domains_list | GET /link-domains | valid_empty | #278 |
| traffic | utm_list | GET /utm-templates | fixture_reference_observed | #279 |
| traffic | utm_create | POST /utm-templates | business_verified | #110 |
| traffic | utm_update | PATCH /utm-templates/:id | business_verified | #111 |
| traffic | utm_remove | DELETE /utm-templates/:id | not_exercised | 尚未为「Remove a UTM template」准备有效请求、依赖状态和结果断言。 |
| traffic | utm_build | POST /utm-templates/preview | not_exercised | 尚未为「Preview expanded UTM parameters」准备有效请求、依赖状态和结果断言。 |
| traffic | links_destinations_list | GET /landing-destinations | valid_empty | #280 |
| traffic | links_destination_create | POST /landing-destinations | not_exercised | 尚未为「Register an allowed landing destination」准备有效请求、依赖状态和结果断言。 |
| traffic | links_destination_update | PATCH /landing-destinations/:id | not_exercised | 尚未为「Update a registered destination」准备有效请求、依赖状态和结果断言。 |
| traffic | pages_list | GET /landing-pages | valid_empty | #281 |
| traffic | pages_create_draft | POST /landing-pages | not_exercised | 尚未为「Create a landing page draft」准备有效请求、依赖状态和结果断言。 |
| traffic | pages_versions | GET /landing-pages/:id/versions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | pages_create_version | POST /landing-pages/:id/versions | not_exercised | 尚未为「Append a page draft version」准备有效请求、依赖状态和结果断言。 |
| traffic | pages_unpublish | POST /landing-pages/:id/unpublish | not_exercised | 尚未为「Take a page offline」准备有效请求、依赖状态和结果断言。 |
| traffic | links_list_checks | GET /page-checks | valid_empty | #282 |
| traffic | links_probe | POST /page-checks/probe | not_exercised | 尚未为「Observe a registered HTTPS destination」准备有效请求、依赖状态和结果断言。 |
| traffic | links_check | POST /page-checks | not_exercised | 尚未为「Run local checks and record manual evidence」准备有效请求、依赖状态和结果断言。 |
| traffic | bio_list | GET /bio-pages | valid_empty | #283 |
| traffic | bio_create | POST /bio-pages | not_exercised | 尚未为「Create a bio page draft」准备有效请求、依赖状态和结果断言。 |
| traffic | bio_publish | POST /bio-pages/:id/publish | not_exercised | 尚未为「Publish or take a bio page offline」准备有效请求、依赖状态和结果断言。 |
| traffic | bio_items | GET /bio-pages/:id/items | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | pages_experiment_report | GET /landing-pages/:id/experiment | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | forms_list | GET /forms | valid_empty | #284 |
| traffic | forms_create | POST /forms | not_exercised | 尚未为「Create a form draft」准备有效请求、依赖状态和结果断言。 |
| traffic | forms_versions | GET /forms/:id/versions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | forms_create_version | POST /forms/:id/versions | not_exercised | 尚未为「Append an immutable form version」准备有效请求、依赖状态和结果断言。 |
| traffic | forms_deactivate | POST /forms/:id/deactivate | not_exercised | 尚未为「Stop accepting form submissions」准备有效请求、依赖状态和结果断言。 |
| traffic | leads_list | GET /leads | valid_empty | #285 |
| traffic | leads_get | GET /leads/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| traffic | leads_update | PATCH /leads/:id | not_exercised | 尚未为「Assign or follow up on a lead」准备有效请求、依赖状态和结果断言。 |
| traffic | leads_handoff | POST /leads/:id/handoff | not_exercised | 尚未为「Queue a consent-checked CRM handoff」准备有效请求、依赖状态和结果断言。 |
| traffic | leads_record_handoff_receipt | POST /leads/:id/handoff/receipt | not_exercised | 尚未为「Record CRM provider readback for the current handoff」准备有效请求、依赖状态和结果断言。 |
| traffic | leads_export | POST /leads/export | not_exercised | 尚未为「Export masked lead records with audit event」准备有效请求、依赖状态和结果断言。 |
| ads | ads_list_accounts | GET /ad-accounts | business_verified | #103 |
| ads | ads_register_account | POST /ad-accounts | business_verified | #102 |
| ads | ads_update_account | PATCH /ad-accounts/:id | not_exercised | 尚未为「Update connection and spend cap references」准备有效请求、依赖状态和结果断言。 |
| ads | ads_import_report | POST /ad-accounts/:id/import | business_verified | #107 |
| ads | ads_list_entities | GET /ad-entities | fixture_reference_observed | #286 |
| ads | ads_query_performance | GET /ads/performance | not_exercised | 缺少该视图的查询条件或业务断言。 |
| ads | ads_list_creatives | GET /ad-creatives | fixture_reference_observed | #287 |
| ads | ads_create_creative | POST /ad-creatives | business_verified | #108 |
| ads | ads_list_creative_variants | GET /ad-creatives/:id/variants | valid_empty | #288 |
| ads | ads_create_creative_variant | POST /ad-creatives/:id/variants | not_exercised | 尚未为「Append an immutable ad creative variant」准备有效请求、依赖状态和结果断言。 |
| ads | ads_archive_creative | DELETE /ad-creatives/:id | business_verified | #109 |
| ads | ads_list_proposals | GET /ad-proposals | valid_empty | #289 |
| ads | ads_create_proposal | POST /ad-proposals | not_exercised | 尚未为「Create an immutable advertising change proposal revision」准备有效请求、依赖状态和结果断言。 |
| ads | ads_get_proposal | GET /ad-proposals/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ads | ads_revise_proposal | POST /ad-proposals/:id/revisions | not_exercised | 尚未为「Append a revision and invalidate earlier approval」准备有效请求、依赖状态和结果断言。 |
| ads | ads_submit_proposal | POST /ad-proposals/:id/submit-approval | not_exercised | 尚未为「Submit the current revision for approval」准备有效请求、依赖状态和结果断言。 |
| ads | ads_export_proposal | POST /ad-proposals/:id/export | not_exercised | 尚未为「Export a revision-bound manual operation package」准备有效请求、依赖状态和结果断言。 |
| ads | ads_record_manual_operation | POST /ad-proposals/:id/manual-operations | not_exercised | 尚未为「Record an approved manual handoff with no provider execution」准备有效请求、依赖状态和结果断言。 |
| ads | ads_get_operation | GET /ad-operations/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| ads | ads_list_adjustments | GET /adjustment-suggestions | valid_empty | #290 |
| ads | ads_suggest_adjustments | POST /adjustment-suggestions | not_exercised | 尚未为「Record a reviewable advertising adjustment with evidence」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_set_local_esp | PUT /esp-accounts/:id/local-config | not_exercised | 尚未为「Authorize the local email ESP with an explicit test-address allowlist」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_sync_local_esp_suppressions | POST /esp-accounts/:id/sync-suppressions | not_exercised | 尚未为「Read opt-outs and suppressions from the authorized local ESP」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_reconcile_local_esp | POST /esp-campaigns/:id/local-reconcile | not_exercised | 尚未为「Read an independent ESP receipt and save actual delivery members」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_list_esp_attempts | GET /esp-campaigns/:id/attempts | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_read_local_esp_flow | POST /esp-flows/:id/local-readback | not_exercised | 尚未为「Read provider flow state independently of the campaign lifecycle」准备有效请求、依赖状态和结果断言。 |
| lifecycle | customers_list | GET /customers | fixture_reference_observed | #291 |
| lifecycle | customers_create | POST /customers | business_verified | #84 |
| lifecycle | customers_get | GET /customers/:id | fixture_reference_observed | #292 |
| lifecycle | customers_link_identity | POST /customers/:id/identities | not_exercised | 尚未为「Link a pseudonymous identity with evidence」准备有效请求、依赖状态和结果断言。 |
| lifecycle | customers_unlink_identity | DELETE /customer-identities/:id | not_exercised | 尚未为「Unlink a customer identity」准备有效请求、依赖状态和结果断言。 |
| lifecycle | customers_merge | POST /customers/merge | not_exercised | 尚未为「Merge customer profiles with manual evidence」准备有效请求、依赖状态和结果断言。 |
| lifecycle | customers_revert_merge | POST /customer-merges/:id/revert | not_exercised | 尚未为「Restore customer profile and original identity ownership」准备有效请求、依赖状态和结果断言。 |
| lifecycle | customers_get_consents | GET /customers/:id/consents | response_only | #293 |
| lifecycle | lifecycle_record_consent | POST /customers/:id/consents | not_exercised | 尚未为「Append an evidence-backed consent event」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_list_consent_conflicts | GET /consent-conflicts | valid_empty | #294 |
| lifecycle | lifecycle_list_consent_texts | GET /consent-texts | fixture_reference_observed | #295 |
| lifecycle | lifecycle_get_consent_text | GET /consent-texts/:id | business_verified | #113 |
| lifecycle | lifecycle_create_consent_text | POST /consent-texts | business_verified | #112 |
| lifecycle | lifecycle_record_suppression | POST /lifecycle/suppressions | not_exercised | 尚未为「Record a source-specific channel suppression」准备有效请求、依赖状态和结果断言。 |
| lifecycle | segments_list | GET /segments | fixture_reference_observed | #296 |
| lifecycle | segments_get | GET /segments/:id | business_verified | #115 |
| lifecycle | segments_create | POST /segments | business_verified | #114 |
| lifecycle | segments_create_version | POST /segments/:id/versions | not_exercised | 尚未为「Append an immutable segment definition」准备有效请求、依赖状态和结果断言。 |
| lifecycle | segments_preview | POST /segments/:id/preview | not_exercised | 尚未为「Preview audience with aggregate exclusion counts」准备有效请求、依赖状态和结果断言。 |
| lifecycle | segments_list_snapshots | GET /segments/:id/snapshots | valid_empty | #297 |
| lifecycle | lifecycle_list_esp_accounts | GET /esp-accounts | valid_empty | #298 |
| lifecycle | lifecycle_create_esp_account | POST /esp-accounts | not_exercised | 尚未为「Register an ESP reference for a channel」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_list_campaigns | GET /esp-campaigns | valid_empty | #299 |
| lifecycle | lifecycle_create_campaign_draft | POST /esp-campaigns | not_exercised | 尚未为「Create a local lifecycle campaign draft」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_get_campaign | GET /esp-campaigns/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| lifecycle | lifecycle_import_campaign_send | POST /esp-campaigns/:id/send-observation | not_exercised | 尚未为「Import actual audience size from an ESP send report」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_export_campaign | POST /esp-campaigns/:id/export | not_exercised | 尚未为「Export local campaign configuration and fresh audience estimate」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_cancel_campaign | POST /esp-campaigns/:id/cancel | not_exercised | 尚未为「Cancel a local draft campaign」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_list_flows | GET /esp-flows | valid_empty | #300 |
| lifecycle | lifecycle_create_flow_draft | POST /esp-flows | not_exercised | 尚未为「Save a local flow draft」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_change_flow_status | POST /esp-flows/:id/status | not_exercised | 尚未为「Change local review mode or require ESP capability」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_get_health | GET /lifecycle/health | response_only | #301 |
| lifecycle | lifecycle_import_health | POST /lifecycle/health | not_exercised | 尚未为「Import observed ESP delivery health counts」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_create_frequency_rule | POST /lifecycle/frequency-rules | not_exercised | 尚未为「Add an observed-send frequency cap」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_import_send_observation | POST /lifecycle/send-observations | not_exercised | 尚未为「Record an observed ESP send for frequency accounting」准备有效请求、依赖状态和结果断言。 |
| lifecycle | lifecycle_request_customer_data | POST /customers/:id/erasure-requests | not_exercised | 尚未为「Open an export or erasure request」准备有效请求、依赖状态和结果断言。 |
| analytics | metric_definitions_get | GET /metric-definitions | response_only | #302 |
| analytics | metric_definition_get | GET /metric-definitions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | revise_metric_definition | POST /metric-definitions | not_exercised | 尚未为「Create or revise a workspace metric definition」准备有效请求、依赖状态和结果断言。 |
| analytics | analytics_record_observations | POST /metrics/observations | not_exercised | 尚未为「Import normalized metric observations」准备有效请求、依赖状态和结果断言。 |
| analytics | metrics_query | POST /metrics/query | not_exercised | 尚未为「Query metrics with their coverage and evidence」准备有效请求、依赖状态和结果断言。 |
| analytics | posts_performance_get | GET /performance/posts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | post_performance_history | GET /performance/posts/:id/history | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | accounts_performance_get | GET /performance/accounts | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | links_performance_get | GET /performance/links | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | reports_list | GET /reports | valid_empty | #303 |
| analytics | reports_create | POST /reports | not_exercised | 尚未为「Create a report definition」准备有效请求、依赖状态和结果断言。 |
| analytics | report_definition_get | GET /reports/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | reports_update | PATCH /reports/:id | not_exercised | 尚未为「Edit a report definition」准备有效请求、依赖状态和结果断言。 |
| analytics | report_versions_list | GET /reports/:id/versions | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | reports_generate_version | POST /reports/:id/versions | not_exercised | 尚未为「Queue generation of a frozen report draft」准备有效请求、依赖状态和结果断言。 |
| analytics | reports_get | GET /report-versions/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | report_provenance_get | GET /report-versions/:id/provenance | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | report_commerce_provenance_get | GET /report-versions/:id/commerce-provenance | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | reports_update_narrative | PATCH /report-versions/:id/narrative | not_exercised | 尚未为「Edit only a draft narrative」准备有效请求、依赖状态和结果断言。 |
| analytics | reports_finalize | POST /report-versions/:id/finalize | not_exercised | 尚未为「Finalize and lock a report snapshot」准备有效请求、依赖状态和结果断言。 |
| analytics | reports_export | POST /report-versions/:id/export | not_exercised | 尚未为「Export a finalized report snapshot」准备有效请求、依赖状态和结果断言。 |
| analytics | reports_queue_export | POST /reports/:id/versions/:n/export | not_exercised | 尚未为「Queue a file for this finalized report version」准备有效请求、依赖状态和结果断言。 |
| analytics | report_exports_list | GET /reports/:id/versions/:n/exports | not_exercised | 需单独验收下载、导出、探测或对账入口，并准备对应的授权、文件或来源记录。 |
| analytics | report_templates_list | GET /report-templates | valid_empty | #304 |
| analytics | report_templates_create | POST /report-templates | not_exercised | 尚未为「Create a reusable report template」准备有效请求、依赖状态和结果断言。 |
| analytics | reports_generate_due | POST /reports/scheduled/generate | not_exercised | 尚未为「Generate drafts for due report schedules」准备有效请求、依赖状态和结果断言。 |
| analytics | attribution_explain | GET /attribution/orders/:id/explain | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | attribution_query | POST /attribution/query | not_exercised | 尚未为「Query each model’s credit and unattributed amounts separately」准备有效请求、依赖状态和结果断言。 |
| analytics | attribution_models_get | GET /attribution-models | response_only | #305 |
| analytics | attribution_models_revise | PATCH /attribution-models/:id | not_exercised | 尚未为「Create a new revision of a model window」准备有效请求、依赖状态和结果断言。 |
| analytics | attribution_run | POST /attribution/runs | not_exercised | 尚未为「Recompute order attribution from workspace evidence」准备有效请求、依赖状态和结果断言。 |
| analytics | attribution_record_reported | POST /attribution/reported | not_exercised | 尚未为「Import authorized provider-reported credits」准备有效请求、依赖状态和结果断言。 |
| analytics | revenue_query | GET /revenue/daily | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | revenue_reconciliation_list | GET /revenue/reconciliation | valid_empty | #306 |
| analytics | revenue_reconcile | POST /revenue/reconciliation | not_exercised | 尚未为「Reconcile observed order totals against an authorized source total」准备有效请求、依赖状态和结果断言。 |
| analytics | unit_costs_import | POST /unit-costs/import | not_exercised | 尚未为「Import normalized unit costs」准备有效请求、依赖状态和结果断言。 |
| analytics | contribution_record_inputs | POST /contribution/inputs | not_exercised | 尚未为「Record normalized contribution evidence」准备有效请求、依赖状态和结果断言。 |
| analytics | contribution_query | GET /contribution | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | cohorts_list | GET /cohorts | fixture_reference_observed | #307 |
| analytics | cohort_get | GET /cohorts/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | experiments_list | GET /experiments | valid_empty | #308 |
| analytics | experiments_create | POST /experiments | not_exercised | 尚未为「Register an experiment design」准备有效请求、依赖状态和结果断言。 |
| analytics | experiment_get | GET /experiments/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| analytics | experiment_update | PATCH /experiments/:id | not_exercised | 尚未为「Edit an experiment before starting it」准备有效请求、依赖状态和结果断言。 |
| analytics | experiment_stop | POST /experiments/:id/stop | not_exercised | 尚未为「Transition an experiment to stop」准备有效请求、依赖状态和结果断言。 |
| analytics | experiment_conclude | POST /experiments/:id/conclude | not_exercised | 尚未为「Transition an experiment to conclude」准备有效请求、依赖状态和结果断言。 |
| analytics | experiment_archive | POST /experiments/:id/archive | not_exercised | 尚未为「Transition an experiment to archive」准备有效请求、依赖状态和结果断言。 |
| analytics | experiment_record_result | POST /experiments/:id/results | not_exercised | 尚未为「Store an immutable experiment evidence snapshot」准备有效请求、依赖状态和结果断言。 |
| analytics | audience_insights_get | GET /audience-insights | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | audience_insights_record | POST /audience-insights | not_exercised | 尚未为「Ingest normalized audience snapshots」准备有效请求、依赖状态和结果断言。 |
| analytics | posting_time_get | GET /posting-time-recommendations | not_exercised | 缺少该视图的查询条件或业务断言。 |
| analytics | posting_time_apply | POST /posting-time-recommendations/:id/apply | not_exercised | 尚未为「Apply suggestions as planning slot templates」准备有效请求、依赖状态和结果断言。 |
| analytics | posting_time_suggest | POST /posting-time-recommendations | not_exercised | 尚未为「Calculate candidate publishing hours for comparable posts」准备有效请求、依赖状态和结果断言。 |
| agent | agent_jobs_list | GET /agent-jobs | business_verified | #71 |
| agent | agent_jobs_get | GET /agent-jobs/:id | business_verified | #75 |
| agent | agent_jobs_claim | POST /agent-jobs/:id/claim | business_verified | #72 |
| agent | agent_jobs_heartbeat | POST /agent-jobs/:id/heartbeat | business_verified | #73 |
| agent | agent_jobs_handoff | POST /agent-jobs/:id/handoff | not_exercised | 尚未为「handoff an Agent job」准备有效请求、依赖状态和结果断言。 |
| agent | agent_jobs_submit_result | POST /agent-jobs/:id/submit | business_verified | #74 |
| agent | agent_jobs_confirm_cancel | POST /agent-jobs/:id/confirm-cancel | not_exercised | 尚未为「confirm-cancel an Agent job」准备有效请求、依赖状态和结果断言。 |
| agent | jobs_get | GET /jobs/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| agent | jobs_cancel | POST /jobs/:id/cancel | not_exercised | 尚未为「Request durable operation cancellation」准备有效请求、依赖状态和结果断言。 |
| agent | change_sets_create | POST /change-sets | business_verified | #70 |
| agent | change_sets_get | GET /change-sets/:id | fixture_reference_observed | #309 |
| agent | workflow_templates_list | GET /workflow-templates | valid_empty | #310 |
| agent | workflow_templates_get | GET /workflow-templates/:id | not_exercised | 缺少 :id 对应的可验证资源或查询条件。 |
| agent | agent_preview_context | GET /brands/:brandId/agent-context | fixture_reference_observed | #311 |
| agent | desktop_request_capability | POST /desktop-capability-requests | boundary_confirmed | #60 |
| agent | desktop_get_capability_request | GET /desktop-capability-requests/:id | boundary_confirmed | #61 |
| ops | ops_get_health | GET /admin/workspace-health | response_only | #312 |
| ops | audit_query | GET /admin/audit-events | valid_empty | #313 |
| files | file_begin_upload | POST /files/uploads | business_verified | #9 |
| files | file_complete_upload | POST /files/uploads/:id/complete | business_verified | #10 |
| files | file_get | GET /files/:id | business_verified | #11 |
