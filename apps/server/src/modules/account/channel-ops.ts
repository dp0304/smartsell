import { createHash } from 'node:crypto';
import {
  ADMIN, AUTOMATION_NOTICE_VERSION, Problem, RISK_ACK_PROVIDERS, RISK_TERMS, RISK_TERMS_VERSION,
  type ApprovalMode, type ChannelSettingsRecord, type Context, type Data, type DriverProvider, type Operation, type PlatformDefaults,
  type PublishWindow, type Row, type TikTokDefaults, type WorkerJobStatus, type XDefaults,
} from '@smartsell/contracts';
import { requireHuman } from '../../agent-actor.js';
import { drainConnectorTasks } from './connector-service.js';
import { bindingFor } from './device-control.js';
import { audit } from './input.js';
import { activeMigration } from './migration.js';
import {
  applyApprovalModeChange, channelDevices, effectiveMode, ensureChannelSettings, isHubProvider, workerEngine, CHANNEL_SETTINGS,
} from './channel-settings.js';

/**
 * Human-only channel settings operations (phase1-design §4, Appendix B.3). They carry their full hub_* names and never go
 * through the account module's op() helper, which would prefix 'account_' and slip past HUMAN_ONLY (§4.6).
 */
type Issue = { path: string; message: string };
const invalid = (issues: Issue[]) => new Problem(422, 'INVALID_ARGUMENTS', `欄位不正確：${issues.map(issue => issue.path).join('、')}`, { issues });
const isObject = (value: unknown): value is Data => !!value && typeof value === 'object' && !Array.isArray(value);
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const hhmm = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
/** Jobs that may still act on the platform for this channel (§5.10 step 1). */
const ACTIVE_JOB_STATUSES: readonly WorkerJobStatus[] = ['claimed', 'ready', 'running', 'submitting', 'result_pending', 'needs_owner', 'releasing', 'unreported', 'outcome_unknown'];

/** E38: the smallest lateness limit, in minutes (settings PATCH, its JSON schema and the channel page input). */
export const LATENESS_MIN = 2;
export const SETTINGS_FIELDS = ['execution_mode', 'approval_mode', 'daily_cap', 'window', 'timezone', 'lateness_limit_min', 'caption_limit', 'platform_defaults'] as const;
type SettingsField = typeof SETTINGS_FIELDS[number];

function channel(ctx: Context, id: string) {
  const account = ctx.get('social_account', id);
  if (!isHubProvider(account.provider)) throw new Problem(422, 'CHANNEL_NOT_FOUND', '這不是第 1 階段支援的帳號', { channel_id: id });
  return account;
}

function integerIn(issues: Issue[], path: string, value: unknown, min: number, max: number) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) issues.push({ path, message: `需為 ${min}–${max} 的整數` });
  return value as number;
}

function zoneValid(zone: unknown) {
  if (typeof zone !== 'string' || !zone || zone.length > 100) return false;
  try { new Intl.DateTimeFormat('en', { timeZone: zone }); return true; } catch { return false; }
}

function parseWindow(issues: Issue[], value: unknown): PublishWindow | null {
  if (value === null) return null;
  if (!isObject(value)) { issues.push({ path: 'window', message: '需為 {start, end, days} 或 null' }); return null; }
  for (const key of Object.keys(value)) if (!['start', 'end', 'days'].includes(key)) issues.push({ path: `window.${key}`, message: '不認得的欄位' });
  if (typeof value.start !== 'string' || !hhmm.test(value.start)) issues.push({ path: 'window.start', message: '需為 HH:mm' });
  if (typeof value.end !== 'string' || !hhmm.test(value.end)) issues.push({ path: 'window.end', message: '需為 HH:mm' });
  if (value.start === value.end) issues.push({ path: 'window.end', message: '起訖時間不能相同' });
  const days = Array.isArray(value.days) ? value.days : [];
  if (!Array.isArray(value.days) || !days.length || days.length > 7 || new Set(days).size !== days.length ||
    days.some(day => typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 7)) issues.push({ path: 'window.days', message: '需為 1（星期一）到 7 的不重複整數' });
  return { start: String(value.start), end: String(value.end), days: [...days].sort() as PublishWindow['days'] };
}

