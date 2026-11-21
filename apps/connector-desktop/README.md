# SmartSell 桌面连接器（Windows / macOS）

D20 桌面应用，覆盖 M9 的设备配对、账号核对、人工交接和证据回填。关闭窗口后保留托盘。急停可从窗口或托盘触发，立即取消本机在途设备请求并停止心跳。已打开的系统浏览器由操作者控制。交接后急停会保留一条「结果未知」报告，可在租约内手动回填。程序重启后需要主动连接。任务状态与尚未确认的报告只保存在内存，重启或租约失效后由工作台处理。

## 安装与本地验证

使用 Node 24。在已有根目录依赖的检出中运行以下命令。桌面依赖使用本目录独立的 npm 锁文件。

```sh
npm --prefix apps/connector-desktop ci --ignore-scripts --prefer-offline
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

## 正式部署与交付

构建时通过 `SMARTSELL_API_ORIGIN` 和 `SMARTSELL_WORKBENCH_ORIGIN` 注入部署的 HTTPS 源地址。API 地址随配对记录加密保存，部署地址变化时应撤销原配对并重新绑定。目前使用仓库已实现的固定 HTTPS 设备接口。设备私钥由 Electron `safeStorage` 使用 macOS 钥匙串或 Windows DPAPI 保护。

1. 登录 Web 后，在「開始設定」连接主 Agent，再进入「桌面 Worker」。复制服务地址、工作区 ID 和一次性配对码。到日后访问社媒或店铺的那台电脑上打开桌面连接器。开发包可以在「设置服务地址」填写服务源。确认设备归属，完成配对后点击「连接」。
2. 如需核验工作台中的浏览器会话，用该账号的专用浏览器配置打开官方创作者页面，读取实际登录账号 ID，在桌面填写会话 ID 和账号 ID。系统浏览器的配置切换由操作者完成。
3. 领取一项任务，查看冻结内容和账号信息。打开官方创作者页面，按需从本机选取媒体进行 SHA-256 校验。随后在官方页面亲自准备审批内容，核对账号与可见范围，在桌面确认后取得有时限的人工交接，再在官方页面提交一次。
4. 证据使用工作台预登记的脱敏截图，填入作品 ID、无查询参数的官方作品链接、证据对象 ID 和 SHA-256。服务端负责证据归属、类型和摘要核验，发布结果由工作台独立核实。无法确定是否提交时回填结果未知。
5. 断开会保留配对。注销本机会删除本机密钥。设备需要彻底撤销时，在工作台由管理员撤销对应设备。外部平台账号的退出在官方浏览器中完成。

抖音与小红书提供官方创作者页面的人工交付入口。这一能力在离线环境验证流程，真实平台租户能力仍取决于平台授权。移动任务、平台 OAuth、自动发布、TikTok 收件匣草稿和认证后的平台上传由此版本界面标记为不可用。桌面不托管平台凭据，媒体只在本机读取校验。

## 从指定 Worker 导入商品

在 Web 的「商城與商品」登记店铺，核对官方店铺 ID，选择固定 Worker，再发起商品导入。要在看板看到导出文件的价格和库存，可为店铺设置相应市场和价格来源。

在绑定的机器上连接工作区，点击「领取商品导入任务」。在官方卖家后台用已授权的账号导出商品 CSV、TSV 或 XLSX，再回到桌面确认官方页面显示的店铺 ID 并选择文件。单批文件最大 384 KiB。连接器从第一张 XLSX 工作表提取商品列。Web 收到预览后，在本批导入页面核对行数据、确认合并，最后到「商品」查看结果。

多台机器须使用它们都能访问的同一个 HTTPS 工作台。`localhost` 和 `127.0.0.1` 的开发地址适合同一台电脑上的验证。

## 打包与签名更新

- macOS 原生主机运行 `npm --prefix apps/connector-desktop run package:mac`，产出 DMG 和 ZIP。配置 `SMARTSELL_MAC_IDENTITY` 为 Developer ID Application 身份及 `APPLE_KEYCHAIN_PROFILE` 为 notarytool 钥匙串配置。`SMARTSELL_UPDATE_FEED` 指向 HTTPS Squirrel.Mac JSON feed，发布端按当前版本返回更新 ZIP 或 HTTP 204。Electron 原生更新器验证更新符合现用应用的代码签名要求。
- Windows 原生主机运行 `npm --prefix apps/connector-desktop run package:win`，产出 NSIS 安装包。配置 `WIN_CSC_LINK` 和 `WIN_CSC_KEY_PASSWORD` 或等效的 `CSC_LINK` 和 `CSC_KEY_PASSWORD`。设置 `SMARTSELL_WIN_PUBLISHER` 为证书完整主体 DN，`SMARTSELL_UPDATE_FEED` 为提供 `latest.yml` 与安装包的 HTTPS 目录。更新器校验摘要及预配置的 Authenticode 发布者，并复查缓存安装包。禁止降级和 Web 安装器。
- 发布脚本要求正式服务、更新源及目标系统签名配置。发布物留在本机 `release/`。macOS 本机开发包可在构建后运行 `node apps/connector-desktop/scripts/package.mjs mac --local-dir`，生成具有 ad hoc 签名的 `.app`，更新关闭。Windows 可在原生主机使用 `win --local-dir`。

当前开发机缺少 Developer ID 发布身份。正式 macOS 公证、Windows Authenticode 安装包和双方的真实签名更新链仍需在配置好的发布主机验证。
