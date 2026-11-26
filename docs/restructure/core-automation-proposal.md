# SmartSell 核心技術方案：本機 Agent 驅動多台機器的真實瀏覽器與手機

日期：2026-11-25　狀態：主人已同意（2026-11-25「你決定，你認為最好的就去做」），依 §8 執行　依據：主人 2026-11-25 的要求；調研以 2026-11 的官方文件與開源專案為準，實測在本機 Chrome 158 上完成。

## 0. 一句話

主人本機的大模型工具（Codex、Claude Code、WorkBuddy）透過 MCP 交代事情，中樞把事情派給對的機器，那台機器的 Worker 在**主人自己平常用、已經登入的 Google Chrome** 或**連在那台電腦上的手機**裡，以接近人的節奏操作社媒與電商後台；已登入就做，沒登入就停下來通知主人去登入。

## 1. 主人的要求與目前的差距

| 要求 | 現在（第 1 階段） | 差距 |
|---|---|---|
| 用主人自己的 Google Chrome，登入了就能代操作 | Worker 為每個帳號開一個獨立的 Chrome 資料夾（`--user-data-dir`），主人要在裡面重新登入 | 不是主人平常的瀏覽器 |
| 擬人操作 | 已經用 CDP 送出 `isTrusted=true` 的滑鼠鍵盤事件 | **實測：Worker 用 `--remote-debugging-pipe` 啟動，頁面上 `navigator.webdriver` 為 `true`**（固定連接埠為 `false`），每個網站都看得到「這是自動化瀏覽器」 |
| 沒登入就提醒去登入 | 有：`login_expired` blocker、通知指名機器與帳號 | 改成在主人的 Chrome 裡檢查 |
| 影片能用 API 提交，MCP 寫清楚 | 中樞有分段上傳 API，relay 在本機呼叫；客戶端直接以 HTTP 連中樞時，`media_upload` 只回 `RELAY_REQUIRED` | 缺「沒有 relay 時用 API 直傳」的路，MCP 說明也沒寫 |
| 用 WorkBuddy 測試 | 只測過 Claude Code（60 輪通過） | WorkBuddy 未接入 |
| 遠程以視覺操作手機 | 沒有 | 全新 |
| 電商後台 | 第 6 階段才做 | 需要通用的操作能力，不能每個後台都寫死驅動 |

## 2. 整體架構

```
主人筆電：Codex / Claude Code / WorkBuddy（自己的大模型，負責理解與規劃）
   │ MCP（relay stdio，或 HTTP + Bearer）
   ▼
中樞（家裡常開的電腦，Tailscale）：帳號 → 機器路由、核准、排程、紀錄、網頁看板
   │ 簽章協定（既有）＋即時遙控通道（新增）
   ▼
每台機器的 Worker
   ├─ 瀏覽器：主人的 Chrome ← SmartSell 擴充功能 ← Native Messaging ← Worker
   └─ 手機：USB / Wi-Fi 的 Android（及 iPhone）← 裝置橋接（adb＋scrcpy server；iPhone 另評估）← Worker
```

給 Agent 的能力分兩種，兩種都經中樞，路由規則不變（**帳號綁哪台機器，就派給哪台**）：

1. **任務工具（已有，繼續擴充）**：`post_schedule` 這類有固定流程的工作，由 Worker 上的驅動準確執行。可以排程、可以在筆電關機時照樣跑，結果一律讀回確認。
2. **遙控工具（新增）**：處理長尾工作，例如某個電商後台改庫存、回某則留言。Agent 用自己的視覺模型一步一步看、一步一步點：
   - `screen_snapshot{machine, channel}`：截圖＋可點元素清單（ref）
   - `screen_act{ref | x,y, action: click|type|scroll|key}`
   - `screen_open{url}`
   - 只在主人打開 Agent 時運作。寫入類動作套用帳號的核准設定。
3. **之後再做：把遙控做過的流程存成「流程」**（步驟＋定位），下次由 Worker 自己重播，長尾工作逐步變成任務工具。

## 3. 瀏覽器：在主人自己的 Chrome 裡操作

### 3.1 為什麼不能直接接管主人的 Chrome

