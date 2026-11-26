# 參與開發

謝謝你願意改進 SmartSell。GitHub（`dp0304/smartsell`）與 Gitee（`yueshutech/smartsell`）是同一份程式碼，兩邊都可以開 issue 與 pull request；合併後會同步到兩邊。

## 開始

```sh
git clone https://github.com/dp0304/smartsell.git
cd smartsell
nvm install && nvm use          # Node.js 24
corepack enable pnpm            # pnpm 10
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm dev                        # API 127.0.0.1:3401，Web 127.0.0.1:5173
```

根目錄的 `pnpm-lock.yaml` 管理所有 workspace 依賴。本機的 Web 以相同來源代理 `/api` 與 `/mcp`；沒有設定 `DATABASE_URL` 時，API 把狀態存在 `.local/smartsell.sqlite`。

**本機首次設定：**`pnpm dev` 或 `pnpm preview` 之後打開本機 Web 網址的「首次設定」。Web 與 API 都只監聽回環位址、請求的 Host 與 Origin 也是伺服器信任的本機位址時，可以用使用者名稱加至少 6 個字元的密碼註冊（設定了 `SETUP_TOKEN` 時還要輸入它）；註冊會建立第一位擁有者與預設工作區。對外部署的首次註冊與成員邀請要求至少 12 個字元。使用者名稱不分大小寫，支援 Unicode 字母與數字，首字元之後可用 `.`、`_`、`-`。其他方式（終端機建立、PostgreSQL、相容工作台）見 [舊版部署與工作台](docs/legacy.md)。

**Worker App：**`pnpm --filter @smartsell/connector-desktop start`，測試與打包見 [apps/connector-desktop/README.md](apps/connector-desktop/README.md)。操作手冊的截圖用 `SMARTSELL_DOCS_SCREENSHOTS=1 pnpm exec playwright test tests/web-e2e/docs-screenshots.spec.mjs` 重新產生（畫面文字改了就更新）。

## 提交前

| 指令 | 用途 |
| --- | --- |
| `pnpm typecheck` | 全部 TypeScript |
| `pnpm test -- <路徑片段>` | 只跑相關的測試；不帶參數跑全部（Node Test Runner、Vitest 與 Playwright 自動分流） |
| `pnpm build` | 完整型別檢查後建置各 workspace，Web 產物在 `apps/web/dist` |
| `node scripts/requirements.mjs --write` | 新增或改名測試檔後，重新產生需求追溯矩陣 |
| `pnpm verify` | 和 CI 相同：需求檢查、建置、全部測試 |

- 設計以 [`docs/restructure/phase1-design.md`](docs/restructure/phase1-design.md) 為準；改變行為時一併更新設計文件（附錄 E 記錄決定）。
- 每個修正都要有能證明它的測試，放在該模組旁邊或 `tests/` 對應的資料夾。
- 介面文字以繁體中文為主，英文放在 `apps/web/src/i18n.ts`。給使用者看的錯誤訊息要說「發生什麼事、要怎麼做」，不要只給代碼。
- commit 訊息沿用 `git log` 的格式（`feat:`、`fix:`、`docs:`，後面用中文說明）。

## 授權

SmartSell 以 [PolyForm Noncommercial 1.0.0](LICENSE.md) 公開，商業用途另外授權（見 [README](README.md#授權)）。提交 pull request 即表示你同意：

- 你的貢獻以同一份條款公開；
- 專案擁有者可以用其他條款（包括商用授權）使用與再授權你的貢獻；
- 你有權提交這些內容（不是從授權不相容的專案複製，也不違反你雇主的規定）。

## 不接受的變更

SmartSell 在使用者自己的帳號與瀏覽器裡操作。以下變更一律不接受：偽造瀏覽器指紋或裝置識別、修改 `navigator.webdriver` 等偵測標記、規避平台風控、自動解驗證碼、批量註冊或養帳號、未經帳號主人確認就代按發布。

## 回報問題

- 一般問題與建議：開 issue，附上作業系統、SmartSell 版本（Worker App 的「進階」可以看到）、重現步驟，以及網頁「機器」頁或 Worker「日誌」裡的相關訊息（請先刪除權杖、帳號名稱等個人資料）。
- 安全問題：請不要公開開 issue，照 [SECURITY.md](SECURITY.md) 私下回報。
