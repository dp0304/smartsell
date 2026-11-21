# SmartSell 备份与恢复续验

2026-11-20。本次仅使用本地 Docker、loopback 和测试数据。

## 续验基线

- `printenv CLAUDECODE` 返回 `1`。`~/.nvm/versions/node/v24.21.0/bin/node -v` 返回 `v24.21.0`。默认 PATH 中的 Node 21 因缺失 ICU 动态库无法启动，复跑显式选择 Node 24。
- 交接记录 `.local/qa-turn/ops-resume.log` 显示 `bash infra/ops-compose-smoke.sh` 已完成镜像构建、PostgreSQL 迁移和服务启动，随后在第 224 行报出 `POST /api/portal/share` 实际 403、预期 404，备份恢复流程尚未执行。
- `git cat-file -t 193a1dbbb67cf57c3eb1b` 找不到该 Git 对象。最初在 `.local/qa-turn/ops-resume.iq5IU3/tree` 看到交接源码，且其 `infra/` 与修改前工作区无差异。第一次复制时该目录已不存在，`cp` 退出码为 1，未启动 Compose。随后从当前工作区创建独立源码副本完成复跑。

## HTTP 403 定位

测试连接门户的临时 loopback 端口，对 JSON POST 默认发送 `Origin: https://workbench.example.invalid`。`infra/web.conf` 的 8081 监听仅允许 `https://review.example.invalid` 访问指定匿名 POST 路由，其他 Origin 由 Nginx 返回 403。匹配门户 Origin 时，Nginx 仅对这两个匿名端点转发工作台 Origin，并移除 `Cookie` 和 `Authorization`，以满足 Commands 的写请求 Origin 守卫。工作台的认证操作仍使用会话和 `X-CSRF-Token`。

改动落在 `infra/ops-compose-smoke.mjs` 和 `infra/ops-compose-smoke.sh`。HTTP 夹具区分连接地址与浏览器 Origin，不向门户发送工作台会话或 CSRF 令牌。复验断言门户拒绝工作台 Origin（403）、接受门户 Origin 后拒绝无效分享令牌（404）、可读出有效签名分享（200），门户监听上的工作台会话路由仍返回 404。

## 执行命令与结果

下列命令从独立源码目录运行，复用当前 Docker Desktop 的镜像缓存。源码副本由 `rsync -a --exclude='.git/' --exclude='.local/' --exclude='node_modules/' --exclude='dist/' --exclude='.env' --exclude='.env.local' --exclude='.turbo/' ./ "$work/tree/"` 创建。

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node --check infra/ops-compose-smoke.mjs
bash -n infra/ops-compose-smoke.sh infra/ops-snapshot.sh
bash infra/ops-compose-smoke.sh > "$work/compose.log" 2>&1
```

- HTTP 修正后第一次完整演练退出 0。源项目为 `smartsell-ops-7de9a6dd450dee1d`，恢复项目为 `smartsell-ops-3863593260605e4f`。日志位于 `.local/qa-turn/ops-completion.YdzGaZ2M/compose.log`。
- 加上网络隔离与显式 SHA-256、提交记录断言后，完整演练再次退出 0。源项目为 `smartsell-ops-53ef2cb7e43cfe40`，恢复项目为 `smartsell-ops-8c978ebaa5cfce5a`。以下行号均指 `.local/qa-turn/ops-offline.4C07Sn15/compose.log`。

| 检查 | 实测结果 |
| --- | --- |
| 构建与迁移 | 工作台和 API 镜像构建成功。源、目标的 PostgreSQL 健康、迁移成功、server 和 web 健康。 |
| 物理备份与独立还原 | 脚本调用 `bash infra/ops-snapshot.sh backup "$source_project" "$source_env" "$snapshot"` 和 `bash infra/ops-snapshot.sh restore "$target_project" "$target_env" "$snapshot"`。源服务停止后归档 PostgreSQL 与媒体卷，目标校验 SHA-256 清单后向独立空卷解档，轮换 4 个数据库角色的密码并在启动应用前持久化安全模式。原账户、工作区、落地页与分享在目标可读。日志 162–225。 |
| 真实离线运行 | `compose.recovery.yaml` 以 `ROLE=api` 启动。演练临时 overlay 将目标 PostgreSQL、迁移和 server 接入内部恢复网络，移除 PostgreSQL 与 server 的宿主机端口映射。`docker network inspect` 验证网络为 internal，`docker inspect` 验证目标 server 仅加入该网络。宿主机仅通过 Web 的 loopback 入口访问恢复应用。日志 189–225。 |
| 媒体 | 源与目标下载字节均匹配测试原文，SHA-256 均为 `160c5192dcffafdfc73d04c2e69a43b051e7d61b9074bbfb0368b34881bb42d5`。带会话的 Range 返回 206，移除会话后下载返回 401。源拒绝错误哈希上传（422）。日志 161、225。 |
| 恢复核实与零新提交 | 通过 GET 读到恢复前已有的 `unknown` 尝试，并将已知上线的测试回执登记两次。两次返回同一平台记录，状态为 `manual_confirmed`。原尝试转为 `verified_published`，ID 保持一致，尝试计数仍为 1，提交起始字段值未变，待确认副作用清空。目标无 worker 或 scheduler，也无外部平台网络路径。日志 221–225。 |
| 清理与 Git | 以每个项目的 Compose label 查询容器、卷、网络，四个临时项目均无残留，专用 `:smoke` 镜像标签已清空。`docker compose ls` 中原有项目仍在。`git rev-parse HEAD` 与本轮起点一致，`git rev-list --count HEAD` 为 1，`git diff --cached --name-only` 为空。本次新增 0 个 Git 提交。 |

额外回归命令，继续使用 Node v24.21.0。

```bash
node --import tsx --test \
  --test-name-pattern='OP07|OP10 keeps export|restore reconciliation can link|restore starting during publication' \
  tests/acceptance/workspace-access.test.mjs apps/server/src/modules/execution/operations.test.ts
