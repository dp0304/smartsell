import assert from 'node:assert/strict';
import test from 'node:test';
import type { Data, Row } from '@smartsell/contracts';
import type { ModelRequest } from '../agent/models.js';
import { testWorkspace as testCommandWorkspace } from '../ingest/test-context.js';
import { testWorkspace } from '../lifecycle/workspace-test-context.js';
import { commands } from './commands.js';
import { applyIntelEvent } from './intel-jobs.js';
import { analyzeCreativeReference, creativeValues, listCreativeReferences } from './intel-research.js';
import {
  classifyMention, escalateMention, labelMention, mentionLabels, queryMentions, recordMention, requestMentionClassification, shareOfVoice,
} from './intel-mentions.js';

function workspace() {
  const { ctx, events } = testWorkspace([]);
  const requests: ModelRequest[] = [];
  function configure(output = '{"sentiment":"negative","confidence":0.34}', purpose = 'classify') {
    const modelCtx = Object.assign(ctx, { agentModelServices: {
      ownsSecret: (_ctx: unknown, id: string) => id === 'local-test-secret',
      countInputTokens: () => 2,
      async invoke(_ctx: unknown, _destination: unknown, request: ModelRequest) {
        requests.push(request);
        return { output, inputTokens: 2, outputTokens: 1 };
      },
    } });
    const provider = modelCtx.create('model_provider', {
      status: 'active', secret_id: 'local-test-secret', protocol: 'openai_chat', endpoint: 'https://example.test',
      allowed_data_classes: ['public', 'internal'],
    });
    const route = modelCtx.create('model_route', { purpose, enabled: true, provider_id: provider.id, model: 'fixture-v2', max_output_tokens: 50 });
    const policy = modelCtx.create('egress_policy', { default_effect: 'allow' });
    return { policy, provider, route };
  }
  function target(brand: string, extra: Data = {}) {
    return ctx.create('watch_target', { status: 'active', brand_id: brand, platform: 'youtube', query: { keywords: ['bottle'] }, ...extra });
  }
  function mention(watch: Row, siteId: string, excerpt: string) {
    return recordMention(ctx, { watch_target_id: watch.id, external_id: siteId, url: `https://example.test/${siteId}`, text_excerpt: excerpt });
  }
  return { ctx, events, requests, configure, target, mention };
}

const classifyEvent = 'intel.mention.classification_requested';

test('classifies through AI07 and retains the original output across human corrections', async () => {
  const { ctx, events, requests, configure, target, mention } = workspace();
  const { provider, route } = configure();
  const post = mention(target('brand-a'), 'post-1', 'Interesting bottle design');
  const event = events.find(event => event.type === classifyEvent)!;
  assert.ok(event);
  const before = queryMentions(ctx, {});
  assert.equal(before.classification_available, true);
  assert.equal((before.items as Data[])[0]?.classification_available, true);
  assert.deepEqual(requestMentionClassification(ctx, post), { mention_id: post.id, status: 'queued' });
  const model = await applyIntelEvent(ctx, { type: event.type, payload: event.data }) as Row;
  assert.equal(model.labeled_by, 'model');
  assert.equal(model.model_ref, 'fixture-v2');
  assert.equal(model.model_route_id, route.id);
  assert.equal(model.model_route_version, route.version);
  assert.equal(model.model_provider_id, provider.id);
  assert.equal(model.confidence, 0.34);
  assert.equal(model.raw_value, 'negative');
  assert.equal(model.value, 'uncertain');
  assert.equal(await classifyMention(ctx, post.id), undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.purpose, 'classify');
  assert.deepEqual(JSON.parse(requests[0]!.fields[1]!.text), { untrusted_content: post.text_excerpt });

  const correction = labelMention(ctx, ctx.get('mention', post.id), { label_type: 'sentiment', value: 'neutral', overrides_label_id: model.id });
  const latest = labelMention(ctx, ctx.get('mention', post.id), { label_type: 'sentiment', value: 'mixed', overrides_label_id: correction.id });
  const result = queryMentions(ctx, { label: 'mixed' });
  assert.deepEqual((result.items as Data[])[0]?.labels, [latest]);
  assert.equal((result.items as Data[])[0]?.classification_available, false);
  assert.equal(queryMentions(ctx, { label: 'uncertain' }).sample_size, 0);
  assert.deepEqual(mentionLabels(ctx, ctx.get('mention', post.id)), {
    mention_id: post.id, latest_label_ids: { sentiment: latest.id }, items: [model, correction, latest],
  });
  assert.deepEqual(ctx.get('mention_label', model.id), model);
  assert.throws(() => labelMention(ctx, post, { label_type: 'sentiment', value: 'negative', overrides_label_id: model.id }), { code: 'INVALID_STATE' });
});

