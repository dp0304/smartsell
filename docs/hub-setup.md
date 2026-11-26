# SmartSell 中樞安裝與維護

這一頁依序列出設定中樞（hub）的命令、預期輸出，以及每一種失敗的處理方式。寫法讓 Codex 或 Claude Code 可以照著替你操作；每一步都標明在哪一台機器上做。

中樞是一台常開的家用機器（macOS 或 Windows）。它只在本機 `127.0.0.1:3401` 提供服務，對外一律經由 `tailscale serve` 的 `https://<機器>.<tailnet>.ts.net`。資料、媒體與設定都在中樞資料夾：

| 系統 | 中樞資料夾 |
|---|---|
| macOS | `~/Library/Application Support/SmartSell Hub` |
| Windows | `%LOCALAPPDATA%\SmartSell Hub` |
| Linux | `~/.local/share/smartsell-hub` |

資料夾內容：`hub.env`（設定，權限 0600）、`smartsell.sqlite`（資料）、`backups/`（資料的每日備份與更新前備份，見第 6a 節）、`media/`、`worker-downloads/`（Worker 安裝包）、`driver-config/`（選擇器資料檔）、`logs/`、`status.json`（最後一次啟動的結果）。

中樞只該在你的 tailnet 內使用：**不要對中樞開啟 Tailscale Funnel**（第 2a 節）。

---

## 1. 一鍵安裝（在中樞上）

還沒有原始碼時，先取得一份（需要 git）：

```bash
git clone https://github.com/dp0304/smartsell.git ~/smartsell     # GitHub（分支 main）
git clone https://gitee.com/yueshutech/smartsell.git ~/smartsell  # 或 Gitee（分支 master，內容相同）
cd ~/smartsell
```

### macOS

```bash
bash scripts/install-hub.sh                 # 已有原始碼時，在原始碼資料夾執行
# 或指定位置與來源：
bash scripts/install-hub.sh --dir ~/smartsell --repo https://github.com/dp0304/smartsell.git --branch main
# 從 Gitee 鏡像安裝：--repo https://gitee.com/yueshutech/smartsell.git --branch master
bash scripts/install-hub.sh --check-only    # 只檢查前置軟體，不做任何變更
```

### Windows（PowerShell）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1
powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1 -Mode boot   # 建議：無人登入也會執行
powershell -ExecutionPolicy Bypass -File scripts\install-hub.ps1 -CheckOnly
```

安裝腳本依序執行下面第 2–5 節。它**不會替你安裝系統軟體**：缺少時會印出確切的命令，你自己執行後重跑即可。

預期輸出（節錄）：

```
==> 1/6 檢查前置軟體
    [OK] git
    [OK] Node.js 24
    [缺少] ffmpeg / ffprobe：請執行  brew install ffmpeg
```

任何一步失敗時會印出：

```
[失敗] 命令：pnpm install --frozen-lockfile
       原因：pnpm install失敗（結束碼 1）
       下一步：看上面的錯誤訊息；網路問題時重跑即可
```

| 前置軟體 | macOS | Windows |
|---|---|---|
| git | `xcode-select --install` | `winget install --id Git.Git -e` |
| Node.js 24（含 corepack） | `brew install node@24 && brew link --overwrite --force node@24` | `winget install --id OpenJS.NodeJS -e --version 24.*` |
| ffmpeg（ffprobe） | `brew install ffmpeg` | `winget install --id Gyan.FFmpeg -e` |
| Tailscale | App Store 安裝並登入（或 `brew install --cask tailscale`） | `winget install --id Tailscale.Tailscale -e` |

## 2. 首次設定：`pnpm hub:init`（在中樞上，可以重跑）

```bash
pnpm hub:init                 # 互動式
pnpm hub:init --yes           # 每一題都回答「是」
pnpm hub:init --no-service --no-worker-release --skip-web-build
```

它會：

1. 建立中樞資料夾（權限 0700）。
2. 找到 Tailscale CLI（macOS：`/Applications/Tailscale.app/Contents/MacOS/Tailscale` 或 PATH；Windows：`%ProgramFiles%\Tailscale\tailscale.exe`）。非標準位置可設 `SMARTSELL_TAILSCALE_CLI=<路徑>`。
3. 執行 `tailscale status --json`，讀出這台機器的 `https://<DNSName>`。
4. 執行 `tailscale serve --bg --https=443 http://127.0.0.1:3401`，再用 `tailscale serve status --json` 確認。
5. 提醒關閉節點金鑰到期。
6. 產生 `APP_SECRET`、`SETUP_TOKEN`，連同 `PUBLIC_ORIGIN`、`PORT=3401` 寫入 `hub.env`；已存在的值保留，不覆蓋。
7. 建置 Web（`dist` 已是最新則略過），再建置 relay：`pnpm --filter @smartsell/agent-relay build`（見第 4b 節；失敗只警告，不中止）。
8. 詢問是否執行 `pnpm worker:release`。
9. 詢問是否安裝為服務。
10. 印出首次設定網址。

