# SmartSell 第 1 階段：主人實機驗收檢查表

依據：`docs/restructure/phase1-design.md` §10.4（十二步驟）、§10.3（真實模型測試）、§11.3（M1、M5），以及各工作流留給實機的項目（`docs/restructure/requests/closure-L-server.md`、`closure-L-worker.md`、`S9.md`）。安裝細節與每一種錯誤訊息的處理，另見 `docs/hub-setup.md`（本表直接引用它的章節，不重複）。

這份檢查表給你在真實機器、真實帳號上照著做。每一步都寫明：**在哪台機器**、**要打的命令**（macOS 與 Windows 分開）、**成功的樣子**、**失敗時怎麼辦**、**網頁上看哪裡**。命令都可以直接複製；`<尖括號>` 的部分換成你自己的值。

## 開始之前

**機器與名稱**（與設計文件一致，Codex 會用這些名字找機器）：

| 角色 | 本表的名字 | 用途 |
|---|---|---|
| 中樞 | `hub` | 常開的家用機器（macOS 或 Windows），跑 SmartSell 中樞與網頁 |
| 筆電 | 你的筆電 | 跑 Codex（或 Claude Code）與 SmartSell App（筆電模式），不發文 |
| 手機 | 你的手機 | 收推播 |
| 發文機器 1 | `Mac-B` | 用 X 帳號發文 |
| 發文機器 2 | `Win-C` | 用 TikTok 帳號發文 |

**先準備好：**

- 一個 Tailscale 帳號（tailnet）。所有機器與手機都登入同一個 tailnet。
- 中樞與要建置安裝包的機器上：Node.js 24、git、ffmpeg（安裝命令見 `docs/hub-setup.md` 第 1 節的表）。
- X 與 TikTok 的帳號，以及它們的密碼與二次驗證裝置（登入一律由你自己在 SmartSell 開出的 Chrome 視窗完成）。
- Google Chrome 裝在 Mac-B 與 Win-C 上（Worker 只用原版 Chrome）。

**網頁的位置（之後一直會用到）：**中樞網址 `https://<中樞機器名>.<tailnet>.ts.net`，登入後左側導覽為「今日、日曆、機器、帳號、Agent、設定、開始設定」。貼文頁在 `…/app/<工作區>/posts/<貼文 ID>`，從今日、日曆、機器、帳號頁都點得到。

**紀錄：**每做完一步，在文末的「驗收紀錄」表填日期與結果。遇到失敗，照該步的「失敗時」處理；仍然不行，收集「出問題時要附的資料」一節列的東西交給開發端。

---

## 第 1 步：中樞

**在哪台機器：**中樞（`hub`）。

### 1.1 安裝

macOS（終端機）：

```bash
git clone https://github.com/dp0304/smartsell.git ~/smartsell
cd ~/smartsell
bash scripts/install-hub.sh --check-only     # 只檢查前置軟體，不做任何變更
bash scripts/install-hub.sh                  # 依序執行 hub:init、建置、安裝服務
```

Windows（系統管理員 PowerShell）：

```powershell
git clone https://github.com/dp0304/smartsell.git $HOME\smartsell
cd $HOME\smartsell
powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1 -CheckOnly
powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1 -Mode boot   # 開機就執行，不必有人登入（建議）
```

安裝過程會問：是否執行 `pnpm worker:release`（建置 macOS 的 Worker 安裝包，選「是」）、是否安裝為服務（選「是」）。macOS 會以 `fdesetup status` 偵測 FileVault 並請你在三種做法中選一種（`docs/hub-setup.md` 第 3 節）：

- 關閉 FileVault 並開啟自動登入，或用 `--mode daemon`（無人登入也執行，需要 `tailscaled` 以系統服務執行）；
- 保持 FileVault，接受斷電後要到場輸入密碼（加 UPS；計畫內重開機用 `sudo fdesetup authrestart`）；
- 改用 Windows 中樞。

**成功的樣子：**最後印出

```
[10/10] 在已加入 tailnet 的瀏覽器開啟下面的網址，建立擁有者帳號（建立後這個網址就會失效）：
https://<中樞機器名>.<tailnet>.ts.net/setup#setup-token=<64 位十六進位>
```

以及「中樞服務已安裝（agent）並在執行中。」（Windows 為 boot 或 logon）。

**失敗時：**照印出的「下一步」做後重跑同一個命令（安裝腳本可以重跑）；每一種訊息的處理見 `docs/hub-setup.md` 第 1、2 節的表。

### 1.2 Tailscale 管理後台（只做一次）

在瀏覽器開啟 Tailscale 管理後台：

1. **DNS** → 啟用 **MagicDNS** 與 **HTTPS Certificates**。
2. **Machines** → 對中樞選 **Disable key expiry**（之後每加一台 Worker 也要做）。
3. 中樞的機器名稱若含個人資訊（例如姓名），先改成中性的名字（例如 `hub`）再重跑 `pnpm hub:init`：這個名字會寫進公開的憑證透明度紀錄。

### 1.3 真實的 `tailscale serve`（M1）

開發機上只用假的 Tailscale CLI 測過，這一項只能在你的中樞上驗。

macOS：

