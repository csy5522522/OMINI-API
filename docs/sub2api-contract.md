# Sub2API 官方源码核对记录

仓库：<https://github.com/Wei-Shaw/sub2api>

固定提交：`ba81c7fd758e425d67f856d601147ef0c5263d3f`。本地只读参考副本在被忽略的 `.reference/sub2api/`，不作为本产品的运行依赖，不复制其实现。

## 路由和认证证据

- [router.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/server/router.go)：面板前缀 `/api/v1`。
- [routes/admin.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/server/routes/admin.go)：`/admin/usage`、`/admin/usage/stats`、`/admin/accounts`、`/admin/dashboard/realtime`、`/admin/channels/model-pricing`。
- [middleware/admin_auth.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/server/middleware/admin_auth.go)：管理员 `x-api-key` 与具有管理员角色的 Bearer JWT 分支。受限管理员 Key 仍可能 403，工具不绕过。
- [routes/user.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/server/routes/user.go)：JWT 保护的 `/user/profile`、`/usage`、`/usage/stats` 等当前用户接口。
- [routes/gateway.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/server/routes/gateway.go)：API Key 网关 `/v1/usage`、`/v1/models`、`/v1/sub2api/billing`。
- [middleware/api_key_auth.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/server/middleware/api_key_auth.go)：网关 API Key 鉴权。只读 usage/billing 不执行模型计费请求。

## 请求参数与响应字段

- [handler/usage_handler.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/handler/usage_handler.go) 和 [handler/admin/usage_handler.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/handler/admin/usage_handler.go)：分页 `page/page_size`；筛选 `start_date/end_date` 为 YYYY-MM-DD，`timezone` 为 IANA 时区。
- [pkg/response/response.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/pkg/response/response.go)：面板 `{code,message,data}`；列表分页 `items,total,page,page_size,pages`。
- [handler/dto/types.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/handler/dto/types.go)：`id,request_id,model,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens,actual_cost,duration_ms,first_token_ms,created_at`。`upstream_request_id` 是管理员字段；不假设普通用户一定能取得。
- [handler/gateway_handler.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/handler/gateway_handler.go)：Key usage 区分 `quota_limited` / `unrestricted`；可能有 `balance,remaining,unit,quota,usage,daily_usage,model_stats`。`days` 范围 1–90；本工具请求 30。
- [pkg/usagestats/usage_log_types.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/pkg/usagestats/usage_log_types.go)：Key 日聚合字段 `date,requests,input_tokens,output_tokens,cache_read_tokens,cache_write_tokens,total_tokens,cost,actual_cost`。注意日聚合为 **cache_write_tokens**，逐记录为 **cache_creation_tokens**，适配器显式映射。
- [handler/gateway_key_billing.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/handler/gateway_key_billing.go)：`object=sub2api.key_billing`，schema 1，包含 `effective_rate_multiplier` 等倍率，不含模型采购/销售价；simple mode 404、无分组 403。
- [handler/admin/channel_handler.go](https://github.com/Wei-Shaw/sub2api/blob/ba81c7fd758e425d67f856d601147ef0c5263d3f/backend/internal/handler/admin/channel_handler.go)：`?model=` 必填，`found:false` 是合法结果；每 Token 字段 `input_price,output_price,cache_read_price,cache_write_price`，可含 `cache_write_1h_price` 与推理倍率。返回的是默认价格目录，不自动认定为真实业务单价。

## 兼容策略

仅依据 HTTP 状态和明确字段识别能力。格式不匹配显示 unavailable；不存在、无权限或限流分开呈现。未知字段不持久化。不会调用管理员写接口，不用模型 Key 试探面板 JWT，不调用付费生成接口做隐式测速。

成功用量日志缺少完整失败分母；不由这些日志推导成功率。未来若接入官方 Ops 错误统计，必须核实去重与范围再启用相关指标。

Sub2API 请求契约使用 tests 中的本地 HTTP 夹具验证；MySQL 与 Redis 集成测试连接实际服务。没有真实第三方站点凭证，不能据此宣称第三方版本已实际验证。产品不提供演示运行模式。
