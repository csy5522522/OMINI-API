import Fastify from 'fastify';
import { dayIn } from '../server/time.js';
export async function mockSub2Api() {
  const app = Fastify(),
    calls: { path: string; auth: string }[] = [];
  const today = dayIn(new Date(), 'Asia/Shanghai');
  const records = [
    {
      id: 1,
      request_id: 'down-request',
      upstream_request_id: 'up-request',
      model: 'test-model',
      input_tokens: 1000000,
      output_tokens: 1000,
      cache_read_tokens: 100,
      cache_creation_tokens: 50,
      actual_cost: 5,
      duration_ms: 420,
      first_token_ms: 80,
      created_at: new Date().toISOString(),
      api_key: { key: 'MUST-NOT-LEAK' },
      user: { email: 'private@example.com' },
    },
  ];
  app.get('/*', async (req, reply) => {
    const auth = String(req.headers['x-api-key'] ?? req.headers.authorization ?? ''),
      path = req.url;
    calls.push({ path, auth });
    if (auth.includes('expired')) return reply.code(401).send({ message: 'expired' });
    if (path.includes('/admin/') && auth !== 'admin-secret')
      return reply.code(403).send({ message: 'forbidden' });
    if (path.startsWith('/v1/') && auth !== 'Bearer model-secret')
      return reply.code(401).send({ message: 'bad key' });
    if (
      path.startsWith('/api/v1/') &&
      !path.includes('/admin/') &&
      !['Bearer user-secret', 'admin-secret'].includes(auth)
    )
      return reply.code(401).send({ message: 'bad jwt' });
    if (path.startsWith('/v1/usage'))
      return {
        mode: 'unrestricted',
        balance: 100,
        remaining: 100,
        unit: 'USD',
        usage: { today: { requests: 3, total_tokens: 200 } },
        daily_usage: [
          {
            date: today,
            requests: 3,
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 30,
            cache_write_tokens: 20,
            total_tokens: 200,
            actual_cost: 2,
          },
        ],
        model_stats: [{ model: 'test-model', requests: 3 }],
      };
    if (path === '/v1/models') return { object: 'list', data: [{ id: 'test-model' }] };
    if (path === '/v1/sub2api/billing') return reply.code(404).send({ message: 'old version' });
    if (path.includes('/usage?'))
      return {
        code: 0,
        data: {
          items: records.map((r) =>
            auth === 'Bearer user-secret'
              ? {
                  ...r,
                  id: 2,
                  request_id: 'up-request',
                  upstream_request_id: undefined,
                  actual_cost: 2,
                }
              : r,
          ),
          total: 1,
          page: 1,
          page_size: 100,
          pages: 1,
        },
      };
    if (path.endsWith('/usage/stats'))
      return {
        code: 0,
        data: {
          total_requests: 1,
          total_tokens: 1001150,
          total_actual_cost: auth === 'admin-secret' ? 5 : 2,
        },
      };
    if (path.endsWith('/user/profile'))
      return { code: 0, data: { balance: 50, email: 'private@example.com' } };
    if (path.includes('/accounts?'))
      return {
        code: 0,
        data: {
          items: [
            {
              id: 1,
              name: 'upstream',
              status: 'active',
              schedulable: true,
              credentials: { token: 'MUST-NOT-LEAK' },
            },
          ],
        },
      };
    if (path.endsWith('/dashboard/realtime')) return { code: 0, data: { rpm: 10, tpm: 100 } };
    if (path.includes('/channels/model-pricing?'))
      return {
        code: 0,
        data: {
          found: true,
          input_price: 0.000002,
          output_price: 0.000008,
          cache_read_price: 0.0000002,
          cache_write_price: 0.0000025,
        },
      };
    return reply.code(404).send({ message: 'not found' });
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address() as { port: number };
  return { app, url: `http://127.0.0.1:${address.port}`, calls };
}
