# 主工作区 MCP 调用审计

## 构建与入口

本次验收使用 `.` 主工作区。Commands 通过 `apps/server/src/bootstrap.ts` 启动，Operations 通过 `apps/server/src/server.ts` 启动，两套服务均使用主工作区 TypeScript 源码。Web 使用主工作区 `pnpm build` 产出的 `apps/web/dist`，由 Vite preview 提供。运行环境为 Node `v24.21.0`，构建中的 Agent 页面代码在 `routes-DgakY_i4.js`。Web 文件及审计相关服务端源码的 SHA-256 记录在 [build.json](main-run-a4xwj5/build.json)。

调用通过正常的 `/mcp` HTTP 入口。服务端生成 `X-Request-Id`，每次 `tools/call` 对应一个 `call_id`，开始和结束更新同一条审计记录。幂等重放有独立的请求和调用 ID，并标记 `replayed: true`。业务效应沿用原幂等键，只发生一次。

Web 从 `/app/:ws/agent` 的 Activity 同页进入「MCP 工具審計」。可按请求 ID、用户 ID、授权 ID、工具名称、调用结果和业务状态查询。同一工作区内，未受品牌范围限制的 Owner 或 Admin 可读取该记录。审计仅显示必要的标识、注册工具名称和路由模板、状态及归一化错误码。工具参数、正文、业务返回和凭据没有进入 Web 投影。

## 实测回执

Commands 和 Operations 各验证 8 条调用。每条均先凭实际 HTTP 响应中的请求 ID 查到唯一审计行，再在构建后的 Agent 页面使用请求 ID、用户、工具和结果组合筛选到同一 `call_id`。两套服务各使用两个独立签发的授权。每套的 7 条可发现调用来自普通 Claude Code 终端，包括同轮两次调用 `workspace_brand_get`。另一条以只读授权通过 MCP JSON-RPC 请求目录中未向该授权公开的写工具，得到 `denied / TOOL_UNAVAILABLE`。终端决策由只在回环地址监听的固定验收夹具驱动。

| 场景 | Commands `request_id` | Operations `request_id` |
| --- | --- | --- |
| 同名读调用 A | `5493e343-df1d-4eb5-9ffb-75a7ae458931` | `b83c4a3e-d224-4cfe-af14-d4c80031868d` |
| 同名读调用 B | `9019d660-44d7-4607-bb81-62ceb0c44313` | `cf49070e-3105-4ccf-87c3-5602f9da7eb6` |
| 第二授权读取 | `7b1c4eb7-8e5c-4548-822f-00a5148a31d6` | `1512000c-a30d-4af2-9d8b-3e906d8caf60` |
| 业务失败 `NOT_FOUND` | `ec28849c-55ab-42c3-a266-426e923dc23f` | `d96b46c1-1e62-47fc-9b88-f4bf52d33d1f` |
| 首次写入 | `b30db82f-c988-424e-9dc5-292f23d04e23` | `66e0c784-68d1-4c5b-9590-972bb4982eae` |
| 原幂等键重放 | `679a9cc7-a206-4726-8bdb-823ecd446d47` | `32d87712-e0a9-4142-a1d3-5fb1c6ff243b` |
| 只读授权写入拒绝 | `a2e2845f-b7ac-4c2c-bfec-103103d2f632` | `c8d87980-59b7-43c9-a332-574b5f4837f2` |
| 桌面能力 `unsupported` | `db8d4c05-ebcb-443c-be94-9f09d0eb39af` | `e631afa8-3d7c-42d1-94c2-4a004381799f` |

Commands 的品牌写入只有一条版本为 1 的业务记录。Operations 的草稿写入只增加一次业务版本。两套服务均返回跨工作区查询 `404`，无法识别的 Bearer 请求返回 `401`，同请求 ID 下审计结果为零。私密内容及凭据探针均未出现在审计响应内。Web 记录包含原请求 ID 和调用 ID，重放显示「已重播」，桌面回执可按「不支援」筛选。

- Commands 实测记录 [终端及 HTTP](main-run-a4xwj5/commands-terminal.json) · [Web](main-run-a4xwj5/commands-web.json)
- Operations 实测记录 [终端及 HTTP](main-run-a4xwj5/operations-terminal.json) · [Web](main-run-a4xwj5/operations-web.json)

## 回归结果

`pnpm build` 通过。完整 `pnpm test` 通过，Node 710 项、Vitest 147 项、Playwright 104 项通过。Node 有 29 项按环境条件跳过，包括需独立 PostgreSQL 或 MinIO 的用例，Playwright 有 3 项跳过。最终改动的定向回归另通过 Node 18 项和 Worker 浏览器 5 项。两套服务的实际调用验收使用独立本地存储。

## 复跑

从主工作区根目录运行。脚本使用本机 `claude` 和项目 Playwright Chromium，为每套服务启动独立临时状态，退出时清理状态。每次复跑打印新的 `agent-ops-lab/audit/main-run-*` 证据目录，以上链接对应本次主工作区验收。

```sh
pnpm build
node --import tsx agent-ops-lab/audit/main-run.mjs
pnpm test -- mcp-call-audit mcp-streamable mcp-commands open-api-http worker-onboarding
pnpm test
```
