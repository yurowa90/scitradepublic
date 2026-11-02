import type { OperationsMetrics } from './operations-metrics';
import { summarize } from '../ledger';
import type { Currency } from '../money';
import { contractReport } from '../reports';
import type { GameState, ScenarioConfig } from '../types';

export interface CurrencyMetrics {
  cash: number;
  accountsReceivable: number;
  accountsPayable: number;
  inventory: number;
  /** 총자산에서 미지급금을 뺀다. TASK-0016 병합 때 합칠 후보. */
  netAssets: number;
  profit: number;
  contractContribution: number;
  contributionDirectTrade: number;
  contributionForwarding: number;
  shortfallDays: number;
  shortfallBasisPoints: number;
  firstShortfallDay: number | null;
  /** 마감한 날마다의 현금 잔액 합(Claude 검수). 금액이 같아도 지급·수금 날짜가 밀리면 달라진다. */
  cashDaySum: number;
}

/** 인도한 계약만 분모에 넣는다. TASK-0016 병합 때 합칠 후보. */
export interface DeliveryMetrics {
  delivered: number;
  onTime: number;
  late: number;
  rateBasisPoints: number | null;
  pastDeadlineUndelivered: number;
}
/** 날짜 지표(Claude 검수). ID 없이 오름차순 목록으로 둔다. 금액·정시 여부가 같아도 날짜가 밀리면 달라진다. */
export interface TimingMetrics {
  /** 취소하지 않고 인도한 계약의 인도일. */
  deliveredDays: number[];
  /** 같은 계약의 납기 여유(납기일 − 인도일). 음수는 지연. */
  slackDays: number[];
  /** 수금까지 마친 계약의 완료일. */
  completedDays: number[];
}
export interface SimMetrics {
  risk?: import('./risk-metrics').RiskMetrics;
  operations?: OperationsMetrics;
  closedDays: number;
  currencies: Record<string, CurrencyMetrics>;
  contracts: { total: number; directTrade: number; forwarding: number; delivered: number; completed: number; cancelled: number };
  delivery: DeliveryMetrics;
  timing: TimingMetrics;
  staff: { availableEmployeeDays: number; idleEmployeeDays: number; waitingTaskDays: number };
}
export interface MetricsCollector {
  observeClosedDay(state: GameState, config: ScenarioConfig, closedDay: number): void;
  finish(state: GameState, config: ScenarioConfig): SimMetrics;
}

export function deliveryCounts(s: Pick<GameState, 'day' | 'contracts'>): DeliveryMetrics {
  let delivered = 0, onTime = 0, pastDeadlineUndelivered = 0;
  for (const c of s.contracts) {
    if (c.status === 'CANCELLED') continue;
    if (c.deliveredDay !== null) {
      delivered++;
      if (c.deliveredDay <= c.deliveryDeadlineDay) onTime++;
    } else if (c.deliveryDeadlineDay < s.day) pastDeadlineUndelivered++;
  }
  return { delivered, onTime, late: delivered - onTime,
    rateBasisPoints: delivered ? Math.floor(onTime * 10000 / delivered) : null, pastDeadlineUndelivered };
}

export function timingOf(s: Pick<GameState, 'contracts'>): TimingMetrics {
  const delivered = s.contracts.filter((c) => c.status !== 'CANCELLED' && c.deliveredDay !== null);
  const asc = (values: number[]) => values.sort((a, b) => a - b);
  return {
    deliveredDays: asc(delivered.map((c) => c.deliveredDay!)),
    slackDays: asc(delivered.map((c) => c.deliveryDeadlineDay - c.deliveredDay!)),
    completedDays: asc(s.contracts.filter((c) => c.completedDay !== null && c.completedDay !== undefined).map((c) => c.completedDay!)),
  };
}

