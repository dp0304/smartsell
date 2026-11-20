import type { Context, Data, Operation, Row } from '@smartsell/contracts';
import { CAMPAIGN, INTERNAL_READ, LEAD, PLAN, array, campaign, choice, conflict, event, fields, flag, hash, integer, invalid, jsonDoc, mutable, optionalText, optionalTimestamp, record, rows, scoped, text, version } from './shared.js';

const BRIEFS = `${CAMPAIGN}/briefs`;
const REVISIONS = '/briefs/:id/revisions';
const REVISION_FIELDS = ['body_doc', 'markdown', 'requirements', 'fact_refs', 'ai_generated'];
const BRIEF_WRITERS = [...PLAN, 'agent'] as const;

export function approvedFacts(ctx: Context, campaignId: string, market: Row | null = null): { fact: Row; revision: Row }[] {
  const products = rows(ctx, 'campaign_product', 'campaign_id', campaignId);
  const revisions = new Map(ctx.list('product_fact_revision').map(row => [row.id, row]));
  return ctx.list('product_fact').flatMap(fact => {
    if (fact.status !== 'active') return [];
    const product = products.find(product => product.product_id === fact.product_id);
    if (!product) return [];
    if (fact.variant_id && Array.isArray(product.variant_ids) && !product.variant_ids.includes(fact.variant_id)) return [];
    if (market && Array.isArray(product.market_ids) && !product.market_ids.includes(market.market_id)) return [];
    if (market && Array.isArray(fact.applicable_market_ids) && !fact.applicable_market_ids.includes(market.market_id)) return [];
    if (!market && Array.isArray(product.market_ids) && Array.isArray(fact.applicable_market_ids)
      && !product.market_ids.some(id => (fact.applicable_market_ids as unknown[]).includes(id))) return [];
    const revision = revisions.get(fact.approved_revision_id as string);
    return revision && revision.fact_id === fact.id && revision.review_status === 'approved' ? [{ fact, revision }] : [];
  });
}

function checkFacts(ctx: Context, brief: Row, refs: Data[]): void {
  if (!refs.length) return;
  const market = typeof brief.campaign_market_id === 'string' ? ctx.get('campaign_market', brief.campaign_market_id) : null;
  const current = new Set(approvedFacts(ctx, brief.campaign_id as string, market).map(({ revision }) => revision.id));
  if (refs.some(ref => !current.has(ref.product_fact_revision_id as string))) conflict('Brief fact references must be current approved revisions of eligible campaign product facts');
}

function bodyDocument(body: Data): Data {
  if ((body.body_doc === undefined) === (body.markdown === undefined)) invalid('Provide exactly one of body_doc or markdown');
  if (body.body_doc !== undefined) return jsonDoc(body.body_doc, 'body_doc');
  const markdown = text(body.markdown, 'markdown', 100_000);
  return { type: 'doc', content: markdown.split('\n').map(line => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    return {
      type: heading ? 'heading' : 'paragraph', ...(heading ? { attrs: { level: heading[1]!.length } } : {}),
      ...(line ? { content: [{ type: 'text', text: heading?.[2] ?? line }] } : {}),
    };
  }) };
}

export function createBrief(ctx: Context, campaign: Row, body: Data): Row {
  fields(body, ['kind', 'title', 'campaign_market_id']);
  const kind = choice(body.kind ?? 'main', ['main', 'market', 'creator', 'production'], 'kind');
  const campaign_market_id = optionalText(body.campaign_market_id, 'campaign_market_id');
  if (kind === 'main' && campaign_market_id) invalid('A main brief must cover the whole campaign');
  if (kind === 'market' && !campaign_market_id) invalid('A market brief needs a campaign market');
  if (campaign_market_id) scoped(ctx, 'campaign_market', campaign_market_id, 'campaign_id', campaign.id);
  if (kind === 'main' && rows(ctx, 'brief', 'campaign_id', campaign.id).some(row => row.kind === 'main')) conflict('The campaign already has a main brief');
  return ctx.create('brief', {
    campaign_id: campaign.id, kind, campaign_market_id, title: text(body.title, 'title'), current_revision_id: null, approved_revision_id: null,
  });
}

