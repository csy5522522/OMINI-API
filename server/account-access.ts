import type { Sub2ApiAdapter } from './adapter.js';
import { capabilityStatus } from './adapter.js';
import { accountMetadata, type KeyProtocol } from './checks.js';

type AccountIdentity = {
  externalId: string;
  name: string;
  platform: string;
  type: string;
  baseUrl: string | null;
};
const rawKey = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() && value.length <= 8192 && !/[\r\n*•…]/.test(value)
    ? value.trim()
    : null;
const messages: Record<string, string> = {
  unauthorized: '主站管理员凭证已失效，请更新主站凭证',
  forbidden: '主站未授权读取完整 Key；若开启二次验证，请使用已验证的管理员 JWT',
  unsupported: '主站版本不支持单账号凭证导出',
  rate_limited: '主站限流，请稍后重新获取',
  error: '主站连接失败或接口异常',
  unavailable: '主站未返回该账号的完整 API Key',
  not_applicable: '此账号使用 OAuth 等凭证，没有可显示的 API Key，可选择生成测试',
};
export async function accountAccess(adapter: Sub2ApiAdapter, account: AccountIdentity) {
  let baseUrl = account.baseUrl;
  let protocol: KeyProtocol =
    account.platform === 'anthropic'
      ? 'anthropic'
      : account.platform === 'gemini'
        ? 'gemini'
        : 'openai';
  const result = (status: string, apiKey: string | null = null) => ({
    status,
    apiKey,
    baseUrl,
    protocol,
    message: apiKey ? '完整 API Key 已从主站获取' : (messages[status] ?? messages.error),
  });
  if (!/^\d+$/.test(account.externalId)) return result('unavailable');
  try {
    const response = await adapter.call(`/api/v1/admin/accounts/${account.externalId}`);
    if (response.status !== 200) return result(capabilityStatus(response.status));
    const detail = response.data;
    if (!detail || String(detail.id) !== account.externalId) return result('unavailable');
    const metadata = accountMetadata(detail);
    baseUrl = metadata.baseUrl;
    protocol =
      metadata.platform === 'anthropic'
        ? 'anthropic'
        : metadata.platform === 'gemini'
          ? 'gemini'
          : 'openai';
    const key = rawKey(detail.credentials?.api_key);
    if (key) return result('supported', key);
    if (metadata.type !== 'apikey' && metadata.type !== 'api_key') return result('not_applicable');
    // The official single-account export is the authorized source for unredacted API keys.
    // Request exactly one ID; never match an export by name across the entire account pool.
    const exported = await adapter.call(
      `/api/v1/admin/accounts/data?ids=${account.externalId}&include_proxies=false`,
    );
    if (exported.status !== 200) return result(capabilityStatus(exported.status));
    const items = exported.data?.accounts;
    if (!Array.isArray(items) || items.length !== 1) return result('unavailable');
    const item = items[0];
    if (item.name !== detail.name || item.platform !== detail.platform || item.type !== detail.type)
      return result('unavailable');
    const exportedUrl = accountMetadata({ ...item, id: detail.id }).baseUrl;
    if (baseUrl && exportedUrl && exportedUrl !== baseUrl) return result('unavailable');
    baseUrl = exportedUrl ?? baseUrl;
    const exportedKey = rawKey(item.credentials?.api_key);
    return exportedKey ? result('supported', exportedKey) : result('unavailable');
  } catch {
    return result('error');
  }
}
