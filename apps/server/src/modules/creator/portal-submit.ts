import type { Context, Entity, Fields } from '../types.ts';
import { conflict, digest, get, insert, invalid, list, setCollaborationStatus, signedTerms, update, url } from './command-input.ts';

/** The authenticated capability supplies the deliverable ID and the workspace transaction. */
export async function submitPortalDeliverable(ctx: Context, deliverableId: string, input: Fields): Promise<Entity> {
  const deliverable = await get(ctx, 'deliverable', deliverableId);
  const collaboration = await get(ctx, 'collaboration', deliverable.data.collaboration_id);
  if (!['active', 'delivering'].includes(collaboration.data.status)) return conflict('invalid_status', 'Collaboration is not accepting submissions');
  await signedTerms(ctx, collaboration);
  const postUrl = url(input, 'post_url');
  if (!postUrl) return invalid('post_url');
  const versions = (await list(ctx, 'deliverable_version')).filter(row => row.data.deliverable_id === deliverableId);
  const latest = versions.find(row => row.id === deliverable.data.latest_version_id);
  if (deliverable.data.status === 'submitted' && latest?.data.review_status === 'pending' && latest.data.post_url === postUrl && latest.data.submitted_via === 'portal') return latest;
  if (!['requested', 'in_progress', 'changes_requested'].includes(deliverable.data.status)) return conflict('invalid_status', 'Deliverable is not accepting another submission');
  const versionNo = versions.reduce((max, row) => Math.max(max, row.data.version_no), 0) + 1;
  const version = await insert(ctx, 'deliverable_version', {
    deliverable_id: deliverableId, version_no: versionNo, asset_ids: [], post_url: postUrl,
    review_status: 'pending', submitted_at: ctx.now, submitted_by: ctx.actorId, submitted_via: 'portal',
  }, digest(['deliverable_version', deliverableId, versionNo]));
  await update(ctx, deliverable, { status: 'submitted', latest_version_id: version.id, rights_grant_ids: [] });
  if (collaboration.data.status === 'active') await setCollaborationStatus(ctx, collaboration, 'delivering');
  await ctx.emit('creator.deliverable.submitted', { collaboration_id: collaboration.id, deliverable_id: deliverableId, deliverable_version_id: version.id });
  return version;
}
