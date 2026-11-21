# 公開流量與分析本機驗收

2026-11-20。工作環境檢查回傳 `CLAUDECODE=1`、`CLAUDE_CODE_ENTRYPOINT=sdk-cli`。預設 Homebrew Node 因缺少 ICU 動態函式庫而無法啟動，重跑命令使用已安裝的 nvm Node `v24.21.0` 與 pnpm `10.11.0`。

## 修正前重現

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --import tsx --test --test-reporter=dot apps/server/src/integration/traffic-host.test.ts
```

退出碼 1。三個本機 TCP 宿主測試在商品頁的 `/checkout|cart|<form|<button/i` 斷言失敗。回應有兩個既有賣場 CTA，以及 `POST /p/product` 分析同意表單及其允許／拒絕按鈕。PostgreSQL 宿主因未設定連線而跳過。

## 本機產品入口結果

| 驗收 | 實際結果 |
| --- | --- |
| 公開商品宿主 | 三個本機 TCP 宿主均通過。維持零價、價格來源和觀測時間的斷言。商品頁連結只有兩個指向已登記商品網址的賣場 CTA。唯一表單以 `POST` 提交到 `/p/product`，內含 `analytics=allow` 和 `analytics=deny` 兩個按鈕。表單外無其他表單或按鈕，頁面無購物車或結帳控制項。外站來源送出回 `403` 且無 `Set-Cookie`。 [宿主用例](../../apps/server/src/integration/traffic-host.test.ts#L89) |
| [LP02](../../plan.md#L6504) | Chromium 由公開 Bio 點入新舊短鏈目的地，均保留 `utm_source=bio`。團隊 API 讀回兩個修訂及其統計。舊版兩次跳轉中，一次是疑似真人，一次是 Twitter 預覽。新版兩次跳轉中，一次是疑似真人，一次未分類。 [HTTPS 瀏覽器用例](../../tests/web-e2e/traffic-metrics.spec.mjs#L118) |
| [LP03](../../plan.md#L6505) | Chromium 手動選英文再切臺灣市場，保持 `lang=en`。商品連結實際跳至已登記的賣場商品 URL。經 `PATCH /variants/:id` 將商品變體設為 `archived`，其短鏈仍為 `active`，另以 `PATCH /bio-items/:id` 將促銷項目截止時間改為過去。重新載入公開 Bio 後，兩項皆消失，畫面同時顯示到期和商品下架提示，語言仍為英文。 [HTTPS 瀏覽器用例](../../tests/web-e2e/traffic-metrics.spec.mjs#L118) |
| [LP06](../../plan.md#L6508) | `POST /page-checks` 先回 `unknown`，此時發布回 `409`。補入人工觀測後，預設工作台「網址檢查」同時顯示同一版本的舊 `unknown` 與新 `pass`。同一工作台的「分析與報表 → 實驗」讀取正式導流頁實驗報表，顯示每組門檻 5、對照組 5 筆、替代組 2 筆，兩組轉化皆為 0。工作台比對真實 API 的 `insufficient_traffic` 報表，畫面顯示「流量不足，無法作出結論。」既有 TCP 用例也覆核尚無結果時的 `unavailable`、樣本 5／0 的 `insufficient_traffic` 與無樣本組的 `null`，領域用例覆核穩定分流。 [工作台用例](../../tests/web-e2e/traffic-metrics.spec.mjs#L212) · [TCP 用例](../../apps/server/src/integration/traffic-host.test.ts#L163) · [分流用例](../../apps/server/src/modules/traffic/operation-traffic.test.ts#L225) |
| [AN03](../../plan.md#L7305) | 公開 Bio 在 Chromium 經 HTTPS 點擊並重載後，預設工作台「分析與報表 → 短連結成效」以同一日期區間、UTC 和短連結 ID 查詢 `/performance/links`。瀏覽器實際回應與直接呼叫 API 的資料一致，畫面分列跳轉 4 次及過濾後點擊 3 次，其中過濾後點擊包含一筆未分類請求。 [工作台用例](../../tests/web-e2e/traffic-metrics.spec.mjs#L189) |
| AN03 會話隔離 | 兩個 Chromium 瀏覽器上下文使用相同 User-Agent、回環 IP、語言、時區和視窗大小。首次瀏覽和拒絕均未寫入觸點。各自允許後，各收到不同的第一方 `Secure`、`HttpOnly`、`SameSite=Lax` cookie，寫入的觸點依會話分成 2 筆與 1 筆。撤回第一個會話的同意後，其重載不再增加觸點，第二個會話仍續用原會話。持久化事件未發現 User-Agent、IP 或指紋欄位。 [HTTPS 瀏覽器用例](../../tests/web-e2e/traffic-metrics.spec.mjs#L275) |

首輪純 HTTP 瀏覽器入口未取得真人分類需要的 Fetch Metadata。改用回環 HTTPS 後，Chromium 將同源原生表單送出為 `Origin: null`，公開宿主回 `403`。帶表單的公開落地頁改用 `Referrer-Policy: same-origin` 後，正常同源提交回 `303`，宿主仍依既有 Origin 規則拒絕跨來源提交，對外導航仍不帶 Referer。 [公開頁實作](../../apps/public/src/traffic.ts#L125)

## 2026-11-20 一般 Playwright 入口復驗

在同一前景 Claude Code 環境使用 Node `v24.21.0` 和 pnpm `10.11.0`。改動前取消 `NODE_OPTIONS`，三項 Chromium 測試在載入夾具時均因 `publishing/index.js` 無法提供 `localMinute` 而失敗。流量夾具改用門戶測試既有的 `tsImport` 模式，透過單一 TypeScript 入口載入服務模組。原有行為斷言與本機端點維持原樣。

取消 `NODE_OPTIONS` 後，一般 Playwright 與 `pnpm test --built-web tests/web-e2e/primary.spec.mjs tests/web-e2e/traffic-metrics.spec.mjs` 均通過全部 3 個流量案例。賣場導覽由瀏覽器夾具攔截。 [修正前日誌](../../.local/qa-turn/setup-traffic-before.log) · [一般執行日誌](../../.local/qa-turn/setup-traffic-after.log) · [建置版本日誌](../../.local/qa-turn/setup-traffic-built.log)

## LP05 線索收件箱與人工 CRM 回執（2026-11-20）

核對 `plan.md` 5.13.12 和驗收索引的 LP05 缺口後，沿用既有工作台與人工回執流程。首輪 Chromium 3 通過、1 失敗，LP05 的「記錄已聯絡」回 `403`。實際以 `claude -p` 執行的 Claude Code `2.1.311`（`claude-opus-5-5`，會話 `b2584abc-a9ce-4b99-8416-4360cf9b0711`）在 Bash 工具內執行 `node --version`，回傳 `v24.21.0`。該會話只修正瀏覽器夾具，在 Vite 啟動後將其實際 HTTPS 源站（含連接埠）加入測試服務的允許集合。工作台寫入仍經正式會話、Origin、CSRF 和角色檢查。 [原稿](../../plan.md#L6499) · [既有驗收索引](./evidence.json#L4094) · [夾具](../../tests/web-e2e/traffic-metrics.spec.mjs#L102)

| 驗收 | 實測 |
| --- | --- |
| 公開送件與三欄 | Chromium 經回環 HTTPS 真正送出三筆 `example.test` 線索。每次載入同意選項均未預勾。正式 `/w/:id` 工作台「導流 → 線索」將待聯絡／同意聯絡／已成交由 **1／2／0** 更新為 **1／1／1**。重新載入後，成交線索仍在成交欄。列表聯絡資料維持遮罩，未回傳加密欄位或回執證據。 |
| 同意與動作權限 | 未同意及僅同意服務聯絡的線索以行銷用途記錄聯絡均回 `409`。無同意線索在工作台沒有「記錄已聯絡」動作。共兩筆服務同意、零筆行銷同意，一筆服務聯絡活動、零筆行銷聯絡活動，零筆 webhook 投遞。編輯者交接和提交回執均回 `403`，工作台仍可看見「結果未知」，回執證據和提交動作依權限隱藏。 |
| 人工回執與核實 | 擁有者透過表單記錄服務聯絡、確認需求、申請 CRM 交接，再填寫 `unknown` 人工回執。線索留在 `qualified`，未出現「標記成交」，重送和提前成交均回 `409`。直接將無同意線索標成交也回 `409`。缺證據的確認回執回 `422`。在表單填入合成證據及 CRM 參考編號並確認後，線索先進入 `handed_off`，再以另一動作標為 `converted`。重新載入並從成交欄開啟線索，仍可查閱確認回執；一筆交接與一筆工作項目，工作項目為 `done`。 |

[HTTPS 瀏覽器用例](../../tests/web-e2e/traffic-metrics.spec.mjs#L284) · [工作台回執表單](../../apps/web/src/lead-followup.tsx#L57)

在專案根目錄重跑。瀏覽器用例請串行執行，並保持本機 Vite 連接埠 5173 可用。

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
unset NODE_OPTIONS
claude --version
node --version
pnpm --version
LP05_OUTPUT=$(mktemp -d /tmp/smartsell-lp05-after.XXXXXX)
pnpm exec playwright test tests/web-e2e/traffic-metrics.spec.mjs --workers=1 --output="$LP05_OUTPUT"
pnpm --filter @smartsell/web exec tsc --noEmit -p tsconfig.json
```