```bash
/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status
```

Windows：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" serve status
```

**成功的樣子：**有一行 `https://<中樞機器名>.<tailnet>.ts.net (tailnet only)`，底下是 `|-- / proxy http://127.0.0.1:3401`。

**失敗時：**沒有這一行 → 重跑 `pnpm hub:init`（它會執行 `tailscale serve --bg --https=443 http://127.0.0.1:3401`）；出現 Funnel 或「(Funnel on)」→ 在管理後台關掉 Funnel，中樞只給 tailnet 內使用。

### 1.4 健檢

```bash
cd ~/smartsell && pnpm hub:doctor
```

**成功的樣子：**最後一行「有 0 個錯誤」。警告可以先記下：FileVault、睡眠、沒有 win-x64 安裝包（第 3 步建置後就會消失）、節點金鑰到期（照 1.2 關閉）。

**失敗時：**每一行錯誤都附了下一步命令，照做後再跑一次 `pnpm hub:doctor`。

### 1.5 從筆電開啟

筆電加入 tailnet（第 2 步的 2.1）之後，在筆電的瀏覽器開啟 1.1 印出的 `https://…/setup#setup-token=…`，建立擁有者帳號，精靈中時區選 `Asia/Shanghai`（或你的時區）。之後打開 `https://<中樞機器名>.<tailnet>.ts.net` 應看到登入頁，登入後是「今日」。

筆電終端機也可以檢查：

```bash
curl -fsS https://<中樞機器名>.<tailnet>.ts.net/readyz && echo OK
```

**失敗時：**`Could not resolve host` → 筆電沒登入 tailnet 或 MagicDNS 沒開；憑證錯誤 → 管理後台的 HTTPS Certificates 沒開；`/setup` 回 409 → 擁有者已建立過，直接到首頁登入。

### 1.6 重開機自動啟動（M1：launchd／排程工作）

macOS：

```bash
sudo shutdown -r now
# 重開機後（agent 模式要先登入；daemon 模式不用）：
cd ~/smartsell && pnpm hub:service status
curl -fsS http://127.0.0.1:3401/readyz && echo OK
launchctl print gui/$(id -u)/com.smartsell.hub | head -20        # agent 模式
sudo launchctl print system/com.smartsell.hub | head -20         # daemon 模式
```

Windows（系統管理員 PowerShell）：

```powershell
Restart-Computer
# 重開機後：
cd $HOME\smartsell; pnpm hub:service status
schtasks /Query /TN "SmartSell Hub" /V /FO LIST
(Invoke-WebRequest http://127.0.0.1:3401/readyz -UseBasicParsing).StatusCode    # 200
```

**成功的樣子：**`hub:service status` 顯示已安裝並在執行；`/readyz` 回 200；從筆電開得了網頁。

**失敗時：**看中樞資料夾的 `status.json`（macOS `~/Library/Application Support/SmartSell Hub/status.json`，Windows `%LOCALAPPDATA%\SmartSell Hub\status.json`）：`config_error` 依訊息修正後 `pnpm hub:service install`；macOS 開機停在 FileVault 解鎖畫面 → 照 1.1 的 FileVault 選擇處理；Windows boot 模式建立工作時要求的 Windows 密碼要你自己輸入。

---

## 第 2 步：筆電與手機

### 2.1 Tailscale

**在哪台機器：**筆電、手機。安裝 Tailscale（macOS：App Store；Windows：`winget install --id Tailscale.Tailscale -e`；手機：App Store／Google Play），登入同一個 tailnet。

**成功的樣子：**手機瀏覽器開得了 `https://<中樞機器名>.<tailnet>.ts.net`。

### 2.2 手機推播

**在哪裡：**網頁「設定 → 通知」（`…/app/<工作區>/settings/notifications`）。

1. 選一種管道：ntfy、Bark 或 Telegram，填入對應設定（不要用 `https://ntfy.sh/` 上容易猜到的 topic；用自己的 ntfy 伺服器或長而隨機的 topic）。
2. 手機安裝對應的 App 並訂閱。
3. 按「傳一則測試」。

**成功的樣子：**手機幾秒內收到測試推播；頁面顯示最後一次測試的結果為成功。

**失敗時：**頁面顯示的錯誤照做（網址、token）；`ALERT_SECRET_UNAVAILABLE` → 中樞沒有 `APP_SECRET`，重跑 `pnpm hub:init` 後重啟中樞。

### 2.3 筆電的 SmartSell App 與 Codex

**在哪台機器：**筆電。

1. 在網頁「開始設定 → 下載 SmartSell Worker」下載對應安裝包（Apple silicon 選 mac-arm64、Intel Mac 選 mac-x64、Windows 選 win-x64）。
2. macOS：把 App 拖進「應用程式」，在 Finder 對 **SmartSell Worker** 按右鍵 →「打開」（未簽章，Gatekeeper 第一次會擋）。Windows：SmartScreen 出現時按「其他資訊」→「仍要執行」。
3. 首次開啟選 **「這台是我的筆電（只連 AI 助手，不發文）」**，貼上中樞位址。
4. 按 **「連接 Codex」**（用 Claude Code 就按「連接 Claude Code」）。瀏覽器會開中樞的授權頁，登入後同意。App 會在 `~/.codex/config.toml` 寫入標記過的 `[mcp_servers.smartsell]` 區塊，寫入前先備份成 `config.toml.smartsell-backup-<時間>`（E12），畫面上會顯示備份路徑。
5. 重新啟動 Codex。

