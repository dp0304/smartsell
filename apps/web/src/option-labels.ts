import { localizedLabel } from '@smartsell/ui';
import type { Label } from './modules';

// Display names for enum values that forms send to the API. The submitted value stays unchanged.
const labels: Record<string, Label> = {
  // Content formats and visibility
  image: ['圖片', 'Image', '图片'], carousel: ['多圖輪播', 'Carousel', '多图轮播'], reel: ['短影片（Reels）', 'Reel', '短视频（Reels）'], video: ['影片', 'Video', '视频'],
  short: ['短影片（Shorts）', 'Short', '短视频（Shorts）'], story: ['限時動態', 'Story', '限时动态'], text: ['純文字', 'Text', '纯文字'],
  feed_image: ['貼文圖片', 'Feed image', '帖子图片'], short_video: ['短影片', 'Short video', '短视频'], long_video: ['長影片', 'Long video', '长视频'], note: ['圖文筆記', 'Note', '图文笔记'], live_teaser: ['直播預告', 'Live teaser', '直播预告'],
  public: ['公開', 'Public', '公开'], private: ['私人', 'Private'], unlisted: ['不公開（持連結可看）', 'Unlisted', '不公开（持链接可看）'],
  followers: ['僅追蹤者', 'Followers only', '仅追踪者'], scheduled_private: ['先私人、到時公開', 'Private until scheduled', '先私人、到时公开'],
  // Platforms and providers
  facebook: ['Facebook', 'Facebook'], instagram: ['Instagram', 'Instagram'], tiktok: ['TikTok', 'TikTok'], youtube: ['YouTube', 'YouTube'],
  x: ['X', 'X'], threads: ['Threads', 'Threads'], pinterest: ['Pinterest', 'Pinterest'], linkedin: ['LinkedIn', 'LinkedIn'],
  douyin: ['抖音', 'Douyin'], xiaohongshu: ['小紅書', 'Xiaohongshu', '小红书'], generic: ['通用（不指定平台）', 'Generic'], meta_instagram: ['Instagram', 'Instagram'], meta_facebook: ['Facebook', 'Facebook'],
  file_import: ['檔案匯入', 'File import', '文件导入'], shopify: ['Shopify', 'Shopify'], tiktok_shop: ['TikTok Shop', 'TikTok Shop'],
  amazon_sp: ['Amazon', 'Amazon'], shopee: ['Shopee', 'Shopee'], lazada: ['Lazada', 'Lazada'],
  // Workspace roles
  owner: ['擁有者', 'Owner', '拥有者'], admin: ['管理員', 'Admin', '管理员'], editor: ['編輯', 'Editor', '编辑'], reviewer: ['審核者', 'Reviewer', '审核者'], viewer: ['檢視者', 'Viewer', '查看者'], analyst: ['分析師', 'Analyst', '分析师'],
  // Content locales
  'zh-TW': ['繁體中文（台灣）', 'Chinese (Taiwan)', '繁体中文（台湾）'], 'zh-HK': ['繁體中文（香港）', 'Chinese (Hong Kong)', '繁体中文（香港）'], 'zh-CN': ['簡體中文', 'Chinese (Simplified)', '简体中文'],
  'en-US': ['英文（美國）', 'English (US)', '英文（美国）'], 'en-GB': ['英文（英國）', 'English (UK)', '英文（英国）'], 'ja-JP': ['日文', 'Japanese'], 'ko-KR': ['韓文', 'Korean', '韩文'],
  'th-TH': ['泰文', 'Thai'], 'vi-VN': ['越南文', 'Vietnamese'], 'id-ID': ['印尼文', 'Indonesian'], 'ms-MY': ['馬來文', 'Malay', '马来文'], 'fil-PH': ['菲律賓文', 'Filipino', '菲律宾文'],
  // Campaigns
  launch: ['新品上市', 'Launch'], seasonal: ['節慶檔期', 'Seasonal', '节庆档期'], promotion: ['促銷', 'Promotion', '促销'], always_on: ['常態經營', 'Always on', '常态经营'],
  brand: ['品牌形象', 'Brand'], other: ['其他', 'Other'],
  planned: ['已規劃', 'Planned', '已规划'], active: ['進行中', 'Active', '进行中'], paused: ['已暫停', 'Paused', '已暂停'], wrapping: ['結案中', 'Wrapping up', '结案中'],
  closed: ['已結案', 'Closed', '已结案'], cancelled: ['已取消', 'Cancelled'], draft: ['草稿', 'Draft'], archived: ['已封存', 'Archived'],
  disabled: ['停用', 'Disabled', '禁用'], enabled: ['啟用', 'Enabled', '激活'], revoke_egress: ['撤銷外送同意', 'Revoke egress consent', '撤销外送同意'],
  // Content production
  accepted: ['已接受', 'Accepted'], drafting: ['撰寫中', 'Drafting', '撰写中'], design: ['設計中', 'Design', '设计中'], awaiting_assets: ['等素材', 'Awaiting assets'],
  internal_review: ['內部審閱', 'Internal review', '内部审阅'], ready: ['可排期', 'Ready'],
  // Brand knowledge and templates
  positioning: ['品牌定位', 'Positioning'], tone: ['語氣', 'Tone', '语气'], forbidden_phrase: ['禁用詞', 'Forbidden phrase', '禁用词'], faq: ['常見問答', 'FAQ', '常见问答'],
  example: ['範例', 'Example', '范例'], policy: ['政策', 'Policy'], product_pointer: ['商品指引', 'Product pointer'],
  text_snippet: ['文字片段', 'Text snippet'], hashtag_set: ['主題標籤組', 'Hashtag set', '主题标签组'], cta: ['行動呼籲', 'Call to action', '行动呼吁'], caption_template: ['貼文範本', 'Caption template', '帖子范本'],
  // Reports
  social_performance: ['社群成效', 'Social performance', '社区成效'], campaign: ['活動報告', 'Campaign', '活动报告'], client_monthly: ['客戶月報', 'Client monthly', '客户月报'], custom: ['自訂', 'Custom', '自订'],
  pdf: ['PDF', 'PDF'], csv: ['CSV', 'CSV'], xlsx: ['Excel（xlsx）', 'Excel (xlsx)'],
  // Inbox and execution
  public_reply: ['公開回覆', 'Public reply', '公开回复'], private_reply: ['私訊回覆留言者', 'Private reply', '私讯回复留言者'], dm: ['私訊', 'Direct message', '私讯'],
  manual: ['人工', 'Manual'], api: ['官方 API', 'Official API'],
  preflight: ['發布前檢查', 'Preflight', '发布前检查'], schedule: ['排期檢查', 'Schedule', '排期检查'], approval: ['審批檢查', 'Approval', '审批检查'], execution: ['執行前檢查', 'Execution', '运行前检查'],
  skip: ['略過這次', 'Skip', '略过这次'], run_now: ['立即發布', 'Run now', '立即发布'], reschedule: ['改期', 'Reschedule'],
  edit_caption: ['修改文案', 'Edit caption'], delete: ['刪除作品', 'Delete post', '删除作品'], hide: ['隱藏作品', 'Hide post', '隐藏作品'], unschedule: ['取消排程', 'Unschedule', '取消调度'],
  completed: ['已完成', 'Completed'], failed: ['失敗', 'Failed', '失败'], published: ['已發布', 'Published', '已发布'], verified_absent: ['確認未發布', 'Verified absent', '确认未发布'],
  resolved: ['已解決', 'Resolved', '已解决'], open: ['未處理', 'Open', '未处理'],
  // Data collection and AI
  pause: ['暫停採集', 'Pause', '暂停采集'], reduce_frequency: ['降低頻率', 'Reduce frequency', '降低频率'], alert_only: ['只提醒', 'Alert only'],
  openai_compatible: ['OpenAI 相容協定', 'OpenAI-compatible', 'OpenAI 兼容协定'], anthropic_compatible: ['Anthropic Messages 相容協定', 'Anthropic Messages-compatible', 'Anthropic Messages 兼容协定'],
  plan: ['規劃', 'Plan', '规划'], translate: ['翻譯', 'Translate', '翻译'], classify: ['分類', 'Classify', '分类'], analyze: ['分析', 'Analyze'], embed: ['向量化', 'Embed', '矢量化'],
};

export function optionLabel(value: string, locale: string) {
  const entry = labels[value];
  return entry ? localizedLabel(entry, locale) : value;
}

const commonZones = ['Asia/Taipei', 'Asia/Hong_Kong', 'Asia/Shanghai', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Bangkok', 'Asia/Jakarta',
  'Asia/Manila', 'Asia/Ho_Chi_Minh', 'Asia/Tokyo', 'Asia/Seoul', 'Australia/Sydney', 'Europe/London', 'Europe/Berlin',
  'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'UTC'];

/** Common zones for the markets SmartSell serves, with the browser zone first. */
export function timeZoneChoices(current?: string) {
  const browser = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return [...new Set([current, browser, ...commonZones].filter((zone): zone is string => Boolean(zone)))];
}
