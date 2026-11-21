import type { Label } from './modules';

// Display names for enum values that forms send to the API. The submitted value stays unchanged.
const labels: Record<string, Label> = {
  // Content formats and visibility
  image: ['圖片', 'Image'], carousel: ['多圖輪播', 'Carousel'], reel: ['短影片（Reels）', 'Reel'], video: ['影片', 'Video'],
  short: ['短影片（Shorts）', 'Short'], story: ['限時動態', 'Story'], text: ['純文字', 'Text'],
  feed_image: ['貼文圖片', 'Feed image'], short_video: ['短影片', 'Short video'], long_video: ['長影片', 'Long video'], note: ['圖文筆記', 'Note'], live_teaser: ['直播預告', 'Live teaser'],
  public: ['公開', 'Public'], private: ['私人', 'Private'], unlisted: ['不公開（持連結可看）', 'Unlisted'],
  followers: ['僅追蹤者', 'Followers only'], scheduled_private: ['先私人、到時公開', 'Private until scheduled'],
  // Platforms and providers
  facebook: ['Facebook', 'Facebook'], instagram: ['Instagram', 'Instagram'], tiktok: ['TikTok', 'TikTok'], youtube: ['YouTube', 'YouTube'],
  x: ['X', 'X'], threads: ['Threads', 'Threads'], pinterest: ['Pinterest', 'Pinterest'], linkedin: ['LinkedIn', 'LinkedIn'],
  douyin: ['抖音', 'Douyin'], xiaohongshu: ['小紅書', 'Xiaohongshu'], generic: ['通用（不指定平台）', 'Generic'], meta_instagram: ['Instagram', 'Instagram'], meta_facebook: ['Facebook', 'Facebook'],
  file_import: ['檔案匯入', 'File import'], shopify: ['Shopify', 'Shopify'], tiktok_shop: ['TikTok Shop', 'TikTok Shop'],
  amazon_sp: ['Amazon', 'Amazon'], shopee: ['Shopee', 'Shopee'], lazada: ['Lazada', 'Lazada'],
  // Workspace roles
  owner: ['擁有者', 'Owner'], admin: ['管理員', 'Admin'], editor: ['編輯', 'Editor'], reviewer: ['審核者', 'Reviewer'], viewer: ['檢視者', 'Viewer'], analyst: ['分析師', 'Analyst'],
  // Content locales
  'zh-TW': ['繁體中文（台灣）', 'Chinese (Taiwan)'], 'zh-HK': ['繁體中文（香港）', 'Chinese (Hong Kong)'], 'zh-CN': ['簡體中文', 'Chinese (Simplified)'],
  'en-US': ['英文（美國）', 'English (US)'], 'en-GB': ['英文（英國）', 'English (UK)'], 'ja-JP': ['日文', 'Japanese'], 'ko-KR': ['韓文', 'Korean'],
  'th-TH': ['泰文', 'Thai'], 'vi-VN': ['越南文', 'Vietnamese'], 'id-ID': ['印尼文', 'Indonesian'], 'ms-MY': ['馬來文', 'Malay'], 'fil-PH': ['菲律賓文', 'Filipino'],
  // Campaigns
  launch: ['新品上市', 'Launch'], seasonal: ['節慶檔期', 'Seasonal'], promotion: ['促銷', 'Promotion'], always_on: ['常態經營', 'Always on'],
  brand: ['品牌形象', 'Brand'], other: ['其他', 'Other'],
  planned: ['已規劃', 'Planned'], active: ['進行中', 'Active'], paused: ['已暫停', 'Paused'], wrapping: ['結案中', 'Wrapping up'],
  closed: ['已結案', 'Closed'], cancelled: ['已取消', 'Cancelled'], draft: ['草稿', 'Draft'], archived: ['已封存', 'Archived'],
  disabled: ['停用', 'Disabled'], enabled: ['啟用', 'Enabled'], revoke_egress: ['撤銷外送同意', 'Revoke egress consent'],
  // Content production
  accepted: ['已接受', 'Accepted'], drafting: ['撰寫中', 'Drafting'], design: ['設計中', 'Design'], awaiting_assets: ['等素材', 'Awaiting assets'],
  internal_review: ['內部審閱', 'Internal review'], ready: ['可排期', 'Ready'],
  // Brand knowledge and templates
  positioning: ['品牌定位', 'Positioning'], tone: ['語氣', 'Tone'], forbidden_phrase: ['禁用詞', 'Forbidden phrase'], faq: ['常見問答', 'FAQ'],
  example: ['範例', 'Example'], policy: ['政策', 'Policy'], product_pointer: ['商品指引', 'Product pointer'],
  text_snippet: ['文字片段', 'Text snippet'], hashtag_set: ['主題標籤組', 'Hashtag set'], cta: ['行動呼籲', 'Call to action'], caption_template: ['貼文範本', 'Caption template'],
  // Reports
  social_performance: ['社群成效', 'Social performance'], campaign: ['活動報告', 'Campaign'], client_monthly: ['客戶月報', 'Client monthly'], custom: ['自訂', 'Custom'],
  pdf: ['PDF', 'PDF'], csv: ['CSV', 'CSV'], xlsx: ['Excel（xlsx）', 'Excel (xlsx)'],
  // Inbox and execution
  public_reply: ['公開回覆', 'Public reply'], private_reply: ['私訊回覆留言者', 'Private reply'], dm: ['私訊', 'Direct message'],
  manual: ['人工', 'Manual'], api: ['官方 API', 'Official API'],
  preflight: ['發布前檢查', 'Preflight'], schedule: ['排期檢查', 'Schedule'], approval: ['審批檢查', 'Approval'], execution: ['執行前檢查', 'Execution'],
  skip: ['略過這次', 'Skip'], run_now: ['立即發布', 'Run now'], reschedule: ['改期', 'Reschedule'],
  edit_caption: ['修改文案', 'Edit caption'], delete: ['刪除作品', 'Delete post'], hide: ['隱藏作品', 'Hide post'], unschedule: ['取消排程', 'Unschedule'],
  completed: ['已完成', 'Completed'], failed: ['失敗', 'Failed'], published: ['已發布', 'Published'], verified_absent: ['確認未發布', 'Verified absent'],
  resolved: ['已解決', 'Resolved'], open: ['未處理', 'Open'],
  // Data collection and AI
  pause: ['暫停採集', 'Pause'], reduce_frequency: ['降低頻率', 'Reduce frequency'], alert_only: ['只提醒', 'Alert only'],
  openai_compatible: ['OpenAI 相容協定', 'OpenAI-compatible'], anthropic_compatible: ['Anthropic Messages 相容協定', 'Anthropic Messages-compatible'],
  plan: ['規劃', 'Plan'], translate: ['翻譯', 'Translate'], classify: ['分類', 'Classify'], analyze: ['分析', 'Analyze'], embed: ['向量化', 'Embed'],
};

export function optionLabel(value: string, locale: string) {
  const entry = labels[value];
  return entry ? entry[locale === 'en' ? 1 : 0] : value;
}

const commonZones = ['Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Bangkok', 'Asia/Jakarta',
  'Asia/Manila', 'Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];

/** Common zones for the markets SmartSell serves, with the browser zone first. */
export function timeZoneChoices(current?: string) {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([current, browser, ...commonZones].filter((zone): zone is string => Boolean(zone)))];
}
