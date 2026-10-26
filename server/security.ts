import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, request } from 'undici';
export function encrypt(value: string, key: string) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'hex'), iv);
  return Buffer.concat([
    iv,
    cipher.update(value, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64');
}
export function decrypt(value: string, key: string) {
  const raw = Buffer.from(value, 'base64'),
    cipher = createDecipheriv('aes-256-gcm', Buffer.from(key, 'hex'), raw.subarray(0, 12));
  cipher.setAuthTag(raw.subarray(-16));
  return Buffer.concat([cipher.update(raw.subarray(12, -16)), cipher.final()]).toString('utf8');
}
export function passwordMatches(value: string, expected: string) {
  return timingSafeEqual(
    scryptSync(value, 'observatory-login', 32),
    scryptSync(expected, 'observatory-login', 32),
  );
}
export function publicAddress(ip: string) {
  try {
    const addr = ipaddr.process(ip);
    return addr.range() === 'unicast';
  } catch {
    return false;
  }
}
export async function validateTarget(base: string, allow: string[] = []) {
  const url = new URL(base);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('只允许不含凭证、查询参数的 HTTP(S) 站点地址');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'metadata.google.internal' || hostname === '169.254.169.254')
    throw new Error('禁止元数据服务地址');
  const addresses = await lookup(hostname, { all: true });
  if (addresses.some((a) => ipaddr.process(a.address).toString() === '169.254.169.254'))
    throw new Error('禁止元数据服务地址');
  if (
    !addresses.length ||
    (!allow.includes(hostname) && addresses.some((a) => !publicAddress(a.address)))
  )
    throw new Error('目标包含内网或保留地址；自建站需在 ALLOW_PRIVATE_HOSTS 中显式允许');
  return { url, addresses };
}
export async function safeGet(
  base: string,
  path: string,
  headers: Record<string, string>,
  allow: string[] = [],
) {
  return safeRequest(base, path, headers, allow);
}
export type RemotePost = (
  base: string,
  path: string,
  headers: Record<string, string>,
  allow: string[],
  body: unknown,
) => Promise<{ status: number; data: any }>;
export const safePost: RemotePost = (base, path, headers, allow, body) =>
  safeRequest(base, path, headers, allow, body);
async function safeRequest(
  base: string,
  path: string,
  headers: Record<string, string>,
  allow: string[],
  body?: unknown,
) {
  const { url, addresses } = await validateTarget(base, allow);
  const target = new URL(url.toString().replace(/\/$/, '') + path);
  const address = addresses[0];
  const agent = new Agent({
    connect: {
      lookup: ((_host: any, opts: any, cb: any) =>
        opts.all ? cb(null, [address]) : cb(null, address.address, address.family)) as any,
      timeout: 8000,
    },
  });
  try {
    const response = await request(target, {
      dispatcher: agent,
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        accept: 'application/json, text/event-stream',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      headersTimeout: 10000,
      bodyTimeout: body === undefined ? 10000 : 55000,
      signal: AbortSignal.timeout(body === undefined ? 15000 : 55000),
    });
    let responseBody = '',
      size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) throw new Error('响应超过 4MB 限制');
      responseBody += chunk.toString();
    }
    let data: any = null;
    try {
      data = JSON.parse(responseBody);
    } catch {
      if (String(response.headers['content-type']).includes('text/event-stream'))
        data = responseBody;
      else if (response.statusCode < 400) throw new Error('接口未返回 JSON');
    }
    return { status: response.statusCode, data };
  } finally {
    await agent.close();
  }
}
