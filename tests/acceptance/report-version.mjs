import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function completedReportVersion(get, { operation_id: id }) {
  assert.ok(id, 'Report generation must return an operation ID');
  const until = performance.now() + 15_000;
  do {
    const job = await get(`/operations/${id}`);
    if (job.status === 'succeeded') return get(`/report-versions/${job.result_ref.version_id}`);
    assert.equal(job.status, 'queued', JSON.stringify(job));
    await delay(100);
  } while (performance.now() < until);
  assert.fail(`Report generation timed out: ${id}`);
}
