import type { Label } from '../modules';

// Phase 1 owner copy (phase1-design §9.8 copy.ts, Appendix C.2) as [繁中, English] tuples, read through useText().l.
type Table = Record<string, Label>;

export const postStatusText: Table = {
  draft: ['草稿', 'Draft'], blocked: ['被擋下', 'Blocked'], awaiting_approval: ['待你核准', 'Awaiting approval'], scheduled: ['已排程', 'Scheduled'],
  ready: ['已準備好', 'Ready'], publishing: ['發布中', 'Publishing'], confirming: ['確認結果中', 'Confirming'], published: ['已發布', 'Published'],
  needs_owner: ['要你處理', 'Needs you'], missed: ['沒有發出', 'Missed'], failed: ['沒有發出（失敗）', 'Failed'], unknown: ['結果不明', 'Result unknown'],
  cancelling: ['取消中', 'Cancelling'], cancelled: ['已取消', 'Cancelled'],
  // E37: the owner rejected it; it goes out again only after a change (改到…) or an explicit resubmission.
  rejected: ['已駁回', 'Rejected'],
};
export const postStatusTone: Record<string, 'good' | 'warning' | 'critical' | 'info' | 'neutral'> = {
  draft: 'neutral', blocked: 'warning', awaiting_approval: 'warning', scheduled: 'info', ready: 'info', publishing: 'info', confirming: 'info',
  published: 'good', needs_owner: 'critical', missed: 'critical', failed: 'critical', unknown: 'critical', cancelling: 'neutral', cancelled: 'neutral',
  rejected: 'neutral',
};
export const jobStatusText: Table = {
  queued: ['排隊中', 'Queued'], claimed: ['機器已領取', 'Claimed'], ready: ['已準備好', 'Ready'], running: ['執行中', 'Running'],
  submitting: ['正在按發布', 'Submitting'], result_pending: ['等待結果', 'Waiting for result'], succeeded: ['完成', 'Done'], needs_owner: ['要你處理', 'Needs you'],
  failed: ['失敗', 'Failed'], missed: ['錯過', 'Missed'], outcome_unknown: ['結果不明', 'Result unknown'], unreported: ['未回報', 'Not reported'],
  releasing: ['撤回中', 'Releasing'], cancelled: ['已取消', 'Cancelled'], superseded: ['已被新版本取代', 'Superseded'],
};
export const jobKindText: Table = { publish_post: ['發布', 'Post'], check_login: ['檢查登入', 'Login check'] };
export const blockerText: Table = {
  captcha: ['出現驗證碼', 'Captcha'], two_factor: ['要求二次驗證', 'Two-factor check'], login_expired: ['登入已過期', 'Signed out'],
  identity_mismatch: ['登入的不是這個帳號', 'Wrong account signed in'], risk_prompt: ['平台風控提示', 'Platform risk prompt'],
  owner_click_required: ['等你按「發布」', 'Waiting for you to click Post'], driver_outdated: ['頁面可能改版', 'Page may have changed'],
  media_unavailable: ['拿不到影片', 'Media unavailable'], media_hash_mismatch: ['影片校驗不符', 'Media checksum mismatch'],
  upload_rejected: ['平台拒絕了影片', 'Upload rejected'], caption_rejected: ['文字框沒有接受文案', 'Caption not accepted'],
  confirm_dialog: ['需要確認的對話框', 'Confirmation dialog'], chrome_unavailable: ['Chrome 無法啟動', 'Chrome unavailable'],
  profile_in_use: ['Chrome 被占用', 'Chrome profile in use'], platform_error: ['平台回報錯誤', 'Platform error'], machine_paused: ['機器已暫停', 'Machine paused'],
  owner_stopped: ['緊急停止', 'Emergency stop'], result_conflict: ['結果衝突', 'Result conflict'],
};
export const missedReasonText: Table = {
  not_approved: ['沒有在期限內核准', 'Not approved before the deadline'], late: ['超過遲到上限', 'Past the lateness limit'],
  machine_was_off: ['機器當時沒開', 'The machine was off'], owner_not_clicked: ['沒有人按「發布」', 'Nobody clicked Post'],
  paused: ['已暫停', 'Paused'], media_unavailable: ['影片沒有準備好', 'Media was not ready'], prepare_blocked: ['準備時被擋下', 'Blocked while preparing'],
  chrome_unavailable: ['Chrome 無法啟動', 'Chrome unavailable'], daily_cap_reached: ['已達每日上限', 'Daily cap reached'], outside_window: ['不在發布時段內', 'Outside the posting window'],
  // E36: a force release of a job the hub saw start (rows from before E36); E41: the machine was retired and the account not moved.
  released_unconfirmed: ['已強制釋放；它可能已經發出，請先到平台確認再改期', 'Force-released; it may have gone out — check the platform before rescheduling'],
  machine_retired: ['機器已撤銷，帳號還沒換到別台機器', 'The machine was retired and the account was not moved'],
};
export const loginText: Table = {
  unknown: ['不明（機器離線）', 'Unknown (machine offline)'], checking: ['檢查中', 'Checking'], verified: ['已登入', 'Signed in'],
  login_required: ['要重新登入', 'Sign-in required'], identity_mismatch: ['登入的不是這個帳號', 'Wrong account'], challenge: ['要完成驗證', 'Verification required'],
};
export const modeText: Table = { auto: ['Worker 自動發', 'Worker posts'], assist: ['要你按發布', 'You click Post'], owner: ['手動發布', 'Manual'] };
export const approvalModeText: Table = { direct: ['Codex 說要發就直接發', 'Post what Codex schedules'], needs_approval: ['要我在網頁按核准', 'I approve on the web'] };
export const approvalText: Table = {
  approved_by_channel_policy: ['已依帳號設定自動核准', 'Approved by the channel setting'], approved: ['已核准', 'Approved'],
  awaiting_owner: ['待你核准', 'Waiting for your approval'], not_submitted: ['尚未送審', 'Not submitted'], rejected: ['已駁回', 'Rejected'],
};
export const providerText: Table = { x: ['X', 'X'], tiktok: ['TikTok', 'TikTok'], youtube: ['YouTube', 'YouTube'], meta_instagram: ['Instagram', 'Instagram'], meta_facebook: ['Facebook', 'Facebook'] };
export const warningTitle: Table = {
  sleep_enabled: ['會睡眠', 'Sleeps when idle'], no_auto_login: ['重開機後無法自動登入', 'No automatic login'], app_outdated: ['Worker 版本過舊', 'Worker outdated'],
  clock_skew: ['時鐘偏差', 'Clock skew'], driver_outdated: ['頁面可能改版', 'Driver outdated'], sync_behind: ['還沒收到變更', 'Has not received changes'],
};
export const warningFix: Table = {
  sleep_enabled: ['在那台機器的「系統設定 → 能源」把閒置睡眠設為「永不」，並保持接上電源。', 'On that machine set idle sleep to Never and keep it on power.'],
  no_auto_login: ['開啟自動登入，或接受斷電重開後要有人到場登入（FileVault 開啟時無法自動登入）。', 'Turn on automatic login, or accept that someone signs in after a restart (not possible with FileVault on).'],
  app_outdated: ['在那台機器的 SmartSell Worker 按「更新」。', 'Click Update in SmartSell Worker on that machine.'],
  clock_skew: ['在那台機器開啟「自動設定日期與時間」。', 'Turn on automatic date and time on that machine.'],
  driver_outdated: ['在中樞執行 pnpm hub:update 更新選擇器，再到帳號頁試跑一次。', 'Run pnpm hub:update on the hub, then do a dry run on the channel page.'],
  sync_behind: ['機器上線後會自動收到；如果一直沒收到，請確認它連得到中樞。', 'It arrives when the machine is online; check that it can reach the hub.'],
};
export const alertKindText: Table = {
  worker_blocker: ['需要你處理', 'Needs you'], missed: ['沒有發出', 'Missed'], unknown: ['結果不明', 'Result unknown'], late_fact_after_release: ['撤回後仍發出', 'Posted after release'],
  approval_due: ['等你核准', 'Approval due'], click_post_soon: ['要你按發布', 'Click Post soon'], login_check_failed: ['登入檢查失敗', 'Login check failed'],
  upload_done: ['上傳完成', 'Upload done'], upload_failed: ['上傳失敗', 'Upload failed'], machine_offline_with_jobs: ['機器離線', 'Machine offline'],
  machine_setup: ['機器設定', 'Machine setup'], published: ['已發布', 'Published'], daily_summary: ['每日摘要', 'Daily summary'],
  offline_run_stale_settings: ['離線時用了舊設定', 'Offline run used old settings'], handle_changed: ['帳號名稱改變', 'Handle changed'],
};
export const attentionKindText: Table = {
  job_blocker: ['要你處理', 'Needs you'], approval: ['核准', 'Approval'], click_post: ['按發布', 'Click Post'], login: ['登入', 'Sign-in'],
  machine_offline: ['機器離線', 'Machine offline'], machine_setup: ['機器設定', 'Machine setup'], missed: ['沒有發出', 'Missed'], unknown: ['結果不明', 'Result unknown'],
  driver_outdated: ['頁面改版', 'Page changed'], dry_run_fallback: ['試跑', 'Dry run'], channel_setup: ['帳號設定', 'Channel setup'],
  publishing_paused: ['已暫停', 'Paused'],
};
/** English timeline labels; zh-Hant uses the hub's sentence (TimelineEntry.text). */
export const eventTextEn: Record<string, string> = {
  queued: 'Queued on the machine', dispatched: 'Queued on the machine', claimed: 'Machine claimed it', reassigned: 'Moved to another machine',
  prepared: 'Prepared', prepare_blocked: 'Stopped while preparing', blocked: 'Stopped', go: 'Hub gave the go', go_denied: 'Hub held it back',
  started: 'Started posting', submitting: 'Clicking Post', submitted: 'Clicked Post', readback_pending: 'Reading back the post URL', result: 'Posted',
  dry_run_done: 'Dry run finished (not posted)', failed: 'Not posted', missed: 'Missed', missed_unclaimed: 'Missed (not claimed)', missed_machine_off: 'Missed (machine off)',
  outcome_unknown: 'Clicked Post, URL unknown', result_pending_timeout: 'Result unknown', unreported: 'Machine did not report', revoke_requested: 'Asked the machine to drop it',
  revoke_pending: 'Revoke waits for the machine', releasing: 'Waiting for the machine to drop it', released: 'Machine dropped it', force_released: 'You force-released it',
  owner_confirmed: 'You confirmed it was posted', owner_marked_not_published: 'You confirmed it was not posted', owner_resumed: 'You resumed it',
  successor_released: 'Released after the previous job', successor_cancelled_predecessor_posted: 'Cancelled: the previous job may have posted',
  late_fact_after_release: 'Posted after it was released', fact_conflict: 'Result linked to another post', handle_changed: 'Handle changed',
  offline_run_used_stale_settings: 'Offline run used old settings', media_ready: 'Media ready', media_unavailable: 'Media not ready', requeued: 'Requeued',
  login_state: 'Login state', cancelled_unclaimed: 'Cancelled before it was claimed', lease_expired: 'Lease expired',
  machine_retired: 'You retired the machine',
};

