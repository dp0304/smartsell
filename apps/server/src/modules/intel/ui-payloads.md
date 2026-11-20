# Intel UI payloads

`?` marks optional payload fields. `expected_version` is the version on the most recently returned entity. Period end times are exclusive. Supply timezone offsets on timestamps.

| Feature | Action | Kind | Payload fields |
|---|---|---|---|
| LI01 watchlist | `create_watch_target` | `watch_target` | `name`, `target_type`, `query`, `data_mode`, `data_source_id?`, `platform?`, `brand_id?`, `market_ids?`, `owner_user_id?`, `refresh_frequency?`, `coverage_note?`, `tags?` |
| LI01 watchlist | `update_watch_target` | `watch_target` | `id`, `expected_version`, any create field, `status?: active\|paused\|archived` |
| LI01 watch detail | `watch_target_detail` | `watch_target` | `id` |
| LI02 snapshots | `record_observation` | `observation` | `watch_target_id`, `subject_type`, `url`, `observed_at`, `access: public\|authorized`, `collection_authorized: true`, `metrics`, `external_id?`, `published_at?`, `attributes?`, `note?` |
| LI02 timeline | `observation_timeline` | `observation` | `watch_target_id`, `subject_type?`, `from?`, `to?`, `missing_metric?` |
| LI02 comparison | `compare_observations` | `observation` | `watch_target_ids[]`, `metric`, `age_bucket: 0-24h\|1-7d\|7-30d`, `from`, `to` |
| LI03 research | `create_research_board` | `research_board` | `title`, `kind: research\|creative\|product_opportunity`, `description?`, `brand_id?`, `campaign_id?` |
| LI03 research | `update_research_board` | `research_board` | `id`, `expected_version`, `title?`, `description?`, `status?: active\|archived` |
| LI03 board detail | `research_board_detail` | `research_board`, `research_item` | `id` |
| LI03 evidence | `add_research_item` | `research_item` | `board_id`, `item_type`, `ref_id?`, `url?`, `title?`, `body?`, `stance?`, `labels?[]`, `lane?`, `position?`, `authorship?: human\|agent`, `evidence_refs?[]` |
| LI03 evidence | `update_research_item` | `research_item` | `id`, `expected_version`, `title?`, `url?`, `body?`, `stance?`, `labels?[]`, `lane?`, `position?`, `evidence_refs?[]`, `status?: active\|archived` |
| LI03 evidence | `search_research` | `observation`, `research_item`, `creative_reference` | `keyword`, `watch_target_id?` |
| LI03 trend | `create_topic` | `topic` | `name`, `keywords[]`, `watch_target_ids[]`, `market_id?`, `language?` |
| LI03 trend | `compute_topic_trend` | `topic_trend_point` | `topic_id`, `period`, `comparison_period`, `metric` |
| LI03–04 handoff | `convert_research_item` | `research_handoff` | `id` (item), `expected_version`, `destination: content.idea\|campaign.brief`, `summary`, `target_id?` |
| LI03–04, LI07 handoff | `link_research_handoff` | `research_handoff` | `id` (handoff), `expected_version`, `target_id` |
| LI04 creative | `create_creative_reference` | `creative_reference` | `url`, `platform?`, `external_id?`, `watch_target_id?`, `structure?`, `structure_source?: human\|agent\|mixed`, `agent_job_id?`, `model_ref?`, `observation_id?`, `tags?[]` |
| LI04 creative | `annotate_creative_reference` | `creative_reference` | `id`, `expected_version`, any create field except `url` |
| LI04 creative | `list_creative_references` | `creative_reference` | `watch_target_id?`, `tag?` |
| LI05 candidate | `create_product_candidate` | `product_candidate` | `name`, `market_ids?[]`, `price_range?`, `supply_notes?`, `estimated_cost?`, `actual_quote?` |
| LI05 candidate | `update_product_candidate` | `product_candidate` | `id`, `expected_version`, optional create fields |
| LI05 candidate | `product_candidate_detail` | `product_candidate`, `candidate_score` | `id` |
| LI05 candidate | `score_product_candidate` | `candidate_score` | `candidate_id`, `expected_version` (candidate), `dimension`, `score` (0–100), `uncertainty: low\|medium\|high\|unknown`, `evidence_item_ids[]`, `authorship?: human\|agent`, `is_estimate?` (boolean) |
| LI05 decision | `transition_product_candidate` | `product_candidate` | `id`, `expected_version`, `status: researching\|validating\|accepted\|rejected\|parked`, `reason?` (required for accepted/rejected), `linked_product_id?` or `draft_store_id?` (acceptance), `new_evidence_item_ids?[]` (reopening) |
| LI06 alerts | `create_alert_rule` | `alert_rule` | `name`, `watch_target_ids[]`, `condition`, `min_freshness?` (seconds), `recipients?[]` |
| LI06 alerts | `update_alert_rule` | `alert_rule` | `id`, `expected_version`, optional create fields, `status?: active\|paused` |
| LI06 alerts | `evaluate_alert_rule` | `alert` | `rule_id` |
| LI06 alerts | `update_alert` | `alert` | `id`, `expected_version`, `status: acknowledged\|assigned\|resolved\|dismissed`, `assignee?` (required for assignment), `reason?` (required for dismissal) |
| LI06 digest | `generate_research_digest` | `research_digest` | `title`, `period`, `fact_item_ids[]`, `recommendation_item_ids[]` |
| LI07 listening | `record_mention` | `mention` | `watch_target_id`, `url`, `text_excerpt`, `observed_at`, `access: public`, `collection_authorized: true`, `published_at?`, `external_id?`, `author_ref?` |
| LI07 listening | `label_mention` | `mention_label` | `mention_id`, `expected_version` (mention), `label_type: sentiment\|intent\|topic`, `value`, `confidence?` (0–1) |
| LI07 listening | `query_mentions` | `mention` | `watch_target_ids[]`, `period`, `keyword?` |
| LI07 escalation | `escalate_mention` | `research_handoff` | `id` (mention), `expected_version`, `destination: inbox.case\|workspace.work_item`, `summary`, `target_id?` |
| LI03 topics | `list_topics` | `topic` | `market_id?`, `language?` |
| LI03 trend history | `list_topic_trends` | `topic_trend_point` | `topic_id` |
| LI06 alert center | `list_alerts` | `alert` | `rule_id?`, `status?` |
| LI07 label history | `mention_labels` | `mention_label` | `mention_id` |
| LI07 share of voice | `compute_share_of_voice` | `share_of_voice_snapshot` | `watch_target_ids[]`, `period`, `keyword?` |

