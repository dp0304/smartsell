import type { Context, Data, Row, TimelineEntry } from '@smartsell/contracts';
import { object } from '../../../../../../packages/domain/src/publishing/index.js';
import { jobEvents, localText, str } from './hub-model.js';

/**
 * worker_job_event → owner-readable timeline rows (phase1-design §3.6, §9.5). zh-Hant, local time. The web keeps its own
 * English labels keyed by `event`; the Agent reads `text` as the detail line.
 */

const BLOCKER_SHORT: Record<string, string> = {
  captcha: '出現驗證碼', two_factor: '要求二次驗證', login_expired: '登入已過期', identity_mismatch: 'Chrome 登入的不是這個帳號',
  risk_prompt: '出現平台風控提示', owner_click_required: '等你在機器上按「發布」', driver_outdated: '頁面可能改版，找不到元素',
  media_unavailable: '拿不到影片', media_hash_mismatch: '影片校驗不符', upload_rejected: '平台拒絕了影片', caption_rejected: '文字框沒有接受文案',
  confirm_dialog: '跳出需要確認的對話框', chrome_unavailable: '找不到或無法啟動 Google Chrome', profile_in_use: 'Chrome 被其他程式占用',
  platform_error: '平台回報錯誤', machine_paused: '機器已暫停', owner_stopped: '機器按了緊急停止', result_conflict: '貼文已連到另一則排程',
};
export const blockerShort = (code: unknown) => BLOCKER_SHORT[String(code)] ?? String(code ?? '');

const GO_DENIED: Record<string, string> = {
  fence_lost: '租約已失效', invalid_state: '狀態不允許', too_early: '還沒到時間', too_late: '已超過遲到上限', revoked: '已撤回',
  approval_invalid: '核准已失效', paused: '已暫停', rebound: '帳號已換機器', daily_cap_reached: '已達每日上限', outside_window: '不在發布時段內',
};
const MISSED: Record<string, string> = {
  late: '超過遲到上限', machine_was_off: '機器當時沒開', owner_not_clicked: '沒有人按「發布」', prepare_blocked: '準備時被擋下',
  chrome_unavailable: 'Chrome 無法啟動', paused: '已暫停', unclaimed: '機器沒有領取', media_unavailable: '影片沒有準備好',
  daily_cap_reached: '已達每日上限', outside_window: '不在發布時段內', not_approved: '沒有在期限內核准',
  // E36: a release of a job the hub saw start (rows written before E36); E41: the machine was retired and the account not moved.
  released_unconfirmed: '已強制釋放；它可能已經發出，請先到平台確認再改期', machine_retired: '機器已撤銷，帳號還沒換到別台機器',
};
export const missedText = (reason: unknown) => MISSED[String(reason)] ?? String(reason ?? '');

