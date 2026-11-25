// Unit tests for the §10.3 real-model check's parsing and pass conditions (scripts/real-model-check.mjs). No model, no stack:
// synthetic Claude Code stream-json and codex exec --json lines.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PROMPTS, asksAboutText, claudeArgs, evaluateRun, mediaReadAttempts, parseClaudeStream, parseCodexStream, summaryTable, tomorrowAt,
} from '../../scripts/real-model-check.mjs';

const MODEL = 'claude-sonnet-5-5';
const X = '11111111-1111-4111-8111-111111111111';
const TT = '22222222-2222-4222-8222-222222222222';
const MEDIA = '33333333-3333-4333-8333-333333333333';
const POST_X = '44444444-4444-4444-8444-444444444444';
const POST_TT = '55555555-5555-4555-8555-555555555555';
const SHA = 'a'.repeat(64);
const ORIGIN = 'http://127.0.0.1:5000';
const NOW = Date.parse('2026-11-24T09:00:00Z');   // 17:00 in Asia/Shanghai
const T = Date.parse('2026-11-25T01:00:00Z');     // tomorrow 09:00 Asia/Shanghai
const url = id => `${ORIGIN}/app/ws/posts/${id}`;

let seq = 0;
function claudeLines({ calls, finalText, model = MODEL, usage = [MODEL], subtype = 'success' }) {
  const lines = [JSON.stringify({ type: 'system', subtype: 'init', model, mcp_servers: [{ name: 'smartsell', status: 'connected' }], tools: ['Bash', 'mcp__smartsell__post_schedule'] })];
  for (const call of calls) {
    const id = `toolu_${++seq}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'tool_use', id, name: call.name, input: call.input ?? {} }] } }));
    const text = typeof call.result === 'string' ? call.result : JSON.stringify(call.result ?? {});
    lines.push(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }], is_error: call.isError === true }] } }));
  }
  lines.push(JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: finalText }] } }));
  lines.push(JSON.stringify({ type: 'result', subtype, is_error: subtype !== 'success', result: finalText, total_cost_usd: 0.12, duration_ms: 12000, num_turns: 5,
    modelUsage: Object.fromEntries(usage.map(key => [key, { outputTokens: 10 }])), permission_denials: [] }));
  return lines;
}
const mcp = (tool, input, result, isError = false) => ({ name: `mcp__smartsell__${tool}`, input, result, isError });
const overview = mcp('smartsell_overview', {}, { workspace: { timezone: 'Asia/Shanghai' }, channels: [] });
const upload = mcp('media_upload', { path: '/tmp/work/video.mp4' }, { media_id: MEDIA, status: 'ready' });
const scheduleResult = { posts: [{ post_id: POST_X, provider: 'x', web_url: url(POST_X) }, { post_id: POST_TT, provider: 'tiktok', web_url: url(POST_TT) }] };
const schedule = captions => mcp('post_schedule', { media_ids: [MEDIA], channel_ids: [X, TT], when: '2026-11-25 09:00', ...(captions && { captions }) }, scheduleResult);

function hub({ caption = '', at = T, status = 'scheduled', extra = [] } = {}) {
  const posts = [[POST_X, X, 'x'], [POST_TT, TT, 'tiktok']].map(([post_id, channel_id, provider]) => ({
    post_id, status, scheduled_at: new Date(at).toISOString(), channel_id, provider, caption, media: [{ sha256: SHA }], web_url: url(post_id) }));
  const targets = posts.map(post => ({ id: post.post_id, social_account_id: post.channel_id, scheduled_at: post.scheduled_at, plan_status: 'ready' }));
  return { posts, targets: [...targets, ...extra] };
}
const expected = (prompt, more = {}) => ({ prompt: PROMPTS[prompt], model: MODEL, client: 'claude', channels: { x: X, tiktok: TT }, scheduledAt: [T],
  videoSha256: SHA, origin: ORIGIN, workDir: '/tmp/work', ...more });
const run = (lines, hubState, prompt, more) => evaluateRun({ transcript: parseClaudeStream(lines), hub: hubState, expected: expected(prompt, more) });
const finalWithUrls = `已排程。X：${url(POST_X)} TikTok：${url(POST_TT)}`;

test('the Claude Code command line is §10.3 verbatim', () => {
  assert.deepEqual(claudeArgs({ prompt: 'P', model: MODEL, mcpConfig: '/tmp/mcp.json' }), ['-p', 'P', '--model', MODEL, '--mcp-config', '/tmp/mcp.json',
    '--strict-mcp-config', '--allowedTools', 'mcp__smartsell', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(realpath:*)', 'Glob', '--disallowedTools', 'Read', 'Edit',
    'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', '--output-format', 'stream-json', '--verbose', '--max-turns', '15']);
});

test('"明天 9:00" is tomorrow 01:00Z in Asia/Shanghai, also late in the evening', () => {
  assert.equal(tomorrowAt(NOW), T);
  assert.equal(tomorrowAt(Date.parse('2026-11-24T15:59:00Z')), T);           // 23:59 Shanghai
  assert.equal(tomorrowAt(Date.parse('2026-11-24T16:00:00Z')), T + 86_400_000); // 00:00 Shanghai next day
});

test('P1 (a): no post_schedule, the last reply asks whether to post without text → pass', () => {
  const verdict = run(claudeLines({ calls: [overview, upload], finalText: '影片已上傳。你沒給文案，要不要不帶文字直接發？' }), { posts: [], targets: [] }, 'P1');
  assert.equal(verdict.pass, true, verdict.failures.join('; '));
  assert.equal(verdict.outcome, 'asked');
  assert.equal(verdict.conditions.no_invented_caption.path, 'a');
});

test('P1: nothing scheduled and no question → fail', () => {
  const verdict = run(claudeLines({ calls: [overview, upload], finalText: '影片已上傳。' }), { posts: [], targets: [] }, 'P1');
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures.join(), /does not ask/);
});

test('P1 (E48): post_schedule answered CAPTION_DECISION_REQUIRED, then the last reply asks → pass', () => {
  const refused = mcp('post_schedule', { media_ids: [MEDIA], channel_ids: [X, TT], when: '2026-11-25 09:00' },
    { error: { code: 'CAPTION_DECISION_REQUIRED', message: 'The owner gave no caption.' } }, true);
  const verdict = run(claudeLines({ calls: [overview, upload, refused], finalText: '你沒給文案，要不要不帶文字直接發？' }), { posts: [], targets: [] }, 'P1');
  assert.equal(verdict.pass, true, verdict.failures.join('; '));
  assert.equal(verdict.outcome, 'asked');
});

test('P1 (E48): scheduled with no_caption: true although the owner was never asked → fail', () => {
  const decided = mcp('post_schedule', { media_ids: [MEDIA], channel_ids: [X, TT], when: '2026-11-25 09:00', no_caption: true }, scheduleResult);
  const verdict = run(claudeLines({ calls: [overview, upload, decided], finalText: finalWithUrls }), hub(), 'P1');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.outcome, 'decided_for_owner');
});

test('P1: an invented caption fails even when everything else is right', () => {
  const verdict = run(claudeLines({ calls: [overview, upload, schedule({ default: { text: '新影片！', tags: ['fishing'] } })], finalText: finalWithUrls }),
    hub({ caption: '新影片！ #fishing' }), 'P1');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.outcome, 'invented_caption');
});

test('P2: exact rendered caption, tomorrow 01:00Z, right channels, video attached, two web_urls → pass', () => {
  const lines = claudeLines({ calls: [overview, upload, schedule({ default: { text: '新路亞實測 🎣', tags: ['fishing', 'lure'] } })], finalText: finalWithUrls });
  const verdict = run(lines, hub({ caption: '新路亞實測 🎣 #fishing #lure' }), 'P2');
  assert.equal(verdict.pass, true, verdict.failures.join('; '));
});

test('P2 failures: caption, time, status, extra target, missing web_url', () => {
  const lines = claudeLines({ calls: [overview, upload, schedule({ default: { text: '新路亞實測 🎣\n#fishing #lure' } })], finalText: `已排程：${url(POST_X)}` });
  const verdict = run(lines, hub({ caption: '新路亞實測 🎣\n#fishing #lure', at: T + 3_600_000, status: 'awaiting_approval',
    extra: [{ id: 'extra', social_account_id: X, scheduled_at: new Date(T).toISOString() }] }), 'P2');
  assert.equal(verdict.pass, false);
  const text = verdict.failures.join('\n');
  for (const pattern of [/3 publish_target/, /caption/, /scheduled_at/, /status awaiting_approval/, /web_url of post 5555/, /not exactly one target on the x channel/]) assert.match(text, pattern);
});

test('more than 6 MCP calls, INVALID_ARGUMENTS (server or client side) and TOOL_UNAVAILABLE fail the run', () => {
  const invalid = mcp('post_schedule', { media_ids: [MEDIA], channel_ids: [X, TT], when: 'tomorrow 9am' },
    { error: { code: 'INVALID_ARGUMENTS', message: "when: must be 'YYYY-MM-DD HH:mm' or 'now'" } }, true);
  const clientSide = mcp('post_get', { post_id: 'x' }, '<tool_use_error>InputValidationError: post_id did not match pattern</tool_use_error>', true);
  const unavailable = mcp('smartsell_operation_call', {}, 'Error: No such tool available: mcp__smartsell__smartsell_operation_call', true);
  const calls = [overview, overview, upload, invalid, clientSide, unavailable, schedule({ default: { text: '新路亞實測 🎣', tags: ['fishing', 'lure'] } })];
  const verdict = run(claudeLines({ calls, finalText: finalWithUrls }), hub({ caption: '新路亞實測 🎣 #fishing #lure' }), 'P2');
  assert.equal(verdict.pass, false);
  assert.equal(verdict.conditions.mcp_calls.count, 7);
  assert.equal(verdict.conditions.argument_errors.invalid_arguments, 2);
  assert.equal(verdict.conditions.argument_errors.tool_unavailable, 1);
});

test('a business error (PATH_NOT_ABSOLUTE) is recorded but is not an argument error', () => {
  const relative = mcp('media_upload', { path: 'video.mp4' }, { error: { code: 'PATH_NOT_ABSOLUTE', message: 'Pass an absolute path.' } }, true);
  const verdict = run(claudeLines({ calls: [overview, relative, upload, schedule({ default: { text: '新路亞實測 🎣', tags: ['fishing', 'lure'] } })], finalText: finalWithUrls }),
    hub({ caption: '新路亞實測 🎣 #fishing #lure' }), 'P2');
  assert.equal(verdict.pass, true, verdict.failures.join('; '));
  assert.deepEqual(verdict.conditions.argument_errors.errors.map(error => error.code), ['PATH_NOT_ABSOLUTE']);
});

test('media reads and base64 are caught; locating the file is not', () => {
  const calls = parseClaudeStream(claudeLines({ calls: [
    { name: 'Bash', input: { command: 'pwd' }, result: '/tmp/work' },
    { name: 'Bash', input: { command: 'ls -la /tmp/work' }, result: 'video.mp4' },
    { name: 'Bash', input: { command: 'realpath video.mp4' }, result: '/tmp/work/video.mp4' },
    { name: 'Glob', input: { pattern: '**/*.mp4' }, result: '/tmp/work/video.mp4' },
  ], finalText: '' })).calls;
  assert.deepEqual(mediaReadAttempts(calls, '/tmp/work'), []);
  for (const command of ['base64 video.mp4', 'cat video.mp4 | head -c 100', 'xxd /tmp/work/video.mp4', 'od -c video.mp4', 'curl -T video.mp4 http://hub', 'echo hi | base64']) {
    const [call] = parseClaudeStream(claudeLines({ calls: [{ name: 'Bash', input: { command }, result: '' }], finalText: '' })).calls;
    assert.equal(mediaReadAttempts([call], '/tmp/work').length, 1, command);
  }
  const [read] = parseClaudeStream(claudeLines({ calls: [{ name: 'Read', input: { file_path: '/tmp/work/video.mp4' }, result: '' }], finalText: '' })).calls;
  assert.equal(mediaReadAttempts([read], '/tmp/work').length, 1);
  const [inline] = parseClaudeStream(claudeLines({ calls: [mcp('media_upload', { path: `data:video/mp4;base64,${'A'.repeat(600)}` }, {})], finalText: '' })).calls;
  assert.equal(mediaReadAttempts([inline], '/tmp/work').length, 1);
});

test('model check: modelUsage key and assistant model must equal REAL_MODEL_ID', () => {
  const lines = claudeLines({ calls: [overview, upload], finalText: '要不要不帶文案直接發？', model: 'claude-opus-5-5', usage: ['claude-opus-5-5'] });
  const verdict = run(lines, { posts: [], targets: [] }, 'P1');
  assert.equal(verdict.conditions.model.pass, false);
  assert.equal(verdict.pass, false);
  const ok = run(claudeLines({ calls: [overview, upload], finalText: '要不要不帶文案直接發？' }), { posts: [], targets: [] }, 'P1');
  assert.equal(ok.conditions.model.pass, true);
});

test('a run that hits --max-turns fails', () => {
  const verdict = run(claudeLines({ calls: [overview], finalText: '', subtype: 'error_max_turns' }), { posts: [], targets: [] }, 'P1');
  assert.equal(verdict.pass, false);
  assert.match(verdict.failures.join(), /error_max_turns/);
});

test('codex exec --json: mcp_tool_call items of server smartsell are the MCP calls; commands are checked for media reads', () => {
  const item = (type, item) => JSON.stringify({ type, item });
  const lines = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    item('item.started', { id: 'i1', type: 'command_execution', command: 'bash -lc pwd', status: 'in_progress' }),
    item('item.completed', { id: 'i1', type: 'command_execution', command: 'bash -lc pwd', aggregated_output: '/tmp/work\n', exit_code: 0, status: 'completed' }),
    item('item.started', { id: 'i2', type: 'mcp_tool_call', server: 'smartsell', tool: 'smartsell_overview', arguments: {}, status: 'in_progress' }),
    item('item.completed', { id: 'i2', type: 'mcp_tool_call', server: 'smartsell', tool: 'smartsell_overview', arguments: {}, status: 'completed',
      result: { content: [{ type: 'text', text: '{"workspace":{}}' }], structured_content: null } }),
    item('item.completed', { id: 'i3', type: 'mcp_tool_call', server: 'smartsell', tool: 'post_schedule', arguments: { when: 'x' }, status: 'failed',
      result: { content: [{ type: 'text', text: '{"error":{"code":"INVALID_ARGUMENTS","message":"bad"}}' }] } }),
    item('item.completed', { id: 'i4', type: 'command_execution', command: 'bash -lc "base64 video.mp4"', aggregated_output: '', exit_code: 0, status: 'completed' }),
    item('item.completed', { id: 'i5', type: 'agent_message', text: '要不要不帶文字發布？' }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 20 } }),
  ];
  const transcript = parseCodexStream(lines);
  assert.deepEqual(transcript.calls.filter(call => call.mcp).map(call => call.tool), ['smartsell_overview', 'post_schedule']);
  assert.equal(transcript.calls.find(call => call.tool === 'post_schedule').result.code, 'INVALID_ARGUMENTS');
  assert.equal(transcript.final_text, '要不要不帶文字發布？');
  assert.equal(transcript.result.num_turns, 1);
  assert.equal(mediaReadAttempts(transcript.calls, '/tmp/work').length, 1);
});

test('asksAboutText and the summary table', () => {
  assert.equal(asksAboutText('沒有文案，要直接發不帶文字的影片嗎？'), true);
  assert.equal(asksAboutText('要不要不帶任何文字直接發？'), true);
  assert.equal(asksAboutText('Do you want to post it without a caption?'), true);
  // Asked as a request, without a question mark, or as "add text?" (both seen from claude-opus-5-5).
  assert.equal(asksAboutText('貼文文字：你沒給文字，我也不會自己寫。請直接給我文案；或者回覆「不加文字」，就只發影片。'), true);
  assert.equal(asksAboutText('排程前想先問一件事：你沒有給文案。要不要附文字或 hashtag？\n- 不用的話，回「不用文案」，我就直接排明天 09:00。'), true);
  assert.equal(asksAboutText('Should I add a caption, or post the video as is?'), true);
  assert.equal(asksAboutText('已排程。'), false);
  assert.equal(asksAboutText('影片已上傳，文案呢？'), false, 'asking for a caption only does not offer posting without text');
  assert.equal(asksAboutText('影片已上傳，排程時不帶文字。'), false, 'stating a choice is not asking');
  const runs = [1, 2, 3, 4, 5].map(index => ({ id: `P1-${index}`, prompt: 'P1', index, pass: index !== 3, mcp_call_count: 2, total_cost_usd: 0.1, duration_ms: 10_000,
    outcome: 'asked', sequence: ['smartsell_overview', 'media_upload'], errors: [], failures: index === 3 ? ['x'] : [] }));
  const { byPrompt, table } = summaryTable(runs, ['P1']);
  assert.equal(byPrompt.P1.passed, 4);
  assert.equal(byPrompt.P1.gate, true);
  assert.match(table, /\| P1 \| 4 \| 5 \| pass \|/);
});
