# TikTok Shop 关闭库存后的商品同步续验

本轮由 Claude Code 2.1.311 会话执行。测试使用 Node v24.21.0（本机 NVM）和 pnpm 10.11.0。HTTP 验收启动正式 Commands 服务，并将合成平台请求转到 `127.0.0.1`。

[指定日志](../../.local/qa-turn/verify-page-delivery-log.NDOG2z#L772) 中的 `sync_capability_unavailable` 在修改前复现，适配器测试 55 通过、1 失败。当前日志的 SHA-256 为 `b84f05f9c562b98b4ad868606d9351267f84e8bd211235c75673ff7e13f747f9`，与任务附的 `e719b5b100102aafa971538aef55149b8dc86af5aa76c70654a5fc17931d1cf0` 不同。路径、用例、错误和堆栈位置相符。

失败发生在 provider 请求之前。原夹具给 TikTok Shop 传了 Shopify 的 `read_products`，而 TikTok Shop 商品读取要求 `seller.product.info`。测试夹具现按平台提供授权，并用分页终止标记与总数模拟 TikTok Shop 的完整单页。生产能力规则保持原样。 [能力声明](../../packages/adapters/src/provider-catalog.ts#L55) · [授权检查](../../packages/adapters/src/official.ts#L122) · [适配器夹具](../../packages/adapters/test/trade.test.ts#L155)

HTTP 回归在关闭库存时完成商品快照。对端仍返回库存，但读回的新商品有 USD 20.00 的价格、空库存数量及 `unknown` 库存状态。只授予 `seller.order.info` 时，库存开关两种状态都以 `authorization_required` 失败，均无目录请求。原用例继续覆盖双页重试、空页与总数异常、重绑及旧授权迟到响应、历史引用和未观测商品。 [HTTP 用例](../../tests/acceptance/commerce-tiktok-catalog-http.test.mjs#L313)

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @smartsell/adapters exec vitest run test` | 6 个文件，56/56 通过 |
| `node --import tsx --test tests/acceptance/commerce-tiktok-catalog-http.test.mjs` | 1/1 通过，无跳过 |
| `node --import tsx --test tests/acceptance/commerce-variant-http.test.mjs tests/integration-contract/shopify-catalog-mapping.test.ts` | 3/3 通过，无跳过 |
| `pnpm typecheck` | 通过 |