function text(event: string, detail: Data, machine: string, zone: string): string {
  const blocker = object(detail.blocker);
  const reason = str(detail.reason);
  switch (event) {
    case 'queued': case 'dispatched': return `已排入 ${machine} 的佇列`;
    case 'claimed': return detail.recovery ? `${machine} 重新領取（重新連線後）` : `${machine} 已領取`;
    case 'reassigned': return '帳號換了機器，改由新的機器執行';
    case 'prepared': return detail.stage === 'final' ? `${machine} 已準備好貼文，等待發布時間` : `${machine} 完成預檢：已登入${str(detail.handle) ? ` @${detail.handle}` : ''}`;
    case 'prepare_blocked': return `${detail.stage === 'preflight' ? '預檢' : '準備'}時停下：${blockerShort(blocker.code)}`;
    case 'blocked': return `停下：${blockerShort(blocker.code)}`;
    case 'go': return detail.mode === 'assist' ? '中樞放行，等你在機器上按「發布」' : '中樞放行，開始發布';
    case 'go_denied': return `中樞暫不放行：${GO_DENIED[String(reason)] ?? reason ?? ''}`;
    case 'started': return detail.go === 'offline' ? `${machine} 連不到中樞，依離線規則開始發布` : `${machine} 開始發布`;
    case 'submitting': return '正在按「發布」';
    case 'submitted': return '已按「發布」，等待平台確認';
    case 'readback_pending': return `正在讀回貼文網址（第 ${Number(detail.attempt) || 1} 次）`;
    case 'result': return str(detail.url) ? `已發出：${detail.url}` : '已發出';
    case 'dry_run_done': return '試跑完成：停在「發布」前，沒有發出';
    case 'failed': return `沒有發出：${blockerShort(detail.code) || str(detail.message) || ''}`;
    case 'missed': return `沒有發出：${missedText(reason)}`;
    case 'missed_unclaimed': return `沒有發出：${missedText(reason ?? 'unclaimed')}`;
    case 'missed_machine_off': return `沒有發出：${machine} 在期限前沒有開跑`;
    case 'outcome_unknown': return '已按「發布」，但讀不到貼文網址；系統不會自動重發';
    case 'result_pending_timeout': return '讀回時間已到，結果不明；系統不會自動重發';
    // WV-5: the hub only knows the machine did not report in time, not that it was offline (§5.6); the page says what to do.
    case 'unreported': return `${machine} 沒有在期限內回報結果；結果不明，系統不會自動重發`;
    case 'revoke_requested': return detail.reason === 'cancelled' ? `已要求 ${machine} 放棄這則` : '已要求機器撤回舊版本';
    case 'revoke_pending': return `等 ${machine} 上線後確認撤回`;
    case 'releasing': return `等 ${machine} 確認放棄`;
    case 'released': return `${machine} 已放棄這則`;
    case 'cancelled_unclaimed': return '已取消（機器還沒領取）';
    case 'lease_expired': return '租約到期';
    case 'force_released': return '你確認機器不會發出，已強制釋放';
    // E41 (hub_machines_retire): what happened to this job when the owner retired its machine.
    case 'machine_retired': return detail.outcome === 'requeued' ? `你撤銷了 ${str(detail.machine_name) ?? machine}，這則等待新的機器`
      : detail.outcome === 'unreported' || detail.outcome === 'outcome_unknown' ? `你撤銷了 ${str(detail.machine_name) ?? machine}；它可能已經發出，請到平台確認`
        : `你撤銷了 ${str(detail.machine_name) ?? machine}，這個工作已結束`;
    case 'owner_confirmed': return `你確認已發出：${str(detail.url) ?? ''}`.trim();
    case 'owner_marked_not_published': return '你確認沒有發出';
    case 'owner_resumed': return '你按了「恢復」，機器會重新準備一次';
    case 'successor_released': return '前一個工作確定沒有發出，這個工作放行';
    case 'successor_cancelled_predecessor_posted': return '前一個工作已發出或結果不明，這個工作自動取消，不會再發';
    case 'late_fact_after_release': return `${machine} 在撤回後仍回報已發出；系統已記錄並通知你`;
    case 'fact_conflict': return '回報的貼文已連到另一則排程，請到貼文頁確認';
    case 'handle_changed': return `帳號 handle 從 @${str(detail.from) ?? '?'} 變成 @${str(detail.to) ?? '?'}`;
    case 'offline_run_used_stale_settings': return '離線開跑時使用的是舊的設定（機器還沒收到最新變更）';
    case 'media_ready': return '影片已上傳完成';
    case 'media_unavailable': return '影片還沒準備好';
    case 'requeued': return '重新排入佇列';
    case 'login_state': return `登入狀態：${str(detail.state) ?? ''}`;
    case 'check_login': return '檢查登入';
    default: return event;
  }
}

/** The job's timeline, oldest first, at most `limit` rows (newest kept). */
export function jobTimeline(ctx: Context, job: Row, machine: string, zone: string, limit = 100): TimelineEntry[] {
  const events = jobEvents(ctx, job.id);
  return events.slice(Math.max(0, events.length - limit)).map(row => {
    const detail = object(row.detail);
    const at = String(row.at ?? row.created_at);
    const actor = (['hub', 'device', 'human', 'agent'] as const).find(value => value === row.actor) ?? 'hub';
    return { at, at_local: localText(at, zone) ?? at, event: String(row.event ?? ''), actor, text: text(String(row.event ?? ''), detail, machine, zone), detail };
  });
}
