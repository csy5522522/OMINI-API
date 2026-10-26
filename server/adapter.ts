import { safeGet } from './security.js';
export type AuthType = 'admin_key' | 'admin_jwt' | 'user_jwt' | 'api_key';
export type RemoteGet = (
  base: string,
  path: string,
  headers: Record<string, string>,
  allow: string[],
) => Promise<{ status: number; data: any }>;
export const capabilityStatus = (status: number) =>
  status === 401
    ? 'unauthorized'
    : status === 403
      ? 'forbidden'
      : status === 404
        ? 'unsupported'
        : status === 429
          ? 'rate_limited'
          : status >= 200 && status < 300
            ? 'supported'
            : 'error';
const messages: Record<string, string> = {
  unauthorized: '认证失败或凭证已过期',
  forbidden: '当前身份无权访问',
  unsupported: '此版本不支持该接口',
  rate_limited: '远端限流，稍后重试',
  supported: '接口可用',
  error: '远端服务异常',
  unavailable: '数据格式与已验证契约不符',
  not_applicable: '此认证方式不适用',
};
export const unwrap = (data: any) =>
  data && typeof data === 'object' && 'code' in data ? data.data : data;
export class Sub2ApiAdapter {
  private latencySamples: number[] = [];
  constructor(
    public base: string,
    public auth: AuthType,
    private secret: string,
    private allow: string[] = [],
    private get: RemoteGet = safeGet,
  ) {}
  async call(path: string) {
    const headers: Record<string, string> = {};
    if (this.auth === 'admin_key') headers['x-api-key'] = this.secret;
    else headers.authorization = `Bearer ${this.secret}`;
    let result: Awaited<ReturnType<RemoteGet>> | undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const started = Date.now();
      try {
        result = await this.get(this.base, path, headers, this.allow);
        if (result.status >= 200 && result.status < 300)
          this.latencySamples.push(Date.now() - started);
      } catch {
        if (attempt === 2) throw new Error('网络连接失败、目标地址被拦截或请求超时');
      }
      if (result && result.status !== 429 && result.status < 500)
        return { ...result, data: unwrap(result.data) };
      if (attempt < 2) await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
    }
    if (!result) throw new Error('网络请求失败');
    return { ...result, data: unwrap(result.data) };
  }
  get isAdmin() {
    return this.auth === 'admin_key' || this.auth === 'admin_jwt';
  }
  async accounts() {
    if (!this.isAdmin) throw new Error('读取账号需要管理员权限');
    const items: any[] = [];
    const seen = new Set<unknown>();
    for (let page = 1; page <= 200; page++) {
      const r = await this.call(`/api/v1/admin/accounts?page=${page}&page_size=100`);
      if (r.status !== 200 || !Array.isArray(r.data?.items))
        throw Object.assign(new Error(`账号列表读取失败（HTTP ${r.status}）`), { statusCode: 422 });
      for (const item of r.data.items) {
        if (seen.has(item?.id))
          throw Object.assign(new Error('账号分页返回重复 ID，本次未覆盖已有数据'), {
            statusCode: 422,
          });
        seen.add(item?.id);
        items.push(item);
      }
      const total = r.data.total;
      if (Number.isSafeInteger(total) && total >= 0) {
        if (items.length >= total) return items;
        if (!r.data.items.length)
          throw Object.assign(new Error('账号分页提前结束，本次未覆盖已有数据'), {
            statusCode: 422,
          });
      } else if (r.data.items.length < 100) return items;
    }
    throw Object.assign(new Error('账号列表超过单次读取上限，本次未覆盖已有数据'), {
      statusCode: 422,
    });
  }
  get panel() {
    return this.isAdmin ? '/api/v1/admin' : '/api/v1';
  }
  plan() {
    return this.auth === 'api_key'
      ? {
          balance: '/v1/usage?days=30',
          tokens: '/v1/usage?days=30',
          billing: '/v1/sub2api/billing',
          models: '/v1/models',
        }
      : {
          balance: this.isAdmin ? null : '/api/v1/user/profile',
          tokens: `${this.panel}/usage/stats`,
          logs: `${this.panel}/usage?page=1&page_size=1`,
          accounts: this.isAdmin ? '/api/v1/admin/accounts?page=1&page_size=100' : null,
          realtime: this.isAdmin ? '/api/v1/admin/dashboard/realtime' : null,
          prices: this.isAdmin
            ? '/api/v1/admin/channels/model-pricing?model=claude-sonnet-4'
            : null,
        };
  }
  async probe() {
    const caps: Record<string, any> = {},
      payloads: Record<string, any> = {},
      cache = new Map<string, any>();
    const started = Date.now();
    for (const [name, path] of Object.entries(this.plan())) {
      if (!path) {
        caps[name] = {
          status: 'not_applicable',
          httpStatus: null,
          message: messages.not_applicable,
        };
        continue;
      }
      try {
        const r = cache.get(path) ?? (await this.call(path));
        cache.set(path, r);
        let status = capabilityStatus(r.status);
        if (status === 'supported') {
          const d = r.data;
          const valid =
            d &&
            typeof d === 'object' &&
            (name !== 'logs' || Array.isArray(d.items)) &&
            (name !== 'models' || Array.isArray(d.data)) &&
            (name !== 'accounts' || Array.isArray(d.items)) &&
            (name !== 'billing' || d.object === 'sub2api.key_billing') &&
            (name !== 'balance' || 'balance' in d || 'remaining' in d || 'quota' in d) &&
            (name !== 'tokens' ||
              (this.auth === 'api_key'
                ? d.usage || d.daily_usage
                : typeof d.total_requests === 'number'));
          if (!valid) status = 'unavailable';
          else payloads[name] = d;
        }
        caps[name] = { status, httpStatus: r.status, message: messages[status] };
      } catch {
        caps[name] = {
          status: 'error',
          httpStatus: null,
          message: '网络超时、连接失败或地址安全检查未通过',
        };
      }
    }
    for (const name of [
      'balance',
      'tokens',
      'logs',
      'models',
      'prices',
      'accounts',
      'realtime',
      'billing',
    ])
      if (!caps[name])
        caps[name] = {
          status: 'not_applicable',
          httpStatus: null,
          message: messages.not_applicable,
        };
    return {
      caps,
      payloads,
      latency: this.latencySamples[0] ?? null,
      collectionDuration: Date.now() - started,
    };
  }
}