const privacyLevels = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'] as const;
const disclosures = ['none', 'your_brand', 'branded_content', 'both'] as const;
const replySettings = ['everyone', 'following', 'mentioned', 'verified'] as const;

function parseDefaults(issues: Issue[], value: unknown, provider: string): PlatformDefaults {
  if (!isObject(value)) { issues.push({ path: 'platform_defaults', message: '需為物件' }); return {}; }
  const result: PlatformDefaults = {};
  for (const [key, entry] of Object.entries(value)) {
    const path = `platform_defaults.${key}`;
    if (key !== provider || !['tiktok', 'x'].includes(key)) { issues.push({ path, message: '只能設定這個帳號平台的預設值' }); continue; }
    if (!isObject(entry)) { issues.push({ path, message: '需為物件' }); continue; }
    if (key === 'tiktok') {
      const allowed = ['privacy_level', 'allow_comment', 'allow_duet', 'allow_stitch', 'commercial_disclosure', 'ai_generated'];
      for (const field of Object.keys(entry)) if (!allowed.includes(field)) issues.push({ path: `${path}.${field}`, message: '不認得的欄位' });
      if (!(privacyLevels as readonly unknown[]).includes(entry.privacy_level)) issues.push({ path: `${path}.privacy_level`, message: `需為 ${privacyLevels.join('、')}` });
      if (!(disclosures as readonly unknown[]).includes(entry.commercial_disclosure)) issues.push({ path: `${path}.commercial_disclosure`, message: `需為 ${disclosures.join('、')}` });
      for (const field of ['allow_comment', 'allow_duet', 'allow_stitch']) if (typeof entry[field] !== 'boolean') issues.push({ path: `${path}.${field}`, message: '需為 true 或 false' });
      if (entry.ai_generated !== undefined && typeof entry.ai_generated !== 'boolean') issues.push({ path: `${path}.ai_generated`, message: '需為 true 或 false' });
      if (entry.privacy_level === 'SELF_ONLY' && ['branded_content', 'both'].includes(String(entry.commercial_disclosure))) {
        issues.push({ path: `${path}.privacy_level`, message: 'TikTok 的品牌合作內容不能設為只有自己看得到' });
      }
      result.tiktok = {
        privacy_level: entry.privacy_level, allow_comment: entry.allow_comment, allow_duet: entry.allow_duet, allow_stitch: entry.allow_stitch,
        commercial_disclosure: entry.commercial_disclosure, ai_generated: entry.ai_generated ?? false,
      } as TikTokDefaults;
    } else {
      for (const field of Object.keys(entry)) if (field !== 'reply_settings') issues.push({ path: `${path}.${field}`, message: '不認得的欄位' });
      if (!(replySettings as readonly unknown[]).includes(entry.reply_settings)) issues.push({ path: `${path}.reply_settings`, message: `需為 ${replySettings.join('、')}` });
      result.x = { reply_settings: entry.reply_settings } as XDefaults;
    }
  }
  return result;
}