**成功的樣子：**在 Codex 輸入「用 SmartSell 看一下我的機器」，Codex 呼叫 `smartsell_overview` 並列出機器（此時還沒有機器也沒關係，有回應就代表連線成功）。網頁「Agent」頁看得到這台筆電的連線。

**失敗時：**Codex 說找不到 smartsell → 確認已重新啟動 Codex，並檢查 `~/.codex/config.toml` 有 `# >>> smartsell` 區塊；`UNAUTHENTICATED` → 在 App 重新按「連接 Codex」（舊連線會自動撤銷，E13）；Windows 筆電沒有 Node → `winget install OpenJS.NodeJS.LTS` 後重新連接（Windows 用 Node 執行 relay）。

---

## 第 3 步：配對 Mac-B 與 Win-C

### 3.1 Tailscale（兩台都做）

安裝 Tailscale、登入同一個 tailnet，**不要設定 exit node**，到管理後台對這兩台選 **Disable key expiry**。

### 3.2 Windows 安裝包：在 Win-C 建置一次（M1）

開發機是 macOS，Windows 安裝包（NSIS）只能在 Windows 上建置，所以這一步只能由你在 Win-C 做。完整步驟在 `docs/hub-setup.md` 第 4a 節，摘要：

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS -e --version 24.*
# 重新開啟 PowerShell
corepack enable
git clone https://github.com/dp0304/smartsell.git $HOME\smartsell
cd $HOME\smartsell
pnpm install --frozen-lockfile
pnpm worker:release --win
```

**釘選的 Electron（E16）：**安裝包一律用 `apps/connector-desktop/package.json` 釘選的 Electron **45.4.1**。第一次建置若出現 `Pinned Electron runtime is missing`，在這台建置機上執行一次（會下載 Electron 45.4.1）：

```powershell
cd $HOME\smartsell\apps\connector-desktop
node node_modules/electron/install.js
Get-Content node_modules\electron\dist\version     # 應為 45.4.1
cd $HOME\smartsell; pnpm worker:release --win
```

macOS 的建置機（通常就是中樞）同樣適用：`cd ~/smartsell/apps/connector-desktop && node node_modules/electron/install.js && cat node_modules/electron/dist/version`。**不要**加 `--allow-electron-version`：那只給開發端離線的本機驗證，做出來的不是釘選版本。

**成功的樣子：**`dist\worker-release\` 有 `SmartSell-Worker-<版本>-win-x64.exe` 與 `latest-win-x64.json`。把兩個檔案放進中樞的 `<中樞資料夾>\worker-downloads\`（例如 `tailscale file cp dist\worker-release\* <中樞機器名>:`，再在中樞搬進該資料夾），然後在中樞跑 `pnpm hub:doctor`，不再出現「沒有 win-x64 的 Worker 安裝包」。

**失敗時：**`Electron … differs from the pinned …` → 照上面重新下載釘選版本；下載失敗 → 檢查網路後重跑；SmartScreen 沒有「仍要執行」→ 公司管理的電腦可能禁止未簽章程式，改用個人電腦。

### 3.3 安裝與配對（兩台都做）

1. 在那台機器的瀏覽器開中樞網頁「開始設定 → 下載 SmartSell Worker」，下載並安裝：
   - Mac-B：拖進「應用程式」，對 SmartSell Worker 按右鍵 →「打開」→「打開」（Gatekeeper，M1）。
   - Win-C：執行安裝程式，SmartScreen 顯示「Windows 已保護您的電腦」時按「其他資訊」→「仍要執行」（SmartScreen，M1）。
2. 選 **「發文的機器（Worker）」**，勾選「這台機器是我的，或我有權管理它；同意把它配對到這個中樞。」
3. 貼上中樞位址，替機器命名：**Mac-B**、**Win-C**（Codex 用這個名字找機器），按「配對」。
4. 瀏覽器會開中樞的配對頁，登入後按「授權並返回桌面程式」。
5. 在 Worker App 的「進階」打開「登入電腦時自動啟動 SmartSell」。
6. macOS 第一次（以及每次更新後）若跳出鑰匙圈提示，**在那台機器前按「永遠允許」**（M1：鑰匙圈）。按「拒絕」的話 Worker 無法簽章，網頁上只會看到它離線。

**成功的樣子：**網頁「機器」頁兩台都顯示「在線」，App 版本與作業系統正確。

### 3.4 重開機後自動上線（M1）

Mac-B：`sudo shutdown -r now`；Win-C：`Restart-Computer`。重開機並登入（或自動登入）後**不要手動開 App**，等一分鐘。

**成功的樣子：**「機器」頁兩台在一分鐘內回到「在線」。

**失敗時：**沒有回來 → 那台機器的 Worker App「進階」確認自動啟動有開；macOS 若卡在鑰匙圈提示，到機器前按「永遠允許」；Windows 在「工作管理員 → 啟動應用程式」確認 SmartSell Worker 是「已啟用」。

### 3.5 機器頁的警告

點進「機器 → Mac-B」與「機器 → Win-C」，「設定與警告」區塊逐條照提示處理：

| 警告 | 處理 |
|---|---|
| 會睡眠（`sleep_enabled`） | macOS：`sudo pmset -c sleep 0 disksleep 0`，並保持接電源；Windows：電源計畫「接上電源時睡眠：永不」 |
| 沒有自動登入（`no_auto_login`） | macOS：「系統設定 → 使用者與群組 → 自動登入」（FileVault 開啟時無法設定，見 1.1）；Windows：`netplwiz` 取消「必須輸入使用者名稱和密碼」 |
| 時鐘偏差（`clock_skew`） | 開啟「自動設定日期與時間」 |
| App 版本過舊（`app_outdated`） | 在那台機器的 Worker 按「更新」（第 12 步） |

**成功的樣子：**兩台都顯示「設定沒有問題。」

---

## 第 4 步：登入帳號

**在哪台機器：**Mac-B（X）、Win-C（TikTok），之後在網頁設定。

### 4.0 用你自己的 Chrome（建議，兩台都做）

1. Worker App「用哪個 Chrome 發文」→ 按 **「改用我自己的 Chrome（建議）」**。
2. 在那台機器平常用的 Chrome 開 `chrome://extensions`，打開右上角「開發人員模式」→「載入未封裝項目」→ 選 App 顯示的資料夾（「文件／SmartSell Worker／chrome-extension」）。
3. 在 SmartSell Worker 擴充功能按「詳細資料」，開啟「允許存取檔案網址」。

