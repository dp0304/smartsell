import { describe, expect, it } from 'vitest';
import type { Commands } from '../types.ts';
import { testWorkspace } from '../ingest/test-context.ts';
import { commands } from './commands.ts';
import { catalogCommands as commerceCommands } from '../commerce/catalog-commands.ts';
import { recordObservations } from './observations.ts';

const window = { from: '2026-11-17T00:00:00Z', to: '2026-11-20T00:00:00Z' };
const targetData = { name: 'Paper Co', target_type: 'competitor_account', platform: 'tiktok', data_mode: 'manual', query: { handle: 'paper-co' } };
const sourcePolicy = { display: true, team_share: true, export: false, model_processing: false, cache_days: 7 };
const sourceData = { provider: 'file_import', kind: 'file_import', method: 'report_import', status: 'active', authorization_confirmed: true, resources: ['posts'],
  field_coverage: { posts: { status: 'available', fields: ['likes', 'title', 'impressions'] } }, allowed_uses: sourcePolicy, last_success_at: '2026-11-19T11:00:00Z' };
const seed: Commands = {
  source: { roles: ['owner'], run: (ctx, input) => ctx.insert('ingest', 'data_source', input) },
  gap: { roles: ['owner'], run: (ctx, input) => ctx.insert('ingest', 'data_gap', input) },
  run: { roles: ['owner'], run: (ctx, input) => ctx.insert('ingest', 'sync_run', input) },
  product: { roles: ['owner'], run: (ctx, input) => ctx.insert('commerce', 'product', input) },
  idea: { roles: ['owner'], run: (ctx, input) => ctx.insert('content', 'idea', input) },
  sink: { roles: ['owner'], run: (ctx, input) => recordObservations(ctx, input.id, input.batch, input.entries) },
  source_policy: { roles: ['owner'], run: (ctx, input) => ctx.update('ingest', 'data_source', input.id, { allowed_uses: input.allowed_uses }, 1) },
  agent_annotate: { roles: ['owner'], run: (ctx, input) => {
    const authenticated = { ...ctx, agentClientId: 'agent-client' };
    return commands.annotate_creative_reference.run(authenticated, input);
  } },
};
const observation = (target: string, observed_at: string, likes: number) => ({
  watch_target_id: target, subject_type: 'post', external_id: 'post-1', url: 'https://social.example/posts/1',
  published_at: '2026-11-17T10:00:00Z', observed_at, access: 'public', collection_authorized: true,
  metrics: { likes: { availability: 'observed', value: likes } }, attributes: { title: 'Paper journal launch' },
});

function workspace() {
  const ws = testWorkspace();
  const run = (action: string, input: Parameters<typeof ws.run>[2] = {}, options?: Parameters<typeof ws.run>[3]) => ws.run(commands, action, input, options);
  return { ...ws, intel: run };
}

