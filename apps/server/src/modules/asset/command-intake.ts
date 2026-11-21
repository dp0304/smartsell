import { admins, required, reviewers, text, writers, type Commands, type Context, type Entity, type Fields } from '../types.ts';
import { assetKinds, createAsset, libraryCommands, safeUrl, verifiedFile } from './command-library.ts';
import { rightsCommands, terms as grantTerms } from './command-rights.ts';
import { bool, conflict, emit, expectVersion, get, insert, instant, integer, invalid, object, option, optional, strings, update } from './command-model.ts';

const providers = ['canva', 'google_drive', 'dropbox', 'figma'];

export const intakeCommands: Commands = {
  submission_box_create: { roles: admins, async run(ctx, input) {
    const brandId = text(input, 'brand_id', 256);
    await required(ctx, 'workspace', 'brand', brandId);
    const folderId = optional(input, 'target_folder_id', 256);
    if (folderId) {
      const folder = await get(ctx, 'asset_folder', folderId);
      if (folder.data.archived_at || folder.data.brand_id && folder.data.brand_id !== brandId) invalid('Folder belongs to another brand');
    }
    const expiresAt = instant(input.expires_at, 'expires_at');
    if (expiresAt <= instant(ctx.now, 'now')) invalid('Submission box must expire in the future');
    const allowedKinds = strings(input.allowed_kinds ?? assetKinds, 'allowed_kinds');
    if (!allowedKinds.length || allowedKinds.some(kind => !assetKinds.includes(kind))) invalid('Invalid allowed_kinds');
    return insert(ctx, 'submission_box', { brand_id: brandId, name: text(input, 'name', 512), target_folder_id: folderId,
      allowed_kinds: allowedKinds, max_bytes: integer(input.max_bytes ?? 100_000_000, 'max_bytes', 1, 2_000_000_000),
      expires_at: expiresAt, status: 'open', requires_rights_form: bool(input, 'requires_rights_form', false) });
  } },
  submission_receive: { roles: writers, async run(ctx, input) {
    const box = await get(ctx, 'submission_box', text(input, 'box_id', 256));
    if (box.data.status !== 'open' || box.data.expires_at <= instant(ctx.now, 'now')) conflict('Submission box is unavailable');
    const kind = option(input, 'kind', box.data.allowed_kinds);
    const file = await verifiedFile(ctx, text(input, 'file_object_id', 256), ['import']);
    if (file.data.storage_key && file.data.created_by_id !== ctx.actorId && !admins.includes(ctx.role)) invalid('The import file must belong to the submitting actor');
    if (['image', 'video', 'audio'].includes(kind) && (typeof file.data.mime_type !== 'string' || !file.data.mime_type.startsWith(`${kind}/`))) invalid('Submission file MIME type does not match kind');
    if (integer(file.data.size_bytes, 'size_bytes', 0, Number.MAX_SAFE_INTEGER) > box.data.max_bytes) invalid('Submission exceeds the file size limit');
    const declared = input.declared_rights == null ? null : object(input.declared_rights, 'declared_rights');
    if (declared) grantTerms({ ...declared, evidence_ids: [] });
    if (box.data.requires_rights_form && !declared) invalid('A rights declaration is required');
    const submission = await insert(ctx, 'submission', { box_id: box.id, kind, file_object_id: file.id, status: 'pending',
      title: text(input, 'title', 512), submitter: text(input, 'submitter', 512), received_by: ctx.actorId, declared_rights: declared });
    await emit(ctx, 'submission.received', { submission_id: submission.id, box_id: box.id });
    return submission;
  } },
  submission_accept: { roles: reviewers, run: (ctx, input) => acceptSubmission(ctx, input) },
  submission_accept_batch: { roles: reviewers, run: (ctx, input) => acceptSubmissionBatch(ctx, input) },
  submission_reject: { roles: reviewers, async run(ctx, input) {
    const submission = await get(ctx, 'submission', text(input, 'submission_id', 256));
    expectVersion(submission, input);
    if (submission.data.status !== 'pending') conflict('Only pending submissions can be rejected');
    return update(ctx, submission, { status: 'rejected', reviewed_by: ctx.actorId, reviewed_at: ctx.now, rejection_reason: text(input, 'reason') });
  } },
  asset_import_external: { roles: writers, async run(ctx, input) {
    const provider = option(input, 'provider', providers);
    const externalFileId = text(input, 'external_file_id', 256);
    const externalVersion = text(input, 'external_version', 256);
    const editUrl = safeUrl(input, 'edit_url');
    const file = await verifiedFile(ctx, text(input, 'file_object_id', 256));
    const result = await createAsset(ctx, { ...input, origin: 'design_tool', external_version: externalVersion,
      origin_ref: { provider, external_file_id: externalFileId, edit_url: editUrl } }, file);
    const source = await insert(ctx, 'external_source', { asset_id: result.asset.id, provider, external_file_id: externalFileId,
      external_version: externalVersion, edit_url: editUrl, update_available: false });
    return { ...result, source };
  } },
  asset_observe_external_version: { roles: admins, async run(ctx, input) {
    const source = await get(ctx, 'external_source', text(input, 'source_id', 256));
    const observed = text(input, 'external_version', 256);
    const changed = observed !== source.data.external_version;
    const updated = await update(ctx, source, { observed_version: observed, last_checked_at: ctx.now, update_available: changed });
    if (changed && observed !== source.data.observed_version) await emit(ctx, 'external_source.update_available', { asset_id: source.data.asset_id, external_source_id: source.id });
    return updated;
  } },
  asset_import_external_version: { roles: writers, async run(ctx, input) {
    const source = await get(ctx, 'external_source', text(input, 'source_id', 256));
    expectVersion(source, input);
    const externalVersion = text(input, 'external_version', 256);
    if (!source.data.update_available || source.data.observed_version !== externalVersion) conflict('Review the current observed version before importing');
    const result = await libraryCommands.asset_add_version.run(ctx, {
      asset_id: source.data.asset_id, file_object_id: input.file_object_id, change_note: input.change_note, external_version: externalVersion,
    }) as Fields;
    const updated = await update(ctx, source, { external_version: externalVersion, update_available: false });
    return { ...result, source: updated };
  } },
};

