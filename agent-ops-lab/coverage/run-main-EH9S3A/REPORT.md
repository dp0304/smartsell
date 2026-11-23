# SmartSell MCP 逐工具验收 · main

源码 `.`。 [运行来源](source.json)

本次证据目录为 [run-main-EH9S3A](summary.json)。两个产品 runtime 使用各自的临时数据库、账号和工作区，通过随机回环端口访问。

| Runtime | 具名工具 | 业务成功 | 目录验证 | 预期拒绝 | 具体失败 | 外部依赖 | 未实调 | 原生 CC 有回执 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| commands | 98 | 97 | 1 | 0 | 0 | 0 | 0 | 98 |
| operations | 42 | 41 | 0 | 1 | 0 | 0 | 0 | 42 |
| 合计 | 140 | 138 | 1 | 1 | 0 | 0 | 0 | 140 |

同名工具在不同 runtime 各计一次。按工具名去重为 **114** 项。目录验证只用于描述工具。预期拒绝单列，空结果和 schema 异常不计入业务通过。

原生 Claude Code 共收到 **183** 条回执，均按平台请求 ID 查到唯一 Web 行，其中 **183** 条的审计字段完全一致。SDK 的 184 条回执均有唯一行，其中 184 条字段完全一致。

根目录与桌面的 MCP 配置在实际批量运行前后保持字节一致。 [配置验证](ordinary-config-verification.json)

### commands

- 写授权 `tools/list` 返回 98 项、1 页。只读授权返回 52 项、1 页。末页均无下一页游标。逻辑列表另外用两条品牌和 `limit: 1` 实际翻页。 [发现回执](commands-discovery.json)
- 134 条 SDK 用例，成功 108，目录验证 20，预期拒绝 6，具体失败 0，外部依赖 0，未实调 0。134 条用例关联了 134 条唯一服务端审计。 [调用回执](commands-calls.jsonl) [服务端审计](commands-audit.jsonl)
- 98 项原生 Claude Code 工具有回执。127 项成功返回，5 项按预期拒绝。 [原生会话](commands-native.jsonl) [逐工具矩阵](commands-matrix.json)
- 写、只读凭据撤销后分别经 `tools/list` 验证均返回 HTTP 401。 [撤销回执](commands-revocation.json)

- 8/8 条补测经标准 `callTool` 通过声明输出 schema 与业务断言。补测工具为 `jobs_get`、`research_create_note`、`research_item_evidence`、`creative_reference_annotate`、`search_query`、`knowledge_get_context`、`agent_preview_context`、`catalog_list_facts`。 [声明 schema 和实际回执](commands-calls.jsonl)

- `smartsell_operation_call` 通过描述工具按模块发现 701 项授权操作，实际调用 9 项。6 条通过业务断言，3 条触发人工审批边界。 [可访问操作和实调明细](commands-operation-call.json)

- Commands 的旧式只读 PAT 额外发现并实调了 jobs_get。该入口单列，未计入上表的 Commands 主连接列。 [旧式只读用例](commands-legacy-only.json) [原生会话](commands-readonly-native.jsonl)

- Web 严格关联原生回执 133/133，按请求 ID 各有唯一行 133/133。SDK 严格关联 134/134，各有唯一行 134/134。 [原生逐请求审计](commands-native-audit.jsonl) [未知请求 ID 查询](commands-web-filter-verification.json)

- 只读目录没有 `workspace_brand_create`。SDK 直接实调并确认 `TOOL_UNAVAILABLE`，原生 Claude Code 只执行目录提供的工具。

### operations

