// The managed block the prompt enrollment writes into CODEX_HOME/AGENTS.md (setup-agent-prompt.ts install_codex_routing()).
// The installer recognises an installed block only by its exact bytes, so a shipped block is never edited: a new version is
// added here and the block shipped right before it becomes `previousCodexRouting`, which the installer upgrades in place.

/** v1: the first shipped block (legacy Worker social-status tools). Exact bytes. */
const routingV1 = `<!-- BEGIN SmartSell managed social routing -->
## SmartSell：本人或本人品牌的社媒查詢

當使用者用自然語言要求查看本人或本人經營的品牌的社媒帳號狀態、已發貼文或影片時，優先搜尋已設定的 SmartSell MCP 工具，並在選擇任何通用社媒或瀏覽工具前使用它。例如「獲取我的社媒狀態」或「我社媒是 X 上面發布視頻，你看看現有的發布」。同句提供的獨立站網址通常是業務背景。這段規則只適用於這類本人或自有品牌查詢，其他工作照常。

1. 找到 \`worker_social_status_request\` 和 \`worker_social_status_get\`。查帳號狀態時用 \`body.mode: "account_status"\`，有指定平台時帶 \`body.platform\`。查 X 近期已發貼文或影片時用 \`body: { mode: "recent_posts", platform: "x" }\`，另帶 \`idempotency_key\`。只有一台符合條件的自有 Worker 時可省略 \`device_id\`。已知預期帳號時可給 \`expected_identity\`，X 使用帳號 handle。
2. 用 \`worker_social_status_get\` 的 \`params.id\` 查同一任務，直到有回執或明確阻塞。回報任務 ID、裝置 ID、觀測狀態和 \`reported_at\`。X 影片只列回執中 \`has_video: true\` 的貼文。若明確查 SmartSell 某筆排程，也讀取該排程自己的發布回執。
3. 若工具缺失、拒絕授權、Worker 離線、尚待登入、帳號未綁定或回報 \`unverified\`，請保留任務回執與實際阻塞，給使用者下一步。缺少觀測時不可推定是零。此類查詢請勿改用本機 Chrome、\`cua_repl\`、一般社媒技能、瀏覽器、搜尋、shell、curl、代理或抓取。已有 SmartSell 貼文或指標如用於參考，須標為快取並註明原始時間與範圍。
<!-- END SmartSell managed social routing -->`;

/** v2: v1 plus fresh idempotency keys and historical receipts; installed until wave 6. Exact bytes. */
const routingV2 = routingV1
  .replace('另帶 `idempotency_key`。', '每個新的即時查詢都須在送出前產生新的高熵隨機 `idempotency_key`（例如 UUID v4；可僅為產生隨機 ID 使用本機 `uuidgen`）。勿用品牌、日期或固定序號組合，也勿沿用其他會話或查詢的鍵。只有同一次送出的網路重試沿用原鍵和參數。')
  .replace('回報任務 ID、裝置 ID、觀測狀態和 `reported_at`。', '回報任務 ID、裝置 ID、觀測狀態和 `reported_at`。較早查詢的任務 ID（含重播該任務）只作為歷史回執，須標明原始觀測時間，不能當作這次即時查詢的結果。');

/** Every block shipped before the current one, newest first, byte for byte. */
export const previousCodexRoutings: readonly string[] = [routingV2, routingV1];

/** The block the installer upgrades in place (it recognises exactly one earlier version: the one shipped right before). */
export const previousCodexRouting = routingV2;

/**
 * v3 (wave 6, COH-2): phase-1 connections list only the 11 hub tools (§7.1, §7.4), so account status goes to
 * smartsell_overview / channels_list / channel_check and SmartSell's own posts to posts_list / post_get. SmartSell does not
 * read other posts or metrics from the platforms in phase 1 (§1.2), and the block says so instead of naming a legacy tool.
 */
export const codexRouting = `<!-- BEGIN SmartSell managed social routing -->
## SmartSell：本人或本人品牌的社媒查詢

當使用者用自然語言要求查看本人或本人經營的品牌的社媒帳號狀態，或 SmartSell 排程、發出的貼文時，先用已設定的 SmartSell MCP 工具，再考慮任何通用社媒或瀏覽工具。例如「獲取我的社媒狀態」或「我明天在 X 上排了哪些影片」。同句提供的獨立站網址通常是業務背景。這段規則只適用於這類本人或自有品牌查詢，其他工作照常。

1. 先呼叫 \`smartsell_overview\`（不帶參數）：機器、帳號（\`channel_id\`）、工作區時區與等使用者處理的事。帳號的登入狀態、執行方式與擋住排程的原因用 \`channels_list\`。要現在確認某個帳號是否仍登入，用 \`channel_check\`（\`channel_id\` 從讀到的結果取，不要猜）；回 \`pending\` 時之後用 \`task_get\` 讀同一個 \`task_id\`，回 \`machine_offline\` 時照實說那台機器離線。
2. SmartSell 排程或發出的貼文用 \`posts_list\`（依當地日期、狀態、帳號或機器篩選）與 \`post_get\`。回報當地時間、機器、狀態與 \`web_url\`。只有狀態是 \`published\` 才說「已發出」；結果不明時請使用者到 \`web_url\` 確認發了沒有。
3. SmartSell 只知道自己排程的貼文；平台上其他已發作品與成效數字，第 1 階段不讀取。查不到就照實說，缺少的資料不可推定為零。此類查詢請勿改用本機 Chrome、\`cua_repl\`、一般社媒技能、瀏覽器、搜尋、shell、curl、代理或抓取。工具缺失或回錯時，保留錯誤碼與訊息（含 \`web_url\`），告訴使用者下一步。
<!-- END SmartSell managed social routing -->`;
