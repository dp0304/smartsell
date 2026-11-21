import { createHash } from 'node:crypto';
import { required, type Commands, type Context } from '../types.ts';
import { command, conflict, emit, expected, fields, getCampaign, integer, invalid, list, moduleName, mutable, object, optionalText, options, readRoles, reference, related, reviewRoles, rows, text, timestamp, writeRoles } from './command-input.ts';

async function review(ctx: Context, input: Record<string, unknown>, to: 'in_review' | 'approved' | 'changes_requested') {
  fields(input, ['campaign_id', 'brief_id', 'revision_id', 'expected_version', 'reason']);
  const campaign = await getCampaign(ctx, input);
  mutable(campaign);
  const brief = await related(ctx, 'brief', campaign.id, input.brief_id);
  const revision = await related(ctx, 'brief_revision', campaign.id, input.revision_id);
  const version = expected(revision, input.expected_version);
  if (revision.data.brief_id !== brief.id || brief.data.current_revision_id !== revision.id) conflict('Only the current brief revision can be reviewed');
  if (revision.data.status !== (to === 'in_review' ? 'draft' : 'in_review')) conflict('Invalid brief revision transition');
  const reason = to === 'changes_requested' ? text(input.reason, 'reason') : optionalText(input.reason, 'reason');
  const updated = await ctx.update(moduleName, 'brief_revision', revision.id, { status: to, reviewed_by: ctx.actorId, review_reason: reason }, version);
  if (to === 'approved') {
    if (brief.data.approved_revision_id) {
      const old = await required(ctx, moduleName, 'brief_revision', brief.data.approved_revision_id);
      await ctx.update(moduleName, 'brief_revision', old.id, { status: 'superseded' }, old.version);
    }
    await ctx.update(moduleName, 'brief', brief.id, { approved_revision_id: revision.id }, brief.version);
    await emit(ctx, 'brief.approved', campaign.id, { brief_id: brief.id, revision_id: revision.id, content_hash: revision.data.content_hash });
  }
  return updated;
}

export const briefCommands: Commands = {
  list_briefs: command(readRoles, async (ctx, input) => rows(ctx, 'brief', (await getCampaign(ctx, input)).id)),
  list_brief_revisions: command(readRoles, async (ctx, input) => {
    const campaign = await getCampaign(ctx, input);
    const brief = await related(ctx, 'brief', campaign.id, input.brief_id);
    return (await rows(ctx, 'brief_revision', campaign.id)).filter(row => row.data.brief_id === brief.id).sort((a, b) => a.data.revision_no - b.data.revision_no);
  }),
  create_brief: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'kind', 'campaign_market_id', 'title']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const kind = options(input.kind ?? 'main', 'kind', ['main', 'market', 'creator', 'production']);
    if (kind === 'main' && (await rows(ctx, 'brief', campaign.id)).some(row => row.data.kind === 'main')) conflict('Campaign already has a main brief');
    const market = input.campaign_market_id == null ? null : await related(ctx, 'campaign_market', campaign.id, input.campaign_market_id);
    if (market?.data.removed_at || (kind === 'market' && !market) || (kind === 'main' && market)) invalid('Invalid brief market');
    return ctx.insert(moduleName, 'brief', { campaign_id: campaign.id, kind, campaign_market_id: market?.id ?? null, title: text(input.title, 'title'),
      current_revision_id: null, approved_revision_id: null, revision_no: 0 });
  }),
  update_brief_draft: command(writeRoles, async (ctx, input) => {
    fields(input, ['campaign_id', 'brief_id', 'expected_version', 'body_doc', 'markdown', 'requirements', 'fact_refs', 'ai_generated']);
    const campaign = await getCampaign(ctx, input);
    mutable(campaign);
    const brief = await related(ctx, 'brief', campaign.id, input.brief_id);
    const version = expected(brief, input.expected_version);
    if (brief.data.current_revision_id) {
      const previous = await required(ctx, moduleName, 'brief_revision', brief.data.current_revision_id);
      if (previous.data.status === 'in_review') conflict('Resolve the current review before drafting another revision');
    }
    if ((input.body_doc === undefined) === (input.markdown === undefined)) invalid('Provide exactly one of body_doc or markdown');
    const bodyDoc = input.markdown !== undefined
      ? { type: 'doc', content: text(input.markdown, 'markdown', 50_000).split('\n').map(line => ({ type: 'paragraph', content: line ? [{ type: 'text', text: line }] : [] })) }
      : object(input.body_doc, 'body_doc');
    if (bodyDoc.type !== 'doc') invalid('body_doc must be a ProseMirror doc');
    const requirements = list(input.requirements ?? [], 'requirements').map(value => {
      const row = object(value, 'requirement');
      fields(row, ['type', 'count', 'spec', 'due_at']);
      return { type: text(row.type, 'type'), count: integer(row.count, 'count', 1), spec: optionalText(row.spec, 'spec'),
        due_at: row.due_at == null ? null : timestamp(row.due_at, 'due_at') };
    });
    const fact_refs = await Promise.all(list(input.fact_refs ?? [], 'fact_refs').map(async value => {
      const row = object(value, 'fact_ref');
      fields(row, ['product_fact_revision_id']);
      return { product_fact_revision_id: await reference(ctx, 'commerce', 'product_fact_revision', row.product_fact_revision_id, 'product_fact_revision_id') };
    }));
    if (input.ai_generated !== undefined && typeof input.ai_generated !== 'boolean') invalid('ai_generated must be boolean');
    const content = { body_doc: structuredClone(bodyDoc), requirements, fact_refs };
    const revision_no = brief.data.revision_no + 1;
    const revision = await ctx.insert(moduleName, 'brief_revision', { ...content, campaign_id: campaign.id, brief_id: brief.id, revision_no, status: 'draft',
      created_by_id: ctx.actorId, ai_generated: input.ai_generated ?? false, content_hash: createHash('sha256').update(JSON.stringify(content)).digest('hex') });
    const updated = await ctx.update(moduleName, 'brief', brief.id, { current_revision_id: revision.id, revision_no }, version);
    return { brief: updated, revision };
  }),
  submit_brief_revision: command(writeRoles, (ctx, input) => review(ctx, input, 'in_review')),
  approve_brief_revision: command(reviewRoles, (ctx, input) => review(ctx, input, 'approved')),
  request_brief_changes: command(reviewRoles, (ctx, input) => review(ctx, input, 'changes_requested')),
};