預期輸出的最後兩行：

```
[10/10] 在已加入 tailnet 的瀏覽器開啟下面的網址，建立擁有者帳號（建立後這個網址就會失效）：
https://hub.tail1234.ts.net/setup#setup-token=<64 位十六進位>
```

| 失敗訊息 | 處理 |
|---|---|
| 找不到 Tailscale | 安裝並登入 Tailscale 後重跑 |
| Tailscale 目前不是連線狀態（NeedsLogin） | 開啟 Tailscale App 登入後重跑 |
| 讀不到這台機器的 Tailscale 名稱 | Tailscale 管理後台 → DNS → 啟用 MagicDNS |
| 請到 Tailscale 管理後台 → DNS → 啟用 MagicDNS 與 HTTPS Certificates | 照做後重跑 `pnpm hub:init` |
| 提醒：……會寫進公開的憑證透明度紀錄 | 機器名稱含個人資訊（例如姓名）時，先到管理後台把機器改名為中性的名字（例如 `hub`），再重跑 |
| hub.env 的 PUBLIC_ORIGIN 是 A，但這台機器的 Tailscale 網址是 B | 機器改過名稱：編輯 `hub.env` 的 `PUBLIC_ORIGIN`，所有 Worker 重新配對 |
| Web 建置失敗 | 看上面的錯誤；通常是 `pnpm install` 沒跑完，重跑 `pnpm install --frozen-lockfile` |
| [警告] relay 建置失敗 | 中樞照常啟動，但 `GET /agent/relay.mjs` 回 503 `RELAY_BUNDLE_MISSING`；修正後執行 `pnpm --filter @smartsell/agent-relay build`（第 4b 節） |

### 2a. 不要開啟 Tailscale Funnel

`tailscale funnel` 會把中樞公開到整個網際網路：任何人都能連到登入頁、Worker 配對與 Agent 連線端點。SmartSell 的設計是只有 tailnet 內的機器連得到中樞，所以推播連結在手機上打不開時，請讓手機加入 tailnet，而不是開 Funnel。

中樞每 10 分鐘檢查一次 `tailscale serve status --json`；只要有 Funnel 讓中樞的連接埠對外公開（`AllowFunnel`），就會：

- 在中樞的紀錄（`logs/hub.out.log`）寫一行 `[警告] 中樞被 Tailscale Funnel 公開到網際網路……`；
- `/api/v1/hub/info` 的 `tailscale.funnel_on` 為 `true`，`tailscale.funnel_warning` 是給你看的說明（開始設定精靈會顯示）；
- `pnpm hub:doctor` 印出 `[錯誤]`（結束碼 1）；`pnpm hub:service status` 與 `pnpm hub:init` 也會提醒。

處理方式：

| Funnel 在哪個連接埠 | 命令 |
|---|---|
| 443（中樞的網址） | `tailscale serve --bg --https=443 http://127.0.0.1:3401`（以 serve 重新設定 443 就會關閉 Funnel、只留在 tailnet 內），或重跑 `pnpm hub:init` |
| 8443 或 10000 | `tailscale funnel --https=8443 off`（或 10000） |

改完後執行 `pnpm hub:doctor`，應看到 `[OK] 沒有開啟 Tailscale Funnel（中樞只在 tailnet 內）`。

**Tailscale 管理後台要做的事（只做一次）：**DNS → 啟用 MagicDNS 與 HTTPS Certificates；Machines → 對中樞與每一台 Worker 選 **Disable key expiry**（金鑰預設 180 天到期，到期後機器會默默離開 tailnet）。主人的筆電與手機也要加入同一個 tailnet，網頁與通知中的連結才打得開。Worker 機器不要設定 exit node。

`hub.env` 只接受這些鍵：`APP_SECRET`、`SETUP_TOKEN`、`PUBLIC_ORIGIN`、`PORT`、`SMARTSELL_DATA_FILE`、`MEDIA_DIRECTORY`、`SMARTSELL_MAX_UPLOAD_BYTES`、`SMARTSELL_WEB_DIST`。其他鍵會被忽略並在啟動時提示。

