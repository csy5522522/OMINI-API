import { safeGet, type RemotePost } from './security.js';
import { capabilityStatus, type RemoteGet } from './adapter.js';

export type KeyProtocol = 'openai' | 'anthropic' | 'gemini';
const statusMessages: Record<string, string> = {
  supported: '模型列表可访问；不代表所有模型均可生成或余额充足',
  unauthorized: 'Key 无效或已过期',
  forbidden: '当前 Key 权限不足或受访问策略限制',
  unsupported: '服务未提供模型列表，无法据此判断 Key 是否有效',
  rate_limited: '服务限流，请稍后重试',
  error: '远端服务异常',
  unavailable: '响应格式不符合模型列表契约，无法判断 Key 是否有效',
};
export function accountMetadata(a: any) {
  const c = a.credentials ?? {},
    flags = a.credentials_status ?? {};
  const rawUrl = typeof c.base_url === 'string' ? c.base_url : null;
  let baseUrl: string | null = null;
  if (rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (
        ['http:', 'https:'].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      )
        baseUrl = url.toString().replace(/\/$/, '').slice(0, 512);
    } catch {
      /* Invalid URLs are never reflected or probed. */
    }
  }
  const keyPresent =
    typeof flags.has_api_key === 'boolean'
      ? flags.has_api_key
      : typeof c.api_key === 'string'
        ? !!c.api_key
        : typeof flags.has_access_token === 'boolean'
          ? flags.has_access_token
          : typeof c.access_token === 'string'
            ? !!c.access_token
            : null;
  return {
    externalId: String(a.id),
    name: String(a.name ?? a.id).slice(0, 255),
    platform: String(a.platform ?? 'unknown').slice(0, 64),
    type: String(a.type ?? 'unknown').slice(0, 64),
    baseUrl,
    keyPresent,
    status: String(a.status ?? 'unknown').slice(0, 64),
    schedulable: typeof a.schedulable === 'boolean' ? a.schedulable : null,
  };
}
export async function checkApiKey(
  baseUrl: string,
  key: string,
  protocol: KeyProtocol,
  allow: string[],
  get: RemoteGet = safeGet,
) {
  const started = Date.now(),
    headers: Record<string, string> = {};
  const base = baseUrl
    .replace(/\/$/, '')
    .replace(protocol === 'gemini' ? /\/v1beta$/ : /\/v1$/, '');
  if (protocol === 'anthropic')
    Object.assign(headers, { 'x-api-key': key, 'anthropic-version': '2023-06-01' });
  else if (protocol === 'gemini') headers['x-goog-api-key'] = key;
  else headers.authorization = `Bearer ${key}`;
  const path = protocol === 'gemini' ? '/v1beta/models' : '/v1/models';
  try {
    const r = await get(base, path, headers, allow);
    let status = capabilityStatus(r.status);
    const list = protocol === 'gemini' ? r.data?.models : r.data?.data;
    if (status === 'supported' && !Array.isArray(list)) status = 'unavailable';
    const models =
      status === 'supported'
        ? list
            .map((m: any) => (protocol === 'gemini' ? m?.name : m?.id))
            .filter((m: any): m is string => typeof m === 'string')
            .map((m: string) => m.slice(0, 255))
            .slice(0, 500)
        : [];
    return {
      status,
      httpStatus: r.status,
      message: statusMessages[status],
      models,
      latency: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return {
      status: 'error',
      httpStatus: null,
      message: '连接超时、网络失败或目标地址未通过安全检查',
      models: [],
      latency: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  }
}
export async function testAccount(
  base: string,
  externalId: string,
  headers: Record<string, string>,
  allow: string[],
  post: RemotePost,
  model?: string,
) {
  const started = Date.now();
  try {
    const r = await post(
      base,
      `/api/v1/admin/accounts/${encodeURIComponent(externalId)}/test`,
      headers,
      allow,
      { prompt: 'Reply OK.', ...(model ? { model_id: model } : {}) },
    );
    let status = capabilityStatus(r.status);
    if (status === 'supported') {
      // HTTP 200 only opens the stream. Success requires an explicit terminal event.
      const events: any[] =
        typeof r.data === 'string'
          ? r.data
              .split(/\r?\n/)
              .filter((l) => /^data:/.test(l))
              .flatMap((l) => {
                try {
                  return [JSON.parse(l.slice(5).trim())];
                } catch {
                  return [];
                }
              })
          : [];
      status = events.some(
        (e) =>
          e.type === 'error' ||
          e.type === 'test_error' ||
          (e.type === 'test_complete' && e.success !== true),
      )
        ? 'error'
        : events.some((e) => e.type === 'test_complete' && e.success === true)
          ? 'supported'
          : 'unavailable';
    }
    return {
      status,
      httpStatus: r.status,
      latency: Date.now() - started,
      checkedAt: new Date().toISOString(),
      message:
        status === 'supported'
          ? 'Sub2API 已完成账号 API / 凭证连通性测试'
          : status === 'unavailable'
            ? '未收到完整测试结果，请在 Sub2API 检查账号'
            : (statusMessages[status] ?? '账号测试失败，请在 Sub2API 查看详情'),
    };
  } catch {
    return {
      status: 'error',
      httpStatus: null,
      latency: Date.now() - started,
      checkedAt: new Date().toISOString(),
      message: '账号检测超时或连接失败',
    };
  }
}