| Nested field | Payload |
|---|---|
| `period`, `comparison_period` | `{ from, to }` |
| `target_type` | `competitor_account`, `keyword`, `hashtag`, `category`, `product_url`, `store`, `creator_account` |
| `query` | `{ handle?, url?, keywords?[], exclude?[], language? }`. Account and store targets require a handle or URL, product URLs require a URL, and keyword/hashtag/category targets require keywords. |
| `data_mode` | `manual`, `import`, `vendor`, `official_api`. Source-backed target edits require an owner or admin. Vendor and official entries arrive through the internal ingest sink. |
| `subject_type` | `post`, `account`, `product`, `video`, `live` |
| `metrics` | Named entries for `likes`, `comments`, `shares`, `views`, `followers`, `impressions`, `reach`, `sales`, `units_sold`, `price`, `gmv`, and `commission_rate`. Entries are `{ availability, value }` or `{ availability, amount_minor, currency }` for price and GMV. For `source_not_provided`, `not_collected`, `no_permission`, `not_applicable` and `sync_failed`, send `{ availability }` only. `estimated` requires covered vendor data. |
| `attributes` | `{ title?, format?, duration_s?, description?, language? }` |
| `item_type`, `stance` | `link`, `observation`, `note`, `creative_reference`, `mention`, `candidate`. Stances are `evidence`, `counter_example`, `question`, `demand`, `hypothesis`. For notes send `body`. For links send `url`. For other item types send `ref_id`. |
| `structure` | `{ hook?, topic?, duration_s?, format?, presentation?, cta?, interaction_question? }`. Agent and mixed annotations require `agent_job_id` and `model_ref`. |
| `dimension` | `demand_evidence`, `competition`, `product_fit`, `supply_feasibility` |
| `price_range`, `estimated_cost`, `actual_quote` | `{ min_minor, max_minor, currency }` for ranges and `{ amount_minor, currency }` for single amounts. |
| `condition` | `{ type: 'new_post' }`, `{ type: 'engagement_increase', metric, minimum_delta }`, `{ type: 'price_change', minimum_delta }`, or `{ type: 'keyword_match', keyword }`. Engagement metrics are `likes`, `comments`, `views`, `shares`. |
| Mention `value` | Sentiment accepts `positive`, `neutral`, `negative`, `uncertain`. Intent accepts `discussion`, `purchase_intent`, `support`, `complaint`, `uncertain`. Topic accepts a text label. |