## 3. 安裝為服務：`pnpm hub:service install`（在中樞上）

```bash
pnpm hub:service install                 # macOS 預設 --mode agent；Windows 預設 --mode logon
pnpm hub:service install --mode daemon   # macOS：無人登入也能執行（需要 sudo）
pnpm hub:service install --mode boot     # Windows：開機就執行（建議）
pnpm hub:service install --dry-run       # 只印出會寫的檔案與會執行的命令
pnpm hub:service status
pnpm hub:service uninstall
```

`install` 先執行 `node --import tsx apps/server/hub.ts --check --hub-dir <中樞資料夾> --load`（設定檢查，再以這個版本載入全部程式、讀一份資料的副本），不通過就拒絕安裝。

| 模式 | 檔案 | 啟動時機 |
|---|---|---|
| macOS `agent` | `~/Library/LaunchAgents/com.smartsell.hub.plist`（`launchctl bootstrap gui/$UID`） | 使用者登入後 |
| macOS `daemon` | `/Library/LaunchDaemons/com.smartsell.hub.plist`（`UserName` 為你的帳號，需要 sudo） | 開機後（FileVault 關閉時） |
| Windows `logon` | 工作排程器「SmartSell Hub」，LogonTrigger，動作是 `hub.ts --supervise` | 使用者登入後 |
| Windows `boot` | 工作排程器「SmartSell Hub」，BootTrigger，不論使用者是否登入，動作是 `hub.ts --supervise` | 開機後 |

**崩潰後誰重新啟動中樞：**

- **macOS：**launchd 的 `KeepAlive{SuccessfulExit:false}`，非 0 結束後約 10 秒（`ThrottleInterval`）重新啟動。
- **Windows：**工作排程器的 `RestartOnFailure` 只會重試「啟動失敗」的工作；程式啟動後才以非 0 結束（崩潰、記憶體不足、開機時連接埠被占用）會被記成「已完成」，不會重跑。所以排程工作執行的是小型監督程序 `hub.ts --supervise`：它把中樞當子程序執行，非 0 結束時 10 秒後重啟，之後每次加倍、最多 5 分鐘（連續執行 10 分鐘後重設）；中樞以碼 0 結束（設定錯誤或正常停止）時監督程序也結束，不會重啟迴圈。監督程序被停止（`schtasks /End`）時，中樞會跟著正常停止。舊版安裝的排程工作沒有 `--supervise`，`pnpm hub:doctor` 會印出 `[錯誤] 排程工作是舊版設定`：重跑 `pnpm hub:service install --mode boot`（或 `--mode logon`）即可。

**Node 路徑（macOS）：**Homebrew 的 node 實際位置帶版本號（例如 `/opt/homebrew/Cellar/node@24/24.11.0/bin/node`），`brew upgrade` 會刪除舊版本。`install` 寫入服務設定檔的是不隨版本變動的 `/opt/homebrew/opt/node@24/bin/node`。舊版安裝留下帶版本號的路徑時，`pnpm hub:doctor` 會警告（路徑已不存在時是錯誤），`pnpm hub:update` 會自動改寫服務設定檔；也可以重跑 `pnpm hub:service install`。

- **FileVault（macOS）：**開啟時，Mac 重開機後要有人在開機畫面輸入密碼解鎖磁碟，在那之前任何服務都不會執行，也無法設定自動登入。`install` 會以 `fdesetup status` 偵測並請你選擇：（1）關閉 FileVault 並開啟自動登入或用 `--mode daemon`；（2）保持 FileVault，接受斷電後到場輸入密碼並加 UPS，計畫內重開機用 `sudo fdesetup authrestart`；（3）改用 Windows 中樞。
- **daemon 模式**需要 `tailscaled` 以系統服務執行：`brew install tailscale`、`sudo brew services start tailscale`（取代 Tailscale App），然後重跑 `pnpm hub:init`。
- **Windows boot 模式**建立工作時，Windows 會要求輸入你的 Windows 密碼：在提示中自己輸入，安裝腳本不經手。
- **睡眠：**macOS `sudo pmset -c sleep 0 disksleep 0`；筆電要接電源並設定闔蓋不睡眠。Windows 電源計畫設定「接上電源時睡眠：永不」。
- **設定錯誤不會重啟迴圈：**中樞發現設定錯誤時寫入 `status.json`（`{"state":"config_error","message":…}`）並以碼 0 結束；launchd 的 `KeepAlive{SuccessfulExit:false}`、Windows 的監督程序與工作排程器的 `RestartOnFailure` 都不會因碼 0 重啟。修正後執行 `pnpm hub:service install`（或 macOS `launchctl kickstart -k gui/$UID/com.smartsell.hub`）。

