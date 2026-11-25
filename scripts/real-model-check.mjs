#!/usr/bin/env node
// Real-model check (phase1-design §10.3): a real Claude Code (or Codex) session, given the owner's own sentence, drives the
// SmartSell MCP surface through the local relay against a fresh test stack (§10.2: hub, two headless Workers "Mac-B" with
// X fixture_x and "Win-C" with TikTok fixture_tt, fixture platforms, 30 MB ffmpeg clip). Each run gets a fresh hubDir.
//
//   pnpm real-model-check                         # Claude Code, P1 ×5 and P2 ×5, model = tests/real-model/config.json REAL_MODEL_ID
//   pnpm real-model-check -- --model claude-opus-5-5 --label confirmation
//   pnpm real-model-check -- --client codex       # codex exec --json with a temporary CODEX_HOME (owner's laptop, M5)
//
// Options: --client claude|codex, --model <full id>, --prompts P1,P2, --runs <n>, --parallel <n>, --label <text>,
//          --claude-bin <path>, --codex-bin <path>, --timeout-sec <n>, --keep (keep temp dirs), --no-write (no results file).
// Writes tests/real-model/results/<ISO>-<client>.json (call sequences, errors, cost, turns, model, client version, summary
// table). Raw transcripts stay under $TMPDIR/smartsell-real-model/. Exit code: 0 gate passed, 1 gate failed, 2 not run / void.
//
// Safety: every origin is loopback; the model only sees the fixture stack. The client runs with a cleared environment
// (HOME, PATH, USER, LOGNAME, SHELL, TMPDIR, LANG, TERM and the two no-update/no-telemetry switches); Claude Code keeps the
// owner's HOME only because its login lives there. Codex gets a temporary CODEX_HOME whose config.toml names only the
// smartsell server; the owner's Codex login file is linked in (never read) when it exists.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** A path for the results file without the owner's home directory (results are committed). */
const displayPath = path => (path && path.startsWith(homedir() + '/') ? `~/${path.slice(homedir().length + 1)}` : path);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(repoRoot, 'tests/real-model/config.json');
const resultsDir = join(repoRoot, 'tests/real-model/results');
const relayBundle = join(repoRoot, 'packages/agent-relay/dist/smartsell-relay.mjs');

export const WORKSPACE_TZ = 'Asia/Shanghai';
export const MCP_SERVER = 'smartsell';
export const MCP_PREFIX = `mcp__${MCP_SERVER}__`;
export const MCP_CALL_LIMIT = 6;
export const GATE = { runs: 5, pass: 4 };
/** §10.3 the two fixed prompts (zh-Hant). P2's caption is what the hub must render, exactly. */
export const PROMPTS = {
  P1: { id: 'P1', text: '把 video.mp4 明天 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok', caption: null },
  P2: { id: 'P2', text: '把 video.mp4 明天早上 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok，文案：「新路亞實測 🎣」，加上 #fishing #lure。',
    caption: '新路亞實測 🎣 #fishing #lure' },
};
/** The Claude Code command line of §10.3, verbatim. */
export function claudeArgs({ prompt, model, mcpConfig }) {
  return ['-p', prompt, '--model', model, '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--allowedTools', 'mcp__smartsell', 'Bash(pwd)', 'Bash(ls:*)', 'Bash(realpath:*)', 'Glob',
    '--disallowedTools', 'Read', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch',
    '--output-format', 'stream-json', '--verbose', '--max-turns', '15'];
}
export function codexArgs({ prompt, model, cwd }) {
  return ['exec', '--json', '--skip-git-repo-check', '-C', cwd, ...(model ? ['-m', model] : []), prompt];
}

// ---------- time ----------
function zoneParts(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour, min: +parts.minute, s: +parts.second };
}
/** UTC ms of the wall-clock time y-m-d hh:mm in `zone`. */
export function zonedTime(y, m, d, hh, mm, zone) {
  let guess = Date.UTC(y, m - 1, d, hh, mm);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(guess, zone);
    const offset = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s) - guess;
    guess = Date.UTC(y, m - 1, d, hh, mm) - offset;
  }
  return guess;
}
/** "明天 9:00" in the workspace zone, as seen at `ms`. */
export function tomorrowAt(ms, zone = WORKSPACE_TZ, hh = 9, mm = 0) {
  const today = zoneParts(ms, zone);
  const next = new Date(Date.UTC(today.y, today.m - 1, today.d + 1));
  return zonedTime(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), hh, mm, zone);
}

