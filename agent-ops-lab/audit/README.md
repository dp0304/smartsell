# SmartSell MCP 逐调用审计验收

隔离产品副本为 `.local/mcp-lab-Lh53qf`。本目录记录 Node 24 下新启动的两种本地服务、原生 Claude Code CLI 和 Chromium 工作台的验收。终端模型响应由确定性的本机夹具给出，CLI 实际发送 MCP 请求，SmartSell 实际认证、执行业务并写入审计。验收用临时工作区和测试凭据。

## 根因

| 历史 `run-GwExwB` | 调用次数 | 广告工具名 | 旧算法匹配的调用／工具名 | 响应中捕获请求 ID | 同一请求 ID 精确匹配 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Commands | 131 | 96 | 51／46 | 0 | 无法从历史记录配对 |
| Operations | 50 | 42 | 19／15 | 50 | 19 |

Commands 的旧导出按新写入行与授权 ID 做宽匹配，原生终端回执还按工具名归并。它未捕获 Commands 的 HTTP 请求 ID，无法证明哪次同名调用对应哪一行。旧场景探针还会漏掉现有存储中的 `agent/tool_call` 和 `row/tool_call` 记录。Operations 在历史导出中有 31 次带请求 ID 的调用找不到行，改用精确匹配未找回任何缺行。代码确认了写入缺口。当时 Commands 逐调用记录仅挂在 OAuth，历史矩阵用的是手工连接；Operations 常规 SDK 和任务适配都没有独立的逐调用记录。已提交写入的业务审计会在幂等回放前提前返回，读取与拒绝没有业务写入可供匹配。 [只读基线统计](baseline.jsonl)

## 查询与配对

在工作台打开 **Agent → MCP 工具審計**，按「請求 ID」或「Agent 授權 ID」查询。两种运行时提供相同的工作区接口 `GET /api/v1/workspaces/:ws/mcp-tool-calls?request_id=<X-Request-Id>`。使用工作台 owner 或 admin 的浏览器会话，可选 `credential_id` 和分页 `cursor`。查询遵守工作区与品牌范围。OAuth 授权面板保留按授权查看历史的入口。

每次进入已认证工具路径的调用写一条记录，在处理完成时更新同一行。服务端 HTTP `x-request-id` 对应 `request_id`，`call_id` 标识这一次调用。结果区分成功、拒绝、失败和待确认，并可附有限业务状态或安全错误码。任务、设备和 Agent 工作 ID 只从专用业务关联提取。目标使用服务端定义的路由模板或有限工具名。原始入参、结果、错误详情、凭据、签名及业务幂等键不进入逐调用记录的公开投影。缺少可信认证主体的请求仍会拒绝；撤销后收到的 401 无可归属工作区审计。

相同幂等键与输入重复提交时，两次调用的请求 ID 和审计 ID 各自独立，回放行标记 `replayed:true`。业务结果 ID 相同，原业务变更及其活动行只产生一次。多个同名调用同样逐条关联，配对不用工具名或客户端 JSON-RPC ID 作为主键。

## 复验结果

| 运行时 | 广告工具有原生终端回执 | SDK 请求精确配对 | 原生终端请求精确配对 | 缺失／重复 |
| --- | ---: | ---: | ---: | ---: |
| Commands | 96／96 | 131／131 | 130／130 | 0／0 |
| Operations | 42／42 | 50／50 | 50／50 | 0／0 |

两种运行时的独立原生终端定向场景各 8／8，覆盖读、写、同名重复、业务失败、拒绝、幂等回放和用 PKCE 兑换的 OAuth 授权。读权限凭据尝试调用未发现的写工具，通过协议请求补验。撤销后的 OAuth 和 PAT 分别返回 401，用各自 `x-request-id` 查询均无行。Commands Matrix 有 95 项通过合成业务断言，1 项验证目录。目录共枚举 700 个通用 Operation 名，本轮实际调用其中 8 个。Operations 有 41 项通过业务断言，1 项预期拒绝。两边各有 2 次商品能力回执记录 `unsupported`；协议成功只确认回执已记录。 [终端与矩阵明细](run-w7Kst9/summary.json)

Chromium 两组用例各 6 次工作台精确配对，均为零缺失和零重复。Commands 由浏览器批准 OAuth，覆盖同名读取、只读授权拒绝写入、异工作区拒绝、写入及回放；Operations 使用独立的工作区会话，覆盖读、写、拒绝、缺失资源和回放。审计查询对未登录、仅 MCP bearer、非管理角色或异工作区保持拒绝。 [浏览器回执](browser.log)

## 可复跑

需要 Node 24、隔离副本已安装的依赖，以及 PATH 内的 Claude Code。以下命令从隔离副本根目录运行，驱动启动各自的本机临时服务，自动记录端口和工作区，退出时关闭夹具。

```sh
node ../../agent-ops-lab/audit/baseline.mjs
node --import tsx ../../agent-ops-lab/audit/run.mjs --focused
node --import tsx ../../agent-ops-lab/audit/run.mjs
node --import tsx ../../agent-ops-lab/audit/run.mjs commands
node --import tsx ../../agent-ops-lab/audit/run.mjs operations
```

全矩阵驱动只读加载既有 `coverage/cases.mjs`，从各自服务发现工具，通过 SDK 断言业务结果，并由原生 CLI 在真实 MCP 连接复验。捕获每次返回的服务器请求 ID，带工作台会话查询审计，检查唯一行、授权、工具和分类结果。通过标准覆盖每个广告工具，分别统计调用级的缺失、重复及错误分类。Commands 的通用目录枚举与实际工具调用在报告中单独计数。新产物使用本目录新建的 `run-*`。

```sh
SMARTSELL_AUDIT_EVIDENCE=1 pnpm exec playwright test --workers=1 \
  tests/web-e2e/mcp-tool-audit.spec.mjs tests/web-e2e/agent-oauth.spec.mjs \
  --grep 'workspace shows|browser consent' --reporter=line \
  --output ../../agent-ops-lab/audit/playwright-output
```

Chromium 通过正常工作台验证精确表单查询，记录可与认证 API 对照。临时服务在测试后关闭，日志里的 loopback 地址用于定位本次抓取。所有调用均在隔离测试环境执行。 [Chromium 证据](browser.log) · [Node 回归](regression.log)
