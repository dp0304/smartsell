import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export async function checkReportXlsx(request, root) {
  const operation = async (path, body, status = 200, headers = {}) => (await (await request(`${root}${path}`, {
    body, status, headers: { ...(body !== undefined && { 'idempotency-key': randomUUID() }), ...headers },
  })).json()).data;
  async function completed(id) {
    const deadline = Date.now() + 30_000;
    do {
      const job = await operation(`/operations/${id}`);
      if (job.status === 'succeeded') return job.result_ref;
      assert.equal(job.status, 'queued', `Report operation ${id}: ${job.error_code ?? job.status}`);
      await delay(250);
    } while (Date.now() < deadline);
    assert.fail(`Report operation ${id} timed out`);
  }

  const report = await operation('/reports', {
    title: 'Production XLSX smoke', period: { from: '2026-01-01', to: '2026-02-01', tz: 'UTC' },
    sections: [{ key: 'notes', type: 'narrative' }],
  });
  const generation = await operation(`/reports/${report.id}/versions`, {}, 202);
  const { version_id, version_no } = await completed(generation.operation_id);
  const draft = await operation(`/report-versions/${version_id}`);
  const finalized = await operation(`/report-versions/${draft.id}/finalize`, {}, 200, { 'if-match': String(draft.version) });
  assert.equal(finalized.status, 'finalized');

  const { operation_id } = await operation(`/reports/${report.id}/versions/${version_no}/export`, { format: 'xlsx' }, 202);
  const exported = await completed(operation_id);
  assert.equal(exported.version_id, version_id);
  assert.equal(exported.format, 'xlsx');
  const download = await request(`${root}/report-exports/${operation_id}/download`);
  assert.equal(download.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.equal(download.headers.get('content-disposition'), `attachment; filename="report-v${version_no}.xlsx"`);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.deepEqual(bytes.subarray(0, 4), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  assert.ok(bytes.includes('xl/workbook.xml') && bytes.includes('xl/worksheets/sheet1.xml'));
  console.log(`Production XLSX export downloaded (${bytes.length} bytes)`);
  return bytes;
}