// ---------- transcripts ----------
function toolResult(text, isError) {
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  let code = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? json.error.code ?? null : null;
  if (!code && isError) {
    // Client-side refusals: Claude Code validates MCP input against the tool schema before sending it.
    if (/InputValidationError|INVALID_ARGUMENTS|Invalid params/i.test(text)) code = 'INVALID_ARGUMENTS';
    else if (/No such tool available|TOOL_UNAVAILABLE/i.test(text)) code = 'TOOL_UNAVAILABLE';
    else if (/permission|haven't granted|denied/i.test(text)) code = 'CLIENT_PERMISSION_DENIED';
    else code = 'CLIENT_ERROR';
  }
  const failed = isError || !!code;
  return { is_error: failed, code, message: failed ? String(json?.error?.message ?? text).slice(0, 600) : null, json: failed ? null : json,
    details: failed && json?.error?.details ? json.error.details : null, bytes: Buffer.byteLength(text) };
}

function newTranscript() {
  return { init: null, calls: [], texts: [], assistant_models: [], usage: null, result: null, final_text: '', events: 0, stream_errors: [] };
}

/** Claude Code `--output-format stream-json --verbose` lines → calls, texts, result. */
export function parseClaudeStream(lines) {
  const t = newTranscript();
  const byId = new Map();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    t.events++;
    if (event.type === 'system' && event.subtype === 'init') {
      t.init = { model: event.model ?? null, cwd: event.cwd ?? null, claude_code_version: event.claude_code_version ?? null, permission_mode: event.permissionMode ?? null,
        mcp_servers: (event.mcp_servers ?? []).map(server => ({ name: server.name, status: server.status })), mcp_tools: (event.tools ?? []).filter(name => name.startsWith('mcp__')) };
    } else if (event.type === 'assistant' && event.message) {
      const model = event.message.model;
      if (model && model !== '<synthetic>') t.assistant_models.push(model);
      if (event.error) t.stream_errors.push(String(event.error));
      for (const block of event.message.content ?? []) {
        if (block.type === 'text' && block.text) t.texts.push(block.text);
        if (block.type === 'tool_use') {
          const mcp = typeof block.name === 'string' && block.name.startsWith(MCP_PREFIX);
          const call = { id: block.id, name: block.name, mcp, tool: mcp ? block.name.slice(MCP_PREFIX.length) : block.name, input: block.input ?? {},
            subagent: !!event.parent_tool_use_id, result: null };
          t.calls.push(call);
          byId.set(block.id, call);
        }
      }
    } else if (event.type === 'user' && event.message && Array.isArray(event.message.content)) {
      for (const block of event.message.content) {
        if (block.type !== 'tool_result') continue;
        const call = byId.get(block.tool_use_id);
        if (!call) continue;
        const text = typeof block.content === 'string' ? block.content
          : (block.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
        call.result = toolResult(text, block.is_error === true);
      }
    } else if (event.type === 'result') {
      t.result = { subtype: event.subtype ?? null, is_error: event.is_error === true, terminal_reason: event.terminal_reason ?? null,
        total_cost_usd: event.total_cost_usd ?? null, duration_ms: event.duration_ms ?? null, duration_api_ms: event.duration_api_ms ?? null,
        num_turns: event.num_turns ?? null, model_usage: event.modelUsage ?? {}, permission_denials: event.permission_denials ?? [], text: event.result ?? '' };
    }
  }
  t.final_text = t.result?.text || t.texts.at(-1) || '';
  return t;
}

/** `codex exec --json` JSONL lines → the same shape (MCP calls are `mcp_tool_call` items of server smartsell). */
export function parseCodexStream(lines) {
  const t = newTranscript();
  const items = new Map();
  let turns = 0;
  const usage = { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0 };
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    t.events++;
    if (event.type === 'thread.started') t.init = { thread_id: event.thread_id ?? null, mcp_servers: [], mcp_tools: [] };
    else if (event.type === 'turn.completed') { turns++; for (const key of Object.keys(usage)) usage[key] += Number(event.usage?.[key] ?? 0); }
    else if (event.type === 'turn.failed') t.stream_errors.push(String(event.error?.message ?? 'turn failed'));
    else if (event.type === 'error') { if (!/^Reconnecting/i.test(String(event.message))) t.stream_errors.push(String(event.message)); }
    else if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
      const item = event.item ?? {};
      const kind = item.type ?? item.item_type;
      if (kind === 'agent_message' || kind === 'assistant_message') { if (event.type === 'item.completed' && item.text) t.texts.push(item.text); continue; }
      if (!['mcp_tool_call', 'command_execution', 'file_change', 'web_search'].includes(kind)) continue;
      let call = items.get(item.id);
      if (!call) {
        const mcp = kind === 'mcp_tool_call' && item.server === MCP_SERVER;
        const name = kind === 'mcp_tool_call' ? `mcp__${item.server}__${item.tool}` : kind;
        const input = kind === 'mcp_tool_call' ? (item.arguments ?? {}) : kind === 'command_execution' ? { command: item.command }
          : kind === 'web_search' ? { query: item.query } : { changes: item.changes };
        call = { id: item.id, name, mcp, tool: kind === 'mcp_tool_call' ? item.tool : kind, input, subagent: false, result: null };
        items.set(item.id, call);
        t.calls.push(call);
      }
      if (event.type === 'item.completed') {
        if (kind === 'mcp_tool_call') {
          const text = (item.result?.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n');
          const isError = item.status === 'failed' || item.result?.is_error === true || item.result?.isError === true || !!item.error;
          call.result = toolResult(text || String(item.error?.message ?? ''), isError);
          if (!call.result.json && !isError && item.result?.structured_content) call.result.json = item.result.structured_content;
        } else if (kind === 'command_execution') {
          call.result = { is_error: item.status !== 'completed', code: null, message: item.status === 'completed' ? null : `exit ${item.exit_code ?? '?'} (${item.status})`,
            json: null, details: null, bytes: Buffer.byteLength(String(item.aggregated_output ?? '')) };
        } else {
          call.result = { is_error: item.status === 'failed', code: null, message: null, json: null, details: null, bytes: 0 };
        }
      }
    }
  }
  t.usage = usage;
  t.result = { subtype: t.stream_errors.length ? 'error' : 'success', is_error: t.stream_errors.length > 0, terminal_reason: null, total_cost_usd: null,
    duration_ms: null, duration_api_ms: null, num_turns: turns, model_usage: {}, permission_denials: [], text: t.texts.at(-1) ?? '' };
  t.final_text = t.texts.at(-1) ?? '';
  return t;
}