(cd packages/adapters && ../../node_modules/.bin/vitest run test/social.test.ts -t 'Facebook reads later Page account cursors')
```

前者 4 个用例通过，覆盖 `adopt_external` 夹具、只读许可下原尝试可核实和审计可导出、开始恢复后已准备的发布被拦截且适配器提交数为 0。后者 1 个选定用例通过，以进程内 HTTP transport 夹具覆盖 Facebook Page 游标与已上线作品读回。首次在根目录运行 Vitest 还收集到两个隔离源码副本，随后在适配器包目录单独复跑得到上述结果。

## 追加独立复跑

- 本轮 `printenv CLAUDECODE` 返回 `1`，Docker Engine 为 `25.0.3`，Node 为 `v24.21.0`。交接标识 `193a1dbbb67cf57c3eb1b` 在当前 Git 对象库中无法解析。当前工作区的 HTTP 夹具、Compose smoke 脚本、Nginx 配置和备份脚本均与上次离线演练保留的源码副本逐字节一致。本轮从工作区另建隔离源码目录执行。
- 复跑前记录了 Git HEAD，暂存区为空。
- 首次命令已完成源码复制和三项语法检查，启动前因 zsh 的 `status` 为只读变量退出 1。以 `smoke_exit` 保存退出码后，从同一源码副本启动演练。

```bash
umask 077
work=$(mktemp -d "$PWD/.local/qa-turn/ops-recheck.XXXXXXXX")
rsync -a --exclude='.git' --exclude='.local' --exclude='node_modules' \
  --exclude='dist' --exclude='.env' --exclude='.env.*' --exclude='.turbo' ./ "$work/tree/"
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
cd "$work/tree"
node --check infra/ops-compose-smoke.mjs
bash -n infra/ops-compose-smoke.sh
bash -n infra/ops-snapshot.sh
smoke_exit=0
bash infra/ops-compose-smoke.sh > "$work/compose.log" 2>&1 || smoke_exit=$?
printf '%s\n' "$smoke_exit" > "$work/exit-status"
```

- 从原工作区再次执行上节两条选择性回归命令。Node 测试 4 项通过，包含许可证只读时拒绝普通写入（402）、允许审计导出和核实原尝试，以及恢复开始后平台提交计数为 0。Vitest Facebook 读回夹具 1 项通过，5 项由过滤条件跳过。日志为 `.local/qa-turn/ops-recheck.tM9JZwKM/restore-tests.log` 和 `provider-test.log`。

本轮 `bash infra/ops-compose-smoke.sh` 退出 **0**。源项目为 `smartsell-ops-2afa7087ba2d175b`，目标为 `smartsell-ops-d2f9599638239c0c`。下列行号对应 `.local/qa-turn/ops-recheck.tM9JZwKM/compose.log`。

| 检查 | 本轮结果 |
| --- | --- |
| 门户和工作台 | Nginx 按门户监听校验 `Origin`。`Origin: https://workbench.example.invalid` 返回 403，`Origin: https://review.example.invalid` 带无效分享令牌返回 404，有效签名分享返回 200。门户上的工作台会话端点返回 404。工作台会话为 Secure，并获取 CSRF 令牌完成认证写入。日志 216–219、282–283。 |
| 物理备份和独立恢复 | `ops-snapshot.sh backup` 停止源端写入、归档 PostgreSQL 和媒体卷并生成 SHA-256 清单。`ops-snapshot.sh restore` 校验清单、向独立项目的空卷恢复、轮换四个数据库角色密码、写入安全模式。源和目标均成功迁移，server 和 web 健康。日志 198–216、220–280。 |
| 恢复网络 | `docker network inspect` 显示 `${project}_recovery` 的 `Internal` 为 `true`。`docker inspect` 显示 PostgreSQL 和 server 仅接入该网络且无宿主机端口，Web 的 8080 和 8081 仅映射到 `127.0.0.1`。详情见同目录 `recovery-runtime.log`。 |
| 离线核实和零新平台提交 | 目标使用 `ROLE=api` 并以持久化安全模式启动。读取原 `unknown` 尝试，重复登记同一份测试回执得到同一平台记录。原尝试转为 `verified_published`，尝试计数仍为 1，提交开始字段保持原值，待确认副作用清空。离线 HTTP 演练使用手工测试回执，单独的发布围栏测试直接断言适配器 `submit` 调用为 0。日志 279–281、`restore-tests.log`。 |
| 媒体 | 备份前和恢复后下载的字节均匹配原文，SHA-256 均为 `160c5192dcffafdfc73d04c2e69a43b051e7d61b9074bbfb0368b34881bb42d5`。两侧 Range 请求均返回 206，去掉会话均返回 401。源端错误哈希上传返回 422。日志 219、283。 |
| 清理与零 Git 提交 | 两个本轮项目的容器、卷、网络和两个专用镜像标签均无残留。`docker compose ls` 仍列出原有项目。Git HEAD 与本轮起点一致，`git rev-list --count HEAD` 返回 1，暂存区为空，新增提交为 0。日志 284–329。 |