test('without a classify route, no model work is scheduled and manual labeling and escalation work', async () => {
  const { ctx, events, requests, configure, target, mention } = workspace();
  configure(undefined, 'draft');
  const brand = ctx.create('brand', { name: 'Bottle Brand', status: 'active' });
  const post = mention(target(brand.id), 'post-2', 'Question about the bottle');
  const result = queryMentions(ctx, {});
  assert.equal(result.classification_available, false);
  assert.equal((result.items as Data[])[0]?.classification_available, false);
  assert.throws(() => requestMentionClassification(ctx, post), { code: 'AI_NOT_CONFIGURED' });
  assert.ok(events.every(event => event.type !== classifyEvent));
  assert.equal(await classifyMention(ctx, post.id), undefined);
  assert.deepEqual(requests, []);
  assert.throws(() => labelMention(ctx, post, { label_type: 'sentiment', value: 'positive', model_ref: 'spoofed' }), { code: 'VALIDATION_ERROR' });
  assert.equal(labelMention(ctx, post, { label_type: 'sentiment', value: 'uncertain' }).labeled_by, 'human');
  const work = escalateMention(ctx, ctx.get('mention', post.id), { body: {}, params: {}, query: {} });
  assert.equal(work.resource_id, post.id);
  assert.equal(work.status, 'open');
});

test('source and workspace egress apply before scheduling and are rechecked before model dispatch', async () => {
  const { ctx, events, configure, target, requests } = workspace();
  const { policy } = configure();
  const allowed_uses = { display: true, model_processing: false, cache_days: 30 };
  const vendor = ctx.create('data_source', { status: 'active', kind: 'vendor', provider: 'vendor:approved', contract_ref: 'contract', resources: ['mentions'], allowed_uses });
  const watch = target('brand-vendor', { data_source_id: vendor.id, data_mode: 'vendor' });
  const post = recordMention(ctx, { watch_target_id: watch.id, data_source_id: vendor.id, url: 'https://example.test/vendor', text_excerpt: 'A vendor mention' }, 'vendor');
  assert.equal(events.length, 0);
  assert.throws(() => requestMentionClassification(ctx, post), { code: 'EGRESS_BLOCKED' });
  ctx.update('data_source', vendor.id, { allowed_uses: { ...allowed_uses, model_processing: true } });
  requestMentionClassification(ctx, post);
  ctx.update('egress_policy', policy.id, { rules: [{ destination_kind: 'model_provider', data_class: 'internal', effect: 'deny' }] });
  assert.equal((queryMentions(ctx, {}).items as Data[])[0]?.classification_available, false);
  assert.throws(() => requestMentionClassification(ctx, post), { code: 'EGRESS_DENIED' });
  const event = events.find(event => event.type === classifyEvent)!;
  assert.equal(await applyIntelEvent(ctx, { type: event.type, payload: event.data }), undefined);
  assert.deepEqual(requests, []);
  ctx.update('data_source', vendor.id, { allowed_uses: { ...allowed_uses, display: false } });
  assert.throws(() => mentionLabels(ctx, post), { code: 'EGRESS_BLOCKED' });
});