// ---------- pass conditions ----------
const MEDIA_NAME = /\.(?:mp4|mov|m4v|webm|jpe?g|png|webp|gif)\b|video/i;
const CONTENT_READERS = /(?:^|[\s|;&(`$])(?:cat|base64|xxd|od|hexdump|head|tail|strings|curl|wget|dd|openssl|less|more|python3?|node|perl|ruby|ffprobe|ffmpeg|sha256sum|shasum|md5|md5sum|cp|tar|zip|gzip)(?=\s|$)/;
const ENCODERS = /\b(?:base64|xxd|hexdump)\b|(?:^|[\s|;&])od(?=\s)/;
const LONG_BASE64 = /[A-Za-z0-9+/=]{512,}/;

function strings(value, out = []) {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach(item => strings(item, out));
  else if (value && typeof value === 'object') Object.values(value).forEach(item => strings(item, out));
  return out;
}

/** Condition 3: any attempt to read the media's bytes or to base64-encode anything. */
export function mediaReadAttempts(calls, workDir) {
  const attempts = [];
  for (const call of calls) {
    if (call.mcp) {
      for (const value of strings(call.input)) {
        if (value.length > 4096 || /^data:/i.test(value) || LONG_BASE64.test(value)) attempts.push({ call: call.name, reason: 'large or base64 value in MCP arguments', size: value.length });
      }
      continue;
    }
    const name = call.name;
    const text = JSON.stringify(call.input ?? {});
    if (['Read', 'NotebookRead', 'Edit', 'Write', 'NotebookEdit'].includes(name) && (MEDIA_NAME.test(text) || (workDir && text.includes(workDir)))) {
      attempts.push({ call: name, reason: `${name} on the media`, input: text.slice(0, 300) });
    } else if (name === 'Grep' && (MEDIA_NAME.test(text) || (workDir && text.includes(workDir)) || !call.input?.path)) {
      attempts.push({ call: name, reason: 'Grep reads file contents', input: text.slice(0, 300) });
    } else if (name === 'Bash' || name === 'command_execution') {
      const command = String(call.input?.command ?? '');
      if (ENCODERS.test(command)) attempts.push({ call: name, reason: 'encoder (base64/xxd/od/hexdump)', input: command.slice(0, 300) });
      else if (CONTENT_READERS.test(command) && (MEDIA_NAME.test(command) || (workDir && command.includes(workDir)))) {
        attempts.push({ call: name, reason: 'reads the media file', input: command.slice(0, 300) });
      }
    } else if (name === 'WebFetch' || name === 'web_search') {
      if (MEDIA_NAME.test(text)) attempts.push({ call: name, reason: 'fetches the media', input: text.slice(0, 300) });
    }
  }
  return attempts;
}

/**
 * P1 (a): the last reply asks the owner whether to post without text (§7.5 rule 4), zh or en. A question mark is not
 * required: "請給我文案，或回覆「不加文字」就只發影片" asks the same thing as "要不要不帶文字發？". It must offer posting without
 * text and ask for an answer; a reply that only says it uploaded the video, or only demands a caption, does not count.
 */
const OFFERS_NO_TEXT = new RegExp([
  // "不帶文字", "不加任何文案", "不用文案", "不需要文案"
  '不(?:帶|加|附|放|配|寫|要|用|需要)?(?:上)?(?:任何)?(?:文字|文案|說明|说明|配文|caption)',
  // "要不要附文字或 hashtag", "是否加上文案": asking whether to add text offers posting without it
  '(?:要不要|是否|需不需要)(?:再)?(?:附|加|帶|放|配|寫|補)(?:上)?(?:任何)?(?:文字|文案|說明|说明|配文|caption|hashtag|標籤)',
  '沒有文案', '沒文案', '無文案', '只發影片', '純影片',
  'without (?:a |any )?(?:caption|text)', 'no (?:caption|text)', 'captionless', '(?:add|include) (?:a |any )?(?:caption|text)',
].join('|'), 'i');
const ASKS = /[?？]|請[^。！？\n]{0,8}?(?:回覆|回答|告訴|提供|確認|決定|給|選)|回覆?「|回答「|告訴我|跟我說|讓我知道|要不要|是否|嗎|please (?:reply|confirm|let me know|tell)|let me know|would you like|do you want|should i/i;
export function asksAboutText(text) {
  const t = String(text ?? '');
  return OFFERS_NO_TEXT.test(t) && ASKS.test(t);
}

function captionsGiven(input) {
  const captions = input?.captions;
  if (!captions || typeof captions !== 'object') return false;
  return Object.values(captions).some(entry => entry && typeof entry === 'object'
    && ((typeof entry.text === 'string' && entry.text.trim()) || (Array.isArray(entry.tags) && entry.tags.length) || (typeof entry.title === 'string' && entry.title.trim())));
}

/**
 * The five §10.3 conditions for one run.
 * expected: { prompt, model, client, channels: {x, tiktok}, scheduledAt: number[], videoSha256, origin, workDir }
 * hub: { targets: [{id, social_account_id, scheduled_at, plan_status}], posts: [{post_id, status, scheduled_at, channel_id, provider,
 *        machine, caption, media: [{sha256}], web_url}] } | null
 */
export function evaluateRun({ transcript, hub, expected }) {
  const failures = [];
  const conditions = {};
  const mcpCalls = transcript.calls.filter(call => call.mcp);
  const otherCalls = transcript.calls.filter(call => !call.mcp);

  conditions.mcp_calls = { count: mcpCalls.length, limit: MCP_CALL_LIMIT, pass: mcpCalls.length <= MCP_CALL_LIMIT,
    non_mcp: otherCalls.map(call => ({ name: call.name, input: summarize(call.input, 160) })) };
  if (!conditions.mcp_calls.pass) failures.push(`${mcpCalls.length} MCP calls (> ${MCP_CALL_LIMIT})`);

  const errors = mcpCalls.filter(call => call.result?.is_error).map(call => ({ tool: call.tool, code: call.result.code, message: call.result.message }));
  const invalid = errors.filter(error => error.code === 'INVALID_ARGUMENTS').length;
  const unavailable = errors.filter(error => error.code === 'TOOL_UNAVAILABLE').length;
  conditions.argument_errors = { invalid_arguments: invalid, tool_unavailable: unavailable, pass: invalid === 0 && unavailable === 0, errors };
  if (!conditions.argument_errors.pass) failures.push(`INVALID_ARGUMENTS ×${invalid}, TOOL_UNAVAILABLE ×${unavailable}`);

  const attempts = mediaReadAttempts(transcript.calls, expected.workDir);
  conditions.no_media_read = { pass: attempts.length === 0, attempts };
  if (attempts.length) failures.push(`media read/base64 attempt: ${attempts.map(item => item.reason).join('; ')}`);

  const scheduleCalls = mcpCalls.filter(call => call.tool === 'post_schedule');
  const scheduled = scheduleCalls.filter(call => call.result && !call.result.is_error);
  const targets = hub?.targets ?? [];
  let outcome;
  let checkSchedule;
  let expectedCaption = expected.prompt.caption;
  if (expected.prompt.id === 'P1') {
    const invented = scheduleCalls.filter(call => captionsGiven(call.input));
    if (invented.length) {
      outcome = 'invented_caption';
      conditions.no_invented_caption = { applicable: true, pass: false, path: null, captions: invented.map(call => call.input.captions) };
      failures.push('P1: post_schedule was given caption text or tags the owner never gave');
      checkSchedule = scheduled.length > 0;
    } else if (!scheduleCalls.length || (!scheduled.length && scheduleCalls.every(call => call.result?.code === 'CAPTION_DECISION_REQUIRED'))) {
      // E48: a post_schedule without captions answered CAPTION_DECISION_REQUIRED is the hub asking the model to ask the owner.
      const asked = asksAboutText(transcript.final_text);
      const pass = asked && targets.length === 0;
      outcome = asked ? 'asked' : 'no_schedule';
      conditions.no_invented_caption = { applicable: true, pass, path: 'a', asked, hub_targets: targets.length };
      if (!asked) failures.push('P1: nothing scheduled and the last reply does not ask whether to post without text');
      if (targets.length) failures.push(`P1: ${targets.length} publish_target(s) exist although post_schedule was never called`);
      checkSchedule = false;
    } else if (!scheduled.length) {
      outcome = 'schedule_failed';
      conditions.no_invented_caption = { applicable: true, pass: false, path: 'b', reason: 'every post_schedule call failed' };
      failures.push('P1: post_schedule was called without captions but never succeeded');
      checkSchedule = false;
    } else {
      // E48: no_caption: true means the owner said to post without text; in a one-sentence run the owner never did.
      outcome = 'decided_for_owner';
      conditions.no_invented_caption = { applicable: true, pass: false, path: 'b', reason: 'no_caption: true without the owner\'s answer' };
      failures.push('P1: scheduled without text (no_caption: true) although the owner was never asked');
      checkSchedule = true;
      expectedCaption = '';
    }
  } else {
    conditions.no_invented_caption = { applicable: false, pass: true };
    outcome = scheduled.length ? 'scheduled' : scheduleCalls.length ? 'schedule_failed' : 'no_schedule';
    checkSchedule = true;
  }

  if (checkSchedule) {
    const problems = [];
    if (!hub) problems.push('hub state could not be read');
    else {
      if (targets.length !== 2) problems.push(`${targets.length} publish_target(s) in the hub (expected exactly 2)`);
      const want = new Map([[expected.channels.x, 'x'], [expected.channels.tiktok, 'tiktok']]);
      const accounts = targets.map(target => target.social_account_id);
      for (const [id, provider] of want) if (accounts.filter(account => account === id).length !== 1) problems.push(`not exactly one target on the ${provider} channel`);
      for (const target of targets) {
        if (!want.has(target.social_account_id)) problems.push(`target ${target.id} is on an unexpected channel ${target.social_account_id}`);
        const at = Date.parse(String(target.scheduled_at));
        if (!expected.scheduledAt.includes(at)) problems.push(`target ${target.id} scheduled_at ${target.scheduled_at} (expected ${expected.scheduledAt.map(ms => new Date(ms).toISOString()).join(' or ')})`);
        const post = hub.posts.find(item => item.post_id === target.id);
        if (!post) { problems.push(`target ${target.id} missing from the posts view`); continue; }
        if (post.status !== 'scheduled') problems.push(`post ${post.post_id} status ${post.status} (expected scheduled)`);
        if (!post.media.some(media => media.sha256 === expected.videoSha256)) problems.push(`post ${post.post_id} does not carry the uploaded video`);
        if (post.media.length !== 1) problems.push(`post ${post.post_id} has ${post.media.length} media (expected the one video)`);
        if (expectedCaption !== null && post.caption !== expectedCaption) problems.push(`post ${post.post_id} caption ${JSON.stringify(post.caption)} (expected ${JSON.stringify(expectedCaption)})`);
        const urls = [post.web_url, ...scheduled.flatMap(call => (call.result.json?.posts ?? []).filter(item => item.post_id === post.post_id).map(item => item.web_url))].filter(Boolean);
        if (!urls.some(url => transcript.final_text.includes(url))) problems.push(`the last reply does not give the web_url of post ${post.post_id} (${post.provider})`);
      }
    }
    conditions.schedule = { applicable: true, pass: problems.length === 0, problems, expected_caption: expectedCaption,
      expected_scheduled_at: expected.scheduledAt.map(ms => new Date(ms).toISOString()) };
    failures.push(...problems);
  } else {
    conditions.schedule = { applicable: false, pass: true };
  }

  const usageKeys = Object.keys(transcript.result?.model_usage ?? {});
  const models = [...new Set(transcript.assistant_models)];
  let modelPass;
  if (expected.client === 'claude') modelPass = usageKeys.includes(expected.model) && models.length > 0 && models.every(model => model === expected.model);
  else modelPass = expected.model ? (expected.reportedModel ? expected.reportedModel === expected.model : null) : null;
  conditions.model = { expected: expected.model, model_usage_keys: usageKeys, assistant_models: models, reported: expected.reportedModel ?? null,
    pass: modelPass, auxiliary_models: usageKeys.filter(key => key !== expected.model) };
  if (modelPass === false) failures.push(`model mismatch: modelUsage ${JSON.stringify(usageKeys)}, assistant ${JSON.stringify(models)}`);

  if (transcript.result?.subtype && transcript.result.subtype !== 'success') failures.push(`client ended with ${transcript.result.subtype}`);
  const pass = failures.length === 0;
  return { pass, outcome, failures, conditions };
}

// ---------- reporting ----------
function summarize(value, max = 240) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text && text.length > max ? `${text.slice(0, max)}…(${text.length})` : text;
}
function resultSummary(call) {
  const result = call.result;
  if (!result) return { status: 'no_result' };
  if (result.is_error) return { status: 'error', code: result.code, message: result.message, details: result.details ? summarize(result.details, 400) : undefined, bytes: result.bytes };
  const json = result.json ?? {};
  const pick = {};
  if (call.tool === 'media_upload') Object.assign(pick, { media_id: json.media_id, status: json.status, bytes: json.bytes, deduplicated: json.deduplicated });
  if (call.tool === 'post_schedule') Object.assign(pick, { posts: (json.posts ?? []).map(post => ({ post_id: post.post_id, provider: post.provider, status: post.status,
    local_time: post.local_time, machine: post.route?.machine_name, caption_preview: post.caption_preview, warnings: (post.warnings ?? []).map(w => w.code) })) });
  if (call.tool === 'smartsell_overview') Object.assign(pick, { timezone: json.workspace?.timezone, channels: (json.channels ?? []).map(c => `${c.provider}:${c.handle}@${c.machine}`) });
  return { status: 'ok', bytes: result.bytes, ...pick };
}

export function summaryTable(runs, prompts) {
  const lines = ['| Prompt | Passed | Runs | Gate (≥4/5) | Avg MCP calls | Avg cost USD | Avg duration s | Outcomes |', '|---|---|---|---|---|---|---|---|'];
  const byPrompt = {};
  for (const id of prompts) {
    const list = runs.filter(run => run.prompt === id && !run.skipped);
    const passed = list.filter(run => run.pass).length;
    const avg = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const calls = avg(list.map(run => run.mcp_call_count).filter(value => typeof value === 'number'));
    const cost = avg(list.map(run => run.total_cost_usd).filter(value => typeof value === 'number'));
    const duration = avg(list.map(run => run.duration_ms).filter(value => typeof value === 'number'));
    const outcomes = Object.entries(list.reduce((acc, run) => { const key = run.harness_error ? 'harness_error' : run.outcome; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}))
      .map(([key, count]) => `${key}×${count}`).join(', ');
    const gate = list.length >= GATE.runs ? passed >= GATE.pass : null;
    byPrompt[id] = { runs: list.length, passed, pass_rate: list.length ? passed / list.length : null, gate, avg_mcp_calls: calls, avg_cost_usd: cost, avg_duration_ms: duration, outcomes };
    lines.push(`| ${id} | ${passed} | ${list.length} | ${gate === null ? 'incomplete' : gate ? 'pass' : 'FAIL'} | ${calls === null ? '—' : calls.toFixed(1)} | ${cost === null ? '—' : cost.toFixed(3)} | ${duration === null ? '—' : (duration / 1000).toFixed(0)} | ${outcomes || '—'} |`);
  }
  lines.push('', '| Run | Pass | MCP calls | Sequence | Errors | Turns | Cost USD | Failure |', '|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    if (run.skipped) { lines.push(`| ${run.id} | skipped | | | | | | ${run.skipped} |`); continue; }
    lines.push(`| ${run.id} | ${run.pass ? 'pass' : 'FAIL'} | ${run.mcp_call_count ?? '—'} | ${(run.sequence ?? []).join(' → ')} | ${(run.errors ?? []).map(e => `${e.tool}:${e.code}`).join(', ') || '—'} | ${run.num_turns ?? '—'} | ${typeof run.total_cost_usd === 'number' ? run.total_cost_usd.toFixed(3) : '—'} | ${(run.harness_error ? [`harness: ${run.harness_error}`] : run.failures ?? []).join('; ').replace(/\|/g, '/').slice(0, 300) || '—'} |`);
  }
  return { table: lines.join('\n'), byPrompt };
}

// ---------- client processes ----------
function findOnPath(command) {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  for (const dir of String(process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of process.platform === 'win32' ? ['.exe', '.cmd', ''] : ['']) {
      const path = join(dir, command + ext);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The cleared environment the model client runs with (names only are recorded). */
function clientEnv(extra = {}) {
  const user = userInfo().username;
  return {
    HOME: homedir(), USER: user, LOGNAME: user, SHELL: process.env.SHELL || '/bin/zsh',
    PATH: [dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(delimiter),
    TMPDIR: tmpdir(), LANG: 'en_US.UTF-8', TERM: 'dumb', ...extra,
  };
}

/** Keep the init event small in the saved transcript (it lists the owner's local skills and plugins). */
function sanitizeLine(line) {
  try {
    const event = JSON.parse(line);
    if (event.type === 'system' && event.subtype === 'init') {
      return JSON.stringify({ type: 'system', subtype: 'init', model: event.model, cwd: event.cwd, mcp_servers: event.mcp_servers, permissionMode: event.permissionMode,
        claude_code_version: event.claude_code_version, tools: (event.tools ?? []).filter(name => name.startsWith('mcp__')), tool_count: (event.tools ?? []).length });
    }
  } catch { /* keep */ }
  return line;
}

function runProcess({ bin, args, cwd, env, transcriptPath, stderrPath, timeoutMs }) {
  return new Promise(resolvePromise => {
    const started = Date.now();
    const out = createWriteStream(transcriptPath);
    const err = createWriteStream(stderrPath);
    const lines = [];
    let buffer = '';
    let timedOut = false;
    const child = spawn(bin, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 10_000).unref(); }, timeoutMs);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        lines.push(line);
        out.write(`${sanitizeLine(line)}\n`);
      }
    });
    child.stderr.on('data', chunk => err.write(chunk));
    const finish = (code, signal, error) => {
      clearTimeout(timer);
      if (buffer.trim()) { lines.push(buffer); out.write(`${sanitizeLine(buffer)}\n`); }
      out.end(); err.end();
      resolvePromise({ lines, code, signal, timedOut, error: error ? String(error.message ?? error) : null, wall_ms: Date.now() - started });
    };
    child.once('error', error => finish(null, null, error));
    child.once('exit', (code, signal) => finish(code, signal, null));
  });
}

function toml(value) { return JSON.stringify(value); }
function codexConfig({ model, relay }) {
  return [
    '# Temporary CODEX_HOME written by scripts/real-model-check.mjs for one run (phase1-design §10.3). Not the owner\'s config.',
    ...(model ? [`model = ${toml(model)}`] : []),
    'approval_policy = "never"',
    'sandbox_mode = "read-only"',
    '',
    `[mcp_servers.${MCP_SERVER}]`,
    `command = ${toml(relay.command)}`,
    `args = [${relay.args.map(toml).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 120',
    'default_tools_approval_mode = "approve"',
    '',
  ].join('\n');
}
/** The model a Codex session used, from its session log in the temporary CODEX_HOME (best effort). */
function codexSessionModel(codexHome) {
  const found = [];
  const walk = dir => {
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.jsonl')) {
        for (const line of readFileSync(path, 'utf8').split('\n')) {
          if (!line.includes('"turn_context"') && !line.includes('"session_meta"')) continue;
          const match = /"model"\s*:\s*"([^"]+)"/.exec(line);
          if (match) found.push(match[1]);
        }
      }
    }
  };
  walk(join(codexHome, 'sessions'));
  return found.at(-1) ?? null;
}

