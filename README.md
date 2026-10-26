# Relay Observatory / Sub2API 运营管理系统

统一的真实工作区，运行时采用 **MySQL 8.4 + Redis + BullMQ**，不注入演示运营数据。3001 和 3002 现在使用同一数据库、同一账号、同一后台队列。

## 本机访问与启动

- Tailscale：<http://100.108.12.45:3002/>、<http://100.108.12.45:3001/>。
- 局域网：<http://192.168.2.178:3001/> 或 3002 端口。
- 保留本机账号 admin，以及用户设置在 .env 中的密码与加密密钥。
- 项目独立 MySQL：Windows 127.0.0.1:3307；项目 Redis：WSL Ubuntu 127.0.0.1:6380。现有 3306 MySQL 未修改。
- 旧数据库升级前没有站点和用量。备份仍在 data/backups/observatory-before-mysql.sqlite，不参与运行。

```powershell
# 本机已经初始化专用基础设施，可用此脚本重新启动
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1
# 已构建时跳过构建
powershell -ExecutionPolicy Bypass -File scripts/start-local.ps1 -NoBuild
```

不要在已有进程占用 3001/3002 时重复启动。开发使用 pnpm dev，Vite 在 5173，同源代理到 3001。

## 全新部署

要求 Node.js 24 LTS、pnpm 11.25、MySQL 8.4 与 Redis 7+。

```powershell
pnpm install --frozen-lockfile
pnpm run setup
# 编辑 .env 的 DATABASE_URL 和 REDIS_URL，连接自己提供的基础设施
pnpm db:init
pnpm build
pnpm start
```

setup 生成随机登录、加密、数据库及 Redis 密码，不覆盖已有 .env。基础设施缺失时明确启动失败，不回退到内存数据或 SQLite。

## Docker Compose

```powershell
node scripts/setup.mjs
# 允许局域网访问：.env 中 DOCKER_BIND_ADDRESS=0.0.0.0
docker compose up -d --build
docker compose logs -f observatory worker
```

| 服务        | 用途                                   |
| ----------- | -------------------------------------- |
| observatory | API、React 生产界面及认证；3001/3002   |
| worker      | 独立采集、调度、重试、告警；无对外端口 |
| mysql       | MySQL 8.4；mysql-data 持久化卷         |
| redis       | Redis 7.4；redis-data 持久化卷及 AOF   |

MySQL 与 Redis 不映射宿主机端口。API/Worker 通过内部服务名连接。四个服务都有健康检查，Worker 验证实际 Redis 心跳。应用以非 root 用户运行。已在 Debian 13 服务器实际完成 Docker 构建、四服务启动、HTTPS 登录与 MySQL/Redis 健康验证；部署、备份和更新方式见 [服务器部署说明](docs/deployment.md)。

## 环境变量

| 变量                                                  | 说明                                            |
| ----------------------------------------------------- | ----------------------------------------------- |
| DATABASE_URL                                          | 必填，mysql://用户:密码@主机:端口/数据库        |
| REDIS_URL                                             | 必填，redis://:密码@主机:端口/0，支持 rediss:// |
| REDIS_PREFIX                                          | Redis 命名空间，默认 relay                      |
| PROCESS_ROLE                                          | all 合并运行；api/worker 拆分部署               |
| CACHE_TTL_SECONDS                                     | 报表缓存默认 10 秒，最大 300 秒                 |
| HOST / PORT                                           | API 监听地址和主端口                            |
| SECONDARY_PORT                                        | 同一工作区兼容端口，默认 3002；0 可关闭         |
| DEV_HOST / DOCKER_BIND_ADDRESS                        | 开发和 Docker 监听地址                          |
| ADMIN_USERNAME / ADMIN_PASSWORD                       | 本系统登录，密码至少 8 字符                     |
| ENCRYPTION_KEY                                        | 64 位十六进制 AES 密钥，必须安全备份            |
| SESSION_SECRET                                        | Cookie 签名密钥，至少 32 字符                   |
| APP_TIMEZONE                                          | IANA 时区，默认 Asia/Shanghai                   |
| SYNC_INTERVAL_SECONDS                                 | 默认 300 秒，最小 60 秒                         |
| ALLOW_PRIVATE_HOSTS                                   | 已授权的内网站点精确主机白名单                  |
| COOKIE_SECURE                                         | HTTPS 部署时 true                               |
| FX_PROVIDER                                           | none 或真实日度汇率来源 open_er                 |
| MYSQL_PASSWORD / MYSQL_ROOT_PASSWORD / REDIS_PASSWORD | Compose 初始化密码                              |

反向代理保留 Host，浏览器与 API 保持同源。密码中的 URL 特殊字符需要编码，setup 生成十六进制基础设施密码。不要把 .env 提交到仓库。

## 真实站点接入

中转站分为两类：**一个主中转站（自己的中转）**和**多个第三方中转站（别人的中转）**。可以先添加第三方站点，但主站最多只能有一个。

在「中转站管理 → 配置主中转站」填写自己站点的根地址，不带 /v1，使用管理员密钥或管理员 JWT。第三方通过「添加第三方中转站」接入，使用普通用户 JWT 或模型 API Key。界面不再让用户选择销售/采购/观测角色：主站自动归为销售端，第三方自动归为采购端；成本模式仍支持 Token/订阅/预付余额。

MySQL 使用主站生成列与唯一索引保证并发创建时也不能有第二个主站，CHECK 约束校验两类站点的核算角色和认证身份。后端修改接口禁止将第三方改为主站或重新指定核算角色。上下游关系只能是主站指向第三方上游。

