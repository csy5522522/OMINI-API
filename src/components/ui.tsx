import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as Tooltip from '@radix-ui/react-tooltip';
import { Info, Search, ChevronLeft, ChevronRight, Inbox, X } from 'lucide-react';
import { useState } from 'react';
export const cn = (...inputs: Parameters<typeof clsx>) => twMerge(clsx(inputs));
export function Button({
  className,
  variant = 'default',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'default' | 'outline' | 'ghost' }) {
  return <button className={cn('button', variant, className)} {...props} />;
}
export function Tip({ text }: { text: string }) {
  return (
    <Tooltip.Provider delayDuration={100}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <button type="button" className="info" aria-label={text}>
            <Info size={13} />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content className="tooltip" sideOffset={6}>
            {text}
            <Tooltip.Arrow />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
export function Empty({
  title = '暂无数据',
  description = '接入站点并同步后，真实数据会显示在这里。',
  action,
}: {
  title?: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox size={24} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return (
    <span className={`badge ${tone}`}>
      <i />
      {children}
    </span>
  );
}
export type Column = { key: string; label: string; render?: (row: any) => ReactNode };
export function Table({
  columns,
  rows,
  searchable = true,
  empty = '暂无记录',
}: {
  columns: Column[];
  rows: any[];
  searchable?: boolean;
  empty?: string;
}) {
  const [search, setSearch] = useState(''),
    [page, setPage] = useState(1),
    [sort, setSort] = useState({ key: '', reverse: false });
  let filtered = rows.filter(
    (r) => !search || JSON.stringify(r).toLowerCase().includes(search.toLowerCase()),
  );
  if (sort.key)
    filtered = [...filtered].sort((a, b) => {
      const av = a[sort.key],
        bv = b[sort.key];
      return (
        (typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av ?? '').localeCompare(String(bv ?? ''))) * (sort.reverse ? -1 : 1)
      );
    });
  const pages = Math.max(1, Math.ceil(filtered.length / 10)),
    current = Math.min(page, pages);
  return (
    <>
      {searchable && (
        <div className="table-tools">
          <Search size={15} />
          <input
            aria-label="搜索表格"
            placeholder="搜索名称、模型或记录…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
          />
          <span>{filtered.length} 条记录</span>
        </div>
      )}
      {filtered.length ? (
        <>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c.key}>
                      <button
                        onClick={() =>
                          setSort({
                            key: c.key,
                            reverse: sort.key === c.key ? !sort.reverse : false,
                          })
                        }
                      >
                        {c.label}
                        {sort.key === c.key ? (sort.reverse ? ' ↓' : ' ↑') : ''}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice((current - 1) * 10, current * 10).map((r, i) => (
                  <tr key={r.id ?? i}>
                    {columns.map((c) => (
                      <td key={c.key}>
                        {c.render
                          ? c.render(r)
                          : (r[c.key] ?? <span className="muted">数据不可用</span>)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <span>
              第 {current} / {pages} 页 · 共 {filtered.length} 条
            </span>
            <div>
              <Button
                variant="ghost"
                disabled={current <= 1}
                onClick={() => setPage(current - 1)}
                aria-label="上一页"
              >
                <ChevronLeft size={15} />
              </Button>
              <Button
                variant="ghost"
                disabled={current >= pages}
                onClick={() => setPage(current + 1)}
                aria-label="下一页"
              >
                <ChevronRight size={15} />
              </Button>
            </div>
          </div>
        </>
      ) : (
        <Empty title={empty} />
      )}
    </>
  );
}
export type Field = {
  name: string;
  label: string;
  type?: string;
  value?: string;
  options?: { value: string; label: string }[];
  required?: boolean;
  hint?: string;
};
export function FormModal({
  title,
  description,
  fields,
  onClose,
  onSubmit,
}: {
  title: string;
  description?: string;
  fields: Field[];
  onClose: () => void;
  onSubmit: (values: Record<string, string>) => Promise<void | boolean>;
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <div>
            <h2>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <Button variant="ghost" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </Button>
        </header>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            const values = Object.fromEntries(new FormData(e.currentTarget).entries()) as Record<
              string,
              string
            >;
            setBusy(true);
            try {
              const close = await onSubmit(values);
              if (close !== false) onClose();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <div className="form-grid">
            {fields.map((f) => (
              <label key={f.name} className={f.type === 'textarea' ? 'wide' : ''}>
                {f.label}
                {f.options ? (
                  <select
                    name={f.name}
                    defaultValue={f.value ?? f.options[0]?.value}
                    required={f.required !== false}
                  >
                    {f.options.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                ) : f.type === 'textarea' ? (
                  <textarea name={f.name} defaultValue={f.value} required={f.required !== false} />
                ) : (
                  <input
                    name={f.name}
                    type={f.type ?? 'text'}
                    step="any"
                    defaultValue={f.value}
                    required={f.required !== false}
                    autoComplete={f.type === 'password' ? 'new-password' : 'off'}
                  />
                )}{' '}
                {f.hint && <small>{f.hint}</small>}
              </label>
            ))}
          </div>
          {error && (
            <div className="error-box" role="alert">
              {error}
            </div>
          )}
          <footer>
            <Button type="button" variant="outline" onClick={onClose}>
              取消
            </Button>
            <Button disabled={busy}>{busy ? '处理中…' : '保存并完成'}</Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