**成功的樣子：**App 顯示「已連上你的 Chrome（Chrome 1xx）」，以及「檢查過：SmartSell 操作時，網頁看到的 navigator.webdriver 是 false」。若顯示 true，記錄在驗收紀錄並回報（代表這個 Chrome 是用除錯參數啟動的）。

**失敗時：**一直顯示「還沒連上你的 Chrome」→ 確認擴充功能已啟用、Chrome 開著，再結束並重開 Worker（啟動時會重新向 Chrome 登記）；Windows 上仍不行，把 Worker「日誌」交給開發端（Windows 的原生訊息轉接還沒在實機驗證過）。維持「每個帳號一個獨立的 Chrome」也可以完成後面所有步驟。

### 4.1 新增帳號與帳號頁設定

1. Mac-B 的 Worker App：平台選 **X** → 按 **「新增帳號」**。用你自己的 Chrome 時會在「SmartSell」視窗開啟 X，已經登入就直接偵測到；獨立 Chrome 模式會開一個新的 Chrome 視窗。沒登入就**你自己登入**（驗證碼與二次驗證都由你完成）。
2. App 偵測到帳號後問「偵測到 X @<你的帳號>，加入 SmartSell？」：看過上面的自動化告知後按 **「加入」**。
3. Win-C 的 Worker App：平台選 **TikTok**，同樣登入並加入。
4. 在各自 App 的帳號列按 **「檢查登入」**。
5. 網頁「帳號」→ 點進每個帳號，設定：
   - **核准**：選「Agent 說要發就直接發」（direct）。
   - **代按發布**：勾選「我了解並接受上述風險，允許 Worker 在這個帳號代按發布」，輸入帳號名稱確認，按「同意並允許代按發布」。（若顯示「還不知道這個帳號的名稱」，先按「檢查登入」。）
   - **TikTok 平台預設**：第一次真實發布前，隱私設為「只有我」。
   - **遲到上限**：保留預設 30 分鐘。

**成功的樣子：**帳號頁的登入狀態為「已登入」（verified）；就緒清單除了「試跑通過」都打勾（試跑在第 5 步）；Worker App 的帳號列沒有「到點時請你按發布」的提示（代按發布已同意）。

**失敗時：**檢查登入結果不是已登入 → 帳號頁按「重新登入」（會在那台機器開出這個帳號的 Chrome 登入視窗，到那台機器登入），或在 Worker App 按「重新登入」；顯示「登入的不是這個帳號」→ 在那個 Chrome 視窗切回正確帳號；`HANDLE_UNKNOWN` → 先「檢查登入」再確認風險。

---

## 第 5 步：試跑與選擇器校準（M1）

**在哪裡：**網頁「帳號 → X @…」與「帳號 → TikTok @…」。

1. 「試跑」區塊，媒體保留「內建測試影片」，按 **「試跑一次」**。Worker 會走到「發布」前停下並捨棄草稿，**不會發出**。
2. 等結果出現在「試跑紀錄」（幾分鐘內）。
3. 點開試跑結果看截圖（發布前那一張）；再到「機器 → Mac-B（或 Win-C）」看 **「最近一次試跑步驟」**（`driver_trace`）。

**成功的樣子：**試跑紀錄為「試跑通過」；截圖中文案框、影片與（TikTok）隱私設定都正確；`driver_trace` 每一步都用主要選擇器，沒有標「後備」（fallback）；X 與 TikTok 上都沒有新貼文或草稿。

**有步驟走到後備，或試跑停在 `driver_outdated`（頁面可能改版）時——選擇器校準：**

