# SmartSell 媒体字节存储

## 工作区 HTTP

以下路径相对于 `/api/v1/workspaces/:ws`。

| 方法及路径 | 输入和行为 |
| --- | --- |
| `POST /files/uploads` | `size_bytes`、`sha256`（64 位十六进制）、`mime_type`、可选 `purpose` 和 `original_filename`。默认用途为 `asset`。上传上限 512 MiB，保留单有效 15 分钟。管理员可指定 `retention_until`。 |
| `POST /files/uploads/:id/complete` | 小文件可提交 `{ "base64": "…" }`，解码后上限 512 KiB。流式或直传完成后提交 `{}`。返回已验证的文件 ID、SHA-256、MIME 和 `meta`。 |
| `PUT /files/uploads/:id/bytes` | 同工作区、同上传者的原始字节流。发送 `application/octet-stream`、准确的 `Content-Length` 以及正常写请求所需的 CSRF / 认证信息。上传后再调用完成。 |
| `GET /files/uploads/:id/direct` | S3 配置下签发暂存对象的短期 PUT。按响应中的方法和请求头发送 Blob，使客户端自动设置签名所需的 `Content-Length`。上传后再调用完成。 |
| `GET /files/:id/download?inline=true` | 为当前用户签发 120 秒下载链接。链接仍要求工作区身份验证，接受单段 `Range` 和 `If-Range`。浏览器支持的图片、音频、视频可申请内联。其他 MIME 强制附件。 |
| `DELETE /files/:id` | 管理员逻辑删除。仍有引用或法律保留时阻止删除。 |
| `GET /files/retention/preview` | 管理员预览当前到期项及 `blocked_by`。 |
| `POST /files/retention/purge` | 提交 `{ "files": [{ "id": "…", "version": 1 }] }`。重新检查到期条件、记录版本和引用后逻辑删除。 |
| `POST /files/cleanup` | 管理员重试过期上传及逻辑删除后的物理清理。每次最多处理 20 项。 |

## 服务端接线

- 将 `apps/server/src/modules/files/index.ts` 的 `operations` 注册为额外的核心 REST 模块，使用现有 `Operation` 执行器。保持 19 个业务模块统计不变。调用 `registerMediaFiles(app, mediaFiles, { workspace })` 挂载流式 PUT 和字节 GET。若宿主单独挂载这些文件路由，可传入 `{ mountOperations: true }`，与通用路由注册二选一。所有进程使用同一个服务配置和签名密钥。
- `workspace(request, ws, write, run)` 每次重新校验身份、授权范围和工作区成员资格，写请求须执行 CSRF 校验。Command 宿主应复用 `operationRecords(context, !write)` 和 `makeContext`，与 JSON Operations 使用同一份工作区记录。写入在 `unit.command` 内执行和 `flush`。完成、流式暂存和清理需共用工作区写锁，先取锁再加载快照与执行对象 IO，并持有到提交。仅提交时检查版本无法保护外部对象删除。原生 `@smartsell/db` 写事务可通过 `tx.workspace` 取得该锁。启用 API Key 白名单时，字节 PUT/GET 也须检查文件权限。签发响应设置 `Cache-Control: private, no-store`，访问日志及代理日志省略签名查询串和认证信息。
- 保留预览通过 `MediaPolicies.retention` 读取含租户继承的有效 OP05 策略，可通过 `references` 和 `evidenceResourceExists` 接入领域保留和新证据关联类型。让管理员或调度服务在后续独立事务中执行 `mediaFiles.cleanup(ctx)`。完成与清理必须走同一工作区写锁。通用 OP05 的 `applyRetention` 接线也应调用文件服务的逻辑删除流程，使负向计量与 tombstone 同一事务提交。
- 正常业务先提交上传保留，再开新事务完成上传。Asset 创建、版本与衍生可传完成响应的 `id` 为 `file_object_id`。依据 `requireMediaFile` 读取已校验的文件。Execution 等领域验证父资源权限后，可用 `attachMediaEvidence` 记录内容哈希、捕获时间和关联。证据等私有用途默认仅允许上传者和工作区管理员读取。
- `mediaFiles.withMediaSource(ctx, id, fn)` 将经长度和哈希复核的临时本地快照交给可信服务，用于导入或媒体 worker。`makeThumbnail` 用固定参数生成单帧 JPEG。将缩图作为新文件经同一流程保存，再在 asset 版本或衍生记录中关联原件及缩图。渲染配方、任务状态和重试由内容或资产 worker 管理。部署媒体 worker 时提供支持 `fd` 协议的 `ffprobe`/`ffmpeg` 并限制进程和文件访问。`scan` 可选注入扫描器，未启用扫描器时文件记为 `skipped`。
- 本地使用 `MEDIA_DIRECTORY`，开发默认 `.local/media`。MinIO 使用 `MEDIA_S3_ENDPOINT`、`MEDIA_S3_BUCKET`、`MEDIA_S3_ACCESS_KEY`、`MEDIA_S3_SECRET_KEY`。`MEDIA_S3_REGION` 默认 `us-east-1`，`MEDIA_S3_PUBLIC_ENDPOINT` 可为浏览器配置另一可达端点。预建私有桶、允许前端来源的跨源 PUT，并对暂存前缀配置生命周期兜底。若桶开启版本控制，还需配置旧版本及删除标记的过期策略。反代应允许流式入口的上传上限和超时。临时目录应由 OS 或媒体容器管理其孤儿文件的清理。

## 验证

运行 `pnpm test tests/media`。媒体样本测试需要 `ffprobe` 和 `ffmpeg`。MinIO 用例通过 `MEDIA_TEST_S3_ENDPOINT`、`MEDIA_TEST_S3_BUCKET`、`MEDIA_TEST_S3_ACCESS_KEY`、`MEDIA_TEST_S3_SECRET_KEY` 启用，使用隔离测试桶。
