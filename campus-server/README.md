# 纸飞机校园 Web 服务

本服务接收校园页面的昵称登录，持久保存玩家存档和私有相册。昵称在校园中唯一，按 Unicode NFKC 和不区分大小写的键判重，显示仍使用玩家填写的昵称。新玩家注册成功才获得独立 UUID 和 HTTPS cookie。回访由该 cookie 恢复本人存档。

## 部署

使用独立 PostgreSQL 16 UTF-8 数据库和持久卷，数据库需要 ICU 的 `und-x-icu` 排序规则。镜像工作目录为 `/app`，以镜像内的 `node` 用户运行。默认监听容器端口 `8080`，可使用 `PORT` 改写。以 PostgreSQL 数据库不可用或权限不全时返回 503 的 `GET /healthz` 作为容器就绪检查。

1. 以拥有独立数据库的迁移身份运行 `node migrate.mjs`。在环境中设置 `PAPERPLANE_CAMPUS_MIGRATION_DATABASE_URL_FILE` 为只读挂载的连接串文件，或直接设置 `PAPERPLANE_CAMPUS_MIGRATION_DATABASE_URL`。两种方式任选其一。
2. 以迁移身份向应用角色授予下列权限。将示例角色和数据库名换成实际值。设定数据库的访问策略时，按部署环境移除 `PUBLIC` 权限。
3. 运行镜像默认命令 `node server.mjs`。连接串采用 `PAPERPLANE_CAMPUS_DATABASE_URL_FILE` 或 `PAPERPLANE_CAMPUS_DATABASE_URL`。应用身份需要读取所用只读连接串文件。
4. 由部署域名的同源反向代理路由接口，保留原始 `Origin`、`Sec-Fetch-Site`、cookie 和校园请求头，接收不超过 2 MiB 的照片。服务端写入仅接受该来源。原站套餐用的 `mode: "demo"` 仅为旧页面响应契约。
5. 将昵称彩蛋配置以只读文件挂载到后端的 `/app/private/campus-name-eggs.json`，设置 `PAPERPLANE_CAMPUS_NAME_EGGS_FILE` 为该绝对路径。文件包含 `{nickname,txt,fx}` 对象数组，`fx` 可含 `star:true`、`wx`（`day`、`night`、`rain`、`snow`）或 `toast` 字符串。后端启动时读取，文件缺失或格式错误会使已配置的进程退出。未配置路径时以空列表运行，供本地和兼容部署使用。生产配置仅挂载给 API 容器，勿加入镜像、静态目录或源码。
6. 仅允许反向代理访问 API 容器，并由该代理将 `X-Campus-Client-IP` 覆盖为可信连接地址。配置可信入口，确保右端地址只能由受控代理写入，才能开启代理地址信任。若无法校验此边界，保持关闭。

```sql
GRANT CONNECT ON DATABASE paperplane_campus TO paperplane_campus_app;
GRANT USAGE ON SCHEMA paperplane_campus TO paperplane_campus_app;
GRANT SELECT ON paperplane_campus.migrations TO paperplane_campus_app;
GRANT SELECT, INSERT, UPDATE ON
  paperplane_campus.players, paperplane_campus.sessions, paperplane_campus.albums
  TO paperplane_campus_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON paperplane_campus.photos TO paperplane_campus_app;
```

迁移以事务和锁执行，已执行文件由 SHA-256 校验。通过追加下一个编号迁移更新表结构。应用启动仅检查数据库就绪和权限。

004 迁移保留每组历史同名中最早注册者的昵称，其他账号的会话、存档和相册归属不变。需要处理冲突的账号在 `GET /api/campus/session` 收到 `user.nicknameConflict: true`，本人重新选名后恢复进校。冲突期间的普通存档写入返回 `409 nickname_required`。注册或改名碰到已占用昵称时返回 `409 nickname_taken`。

## 接口

