import type { BlockerCode, OwnerAlertKind } from '@smartsell/contracts';

/** Owner-facing blocker copy, verbatim from phase1-design Appendix C.2 (zh-Hant). */
export const BLOCKER_COPY: Record<BlockerCode, string> = {
  captcha: '{machine} 的 {channel} 出現驗證碼，已停止。請到 {machine} 的 SmartSell Chrome 視窗完成驗證；完成後會自動繼續（不會重新整理頁面），截止 {deadline}。',
  two_factor: '{machine} 的 {channel} 要求二次驗證。請在 {machine} 完成驗證；完成後會自動繼續（截止 {deadline}）。',
  login_expired: '{machine} 的 {channel} 登入已過期，這則發不出去。請在 {machine} 的 SmartSell Chrome 視窗重新登入，完成後會自動繼續（截止 {deadline}）。',
  identity_mismatch: '{machine} 的 Chrome 登入的不是 {channel}。請在 {machine} 切回正確的帳號；切回後會自動繼續。',
  risk_prompt: '{channel} 出現平台風控提示，已停止且不會重試。請到 {machine} 查看平台訊息；確定沒問題後可按「恢復」再試一次（截止 {deadline}）。',
  owner_click_required: '{machine} 的 {channel} 已準備好，等你在 {machine} 按「發布」（這個帳號沒有開啟代按發布），截止 {deadline}。',
  driver_outdated: '{channel} 的頁面可能改版，驅動在「{step}」這一步找不到元素，這則沒有發出。校準後可按「恢復」再試一次。',
  media_unavailable: '{machine} 拿不到這則的影片（還在上傳或下載失敗）。',
  media_hash_mismatch: '{machine} 下載的影片校驗不符，已停止。',
  upload_rejected: '{channel} 拒絕了這支影片：「{platform_message}」。這則沒有發出。',
  caption_rejected: '{channel} 的文字框沒有接受程式輸入的文案。頁面已填好，請到 {machine} 檢查後自己按發布。',
  confirm_dialog: '{channel} 跳出需要確認的對話框，已停在 {machine} 等你處理；處理後按「恢復」。',
  platform_error: '{channel} 回報錯誤，可能已經發出，也可能沒有。請到貼文頁貼上網址，或確認沒有發出；系統不會自動重發。',
  result_conflict: '{channel} 回報的貼文已經連到另一則排程，無法確定是哪一則。請到貼文頁確認。',
  chrome_unavailable: '{machine} 找不到 Google Chrome，或無法啟動；每 5 分鐘會再試一次。',
  profile_in_use: '{machine} 的 {channel} Chrome 目前被其他程式占用，請關閉後會自動繼續。',
  machine_paused: '{machine} 已暫停，這則不會發出，直到你恢復機器。',
  owner_stopped: '{machine} 按了緊急停止。',
};

/** Status and event copy from Appendix C.2. */
export const STATUS_COPY = {
  missed: '{machine} 在 {deadline} 前沒有開始（{reason}），這則沒有發出。要改到別的時間嗎？',
  missed_paused: '這則沒有發出，因為{scope}在 {paused_at} 被{paused_by}暫停。要改到別的時間嗎？',
  missed_not_approved: '這則沒有在 {deadline} 前核准，所以沒有發出。要改到別的時間嗎？',
  unknown: '{machine} 已點擊發布，但讀不到 {channel} 的貼文網址。請貼上網址，或確認沒有發出；系統不會自動重發。',
  unreported: '{machine} 未回報 {local_time} 的 {channel} 貼文（目前離線）。機器上線後會自動補報。',
  late_fact_after_release: '{machine} 在撤回後仍發出了 {channel} 的舊版本；新版本已自動取消，不會再發。請到貼文頁確認。',
  // AO-7: a Worker settles an unreported (or unknown) post as failed: it stopped before sending, so it can be rescheduled.
  failed_late_report: '{machine} 後來回報：{channel} 的這則貼文沒有發出（{reason}），它在送出前就停止了。要改到別的時間嗎？',
  offline_run_stale_settings: '{machine} 在中樞連不上時照排程發出了 {channel} 的貼文，但它還沒收到你之後改的暫停或發布方式。請到貼文頁確認。',
  // E10 (§3.3): a handle change never changes the identity check, so nothing stops; the owner is only told.
  handle_changed: '{machine} 讀到 {provider} 帳號的名稱從 @{from} 改成了 @{to}。SmartSell 已更新顯示的名稱，排好的貼文照常發出；如果不是你改的，請到帳號頁確認。',
} as const;

