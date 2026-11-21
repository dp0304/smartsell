# Asset module

The workspace command API in `index.ts` covers library records, immutable file versions, rendition work, rights, brand knowledge, templates and intake. REST/MCP operations are exported separately from the same entry point.

## Create an asset and authorize a use

The workspace file service supplies a scanned `core.file_object` ID and its verified checksum. The following example shows command inputs and the direct helper used by planning and execution.

```ts
import type { Entity } from '../types.ts';
import { checkUsage, commands } from './index.ts';

const { asset, version } = await commands.asset_create.run(ctx, {
  brand_id: brandId,
  kind: 'image',
  title: 'Campaign hero',
  file_object_id: fileId,
}) as { asset: Entity; version: Entity };

const grant = await commands.rights_create_draft.run(ctx, {
  brand_id: brandId,
  grant_type: 'license',
  grantor_kind: 'external_party',
  asset_version_id: version.id,
  terms: {
    usages: ['organic_social'],
    platforms: ['instagram'],
    regions: ['US'],
    valid_from: '2026-11-20T00:00:00Z',
    valid_until: '2026-12-01T00:00:00Z',
    evidence_ids: [contractEvidenceId],
  },
}) as Entity;

await commands.rights_activate.run(reviewerCtx, {
  rights_grant_id: grant.id,
  revision_id: grant.data.current_revision_id,
});

const decision = await checkUsage(ctx, {
  asset_version_id: version.id,
  platform: 'instagram',
  market: 'US',
  purpose: 'organic_social',
  at: '2026-11-25T15:00:00Z',
});
```

These calls represent separate workspace transactions. For an allowed decision, persist `grant_id` and `grant_version` with the frozen asset version and check the intended scope again at execution. `valid_until` is an exclusive boundary. Set `modification: true` for uses that require modification rights, and surface any attribution or restrictions returned by the checker.

## Lifecycle and integrations

- `asset_add_version` adds a file version and changes the library's current version pointer. Existing references continue to point to their original file versions. `asset_archive` retains the complete history.
- `asset_request_rendition` deduplicates the kind, target platform and normalized parameters for a version. Workers consume `asset.rendition.requested` and report progress with the matching attempt number. A failed attempt can be retried without changing its source.
- `rights_expiry_scan` uses the workspace clock and emits transitions once per state change. Expiry and takedown revocation create review records for existing posts linked to the selected grant through a planning reference or frozen snapshot. Reviewers resolve these with `rights_resolve_impact`.
- `knowledge_get_context` returns active rules and revision numbers for a specific brand. Pass `include_proposed: true` to request suggestions under a separate key. `template_render` returns dynamic fields in `revalidate` for content submission to verify against current source data.
- `submission_receive` records a scanned import for review. `submission_accept` creates a library asset and keeps any rights declaration in draft pending separate confirmation. External source commands store provenance and observed versions. Importing a source update appends a new version.

Object storage, actual media transforms, scheduling the expiry scan, public sharing and authenticated provider fetching are responsibilities of their respective host services. The external version commands accept completed artifacts or version observations from those services.

Run the module acceptance tests from the repository root with `pnpm exec tsx --test apps/server/src/modules/asset/asset.test.ts`.
