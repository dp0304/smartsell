# 回報安全問題

請**不要**用公開的 issue 回報安全問題。

- GitHub：在本倉庫的 **Security → Report a vulnerability** 私下回報（GitHub 的 private vulnerability reporting）。
- 無法使用 GitHub 時：在 Gitee 開一個只寫「需要私下回報安全問題」的 issue，不要附任何細節，我們會聯絡你。

請附上受影響的版本或 commit、重現步驟與影響。我們會在 7 天內回覆，修好後在 release notes 致謝（你不想具名也可以）。

## 範圍

特別重要的部分：

- 中樞的登入、工作區隔離、Agent 權杖（MCP）與只能由人操作的動作（核准、代按發布的風險確認、恢復暫停）；
- 影片上傳（分段上傳、單次有效的直傳網址）；
- 中樞與 Worker 之間的簽章裝置協定、配對與派工；
- Worker App、SmartSell Chrome 擴充功能與原生訊息主機：任何讓別的程式或網頁能操作使用者 Chrome 的方法；
- Worker 的自動更新。

不在範圍內：需要已經控制使用者電腦或 tailnet 的攻擊、第三方平台（X、TikTok）本身的問題、只影響 `pnpm dev` 開發模式且需要對方配合的設定。
