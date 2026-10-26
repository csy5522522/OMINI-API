import { describe, it, expect } from 'vitest';
import {
  encrypt,
  decrypt,
  publicAddress,
  validateTarget,
  passwordMatches,
} from '../server/security.js';
describe('凭证与 SSRF 防护', () => {
  it('AES-GCM 随机 nonce、认证标签和往返解密', () => {
    const key = 'ab'.repeat(32),
      a = encrypt('secret-api-key', key),
      b = encrypt('secret-api-key', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-api-key');
    expect(decrypt(a, key)).toBe('secret-api-key');
    expect(() => decrypt(a, 'cd'.repeat(32))).toThrow();
  });
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.1',
    '169.254.169.254',
    '0.0.0.0',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe80::1',
    '224.0.0.1',
  ])('阻止保留地址 %s', (ip) => expect(publicAddress(ip)).toBe(false));
  it('允许公网地址', () => expect(publicAddress('8.8.8.8')).toBe(true));
  it('禁止 URL 凭证、危险协议、私网以及元数据地址', async () => {
    for (const url of [
      'file:///etc/passwd',
      'https://a:b@example.com',
      'http://127.0.0.1',
      'http://169.254.169.254',
    ])
      await expect(validateTarget(url)).rejects.toThrow();
  });
  it('只有明确列出的内网主机可用', async () => {
    await expect(validateTarget('http://127.0.0.1', ['127.0.0.1'])).resolves.toBeTruthy();
  });
  it('固定长度比较密码', () => {
    expect(passwordMatches('long-password', 'long-password')).toBe(true);
    expect(passwordMatches('wrong', 'long-password')).toBe(false);
  });
});
