import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const [first, shop = first] = process.argv.slice(2);
assert.ok(first, 'usage: node verify.mjs runs/<video-collect-run> [runs/<shop-run>]');
const json = async (run, file) => JSON.parse(await readFile(resolve(run, file), 'utf8'));
const checks = {};
for (const [scenario, run] of [['01-video', first], ['02-shop', shop], ['03-collect', first]]) {
  const conversation = await json(run, `${scenario}/conversation.json`);
  const view = await json(run, `${scenario}/platform-readback.json`);
  const { rows } = await json(run, 'platform-audit-rows.json');
  assert.equal(conversation.length, 2);
  assert.ok(conversation.every(turn => turn.status === 'success' && turn.reply));
  assert.equal(view.deviceId, null);
  assert.equal(view.job.status, 'submitted');
  const events = rows.filter(r => r.kind === 'agent_job_event' && r.data.agent_job_id === view.job.id);
  assert.ok(events.some(e => e.data.type === 'claimed'));
  assert.ok(events.some(e => e.data.type === 'submitted'));
  checks[scenario] = { jobId: view.job.id, workItemId: view.job.work_item_id, jobStatus: view.job.status, deviceId: view.deviceId, platformAudit: events.map(e => ({ id: e.data.id, type: e.data.type, at: e.data.occurred_at })) };
  const check = checks[scenario];
  if (scenario === '01-video') {
    const [target] = view.targets;
    assert.equal(view.targets.length, 1);
    assert.equal(target.plan_status, 'awaiting_approval');
    assert.equal(target.execution_status, null);
    assert.equal(target.platform_post_id, null);
    assert.deepEqual(view.posts, []);
    assert.match(view.job.result_ref.note, /NO_AUTHORIZED_SOCIAL_SANDBOX/);
    Object.assign(check, { targetId: target.id, contentId: target.content_item_id, revisionId: target.variant_revision_id, scheduledAt: target.scheduled_at, zone: target.schedule_tz, state: target.plan_status, externalReceipt: null, block: 'NO_AUTHORIZED_SOCIAL_SANDBOX' });
  } else if (scenario === '02-shop') {
    const draft = view.products.find(p => p.title.endsWith('内建草稿'));
    const imported = view.products.find(p => p.title.endsWith('CSV 样品'));
    const batch = view.imports?.find(b => b.template_key === 'product_list');
    assert.equal(draft.external_product_id, null);
    assert.equal(draft.status, 'draft');
    assert.equal(view.store.connection_id, null);
    assert.equal(view.store.status, 'import_only');
    assert.match(view.job.result_ref.note, /NO_AUTHORIZED_STORE_SANDBOX/);
    assert.equal(batch.status, 'merged');
    assert.equal(batch.merged_rows, 1);
    assert.equal(batch.failed_rows, 0);
    assert.equal(imported.external_product_id, 'prism-import-01');
    assert.equal(view.importRows.find(b => b.batchId === batch.id).rows[0].status, 'merged');
    Object.assign(check, { internalProductId: draft.id, importedProductId: imported.id, importExternalKey: imported.external_product_id, importBatchId: batch.id, importStatus: batch.status, mergedRows: batch.merged_rows, remoteProductId: null, externalReceipt: null, block: 'NO_AUTHORIZED_STORE_SANDBOX' });
  } else {
    const [item] = view.board.items;
    assert.equal(view.board.items.length, 1);
    assert.equal(item.url, view.capture.source_url);
    const { authorization: storedAuthorization, ...stored } = JSON.parse(item.body);
    const { authorization: capturedAuthorization, ...captured } = view.capture;
    assert.deepEqual(stored, captured);
    assert.match(storedAuthorization, /授权/);
    if (capturedAuthorization !== '[REDACTED]') assert.equal(storedAuthorization, capturedAuthorization);
    Object.assign(check, { itemId: item.id, sourceUrl: item.url, observedAt: view.capture.observed_at, fields: view.capture.fields });
  }
}
console.log(JSON.stringify(checks, null, 2));
