import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  BarChart3,
  Bell,
  Calculator,
  Check,
  ChevronRight,
  Command,
  CreditCard,
  Database,
  ExternalLink,
  Globe2,
  LayoutDashboard,
  KeyRound,
  Layers,
  LogOut,
  Menu,
  Moon,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings,
  ShieldCheck,
  Sun,
  Tags,
  Wallet,
  Terminal,
  X,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  BarChart,
  Bar,
} from 'recharts';
import { api } from './api';
import { Badge, Button, Empty, FormModal, Table, Tip, type Field } from './components/ui';
import { calculate, type Rates, type Tokens } from '../shared/finance';
import { periodRange, dayIn } from '../shared/time';
import { UpstreamAccounts, McpPlatform } from './components/Integrations';
import { KeyMonitors } from './components/KeyMonitors';
type Page =
  | 'overview'
  | 'stations'
  | 'balances'
  | 'key-monitors'
  | 'mcp'
  | 'detail'
  | 'models'
  | 'calculator'
  | 'profit'
  | 'prices'
  | 'costs'
  | 'compare'
  | 'alerts'
  | 'settings';
const nav: [Page, string, typeof Activity][] = [
  ['overview', '总览仪表盘', LayoutDashboard],
  ['stations', '中转站管理', Server],
  ['balances', '余额监控', Wallet],
  ['key-monitors', 'API Key 监控', KeyRound],
  ['mcp', 'MCP 开放平台', Terminal],
  ['models', '模型监控', Layers],
  ['compare', '中转站对比', BarChart3],
  ['calculator', 'Token 计算器', Calculator],
  ['profit', '成本与利润', Wallet],
  ['prices', '模型价格', Tags],
  ['costs', '订阅与充值', CreditCard],
  ['alerts', '告警中心', Bell],
  ['settings', '系统设置', Settings],
];
const titles: Record<Page, [string, string]> = {
  overview: ['总览仪表盘', '将每一次请求，转化为清晰的业务洞察。'],
  stations: ['中转站与账号管理', '连接主站，自动获取 Sub2API 上游账号与 API 配置。'],
  balances: ['余额监控', '定时查询上游账户余额，余额不足、认证失效和采集失败时在告警中心提醒。'],
  'key-monitors': ['API Key 监控', '持续监控 Key 的可用状态与余额，异常时及时提醒。'],
  mcp: ['MCP 开放平台', '连接你的 AI 客户端，安全读取真实运营数据。'],
  detail: ['站点详情', '能力、运行状态与同步轨迹。'],
  models: ['模型监控', '从 Token 用量到性能，了解每个模型的真实表现。'],
  calculator: ['Token 计费计算器', '精确计算采购、销售与利润。此页面的结果均为模拟估算。'],
  profit: ['成本与利润分析', '分清实际账单、固定摊销与估算，让每笔成本有据可查。'],
  prices: ['模型价格管理', '采购与销售价格独立配置，历史版本永久保留。'],
  costs: ['订阅与充值成本', '管理固定订阅与预付款，按实际消费确认成本。'],
  compare: ['中转站对比', '相同模型、相同 Token 数量，比较价格与观测性能。'],
  alerts: ['告警中心', '关注需要处理的变化，让重复通知保持安静。'],
  settings: ['系统设置', '汇率、数据关联、安全与审计。'],
};
const number = (x: any) =>
  x == null
    ? '—'
    : new Intl.NumberFormat('zh-CN', {
        maximumFractionDigits: 2,
        notation: Number(x) >= 1e7 ? 'compact' : 'standard',
      }).format(Number(x));
const money = (x: any, currency = 'USD') =>
  x == null
    ? '待核算'
    : new Intl.NumberFormat('zh-CN', {
        style: 'currency',
        currency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 6,
      }).format(Number(x));