Chromium 串行 4 通過、0 失敗（14.6 秒），涵蓋 LP05 和已通過的 LP02、LP03、LP06、AN03。Claude Code 以 `pnpm exec playwright test tests/web-e2e/traffic-metrics.spec.mjs --grep 'LP05' --output "$(mktemp -d /tmp/smartsell-lp05.XXXXXX)"` 單跑 LP05，1 通過（6.4 秒）。兩個 Playwright 行程重疊的一輪因 Vite 5173 被佔用而有兩例在啟動時失敗，待行程退出後串行復驗全數通過。工作台 TypeScript 檢查退出碼 0。已查看此次 `workspace-lead-columns.png`，位於 `/tmp/smartsell-lp05-after.gx8H7Z` 的 LP05 用例輸出目錄。

以快取 `postgres:17-alpine`（映像 `e29b5f752308`，PostgreSQL `17.11`）補跑 Node 回歸，31 通過、0 失敗、0 跳過。以下為該次暫存資料庫與測試命令，沿用既有 PostgreSQL 驗收的獨立遷移和執行角色。容器退出後已移除，沿用原快取映像。 [資料庫驗收夾具](../../tests/acceptance/with-postgres.sh#L34)

```sh
bash <<'BASH'
set -euo pipefail
container=$(docker run --rm --pull=never --detach --tmpfs /var/lib/postgresql/data --publish 127.0.0.1::5432 --env POSTGRES_PASSWORD=acceptance-local postgres:17-alpine)
trap 'docker stop "$container" >/dev/null' EXIT
for ((attempt=0; attempt<30; attempt++)); do
  if docker exec "$container" pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec -i "$container" psql --username postgres --set ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE smartsell_request NOLOGIN;
CREATE ROLE acceptance_owner LOGIN PASSWORD 'fixture-owner';
CREATE ROLE acceptance_request LOGIN PASSWORD 'fixture-request';
GRANT smartsell_request TO acceptance_request;
CREATE DATABASE smartsell_traffic OWNER acceptance_owner;
SHOW server_version;
SQL
address=$(docker port "$container" 5432/tcp)
export TRAFFIC_TEST_DATABASE_OWNER_URL="postgresql://acceptance_owner:fixture-owner@${address}/smartsell_traffic"
export TRAFFIC_TEST_DATABASE_URL="postgresql://acceptance_request:fixture-request@${address}/smartsell_traffic"
MIGRATION_DATABASE_URL="$TRAFFIC_TEST_DATABASE_OWNER_URL" pnpm db:migrate
node --import tsx --test apps/server/src/integration/traffic-host.test.ts apps/server/src/modules/traffic/{traffic,operation-traffic}.test.ts apps/server/src/modules/analytics/operations.test.ts
BASH
```

此次 CRM 參考編號及回執均為人工輸入的合成資料。SmartSell 公開入口和工作台均由本機服務處理，零真實客戶、零外部訊息。外部驗收仍待授權 CRM 帳戶、實際投遞與供應商回執讀回。

## 重跑命令

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --version
node --import tsx --test apps/server/src/integration/traffic-host.test.ts apps/server/src/modules/traffic/{traffic,operation-traffic}.test.ts apps/server/src/modules/analytics/operations.test.ts
TRAFFIC_E2E_OUTPUT=$(mktemp -d /tmp/smartsell-traffic-metrics.XXXXXX)
printf 'Playwright output: %s\n' "$TRAFFIC_E2E_OUTPUT"
unset NODE_OPTIONS
pnpm exec playwright test tests/web-e2e/traffic-metrics.spec.mjs --workers=1 --output="$TRAFFIC_E2E_OUTPUT"
pnpm --filter @smartsell/web exec tsc --noEmit -p tsconfig.json
```

前次 Node 回歸 27 通過、0 失敗、1 跳過。PostgreSQL 組需 `TRAFFIC_TEST_DATABASE_URL` 與 `TRAFFIC_TEST_DATABASE_OWNER_URL`。同次 Chromium 3 通過、0 失敗（11.8 秒），工作台 TypeScript 檢查通過。該次瀏覽器輸出在 `/tmp/smartsell-traffic-metrics.4oCCbr`，已查看 `workspace-url-checks.png`、`workspace-experiment.png` 與 `workspace-link-performance.png`，分別確認檢查歷史、流量不足提示與短連結分欄數值。

每個 Chromium 用例都以 `127.0.0.1:0` 啟動獨立公開 HTTPS 入口和 Operations 服務，並使用獨立暫存檔案資料庫。需要工作台的用例沿用同一套臨時自簽憑證啟動 Vite，經正式 `/w/:id` 頁面及 `__Host-smartsell_session` cookie 讀取同一 Operations 服務。賣場回應由瀏覽器夾具提供。SmartSell 公開頁、表單、跳轉、工作台與報表均透過本機服務實跑。實體跨裝置和授權賣場仍待覆核。