/** Validates a settings patch. Unknown fields and every invalid value are reported together with their paths. */
export function parseSettingsPatch(body: Data, provider: string): Partial<Pick<ChannelSettingsRecord, SettingsField>> {
  const issues: Issue[] = [];
  for (const key of Object.keys(body)) if (!(SETTINGS_FIELDS as readonly string[]).includes(key)) issues.push({ path: key, message: '不認得的欄位' });
  const patch: Data = {};
  if ('execution_mode' in body) {
    if (body.execution_mode === 'api') throw new Problem(422, 'EXECUTION_MODE_UNAVAILABLE', '第 1 階段還不支援以官方 API 發布，請選「Worker 代發」或「Worker 準備好、我自己按」');
    if (!['browser_auto', 'browser_assist'].includes(String(body.execution_mode))) issues.push({ path: 'execution_mode', message: '需為 browser_auto 或 browser_assist' });
    patch.execution_mode = body.execution_mode;
  }
  if ('approval_mode' in body) {
    if (!['direct', 'needs_approval'].includes(String(body.approval_mode))) issues.push({ path: 'approval_mode', message: '需為 direct 或 needs_approval' });
    patch.approval_mode = body.approval_mode;
  }
  if ('daily_cap' in body) patch.daily_cap = integerIn(issues, 'daily_cap', body.daily_cap, 1, 50);
  // E38: at least 2 minutes. A shorter window is missed by network latency and clock skew before the go reaches the hub.
  if ('lateness_limit_min' in body) patch.lateness_limit_min = integerIn(issues, 'lateness_limit_min', body.lateness_limit_min, LATENESS_MIN, 240);
  if ('caption_limit' in body) patch.caption_limit = body.caption_limit === null ? null : integerIn(issues, 'caption_limit', body.caption_limit, 1, 25_000);
  if ('timezone' in body) {
    if (!zoneValid(body.timezone)) issues.push({ path: 'timezone', message: '需為 IANA 時區，例如 Asia/Shanghai' });
    patch.timezone = body.timezone;
  }
  if ('window' in body) patch.window = parseWindow(issues, body.window);
  if ('platform_defaults' in body) patch.platform_defaults = parseDefaults(issues, body.platform_defaults, provider);
  if (issues.length) throw invalid(issues);
  return patch as Partial<Pick<ChannelSettingsRecord, SettingsField>>;
}

function expectVersion(settings: ChannelSettingsRecord, expected: number | undefined) {
  if (expected === undefined) throw new Problem(428, 'VERSION_REQUIRED', '請帶 If-Match（帳號設定的 version）');
  if (settings.version !== expected) {
    throw new Problem(409, 'VERSION_CONFLICT', '帳號設定已被更新，請重新整理後再存檔', { current_version: settings.version, expected_version: expected });
  }
}

/** Writes a settings change, bumping settings_generation and the heartbeat sync generation of the bound machine. */
function writeSettings(ctx: Context, settings: ChannelSettingsRecord, patch: Data, reason: string) {
  const updated = ctx.update(CHANNEL_SETTINGS, settings.id, { ...patch, settings_generation: settings.settings_generation + 1 }) as unknown as ChannelSettingsRecord;
  workerEngine().bumpSyncGeneration(ctx, channelDevices(ctx, settings.social_account_id), reason);
  return updated;
}

function updateSettings(ctx: Context, accountId: string, body: Data, expected: number | undefined) {
  const account = channel(ctx, accountId);
  const current = ensureChannelSettings(ctx, account.id);
  expectVersion(current, expected);
  const values = parseSettingsPatch(body, String(account.provider));
  if (values.platform_defaults) values.platform_defaults = { ...current.platform_defaults, ...values.platform_defaults };
  const fields = SETTINGS_FIELDS.filter(field => field in values && !same(values[field], current[field]));
  const approvalChanged = fields.includes('approval_mode');
  const patch: Data = Object.fromEntries(fields.map(field => [field, values[field]]));
  // Saving the approval choice, even unchanged, records that the owner chose it (readiness item 4).
  const confirm = 'approval_mode' in values ? { approval_mode_confirmed_at: ctx.now } : {};
  if (approvalChanged) patch.approval_generation = current.approval_generation + 1;
  let settings = current;
  if (fields.length) settings = writeSettings(ctx, current, { ...patch, ...confirm }, 'channel_settings');
  else if ('approval_mode' in values) settings = ctx.update(CHANNEL_SETTINGS, current.id, confirm) as unknown as ChannelSettingsRecord;
  // Same transaction as the settings write: no window in which a waiting post lacks a pending request (§4.1).
  const outcome = approvalChanged ? applyApprovalModeChange(ctx, account.id, current.approval_mode, settings.approval_mode as ApprovalMode) : { resubmitted: 0, revoked: 0 };
  if (fields.length) {
    audit(ctx, 'account.channel_settings.updated', { social_account_id: account.id, fields, settings_generation: settings.settings_generation });
    ctx.emit('account.channel_settings.changed', { social_account_id: account.id, generation: settings.settings_generation, approval_mode_changed: approvalChanged, fields });
  }
  return { settings: ctx.get(CHANNEL_SETTINGS, settings.id), requeued_posts: outcome.resubmitted, revoked_posts: outcome.revoked, changed_fields: fields,
    effective_mode: effectiveMode(ctx, account.id) };
}

