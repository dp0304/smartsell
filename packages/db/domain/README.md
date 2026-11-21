# PostgreSQL 17 领域仓储

`100_domain_schema.sql` 展开 `plan.md` §4–§5 明确给出 DDL 的 188 个表名和 `@std`、`@ws`、`@actor`、`@ver`。先建表，再按作用域添加外键、唯一约束和索引。`101` 安装强制 RLS 和身份、审计桥接。`102`–`105` 补齐发布链路、分区滚动、后台角色隔离和部分导入关系。按表名列出、未给出 DDL 的 P1/P2 项目仍依各模块现有实现。

`pnpm db:migrate` 继续使用原入口。它用同一事务、事务级 advisory lock 和校验和账本应用核心与领域迁移。`migrate:all` 还会调用独立 Operations kernel 的迁移入口。已应用的 SQL 文件应保留原校验和，新变更追加编号。与已有领域 schema 同名的对象会使迁移失败并回滚。`ss` 和 `smartsell` 的既有对象继续使用各自的 schema。

## 运行时与兼容范围

| 路径 | PostgreSQL Commands 服务 |
| --- | --- |
| 身份与授权 | `ss` 继续管理凭据、登录、会话和成员资格。租户、工作区和用户 ID 同步到领域表。 |
| 品牌、商品、活动、内容和发布 | Commands 挂载的 Operations HTTP 路径将可映射的品牌、市场、店铺、商品及变体、活动、内容版本、发布计划与目标写入领域表。API 记录仍由 `ss.entities` 枚举。版本一致时，从类型化列读取映射字段。 |
| 审批、执行、证据、审计 | 发布 Operations 的请求、真人决定、任务、尝试、平台结果、文件和证据与兼容记录在同一事务写入。`ss.audit` 保留事件与 outbox 关联。已有成功审计同步到 `core.audit_event`。操作失败时，审计和业务记录一起回滚。 |
| 兼容路径 | 未映射字段、旧数据、无法表达为领域列的记录、Commands 的旧发布审批与部分执行状态、设备控制、导入、分析、协作、广告和投放等路径仍从现有通用仓储读写。部分已声明表只提供 DDL 与约束，尚未成为运行时写入目标。 |
| 公共入口与独立 kernel | 公开分享/流量入口使用其既有定位器权限。独立 `start:kernel` 与 Operations Compose overlay 在 `smartsell.record` 中持久化。 |

`apps/server/src/postgres-domain-mappings.ts` 列出字段级投影范围和可从类型化表回读的列。既有通用业务记录原样保留。兼容记录在修改或作为新记录的父对象时按需投影，历史业务记录尚无全量回填。使用领域表做历史报表前，要单独完成回填及核对。旧记录中的非 UUID、跨工作区重复 UUID 或缺少必填字段等情况可能只留在兼容仓储。`resource_type`／`resource_id` 等多态引用和 JSON 内部 ID 由应用检查，适用的直接引用由数据库检查。`ingest.raw_record.webhook_delivery_id` 仍为关联线索，分区后的交付表需要同时给出 `received_at` 才能建立外键。

## 角色和分区运维

API 登录继承 `smartsell_request`。应用连接在授权事务内设置范围。范围参数还需要有效会话与工作区成员资格，或受限的后台事务凭证。数据库拥有者负责迁移与分区运维。API-only 可在未配置后台角色时启动。启用 worker、scheduler 或已配置的电商回调时，部署需要独立 `BACKGROUND_DATABASE_URL`。Compose 可用 `SMARTSELL_BACKGROUND_PASSWORD` 生成此 URL，新卷初始化时创建 `smartsell_background`（NOLOGIN）与 `app_background`。已有卷由数据库管理员预配这些角色、授予 `app_background` 数据库 CONNECT 和对 `smartsell_request`、`smartsell_background` 的继承，然后用原迁移入口升级。若在后台角色缺席时已记录 `104`，后续创建角色后，由迁移所有者通过 `psql -X -v ON_ERROR_STOP=1 --single-transaction -f packages/db/domain/104_domain_background.sql` 安装该角色的函数授权。

8 个分区父表包含时间列在主键内。`intel.observation` 按 UTC 季，其余按 UTC 月。安装时预建前一期、当期和未来三期，并保留默认分区。以迁移所有者身份定期执行 `SELECT core.ensure_domain_partitions();`。函数可以将已落入默认分区的目标区间行原子迁移到新分区，并拒绝名称或边界冲突。该操作需要排他锁，适合维护窗口。按表保留期清理与分区调度由部署负责，应用尚未定时执行领域分区维护。

## 验收

`bash tests/acceptance/domain-postgres.sh` 使用本地已缓存的 `postgres:17-alpine`，为完整建库、故障回滚、旧库升级和 HTTP 路径建立独立数据库。脚本检查表及宏展开、强制 RLS、索引、月/季度分区、双租户与同租户跨工作区隔离、后台角色、重复执行，以及真实发布链路中的外键、唯一性和事务回滚。