1. 把「最近一次試跑步驟」中標後備或失敗的步驟名稱（例如 `x.post_button`、`tt.uploaded`）與截圖交給開發端（S6），由他們更新 `apps/connector-desktop/src/drivers/selectors.json`。
2. 開發端推送後，在中樞：

   ```bash
   cd ~/smartsell && pnpm hub:update
   ```

   它會把新的 `selectors.json` 複製到 `<中樞資料夾>/driver-config/`。**不必重裝 Worker**：下一次心跳 Worker 就會套用。
3. 「機器」頁的「選擇器資料版本」變成新版本後，再試跑一次，直到通過。

**失敗時：**試跑停在 `login_expired`／`captcha` → 到那台機器的 SmartSell Chrome 視窗處理後再試跑；`DRY_RUN_IN_PROGRESS` → 等上一次結束；`MACHINE_BINDING_REQUIRED` → 帳號還沒綁機器，回第 4 步。

---

## 第 6 步：第一次真實發布（低風險）

**主人決定的低風險做法（§12.3 第 3 題）：**TikTok 隱私先設「只有我」；X 發一則可以刪除的測試貼文。兩個帳號都已完成風險確認、核准方式為 direct（第 4 步）。

**在哪台機器：**筆電的 Codex。準備一支短的測試影片（例如 `test.mp4`），在它所在的資料夾開 Codex，輸入：

```
把 test.mp4 現在發到 Mac-B 的 X 和 Win-C 的 TikTok，文案：「SmartSell 測試，稍後刪除」
```

**成功的樣子：**

- Codex 回覆兩則貼文的機器、時間、狀態與網址（`web_url`），MCP 呼叫不超過 6 次。
- **5 分鐘內**兩則都變成「已發布」，貼文頁有平台網址。
- 五個頁面一致且互相連結：「今日」的「最近發出（24 小時內）」、「機器 → Mac-B／Win-C」的紀錄、「帳號」頁的貼文列表、「日曆」上的事件、貼文頁；從貼文頁點得到機器、帳號與日曆。
- 手機收到「已發布」推播；筆電的 SmartSell App 也跳出通知。

做完後到 X 刪除測試貼文；TikTok 的「只有我」影片可保留或刪除。

**失敗時：**狀態停在「要你處理」→ 看貼文頁的說明（驗證碼、登入過期等，到那台機器處理後會自動繼續）；「結果不明」→ 到平台看是否已發出，在貼文頁按「貼上網址（確認已發出）」或「確認沒發出」，系統**不會**自動重發；Codex 回 `INVALID_ARGUMENTS` 或呼叫超過 6 次 → 把 Codex 的對話記錄交給開發端（這是 §10.3 要修的介面問題）。

---

## 第 7 步：完整情境與 Codex 真實模型測試（M5）

### 7.1 主人的原句

**在哪台機器：**筆電的 Codex。在放著 `video.mp4`（約 30 MB 以上的真實影片）的資料夾開 Codex，輸入主人的原句：

```
把 video.mp4 明天 9:00 發到 Mac-B 的 X 和 Win-C 的 TikTok
```

**成功的樣子：**Codex 先看總覽、上傳影片，然後**問一次**要不要不帶文字發布（它不會自己編文案）；你回覆（「不帶文字」或給文案）後，它以**一次** `post_schedule` 排好兩則，回報兩則的本地時間、機器、狀態（已排程）與網址。網頁「今日」的「接下來 48 小時」出現一組內容、兩則貼文。第二天 9:00 到點後確認兩台都準時發出（貼文頁時間軸的發出時間在 9:00 後一兩分鐘內），手機收到兩則「已發布」。

**失敗時：**Codex 讀檔、做 base64 或用 curl 傳檔 → 違反 §7.5，記下對話交給開發端；上傳很慢、回覆 `continues_in_background` → 讓筆電保持不睡眠直到上傳完成（App 會接手續傳）；到點沒發出 → 看貼文頁的狀態與時間軸。

### 7.2 Codex 真實模型測試（`scripts/real-model-check.mjs --client codex`，M5 必要關卡）

開發機上沒有 Codex CLI，所以這一關由你在筆電上跑並存檔。測試**不碰中樞、不碰真實帳號**：它在筆電上啟動自己的測試中樞、兩個無頭 Chrome Worker（Mac-B、Win-C）與模擬的 X／TikTok 頁面，用 30 MB 測試影片，讓 Codex 跑兩個固定提示詞各 5 次。

**前置（筆電，一次）：**

```bash
git clone https://github.com/dp0304/smartsell.git ~/smartsell-check     # 已有原始碼就用既有的
cd ~/smartsell-check
pnpm install --frozen-lockfile
brew install ffmpeg                       # 產生測試影片；Windows 筆電見下方說明
codex --version                           # 確認 Codex CLI 已安裝
codex login                               # 已登入過就跳過
```

也需要 Google Chrome（無頭 Worker 用）。relay 的 bundle 沒建置時，腳本會先自己建置（`packages/agent-relay/scripts/build.mjs`）。

**執行：**

