# Coolify 运行手册

## 首次在隔离环境验证

1. GitHub 建立审核过的仓库并推送独立历史。添加 `main` 规则，要求通过 `Campus checks`、维护者复核、分支最新、拒绝强推与删除。有外部 PR 时由 GitHub 托管 runner 执行合成样例任务。只在选中仓库安装 Coolify GitHub App。
2. Coolify 添加 Git-based Application，选择 `main` 和 Docker Compose。Base Directory 为 `/`，Compose Location 为 `/compose.coolify.yml`。初次测试用 Staging 域名、独立数据库与独立网络。域名只给 `web`，内部端口选 `8080`。关闭 PR 预览。用 [GitHub App](https://coolify.io/docs/applications/sources/github/auto-deploy) 或用 [签名仓库 webhook](https://coolify.io/docs/applications/deployments/manual-webhooks) 触发部署。
3. 按 [.env.example](../.env.example) 填设置。服务器提前准备存在的只读目录和文件，确认 UID 1000 可读取。连接串和彩蛋文件只挂 API。数据库、迁移身份和备份收据由数据库负责人保管。若使用既有数据库，按 [数据库说明](../campus-server/README.md) 核对迁移和应用权限。安全展示的 Compose 为 `docker compose --env-file .env.example -f compose.coolify.yml config --quiet`。查看实际生成的 Compose 时避免输出敏感配置。
4. 在 Advanced → Build 将 Source commit availability 设为 Available during build，确认 Compose 两个镜像各拿到 `SOURCE_COMMIT`。如界面存在自动注入网络容器的选项，构建本身无需连接生产网络，关闭该选项。检查生成的 Compose 外部数据库网络名、Web 域名和素材绑定。对于旧版 Coolify 应按实际版本验证菜单和渲染行为。[构建变量](https://coolify.io/docs/applications/configuration/environment-variables) · [Docker Compose](https://coolify.io/docs/applications/builds/docker-compose)
5. 运行首次部署，验证 Web 和 API 容器均健康。HTTPS 请求 `/release.json` 的 `revision` 应等于部署 SHA。浏览器验证首页、注册和回访，外部探针仅检查首页、发布 SHA 和匿名会话。公网请求私有目录、管理员接口与指标路径应得到 404。只有在受控入口验证了可信代理会把真实连接地址追加到 `X-Forwarded-For` 的最右端、且 Web 无直接访问途径后，才启用 `PAPERPLANE_CAMPUS_PROXY_APPEND=1`。通过两条不同来源核对限流不会共用代理地址。
6. 在 Advanced → Deployment 打开 Deploy on push (webhooks)。用一个经过审核的 Staging 提交核对 GitHub 事件、Coolify 队列、部署 SHA、站外健康和送达回执。生产接管时复用批准的独立校园数据库，只保留一个处理实时同场状态的 API。

## 生成受控的浏览器素材包

在持有授权原包的环境使用项目既有构建，产出通过去除昵称表和素材校验的 `web/` 子目录。根据该次可信发布回执读取处理后 HTML 的 SHA-256，用以下命令生成全新的素材目录。目录只能在受控服务器或相同权限的离线环境保存。

```bash
node scripts/pack-approved-assets.mjs /trusted/build/web /srv/campus/assets-v1 HTML_SHA256
```

第四个参数可提供获准公开显示的作者联系方式文件。构建回执的 SHA 和素材清单 SHA 分别记录。将命令输出的 `PAPERPLANE_CAMPUS_ASSET_SHA256` 与目标目录一起填入 Coolify。素材挂载目录只包含命令收到的允许列表，彩蛋表来自独立私有路径。Web 容器生成 CSP 和静态目录，校验清单和每个文件后才启动。保留上一份经验证的素材及配置，以便配合应用代码回滚。

## 通知和回滚

- GitHub Checks 记录 PR 和 `main` 测试。Coolify 团队 Notifications 为每个渠道启用连接、选事件并做 Send test，按需要启用部署成功、部署失败、资源异常和备份失败。允许的渠道包括 Email、Discord、Slack/Mattermost、Telegram、Pushover 或 JSON Webhook。[Coolify 通知](https://coolify.io/docs/core/notifications/overview)
- Webhook 可由受控接收方按 Application UUID 和环境过滤，使用事件和部署 UUID 去重。通知正文采用允许列表。运维再查 `/release.json` 和实际应用探针，记录已观察到的 SHA。[事件字段](https://coolify.io/docs/core/notifications/channels/webhook/payload-reference)
- 正常回滚使用 revert 后的主分支重新部署。紧急先把自动部署切为手动，使用已验证的旧源码 ref 和素材版本回滚，核对数据库迁移的向后兼容性。根据实际 Coolify 版本确认 Compose 的回滚能力。数据库和其他持久数据按独立恢复流程处理。[Coolify 回滚](https://coolify.io/docs/applications/deployments/rollbacks)