- 写授权 `tools/list` 返回 42 项、1 页。只读授权返回 26 项、1 页。末页均无下一页游标。逻辑列表另外用两条品牌和 `limit: 1` 实际翻页。 [发现回执](operations-discovery.json)
- 50 条 SDK 用例，成功 46，目录验证 0，预期拒绝 4，具体失败 0，外部依赖 0，未实调 0。50 条用例关联了 50 条唯一服务端审计。 [调用回执](operations-calls.jsonl) [服务端审计](operations-audit.jsonl)
- 42 项原生 Claude Code 工具有回执。46 项成功返回，4 项按预期拒绝。 [原生会话](operations-native.jsonl) [逐工具矩阵](operations-matrix.json)
- 写、只读凭据撤销后分别经 `tools/list` 验证均返回 HTTP 401。 [撤销回执](operations-revocation.json)

- 7/7 条补测经标准 `callTool` 通过声明输出 schema 与业务断言。补测工具为 `research_create_note`、`research_item_evidence`、`creative_reference_annotate`、`search_query`、`knowledge_get_context`、`agent_preview_context`、`catalog_list_facts`。 [声明 schema 和实际回执](operations-calls.jsonl)

- 此入口的工具目录没有 `smartsell_operation_call`。

- Web 严格关联原生回执 50/50，按请求 ID 各有唯一行 50/50。SDK 严格关联 50/50，各有唯一行 50/50。 [原生逐请求审计](operations-native-audit.jsonl) [未知请求 ID 查询](operations-web-filter-verification.json)


## 权限、重放与审计

- Commands 验证了只读凭据执行写工具被拒绝、重复键同参数返回原品牌且没有新增写审计、重复键不同参数被拒绝、人工发布审批与广告决策被拒绝、陈旧租约被拒绝。
- Operations 验证了工作区外 ID 隐藏、陈旧租约被拒绝、缺少回复租约以及持有效租约但未经审批时均不能发送。
- 正向用例使用标准 `callTool`。Operations 的跨工作区 `NOT_FOUND` 拒绝用例继续通过 SDK 协议请求验证。
- 原生回执以用例、工具名和完整参数定位实际 JSON-RPC 调用，读取平台 HTTP 响应的 `x-request-id`，再用 Web 管理会话查询 `/mcp-tool-calls?request_id=...`。严格匹配要求唯一行以及工具名、授权凭据、执行结果和拒绝码一致。
- 独立本地资产上传和图片注册完成。广告只提交到本地审查。知乎查登录只创建并读取了本地排队单。桌面商品上架只验证了产品明确返回的 `unsupported` 回执。真实站点登录、对外发布、对外回复、实际投放与商品上架交付均未执行。

## 复跑

在指定的 `agent-ops-lab` 目录运行，使用 Node 24、所选源码树的依赖和本机 Claude Code。省略 `MATRIX_SMARTSELL_SOURCE` 时使用隔离副本。

```sh
cd ./agent-ops-lab
MATRIX_SMARTSELL_SOURCE=.. node --import tsx coverage/run.mjs
node --import ../.local/mcp-lab-Lh53qf/node_modules/.pnpm/tsx@4.23.15/node_modules/tsx/dist/loader.mjs coverage/run.mjs
node coverage/report.mjs coverage/run-main-EH9S3A
```

- 入口与产品 `pnpm --filter @smartsell/server start` 和 `pnpm --filter @smartsell/server start:kernel` 使用同一启动函数。运行器调用这两套入口的服务启动函数以指定随机端口，先经 `/readyz` 和 `/api/v1/setup` 创建独立工作区，再通过 `/mcp` 实调。产品 Web 正常入口是副本 README 中的 `pnpm dev`，默认回环监听，`/mcp` 与 `/api` 同源代理。
- 矩阵的 `coverage/.mcp.json` 由原生会话显式加载，其变量只在运行器的 Claude Code 子进程中注入。原生 Claude Code 2.1.311 使用回环 Messages 夹具，工具调用到独立的实际 SmartSell 监听器。会话由脚本编排，未使用在线模型。所有用例的输入、断言和地区或日期夹具均在 `coverage/cases.mjs`。
- 可使用较短的 [脱敏会话索引](TERMINAL.md) 检索每条请求、工具参数、回执、答复和审计 ID。
