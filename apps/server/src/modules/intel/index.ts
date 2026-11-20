import { Problem, READ, type Context, type Data, type Operation } from '@smartsell/contracts';
import { operations as contentOperations } from '../content/index.js';
import { briefOperations, createBrief, createBriefRevision } from '../campaign/brief-operations.js';
import { id, choice, conflict, invalid, object, optionalText, strings, text, url } from './input.js';
import { modes, prepareObservation, sourceRow, timeline, watchTargetCoverage } from './intel-observations.js';
import { analyzeCreativeReference, boardDetail, boardValues, checkEvidenceUse, creativeValues, deleteItem, itemValues, listCreativeReferences, readDigest, resolveResearchEvidence, search } from './intel-research.js';
import { queueResearchDigest, researchDigestRoles, researchDigestSubscriber } from './digest-operations.js';
import { addScore, candidateDetail, candidateValues, transition } from './intel-candidates.js';
import { alertTransition, compare, createTopic, evaluateAlerts, listAlerts, ruleValues, trend } from './intel-signals.js';
import { escalateMention, labelMention, mentionLabels, queryMentions, recordMention, requestMentionClassification, shareOfVoice } from './intel-mentions.js';
import { applyIntelEvent, intelAcceptsEvent, scanIntel, scanIntelFreshness } from './intel-jobs.js';

export { applyIntelEvent, intelAcceptsEvent, scanIntel };
export const subscribers = [{ id: 'intel', accepts: intelAcceptsEvent, run: applyIntelEvent }, researchDigestSubscriber];
export const schedules = [
  { id: 'intel.scan', intervalMs: 86_400_000, run: scanIntel },
  { id: 'intel.freshness', intervalMs: 60_000, run: scanIntelFreshness },
];
export { recordMention };

export { prepareObservation, recordObservations, purgeExpiredObservations } from './intel-observations.js';

const humans = ['owner', 'admin', 'manager', 'editor', 'analyst'] as const;
const drafts = [...humans, 'agent'] as const;
const candidateManagers = ['owner', 'admin', 'manager'] as const;
function operation(method: Operation['method'], path: string, name: string, summary: string, roles: Operation['roles'], run: Operation['run'], versionKind?: string): Operation {
  return { method, path, name, summary, roles, run, ...(versionKind ? { versionKind } : {}) };
}

function targetValues(ctx: Context, body: Data): Data {
  const type = choice(body.target_type, ['competitor_account', 'keyword', 'hashtag', 'category', 'product_url', 'store', 'creator_account'], 'target_type');
  const input = object(body.query, 'query');
  const query = {
    handle: optionalText(input.handle, 'query.handle', 200),
    url: input.url == null ? null : url(input.url, 'query.url'),
    keywords: strings(input.keywords ?? [], 'query.keywords'),
    exclude: strings(input.exclude ?? [], 'query.exclude'),
    language: optionalText(input.language, 'query.language', 50),
  };
  if (type === 'product_url' && !query.url) invalid('query.url', 'is required for a product URL');
  if (['competitor_account', 'store', 'creator_account'].includes(type) && !query.handle && !query.url) invalid('query', 'requires a handle or URL');
  if (['keyword', 'hashtag', 'category'].includes(type) && !query.keywords.length) invalid('query.keywords', 'requires at least one keyword');
  const mode = choice(body.data_mode ?? 'manual', modes, 'data_mode');
  const sourceId = optionalText(body.data_source_id, 'data_source_id', 200);
  const brand = optionalText(body.brand_id, 'brand_id', 200);
  if (brand) ctx.get('brand', brand);
  const markets = strings(body.market_ids ?? [], 'market_ids');
  markets.forEach(market => ctx.get('market', market));
  if (['vendor', 'official_api'].includes(mode) && !sourceId) invalid('data_source_id', 'is required for authorized collection');
  if (sourceId) sourceRow(ctx, sourceId, mode, brand);
  return {
    target_type: type, platform: optionalText(body.platform, 'platform', 100), name: text(body.name, 'name', 250), query,
    data_mode: mode, data_source_id: sourceId, brand_id: brand, market_ids: markets,
    refresh_frequency: choice(body.refresh_frequency ?? 'manual', ['manual', 'daily', 'weekly'], 'refresh_frequency'),
    owner_user_id: optionalText(body.owner_user_id, 'owner_user_id', 200),
    tags: strings(body.tags ?? [], 'tags'), coverage_note: optionalText(body.coverage_note, 'coverage_note') ?? (sourceId ? 'Coverage depends on the authorized data source' : 'Public observations entered by workspace members'),
    status: choice(body.status ?? 'active', ['active', 'paused', 'archived'], 'status'),
  };
}

