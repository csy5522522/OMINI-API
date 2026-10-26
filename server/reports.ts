import { and, gte, lt, eq } from 'drizzle-orm';
import type { Store } from './db.js';
import * as s from './schema.js';
import { Decimal, amortize, prepaidBalance } from '../shared/finance.js';
import { dayIn } from './time.js';
export async function report(
  store: Store,
  from: string,
  to: string,
  tz: string,
  stationId?: string,
  model?: string,
) {
  return await store.db.transaction(
    async (db) => {
      const [
        stations,
        relations,
        links,
        allSubscriptions,
        allUsage,
        allAggregates,
        allTransactions,
        allRecharges,
        allPrices,
        allAlerts,
      ] = await Promise.all([
        db.select().from(s.stations),
        db.select().from(s.relations),
        db.select().from(s.correlations),
        db.select().from(s.subscriptions),
        db.select().from(s.usage),
        db.select().from(s.aggregates),
        db.select().from(s.transactions),
        db.select().from(s.recharges),
        db.select().from(s.pricing),
        db.select().from(s.alerts),
      ]);
      const usageById = new Map(allUsage.map((x) => [x.id, x])),
        priceById = new Map(allPrices.map((x) => [x.id, x]));
      const fixedCostKnown = (id: string, date: string) =>
        allSubscriptions.some((x) => x.stationId === id && x.start <= date && x.end > date);
      const upstream = new Set(
        stations.filter((st) => st.kind === 'third_party').map((st) => st.id),
      );
      const rows = allUsage.filter(
        (x) =>
          x.occurredAt >= from &&
          x.occurredAt < to &&
          (!stationId || x.stationId === stationId) &&
          (!model || x.model === model),
      );
      const canonical = rows.filter(
        (r) => stationId || stations.find((st) => st.id === r.stationId)?.kind === 'self',
      );
      const aggregates = allAggregates.filter(
        (r) =>
          (!stationId || r.stationId === stationId) &&
          !model &&
          r.day >= dayIn(new Date(from), tz) &&
          r.day < dayIn(new Date(to), tz) &&
          !canonical.some((u) => u.stationId === r.stationId) &&
          (!upstream.has(r.stationId) || stationId),
      );
      const getStation = (id: string) => stations.find((x) => x.id === id)!;
      const modelMap = new Map<string, any>(),
        trendMap = new Map<string, any>();
      const zero = () => ({
        requests: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheCreation: 0,
        totalTokens: 0,
        latencyTotal: 0,
        latencyCount: 0,
        firstTotal: 0,
        firstCount: 0,
        knownOutcomes: 0,
        failures: 0,
        consumption: new Decimal(0),
        knownBills: 0,
        unknownBills: 0,
        unknownRequests: 0,
        unknownTokens: 0,
        unknownFields: [] as string[],
      });
      const total = zero();
      function add(target: ReturnType<typeof zero>, r: (typeof rows)[number]) {
        target.requests++;
        for (const k of ['input', 'output', 'cacheRead', 'cacheCreation'] as const) {
          target[k] += r[k] ?? 0;
          if (r[k] === null) {
            target.unknownTokens++;
            target.unknownFields.push(k);
          }
        }
        target.totalTokens +=
          (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheCreation ?? 0);
        if (r.duration !== null) {
          target.latencyTotal += r.duration;
          target.latencyCount++;
        }
        if (r.firstToken !== null) {
          target.firstTotal += r.firstToken;
          target.firstCount++;
        }
        if (r.success !== null) {
          target.knownOutcomes++;
          if (!r.success) target.failures++;
        }
        if (r.actualCost !== null) {
          target.knownBills++;
          target.consumption = target.consumption.plus(r.actualCost);
        } else target.unknownBills++;
      }
      for (const r of canonical) {
        add(total, r);
        const key = r.model;
        const m = modelMap.get(key) ?? { model: key, ...zero() };
        add(m, r);
        modelMap.set(key, m);
        const day = dayIn(new Date(r.occurredAt), tz),
          t = trendMap.get(day) ?? { day, ...zero() };
        add(t, r);
        trendMap.set(day, t);
      }
      for (const a of aggregates) {
        const d = a.data,
          t = trendMap.get(a.day) ?? { day: a.day, ...zero() };
        for (const target of [total, t]) {
          target.requests += d.requests ?? 0;
          if (d.requests == null) target.unknownRequests++;
          for (const [key, field] of Object.entries({
            input: 'input_tokens',
            output: 'output_tokens',
            cacheRead: 'cache_read_tokens',
            cacheCreation: 'cache_creation_tokens',
          })) {
            (target as any)[key] += d[field] ?? 0;
            if (d[field] == null) target.unknownFields.push(key);
          }
          target.totalTokens += d.total_tokens ?? 0;
          if (d.total_tokens == null) target.unknownTokens++;
          if (d.actual_cost != null) {
            target.knownBills++;
            target.consumption = target.consumption.plus(d.actual_cost);
          } else target.unknownBills++;
        }
        trendMap.set(a.day, t);
      }
      const serialize = (x: any) => ({
        ...x,
        ...Object.fromEntries(x.unknownFields.map((k: string) => [k, null])),
        requests: x.unknownRequests ? null : x.requests,
        consumption: x.knownBills && !x.unknownBills ? x.consumption.toFixed(8) : null,
        averageLatency: x.latencyCount ? x.latencyTotal / x.latencyCount : null,
        firstToken: x.firstCount ? x.firstTotal / x.firstCount : null,
        successRate:
          x.knownOutcomes === x.requests && x.requests
            ? 100 * (1 - x.failures / x.knownOutcomes)
            : null,
        totalTokens: x.unknownTokens ? null : x.totalTokens,
      });
      const perStationModels = new Map<string, any>();
      for (const row of rows) {
        const key = row.stationId + '|' + row.model;
        const value = perStationModels.get(key) ?? {
          stationId: row.stationId,
          model: row.model,
          ...zero(),
        };
        add(value, row);
        perStationModels.set(key, value);
      }
      const groups = new Map<
        string,
        {
          currency: string;
          revenue: Decimal;
          cost: Decimal;
          other: Decimal;
          amortization: Decimal;
          recharges: Decimal;
        }
      >();
      const group = (currency: string) => {
        if (!groups.has(currency))
          groups.set(currency, {
            currency,
            revenue: new Decimal(0),
            cost: new Decimal(0),
            other: new Decimal(0),
            amortization: new Decimal(0),
            recharges: new Decimal(0),
          });
        return groups.get(currency)!;
      };
      let pending = 0;
      const matchedCosts = new Set<string>();
      for (const row of canonical) {
        const st = getStation(row.stationId);
        if (st.role === 'sales') {
          if (row.actualCost !== null)
            group(row.currency).revenue = group(row.currency).revenue.plus(row.actualCost);
          else pending++;
          const link = links.find((l) => l.downstreamUsageId === row.id);
          const cost = link ? usageById.get(link.upstreamUsageId) : null;
          if (cost) {
            matchedCosts.add(cost.id);
            if (getStation(cost.stationId).costMode === 'subscription') {
              if (!fixedCostKnown(cost.stationId, row.occurredAt)) pending++;
            } else if (cost.actualCost !== null)
              group(cost.currency).cost = group(cost.currency).cost.plus(cost.actualCost);
            else pending++;
          } else if (st.costMode !== 'subscription' || !fixedCostKnown(st.id, row.occurredAt))
            pending++;
        } else if (stationId && st.kind === 'third_party' && st.costMode !== 'subscription') {
          if (row.actualCost !== null)
            group(row.currency).cost = group(row.currency).cost.plus(row.actualCost);
          else pending++;
        }
      }
      for (const a of aggregates) {
        const st = getStation(a.stationId);
        if (a.data.actual_cost != null) {
          const g = group('USD');
          if (st.role === 'sales') {
            g.revenue = g.revenue.plus(a.data.actual_cost);
            pending++;
          } else if (st.role === 'cost' && st.costMode !== 'subscription')
            g.cost = g.cost.plus(a.data.actual_cost);
        }
      }
      // Manual transactions are additional entries, never automatic replacements of imported bills.
      for (const tr of allTransactions.filter(
        (x) =>
          x.occurredAt >= from && x.occurredAt < to && (!stationId || x.stationId === stationId),
      )) {
        const g = group(tr.currency);
        if (tr.kind === 'revenue') g.revenue = g.revenue.plus(tr.amount);
        else if (tr.kind === 'consumption') g.cost = g.cost.plus(tr.amount);
        else g.other = g.other.plus(tr.amount);
      }
      const selectedCosts = new Set<string>(stationId ? [stationId] : stations.map((x) => x.id));
      if (stationId)
        for (let i = 0; i < stations.length; i++)
          for (const edge of relations)
            if (selectedCosts.has(edge.downstreamId)) selectedCosts.add(edge.upstreamId);
      const subscriptionData = allSubscriptions
        .filter((x) => selectedCosts.has(x.stationId))
        .map((x) => {
          const allocated = amortize(x.amount, x.otherFees, x.start, x.end, from, to),
            elapsed = amortize(
              x.amount,
              x.otherFees,
              x.start,
              x.end,
              x.start,
              new Date().toISOString(),
            );
          const g = group(x.currency);
          g.amortization = g.amortization.plus(allocated);
          const related = (r: (typeof rows)[number]) =>
            r.occurredAt >= x.start &&
            r.occurredAt < x.end &&
            getStation(r.stationId).role === 'sales' &&
            links.some(
              (l) =>
                l.downstreamUsageId === r.id &&
                usageById.get(l.upstreamUsageId)?.stationId === x.stationId,
            );
          const periodSales = rows.filter(related),
            lifetimeSales = allUsage
              .filter((r) => r.occurredAt >= x.start && r.occurredAt < new Date().toISOString())
              .filter(related);
          const periodMissing = periodSales.some(
              (r) => r.currency !== x.currency || r.actualCost === null,
            ),
            lifetimeMissing = lifetimeSales.some(
              (r) => r.currency !== x.currency || r.actualCost === null,
            );
          const recognized = periodSales
              .filter((r) => r.currency === x.currency)
              .reduce((sum, r) => sum.plus(r.actualCost ?? 0), new Decimal(0)),
            lifetime = lifetimeSales
              .filter((r) => r.currency === x.currency)
              .reduce((sum, r) => sum.plus(r.actualCost ?? 0), new Decimal(0));
          return {
            ...x,
            allocated,
            elapsed,
            recognizedRevenue: periodMissing ? null : recognized.toFixed(8),
            net: periodMissing ? null : recognized.minus(allocated).toFixed(8),
            currentRevenue: lifetimeMissing ? null : lifetime.toFixed(8),
            currentNet: lifetimeMissing ? null : lifetime.minus(elapsed).toFixed(8),
            contractDifference: lifetimeMissing
              ? null
              : lifetime.minus(new Decimal(x.amount).plus(x.otherFees)).toFixed(8),
            breakEven:
              lifetimeMissing || new Decimal(x.amount).plus(x.otherFees).isZero()
                ? null
                : lifetime.div(new Decimal(x.amount).plus(x.otherFees)).times(100).toFixed(2),
            quotaProgress:
              x.quota && new Decimal(x.quota).gt(0)
                ? new Decimal(x.used ?? 0).div(x.quota).times(100).toFixed(2)
                : null,
          };
        });
      for (const r of allRecharges.filter(
        (x) =>
          x.occurredAt >= from && x.occurredAt < to && (!stationId || x.stationId === stationId),
      ))
        group(r.currency).recharges = group(r.currency).recharges.plus(r.amount);
      const prepaid = stations
        .filter((x) => x.costMode === 'prepaid')
        .map((st) => {
          const rs = allRecharges.filter(
            (r) => r.stationId === st.id && r.currency === st.currency,
          );
          const consumed = allUsage
            .filter((r) => r.stationId === st.id)
            .filter((x) => x.currency === st.currency && x.actualCost !== null);
          const manual = allTransactions
            .filter((r) => r.stationId === st.id && r.kind === 'consumption')
            .filter((x) => x.currency === st.currency);
          return {
            stationId: st.id,
            currency: st.currency,
            recharged: rs.reduce((v, r) => v.plus(r.amount), new Decimal(0)).toFixed(8),
            calculatedBalance: prepaidBalance(
              rs.map((r) => r.amount),
              [...consumed.map((r) => r.actualCost!), ...manual.map((r) => r.amount)],
            ),
            remoteBalance: st.snapshot?.balance ?? null,
            note: '账面余额仅覆盖已录入期初充值和已同步消费',
          };
        });
      const finances = [...groups.values()].map((g) => {
        const cost = g.cost.plus(g.other).plus(g.amortization),
          profit = g.revenue.minus(cost);
        return {
          currency: g.currency,
          revenue: g.revenue.toFixed(8),
          consumption: g.cost.toFixed(8),
          other: g.other.toFixed(8),
          amortization: g.amortization.toFixed(8),
          cost: cost.toFixed(8),
          profit: pending ? null : profit.toFixed(8),
          knownDifference: profit.toFixed(8),
          margin:
            !pending && !g.revenue.isZero() ? profit.div(g.revenue).times(100).toFixed(4) : null,
          markup: !pending && !cost.isZero() ? profit.div(cost).times(100).toFixed(4) : null,
          recharges: g.recharges.toFixed(8),
        };
      });
      function modelFinance(model: string) {
        let revenue = new Decimal(0),
          cost = new Decimal(0),
          knownRevenue = 0,
          knownCost = 0,
          missing = 0;
        const estimateGroups = new Map<
          string,
          { cost: Decimal; revenue: Decimal; records: number }
        >();
        for (const row of canonical.filter((x) => x.model === model)) {
          const st = getStation(row.stationId);
          if (st.role === 'sales') {
            if (row.actualCost !== null) {
              revenue = revenue.plus(row.actualCost);
              knownRevenue++;
            } else missing++;
            const link = links.find((x) => x.downstreamUsageId === row.id),
              up = link ? usageById.get(link.upstreamUsageId) : null;
            if (
              up &&
              up.actualCost !== null &&
              getStation(up.stationId).costMode !== 'subscription'
            ) {
              cost = cost.plus(up.actualCost);
              knownCost++;
            } else missing++;
          } else if (
            st.role === 'cost' &&
            st.costMode !== 'subscription' &&
            row.actualCost !== null
          ) {
            cost = cost.plus(row.actualCost);
            knownCost++;
          }
          if (row.estimatedCost !== null && row.estimatedRevenue !== null && row.priceId) {
            const price = priceById.get(row.priceId);
            if (price) {
              const e = estimateGroups.get(price.currency) ?? {
                cost: new Decimal(0),
                revenue: new Decimal(0),
                records: 0,
              };
              e.cost = e.cost.plus(row.estimatedCost);
              e.revenue = e.revenue.plus(row.estimatedRevenue);
              e.records++;
              estimateGroups.set(price.currency, e);
            }
          }
        }
        return {
          revenue: knownRevenue ? revenue.toFixed(8) : null,
          actualPurchaseCost: knownCost ? cost.toFixed(8) : null,
          grossProfit: !missing && knownRevenue ? revenue.minus(cost).toFixed(8) : null,
          pendingRecords: missing,
          estimates: [...estimateGroups.entries()].map(([currency, e]) => ({
            currency,
            records: e.records,
            cost: e.cost.toFixed(8),
            revenue: e.revenue.toFixed(8),
            profit: e.revenue.minus(e.cost).toFixed(8),
          })),
        };
      }
      return {
        summary: {
          ...serialize(total),
          stations: stations.length,
          healthy: stations.filter((x) => x.status === 'online').length,
          connected: stations.filter((x) => ['online', 'degraded'].includes(x.status)).length,
          alerts: allAlerts.filter((x) => x.status === 'open').length,
          pending,
          unlinked: rows.filter((r) => upstream.has(r.stationId) && !matchedCosts.has(r.id)).length,
        },
        models: [...modelMap.values()].map((x) => ({ ...serialize(x), ...modelFinance(x.model) })),
        perStationModels: [...perStationModels.values()].map(serialize),
        trend: [...trendMap.values()].sort((a, b) => a.day.localeCompare(b.day)).map(serialize),
        finances,
        subscriptions: subscriptionData,
        prepaid,
        scope:
          '全局请求与 Token 仅统计自己的主中转站；第三方用量单独查看，未配置上下游关系时也不叠加到主站。可靠请求关联用于确认采购成本，未匹配记录保持未关联。不同币种分账，估算不进入实际利润。主站报告包含其已关联上游的完整固定订阅摊销。',
      };
    },
    { isolationLevel: 'repeatable read' },
  );
}