預期輸出：

```
[OK] 中樞設定檢查通過（/Users/you/Library/Application Support/SmartSell Hub）；程式與資料都能以這個版本載入
寫入 /Users/you/Library/LaunchAgents/com.smartsell.hub.plist
載入 LaunchAgent 並立即啟動：launchctl bootstrap gui/501 /Users/you/Library/LaunchAgents/com.smartsell.hub.plist
等待中樞回應 http://127.0.0.1:3401/readyz …
中樞服務已安裝（agent）並在執行中。
```

## 4. 首次設定精靈（在任何一台已加入 tailnet 的機器的瀏覽器）

開啟第 2 節印出的 `https://<ts.net>/setup#setup-token=…`，建立擁有者帳號；之後依精靈設定時區、連接機器（在要發文的機器安裝 SmartSell Worker，貼上中樞位址）、新增帳號與通知。`/setup` 在首位擁有者建立後回 409，網址即失效。

Worker 安裝包由中樞提供下載（`/api/v1/worker-downloads/<mac-arm64|mac-x64|win-x64>`）。建置方式：

```bash
pnpm worker:release --out "<中樞資料夾>/worker-downloads"   # 在中樞（macOS）上：mac-arm64、mac-x64
pnpm worker:release --win                                    # 在 Windows 機器（例如 Win-C）上：win-x64
```

**發行簽章金鑰：**`pnpm worker:release` 會以 Ed25519 私鑰替每個安裝包的 `latest-<platform>.json` 簽章，並把公鑰內建進 Worker；Worker 只安裝簽章驗證通過的更新（安全審核 S1）。私鑰預設在建置機的 `~/.smartsell/worker-release-key.pem`（第一次執行自動建立，權限 0600），或以 `SMARTSELL_RELEASE_SIGNING_KEY=<PEM 路徑>` 指定；不可放在原始碼資料夾內。**請備份這個檔案，並在每台建置機（包括 Windows）用同一把**：換了金鑰或遺失，已安裝的 Worker 會拒絕更新（更新卡片顯示「發行簽章驗證失敗」），只能手動重新安裝。`pnpm hub:doctor` 會對沒有簽章的安裝包發出警告。

**用 GitHub Actions 建置（選用）：**`.github/workflows/release.yml` 在推送 `worker-v<版本>` 標籤時，於 macOS 與 Windows 執行器建置三個安裝包，連同 `latest-*.json` 放進一個**草稿** Release（按 Publish 之前不公開）。先把上面的私鑰內容存成倉庫的 secret `SMARTSELL_RELEASE_SIGNING_KEY_PEM`；沒有這個 secret 時標籤建置會直接失敗，以免每次建置內建不同的公鑰。標籤要和 `apps/connector-desktop/package.json` 的版本一致，例如 `git tag worker-v0.3.0 && git push github worker-v0.3.0`。下載 Release 的檔案放進中樞的 `worker-downloads/` 即可。

第 1 階段的安裝包沒有作業系統的程式碼簽章：macOS 第一次開啟時請在 Finder 對 App 按右鍵 →「打開」（Gatekeeper，較新的 macOS 要到「系統設定 → 隱私權與安全性」按「強制打開」）；Windows 出現 SmartScreen 時按「其他資訊」→「仍要執行」。macOS 每次更新後可能再跳出鑰匙圈授權提示，請留在那台機器前按「永遠允許」，否則 Worker 無法連線（會發出通知）。舊版 SmartSell Connector 的配對不會帶過來，要在新的 Worker 重新配對。

Windows 安裝包只能在 Windows 機器上建置，步驟見第 4a 節。

Worker 每次心跳都回報自己的 CPU（`arch`），中樞依此在「有新版本」提示中給對應的安裝包：Apple silicon 的 Mac 拿 `mac-arm64`、Intel Mac 拿 `mac-x64`、Windows 拿 `win-x64`；舊版 Worker 沒有回報時，macOS 視為 arm64（E9）。所以兩種 Mac 都要有安裝包，Intel Mac 才收得到更新。

### 4a. Windows 安裝包（在 Win-C 建置一次）