async function convert(ctx: Context, { body, params, query }: Parameters<Operation['run']>[1]) {
  const item = ctx.get('research_item', params.id);
  const destination = choice(body.destination, ['idea', 'campaign_hypothesis'], 'destination');
  checkEvidenceUse(ctx, [item], 'team_share');
  if (item.converted_to) {
    if ((item.converted_to as Data).destination !== destination) conflict('Research item already has a different destination');
    return item;
  }
  const board = ctx.get('research_board', String(item.board_id));
  if (board.status !== 'active') conflict('Research board is archived');
  const title = text(body.title ?? item.title ?? board.title, 'title', 250);
  const hypothesis = optionalText(body.hypothesis ?? item.body, 'hypothesis');
  let converted: Data;
  if (destination === 'idea') {
    const idea = contentOperations.find(op => op.name === 'idea_create');
    if (!idea) throw new Problem(503, 'INTEGRATION_UNAVAILABLE', 'The content idea service is unavailable');
    if (!idea.roles.includes(ctx.role)) throw new Problem(403, 'FORBIDDEN', 'Content draft permission is required');
    const originRefs = [{ type: 'research_note', id: item.id }, ...(item.item_type === 'observation' ? [{ type: 'observation', id: item.ref_id }] : [])];
    const result = await idea.run(ctx, { params: {}, query, body: { title, hypothesis, brand_id: board.brand_id ?? body.brand_id, campaign_id: board.campaign_id, origin: 'monitoring', origin_refs: originRefs, tags: item.labels } }) as Data;
    converted = { module: 'content', resource_type: 'idea', id: result.id, destination };
  } else {
    const brief = briefOperations.find(op => op.name === 'campaign_brief_create' || (op.method === 'POST' && op.path === '/campaigns/:id/briefs'));
    if (!brief?.roles.includes(ctx.role) || ctx.role === 'agent') throw new Problem(403, 'FORBIDDEN', 'Campaign draft permission is required');
    const campaign = ctx.get('campaign', text(board.campaign_id ?? body.campaign_id, 'campaign_id', 200));
    if (board.brand_id && campaign.brand_id !== board.brand_id) conflict('Campaign is outside the board brand');
    const created = createBrief(ctx, campaign, { title, kind: 'production' });
    createBriefRevision(ctx, created, { markdown: `Research hypothesis\n\n${hypothesis ?? title}\n\nResearch item ${item.id}` });
    converted = { module: 'campaign', resource_type: 'brief', id: created.id, destination };
  }
  const result = ctx.update('research_item', item.id, { converted_to: converted });
  ctx.emit('intel.research_item.converted', { research_item_id: item.id, ...converted });
  return result;
}