/**
 * WV-11: owner copy (zh-Hant first, Appendix C) for the error codes the dashboard's own actions can meet. The hub's `message`
 * is written for the Agent (English); `details.owner_message`, when the hub sends one, wins over this table.
 */
export const ownerErrorText: Table = {
  TIME_IN_PAST: ['這個時間已經過了，請選一個之後的時間。', 'That time has passed; pick a later time.'],
  TIME_NONEXISTENT: ['這個時間因為日光節約時間而不存在，請選另一個時間。', 'That time does not exist because of daylight saving time; pick another one.'],
  TIME_AMBIGUOUS: ['這個時間因為日光節約時間會出現兩次，請選另一個時間。', 'That time occurs twice because of daylight saving time; pick another one.'],
  TIMEZONE_INVALID: ['時區不正確，請選一個時區。', 'The time zone is not valid; pick one.'],
  POST_FINAL: ['這則已經發出或已取消，不能再改。要再發一次，請在 Codex 重新排程。', 'This post was already published or cancelled. To post it again, schedule it again in Codex.'],
  POST_LOCKED: ['正在發布中，無法修改；請等結果。', 'Publishing is in progress; wait for the result.'],
  POST_RESULT_UNKNOWN: ['結果不明，請先在這一頁確認已發或未發。', 'The result is unknown; confirm on this page whether it was posted first.'],
  POST_NOT_FOUND: ['找不到這則貼文。', 'This post was not found.'],
  INVALID_STATE: ['這則的狀態已經變了，這個動作現在不能做。頁面已重新整理，請看最新狀態再操作。', 'The post changed and this action is no longer possible. The page has refreshed; check its latest state.'],
  JOB_INVALID_STATE: ['這個工作的狀態已經變了。頁面已重新整理，請看最新狀態再操作。', 'The job changed. The page has refreshed; check its latest state.'],
  APPROVAL_STALE: ['這則在你核准前被改過（文字、媒體或帳號設定）。頁面已重新整理，請確認最新內容後再核准。', 'The post changed before you approved it (caption, media or channel settings). Check the latest version and approve again.'],
  LEASE_HELD: ['上一次發布嘗試還沒結束，請先處理它再核准。', 'The previous attempt has not ended; settle it before approving.'],
  DUPLICATE_DECISION: ['你已經決定過這一步了。', 'You already decided this step.'],
  RETRY_NOT_ALLOWED: ['只有在準備時被擋下、還沒開始發布的貼文可以立刻重試；沒有發出的貼文請用「改到…」。', 'Retry is only for a post blocked before it started; use Reschedule for a missed post.'],
  RESUME_NOT_ALLOWED: ['只有停下來等你看過的問題（風控提示、平台錯誤、頁面改版、文字被拒、確認對話框）可以按「恢復」，而且要在截止前；之後請用「改到…」。',
    'Resume is only for a blocker you review (risk prompt, platform error, page change, caption rejected, confirm dialog), before the deadline; after it, use Reschedule.'],
  POSSIBLY_SENT: ['這則可能已經發出，不能強制釋放。請先到平台確認：有就按「貼上網址」，沒有就按「確認沒發出」。', 'This post may already be live, so it cannot be force-released. Check the platform: paste its URL, or confirm it was not posted.'],
  CONFIRM_TEXT_MISMATCH: ['請輸入：{expected}', 'Type: {expected}'],
  HUMAN_REQUIRED: ['這個動作只能由你在網頁上做。', 'Only you can do this, on the web.'],
  VERSION_CONFLICT: ['設定已被更新，請重新整理後再改。', 'The settings changed; refresh and try again.'],
  HANDLE_MISMATCH: ['輸入的帳號名稱和這個帳號不符。', 'The handle you typed does not match this account.'],
  HANDLE_UNKNOWN: ['還不知道這個帳號的名稱，請先按「檢查登入」。', 'The handle is not known yet; click "Check login" first.'],
  RISK_TERMS_OUTDATED: ['條款已更新，請重新閱讀後確認。', 'The terms changed; read them again and confirm.'],
  AUTOMATION_NOTICE_OUTDATED: ['自動化告知已更新，請重新閱讀後確認。', 'The automation notice changed; read it again and confirm.'],
  ACCOUNT_OWNERSHIP_REQUIRED: ['請確認這是你自己的帳號。', 'Confirm that this is your own account.'],
  DRY_RUN_IN_PROGRESS: ['這個帳號已有一個試跑在進行中。', 'A dry run is already in progress for this channel.'],
  MACHINE_BINDING_REQUIRED: ['這個帳號還沒有綁定機器，請先在帳號頁選擇機器。', 'This channel has no machine yet; pick one on the channel page first.'],
  DRIVER_UNAVAILABLE: ['這個平台第 1 階段還沒有 Worker，無法試跑。', 'This platform has no Worker yet; a dry run is not possible.'],
  MACHINE_NOT_FOUND: ['找不到這台機器（可能已撤銷）。', 'This machine was not found (it may have been retired).'],
  INVALID_ARGUMENTS: ['有欄位不正確，請檢查後再送出。', 'Some fields are not valid; check them and send again.'],
};