describe('Intel workflows', () => {
  it('isolates watch targets, preserves immutable snapshots, and compares one sample per subject in each age bucket', async () => {
    const { intel, list, events } = workspace();
    await expect(intel('create_watch_target', targetData, { role: 'viewer' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(intel('create_watch_target', { ...targetData, query: { handle: 'paper-co', crawl: true } })).rejects.toMatchObject({ code: 'invalid_input' });
    const watch = await intel('create_watch_target', targetData, { role: 'editor' });
    const first = observation(watch.id, '2026-11-17T14:00:00Z', 0);
    await expect(intel('record_observation', first, { workspaceId: 'different' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(intel('record_observation', { ...first, collection_authorized: false })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    await expect(intel('record_observation', { ...first, metrics: { reach: { availability: 'observed', value: 50 } } })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    await expect(intel('record_observation', { ...first, metrics: { sales: { availability: 'source_not_provided', value: 0 } } })).rejects.toMatchObject({ code: 'invalid_input' });
    const obs = await intel('record_observation', first);
    const sameBucket = await intel('record_observation', observation(watch.id, '2026-11-17T17:00:00Z', 10));
    await intel('record_observation', observation(watch.id, '2026-11-19T10:00:00Z', 100));
    expect(obs.data.metrics).toMatchObject({ likes: { value: 0, availability: 'observed' }, reach: { availability: 'source_not_provided' } });
    expect(obs.data.age_at_observation).toBe(14400);
    expect(list('intel', 'observation').every(row => row.version === 1)).toBe(true);
    const comparison = await intel('compare_observations', { watch_target_ids: [watch.id], metric: 'likes', age_bucket: '0-24h', ...window }, { role: 'viewer' });
    expect(comparison.items).toEqual([expect.objectContaining({ average: 10, post_count: 1, sample_size: 1, evidence_observation_ids: [sameBucket.id] })]);
    const timeline = await intel('observation_timeline', { watch_target_id: watch.id, missing_metric: 'reach' });
    expect(timeline.items).toHaveLength(3);
    await intel('update_watch_target', { id: watch.id, expected_version: watch.version, status: 'paused' });
    await expect(intel('record_observation', first)).rejects.toMatchObject({ code: 'invalid_state' });
    expect(events().filter(event => event.event === 'intel.observation.recorded')).toHaveLength(3);
  });

  it('enforces source field coverage, expiry, export permission, and stale alert deduplication', async () => {
    const { intel, run, events } = workspace();
    const source = await run(seed, 'source', sourceData);
    const input = { ...targetData, data_mode: 'import', data_source_id: source.id };
    await expect(intel('create_watch_target', input, { role: 'editor' })).rejects.toMatchObject({ code: 'forbidden' });
    const target = await intel('create_watch_target', input);
    const base = { ...observation(target.id, '2026-11-19T11:30:00Z', 15), access: 'authorized' };
    await expect(intel('record_observation', { ...base, metrics: { sales: { availability: 'observed', value: 5 } } })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    const obs = await intel('record_observation', { ...base, metrics: { impressions: { availability: 'observed', value: 5 } } });
    expect(obs.data.source).toMatchObject({ method: 'import', data_source_id: source.id, observed_at: '2026-11-19T11:30:00.000Z' });
    const board = await intel('create_research_board', { title: 'Journals', kind: 'research' });
    const item = await intel('add_research_item', { board_id: board.id, item_type: 'observation', ref_id: obs.id });
    await expect(intel('generate_research_digest', { title: 'Digest', period: window, fact_item_ids: [item.id], recommendation_item_ids: [] })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    const expired = await intel('observation_timeline', { watch_target_id: target.id }, { now: '2026-11-27T12:00:00Z' });
    expect(expired.items).toEqual([]);
    await run(seed, 'gap', { data_source_id: source.id, status: 'open', gap_type: 'source_outage' });
    const rule = await intel('create_alert_rule', { name: 'New posts', watch_target_ids: [target.id], condition: { type: 'new_post' } });
    const { items: [alert] } = await intel('evaluate_alert_rule', { rule_id: rule.id });
    const acknowledged = await intel('update_alert', { id: alert.id, expected_version: alert.version, status: 'acknowledged' });
    expect(acknowledged.data.alert_type).toBe('source_stale');
    expect((await intel('evaluate_alert_rule', { rule_id: rule.id })).items[0].id).toBe(alert.id);
    expect(events().filter(event => event.event === 'intel.alert.raised')).toHaveLength(1);
  });

  it('requires a matching successful ingest batch and keeps vendor estimates identifiable', async () => {
    const { intel, run, list } = workspace();
    const source = await run(seed, 'source', { ...sourceData, kind: 'vendor', provider: 'vendor:licensed', contract_ref: 'agreement-v1',
      resources: ['products'], field_coverage: { products: { status: 'available', fields: ['title', 'sales'] } } });
    const watch = await intel('create_watch_target', { ...targetData, data_mode: 'vendor', data_source_id: source.id });
    const row = { ...observation(watch.id, '2026-11-19T11:30:00Z', 0), subject_type: 'product', access: 'authorized',
      metrics: { sales: { availability: 'estimated', value: 80 } } };
    const failed = await run(seed, 'run', { data_source_id: source.id, status: 'failed' });
    await expect(run(seed, 'sink', { id: source.id, batch: failed.id, entries: [row] })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    await expect(intel('record_observation', row)).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    const batch = await run(seed, 'run', { data_source_id: source.id, status: 'succeeded', resource: 'products' });
    const [obs] = await run(seed, 'sink', { id: source.id, batch: batch.id, entries: [row] });
    expect(obs.data.source).toMatchObject({ batch_id: batch.id, estimate: true, method: 'vendor' });
    await run(seed, 'sink', { id: source.id, batch: batch.id, entries: [row] });
    expect(list('intel', 'observation')).toHaveLength(1);
  });

  it('requires independent scored dimensions, decision authority and a real product', async () => {
    const { intel, run, list, events } = workspace();
    const board = await intel('create_research_board', { title: 'Opportunity', kind: 'product_opportunity' });
    const unsupported = await intel('add_research_item', { board_id: board.id, item_type: 'note', body: 'A theory', authorship: 'agent', stance: 'demand' });
    const demand = await intel('add_research_item', { board_id: board.id, item_type: 'link', url: 'https://social.example/journal', stance: 'demand' });
    const supply = await intel('add_research_item', { board_id: board.id, item_type: 'note', body: 'Supplier quote', stance: 'evidence' });
    expect(unsupported.data.stance).toBe('hypothesis');
    const proposed = await intel('create_product_candidate', { name: 'Journal', estimated_cost: { amount_minor: 500, currency: 'USD' }, actual_quote: { amount_minor: 550, currency: 'USD' } });
    const move = (row: { id: string; version: number }, status: string, extra = {}, options?: Parameters<typeof intel>[2]) =>
      intel('transition_product_candidate', { id: row.id, expected_version: row.version, status, ...extra }, options);
    const researching = await move(proposed, 'researching');
    const doScore = (revision: number, dimension: string, id: string, authorship = 'human') => intel('score_product_candidate',
      { candidate_id: proposed.id, expected_version: revision, dimension, score: 75, uncertainty: 'medium', evidence_item_ids: [id], authorship });
    const scored = await doScore(researching.version, 'demand_evidence', demand.id);
    const theory = await doScore(scored.candidate.version, 'supply_feasibility', unsupported.id, 'agent');
    expect(theory.score.data.status).toBe('hypothesis');
    await expect(move(theory.candidate, 'validating')).rejects.toMatchObject({ code: 'invalid_state' });
    const rescored = await doScore(theory.candidate.version, 'supply_feasibility', supply.id);
    const validating = await move(rescored.candidate, 'validating');
    const accept = { reason: 'Supplier and customer signals support a trial', linked_product_id: 'missing' };
    await expect(move(validating, 'accepted', accept, { role: 'editor' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(move(validating, 'accepted', accept)).rejects.toMatchObject({ code: 'not_found' });
    const product = await run(seed, 'product', { title: 'Journal', status: 'draft' });
    const accepted = await move(validating, 'accepted', { ...accept, linked_product_id: product.id }, { role: 'reviewer' });
    expect(accepted.data).toMatchObject({ status: 'accepted', linked_product_id: product.id, actual_quote: { amount_minor: 550 }, estimated_cost: { amount_minor: 500 } });
    expect(list('intel', 'candidate_score')).toHaveLength(3);
    expect(events().filter(event => event.event === 'intel.candidate.decided')).toHaveLength(1);
    const store = await run(commerceCommands, 'create_store', { provider: 'file_import', name: 'Trial store', default_currency: 'USD', default_locale: 'en-US' });
    let second = await intel('create_product_candidate', { name: 'Refill' });
    second = await move(second, 'researching');
    for (const [dimension, item] of [['demand_evidence', demand], ['supply_feasibility', supply]]) {
      const output = await intel('score_product_candidate', { candidate_id: second.id, expected_version: second.version, dimension,
        score: 75, uncertainty: 'medium', evidence_item_ids: [item.id] });
      second = output.candidate;
    }
    second = await move(second, 'validating');
    const acceptance = { reason: 'Start a trial draft', draft_store_id: store.id };
    await expect(move(second, 'accepted', acceptance, { beforeWrite(module, kind) {
      if (module === 'intel' && kind === 'product_candidate') throw new Error('Simulated candidate write failure');
    } })).rejects.toThrow('Simulated candidate write failure');
    expect(list('commerce', 'product')).toHaveLength(1);
    const draft = await move(second, 'accepted', acceptance);
    expect(list('commerce', 'product')).toContainEqual(expect.objectContaining({ id: draft.data.linked_product_id,
      data: expect.objectContaining({ title: 'Refill', status: 'draft', store_id: store.id }) }));
  });

  it('resolves exact evidence through a creative reference and blocks expired or revoked chains', async () => {
    const { intel, run } = workspace();
    const source = await run(seed, 'source', sourceData);
    const target = await intel('create_watch_target', { ...targetData, data_mode: 'import', data_source_id: source.id });
    const snapshot = await intel('record_observation', { ...observation(target.id, '2026-11-19T10:00:00Z', 15), access: 'authorized' });
    const later = await intel('record_observation', { ...observation(target.id, '2026-11-19T11:30:00Z', 20), access: 'authorized' });
    const creative = await intel('create_creative_reference', { url: snapshot.data.url, watch_target_id: target.id,
      observation_id: snapshot.id, structure: { topic: 'Paper journal' } });
    const board = await intel('create_research_board', { title: 'Journal', kind: 'creative' });
    const item = await intel('add_research_item', { board_id: board.id, item_type: 'creative_reference', ref_id: creative.id });
    const note = await intel('add_research_item', { board_id: board.id, item_type: 'note', body: 'Verified comparison', authorship: 'agent', stance: 'demand', evidence_refs: [item.id] });
    const result = await intel('resolve_research_evidence', { id: note.id }, { role: 'viewer' });
    expect(result.item.data).toMatchObject({ stance: 'demand', authorship: 'agent' });
    expect(result.evidence.map((row: { id: string; kind: string }) => [row.kind, row.id])).toEqual([
      ['research_item', item.id], ['creative_reference', creative.id], ['observation', snapshot.id],
    ]);
    expect((await intel('search_research', { kind: 'observation', from: '2026-11-19T10:30:00Z', to: '2026-11-19T11:45:00Z' })).items)
      .toEqual([expect.objectContaining({ id: later.id, kind: 'observation' })]);
    expect((await intel('search_research', { id: snapshot.id, kind: 'observation' })).items)
      .toEqual([expect.objectContaining({ id: snapshot.id, kind: 'observation', version: snapshot.version })]);
    await expect(intel('resolve_research_evidence', { id: note.id }, { workspaceId: 'other' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(intel('resolve_research_evidence', { id: note.id }, { now: '2026-11-27T00:00:00Z' })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    await run(seed, 'source_policy', { id: source.id, allowed_uses: { ...sourcePolicy, team_share: false } });
    await expect(intel('resolve_research_evidence', { id: note.id })).rejects.toMatchObject({ code: 'EGRESS_BLOCKED' });
    expect((await intel('list_creative_references')).items).toEqual([]);
    expect((await intel('search_research', { keyword: 'journal' })).items).toEqual([]);
  });

  it('attributes creative structure to an authenticated agent and supports manual revision without a model', async () => {
    const { intel, run, list } = workspace();
    const creative = await intel('create_creative_reference', { url: 'https://example.com/reference', structure: { hook: 'Reveal' } });
    const agent = await run(seed, 'agent_annotate', { id: creative.id, expected_version: creative.version,
      structure_source: 'human', structure: { topic: 'Journals' } });
    expect(agent.data).toMatchObject({ rights: 'reference_only', structure_source: 'mixed', structure_authors: { hook: 'human', topic: 'agent' } });
    const human = await intel('annotate_creative_reference', { id: creative.id, expected_version: agent.version,
      structure: { topic: 'Notebooks' } }, { actorId: 'editor-1' });
    expect(human.data).toMatchObject({ structure_source: 'human', structure_updated_by_id: 'editor-1', model_ref: null,
      structure: { hook: 'Reveal', topic: 'Notebooks' }, structure_authors: { hook: 'human', topic: 'human' } });
    expect(list('asset', 'asset')).toEqual([]);
  });

  it('links research handoffs, computes observed trend increments, and retains superseded mention labels', async () => {
    const { intel, run } = workspace();
    const watch = await intel('create_watch_target', targetData);
    const baseline = await intel('record_observation', observation(watch.id, '2026-11-17T14:00:00Z', 10));
    const current = await intel('record_observation', observation(watch.id, '2026-11-19T10:00:00Z', 65));
    const topic = await intel('create_topic', { name: 'Journals', keywords: ['journal'], watch_target_ids: [watch.id] });
    const trend = await intel('compute_topic_trend', { topic_id: topic.id, metric: 'likes',
      comparison_period: { from: '2026-11-17T00:00:00Z', to: '2026-11-18T00:00:00Z' },
      period: { from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' } });
    expect(trend.data).toMatchObject({ sample_size: 1, observed_sample_size: 1, observed_increment: 55,
      estimated_sample_size: 0, estimated_increment: null, signal_type: 'discussion', evidence_observation_ids: [baseline.id, current.id],
      comparison_period: { from: '2026-11-17T00:00:00.000Z', to: '2026-11-18T00:00:00.000Z' },
      period: { from: '2026-11-19T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' } });
    const board = await intel('create_research_board', { title: 'Signals', kind: 'creative' });
    const item = await intel('add_research_item', { board_id: board.id, item_type: 'note', title: 'Test', body: 'Test a journal reveal' });
    const handoff = await intel('convert_research_item', { id: item.id, expected_version: item.version, destination: 'content.idea', summary: 'Test a reveal hook' });
    expect(handoff.data.status).toBe('pending');
    const idea = await run(seed, 'idea', { title: 'Journal reveal' });
    expect((await intel('link_research_handoff', { id: handoff.id, expected_version: handoff.version, target_id: idea.id })).data).toMatchObject({ status: 'linked', target_id: idea.id });
    const mention = await intel('record_mention', { watch_target_id: watch.id, url: 'https://social.example/post/2', observed_at: '2026-11-19T11:00:00Z',
      access: 'public', collection_authorized: true, text_excerpt: 'Is the journal available?' });
    const first = await intel('label_mention', { mention_id: mention.id, expected_version: mention.version, label_type: 'intent', value: 'uncertain' });
    const corrected = await intel('label_mention', { mention_id: mention.id, expected_version: mention.version + 1, label_type: 'intent', value: 'purchase_intent' });
    expect(corrected.data.overrides_label_id).toBe(first.id);
    expect((await intel('query_mentions', { watch_target_ids: [watch.id], period: window })).sample_size).toBe(1);
    const share = await intel('compute_share_of_voice', { watch_target_ids: [watch.id], period: window });
    expect(share.data).toMatchObject({ sample_size: 1, evidence_mention_ids: [mention.id], brand_counts: [{ scope_id: watch.id, count: 1, share: 1 }] });
    expect((await intel('escalate_mention', { id: mention.id, expected_version: mention.version + 2, destination: 'inbox.case', summary: 'Monitor customer questions' })).data.status).toBe('pending');
  });
});