const time = (x: any) => (x ? new Date(x).toLocaleString('zh-CN', { hour12: false }) : '尚未同步');
const labels: Record<string, string> = {
  key: 'API Key 监控',
  online: '正常',
  degraded: '部分可用',
  offline: '离线',
  pending: '待连接',
  error: '同步异常',
  unauthorized: '认证失效',
  supported: '支持',
  unsupported: '接口缺失',
  forbidden: '权限不足',
  not_applicable: '不适用',
  unavailable: '数据不可用',
  rate_limited: '远端限流',
  sales: '销售站',
  cost: '采购站',
  observe: '仅观测',
  token: '按 Token',
  subscription: '固定订阅',
  prepaid: '余额预付',
  admin_key: '管理员密钥',
  admin_jwt: '管理员 JWT',
  user_jwt: '用户 JWT',
  api_key: '模型 API Key',
  balance: '余额查询',
  tokens: 'Token 统计',
  logs: '使用日志',
  models: '模型列表',
  prices: '价格目录',
  accounts: '上游账号',
  realtime: '实时监控',
  billing: '计费倍率',
  completed: '已完成',
  failed: '失败',
  running: '进行中',
  interrupted: '已中断',
  revenue: '额外销售收入',
  consumption: '额外消费成本',
  other: '其他费用',
  offline_rule: '站点不可用',
  auth: '认证失效',
  failure: '失败率',
  latency: '响应延迟',
  token_spike: 'Token 突增',
  budget: '单日支出',
  negative_margin: '估算负毛利',
  expiry: '订阅到期',
  sync: '同步失败',
};
function Status({ value }: { value: string }) {
  return (
    <Badge
      tone={
        ['online', 'supported', 'completed'].includes(value)
          ? 'good'
          : ['offline', 'error', 'failed', 'unauthorized'].includes(value)
            ? 'bad'
            : ['degraded', 'rate_limited', 'forbidden'].includes(value)
              ? 'warn'
              : 'neutral'
      }
    >
      {labels[value] ?? value}
    </Badge>
  );
}
function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
function Metric({
  label,
  value,
  description,
  icon: Icon = Activity,
}: {
  label: string;
  value: ReactNode;
  description: string;
  icon?: typeof Activity;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        <Tip text={description} />
        <Icon size={16} />
      </div>
      <strong>{value}</strong>
      <p>{description}</p>
    </div>
  );
}
function Login({ onLogin }: { onLogin: () => void }) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="login">
      <div className="login-art">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={22} />
          </div>
          <span>
            relay<span className="brand-thin"> / observatory</span>
          </span>
        </div>
        <div>
          <span className="eyebrow">YOUR GATEWAY TO CLARITY</span>
          <h1>
            每一次调用，
            <br />
            都心中有数。
          </h1>
          <p>
            多个中转站。一个清晰的视野。
            <br />
            统一监控模型、用量与每一笔成本。
          </p>
          <div className="login-lines">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </div>
        <span className="muted">SUB2API OPERATIONS WORKSPACE</span>
      </div>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          const data = new FormData(e.currentTarget);
          try {
            await api('/login', Object.fromEntries(data));
            onLogin();
          } catch (err) {
            setError((err as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <ShieldCheck size={28} />
        <h2>登录观测台</h2>
        <p>使用本系统管理员账户继续</p>
        <label>
          用户名
          <input name="username" autoComplete="username" required defaultValue="admin" />
        </label>
        <label>
          密码
          <input name="password" type="password" autoComplete="current-password" required />
        </label>
        {error && <div className="error-box">{error}</div>}
        <Button disabled={busy}>
          {busy ? '验证中…' : '进入工作区'}
          <ArrowRight size={16} />
        </Button>
        <small>首次使用请运行 pnpm setup，并读取 .env 中的密码。</small>
      </form>
    </div>
  );
}
export default function App() {
  const [auth, setAuth] = useState<boolean | null>(null),
    [state, setState] = useState<any>(null),
    [page, setPage] = useState<Page>('overview'),
    [selected, setSelected] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [loading, setLoading] = useState(false),
    [mobile, setMobile] = useState(false),
    [dark, setDark] = useState(localStorage.getItem('theme') === 'dark');
  const [period, setPeriod] = useState('today'),
    [from, setFrom] = useState(''),
    [to, setTo] = useState(''),
    [stationFilter, setStationFilter] = useState('');
  const [refreshing, setRefreshing] = useState<string[]>([]);
  const [modal, setModal] = useState<{
    title: string;
    description?: string;
    fields: Field[];
    submit: (values: Record<string, string>) => Promise<void | boolean>;
  } | null>(null);
  const timezone = state?.timezone ?? 'Asia/Shanghai',
    today = dayIn(new Date(), timezone);
  const query = useMemo(() => {
    const q = new URLSearchParams(periodRange(period, timezone, from, to));
    if (stationFilter) q.set('stationId', stationFilter);
    return q.toString();
  }, [period, from, to, stationFilter, timezone, today]);
  const load = async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setState(await api('/state?' + query));
      setError('');
    } catch (err) {
      if ((err as any).status === 401) setAuth(false);
      else setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    api('/me')
      .then(() => setAuth(true))
      .catch(() => setAuth(false));
  }, []);
  useEffect(() => {
    if (auth) {
      void load();
      const timer = setInterval(() => void load(true), 10000);
      return () => clearInterval(timer);
    }
  }, [auth, query]);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('theme', dark ? 'dark' : 'light');
  }, [dark]);
  useEffect(() => {
    if (notice) {
      const timer = setTimeout(() => setNotice(''), 5000);
      return () => clearTimeout(timer);
    }
  }, [notice]);
  const navigate = (p: Page) => {
    setPage(p);
    setMobile(false);
  };
  const act = async (path: string, body?: unknown, method?: string) => {
    const r = await api(path, body, method);
    setNotice(r.message ?? '已保存');
    await load(true);
    return r;
  };
  const refreshStation = async (id: string) => {
    setNotice('');
    setError('');
    setRefreshing((ids) => (ids.includes(id) ? ids : [...ids, id]));
    let failure = '';
    try {
      await api(`/stations/${id}/sync`, { wait: true });
    } catch (e) {
      failure = (e as Error).message;
    } finally {
      await load(true);
      if (failure) setError(failure);
      setRefreshing((ids) => ids.filter((value) => value !== id));
    }
  };
  const openForm = (
    title: string,
    fields: Field[],
    path: string,
    transform: (v: Record<string, string>) => any = (x) => x,
    description?: string,
  ) =>
    setModal({
      title,
      fields,
      description,
      submit: async (x) => {
        await act(path, transform(x));
      },
    });
  const stations = state?.stations ?? [],
    stationOptions = stations.map((s: any) => ({ value: s.id, label: s.name }));
  const stationName = (id: string) => stations.find((s: any) => s.id === id)?.name ?? '站点已移除';
  const stationField: Field = { name: 'stationId', label: '所属中转站', options: stationOptions };
  const currencyField: Field = {
    name: 'currency',
    label: '币种',
    options: ['USD', 'CNY', 'EUR', 'AED'].map((value) => ({ value, label: value })),
  };
  const mainStation = stations.find((st: any) => st.kind === 'self');
  const thirdPartyStations = stations.filter((st: any) => st.kind === 'third_party');
  const mainStationOptions = mainStation
    ? [{ value: mainStation.id, label: mainStation.name }]
    : [];
  const thirdPartyOptions = thirdPartyStations.map((st: any) => ({ value: st.id, label: st.name }));
  function addStation(kind: 'self' = 'self') {
    if (mainStation) {
      navigate('stations');
      return;
    }
    openForm(
      '配置主中转站',
      [
        { name: 'name', label: '站点名称' },
        {
          name: 'baseUrl',
          label: '站点根地址',
          type: 'url',
          hint: '例如 https://relay.example.com；不要包含 /v1',
        },
        {
          name: 'authType',
          label: '认证方式',
          options: ['admin_key', 'admin_jwt'].map((value) => ({
            value,
            label: labels[value],
          })),
        },
        {
          name: 'costMode',
          label: '成本模式',
          options: ['token', 'subscription', 'prepaid'].map((value) => ({
            value,
            label: labels[value],
          })),
        },
        currencyField,
        {
          name: 'credential',
          label: '密钥 / JWT',
          type: 'password',
          hint: '填写主站管理员 Key 或 JWT，仅在后端加密保存',
        },
        { name: 'notes', label: '备注', type: 'textarea', required: false },
      ],
      '/stations',
      (x) => ({ ...x, kind }),
      '配置自己的 Sub2API 主站，上游账号直接从账号管理模块读取。',
    );
  }
  function addBalanceMonitor() {
    openForm(
      '添加余额监控',
      [
        { name: 'name', label: '站点名称', value: 'F-AI Hub' },
        { name: 'baseUrl', label: '站点根地址', type: 'url', value: 'https://api.f-api.site' },
        {
          name: 'authType',
          label: '认证方式',
          value: 'api_key',
          options: [
            { value: 'api_key', label: '模型 API Key（F-AI Hub 已验证）' },
            { value: 'user_jwt', label: '网页登录 JWT' },
          ],
        },
        {
          name: 'credential',
          label: 'API Key / JWT',
          type: 'password',
          hint: '后端加密保存；JWT 失效时需替换凭证。',
        },
        {
          name: 'balanceThreshold',
          label: '低余额提醒阈值',
          value: '10',
          hint: '余额低于此金额时触发告警；同类告警每小时最多一次。',
        },
        currencyField,
      ],
      '/stations',
      (x) => ({ ...x, kind: 'third_party', costMode: 'prepaid' }),
      `保存后立即采集，此后每 ${state?.syncIntervalSeconds ?? 300} 秒自动查询。在告警中心查看提醒。`,
    );
  }
  function addPrice(prefill?: {
    stationId: string;
    model: string;
    currency: string;
    rates: Record<string, string | null>;
  }) {
    const fields: Field[] = [
      { ...stationField, value: prefill?.stationId },
      { name: 'model', label: '模型标识', value: prefill?.model },
      { ...currencyField, value: prefill?.currency },
      { name: 'multiplier', label: '计费倍率', value: '1' },
      {
        name: 'effectiveAt',
        label: '生效时间',
        type: 'datetime-local',
        value: new Date(Date.now() - new Date().getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16),
      },
    ];
    for (const side of ['buy', 'sell'])
      for (const [key, label] of Object.entries({
        input: '输入',
        output: '输出',
        cacheRead: '缓存读取',
        cacheCreation: '缓存创建',
      }))
        fields.push({
          name: side + '_' + key,
          label: `${side === 'buy' ? '采购' : '销售'} · ${label} / 百万 Token`,
          value: prefill ? (prefill.rates[key] ?? '') : '0',
        });
    openForm(
      '新增价格版本',
      fields,
      '/prices',
      (x) => ({
        stationId: x.stationId,
        model: x.model,
        currency: x.currency,
        multiplier: x.multiplier,
        effectiveAt: new Date(x.effectiveAt).toISOString(),
        buy: Object.fromEntries(
          ['input', 'output', 'cacheRead', 'cacheCreation'].map((k) => [k, x['buy_' + k]]),
        ),
        sell: Object.fromEntries(
          ['input', 'output', 'cacheRead', 'cacheCreation'].map((k) => [k, x['sell_' + k]]),
        ),
      }),
      '历史用量绑定采集时的价格版本；新增价格不会重算历史账单。',
    );
  }
  if (auth === null)
    return (
      <div className="boot">
        <Activity className="spin" />
        正在打开观测台…
      </div>
    );
  if (!auth) return <Login onLogin={() => setAuth(true)} />;
  const r = state?.report,
    s = r?.summary,
    usd = r?.finances.find((f: any) => f.currency === 'USD');
  const stationColumns = [
    {
      key: 'name',
      label: '中转站',
      render: (st: any) => (
        <button
          className="station-link"
          onClick={() => {
            setSelected(st.id);
            navigate('detail');
          }}
        >
          <span className="station-avatar">{st.name.slice(0, 1).toUpperCase()}</span>
          <span>
            <b>{st.name}</b>
            <small>{st.baseUrl}</small>
          </span>
        </button>
      ),
    },
    {
      key: 'kind',
      label: '站点类型',
      render: (st: any) => (
        <Badge tone={st.kind === 'self' ? 'good' : 'neutral'}>
          {st.kind === 'self' ? '主中转站' : '第三方中转站'}
        </Badge>
      ),
    },
    { key: 'status', label: '运行状态', render: (st: any) => <Status value={st.status} /> },
    { key: 'authType', label: '接入身份', render: (st: any) => labels[st.authType] },
    {
      key: 'latency',
      label: '接口响应延迟',
      render: (st: any) => (st.latency != null ? `${number(st.latency)} ms` : '—'),
    },
    {
      key: 'balance',
      label: '当前余额',
      render: (st: any) =>
        st.snapshot?.balance != null
          ? money(st.snapshot.balance, st.snapshot.unit === 'USD' ? 'USD' : st.currency)
          : st.snapshot?.remaining != null
            ? `${number(st.snapshot.remaining)} ${st.snapshot.unit ?? ''}`
            : '数据不可用',
    },
    {
      key: 'lastSync',
      label: '最近同步',
      render: (st: any) => <span className="muted">{time(st.lastSync)}</span>,
    },
    {
      key: 'action',
      label: '操作',
      render: (st: any) => (
        <Button
          variant="outline"
          disabled={refreshing.includes(st.id)}
          onClick={() => void refreshStation(st.id)}
        >
          <RefreshCw size={13} />
          {refreshing.includes(st.id) ? '刷新中…' : '测试 / 同步'}
        </Button>
      ),
    },
  ];
  let content: ReactNode;
  if (!state)
    content = error ? (
      <Empty
        title="暂时无法加载"
        description={error}
        action={<Button onClick={() => void load()}>重试</Button>}
      />
    ) : (
      <div className="skeleton-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div className="skeleton" key={i} />
        ))}
      </div>
    );
  else
    switch (page) {
      case 'balances': {
        const monitors = thirdPartyStations;
        const openAlerts = state.alerts.filter(
          (a: any) =>
            a.status === 'open' &&
            ['balance', 'auth', 'sync'].includes(a.type) &&
            monitors.some((m: any) => m.id === a.stationId),
        );
        const available = monitors.filter(
          (m: any) =>
            m.status !== 'error' &&
            m.capabilities.some((c: any) => c.name === 'balance' && c.status === 'supported') &&
            m.snapshot?.balance != null,
        );
        content = (
          <>
            <div className="info-strip">
              <Activity size={17} />
              <span>
                后台每 {state.syncIntervalSeconds ?? 300} 秒采集 · 页面每 10 秒刷新 ·
                后台服务运行时持续监控
              </span>
            </div>
            <div className="metrics-grid">
              <Metric
                label="监控站点"
                value={monitors.length}
                description="第三方账户余额"
                icon={Wallet}
              />
              <Metric
                label="余额可用"
                value={available.length}
                description="最近一次采集成功"
                icon={Check}
              />
              <Metric
                label="待处理提醒"
                value={openAlerts.length}
                description="低余额、认证失效及采集失败"
                icon={Bell}
              />
            </div>
            <Panel
              title="账户余额"
              subtitle="金额来自远端只读接口，采集失败时显示具体状态。"
              action={
                <Button onClick={addBalanceMonitor}>
                  <Plus size={15} />
                  添加余额监控
                </Button>
              }
            >
              <Table
                rows={monitors}
                empty="尚未添加余额监控"
                emptyDescription="添加站点 API Key 或用户 JWT，配置余额阈值后即可开始。"
                columns={[
                  stationColumns[0],
                  {
                    key: 'balance',
                    label: '当前余额',
                    render: (st: any) => {
                      const cap = st.capabilities.find((c: any) => c.name === 'balance');
                      return st.status === 'error' ? (
                        <Status value="error" />
                      ) : cap?.status === 'supported' ? (
                        st.snapshot?.balance != null ? (
                          money(st.snapshot.balance, st.currency)
                        ) : st.snapshot?.remaining != null ? (
                          `${number(st.snapshot.remaining)} ${st.snapshot.unit ?? ''}`
                        ) : (
                          '数据不可用'
                        )
                      ) : (
                        <Status value={cap?.status ?? 'pending'} />
                      );
                    },
                  },
                  {
                    key: 'threshold',
                    label: '提醒阈值',
                    render: (st: any) => {
                      const rule = state.rules.find(
                        (r: any) => r.stationId === st.id && r.type === 'balance',
                      );
                      return rule
                        ? `${money(rule.threshold, st.currency)}${rule.enabled ? '' : '（已停用）'}`
                        : '未配置';
                    },
                  },
                  { key: 'lastSync', label: '最近采集', render: (st: any) => time(st.lastSync) },
                  {
                    key: 'action',
                    label: '操作',
                    render: (st: any) => (
                      <div className="actions">
                        <Button
                          variant="outline"
                          disabled={refreshing.includes(st.id)}
                          onClick={() => void refreshStation(st.id)}
                        >
                          <RefreshCw size={13} />
                          {refreshing.includes(st.id) ? '刷新中…' : '立即刷新'}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            const rule = state.rules.find(
                              (r: any) => r.stationId === st.id && r.type === 'balance',
                            );
                            setModal({
                              title: '设置余额提醒',
                              fields: [
                                {
                                  name: 'threshold',
                                  label: `低余额阈值（${st.currency}）`,
                                  value: rule?.threshold ?? '10',
                                },
                                {
                                  name: 'cooldown',
                                  label: '提醒间隔（秒）',
                                  type: 'number',
                                  value: String(rule?.cooldown ?? 3600),
                                },
                              ],
                              submit: async (x) => {
                                await act(
                                  rule ? `/alert-rules/${rule.id}` : '/alert-rules',
                                  {
                                    ...x,
                                    cooldown: Number(x.cooldown),
                                    ...(rule
                                      ? {}
                                      : { stationId: st.id, type: 'balance', enabled: true }),
                                  },
                                  rule ? 'PATCH' : 'POST',
                                );
                              },
                            });
                          }}
                        >
                          提醒设置
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() => {
                            setSelected(st.id);
                            navigate('detail');
                          }}
                        >
                          配置 / 凭证
                        </Button>
                      </div>
                    ),
                  },
                ]}
              />
            </Panel>
            <Panel
              title="最近提醒"
              action={
                <Button variant="outline" onClick={() => navigate('alerts')}>
                  管理告警规则
                </Button>
              }
            >
              <Table
                rows={openAlerts}
                empty="暂无待处理提醒"
                emptyDescription="低余额或采集异常时会自动出现在这里。"
                columns={[
                  { key: 'createdAt', label: '时间', render: (a: any) => time(a.createdAt) },
                  { key: 'message', label: '提醒内容' },
                  {
                    key: 'action',
                    label: '处理',
                    render: (a: any) => (
                      <Button variant="outline" onClick={() => act(`/alerts/${a.id}`, {}, 'PATCH')}>
                        确认处理
                      </Button>
                    ),
                  },
                ]}
              />
            </Panel>
          </>
        );
        break;
      }
      case 'key-monitors':
        content = <KeyMonitors stations={stations} />;
        break;
      case 'mcp':
        content = <McpPlatform />;
        break;
      case 'overview':
        content = (
          <>
            <div className="section-kicker">
              <span>
                <i className="live-dot" />
                运营概览{' '}
                <span className="muted">/ {stations.length ? '真实采集数据' : '等待接入数据'}</span>
              </span>
              <span className="muted">{state.timezone} · 每 10 秒刷新视图</span>
            </div>
            <div className="metrics-grid">
              <Metric
                label="已连接中转站"
                value={
                  <>
                    {s.connected}
                    <em>/ {s.stations}</em>
                  </>
                }
                description={`${s.healthy} 个站点已支持能力正常`}
                icon={Server}
              />
              <Metric
                label="请求总量"
                value={number(s.requests)}
                description="全部站点时仅统计主中转站用量"
                icon={ArrowUpRight}
              />
              <Metric
                label="Token 总消耗"
                value={number(s.totalTokens)}
                description="输入 + 输出 + 缓存读取 + 缓存创建"
                icon={Layers}
              />
              <Metric
                label="实际消费 · USD"
                value={money(s.consumption)}
                description="接口实际扣费，不含充值流水"
                icon={CreditCard}
              />
            </div>
            <div className="overview-finance">
              <div>
                <span>
                  实际销售收入 <Tip text="销售站的实际消费账单，加额外收入流水；各币种分账。" />
                </span>
                <strong>{money(usd?.revenue)}</strong>
              </div>
              <div>
                <span>已知采购及固定成本</span>
                <strong>{money(usd?.cost)}</strong>
              </div>
              <div>
                <span>
                  实际净收益 <Tip text="缺少请求成本关联时保持待核算，不把已知差额当作利润。" />
                </span>
                <strong>{money(usd?.profit)}</strong>
              </div>
              <div>
                <span>待核算记录</span>
                <strong>
                  {number(s.pending)}
                  <small> 条</small>
                </strong>
              </div>
              <button className="text-button" onClick={() => navigate('profit')}>
                查看核算 <ArrowRight size={15} />
              </button>
            </div>
            <div className="chart-grid">
              <Panel
                title="请求与 Token 趋势"
                subtitle="所选时间范围内的真实用量"
                action={<Badge>按日汇总</Badge>}
              >
                {r.trend.length ? (
                  <div className="chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <AreaChart data={r.trend}>
                        <defs>
                          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#7c8b83" stopOpacity={0.23} />
                            <stop offset="100%" stopColor="#7c8b83" stopOpacity={0} />
                          </linearGradient>
                        </defs>
                        <CartesianGrid
                          strokeDasharray="3 5"
                          vertical={false}
                          stroke="var(--line)"
                        />
                        <XAxis
                          dataKey="day"
                          tickFormatter={(x) => x.slice(5)}
                          tickLine={false}
                          axisLine={false}
                          fontSize={11}
                        />
                        <YAxis tickLine={false} axisLine={false} fontSize={11} />
                        <YAxis yAxisId="tokens" orientation="right" hide />
                        <Tooltip
                          contentStyle={{
                            background: 'var(--panel)',
                            border: '1px solid var(--line)',
                            borderRadius: 8,
                          }}
                        />
                        <Area
                          type="monotone"
                          dataKey="requests"
                          name="请求次数"
                          stroke="#6c8075"
                          fill="url(#fill)"
                          strokeWidth={2}
                        />
                        <Area
                          yAxisId="tokens"
                          type="monotone"
                          dataKey="totalTokens"
                          name="Token 总量"
                          stroke="#a8adb1"
                          fill="transparent"
                          strokeWidth={1.5}
                        />
                      </AreaChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <Empty
                    title={mainStation ? '所选日期暂无使用记录' : '开始观测你的 API 业务'}
                    description={
                      mainStation
                        ? '可切换日期或同步主站数据；未来日期不会产生历史用量。'
                        : '接入 Sub2API 主站，即可查看请求、Token 与成本趋势。'
                    }
                    action={
                      <Button variant="outline" onClick={() => addStation()}>
                        <Plus size={15} />
                        {mainStation ? '查看主站与账号' : '配置主中转站'}
                      </Button>
                    }
                  />
                )}
              </Panel>
              <Panel title="模型用量分布" subtitle="按所选范围的请求次数">
                {r.models.length ? (
                  <div className="chart">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={r.models.slice(0, 6)} layout="vertical">
                        <XAxis type="number" hide />
                        <YAxis
                          type="category"
                          dataKey="model"
                          width={130}
                          fontSize={11}
                          tickLine={false}
                          axisLine={false}
                        />
                        <Tooltip />
                        <Bar
                          dataKey="requests"
                          name="请求数"
                          fill="#7a8b81"
                          radius={[0, 4, 4, 0]}
                        />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <Empty title="暂无模型用量" description="同步后展示模型的真实请求分布。" />
                )}
              </Panel>
            </div>
            <Panel
              title="站点运行状态"
              subtitle="统一管理接入身份与可观测能力"
              action={
                <Button variant="ghost" onClick={() => navigate('stations')}>
                  全部站点 <ArrowRight size={14} />
                </Button>
              }
            >
              <Table columns={stationColumns} rows={stations} searchable={false} />
            </Panel>
            <div className="small-metrics">
              <span>
                <ShieldCheck size={15} /> 凭证在服务端加密
              </span>
              <span>
                请求成功率{' '}
                <b>{s.successRate == null ? '数据不可用' : number(s.successRate) + '%'}</b>
              </span>
              <span>
                当前告警 <b>{s.alerts}</b>
              </span>
              <span>
                未关联上游记录 <b>{s.unlinked}</b>
                <Tip text={r.scope} />
              </span>
            </div>
          </>
        );
        break;
      case 'stations':
        content = (
          <>
            <div className="info-strip">
              <ShieldCheck size={17} />
              <span>只需连接自己的 Sub2API 主站，上游账号和 API 配置直接从账号管理模块读取。</span>
            </div>
            <Panel
              title="主中转站 · 自己的中转"
              subtitle="全系统最多一个，使用管理员密钥或管理员 JWT 接入"
              action={
                !mainStation ? (
                  <Button onClick={() => addStation('self')}>
                    <Plus size={15} />
                    配置主中转站
                  </Button>
                ) : (
                  <Badge tone="good">已配置 1 / 1</Badge>
                )
              }
            >
              {mainStation ? (
                <Table columns={stationColumns} rows={[mainStation]} searchable={false} />
              ) : (
                <Empty
                  title="尚未配置主中转站"
                  description="添加你自己运营的 Sub2API，作为用量、销售收入与利润核算的主站。"
                  action={
                    <Button variant="outline" onClick={() => addStation('self')}>
                      配置主中转站
                    </Button>
                  }
                />
              )}
            </Panel>
            <UpstreamAccounts configured={!!mainStation} />
            {thirdPartyStations.length > 0 && (
              <details className="panel legacy-stations">
                <summary>余额监控及手动接入站点 · {thirdPartyStations.length}</summary>
                <Table columns={stationColumns} rows={thirdPartyStations} />
              </details>
            )}
          </>
        );
        break;
      case 'detail': {
        const st = stations.find((x: any) => x.id === selected);
        content = st ? (
          <>
            <button className="text-button" onClick={() => navigate('stations')}>
              ← 返回中转站
            </button>
            <div className="detail-summary">
              <div className="station-avatar large">{st.name.slice(0, 1)}</div>
              <div>
                <h2>
                  {st.name} <Badge>{st.kind === 'self' ? '主中转站' : '第三方中转站'}</Badge>
                  <Status value={st.status} />
                </h2>
                <p>{st.baseUrl}</p>
              </div>
              <div className="push-right">
                <Button
                  variant="outline"
                  onClick={() =>
                    setModal({
                      title: '编辑站点',
                      fields: [
                        { name: 'name', label: '站点名称', value: st.name },
                        {
                          name: 'notes',
                          label: '备注',
                          type: 'textarea',
                          value: st.notes,
                          required: false,
                        },
                        {
                          name: 'credential',
                          label: '替换凭证（留空保留）',
                          type: 'password',
                          required: false,
                        },
                      ],
                      submit: async (values) => {
                        if (!values.credential) delete values.credential;
                        await act(`/stations/${st.id}`, values, 'PATCH');
                      },
                    })
                  }
                >
                  编辑配置
                </Button>
                <Button
                  disabled={refreshing.includes(st.id)}
                  onClick={() => void refreshStation(st.id)}
                >
                  <RefreshCw size={14} />
                  {refreshing.includes(st.id) ? '刷新中…' : '测试连接与同步'}
                </Button>
              </div>
            </div>
            <div className="metrics-grid">
              <Metric
                label="认证身份"
                value={labels[st.authType]}
                description={`后端凭证 ${st.credential}`}
              />
              <Metric
                label="模型数量"
                value={
                  state.models.filter((m: any) => m.stationId === st.id).length || '数据不可用'
                }
                description="来自模型列表或实际用量"
              />
              <Metric
                label="计费模式"
                value={labels[st.costMode]}
                description={`${st.kind === 'self' ? '主站销售核算' : '第三方采购核算'} · ${st.currency}`}
              />
              <Metric
                label="版本识别"
                value={st.version ?? '未提供'}
                description="不使用不可靠响应猜测版本号"
              />
            </div>
            <Panel title="API 能力检测" subtitle="401 认证失效 · 403 权限不足 · 404 接口缺失">
              <div className="cap-grid">
                {st.capabilities.length ? (
                  st.capabilities.map((c: any) => (
                    <div className="cap" key={c.id}>
                      <div>
                        <b>{labels[c.name]}</b>
                        <Status value={c.status} />
                      </div>
                      <p>
                        {c.message}
                        {c.httpStatus ? ` · HTTP ${c.httpStatus}` : ''}
                      </p>
                    </div>
                  ))
                ) : (
                  <Empty title="尚未检测" description="点击测试连接以获取实际能力。" />
                )}
              </div>
            </Panel>
            <div className="two-grid">
              <Panel title="账号状态（仅安全字段）">
                <Table
                  columns={[
                    { key: 'name', label: '账号' },
                    { key: 'status', label: '状态' },
                    {
                      key: 'schedulable',
                      label: '可调度',
                      render: (a: any) =>
                        a.schedulable === true
                          ? '是'
                          : a.schedulable === false
                            ? '否'
                            : '数据不可用',
                    },
                  ]}
                  rows={st.snapshot?.accounts ?? []}
                />
              </Panel>
              <Panel title="采集与计费信息">
                <div className="key-values">
                  <p>
                    <span>最近同步</span>
                    <b>{time(st.lastSync)}</b>
                  </p>
                  <p>
                    <span>同步检查点</span>
                    <b>{time(st.checkpoint)}</b>
                  </p>
                  <p>
                    <span>当前余额</span>
                    <b>
                      {st.snapshot?.balance != null ? money(st.snapshot.balance) : '数据不可用'}
                    </b>
                  </p>
                  <p>
                    <span>已消耗额度</span>
                    <b>{number(st.snapshot?.quota?.used)}</b>
                  </p>
                  <p>
                    <span>剩余额度</span>
                    <b>{number(st.snapshot?.quota?.remaining)}</b>
                  </p>
                  <p>
                    <span>当前计费倍率</span>
                    <b>{number(st.snapshot?.billing?.effectiveMultiplier)}</b>
                  </p>
                  <p>
                    <span>备注</span>
                    <b>{st.notes || '—'}</b>
                  </p>
                </div>
              </Panel>
            </div>
            <Panel title="同步任务">
              <Table
                columns={[
                  { key: 'startedAt', label: '开始时间', render: (x) => time(x.startedAt) },
                  { key: 'status', label: '状态', render: (x) => <Status value={x.status} /> },
                  { key: 'count', label: '新增记录' },
                  { key: 'message', label: '结果' },
                ]}
                rows={state.jobs.filter((j: any) => j.stationId === st.id)}
              />
            </Panel>
          </>
        ) : (
          <Empty
            title="请选择站点"
            action={<Button onClick={() => navigate('stations')}>查看站点</Button>}
          />
        );
        break;
      }
      case 'models':
        content = (
          <Panel title="模型使用统计" subtitle="只展示受支持的指标；成功率需具备完整请求结果数据">
            <Table
              rows={r.models}
              columns={[
                { key: 'model', label: '模型' },
                { key: 'requests', label: '请求数', render: (x) => number(x.requests) },
                ...['input', 'output', 'cacheRead', 'cacheCreation', 'totalTokens'].map(
                  (key, i) => ({
                    key,
                    label: ['输入 Token', '输出 Token', '缓存读取', '缓存创建', '总 Token'][i],
                    render: (x: any) => number(x[key]),
                  }),
                ),
                {
                  key: 'averageLatency',
                  label: '平均延迟',
                  render: (x) =>
                    x.averageLatency == null ? '数据不可用' : `${number(x.averageLatency)} ms`,
                },
                {
                  key: 'firstToken',
                  label: '首 Token',
                  render: (x) =>
                    x.firstToken == null ? '数据不可用' : `${number(x.firstToken)} ms`,
                },
                {
                  key: 'successRate',
                  label: '成功率',
                  render: (x) =>
                    x.successRate == null ? '数据不可用' : `${number(x.successRate)}%`,
                },
                { key: 'consumption', label: '实际消费 USD', render: (x) => money(x.consumption) },
                {
                  key: 'actualPurchaseCost',
                  label: '实际采购 USD',
                  render: (x) => money(x.actualPurchaseCost),
                },
                { key: 'grossProfit', label: '模型毛利 USD', render: (x) => money(x.grossProfit) },
                {
                  key: 'estimates',
                  label: '独立模拟估算',
                  render: (x) =>
                    x.estimates.length
                      ? x.estimates
                          .map(
                            (e: any) =>
                              `${e.currency}：成本 ${e.cost} / 利润 ${e.profit}（${e.records} 条）`,
                          )
                          .join('；')
                      : '未配置',
                },
              ]}
            />
          </Panel>
        );
        break;
      case 'calculator':
        content = <CalculatorPage state={state} />;
        break;
      case 'profit':
        content = (
          <>
            <div className="info-strip">
              <Database size={17} />
              <span>{r.scope}</span>
            </div>
            <div className="metrics-grid">
              <Metric label="待核算记录" value={s.pending} description="实际成本或销售账单缺失" />
              <Metric
                label="未关联上游记录"
                value={s.unlinked}
                description="不自动推断，不并入全局用量"
              />
              <Metric
                label="已确认请求关联"
                value={state.correlations.length}
                description="可靠上游请求 ID 或人工证据"
              />
              <Metric
                label="核算口径"
                value="实际 / 分币种"
                description="预充值不确认收入，充值不确认成本"
              />
            </div>
            <Panel title="实际核算" subtitle="已知差额仅供核对；存在待核算记录时不展示完整净利润">
              <Table
                rows={r.finances}
                columns={[
                  { key: 'currency', label: '币种' },
                  {
                    key: 'revenue',
                    label: '确认收入',
                    render: (x) => money(x.revenue, x.currency),
                  },
                  {
                    key: 'consumption',
                    label: '实际消费成本',
                    render: (x) => money(x.consumption, x.currency),
                  },
                  {
                    key: 'amortization',
                    label: '固定订阅摊销',
                    render: (x) => money(x.amortization, x.currency),
                  },
                  { key: 'other', label: '其他费用', render: (x) => money(x.other, x.currency) },
                  {
                    key: 'knownDifference',
                    label: '已知差额',
                    render: (x) => money(x.knownDifference, x.currency),
                  },
                  { key: 'profit', label: '净利润', render: (x) => money(x.profit, x.currency) },
                  {
                    key: 'margin',
                    label: '净利率',
                    render: (x) => (x.margin == null ? '待核算' : `${number(x.margin)}%`),
                  },
                  {
                    key: 'markup',
                    label: '成本加成率',
                    render: (x) => (x.markup == null ? '待核算' : `${number(x.markup)}%`),
                  },
                ]}
              />
            </Panel>
            <Panel
              title="额外财务流水"
              subtitle="仅录入未被同步账单覆盖的金额，避免重复记账"
              action={
                <Button
                  variant="outline"
                  onClick={() =>
                    openForm(
                      '录入额外流水',
                      [
                        stationField,
                        {
                          name: 'kind',
                          label: '流水类型',
                          options: ['revenue', 'consumption', 'other'].map((value) => ({
                            value,
                            label: labels[value],
                          })),
                        },
                        { name: 'amount', label: '金额' },
                        currencyField,
                        { name: 'occurredAt', label: '发生时间', type: 'datetime-local' },
                        { name: 'note', label: '依据 / 备注', type: 'textarea' },
                      ],
                      '/transactions',
                      (x) => ({ ...x, occurredAt: new Date(x.occurredAt).toISOString() }),
                    )
                  }
                >
                  <Plus size={14} />
                  录入流水
                </Button>
              }
            >
              <Table
                rows={state.transactions}
                columns={[
                  { key: 'occurredAt', label: '时间', render: (x) => time(x.occurredAt) },
                  { key: 'stationId', label: '站点', render: (x) => stationName(x.stationId) },
                  { key: 'kind', label: '类型', render: (x) => labels[x.kind] },
                  { key: 'amount', label: '金额', render: (x) => money(x.amount, x.currency) },
                  { key: 'note', label: '依据' },
                ]}
              />
            </Panel>
          </>
        );
        break;
      case 'prices':
        content = (
          <>
            <div className="info-strip">
              <Tags size={17} />
              <span>
                价格按百万 Token 计价。默认目录价需确认实际倍率；长上下文、1h
                缓存、图像等特殊阶梯不自动套用。
              </span>
            </div>
            <Panel
              title="模型价格版本"
              subtitle="每次变更新增版本，历史记录保持原计价快照"
              action={
                <div className="actions">
                  <Button
                    variant="outline"
                    onClick={() =>
                      setModal({
                        title: '读取默认目录价',
                        fields: [stationField, { name: 'model', label: '模型标识' }],
                        description:
                          '需要管理员权限；读取结果仅作单价参考，请通过新增价格确认采购与销售单价。',
                        submit: async (x) => {
                          const p = await api(`/stations/${x.stationId}/import-price`, {
                            model: x.model,
                          });
                          addPrice({
                            stationId: x.stationId,
                            model: x.model,
                            currency: p.currency,
                            rates: p.rates,
                          });
                          return false;
                        },
                      })
                    }
                  >
                    读取目录价
                  </Button>
                  <Button onClick={() => addPrice()}>
                    <Plus size={14} />
                    新增价格
                  </Button>
                </div>
              }
            >
              <Table
                rows={state.prices}
                columns={[
                  { key: 'model', label: '模型' },
                  { key: 'stationId', label: '站点', render: (x) => stationName(x.stationId) },
                  { key: 'currency', label: '币种' },
                  {
                    key: 'buy',
                    label: '采购 · 输入 / 输出',
                    render: (x) => `${x.buy.input} / ${x.buy.output}`,
                  },
                  {
                    key: 'sell',
                    label: '销售 · 输入 / 输出',
                    render: (x) => `${x.sell.input} / ${x.sell.output}`,
                  },
                  {
                    key: 'cache',
                    label: '采购 · 读缓存 / 写缓存',
                    render: (x) => `${x.buy.cacheRead} / ${x.buy.cacheCreation}`,
                  },
                  { key: 'multiplier', label: '倍率' },
                  { key: 'effectiveAt', label: '生效时间', render: (x) => time(x.effectiveAt) },
                  {
                    key: 'source',
                    label: '来源',
                    render: (x) => (x.source === 'manual' ? '手动配置' : '目录导入'),
                  },
                ]}
              />
            </Panel>
          </>
        );
        break;
      case 'costs':
        content = (
          <>
            <div className="two-grid">
              <Panel
                title="固定订阅"
                subtitle="按订阅有效期逐时摊销，独立于 Token 估算"
                action={
                  <Button
                    onClick={() =>
                      openForm(
                        '新增固定订阅',
                        [
                          stationField,
                          { name: 'name', label: '账号 / 订阅名称' },
                          { name: 'amount', label: '订阅费用' },
                          { name: 'otherFees', label: '其他固定费用', value: '0' },
                          currencyField,
                          { name: 'start', label: '订阅开始时间', type: 'datetime-local' },
                          { name: 'end', label: '订阅结束时间', type: 'datetime-local' },
                          { name: 'quota', label: '订阅额度（可选）', required: false },
                          { name: 'used', label: '已使用额度（可选）', required: false },
                        ],
                        '/subscriptions',
                        (x) => ({
                          ...x,
                          start: new Date(x.start).toISOString(),
                          end: new Date(x.end).toISOString(),
                          quota: x.quota || null,
                          used: x.used || null,
                        }),
                      )
                    }
                  >
                    <Plus size={14} />
                    订阅
                  </Button>
                }
              >
                <Table
                  rows={r.subscriptions}
                  columns={[
                    { key: 'name', label: '订阅' },
                    {
                      key: 'amount',
                      label: '固定费用',
                      render: (x) => money(x.amount, x.currency),
                    },
                    {
                      key: 'allocated',
                      label: '本期摊销',
                      render: (x) => money(x.allocated, x.currency),
                    },
                    {
                      key: 'recognizedRevenue',
                      label: '本期关联收入',
                      render: (x) => money(x.recognizedRevenue, x.currency),
                    },
                    { key: 'net', label: '本期净收益', render: (x) => money(x.net, x.currency) },
                    {
                      key: 'elapsed',
                      label: '累计摊销',
                      render: (x) => money(x.elapsed, x.currency),
                    },
                    {
                      key: 'currentRevenue',
                      label: '累计关联收入',
                      render: (x) => money(x.currentRevenue, x.currency),
                    },
                    {
                      key: 'currentNet',
                      label: '累计净收益',
                      render: (x) => money(x.currentNet, x.currency),
                    },
                    {
                      key: 'contractDifference',
                      label: '累计收入减合同总费',
                      render: (x) => money(x.contractDifference, x.currency),
                    },
                    {
                      key: 'breakEven',
                      label: '回本进度',
                      render: (x) => (x.breakEven == null ? '—' : `${number(x.breakEven)}%`),
                    },
                    {
                      key: 'quotaProgress',
                      label: '额度消耗',
                      render: (x) =>
                        x.quotaProgress == null ? '未配置' : `${number(x.quotaProgress)}%`,
                    },
                    { key: 'end', label: '到期时间', render: (x) => time(x.end) },
                  ]}
                />
              </Panel>
              <Panel
                title="充值预付款"
                subtitle="充值增加余额，实际消费才确认成本"
                action={
                  <Button
                    variant="outline"
                    onClick={() =>
                      openForm(
                        '录入预付款充值',
                        [
                          stationField,
                          { name: 'amount', label: '充值金额' },
                          currencyField,
                          { name: 'occurredAt', label: '充值时间', type: 'datetime-local' },
                          { name: 'note', label: '充值依据', type: 'textarea' },
                        ],
                        '/recharges',
                        (x) => ({ ...x, occurredAt: new Date(x.occurredAt).toISOString() }),
                      )
                    }
                  >
                    <Plus size={14} />
                    充值
                  </Button>
                }
              >
                <Table
                  rows={state.recharges}
                  columns={[
                    { key: 'stationId', label: '站点', render: (x) => stationName(x.stationId) },
                    { key: 'amount', label: '预付款', render: (x) => money(x.amount, x.currency) },
                    { key: 'occurredAt', label: '时间', render: (x) => time(x.occurredAt) },
                    { key: 'note', label: '凭据' },
                  ]}
                />
              </Panel>
            </div>
            <Panel
              title="预付款对账"
              subtitle="账面余额仅覆盖系统录入的期初/充值及已采集消费，不假设为第三方真实余额"
            >
              <Table
                rows={r.prepaid}
                columns={[
                  { key: 'stationId', label: '站点', render: (x) => stationName(x.stationId) },
                  {
                    key: 'recharged',
                    label: '累计录入充值',
                    render: (x) => money(x.recharged, x.currency),
                  },
                  {
                    key: 'calculatedBalance',
                    label: '账面余额',
                    render: (x) => money(x.calculatedBalance, x.currency),
                  },
                  {
                    key: 'remoteBalance',
                    label: '远端余额',
                    render: (x) =>
                      x.remoteBalance == null ? '数据不可用' : money(x.remoteBalance, x.currency),
                  },
                  { key: 'note', label: '说明' },
                ]}
              />
            </Panel>
          </>
        );
        break;
      case 'compare':
        content = <ComparePage state={state} />;
        break;
      case 'alerts':
        content = (
          <>
            <div className="metrics-grid">
              <Metric
                label="待处理告警"
                value={s.alerts}
                description="已触发但尚未确认的站内告警"
                icon={Bell}
              />
              <Metric
                label="监控规则"
                value={state.rules.length}
                description="定时采集完成后评估"
                icon={ShieldCheck}
              />
              <Metric
                label="通知渠道"
                value="站内通知"
                description="已预留通知适配器；未连接外部机器人"
              />
              <Metric
                label="告警冷却"
                value="按规则配置"
                description="已确认告警仍遵守原冷却窗口"
              />
            </div>
            <Panel title="告警事件">
              <Table
                rows={state.alerts}
                columns={[
                  { key: 'createdAt', label: '触发时间', render: (x) => time(x.createdAt) },
                  {
                    key: 'stationId',
                    label: '监控对象',
                    render: (x) => (x.type === 'key' ? 'API Key' : stationName(x.stationId)),
                  },
                  { key: 'type', label: '规则', render: (x) => labels[x.type] ?? x.type },
                  { key: 'message', label: '详情' },
                  {
                    key: 'status',
                    label: '状态',
                    render: (x) => (
                      <Badge tone={x.status === 'open' ? 'warn' : 'neutral'}>
                        {x.status === 'open'
                          ? '待处理'
                          : x.status === 'resolved'
                            ? '已恢复 / 已停用'
                            : '已确认'}
                      </Badge>
                    ),
                  },
                  {
                    key: 'action',
                    label: '操作',
                    render: (x) =>
                      x.status === 'open' ? (
                        <Button
                          variant="outline"
                          onClick={() => act(`/alerts/${x.id}`, {}, 'PATCH')}
                        >
                          确认处理
                        </Button>
                      ) : (
                        <Check size={15} />
                      ),
                  },
                ]}
              />
            </Panel>
            <Panel
              title="告警规则"
              action={
                <Button
                  onClick={() =>
                    openForm(
                      '新增告警规则',
                      [
                        {
                          name: 'stationId',
                          label: '适用站点',
                          options: [{ value: '', label: '全部站点' }, ...stationOptions],
                        },
                        {
                          name: 'type',
                          label: '规则类型',
                          options: [
                            'offline',
                            'auth',
                            'failure',
                            'latency',
                            'balance',
                            'token_spike',
                            'budget',
                            'negative_margin',
                            'expiry',
                            'sync',
                          ].map((value) => ({ value, label: labels[value] ?? value })),
                        },
                        {
                          name: 'threshold',
                          label: '阈值',
                          value: '0',
                          hint: '延迟 ms / 失败率 % / 突增比例 % / 余额 USD / 到期天数；状态类填 0',
                        },
                        {
                          name: 'cooldown',
                          label: '冷却时间（秒）',
                          type: 'number',
                          value: '3600',
                        },
                      ],
                      '/alert-rules',
                      (x) => ({
                        ...x,
                        stationId: x.stationId || null,
                        cooldown: Number(x.cooldown),
                        enabled: true,
                      }),
                    )
                  }
                >
                  <Plus size={14} />
                  新增规则
                </Button>
              }
            >
              <Table
                rows={state.rules}
                columns={[
                  { key: 'type', label: '规则类型', render: (x) => labels[x.type] ?? x.type },
                  {
                    key: 'stationId',
                    label: '适用站点',
                    render: (x) => (x.stationId ? stationName(x.stationId) : '全部站点'),
                  },
                  { key: 'threshold', label: '阈值' },
                  { key: 'cooldown', label: '冷却（秒）' },
                  {
                    key: 'enabled',
                    label: '状态',
                    render: (x) => (
                      <Button
                        variant="outline"
                        onClick={() =>
                          act(`/alert-rules/${x.id}`, { enabled: !x.enabled }, 'PATCH')
                        }
                      >
                        {x.enabled ? '已启用 · 点击停用' : '已停用 · 点击启用'}
                      </Button>
                    ),
                  },
                ]}
              />
            </Panel>
          </>
        );
        break;
      case 'settings':
        content = (
          <>
            <div className="two-grid">
              <Panel
                title="历史汇率"
                subtitle={
                  state.fxProvider === 'open_er'
                    ? '真实日度汇率 · 保留历史版本'
                    : '手动配置真实来源；自动汇率未启用'
                }
                action={
                  <div className="actions">
                    <Button
                      variant="outline"
                      onClick={() =>
                        act('/exchange-rates/sync', {}).catch((e) => setError(e.message))
                      }
                    >
                      同步日度汇率
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        openForm(
                          '录入汇率',
                          [
                            { name: 'from', label: '原币种', options: currencyField.options },
                            {
                              name: 'to',
                              label: '目标币种',
                              options: currencyField.options,
                              value: 'CNY',
                            },
                            { name: 'rate', label: '1 原币 = 目标币金额' },
                            { name: 'effectiveAt', label: '生效时间', type: 'datetime-local' },
                            { name: 'source', label: '真实来源 / 备注' },
                          ],
                          '/exchange-rates',
                          (x) => ({ ...x, effectiveAt: new Date(x.effectiveAt).toISOString() }),
                        )
                      }
                    >
                      <Plus size={14} />
                      汇率
                    </Button>
                  </div>
                }
              >
                <Table
                  rows={state.exchangeRates}
                  columns={[
                    { key: 'from', label: '原币' },
                    { key: 'to', label: '目标币' },
                    { key: 'rate', label: '汇率' },
                    { key: 'effectiveAt', label: '生效时间', render: (x) => time(x.effectiveAt) },
                    { key: 'source', label: '来源' },
                  ]}
                />
              </Panel>
              <Panel
                title="上下游关系"
                subtitle="只配置主中转站与第三方上游的关系，请求仅按可靠标识或人工证据关联。"
                action={
                  <Button
                    variant="outline"
                    onClick={() =>
                      openForm(
                        '配置上下游',
                        [
                          {
                            name: 'downstreamId',
                            label: '主中转站',
                            options: mainStationOptions,
                          },
                          {
                            name: 'upstreamId',
                            label: '第三方上游中转站',
                            options: thirdPartyOptions,
                          },
                        ],
                        '/relations',
                      )
                    }
                  >
                    <Plus size={14} />
                    关系
                  </Button>
                }
              >
                <Table
                  rows={state.relations}
                  columns={[
                    {
                      key: 'downstreamId',
                      label: '下游',
                      render: (x) => stationName(x.downstreamId),
                    },
                    { key: 'arrow', label: '', render: () => <ArrowRight size={14} /> },
                    { key: 'upstreamId', label: '上游', render: (x) => stationName(x.upstreamId) },
                  ]}
                />
              </Panel>
            </div>
            <p className="muted source-note">
              {state.fxProvider === 'open_er' && (
                <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
                  Rates By Exchange Rate API ↗
                </a>
              )}
            </p>
            <Panel title="基础设施与后台队列" subtitle="来自当前 MySQL / Redis 实际连接与队列计数">
              <div className="metrics-grid infrastructure-metrics">
                <Metric
                  label="数据库"
                  value={state.storage.database}
                  description="持久化业务数据与事务审计"
                  icon={Database}
                />
                <Metric
                  label="在线 Worker"
                  value={state.queueStats.workers ?? 0}
                  description="Redis 中 30 秒内收到的真实心跳"
                  icon={Activity}
                />
                <Metric
                  label="排队 / 执行中"
                  value={`${state.queueStats.waiting} / ${state.queueStats.active}`}
                  description={`延迟/定时 ${state.queueStats.delayed} · 失败 ${state.queueStats.failed}`}
                  icon={RefreshCw}
                />
                <Metric
                  label="Redis 缓存命中"
                  value={number(state.queueStats.cacheHits)}
                  description={`累计未命中 ${state.queueStats.cacheMisses} · TTL ${state.storage.cacheTtlSeconds} 秒`}
                  icon={Layers}
                />
              </div>
            </Panel>
            <Panel title="运行与安全">
              <div className="settings-grid">
                <div>
                  <ShieldCheck size={22} />
                  <h3>服务端凭证保护</h3>
                  <p>AES-256-GCM 加密 · HttpOnly 会话 · 同源写入校验 · 登录限流。</p>
                </div>
                <div>
                  <Globe2 size={22} />
                  <h3>目标地址校验</h3>
                  <p>DNS 解析并固定目标 IP，禁止危险内网与重定向。可信内网由环境变量逐个允许。</p>
                </div>
                <div>
                  <Database size={22} />
                  <h3>数据与部署</h3>
                  <p>MySQL · Redis / BullMQ · {state.timezone} · 独立后台采集。</p>
                </div>
              </div>
            </Panel>
            <Panel title="财务配置审计" subtitle="保留价格、汇率、充值、订阅及人工关联的变更依据">
              <Table
                rows={state.audit}
                columns={[
                  { key: 'createdAt', label: '时间', render: (x) => time(x.createdAt) },
                  { key: 'action', label: '操作' },
                  { key: 'entityId', label: '实体 ID' },
                  {
                    key: 'details',
                    label: '变更摘要',
                    render: (x) => (
                      <span className="truncate" title={JSON.stringify(x.details)}>
                        {JSON.stringify(x.details)}
                      </span>
                    ),
                  },
                ]}
              />
            </Panel>
          </>
        );
        break;
    }
  return (
    <div className="app">
      <aside className={mobile ? 'sidebar open' : 'sidebar'}>
        <div className="brand">
          <div className="brand-mark">
            <Activity size={21} />
          </div>
          <span>
            relay<span className="brand-thin"> / obs</span>
          </span>
          <Button variant="ghost" className="mobile-close" onClick={() => setMobile(false)}>
            <X size={18} />
          </Button>
        </div>
        <div className="workspace-label">
          <span className="workspace-icon">
            <Command size={14} />
          </span>
          <div>
            <b>运营工作区</b>
            <small>Sub2API Observatory</small>
          </div>
          <Badge>LIVE</Badge>
        </div>
        <nav>
          <span className="nav-label">观测与运营</span>
          {nav.map(([id, label, Icon]) => (
            <div key={id}>
              {id === 'calculator' && <span className="nav-label">财务与核算</span>}
              {id === 'alerts' && <span className="nav-label">工作区</span>}
              <button
                onClick={() => navigate(id)}
                className={page === id || (page === 'detail' && id === 'stations') ? 'active' : ''}
              >
                <Icon size={17} />
                {label}
                {id === 'alerts' && s?.alerts > 0 && <span className="nav-count">{s.alerts}</span>}
              </button>
            </div>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="storage">
            <span>
              <i className="live-dot" />
              本地数据，独立掌控
            </span>
            <small>MySQL 持久化 · Redis 后台任务</small>
          </div>
          <button className="user" onClick={() => api('/logout', {}).then(() => setAuth(false))}>
            <span className="avatar">A</span>
            <span>
              <b>Administrator</b>
              <small>工作区管理员</small>
            </span>
            <LogOut size={15} />
          </button>
        </div>
      </aside>
      {mobile && <div className="sidebar-overlay" onClick={() => setMobile(false)} />}
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <Button variant="ghost" className="mobile-toggle" onClick={() => setMobile(true)}>
              <Menu size={18} />
            </Button>
            <span>工作区</span>
            <ChevronRight size={13} />
            <b>{titles[page][0]}</b>
          </div>
          <div className="top-actions">
            <span className="private-label">
              <ShieldCheck size={13} />
              私有工作区
            </span>
            <Button variant="ghost" aria-label="切换深色模式" onClick={() => setDark(!dark)}>
              {dark ? <Sun size={17} /> : <Moon size={17} />}
            </Button>
            <Button variant="ghost" aria-label="查看告警" onClick={() => navigate('alerts')}>
              <Bell size={17} />
              {s?.alerts > 0 && <i className="notification-dot" />}
            </Button>
            <span className="avatar small">A</span>
          </div>
        </header>
        <main>
          <div className="page-title">
            <div>
              <span className="eyebrow">RELAY OBSERVATORY</span>
              <h1>{titles[page][0]}</h1>
              <p>{titles[page][1]}</p>
            </div>
            <div className="actions">
              {page !== 'key-monitors' && (
                <Button
                  variant="outline"
                  onClick={() => {
                    if (page === 'balances')
                      void Promise.all(thirdPartyStations.map((st: any) => refreshStation(st.id)));
                    else void load();
                  }}
                  disabled={loading || refreshing.length > 0}
                >
                  <RefreshCw size={14} className={loading || refreshing.length > 0 ? 'spin' : ''} />
                  {refreshing.length > 0 ? '刷新中…' : '刷新数据'}
                </Button>
              )}
              {['overview', 'stations'].includes(page) && !mainStation && (
                <Button onClick={() => addStation()}>
                  <Plus size={15} />
                  配置主中转站
                </Button>
              )}
            </div>
          </div>
          {!['mcp', 'balances', 'key-monitors'].includes(page) && (
            <div className="global-filters">
              <div>
                <Globe2 size={14} />
                <select
                  aria-label="全局站点筛选"
                  value={stationFilter}
                  onChange={(e) => setStationFilter(e.target.value)}
                >
                  <option value="">全部中转站</option>
                  {stationOptions.map((o: any) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <select
                  aria-label="全局时间范围"
                  value={period}
                  onChange={(e) => setPeriod(e.target.value)}
                >
                  {[
                    ['today', '今天'],
                    ['yesterday', '昨天'],
                    ['dayAfterTomorrow', '后天'],
                    ['3', '3 天内'],
                    ['7', '7 天内'],
                    ['30', '最近 30 天'],
                    ['month', '本月'],
                    ['custom', '自定义范围'],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
              {period === 'custom' && (
                <>
                  <input
                    aria-label="开始日期"
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <span>至</span>
                  <input
                    aria-label="结束日期"
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </>
              )}
              <span className="filter-note">
                {stations.length
                  ? `${stations.length} 个站点 · 独立采集`
                  : '连接你的第一个中转站，开始观测'}
              </span>
            </div>
          )}
          {error && (
            <div className="error-box">
              {error}
              <Button variant="ghost" onClick={() => setError('')}>
                关闭
              </Button>
            </div>
          )}
          {page === 'overview' && (
            <div className="date-shortcuts" role="group" aria-label="总览日期快捷筛选">
              {[
                ['today', '今天'],
                ['yesterday', '昨天'],
                ['dayAfterTomorrow', '后天'],
                ['3', '3 天内'],
                ['7', '7 天内'],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={period === value}
                  className={period === value ? 'active' : ''}
                  onClick={() => setPeriod(value)}
                >
                  {label}
                </button>
              ))}
              <span>
                {period === 'dayAfterTomorrow' ? '未来日期暂无实际用量' : '按工作区时区统计自然日'}
              </span>
            </div>
          )}
          <div className="page-content">{content}</div>
          <footer className="app-footer">
            <span>
              Relay Observatory <span className="muted">/ 独立 Sub2API 运营工具</span>
            </span>
            <span>金额精确计算 · 实际与估算分账</span>
          </footer>
        </main>
      </div>
      {notice && (
        <div className="toast" role="status">
          <Check size={16} />
          {notice}
        </div>
      )}
      {modal && (
        <FormModal
          key={modal.title}
          {...modal}
          onClose={() => setModal(null)}
          onSubmit={modal.submit}
        />
      )}
    </div>
  );
}

function CalculatorPage({ state }: { state: any }) {
  const [stationId, setStationId] = useState(''),
    [priceId, setPriceId] = useState(''),
    [tokens, setTokens] = useState<Tokens>({ input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }),
    [buy, setBuy] = useState<Rates>({
      input: '0',
      output: '0',
      cacheRead: '0',
      cacheCreation: '0',
    }),
    [sell, setSell] = useState<Rates>({
      input: '0',
      output: '0',
      cacheRead: '0',
      cacheCreation: '0',
    }),
    [multiplier, setMultiplier] = useState('1'),
    [fx, setFx] = useState('1'),
    [currency, setCurrency] = useState('USD'),
    [target, setTarget] = useState('USD');
  let result: ReturnType<typeof calculate> | null = null;
  try {
    if (
      Number(fx) > 0 &&
      Number(multiplier) >= 0 &&
      Object.values(buy).every((x) => Number(x) >= 0) &&
      Object.values(sell).every((x) => Number(x) >= 0)
    )
      result = calculate(tokens, buy, sell, multiplier, fx);
  } catch {}
  const fields = {
    input: '输入 Token',
    output: '输出 Token',
    cacheRead: 'Cache Read',
    cacheCreation: 'Cache Creation',
  };
  return (
    <>
      <div className="info-strip">
        <Calculator size={17} />
        <span>模拟估算 · 输入四类互斥 Token 数；若提供商输入数已包含缓存，请先扣除缓存部分。</span>
        <Badge>DECIMAL PRECISION</Badge>
      </div>
      <div className="calculator-grid">
        <Panel title="配置本次调用" subtitle="可以选择已保存价格，也可以直接输入单价">
          <div className="calculator-form">
            <div className="form-grid">
              <label>
                中转站
                <select
                  value={stationId}
                  onChange={(e) => {
                    setStationId(e.target.value);
                    setPriceId('');
                  }}
                >
                  <option value="">手动模拟</option>
                  {state.stations.map((s: any) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                历史价格版本
                <select
                  value={priceId}
                  onChange={(e) => {
                    setPriceId(e.target.value);
                    const p = state.prices.find((x: any) => x.id === e.target.value);
                    if (p) {
                      setBuy(p.buy);
                      setSell(p.sell);
                      setMultiplier(p.multiplier);
                      setCurrency(p.currency);
                      setTarget(p.currency);
                      setFx('1');
                    }
                  }}
                >
                  <option value="">手动配置价格</option>
                  {state.prices
                    .filter((p: any) => !stationId || p.stationId === stationId)
                    .map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.model} · {time(p.effectiveAt)}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <h3>Token 数量</h3>
            <div className="form-grid">
              {Object.entries(fields).map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="number"
                    min="0"
                    max="1000000000000"
                    step="1"
                    value={tokens[key as keyof Tokens]}
                    onChange={(e) =>
                      setTokens({
                        ...tokens,
                        [key]: Math.max(0, Math.floor(Number(e.target.value))),
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <div className="price-input-table">
              <div>
                <b>计价维度</b>
                <b>上游采购 / 百万</b>
                <b>下游销售 / 百万</b>
              </div>
              {Object.entries(fields).map(([key, label]) => (
                <div key={key}>
                  <span>{label}</span>
                  <input
                    aria-label={`${label}采购价格`}
                    type="number"
                    min="0"
                    step="any"
                    value={buy[key as keyof Rates]}
                    onChange={(e) => setBuy({ ...buy, [key]: e.target.value })}
                  />
                  <input
                    aria-label={`${label}销售价格`}
                    type="number"
                    min="0"
                    step="any"
                    value={sell[key as keyof Rates]}
                    onChange={(e) => setSell({ ...sell, [key]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            <div className="form-grid">
              <label>
                计费倍率
                <input
                  type="number"
                  min="0"
                  step="any"
                  value={multiplier}
                  onChange={(e) => setMultiplier(e.target.value)}
                />
              </label>
              <label>
                单价币种
                <select
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setTarget(e.target.value);
                    setFx('1');
                  }}
                >
                  {['USD', 'CNY', 'EUR', 'AED'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                结果币种
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    if (e.target.value === currency) setFx('1');
                    else {
                      const rate = state.exchangeRates.find(
                        (r: any) =>
                          r.from === currency &&
                          r.to === e.target.value &&
                          r.effectiveAt <= new Date().toISOString(),
                      );
                      setFx(rate?.rate ?? '');
                    }
                  }}
                >
                  {['USD', 'CNY', 'EUR', 'AED'].map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </label>
              <label>
                汇率（1 {currency} → {target}）
                <input
                  type="number"
                  min="0.000000001"
                  step="any"
                  value={fx}
                  disabled={currency === target}
                  onChange={(e) => setFx(e.target.value)}
                />
              </label>
            </div>
          </div>
        </Panel>
        <div>
          <Panel title="本次计算结果" subtitle="模拟估算，不进入实际财务报表">
            <div className="calculation-result">
              <span>预估单次利润</span>
              <strong>{money(result?.profit, target)}</strong>
              <Badge>ESTIMATE / 模拟估算</Badge>
              <div className="key-values">
                <p>
                  <span>
                    <ArrowDownLeft size={14} /> 采购成本
                  </span>
                  <b>{money(result?.cost, target)}</b>
                </p>
                <p>
                  <span>
                    <ArrowUpRight size={14} /> 销售金额
                  </span>
                  <b>{money(result?.revenue, target)}</b>
                </p>
                <p>
                  <span>毛利率</span>
                  <b>{result?.margin == null ? '—' : number(result.margin) + '%'}</b>
                </p>
                <p>
                  <span>成本加成率</span>
                  <b>{result?.markup == null ? '—' : number(result.markup) + '%'}</b>
                </p>
                <p>
                  <span>每百万 Token 利润</span>
                  <b>
                    {result?.profitPerMillion == null
                      ? '—'
                      : money(result.profitPerMillion, target)}
                  </b>
                </p>
                <p>
                  <span>原始 Token 总量</span>
                  <b>{number(result?.totalTokens)}</b>
                </p>
              </div>
              {!result && <div className="error-box">请填写完整、有效的非负价格及正数汇率。</div>}
              <p className="calculation-note">
                金额以十进制精确计算。显示保留最多 6 位小数，内部保留 8 位。特殊阶梯计费需分别计算。
              </p>
            </div>
          </Panel>
          <div className="formula">
            {state.exchangeRates.some(
              (r: any) => r.source === 'https://www.exchangerate-api.com',
            ) && (
              <p>
                <a href="https://www.exchangerate-api.com" target="_blank" rel="noreferrer">
                  Rates By Exchange Rate API ↗
                </a>
              </p>
            )}
            <h3>计算依据</h3>
            <p>Σ（各类 Token × 对应单价）÷ 1,000,000 × 倍率 × 汇率</p>
            <p>
              毛利率 = 利润 ÷ 收入
              <br />
              成本加成率 = 利润 ÷ 成本
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
function ComparePage({ state }: { state: any }) {
  const [model, setModel] = useState(''),
    [tokens, setTokens] = useState(1000);
  const models = [
    ...new Set<string>([
      ...state.models.map((m: any) => m.model),
      ...state.prices.map((p: any) => p.model),
    ]),
  ];
  const rows = state.stations.map((s: any) => {
    const p = state.prices.find(
      (x: any) =>
        x.stationId === s.id && x.model === model && x.effectiveAt <= new Date().toISOString(),
    );
    let estimated = null;
    if (p)
      estimated = calculate(
        { input: tokens, output: tokens, cacheRead: 0, cacheCreation: 0 },
        p.buy,
        p.sell,
        p.multiplier,
      ).cost;
    const observed = state.report.perStationModels.find(
      (x: any) => x.stationId === s.id && x.model === model,
    );
    return {
      ...s,
      price: p,
      estimated: estimated === null ? null : Number(estimated),
      observed,
      availability: state.models.some((m: any) => m.stationId === s.id && m.model === model)
        ? '已观测'
        : '未观测（非不可用）',
    };
  });
  return (
    <>
      <div className="compare-controls">
        <label>
          比较模型
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            <option value="">选择模型</option>
            {models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </select>
        </label>
        <label>
          输入 / 输出 Token（各）
          <input
            type="number"
            min="0"
            step="1"
            value={tokens}
            onChange={(e) => setTokens(Math.max(0, Math.floor(Number(e.target.value))))}
          />
        </label>
        <div className="muted">
          <ShieldCheck size={15} />
          被动观测，无额外模型调用费用
        </div>
      </div>
      <Panel
        title="同模型跨站对比"
        subtitle="仅同币种价格可直接比较；只读接口延迟不等同于模型生成延迟"
      >
        {model ? (
          <Table
            rows={rows}
            columns={[
              { key: 'name', label: '中转站' },
              { key: 'availability', label: '模型观测' },
              {
                key: 'price',
                label: '采购 · 输入 / 输出',
                render: (x) =>
                  x.price
                    ? `${x.price.buy.input} / ${x.price.buy.output} ${x.price.currency}`
                    : '未配置',
              },
              {
                key: 'cache',
                label: '缓存读 / 写',
                render: (x) =>
                  x.price ? `${x.price.buy.cacheRead} / ${x.price.buy.cacheCreation}` : '未配置',
              },
              {
                key: 'estimated',
                label: '单次估算采购',
                render: (x) => (x.price ? money(x.estimated, x.price.currency) : '数据不可用'),
              },
              {
                key: 'latency',
                label: '最近接口延迟',
                render: (x) => (x.latency == null ? '—' : `${number(x.latency)} ms`),
              },
              {
                key: 'successRate',
                label: '历史成功率',
                render: (x) =>
                  x.observed?.successRate == null
                    ? '数据不可用'
                    : number(x.observed.successRate) + '%',
              },
              {
                key: 'actual',
                label: '实际消耗 USD',
                render: (x) => money(x.observed?.consumption),
              },
              {
                key: 'modelLatency',
                label: '模型平均延迟',
                render: (x) =>
                  x.observed?.averageLatency == null
                    ? '数据不可用'
                    : number(x.observed.averageLatency) + ' ms',
              },
            ]}
          />
        ) : (
          <Empty
            title="选择一个模型开始比较"
            description="模型来自真实使用记录、模型列表或手动价格配置。"
          />
        )}
      </Panel>
    </>
  );
}