/** One short clause per blocker, used in the one-sentence title that push notifications carry. */
export const BLOCKER_SHORT: Record<BlockerCode, string> = {
  captcha: '出現驗證碼，已停止', two_factor: '要求二次驗證', login_expired: '登入已過期，這則發不出去',
  identity_mismatch: 'Chrome 登入的不是這個帳號', risk_prompt: '出現平台風控提示，已停止且不會重試',
  owner_click_required: '已準備好，等你按「發布」', driver_outdated: '頁面可能改版，這則沒有發出',
  media_unavailable: '拿不到這則的影片', media_hash_mismatch: '下載的影片校驗不符，已停止', upload_rejected: '平台拒絕了這支影片',
  caption_rejected: '文字框沒有接受文案，請自己按發布', confirm_dialog: '跳出需要確認的對話框', platform_error: '平台回報錯誤，可能已經發出',
  result_conflict: '回報的貼文對不上排程', chrome_unavailable: '無法啟動 Google Chrome', profile_in_use: 'Chrome 被其他程式占用',
  machine_paused: '機器已暫停', owner_stopped: '按了緊急停止',
};

export const MISSED_REASON: Record<string, string> = {
  late: '超過遲到上限', machine_was_off: '機器當時沒有開機或沒有連線', owner_not_clicked: '沒有人按「發布」',
  prepare_blocked: '準備時被擋下', chrome_unavailable: '無法啟動 Google Chrome', paused: '已暫停', media_unavailable: '影片沒有及時準備好',
  unclaimed: '機器沒有及時領取', machine_off: '機器當時沒有開機或沒有連線', daily_cap_reached: '已達每日上限',
  outside_window: '不在發文時段內', not_approved: '沒有在期限內核准',
};

/** Why a Worker's `failed` report says the post did not go out (AO-7); anything else is the Worker's own failure. */
export const FAILED_REASON: Record<string, string> = {
  upload_rejected: '平台拒絕了這支影片', media_hash_mismatch: '影片校驗不符', caption_rejected: '文字框沒有接受文案',
  driver_outdated: '頁面可能改版', media_unavailable: '拿不到影片', chrome_unavailable: '無法啟動 Google Chrome',
  profile_in_use: 'Chrome 被其他程式占用', default: '機器回報失敗',
};

export const PAUSE_SCOPE: Record<string, string> = { workspace: '工作區', brand: '品牌', social_account: '這個帳號', machine: '這台機器' };

/** Short label per kind for push titles and the settings page. */
export const KIND_LABEL: Record<OwnerAlertKind, string> = {
  worker_blocker: '需要你處理', missed: '沒有發出', unknown: '結果不明', late_fact_after_release: '舊版本已發出',
  approval_due: '等你核准', click_post_soon: '要你按發布', login_check_failed: '登入檢查失敗', upload_done: '上傳完成',
  upload_failed: '上傳失敗', machine_offline_with_jobs: '機器離線', machine_setup: '機器設定', published: '已發出',
  daily_summary: '每日摘要', offline_run_stale_settings: '以舊設定發出', handle_changed: '帳號名稱改了',
};

const FALLBACK: Record<string, string> = {
  machine: '指定的機器', channel: '這個帳號', deadline: '期限', step: '某一步', platform_message: '平台沒有提供說明',
  reason: '原因不明', scope: '帳號', paused_at: '稍早', paused_by: '你', local_time: '預定時間', provider: '平台',
};

/** Substitute `{name}` placeholders; a missing value falls back to a readable phrase instead of a raw placeholder. */
export function fill(template: string, values: Record<string, string | number | undefined | null>): string {
  return template.replace(/\{([a-z_]+)\}/g, (_match, key: string) => {
    const value = values[key];
    return value === undefined || value === null || value === '' ? FALLBACK[key] ?? '' : String(value);
  });
}

/** "Mac-B 的 X @a", "X @a" or "Mac-B". */
export function subject(machine: string | undefined, channel: string | undefined): string {
  if (machine && channel) return `${machine} 的 ${channel}`;
  return channel ?? machine ?? 'SmartSell';
}

/** "X @a（Mac-B）": the account first, for titles about one post. */
export function channelAt(machine: string | undefined, channel: string | undefined): string {
  if (machine && channel) return `${channel}（${machine}）`;
  return channel ?? machine ?? 'SmartSell';
}

/** Join a label and the following words: no space after a full-width bracket, one space otherwise. */
export const lead = (label: string) => (label.endsWith('）') ? label : `${label} `);

/** The first sentence of a text, capped for push (§12.1 risk 13: one sentence, no captions). */
export function firstSentence(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const end = flat.search(/[。！？!?]/);
  const sentence = end >= 0 ? flat.slice(0, end + 1) : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}