1. 在 Win-C 以系統管理員開啟 PowerShell，安裝：`winget install --id Git.Git -e`、`winget install --id OpenJS.NodeJS -e --version 24.*`，重新開啟 PowerShell 後 `corepack enable`。
2. `git clone <repo> smartsell`、`cd smartsell`、`pnpm install --frozen-lockfile`。把中樞那台建置機的 `~/.smartsell/worker-release-key.pem` 複製到 Win-C（例如 `%USERPROFILE%\.smartsell\worker-release-key.pem`），讓兩個平台用同一把發行金鑰；不複製時 Win-C 會自己建立一把，Windows 的 Worker 之後就只認那一把。
3. `pnpm worker:release --win`：產生 `dist\worker-release\SmartSell-Worker-<version>-win-x64.exe` 與 `latest-win-x64.json`（未簽章 NSIS，每位使用者安裝，不需要系統管理員）。第一次會下載對應版本的 Electron（安裝包一律使用 package.json 釘選的 Electron 版本，E16；本機沒有時在建置機上執行一次 `node node_modules/electron/install.js`）。
4. 把這兩個檔案複製到中樞的 `<中樞資料夾>\worker-downloads\`（例如 `tailscale file cp dist\worker-release\* <hub>:`，再在中樞把它們搬進該資料夾）。中樞的「開始設定 → 下載 SmartSell Worker」就會列出 win-x64；`pnpm hub:doctor` 也會列出它的版本。
5. 在 Win-C 執行安裝程式：SmartScreen 顯示「Windows 已保護您的電腦」時按「其他資訊」→「仍要執行」。安裝完成後 SmartSell Worker 會自動開啟。
6. 驗收（M1）：配對並命名、機器頁顯示在線與 posture 警告、重開機後自動上線。

**macOS 安裝包**：在 Mac 上執行 `pnpm worker:release`（arm64 與 x64 的 dmg + zip）。第一次開啟：在「應用程式」對 SmartSell Worker 按右鍵 →「打開」。更新後第一次啟動若出現鑰匙圈提示，按「永遠允許」，否則 Worker 無法連線。舊版 SmartSell Connector 的配對不會帶過來，要重新配對。

| 失敗訊息 | 處理 |
|---|---|
| `Electron … differs from the pinned …` | 不要加 `--allow-electron-version`（那只給離線的本機驗證）；改用釘選的版本重建 |
| `Pinned Electron runtime is missing` 或下載失敗 | 檢查網路後重跑 |
| SmartScreen 沒有「仍要執行」 | 公司管理的電腦可能禁止未簽章程式；請改用個人電腦或請管理員放行 |

舊的 `pnpm package:worker-download`（產生 `SmartSell Connector.app` 的 `--local-dir` 流程）已移除，一律改用 `pnpm worker:release`。

### 4b. relay 套件（筆電連 Codex／Claude Code 用）

中樞在 `GET /agent/relay.mjs` 提供 relay 的單檔 bundle（不需要登入），網頁 Agent 頁的備援說明與 Windows 筆電的 Node relay 都從這裡下載。它是 `packages/agent-relay/dist/smartsell-relay.mjs`，由下面任一個步驟建置：

- `pnpm hub:init`（第 2 節第 7 步；失敗只警告）
- `pnpm hub:update`（第 6 節第 2 步；失敗就不重啟服務）
- `scripts/install-hub.sh`／`install-hub.ps1`（第 4 步）
- 手動：`pnpm --filter @smartsell/agent-relay build`

bundle 不需要另外安裝套件（借用 `apps/connector-desktop` 釘選的 esbuild）。還沒建置時，`GET /agent/relay.mjs` 回 503 `RELAY_BUNDLE_MISSING`，`details.owner_message` 寫明上面的手動命令。檢查：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3401/agent/relay.mjs   # 200 表示已建置，503 表示還沒建置
```

筆電上的 SmartSell App 重新連接同一台筆電時，會用舊連線自己的 token 呼叫 `DELETE /api/v1/agent-connections/self` 撤銷舊連線（E13，只能撤銷自己，會寫入活動紀錄）；網頁的 Agent 頁也可以手動撤銷。

## 5. 健檢：`pnpm hub:doctor`（在中樞上）

每一項問題印一行可以照做的說明，有錯誤時結束碼為 1：

```
[OK] /readyz 正常（http://127.0.0.1:3401）
[OK] tailscale serve：443 → http://127.0.0.1:3401
[警告] 中樞的 Tailscale 節點金鑰將在 2026-12-10 到期（剩 16 天）。請到 Tailscale 管理後台 → Machines，對這台機器選 Disable key expiry。
[警告] FileVault 已開啟：……
[警告] 沒有 win-x64 的 Worker 安裝包。請執行 pnpm worker:release（Windows 安裝包要在 Windows 機器上建置）……
有 0 個錯誤、3 個警告。
```

