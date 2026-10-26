import { describe, it, expect } from 'vitest';
import { accountMetadata, checkApiKey, testAccount } from '../server/checks.js';
import { Sub2ApiAdapter } from '../server/adapter.js';

describe('API 与账号检测契约', () => {
  it('只保存账号白名单字段，兼容新版脱敏凭证和旧版明文响应', () => {
    const metadata = accountMetadata({
      id: 1,
      name: 'upstream',
      platform: 'openai',
      type: 'apikey',
      credentials: {
        base_url: 'https://relay.example/v1',
        api_key: 'secret',
        access_token: 'oauth-secret',
      },
      credentials_status: { has_api_key: true },
      extra: { private: 'secret' },
    });
    expect(metadata.baseUrl).toBe('https://relay.example/v1');
    expect(metadata.keyPresent).toBe(true);
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(accountMetadata({ id: 2, credentials_status: { has_api_key: false } }).keyPresent).toBe(
      false,
    );
    expect(accountMetadata({ id: 2 }).keyPresent).toBeNull();
    expect(
      accountMetadata({
        id: 2,
        credentials: { base_url: 'https://user:secret@example.com/?key=secret' },
      }).baseUrl,
    ).toBeNull();
  });
  it('账号列表完整分页，第二页失败不返回不完整列表', async () => {
    const paths: string[] = [];
    let fail = false;
    const adapter = new Sub2ApiAdapter(
      'https://relay.example',
      'admin_key',
      'admin',
      [],
      async (_base, path) => {
        paths.push(path);
        if (path.includes('page=2'))
          return fail
            ? { status: 403, data: {} }
            : { status: 200, data: { code: 0, data: { items: [{ id: 101 }], total: 101 } } };
        return {
          status: 200,
          data: {
            code: 0,
            data: { items: Array.from({ length: 100 }, (_, i) => ({ id: i + 1 })), total: 101 },
          },
        };
      },
    );
    expect(await adapter.accounts()).toHaveLength(101);
    expect(paths[1]).toContain('page=2');
    fail = true;
    await expect(adapter.accounts()).rejects.toThrow('HTTP 403');
  });
  it('各协议使用正确路径和请求头，支持带版本前缀的 URL', async () => {
    for (const protocol of ['openai', 'anthropic', 'gemini'] as const) {
      const result = await checkApiKey(
        `https://relay.example/custom/${protocol === 'gemini' ? 'v1beta' : 'v1'}`,
        'secret',
        protocol,
        [],
        async (base, path, headers) => {
          expect(base).toBe('https://relay.example/custom');
          expect(path).toBe(protocol === 'gemini' ? '/v1beta/models' : '/v1/models');
          expect(
            headers[
              protocol === 'gemini'
                ? 'x-goog-api-key'
                : protocol === 'anthropic'
                  ? 'x-api-key'
                  : 'authorization'
            ],
          ).toBe(protocol === 'openai' ? 'Bearer secret' : 'secret');
          return {
            status: 200,
            data:
              protocol === 'gemini'
                ? { models: [{ name: 'models/example' }] }
                : { data: [{ id: 'example' }] },
          };
        },
      );
      expect(result.status).toBe('supported');
      expect(result.models).toHaveLength(1);
    }
  });
  it('远端缩小每页数量时按 total 继续获取，空页提前结束与重复页均报错', async () => {
    const make = (mode: 'short' | 'empty' | 'repeat') =>
      new Sub2ApiAdapter('https://relay.example', 'admin_key', 'admin', [], async (_base, path) => {
        const second = path.includes('page=2');
        return {
          status: 200,
          data: {
            code: 0,
            data: {
              total: 2,
              items:
                second && mode === 'empty' ? [] : [{ id: second && mode !== 'repeat' ? 2 : 1 }],
            },
          },
        };
      });
    expect(await make('short').accounts()).toHaveLength(2);
    await expect(make('empty').accounts()).rejects.toThrow('提前结束');
    await expect(make('repeat').accounts()).rejects.toThrow('重复 ID');
  });
  it('认证失效、权限、限流、不支持与异常格式不混淆，不回显上游错误', async () => {
    for (const [code, expected] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'unsupported'],
      [429, 'rate_limited'],
      [500, 'error'],
      [200, 'unavailable'],
    ] as const) {
      const r = await checkApiKey('https://relay.example', 'secret', 'openai', [], async () => ({
        status: code,
        data: { message: 'secret' },
      }));
      expect(r.status).toBe(expected);
      expect(JSON.stringify(r)).not.toContain('secret');
    }
  });
  it('SSE 必须明确成功结束，HTTP 200、内容片段和错误事件均不能视作通过', async () => {
    for (const [data, status] of [
      ['data: {"type":"test_complete","success":true}\n\n', 'supported'],
      ['data: {"type":"content","text":"secret"}\n\n', 'unavailable'],
      [
        'data: {"type":"error","error":"secret"}\n\ndata: {"type":"test_complete","success":true}\n\n',
        'error',
      ],
      ['data: {"type":"test_complete","success":false}\n\n', 'error'],
    ]) {
      const r = await testAccount('https://relay.example', '1', {}, [], async () => ({
        status: 200,
        data,
      }));
      expect(r.status).toBe(status);
      expect(JSON.stringify(r)).not.toContain('secret');
    }
  });
});
