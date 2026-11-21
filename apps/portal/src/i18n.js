export const messages = {
  'zh-Hant': {
    portal: '客戶門戶', language: '語言', desktop: '請使用桌面瀏覽器開啟此門戶（建議寬度至少 1280 像素）。',
    loading: '載入中…', shared: '與您共享的項目', empty: '目前沒有共享項目。', signIn: '登入門戶',
    search: '搜尋', searchShared: '搜尋共享項目標題', noMatches: '找不到符合的共享項目。',
    session: '請先登入門戶。', unavailable: '無法存取此項目。分享可能已到期或被撤銷。', retry: '目前無法完成操作，請稍後再試。',
    denied: '您目前沒有執行此操作的權限。', invalid: '請檢查輸入資料後再試。', conflict: '此項目可能已變更。請重新整理後再試。',
    tooLong: '內容太長。請縮短後再試。', limited: '操作次數過多，請稍後再試。',
    stale: '已有新版本。等待團隊重新分享期間，仍可查看原版本。', expires: '有效期限', back: '所有共享項目',
    files: '可下載附件', feedback: '回饋', leaveFeedback: '留下回饋', send: '送出回饋', reply: '回覆',
    review: '審閱', approve: '批准', changes: '要求修改', reason: '修改原因', submitted: '已記錄。',
    invitation: '門戶邀請', accept: '接受邀請', submit: '送出創作者交付', submission: '交付說明',
    confirm: '確認收到交付', confirmationReminder: '請確認是否已收到這項交付。',
    delivery: '交付時間', produced_at: '產生', sent_at: '送達', confirmed_at: '確認',
    content: '內容', report: '報告', asset_pack: '素材', campaign: '活動',
  },
  'zh-Hans': {
    portal: '客户门户', language: '语言', desktop: '请使用桌面浏览器打开此门户（建议窗口宽度至少为 1280 像素）。',
    loading: '加载中…', shared: '与您共享的项目', empty: '目前没有共享项目。', signIn: '登录门户',
    search: '搜索', searchShared: '搜索共享项目标题', noMatches: '找不到匹配的共享项目。',
    session: '请先登录门户。', unavailable: '无法访问此项目。分享可能已过期或被撤销。', retry: '暂时无法完成操作，请稍后重试。',
    denied: '您没有执行此操作的权限。', invalid: '请检查输入的信息后重试。', conflict: '此项目可能已更改。请刷新页面后重试。',
    tooLong: '内容过长。请缩短后重试。', limited: '操作次数过多，请稍后重试。',
    stale: '已有新版本。等待团队重新分享期间，仍可查看原版本。', expires: '有效期', back: '所有共享项目',
    files: '可下载附件', feedback: '反馈', leaveFeedback: '留下反馈', send: '提交反馈', reply: '回复',
    review: '审核', approve: '批准', changes: '要求修改', reason: '修改原因', submitted: '已记录。',
    invitation: '门户邀请', accept: '接受邀请', submit: '提交创作者交付', submission: '交付说明',
    confirm: '确认收到交付', confirmationReminder: '请确认是否已收到这项交付。',
    delivery: '交付时间', produced_at: '生成', sent_at: '送达', confirmed_at: '确认',
    content: '内容', report: '报告', asset_pack: '素材', campaign: '活动',
  },
  en: {
    portal: 'Client portal', language: 'Language', desktop: 'Open this portal in a desktop browser at least 1280 pixels wide.',
    loading: 'Loading…', shared: 'Shared with you', empty: 'Nothing has been shared with you yet.', signIn: 'Sign in to the portal',
    search: 'Search', searchShared: 'Search shared titles', noMatches: 'No matching shared items.',
    session: 'Sign in to open the portal.', unavailable: 'This item is unavailable. The share may have expired or been revoked.', retry: 'The request could not be completed. Try again.',
    denied: 'You don’t have permission to perform this action.', invalid: 'Check the information you entered and try again.',
    conflict: 'This item may have changed. Refresh and try again.', tooLong: 'Shorten the text and try again.', limited: 'Too many attempts. Try again later.',
    stale: 'A newer revision exists. You can view this revision while the team prepares a new share.', expires: 'Expires', back: 'All shared items',
    files: 'Downloads', feedback: 'Feedback', leaveFeedback: 'Leave feedback', send: 'Post feedback', reply: 'Reply',
    review: 'Review', approve: 'Approve', changes: 'Request changes', reason: 'Changes requested', submitted: 'Recorded.',
    invitation: 'Portal invitation', accept: 'Accept invitation', submit: 'Submit creator delivery', submission: 'Delivery notes',
    confirm: 'Acknowledge delivery', confirmationReminder: 'Please confirm that you received this delivery.',
    delivery: 'Delivery timeline', produced_at: 'Produced', sent_at: 'Sent', confirmed_at: 'Confirmed',
    content: 'Content', report: 'Report', asset_pack: 'Assets', campaign: 'Campaign',
  },
};
function supportedLocale(tag) {
  if (!tag) return;
  try {
    const { language, script, region } = new Intl.Locale(tag.trim().replaceAll('_', '-'));
    if (language === 'en') return 'en';
    if (language !== 'zh') return;
    if (script) return script === 'Hans' ? 'zh-Hans' : script === 'Hant' ? 'zh-Hant' : undefined;
    return ['TW', 'HK', 'MO'].includes(region) ? 'zh-Hant' : 'zh-Hans';
  } catch {
    return;
  }
}

function rememberLocale(locale) {
  try { localStorage.setItem(preferenceKey, locale); } catch { /* storage can be blocked */ }
}

const preferenceKey = 'portal-locale';
function initialLocale() {
  const requested = supportedLocale(new URLSearchParams(location.search).get('lang'));
  let saved;
  try { saved = supportedLocale(localStorage.getItem(preferenceKey)); } catch { /* storage can be blocked */ }
  if (requested) rememberLocale(requested);
  return requested ?? saved ?? (navigator.languages ?? []).map(supportedLocale).find(Boolean) ?? 'zh-Hant';
}

export function bindLanguagePicker(picker, onChange) {
  picker.value = initialLocale();
  picker.addEventListener('change', () => {
    rememberLocale(picker.value);
    const url = new URL(location.href);
    if (url.searchParams.has('lang')) {
      url.searchParams.delete('lang');
      history.replaceState(history.state, '', url);
    }
    onChange();
  });
}

// Bind only UI-owned text. Domain text and inputs never pass through a catalog.
const translations = new WeakMap();
export const resolve = text => typeof text === 'function' ? text() : text;

export function appendText(parent, text) {
  if (typeof text !== 'string' && typeof text !== 'function') return;
  const child = document.createTextNode(resolve(text));
  if (typeof text === 'function') translations.set(child, text);
  parent.append(child);
}

export function writeText(parent, text) {
  parent.replaceChildren();
  appendText(parent, text);
}

export function updateText(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const translate = translations.get(walker.currentNode);
    if (translate) walker.currentNode.data = translate();
  }
}