清理核验使用 `docker ps -aq`、`docker volume ls -q`、`docker network ls -q`，各自传入 `--filter "label=com.docker.compose.project=$project"`，并用 `docker image ls -q "$image"` 检查本轮专用标签。Git 核验使用 `git rev-parse HEAD`、`git rev-list --count HEAD` 和 `git diff --cached --name-only`。

## 外部待验

- 以具备所需 scope 的真实测试账号、独立恢复环境及已知一小时前的备份，读回已上线测试作品，验证 `adopt_external` 与真实平台零新提交。此处物理还原使用新建的本地快照和测试回执，平台适配器覆盖来自离线夹具。
- OP01 的真实商家前置检查、固定出口 IP 与平台 allowlist 的实际 403，以及 `ROLE=all` 连真实平台的发布与回执读回，仍需要获授权的外部测试环境。OP10 的真实已上线作品回执核实仍待验。

## OP01 隔离本地续验

2026-11-20，在 `CLAUDECODE=1` 会话继续。宿主和临时应用镜像均使用 Node v24.21.0。沿用已通过的物理恢复记录。以下两项使用独立 Compose 项目、空白 PostgreSQL 与媒体卷。应用容器仅接入 Docker internal 网络，宿主通过绑定到 `127.0.0.1` 的 TCP 转发访问应用 HTTP 端点。平台数据均为测试数据。

### 独立 worker 停止后显示离线

已通过原稿 `plan.md` §5.19.12 的 OP01 30 秒条件。复用中断前已经落盘的 `smartsell-op01-h8l9vbnv-split` 演练。`ROLE=api` 与 `ROLE=worker` 分别启动，健康端点先读到 `unknown`，随后读到两者 `online`。测试以管理员会话约每 200 毫秒 GET `/api/v1/workspaces/:workspaceId/admin/health`，持续读取同一端点并执行 `docker compose stop worker`。无会话请求返回 401。

| 事件 | UTC 时间 |
| --- | --- |
| 发出停止请求 | `01:34:42.622` |
| Docker 记录 worker 退出 | `01:34:42.757022126` |
| 最后一次读到 worker `online` | `01:35:11.474` |
| 首次读到 worker `offline` | `01:35:11.683` |

