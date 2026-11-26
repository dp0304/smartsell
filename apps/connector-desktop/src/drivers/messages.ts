// zh-Hant owner copy for blockers raised on the Worker (Appendix C.2). The
// Worker fills {machine}, {channel} and {deadline} with what it knows so the
// local OS notification and the hub both get a complete sentence (§8.10).
import type { BlockerCode } from '../runtime/contracts.ts';

export interface MessageContext { machine: string; channel: string; deadline: string; step?: string; platform_message?: string }

const templates: Partial<Record<BlockerCode, string>> = {
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

/**
 * After the Post click the Worker never continues on its own (§5.11): the post may exist, the hub shows it as
 * outcome_unknown, and the owner confirms it. These codes otherwise promise an automatic continuation.
 */
const afterSubmitTemplates: Partial<Record<BlockerCode, string>> = {
  captcha: '{channel} 在按下發布後出現驗證碼，已停止，不會自動重發。這則可能已經發出，也可能沒有：請到 {machine} 的 SmartSell Chrome 視窗完成驗證，再到貼文頁貼上網址或確認沒有發出。',
  two_factor: '{channel} 在按下發布後要求二次驗證，已停止，不會自動重發。這則可能已經發出，也可能沒有：請在 {machine} 完成驗證，再到貼文頁貼上網址或確認沒有發出。',
  login_expired: '{channel} 在按下發布後要求重新登入，已停止，不會自動重發。這則可能已經發出，也可能沒有：請在 {machine} 的 SmartSell Chrome 視窗重新登入，再到貼文頁確認。',
  identity_mismatch: '{machine} 的 Chrome 在按下發布後顯示的不是 {channel}，已停止，不會自動重發。請到貼文頁確認這則有沒有發出。',
  risk_prompt: '{channel} 在按下發布後出現平台風控提示，已停止，不會重試。這則可能已經發出，也可能沒有：請到 {machine} 查看平台訊息，再到貼文頁確認。',
};

/**
 * WA-9: before the Post click a platform error page means nothing was posted, and 「恢復」 (platform_error is an
 * owner-resume blocker) tries again. Only after the click is the post possibly live (afterSubmitTemplates / templates).
 */
const preSubmitTemplates: Partial<Record<BlockerCode, string>> = {
  platform_error: '{channel} 出現錯誤頁面，已停止，這則還沒有發出。請到 {machine} 查看；確定沒問題後可按「恢復」再試一次（截止 {deadline}）。',
};

/** Human names for selector steps used in driver_outdated messages. */
export const stepNames: Record<string, string> = {
  'x.ready': '開啟發文視窗', 'x.identity': '確認帳號', 'x.file_input': '附加媒體', 'x.attached': '附加媒體', 'x.upload_done': '等待媒體處理',
  'x.textbox': '輸入文字', 'x.reply_settings': '設定誰可以回覆', 'x.post_button': '發布按鈕', 'x.discard': '捨棄草稿',
  'tt.ready': '開啟上傳頁', 'tt.identity': '確認帳號', 'tt.file_input': '選擇影片', 'tt.uploaded': '等待上傳完成', 'tt.caption': '輸入說明文字',
  'tt.visibility': '設定誰可以觀看', 'tt.allow_comment': '設定留言', 'tt.allow_reuse': '設定內容再利用', 'tt.disclosure': '揭露貼文內容',
  'tt.ai_label': 'AI 生成標示', 'tt.post_button': '發布按鈕', 'tt.discard': '捨棄草稿',
};

export function blockerMessage(code: BlockerCode, context: MessageContext, phase?: 'prepare' | 'before_submit' | 'after_submit'): string {
  const phased = phase === 'after_submit' ? afterSubmitTemplates[code] : phase === 'prepare' || phase === 'before_submit' ? preSubmitTemplates[code] : undefined;
  // Without a phase the conservative (possibly posted) wording stays.
  const template = phased ?? templates[code] ?? '{machine} 的 {channel} 需要你處理（{code}）。';
  return template
    .replaceAll('{machine}', context.machine)
    .replaceAll('{channel}', context.channel)
    .replaceAll('{deadline}', context.deadline)
    .replaceAll('{step}', context.step ? stepNames[context.step] ?? context.step : '未知')
    .replaceAll('{platform_message}', context.platform_message ?? '平台沒有說明原因')
    .replaceAll('{code}', code);
}

/** Own-Chrome mode (core-automation-proposal §3.2): the owner's Chrome is reached through the SmartSell extension. */
const ownChromeTemplates: Record<'extension_not_connected' | 'extension_ambiguous' | 'extension_cancelled', string> = {
  extension_not_connected: '{machine} 的 Chrome 沒有連上 SmartSell：請在 {machine} 打開 Chrome，確認 SmartSell Worker 擴充功能已安裝並啟用；連上後會自動繼續（截止 {deadline}）。',
  extension_ambiguous: '{machine} 有好幾個 Chrome 設定檔都裝了 SmartSell 擴充功能，不知道 {channel} 要用哪一個。請在 {machine} 的 SmartSell Worker 為 {channel} 選擇 Chrome 設定檔。',
  extension_cancelled: '{machine} 的 Chrome 中斷了 SmartSell 的操作（有人按了頂端偵錯提示的「取消」），{channel} 這則已停止。要繼續請按「恢復」。',
};

export function ownChromeMessage(problem: keyof typeof ownChromeTemplates, context: MessageContext) {
  return ownChromeTemplates[problem].replaceAll('{machine}', context.machine).replaceAll('{channel}', context.channel).replaceAll('{deadline}', context.deadline);
}

export const missedReasonText: Record<string, string> = {
  late: '超過遲到上限', machine_was_off: '機器當時沒有開機或沒有連線', owner_not_clicked: '沒有在時限內按發布', prepare_blocked: '準備時遇到需要處理的問題',
  chrome_unavailable: '無法啟動 Chrome', paused: '已暫停',
};

export function missedMessage(context: MessageContext, reason: string) {
  return `${context.machine} 在 ${context.deadline} 前沒有開始（${missedReasonText[reason] ?? reason}），這則沒有發出。要改到別的時間嗎？`;
}

/** Channel label as used by the hub: 'X @makemylure', 'TikTok @lurelab'. */
export function channelLabel(provider: string, handle: string | null, fallback: string) {
  const name = provider === 'x' ? 'X' : provider === 'tiktok' ? 'TikTok' : provider;
  return `${name} ${handle ? `@${handle}` : fallback}`;
}

/** HH:mm in the job's time zone; falls back to UTC when the zone is unknown. */
export function localTime(iso: string, timeZone: string) {
  const date = new Date(iso);
  try { return new Intl.DateTimeFormat('zh-TW', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
  catch { return new Intl.DateTimeFormat('zh-TW', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false }).format(date); }
}