export const operations: (Operation & { mcp?: boolean })[] = [
  operation('GET', '/watch-targets', 'watch_targets_list', 'List watch targets and coverage', READ, (ctx, { query }) => ctx.list('watch_target').filter(row => ['status','platform','brand_id','data_mode'].every(key => !query[key] || row[key] === query[key])).map(row => watchTargetCoverage(ctx, row))),
  operation('POST', '/watch-targets', 'watch_target_create', 'Create a monitoring target', humans, (ctx, { body }) => {
    const row = ctx.create('watch_target', targetValues(ctx, body));
    ctx.emit('intel.watch_target.created', { watch_target_id: row.id, data_source_id: row.data_source_id });
    return row;
  }),
  operation('GET', '/watch-targets/:id', 'watch_target_get', 'Read a watch target', READ, (ctx, input) => watchTargetCoverage(ctx, ctx.get('watch_target', id(input)))),
  operation('PATCH', '/watch-targets/:id', 'watch_target_update', 'Update a watch target', humans, (ctx, input) => {
    const existing = ctx.get('watch_target', id(input));
    const row = ctx.update('watch_target', existing.id, targetValues(ctx, { ...existing, ...input.body }));
    ctx.emit('intel.watch_target.changed', { watch_target_id: row.id, data_source_id: row.data_source_id });
    return row;
  }, 'watch_target'),
  operation('GET', '/watch-targets/:id/observations', 'observations_list', 'Read immutable observation history', READ, (ctx, input) => timeline(ctx, id(input), input.query)),
  operation('POST', '/observations', 'observation_record', 'Record a public observation', humans, (ctx, { body }) => prepareObservation(ctx, body)()),
  operation('GET', '/research-boards', 'research_boards_list', 'List research boards', drafts, (ctx, { query }) => ctx.list('research_board').filter(row => ['status','kind','brand_id','campaign_id'].every(key => !query[key] || row[key] === query[key]))),
  operation('POST', '/research-boards', 'research_board_create', 'Create a research board', drafts, (ctx, { body }) => ctx.create('research_board', boardValues(ctx, body))),
  operation('GET', '/research-boards/:id', 'research_board_get', 'Read a research board and its items', drafts, (ctx, input) => boardDetail(ctx, ctx.get('research_board', id(input)))),
  operation('PATCH', '/research-boards/:id', 'research_board_update', 'Update a research board', drafts, (ctx, input) => {
    const row = ctx.get('research_board', id(input));
    return ctx.update('research_board', row.id, boardValues(ctx, { ...row, ...input.body }));
  }, 'research_board'),
  operation('POST', '/research-boards/:id/items', 'research_add_item', 'Add a sourced research item', drafts, (ctx, input) => ctx.create('research_item', itemValues(ctx, input.body, ctx.get('research_board', id(input))))),
  operation('POST', '/research-boards/:id/notes', 'research_create_note', 'Add a research note', drafts, (ctx, input) => ctx.create('research_item', itemValues(ctx, { ...input.body, item_type: 'note' }, ctx.get('research_board', id(input))))),
  operation('PATCH', '/research-items/:id', 'research_item_update', 'Update a research item', drafts, (ctx, input) => {
    const row = ctx.get('research_item', id(input));
    return ctx.update('research_item', row.id, itemValues(ctx, input.body, ctx.get('research_board', String(row.board_id)), row));
  }, 'research_item'),
  operation('DELETE', '/research-items/:id', 'research_item_delete', 'Remove an unreferenced research item', drafts, (ctx, input) => {
    const row = ctx.get('research_item', id(input));
    deleteItem(ctx, row);
    return { id: row.id, deleted: true };
  }, 'research_item'),
  operation('POST', '/research-items/:id/convert', 'research_item_convert', 'Convert research to a content idea or campaign hypothesis', drafts, convert, 'research_item'),
  operation('GET', '/research/search', 'research_search', 'Search research evidence and creative references', READ, (ctx, { query }) => search(ctx, query)),
  operation('GET', '/research-items/:id/evidence', 'research_item_evidence', 'Resolve the exact evidence cited by a research item', READ, (ctx, input) => resolveResearchEvidence(ctx, ctx.get('research_item', id(input)))),
  operation('GET', '/creative-references', 'creative_references_list', 'List creative references', drafts, (ctx, { query }) => listCreativeReferences(ctx, query)),
  operation('POST', '/creative-references', 'creative_reference_create', 'Create a link-only creative reference', drafts, (ctx, { body }) => ctx.create('creative_reference', creativeValues(ctx, body))),
  operation('PATCH', '/creative-references/:id', 'creative_reference_annotate', 'Annotate a creative reference', drafts, (ctx, input) => {
    const row = ctx.get('creative_reference', id(input));
    return ctx.update('creative_reference', row.id, creativeValues(ctx, input.body, row));
  }, 'creative_reference'),
  { ...operation('POST', '/creative-references/:id/analyze', 'creative_reference_analyze', 'Analyze an approved observation via AI07', humans, (ctx, input) => analyzeCreativeReference(ctx, ctx.get('creative_reference', id(input))), 'creative_reference'), external: true, mcp: false },
  operation('GET', '/product-candidates', 'product_candidates_list', 'List product candidates and evidence scores', candidateManagers, (ctx, { query }) => ctx.list('product_candidate').filter(row => !query.status || row.status === query.status).map(row => candidateDetail(ctx, row))),
  operation('POST', '/product-candidates', 'product_candidate_create', 'Propose a product candidate', candidateManagers, (ctx, { body }) => ctx.create('product_candidate', { ...candidateValues(ctx, body), status: 'proposed', decision_reason: null, linked_product_id: null })),
  operation('GET', '/product-candidates/:id', 'product_candidate_get', 'Read candidate evidence and scores', candidateManagers, (ctx, input) => candidateDetail(ctx, ctx.get('product_candidate', id(input)))),
  operation('PATCH', '/product-candidates/:id', 'product_candidate_update', 'Update candidate research fields or advance its state', candidateManagers, (ctx, input) => {
    const row = ctx.get('product_candidate', id(input));
    if (input.body.status !== undefined) return transition(ctx, row, input.body);
    if (['accepted', 'rejected'].includes(String(row.status))) conflict('Decided candidates cannot be edited');
    return ctx.update('product_candidate', row.id, candidateValues(ctx, { ...row, ...input.body }));
  }, 'product_candidate'),
  operation('POST', '/product-candidates/:id/scores', 'product_candidates_score', 'Score one candidate dimension without deciding', [...candidateManagers, 'agent'], (ctx, input) => addScore(ctx, ctx.get('product_candidate', id(input)), input.body), 'product_candidate'),
  operation('POST', '/product-candidates/:id/decide', 'product_candidate_decide', 'Accept or reject a candidate with rationale', candidateManagers, (ctx, input) => {
    choice(input.body.status, ['accepted','rejected'], 'status');
    return transition(ctx, ctx.get('product_candidate', id(input)), input.body);
  }, 'product_candidate'),
  { ...operation('POST', '/research-digests', 'research_digest_create', 'Queue a source-authorized structured research digest', researchDigestRoles, queueResearchDigest), accepted: true, mcp: false },
  { ...operation('GET', '/research-digests/:id', 'research_digest_get', 'Read a completed research digest', researchDigestRoles, (ctx, input) => readDigest(ctx, id(input))), mcp: false },
  operation('GET', '/research/compare', 'observations_compare', 'Compare observations at the same post age', READ, (ctx, { query }) => compare(ctx, query)),
  operation('GET', '/topics', 'research_topics_list', 'List research topics', READ, ctx => ctx.list('topic')),
  operation('POST', '/topics', 'research_topic_create', 'Define a topic and its eligible sample', humans, (ctx, { body }) => createTopic(ctx, body)),
  operation('GET', '/topics/:id/trend', 'research_topic_trend', 'Compare topic increments across time windows', READ, (ctx, input) => trend(ctx, ctx.get('topic', id(input)), input.query)),
  operation('GET', '/alert-rules', 'alert_rules_list', 'List monitoring alert rules', humans, ctx => ctx.list('alert_rule')),
  operation('POST', '/alert-rules', 'alert_rule_create', 'Create a monitoring alert rule', humans, (ctx, { body }) => ctx.create('alert_rule', ruleValues(ctx, body))),
  operation('PATCH', '/alert-rules/:id', 'alert_rule_update', 'Update a monitoring alert rule', humans, (ctx, input) => {
    const row = ctx.get('alert_rule', id(input));
    return ctx.update('alert_rule', row.id, ruleValues(ctx, { ...row, ...input.body }));
  }, 'alert_rule'),
  operation('GET', '/alerts', 'alerts_list', 'List signal and source freshness alerts', humans, (ctx, { query }) => listAlerts(ctx, query)),
  operation('POST', '/alerts/evaluate', 'alerts_evaluate', 'Evaluate configured alert rules', humans, ctx => evaluateAlerts(ctx)),
  operation('PATCH', '/alerts/:id', 'alert_update', 'Acknowledge, assign, resolve or dismiss an alert', humans, (ctx, input) => alertTransition(ctx, ctx.get('alert', id(input)), input.body), 'alert'),
  operation('GET', '/mentions', 'mentions_query', 'Query visible mentions and current human annotations', READ, (ctx, { query }) => queryMentions(ctx, query)),
  operation('POST', '/mentions', 'mention_record', 'Record a public brand mention', humans, (ctx, { body }) => recordMention(ctx, body)),
  operation('GET', '/mentions/:id/labels', 'mention_labels_list', 'Read original and superseding mention annotations', READ, (ctx, input) => mentionLabels(ctx, ctx.get('mention', id(input)))),
  { ...operation('POST', '/mentions/:id/classify', 'mention_classify', 'Queue classification via the configured model route', humans, (ctx, input) => requestMentionClassification(ctx, ctx.get('mention', id(input))), 'mention'), mcp: false },
  operation('PATCH', '/mentions/:id/labels', 'mention_label_update', 'Append a human label and preserve superseded labels', humans, (ctx, input) => labelMention(ctx, ctx.get('mention', id(input)), input.body), 'mention'),
  operation('POST', '/mentions/:id/escalate', 'mention_escalate', 'Escalate a mention to a workspace follow-up task', humans, (ctx, input) => escalateMention(ctx, ctx.get('mention', id(input)), input), 'mention'),
  operation('GET', '/share-of-voice', 'share_of_voice_get', 'Compute share of voice for a defined source sample', READ, (ctx, { query }) => shareOfVoice(ctx, query)),
];

export { commands } from './commands.ts';
export { recordObservations as recordWorkspaceObservations } from './observations.ts';
