import assert from 'node:assert/strict';
import test from 'node:test';
import { Problem, type Context, type Data, type Role, type Row } from '@smartsell/contracts';
import { operations as assetOperations } from '../asset/index.js';
import { applyIntelEvent, operations, prepareObservation, scanIntel } from './index.js';
import { importOperations } from '../ingest/import-operations.js';
import { watchTargetCoverage } from './intel-observations.js';

function workspace() {
  const tables = new Map<string, Row[]>();
  const events: Data[] = [];
  let next = 0;
  const ctx: Context = {
    role: 'owner', actorId: 'alice', tenantId: 'tenant', workspaceId: 'workspace', now: '2026-11-22T00:00:00.000Z',
    list: kind => tables.get(kind) ?? [],
    get(kind, id) {
      const row = ctx.list(kind).find(row => row.id === id);
      if (!row) throw new Problem(404, 'NOT_FOUND', 'Missing row');
      return row;
    },
    create(kind, values) {
      const row = { ...values, id: `${kind}-${++next}`, version: 1, created_at: ctx.now, updated_at: ctx.now };
      tables.set(kind, [...ctx.list(kind), row]);
      return row;
    },
    update(kind, id, values) {
      const old = ctx.get(kind, id);
      const row = { ...old, ...values, version: old.version + 1, updated_at: ctx.now };
      tables.set(kind, ctx.list(kind).map(value => value.id === id ? row : value));
      return row;
    },
    remove(kind, id) { tables.set(kind, ctx.list(kind).filter(value => value.id !== id)); },
    emit(type, payload) { events.push({ type, payload }); },
  };
  function run(name: string, body: Data = {}, id = '', query: Record<string, string> = {}, role: Role = 'owner', expectedVersion?: number): any {
    const op = operations.find(op => op.name === name);
    assert.ok(op?.roles.includes(role), `Unknown or forbidden operation ${name}`);
    return op!.run({ ...ctx, role }, { body, params: { id }, query, expectedVersion });
  }
  return { ctx, events, run };
}

const observed = (target: Row, date = '2026-11-21T01:00:00Z', likes = 12): Data => ({
  watch_target_id: target.id, url: 'https://example.com/post', observed_at: date, published_at: '2026-11-21T00:00:00Z', subject_type: 'post',
  metrics: { likes: { value: likes, availability: 'observed' } }, attributes: { title: 'A post about insulated bottles' },
});

const addTarget = (run: ReturnType<typeof workspace>['run'], extra: Data = {}) => run('watch_target_create', { target_type: 'keyword', query: { keywords: ['bottle'] }, name: 'Bottle monitoring', ...extra });

test('observation sink is immutable, preserves missing metrics and compares within an age bucket', () => {
  const { ctx, run } = workspace();
  const target = addTarget(run);
  const first = prepareObservation(ctx, observed(target), 'import');
  assert.equal(first.status, 'create');
  const initial = first();
  assert.equal(initial.age_at_observation, 3600);
  assert.equal((initial.metrics as Data).reach && ((initial.metrics as Data).reach as Data).availability, 'source_not_provided');
  const replay = prepareObservation(ctx, observed(target, '2026-11-21T01:00:00Z', 45), 'import');
  assert.equal(replay.status, 'skip');
  assert.equal(replay().id, initial.id);
  assert.throws(() => prepareObservation(ctx, { ...observed(target), metrics: { impressions: { value: 12, availability: 'observed' } } }), /explicit source field permission/);
  run('observation_record', observed(target, '2026-11-21T05:00:00Z', 20));
  assert.equal(run('observations_compare', {}, '', { watch_target_ids: target.id, age: '24h' }).sample[0].average, 20);
  assert.equal(run('observations_compare', {}, '', { watch_target_ids: target.id, age: '7d' }).sample[0].sample_size, 0);
});

