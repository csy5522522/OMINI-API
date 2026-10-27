# 服务器部署与版本管理

地址：https://admin-api.omini.cn ，源站：152.53.89.198。
代码仓库：https://github.com/csy5522522/OMINI-API 。
服务器目录 `/opt/omini-api`，Compose 项目名 `omini-api`。

## 服务布局

Nginx 80/443 → `127.0.0.1:3001` → observatory。独立 worker 消费 BullMQ 队列。
MySQL 8.4 和 Redis 7.4 仅在容器内部网络开放，分别使用独立持久化卷。
3001/3002 只绑定服务器回环地址。所有容器配置 `unless-stopped`。

域名由 Cloudflare 代理，使用 Full (strict)；源站复用现有 `*.omini.cn`
Origin CA 证书。证书私钥由宿主机管理，不进入 Git 或镜像。
Nginx 配置为 `deploy/nginx.conf`，部署到
`/www/server/panel/vhost/nginx/admin-api.omini.cn.conf`。

`.env` 仅保存在服务器和私有备份中，权限 600。部署时必须配置：

```dotenv
COMPOSE_PROJECT_NAME=omini-api
DOCKER_BIND_ADDRESS=127.0.0.1
APP_IMAGE=omini-api:RELEASE
COOKIE_SECURE=true
```

其余变量见 `.env.example`。应用与数据库密码、加密密钥、签名密钥不能提交 Git。
`ENCRYPTION_KEY` 必须与加密后的站点凭证一起备份。

## 检查

```bash
cd /opt/omini-api
docker compose ps
curl --fail https://admin-api.omini.cn/api/health
docker compose logs --tail 80 observatory worker
```

健康接口应返回 MySQL、Redis、BullMQ 和 worker 状态。

## 备份与更新

```bash
cd /opt/omini-api
bash scripts/backup.sh
git pull --ff-only origin main
# 把 .env 的 APP_IMAGE 改为本次版本标签，保留已有密钥和连接密码。
docker compose build observatory
docker compose up -d --no-build --wait --wait-timeout 180
curl --fail https://admin-api.omini.cn/api/health
```

备份保存在 `/opt/backups/omini-api/时间戳/`，含数据库逻辑备份、私有环境配置和
Git 提交编号。可先执行 `gzip -t database.sql.gz` 校验压缩文件；恢复前先备份当前库，
停用 API/worker，再将备份导入 MySQL，并恢复相配套的 `ENCRYPTION_KEY`。
本脚本不安排定时任务；需要另外配置备份调度与异地存储。

不要运行 `docker compose down -v`，该命令会删除数据库和队列的数据卷。
只回退应用镜像不会撤销数据库迁移。涉及不兼容 Schema 的版本回退，需要同时恢复对应备份。

## Git

`main` 保存可部署源代码，正式部署用 `v1.0.0` 等标签记录版本。
Git 不包含运行数据、站点密钥、密码、私钥、构建缓存和本机测试产物。
服务器通过公开仓库 HTTPS 拉取，不保存 GitHub 写入令牌。

## v1.1.0 更新说明

新增 Sub2API 上游账号自动获取、显式账号连通性测试、独立 API Key 检测、总览日期快捷筛选，以及 MCP 开放平台。MCP 入口是同域 `/mcp`，现有 Nginx 的根路径代理可直接转发。

本次新增迁移 `0004_conscious_roulette.sql`，创建 `upstream_accounts` 和 `mcp_keys` 两张表，保留既有业务数据。API/worker 启动时通过迁移锁自动执行；升级前先运行备份。正式镜像使用 `omini-api:v1.1.0`，两个应用容器使用同一镜像。

上游原始 Key 保留在 Sub2API；账号检测需要在页面勾选用量提示后执行。MCP Token 在开放平台单独创建。更新保留服务器原有登录密码、加密密钥及数据库/Redis 配置，本地 `.env` 不上传到服务器。

## v1.1.1 修复说明

账号页直接显示并可复制完整 API Key，使用主站授权的单账号导出接口读取，不持久化原始 Key。默认 API/Key 检测改为只读模型列表请求，按钮无需用量确认即可使用；生成测试单独选择并保留用量提示。本版无新增数据库迁移，镜像为 `omini-api:v1.1.1`。

## v1.2.0 余额监控

新增余额监控页面、首次自动采集、余额阈值设置及低余额/认证失效/同步失败告警。默认后台每 300 秒查询，页面每 10 秒刷新；仅调用只读接口，通知显示在应用内。F-AI Hub 的模型 API Key 余额接口已经实际验证。详细变更见 [更新记录](../CHANGELOG.md)。

本版无新增数据库迁移。发布使用 Git 注解标签 `v1.2.0`，API 与 worker 共用镜像 `omini-api:v1.2.0`。升级先执行备份脚本，确认服务器工作区干净，拉取已发布提交并核对标签与提交一致，再构建镜像、更新 `.env` 中的 `APP_IMAGE` 并启动。保留服务器原有登录密码、加密密钥、数据库和 Redis 配置；不上传本机 `.env`。

需要回退应用时，将服务器 `.env` 中的 `APP_IMAGE` 改回 `omini-api:v1.1.1`，运行 `docker compose up -d --no-build --wait --wait-timeout 180 observatory worker`，并检查 HTTPS 健康接口。保留旧镜像和升级前备份；不删除数据卷。本次新增的监控站点及告警兼容旧表结构，回退应用不会自动删除这些配置。

## v1.2.1 刷新交互调整

手动刷新等待 worker 完成后返回，前端直接更新数据并关闭队列提交提示。独立 API Key 检测及历史使用记录页面已关闭。无数据库迁移；API 与 worker 共用 `omini-api:v1.2.1`，完成任务短暂保留最多 100 条/5 分钟用于可靠读取完成结果。升级前备份，保留 `v1.2.0` 镜像用于应用回退。

## 首次上线验证（2026-10-26）

- `v1.0.0`：服务器实际构建 Node 24 镜像，API、worker、MySQL、Redis 均健康。
- 4 个迁移全部应用，19 张业务表和 1 张迁移表已建立。
- HTTPS 登录、Secure/HttpOnly/SameSite Cookie、鉴权、退出、Redis 缓存命中通过。
- 浏览器实际检查仪表盘与系统设置，显示 MySQL、在线 worker 和真实队列计数。
- 首份 MySQL 逻辑备份及配套环境密钥备份已生成，压缩完整性校验通过。
- 本机类型检查、生产构建、47 项自动化测试通过。
- 上线时无站点或账单数据；真实上游连接需登录后配置自己的站点凭证。