// ---------- one run ----------
async function hubState(stack) {
  const list = await stack.view('/views/posts?from=2000-01-01&to=2100-12-31&limit=200');
  const posts = [];
  for (const summary of list.posts ?? []) {
    const detail = await stack.view(`/views/posts/${summary.post_id}`);
    posts.push({ post_id: detail.post.post_id, status: detail.post.status, scheduled_at: detail.post.scheduled_at, local_time: detail.post.local_time,
      channel_id: detail.post.channel.id, provider: detail.post.channel.provider, machine: detail.post.machine?.name ?? null, approval: detail.post.approval,
      caption: detail.content?.caption ?? null, media: (detail.media ?? []).map(media => ({ media_id: media.media_id, sha256: media.sha256, status: media.status, filename: media.filename })),
      web_url: detail.post.web_url });
  }
  await stack.killHub('SIGTERM');
  const records = stack.records();
  const targets = records.list('publish_target').map(row => ({ id: row.id, social_account_id: row.social_account_id ?? null, scheduled_at: row.scheduled_at ?? null, plan_status: row.plan_status ?? null }));
  return { posts, targets };
}

function harnessProblem(client, transcript, processResult) {
  if (processResult.error) return `client did not start: ${processResult.error}`;
  if (processResult.timedOut) return null;   // a run that never finished is the model's failure, reported as such
  if (client === 'claude') {
    if (!transcript.init) return `no init event (exit ${processResult.code})`;
    const server = transcript.init.mcp_servers.find(item => item.name === MCP_SERVER);
    if (!server || server.status !== 'connected') return `MCP server ${MCP_SERVER} not connected (${JSON.stringify(transcript.init.mcp_servers)})`;
    const others = transcript.init.mcp_servers.filter(item => item.name !== MCP_SERVER);
    if (others.length) return `other MCP servers loaded despite --strict-mcp-config: ${others.map(item => item.name).join(', ')}`;
    if (!transcript.result) return `no result event (exit ${processResult.code})`;
    if (transcript.result.is_error && (transcript.result.terminal_reason === 'api_error' || /Not logged in|authentication|overloaded|rate.?limit|api error/i.test(transcript.result.text)))
      return `client API error: ${transcript.result.text.slice(0, 200)}`;
  } else {
    if (!transcript.init) return `no thread.started event (exit ${processResult.code})`;
    if (transcript.stream_errors.some(error => /auth|login|unauthor|api key|rate.?limit|quota/i.test(error))) return `client error: ${transcript.stream_errors.join('; ').slice(0, 300)}`;
  }
  return null;
}