从容器实际退出到首次读到离线为 **28.926 秒**，从发出停止请求算起为 **29.062 秒**。连续 5 次采样确认 worker 离线，从发出停止请求到采样结束，API 一直为 `online`，健康端点继续返回 HTTP 200。采样脚本和原始记录保存在 `.local/qa-turn/op01.h8L9vbNv/heartbeat.mjs`、`split.log`（第 52–212 行）和 `split-services.log`。

### 单应用容器 `ROLE=all` 合成回执主链

现有 `tests/acceptance/launch-campaign.test.mjs` 已用本机 SQLite 跑通 §7.1，现有 `ROLE=all` 冒烟记录覆盖登入、目录、权限、幂等和登出。隔离 Compose 上从商品导入到结案的证据在中断时尚未完成。首次运行到发布预检后，PNG 凭证上传完成接口返回 503 `MEDIA_UNAVAILABLE`。确认镜像缺少 PNG 探测所需的 `ffprobe`，续验仅将临时夹具的凭证替换为 `text/plain` 合成回执，保留上传长度、SHA-256 校验和执行凭证关联。

`smartsell-op01-h8l9vbnv-all-retry` 启动单一 SmartSell 应用容器，容器内确认 `ROLE=all`。PostgreSQL 和 loopback 转发各自独立，无单独的应用 worker 或 scheduler 容器。复用 §7.1 测试的业务断言，经应用 HTTP 入口运行，结果 **1 项通过、0 项失败**。流程从 CSV 商品导入、活动和内容、审批排期及发布前检查，走到合成发布回执登记（`manual_confirmed`、执行状态 `published`、人工尝试 `verified_published`）、合成评论分派和人工回复回执、指标写入、冻结报告及结案。重启应用容器后可读回结案和原冻结报告，补录指标生成的第二版报告也可读回。

临时启动套件及日志位于 `.local/qa-turn/op01-all-retry.QPBd0N4d/`，运行命令为 `bash .local/qa-turn/op01-all-retry.QPBd0N4d/compose-run.sh all`，`all.log` 第 39–54 行记录环境及结果，`all-services.log` 记录应用启动与重启。本地证据覆盖 §7.1 测试的人工回执路径。PNG 凭证处理、官方 API 或连接器向真实平台的提交与读回，以及 §7.1 的 P1 创作者协作与平台订单同步均未纳入本次验证。

已核对两个临时环境的容器、卷和网络均已清理，保留专用测试镜像及日志以便复现。

### OP01 媒体镜像修复复验

2026-11-20，在 Claude Code 2.1.311（`CLAUDECODE=1`）、宿主 Node v24.21.0 和 Docker Engine 25.0.3 下复验。`infra/Dockerfile` 使用 `node:24.21.0-trixie-slim`，通过 apt 仅显式安装 `ffmpeg`，关闭推荐包并清理 apt 索引。该包同时提供 `ffprobe`。上传探测与缩略图、图像衍生处理依赖可 seek 的 `fd:` 输入，Bookworm 的 FFmpeg 5 缺少该协议。ARM64 原生和 AMD64 模拟构建均成功，镜像内 Node 为 v24.21.0，`ffmpeg`、`ffprobe` 均为 `7.1.5-0+deb13u1`，两个程序均列出 `fd`。本轮构建及执行未遇到 apt 或 CPU 障碍。

用新构建的 ARM64 镜像启动 `smartsell-op01-media-02ipwcna` 的默认 `/app/infra/start.sh`。单个 SmartSell 应用容器运行 `ROLE=all`，以 UID 1000 的 `node` 用户执行，`/var/lib/smartsell/media` 权限为 `0700`、属主为 `node:node`。应用、迁移和 PostgreSQL 仅接入内部网络，HTTP 通过绑定在 `127.0.0.1` 的临时转发访问。全程使用合成数据与新建卷。

