# SmartSell 桌面连接器（Windows / macOS）

用 Codex 或 Claude Code 通过 SmartSell MCP 发起和查询任务。桌面 Worker 接收工作台派发到本机的签名任务，Web 工作台显示审批、任务和结果。关闭窗口后保留托盘。急停可从窗口或托盘触发，立即取消本机在途设备请求并停止心跳。已打开的系统浏览器由操作者控制。交接后急停会保留一条「结果未知」报告，可在租约内手动回填。程序重启后需要主动连接。任务状态与尚未确认的报告只保存在内存，重启或租约失效后由工作台处理。

## 安装与本地验证

使用 Node 24。在已有根目录依赖的检出中运行以下命令。桌面依赖通过仓库的 pnpm workspace 安装。

```sh
npm --prefix apps/connector-desktop run typecheck
npm --prefix apps/connector-desktop test
npm --prefix apps/connector-desktop run build
```

Electron 类型检查和 JS 构建仅需 npm 包。启动、GUI 测试或打包需要对应系统和架构的 Electron 运行时。先检查 `apps/connector-desktop/node_modules/electron/dist`，缺少时运行 `node apps/connector-desktop/node_modules/electron/install.js`，该安装器优先使用 Electron 缓存。

```sh
npm --prefix apps/connector-desktop start
node tests/connector-desktop/smoke.mjs
```

GUI smoke 使用未配置服务的构建和隔离用户目录。逻辑测试注入内存传输，验证真实配对证明、签名、随机 nonce 与任务防护。测试使用合成工作区、账号、媒体哈希和证据引用。

安装 Google Chrome 后，可运行 `node tests/connector-desktop/channel-dom.mjs`，在可见 Chrome 中验证合成页面的身份读取及账号菜单点击。设置 `SMARTSELL_CONNECTOR_REAL_CHROME=1` 运行 GUI smoke 时，还会以隔离的未登录 Chrome 配置打开真实 YouTube Studio。

## 正式部署与交付

构建时通过 `SMARTSELL_API_ORIGIN` 和 `SMARTSELL_WORKBENCH_ORIGIN` 注入部署的 HTTPS 源地址。API 地址随配对记录加密保存，部署地址变化时应撤销原配对并重新绑定。目前使用仓库已实现的固定 HTTPS 设备接口。设备私钥由 Electron `safeStorage` 使用 macOS 钥匙串或 Windows DPAPI 保护。

1. 在日后访问社媒或店铺的电脑上打开桌面 Worker，按窗口顶部的「首次设置」操作。点击「检查系统安全存储」，并在系统提示出现时自行决定是否授权。验证通过后，填写可信的工作台网址，核对本机并在系统浏览器中同意授权。也可粘贴工作台发出的 Worker 配对网址。配对在加密保存后通过，签名连接在工作台确认心跳后通过。重新打开 Worker 会读取已有配对，仍需连接才能恢复在线。点击「连接专用 Google Chrome」验证 Worker 自己的 Chrome 会话，然后按需添加平台，在官方页面登录并用相应渠道的「验证」核对身份。平台选择只用于首次设置进度，账号状态随当前会话重新核验。
2. 点击「检查本机已登录渠道」。Worker 检查专用 Chrome 已打开或恢复的官方页面。需要登录时，从对应渠道点击「在 Chrome 打开」，完成登录并打开账号或店铺身份页。勾选已验证的渠道并确认登记，Worker 复核身份并等待工作台确认。可在工作台查看已登记的账号和店铺。已绑定且等待复核的旧会话只需在本机专用 Chrome 打开官方账号资料。Worker 会在心跳后读取该标签页并签名回报明确匹配的身份。已登记渠道若显示过期，请打开原账号或店铺资料并重新验证。检测到账号切换时，核对身份后再验证。
3. 在终端通过 MCP 提交或查询任务，按工作台要求完成审批。在线空闲时，Worker 自动领取本机任务，一次处理一项。抖音和小红书的浏览器交接会自动从专用 Chrome 核对账号。页面看不到明确身份时，先打开官方账号资料。发布仍须按冻结版本核对内容、媒体和可见范围，确认交接后在官方页面亲自提交一次。
4. 证据使用工作台预登记的脱敏截图，填入作品 ID、无查询参数的官方作品链接、证据对象 ID 和 SHA-256。服务端负责证据归属、类型和摘要核验，发布结果由工作台独立核实。无法确定是否提交时回填结果未知。
5. 断开会保留配对。注销本机会删除本机密钥。设备需要彻底撤销时，在工作台由管理员撤销对应设备。外部平台账号的退出在官方浏览器中完成。

