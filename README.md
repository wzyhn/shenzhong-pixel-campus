# 纸飞机校园 Web

这个仓库包含校园界面增强、同源 API、独立 PostgreSQL 迁移、部署配置和可自己运行的开发样例。合成像素地图用于本地验证昵称会话与部署。正式校园地图、音轨、品牌图片和个人配置由获准的部署维护者提供。仓库内的原创代码采用 [MIT 许可证](LICENSE)。正式校园原版、素材、音乐、图标和私有配置的使用权按各自授权管理。

## 本地运行

需要 Node.js 22 和 Docker Compose。使用独立项目名启动开发样例。

```bash
docker compose -p campus-fixture -f compose.demo.yml up --build -d --wait
node scripts/smoke-demo.mjs
```

浏览器打开 `http://localhost:18080`。独立演示数据库会留在该 Compose 项目的卷。完成后用 `docker compose -p campus-fixture -f compose.demo.yml down` 停止演示。

```bash
npm ci --prefix web --ignore-scripts
npm ci --prefix campus-server --ignore-scripts
node --test web/*.test.mjs
npm test --prefix campus-server
node web/build-web.mjs
```

PostgreSQL 集成检查用 `WECONQ_TEST_POSTGRES_DSN` 指定独立测试数据库。测试执行随机名称的测试数据库及角色创建、验证和回收。GitHub Actions 在合成环境运行这些检查。

正式部署说明见 [Coolify 运行手册](docs/coolify.md)。依赖许可随构建输出生成。

## 第三方来源

Web 按 lockfile 使用 [TDesign Vue Next](https://github.com/Tencent/tdesign-vue-next)、[Vue](https://github.com/vuejs/core) 和 [esbuild](https://github.com/evanw/esbuild)。Web 构建将所有实际打包依赖的 LICENSE 与 NOTICE 收集在 `Web-LICENSES.txt`。服务端按 lockfile 使用 [node-postgres](https://github.com/brianc/node-postgres) 及其依赖，各包的许可随安装内容保存。原版校园的作品权利和素材许可按授权包处理，地图浏览器产物保留作者署名及附带的第三方许可。
