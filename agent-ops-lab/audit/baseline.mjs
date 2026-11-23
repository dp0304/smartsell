import { readFile } from 'node:fs/promises';

const history = new URL('../coverage/run-GwExwB/', import.meta.url);
async function readRows(file) {
  return (await readFile(new URL(file, history), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

for (const runtime of ['commands', 'operations']) {
  const [calls, audit] = await Promise.all([readRows(`${runtime}-calls.jsonl`), readRows(`${runtime}-audit.jsonl`)]);
  const exact = calls.filter(call => call.requestId && audit.some(row => row.request_id === call.requestId));
  const legacy = calls.filter(call => call.serverAuditIds.length > 0);
  const names = rows => new Set(rows.map(row => row.name)).size;
  console.log(JSON.stringify({
    runtime, calls: calls.length, distinctTools: names(calls),
    legacyMatchedCalls: legacy.length, legacyMatchedTools: names(legacy),
    callsWithRequestId: calls.filter(row => row.requestId).length,
    exportedAuditRows: audit.length, exactMatchedCalls: exact.length, exactMatchedTools: names(exact),
    recoveredPreviouslyUnlinkedCalls: exact.filter(call => !call.serverAuditIds.length).length,
  }));
}