```bash
cd ~/smartsell-check
pnpm real-model-check -- --client codex --parallel 2
# 指定 Codex 模型：加 --model <完整模型 ID>，或寫進 tests/real-model/config.json 的 CODEX_MODEL_ID
```

腳本做的事：每一次都用全新的測試中樞；為 Codex 建一個暫存的 `CODEX_HOME`，其 `config.toml` 只有 `smartsell` 這個 MCP 伺服器與非互動核准（`approval_policy = "never"`、`sandbox_mode = "read-only"`），**不改你自己的 `~/.codex/config.toml`**；你的 Codex 登入檔 `~/.codex/auth.json` 以符號連結帶進暫存目錄（不讀、不複製）；Codex 的工作目錄是只放著 `video.mp4` 的暫存資料夾。約 5–15 分鐘。

**成功的樣子：**最後印出摘要表與 `GATE PASSED`，結束碼 0；P1 與 P2 各自 5 次中至少 4 次通過。結果檔 `tests/real-model/results/<時間>-codex.json`（每次的呼叫序列、錯誤、輪數、模型、Codex 版本與摘要表）。**把這個檔案交給開發端存檔**（或 commit）；原始的事件記錄在 `$TMPDIR/smartsell-real-model/<時間>-codex/`。

每次通過的條件（§10.3）：MCP 呼叫 ≤ 6 次；`INVALID_ARGUMENTS` 與 `TOOL_UNAVAILABLE` 都是 0；沒有讀媒體內容或 base64；P1 不編造文案（要嘛問要不要不帶文字發布，要嘛不帶任何文字排程）；有排程時兩則都在明天 9:00（Asia/Shanghai，即 01:00Z）、帳號正確、狀態「已排程」、附上影片，P2 的文案完全等於「新路亞實測 🎣 #fishing #lure」，最後回覆有兩則貼文的網址。

**失敗時：**

| 訊息 | 處理 |
|---|---|
| `codex CLI not found` | 安裝 Codex CLI，或加 `--codex-bin <路徑>`；腳本不會假裝跑過 |
| `harness error`：auth、login、401 | `codex login` 後重跑 |
| Codex 回報 `config.toml` 的鍵不認得（例如 `default_tools_approval_mode`） | 更新 Codex CLI 後重跑；仍不行就把錯誤訊息交給開發端 |
| MCP 呼叫的狀態是 declined、或一直要求核准 | 把結果檔與事件記錄交給開發端（暫存設定已是非互動核准） |
| `GATE FAILED` | 不要重跑到過為止：把結果檔與 `$TMPDIR/smartsell-real-model/<時間>-codex/` 整個資料夾交給開發端，由他們修 MCP 介面後再跑 |
| `Google Chrome is not installed` | 安裝 Chrome，或設 `SMARTSELL_CHROME_PATH` |

Windows 筆電：這個測試的模擬環境目前只在 macOS（與 Linux）上驗證過；Windows 筆電請改在任一台 Mac 上（裝好 Codex CLI 並登入）執行。

想順便重跑 Claude Code 的版本：`pnpm real-model-check`（使用 `tests/real-model/config.json` 的 `REAL_MODEL_ID`）。開發機已跑過並存檔，見 `docs/restructure/requests/S8-RM.md`。

---

## 第 8 步：中樞停機

**目的：**中樞在 9:00 前後停機，兩台機器照樣準時發出，中樞恢復後補回報（§5.7）。

1. 用 Codex 排一則**至少 45 分鐘以後**的貼文（TikTok 先維持「只有我」），記下時間 T。這樣機器在中樞停機前已經領取並在 T − 30 分鐘做完準備。
2. 在 **T − 5 分鐘**停掉中樞服務（在中樞上）：

   macOS（agent 模式）：

   ```bash
   launchctl bootout gui/$(id -u)/com.smartsell.hub
   curl -fsS http://127.0.0.1:3401/readyz || echo "中樞已停止"
   ```

   macOS（daemon 模式）：`sudo launchctl bootout system/com.smartsell.hub`

   Windows（系統管理員 PowerShell）：

   ```powershell
   schtasks /Change /TN "SmartSell Hub" /DISABLE
   schtasks /End /TN "SmartSell Hub"
   ```

3. 在 **T + 10 分鐘**再啟動：

   macOS（agent 模式）：

   ```bash
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.smartsell.hub.plist
   curl -fsS http://127.0.0.1:3401/readyz && echo OK
   ```

   macOS（daemon 模式）：`sudo launchctl bootstrap system /Library/LaunchDaemons/com.smartsell.hub.plist`

   Windows：

   ```powershell
   schtasks /Change /TN "SmartSell Hub" /ENABLE
   schtasks /Run /TN "SmartSell Hub"
   ```

**成功的樣子：**平台上的貼文時間在 T 前後一分鐘內（停機期間也照發）；連不上中樞約 10 分鐘後，Mac-B 與 Win-C 的 Worker App 跳出「中樞連不上」的通知；中樞恢復後一兩分鐘內，貼文頁變成「已發布」，時間軸寫明是離線開跑；手機收到「已發布」。