- Chrome 136 起，`--remote-debugging-port` 和 `--remote-debugging-pipe` 對**預設的使用者資料夾**一律無效，目的是防止竊取 cookie 的惡意程式（Google 官方說明，2025-03）。2026 年仍然如此，原本的繞過旗標在 Chrome 140 左右已失效。
- Chrome 144 起有官方開關 `chrome://inspect/#remote-debugging`，Chrome DevTools MCP 的 `--autoConnect` 就是用它。但**每次連線都要主人按「允許」**，無人值守時無法自動重連，所以只能當備案。

### 3.2 建議做法：SmartSell 擴充功能＋Native Messaging

- **安裝**：主人在自己的 Chrome 裝一個 SmartSell 擴充功能（Manifest V3）。Worker 安裝時註冊 Native Messaging host，擴充功能經由它和 Worker 溝通。這和 Claude in Chrome 的做法相同。
- **讀頁面**：用 content script 讀 DOM 與可點元素，不需要附加除錯器。
- **輸入**：只在要點擊或輸入的那一步，用 `chrome.debugger` 附加到那個分頁，送出 `Input.dispatchMouseEvent`、`Input.insertText`（事件為 `isTrusted=true`），做完立刻脫離。content script 的 `dispatchEvent` 產生的是 `isTrusted=false`，不能用。
- **登入判斷**：每個平台的驅動在主人的 Chrome 裡檢查登入狀態。
  - 已登入：照做。
  - 沒登入：Worker 在那個 Chrome 開出登入頁，並通知主人「Mac-B 的 Chrome 沒有登入 TikTok，請登入」。驗證碼、二次驗證一律由主人完成。
- **同平台多個帳號**：一個 Chrome 設定檔對應一組身分。同一台機器上的第二個 X 帳號，要放在另一個 Chrome 設定檔，並在那個設定檔也裝擴充功能。
- **好處**：
  - 用的就是主人的瀏覽器和登入狀態，重開機後仍然有效；
  - 不用任何會讓 `navigator.webdriver` 變 `true` 的啟動旗標；
  - 驅動、選擇器、讀回與「不重發」的邏輯沿用第 1 階段，只換掉底層的 `CdpPage` 傳輸。
- **代價**：
  - 附加除錯器期間，Chrome 會在所有分頁頂端顯示「SmartSell 已開始對這個瀏覽器進行偵錯」，主人按「取消」就會中斷；
  - 上架 Chrome 線上應用程式商店時，使用 `debugger` 權限的審核較嚴；可以先以開發者模式安裝，或由企業政策安裝；
  - Worker 操作的是主人正在用的瀏覽器：會新開一個分頁做事，不碰主人正在看的分頁。

### 3.3 擬人的界線

**要做：**
- 逐字輸入；
- 真實的滑鼠移動與點擊位置；
- 步驟之間有人的停頓；
- 每帳號每日上限與時段限制；
- 一次只操作一個分頁。

**不做：**
- 不偽造指紋；
- 不修改 `navigator.webdriver` 或任何偵測標記；
- 不用模擬器或防偵測瀏覽器；
- 不解驗證碼。

說明：「擬人」是讓頁面像被人操作一樣正常反應（例如 X 的編輯器要先真實點擊才收得到輸入），並且不以機器的頻率操作，**不是**保證平台偵測不到。X 的規則明文禁止以腳本操作網站，TikTok 條款也禁止自動化。每個帳號的「代按發布風險確認」照舊保留。

### 3.4 遇到平台拒絕時的退路（依序）

1. **系統輸入**：用作業系統層級的輸入（macOS CGEvent、Windows SendInput），只用在被拒絕的那一步，例如 TikTok 按「發布」。
   - 頁面收到的是一般輸入；
   - 代價是會暫時接管主人的滑鼠鍵盤，需要 macOS「輔助使用」權限，視窗也要在最前面。
   - 只在主人允許、而且那台機器沒人在用時才用。
2. **協助模式（已有）**：準備好影片和文案，停在「發布」前，通知主人自己按。

### 3.5 先驗證再全面改（spike）

調研有一項還沒有證實：TikTok Studio 的 `{code: 7, Permission Denied}` 是因為「附加了 CDP」本身，還是因為我們的啟動方式。這決定擴充功能方案是否足夠，所以第一步先做一個最小原型，在主人的 Chrome 上量測：

- 擴充功能附加 `chrome.debugger` 時，`navigator.webdriver` 的值；
- X：點擊編輯框、輸入文字，「發布」按鈕會不會變成可按（只試跑，不發出）；
- TikTok Studio：上傳後按「發布」會不會回 code 7，用「只有我」可見的測試影片。