function ackNotice(ctx: Context, accountId: string, body: Data) {
  const account = channel(ctx, accountId);
  if (Object.keys(body).some(key => key !== 'version')) throw invalid(Object.keys(body).filter(key => key !== 'version').map(path => ({ path, message: '不認得的欄位' })));
  if (body.version !== AUTOMATION_NOTICE_VERSION) {
    throw new Problem(409, 'AUTOMATION_NOTICE_OUTDATED', '自動化告知已更新，請重新閱讀後確認', { current_version: AUTOMATION_NOTICE_VERSION });
  }
  const current = ensureChannelSettings(ctx, account.id);
  if (current.automation_notice_ack?.version === AUTOMATION_NOTICE_VERSION) return { settings: current };
  const settings = writeSettings(ctx, current, { automation_notice_ack: { at: ctx.now, via: 'web', by: ctx.actorId, version: AUTOMATION_NOTICE_VERSION } }, 'automation_notice');
  audit(ctx, 'account.automation_notice.acknowledged', { social_account_id: account.id, via: 'web', version: AUTOMATION_NOTICE_VERSION });
  ctx.emit('account.automation_notice.acked', { social_account_id: account.id });
  return { settings };
}

export const normalizeHandle = (value: string) => value.trim().replace(/^@/, '').toLowerCase();

function ackRisk(ctx: Context, accountId: string, body: Data) {
  const account = channel(ctx, accountId);
  const unknown = Object.keys(body).filter(key => !['terms_version', 'typed_handle'].includes(key));
  if (unknown.length || typeof body.typed_handle !== 'string' || !body.typed_handle.trim() || body.typed_handle.length > 70 || typeof body.terms_version !== 'string') {
    throw invalid([...unknown.map(path => ({ path, message: '不認得的欄位' })),
      ...(typeof body.terms_version !== 'string' ? [{ path: 'terms_version', message: '必填' }] : []),
      ...(typeof body.typed_handle !== 'string' || !body.typed_handle.trim() || body.typed_handle.length > 70 ? [{ path: 'typed_handle', message: '請輸入帳號名稱' }] : [])]);
  }
  if (!(RISK_ACK_PROVIDERS as readonly unknown[]).includes(account.provider)) throw new Problem(422, 'RISK_ACK_NOT_APPLICABLE', '這個平台在第 1 階段不提供代按發布，不需要風險確認');
  if (body.terms_version !== RISK_TERMS_VERSION) throw new Problem(409, 'RISK_TERMS_OUTDATED', '條款已更新，請重新閱讀後確認', { current_version: RISK_TERMS_VERSION });
  if (typeof account.handle !== 'string' || !account.handle) throw new Problem(409, 'HANDLE_UNKNOWN', '請先在帳號頁按「檢查登入」');
  if (normalizeHandle(body.typed_handle) !== account.handle.toLowerCase()) throw new Problem(422, 'HANDLE_MISMATCH', '輸入的帳號名稱和這個帳號不符', { expected_format: '@handle' });
  const current = ensureChannelSettings(ctx, account.id);
  const terms = RISK_TERMS[account.provider as DriverProvider];
  const risk_ack = { at: ctx.now, by_user_id: ctx.actorId, terms_version: RISK_TERMS_VERSION, text_sha256: sha256(terms.zh_hant) };
  const settings = writeSettings(ctx, current, { risk_ack }, 'risk_ack');
  audit(ctx, 'account.channel_risk.acknowledged', { social_account_id: account.id, terms_version: RISK_TERMS_VERSION, text_sha256: risk_ack.text_sha256 });
  ctx.emit('account.channel_settings.changed', { social_account_id: account.id, generation: settings.settings_generation, approval_mode_changed: false, fields: ['risk_ack'] });
  return { settings, effective_mode: effectiveMode(ctx, account.id) };
}