async function runOnce(task, ctx) {
  const { startStack } = await import('../tests/e2e-phase1/stack.ts');
  const { e2eClip } = await import('../tests/e2e-phase1/video.ts');
  const id = `${task.prompt.id}-${task.index}`;
  const base = mkdtempSync(join(tmpdir(), `ss-rm-${ctx.client}-${id}-`));
  const workDir = join(base, 'work');
  const clientDir = join(base, 'client');
  mkdirSync(workDir, { mode: 0o700 });
  mkdirSync(clientDir, { mode: 0o700 });
  let stack = null;
  try {
    stack = await startStack({ name: `real-model-${ctx.client}-${id}` , clip: false });
    const video = await e2eClip(workDir);
    const tokenFile = join(clientDir, 'token');
    writeFileSync(tokenFile, stack.agentToken, { mode: 0o600 });
    const relay = { command: process.execPath, args: [relayBundle, '--hub', stack.origin, '--token-file', tokenFile] };
    const transcriptPath = join(ctx.transcriptDir, `${id}.jsonl`);
    const stderrPath = join(ctx.transcriptDir, `${id}.stderr.log`);
    const startedAt = Date.now();
    let processResult;
    let transcript;
    let reportedModel = null;
    if (ctx.client === 'claude') {
      const mcpConfig = join(clientDir, 'mcp.json');
      writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { [MCP_SERVER]: relay } }), { mode: 0o600 });
      processResult = await runProcess({ bin: ctx.bin, args: claudeArgs({ prompt: task.prompt.text, model: ctx.model, mcpConfig }), cwd: workDir,
        env: clientEnv(ctx.extraEnv), transcriptPath, stderrPath, timeoutMs: ctx.timeoutMs });
      transcript = parseClaudeStream(processResult.lines);
    } else {
      const codexHome = join(clientDir, 'codex-home');
      mkdirSync(codexHome, { mode: 0o700 });
      writeFileSync(join(codexHome, 'config.toml'), codexConfig({ model: ctx.model, relay }), { mode: 0o600 });
      // The owner's Codex login: linked, never read or copied. API keys pass through only when the owner set one.
      const ownerAuth = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
      if (existsSync(ownerAuth)) symlinkSync(ownerAuth, join(codexHome, 'auth.json'));
      const keys = Object.fromEntries(['CODEX_API_KEY', 'OPENAI_API_KEY'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      processResult = await runProcess({ bin: ctx.bin, args: codexArgs({ prompt: task.prompt.text, model: ctx.model, cwd: workDir }), cwd: workDir,
        env: clientEnv({ ...ctx.extraEnv, ...keys, CODEX_HOME: codexHome }), transcriptPath, stderrPath, timeoutMs: ctx.timeoutMs });
      transcript = parseCodexStream(processResult.lines);
      reportedModel = codexSessionModel(codexHome);
    }
    const harness = harnessProblem(ctx.client, transcript, processResult);
    const scheduledAt = [...new Set([tomorrowAt(startedAt), tomorrowAt(Date.now())])];
    let hub = null;
    let hubError = null;
    try { hub = await hubState(stack); } catch (error) { hubError = String(error?.message ?? error); }
    const expected = { prompt: task.prompt, model: ctx.model, client: ctx.client, channels: { x: stack.channels.x.id, tiktok: stack.channels.tiktok.id },
      scheduledAt, videoSha256: video.sha256, origin: stack.origin, workDir, reportedModel };
    const verdict = evaluateRun({ transcript, hub, expected });
    if (processResult.timedOut) verdict.failures.unshift(`client did not finish within ${ctx.timeoutMs / 1000} s`), verdict.pass = false;
    if (hubError) verdict.failures.push(`hub state: ${hubError}`), verdict.pass = false;
    const mcpCalls = transcript.calls.filter(call => call.mcp);
    return {
      id, prompt: task.prompt.id, index: task.index, started_at: new Date(startedAt).toISOString(),
      pass: !harness && verdict.pass, harness_error: harness, outcome: verdict.outcome, failures: verdict.failures, conditions: verdict.conditions,
      mcp_call_count: mcpCalls.length, sequence: mcpCalls.map(call => call.tool),
      calls: transcript.calls.map(call => ({ name: call.name, mcp: call.mcp, ...(call.subagent && { subagent: true }), input: summarize(call.input, 600), result: resultSummary(call) })),
      non_mcp_calls: transcript.calls.filter(call => !call.mcp).map(call => ({ name: call.name, input: summarize(call.input, 300), error: call.result?.is_error ? call.result.message : null })),
      errors: mcpCalls.filter(call => call.result?.is_error).map(call => ({ tool: call.tool, code: call.result.code, message: call.result.message })),
      permission_denials: (transcript.result?.permission_denials ?? []).map(denial => ({ tool: denial.tool_name, input: summarize(denial.tool_input, 200) })),
      final_text: transcript.final_text, total_cost_usd: transcript.result?.total_cost_usd ?? null,
      duration_ms: transcript.result?.duration_ms ?? processResult.wall_ms, wall_ms: processResult.wall_ms, num_turns: transcript.result?.num_turns ?? null,
      result_subtype: transcript.result?.subtype ?? null, model_usage_keys: Object.keys(transcript.result?.model_usage ?? {}), assistant_models: [...new Set(transcript.assistant_models)],
      reported_model: reportedModel, usage: transcript.usage, exit_code: processResult.code, timed_out: processResult.timedOut,
      hub: hub && { targets: hub.targets, posts: hub.posts.map(post => ({ ...post, media: post.media.map(media => ({ ...media, sha256: media.sha256?.slice(0, 16) })) })) },
      expected_scheduled_at: scheduledAt.map(ms => new Date(ms).toISOString()), video: { bytes: video.bytes, sha256: video.sha256 },
      transcript: transcriptPath, stack_logs: stack.logDir,
    };
  } finally {
    await stack?.close().catch(() => {});
    if (!ctx.keep) rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

// ---------- main ----------
function parseOptions(argv) {
  const options = { client: 'claude', prompts: ['P1', 'P2'], runs: GATE.runs, parallel: 1, keep: false, write: true, timeoutSec: 900 };
  const args = argv.filter(arg => arg !== '--');
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = () => { const next = args[++i]; if (next === undefined) throw new Error(`${arg} needs a value`); return next; };
    if (arg === '--client') options.client = value();
    else if (arg === '--model') options.model = value();
    else if (arg === '--prompts') options.prompts = value().split(',').map(item => item.trim().toUpperCase()).filter(Boolean);
    else if (arg === '--runs') options.runs = Number(value());
    else if (arg === '--parallel') options.parallel = Number(value());
    else if (arg === '--label') options.label = value();
    else if (arg === '--claude-bin') options.claudeBin = value();
    else if (arg === '--codex-bin') options.codexBin = value();
    else if (arg === '--timeout-sec') options.timeoutSec = Number(value());
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--no-write') options.write = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown option ${arg}`);
  }
  if (!['claude', 'codex'].includes(options.client)) throw new Error('--client must be claude or codex');
  if (options.prompts.some(id => !PROMPTS[id])) throw new Error('--prompts takes P1,P2');
  for (const key of ['runs', 'parallel', 'timeoutSec']) if (!Number.isInteger(options[key]) || options[key] < 1) throw new Error(`--${key} must be a positive integer`);
  return options;
}

function clientVersion(bin) {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', env: clientEnv(), timeout: 30_000 });
  return result.status === 0 ? String(result.stdout).trim() : null;
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseOptions(argv); } catch (error) { console.error(`real-model-check: ${error.message}`); return 2; }
  if (options.help) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 14).map(line => line.replace(/^\/\/ ?/, '')).join('\n')); return 0; }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  // The client must exist before anything starts: never pretend a run happened.
  let bin;
  if (options.client === 'claude') {
    const fallback = join(homedir(), '.local', 'bin', 'claude'); // the native installer's default location
    bin = findOnPath(options.claudeBin ?? (existsSync(fallback) ? fallback : 'claude'));
    if (!bin) { console.error('real-model-check: Claude Code CLI not found (install it or pass --claude-bin <path>). Nothing was run.'); return 2; }
  } else {
    bin = findOnPath(options.codexBin ?? 'codex');
    if (!bin) { console.error('real-model-check: codex CLI not found (install the Codex CLI, sign in with `codex login`, or pass --codex-bin <path>). Nothing was run.'); return 2; }
  }
  const version = clientVersion(bin);
  if (!version) { console.error(`real-model-check: ${bin} --version failed. Nothing was run.`); return 2; }
  const model = options.model ?? (options.client === 'claude' ? config.REAL_MODEL_ID : config.CODEX_MODEL_ID ?? null);
  if (options.client === 'claude' && !model) { console.error('real-model-check: REAL_MODEL_ID is missing in tests/real-model/config.json. Nothing was run.'); return 2; }

  if (!existsSync(relayBundle)) {
    console.log('relay bundle missing; building it with the package script (packages/agent-relay/scripts/build.mjs)');
    const build = spawnSync(process.execPath, [join(repoRoot, 'packages/agent-relay/scripts/build.mjs')], { cwd: repoRoot, stdio: 'inherit' });
    if (build.status !== 0 || !existsSync(relayBundle)) { console.error('real-model-check: could not build the relay bundle. Nothing was run.'); return 2; }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const transcriptDir = join(tmpdir(), 'smartsell-real-model', `${stamp}-${options.client}`);
  mkdirSync(transcriptDir, { recursive: true });
  const extraEnv = options.client === 'claude' ? { DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {};
  const ctx = { client: options.client, bin, model, timeoutMs: options.timeoutSec * 1000, keep: options.keep, transcriptDir, extraEnv };
  const tasks = [];
  for (let index = 1; index <= options.runs; index++) for (const id of options.prompts) tasks.push({ prompt: PROMPTS[id], index });
  console.log(`real-model-check: ${options.client} ${version}, model ${model ?? '(client default)'}, ${tasks.length} runs (${options.prompts.join('+')} ×${options.runs}), parallel ${options.parallel}`);
  console.log(`transcripts: ${transcriptDir}`);

  const startedAt = new Date().toISOString();
  const runs = [];
  let voidReason = null;
  let next = 0;
  let firstDone = false;
  async function worker() {
    while (next < tasks.length) {
      const task = tasks[next++];
      const id = `${task.prompt.id}-${task.index}`;
      if (voidReason) { runs.push({ id, prompt: task.prompt.id, index: task.index, skipped: `round void: ${voidReason}`, pass: false }); continue; }
      let run;
      const attempts = [];
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { run = await runOnce(task, ctx); }
        catch (error) { run = { id, prompt: task.prompt.id, index: task.index, pass: false, harness_error: `stack or run failed: ${String(error?.stack ?? error).slice(0, 600)}`, failures: [] }; }
        if (!run.harness_error) break;
        attempts.push(run.harness_error);
        console.log(`  ${id}: harness error (${run.harness_error.slice(0, 160)})${attempt === 1 ? ', retrying once' : ''}`);
      }
      if (attempts.length) run.harness_attempts = attempts;
      runs.push(run);
      console.log(`  ${id}: ${run.pass ? 'pass' : 'FAIL'} — ${run.mcp_call_count ?? '?'} MCP calls [${(run.sequence ?? []).join(' → ')}]${run.failures?.length ? ` — ${run.failures.join('; ')}` : ''}`);
      // §10.3: the first run's modelUsage key must equal REAL_MODEL_ID, otherwise the round is void.
      if (!firstDone && !run.harness_error) {
        firstDone = true;
        if (run.conditions?.model?.pass === false) voidReason = `first run used ${JSON.stringify(run.model_usage_keys)} / ${JSON.stringify(run.assistant_models)}, not ${model}`;
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(options.parallel, tasks.length) }, () => worker()));
  runs.sort((a, b) => a.index - b.index || a.prompt.localeCompare(b.prompt));

  const { table, byPrompt } = summaryTable(runs, options.prompts);
  const gatePassed = !voidReason && options.prompts.every(id => byPrompt[id].gate === true);
  const report = {
    check: 'phase1-design §10.3 real-model check', client: options.client, client_version: version, client_bin: displayPath(bin), model_id: model,
    model_source: options.model ? 'cli' : 'tests/real-model/config.json', label: options.label ?? null,
    started_at: startedAt, finished_at: new Date().toISOString(), host: { platform: process.platform, arch: process.arch, node: process.version },
    command: options.client === 'claude' ? [bin, ...claudeArgs({ prompt: '<prompt>', model, mcpConfig: '<tmp>/mcp.json' })] : [bin, ...codexArgs({ prompt: '<prompt>', model, cwd: '<tmp work dir>' })],
    mcp_config: { mcpServers: { [MCP_SERVER]: { command: 'node', args: ['packages/agent-relay/dist/smartsell-relay.mjs', '--hub', 'http://127.0.0.1:<p>', '--token-file', '<tmp>/token'] } } },
    client_env_keys: Object.keys(clientEnv(ctx.extraEnv)).concat(options.client === 'codex' ? ['CODEX_HOME'] : []),
    prompts: Object.fromEntries(options.prompts.map(id => [id, PROMPTS[id].text])), runs_per_prompt: options.runs, gate: `each prompt ≥ ${GATE.pass}/${GATE.runs}`,
    void: voidReason, gate_passed: gatePassed, summary: byPrompt, summary_table: table, transcripts: transcriptDir, runs,
  };
  if (options.write) {
    mkdirSync(resultsDir, { recursive: true });
    const file = join(resultsDir, `${stamp}-${options.client}.json`);
    writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`results: ${file}`);
  }
  console.log(`\n${table}\n`);
  const incomplete = options.prompts.some(id => byPrompt[id].gate === null);
  console.log(voidReason ? `ROUND VOID: ${voidReason}` : gatePassed ? 'GATE PASSED'
    : incomplete ? `GATE NOT EVALUATED: fewer than ${GATE.runs} completed runs per prompt` : 'GATE FAILED');
  return voidReason ? 2 : gatePassed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // Exit explicitly: a stuck child handle must not keep a finished check alive.
  main().then(code => process.exit(code), error => { console.error(error); process.exit(2); });
}