檢查項目：設定與啟動檢查（同 `hub.ts --check`）、服務狀態與 `status.json`、服務設定檔的 Node 路徑還在不在（macOS）、`/readyz`、`tailscale serve`、Tailscale Funnel（開啟時是錯誤，第 2a 節）、HTTPS 憑證、節點金鑰到期（30 天內警告）、ffprobe、最新的資料備份（沒有或超過 48 小時警告，第 6a 節）、磁碟剩餘空間（少於 10 GB 警告）、macOS 的 FileVault／自動登入／`pmset -g` 睡眠、Windows 的電源計畫睡眠、排程工作觸發條件與是否由監督程序執行、`worker-downloads` 的平台與版本。

## 6. 更新：`pnpm hub:update`（在中樞上）

```bash
pnpm hub:update
pnpm hub:update --skip-pull     # 原始碼已經更新過時
pnpm hub:update --no-restart
```

依序：

| 步驟 | 做什麼 |
|---|---|
| 0/6 | 記下目前的版本（`git rev-parse HEAD`），並把資料複製到 `backups/pre-update-<時間>.sqlite` |
| 1/6 | `git pull --ff-only` |
| 2/6 | `pnpm install --frozen-lockfile`、建置 relay（第 4b 節） |
| 3/6 | 檢查 Web 型別，把 Web 建置到暫存資料夾（還不替換正在使用的 `dist`） |
| 4/6 | `hub.ts --check --load`：以**新版本**檢查設定、載入全部模組與操作（正式模式，缺模組就算失敗），並讀一份資料的副本；不啟動、不碰原資料檔 |
| 5/6 | 檢查通過才替換 `dist`，並把 `apps/connector-desktop/src/drivers/selectors.json` 複製到 `<中樞資料夾>/driver-config/`（Worker 下一次心跳就會更新選擇器） |
| 6/6 | 重新啟動服務，等**新的**中樞程序在 `/readyz` 回應 |

**第 2–4 步任何一步失敗：**原始碼回到更新前的版本（`git reset --keep`，你自己改過的檔案保留不動）、相依套件以 `pnpm install --frozen-lockfile --offline` 裝回（網路不通也可以）、relay 重建，`dist` 與選擇器都沒有動。服務沒有重新啟動，舊版本繼續執行，**下次重開機或崩潰後執行的也是舊版本**：

```
[失敗] 3/6 建置 Web失敗（結束碼 1）。
原始碼已回到 1a2b3c4d5e6f（git reset --keep，你自己改過的檔案保留不動）。
相依套件與 relay 已回到更新前的版本。
中樞服務沒有重新啟動，舊版本繼續執行；原始碼與相依套件已回到更新前的版本（1a2b3c4d5e6f），重開機後也會執行它。
```

**新版本重新啟動後 60 秒內沒有回應：**自動停止服務，把原始碼、相依套件、`dist`、選擇器換回更新前的版本；若新版本已經改過資料，資料檔換回第 0 步的備份，新版本寫過的檔案改名保留為 `smartsell.sqlite.failed-update-<時間>`（不刪除）；再啟動服務並確認舊版本回應：

```
[失敗] 新版本在 60 秒內沒有回應。……
自動回到更新前的版本 1a2b3c4d5e6f…
新版本改過資料，已換回更新前的備份；新版本寫過的資料保留在 …/smartsell.sqlite.failed-update-20261124T090500Z（沒有刪除）。
[已回復] 中樞已回到更新前的版本 1a2b3c4d5e6f 並在執行中，更新沒有套用。請把上面的錯誤告訴開發者，或執行 pnpm hub:doctor。
```

- `--skip-pull`：原始碼是你自己更新的，`hub:update` 不知道更早的版本，失敗時只能把相依套件、`dist` 與選擇器換回，原始碼維持現狀（會印出說明）。
- `--no-restart`：第 5 步之後就結束；網頁已是新版，伺服器要等你重新啟動服務才會換成新版本。
- macOS 服務設定檔指向的 Node 已被 `brew upgrade` 刪除（或帶版本號）時，第 6 步會先改寫服務設定檔再載入（第 3 節）。Windows 的排程工作還是舊版設定時，會提醒你重新安裝服務。

### 6a. 資料備份與還原

