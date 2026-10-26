# MySQL / Redis 改造与官方参考

参考 Sub2API 提交 ba81c7fd758e425d67f856d601147ef0c5263d3f。本系统保持独立工具定位，不修改第三方站点。

- [官方部署](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/deploy/docker-compose.yml) 使用 PostgreSQL 与 Redis。本项目按用户要求采用 MySQL 8.4。
- [队列接口](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/service/batch_image_queue.go) 定义入队、保留、确认、心跳、延迟重试、失活恢复与任务锁。
- [Redis 队列实现](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/repository/batch_image_queue.go) 为去重和恢复机制提供源码参考。
- [BullMQ 文档](https://docs.bullmq.io/guide/connections) 对应生产者有限重试、消费者长期连接、独立 Worker 生命周期。
- [Drizzle MySQL 文档](https://orm.drizzle.team/docs/get-started-mysql) 对应 mysql2 异步驱动及 MySQL Schema。

3001 与 3002 是同一正式工作区。测试夹具仅用于自动化验证，不存在用户可切换的演示数据库。
