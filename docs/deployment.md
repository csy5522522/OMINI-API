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
