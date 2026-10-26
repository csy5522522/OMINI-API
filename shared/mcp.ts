export const mcpTools = [
  {
    name: 'get_overview',
    description: '查询主站在指定日期范围内的运营总览。默认今天，日期使用工作区时区。',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          enum: ['today', 'yesterday', 'dayAfterTomorrow', '3', '7', '30'],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_accounts',
    description: '分页查看从 Sub2API 同步的上游账号、API 地址、凭证存在性及最近检测结果。',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_models',
    description: '分页查看工作区已同步的模型目录。',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'integer', minimum: 1 },
        pageSize: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
] as const;
