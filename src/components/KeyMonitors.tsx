import { useEffect, useRef, useState } from 'react';
import { Activity, KeyRound, Plus, RefreshCw } from 'lucide-react';
import { api } from '../api';
import { Badge, Button, Empty, FormModal, Table, type Field } from './ui';

const protocols = [
  { value: 'openai', label: 'OpenAI 兼容 / Sub2API' },
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'gemini', label: 'Gemini' },
];
const statuses: Record<string, string> = {
  supported: '模型列表可访问',
  unauthorized: 'Key 无效或已过期',
  forbidden: '权限不足',
  unsupported: '接口不支持',
  unavailable: '无法确认',
  rate_limited: '远端限流',
  error: '连接或服务异常',
  disabled: '未启用',
  pending: '等待检测',
};
const stamp = (value?: string) =>
  value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未检测';
const amount = (value: string, currency: string) =>
  new Intl.NumberFormat('zh-CN', { style: 'currency', currency, maximumFractionDigits: 6 }).format(
    Number(value),
  );

export function KeyMonitors({ stations }: { stations: any[] }) {
  const [rows, setRows] = useState<any[]>([]),
    [interval, setIntervalSeconds] = useState(300),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [busy, setBusy] = useState<string[]>([]),
    [detail, setDetail] = useState<string | null>(null);
  const [modal, setModal] = useState<{
    title: string;
    description?: string;
    fields: Field[];
    submit: (values: Record<string, string>) => Promise<void>;
  } | null>(null);
  const mounted = useRef(true),
    active = useRef(new Set<string>()),
    loadingRequest = useRef(false);
  async function load() {
    if (loadingRequest.current) return;
    loadingRequest.current = true;
    try {
      const data = await api('/key-monitors');
      if (mounted.current) {
        setRows(data.monitors);
        setIntervalSeconds(data.intervalSeconds);
      }
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      loadingRequest.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void load();
    const timer = window.setInterval(() => void load(), 10000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, []);
  async function refresh(id: string) {
    if (active.current.has(id)) return;
    active.current.add(id);
    setBusy([...active.current]);
    try {
      const row = await api(`/key-monitors/${id}/refresh`, {});
      if (mounted.current)
        setRows((current) => current.map((item) => (item.id === id ? row : item)));
    } catch (err) {
      if (mounted.current) setError((err as Error).message);
    } finally {
      active.current.delete(id);
      if (mounted.current) setBusy([...active.current]);
    }
  }
  async function change(id: string, values: unknown) {
    setError('');
    try {
      await api(`/key-monitors/${id}`, values, 'PATCH');
      await load();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  function edit(row?: any) {
    setModal({
      title: row ? '编辑 API Key 监控' : '添加 API Key 监控',
      description: '后台定时查询模型列表，不发起生成请求。Key 加密保存，页面仅显示尾号。',
      fields: [
        { name: 'name', label: '名称', value: row?.name },
        {
          name: 'baseUrl',
          label: 'API 地址',
          type: 'url',
          value: row?.baseUrl,
          hint: '填写 API 网关地址，例如 https://api.f-api.site；可带 /v1。',
        },
        {
          name: 'protocol',
          label: '接口协议',
          options: protocols,
          value: row?.protocol ?? 'openai',
        },
        {
          name: 'key',
          label: row ? '替换 API Key（留空保留原值）' : 'API Key',
          type: 'password',
          required: !row,
        },
        {
          name: 'balanceEnabled',
          label: '余额查询',
          value: String(row?.balanceEnabled ?? true),
          options: [
            { value: 'true', label: '查询余额（接口支持时显示）' },
            { value: 'false', label: '关闭余额查询' },
          ],
          hint: '支持 Sub2API / F-AI Hub 的只读余额接口，其他接口显示不支持。',
        },
        { name: 'balanceThreshold', label: '低余额提醒阈值', value: row?.balanceThreshold ?? '10' },
        {
          name: 'currency',
          label: '阈值币种',
          value: row?.currency ?? 'USD',
          options: ['USD', 'CNY', 'EUR', 'AED'].map((value) => ({ value, label: value })),
        },
      ],
      submit: async (values) => {
        const { key, ...rest } = values;
        await api(
          row ? `/key-monitors/${row.id}` : '/key-monitors',
          {
            ...rest,
            balanceEnabled: values.balanceEnabled === 'true',
            ...(!row || key ? { key } : {}),
          },
          row ? 'PATCH' : 'POST',
        );
        setError('');
        await load();
      },
    });
  }
  const selected = rows.find((row) => row.id === detail);
  const sources = stations.filter((station) => station.authType === 'api_key');
  return (
    <div className="integration-stack key-monitor-page">
      <div className="info-strip">
        <Activity size={17} />
        <span>后台每 {interval} 秒检测 · 页面每 10 秒更新 · 关闭页面后继续监控</span>
      </div>
      {error && (
        <div className="error-box" role="alert">
          {error}
        </div>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>我的 API Key</h2>
            <p>
              共 {rows.length} 个 · 已启用 {rows.filter((row) => row.enabled).length} 个 · 需处理{' '}
              {rows.filter((row) => row.enabled && row.incident).length} 个
            </p>
          </div>
          <div className="actions">
            <Button
              variant="outline"
              disabled={busy.length > 0 || !rows.some((row) => row.enabled)}
              onClick={async () => {
                setError('');
                for (const row of rows.filter((item) => item.enabled)) {
                  if (!mounted.current) break;
                  await refresh(row.id);
                }
              }}
            >
              <RefreshCw size={14} />
              {busy.length ? '检测中…' : '检测全部'}
            </Button>
            {sources.length > 0 && (
              <Button
                variant="outline"
                onClick={() =>
                  setModal({
                    title: '导入已有站点 Key',
                    description: '直接使用余额监控中已加密保存的 Key，无需再次输入。',
                    fields: [
                      {
                        name: 'stationId',
                        label: '选择站点',
                        options: sources.map((station) => ({
                          value: station.id,
                          label: station.name,
                        })),
                      },
                    ],
                    submit: async (values) => {
                      await api('/key-monitors/import', values);
                      await load();
                    },
                  })
                }
              >
                导入已有站点
              </Button>
            )}
            <Button onClick={() => edit()}>
              <Plus size={14} />
              添加 Key
            </Button>
          </div>
        </div>
        {loading ? (
          <Empty title="正在加载监控…" description="" />
        ) : (
          <Table
            rows={rows}
            empty="尚未添加 API Key"
            emptyDescription="添加 API 地址和 Key，保存后自动开始监控。"
            columns={[
              {
                key: 'name',
                label: '名称 / Key',
                render: (row) => (
                  <div>
                    <b>{row.name}</b>
                    <p>
                      <code>{row.masked}</code>
                    </p>
                    <small className="muted">{row.baseUrl}</small>
                  </div>
                ),
              },
              {
                key: 'protocol',
                label: '协议',
                render: (row) => protocols.find((item) => item.value === row.protocol)?.label,
              },
              {
                key: 'status',
                label: '可用状态',
                render: (row) => {
                  const stale =
                    row.enabled &&
                    row.checkedAt &&
                    Date.now() - Date.parse(row.checkedAt) > interval * 2000;
                  return (
                    <div>
                      <Badge
                        tone={
                          !row.enabled
                            ? 'neutral'
                            : stale
                              ? 'warn'
                              : row.result?.status === 'supported'
                                ? 'good'
                                : row.result?.status === 'unauthorized'
                                  ? 'bad'
                                  : 'warn'
                        }
                      >
                        {!row.enabled
                          ? '已暂停'
                          : stale
                            ? '检测结果已过期'
                            : statuses[row.result?.status ?? 'pending']}
                      </Badge>
                      <p className="muted">
                        {row.result
                          ? `HTTP ${row.result.httpStatus ?? '—'} · ${row.result.latency} ms`
                          : '保存后自动检测'}
                      </p>
                    </div>
                  );
                },
              },
              {
                key: 'balance',
                label: '余额 / 阈值',
                render: (row) => {
                  const balance = row.result?.balance;
                  return (
                    <div>
                      {!row.balanceEnabled ? (
                        '未启用'
                      ) : balance?.status === 'supported' && balance.amount != null ? (
                        <>
                          <b>{amount(balance.amount, balance.currency)}</b>
                          {row.incident === 'low_balance' && <Badge tone="bad">余额不足</Badge>}
                        </>
                      ) : (
                        (statuses[balance?.status ?? 'pending'] ?? '数据不可用')
                      )}
                      {row.balanceEnabled && (
                        <p className="muted">
                          低于 {amount(row.balanceThreshold, row.currency)} 提醒
                        </p>
                      )}
                    </div>
                  );
                },
              },
              { key: 'checkedAt', label: '最近检测', render: (row) => stamp(row.checkedAt) },
              {
                key: 'actions',
                label: '操作',
                render: (row) => (
                  <div className="actions">
                    <Button
                      variant="outline"
                      disabled={!row.enabled || busy.includes(row.id)}
                      onClick={() => {
                        setError('');
                        void refresh(row.id);
                      }}
                    >
                      {busy.includes(row.id) ? '检测中…' : '立即刷新'}
                    </Button>
                    <Button variant="ghost" onClick={() => setDetail(row.id)}>
                      详情
                    </Button>
                    <Button variant="ghost" onClick={() => edit(row)}>
                      编辑
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() => void change(row.id, { enabled: !row.enabled })}
                    >
                      {row.enabled ? '暂停' : '启用'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        setModal({
                          title: '移除 API Key 监控',
                          description: `移除「${row.name}」及本系统保存的加密 Key。上游 Key 不会被撤销。`,
                          fields: [],
                          submit: async () => {
                            await api(`/key-monitors/${row.id}`, undefined, 'DELETE');
                            await load();
                          },
                        })
                      }
                    >
                      移除
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </section>
      <p className="muted">
        模型列表可访问仅表示该接口的认证与权限通过；生成能力、模型额度以服务商为准。余额不支持时不影响可用状态。异常及低余额在告警中心提醒，同类提醒每小时最多一次。
      </p>
      {selected && (
        <section className="panel">
          <div className="panel-heading">
            <h2>
              <KeyRound size={17} /> {selected.name} · 检测详情
            </h2>
            <Button variant="ghost" onClick={() => setDetail(null)}>
              关闭
            </Button>
          </div>
          <div className="integration-form">
            <p>{selected.result?.message ?? '等待首次检测'}</p>
            <p className="muted">
              最近检测：{stamp(selected.checkedAt)} · 可访问模型：
              {selected.result?.models?.length ?? 0}
            </p>
            <div className="model-tags">
              {selected.result?.models?.map((model: string, index: number) => (
                <code key={index}>{model}</code>
              ))}
            </div>
          </div>
        </section>
      )}
      {modal && (
        <FormModal
          title={modal.title}
          description={modal.description}
          fields={modal.fields}
          onClose={() => setModal(null)}
          onSubmit={modal.submit}
        />
      )}
    </div>
  );
}
