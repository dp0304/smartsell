# Content API examples

Use the authenticated workspace command endpoint at `POST /api/v1/workspaces/{ws}/commands/content/{action}`. Send a unique `Idempotency-Key` with each command. A retry of the same request can reuse its key. Command responses contain `data`; entities inside it expose `id`, `version`, and their domain fields under `data`.

## From idea to committed revision

| Action | Example JSON body |
| --- | --- |
| `idea_create` | `{"brand_id":"brand-1","title":"Summer travel","origin_refs":[{"type":"url","url":"https://example.org/research"}]}` |
| `idea_convert` | `{"idea_id":"idea-1","variants":[{"platform":"instagram","format":"text","locale":"en-US","market_id":"US","body":"Pack light #travel"}]}` |
| `content_autosave_variant` | `{"variant_id":"variant-1","expected_version":1,"draft_doc":{"body":"Pack light this summer #travel"}}` |
| `content_commit_revision` | `{"variant_id":"variant-1","expected_version":2,"base_revision_id":null}` |
| `content_validate_variant` | `{"variant_id":"variant-1","revision_id":"revision-1","social_account_ids":["account-1"]}` |
| `content_set_readiness` | `{"variant_id":"variant-1","expected_version":3}` |

Autosave changes the working draft. Save a revision with `base_revision_id: null` when committing the first revision. Use its returned `revision.id` as the base for subsequent edits. `content_update_variant` requires both `expected_version` and `base_revision_id`. A `409 VERSION_CONFLICT` carries the base, submitted text and settings, committed revision, current working draft, and the changed fields. `content_restore_revision` takes the historical `revision_id`, current `base_revision_id`, and variant `expected_version`, then creates a new revision.

`content_validate_variant` returns severity-coded issues and an approximate preview, including rendered text, media, and selected settings. Use `content_create_translation` with `source_variant_id`, `locale`, `market_id`, and `text` to create localized copy. Subsequent source revisions mark the translation for review. Use `content_accept_source_change` or `content_mark_divergence` with `translation_link_id`, `expected_version`, and the current `source_revision_id`. Divergence also requires a `note`.

## TikTok settings

A human can commit an explicitly selected privacy setting and commercial disclosure using `content_commit_revision`.

```json
{
  "variant_id": "variant-1",
  "expected_version": 3,
  "base_revision_id": "revision-1",
  "settings": {
    "platform_options": {
      "tiktok": {
        "privacy_level": "PUBLIC_TO_EVERYONE",
        "commercial_disclosure": "none",
        "allow_comment": true,
        "allow_duet": false,
        "allow_stitch": false
      }
    }
  }
}
```

Agent create, update, and batch operations reject human-only selections. A localized or duplicated variant needs its own selections. Missing selections block readiness. Product references can include `variant_id`, `fact_revision_id`, `listing_snapshot_id`, `market_id`, `field`, `inserted_text`, and `currency`. Price references require the appropriate market and currency.

## Later workflows

`content_duplicate` copies committed variants into an item with lineage and returns product-review and removed-asset warnings. The duplicate is a working draft. `content_poll_feed` emits `content.feed.poll_requested`. The trusted fetch worker calls `recordFeedItems` in a workspace transaction with normalized entries. `content_import_feed_item` converts a preview entry into an attributed idea. Transcription and post maintenance similarly emit requests for their owning workers. Upstream commerce and asset events enter through `handleContentEvent` and mark the affected current variants for review.