test('the approved CSV import feeds the REST timeline with provenance and explicit missing metrics', () => {
  const { ctx, run } = workspace();
  ctx.now = '2026-11-24T00:00:00.000Z';
  const source = ctx.create('data_source', {
    kind: 'file_import', provider: 'file_import', status: 'active', resources: ['posts'],
    field_coverage: { posts: { status: 'available', fields: ['likes'] } },
    allowed_uses: { display: true, team_share: true, export: false, cache_days: 30 },
  });
  const target = addTarget(run, { data_mode: 'import', data_source_id: source.id });
  assert.deepEqual((watchTargetCoverage(ctx, target).acquisition as Data).field_coverage, source.field_coverage);
  assert.equal((watchTargetCoverage(ctx, target).acquisition as Data).automated, false);
  const callImport = (name: string, body: Data, id = '') => importOperations.find(op => op.name === name)!.run(ctx, { body, query: {}, params: { id } }) as Row;
  const batch = callImport('import_create', { template_key: 'competitor_observation', data_source_id: source.id,
    csv_text: `watch_target_id,external_id,subject_type,url,published_at,observed_at,likes\n${target.id},p1,post,https://example.com/post,2026-11-21T00:00:00Z,2026-11-21T05:00:00Z,0\n${target.id},p1,post,https://example.com/post,2026-11-21T00:00:00Z,2026-11-22T00:00:00Z,20`,
  });
  assert.equal(ctx.list('observation').length, 0);
  assert.equal(callImport('import_confirm', {}, batch.id).status, 'merged');
  callImport('import_confirm', {}, batch.id);
  assert.equal(ctx.list('observation').length, 2);
  const [younger] = run('observations_list', {}, target.id, { subject_type: 'post', external_id: 'p1', age_bucket: '0-24h', metric: 'reach', availability: 'source_not_provided' });
  assert.equal(younger.age_at_observation, 18000);
  assert.deepEqual(younger.metrics.likes, { availability: 'observed', value: 0 });
  assert.deepEqual(younger.metrics.reach, { availability: 'source_not_provided' });
  assert.equal(younger.source.method, 'import');
  assert.equal(younger.source.batch_id, batch.id);
  assert.equal(younger.source.data_source_id, source.id);
  const [older] = run('observations_list', {}, target.id, { age_bucket: '1-7d' });
  assert.equal(older.age_at_observation, 86400);
  assert.throws(() => run('observations_list', {}, target.id, { metric: '__proto__', availability: 'source_not_provided' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => run('observations_list', {}, target.id, { age_bucket: 'unknown' }), { code: 'VALIDATION_ERROR' });
  assert.throws(() => run('observation_record', observed(target)), { code: 'INVALID_STATE' });
  assert.throws(() => prepareObservation(ctx, observed(target), 'import'), { code: 'INVALID_STATE' });
  ctx.update('data_source', source.id, { status: 'paused' });
  assert.deepEqual(run('observations_list', {}, target.id), []);
});

test('research evidence remains traceable through conversion and the candidate decision', async () => {
  const { ctx, run } = workspace();
  const brand = ctx.create('brand', { name: 'Brand' });
  const target = addTarget(run, { brand_id: brand.id });
  const snapshot = run('observation_record', observed(target));
  const board = run('research_board_create', { title: 'Bench research', brand_id: brand.id });
  const item = run('research_add_item', { item_type: 'observation', ref_id: snapshot.id, title: 'Snapshot' }, board.id);
  const note = run('research_create_note', { body: 'Try a recycled bottle', stance: 'evidence' }, board.id, {}, 'agent');
  assert.equal(note.stance, 'hypothesis');
  const converted = await run('research_item_convert', { destination: 'idea' }, item.id);
  assert.ok(ctx.get('idea', converted.converted_to.id));
  const candidate = run('product_candidate_create', { name: 'Insulated bottle', brand_id: brand.id });
  await run('product_candidate_update', { status: 'researching' }, candidate.id);
  await assert.rejects(() => run('product_candidate_update', { status: 'validating' }, candidate.id), /two dimensions/);
  for (const dimension of ['demand_evidence', 'product_fit']) run('product_candidates_score', { dimension, score: 75, uncertainty: 0.2, evidence_item_ids: [item.id] }, candidate.id);
  await run('product_candidate_update', { status: 'validating' }, candidate.id);
  await assert.rejects(() => run('product_candidate_decide', { status: 'accepted' }, candidate.id), /decision_reason/);
  const store = ctx.create('store', { brand_id: brand.id, status: 'active' });
  const adopted = await run('product_candidate_decide', { status: 'accepted', decision_reason: 'Evidence and fit confirmed', product_draft: { store_id: store.id } }, candidate.id);
  assert.equal(adopted.status, 'accepted');
  assert.equal(ctx.get('product', adopted.linked_product_id).status, 'draft');
});

test('vendor policy blocks export and freshness gaps suppress signal alerts', () => {
  const { ctx, events, run } = workspace();
  const vendor = ctx.create('data_source', { kind: 'vendor', status: 'active', provider: 'vendor:approved', resources: ['post_metrics'], contract_ref: 'contract', allowed_uses: { display: true, team_share: true, export: false, cache_days: 30 } });
  const target = addTarget(run, { data_mode: 'vendor', data_source_id: vendor.id });
  run('alert_rule_create', { name: 'New post', watch_target_ids: [target.id], condition: { type: 'new_post' } });
  ctx.create('data_gap', { data_source_id: vendor.id, gap_type: 'freshness', status: 'open' });
  const snapshot = prepareObservation(ctx, { ...observed(target), data_source_id: vendor.id }, 'vendor')();
  const event = events.find(event => event.type === 'intel.observation.recorded')!;
  applyIntelEvent(ctx, event);
  applyIntelEvent(ctx, event);
  assert.deepEqual(ctx.list('alert').map(row => row.alert_type), ['source_stale']);
  const board = run('research_board_create', { title: 'Draft' });
  run('research_add_item', { item_type: 'observation', ref_id: snapshot.id }, board.id);
  assert.throws(() => run('research_digest_create', { board_id: board.id, period: { from: '2026-11-21T00:00:00Z', to: '2026-11-23T00:00:00Z' } }, '', {}, 'owner', board.version), { code: 'EGRESS_BLOCKED' });
});

test('agent conclusions resolve exact evidence and respect revoked source permissions', () => {
  const { ctx, run } = workspace();
  const source = ctx.create('data_source', { kind: 'vendor', status: 'active', provider: 'vendor:approved',
    resources: ['post_metrics'], contract_ref: 'contract', allowed_uses: { display: true, team_share: true, model_processing: true, cache_days: 30 } });
  const target = addTarget(run, { data_mode: 'vendor', data_source_id: source.id });
  const first = prepareObservation(ctx, { ...observed(target), data_source_id: source.id }, 'vendor')();
  prepareObservation(ctx, { ...observed(target, '2026-11-21T02:00:00Z', 17), data_source_id: source.id }, 'vendor')();
  const board = run('research_board_create', { title: 'Evidence' });
  const evidence = run('research_add_item', { item_type: 'observation', ref_id: first.id, stance: 'evidence' }, board.id);
  const theory = run('research_create_note', { body: 'Unverified inference', stance: 'demand' }, board.id, {}, 'agent');
  const unsourced = run('research_create_note', { body: 'Another inference', stance: 'demand', evidence_refs: [theory.id] }, board.id, {}, 'agent');
  assert.equal(unsourced.stance, 'hypothesis');
  const note = run('research_create_note', { body: 'Exact evidence', stance: 'demand', evidence_refs: [evidence.id] }, board.id, {}, 'agent');
  const resolved = run('research_item_evidence', {}, note.id);
  assert.equal(resolved.item.stance, 'demand');
  assert.deepEqual(resolved.evidence.map(({ kind, id }: { kind: string; id: string }) => [kind, id]),
    [['research_item', evidence.id], ['observation', first.id]]);
  ctx.update('data_source', source.id, { allowed_uses: { display: true, team_share: true, model_processing: false, cache_days: 30 } });
  Object.assign(ctx, { agentCredentialId: 'owner-agent-credential' });
  assert.throws(() => run('research_item_evidence', {}, note.id), { code: 'EGRESS_BLOCKED' });
  assert.throws(() => run('research_create_note', { body: 'Reused evidence', evidence_refs: [evidence.id] }, board.id), { code: 'EGRESS_BLOCKED' });
  assert.deepEqual(run('research_search', {}, '', { keyword: 'bottle' }).observations, []);
  const credentialNote = run('research_create_note', { body: 'Agent hypothesis', stance: 'demand' }, board.id);
  assert.equal(credentialNote.authorship, 'agent');
  Object.assign(ctx, { agentCredentialId: undefined });
  assert.equal(run('research_item_evidence', {}, note.id).item.id, note.id);
  const exact = run('research_search', {}, '', { id: first.id, kind: 'observation' });
  assert.deepEqual(exact.observations.map((row: Row) => [row.id, row.created_at]), [[first.id, first.created_at]]);
  ctx.update('data_source', source.id, { allowed_uses: { display: true, team_share: false, cache_days: 30 } });
  assert.throws(() => run('research_item_evidence', {}, note.id), { code: 'EGRESS_BLOCKED' });
  const visibleIds = [theory.id, unsourced.id, credentialNote.id].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(run('research_board_get', {}, board.id).items.map((item: Row) => item.id), visibleIds);
});

test('creative references support mixed authorship and are excluded from the asset picker', () => {
  const { ctx, run } = workspace();
  const reference = run('creative_reference_create', { url: 'https://example.com/reference', structure: { hook: 'Reveal' }, tags: ['short'] });
  assert.equal(reference.structure_source, 'human');
  const annotated = run('creative_reference_annotate', { structure: { topic: 'Insulated bottles' } }, reference.id, {}, 'agent');
  assert.deepEqual(annotated.structure_authors, { hook: 'human', topic: 'agent' });
  assert.equal(annotated.structure_source, 'mixed');
  const revised = run('creative_reference_annotate', { structure: { topic: 'Reusable bottles' } }, reference.id);
  assert.equal(revised.structure_source, 'human');
  assert.equal(revised.rights, 'reference_only');
  assert.deepEqual(run('creative_references_list', {}, '', { tag: 'short' }).map((row: Row) => row.id), [reference.id]);
  assert.throws(() => run('creative_reference_create', { url: revised.url, asset_id: 'asset-1' }), { code: 'VALIDATION_ERROR' });
  const asset = ctx.create('asset', { title: 'Uploaded reference', status: 'ready' });
  const picker = assetOperations.find(op => op.name === 'asset_search')!;
  assert.deepEqual(picker.run(ctx, { body: {}, params: {}, query: { status: 'ready' } }), [asset]);
});

test('topic trend returns explicit ranges and exact observations for each sample', () => {
  const { run } = workspace();
  const target = addTarget(run);
  const baselineStart = run('observation_record', observed(target, '2026-11-21T01:00:00Z', 10));
  const baselineEnd = run('observation_record', observed(target, '2026-11-21T04:00:00Z', 14));
  const currentStart = run('observation_record', observed(target, '2026-11-21T08:00:00Z', 30));
  const currentEnd = run('observation_record', observed(target, '2026-11-21T10:00:00Z', 40));
  run('observation_record', observed(target, '2026-11-21T12:00:00Z', 100));
  const topic = run('research_topic_create', { name: 'Bottles', keywords: ['bottle'], watch_target_ids: [target.id] });
  const query = { metric: 'likes', from: '2026-11-21T08:00:00Z', to: '2026-11-21T12:00:00Z',
    comparison_from: '2026-11-21T00:00:00Z', comparison_to: '2026-11-21T05:00:00Z' };
  const result = run('research_topic_trend', {}, topic.id, query);
  assert.deepEqual(result.period, { from: '2026-11-21T08:00:00.000Z', to: '2026-11-21T12:00:00.000Z' });
  assert.deepEqual(result.comparison_period, { from: '2026-11-21T00:00:00.000Z', to: '2026-11-21T05:00:00.000Z' });
  assert.equal(result.sample_size, 1);
  assert.equal(result.observed_increment, 10);
  assert.equal(result.purchase_intent_sample_size, 0);
  assert.deepEqual(result.evidence_observation_ids, [currentStart.id, currentEnd.id]);
  assert.equal(result.comparison.observed_increment, 4);
  assert.deepEqual(result.comparison.evidence_observation_ids, [baselineStart.id, baselineEnd.id]);
  assert.throws(() => run('research_topic_trend', {}, topic.id, { ...query, comparison_to: query.to }), { code: 'VALIDATION_ERROR' });
});

test('scheduled freshness and failure events share an alert and deliver one in-app notification per member', () => {
  const { ctx, events, run } = workspace();
  const source = ctx.create('data_source', { kind: 'file_import', status: 'active', provider: 'file_import', resources: ['posts'],
    allowed_uses: { display: true, team_share: true, cache_days: 30 } });
  const target = addTarget(run, { data_mode: 'import', data_source_id: source.id });
  const rule = run('alert_rule_create', { name: 'New post', watch_target_ids: [target.id], condition: { type: 'new_post' },
    min_freshness: 7200, recipients: ['alice', 'bob', 'scoped', 'missing'] });
  const snapshot = prepareObservation(ctx, { ...observed(target), data_source_id: source.id }, 'import')();
  Object.assign(ctx, { activeWorkspaceMembers: [
    { userId: 'alice', role: 'owner' }, { userId: 'bob', role: 'editor' }, { userId: 'scoped', role: 'viewer', scopes: ['brand:other'] },
  ] });
  ctx.create('notification_preference', { user_id: 'bob', type_pattern: 'intel_*', channels: [] });
  scanIntel(ctx);
  const [alert] = ctx.list('alert');
  assert.equal(alert.alert_type, 'source_stale');
  assert.equal(alert.last_success_at, snapshot.observed_at);
  assert.equal(alert.source_age_seconds, 23 * 3600);
  const gap = ctx.create('data_gap', { data_source_id: source.id, status: 'open', gap_type: 'source_outage' });
  const failure = { type: 'ingest.data_gap.detected', payload: { data_gap_id: gap.id } };
  run('alert_update', { status: 'acknowledged' }, alert.id);
  applyIntelEvent(ctx, failure);
  scanIntel(ctx);
  assert.deepEqual(ctx.list('alert').map(row => [row.id, row.status]), [[alert.id, 'acknowledged']]);
  const raised = events.filter(event => event.type === 'intel.alert.raised');
  assert.equal(raised.length, 1);
  applyIntelEvent(ctx, raised[0]);
  applyIntelEvent(ctx, raised[0]);
  assert.deepEqual(ctx.list('notification').map(row => row.recipient_user_id), ['alice', 'bob']);
  assert.deepEqual(ctx.list('notification_delivery').map(row => row.status), ['delivered', 'suppressed']);

  ctx.update('data_gap', gap.id, { status: 'resolved' });
  const fresh = prepareObservation(ctx, { ...observed(target, '2026-11-21T23:00:00Z'), external_id: 'p2', data_source_id: source.id }, 'import')();
  applyIntelEvent(ctx, { type: 'intel.observation.recorded', payload: { observation_ids: [fresh.id] } });
  assert.equal(ctx.get('alert', alert.id).source_recovered_at, ctx.now);
  assert.deepEqual(ctx.list('alert').filter(row => row.alert_type === 'signal').map(row => row.evidence_observation_ids), [[fresh.id]]);
  assert.equal(ctx.list('alert')[0].rule_id, rule.id);
});

test('vendor field permission, estimates, and expiry are enforced', () => {
  const { ctx, run } = workspace();
  const source = ctx.create('data_source', {
    kind: 'vendor', status: 'active', provider: 'vendor:approved', contract_ref: 'contract',
    resources: ['product_metrics'], field_coverage: { product_metrics: { fields: ['sales'] } },
    allowed_uses: { display: true, cache_days: 1 },
  });
  const target = addTarget(run, { data_mode: 'vendor', data_source_id: source.id });
  const snapshot = prepareObservation(ctx, { ...observed(target), subject_type: 'product', data_source_id: source.id,
    metrics: { sales: { value: 20, availability: 'observed' } },
  }, 'vendor')();
  assert.equal((snapshot.source as Data).estimate, true);
  assert.throws(() => prepareObservation(ctx, { ...observed(target), data_source_id: source.id }, 'vendor'), /does not cover/);
  ctx.now = '2026-11-23T00:00:00.000Z';
  assert.deepEqual(run('observations_list', {}, target.id), []);
  assert.equal(scanIntel(ctx).removed, 1);
});

test('mention labels retain the previous value and share of voice describes its sample', () => {
  const { ctx, run } = workspace();
  const brand = ctx.create('brand', { name: 'Brand' });
  const target = addTarget(run, { brand_id: brand.id, platform: 'youtube' });
  const mention = run('mention_record', { watch_target_id: target.id, url: 'https://example.com/mention', text_excerpt: 'Unclear tone' });
  const prior = run('mention_label_update', { label_type: 'sentiment', value: 'negative' }, mention.id);
  const current = run('mention_label_update', { label_type: 'sentiment', value: 'uncertain' }, mention.id);
  assert.equal(current.overrides_label_id, prior.id);
  assert.equal(run('mentions_query').items[0].labels[0].value, 'uncertain');
  const sample = run('share_of_voice_get', {}, '', { watch_target_ids: target.id, sources: 'manual', from: '2026-11-21T00:00:00Z', to: '2026-11-23T00:00:00Z' });
  assert.equal(sample.sample_size, 1);
  assert.equal(sample.brand_counts[brand.id], 1);
  assert.equal(run('mention_escalate', {}, mention.id).resource_id, mention.id);
});
