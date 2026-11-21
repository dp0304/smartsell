# 采集、店铺与广告本机续验

范围为 DS04、DS05、PC02、AD05。使用 Node v24.21.0、本机合成数据和对端。历史 `.local/qa-turn/data-commerce-e2e.log` 的两条 PC02 用例均在 Chromium 启动时以 `SIGTRAP` 退出。本页以本轮复跑结果为准。

| 能力 | 本轮结果 |
| --- | --- |
| DS04 乱序事件与回退轮询 | 商品和刊登已有较新状态时，较旧 webhook 的读回无法使资料倒退。回调不可达后，轮询节奏按来源限制调整。工作台显示 `callback_unreachable`，可达性恢复后原因清除。 |
| DS05 修正档重导与原批次追溯 | 第一份 CSV 的错误行没有生成商品。操作员从工作台上传修正版、预览并确认，读回有效商品。修正批次的 `supersedes_batch_id` 指向原批次，原错误行仍可从错误文件下载。 |
| PC02 新工作台批量人工审查 | Chromium 通过同 SKU 商品查找及拆分历史用例，也通过同条码候选的批量审查用例。人工审查后各店商品仍有各自的主档。五个平台的实际商家目录同步仍待验证。 |
| AD05 Meta 暂停与送审边界 | 两条本地验收均通过。暂停操作须先审批，API 接受与独立读回分开记录，未知写入不会被再发。该对端只验证暂停操作，真实广告送审、投放及跨平台创建重试仍待验证。 |

2026-11-20（UTC+8），独立复跑以下 4 项 Node 验收及 4 项 Chromium 验收，全部通过。浏览器同批另有 OP02 的私有管理页用例通过。

```sh
node --import tsx --test \
  --test-name-pattern='older webhook catalog|callback fallback accelerates|AD05 HTTP approval|AD05 Meta campaign pause' \
  apps/server/src/modules/ingest/operations.test.ts apps/server/src/modules/ads/workspace-ads.test.ts tests/acceptance/ads-http.test.mjs
SMARTSELL_E2E_PREVIEW=1 pnpm exec playwright test \
  tests/web-e2e/commerce-variant.spec.mjs tests/web-e2e/ingest-quality.spec.mjs \
  --grep 'PC02|DS04 source details|corrected import' --workers=1 --retries=0
```

[先前的服务端实跑输出](../../.local/qa-turn/commerce-ingest-ads-resume-node.log) · [先前的浏览器复跑输出](../../.local/qa-turn/commerce-ingest-resume-browser-final.log)

## PC01、PC03、PC06、PC07 工作台缺口续验