- **每日備份：**中樞啟動一分鐘後檢查一次，之後每小時檢查；當天還沒有備份就以 SQLite 的 `VACUUM INTO` 寫一份一致的副本 `backups/smartsell-<日期>.sqlite`（權限 0600，資料夾 0700），保留最新 7 份。備份失敗只會在紀錄寫一行 `[警告] 每日備份失敗，一小時後再試`，不會停止中樞。
- **更新前備份：**`pnpm hub:update` 第 0 步寫 `backups/pre-update-<時間>.sqlite`，保留最新 3 份（不會擠掉每日備份）。
- **macOS 的寫入保證：**中樞的 SQLite 連線開啟 `fullfsync`，資料確實寫到磁碟上才算完成（一般 `fsync` 在 macOS 不會清掉磁碟的寫入快取，斷電可能遺失剛寫入的資料）。仍建議中樞加裝 UPS。
- `pnpm hub:doctor` 會列出最新的備份；沒有備份或超過 48 小時是警告。
- 備份與資料在同一顆磁碟：它防的是資料損毀與更新失敗，不防磁碟故障。請偶爾把 `backups/` 與 `hub.env` 複製到別的地方（例如 Time Machine 或隨身碟）。`hub.env` 的 `APP_SECRET` 是解開推播 token 等加密欄位的鑰匙，要和備份一起保存；`media/` 不在備份內。

**手動還原（在中樞上）：**

1. 停止服務：macOS `launchctl bootout gui/$UID/com.smartsell.hub`（daemon 模式：`sudo launchctl bootout system/com.smartsell.hub`）；Windows `schtasks /End /TN "SmartSell Hub"`。
2. 把現在的資料檔改名留著（例如 `smartsell.sqlite.before-restore`，連同同名的 `-journal` 檔），再把要用的備份複製成 `smartsell.sqlite`，權限設為 600（`chmod 600 smartsell.sqlite`）。
3. 啟動服務：macOS `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.smartsell.hub.plist`（daemon：`sudo launchctl bootstrap system /Library/LaunchDaemons/com.smartsell.hub.plist`）；Windows `schtasks /Run /TN "SmartSell Hub"`。
4. `pnpm hub:doctor` 確認 `/readyz` 正常。備份之後 Worker 回報、但備份裡沒有的事實不會自動重送：請到今日頁確認那段時間的貼文。

## 7. 匯出舊資料：`pnpm hub:export-legacy`

```bash
pnpm hub:export-legacy --from .local/smartsell.sqlite --out ~/SmartSell-export-20261124
```

以唯讀方式開啟舊資料檔，寫出 `export.json`（`{exported_at, source, kinds}`），排除 session、MCP credential、`*_hash`、`*_ciphertext`、`private*`、密碼／secret／token 欄位、`device_nonce`、`outbox/`、`job/`；同時把舊的 `.local/media` 複製到 `media/`（不跟隨符號連結）。輸出資料夾必須是新的或空的。中樞不會匯入這份資料。

## 8. 手動執行與檢查

```bash
pnpm hub                         # 前景執行（Ctrl-C 停止）
node --import tsx apps/server/hub.ts --check   # 只檢查設定，不啟動；不通過時結束碼 1
node --import tsx apps/server/hub.ts --check --load   # 再以這個版本載入全部程式並讀一份資料的副本（hub:update 用的檢查）
node --import tsx apps/server/hub.ts --supervise      # Windows 服務的監督程序：中樞非 0 結束時自動重啟
```

`status.json` 的 `state`：`running`（執行中）、`stopped`（正常停止）、`config_error`（設定錯誤，未啟動，不會自動重試）、`start_failed`（啟動失敗，服務會重試：macOS 由 launchd、Windows 由監督程序）。

## 9. 開發者備註（其他工作流）

