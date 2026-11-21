# Commerce workbench contract

Use the existing workspace command endpoint with module `commerce` and an `Idempotency-Key`. Records below use the `Entity` envelope. Send snake_case payloads. Use fresh keys for intentional repeats and render the command list returned for the current role. An `expected_version` is the version returned by the latest response for that resource.

## PC01 · Shops and reports

| Action | Payload | Result or record kind |
|---|---|---|
| `create_store` | `provider`, `name`, `default_currency`, `default_locale`, optional `brand_id`, `external_store_id`, `region` | `store` in `import_only` |
| `set_store_status` | `store_id`, `expected_version`, `status`, optional `connection_id`, `status_reason`, `snapshot_completed` | `store` |
| `import_template` | `provider`, `template_key` | `columns`, downloadable header-only `csv`, and phase |
| `preview_import` | `store_id`, `template_key`, `csv`, optional `options.timezone` | Batch summary with `batch_id`, `version`, `status`, `rows`, `issues`, `counts`, and `row_count` |
| `preflight_import` | `batch_id`, optional `expected_version` | Updated batch summary against current store records |
| `import_error_file` | `batch_id` | `filename`, `mime_type`, and sanitized `csv` with line, code, severity, and message |
| `commit_import` | `batch_id`, `expected_version` | Committed summary |
| `rollback_import` | `batch_id`, `expected_version` | Rolled-back summary, or `rollback_conflict` if changed records or dependencies prevent restoration |

Provider keys are `shopify`, `tiktok_shop`, `amazon_sp`, `shopee`, and `file_import`. Product CSV is available for every supported provider. Shopify also accepts `inventory_list`. Amazon and Shopee accept `order_list` and `refund_list` as P1 report imports. Store administration is required for financial preview and commit. Store administration is required for any rollback. Show `connecting` as catalog synchronization pending and surface `status_reason` on degraded stores.

CSV and tab-separated input support UTF-8 BOMs, quoted values, and multiline fields. Preflight issues use physical line numbers and fixed codes and messages. Use `counts` for new, changed, unchanged, duplicate, and invalid totals. Identical duplicates are skipped with a warning. Conflicting duplicates or any other row error block the whole commit. After `preflight_changed`, refresh the batch via `preflight_import` and ask for confirmation using its new version. The original file can be retained by the user for reference. Previews store only allowlisted values and fixed diagnostic fields, including Amazon reports. Display text cells as text. Dates without offsets require an IANA timezone in `options.timezone`. Ambiguous or nonexistent local times require an explicit offset. Integers and decimal currency prices are parsed without rounding.

Canonical financial headers are `external_order_id,placed_at,currency,total_minor,financial_status` and `external_order_id,external_refund_id,created_at,currency,amount_minor,status`. Amazon aliases include `amazon-order-id`, `purchase-date`, `order-total`, `order-status`, and `refund-date`. This workflow requires an authoritative order total and a stable refund ID. Use provider exports containing those fields or map the report to the canonical headers. A valid header-only financial report can be committed for a reconciliation window with zero rows. Use `attest_import_coverage` to record reconciled coverage separately from importing data.

## PC02–PC03 · Catalog, variants, and market prices

| Action | Payload |
|---|---|
| `create_product` | `store_id`, `title`, optional `handle`, `status`, `product_type`, `vendor` |
| `update_product` | `product_id`, `expected_version`, any editable product fields |
| `upsert_variant` | `product_id`, optional `variant_id` with `expected_version`, `sku`, `barcode`, `options`, `status` |
| `catalog_search` | Optional `query`, `brand_id`, `store_id`, `market_id`, `available_only`, `status`, `limit` |
| `catalog_get_product` | `product_id` |
| `create_variant_group` | `name`, optional `brand_id`, `note` |
| `link_variant_group` | `group_id`, `variant_id`, optional `linked_via` (`manual` or `suggestion_accepted`), `evidence` |
| `unlink_variant_group` | `member_id`, `expected_version`, `reason` |
| `configure_store_market` | `store_id`, `market_id`, `channel`, `price_source`, `expected_version` for updates, optional `enabled`, `purchase_url_template`, `inventory_locations`, `low_stock_threshold`, `snapshot_ttl_minutes` |
| `record_listing_snapshot` | `variant_id`, `market_id`, `channel`, optional `price_source`, `price_amount_minor`, `compare_at_amount_minor`, `currency`, `available_for_sale`, `inventory_quantity`, `purchase_url`, `availability`, `source_updated_at`, `fx_rate_id` |
| `market_snapshot` | `variant_ids`, `market_id`, `channel` |