| 请求                              | 响应或写入                                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/campus/session`         | `{user,state}`，匿名时两项为 `null`。                                                                                                   |
| `POST /api/campus/session`        | JSON `{nickname,outfit?}`。有有效会话时返回原账号及存档。匿名时一并保存可选的初始装扮并发放 cookie。                                    |
| `GET /api/auth/session`           | 原版页面兼容响应的 `user` 为 `null` 或 `{id,displayName}`，`mode` 为 `"demo"`。 |
| `PUT /api/campus/state`           | `X-Campus-User-ID` 和 JSON `{revision,progress,nickname?}`。成功增加存档版本。版本冲突返回 409 与当前 `{user,state}`。                  |
| `POST /api/auth/logout`           | JSON `{}`，可带 `X-Campus-User-ID`。撤销当前 cookie，返回兼容匿名响应。                                                                 |
| `GET /api/campus/album`           | 需要 `X-Campus-User-ID`，返回 `{revision,photos:[{id,version,metadata}]}`。                                                             |
| `GET /api/campus/album/<uuid>`    | 需要 `X-Campus-User-ID`，返回所请求照片的 PNG。                                                                                         |
| `PUT /api/campus/album/<uuid>`    | 需要账号头、`If-Match: "<revision>"`、`X-Campus-Photo-Metadata` 和原始 PNG。照片头使用 `encodeURIComponent(JSON.stringify(metadata))`。 |
| `DELETE /api/campus/album/<uuid>` | 需要账号头及相册版本。写入成功或版本冲突响应与相册列表格式相同。                                                                        |
| `POST /api/campus/presence`       | 需要账号头与 JSON `{room,tabId,findable,pos?,emotes}`。以短心跳更新校园同场状态，返回 `{players,emotes}`。                              |
| `DELETE /api/campus/presence`     | 需要账号头与 JSON `{room,tabId}`，离开当前标签页。                                                                                      |

存档包含位置和设置、装扮、纸飞机玩具状态、可发现设置及本人编辑的年龄与教育经历。每张照片最多 2 MiB，每个相册最多 12 张、20 MiB。服务总计最多 128 MiB、10,000 张。相册版本与存档版本独立。认证响应和图片均禁止缓存。

校园会话读取、注册成功或已登录的会话提交可以额外返回本人的 `nameEgg:{txt,fx}`。匹配按账户中保存的显示昵称逐字比较，延续存档对首尾空白的处理，并独立于昵称唯一性所用的 Unicode 归一化键。修改昵称或修复旧昵称冲突成功后也可返回该字段。匿名、待处理昵称冲突、存档冲突、仅保存进度和提交原昵称时省略该字段。

同一来源每十分钟最多尝试注册八次。改名每个账号每五分钟最多尝试六次，每个来源每十分钟最多二十次。昵称已占用和版本过期的改名也会计入，提交已保存的昵称或只保存进度免计。超过限额返回 `429 nickname_rate_limited` 和以秒为单位的 `Retry-After`。来源按 IPv4 地址或 IPv6 /64 统计。限额由单个 API 进程维护，重启时清除。

「深中校园」同场房间支持在线名单、游戏位置和固定表情。隐藏位置时，其他同学只看到名单条目。玩家离开时关闭其标签页心跳，其余仍在线的标签页继续生效。失联心跳在 12 秒后过期。同场信息只保存在单个校园 API 进程内，生产应使用一个校园 API 实例。浏览器的私人存档、身份和相册仍保存在 PostgreSQL。
在线名单可包含 `nameStar:true`，用于显示该同学的昵称星标。决定星标时使用该同学存档中的当前昵称。彩蛋文案、天气和提示仅随本人会话或改名结果返回。

### 公屏聊天

校园昵称账号登录后可以直接发公屏消息。升级前执行独立校园数据库的 003 迁移，并授予应用身份下列权限。

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON paperplane_campus.chat_messages TO paperplane_campus_app;
```

| 请求                             | 接口合同                                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/campus/chat`           | 使用原有校园 cookie 和 `X-Campus-User-ID`，返回 `{messages}`。每条包含 `id,nickname,text,created_at,own`，最多 30 条。                                 |
| `POST /api/campus/chat`          | 同源 JSON `{requestId,text}`，长度最多 40 个 Unicode 码点。已发布回执为 `{status:"published",message}`。同编号不同正文返回 409，触发频率限制返回 429。 |
| `DELETE /api/campus/chat/<uuid>` | 同源并验证当前账号，只允许作者撤回自己的已发布消息。成功返回 `{revoked:true}`。                                                                        |

公屏投影使用作者当前的校园昵称。等待处理昵称冲突的账号先退出同场，该账号的历史正文也暂离公屏，改名后可按新昵称继续显示。公开列表仅显示七天内未撤回的消息，数据库总量上限为 4096 条。撤回移除正文并保留幂等回执。

## 猜校园地点

同源公开接口 `GET /api/campus/clues` 返回三道题，`GET /api/campus/clues/<id>` 返回其中一道。题面仅提供题号、问题、原版地图裁图和三个选项。提交 `POST /api/campus/clues/<id>/answer`，正文为 `{choice:"a"|"b"|"c"}`，答对或答错都会返回核准的地点和拍摄机位。答题不写入玩家存档或 PostgreSQL。

正式环境从受控素材包读取题图，样例环境使用合成图片。

## 本地验证

执行 `npm ci --ignore-scripts` 后使用 `npm test`。完整集成验证需要把 `WECONQ_TEST_POSTGRES_DSN` 指向可创建角色与数据库的本地测试库 `postgres`。测试自行创建、授予权限和删除独立的随机命名数据库和角色，覆盖账号隔离、版本冲突、服务重启后的恢复、私有照片和会话撤销。
