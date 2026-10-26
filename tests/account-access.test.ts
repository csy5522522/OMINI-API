import { describe, it, expect } from 'vitest';
import { Sub2ApiAdapter } from '../server/adapter.js';
import { accountAccess } from '../server/account-access.js';

const identity = {
  externalId: '1',
  name: 'upstream',
  platform: 'openai',
  type: 'apikey',
  baseUrl: 'https://upstream.example/v1',
};
const detail = {
  id: 1,
  name: identity.name,
  platform: identity.platform,
  type: identity.type,
  credentials: { base_url: identity.baseUrl },
  credentials_status: { has_api_key: true },
};
describe('上游完整 Key 读取', () => {
  it('详情已返回完整 Key 时直接使用，不调用导出', async () => {
    let calls = 0;
    const adapter = new Sub2ApiAdapter(
      'https://main.example',
      'admin_key',
      'admin',
      [],
      async () => {
        calls++;
        return {
          status: 200,
          data: { ...detail, credentials: { ...detail.credentials, api_key: 'full-key' } },
        };
      },
    );
    expect((await accountAccess(adapter, identity)).apiKey).toBe('full-key');
    expect(calls).toBe(1);
  });
  it('新版脱敏详情使用精确 ID 导出，只返回 API Key，不返回 OAuth/代理等信息', async () => {
    const adapter = new Sub2ApiAdapter(
      'https://main.example',
      'admin_key',
      'admin',
      [],
      async (_base, path) => {
        if (path === '/api/v1/admin/accounts/1')
          return { status: 200, data: { code: 0, data: detail } };
        expect(path).toBe('/api/v1/admin/accounts/data?ids=1&include_proxies=false');
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              accounts: [
                {
                  ...detail,
                  credentials: {
                    ...detail.credentials,
                    api_key: 'full-key',
                    refresh_token: 'DO-NOT-RETURN',
                  },
                },
              ],
              proxies: [{ password: 'DO-NOT-RETURN' }],
            },
          },
        };
      },
    );
    const access = await accountAccess(adapter, identity);
    expect(access.apiKey).toBe('full-key');
    expect(access.baseUrl).toBe(identity.baseUrl);
    expect(JSON.stringify(access)).not.toContain('DO-NOT-RETURN');
  });
  it('导出权限或二次验证被拒绝时不绕过，不伪造 Key', async () => {
    const adapter = new Sub2ApiAdapter(
      'https://main.example',
      'admin_key',
      'admin',
      [],
      async (_base, path) =>
        path.endsWith('/1')
          ? { status: 200, data: detail }
          : { status: 403, data: { message: 'DO-NOT-RETURN' } },
    );
    const access = await accountAccess(adapter, identity);
    expect(access.status).toBe('forbidden');
    expect(access.apiKey).toBeNull();
    expect(access.message).toContain('二次验证');
    expect(JSON.stringify(access)).not.toContain('DO-NOT-RETURN');
  });
  it('拒绝多账号、错配账号与掩码 Key，OAuth 不读取导出', async () => {
    for (const items of [
      [detail, detail],
      [{ ...detail, name: 'wrong', credentials: { api_key: 'wrong-key' } }],
      [{ ...detail, credentials: { ...detail.credentials, api_key: 'sk-***' } }],
    ]) {
      const adapter = new Sub2ApiAdapter(
        'https://main.example',
        'admin_key',
        'admin',
        [],
        async (_base, path) => ({
          status: 200,
          data: path.endsWith('/1') ? detail : { accounts: items },
        }),
      );
      expect((await accountAccess(adapter, identity)).apiKey).toBeNull();
    }
    let calls = 0;
    const oauth = new Sub2ApiAdapter('https://main.example', 'admin_key', 'admin', [], async () => {
      calls++;
      return { status: 200, data: { ...detail, type: 'oauth' } };
    });
    expect((await accountAccess(oauth, { ...identity, type: 'oauth' })).status).toBe(
      'not_applicable',
    );
    expect(calls).toBe(1);
  });
});
