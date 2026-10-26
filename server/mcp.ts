import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { eq, and, isNull, gt, count } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { one, run, type Store } from './db.js';
import * as s from './schema.js';
import { report } from './reports.js';
import { periodRange } from '../shared/time.js';
import { mcpTools } from '../shared/mcp.js';

const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const paging = z
  .object({
    page: z.number().int().min(1).max(100000).default(1),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .strict();
const protocolVersions = ['2025-03-26', '2025-06-18', '2025-11-25'];
export async function callMcpTool(store: Store, config: Config, name: string, args: unknown) {
  if (name === 'get_overview') {
    const q = z
      .object({
        period: z.enum(['today', 'yesterday', 'dayAfterTomorrow', '3', '7', '30']).default('today'),
      })
      .strict()
      .parse(args);
    const range = periodRange(q.period, config.APP_TIMEZONE);
    return {
      timezone: config.APP_TIMEZONE,
      range,
      report: await report(store, range.from, range.to, config.APP_TIMEZONE),
    };
  }
  if (name === 'list_accounts' || name === 'list_models') {
    const { page, pageSize } = paging.parse(args);
    const table = name === 'list_accounts' ? s.upstreamAccounts : s.models;
    const [items, total] = await store.db.transaction(async (tx) => {
      const total = await tx.select({ count: count() }).from(table);
      const items =
        name === 'list_accounts'
          ? await tx
              .select()
              .from(s.upstreamAccounts)
              .orderBy(s.upstreamAccounts.stationId, s.upstreamAccounts.externalId)
              .limit(pageSize)
              .offset((page - 1) * pageSize)
          : await tx
              .select()
              .from(s.models)
              .orderBy(s.models.stationId, s.models.model)
              .limit(pageSize)
              .offset((page - 1) * pageSize);
      return [items, total[0].count] as const;
    });
    return { items, total, page, pageSize };
  }
  throw new Error('未知工具');
}
export function registerMcp(app: FastifyInstance, store: Store, config: Config) {
  const { db } = store;
  app.get('/api/mcp/keys', async () => {
    const rows = await db.select().from(s.mcpKeys).orderBy(s.mcpKeys.createdAt);
    return rows.map(({ tokenHash, ...row }) => row);
  });
  app.post('/api/mcp/keys', async (req, reply) => {
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        days: z.number().int().min(1).max(365).default(30),
      })
      .strict()
      .parse(req.body);
    const token = 'mcp_' + randomBytes(32).toString('hex'),
      id = randomUUID(),
      createdAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + body.days * 864e5).toISOString();
    await db.transaction(async (tx) => {
      await run(
        tx
          .insert(s.mcpKeys)
          .values({
            id,
            name: body.name,
            tokenHash: hash(token),
            prefix: token.slice(0, 12),
            createdAt,
            expiresAt,
          }),
      );
      await run(
        tx
          .insert(s.audit)
          .values({
            id: randomUUID(),
            action: 'mcp.key.create',
            entityId: id,
            details: { name: body.name, days: body.days },
            createdAt,
          }),
      );
    });
    return reply.code(201).send({ id, token, expiresAt });
  });
  app.delete('/api/mcp/keys/:id', async (req, reply) => {
    const id = z
      .string()
      .uuid()
      .parse((req.params as any).id);
    const existing = await one(db.select().from(s.mcpKeys).where(eq(s.mcpKeys.id, id)));
    if (!existing) return reply.code(404).send({ message: '接入密钥不存在' });
    const now = new Date().toISOString();
    await db.transaction(async (tx) => {
      await run(tx.update(s.mcpKeys).set({ revokedAt: now }).where(eq(s.mcpKeys.id, id)));
      await run(
        tx
          .insert(s.audit)
          .values({
            id: randomUUID(),
            action: 'mcp.key.revoke',
            entityId: id,
            details: {},
            createdAt: now,
          }),
      );
    });
    return { ok: true };
  });
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    config: { rateLimit: { max: 60, timeWindow: 60000 } },
    handler: async (req, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (req.headers.origin) {
        try {
          if (new URL(req.headers.origin).host !== req.headers.host)
            return reply.code(403).send({ message: '禁止跨站调用' });
        } catch {
          return reply.code(403).send({ message: '无效来源' });
        }
      }
      const bearer = req.headers.authorization?.match(/^Bearer (mcp_[a-f0-9]{64})$/)?.[1];
      const key = bearer
        ? await one(
            db
              .select()
              .from(s.mcpKeys)
              .where(
                and(
                  eq(s.mcpKeys.tokenHash, hash(bearer)),
                  isNull(s.mcpKeys.revokedAt),
                  gt(s.mcpKeys.expiresAt, new Date().toISOString()),
                ),
              ),
          )
        : undefined;
      if (!key)
        return reply
          .code(401)
          .header('WWW-Authenticate', 'Bearer realm="mcp"')
          .send({ message: '需要有效的 MCP 接入密钥' });
      if (req.method !== 'POST')
        return reply
          .code(405)
          .header('Allow', 'POST')
          .send({ message: '此无状态 MCP 服务使用 POST，响应为 application/json' });
      const version = req.headers['mcp-protocol-version'];
      if (version && !protocolVersions.includes(String(version)))
        return reply.code(400).send({ message: '不支持的 MCP 协议版本' });
      await run(
        db
          .update(s.mcpKeys)
          .set({ lastUsedAt: new Date().toISOString() })
          .where(eq(s.mcpKeys.id, key.id)),
      );
      const body = req.body as any;
      const validId = body && (typeof body.id === 'string' || typeof body.id === 'number');
      const error = (code: number, message: string) => ({
        jsonrpc: '2.0',
        id: validId ? body.id : null,
        error: { code, message },
      });
      if (
        !body ||
        Array.isArray(body) ||
        body.jsonrpc !== '2.0' ||
        typeof body.method !== 'string' ||
        ('id' in body && !validId)
      )
        return reply.code(400).send(error(-32600, 'Invalid Request'));
      if (!validId) return reply.code(202).send();
      let result: unknown;
      try {
        if (body.method === 'initialize') {
          const init = z
            .object({
              protocolVersion: z.string(),
              capabilities: z.object({}).passthrough(),
              clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough(),
            })
            .passthrough()
            .parse(body.params);
          result = {
            protocolVersion: protocolVersions.includes(init.protocolVersion)
              ? init.protocolVersion
              : '2025-11-25',
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'relay-observatory', version: '1.1.0' },
            instructions: '只读运营工具；不会返回任何上游原始凭证。',
          };
        } else if (body.method === 'ping') result = {};
        else if (body.method === 'tools/list')
          result = {
            tools: mcpTools.map((t) => ({
              ...t,
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
            })),
          };
        else if (body.method === 'tools/call') {
          const p = z
            .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() })
            .strict()
            .parse(body.params);
          if (!mcpTools.some((t) => t.name === p.name)) return error(-32602, '未知工具');
          try {
            const data = await callMcpTool(store, config, p.name, p.arguments ?? {});
            result = { content: [{ type: 'text', text: JSON.stringify(data) }] };
          } catch (e) {
            if (e instanceof ZodError) return error(-32602, '工具参数不合法');
            result = {
              isError: true,
              content: [{ type: 'text', text: '数据读取失败，请稍后重试' }],
            };
          }
        } else return error(-32601, 'Method not found');
      } catch (e) {
        if (e instanceof ZodError) return error(-32602, 'Invalid params');
        return error(-32603, 'Internal error');
      }
      return { jsonrpc: '2.0', id: body.id, result };
    },
  });
}
