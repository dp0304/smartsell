# PC02 商品变体与 SKU 对照验收

依据 [plan.md §5.4.12](../../plan.md#L3213) 和 [原始构思 PC02](../../社媒運營系統_完整功能方案_繁體.md#L300)。本轮使用本地合成商品 CSV、图片和账号。HTTP 测试在 `127.0.0.1` 的临时端口运行实际 Operations 服务，使用独立文件数据库和本地媒体目录。第二工作区和只读成员通过测试夹具开通，其余业务数据由正式 HTTP 路由建立和读回。

| 场景 | 实测结果 |
| --- | --- |
| 区分两店同 SKU | 通过 HTTP 新建两家店并分别预览、确认 CSV。两个文件使用同一 SKU、同一外部商品和变体 ID，颜色与尺寸不同。按 SKU 查到两个商品和两个独立变体，且各自关联原店、原商品和文件导入来源。起初没有对照群组。 |
| 显式对照及拆分 | 手动建立群组并分别加入两个原变体。解除南店变体的对照后，北店成员仍有效。南店历史成员保留其 ID、变体、店铺、群组、人工依据、操作者、拆分时间和原因。另从持久化审计读回建组、关联和拆分操作。 |
| 原始内容和业务引用 | 对照有效时建立活动、素材和内容修订，指向南店变体及原价格快照。拆分后再提交一版文案并移除新版本商品引用，旧修订仍逐字段相同。南店商品仍可查到历史修订、活动和素材使用，北店商品的使用处为空。 |
| 隔离与重复请求 | 同一所有者进入同租户的第二工作区，SKU 搜索和群组列表查不到源记录，直接读原店、原群组成员、商品使用及内容修订返回 `404`，关联或拆分跨工作区对象亦返回 `404`。只读成员可读对照并在拆分时收到 `403`。同键重放建店、导入、确认、建组、关联及拆分复用结果。同键异参返回 `422`，以新请求重复关联返回 `409`，重复拆分保留首次原因。 |

复用现有商品导入、对照成员、不可变内容修订及权限与审计机制。商品使用 API 补查原变体引用与素材关系，并暴露活动的原商品关系行，供工作台按变体筛选。群组列表补充用于辨识同 SKU 的商品资料，新的成员记录保存建立者与店铺。见 [商品目录及对照 API](../../apps/server/src/modules/commerce/catalog-operations.ts) 和 [HTTP 验收](../../tests/acceptance/commerce-variant-http.test.mjs)。

## 实际执行命令与结果

Node.js 24.21.0，pnpm 10.11.0。在仓库根目录执行。

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --import tsx --test tests/acceptance/commerce-variant-http.test.mjs apps/server/src/modules/commerce/{commerce-operations,commands,import-api}.test.ts
```

HTTP 与 Commerce 回归 **18/18 通过**。

```bash
node --import tsx --test tests/acceptance/commerce-variant-http.test.mjs apps/server/src/modules/commerce/{commerce-operations,commands,import-api}.test.ts apps/server/src/modules/content/content.test.ts
```

扩展运行最终 **43/43 通过**。早一轮中 CO08 因夹具的商品事实修订缺少对应语言的可用值或来源返回 `422 invalid_product_reference`，PC02 在两轮均通过。

```bash
pnpm exec playwright test tests/web-e2e/commerce-variant.spec.mjs
```

Chromium **1/1 通过**。实际默认工作台可按 SKU 找到两店商品，建立群组、选择各店的原变体、提交拆分原因，刷新后仍可看到拆分历史及北店有效对照。初次运行遇到非 PC02 模块编译错误和本地启动超时，另一次发现默认路由尚未接入新控件。完成路由接入并用实际下拉框角色定位后，以上命令通过。见 [浏览器验收](../../tests/web-e2e/commerce-variant.spec.mjs)。

```bash
pnpm typecheck
```

根工作区 TypeScript 检查最终通过，退出码为 `0`。