可登记抖音、小红书、TikTok 国际版、YouTube、Facebook、Instagram、Shopify、Amazon Seller Central 和 Shopee。X 和 Reddit 提供本机身份核验。登记需在专用 Chrome 显示官方身份，例如 TikTok 数字用户 ID 或 Amazon Seller ID。关页、结束 Chrome 会话或本机验证满 30 分钟时需复验。网页登录、验证码和二次验证由操作者在 Chrome 完成。

Worker 的桌面任务支持抖音和小红书的浏览器交接、派发到本机的商品文件导入，以及知乎的既有只读登录检查和可见统计。社媒作品证据和可见性需要人工核对。已有平台草稿无法在此交接，会回报当前版本不支持。手机任务由对应移动执行路径处理。旧服务未声明支持浏览器专用领单时，桌面仍可连接，社媒任务等待服务升级。

## 从指定 Worker 导入商品

在 Web 的「商城與商品」登记店铺，核对官方店铺 ID，选择固定 Worker，再发起商品导入。要在看板看到导出文件的价格和库存，可为店铺设置相应市场和价格来源。

绑定的 Worker 在线且空闲时会自动接收任务，并显示本批导入交接。在官方卖家后台用已授权的账号导出商品 CSV、TSV 或 XLSX，再回到桌面确认官方页面显示的店铺 ID 并选择文件。单批文件最大 384 KiB。连接器从第一张 XLSX 工作表提取商品列。Web 收到预览后，在本批导入页面核对行数据、确认合并，最后到「商品」查看结果。

多台机器须使用它们都能访问的同一个 HTTPS 工作台。`localhost` 和 `127.0.0.1` 的开发地址适合同一台电脑上的验证。

## 在终端安装并使用 Skills

构建后，从仓库根目录运行独立安装器，目标为已有的运维项目目录。

```sh
node apps/connector-desktop/dist/smartsell-install-skills.mjs "/path/to/ops-project"
```

如果收到单独交付的 `smartsell-install-skills.mjs`，可以在运维项目中运行 `node /path/to/smartsell-install-skills.mjs .`。安装器将三份预设写入项目的 `.claude/skills/` 和 `.agents/skills/`，保留同名内容。全局 Skills 和 MCP 配置由各自的工具管理。

重新打开该项目的 Codex 或 Claude Code 会话，在 Web 工作台的「Agent」页面按说明连接同一工作区的 SmartSell MCP。用自然语言描述要提交或查询的任务。可执行操作取决于当前 MCP 工具、工作区权限和平台授权。预设源文件位于 `skills/`，构建将预设嵌入单文件安装器。

## 打包与签名更新

- macOS 原生主机运行 `npm --prefix apps/connector-desktop run package:mac`，产出 DMG 和 ZIP。配置 `SMARTSELL_MAC_IDENTITY` 为 Developer ID Application 身份及 `APPLE_KEYCHAIN_PROFILE` 为 notarytool 钥匙串配置。`SMARTSELL_UPDATE_FEED` 指向 HTTPS Squirrel.Mac JSON feed，发布端按当前版本返回更新 ZIP 或 HTTP 204。Electron 原生更新器验证更新符合现用应用的代码签名要求。
- Windows 原生主机运行 `npm --prefix apps/connector-desktop run package:win`，产出 NSIS 安装包。配置 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` 或等效的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`。设置 `SMARTSELL_WIN_PUBLISHER` 为证书完整主体 DN，`SMARTSELL_UPDATE_FEED` 为提供 `latest.yml` 与安装包的 HTTPS 目录。更新器校验摘要及预配置的 Authenticode 发布者，并复查缓存安装包。禁止降级和 Web 安装器。
- 发布脚本要求正式服务、更新源及目标系统签名配置。发布物留在本机 `release/`。macOS 本机开发包可在构建后运行 `node apps/connector-desktop/scripts/package.mjs mac --local-dir`，生成具有 ad hoc 签名的 `.app`，更新关闭。Windows 可在原生主机使用 `win --local-dir`。

当前开发机缺少 Developer ID 发布身份。正式 macOS 公证、Windows Authenticode 安装包和双方的真实签名更新链仍需在配置好的发布主机验证。
