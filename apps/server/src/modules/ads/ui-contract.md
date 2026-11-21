# Paid ads workbench contract

Send actions to `POST /api/v1/workspaces/:wid/commands/ads/:action` with an `Idempotency-Key`. Use the latest returned entity `version` as `expected_version`. For a proposal also pass the current revision's `data.content_hash` as `revision_hash`. Commands read and write workspace records transactionally. Use the scoped list and detail commands for the ads workbench because the generic records endpoint's workspace-level metadata projection cannot enforce account grants.

| Design ID | Screen | Scoped read action and response |
| --- | --- | --- |
| AD01 | `/w/:ws/ads/accounts` | `list_accounts` → `ad_account` rows with caller `actions`, `max_spend_minor`, and current `read_capability` / `write_capability`. No other actors' grants are returned. |
| AD02 | `/w/:ws/ads` | `list_entities` with `ad_account_id`, optional `campaign_id` → `ad_entity` rows. `query_performance` with `ad_account_id`, `start_date`, `end_date`, optional `campaign_id` / `entity_id` → time zone, currency, `as_of`, analytics observations, and coverage/pacing totals. |
| AD03 | `/w/:ws/ads/creatives` | `list_creatives` with `ad_account_id`, optional `campaign_id` → `ad_creative` rows and `ad_creative_variant` rows with `usage_history`. |
| AD04 | `/w/:ws/ads/proposals/:id` | `list_proposals` with `ad_account_id`, optional `campaign_id`. `get_proposal` with `id` → proposal, immutable revisions, previews, reviews, exports, and operations. |
| AD05 | `/w/:ws/ads/operations` | `get_operation` with `id` → operation, attempts, results, reconciliations, and core evidence. |
| AD06 | `/w/:ws/ads/experiments` | `list_adjustments` with `ad_account_id` → suggestions. `get_performance_snapshot` with `id` → saved performance scope and observation IDs. |

## Account setup and reporting

`register_account` accepts `brand_id`, `provider`, `external_account_id`, `currency`, `timezone`, `spend_cap_minor`, and optional `status_snapshot`, `connection_id`, `read_capability_id`, `write_capability_id`, `permissions`. `update_account` accepts `id`, `expected_version` and editable capability references, status, or cap. `set_account_permissions` accepts `id`, `expected_version`, and the complete replacement `permissions` array. Each grant contains `actor_id`, `actions`, optional `expires_at`, and `max_spend_minor` for `spend`. Workspace administrator privileges allow setup. Scoped actions still require an effective grant. A valid connection must have a dedicated advertising purpose and matching provider and brand. Read and write capability references are resolved independently. The local manual workflow uses account action grants.

`record_entity_snapshot` accepts `ad_account_id`, `level`, `external_id`, `name`, `status_snapshot`, `observed_at`, and `source` (`manual` or `import`). Optional fields include `source_ref`, `campaign_id`, `parent_entity_id`, `objective`, `budget_snapshot` (`amount_minor`, `currency`, `type`), `ad_creative_variant_id`, and `platform_post_id`. Group and ad records require a parent at the previous level. Updating a snapshot requires `expected_version` and a newer observation.

`import_ad_report` takes `ad_account_id` and `import_batch_id` of a merged `ad_report` ingestion batch. The batch must be scoped to that account or belong to the caller. Register ad structure before importing its external IDs. Current staged import supports spend. Other observations arrive through analytics. `save_performance_snapshot` accepts the performance query fields and requires both `read` and `export`. It saves observation references for adjustments and emits an over-budget event once per account, campaign, time range, and hour.

Render `totals.observed_spend_minor: null` as unknown. `missing_dates`, `coverage`, and `is_partial` qualify the sum for the requested period. `latest_spend_observed_at` identifies the latest contributing fact. `budget_by_currency` preserves separate allocations and `pacing_ratio` uses only the matching currency. Display observation definitions, source, dates, time zone, and availability alongside native platform amounts.

## Creative and proposal actions

`create_creative` accepts `ad_account_id`, `campaign_id`, `origin`, `origin_ref` when origin is `asset`, `deliverable`, or `platform_post`, and optional `creator_identity_required`. `create_creative_variant` accepts `creative_id`, `headline`, `primary_text`, `cta`, `rendition_ids`, `locale`, and `aspect_ratio`. `archive_creative` takes `id` and `expected_version`.