export function createMetricsCollector(config: ScenarioConfig): MetricsCollector {
  const primaryCurrencies = [...new Set([config.tradeCurrency, config.payrollCurrency])];
  const seenCurrencies = new Set<Currency>(primaryCurrencies);
  const shortfalls = new Map<Currency, { days: number; first: number }>();
  const cashDaySums = new Map<Currency, number>();
  let closedDays = 0;
  const staff = { availableEmployeeDays: 0, idleEmployeeDays: 0, waitingTaskDays: 0 };
  return {
    observeClosedDay(state, _config, closedDay) {
      closedDays++;
      for (const currency of new Set([...seenCurrencies, ...state.ledger.entries.map((e) => e.currency)])) {
        seenCurrencies.add(currency);
        cashDaySums.set(currency, (cashDaySums.get(currency) ?? 0) + summarize(state.ledger, currency).cash);
      }
      const unpaid = new Set(state.obligations.filter((o) => o.paidDay === null).map((o) => o.currency));
      for (const currency of unpaid) {
        const previous = shortfalls.get(currency);
        shortfalls.set(currency, { days: (previous?.days ?? 0) + 1, first: previous?.first ?? closedDay });
        seenCurrencies.add(currency);
      }
      for (const e of state.employees) {
        if (e.employmentStatus !== 'employed' || e.availableFromDay > closedDay) continue;
        staff.availableEmployeeDays++;
        const worked = state.tasks.some((t) => t.assignedEmployeeId === e.id && t.startedDay !== null && t.startedDay <= closedDay
          && (t.status === 'RUNNING' || (t.status === 'DONE' && t.completedDay === closedDay)));
        if (!worked) staff.idleEmployeeDays++;
      }
      staff.waitingTaskDays += state.tasks.filter((t) => t.status === 'QUEUED' && t.assignedEmployeeId === null).length;
    },
    finish(state) {
      for (const entry of state.ledger.entries) seenCurrencies.add(entry.currency);
      for (const obligation of state.obligations) seenCurrencies.add(obligation.currency);
      const order = [...primaryCurrencies, ...[...seenCurrencies].filter((c) => !primaryCurrencies.includes(c)).sort()];
      const currencies: Record<string, CurrencyMetrics> = {};
      for (const currency of order) {
        const book = summarize(state.ledger, currency);
        let contributionDirectTrade = 0, contributionForwarding = 0;
        for (const contract of state.contracts) {
          if (contract.currency !== currency) continue;
          const contribution = contractReport(state, contract).contribution;
          if (contract.kind === 'DIRECT_TRADE') contributionDirectTrade += contribution;
          else contributionForwarding += contribution;
        }
        const shortage = shortfalls.get(currency);
        const shortfallDays = shortage?.days ?? 0;
        currencies[currency] = {
          cash: book.cash, accountsReceivable: book.accountsReceivable, accountsPayable: book.accountsPayable,
          inventory: book.inventory, netAssets: book.totalAssets - book.accountsPayable, profit: book.profit,
          contractContribution: contributionDirectTrade + contributionForwarding,
          contributionDirectTrade, contributionForwarding, shortfallDays,
          shortfallBasisPoints: closedDays ? Math.floor(shortfallDays * 10000 / closedDays) : 0,
          firstShortfallDay: shortage?.first ?? null,
          cashDaySum: cashDaySums.get(currency) ?? 0,
        };
      }
      const contracts = state.contracts;
      return { closedDays, currencies, contracts: {
        total: contracts.length, directTrade: contracts.filter((c) => c.kind === 'DIRECT_TRADE').length,
        forwarding: contracts.filter((c) => c.kind === 'FORWARDING').length,
        delivered: contracts.filter((c) => c.deliveredDay !== null).length,
        completed: contracts.filter((c) => c.status === 'COMPLETED').length,
        cancelled: contracts.filter((c) => c.status === 'CANCELLED').length,
      }, delivery: deliveryCounts(state), timing: timingOf(state), staff: { ...staff } };
    },
  };
}
