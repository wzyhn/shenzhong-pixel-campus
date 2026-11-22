# 校园私有管理接口

生产 Web 和校园 API 继续通过已有公网域名服务。`/admin/v1` 在独立监听器上提供 HTTP，仅供可信宿主回环或经批准的私网 HTTPS 代理使用。直接部署示例用 `-f compose.coolify.yml -f compose.admin.yml`，只将 `8443` 映射到宿主 `127.0.0.1`。Coolify 单 Compose 路径由部署维护者私下合并同样的 API 服务设置，核对实际监听。浏览器来源请求会被拒绝。只运行一个校园 API 实例以维持同场语义。 [Docker 端口说明](https://docs.docker.com/engine/network/port-publishing/)

## 权限和上线顺序

1. 备份独立校园数据库，在隔离库验证恢复和 005 前滚。`005_private_admin.sql` 只新增表和索引，原版可继续读写原表。已有后台操作生效后，回退到 004 时代的应用镜像会暂停规则执行，优先使用继续执行策略的版本前滚修复。
2. 用现有迁移身份运行 `node migrate.mjs`。以数据库负责人身份为原 API 角色和新后台运行角色分别授权。新角色无建库、建表、全局角色或玩家内容删除权限。

```sql
GRANT SELECT ON paperplane_campus.admin_settings, paperplane_campus.admin_catalogs,
  paperplane_campus.admin_bans, paperplane_campus.admin_hidden_chat TO campus_runtime;
GRANT USAGE ON SCHEMA paperplane_campus TO campus_operator;
GRANT SELECT (id,nickname,revision,nickname_conflict,updated_at,progress)
  ON paperplane_campus.players TO campus_operator;
GRANT SELECT (revoked_at,expires_at) ON paperplane_campus.sessions TO campus_operator;
GRANT SELECT, UPDATE (id) ON paperplane_campus.chat_messages TO campus_operator;
GRANT SELECT, UPDATE ON paperplane_campus.admin_settings TO campus_operator;
GRANT SELECT, INSERT, UPDATE ON paperplane_campus.admin_catalogs,
  paperplane_campus.admin_bans, paperplane_campus.admin_plans TO campus_operator;
GRANT SELECT, INSERT ON paperplane_campus.admin_hidden_chat,
  paperplane_campus.admin_operations TO campus_operator;
```

3. 以只读方式把后台私有目录挂到 `/app/admin-private`，内含单独的 `database-url` 和 `credentials.json`。API 用户需要读取。活跃凭据文件是 `{actor,digest,expiresAt}` 的 JSON 数组。原始凭据使用 32 个随机字节的无填充 base64url 编码，配置只存其 SHA-256 十六进制值。每名操作员单独签发并设置 UTC 失效时间。用目录挂载支持原子轮换文件和即时撤销。空列表暂停管理员调用，已有数据库策略继续生效。冷启动后，私有端口监听不影响公网入口。
4. 从回环核对 `GET /admin/v1/status` 需要管理员凭据，指定正确环境后返回运行 SHA。从公网核对 `/admin/v1/status` 和完整彩蛋配置仍返回 404。从外部验证宿主的 8443 无法直连。只用合成账号验证管理写入。

## 从 Skill 调用

`scripts/campus-admin.py` 需要 Python 3。将 `PAPERPLANE_CAMPUS_ADMIN_URL` 设置为可信私有 HTTPS 地址，或通过有限权限的 SSH 隧道使用默认的 `http://127.0.0.1:8443`。设置 `PAPERPLANE_CAMPUS_ADMIN_ENVIRONMENT` 和 `PAPERPLANE_CAMPUS_ADMIN_TOKEN_FILE`。调用前 CLI 对照 `/session` 的环境。凭据从私有文件读取。管理口和公开发布的凭据分开。

```text
python scripts/campus-admin.py GET /status
python scripts/campus-admin.py GET /players
python scripts/campus-admin.py GET "/operations?key=<原始UUID>"
python scripts/campus-admin.py POST /bans --data ./ban-request.json --key <UUIDv4>
```

写请求必须记录幂等键。可按原键查询回执。发生超时时以原参数、原版本和原键重试，写入结果不会重复执行。版本写入带 `If-Match`，客户端通过 `--revision` 设置。读写环境须和凭据所在环境一致。授权方核对目标、操作和回执。完整彩蛋、私密内容和管理员凭据只在受控环境处理。

| 管理事项 | 私有路径（省略 `/admin/v1`） |
| --- | --- |
| 状态与审计 | `GET /session`、`/status`、`/audit?cursor=`、`/operations/{id}`、`/operations?key=` |
| 玩家 | `GET /players?q=&cursor=`、`GET /players/{id}`。昵称查询后用 UUID 二次核对。 |
| 黑名单 | `GET /bans?active=1`。`POST /bans` 提交 `{playerId,reason,until}`，有效期用 UTC ISO 时间。`POST /bans/{id}/lift` 提交 `{reason}`。封禁保留原 Cookie，解封后原账号可继续使用。 |
| 公屏 | `GET /chat?cursor=`。`POST /chat/{id}/hide` 提交 `{reason}`，公屏和已隐去消息的原发送回执都不会返回该正文。 |
| 彩蛋 | `GET /name-eggs/active`、`/name-eggs/versions`、`/name-eggs/versions/{id}`。`POST /name-eggs/versions` 身体 `{}` 创建草稿。`PUT /name-eggs/versions/{id}/entries` 以草稿修订号和 `{entries}` 替换整份草稿。`POST /name-eggs/versions/{id}/preview` 身体 `{}` 加草稿修订号校验并记审阅。`PUT /name-eggs/active` 以设置修订号和 `{versionId,versionRevision}` 发布，两个字段同时为 `null` 可回到受控文件基线。 |
| 维护 | `PUT /maintenance` 提交 `{enabled,reason}`，使用设置修订号。启用后玩家读接口保留，保存、注册和心跳暂缓。 |
| 清空在线 | `POST /operations/preview` 提交 `{scope:"online",reason}`，确认后同一操作者在五分钟内 `POST /operations/{id}/execute` 身体 `{}`，提交原设置修订号。复核回执和状态。新的有效心跳会重新加入。 |

全员会话、存档及玩家数据清理可预演数量，实际执行暂时关闭。备份与恢复由受控数据库运行流程负责。站长令牌是一人一份的完整校园后台权限，启用两级授权或业务 MFA 前不把它当作受限只读凭据。
