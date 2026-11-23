import { untested } from './scope.mjs';

const count = (list, key) => Object.fromEntries([...new Set(list.map(item => item[key]))].sort()
  .map(value => [value, list.filter(item => item[key] === value).length]));

export async function matrix({ catalog, calls, gaps, json, dir, redact }) {
  const operations = [...catalog.values()].map(op => {
    const attempts = calls.filter(call => call.operation === op.name);
    const statuses = new Set(attempts.map(call => call.status));
    const status = ['business_verified', 'valid_empty', 'boundary_confirmed', 'response_only', 'business_error', 'assertion_failed', 'transport_or_sdk_error']
      .find(value => statuses.has(value)) ?? attempts.at(-1)?.status ?? 'not_exercised';
    return { name: op.name, module: op.module, method: op.method, path: op.path, scope: 'visible to this local workspace write Agent',
      summary: op.summary, requiresVersion: op.requires_version ?? false, status,
      ...(attempts.length ? { attempts: attempts.map(({ seq, sentAt, receivedAt, status, audit, requestId, requestAudit, resultCount, code, error }) => ({
        seq, sentAt, receivedAt, status, audit, requestId, toolCallId: requestAudit.row?.call_id, resultCount, code, error,
      })) } : untested(op)) };
  });
  const other = calls.filter(call => !catalog.has(call.operation));
  const summary = { discovered: operations.length, modules: count(operations, 'module'), uniqueCalled: new Set(calls.map(call => call.operation)).size,
    discoveredCalled: operations.filter(op => op.attempts).length, attempts: calls.length,
    observedBusinessSuccesses: operations.filter(op => op.status === 'business_verified').length,
    catalogStatuses: count(operations, 'status'), callStatuses: count(calls, 'status'),
    auditPersistedCalls: calls.filter(call => call.audit.ids.length).length,
    auditRequestIdMatches: calls.filter(call => call.requestAudit.status === 'matched').length,
    observedNonemptyReadOperations: new Set(calls.filter(call => call.resultCount?.count > 0).map(call => call.operation)).size,
    observedZeroReadOperations: new Set(calls.filter(call => call.resultCount?.count === 0).map(call => call.operation)).size,
    untestedReasons: count(operations.filter(op => op.reasonCode), 'reasonCode'),
    callsOutsideCatalog: other.map(({ seq, operation, status }) => ({ seq, operation, status })), gaps };
  await json('matrix.json', operations);
  await json('summary.json', summary);
  const { writeFile } = await import('node:fs/promises');
  const { resolve } = await import('node:path');
  const header = '# 通用网关调度文本记录\n\nMCP TypeScript SDK 执行的工具请求／结果，无模型参与。完整请求、响应和时间见 calls.jsonl。\n';
  const excerpt = value => {
    const text = JSON.stringify(redact(value));
    return text.length > 700 ? `${text.slice(0, 700)}…（完整内容见 calls.jsonl）` : text;
  };
  await writeFile(resolve(dir, 'transcript.txt'), header + calls.map(call =>
    `\n[${call.sentAt}] #${call.seq} SDK → ${call.tool} ${call.operation}\n${excerpt(call.args)}\n[${call.receivedAt}] 网关 → ${call.status}${call.code ? ` (${call.code})` : ''}\n${excerpt(call.response?.structuredContent ?? call.response?.content ?? call.error ?? null)}\n工具审计 ${call.requestAudit.status} request_id=${call.requestId ?? ''} call_id=${call.requestAudit.row?.call_id ?? ''}\n业务写入审计 ${call.audit.status} ${call.audit.ids.join(' ')}\n`).join(''), { mode: 0o600 });
  const cell = value => String(value ?? '').replaceAll('|', '\\|').replace(/\r?\n/g, ' ');
  await writeFile(resolve(dir, 'matrix.md'), ['# SmartSell 通用网关覆盖矩阵', '',
    '每行来自本次 Agent 的实际发现。序号对应 [逐调用原始记录](calls.jsonl)，审计 ID 对应 [快照审计行](audit.json)。', '',
    '| 模块 | 子操作 | 路由 | 结果 | 调用、返回条数或未调原因 |', '|---|---|---|---|---|',
    ...operations.map(op => `| ${[op.module, op.name, `${op.method} ${op.path}`, op.status,
      op.attempts?.map(x => `#${x.seq}${x.resultCount ? ` · ${x.resultCount.path}=${x.resultCount.count}` : ''}`).join(', ') ?? `${op.reasonCode} · ${op.reason}`].map(cell).join(' | ')} |`), '',
  ].join('\n'), { mode: 0o600 });
  console.log(JSON.stringify(summary, null, 2));
}