export function createBriefRevision(ctx: Context, brief: Row, body: Data): Row {
  fields(body, [...REVISION_FIELDS, 'expected_version']);
  const prior = rows(ctx, 'brief_revision', 'brief_id', brief.id);
  if (prior.some(row => row.status === 'in_review')) conflict('Resolve the revision in review before drafting a new revision');
  const requirements = array(body.requirements ?? [], 'requirements').map(item => {
    const req = record(item, 'requirement');
    fields(req, ['type', 'count', 'spec', 'due_at']);
    return { type: text(req.type, 'requirement.type'), count: integer(req.count, 'requirement.count', 1), spec: optionalText(req.spec, 'requirement.spec', 10_000), due_at: optionalTimestamp(req.due_at, 'requirement.due_at') };
  });
  const fact_refs = array(body.fact_refs ?? [], 'fact_refs').map(item => {
    const ref = record(item, 'fact reference');
    fields(ref, ['product_fact_revision_id']);
    return { product_fact_revision_id: text(ref.product_fact_revision_id, 'product_fact_revision_id') };
  });
  if (new Set(fact_refs.map(ref => ref.product_fact_revision_id)).size !== fact_refs.length) invalid('fact_refs must be unique');
  checkFacts(ctx, brief, fact_refs);
  const values = { body_doc: bodyDocument(body), requirements, fact_refs };
  const aiGenerated = flag(body.ai_generated, 'ai_generated');
  const revision = ctx.create('brief_revision', {
    ...values, brief_id: brief.id, revision_no: Math.max(0, ...prior.map(row => Number(row.revision_no))) + 1,
    status: 'draft', ai_generated: ctx.role === 'agent' || aiGenerated, content_hash: hash(values),
    created_by_type: ctx.role === 'agent' ? 'agent_client' : 'user', created_by_id: ctx.actorId,
  });
  ctx.update('brief', brief.id, { current_revision_id: revision.id });
  return revision;
}

export const briefOperations: Operation[] = [
  { method: 'GET', path: BRIEFS, name: 'campaign_brief_list', roles: INTERNAL_READ, summary: 'List campaign briefs', run: (ctx, input) => rows(ctx, 'brief', 'campaign_id', campaign(ctx, input).id) },
  { method: 'POST', path: BRIEFS, name: 'campaign_brief_create', roles: BRIEF_WRITERS, summary: 'Create a brief and optionally its initial revision', run(ctx, input) {
    const row = campaign(ctx, input); mutable(row);
    const { revision, ...meta } = input.body;
    const brief = createBrief(ctx, row, meta);
    if (revision === undefined) return brief;
    const draft = createBriefRevision(ctx, brief, record(revision, 'revision'));
    return { ...ctx.get('brief', brief.id), revision: draft };
  } },
  { method: 'GET', path: REVISIONS, name: 'brief_revision_list', roles: INTERNAL_READ, summary: 'List immutable brief revisions', run(ctx, { params }) {
    const brief = ctx.get('brief', params.id!);
    return rows(ctx, 'brief_revision', 'brief_id', brief.id).sort((a, b) => Number(b.revision_no) - Number(a.revision_no));
  } },
  { method: 'POST', path: REVISIONS, name: 'brief_update_draft', roles: BRIEF_WRITERS, versionKind: 'brief', summary: 'Append a new immutable brief revision', run(ctx, input) {
    const brief = ctx.get('brief', text(input.params.id ?? input.body.brief_id, 'brief_id'));
    mutable(ctx.get('campaign', brief.campaign_id as string));
    version(brief, input);
    const { brief_id, ...body } = input.body;
    if (brief_id !== undefined && brief_id !== brief.id) invalid('brief_id does not match the requested brief');
    return createBriefRevision(ctx, brief, body);
  } },
  ...(['submit', 'approve', 'request-changes'] as const).map((action): Operation => ({
    method: 'POST', path: `/brief-revisions/:id/${action}`, name: `brief_revision_${action.replace('-', '_')}`,
    roles: action === 'submit' ? BRIEF_WRITERS : LEAD, versionKind: 'brief_revision', summary: `${action} a brief revision`,
    run(ctx, input) {
      fields(input.body, ['expected_version', 'reason']);
      const revision = ctx.get('brief_revision', input.params.id!);
      const brief = ctx.get('brief', revision.brief_id as string);
      mutable(ctx.get('campaign', brief.campaign_id as string));
      version(revision, input);
      const submitting = action === 'submit';
      if (brief.current_revision_id !== revision.id || revision.status !== (submitting ? 'draft' : 'in_review')) conflict('The current revision is not in the expected review state');
      const reason = action === 'request-changes' ? text(input.body.reason, 'reason') : optionalText(input.body.reason, 'reason');
      if (action !== 'request-changes') checkFacts(ctx, brief, revision.fact_refs as Data[]);
      if (action === 'approve' && typeof brief.approved_revision_id === 'string') {
        const previous = scoped(ctx, 'brief_revision', brief.approved_revision_id, 'brief_id', brief.id);
        ctx.update('brief_revision', previous.id, { status: 'superseded' });
      }
      const status = submitting ? 'in_review' : action === 'approve' ? 'approved' : 'changes_requested';
      const changed = ctx.update('brief_revision', revision.id, { status, review_reason: reason, reviewed_by: submitting ? null : ctx.actorId, reviewed_at: submitting ? null : ctx.now });
      if (action === 'approve') {
        ctx.update('brief', brief.id, { approved_revision_id: revision.id });
        event(ctx, 'brief.approved', brief.campaign_id as string, { brief_id: brief.id, brief_revision_id: revision.id, content_hash: revision.content_hash });
      }
      return changed;
    },
  })),
];