function clearRisk(ctx: Context, accountId: string) {
  const account = channel(ctx, accountId);
  const current = ensureChannelSettings(ctx, account.id);
  if (!current.risk_ack) return { settings: current, effective_mode: effectiveMode(ctx, account.id) };
  const settings = writeSettings(ctx, current, { risk_ack: null }, 'risk_ack_cleared');
  audit(ctx, 'account.channel_risk.cleared', { social_account_id: account.id });
  ctx.emit('account.channel_settings.changed', { social_account_id: account.id, generation: settings.settings_generation, approval_mode_changed: false, fields: ['risk_ack'] });
  return { settings, effective_mode: effectiveMode(ctx, account.id) };
}

/** §5.10 換機器. The job engine moves queued jobs; anything already claimed blocks the move. */
function bindMachine(ctx: Context, accountId: string, body: Data) {
  const account = channel(ctx, accountId);
  const unknown = Object.keys(body).filter(key => !['device_id', 'owned_account_confirmed'].includes(key));
  if (unknown.length || typeof body.device_id !== 'string' || !body.device_id) {
    throw invalid([...unknown.map(path => ({ path, message: '不認得的欄位' })), ...(typeof body.device_id !== 'string' || !body.device_id ? [{ path: 'device_id', message: '必填' }] : [])]);
  }
  if (body.owned_account_confirmed !== true) throw new Problem(422, 'ACCOUNT_OWNERSHIP_REQUIRED', '請確認這是你自己的帳號');
  if (account.status !== 'active') throw new Problem(409, 'CHANNEL_INACTIVE', '這個帳號已停用');
  const device = ctx.get('connector_device', body.device_id);
  if (device.status !== 'active') throw new Problem(409, 'DEVICE_INACTIVE', '這台機器已停用或撤銷');
  if (activeMigration(ctx, account.id)) throw new Problem(409, 'MIGRATION_IN_PROGRESS', '這個帳號正在搬移，請先完成搬移');
  const existing = bindingFor(ctx, account.id);
  const settings = ensureChannelSettings(ctx, account.id);
  const sessions = (binding: Row | undefined) => binding ? ctx.list('browser_session').filter(row => row.binding_id === binding.id && row.status !== 'revoked') : [];
  if (existing && existing.device_id === device.id && existing.mode === 'connector' && existing.connector_channel === 'browser' && sessions(existing).length) {
    return { binding: existing, session: sessions(existing)[0], moved_jobs: 0, check_login_job_id: null, unchanged: true, settings };
  }
  const active = ctx.list('worker_job').filter(job => job.social_account_id === account.id && ACTIVE_JOB_STATUSES.includes(job.status as WorkerJobStatus));
  if (active.length) {
    const postIds = [...new Set(active.map(job => job.publish_target_id).filter((id): id is string => typeof id === 'string'))];
    throw new Problem(409, 'CHANNEL_HAS_ACTIVE_JOBS', `請先取消或等這 ${postIds.length || active.length} 則貼文結束，再換機器`, { post_ids: postIds, job_ids: active.map(job => job.id) });
  }
  if (existing) {
    drainConnectorTasks(ctx, row => row.binding_id === existing.id);
    if (ctx.list('connector_task').some(row => row.binding_id === existing.id && ['claimed', 'outcome_unknown'].includes(String(row.status)))) {
      throw new Problem(409, 'EXECUTION_DRAIN_REQUIRED', '舊的執行工作還沒結束，請稍後再換機器');
    }
  }
  const previousDevice = typeof existing?.device_id === 'string' ? existing.device_id : null;
  const values = { social_account_id: account.id, mode: 'connector', connector_channel: 'browser', device_id: device.id,
    mobile_device_id: null, mobile_app: null, connector_mode: 'assist', paused: false };
  const binding = existing ? ctx.update('account_execution_binding', existing.id, values) : ctx.create('account_execution_binding', values);
  for (const old of sessions(existing)) ctx.update('browser_session', old.id, { status: 'revoked', revoked_at: ctx.now });
  const session = ctx.create('browser_session', { social_account_id: account.id, device_id: device.id, binding_id: binding.id, status: 'pending_identity' });
  const engine = workerEngine();
  const { moved } = engine.moveQueuedChannelJobs(ctx, account.id, device.id);
  const check = engine.createCheckLoginJob(ctx, account.id, { openLoginWindow: true });
  engine.bumpSyncGeneration(ctx, [...new Set([previousDevice, device.id].filter((id): id is string => !!id))], 'binding_changed');
  audit(ctx, 'account.channel.machine_bound', { social_account_id: account.id, device_id: device.id, previous_device_id: previousDevice, moved_jobs: moved });
  ctx.emit('account.binding.changed', { binding_id: binding.id, social_account_id: account.id, device_id: device.id });
  return { binding, session, moved_jobs: moved, check_login_job_id: check.id, unchanged: false, settings };
}