| 检查 | 本轮结果 |
| --- | --- |
| PNG 发布凭证 | 复用 `tests/acceptance/launch-campaign.test.mjs` 内置的 1×1 PNG。上传完成和签名下载均返回 200，下载的 68 字节与原始夹具逐字节一致，SHA-256 为 `6e2dd924430f769cd1b65f5eac67456b092be0c0b205985a1efe33bab98f91bf`。同一文件随后用于登记发布回执。 |
| MP4 上传与读取 | 通过同一 HTTP 入口上传一个将 `moov` 置于媒体数据之后的 2 秒 H.264 MP4。上传完成返回 200，探测尺寸为 96×64。两次 Range 下载均返回 206，拼接后的 2,929 字节与原视频一致，SHA-256 为 `4c59e797c1d6e6c77d133252d41bd23ee176c511c188ce0c5d0185a82dacf199`。 |
| 缩略图与图像处理 | `tests/media/files.test.mjs` 的真实视频探测、分段播放与 JPEG 缩略图用例在 ARM64、AMD64 镜像各通过 1 项。`apps/server/src/modules/asset/asset.test.ts` 的图像缩略图、裁切及缩放用例在 ARM64 镜像通过 1 项。额外的 Compose HTTP 视频缩略图试验在约 20 秒轮询后仍为 `queued`，该入口的后台派送未验证通过。 |
| §7.1 合成发布主链 | 使用复用的业务断言，从 CSV 商品导入、活动和内容、审批排期及预检，走到使用 PNG 的人工发布回执（`manual_confirmed`、`published`、`verified_published`）、人工回复回执、冻结报告及结案。重启同一应用容器后成功读回结案和冻结报告，并验证第二版报告。**1 项通过、0 项失败。** |

本轮启动脚本和证据保存在 `.local/qa-turn/op01-media.02Ipwcna/`。`all.log` 第 39–89 行记录容器、媒体和发布链的断言结果，`all-services.log` 记录默认入口的启动与重启。`build-arm64.log`、`build-amd64.log` 和 `runtime-amd64.log` 记录构建和模拟执行，`media-tests.log`、`media-tests-amd64.log`、`asset-test.log` 记录媒体用例，`thumbnail-http-attempt.log` 保留排队试验结果。本轮 Compose 的容器、网络、卷及两个专用应用镜像均已清理，临时凭据文件已删除。沿用上文的物理恢复记录。真实平台提交、回执读回和商家前置检查仍待授权环境复验。Git HEAD 不变，无新增提交。

### OP01 视频缩略图后台派送续验

2026-11-20，在 Claude Code 2.1.311（`CLAUDECODE=1`）下执行。默认 PATH 中的 Node 21 仍因缺少 ICU 动态库无法启动。宿主显式选择 Node v24.21.0，两个 ARM64 镜像内也均为 v24.21.0。Docker Engine 为 25.0.3。每轮使用新的 Compose 项目、PostgreSQL 和媒体卷，经 `127.0.0.1` 转发访问默认 `/app/infra/start.sh` 启动的应用。PostgreSQL、迁移和应用仅接入内部网络。视频由容器内的 FFmpeg 合成，为 2 秒、96×64 的 H.264 MP4。

保留的 `thumbnail-http-attempt.log` 和 `thumbnail-http-services.log` 显示早先的 `ROLE=all` 请求约 20 秒仍为 `queued`，任务尝试号为 1，服务日志未记录后台循环或 outbox 错误。正式入口从 `infra/start.sh` 进入 `command-main.ts` 和 `bootstrap.ts`。资产上传完成后，创建视频资产会提交 `asset.rendition.requested`。`asset.thumbnail` 已注册为 `media` 队列的 subscriber，后台循环每秒检查一次，调度、事件派送和作业执行在同一轮内顺序运行。缩略图不依赖发布审批。修复前的 `ROLE=all` 复测已成功，旧试验超时的具体原因无法从现有日志确定。

`ROLE=api,media` 则稳定复现了入口缺陷。原启动条件只检测 `worker` 和 `scheduler`，仅启用 `api,media` 时后台循环未启动，已提交的缩略图事件一直未处理。`apps/server/src/bootstrap.ts` 将 `media` 纳入同一条件，既使用现有的后台数据库登录校验，也启动现有媒体 subscriber。沿用原上传、签名下载和数据库角色隔离。

| Compose 复验 | HTTP 实测 | 保留日志 |
| --- | --- | --- |
| 修复前 `ROLE=all`，空白工作区 | `queued` → `ready` 1.652 秒，JPEG 下载 200。退出 0。 | `.local/qa-turn/media-background.lqLmHxrq/baseline.log` 76–88 行 |
| 修复前 `ROLE=all`，复用上次前置负载至发布预检 | `queued` → `ready` 10.685 秒，JPEG 下载 200。退出 0。 | `.local/qa-turn/media-workload.nOQThzxU/compose.log` 76–89 行 |
| 修复前 `ROLE=api,media` | 100 次轮询均为 `queued`，测试约 27 秒后以状态断言失败退出 1。 | `.local/qa-turn/media-role-baseline.9t9qzZ4D/compose.log` 76–103 行 |
| 修复后 `ROLE=api,media` | `queued` → `ready` 0.860 秒，尝试号 1，签名下载 200，同链接无会话返回 401。退出 0。 | `.local/qa-turn/media-fixed.chvqJEsK/compose.log` 76–88 行 |
| 修复后默认 `ROLE=all` | `queued` → `ready` 1.909 秒，尝试号 1，签名下载 200，同链接无会话返回 401。退出 0。 | `.local/qa-turn/media-all-fixed.G57G49My/compose.log` 76–88 行 |