## 4. 手機：電腦遠程以視覺操作

### 4.1 調研結論（2026-11，GitHub API 核對授權與活躍度）

| 專案 | 角色 | 結論 |
|---|---|---|
| **mobile-mcp + mobilecli**（mobile-next） | 裝置橋接 | 非常活躍（2026-11-24）。原生 MCP，**唯一支援實體 iPhone**，Android 走 ADB，macOS 與 Windows 都能跑。**更正（2026-11-26）：mobilecli 的授權是 FSL-1.1-Apache-2.0（Functional Source License），兩年內禁止「競爭用途」，不是 Apache-2.0**；SaaS 版有風險。改為：Android 直接用 adb（截圖、點擊、滑動、按鍵、`uiautomator dump`），中文輸入用 scrcpy server（Apache-2.0）的剪貼簿貼上；iPhone 另外評估（WebDriverAgent，BSD-3） |
| **ya-webadb + scrcpy server** | Android 快速通道 | MIT／Apache-2.0，可在 Node 內取得畫面與真實觸控。**採用為加速選項** |
| **Midscene.js**（字節） | 視覺定位與動作 | MIT，活躍。支援 Android、iOS 與任意視覺模型，內建中文輸入（yadb）。它的 MCP 套件已停用，改用 SDK。**Worker 自主執行時採用** |
| **Open-AutoGLM**（智譜） | 模型＋框架 | Apache-2.0。AutoGLM-Phone-9B 針對抖音、小紅書、淘寶等中文 App 調校。**借用它的「交還主人」設計**；模型可作為本地選項 |
| GUI-Owl-1.5（阿里）、MAI-UI（通義）、GELab-Zero（階躍） | 本地模型 | 可在本地 GPU 上執行的備選模型 |
| UI-TARS-desktop | — | 已封存，不採用 |
| AppAgent | — | 2025 年起停更，不採用 |
| Maestro、minitap mobile-use | — | 不支援實體 iPhone，不採用 |

### 4.2 建議做法

- **裝置橋接**：Worker 直接呼叫 adb（Android；授權見 §4.1 的更正）。主人在那台電腦以 USB 連上手機，在手機上按「允許 USB 偵錯」，到 Worker 綁成一個「手機帳號」。帳號照樣綁機器，路由規則不變。
- **看與做**：以截圖為主，無障礙樹只當提示。抖音、小紅書這類 App 大量用畫布繪製，無障礙樹常常不完整。
- **兩種驅動方式**：
  - 互動式：主人打開 Agent 時，用遙控工具 `phone_snapshot`、`phone_act`，由 Agent 自己的視覺模型決定點哪裡；
  - 無人值守：排程任務由 Worker 用 Midscene 搭配視覺模型執行。模型可選雲端的豆包 Seed、Qwen3-VL，或本地的 AutoGLM-Phone-9B、GUI-Owl-8B（需要 GPU）。
- **交還主人**：遇到登入、驗證碼、付款、`FLAG_SECURE` 畫面（截圖會是全黑）時，一律停下來通知主人。
- **中文輸入**：優先用 yadb 或剪貼簿貼上。ADB Keyboard 是 GPL-2.0，而且會切換手機的輸入法，避免使用。
- **iPhone**：要在 Mac 上用 Xcode 簽署測試代理程式，手機要開「開發者模式」。用免費帳號簽署的描述檔 7 天就會過期，建議用付費開發者帳號。所以 Android 先上，iPhone 以 Mac 輔助的測試版提供。
- **風險**：
  - App 可能偵測 ADB 或開發者選項，對抖音、小紅書的實際影響尚未驗證；
  - 視覺模型在真實裝置上的端到端成功率約 40–80%；
  - Wi-Fi ADB 不穩定。

  所以手機上的寫入動作預設「要我按核准」，每一步留截圖。

## 5. 影片上傳：兩條路，MCP 寫清楚

