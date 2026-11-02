// 경로 11 읽기 모델. 원장·청구서와 오늘까지 공개된 경로만 읽는다.
import { ACCOUNT_KIND, balance, summarize, type Account, type Ledger } from './ledger';
import type { Currency } from './money';
import { quotePreview } from './readers';
import { creditTermOptions } from './readers-lazy';
import { receivableSchedule } from './reports-lazy';
import { fundsPosition } from './reservations';
import { divHalfAway, referenceRate, usdToKrwMinor } from './risk';
import type { CreditTermId, GameState, ScenarioConfig } from './types';

type MoneyRow = { currency: Currency; amountMinor: number };
const accounts = Object.keys(ACCOUNT_KIND) as Account[];
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const debitSign = (account: Account) => ['asset', 'expense'].includes(ACCOUNT_KIND[account]) ? 1 : -1;

function currencies(s: GameState, config: ScenarioConfig): Currency[] {
  return [...new Set([config.tradeCurrency, config.payrollCurrency, ...s.ledger.entries.map((e) => e.currency)])].sort(compareText);
}
function krw(currency: Currency, amount: number, rate: number): number {
  if (currency === 'KRW') return amount;
  if (currency === 'USD') return usdToKrwMinor(amount, rate);
  throw new Error('통화 없는 금액은 원화로 환산할 수 없습니다');
}
function moneyTotal(rows: MoneyRow[], rate: number): number {
  const totals = new Map<Currency, number>();
  for (const row of rows) totals.set(row.currency, (totals.get(row.currency) ?? 0) + row.amountMinor);
  return [...totals].reduce((sum, [currency, amount]) => sum + krw(currency, amount, rate), 0);
}
function ledgerAt(s: GameState, asOfDay: number): Ledger {
  if (asOfDay > s.day) throw new Error('경로 11 결산일은 현재 날짜를 넘을 수 없습니다');
  return { entries: s.ledger.entries.filter((e) => e.day <= asOfDay), postedIds: {} };
}

export function creditLockPreview(s: GameState, config: ScenarioConfig, buyOfferId: string, sellOfferId: string, quantity?: number) {
  if (config.rules.rulesVersion !== 'M2a-rules-4') return [];
  const quote = quotePreview(s, config, { buyOfferId, sellOfferId }, quantity);
  const cashOut = (quote.cashNeedByCurrency ?? [{ currency: config.tradeCurrency, amountMinor: quote.cashNeed }])
    .map((row) => ({ ...row })).sort((a, b) => compareText(a.currency, b.currency));
  const rate = referenceRate(config, s.rng.seed, s.day);
  const p = config.operations!.market.publish;
  return creditTermOptions(s, config, buyOfferId, sellOfferId, quantity).map((row) => {
    let publishesInWindow = 0;
    for (let day = p.firstDay; day <= Math.min(p.lastDay, row.paymentDueDay); day += p.intervalDays) {
      if (day > s.day) publishesInWindow++;
    }
    return { termId: row.termId, allowed: row.allowed, reasonKo: row.reasonKo,
      cashOut: cashOut.map((r) => ({ ...r })), cashOutKrwMinor: moneyTotal(cashOut, rate),
      paymentDueDay: row.paymentDueDay, lockDays: row.paymentDueDay - s.day, publishesInWindow,
      exposureAfterMinor: row.exposureMinor + (row.termId === 'BASE' ? 0 : row.saleAmountMinor), limitMinor: row.limitMinor };
  });
}