计时从请求缩略图前到首次读到 `ready`，包含 HTTP 和轮询间隔。两轮修复后试验均确认显式请求复用创建资产时自动产生的同一任务 ID。下载文件为 `image/jpeg`，644 字节，SHA-256 为 `36fe477ba6d1884c4e9d77c48eb2f08b7dc4dc5bbee8deafca08e98e81c2bc66`。`ffprobe` 识别为 320×213 MJPEG，`ffmpeg` 成功解码一帧，见对应目录的 `jpeg-decode.log`。

从仓库根目录运行的命令如下。保留的 `compose-run.sh` 使用 `docker compose --profile server up --detach --no-build --pull never --wait --wait-timeout 120 server relay`，校验内部网络、生成视频并调用 `node --test "$work/launch-compose.test.mjs"`。

```bash
export PATH="$HOME/.nvm/versions/node/v24.21.0/bin:$PATH"
node -v
base=.local/qa-turn/media-background.lqLmHxrq
fixed=.local/qa-turn/media-fixed.chvqJEsK
all=.local/qa-turn/media-all-fixed.G57G49My
# 修改 bootstrap.ts 前
docker build --progress=plain -f infra/Dockerfile -t "smartsell-op01-media:${base##*.}" .
bash "$base/compose-run.sh" all
bash .local/qa-turn/media-role-baseline.9t9qzZ4D/compose-run.sh all
bash .local/qa-turn/media-workload.nOQThzxU/compose-run.sh all
# 修改 bootstrap.ts 后
docker build --progress=plain -f infra/Dockerfile -t "smartsell-op01-media:${fixed##*.}" .
node --check "$fixed/launch-compose.test.mjs"
bash -n "$fixed/compose-run.sh"
./node_modules/.bin/tsc --noEmit -p tsconfig.json
bash "$fixed/compose-run.sh" all
bash "$all/compose-run.sh" all
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of json "$fixed/thumbnail.jpg"
ffmpeg -nostdin -v error -xerror -i "$fixed/thumbnail.jpg" -frames:v 1 -f null -
```

语法检查和类型检查退出 0。五个临时项目的容器、网络、卷和凭据已清理。核实两个本轮镜像没有容器引用后，对其专用标签分别执行 `docker image rm --no-prune`，清理前后的既有镜像清单一致，详见 `.local/qa-turn/media-fixed.chvqJEsK/cleanup.log`。本轮复用既有备份恢复、整视频探测和发布结案证据。Git HEAD 不变，暂存区为空，状态清单与开工时一致。

在媒体验证通过后，工作区出现并行的发布与报表改动。保留这些改动，从当时的工作区重建镜像并再次执行两种角色的 Compose 检查。镜像构建退出 0，两个 Compose 检查均退出 1，应用在健康检查前因 `analytics/reports.ts` 引用的 `metricIngestProvenance` 未由 `ingest/evidence.ts` 导出而退出，因此该快照未建立新缩略图任务。`tsc` 也报告同一导出错误及 `analytics-http.test.ts` 中 `versions` 的两处隐式 `any[]` 错误。媒体启动条件仍在。命令和证据如下。

```bash
current=.local/qa-turn/media-current.riRaoLSV
current_all=.local/qa-turn/media-current-all.ClMIzTs9
docker build --progress=plain -f infra/Dockerfile -t "smartsell-op01-media:${current##*.}" .
bash "$current/compose-run.sh" all
bash "$current_all/compose-run.sh" all
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

两个目录的 `all-services.log` 保留实际异常，`media-current.riRaoLSV/typecheck.log` 保留编译输出。第三个本轮镜像在确认无容器引用后也以 `docker image rm --no-prune` 清理，两个新增项目的容器、网络、卷和凭据均已清理，既有镜像清单一致。见 `media-current.riRaoLSV/cleanup.log`。