保存后点击「测试/同步」，请求进入 Redis 队列。详情页显示接口能力、权限错误和任务结果。模型价格支持采购、销售、缓存价格及历史版本；默认目录价需确认真实业务倍率和单价。上游作为采购站添加，在设置中配置关系并按可靠请求 ID 或人工证据关联。

接口来源见 [Sub2API 契约](docs/sub2api-contract.md)，架构参考见 [改造记录](docs/architecture.md)。凭证在页面输入即可，无需发到聊天。全部管理页面、深浅色、响应式布局、搜索排序、分页及 CSV 保持可用。

## 数据一致性

Drizzle 使用 mysql2 异步连接池。金额/汇率/倍率采用 DECIMAL(30,12) 和十进制字符串，应用使用 Decimal 40 位精度；模型四维价格 JSON 保留字符串。Token 为 BIGINT，时间使用 UTC 与配置时区。

InnoDB 外键及唯一索引约束外部记录、模型、日聚合和请求关联。utf8mb4_bin 防止模型或请求 ID 大小写被误合并。财务配置和审计同一事务提交；报表在 REPEATABLE READ 事务中读取一致快照。

迁移在 migrations/mysql，启动使用 MySQL 命名锁并核对文件 SHA-256。MySQL DDL 隐式提交，全部语句成功后才记录迁移。失败需修复后继续，不静默跳过。Schema 修改后运行 pnpm db:generate；不要改写已应用 SQL。

19 张业务表覆盖站点/凭证/能力、模型/价格、用量/聚合、订阅/充值/交易、汇率、上下游/请求关联、告警、同步任务、审计、设置及会话，另有 schema_migrations。

## Redis 队列和缓存

- BullMQ 只保存站点 ID，Worker 从 MySQL 解密读取凭证。
- 每站固定 Job ID，跨实例去重；手动提交冷却 30 秒。
- 并发 3，每秒最多启动 3 个任务；失败最多尝试 3 次，从 2 秒指数退避。认证失效不反复重试。
- 分布式锁自动续期、stalled 任务恢复；重新取得锁后将旧 running 日志标为 interrupted，重用检查点及唯一约束。
- 完成任务移出活动队列；失败最多保留 500 条或 7 天。MySQL 保存执行历史、Job ID 和尝试次数。
- 定时计划存 Redis，由 Worker 扫描站点入队。前端刷新不直接调用上游。
- Redis 保存限流、心跳及脱敏报表缓存，MySQL 始终是业务事实来源。
- 写入成功和采集完成递增缓存版本，旧快照不能覆盖新版本；TTL 清理，浏览器响应仍 no-store。
- Redis 配置 AOF、everysec、noeviction。断电持久化受 AOF 刷盘周期约束。
- 系统设置显示实际 Worker、队列状态、缓存命中与 TTL。

## 核算与采集口径

充值是预付款，实际消费才确认成本；固定订阅按有效期摊销，不重复计算 Token 成本。计算器估算与实际利润分开，缺少采购依据显示待核算。不同币种分账，保留历史汇率引用。

全局请求和 Token 用量仅统计主中转站；第三方即使还未配置上下游关系，也不会叠加到主站业务量。选择具体第三方仍可查看其真实用量和采购消费。请求仅按明确且唯一的上下游请求 ID 或人工证据关联；未匹配数据保持未关联。固定订阅按实际配置摊销，不按 Token 再重复计费。

初次拉取最近 30 天，后续重叠前一天，分页 100 条，单次最多 200 页；达到上限不推进检查点。Key 日聚合覆盖同一日快照，不累加轮询结果。日期范围支持自然日、时区和夏令时。

缺失指标显示不可用。成功日志缺少失败分母时，不推导成功率。只读接口延迟与模型生成延迟分开。长上下文、1h 缓存和图像等特殊阶梯不套用通用估算。自动汇率来源未配置时不生成虚构数据。

## 测试

```powershell
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test
pnpm db:init
```

数据库、API、报表、队列、缓存测试真实连接 MySQL 和 Redis。TEST_DATABASE_URL 必须不同于正式库且库名以 \_test 结尾；TEST_REDIS_URL 使用独立 DB 与随机 test- 前缀。清理只针对测试库/前缀，不使用 FLUSHALL。

远端 HTTP 契约使用 tests 内的本地测试夹具，这是自动化验证，不是产品运行模式，不写入正式库。没有真实第三方凭证，不宣称已连接真实第三方站点。

## 安全与维护

AES-GCM 凭证加密；MySQL 会话；签名 HttpOnly/SameSite Cookie；Redis 限流；同源写校验；SSRF 检查所有 DNS 结果并固定目标，拒绝元数据服务及重定向。只保存计量白名单，不保存对话正文或远端明文密钥。

备份使用 MySQL 逻辑/物理备份与 Redis 持久化，同时保存加密密钥；升级不要删除数据卷。当前未实现付费主动测速、共享订阅自动分摊、Webhook/飞书发送及超大历史批量回填。通知为站内告警；大量历史数据仍需后续物化聚合优化。

## 目录

src 为 React 前端，server/mysql.ts 管理连接池与迁移，server/schema.ts 为 MySQL Schema，server/runtime.ts 管理 Redis/BullMQ，server/start.ts 支持 API/Worker/合并运行，server/sync.ts 负责采集，server/reports.ts 负责一致快照报表。shared 保存精确计费与时间逻辑；migrations/mysql 为迁移；tests 为单元与基础设施集成测试。