| 情況 | 做法 |
|---|---|
| **A. 經由 relay（建議）**：Codex、Claude Code、WorkBuddy 以 stdio 啟動 `node ~/.smartsell/relay.mjs` | `media_upload{path}` 在本機讀檔，用中樞的上傳 API 分段上傳。每段校驗 SHA-256，可以續傳，中樞模式上限 2 GB。影片內容不經過模型 |
| **B. 直接以 HTTP 連中樞（新增）**：客戶端沒有 relay，但 Agent 能在本機執行指令 | `media_upload{filename, bytes, sha256, mime}`，由 Agent 先用 `shasum -a 256` 算好雜湊。中樞回傳**單次有效的上傳網址**（綁定大小與 SHA-256，1 小時過期，只能用一次）和一行可以直接執行的指令 `curl --fail -T '<path>' '<url>'`（單引號，檔名裡的 `$(…)` 不會被執行）；之後用 `media_upload{media_id}` 查狀態 |

- 路 B 的網址本身就是授權，不會把 agent token 暴露給模型；中樞照樣校驗大小與 SHA-256，不符就拒收。
- MCP 伺服器說明（server instructions）的第 2 條改寫成：先用 A，沒有 relay 時改用 B，兩種都不准把檔案讀進對話、不准 base64。
- 這推翻第 1 階段決定 E4（「不提供一次性 PUT 網址」），需要主人確認。

## 6. WorkBuddy 測試

- 本機已安裝 WorkBuddy AI。它支援 stdio 與 HTTP（`url` 加 `headers`），設定檔在使用者資料夾的 `.workbuddy-ai/mcp.json`，第一次連線要在介面上按「信任」。
- 走路 A（relay）：設定檔裡 `"command": "node", "args": ["~/.smartsell/relay.mjs", "--hub", "<中樞>", "--token-file", "~/.smartsell/token"]`。
- 走路 B：`"url": "<中樞>/mcp"` 加 `"headers": {"Authorization": "Bearer …"}`，用來驗證直傳。
- WorkBuddy 沒有命令列模式，所以由主人在介面上輸入 §10.3 的 P1、P2 句子；中樞的紀錄由我讀取評分（工具呼叫次數、錯誤數、有沒有自己編文案、最後回覆有沒有附貼文網址）。

## 7. 準確性的保證（任何一種執行方式都適用）

- **寫入後一律讀回確認**：發出後讀回貼文網址，改價後讀回價格。讀不到就標「結果不明」，不自動重做。
- **已送出的動作絕不自動重試**（第 1 階段「不重發」的不變式，延伸到所有寫入）。
- **每一步留證據**：截圖的雜湊、步驟紀錄，貼文頁與任務頁都看得到。
- **核准與上限**：每帳號各自設定核准方式、每日上限、時段；手機與電商的寫入預設要核准。
- **停下來交還主人的情況**：登入、驗證碼、二次驗證、風控提示、付款畫面、頁面改版（找不到元素）。

## 8. 分階段

| 步驟 | 內容 | 完成標準 |
|---|---|---|
| 1 | 影片直傳 API＋MCP 說明改寫；WorkBuddy 接入與 P1/P2 測試 | WorkBuddy 以 relay 與直傳各完成一次「明天 9:00 發到 X 和 TikTok」，6 次以內的工具呼叫 |
| 2 | 瀏覽器原型：擴充功能＋Native Messaging，在主人的 Chrome 量測 §3.5 三項 | 有量測紀錄，決定採用擴充功能、或需要 §3.4 的系統輸入退路 |
| 3 | `CdpPage` 改走擴充功能；登入檢查與「請登入」通知改在主人的 Chrome 裡進行；舊的獨立資料夾模式保留為備案 | X、TikTok 試跑在主人的 Chrome 通過；E2E 改用擴充功能傳輸 |
| 4 | 遙控工具 `screen_snapshot`、`screen_act`（瀏覽器） | 在 WorkBuddy 或 Codex 裡完成一次電商後台的唯讀查詢與一次經核准的修改，寫入後讀回 |
| 5 | 手機：adb 橋接＋`phone_snapshot`、`phone_act`；Android 先做 | 一台 Android 手機在小紅書完成一次試跑，停在發布前；遇到登入畫面正確交還主人 |
| 6 | 手機無人值守：Midscene＋視覺模型，排程發布 | 同一則內容排程在 Android 手機準時發出並讀回 |
| 7 | iPhone（Mac 輔助） | 一台 iPhone 完成同樣的試跑 |

## 8.1 進度（2026-11-26）