interface ReceivableRow {
  termId: CreditTermId; grade: string | null; currency: Currency;
  outstandingMinor: number; count: number; overdueCount: number;
}
export function receivablesByTerm(s: GameState, config: ScenarioConfig): { rows: ReceivableRow[]; totalKrwMinor: number } {
  if (config.rules.rulesVersion !== 'M2a-rules-4') return { rows: [], totalKrwMinor: 0 };
  const groups = new Map<string, ReceivableRow>();
  const contracts = new Map(s.contracts.map((c) => [c.id, c]));
  const invoices = new Map(s.invoices.map((i) => [i.id, i]));
  for (const invoice of receivableSchedule(s, config)) {
    const contract = contracts.get(invoice.contractId)!;
    const termId = contract.kind === 'FORWARDING' ? 'BASE' : contract.creditTermId ?? 'BASE';
    const grade = contract.kind === 'FORWARDING' ? null
      : config.operations!.risk!.profile.collections.byCounterparty.find((r) => r.counterpartyId === contract.customerId)!.grade;
    const key = JSON.stringify([termId, grade, invoice.currency]);
    const row = groups.get(key) ?? { termId, grade, currency: invoice.currency, outstandingMinor: 0, count: 0, overdueCount: 0 };
    row.outstandingMinor += invoice.outstandingMinor;
    row.count++;
    if (invoices.get(invoice.invoiceId)!.status === 'OVERDUE') row.overdueCount++;
    groups.set(key, row);
  }
  const order: Record<CreditTermId, number> = { BASE: 0, D15: 1, D30: 2 };
  const rows = [...groups.values()].sort((a, b) => order[a.termId] - order[b.termId]
    || (a.grade === b.grade ? 0 : a.grade === null ? 1 : b.grade === null ? -1 : compareText(a.grade, b.grade))
    || compareText(a.currency, b.currency));
  return { rows, totalKrwMinor: moneyTotal(rows.map((r) => ({ currency: r.currency, amountMinor: r.outstandingMinor })),
    referenceRate(config, s.rng.seed, s.day)) };
}

export function cashLockSummary(s: GameState, config: ScenarioConfig) {
  if (!config.operations) return null;
  const codes = currencies(s, config), schedule = receivableSchedule(s, config);
  const available = codes.map((currency) => ({ currency, amountMinor: fundsPosition(s, config, currency).available }));
  const receivable = codes.map((currency) => ({ currency,
    amountMinor: schedule.filter((r) => r.currency === currency).reduce((sum, r) => sum + r.outstandingMinor, 0) }));
  const rate = referenceRate(config, s.rng.seed, s.day);
  const availableKrwMinor = moneyTotal(available, rate), receivableKrwMinor = moneyTotal(receivable, rate);
  const denominator = availableKrwMinor + receivableKrwMinor;
  return { available, receivable, availableKrwMinor, receivableKrwMinor,
    lockedShareBp: denominator > 0 ? divHalfAway(receivableKrwMinor * 10000, denominator) : null };
}

export function balanceSheetAt(s: GameState, config: ScenarioConfig, asOfDay: number) {
  const ledger = ledgerAt(s, asOfDay);
  return { asOfDay, byCurrency: currencies(s, config).map((currency) => {
    const rows = (kind: 'asset' | 'liability' | 'equity') => accounts.filter((a) => ACCOUNT_KIND[a] === kind)
      .map((account) => ({ account, amountMinor: balance(ledger, currency, account) }));
    return { currency, assets: rows('asset'), liabilities: rows('liability'), equity: rows('equity'),
      retainedMinor: summarize(ledger, currency).profit };
  }) };
}

export function settlementKrw(s: GameState, config: ScenarioConfig, asOfDay: number) {
  const ledger = ledgerAt(s, asOfDay);
  if (!config.operations) return null;
  const rateAsOf = referenceRate(config, s.rng.seed, asOfDay);
  const totals = new Map<Account, number>(accounts.map((a) => [a, 0]));
  // 수익·비용·자본은 줄마다 반올림한다. 환전 자본도 분개일 환율을 따른다.
  for (const entry of ledger.entries) {
    const rate = entry.currency === 'USD' ? referenceRate(config, s.rng.seed, entry.day) : rateAsOf;
    for (const line of entry.lines) {
      if (['asset', 'liability'].includes(ACCOUNT_KIND[line.account])) continue;
      totals.set(line.account, totals.get(line.account)! + debitSign(line.account) * krw(entry.currency, line.amount, rate));
    }
  }
  // 자산·부채는 통화별 계정 잔액마다 마감일 환율로 한 번 환산한다.
  for (const currency of currencies(s, config)) for (const account of accounts) {
    if (!['asset', 'liability'].includes(ACCOUNT_KIND[account])) continue;
    totals.set(account, totals.get(account)! + krw(currency, balance(ledger, currency, account), rateAsOf));
  }
  const rows = (...kinds: (typeof ACCOUNT_KIND)[Account][]) => accounts.filter((a) => kinds.includes(ACCOUNT_KIND[a]))
    .map((account) => ({ account, krwMinor: totals.get(account)! }));
  return { asOfDay, rateAsOf, income: rows('income', 'expense'), equity: rows('equity'), assets: rows('asset'), liabilities: rows('liability'),
    fxTranslationKrwMinor: accounts.reduce((sum, account) => sum + debitSign(account) * totals.get(account)!, 0) };
}
