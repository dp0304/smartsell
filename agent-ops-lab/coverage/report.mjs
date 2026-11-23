import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const coverage = dirname(fileURLToPath(import.meta.url));
const evidence = resolve(process.argv[2] ?? '');
assert.equal(dirname(evidence), coverage);
assert.match(basename(evidence), /^run-[\w-]+$/);
const dir = basename(evidence);
const read = file => readFile(resolve(evidence, file), 'utf8');
const json = async file => JSON.parse(await read(file));
const optionalJson = async file => {
  try { return await json(file); } catch (error) { if (error.code !== 'ENOENT') throw error; return []; }
};
const jsonl = async file => (await read(file)).trim().split('\n').map(JSON.parse);
const source = await optionalJson('source.json');
const sourceLabel = source.kind ? ` · ${source.kind}` : '';
const statuses = ['成功', '目录验证', '预期拒绝', '具体失败', '外部依赖', '未实调'];
const report = [
  `# SmartSell MCP 逐工具验收${sourceLabel}`, '',
  ...(source.kind ? [`源码 \`${source.path}\`。 [运行来源](${dir}/source.json)`, ''] : []),
  `本次证据目录为 [${dir}](${dir}/summary.json)。两个产品 runtime 使用各自的临时数据库、账号和工作区，通过随机回环端口访问。`, '',
  '| Runtime | 具名工具 | 业务成功 | 目录验证 | 预期拒绝 | 具体失败 | 外部依赖 | 未实调 | 原生 CC 有回执 |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
];
const section = [];
const timeline = [`# 脱敏终端会话${sourceLabel}`, '', '原生会话记录本次运行的请求、实际 Claude Code 可见回复、工具调用与回执。MCP SDK 用例中的用户请求与回复由测试夹具生成。时间使用 UTC。带签名的游标和租约令牌已脱敏，可用运行器重新生成。'];
const summary = await json('summary.json');
const strictRun = summary.some(data => data.strict);
const sumAudit = (driver, key) => summary.reduce((sum, data) => sum + (data.strict?.[driver]?.[key] ?? 0), 0);
const unique = new Set();
let total = 0;
let nativeCoverage = 0;
let sdkOutputChecks = 0;
const counts = Object.fromEntries(statuses.map(status => [status, 0]));
for (const data of summary) {
  assert(!data.fatal, `${data.runtime} aborted`);
  const { runtime } = data;
  const matrix = await json(`${runtime}-matrix.json`);
  const discovery = await json(`${runtime}-discovery.json`);
  const calls = await jsonl(`${runtime}-calls.jsonl`);
  const audits = await jsonl(`${runtime}-audit.jsonl`);
  const native = await jsonl(`${runtime}-native.jsonl`);
  const legacy = await optionalJson(`${runtime}-legacy-only.json`);
  const revocations = await json(`${runtime}-revocation.json`);
  const operations = await json(`${runtime}-operation-call.json`);
  const inventory = discovery.pages.flatMap(p => p.result.tools.map(tool => tool.name));
  assert.deepEqual(matrix.map(tool => tool.name), inventory);
  if (!strictRun) {
    assert(matrix.every(tool => tool.cases.length && tool.nativeCalls.length));
    assert.equal(new Set(native.filter(event => event.role === 'tool_result').map(event => event.name)).size, matrix.length);
  }
  assert(native.filter(event => event.role === 'exit').every(event => event.code === 0));
  assert.equal(revocations.length, 2);
  assert(revocations.every(revocation => revocation.passed));
  if (!strictRun) assert.equal(calls.filter(call => call.conclusion === '具体失败').length, 0);
  for (const call of calls) for (const id of call.serverAuditIds) {
    assert(audits.some(row => (row.auditId ?? row.id) === id && row.caseId === call.id));
  }
  const natives = new Set(native.filter(event => event.role === 'tool_result').map(event => event.name));
  const denominators = statuses.map(status => matrix.filter(tool => tool.conclusion === status).length);
  for (const [index, status] of statuses.entries()) counts[status] += denominators[index];
  for (const tool of matrix) unique.add(tool.name);
  total += matrix.length;
  nativeCoverage += natives.size;
  report.push(`| ${runtime} | ${matrix.length} | ${denominators.join(' | ')} | ${natives.size} |`);
  const caseCounts = statuses.map(status => `${status} ${calls.filter(call => call.conclusion === status).length}`).join('，');
  const linked = calls.filter(call => call.serverAuditIds.length);
  section.push(`### ${runtime}`, '',
    `- 写授权 \`tools/list\` 返回 ${inventory.length} 项、${discovery.pages.length} 页。只读授权返回 ${discovery.readOnlyPages.reduce((sum, page) => sum + page.received, 0)} 项、${discovery.readOnlyPages.length} 页。末页均无下一页游标。逻辑列表另外用两条品牌和 \`limit: 1\` 实际翻页。 [发现回执](${dir}/${runtime}-discovery.json)`,
    `- ${calls.length} 条 SDK 用例，${caseCounts}。${linked.length} 条用例关联了 ${new Set(linked.flatMap(call => call.serverAuditIds)).size} 条唯一服务端审计。 [调用回执](${dir}/${runtime}-calls.jsonl) [服务端审计](${dir}/${runtime}-audit.jsonl)`,
    `- ${natives.size} 项原生 Claude Code 工具有回执。${data.native.observed.filter(call => call.conclusion === '收到成功回执').length} 项成功返回，${data.native.observed.filter(call => call.conclusion === '预期拒绝').length} 项按预期拒绝。 [原生会话](${dir}/${runtime}-native.jsonl) [逐工具矩阵](${dir}/${runtime}-matrix.json)`,
    `- 写、只读凭据撤销后分别经 \`tools/list\` 验证均返回 HTTP 401。 [撤销回执](${dir}/${runtime}-revocation.json)`, '');
  const outputChecks = calls.filter(call => call.sdkOutput);
  sdkOutputChecks += outputChecks.length;
  if (outputChecks.length) {
    const passed = outputChecks.filter(call => call.conclusion === '成功' && call.sdkOutput.declaredSchema).length;
    section.push(`- ${passed}/${outputChecks.length} 条补测经标准 \`callTool\` 通过声明输出 schema 与业务断言。补测工具为 ${outputChecks.map(call => `\`${call.name}\``).join('、')}。 [声明 schema 和实际回执](${dir}/${runtime}-calls.jsonl)`, '');
    for (const call of outputChecks.filter(call => call.sdkOutput.sdkError)) {
      section.push(`- \`${call.name}\` 的 SDK 错误为 ${call.sdkOutput.sdkError.message}。调用记录的 \`sdkOutput\` 保留声明 schema 与实际 JSON-RPC 回执。`, '');
    }
  }
  if (operations.enumerated.length) {
    const tested = operations.called;
    section.push(`- \`smartsell_operation_call\` 通过描述工具按模块发现 ${new Set(operations.enumerated.map(op => op.name)).size} 项授权操作，实际调用 ${new Set(tested.map(op => op.operation)).size} 项。${tested.filter(op => op.conclusion === '成功').length} 条通过业务断言，${tested.filter(op => op.conclusion === '预期拒绝').length} 条触发人工审批边界。 [可访问操作和实调明细](${dir}/${runtime}-operation-call.json)`, '');
  } else section.push('- 此入口的工具目录没有 `smartsell_operation_call`。', '');
  if (legacy.length) {
    assert(legacy.every(tool => tool.cases.some(test => test.conclusion === '成功') && tool.nativeCalls.some(call => !call.isError)));
    section.push(`- Commands 的旧式只读 PAT 额外发现并实调了 ${legacy.map(tool => tool.name).join('、')}。该入口单列，未计入上表的 Commands 主连接列。 [旧式只读用例](${dir}/${runtime}-legacy-only.json) [原生会话](${dir}/${runtime}-${strictRun ? 'readonly' : 'legacy-only'}-native.jsonl)`, '');
    native.push(...await jsonl(`${runtime}-${strictRun ? 'readonly' : 'legacy-only'}-native.jsonl`));
  }
  if (strictRun) {
    const { sdk, native } = data.strict;
    section.push(`- Web 严格关联原生回执 ${native.matched}/${native.receipts}，按请求 ID 各有唯一行 ${native.uniqueRequestRows}/${native.receipts}。SDK 严格关联 ${sdk.matched}/${sdk.receipts}，各有唯一行 ${sdk.uniqueRequestRows}/${sdk.receipts}。 [原生逐请求审计](${dir}/${runtime}-native-audit.jsonl) [未知请求 ID 查询](${dir}/${runtime}-web-filter-verification.json)`, '');
    for (const row of audits.filter(audit => audit.status === 'web_row_mismatch')) {
      section.push(`- \`${row.expected.name}\` 的 MCP 回执拒绝码为 \`${row.expected.code}\`，Web 审计为 \`${row.cohort[0].error_code}\`。 [SDK 审计](${dir}/${runtime}-audit.jsonl) [原生审计](${dir}/${runtime}-native-audit.jsonl)`);
    }
    for (const entry of data.strict.nativeUnavailable) {
      section.push(`- 只读目录没有 \`${entry.name}\`。SDK 直接实调并确认 \`${entry.code}\`，原生 Claude Code 只执行目录提供的工具。`);
    }
    section.push('');
  }
  const failures = matrix.filter(tool => tool.conclusion === '具体失败' || tool.conclusion === '未实调');
  if (failures.length) for (const tool of failures) section.push(`- \`${tool.name}\`：${tool.conclusion}。${tool.detail ?? ''}`);
  timeline.push('', `## ${runtime} 原生 Claude Code`, '',
    `连接目标 ${discovery.origin}/mcp，工作区 \`${discovery.workspace}\`。按同一次测试运行实际记录的时间排列。`, '');
  for (const event of native) {
    const type = event.role;
    const stamp = `- ${event.at}`;
    if (type === 'user' || type === 'assistant') timeline.push(`${stamp} **${type === 'user' ? '用户请求' : 'Agent 答复'}** ${event.text}`);
    if (type === 'init') timeline.push(`${stamp} **原生 CC 初始化** \`${event.sessionId}\` ${event.mcp.map(server => `${server.name} ${server.status}`).join('，')}`);
    if (type === 'tool_use') timeline.push(`${stamp} **工具调用** \`${event.name}\` ${compact(event.arguments)}。调用 \`${event.id}\``);
    if (type === 'tool_result') timeline.push(`${stamp} **实际回执** \`${event.name}\` ${event.conclusion}。${compact(event.content, 350)} 调用 \`${event.id}\``);
    if (type === 'audit' && strictRun) timeline.push(`${stamp} **Web 审计** \`${event.name}\` · Claude 工具调用 \`${event.id}\` · JSON-RPC \`${event.wire?.rpcId ?? '无'}\` · HTTP 请求 \`${event.requestId ?? '无'}\` · 审计行 \`${event.serverAuditIds.join(', ') || '无'}\` · ${event.webAudit.status}`);
    if (type === 'audit' && !strictRun) timeline.push(`${stamp} **审计关联** \`${event.name}\` · 本次 \`${event.serverAuditIds.join(', ') || '未生成独立行'}\` · 对应 SDK 审计 \`${event.priorSdkAuditIds.join(', ') || '无行'}\``);
    if (type === 'exit') timeline.push(`${stamp} **Claude Code 退出码** \`${event.code}\``);
  }
  timeline.push('', `## ${runtime} MCP SDK`, '', `完整工具参数和 JSON 回执见 [${runtime}-calls.jsonl](${dir}/${runtime}-calls.jsonl)。`, '');
  for (const entry of calls) {
    timeline.push(`### ${entry.operation ?? entry.name} · ${entry.conclusion}`, '',
      `- ${entry.started} → ${entry.finished} · ${entry.driver} · 用例 \`${entry.id}\``,
      `- 用户请求 ${entry.user}`, `- 调用 \`${entry.name}\` ${compact(entry.arguments)}`,
      `- 回执 ${compact(entry.result?.structuredContent ?? entry.result?.content ?? entry.detail ?? entry.code, 500)}`,
      `- Agent 答复（夹具） ${entry.agentReply}`,
      `- HTTP 请求 ID \`${entry.requestId ?? '服务端未返回'}\` · 审计 ID \`${entry.serverAuditIds.join(', ') || '无独立审计行'}\``, '');
  }
}
report.push(`| 合计 | ${total} | ${statuses.map(status => counts[status]).join(' | ')} | ${nativeCoverage} |`, '',
  `同名工具在不同 runtime 各计一次。按工具名去重为 **${unique.size}** 项。目录验证只用于描述工具。预期拒绝单列，空结果和 schema 异常不计入业务通过。`, '',
  ...(strictRun ? [
    `原生 Claude Code 共收到 **${sumAudit('native', 'receipts')}** 条回执，均按平台请求 ID 查到唯一 Web 行，其中 **${sumAudit('native', 'matched')}** 条的审计字段完全一致。SDK 的 ${sumAudit('sdk', 'receipts')} 条回执均有唯一行，其中 ${sumAudit('sdk', 'matched')} 条字段完全一致。`, '',
    `根目录与桌面的 MCP 配置在实际批量运行前后保持字节一致。 [配置验证](${dir}/ordinary-config-verification.json)`, '',
  ] : []),
  ...section, '## 权限、重放与审计', '',
  '- Commands 验证了只读凭据执行写工具被拒绝、重复键同参数返回原品牌且没有新增写审计、重复键不同参数被拒绝、人工发布审批与广告决策被拒绝、陈旧租约被拒绝。',
  '- Operations 验证了工作区外 ID 隐藏、陈旧租约被拒绝、缺少回复租约以及持有效租约但未经审批时均不能发送。',
  sdkOutputChecks ? '- 正向用例使用标准 `callTool`。Operations 的跨工作区 `NOT_FOUND` 拒绝用例继续通过 SDK 协议请求验证。' : '- 两套 SDK 路径区分了高层 `callTool` 与协议请求。协议请求仍实调 MCP，只校验通用回执结构，用于独立判定服务端返回的跨工作区拒绝，及测试产品的旧式或特殊回执。早期回合保留了声明输出 schema 校验错误明细。',
  strictRun ? '- 原生回执以用例、工具名和完整参数定位实际 JSON-RPC 调用，读取平台 HTTP 响应的 `x-request-id`，再用 Web 管理会话查询 `/mcp-tool-calls?request_id=...`。严格匹配要求唯一行以及工具名、授权凭据、执行结果和拒绝码一致。' : '- 本次直查 Commands SQLite 的审计实体与 Operations 持久化记录。SDK 用例串行执行，按请求 ID 或凭据和该次调用前后的审计差值关联。原生会话按批次差值、凭据和工具名关联新审计。只读、预期拒绝和幂等重放可能没有新审计行，记录注明是否存在原始 SDK 审计。',
  '- 独立本地资产上传和图片注册完成。广告只提交到本地审查。知乎查登录只创建并读取了本地排队单。桌面商品上架只验证了产品明确返回的 `unsupported` 回执。真实站点登录、对外发布、对外回复、实际投放与商品上架交付均未执行。', '',
  '## 复跑', '',
  '在指定的 `agent-ops-lab` 目录运行，使用 Node 24、所选源码树的依赖和本机 Claude Code。省略 `MATRIX_SMARTSELL_SOURCE` 时使用隔离副本。', '',
  '```sh',
  'cd ./agent-ops-lab',
  ...(source.kind === 'main' ? ['MATRIX_SMARTSELL_SOURCE=.. node --import tsx coverage/run.mjs'] : []),
  'node --import ../.local/mcp-lab-Lh53qf/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs coverage/run.mjs',
  `node coverage/report.mjs coverage/${dir}`,
  '```', '',
  '- 入口与产品 `pnpm --filter @smartsell/server start` 和 `pnpm --filter @smartsell/server start:kernel` 使用同一启动函数。运行器调用这两套入口的服务启动函数以指定随机端口，先经 `/readyz` 和 `/api/v1/setup` 创建独立工作区，再通过 `/mcp` 实调。产品 Web 正常入口是副本 README 中的 `pnpm dev`，默认回环监听，`/mcp` 与 `/api` 同源代理。',
  '- 矩阵的 `coverage/.mcp.json` 由原生会话显式加载，其变量只在运行器的 Claude Code 子进程中注入。原生 Claude Code 2.1.311 使用回环 Messages 夹具，工具调用到独立的实际 SmartSell 监听器。会话由脚本编排，未使用在线模型。所有用例的输入、断言和地区或日期夹具均在 `coverage/cases.mjs`。',
  '- 可使用较短的 [脱敏会话索引](TERMINAL.md) 检索每条请求、工具参数、回执、答复和审计 ID。', '');
const reportDir = strictRun ? evidence : coverage;
const withLocalLinks = markdown => strictRun ? markdown.replaceAll(`](${dir}/`, '](') : markdown;
await writeFile(resolve(reportDir, 'REPORT.md'), withLocalLinks(report.join('\n')));
await writeFile(resolve(reportDir, 'TERMINAL.md'), withLocalLinks(timeline.join('\n')) + '\n');
console.log(`${total} runtime-tool pairs verified across ${unique.size} unique tool names`);

function compact(value, max = 300) {
  const text = JSON.stringify(value ?? null).replaceAll('`', '\\u0060');
  return '`' + (text.length <= max ? text : `${text.slice(0, max)}…`) + '`';
}