const humanOnly = (name: string, run: (ctx: Context, input: Parameters<Operation['run']>[1]) => unknown): Operation['run'] => (ctx, input) => {
  requireHuman(ctx, name);
  return run(ctx, input);
};
const channelPath = '/hub/channels/:id';
const strict = (properties: Data, required: string[] = []) => ({ type: 'object', additionalProperties: false, required, properties });

export const channelOperations: Operation[] = [
  {
    method: 'PATCH', path: `${channelPath}/settings`, name: 'hub_channels_update_settings', roles: ADMIN,
    summary: 'Update a channel\'s execution mode, approval mode, limits and platform defaults (person only; If-Match required)',
    contract: { bodyRequired: true, body: strict({
      execution_mode: { type: 'string', enum: ['browser_auto', 'browser_assist'] }, approval_mode: { type: 'string', enum: ['direct', 'needs_approval'] },
      daily_cap: { type: 'integer', minimum: 1, maximum: 50 }, lateness_limit_min: { type: 'integer', minimum: LATENESS_MIN, maximum: 240 },
      caption_limit: { type: ['integer', 'null'], minimum: 1, maximum: 25000 }, timezone: { type: 'string' },
      window: { type: ['object', 'null'] }, platform_defaults: { type: 'object' },
    }) },
    run: humanOnly('hub_channels_update_settings', (ctx, input) => updateSettings(ctx, input.params.id!, input.body, input.expectedVersion)),
  },
  {
    method: 'POST', path: `${channelPath}/automation-notice`, name: 'hub_channels_ack_automation_notice', roles: ADMIN,
    summary: 'Record that the owner read the automation notice for this channel (person only)',
    contract: { bodyRequired: true, body: strict({ version: { type: 'string' } }, ['version']) },
    run: humanOnly('hub_channels_ack_automation_notice', (ctx, input) => ackNotice(ctx, input.params.id!, input.body)),
  },
  {
    method: 'POST', path: `${channelPath}/risk-ack`, name: 'hub_channels_ack_risk', roles: ADMIN,
    summary: 'Accept the platform automation risk so the Worker may click Post for this channel (person only)',
    contract: { bodyRequired: true, body: strict({ terms_version: { type: 'string' }, typed_handle: { type: 'string', maxLength: 70 } }, ['terms_version', 'typed_handle']) },
    run: humanOnly('hub_channels_ack_risk', (ctx, input) => ackRisk(ctx, input.params.id!, input.body)),
  },
  {
    method: 'DELETE', path: `${channelPath}/risk-ack`, name: 'hub_channels_clear_risk_ack', roles: ADMIN,
    summary: 'Withdraw the automation risk acceptance; the Worker stops before Post from now on (person only)',
    run: humanOnly('hub_channels_clear_risk_ack', (ctx, input) => clearRisk(ctx, input.params.id!)),
  },
  {
    method: 'PUT', path: `${channelPath}/machine`, name: 'hub_channels_bind_machine', roles: ADMIN,
    summary: 'Choose which paired machine signs in and posts for this channel (person only)',
    contract: { bodyRequired: true, body: strict({ device_id: { type: 'string' }, owned_account_confirmed: { type: 'boolean', const: true } }, ['device_id', 'owned_account_confirmed']) },
    run: humanOnly('hub_channels_bind_machine', (ctx, input) => bindMachine(ctx, input.params.id!, input.body)),
  },
];

