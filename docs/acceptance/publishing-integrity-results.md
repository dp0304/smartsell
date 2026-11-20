# PL03 与 AS02 本地 HTTP 验收结果

2026-11-20 验收通过。范围为 `plan.md` §5.8.12、§5.9.12 及 `docs/acceptance/evidence.json` 中 AS02、PL03 的剩余 HTTP 验收项。复用了已有的 [HTTP 验收用例](../../tests/acceptance/publishing-integrity-http.test.mjs)，未发现需要修复的应用行为。

## 运行方式

在仓库根目录使用 Node 24、已安装的项目依赖、可用的 Docker 和本地 `postgres:17-alpine` 镜像。本次使用 Node `v24.21.0` 和 pnpm `10.11.0`。

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --version
bash tests/acceptance/publishing-integrity.sh
```

[启动脚本](../../tests/acceptance/publishing-integrity.sh) 为每次运行创建独立的临时 PostgreSQL 容器和数据库，在回环地址分配端口，执行正式数据库迁移，退出时停止本次容器。用例通过 Fastify 的回环 HTTP 监听端口访问正式工作区路由，使用本地初始化会话、CSRF 和数据库请求角色。持久化核对通过单独的只读连接进行。上传写入独立临时目录。两个子用例依次运行，全部使用本地测试数据。

## 用例与结果

### PL03

稳定用例名 `PL03 replays target creation and preserves per-item batch outcomes over HTTP`。

- 连续两次向工作区 `POST /publish-targets` 发送相同请求体和 `Idempotency-Key`。两次均返回 HTTP 200，响应相同且目标 ID 一致。按账号读取实际目标列表只有这一个 ID。目标详情与 `planning.publish_target` 中唯一一条记录均指向预期内容修订。
- 部分提交批次包含一条有效项目和一条引用不存在修订的项目。预览分别显示 `add` 和 `error`。提交及后续操作查询均显示 `partially_committed`，共两项、一项失败。重新读取计划可看到两条逐项结果。有效项目显示 `approval_required` 并返回目标 ID，失败项目显示 `failed` 和具体错误码及消息。目标详情和数据库均确认该计划只创建了有效项目对应的目标。

### AS02

稳定用例名 `AS02 protects referenced asset versions and serves original bytes after rendition failure over HTTP`。

- 经 HTTP 上传原件并创建素材版本、内容修订及排期目标。尝试对已引用版本执行 `PATCH`、`PUT` 和 `DELETE`，均返回 `404 not_found`。现有版本路由提供原件下载和衍生处理，新增版本通过素材的版本集合提交。
- 归档素材后，正式素材删除接口返回 `409 ASSET_REFERENCED`，原始文件删除接口返回 `409 FILE_REFERENCED`。重读工作区资源和持久记录后，版本元数据、文件元数据、素材使用记录、内容修订及排期引用均与操作前一致。
- 通过现有衍生结果 HTTP 接口将测试衍生项从 `processing` 标为 `failed`，正式查询可见失败状态及错误。失败后仍可通过工作区接口获取下载链接并以 HTTP 200 读到原件。首次读取、衍生失败后和最终核对的 SHA-256 均为 `c054eec0ca71070d8406b12c9e0b1745c861d337f4818c5fe8334e1b4c0dc425`。

## 执行记录

- 首次执行因默认环境的 Homebrew Node 缺少 `libicui18n.74.dylib`，在迁移启动时中止，未进入用例。
- 切换到 Node `v24.21.0` 后迁移完成，父用例 `publishing integrity on a fresh local PostgreSQL workspace` 和两个子用例均通过。Node 汇总为 **3 通过、0 失败、0 跳过**。运行中出现 Fastify `disableRequestLogging` 和 `pg` 查询弃用警告，执行退出码为 `0`。
