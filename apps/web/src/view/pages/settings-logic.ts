// Pure rules for the settings page: role gates, request bodies, pause impact and the setup summary.
import type { Tuple } from '@smartsell/ui';

export type Row = Record<string, unknown>;
const str = (value: unknown) => typeof value === 'string' ? value : '';

/** Providers the owned-account registration accepts (account_register_owned_social_account). */
export const platforms = ['meta_instagram', 'meta_facebook', 'tiktok', 'youtube', 'xiaohongshu', 'douyin'] as const;
export type Platform = typeof platforms[number];
export const platformText: Record<string, Tuple> = {
  meta_instagram: ['Instagram', 'Instagram'], meta_facebook: ['Facebook', 'Facebook'], tiktok: ['TikTok', 'TikTok'],
  youtube: ['YouTube', 'YouTube'], xiaohongshu: ['小紅書', 'Xiaohongshu'], douyin: ['抖音', 'Douyin'],
  instagram: ['Instagram', 'Instagram'], facebook: ['Facebook', 'Facebook'],
};

export const roleText: Record<string, Tuple> = {
  owner: ['擁有者', 'Owner'], admin: ['管理員', 'Admin'], manager: ['經理', 'Manager'], editor: ['編輯', 'Editor'],
  reviewer: ['審核者', 'Reviewer'], analyst: ['分析師', 'Analyst'], viewer: ['檢視者', 'Viewer'], agent: ['Agent', 'Agent'],
};

// Mirrors the server role lists: ADMIN registers accounts, WRITE pauses, POLICY_ADMIN releases.
const gates = {
  register: ['owner', 'admin'],
  pause: ['owner', 'admin', 'manager', 'editor'],
  release: ['owner', 'admin', 'manager'],
} as const;
export type Gate = keyof typeof gates;
/** An unknown role is not refused here; the server decides and its answer is shown. */
export function can(gate: Gate, role: string | null | undefined) {
  return !role || (gates[gate] as readonly string[]).includes(role);
}

export interface PauseSwitch {
  id: string; version?: number; scope_type?: string; scope_id?: string; reason?: string | null; mode?: string | null;
  activated_at?: string | null; activated_by?: string | null; released_at?: string | null; released_by?: string | null;
  created_via?: string | null;
}

const at = (value: unknown) => { const time = Date.parse(str(value)); return Number.isFinite(time) ? time : -Infinity; };

/** Active pauses newest first; released ones newest release first. */
export function splitPauses(rows: unknown) {
  const list = Array.isArray(rows) ? rows.filter((row): row is PauseSwitch => !!row && typeof row === 'object' && typeof (row as Row).id === 'string') : [];
  return {
    active: list.filter(row => !row.released_at).sort((a, b) => at(b.activated_at) - at(a.activated_at)),
    released: list.filter(row => row.released_at).sort((a, b) => at(b.released_at) - at(a.released_at)),
  };
}

/** Publications a pause holds and how many of them already passed their planned time. */
export function heldBy(targets: readonly Row[] | undefined, pauseId: string, now = Date.now()) {
  const held = (targets ?? []).filter(row => row.paused_by_switch_id === pauseId && row.plan_status === 'paused');
  const today = new Date(now).toISOString().slice(0, 10);
  const missed = held.filter(row => {
    const scheduled = Date.parse(str(row.scheduled_at));
    if (Number.isFinite(scheduled)) return scheduled < now;
    const local = str(row.local_scheduled_at).slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(local) && local < today;
  });
  return { held: held.length, missed: missed.length };
}

export type PauseScope = 'workspace' | 'brand' | 'social_account';
export interface PauseDraft { scope_type: PauseScope; scope_id: string; reason: string; unschedule: boolean }
/** The POST /pause-switches body, or the fields still missing. */
export function pauseBody(draft: PauseDraft): { body: Row } | { missing: (keyof PauseDraft)[] } {
  const reason = draft.reason.trim();
  const scope = draft.scope_id.trim();
  const missing: (keyof PauseDraft)[] = [];
  if (draft.scope_type !== 'workspace' && !scope) missing.push('scope_id');
  if (!reason) missing.push('reason');
  if (missing.length) return { missing };
  return { body: { scope_type: draft.scope_type, ...(draft.scope_type === 'workspace' ? {} : { scope_id: scope }), reason, mode: draft.unschedule ? 'hold_and_unschedule' : 'hold' } };
}

