# SmartSell 量測原型（技術方案 §3.5）

> 2026-11-26：正式的 SmartSell 擴充功能（`../extension/`）已經會在每次操作時讀取 `navigator.webdriver`，結果顯示在 Worker App 的「用哪個 Chrome 發文」卡片；在你的 Chrome 裝好正式擴充功能、對 X 與 TikTok 各跑一次試跑，就等於完成這份量測。下面的原型只在想單獨量測時才需要。

在**你自己平常用的 Google Chrome** 裡量三件事，決定 Worker 改走擴充功能時夠不夠用（[core-automation-proposal.md](../../../docs/restructure/core-automation-proposal.md) §3.5）：

1. `navigator.webdriver`：附加 `chrome.debugger` 之前、期間、之後的值。
2. X：是否已登入；在撰寫框真實點擊並輸入一段文字後，「發布」按鈕會不會變成可按。**文字會再刪掉，絕不按發布。**
3. TikTok Studio：是否已登入（只開上傳頁，不上傳、不發布）。

## 怎麼跑

1. 在 SmartSell 原始碼根目錄執行：`node apps/connector-desktop/extension-spike/measure.mjs`
2. 在你的 Chrome 開 `chrome://extensions`，打開右上角「開發人員模式」，按「載入未封裝項目」，選這個資料夾裡的 `extension/`。
3. 擴充功能一載入就會連上量測程式，自動開分頁、量完自己關閉。附加除錯器的幾秒內，Chrome 頂端會出現「SmartSell 量測（原型）已開始對這個瀏覽器進行偵錯」，這是預期的，不要按取消。
4. 結果印在終端機，也存成這個資料夾裡的 `measurements-<時間>.json`（不進版本庫）。
5. 量完到 `chrome://extensions` 移除這個擴充功能即可。

擴充功能只連 `127.0.0.1:47231`，只在量測程式要求時動作，只碰它自己開的分頁；權限只有 `debugger`、`tabs`、`scripting` 與 `x.com`、`www.tiktok.com`。