**失敗時：**沒有發出 → 看貼文頁時間軸與 Worker App：機器在停機前沒領取（排程太近）、帳號或機器在停機前被暫停、代按發布被撤回（會停在發布前）都是預期中不發的情況；其他情況把中樞的 `logs/` 與那台機器的 Worker 記錄交給開發端。`bootstrap` 回「already loaded」→ 服務已在跑，用 `launchctl kickstart -k gui/$(id -u)/com.smartsell.hub`。

---

## 第 9 步：撤回代按發布

1. 網頁「帳號 → X @…」→ 代按發布 → **「撤回同意」**。
2. 用 Codex 排下一則 X 貼文（至少 45 分鐘以後），時間 T。

**成功的樣子：**Codex 的回覆說明要你在 Mac-B 按發布（`owner_action`）；手機在 T − 30 分鐘與 T 各收到一則「T 要你在 Mac-B 按發布」；到 T 時 Mac-B 的 SmartSell Chrome 已填好內容並**停在發布前**，不會自己按。你在 Mac-B 按「發布」後，貼文頁變成「已發布」。不想發就在貼文頁按「取消這則」，Mac-B 會捨棄草稿。

做完後回帳號頁重新「同意並允許代按發布」。

**失敗時：**到點自己發出了 → 立即在「設定」暫停發布並把貼文頁截圖交給開發端（這是安全問題）；沒收到提醒 → 檢查第 2.2 步的推播設定與「設定 → 通知」的偏好。

---

## 第 10 步：機器離線超過遲到上限

1. 用 Codex 排一則 TikTok 貼文（至少 60 分鐘以後），時間 T。
2. 在「機器 → Win-C」確認佇列裡有這則（已領取）。
3. 在 **T − 40 分鐘**把 Win-C 關機（`Stop-Computer`），到 **T + 40 分鐘**（超過 30 分鐘遲到上限）後再開機。

**成功的樣子：**TikTok 上**沒有**補發；手機收到「沒有發出」，內容寫明 Win-C 與 TikTok 帳號；「今日」出現「沒有發出（機器當時沒開）」的卡片與「改到…」按鈕。按「改到…」選新時間，會重新排程並只發一則。

**失敗時：**Win-C 開機後補發了 → 這是不該發生的，截圖貼文頁與 TikTok 交給開發端；貼文顯示「未回報」→ 中樞無法證明機器沒開跑（例如關機時間太接近 T），等 Win-C 上線後它會自己回報。

---

## 第 11 步：登入過期

1. Win-C 的 Worker App → TikTok 帳號 → 「開啟 Chrome」，在 TikTok 登出，關掉視窗。
2. 等 **30 分鐘以上**（30 分鐘內檢查過登入的帳號會略過領取後的預檢）。
3. 用 Codex 排一則 24 小時內的 TikTok 貼文。

**成功的樣子：**排程後幾分鐘內（Win-C 領取後的預檢）手機收到通知，**指名 Win-C 與 TikTok @你的帳號**，說登入已過期；帳號頁登入狀態為「需要重新登入」；「今日」有「登入」卡片。到 Win-C 重新登入（帳號頁「重新登入」會在 Win-C 開出登入視窗，或在 Worker App 按「重新登入」），這則在期限前自動繼續。

**失敗時：**到點前都沒有通知 → 看「機器 → Win-C」是否在線、佇列是否已領取；仍沒有就把貼文頁時間軸交給開發端。

---

## 第 12 步：Worker 更新

**前提：**有比目前更新的 Worker 版本（開發端發布新版、`apps/connector-desktop/package.json` 的 version 變大）。不要在中樞的原始碼裡手改版本號，那會讓 `pnpm hub:update` 的 `git pull --ff-only` 失敗。

1. 在中樞：

   ```bash
   cd ~/smartsell && pnpm hub:update
   pnpm worker:release      # 在中樞上預設寫進 <中樞資料夾>/worker-downloads（mac-arm64 與 mac-x64）
   pnpm hub:doctor          # 列出 worker-downloads 的平台與新版本
   ```

   （Windows 安裝包照第 3.2 步在 Win-C 重建並放進 `worker-downloads`。）
2. 等 Mac-B 的下一次心跳（約一分鐘）。

**成功的樣子：**Mac-B 的 Worker App 出現「SmartSell Worker <新版本> 可更新」；**在 Mac-B 前**按「更新」；更新後若跳出鑰匙圈提示，按「永遠允許」；App 重新啟動後自動上線，「機器」頁的 App 版本變成新版本。

**失敗時：**沒有出現「可更新」→ `pnpm hub:doctor` 確認新版本已列出；Intel Mac 需要 mac-x64 的安裝包；顯示「有貼文正在發布，結束後才能更新」→ 等那則結束；更新後一直離線 → 多半是鑰匙圈提示被拒絕，到機器前重新開 App 並按「永遠允許」。

---

## 第 13 步：遙控瀏覽器（選做，E50）

**在哪裡：**網頁「機器 → Mac-B」，以及筆電的 AI 助手。前提：Mac-B 已完成 4.0（你自己的 Chrome）。