export interface AccountDraft { brand_id: string; provider: string; display_name: string; external_account_id: string; default_timezone: string; owned: boolean }
/** The POST /social-accounts body (ownership attested by the person), or the fields still missing. */
export function accountBody(draft: AccountDraft): { body: Row } | { missing: (keyof AccountDraft)[] } {
  const values = { brand_id: draft.brand_id.trim(), provider: draft.provider.trim(), display_name: draft.display_name.trim(),
    external_account_id: draft.external_account_id.trim(), default_timezone: draft.default_timezone.trim() };
  const missing: (keyof AccountDraft)[] = (Object.keys(values) as (keyof typeof values)[]).filter(key => !values[key] || values[key].length > 256);
  if (values.provider && !(platforms as readonly string[]).includes(values.provider) && !missing.includes('provider')) missing.push('provider');
  if (!draft.owned) missing.push('owned');
  if (missing.length) return { missing };
  return { body: { ...values, owned_account_confirmed: true } };
}

/** Prefer the brand's default market zone, then any of its markets, then the workspace zone, then the browser. */
export function defaultZone(brandId: string, brands: readonly Row[], markets: readonly Row[], workspaceZone?: string | null, browserZone?: string) {
  const brand = brands.find(row => row.id === brandId);
  const own = markets.filter(row => row.brand_id === brandId && str(row.timezone));
  const preferred = own.find(row => row.id === brand?.default_market_id) ?? own[0];
  if (preferred) return str(preferred.timezone);
  if (workspaceZone && workspaceZone !== 'UTC') return workspaceZone;
  return browserZone || workspaceZone || 'UTC';
}

/** Member resource scopes, with brand scopes named when the brand is known. */
export function scopeNames(scopes: unknown, brandNames: ReadonlyMap<string, string>): string[] {
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((scope): scope is string => typeof scope === 'string' && scope.length > 0).map(scope => {
    const [kind, id] = scope.split(':', 2);
    return kind === 'brand' && id && brandNames.has(id) ? brandNames.get(id)! : scope;
  });
}

export type CheckTone = 'good' | 'warning' | 'critical' | 'neutral';
export interface SetupInput { pauses?: number; brands?: number; markets?: number; accounts?: number; activeAccounts?: number; agent?: string }
/** One tone per setup fact; undefined input means the read has not answered, which is not the same as zero. */
export function setupTones(input: SetupInput): Record<'publishing' | 'brands' | 'accounts' | 'agent', CheckTone> {
  const known = (value: number | undefined): value is number => typeof value === 'number' && Number.isFinite(value);
  return {
    publishing: !known(input.pauses) ? 'neutral' : input.pauses > 0 ? 'critical' : 'good',
    brands: !known(input.brands) ? 'neutral' : input.brands === 0 || (known(input.markets) && input.markets === 0) ? 'warning' : known(input.markets) ? 'good' : 'neutral',
    accounts: !known(input.accounts) ? 'neutral' : known(input.activeAccounts) && input.activeAccounts > 0 ? 'good' : 'warning',
    agent: input.agent === 'active' || input.agent === 'idle' ? 'good' : input.agent === 'none' ? 'warning' : 'neutral',
  };
}

const problems: Record<string, Tuple> = {
  ACCOUNT_ALREADY_REGISTERED: ['這個平台帳號已經登記過了。', 'This platform account is already registered.'],
  ACCOUNT_OWNERSHIP_REQUIRED: ['請先勾選確認這個帳號屬於你的公司。', 'Confirm that your company owns this account first.'],
  INVALID_TIME_ZONE: ['時區無效，請重新選擇。', 'That time zone is not valid; choose another.'],
  BRAND_INACTIVE: ['這個品牌已停用或封存，請選擇其他品牌。', 'This brand is inactive or archived; choose another.'],
  HUMAN_SESSION_REQUIRED: ['這個動作只能由人在瀏覽器裡完成。', 'Only a person signed in to the browser can do this.'],
  HUMAN_REQUIRED: ['這個動作只能由人在瀏覽器裡完成。', 'Only a person signed in to the browser can do this.'],
  VERSION_CONFLICT: ['暫停狀態剛剛有變更，請看過最新狀態再操作。', 'This pause just changed; check the latest state and try again.'],
  INVALID_INPUT: ['有欄位格式不正確，請檢查後再送出。', 'A field is not in the expected format; check and try again.'],
};
/** A plain-language reading of a known API problem; unknown problems fall back to the generic notice. */
export function problemText(status: number | undefined, code: unknown): Tuple | undefined {
  if (typeof code === 'string' && problems[code]) return problems[code];
  if (status === 403) return ['你的角色沒有權限做這件事，請找工作區擁有者或管理員。', 'Your role cannot do this; ask a workspace owner or admin.'];
  if (status === 409 || status === 412) return ['資料剛剛有變更，請看過最新狀態再操作。', 'This just changed; check the latest state and try again.'];
  return undefined;
}