/**
 * Owner copy for 「重新登入」 (E21, §8.16 step 7) on the channel page header and Today's login card; which sentence is shown
 * depends on the hub's answer (reloginMessage in pages/ChannelPage.tsx). The window is the channel's own Chrome profile on
 * its machine; the owner signs in there, never on the web.
 */
export const RELOGIN = {
  button: ['重新登入', 'Sign in again'],
  hint: ['按「重新登入」，{machine} 會把這個帳號的 SmartSell Chrome 登入視窗帶到前景，請到 {machine} 上登入。',
    "Sign in again brings this channel's SmartSell Chrome sign-in window to the front on {machine}; sign in there."],
  opened: ['已請 {machine} 開啟 {channel} 的登入視窗。請到 {machine} 上的 SmartSell Chrome 視窗登入（驗證碼、二次驗證也在那裡完成），10 分鐘內登入，這裡會自動更新。如果這個帳號其實還在登入狀態，只會更新登入狀態，不會開視窗。',
    'Asked {machine} to open the sign-in window for {channel}. Sign in in the SmartSell Chrome window on {machine} (captchas and two-factor checks happen there too); sign in within 10 minutes and this page updates. If the channel is still signed in, only its login state is updated and no window opens.'],
  offline: ['{machine} 目前離線，{channel} 的登入視窗要等它上線才會開啟；10 分鐘內沒上線就不會開，請等它上線後再按一次「重新登入」。',
    '{machine} is offline: the sign-in window for {channel} opens only when it is back. If it is not back within 10 minutes nothing opens; click Sign in again once it is online.'],
  busy: ['{machine} 正在檢查 {channel} 的登入，這次不會開啟登入視窗；等這次檢查結束後再按一次「重新登入」。',
    '{machine} is already checking the login of {channel}, so no sign-in window opens this time. Click Sign in again when that check has finished.'],
  done: ['{channel} 的登入狀態已更新。', 'The login state of {channel} is up to date.'],
} as const satisfies Table;

