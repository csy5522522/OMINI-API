import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BookOpen,
  Check,
  Copy,
  KeyRound,
  Play,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Empty, Table } from './ui';
import { mcpTools } from '../../shared/mcp';

const stamp = (v: string | null) =>
  v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '尚未检测';
const statuses: Record<string, string> = {
  supported: '检测通过',
  unauthorized: '认证失效',
  forbidden: '权限不足',
  unsupported: '接口不支持',
  rate_limited: '远端限流',
  unavailable: '无法确认',
  error: '检测失败',
};
function ResultBadge({ status }: { status?: string }) {
  return (
    <Badge
      tone={
        status === 'supported'
          ? 'good'
          : ['error', 'unauthorized'].includes(status ?? '')
            ? 'bad'
            : status
              ? 'warn'
              : 'neutral'
      }
    >
      {statuses[status ?? ''] ?? '未检测'}
    </Badge>
  );
}
function Card({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
function Code({ value, secret = false }: { value: string; secret?: boolean }) {
  const [copied, setCopied] = useState(false),
    [error, setError] = useState('');
  return (
    <div className="code-block">
      <Button
        variant="ghost"
        aria-label={secret ? '复制接入密钥' : '复制配置'}
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
            setError('');
            setTimeout(() => setCopied(false), 1800);
          } catch {
            setError('请选中文本手动复制');
          }
        }}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? '已复制' : '复制'}
      </Button>
      <pre tabIndex={0}>{value}</pre>
      {error && <p role="status">{error}</p>}
    </div>
  );
}
export function UpstreamAccounts({ configured }: { configured: boolean }) {
  const [rows, setRows] = useState<any[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [model, setModel] = useState(''),
    [ack, setAck] = useState(false),
    [progress, setProgress] = useState('');
  const alive = useRef(true),
    stop = useRef(false);
  const load = async () => {
    const result = await api('/accounts');
    if (alive.current) setRows(result);
  };
  useEffect(() => {
    alive.current = true;
    void load().catch((e) => setError(e.message));
    return () => {
      alive.current = false;
      stop.current = true;
    };
  }, []);
  const check = async (accounts: any[]) => {
    setBusy(true);
    setError('');
    setNotice('');
    stop.current = false;
    let done = 0;
    try {
      for (const a of accounts) {
        if (stop.current) break;
        setProgress(`${done + 1} / ${accounts.length} · ${a.name}`);
        const result = await api(`/accounts/${a.id}/check`, {
          acknowledgeUsage: true,
          ...(model.trim() ? { model: model.trim() } : {}),
        });
        done++;
        if (alive.current)
          setRows((current) =>
            current.map((row) =>
              row.id === a.id ? { ...row, checkedAt: result.checkedAt, checkResult: result } : row,
            ),
          );
      }
      if (alive.current) setNotice(`已完成 ${done} / ${accounts.length} 个账号检测`);
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        setProgress('');
      }
    }
  };
  return (
    <div className="integration-stack">
      <div className="info-strip">
        <ShieldCheck size={17} />
        <span>
          直接读取主站 Sub2API 的账号管理模块，自动获取上游 API 地址、凭证配置和账号状态。
        </span>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="info-strip" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      <Card
        title={`上游账号 · ${rows.length}`}
        action={
          <Button
            variant="outline"
            disabled={busy || !configured}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                const r = await api('/accounts/refresh', {});
                await load();
                setNotice(r.message);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={14} />从 Sub2API 获取
          </Button>
        }
      >
        {!configured ? (
          <Empty
            title="先配置主中转站"
            description="配置一个具有管理员权限的 Sub2API 主站后，账号会随主站同步自动获取。"
          />
        ) : (
          <>
            <div className="account-controls">
              <label>
                测试模型（可选）
                <input
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="留空使用 Sub2API 默认模型"
                  maxLength={200}
                  disabled={busy}
                />
              </label>
              <label className="check-label">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                  disabled={busy}
                />
                我已了解：调用 Sub2API 测试会请求上游，可能产生用量并恢复账号调度状态。
              </label>
              <div className="actions">
                <Button disabled={busy || !ack || !rows.length} onClick={() => void check(rows)}>
                  <Play size={14} />
                  逐个检测全部账号
                </Button>
                {busy && progress && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      stop.current = true;
                    }}
                  >
                    完成当前账号后停止
                  </Button>
                )}
                <span role="status" className="muted">
                  {progress}
                </span>
              </div>
            </div>
            <Table
              rows={rows}
              empty="尚未获取账号，点击「从 Sub2API 获取」"
              emptyDescription="账号将直接从主站读取，无需逐个添加第三方中转站。"
              columns={[
                {
                  key: 'name',
                  label: '账号',
                  render: (a) => (
                    <div>
                      <strong>{a.name}</strong>
                      <p className="muted">
                        #{a.externalId} · {a.platform} / {a.type}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'baseUrl',
                  label: 'API 地址',
                  render: (a) => (
                    <span className="endpoint-text">
                      {a.baseUrl ?? '未提供地址 · 由 Sub2API 管理'}
                    </span>
                  ),
                },
                {
                  key: 'keyPresent',
                  label: 'Key / OAuth 凭证',
                  render: (a) => (
                    <Badge
                      tone={
                        a.keyPresent === true ? 'good' : a.keyPresent === false ? 'bad' : 'neutral'
                      }
                    >
                      {a.keyPresent === true
                        ? '已配置 · 已脱敏'
                        : a.keyPresent === false
                          ? '未配置'
                          : '主站未返回配置状态'}
                    </Badge>
                  ),
                },
                {
                  key: 'status',
                  label: '主站状态',
                  render: (a) => (
                    <div>
                      {a.status}
                      <p className="muted">
                        {a.schedulable === true
                          ? '可调度'
                          : a.schedulable === false
                            ? '不可调度'
                            : '调度状态未知'}
                      </p>
                    </div>
                  ),
                },
                {
                  key: 'checkedAt',
                  label: '检测结果',
                  render: (a) => (
                    <div>
                      <ResultBadge status={a.checkResult?.status} />
                      <p className="muted">{stamp(a.checkedAt)}</p>
                      {a.checkResult && (
                        <p className="muted">
                          {a.checkResult.message}
                          {a.checkResult.httpStatus ? ` · HTTP ${a.checkResult.httpStatus}` : ''}
                        </p>
                      )}
                    </div>
                  ),
                },
                {
                  key: 'actions',
                  label: '操作',
                  render: (a) => (
                    <Button
                      variant="outline"
                      disabled={busy || !ack}
                      onClick={() => void check([a])}
                    >
                      检测 API / Key
                    </Button>
                  ),
                },
              ]}
            />
          </>
        )}
      </Card>
      <p className="integration-note">
        原始 Key 与 OAuth Token 保留在 Sub2API。凭证“已配置”仅表示存在；检测通过以 Sub2API
        的完整测试结果为准。自动同步只读取账号信息。
      </p>
    </div>
  );
}
export function ApiKeyChecker() {
  const [url, setUrl] = useState(''),
    [key, setKey] = useState(''),
    [protocol, setProtocol] = useState('openai'),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState<any>(null),
    [error, setError] = useState('');
  return (
    <div className="integration-stack">
      <div className="info-strip">
        <KeyRound size={17} />
        <span>
          检测任意 API Key 的认证与模型列表权限，支持 OpenAI 兼容、Anthropic 和 Gemini 接口。
        </span>
      </div>
      <div className="checker-grid">
        <Card title="API Key 检测">
          <form
            className="integration-form"
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError('');
              setResult(null);
              const submittedKey = key;
              setKey('');
              try {
                setResult(
                  await api('/keys/check', {
                    baseUrl: url.trim(),
                    key: submittedKey.trim(),
                    protocol,
                  }),
                );
              } catch (err) {
                setError((err as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <label>
              接口协议
              <select
                value={protocol}
                onChange={(e) => {
                  setProtocol(e.target.value);
                  setResult(null);
                }}
                disabled={busy}
              >
                <option value="openai">OpenAI 兼容 / Sub2API</option>
                <option value="anthropic">Anthropic</option>
                <option value="gemini">Gemini</option>
              </select>
            </label>
            <label>
              API 地址
              <input
                type="url"
                required
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  setResult(null);
                }}
                disabled={busy}
                placeholder="https://api.example.com 或 https://api.example.com/v1"
                maxLength={512}
              />
            </label>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                required
                value={key}
                onChange={(e) => {
                  setKey(e.target.value);
                  setResult(null);
                }}
                disabled={busy}
                placeholder="输入需要检测的 Key"
                maxLength={8192}
              />
            </label>
            <p className="muted">
              仅在本次请求中使用，提交后清空输入，不保存原始 Key。查询模型列表不发起生成请求。
            </p>
            {error && (
              <div className="error-box" role="alert">
                {error}
              </div>
            )}
            <Button disabled={busy} type="submit">
              <ShieldCheck size={15} />
              {busy ? '正在检测…' : '开始检测'}
            </Button>
          </form>
        </Card>
        <Card title="检测结果">
          {!result ? (
            <Empty
              title={busy ? '正在连接 API' : '等待检测'}
              description="提交地址和 Key 后，在此查看认证、接口状态与可访问模型。"
            />
          ) : (
            <div className="integration-form" role="status">
              <ResultBadge status={result.status} />
              <p>{result.message}</p>
              <div className="check-stats">
                <span>
                  HTTP <strong>{result.httpStatus ?? '—'}</strong>
                </span>
                <span>
                  响应 <strong>{result.latency} ms</strong>
                </span>
                <span>
                  模型 <strong>{result.models.length}</strong>
                </span>
              </div>
              <p className="muted">{stamp(result.checkedAt)}</p>
              {result.models.length > 0 && (
                <div className="model-tags">
                  {result.models.map((m: string) => (
                    <code key={m}>{m}</code>
                  ))}
                </div>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
export function McpPlatform() {
  const [section, setSection] = useState('token'),
    [keys, setKeys] = useState<any[]>([]),
    [name, setName] = useState(''),
    [days, setDays] = useState('30'),
    [token, setToken] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [client, setClient] = useState('generic');
  const endpoint = `${window.location.origin}/mcp`;
  const sections = [
    ['token', '1. 获取 MCP Token'],
    ['quickstart', '2. 快速开始'],
    ['clients', '3. 客户端配置'],
    ['tools', '4. 工具列表'],
    ['debug', '5. 调试与错误码'],
  ];
  const load = async () => setKeys(await api('/mcp/keys'));
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  // Templates always contain placeholders; a real token is only shown in the creation notice.
  const config = JSON.stringify(
    {
      mcpServers: {
        'relay-observatory': {
          ...(client === 'cherry' ? { type: 'streamableHttp' } : {}),
          url: endpoint,
          headers: { Authorization: 'Bearer <YOUR_MCP_TOKEN>' },
        },
      },
    },
    null,
    2,
  );
  return (
    <div className="mcp-platform">
      <div className="mcp-hero">
        <div className="mcp-hero-icon">
          <Terminal size={24} />
        </div>
        <div>
          <span className="eyebrow">DEVELOPER PLATFORM</span>
          <h2>让你的 AI，读懂每一次 API 调用。</h2>
          <p>通过 MCP 连接运营数据，把总览、上游账号和模型目录带进你的 AI 工作流。</p>
        </div>
        <Badge tone="good">Streamable HTTP</Badge>
      </div>
      <div className="mcp-layout">
        <nav className="mcp-toc" aria-label="MCP 文档导航">
          <span className="eyebrow">接入指南</span>
          {sections.map(([id, title]) => (
            <button
              key={id}
              className={section === id ? 'active' : ''}
              onClick={() => setSection(id)}
            >
              {title}
            </button>
          ))}
          <a href="https://open.mcd.cn/mcp/doc" target="_blank" rel="noreferrer">
            <BookOpen size={14} />
            参考文档
          </a>
        </nav>
        <div className="mcp-document">
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          {section === 'token' && (
            <>
              <span className="eyebrow">AUTHENTICATION</span>
              <h2>1. 获取 MCP Token</h2>
              <p>
                为每个客户端创建独立的接入密钥。密钥可读取本工作区的运营数据，默认有效期 30
                天，可随时撤销。
              </p>
              <form
                className="token-form"
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  setError('');
                  setToken('');
                  try {
                    const r = await api('/mcp/keys', { name: name.trim(), days: Number(days) });
                    setToken(r.token);
                    setName('');
                    await load();
                  } catch (err) {
                    setError((err as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <label>
                  客户端名称
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="例如：我的 Cursor"
                    maxLength={100}
                  />
                </label>
                <label>
                  有效期
                  <select value={days} onChange={(e) => setDays(e.target.value)}>
                    <option value="7">7 天</option>
                    <option value="30">30 天</option>
                    <option value="90">90 天</option>
                    <option value="365">365 天</option>
                  </select>
                </label>
                <Button disabled={busy}>
                  <KeyRound size={14} />
                  创建 Token
                </Button>
              </form>
              {token && (
                <div className="token-notice">
                  <strong>请立即复制。完整密钥仅显示一次。</strong>
                  <Code value={token} secret />
                  <Button variant="outline" onClick={() => setToken('')}>
                    我已保存，隐藏密钥
                  </Button>
                </div>
              )}
              <Table
                rows={keys}
                columns={[
                  { key: 'name', label: '名称' },
                  { key: 'prefix', label: '密钥', render: (k) => <code>{k.prefix}••••••</code> },
                  { key: 'expiresAt', label: '到期时间', render: (k) => stamp(k.expiresAt) },
                  {
                    key: 'lastUsedAt',
                    label: '最近调用',
                    render: (k) => (k.lastUsedAt ? stamp(k.lastUsedAt) : '尚未使用'),
                  },
                  {
                    key: 'revokedAt',
                    label: '状态',
                    render: (k) => (
                      <Badge
                        tone={
                          k.revokedAt || k.expiresAt <= new Date().toISOString()
                            ? 'neutral'
                            : 'good'
                        }
                      >
                        {k.revokedAt
                          ? '已撤销'
                          : k.expiresAt <= new Date().toISOString()
                            ? '已过期'
                            : '有效'}
                      </Badge>
                    ),
                  },
                  {
                    key: 'actions',
                    label: '操作',
                    render: (k) => (
                      <Button
                        variant="ghost"
                        disabled={busy || !!k.revokedAt}
                        onClick={async () => {
                          setBusy(true);
                          setError('');
                          try {
                            await api(`/mcp/keys/${k.id}`, undefined, 'DELETE');
                            await load();
                          } catch (e) {
                            setError((e as Error).message);
                          } finally {
                            setBusy(false);
                          }
                        }}
                      >
                        撤销
                      </Button>
                    ),
                  },
                ]}
                empty="还没有接入密钥"
                emptyDescription="为你的 AI 客户端创建一个 MCP Token，即可开始接入。"
              />
            </>
          )}
          {section === 'quickstart' && (
            <>
              <span className="eyebrow">QUICK START</span>
              <h2>2. 快速开始</h2>
              <h3>接入地址</h3>
              <Code value={endpoint} />
              <p>
                使用 Streamable HTTP 连接，服务以 JSON 响应 POST 请求。请求头添加{' '}
                <code>Authorization: Bearer &lt;YOUR_MCP_TOKEN&gt;</code>。
              </p>
              <div className="doc-steps">
                <div>
                  <b>01</b>
                  <h3>创建 Token</h3>
                  <p>在「获取 MCP Token」生成专用接入密钥。</p>
                </div>
                <div>
                  <b>02</b>
                  <h3>连接客户端</h3>
                  <p>复制配置，填入真实 Token，并使用客户端能访问的本站地址。</p>
                </div>
                <div>
                  <b>03</b>
                  <h3>调用运营工具</h3>
                  <p>例如询问 AI：“查看最近 7 天的 API 运营总览。”</p>
                </div>
              </div>
              <h3>传输与权限</h3>
              <p>
                本平台开放三个只读工具。Token
                不用于登录管理后台，也不能触发账号测试。远程连接请使用部署后的 HTTPS
                地址；本机地址仅供同一设备访问。
              </p>
            </>
          )}
          {section === 'clients' && (
            <>
              <span className="eyebrow">CLIENT CONFIGURATION</span>
              <h2>3. 客户端配置</h2>
              <div className="doc-tabs">
                {[
                  ['generic', '通用 JSON'],
                  ['cursor', 'Cursor'],
                  ['cherry', 'Cherry Studio'],
                ].map(([id, label]) => (
                  <Button
                    variant={client === id ? 'default' : 'outline'}
                    key={id}
                    onClick={() => setClient(id)}
                  >
                    {label}
                  </Button>
                ))}
              </div>
              <p>
                {client === 'cursor'
                  ? '将以下 mcpServers 条目添加到 Cursor 的 MCP 配置文件，替换 Token 占位符。'
                  : client === 'cherry'
                    ? '在 MCP 服务器设置中选择 Streamable HTTP，填写接入地址，并添加 Authorization 请求头。以下 JSON 为配置字段示例。'
                    : '适用于支持远程 MCP 和自定义请求头的客户端，按客户端要求导入以下配置。'}
              </p>
              <Code value={config} />
              <p className="muted">
                将 &lt;YOUR_MCP_TOKEN&gt; 替换为你创建的接入密钥。不要填入主站管理员 Key 或上游 API
                Key。
              </p>
            </>
          )}
          {section === 'tools' && (
            <>
              <span className="eyebrow">TOOLS REFERENCE</span>
              <h2>4. 工具列表</h2>
              <p>工具读取本系统已同步的数据，账号状态以最近一次同步和检测时间为准。</p>
              {mcpTools.map((tool) => (
                <article className="mcp-tool" key={tool.name}>
                  <div>
                    <code>{tool.name}</code>
                    <Badge tone="good">只读</Badge>
                  </div>
                  <p>{tool.description}</p>
                  <h3>参数模板</h3>
                  <Code
                    value={JSON.stringify(
                      tool.name === 'get_overview' ? { period: '7' } : { page: 1, pageSize: 50 },
                      null,
                      2,
                    )}
                  />
                  <details>
                    <summary>查看参数 Schema</summary>
                    <Code value={JSON.stringify(tool.inputSchema, null, 2)} />
                  </details>
                </article>
              ))}
            </>
          )}
          {section === 'debug' && (
            <>
              <span className="eyebrow">DEBUGGING</span>
              <h2>5. 调试与错误码</h2>
              <p>
                先调用 initialize，再发送 notifications/initialized，最后通过 tools/list
                查看工具。请求头同时包含 Content-Type: application/json 与 Accept: application/json,
                text/event-stream。
              </p>
              <h3>初始化请求</h3>
              <Code
                value={JSON.stringify(
                  {
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                      protocolVersion: '2025-11-25',
                      capabilities: {},
                      clientInfo: { name: 'my-client', version: '1.0.0' },
                    },
                  },
                  null,
                  2,
                )}
              />
              <h3>调用示例</h3>
              <Code
                value={JSON.stringify(
                  {
                    jsonrpc: '2.0',
                    id: 2,
                    method: 'tools/call',
                    params: { name: 'get_overview', arguments: { period: '7' } },
                  },
                  null,
                  2,
                )}
              />
              <Table
                searchable={false}
                rows={[
                  { code: 'HTTP 401', meaning: 'Token 缺失、错误、到期或已撤销' },
                  { code: 'HTTP 403', meaning: '请求来源不被允许' },
                  { code: 'HTTP 405', meaning: '仅支持 POST，不提供 SSE 长连接' },
                  { code: 'HTTP 429', meaning: '请求过于频繁，请稍后重试' },
                  { code: '-32600', meaning: 'JSON-RPC 消息格式错误' },
                  { code: '-32601', meaning: '方法不存在' },
                  { code: '-32602', meaning: '工具名称或参数错误' },
                ]}
                columns={[
                  { key: 'code', label: '错误码' },
                  { key: 'meaning', label: '说明' },
                ]}
              />
              <p className="muted">
                支持协议版本 2025-03-26、2025-06-18、2025-11-25；采用无状态连接。
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