// The HTTP host can promote stored bytes from the private import area to an asset file.
type PromoteImport = (file: Entity) => Promise<Entity>;

export async function acceptSubmission(ctx: Context, input: Fields, promote?: PromoteImport) {
  const submission = await get(ctx, 'submission', text(input, 'submission_id', 256));
  expectVersion(submission, input);
  if (submission.data.status !== 'pending') conflict('Only pending submissions can be accepted');
  const box = await get(ctx, 'submission_box', submission.data.box_id);
  const source = await verifiedFile(ctx, submission.data.file_object_id, ['import']);
  const declaration = submission.data.declared_rights;
  if (declaration) grantTerms({ ...declaration, evidence_ids: [] });
  const file = promote && source.data.storage_key ? await promote(source) : source;
  const { asset, version } = await createAsset(ctx, {
    brand_id: box.data.brand_id, folder_id: box.data.target_folder_id, kind: submission.data.kind,
    title: submission.data.title, origin: 'import', origin_ref: { submission_id: submission.id, author: submission.data.submitter },
  }, file);
  const draft = declaration ? await rightsCommands.rights_create_draft.run(ctx, {
    brand_id: box.data.brand_id, grant_type: 'ugc_permission', grantor_kind: 'external_party',
    grantor_ref: { name: submission.data.submitter }, asset_version_id: version.id, terms: { ...declaration, evidence_ids: [] },
  }) as { id: string } : null;
  return update(ctx, submission, { status: 'accepted', accepted_asset_ids: [asset.id], rights_grant_id: draft?.id ?? null, reviewed_by: ctx.actorId, reviewed_at: ctx.now });
}

export async function acceptSubmissionBatch(ctx: Context, input: Fields, promote?: PromoteImport) {
  const box = await get(ctx, 'submission_box', text(input, 'box_id', 256));
  if (!Array.isArray(input.submissions) || !input.submissions.length || input.submissions.length > 20) invalid('Provide between 1 and 20 submissions');
  const batch = new Map<string, Fields>();
  for (const value of input.submissions) {
    const item = object(value, 'submission');
    const id = text(item, 'submission_id', 256);
    const row = await get(ctx, 'submission', id);
    if (row.data.box_id !== box.id || batch.has(id)) invalid('Provide unique submissions from this box');
    if (row.data.status !== 'pending') conflict('Only pending submissions can be accepted');
    expectVersion(row, item);
    batch.set(id, item);
  }
  const items = [];
  for (const item of batch.values()) items.push(await acceptSubmission(ctx, item, promote));
  return { items };
}