export const hub = {
  nav: {
    today: ['今日', 'Today'], calendar: ['日曆', 'Calendar'], machines: ['機器', 'Machines'], channels: ['帳號', 'Channels'], agent: ['Agent', 'Agent'],
    settings: ['設定', 'Settings'], setup: ['開始設定', 'Get started'], more: ['其他模組', 'More modules'], notifications: ['通知', 'Notifications'],
  },
  common: {
    open: ['開啟', 'Open'], openPost: ['開啟貼文', 'Open post'], machine: ['機器', 'Machine'], channel: ['帳號', 'Channel'], post: ['貼文', 'Post'],
    status: ['狀態', 'Status'], time: ['時間', 'Time'], none: ['沒有', 'None'], online: ['在線', 'Online'], offline: ['離線', 'Offline'], paused: ['已暫停', 'Paused'],
    lastSeen: ['最後上線', 'Last seen'], cancel: ['取消', 'Cancel'], close: ['關閉', 'Close'], save: ['儲存', 'Save'], saving: ['儲存中…', 'Saving…'],
    sending: ['送出中…', 'Sending…'], done: ['完成', 'Done'], noCaption: ['不帶文字', 'No caption'], manual: ['手動', 'Manual'], back: ['返回', 'Back'],
    viewAll: ['查看全部', 'View all'], platformPost: ['平台上的貼文', 'Post on the platform'], unknownMachine: ['機器', 'machine'], refresh: ['重新整理', 'Refresh'],
    yes: ['是', 'Yes'], no: ['否', 'No'], never: ['從未', 'Never'],
  },
  today: {
    title: ['今日', 'Today'], subtitle: ['要你處理的事、接下來 48 小時的貼文、機器狀態與剛發出的貼文。', 'What needs you, the next 48 hours, machines and what just went out.'],
    attention: ['要你處理', 'Needs you'], nothing: ['目前沒有要你處理的事。', 'Nothing needs you right now.'],
    upcoming: ['接下來 48 小時', 'Next 48 hours'], noUpcoming: ['接下來 48 小時沒有排程。在 Codex 說「明天 9:00 發到 X」就會出現在這裡。', 'Nothing in the next 48 hours. Tell Codex "post this to X tomorrow at 9:00" and it shows up here.'],
    justScheduled: ['剛由 Codex 排程', 'Just scheduled by Codex'], machines: ['機器', 'Machines'], noMachines: ['還沒有配對任何機器。', 'No machines paired yet.'],
    pair: ['配對機器', 'Pair a machine'], recent: ['最近發出（24 小時內）', 'Published in the last 24 hours'], noRecent: ['24 小時內沒有發出的貼文。', 'Nothing published in the last 24 hours.'],
    nextJob: ['下一則', 'Next'], channels: ['個帳號', 'channels'], warnings: ['項警告', 'warnings'], counts: ['今日', 'Today'],
    timesIn: ['時間以 {zone} 顯示', 'Times in {zone}'],
    scheduled: ['已排程', 'Scheduled'], published: ['已發布', 'Published'], needsOwner: ['要你處理', 'Needs you'], missed: ['沒有發出', 'Missed'], unknown: ['結果不明', 'Unknown'],
    autoResume: ['處理好後會自動繼續', 'Continues by itself once fixed'], deadline: ['期限', 'Deadline'],
    // U4: the setup reminders that never stop scheduling are folded into one entry under the cards that need the owner.
    reminders: ['設定提醒（{n} 項，不影響排程）', 'Setup reminders ({n}, scheduling not affected)'],
    needsOwnerHint: ['「要你處理」底下的卡片數，不含設定提醒', 'Cards under “Needs you”, not counting setup reminders'],
  },
  machines: {
    title: ['機器', 'Machines'], subtitle: ['每台會發文的機器：在線狀態、帳號、佇列與需要調整的設定。', 'Every machine that posts: online state, channels, queue and settings to fix.'],
    pair: ['配對新機器', 'Pair a new machine'], empty: ['還沒有配對任何機器。在要發文的機器上安裝 SmartSell Worker 並貼上中樞位址。', 'No machines yet. Install SmartSell Worker on the machine that will post and paste the hub address.'],
    version: ['Worker 版本', 'Worker version'], outdated: ['有新版', 'update available'], os: ['作業系統', 'OS'], drivers: ['驅動', 'Drivers'],
    queue: ['佇列', 'Queue'], queued: ['排隊', 'queued'], ready: ['準備好', 'ready'], running: ['執行中', 'running'], needsOwner: ['要你處理', 'need you'],
    noWarnings: ['設定沒有問題。', 'No setting issues.'], settings: ['設定與警告', 'Settings and warnings'], channels: ['這台機器上的帳號', 'Channels on this machine'],
    noChannels: ['這台機器還沒有帳號。在這台機器的 SmartSell Worker 按「新增帳號」。', 'No channels yet. Click "Add account" in SmartSell Worker on this machine.'],
    upcoming: ['佇列', 'Queue'], noUpcoming: ['佇列是空的。', 'The queue is empty.'], history: ['最近的工作', 'Recent jobs'], noHistory: ['還沒有工作紀錄。', 'No jobs yet.'],
    driver: ['驅動與選擇器', 'Drivers and selectors'], selectors: ['選擇器資料版本', 'Selector data version'], lastTrace: ['最近一次試跑步驟', 'Last dry-run steps'],
    clock: ['時鐘偏差', 'Clock offset'], paired: ['配對時間', 'Paired'], remote: ['開啟遠端畫面', 'Open remote screen'],
    rename: ['改名', 'Rename'], renameHint: ['Codex 用這個名字找機器，例如 Mac-B。', 'Codex finds machines by this name, e.g. Mac-B.'],
    pause: ['暫停這台機器', 'Pause this machine'], resume: ['恢復這台機器', 'Resume this machine'],
    pauseReason: ['暫停原因', 'Reason'], pauseHint: ['暫停後，這台機器上的所有帳號都不會發文，直到你恢復。', 'While paused, no channel on this machine posts until you resume it.'],
    checkLogin: ['檢查登入', 'Check login'], profile: ['Chrome profile', 'Chrome profile'],
    // E41: hub_machines_retire, person only. The copy says what happens to the jobs and channels, as the hub does it.
    retire: ['撤銷這台機器', 'Retire this machine'],
    retireHint: ['撤銷後，{machine} 不能再連到中樞（要再用就得重新配對），也不會再發任何貼文。還沒開始的貼文會留在中樞，等你把帳號「換機器」到另一台；如果到期前沒有換，就會顯示「沒有發出」。已經開始或已按「發布」的貼文不會重發，要你到平台確認。這台機器上的帳號都要換到別台機器。這個動作不能復原。',
      'After retiring, {machine} can no longer reach the hub (it must pair again to be used) and posts nothing more. Posts that have not started stay on the hub until you move their channel to another machine; if you do not before their deadline they show as missed. Posts that started or clicked Post are never sent again: you check them on the platform. Every channel on this machine must move to another machine. This cannot be undone.'],
    retireType: ['輸入機器名稱 {machine} 確認', 'Type the machine name {machine} to confirm'],
    retireConfirm: ['撤銷', 'Retire'],
    retired: ['已撤銷 {machine}。', '{machine} was retired.'],
    retiredWaiting: ['{n} 則還沒開始的貼文等待新的機器：把帳號「換機器」後就會由新機器發出。', '{n} posts that had not started wait for a new machine: move their channel and the new machine posts them.'],
    retiredConfirm: ['這些貼文可能已經發出，請到平台確認：', 'These posts may have gone out; check them on the platform:'],
    retiredChannels: ['這些帳號要換到別台機器：', 'Move these channels to another machine:'],
  },
  channels: {
    title: ['帳號', 'Channels'], subtitle: ['每個發文帳號：綁在哪台機器、登入狀態、怎麼發、是否需要核准，以及還差哪些設定。', 'Every posting account: machine, login, how it posts, approval and what is left to set up.'],
    empty: ['還沒有帳號。帳號要在那台機器的 SmartSell Worker 新增：開啟 Worker → 新增帳號 → 選平台 → 在跳出的 Chrome 視窗登入 → 確認加入。', 'No channels yet. Add them in SmartSell Worker on the machine that posts: Add account → pick the platform → sign in in the Chrome window → confirm.'],
    allProviders: ['全部平台', 'All platforms'], allMachines: ['全部機器', 'All machines'], filterProvider: ['平台', 'Platform'], filterMachine: ['機器', 'Machine'],
    login: ['登入', 'Login'], mode: ['怎麼發', 'Posting'], approval: ['核准', 'Approval'], today: ['今日已排／上限', 'Today / cap'], next: ['下一則', 'Next'],
    readiness: ['就緒', 'Ready'], noMachine: ['還沒綁機器', 'No machine'],
    checklist: ['就緒清單', 'Readiness checklist'],
    logged_in: ['已登入', 'Signed in'], automation_notice: ['已確認自動化告知', 'Automation notice acknowledged'], defaults_ready: ['TikTok 預設選項已設定', 'TikTok defaults set'],
    approval_mode_chosen: ['已選擇核准方式', 'Approval mode chosen'], risk_ack_or_assist: ['已確認代按發布的風險，或選了「我自己按發布」', 'Risk accepted, or "I click Post myself"'],
    dry_run_passed: ['試跑通過', 'Dry run passed'],
    checkLogin: ['檢查登入', 'Check login'],
    bind: ['換機器', 'Change machine'], bindTitle: ['換到另一台機器', 'Move to another machine'],
    bindHint: ['換機器後，要在新機器的 SmartSell Worker 用這個帳號登入一次。排隊中的貼文會一起移過去。', 'After moving, sign in to this account once in SmartSell Worker on the new machine. Queued posts move with it.'],
    bindActive: ['這個帳號還有進行中的貼文，請先取消或等它們結束：', 'This channel still has posts in progress. Cancel them or wait for them to finish:'],
    ownedConfirm: ['我確認這是我自己的帳號', 'I confirm this is my own account'],
    notice: ['自動化告知', 'Automation notice'], noticeAck: ['我了解', 'I understand'], noticeDone: ['已確認：', 'Acknowledged: '],
    publishing: ['發布方式', 'How it posts'], executionAuto: ['Worker 代發', 'The Worker posts'], executionAssist: ['Worker 準備好、我自己按', 'The Worker prepares, I click Post'],
    approvalHint: ['沒在期限內核准的貼文不會發出，系統會事先提醒。', 'Posts not approved before the deadline do not go out; you get reminders first.'],
    risk: ['代按發布', 'Clicking Post for you'], riskNone: ['尚未同意：到點會停在發布前，等你在機器上按「發布」。', 'Not accepted: at the time it stops before Post and waits for you on the machine.'],
    riskAccepted: ['已同意（{at}）', 'Accepted ({at})'], riskOutdated: ['條款已更新，請重新確認。', 'The terms changed; please confirm again.'],
    riskAccept: ['同意並允許代按發布', 'Accept and allow clicking Post'], riskWithdraw: ['撤回同意', 'Withdraw'],
    riskCheck: ['我了解並接受上述風險，允許 Worker 在這個帳號代按發布', 'I understand and accept the risk above and allow the Worker to click Post for this account'],
    riskType: ['輸入帳號名稱 {handle} 確認', 'Type the handle {handle} to confirm'], riskNeedsHandle: ['還不知道這個帳號的名稱，請先按「檢查登入」。', 'The handle is not known yet; click "Check login" first.'],
    riskWithdrawHint: ['撤回後，從下一則開始會停在發布前，等你按。', 'After withdrawing, posts stop before Post and wait for you.'],
    pause: ['暫停', 'Pause'], pausedBy: ['{scope}在 {at} 被{by}暫停：{reason}', '{scope} paused {at} by {by}: {reason}'], resumeLink: ['到設定頁恢復', 'Resume in settings'],
    resumeMachine: ['到機器頁恢復', 'Resume on the machine page'], scope_campaign: ['活動', 'The campaign'], scope_machine: ['這台機器', 'The machine'],
    by_unknown: ['有人', 'someone'],
    pauseThis: ['暫停這個帳號', 'Pause this channel'], notPaused: ['沒有暫停。', 'Not paused.'],
    scope_workspace: ['整個工作區', 'The workspace'], scope_brand: ['品牌', 'The brand'], scope_social_account: ['這個帳號', 'This channel'],
    by_agent: ['Agent', 'the Agent'], by_person: ['人工', 'a person'],
    limits: ['限制', 'Limits'], dailyCap: ['每日上限', 'Daily cap'], window: ['發布時段', 'Posting window'], windowAny: ['不限時段', 'Any time'],
    windowFrom: ['開始', 'From'], windowTo: ['結束', 'To'], days: ['星期', 'Days'], lateness: ['遲到上限（分鐘）', 'Lateness limit (minutes)'],
    latenessHint: ['機器離線或晚到超過這個時間就不補發。最少 2 分鐘（網路延遲與時鐘誤差）。', 'Past this delay the post is not sent late. At least 2 minutes (network delay and clock drift).'],
    // E42: the channel's own time zone, read by its posting window and daily cap.
    timezone: ['時區', 'Time zone'], timezoneHint: ['發布時段與每日上限都用這個時區計算。', 'The posting window and the daily cap use this time zone.'],
    captionLimit: ['文字上限', 'Caption limit'], captionDefault: ['平台預設', 'Platform default'], xPremium: ['X Premium（25,000 字）', 'X Premium (25,000)'],
    defaults: ['平台預設', 'Platform defaults'], privacy: ['誰可以看', 'Who can view'], allowComment: ['允許留言', 'Allow comments'],
    allowReuse: ['允許內容再利用（合拍與拼接）', 'Allow reuse of content (Duet and Stitch)'], commercial: ['商業內容揭露', 'Commercial content disclosure'],
    aiGenerated: ['標示為 AI 生成', 'Label as AI-generated'], replySettings: ['誰可以回覆', 'Who can reply'],
    dryRun: ['試跑', 'Dry run'], dryRunHint: ['Worker 走到「發布」前就停下並捨棄草稿，不會發出。預設使用內建測試影片。', 'The Worker stops before Post and discards the draft. Nothing is posted. Uses the built-in test clip by default.'],
    dryRunMedia: ['媒體', 'Media'], dryRunBuiltIn: ['內建測試影片', 'Built-in test clip'], dryRunStart: ['試跑一次', 'Run a dry run'],
    dryRunStarted: ['已送到 {machine}，結果會出現在下方。', 'Sent to {machine}; the result appears below.'], dryRuns: ['試跑紀錄', 'Dry runs'], checks: ['登入檢查紀錄', 'Login checks'],
    posts: ['貼文', 'Posts'], noPosts: ['最近沒有貼文。', 'No recent posts.'],
    saved: ['已更新，{n} 則排程中的貼文已重新確認。', 'Saved. {n} scheduled posts were rechecked.'], savedOffline: ['{machine} 目前離線，上線後才會收到。', '{machine} is offline and gets the change when it is back.'],
    conflict: ['設定已在別處被修改，請重新整理後再存。', 'The settings changed elsewhere; refresh and save again.'],
    checkStarted: ['已請 {machine} 檢查登入。', 'Asked {machine} to check the login.'],
  },
  post: {
    title: ['貼文', 'Post'], content: ['內容', 'Content'], media: ['媒體', 'Media'], route: ['帳號與機器', 'Channel and machine'], approval: ['核准', 'Approval'],
    task: ['任務', 'Task'], result: ['結果', 'Result'], actions: ['動作', 'Actions'], timeline: ['時間線', 'Timeline'], noTimeline: ['還沒有任何事件。', 'No events yet.'],
    latest: ['最晚', 'Latest'], calendar: ['在日曆中查看', 'Show in calendar'], openFull: ['開啟完整頁面', 'Open the full page'],
    created: ['建立', 'Created'], createdByAgent: ['由 Agent 建立', 'Created by the Agent'], createdByHuman: ['由人工建立', 'Created by a person'],
    externalId: ['外部 ID', 'External ID'], publishedAt: ['發出時間', 'Published at'], lateBy: ['遲到 {n} 秒', '{n} s late'], verification_system_verified: ['系統讀回確認', 'Read back by the system'],
    verification_manual_confirmed: ['你手動確認', 'Confirmed by you'], evidence: ['截圖', 'Screenshots'], uploading: ['上傳中 {pct}%', 'Uploading {pct}%'],
    deadline: ['期限 {at}', 'deadline {at}'], approveBy: ['請在 {at} 前核准，之後這則不會發出。', 'Approve before {at}; after that it will not go out.'],
    approvedBy: ['已核准（{at}）', 'Approved ({at})'], clickWindow: ['{from}–{until} 要你在 {machine} 按「發布」', '{from}–{until} you click Post on {machine}'],
    attempts: ['執行次數', 'Attempts'], goSource: ['放行來源', 'Go from'], goHub: ['中樞', 'Hub'], goOffline: ['離線規則', 'Offline rule'],
    noActions: ['這則貼文目前沒有需要你做的事。', 'Nothing to do for this post right now.'], previewing: ['載入預覽…', 'Loading preview…'],
    noMedia: ['沒有媒體', 'No media'], shaShort: ['SHA-256', 'SHA-256'],
    // E35: a post an active pause holds.
    paused: ['已暫停：恢復前不會發出', 'Paused: it does not go out until resumed'],
    rejected: ['你駁回了這則，它不會發出。要發的話，按「改到…」選時間就會重新送審。', 'You rejected this post; it does not go out. To post it, pick a time with Reschedule and it is submitted again.'],
  },
  action: {
    approve: ['核准', 'Approve'], reject: ['駁回', 'Reject'], cancel: ['取消這則', 'Cancel this post'], reschedule: ['改到…', 'Reschedule…'], retry: ['立刻重試', 'Retry now'],
    resume: ['恢復', 'Resume'], confirm_result: ['貼上網址（確認已發出）', 'Paste URL (it was posted)'], mark_not_published: ['確認沒發出', 'It was not posted'],
    force_release: ['強制釋放', 'Force release'],
    cancelHint: ['取消後這則不會發出。機器已領取的，會先顯示「取消中」，機器確認後才算取消。', 'Cancelled posts do not go out. If a machine already claimed it, it shows "Cancelling" until the machine confirms.'],
    rescheduleHint: ['選新的時間（{zone}）。需要核准的帳號會重新送審。', 'Pick a new time ({zone}). Channels that need approval are resubmitted.'],
    retryHint: ['這則在準備時被擋下、還沒開始發。處理好問題後，按這裡立刻重新準備一次。', 'It was blocked while preparing and never started. Once fixed, this prepares it again right away.'],
    resumeHint: ['看過平台訊息、確定沒問題後再按。機器會在期限內重新準備一次，不會自動重試別的東西。', 'Press it after you checked the platform message. The machine prepares once more before the deadline.'],
    confirmHint: ['貼上這則在平台上的網址。系統會把它標為已發出，不會再發。', 'Paste the post URL on the platform. It is marked as posted and will not be sent again.'],
    markHint: ['確認平台上沒有這則貼文。之後可以改期再發；如果其實已經發出，改期會造成重複貼文。', 'Confirm the post is not on the platform. You can then reschedule; if it was in fact posted, a reschedule makes a duplicate.'],
    markCheck: ['我確認平台上沒有這則貼文', 'I confirm this post is not on the platform'],
    // E36: offered only for a job the hub never saw start (no go, started or submitting); a possibly-sent one is refused.
    forceHint: ['只有在 {machine} 確定已關機或斷網時才這樣做。中樞沒有收到它開始發布的紀錄；強制釋放後，{machine} 上線也不會再發這則。如果它其實還開著並且發出了，會造成重複貼文；系統仍會記錄並通知你。',
      'Only do this if {machine} is surely off or offline. The hub has no record that it started posting; after the release {machine} will not post it when it is back. If it is in fact running and posts, you get a duplicate; it is still recorded and you are told.'],
    forceType: ['輸入下面這句話確認：', 'Type this sentence to confirm:'], forceText: ['我確認 {machine} 已關機或已斷網，不會發出這則貼文。', '我確認 {machine} 已關機或已斷網，不會發出這則貼文。'],
    url: ['貼文網址', 'Post URL'], newTime: ['新的時間', 'New time'], reason: ['原因（選填）', 'Reason (optional)'], confirm: ['確認', 'Confirm'],
    done: ['已送出。', 'Sent.'], humanOnly: ['這些動作只能由你在網頁上做，Agent 不能代做。', 'Only you can do these on the web; the Agent cannot.'],
    // WV-3: an approval the hub answered 200 without recording it.
    approveBlocked: ['沒有核准：{reasons}', 'Not approved: {reasons}'], approveBlockedNone: ['沒有核准：預檢擋下了這則，請看貼文頁的項目。', 'Not approved: the precheck blocked this post; see the post page.'],
    approveExpired: ['核准期限已過，這則不會發出；可以改期重新送審。', 'The approval deadline has passed; this post will not go out. Reschedule it to submit it again.'],
    notApprovable: ['這則目前沒有可以核准的請求（期限已過或已處理），不會發出；改期即可重新送審。', 'There is no request to approve any more (deadline passed or already decided); it will not go out. Reschedule it to submit it again.'],
  },
  alerts: {
    bell: ['通知', 'Notifications'], unread: ['{n} 則未讀', '{n} unread'], empty: ['沒有通知。', 'No notifications.'], markAll: ['全部標為已讀', 'Mark all read'],
    markRead: ['標為已讀', 'Mark read'], all: ['查看全部通知', 'All notifications'], title: ['通知', 'Notifications'],
    subtitle: ['機器、帳號與貼文要你知道的事；同樣的通知也會送到筆電的 SmartSell App 與手機推播。', 'What machines, channels and posts need you to know. The same alerts go to the laptop app and phone push.'],
    onlyUnread: ['只看未讀', 'Unread only'], settings: ['推播設定', 'Push settings'],
  },
  push: {
    title: ['通知設定', 'Notification settings'], subtitle: ['手機推播讓你不在電腦前也知道要處理的事。推播只含機器、帳號、時間與一句說明，不含文案與媒體。', 'Phone push tells you when something needs you. It carries the machine, channel, time and one sentence, never captions or media.'],
    channels: ['手機推播', 'Phone push'], none: ['還沒有設定推播。', 'No push channel yet.'], ntfy: ['ntfy', 'ntfy'], bark: ['Bark', 'Bark'], telegram: ['Telegram', 'Telegram'],
    ntfyUrl: ['主題網址（例如 https://ntfy.sh/你的主題）', 'Topic URL (e.g. https://ntfy.sh/your-topic)'], ntfyToken: ['存取權杖（選填）', 'Access token (optional)'],
    barkUrl: ['裝置網址（Bark App 裡的 https://api.day.app/…）', 'Device URL (https://api.day.app/… from the Bark app)'],
    telegramChat: ['Chat ID', 'Chat ID'], telegramToken: ['Bot token', 'Bot token'], tokenSet: ['已設定（不會顯示）；留空表示不變', 'Set (hidden); leave empty to keep it'],
    clearToken: ['清除權杖', 'Clear token'], enabled: ['啟用', 'Enabled'], remove: ['移除', 'Remove'], add: ['新增推播', 'Add push'],
    test: ['傳一則測試', 'Send a test'], testQueued: ['已排入，幾秒內會在下方顯示結果。', 'Queued; the result shows below in a few seconds.'],
    lastTest: ['最近一次測試', 'Last test'], lastDelivery: ['最近一次送達', 'Last delivery'], sent: ['已送達', 'Delivered'], failed: ['失敗', 'Failed'], queued: ['排隊中', 'Queued'],
    publicTopic: ['ntfy 的公開主題任何人都能訂閱：請用難猜的主題名稱，或自架 ntfy 並設定權杖。', 'Anyone can subscribe to a public ntfy topic: use a hard-to-guess name, or self-host ntfy with a token.'],
    prefs: ['可以關閉的通知', 'Optional alerts'], published: ['每則發出時通知', 'Tell me each time a post goes out'], dailySummary: ['每天 21:00 的摘要', 'Daily summary at 21:00'],
    prefsHint: ['其他通知（要你處理、沒有發出、結果不明等）一律會送，不能關閉。', 'Other alerts (needs you, missed, unknown, …) are always sent.'],
    laptop: ['筆電通知', 'Laptop notifications'], laptopHint: ['在筆電安裝 SmartSell App，選「這台是我的筆電（只連 Codex，不發文）」，App 會常駐並顯示所有機器的通知。', 'Install the SmartSell App on your laptop and choose "This is my laptop (Codex only, no posting)". It stays in the tray and shows every machine\'s alerts.'],
    tailnet: ['筆電與手機也要加入同一個 tailnet，通知中的連結才打得開。', 'Your laptop and phone must join the same tailnet to open the links in alerts.'],
    saved: ['已儲存。', 'Saved.'],
  },
} as const satisfies Record<string, Record<string, Label>>;
