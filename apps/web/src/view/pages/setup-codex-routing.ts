// Preserve the exact previously shipped bytes for safe in-place upgrades of the managed block.
export const previousCodexRouting = `<!-- BEGIN SmartSell managed social routing -->
## SmartSell：本人或本人品牌的社媒查詢

當使用者用自然語言要求查看本人或本人經營的品牌的社媒帳號狀態、已發貼文或影片時，優先搜尋已設定的 SmartSell MCP 工具，並在選擇任何通用社媒或瀏覽工具前使用它。例如「獲取我的社媒狀態」或「我社媒是 X 上面發布視頻，你看看現有的發布」。同句提供的獨立站網址通常是業務背景。這段規則只適用於這類本人或自有品牌查詢，其他工作照常。

1. 找到 \`worker_social_status_request\` 和 \`worker_social_status_get\`。查帳號狀態時用 \`body.mode: "account_status"\`，有指定平台時帶 \`body.platform\`。查 X 近期已發貼文或影片時用 \`body: { mode: "recent_posts", platform: "x" }\`，另帶 \`idempotency_key\`。只有一台符合條件的自有 Worker 時可省略 \`device_id\`。已知預期帳號時可給 \`expected_identity\`，X 使用帳號 handle。
2. 用 \`worker_social_status_get\` 的 \`params.id\` 查同一任務，直到有回執或明確阻塞。回報任務 ID、裝置 ID、觀測狀態和 \`reported_at\`。X 影片只列回執中 \`has_video: true\` 的貼文。若明確查 SmartSell 某筆排程，也讀取該排程自己的發布回執。
3. 若工具缺失、拒絕授權、Worker 離線、尚待登入、帳號未綁定或回報 \`unverified\`，請保留任務回執與實際阻塞，給使用者下一步。缺少觀測時不可推定是零。此類查詢請勿改用本機 Chrome、\`cua_repl\`、一般社媒技能、瀏覽器、搜尋、shell、curl、代理或抓取。已有 SmartSell 貼文或指標如用於參考，須標為快取並註明原始時間與範圍。
<!-- END SmartSell managed social routing -->`;

export const codexRouting = previousCodexRouting
  .replace('另帶 `idempotency_key`。', '每個新的即時查詢都須在送出前產生新的高熵隨機 `idempotency_key`（例如 UUID v4；可僅為產生隨機 ID 使用本機 `uuidgen`）。勿用品牌、日期或固定序號組合，也勿沿用其他會話或查詢的鍵。只有同一次送出的網路重試沿用原鍵和參數。')
  .replace('回報任務 ID、裝置 ID、觀測狀態和 `reported_at`。', '回報任務 ID、裝置 ID、觀測狀態和 `reported_at`。較早查詢的任務 ID（含重播該任務）只作為歷史回執，須標明原始觀測時間，不能當作這次即時查詢的結果。');