test('voice shares retain the query definition and the evidence for the deduplicated sample', () => {
  const { ctx, target, mention } = workspace();
  const first = target('brand-a');
  const duplicateTarget = target('brand-a');
  const second = target('brand-b');
  const matching = mention(first, 'same-post', 'Bottle in a video');
  const duplicate = mention(duplicateTarget, 'same-post', 'Bottle in a video');
  mention(second, 'other-post', 'Different topic');
  const query = { watch_target_ids: [second.id, first.id, duplicateTarget.id].join(','), sources: 'manual',
    from: '2026-11-18T00:00:00Z', to: '2026-11-20T00:00:00Z', keyword: 'BOTTLE' };
  const voice = shareOfVoice(ctx, query);
  assert.deepEqual(voice.brand_counts, { 'brand-a': 1, 'brand-b': 0 });
  assert.deepEqual(voice.shares, { 'brand-a': 1, 'brand-b': 0 });
  assert.equal(voice.sample_size, 1);
  assert.deepEqual(voice.evidence_mention_ids, [[matching.id, duplicate.id].sort()[0]]);
  assert.deepEqual(voice.query_definition, { watch_target_ids: [first.id, duplicateTarget.id, second.id], sources: ['manual'],
    period: { from: '2026-11-18T00:00:00.000Z', to: '2026-11-20T00:00:00.000Z' }, keyword: 'bottle',
    queries: [first, duplicateTarget, second].map(row => ({ id: row.id, query: row.query, version: row.version })),
  });
  assert.equal(shareOfVoice(ctx, { ...query, watch_target_ids: [first.id, second.id, duplicateTarget.id, first.id].join(','), keyword: 'bottle' }).query_def_hash, voice.query_def_hash);
  assert.notEqual(shareOfVoice(ctx, { ...query, keyword: 'different' }).query_def_hash, voice.query_def_hash);
  const search = queryMentions(ctx, query);
  assert.deepEqual(search.sample_sources, ['manual']);
  assert.equal(search.sample_size, 2);
  assert.equal((search.query_definition as Data).keyword, 'bottle');
});

test('command snapshots persist the same definition and evidence as their mention query', async () => {
  const { run } = testCommandWorkspace();
  const watch = await run(commands, 'create_watch_target', {
    name: 'Bottle watch', target_type: 'competitor_account', platform: 'tiktok', data_mode: 'manual', query: { handle: 'bottle-co' },
  });
  const post = await run(commands, 'record_mention', {
    watch_target_id: watch.id, url: 'https://example.test/mention', text_excerpt: 'Which bottle?',
    observed_at: '2026-11-19T10:00:00Z', access: 'public', collection_authorized: true,
  });
  const query = { watch_target_ids: [watch.id], keyword: 'BOTTLE', period: { from: '2026-11-19T00:00:00Z', to: '2026-11-20T00:00:00Z' } };
  const sample = await run(commands, 'query_mentions', query);
  const snapshot = await run(commands, 'compute_share_of_voice', query);
  assert.equal(snapshot.data.sample_size, 1);
  assert.deepEqual(snapshot.data.evidence_mention_ids, [post.id]);
  assert.deepEqual(snapshot.data.query_def, sample.query_def);
  assert.equal(snapshot.data.query_def_hash, sample.query_def_hash);
});

test('analyzes only a saved observation and preserves human creative fields', async () => {
  const { ctx, requests, configure, target } = workspace();
  const watch = target('brand-a');
  const observation = ctx.create('observation', { watch_target_id: watch.id, url: 'https://example.test/review',
    note: 'Opening shows a refill', attributes: { duration_s: 15 }, source: { method: 'manual' } });
  const reference = ctx.create('creative_reference', creativeValues(ctx, { url: observation.url, observation_id: observation.id,
    structure: { hook: 'Human observation' } }));
  assert.equal(listCreativeReferences(ctx, {})[0]?.analysis_available, false);
  await assert.rejects(() => analyzeCreativeReference(ctx, reference), { code: 'AI_NOT_CONFIGURED' });
  configure('{"hook":"Replacement","duration_s":15,"asset_id":"ignored"}', 'analyze');
  assert.equal(listCreativeReferences(ctx, {})[0]?.analysis_available, true);
  const updated = await analyzeCreativeReference(ctx, reference);
  assert.deepEqual(updated.structure, { hook: 'Human observation', duration_s: 15 });
  assert.deepEqual(updated.structure_authors, { hook: 'human', duration_s: 'agent' });
  assert.equal(updated.rights, 'reference_only');
  assert.deepEqual(JSON.parse(requests[0]!.fields[1]!.text), { untrusted_content: { duration_s: 15, note: 'Opening shows a refill' } });
  await assert.rejects(() => analyzeCreativeReference(ctx, { ...reference, observation_id: null }), { code: 'EGRESS_BLOCKED' });
  assert.equal(requests.length, 1);
});