- **第 1 步完成**：直傳 API 與 MCP 說明（E47）、WorkBuddy 以 relay 與直傳各跑 P1／P2（E48）。
- **第 2 步部分完成**：通道本身已在測試用 Chromium 驗證（擴充功能 → 原生訊息 → Worker，`chrome.debugger` 的隔離世界、無障礙樹查詢、可信輸入、檔案輸入、截圖都可用）。主人 Chrome 上的三項量測（§3.5）仍待主人在自己的 Chrome 跑一次 `extension-spike/`。依 Chromium 原始碼，`navigator.webdriver` 只由自動化啟動旗標（`--enable-automation`、`--remote-debugging-*`）打開，`chrome.debugger` 附加不會；量測會確認這一點。
- **第 3 步完成（待主人 Chrome 驗收）**：
  - 擴充功能：`apps/connector-desktop/extension/`，固定 ID `ghfcogpklmadimibmifjhfhlcncpcncp`（manifest 的 `key`）。只操作自己在「SmartSell」視窗開的分頁；只允許 Page、DOM、Runtime、Input、Network、Accessibility 與焦點模擬；不能導向 `file:`／`chrome:`；Worker 斷線時立刻脫離除錯器。
  - 原生訊息主機：macOS 用系統內建的 `nc -U`、Windows 用 PowerShell 管線，只做位元組轉送到 Worker 資料夾裡的 socket（0600）。打包版 App 的 Electron `runAsNode` 保持關閉。
  - Worker：`src/browser-bridge/`。`ExtensionCdpPipe` 把 CDP 轉給擴充功能，`ChromeCdpPage` 與 X、TikTok 驅動完全不改；每個帳號記住用哪個 Chrome 設定檔（`browser-bindings.json`），絕不自己換到另一個設定檔。
  - App：「用哪個 Chrome 發文」卡片，安裝步驟、連線狀態、多個設定檔時為每個帳號選一個；切換時若有貼文正在發布會拒絕。
  - 驗證：模擬平台上的 X、TikTok 全部驅動測試在兩種傳輸都通過（各 45 項）；E2E 從 MCP 排程到兩台機器在各自的「主人 Chrome」發出、網址回到中樞通過。
  - 還要主人做的：在自己的 Chrome 安裝擴充功能，對 X 與 TikTok 各跑一次試跑（停在發布前）。

- **第 4 步完成（設計 E50）**：`browser_open`／`browser_act` 在那台機器的主人 Chrome 操作主人允許的網站。
  - 每台機器預設關閉，只有人能在網頁開啟並列出允許的網站；Worker 也照同一份清單擋，連結或轉址離開範圍就停。
  - 快照＝截圖（MCP image 區塊）＋可見文字＋可互動元素（ref 只到下一次快照前有效）。
  - 驗證：E2E 從 MCP 到主人 Chrome 的模擬電商後台改庫存並讀回；真實模型（Claude Code，`pnpm manual-client-check -- --prompt P3 --client claude`）7 次呼叫、0 錯誤完成並自己讀回確認。
- **第 5 步部分完成**：`phone_act` 與 Android 引擎（只用 adb；mobilecli 因 FSL-1.1 授權不用）：截圖、uiautomator 元素、點擊、滑動、輸入（只收英數）、按鍵、開允許的 App，受保護畫面交還主人。這裡沒有實體手機，只以模擬 adb 驗證每一條指令；要主人插一支 Android 手機試跑一次小紅書（停在發布前）。中文輸入（scrcpy server 剪貼簿）與無人值守（第 6 步）還沒做。

## 9. 主人的決定（2026-11-25）

主人回覆「能接受，你決定，你認為最好的就去做」。據此：

1. 採用擴充功能方案，接受附加除錯器時 Chrome 頂端的偵錯提示。
2. 推翻 E4，提供單次有效的直傳網址（設計文件 E47，已實作）。
3. 手機的模型：互動時由主人本機的 Agent 自己看截圖（不另外付費）；無人值守的模型做成設定，可選雲端（豆包 Seed、Qwen3-VL）或本地（AutoGLM-Phone-9B、GUI-Owl-8B），預設不開。
4. 手機先支援抖音、小紅書、TikTok。

## 附錄：本機實測

```
Chrome 158.0.8127.37（macOS）
--remote-debugging-pipe（Worker 現在的啟動方式，有視窗）  navigator.webdriver = true
--remote-debugging-port=9339（獨立資料夾）               navigator.webdriver = false
```