- **開發模式不受影響：**`pnpm dev` 的行為與之前相同；只有 `SMARTSELL_MODE=hub`（`pnpm hub`）才是中樞模式。
- **中樞模式一律 `config.production === true`**，即使 E2E 以 `NODE_ENV=test` 啟動。E2E 可用的例外只有兩項：`NODE_ENV=test` 加 `SMARTSELL_HUB_TEST_HTTP=1` 時 `PUBLIC_ORIGIN` 可以是 `http://127.0.0.1:<port>`；`SMARTSELL_TEST_*` 縮短時程由 `config.testTiming` 提供。E2E 請設 `SMARTSELL_TAILSCALE_CLI` 指向假的 CLI，測試不要碰真的 tailscale。
- **根層守衛與 raw body：**根層 `onRequest` 守衛以 415 拒絕 Content-Type 不是 `application/json` 的 `POST`。送 raw bytes 的端點請用 `PUT`（上傳分段、證據），守衛不檢查 PUT 的 Content-Type。確實需要非 JSON 的 `POST` 時，以 `apps/server/src/app.ts` 匯出的 `RAW_BODY_ROUTE` 註冊，並在封裝的 plugin 內加自己的 content-type parser：

  ```ts
  import { RAW_BODY_ROUTE } from '../app.js';
  app.register(async scope => {
    scope.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 8 * 1024 * 1024 }, (_req, body, done) => done(null, body));
    scope.post('/api/v1/example/raw', { ...RAW_BODY_ROUTE, bodyLimit: 8 * 1024 * 1024 }, handler);
  });
  ```

  Origin 與 `Sec-Fetch-Site` 的檢查照常適用，只略過 Content-Type 檢查。目前沒有路由使用 `RAW_BODY_ROUTE`；新增時請列在這裡。
- **404 與 SPA：**`buildApp` 只設一個 not-found handler；中樞把 SPA fallback 以 `notFound` 委派傳入。`/api/*`、`/mcp`、`/agent/*` 一律回 JSON 404。
- **`trustProxy`：**中樞只信任 `127.0.0.1`（`tailscale serve`），`request.ip` 取 serve 放在 `X-Forwarded-For` 最後的 tailnet 來源位址，tailnet 上的機器無法冒充；`requestTimeout` 為 120 秒。中樞機器上的程式直接連 `127.0.0.1:3401` 時可以自填 `X-Forwarded-For`，所以登入另有兩層限制（`auth.ts`，存在與不存在的名稱同樣處理）：同一個登入名稱從同一個位址 15 分鐘內最多失敗 20 次，超過時只有這個位址對這個名稱回 429，15 分鐘後解除；同一個名稱從所有位址合計失敗超過 20 次後，之後每次登入都先等 1 秒、每多失敗一次加倍、最多 10 秒，同時最多 4 個在等（安全審核 S3）。所以別人猜錯密碼不會把主人鎖在外面，主人從自己的位址輸入正確密碼只是慢幾秒。每位址每分鐘 10 次的限制表滿時淘汰最舊的項目，不會把所有人擋在外面；已登入的 session 不受影響。
- **Worker 安裝包的裝置簽章下載：**`apps/server/src/worker-downloads.ts` 匯出 `provideWorkerDownloadDeviceAuth(app, authenticate)`；裝置流程（S3）以根 app 呼叫它，`authenticate(request, 'worker_download.read:<platform>')` 驗證簽章（body 為空）。尚未提供時，帶裝置標頭的請求回 503 `DEVICE_AUTH_UNAVAILABLE`。最新版本資訊由 `workerReleases(config.workerDownloadDirectory)` 讀 `latest-<platform>.json`，心跳的 `latest_worker` 可用它組出。
- **選擇器資料檔：**`config.driverConfigDirectory`（`<中樞資料夾>/driver-config`）由 `pnpm hub:update` 放置 `selectors.json`。
- **媒體目錄：**`config.mediaDirectory`（預設 `<資料檔所在資料夾>/media`，`hub.env` 可用 `MEDIA_DIRECTORY` 覆寫）。媒體路徑（`createMediaHost`）直接讀它；中樞不再把它寫回 `process.env`。
- **`latest_worker` 與 CPU（E9）：**心跳 v2 的選填欄位 `arch: 'arm64' | 'x64'` 決定 macOS 用哪一個安裝包，值改變時才寫入 `connector_device.arch`。
- **正式語意：**沒有 Config 可讀的模組（customer egress、Agent 模型、名單聯絡資料）用 `apps/server/src/production.ts` 的 `productionSemantics()`，與 `config.production` 同一條規則；不要再直接讀 `NODE_ENV`（`hub.test.ts` 的稽核會擋）。
- **關閉中樞：**`buildApp` 在關閉時會丟棄從沒送出任何位元組的連線（例如 fetch 取消 SSE 後留下的備用連線），所以通知串流的用戶端取消後，`app.close()` 不會再等 70 秒；正在處理的請求照常完成。
- **Playwright：**沒有下載 Playwright 的 Chromium 時，設定 `SMARTSELL_PLAYWRIGHT_CHANNEL=chrome` 就改用這台機器安裝的 Google Chrome；找不到下載的 Chromium 而有安裝 Chrome 時也會自動改用。不要為了測試下載瀏覽器。