范围仅为 [plan.md §5.4.12](../../plan.md#L3208) 与 `evidence.json` 对应的四项缺口；不重列已通过的领域证据，不改变共享验收状态。先核实实际运行时：`claude --version` 为 Claude Code 2.1.311，独立 `claude -p --model claude-opus-5-5` 探针返回成功且用量标识为 `claude-opus-5-5`。应用与浏览器测试用本机 `~/.nvm/versions/node/v24.21.0/bin` 上的 Node v24.21.0、pnpm 10.11.0 和 Playwright 1.65.1。PC03 和 PC01 补边由该实际 Claude Code 会话实现，PC01、PC06、PC07 也用实际 Claude Code 做了复核。

| 缺口 | 本机验收结果与测试锚点 | 仍需商家配合 |
| --- | --- | --- |
| PC01 商品页同步中、失败/重试 | [商品页同步用例](../../tests/web-e2e/commerce-store-sync.spec.mjs#L54)：待首个快照时，店铺商品页和未筛选商品页显示「同步中」而非空清单；Shopify 回环故障显示 `provider_request_failed`，从商品页重试同一任务，第 2 次成功，无需刷新页面即可看到商品。首次成功后再次同步时，未筛选商品页仍能显示失败和重试，并保留已同步商品。 | Shopify 每商家 custom app 和实际只读授权，适用时核对固定出口 IP/allowlist；TikTok Shop 应用审查、商家商品读权限及店铺绑定；正式环境另验回调和定期核对。后续阶段的平台不计为已验证。 |
| PC01 升级不中断内容引用 | [原地升级用例](../../tests/web-e2e/commerce-store-sync.spec.mjs#L104)：正式 CSV 确认及内容修订写入后，在店铺工作台关联合成授权、建立资料来源并启动目录同步。回环返回相同平台 ID 后，原商品、SKU、快照可继续解析，提交过的修订与反查引用完全相同。独立[映射回归](../../tests/integration-contract/shopify-catalog-mapping.test.ts#L10)确认无平台 ID、无 SKU 的旧 CSV 可用完整 handle/选项原地关联；缺字段的选项不强行匹配，留待人工处理。 | 真实商家店铺需用原始平台 ID 对账后逐店升级；本轮只覆盖 Shopify 回环，不推断 TikTok Shop 或其他平台结果。 |
| PC03 未取得、拒绝换汇估计 | [价格和文案用例](../../tests/web-e2e/commerce-market-price.spec.mjs#L7)：缺价格以「未取得」警示徽标显示；内容选择器不提供 FX 估计，直接调用插入和草稿端点同样被拒且草稿不变；缺价、异市场、过期和被替换的价格也不可插入。正向对照从工作台插入当前价格，提交后保留原快照和文字。汇率只是输入夹具：用 Analytics 命令记录合成汇率，仅将该汇率桥接到隔离的 Operations 数据库，商品快照与内容始终走正式端点。 | 真实 Shopify Markets 的启用状态、市场币别、实际价格与相关读取权限；TikTok Shop 市场绑定及授权；Amazon/Shopee 逐市场、Lazada 逐站点另按分期核对。 |
| PC06 同一改价、旧批准失效 | [改价发布联动用例](../../tests/web-e2e/commerce-changes.spec.mjs#L7)：同一 USD 10→12 快照变更显示旧价/新价及受影响目标，点击链接进入该目标所在日历周并看到批准失效；再点目标后重载仍停在同一周。相同 SKU 的另一渠道目标保持已批准。用目标当前版本重放旧批准 ID/哈希得到 `409 INVALID_STATE`；立即执行仍为 `approval_invalid`，没有尝试记录、待处理副作用或平台作品。 | 本轮用本地记录的价格和手动发布目标。商家授权后从真实价格快照触发该链路，按实际发布平台核验账号权限；本轮没有发外部作品。 |
| PC07 草稿、生效、实际用量及文案提示 | [促销工作台用例](../../tests/web-e2e/commerce-promotions.spec.mjs#L7)：在页面建草稿时为零；内部计划生效不等于店铺验证。通过合成 Shopify 授权和实时回环读回后显示「已验证生效」且仍为零；正式订单同步观察到优惠码后才显示 1 笔。输入文案宣称的错误优惠码、百分比会逐项提示，改成匹配值后提示清除。 | 实际 Shopify 商家必须授予 `read_discounts`、`read_orders` 等适用权限并配置必要的出口允许清单。本轮只验证无额外限制的百分比优惠码；不包含 `write_discounts`、实际创建优惠、组合规则、任意文案解析、Shopee 读回或其他平台导入/归因。 |

TikTok Shop 仍有一个本机未关闭的限制：现有 [worker](../../apps/server/src/integration/commerce-jobs.ts#L225) 只将 Shopify 全量目录标为可权威核对，TikTok Shop 的完整分页读回仍可能以 `partially_succeeded` 结束且不完成首个快照。未将它标成权威数据，以免把未观测的商品误判为已移除。还需按授权店铺查明覆盖范围，将快照完成与移除判定分开验证。

Shopify 合成授权、商品、优惠及订单请求由测试 transport 限定为 `127.0.0.1`，不发真实供应商请求；店铺连接/同步、内容插入、批准及促销等业务操作走工作台或实际 HTTP 端点。未构建或删除 Docker 镜像。

复跑命令（先编译，再用实际 Web 预览和本机应用 HTTP 服务）：

```sh
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --version
pnpm typecheck
pnpm --filter @smartsell/web build
SMARTSELL_E2E_PREVIEW=1 pnpm exec playwright test \
  tests/web-e2e/commerce-store-sync.spec.mjs tests/web-e2e/commerce-market-price.spec.mjs \
  tests/web-e2e/commerce-changes.spec.mjs tests/web-e2e/commerce-promotions.spec.mjs \
  --workers=1 --retries=0
node --import tsx --test tests/integration-contract/shopify-catalog-mapping.test.ts
pnpm --filter @smartsell/adapters exec vitest run test/commerce.test.ts
```

2026-11-20（UTC+8）：类型检查、Web 生产构建、5 条浏览器用例、1 条 Shopify CSV 映射回归以及当前适配器包 11 条测试均通过。[本机实跑日志](../../.local/qa-turn/commerce-pc01-pc03-pc06-pc07-final.log)。`pnpm requirements` 单独报共享 `docs/acceptance/matrix.md` 的生成锚点已过期；按本轮边界未运行生成写入，也未修改共享索引、两份原稿或 Git 历史。

## PC01 TikTok Shop 快照续验

以 Node v24.21.0 和正式 Commands 服务复跑本机 TikTok Shop 双页目录。第二页失败时初次快照仍待完成，重试沿用原游标并最终显示店铺已启用。原商品、SKU、清单引用和内容关联保留，未观察到的旧商品不因缺席下架。空页及分页总量异常受到限制，授权改绑后旧作业的迟到页不会混入新快照。`node --import tsx --test tests/acceptance/commerce-tiktok-catalog-http.test.mjs` 通过 1/1，无跳过。实跑日志为 `.local/qa-turn/tiktok-catalog-independent.AamDU0`。真店的授权和目录覆盖仍待验。 [用例](../../tests/acceptance/commerce-tiktok-catalog-http.test.mjs#L25)