1. 機器頁「遙控」勾選「允許操作這台機器的 Chrome」，允許的網站填一個你自己的後台網域（例如 `seller.shopee.tw`），按「儲存」。
2. 半分鐘內 Mac-B 的 Worker App 出現「遙控」卡片，列出這個網站。
3. 對 AI 助手說：「到 Mac-B 的 <後台網址> 看一下 <某商品> 目前的庫存，先不要改。」
4. 再說：「打開 https://example.com」（不在清單的網站）。
5. （選做）請它改一個無關緊要的值，例如某個測試商品的庫存。

**成功的樣子：**第 3 步回報看到的內容，Mac-B 的 Chrome 出現「SmartSell」視窗，你正在看的分頁沒有被動到；第 4 步被拒絕（`SITE_NOT_ALLOWED`）；第 5 步改完它會自己讀回確認；遇到登入或驗證碼它停下來請你處理。

**失敗時：**`REMOTE_CONTROL_OFF` → 第 1 步沒有儲存；說這台機器沒有用你自己的 Chrome → 回到 4.0。

## 第 14 步：Android 手機（選做）

**在哪裡：**Mac-B（或任何一台 Worker）與一支 Android 手機。

1. 在 Mac-B 安裝 adb：`brew install android-platform-tools`（Windows：`winget install Google.PlatformTools`）。
2. 手機開啟「開發人員選項 → USB 偵錯」，用 USB 接上 Mac-B，手機跳出提示時按「允許」。在 Mac-B 的終端機執行 `adb devices`，應看到一行 `device`。
3. 機器頁「遙控」勾選「允許操作插在這台機器的 Android 手機」，允許的 App 填 `com.xingin.xhs`（小紅書，或你要試的 App 套件名稱），按「儲存」。
4. 對 AI 助手說：「在 Mac-B 的手機打開小紅書，把首頁畫面給我看，不要發任何東西。」
5. 再說：「打開手機的設定 App」（不在清單）。

**成功的樣子：**第 4 步回報首頁畫面；第 5 步被拒絕（`APP_NOT_ALLOWED`），手機回到主畫面；遇到付款或受保護的畫面時它停下來請你處理。目前只能輸入英數，需要中文時它會請你在手機上打。

**失敗時：**「找不到 adb」→ 第 1 步，裝好後重試即可；`UNAUTHORIZED` → 在手機上按「允許 USB 偵錯」；`NO_DEVICE` → 換一條傳輸線或 USB 埠，再看 `adb devices`。

---

## 出問題時要附的資料

- 中樞：`pnpm hub:doctor` 的完整輸出、`<中樞資料夾>/status.json`、`<中樞資料夾>/logs/` 中當天的檔案。
- 貼文：貼文頁網址與時間軸截圖（貼文頁顯示的內容不含帳號密碼）。
- 機器：Worker App 的畫面截圖、「機器」頁的「最近一次試跑步驟」。
- 真實模型測試：`tests/real-model/results/<時間>-<client>.json` 與 `$TMPDIR/smartsell-real-model/<時間>-<client>/`。
- 不要附：`hub.env`、`~/.codex/auth.json`、任何 token 或密碼。

## 驗收紀錄

| # | 項目 | 日期 | 結果（通過／失敗） | 備註 |
|---|---|---|---|---|
| 1 | 中樞安裝、`hub:doctor` 0 錯誤、筆電開得了 ts.net 網址 | | | |
| 1.3 | M1：真實 `tailscale serve` 指到 `127.0.0.1:3401` | | | |
| 1.6 | M1：中樞重開機後自動啟動（launchd／排程工作） | | | |
| 2 | 筆電與手機：Tailscale、推播測試、Codex 連上 smartsell | | | |
| 3.2 | M1：Win-C 建置 NSIS 安裝包；釘選 Electron 45.4.1（E16） | | | |
| 3.3 | M1：Gatekeeper「打開」、SmartScreen「仍要執行」、鑰匙圈「永遠允許」 | | | |
| 3.4 | M1：Mac-B、Win-C 重開機後自動上線 | | | |
| 4.0 | 你自己的 Chrome：擴充功能已連上，navigator.webdriver 為 false（Mac-B、Win-C） | | | |
| 4 | X、TikTok 登入，檢查登入為已登入，direct 與風險確認 | | | |
| 5 | 試跑通過；選擇器沒有走後備（或已校準並 `hub:update`） | | | |
| 6 | 第一次真實發布：5 分鐘內網址回來、五頁一致、手機收到 | | | |
| 7.1 | Codex 主人原句：問一次文案、一次排好、明天 9:00 準時發出 | | | |
| 7.2 | M5：`pnpm real-model-check -- --client codex` 結果 `GATE PASSED`，結果檔已存 | | | |
| 8 | 中樞停機：準時發出、恢復後回報 | | | |
| 9 | 撤回代按：提醒、停在發布前 | | | |
| 10 | 機器離線超過上限：沒有補發、收到「沒有發出」、可改期 | | | |
| 11 | 登入過期：幾分鐘內收到指名機器與帳號的通知 | | | |
| 12 | Worker 更新：可更新、更新後自動上線 | | | |
| 13 | 遙控瀏覽器（選做）：只在允許的網站操作、範圍外被拒絕、改完自己讀回 | | | |
| 14 | Android 手機（選做）：看得到畫面、範圍外的 App 被拒絕 | | | |