Related kinds are `product`, `product_variant`, `variant_group`, `variant_group_member`, `store_market`, and `listing_snapshot`. Use `unlinked_at` to distinguish historical memberships. Filter out `rolled_back` records. Treat `null` price, stock, and sale flags as unknown. Render estimates only internally. `publishable_price` is false for missing, stale, or estimated prices. Snapshots expose both the inventory `snapshot_id` and the selected `price_snapshot_id`. Stock change events use newly observed values and ignore observation gaps. Shopify location reports match existing variants and sum the enabled market locations. Product reports subsequently preserve location inventory.

## PC04–PC06 · Facts, translations, and changes

| Action | Payload |
|---|---|
| `catalog_propose_fact` | `product_id`, `fact_key`, `category`, typed `value`, optional `variant_id`, `evidence_urls`, `evidence_ids`, `applicable_market_ids`, `expected_version` for edits |
| `review_fact_revision` | `revision_id`, fact `expected_version`, `decision` (`approve` or `reject`) |
| `catalog_list_facts` | `product_id`, optional `category` list, `approved_only` default true |
| `retract_fact` | `fact_id`, `expected_version`, `reason` |
| `catalog_update_localization` | `product_id`, `field_key` (`title` or `fact:<id>`), `locale`, optional `market_id`, `source_locale`, or existing `localization_id` with `expected_version`. Always include `text`. Optional `origin` is `human` or `agent`. |
| `submit_localization` | `localization_id`, `expected_version` |
| `review_localization` | `localization_id`, `expected_version`, `decision` (`approve`, `return`, or `accept_source_change`) |
| `transition_change` | `change_event_id`, `expected_version`, `status` (`acknowledged`, `resolved`, or `dismissed`), and `note` to resolve or dismiss |

Use `product_fact`, `product_fact_revision`, `product_localization`, `product_localization_revision`, and `change_event` for detail views. External content insertion uses approved fact revisions and excludes speculation. Localized titles and facts track their source content hash, and source edits mark affected localizations stale. Preserve the approved revision ID while reviewing a candidate. Highlight `blocking` change events for pre-publication review. Provider writeback and network sync require the separate account and ingest adapters.

## PC07 · Promotions

`save_promotion` accepts `store_id`, `name`, `valid_from`, `valid_until`, and `rule` with `percent_off` or `amount_off_minor`. Optional fields include `state` (`draft` or `scheduled`), `market_ids`, `campaign_id`, `external_discount_id` and `codes`. To edit or cancel, send `promotion_id` and `expected_version`. `promotion_get` accepts `promotion_id` or `campaign_id` and returns the related `promotion_code` records, effective state, readback status, and observed use separately.

## Order and refund read model

`order.data` uses `store_id`, `external_order_id`, `placed_at`, `currency`, `total_minor`, `financial_status`, and optional `subtotal_minor`, `discount_minor`, `tax_minor`, `shipping_minor`, `fulfillment_status`, `cancelled_at`. `refund.data` uses `store_id`, `order_id` (internal ID), `external_order_id`, `external_refund_id`, `created_at` (source date), `currency`, `amount_minor`, `status`. Deduct only `succeeded` refunds and report coverage separately. Rows with `rolled_back: true` are historical. Domain events carry internal IDs and store or batch references.