`create_proposal` accepts `ad_account_id`, `campaign_id`, `name`, optional `experiment_id`, and `revision`. The revision includes `objective`, `market_ids`, `placements`, `schedule: {start_at,end_at,timezone}`, `budget: {type,amount_minor,currency,cap_minor}`, and `creative_variant_ids`. Optional fields are `product_variant_ids`, `audience_spec`, `estimates` with `{metric,value,source,currency?}`, `platform_options`, and `operation: {kind,target_entity_id?}` (default `launch`). Keep estimate values labeled even when the inputs originate from historical observations. The proposal's actual spend stays unknown in preview.

- `revise_proposal` accepts `id`, `expected_version`, `revision_hash`, and complete replacement `revision`. It supersedes the old current revision and invalidates its approval.
- `preview_proposal` accepts `id`, `expected_version`, and `revision_hash`. Show `rights_check`, `unsupported_fields`, `blockers`, `operation.spend_delta_minor`, and distinct `planned_budget` and `estimates`.
- `submit_proposal` adds `preview_id`. The current preview must still match, and blockers must be resolved.
- `review_proposal` adds `recommendation` (`approve` or `reject`) and `note`. Proposal authors and the submitter cannot review or decide.
- `approve_proposal` requires a favorable independent review and may include `note`. `reject_proposal` requires `note`. Approval expires after seven days or at schedule end, whichever is earlier. Approvers need `spend` within their cap for a higher-spend action.
- `export_proposal` accepts `id`, `expected_version`, and `revision_hash` of an approved proposal. It returns `ad_proposal_export` with `checklist` and a downloadable `csv` string.

## Manual operation timeline

`prepare_operation` accepts `proposal_id`, `expected_version`, `revision_hash`, and body `idempotency_key`. It checks the approval, rights, target version, role, account permissions, and spend ceilings. It creates `ad_operation` in `awaiting_manual_result` and an `ad_operation_attempt` with a stable `client_reference` and per-attempt `fencing_token`. Operation intent comes from the approved revision. The workbench displays the manual checklist and external reference.

`record_operation_result` takes `id`, `expected_version`, `fencing_token`, `outcome` (`accepted`, `failed`, or `outcome_unknown`), `external_id` for accepted results, optional `result_entity_id` / `error_class`, and `evidence: {reference,note,source,observed_at}`. `source` is `platform_console`, `platform_receipt`, or `report_export`. It enters `awaiting_reconciliation`.

`reconcile_operation` takes `id`, `expected_version`, `result_id`, `decision` (`matched`, `confirmed_not_applied`, or `inconclusive`), `evidence` with a separate reference, and `observations`. The caller needs `reconcile` and must differ from the preparer and result recorder. A matched readback takes `external_account_id`, `external_id`, `accepted_at`, `platform_review`, and `delivery`. Verified delivery requires `result_entity_id` and readback `budget: {type,currency,amount_minor}` for funded actions and budget updates. `first_spend_at`, when known, is a distinct observation. Only a verified launch sets the proposal to `launched`.

If spend first appears after verification, `record_first_spend` accepts `id`, `expected_version`, `observation_id`, `first_spend_at`, and `evidence`. An independent reconciler links a positive analytics spend observation for the verified entity and currency.

An unknown outcome can receive a newer result. To offer a retry, require independent confirmation of non-application with `observations.client_reference` and `retry: true`. `retry_operation` accepts `id`, `expected_version`, and `revision_hash`. It uses a fresh attempt token and keeps the same client reference. The workbench may show `accepted`, `platform_review`, `outcome_unknown`, `retryable`, `failed`, `verified`, and `active_verified` separately.

## Adjustment suggestions

`create_adjustment` takes `proposal_id`, `revision_hash`, `target_entity_id`, `kind` (`pause`, `scale`, `reallocate`, or `swap_creative`), `rationale`, `evidence_refs` (saved performance snapshots), `minimum_sample_size`, `concurrent_promotion`, and optional `ai_generated`. Present inventory, rights, budget, sample size, and limitations with the evidence.

`decide_adjustment` accepts `id`, `expected_version`, `decision`, and `note`. Accepted or modified suggestions also require `proposal_expected_version`, `revision_hash`, and the replacement `revision` with the matching operation and target. The resulting revision starts in `draft` and requires the standard preview and approval sequence.
