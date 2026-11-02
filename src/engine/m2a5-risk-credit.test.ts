import { describe, expect, it, vi } from 'vitest';
import { loadScenario, OPERATIONS_SCENARIO_IDS, riskProfiles } from '../content/scenario';
import { listSailings, routeBetween } from './catalog';
import { commitDay, createGame, openDay, planState } from './engine';
import { post, summarize, type LedgerEntry } from './ledger';
import { batchZero, generateBatch, offerDef, openTradePairs } from './market';
import { dailyKrwDue, paymentDefaultStatus, usdLotKrw } from './operations';
import { quotePreview } from './readers';
import { campaignSummary, contractReport, contractRiskReport, preview, upcomingPayments } from './reports';
import { receivableSchedule } from './reports-lazy';
import { cashReservations, fundsPosition, runningTaskOf } from './reservations';
import { drawUniform } from './rng';
import { claimFor, collectionPlan, referenceRate, withRiskLevel, type TariffEvent } from './risk';
import { deserializeSave, serializeSave, SaveError } from './save';
import { formatMoney, type Currency } from './money';
import type { Contract, EngineCommand, GameState, Invoice, RiskProfile, ScenarioConfig } from './types';

vi.mock('./rng', async (original) => {
  const m = await original<typeof import('./rng')>();
  return { ...m, drawUniform: vi.fn(m.drawUniform) };
});
vi.mock('./risk', async (original) => {
  const m = await original<typeof import('./risk')>();
  return { ...m, claimFor: vi.fn(m.claimFor), collectionPlan: vi.fn(m.collectionPlan) };
});
const rng = await vi.importActual<typeof import('./rng')>('./rng');
const base = loadScenario(OPERATIONS_SCENARIO_IDS[0]), profile = riskProfiles()[0]!;
const cfgFor = (seed = 2001, p = profile, level: 'R0' | 'R1' | 'R2' | 'R3' = 'R3') => withRiskLevel({ ...base, seed }, level, p);
const half = (n: number, d: number) => Math.sign(n) * Math.floor((2 * Math.abs(n) + d) / (2 * d));
const toKrw = (n: number, r: number) => half(n * r, 100);
const bpAmount = (n: number, bp: number) => half(n * bp, 10000);
const country = (cfg: ScenarioConfig, city: string) => cfg.cities.find((c) => c.id === city)!.countryCode;
const fresh = (cfg: ScenarioConfig) => openDay(createGame(cfg), cfg).state;
const keys = ['K1', 'K2', 'K3'];
// 제품 함수와 독립된 일정·정수 산술 오라클. 원본 난수 함수만 공유한다.
function integer(seed: number, stream: string, a: number, b: number) {
  return a + Math.floor(rng.drawUniform({ seed, cursors: { [stream]: 0 } }, stream).value * (b - a + 1));
}
function oracleRate(cfg: ScenarioConfig, events: TariffEvent[], cc: string, good: string, k: number, t: number, noticeOrder = false) {
  const p = cfg.operations!.risk!.profile.tariff;
  let rate = p.base.find((r) => r.countryCode === cc && r.goodId === good)!.rateBp;
  const relevant = events.filter((e) => e.countryCode === cc && e.noticeDay <= k && e.effectiveDay <= t);
  relevant.sort((a, b) => (noticeOrder ? 0 : a.effectiveDay - b.effectiveDay) || a.noticeDay - b.noticeDay || a.round - b.round);
  for (const e of relevant) rate = Math.min(p.maxBp, Math.max(p.minBp, rate + e.stepBp));
  return rate;
}
function oracleEvents(cfg: ScenarioConfig, seed: number): TariffEvent[] {
  if (!cfg.operations?.risk?.layers.includes('TARIFF')) return [];
  const p = cfg.operations.risk.profile.tariff, kept: TariffEvent[] = [];
  for (const cc of [...new Set(p.base.map((r) => r.countryCode))]) {
    const count = integer(seed, `TARIFF:${cc}:count`, 0, p.maxChanges), raw: TariffEvent[] = [];
    for (let r = 1; r <= count; r++) {
      const lag = integer(seed, `TARIFF:${cc}:${r}:lag`, p.lagDays[0]!, p.lagDays[1]!);
      const n = integer(seed, `TARIFF:${cc}:${r}:notice`, 1, cfg.campaignDays - p.lagDays[1]!);
      raw.push({ countryCode: cc, round: r, noticeDay: n, effectiveDay: n + lag,
        stepBp: integer(seed, `TARIFF:${cc}:${r}:step`, p.stepBp[0]!, p.stepBp[1]!) });
    }
    raw.sort((a, b) => a.noticeDay - b.noticeDay || a.round - b.round);
    for (const e of raw) {
      const rates = p.base.filter((b) => b.countryCode === cc).map((b) => oracleRate(cfg, kept, cc, b.goodId, e.noticeDay, e.effectiveDay));
      if (rates.some((a) => a !== Math.min(p.maxBp, Math.max(p.minBp, a + e.stepBp)))) kept.push(e);
    }
  }
  return kept;
}
function oracleSurcharge(cfg: ScenarioConfig, seed: number, route: string, w: number) {
  if (!cfg.operations?.risk?.layers.includes('SURCHARGE')) return 0;
  const p = cfg.operations.risk.profile.surcharge, key = `SURCHARGE:${route}:${w}`;
  return integer(seed, `${key}:zero`, 0, 9999) < p.pZeroBp ? 0 : integer(seed, `${key}:value`, p.minBp, p.maxBp);
}
function rateAt(cfg: ScenarioConfig, seed: number, day: number) {
  if (!cfg.operations!.risk) return cfg.operations!.fx.baseKrwPerUsd;
  const p = cfg.operations!.risk!.profile.fx, publish = cfg.operations!.market.publish;
  let r = p.startKrwPerUsd;
  if (!cfg.operations!.risk!.layers.includes('FX')) return r;
  const end = Math.max(0, Math.floor((Math.min(day, publish.lastDay) - publish.firstDay) / publish.intervalDays));
  for (let k = 1; k <= end; k++) {
    const u = rng.drawUniform({ seed, cursors: { 'FX-REF': k } }, 'FX-REF').value;
    r = Math.min(p.maxKrwPerUsd, Math.max(p.minKrwPerUsd, half(r * (10000 + Math.floor(u * (2 * p.stepBp + 1)) - p.stepBp), 10000)));
  }
  return r;
}
function oracleDuty(cfg: ScenarioConfig, seed: number, good: string, city: string, t: number, k: number, purchase: number, currency: Currency, valueDay: number) {
  const taxable = currency === 'KRW' ? half(purchase * 100, rateAt(cfg, seed, valueDay)) : purchase;
  const rate = cfg.operations?.risk?.layers.includes('TARIFF')
    ? oracleRate(cfg, oracleEvents(cfg, seed), country(cfg, city), good, k, t) : cfg.terms.dutyRateBasisPoints;
  return bpAmount(taxable, rate);
}
// 현금 줄과 남은 비용을 같은 환율 바구니에 합친 뒤 한 번 환산한다.
function independent(s: GameState, cfg: ScenarioConfig, c: Contract) {
  const day = s.phase === 'ENDED' ? s.operations?.failure?.day ?? cfg.campaignDays : s.day;
  const rate = (d: number) => rateAt(cfg, s.rng.seed, Math.min(d, day));
  const costs = new Map<number, number>(); let total = 0;
  const add = (amount: number, currency: Currency, d: number, cost = true) => {
    if (currency === 'KRW') total += amount;
    else if (!cost) total += toKrw(amount, rate(d));
    else costs.set(rate(d), (costs.get(rate(d)) ?? 0) + amount);
  };
  const entries = s.ledger.entries.filter((e) => e.contractId === c.id && e.day <= day), ids = new Set(entries.map((e) => e.id));
  const settled = s.ledger.entries.filter((e) => e.id.startsWith('SETTLE-') && ids.has(e.id.slice(7)) && e.day <= day);
  for (const e of [...entries, ...settled]) for (const line of e.lines) if (line.account === 'CASH') add(line.amount, e.currency, e.day, !e.id.startsWith('RECEIPT-'));
  const buyCurrency = c.buyOfferId ? offerDef(s, cfg, c.buyOfferId)!.currency : c.currency;
  const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
  const sh = s.shipments.find((v) => v.contractId === c.id), book = s.bookings.find((v) => v.id === c.bookingId && v.status === 'BOOKED');
  const arrival = sh ? Math.max(sh.scheduledArrivalDay, day) : book ? book.departureDay + route.transitDays : listSailings(cfg, route.id, day + 1)[0]?.scheduledArrivalDay ?? day;
  const reduction = (d: number) => Math.min(bpAmount(c.saleAmountMinor, cfg.terms.lateDeliveryCapBasisPoints!), Math.max(0, d - c.deliveryDeadlineDay) * cfg.terms.lateDeliveryPriceReductionMinor);
  if (c.status !== 'CANCELLED') {
    const invoice = s.invoices.find((i) => i.contractId === c.id);
    const receipts = entries.filter((e) => e.id.startsWith('RECEIPT-')).flatMap((e) => e.lines).filter((l) => l.account === 'CASH').reduce((n, l) => n + l.amount, 0);
    const sale = c.saleAmountMinor - (c.deliveredDay !== null ? c.priceReductionMinor : reduction(Math.max(day, sh?.releaseDay ?? arrival + cfg.terms.customsDays)));
    add(invoice ? invoice.amountMinor - receipts : c.status === 'COMPLETED' ? 0 : sale, c.currency, day, false);
    if (!sh && !book) add(-route.bookingFeeMinor, c.currency, day);
    if (c.kind === 'DIRECT_TRADE' && (!sh || sh.dutyMinor === null)) add(-oracleDuty(cfg, s.rng.seed, c.goodId, c.destinationCityId, arrival, day, c.purchaseAmountMinor, buyCurrency, c.acceptedDay), c.currency, day);
  }
  for (const o of s.obligations) if (ids.has(o.id) && o.paidDay === null) add(-o.amountMinor, o.currency, day);
  for (const [r, amount] of costs) total += toKrw(amount, r);
  const first = listSailings(cfg, route.id, c.acceptedDay + 1)[0];
  const duty = c.kind === 'DIRECT_TRADE' ? oracleDuty(cfg, s.rng.seed, c.goodId, c.destinationCityId, first?.scheduledArrivalDay ?? c.acceptedDay, c.acceptedDay, c.purchaseAmountMinor, buyCurrency, c.acceptedDay) : 0;
  const r0 = rate(c.acceptedDay), sale0 = c.saleAmountMinor - (first ? reduction(first.scheduledArrivalDay + cfg.terms.customsDays) : 0);
  const expected = toKrw(sale0, r0) - (buyCurrency === 'KRW' ? c.purchaseAmountMinor : 0)
    - toKrw((buyCurrency === 'USD' ? c.purchaseAmountMinor : 0) + route.bookingFeeMinor + duty, r0);
  return { realized: total, expected };
}
function identity(s: GameState, cfg: ScenarioConfig, id: string) {
  const c = s.contracts.find((v) => v.id === id)!, own = independent(s, cfg, c), report = contractRiskReport(s, cfg, id);
  expect(report.realized).toBe(own.realized); expect(report.expected).toBe(own.expected);
  const { residual, ...stages } = report.components;
  expect(own.realized - own.expected).toBe(Object.values(stages).reduce((n, v) => n + v, 0));
  expect(residual).toBe(0);
  return report;
}

function oracleClaim(cfg: ScenarioConfig, seed: number, key: string, good: string) {
  if (!cfg.operations!.risk!.layers.includes('CLAIM')) return null;
  const p = cfg.operations!.risk!.profile.claims, row = p.byGood.find((r) => r.goodId === good)!;
  if (integer(seed, `CLAIM:${key}:hit`, 0, 9999) >= row.pClaimBp) return null;
  const tier = integer(seed, `CLAIM:${key}:tier`, 0, 9999) < p.minor.weightBp ? 'MINOR' as const : 'MAJOR' as const;
  const range = tier === 'MINOR' ? p.minor : p.major;
  return { tier, rateBp: integer(seed, `CLAIM:${key}:rate`, range.minBp, range.maxBp) };
}
function oracleCollection(cfg: ScenarioConfig, seed: number, key: string, customer: string) {
  if (!cfg.operations!.risk!.layers.includes('COLLECTION')) return { mode: 'ON_TIME', days: 0 };
  const p = cfg.operations!.risk!.profile.collections;
  const grade = p.grades.find((r) => r.grade === p.byCounterparty.find((r) => r.counterpartyId === customer)!.grade)!;
  const v = integer(seed, `COLLECT:${key}:mode`, 0, 9999);
  if (v < grade.pOnTimeBp) return { mode: 'ON_TIME', days: 0 };
  return { mode: v < grade.pOnTimeBp + grade.pLateBp ? 'LATE' : 'PARTIAL', days: integer(seed, `COLLECT:${key}:days`, p.lateMinDays, p.lateMaxDays) };
}
function apply(s: GameState, cfg: ScenarioConfig, cmd: EngineCommand) {
  const r = planState(s, cfg, [cmd]);
  expect(r.results[0], JSON.stringify(cmd)).toMatchObject({ status: 'APPLIED' });
  return r.state;
}
function fund(s: GameState, cfg: ScenarioConfig, purchase = 0) {
  const need = purchase + dailyKrwDue(s, cfg, s.day) - fundsPosition(s, cfg, 'KRW').available;
  if (need <= 0) return s;
  const usdAmountMinor = Math.ceil(need / usdLotKrw(cfg, s)) * cfg.operations!.fx.lotUsdMinor;
  if (usdAmountMinor > fundsPosition(s, cfg, 'USD').available) return s;
  return planState(s, cfg, [{ id: `환전-${s.day}-${s.operations!.exchanges.length}`, type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor }]).state;
}
function step(s: GameState, cfg: ScenarioConfig) { return commitDay(fund(openDay(s, cfg).state, cfg), cfg, []).state; }
type Run = { cfg: ScenarioConfig; states: GameState[]; end: GameState; id: string };
function runFrom(s: GameState, cfg: ScenarioConfig, id = s.contracts.at(-1)!.id): Run {
  const states = [s];
  while (s.phase !== 'ENDED') { s = step(s, cfg); states.push(s); }
  return { cfg, states, end: s, id };
}
type Pair = ReturnType<typeof openTradePairs>[number];
function setup(cfg: ScenarioConfig, pairIndex = 0, later = 0, ahead = false, noEmployee = false) {
  let s = fresh(cfg);
  const pair = openTradePairs(s, cfg)[pairIndex]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
  const sailing = listSailings(cfg, routeBetween(cfg, buy.cityId, sell.cityId)!.id, 2)[later]!;
  const employees = s.employees.filter((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId);
  if (ahead) {
    const f = cfg.offers.find((o) => o.kind === 'forwarding')!;
    const fs = listSailings(cfg, routeBetween(cfg, f.cityId, f.destinationCityId!)!.id, 2)[0]!;
    s = apply(s, cfg, { id: '주선 먼저', type: 'ACCEPT_FORWARDING', offerId: f.id, plan: { employeeId: employees[1]!.id, sailingId: fs.id } });
  }
  s = fund(s, cfg, buy.unitPriceMinor * buy.quantity);
  s = apply(s, cfg, { id: '첫 무역', type: 'ACCEPT_TRADE', ...pair, plan: { sailingId: sailing.id, ...(noEmployee ? {} : { employeeId: employees[0]!.id }) } });
  expect(s.rng.seed).toBe(cfg.seed);
  return { s, cfg, id: s.contracts.at(-1)!.id, pair, sailing };
}
const contract = (r: Run, s = r.end) => s.contracts.find((c) => c.id === r.id)!;
const invoice = (r: Run, s = r.end) => s.invoices.find((i) => i.contractId === r.id)!;
const at = (r: Run, day: number) => r.states.find((s) => s.day === day)!;
const cash = (e: LedgerEntry) => e.lines.filter((l) => l.account === 'CASH').reduce((n, l) => n + l.amount, 0);
const receiptEntries = (s: GameState, inv: Invoice) => s.ledger.entries.filter((e) => e.id === `RECEIPT-RCPT-${inv.id}` || e.id.startsWith(`RECEIPT-RCPT-${inv.id}-`));
const received = (s: GameState, inv: Invoice) => receiptEntries(s, inv).reduce((n, e) => n + cash(e), 0);
const claimEntry = (s: GameState, id: string) => s.ledger.entries.find((e) => e.id === `CLAIM-${id}`);
const allowance = (s: GameState, id: string) => claimEntry(s, id)?.lines.find((l) => l.account === 'SALES_ALLOWANCE')?.amount ?? 0;
const clear = () => { vi.mocked(claimFor).mockClear(); vi.mocked(collectionPlan).mockClear(); };
const noCalls = () => { expect(claimFor).not.toHaveBeenCalled(); expect(collectionPlan).not.toHaveBeenCalled(); };
const rate = (r: Run, day: number) => referenceRate(r.cfg, r.end.rng.seed, day);
const planFor = (r: Run) => collectionPlan(r.cfg, r.end.rng.seed, contract(r).sellOfferId!, contract(r).customerId);
const evidence: Record<string, unknown> = {};
function record(name: string, r: Run, s = r.end) {
  evidence[name] = { seed: r.cfg.seed, invoice: invoice(r, s)?.id, dueDay: invoice(r, s)?.dueDay,
    ...contractRiskReport(s, r.cfg, r.id) };
}
// 첫 쌍 사례만 캐시한다. 공유 무역 실행은 sharedRuns의 첫 호출 때 만든다.
const cases = new Map<string, Run>();
function findCase(name: string, pre: (cfg: ScenarioConfig, pair: Pair, s: GameState) => boolean,
  accept: (r: Run) => boolean = () => true, p = profile, later = 0, allPairs = false): Run {
  const cached = cases.get(name); if (cached) return cached;
  let found: Run | undefined;
  outer: for (let seed = 2001; seed <= 2200; seed++) {
    const cfg = cfgFor(seed, p), s = fresh(cfg), pairs = openTradePairs(s, cfg);
    for (let i = 0; i < (allPairs ? pairs.length : 1); i++) {
      if (!pre(cfg, pairs[i]!, s)) continue;
      const start = setup(cfg, i, later), r = runFrom(start.s, cfg, start.id);
      if (accept(r)) { found = r; break outer; }
    }
  }
  expect(found, name).toBeDefined(); cases.set(name, found!); return found!;
}
function modeCase(mode: 'ON_TIME' | 'LATE' | 'PARTIAL') {
  return findCase(mode, (cfg, pair, s) => {
    const b = offerDef(s, cfg, pair.buyOfferId)!, v = offerDef(s, cfg, pair.sellOfferId)!;
    return !claimFor(cfg, s.rng.seed, v.id, b.goodId) && collectionPlan(cfg, s.rng.seed, v.id, v.counterpartyId).mode === mode;
  });
}
function claimCase(p = profile, name = '클레임', later = 0, allPairs = false) {
  return findCase(name, (cfg, pair, s) => {
    const b = offerDef(s, cfg, pair.buyOfferId)!, v = offerDef(s, cfg, pair.sellOfferId)!;
    return !!claimFor(cfg, s.rng.seed, v.id, b.goodId) && collectionPlan(cfg, s.rng.seed, v.id, v.counterpartyId).mode === 'ON_TIME';
  }, (r) => {
    const c = contract(r), inv = invoice(r); if (!inv) return false;
    const q = claimFor(r.cfg, r.end.rng.seed, c.sellOfferId!, c.goodId)!, sale = c.saleAmountMinor - c.priceReductionMinor;
    return later ? c.priceReductionMinor > 0 && bpAmount(sale, q.rateBp) !== bpAmount(c.saleAmountMinor, q.rateBp)
      && sale * q.rateBp % 10000 >= 5000 : c.deliveredDay !== null && c.deliveredDay <= c.deliveryDeadlineDay && rate(r, c.deliveredDay) !== rate(r, inv.dueDay);
  }, p, later, allPairs);
}
type Picked = { run: Run; state: GameState; inv: Invoice };
function buildTradeRuns() {
  const runs: Run[] = []; let late: Picked | undefined, partial: Picked | undefined, split: Picked | undefined, same: Picked | undefined, sorted: Picked | undefined;
  const times: number[] = [];
  for (let seed = 2001; seed <= 2200 && !(late && partial && split && same && sorted); seed++) {
    const started = performance.now(), cfg = cfgFor(seed); let s = fresh(cfg); const states: GameState[] = [];
    while (s.phase !== 'ENDED') {
      s = fund(openDay(s, cfg).state, cfg);
      for (const pair of openTradePairs(s, cfg)) {
        const employee = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId && !runningTaskOf(s, e.id));
        const b = offerDef(s, cfg, pair.buyOfferId)!, v = offerDef(s, cfg, pair.sellOfferId)!;
        const sailing = listSailings(cfg, routeBetween(cfg, b.cityId, v.cityId)!.id, s.day + 1)[0];
        if (!employee || !sailing) continue;
        const need = b.unitPriceMinor * b.quantity + dailyKrwDue(s, cfg, s.day) - fundsPosition(s, cfg, 'KRW').available;
        if (need > 0) {
          const usdAmountMinor = Math.ceil(need / usdLotKrw(cfg, s)) * cfg.operations!.fx.lotUsdMinor;
          const funding = planState(s, cfg, [{ id: `환전-${s.day}-${s.operations!.exchanges.length}`,
            type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor }]);
          if (funding.results[0]!.status !== 'APPLIED') continue;
          s = funding.state;
        }
        const trial = planState(s, cfg, [{ id: `무역-${s.day}-${pair.sellOfferId}`, type: 'ACCEPT_TRADE', ...pair,
          plan: { employeeId: employee.id, sailingId: sailing.id } }]);
        if (trial.results[0]!.status === 'APPLIED') s = trial.state;
      }
      s = commitDay(s, cfg, []).state; states.push(s);
    }
    const run: Run = { cfg, states, end: s, id: '' }; runs.push(run); times.push(performance.now() - started);
    for (const state of states) {
      const open = state.invoices.filter((i) => i.status !== 'PAID' && state.contracts.find((c) => c.id === i.contractId)!.kind === 'DIRECT_TRADE');
      const ordered = [...open].sort((a, b) => a.dueDay - b.dueDay || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (!sorted && open.length >= 2 && ordered.map((i) => i.id).join() !== [...open].sort((a, b) => a.id < b.id ? -1 : 1).map((i) => i.id).join()) sorted = { run, state, inv: ordered[0]! };
      const evaluation = state.phase === 'ENDED' ? state.operations!.failure?.day ?? cfg.campaignDays : state.day;
      for (const inv of open) {
        const c = state.contracts.find((c) => c.id === inv.contractId)!, receipts = receiptEntries(state, inv);
        const plan = collectionPlan(cfg, state.rng.seed, c.sellOfferId!, c.customerId), dRate = referenceRate(cfg, state.rng.seed, inv.dueDay);
        const picked = { run: { ...run, id: c.id }, state, inv };
        if (state.phase === 'ENDED' && state.operations!.outcome === 'COMPLETED' && inv.dueDay <= cfg.campaignDays && inv.dueDay + plan.days > cfg.campaignDays) {
          if (!late && plan.mode === 'LATE' && receipts.length === 0) late = picked;
          if (!partial && plan.mode === 'PARTIAL' && receipts.length === 1 && cash(receipts[0]!) > 0 && cash(receipts[0]!) < inv.amountMinor) partial = picked;
        }
        if (plan.mode !== 'PARTIAL' || receipts.length !== 1 || receipts[0]!.id !== `RECEIPT-RCPT-${inv.id}-1`) continue;
        const first = cash(receipts[0]!), rest = inv.amountMinor - first;
        if (!(first > 0 && rest > 0) || toKrw(first, dRate) + toKrw(rest, dRate) === toKrw(inv.amountMinor, dRate)) continue;
        if (!split && inv.dueDay < evaluation && referenceRate(cfg, state.rng.seed, evaluation) !== dRate) split = picked;
        if (!same && state.day === inv.dueDay + 1 && referenceRate(cfg, state.rng.seed, inv.dueDay + 1) === dRate) same = picked;
      }
    }
    clear(); vi.mocked(drawUniform).mockClear();
  }
  return { runs, times, late, partial, split, same, sorted };
}
type SharedRuns = ReturnType<typeof buildTradeRuns>;
let sharedCache: { value: SharedRuns } | { error: unknown } | undefined;
function sharedRuns(): SharedRuns {
  if (!sharedCache) {
    try { sharedCache = { value: buildTradeRuns() }; }
    catch (error) { sharedCache = { error }; }
  }
  if ('error' in sharedCache) throw sharedCache.error;
  return sharedCache.value;
}

// 현재 원문의 토큰과 괄호 짝으로 호출의 가장 가까운 블록을 찾는다.
// 문자열·주석 안의 괄호는 무시한다. 일반 제어 흐름 분석 대신 승인된 두 가드 꼴만 인정한다.
function directTradeGuard(body: string, call: string): boolean {
  const tokens = body.match(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|[\w$]+|===|!==|\|\||[^\s]/g)?.filter((t) => !t.startsWith('//') && !t.startsWith('/*')) ?? [];
  const stack: number[] = [], pairs = new Map<number, number>(), parents = new Map<number, number | undefined>();
  const blocks: number[] = [], calls: number[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    parents.set(i, blocks.at(-1));
    if (t === call && tokens[i + 1] === '(') calls.push(i);
    if (t === '(' || t === '{' || t === '[') {
      stack.push(i); if (t === '{') blocks.push(i);
    } else if (t === ')' || t === '}' || t === ']') {
      const start = stack.pop();
      if (start === undefined || tokens[start] !== ({ ')': '(', '}': '{', ']': '[' }[t])) return false;
      pairs.set(start, i); pairs.set(i, start); if (t === '}') blocks.pop();
    }
  }
  if (stack.length || !calls.length) return false;
  const condition = (block: number) => {
    if (tokens[block - 1] !== ')') return '';
    const open = pairs.get(block - 1)!;
    return tokens[open - 1] === 'if' ? tokens.slice(open + 1, block - 1).join('') : '';
  };
  return calls.every((index) => {
    const block = parents.get(index);
    if (block === undefined) return false;
    if (condition(block) === "contract.kind==='DIRECT_TRADE'") return true;
    // 호출과 같은 블록에 있는 조기 탈출만 허용한다. continue는 해당 if의 마지막 직접 문장이어야 한다.
    for (let i = block + 1; i < index; i++) {
      if (tokens[i] !== '{' || parents.get(i) !== block || !condition(i).startsWith("contract.kind!=='DIRECT_TRADE'||")) continue;
      const end = pairs.get(i)!;
      if (end >= index || tokens[end - 2] !== 'continue' || tokens[end - 1] !== ';' || parents.get(end - 2) !== i) continue;
      let loop = false;
      for (let j = end + 1; j < index; j++) if ((tokens[j] === 'for' || tokens[j] === 'while') && tokens[j + 1] === '(') loop = true;
      if (!loop) return true;
    }
    return false;
  });
}

describe('TASK-0064 추첨과 공개 정보', () => {
  it('일정 오라클(클레임·수금): 모든 품목·거래처·키, R2 표 미참조', () => {
    const seen = new Set<string>(), rows: { actual: unknown; expected: unknown }[] = [];
    for (let seed = 2001; seed <= 2200; seed++) {
      const cfg = cfgFor(seed), r2 = cfgFor(seed, profile, 'R2');
      const empty = structuredClone(profile); empty.claims.byGood = []; empty.collections.byCounterparty = [];
      const emptyR2 = cfgFor(seed, empty, 'R2');
      for (const key of keys) {
        for (const row of cfg.operations!.risk!.profile.claims.byGood) {
          const expected = oracleClaim(cfg, seed, key, row.goodId); if (expected) seen.add(expected.tier);
          rows.push({ actual: claimFor(cfg, seed, key, row.goodId), expected });
          rows.push({ actual: claimFor(r2, seed, key, row.goodId), expected: null }, { actual: claimFor(emptyR2, seed, key, row.goodId), expected: null });
        }
        for (const row of profile.collections.byCounterparty) {
          const expected = oracleCollection(cfg, seed, key, row.counterpartyId); seen.add(expected.mode); seen.add(`days:${expected.days}`);
          rows.push({ actual: collectionPlan(cfg, seed, key, row.counterpartyId), expected });
          for (const c of [r2, emptyR2]) rows.push({ actual: collectionPlan(c, seed, key, row.counterpartyId), expected: { mode: 'ON_TIME', days: 0 } });
        }
      }
    }
    for (const outcome of ['MINOR', 'MAJOR', 'ON_TIME', 'LATE', 'PARTIAL', `days:${profile.collections.lateMinDays}`, `days:${profile.collections.lateMaxDays}`]) expect(seen.has(outcome), outcome).toBe(true);
    for (const row of rows) expect(row.actual).toEqual(row.expected);
  }, 60000);
  it('흐름 유일성(클레임·수금): 결과가 정하는 흐름만 커서 0으로', () => {
    const observations: { actual: [string, number][]; expected: [string, number][] }[] = []; let hit = false, days = false;
    for (let seed = 2001; seed <= 2200; seed++) {
      const cfg = cfgFor(seed); vi.mocked(drawUniform).mockClear();
      const results = keys.map((key) => ({ key, claim: claimFor(cfg, seed, key, profile.claims.byGood[0]!.goodId),
        plan: collectionPlan(cfg, seed, key, profile.collections.byCounterparty[0]!.counterpartyId) }));
      const calls = vi.mocked(drawUniform).mock.calls.map(([r, stream]) => [stream, r.cursors[stream] ?? 0] as [string, number]);
      hit ||= calls.some(([k]) => k.endsWith(':rate')); days ||= calls.some(([k]) => k.endsWith(':days'));
      expect(new Set(calls.map((v) => JSON.stringify(v))).size).toBe(calls.length);
      for (const row of results) {
        for (const [prefix, endings] of [[`CLAIM:${row.key}:`, row.claim ? ['hit', 'tier', 'rate'] : ['hit']],
          [`COLLECT:${row.key}:`, row.plan.mode === 'ON_TIME' ? ['mode'] : ['mode', 'days']]] as [string, string[]][]) {
          observations.push({ actual: calls.filter(([k]) => k.startsWith(prefix)).sort(), expected: endings.map((k) => [prefix + k, 0] as [string, number]).sort() });
        }
        expect(calls.every(([k, cursor]) => cursor === 0 && /^(CLAIM:K[123]:(hit|tier|rate)|COLLECT:K[123]:(mode|days))$/.test(k))).toBe(true);
      }
    }
    expect(hit).toBe(true); expect(days).toBe(true);
    for (const row of observations) expect(row.actual).toEqual(row.expected);
  }, 60000);
  it('클레임 층 범위: 생성 판매 견적 모두, 두 층 각각 다섯 건 이상', () => {
    const results: NonNullable<ReturnType<typeof claimFor>>[] = [];
    for (let seed = 2001; seed <= 2200; seed++) {
      const cfg = cfgFor(seed), pub = cfg.operations!.market.publish; let index = batchZero(cfg).index;
      for (let k = 1; k <= (pub.lastDay - pub.firstDay) / pub.intervalDays; k++) {
        const batch = generateBatch(cfg.seed, k, index, cfg); index = batch.batch.index;
        for (const o of batch.offers.filter((o) => o.kind === 'customer')) {
          const result = claimFor(cfg, seed, o.id, o.goodId); if (result) results.push(result);
        }
      }
    }
    for (const tier of ['MINOR', 'MAJOR']) expect(results.filter((r) => r.tier === tier).length).toBeGreaterThanOrEqual(5);
    for (const r of results) { const p = r.tier === 'MINOR' ? profile.claims.minor : profile.claims.major;
      expect(r.rateBp).toBeGreaterThanOrEqual(p.minBp); expect(r.rateBp).toBeLessThanOrEqual(p.maxBp); }
  }, 60000);
  it('등급별 확률: 시작·극단·순서 변경 사본', () => {
    const count = (p: RiskProfile) => p.collections.grades.map((grade) => {
      const customer = p.collections.byCounterparty.find((r) => r.grade === grade.grade)!.counterpartyId;
      let late = 0, partial = 0;
      for (let seed = 2001; seed <= 2200; seed++) { const cfg = cfgFor(seed, p);
        for (const key of keys) { const result = collectionPlan(cfg, seed, key, customer); late += Number(result.mode === 'LATE'); partial += Number(result.mode === 'PARTIAL'); }
      }
      return { late, partial };
    });
    const normal = count(profile);
    for (let i = 1; i < normal.length; i++) for (const key of ['late', 'partial'] as const) expect(normal[i]![key] - normal[i - 1]![key]).toBeGreaterThanOrEqual(10);
    const extreme = structuredClone(profile);
    extreme.collections.grades.forEach((g, i) => { g.pLateBp = i * 5000; g.pPartialBp = 0; g.pOnTimeBp = 10000 - g.pLateBp; });
    const extremes = count(extreme); expect(extremes[0]!.late).toBe(0); expect(extremes[1]!.late).toBeGreaterThan(0); expect(extremes[1]!.late).toBeLessThan(600); expect(extremes[2]!.late).toBe(600);
    const reverse = structuredClone(profile);
    reverse.collections.grades.forEach((g, i) => { g.pLateBp = [3000, 1000, 2000][i]!; g.pPartialBp = 0; g.pOnTimeBp = 10000 - g.pLateBp; });
    const counts = count(reverse); expect(counts[0]!.late).toBeGreaterThan(counts[2]!.late); expect(counts[2]!.late).toBeGreaterThan(counts[1]!.late);
    evidence['등급 횟수'] = { normal, extremes, reverse: counts };
  }, 60000);
  it('R3 변환·riskGrades 키 존재와 공개 등급', () => {
    const r2 = cfgFor(2001, profile, 'R2'), r3 = cfgFor();
    expect(r3.operations!.risk!.layers).toEqual(['FX', 'TARIFF', 'SURCHARGE', 'CLAIM', 'COLLECTION']);
    const withoutLayers = (cfg: ScenarioConfig) => { const copy = structuredClone(cfg); delete (copy.operations!.risk as Partial<NonNullable<typeof copy.operations>['risk']>)!.layers; return copy; };
    expect(withoutLayers(r3)).toEqual(withoutLayers(r2));
    for (const level of ['R0', 'R1', 'R2', 'R3'] as const) {
      const cfg = cfgFor(2001, profile, level), s = fresh(cfg), pair = openTradePairs(s, cfg)[0]!;
      const f = cfg.offers.find((o) => o.kind === 'forwarding')!;
      clear(); const q = quotePreview(s, cfg, pair), fwd = quotePreview(s, cfg, { offerId: f.id }); noCalls();
      if (level === 'R0') { expect('riskGrades' in q).toBe(false); expect('riskGrades' in fwd).toBe(false); }
      else {
        expect(q.riskGrades).toEqual({ damage: profile.claims.byGood.find((r) => r.goodId === offerDef(s, cfg, pair.buyOfferId)!.goodId)!.grade,
          credit: profile.collections.byCounterparty.find((r) => r.counterpartyId === offerDef(s, cfg, pair.sellOfferId)!.counterpartyId)!.grade });
        expect(Object.keys(q.riskGrades!)).toEqual(['damage', 'credit']); expect(fwd.riskGrades).toBeNull();
      }
    }
    const s = fresh(r3), pair = openTradePairs(s, r3)[0]!;
    const q3 = quotePreview(s, r3, pair), q2 = quotePreview(fresh(r2), r2, pair);
    expect(q3.surchargeMaxBp).toBe(q2.surchargeMaxBp); expect(q3.referenceEstimate).toEqual(q2.referenceEstimate);
    const start = setup(r3); let next = start.s;
    const pub = r3.operations!.market.publish;
    while (next.day < pub.firstDay + pub.intervalDays) next = step(next, r3);
    const other = openTradePairs(next, r3).find((p) => profile.collections.byCounterparty.find((r) => r.counterpartyId === offerDef(next, r3, p.sellOfferId)!.counterpartyId)!.grade !== q3.riskGrades!.credit);
    expect(other).toBeDefined(); clear(); const q = quotePreview(next, r3, other!); noCalls();
    expect(q.riskGrades).toEqual({ damage: profile.claims.byGood.find((r) => r.goodId === offerDef(next, r3, other!.buyOfferId)!.goodId)!.grade,
      credit: profile.collections.byCounterparty.find((r) => r.counterpartyId === offerDef(next, r3, other!.sellOfferId)!.counterpartyId)!.grade });
    expect(Object.keys(q.riskGrades!)).toEqual(['damage', 'credit']);
  }, 60000);
  it('원천 검사: 추첨은 인도·결제일의 직접 무역 경로 안에서만', () => {
    const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '');
    for (const [file, raw] of Object.entries(sources)) {
      if (file.endsWith('.test.ts')) continue;
      const src = strip(raw);
      for (const [name, host] of [['claimFor', 'processDeliveries'], ['collectionPlan', 'processCollections']]) {
        const definition = new RegExp(`export function ${name}\\(`, 'g');
        if (definition.test(src)) expect(file).toBe('./risk.ts');
        const calls = src.replace(definition, '').match(new RegExp(`\\b${name}\\(`, 'g')) ?? [];
        if (calls.length) {
          expect(file).toBe('./engine.ts');
          const body = src.slice(src.indexOf(`function ${host}(`)).split(/\n(?:export )?function /)[0]!;
          expect(body.match(new RegExp(`\\b${name}\\(`, 'g'))).toHaveLength(calls.length);
          expect(body).toMatch(new RegExp(`${name}\\(config, s\\.rng\\.seed,`));
          expect(directTradeGuard(body, name!), `${host}: ${name} 직접 무역 가드`).toBe(true);
        }
      }
      if (/CLAIM:|COLLECT:/.test(src)) expect(file).toBe('./risk.ts');
      if (file === './reports.ts' || file === './readers.ts' || file === './readers-lazy.ts' || file === './reports-lazy.ts') {
        expect(src).not.toMatch(/import[^;]*(?:claimFor|collectionPlan|drawAt|drawUniform|['"]\.\/rng['"])/);
      }
    }
    const engine = strip(sources['./engine.ts']!);
    const delivery = engine.slice(engine.indexOf('function processDeliveries(')).split(/\n(?:export )?function /)[0]!;
    const collection = engine.slice(engine.indexOf('function processCollections(')).split(/\n(?:export )?function /)[0]!;
    const withoutDeliveryGuard = delivery.replace("if (contract.kind === 'DIRECT_TRADE') {", '{');
    const withoutCollectionGuard = collection.replace("contract.kind !== 'DIRECT_TRADE' || ", '');
    expect(withoutDeliveryGuard).not.toBe(delivery);
    expect(withoutCollectionGuard).not.toBe(collection);
    expect(directTradeGuard(withoutDeliveryGuard, 'claimFor'), '인도 가드 삭제 사본').toBe(false);
    expect(directTradeGuard(withoutCollectionGuard, 'collectionPlan'), '수금 가드 삭제 사본').toBe(false);
    expect([directTradeGuard(delivery, 'claimFor'), directTradeGuard(collection, 'collectionPlan')], '원문 가드').toEqual([true, true]);
  });
});
function assertClaim(r: Run, late = false) {
  const c = contract(r), inv = invoice(r), cfg = r.cfg, sale = c.saleAmountMinor - c.priceReductionMinor;
  if (!late) expect(c.priceReductionMinor, 'priceReductionMinor').toBe(0);
  const draw = claimFor(cfg, r.end.rng.seed, c.sellOfferId!, c.goodId)!;
  expect(draw).not.toBeNull(); expect(planFor(r).mode).toBe('ON_TIME');
  const x = bpAmount(sale, draw.rateBp), delivered = at(r, c.deliveredDay! + 1);
  const entry = claimEntry(delivered, c.id)!;
  expect(delivered.ledger.entries.filter((e) => e.id === entry.id)).toHaveLength(1);
  expect(entry).toMatchObject({ day: c.deliveredDay, contractId: c.id, currency: c.currency,
    lines: [{ account: 'SALES_ALLOWANCE', amount: x }, { account: 'ACCOUNTS_RECEIVABLE', amount: -x }] });
  const saleEntry = delivered.ledger.entries.find((e) => e.id === `SALE-${c.id}`)!;
  expect(saleEntry.lines.find((l) => l.account === 'ACCOUNTS_RECEIVABLE')!.amount).toBe(sale);
  expect(delivered.ledger.entries.indexOf(saleEntry)).toBeLessThan(delivered.ledger.entries.indexOf(entry));
  expect(inv.amountMinor).toBe(sale - x);
  if (late) {
    const reduction = cfg.terms.lateDeliveryBasis === 'PER_LATE_DAY_CAPPED'
      ? Math.min(cfg.terms.lateDeliveryPriceReductionMinor * c.lateDays, bpAmount(c.saleAmountMinor, cfg.terms.lateDeliveryCapBasisPoints!))
      : cfg.terms.lateDeliveryPriceReductionMinor;
    expect(c.priceReductionMinor).toBe(reduction);
    expect(sale * draw.rateBp % 10000).toBeGreaterThanOrEqual(5000);
    expect(x).not.toBe(bpAmount(c.saleAmountMinor, draw.rateBp));
  }
  const logs = delivered.log.filter((l) => l.day === c.deliveredDay).map((l) => l.textKo);
  const position = logs.findIndex((t) => t.includes(c.id) && t.includes('수금 예정'));
  expect(position).toBeGreaterThanOrEqual(0);
  expect(logs[position]).toContain(`매출 ${formatMoney(c.currency, sale)}는 채권으로 남고 현금은 ${inv.dueDay}일 수금 예정`);
  expect(logs[position + 1]).toBe(`${c.id} 화물 일부 손상: 고객이 대금 ${formatMoney(c.currency, x)} 감액 청구`);
  const b = summarize(delivered.ledger, 'USD');
  expect(b.totalAssets - b.accountsPayable).toBe(b.openingEquity + b.profit + b.currencyTransferNet);
  const receipt = receiptEntries(at(r, inv.dueDay + 1), inv);
  expect(receipt).toHaveLength(1); expect(receipt[0]!.id).toBe(`RECEIPT-RCPT-${inv.id}`); expect(cash(receipt[0]!)).toBe(sale - x);
  const report = identity(at(r, inv.dueDay + 1), cfg, c.id);
  expect(report.components.claim).toBe(toKrw(sale - x, rate(r, inv.dueDay)) - toKrw(sale, rate(r, inv.dueDay)));
  expect(report.components.cancel).toBe(0); expect(report.components.collection).toBe(0);
  record(late ? '클레임 늦은 인도' : draw.tier === 'MAJOR' ? '클레임 큰 층' : '클레임 정시', r, at(r, inv.dueDay + 1));
}
function assertCollection(r: Run, mode: 'LATE' | 'PARTIAL') {
  const c = contract(r), inv = invoice(r), plan = planFor(r), d = inv.dueDay, end = d + plan.days;
  expect(plan.mode).toBe(mode); expect(c.deliveredDay!).toBeLessThan(d); expect(end).toBeLessThanOrEqual(r.cfg.campaignDays);
  const first = mode === 'PARTIAL' ? bpAmount(inv.amountMinor, r.cfg.operations!.risk!.profile.collections.partialBp) : 0;
  const middle = at(r, d + 1), mi = invoice(r, middle), receipts = receiptEntries(middle, mi);
  expect(mi.status).toBe('OVERDUE'); expect(contract(r, middle).status).not.toBe('COMPLETED');
  expect(mi.receiptIds).toEqual(mode === 'PARTIAL' ? [`RCPT-${inv.id}-1`] : []);
  expect(receipts).toHaveLength(mode === 'PARTIAL' ? 1 : 0);
  if (mode === 'PARTIAL') { expect(receipts[0]).toMatchObject({ day: d, contractId: c.id }); expect(cash(receipts[0]!)).toBe(first); }
  for (let day = d + 1; day <= end; day++) {
    const s = at(r, day);
    expect(receivableSchedule(s, r.cfg).find((i) => i.invoiceId === inv.id)).toEqual({ invoiceId: inv.id, contractId: c.id,
      currency: inv.currency, dueDay: d, outstandingMinor: inv.amountMinor - first, overdueDays: day - d });
    expect(campaignSummary(s, r.cfg).openInvoices.find((i) => i.invoiceId === inv.id)!.amountMinor).toBe(inv.amountMinor - first);
  }
  const done = at(r, end + 1), entries = receiptEntries(done, inv), last = entries.at(-1)!;
  expect(last).toMatchObject({ id: `RECEIPT-RCPT-${inv.id}${mode === 'PARTIAL' ? '-2' : ''}`, day: end, contractId: c.id });
  expect(cash(last)).toBe(inv.amountMinor - first); expect(received(done, inv)).toBe(inv.amountMinor);
  expect(invoice(r, done)).toMatchObject({ status: 'PAID', receiptIds: mode === 'PARTIAL' ? [`RCPT-${inv.id}-1`, `RCPT-${inv.id}-2`] : [`RCPT-${inv.id}`] });
  expect(contract(r, done)).toMatchObject({ status: 'COMPLETED', completedDay: end });
  expect(receivableSchedule(done, r.cfg).find((i) => i.invoiceId === inv.id)).toBeUndefined();
  expect(done.log.find((l) => l.day === c.deliveredDay && l.textKo.includes(c.id) && l.textKo.includes('수금 예정'))!.textKo).toContain(`현금은 ${d}일 수금 예정`);
  for (let day = d; day <= end; day++) {
    const rows = done.log.filter((l) => l.day === day && l.textKo.includes(c.id)).map((l) => l.textKo);
    const expected = day === d ? mode === 'PARTIAL'
      ? [`${c.id} 대금 일부 ${formatMoney(inv.currency, first)} 수금(남은 ${formatMoney(inv.currency, inv.amountMinor - first)})`]
      : [`${c.id} 결제일에 대금이 들어오지 않음(남은 ${formatMoney(inv.currency, inv.amountMinor)})`]
      : day === end ? [`${c.id} 대금 ${mode === 'PARTIAL' ? '나머지 ' : ''}${formatMoney(inv.currency, inv.amountMinor - first)} 수금. 계약 종결`] : [];
    expect(rows, `수금 로그 ${day}`).toEqual(expected);
  }
  record(`${mode} 첫 수금 뒤`, r, middle); record(`${mode} 완료`, r, done);
}
describe('TASK-0064 엔진 처리', () => {
  it('새 층이 꺼진 R2: 정시 전액·로그·커서·채권 일정', () => {
    const cfg = cfgFor(2001, profile, 'R2'), start = setup(cfg), r = runFrom(start.s, cfg), inv = invoice(r);
    expect(r.end.ledger.entries.some((e) => e.id.startsWith('CLAIM-'))).toBe(false);
    expect(invoice(r, at(r, inv.dueDay + 1))).toMatchObject({ status: 'PAID', receiptIds: [`RCPT-${inv.id}`] });
    expect(cash(receiptEntries(r.end, inv)[0]!)).toBe(inv.amountMinor);
    let beforeDueStates = 0;
    for (const s of r.states) {
      expect(s.invoices.some((i) => i.status === 'OVERDUE')).toBe(false);
      expect(Object.keys(s.rng.cursors).some((k) => /^(CLAIM:|COLLECT:)/.test(k))).toBe(false);
      expect(s.log.some((l) => /결제일에 대금이 들어오지 않음|대금 일부|대금 나머지|화물 일부 손상/.test(l.textKo))).toBe(false);
      if (s.invoices.length && s.day < inv.dueDay) {
        beforeDueStates++;
        expect(receivableSchedule(s, cfg)).toEqual([{ invoiceId: inv.id, contractId: inv.contractId, currency: inv.currency,
          dueDay: inv.dueDay, outstandingMinor: inv.amountMinor, overdueDays: 0 }]);
        expect(campaignSummary(s, cfg).openInvoices[0]!.amountMinor).toBe(inv.amountMinor);
      }
    }
    expect(beforeDueStates, '결제일 전 채권 상태 수').toBeGreaterThanOrEqual(1);
    expect(receivableSchedule(r.end, cfg)).toEqual([]); cases.set('R2', r);
  }, 60000);
  it('클레임 (가): 정시 인도·정시 수금·분개·로그 순서·순자산', () => assertClaim(claimCase()), 60000);
  it('클레임 (나): 늦은 감액 뒤 기준·half-up·6단계 정확식', () => assertClaim(claimCase(profile, '늦은 클레임', 1, true), true), 60000);
  it('클레임 (다): 큰 층 사본의 엔진 금액·순자산', () => {
    const p = structuredClone(profile); p.claims.minor.weightBp = 0; p.claims.major.weightBp = 10000;
    const r = claimCase(p, '큰 층'), c = contract(r), result = claimFor(r.cfg, r.end.rng.seed, c.sellOfferId!, c.goodId)!;
    expect(result.tier).toBe('MAJOR'); expect(result.rateBp).toBeGreaterThanOrEqual(p.claims.major.minBp); expect(result.rateBp).toBeLessThanOrEqual(p.claims.major.maxBp); assertClaim(r);
  }, 60000);
  it('지연: D+1 연체·계획일 전액·고정 로그', () => assertCollection(modeCase('LATE'), 'LATE'), 60000);
  it('부분 (가): 남은 금액·두 분개·마지막 종결·고정 로그', () => assertCollection(modeCase('PARTIAL'), 'PARTIAL'), 60000);
  it('부분 (나): 2500bp 사본의 반올림과 나머지 뺄셈', () => {
    const p = structuredClone(profile); p.claims.byGood.forEach((r) => r.pClaimBp = 10000);
    p.collections.grades.forEach((r) => { r.pOnTimeBp = r.pLateBp = 0; r.pPartialBp = 10000; }); p.collections.partialBp = 2500;
    const r = findCase('부분 반올림', () => true, (r) => {
      const inv = invoice(r); return !!inv && bpAmount(inv.amountMinor, p.collections.partialBp) !== Math.floor(inv.amountMinor * p.collections.partialBp / 10000);
    }, p);
    const inv = invoice(r), first = bpAmount(inv.amountMinor, p.collections.partialBp);
    expect(first).not.toBe(Math.floor(inv.amountMinor * p.collections.partialBp / 10000)); expect(first).not.toBe(Math.floor(inv.amountMinor / 2));
    expect(cash(receiptEntries(at(r, inv.dueDay + 1), inv)[0]!)).toBe(first);
    expect(cash(receiptEntries(r.end, inv)[1]!)).toBe(inv.amountMinor - first);
    record('부분 반올림 사본', r);
  }, 60000);
  it.each(['claim', 'plan'] as const)('공통 난수: 주선 선행 뒤 다른 계약 ID, %s의 실제 엔진 관측', (kind) => {
    let found: { a: Run; b: Run } | undefined;
    for (let seed = 2001; seed <= 2200; seed++) {
      const cfg = cfgFor(seed), a = setup(cfg), b = setup(cfg, 0, 0, true);
      const ca = a.s.contracts.find((c) => c.id === a.id)!, cb = b.s.contracts.find((c) => c.id === b.id)!;
      const first = kind === 'claim' ? claimFor(cfg, seed, ca.id, ca.goodId) : collectionPlan(cfg, seed, ca.id, ca.customerId);
      const second = kind === 'claim' ? claimFor(cfg, seed, cb.id, cb.goodId) : collectionPlan(cfg, seed, cb.id, cb.customerId);
      if (JSON.stringify(first) === JSON.stringify(second)) continue;
      found = { a: runFrom(a.s, cfg, a.id), b: runFrom(b.s, cfg, b.id) }; break;
    }
    expect(found).toBeDefined(); const { a, b } = found!, ca = contract(a), cb = contract(b), ia = invoice(a), ib = invoice(b);
    expect(ca.id).not.toBe(cb.id); expect(ca.sellOfferId).toBe(cb.sellOfferId);
    expect([ca.deliveredDay, ca.priceReductionMinor, ia.dueDay]).toEqual([cb.deliveredDay, cb.priceReductionMinor, ib.dueDay]);
    if (kind === 'claim') expect(ca.saleAmountMinor - ca.priceReductionMinor).toBeGreaterThanOrEqual(10000);
    const observed: unknown[] = [];
    for (const r of [a, b]) {
      const c = contract(r), inv = invoice(r), claim = claimFor(r.cfg, r.end.rng.seed, c.sellOfferId!, c.goodId), plan = planFor(r);
      expect(inv.dueDay + plan.days).toBeLessThanOrEqual(r.cfg.campaignDays);
      const x = claim ? bpAmount(c.saleAmountMinor - c.priceReductionMinor, claim.rateBp) : 0;
      const expectedIds = plan.mode === 'PARTIAL' ? [`RCPT-${inv.id}-1`, `RCPT-${inv.id}-2`] : [`RCPT-${inv.id}`];
      expect(!!claimEntry(r.end, c.id)).toBe(x > 0); expect(allowance(r.end, c.id)).toBe(x); expect(inv.receiptIds).toEqual(expectedIds);
      const delays = receiptEntries(r.end, inv).map((e) => e.day - inv.dueDay);
      expect(delays).toEqual(plan.mode === 'PARTIAL' ? [0, plan.days] : [plan.days]);
      observed.push([!!claimEntry(r.end, c.id), allowance(r.end, c.id), inv.receiptIds.map((v) => v.slice(`RCPT-${inv.id}`.length)), delays]);
    }
    expect(observed[0]).toEqual(observed[1]); evidence[`공통 난수 ${kind}`] = { seed: a.cfg.seed, k1: ca.id, k2: cb.id, observation: observed[0] };
  }, 60000);
});
function readAll(s: GameState, cfg: ScenarioConfig) {
  return JSON.stringify([receivableSchedule(s, cfg), campaignSummary(s, cfg), paymentDefaultStatus(s, cfg),
    fundsPosition(s, cfg, 'KRW'), fundsPosition(s, cfg, 'USD'), cashReservations(s, cfg), upcomingPayments(s, cfg),
    s.contracts.map((c) => contractReport(s, c)), s.contracts.map((c) => contractRiskReport(s, cfg, c.id))]);
}
function changedRateCase(mode: 'LATE' | 'PARTIAL') {
  return findCase(`다른 환율 ${mode}`, (cfg, pair, s) => {
    const b = offerDef(s, cfg, pair.buyOfferId)!, v = offerDef(s, cfg, pair.sellOfferId)!;
    return !claimFor(cfg, s.rng.seed, v.id, b.goodId) && collectionPlan(cfg, s.rng.seed, v.id, v.counterpartyId).mode === mode;
  }, (r) => {
    const inv = invoice(r), c = contract(r), plan = planFor(r); if (!inv) return false;
    return inv.dueDay + plan.days <= r.cfg.campaignDays && rate(r, inv.dueDay + plan.days) !== rate(r, inv.dueDay)
      && rate(r, c.acceptedDay) !== rate(r, inv.dueDay)
      && r.states.some((s) => s.day > inv.dueDay && s.day < inv.dueDay + plan.days && rate(r, s.day) !== rate(r, inv.dueDay));
  });
}
function openChanged(r: Run) {
  const inv = invoice(r), plan = planFor(r);
  const s = r.states.find((s) => s.day > inv.dueDay && s.day < inv.dueDay + plan.days && rate(r, s.day) !== rate(r, inv.dueDay));
  expect(s).toBeDefined(); return s!;
}
function collectionValue(s: GameState, r: Run) {
  const inv = invoice(r, s), e = s.phase === 'ENDED' ? s.operations!.failure?.day ?? r.cfg.campaignDays : s.day;
  const receivedKrw = receiptEntries(s, inv).reduce((n, entry) => n + toKrw(cash(entry), rate(r, Math.min(entry.day, e))), 0);
  return receivedKrw + toKrw(inv.amountMinor - received(s, inv), rate(r, e)) - toKrw(inv.amountMinor, rate(r, Math.min(inv.dueDay, e)));
}
describe('TASK-0064 미래 정보와 단계별 손익', () => {
  it('미래 누설 없음: 손상 없는 세 방식의 결제일 전 행 정확값', () => {
    const runs = (['ON_TIME', 'LATE', 'PARTIAL'] as const).map(modeCase);
    expect(new Set(runs.map((r) => contract(r).sellOfferId)).size).toBe(1);
    expect(new Set(runs.map((r) => invoice(r).dueDay)).size).toBe(1);
    for (const r of runs.slice(1)) expect(planFor(r).days).toBeGreaterThanOrEqual(1);
    const comparable: unknown[][] = [];
    for (const r of runs) {
      const inv = invoice(r), states = r.states.filter((s) => s.invoices.length && s.day < inv.dueDay);
      expect(states.length).toBeGreaterThan(0); const rows: unknown[] = [];
      for (const s of states) {
        const expected = { invoiceId: inv.id, contractId: inv.contractId, currency: inv.currency, dueDay: inv.dueDay, outstandingMinor: inv.amountMinor, overdueDays: 0 };
        expect(receivableSchedule(s, r.cfg)).toEqual([expected]);
        const { invoiceId: _, contractId: __, ...rest } = receivableSchedule(s, r.cfg)[0]!; rows.push([s.day, rest]);
        expect(campaignSummary(s, r.cfg).openInvoices[0]!.amountMinor).toBe(inv.amountMinor);
        const report = contractRiskReport(s, r.cfg, r.id); expect(report.components.collection).toBe(0); expect(report.components.open_valuation).toBe(0);
      }
      comparable.push(rows); evidence[`미래 누설 ${planFor(r).mode}`] = r.cfg.seed;
    }
    expect(comparable[0]).toEqual(comparable[1]); expect(comparable[0]).toEqual(comparable[2]);
  }, 60000);
  it('미래 누설 없음(로그·상태): 다섯 사본, 전체 저장과 읽기 JSON 대조', () => {
    const l = profile.collections.lateMinDays;
    const runs = (['ON_TIME', 'LATE', 'LATE', 'PARTIAL', 'PARTIAL'] as const).map((mode, i) => {
      const p = structuredClone(profile); p.collections.lateMinDays = p.collections.lateMaxDays = l + Number(i === 2 || i === 4);
      for (const g of p.collections.grades) { g.pOnTimeBp = mode === 'ON_TIME' ? 10000 : 0; g.pLateBp = mode === 'LATE' ? 10000 : 0; g.pPartialBp = mode === 'PARTIAL' ? 10000 : 0; }
      const cfg = cfgFor(2001, p), start = setup(cfg); return runFrom(start.s, cfg);
    });
    const d = invoice(runs[0]!).dueDay;
    for (const r of runs) { expect(contract(r).kind).toBe('DIRECT_TRADE'); expect(contract(r).deliveredDay!).toBeLessThan(d); expect(d + l + 1).toBeLessThanOrEqual(r.cfg.campaignDays); }
    const dates = runs.map((r) => receiptEntries(r.end, invoice(r)).map((e) => e.day));
    expect(dates).toEqual([[d], [d + l], [d + l + 1], [d, d + l], [d, d + l + 1]]);
    for (const [a, b, last] of [[0, 1, d - 1], [0, 3, d - 1], [1, 2, d + l - 1], [3, 4, d + l - 1]]) {
      for (let closed = 1; closed <= last!; closed++) {
        const x = at(runs[a!]!, closed + 1), y = at(runs[b!]!, closed + 1);
        expect(serializeSave(x)).toBe(serializeSave(y)); expect(readAll(x, runs[a!]!.cfg)).toBe(readAll(y, runs[b!]!.cfg));
      }
    }
    for (const [a, b, day] of [[0, 1, d], [1, 2, d + l], [3, 4, d + l]]) {
      expect(serializeSave(at(runs[a!]!, day! + 1))).not.toBe(serializeSave(at(runs[b!]!, day! + 1)));
      expect(readAll(at(runs[a!]!, day! + 1), runs[a!]!.cfg)).not.toBe(readAll(at(runs[b!]!, day! + 1), runs[b!]!.cfg));
    }
  }, 60000);
  it('미래 누설 없음(클레임): 출항 전·운송 중 0, 인도 뒤 양성 대조', () => {
    const r = claimCase(), c = contract(r), inv = invoice(r);
    expect(claimFor(r.cfg, r.end.rng.seed, c.sellOfferId!, c.goodId)).not.toBeNull();
    const transit = r.states.find((s) => s.shipments.length && contract(r, s).deliveredDay === null);
    expect(transit).toBeDefined();
    for (const s of [r.states[0]!, transit!]) {
      expect(contract(r, s).deliveredDay).toBeNull(); expect(claimEntry(s, c.id)).toBeUndefined();
      clear(); const report = contractRiskReport(s, r.cfg, c.id); expect(claimFor).not.toHaveBeenCalled(); expect(report.components.claim).toBe(0);
    }
    for (const s of [at(r, c.deliveredDay! + 1), at(r, inv.dueDay + 1)]) {
      const report = contractRiskReport(s, r.cfg, c.id), sale = c.saleAmountMinor - c.priceReductionMinor, x = allowance(s, c.id), fx = rate(r, Math.min(inv.dueDay, report.evaluationDay));
      expect(report.components.claim).not.toBe(0); expect(report.components.claim).toBe(toKrw(sale - x, fx) - toKrw(sale, fx));
    }
    record('운송 중 ⑨', r, transit!);
  }, 60000);
  it('연체 미수 평가 (가): 받은 금액 0·다른 환율의 열린 지연 채권', () => {
    const r = changedRateCase('LATE'), s = openChanged(r), inv = invoice(r, s);
    expect(received(s, inv)).toBe(0); expect(rate(r, s.day)).not.toBe(rate(r, inv.dueDay));
    const expected = toKrw(inv.amountMinor - received(s, inv), rate(r, s.day)) - toKrw(inv.amountMinor - received(s, inv), rate(r, inv.dueDay));
    expect(expected).not.toBe(0); const report = identity(s, r.cfg, r.id);
    expect(report.components.collection).toBe(expected); expect(report.components.open_valuation).toBe(0); record('연체 미수 평가 지연', r, s);
  }, 60000);
  it('연체 미수 평가 (나): 공유 실행의 부분 수금 줄별 반올림', () => {
    const shared = sharedRuns();
    expect(shared.split).toBeDefined(); const { run: r, state: s, inv } = shared.split!;
    const entries = receiptEntries(s, inv), first = cash(entries[0]!), rest = inv.amountMinor - first;
    expect(entries.map((e) => e.id)).toEqual([`RECEIPT-RCPT-${inv.id}-1`]);
    expect(s.day).toBeGreaterThan(inv.dueDay); expect(first).toBeGreaterThan(0); expect(first).toBeLessThan(inv.amountMinor);
    expect(rate(r, s.day)).not.toBe(rate(r, inv.dueDay));
    expect(toKrw(first, rate(r, inv.dueDay)) + toKrw(rest, rate(r, inv.dueDay))).not.toBe(toKrw(inv.amountMinor, rate(r, inv.dueDay)));
    const report = identity(s, r.cfg, inv.contractId); expect(report.components.collection).toBe(collectionValue(s, r)); expect(report.components.open_valuation).toBe(0);
    record('연체 미수 평가 부분', r, s);
  }, 60000);
  it('미래 누설 없음(호출 없음): 읽기·결제일 전 마감·양성 대조', () => {
    const shared = sharedRuns();
    expect(shared.late).toBeDefined();
    const runs = [modeCase('LATE'), modeCase('PARTIAL')];
    for (const r of runs) {
      const inv = invoice(r); expect(['LATE', 'PARTIAL']).toContain(planFor(r).mode);
      const before = r.states.find((s) => s.invoices.length && s.day < inv.dueDay); expect(before).toBeDefined();
      for (const s of [before!, at(r, inv.dueDay + 1), shared.late!.state]) {
        const cfg = s === shared.late!.state ? shared.late!.run.cfg : r.cfg;
        clear(); s.contracts.forEach((c) => contractRiskReport(s, cfg, c.id)); receivableSchedule(s, cfg); campaignSummary(s, cfg); noCalls();
      }
    }
    const r = runs[0]!, cfg = r.cfg, c = contract(r), inv = invoice(r); expect(c.deliveredDay!).toBeLessThan(inv.dueDay);
    let s = fresh(cfg), pair = openTradePairs(s, cfg)[0]!, b = offerDef(s, cfg, pair.buyOfferId)!, v = offerDef(s, cfg, pair.sellOfferId)!;
    clear(); const q = quotePreview(s, cfg, pair); expect(q.riskGrades).not.toBeNull();
    preview(cfg, 'DIRECT_TRADE', b.cityId, v.cityId, s.day, { purchase: b.unitPriceMinor * b.quantity, sale: v.unitPriceMinor * b.quantity }, v.deliveryDeadlineDay!, v.paymentDueDay!, { goodId: b.goodId, purchaseCurrency: b.currency }); noCalls();
    s = setup(cfg).s; let sawClaim = false;
    while (s.day < inv.dueDay) {
      s = fund(openDay(s, cfg).state, cfg); const day = s.day; clear(); s = commitDay(s, cfg, []).state;
      expect(vi.mocked(collectionPlan).mock.calls.filter((args) => args[2] === c.sellOfferId)).toHaveLength(0);
      if (day === c.deliveredDay) { expect(claimFor).toHaveBeenCalledWith(cfg, s.rng.seed, c.sellOfferId, c.goodId); sawClaim = true; }
    }
    expect(sawClaim).toBe(true); expect(s.day).toBe(inv.dueDay);
    s = fund(openDay(s, cfg).state, cfg); clear(); commitDay(s, cfg, []);
    expect(collectionPlan).toHaveBeenCalledWith(cfg, s.rng.seed, c.sellOfferId, c.customerId);
  }, 60000);
  it('클레임 계약 보고서: 순매출·기여·통화별 합과 기존 키', () => {
    const r = claimCase(), r2 = (() => { const cfg = cfgFor(2001, profile, 'R2'); return runFrom(setup(cfg).s, cfg); })();
    for (const run of [r, r2]) {
      const s = run.end, c = contract(run), sale = c.saleAmountMinor - c.priceReductionMinor, x = allowance(s, c.id);
      const cogs = s.ledger.entries.filter((e) => e.contractId === c.id && e.id.startsWith('COGS-') && e.currency === 'USD')
        .flatMap((e) => e.lines).filter((l) => l.account === 'COST_OF_GOODS_SOLD').reduce((n, l) => n + l.amount, 0);
      expect(contractReport(s, c).netRevenue).toBe(sale - x); expect(contractReport(s, c).contribution).toBe(sale - x - cogs);
      expect(campaignSummary(s, run.cfg).byCurrency.find((b) => b.currency === 'USD')!.contractContribution).toBe(sale - x - cogs);
    }
    const rules2 = { ...base, seed: 2001 }, plain = runFrom(setup(rules2).s, rules2);
    expect(Object.keys(campaignSummary(r.end, r.cfg).byCurrency[0]!)).toEqual(Object.keys(campaignSummary(plain.end, rules2).byCurrency[0]!));
    const before = at(r, contract(r).deliveredDay! + 1), plainBefore = at(plain, contract(plain).deliveredDay! + 1);
    expect(Object.keys(campaignSummary(before, r.cfg).openInvoices[0]!)).toEqual(Object.keys(campaignSummary(plainBefore, rules2).openInvoices[0]!));
  }, 60000);
});
function forwardingCase(known: boolean): Run {
  const key = `주선-${known}`, old = cases.get(key); if (old) return old;
  const cfg = cfgFor(); let s = fresh(cfg);
  const find = () => (known ? s.operations!.offers : cfg.offers).find((o) => o.kind === 'forwarding'
    && s.offers.some((v) => v.id === o.id && v.status === 'OPEN') && profile.claims.byGood.some((r) => r.goodId === o.goodId) === known);
  while (known && !find() && s.phase !== 'ENDED') s = step(s, cfg);
  s = openDay(s, cfg).state;
  const f = find();
  expect(f).toBeDefined(); expect(profile.collections.byCounterparty.some((r) => r.counterpartyId === f!.counterpartyId)).toBe(false);
  const employee = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId)!;
  const sailings = listSailings(cfg, routeBetween(cfg, f!.cityId, f!.destinationCityId!)!.id, s.day + 1);
  let result: Run | undefined;
  for (const sailing of sailings) {
    const trial = planState(s, cfg, [{ id: '주선', type: 'ACCEPT_FORWARDING', offerId: f!.id, plan: { employeeId: employee.id, sailingId: sailing.id } }]);
    if (trial.results[0]!.status !== 'APPLIED') continue;
    clear(); const r = runFrom(trial.state, cfg); noCalls();
    if (contract(r).status === 'COMPLETED') { result = r; break; }
  }
  expect(result).toBeDefined(); cases.set(key, result!); return result!;
}
function roundtrip(s: GameState, cfg: ScenarioConfig) {
  return deserializeSave(serializeSave(s), { config: cfg, dataVersion: cfg.dataVersion, rulesVersion: cfg.rules.rulesVersion });
}
describe('TASK-0064 저장·불변식·마감', () => {
  it('프로필 누락: 추첨 전 예외, R2 미참조, 인도·결제·등급 읽기', () => {
    const cfg = cfgFor(), s = fresh(cfg), pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    const p1 = structuredClone(profile), p2 = structuredClone(profile);
    p1.claims.byGood = p1.claims.byGood.filter((r) => r.goodId !== buy.goodId);
    p2.collections.byCounterparty = p2.collections.byCounterparty.filter((r) => r.counterpartyId !== sell.counterpartyId);
    for (const [p, kind] of [[p1, 'claim'], [p2, 'collection']] as const) {
      const c = cfgFor(2001, p), r2 = cfgFor(2001, p, 'R2');
      vi.mocked(drawUniform).mockClear();
      expect(() => kind === 'claim' ? claimFor(c, s.rng.seed, sell.id, buy.goodId) : collectionPlan(c, s.rng.seed, sell.id, sell.counterpartyId)).toThrow();
      expect(drawUniform).not.toHaveBeenCalled();
      expect(claimFor(r2, s.rng.seed, sell.id, buy.goodId)).toBeNull(); expect(collectionPlan(r2, s.rng.seed, sell.id, sell.counterpartyId)).toEqual({ mode: 'ON_TIME', days: 0 });
      expect(() => quotePreview(s, c, pair)).toThrow();
      const f = cfg.offers.find((o) => o.kind === 'forwarding')!; expect(quotePreview(s, c, { offerId: f.id }).riskGrades).toBeNull();
      const normal = modeCase('ON_TIME'), target = kind === 'claim' ? contract(normal).deliveredDay! : invoice(normal).dueDay;
      let state = setup(c).s;
      while (state.day < target) state = step(state, c);
      expect(state.day).toBe(target); expect(() => step(state, c)).toThrow();
    }
    const noGrade = structuredClone(profile); noGrade.collections.grades = [];
    expect(() => collectionPlan(cfgFor(2001, noGrade), 2001, sell.id, sell.counterpartyId)).toThrow('신용등급');
  }, 60000);
  it.each([false, true])('주선(R3): 프로필 품목 존재 %s, 두 추첨 호출 0·정시 전액·단계 0', (known) => {
    const r = forwardingCase(known), c = contract(r), inv = invoice(r);
    expect(c.status).toBe('COMPLETED'); expect(c.kind).toBe('FORWARDING');
    expect(r.end.ledger.entries.some((e) => e.id.startsWith('CLAIM-'))).toBe(false);
    expect(inv.receiptIds).toEqual([`RCPT-${inv.id}`]); const entries = receiptEntries(r.end, inv);
    expect(entries).toHaveLength(1); expect(entries[0]!.day).toBe(inv.dueDay); expect(cash(entries[0]!)).toBe(inv.amountMinor);
    for (const s of r.states) expect(s.invoices.some((i) => i.status === 'OVERDUE')).toBe(false);
    const transit = r.states.find((s) => s.shipments.length && contract(r, s).deliveredDay === null), delivered = r.states.find((s) => s.invoices.some((i) => i.status !== 'PAID'));
    expect(transit).toBeDefined(); expect(delivered).toBeDefined();
    for (const s of [r.states[0]!, transit!, delivered!, r.end]) {
      const report = identity(s, r.cfg, c.id);
      for (const key of ['tariff', 'surcharge', 'claim', 'collection', 'residual'] as const) expect(report.components[key]).toBe(0);
    }
    record(`주선 ${known}`, r, at(r, c.completedDay! + 1)); record(`주선 미수 ${known}`, r, delivered!);
  }, 60000);
  it('캠페인 끝: 공유 실행의 지연·부분 채권 잔액·매출채권 합', () => {
    const shared = sharedRuns();
    expect(shared.late).toBeDefined(); expect(shared.partial).toBeDefined();
    for (const [picked, mode] of [[shared.late!, 'LATE'], [shared.partial!, 'PARTIAL']] as const) {
      const { run: r, state: s, inv } = picked, plan = planFor(r), outstanding = inv.amountMinor - received(s, inv);
      expect(s.operations!.outcome).toBe('COMPLETED'); expect(plan.mode).toBe(mode); expect(inv.dueDay + plan.days).toBeGreaterThan(r.cfg.campaignDays); expect(inv.dueDay).toBeLessThanOrEqual(r.cfg.campaignDays);
      if (mode === 'PARTIAL') { expect(outstanding).toBeGreaterThan(0); expect(outstanding).toBeLessThan(inv.amountMinor); }
      expect(inv.status).toBe('OVERDUE'); expect(contract(r).status).not.toBe('COMPLETED');
      expect(inv.receiptIds).toEqual(mode === 'PARTIAL' ? [`RCPT-${inv.id}-1`] : []);
      expect(campaignSummary(s, r.cfg).openInvoices.find((i) => i.invoiceId === inv.id)!.amountMinor).toBe(outstanding);
      expect(receivableSchedule(s, r.cfg).find((i) => i.invoiceId === inv.id)!.outstandingMinor).toBe(outstanding);
      const sum = s.invoices.filter((i) => i.currency === 'USD' && i.status !== 'PAID').reduce((n, i) => n + i.amountMinor - received(s, i), 0);
      expect(summarize(s.ledger, 'USD').accountsReceivable).toBe(sum);
      expect(campaignSummary(s, r.cfg).byCurrency.find((b) => b.currency === 'USD')!.accountsReceivable).toBe(sum);
      const report = identity(s, r.cfg, inv.contractId); expect(report.open).toBe(true); expect(report.evaluationDay).toBe(r.cfg.campaignDays);
      expect(report.components.collection).toBe(collectionValue(s, r)); record(`캠페인 끝 ${mode}`, r, s);
    }
  }, 60000);
  it('불변식: 독립 사본 네 개의 저장 거부·서로 다른 문장·ID', () => {
    const partial = modeCase('PARTIAL'), inv = invoice(partial), plan = planFor(partial), fwd = forwardingCase(false), claim = claimCase();
    const sources = [at(partial, inv.dueDay + 1), at(partial, inv.dueDay + plan.days + 1), fwd.end, at(claim, contract(claim).deliveredDay! + 1)];
    const configs = [partial.cfg, partial.cfg, fwd.cfg, claim.cfg];
    sources.forEach((s, i) => expect(serializeSave(roundtrip(s, configs[i]!))).toBe(serializeSave(s)));
    const copies = sources.map((s) => structuredClone(s)), a = copies[0]!, b = copies[1]!, c = copies[2]!, d = copies[3]!;
    const receipt = receiptEntries(a, invoice(partial, a))[0]!;
    receipt.lines.find((l) => l.account === 'CASH')!.amount = inv.amountMinor + 1;
    receipt.lines.find((l) => l.account === 'ACCOUNTS_RECEIVABLE')!.amount = -inv.amountMinor - 1;
    invoice(partial, b).amountMinor++;
    const fc = contract(fwd); expect(fc.saleAmountMinor - fc.priceReductionMinor).toBeGreaterThan(1);
    post(c.ledger, { id: `CLAIM-${fc.id}`, day: c.day, currency: fc.currency, contractId: fc.id, reason: '불변식 시험',
      lines: [{ account: 'SALES_ALLOWANCE', amount: 1 }, { account: 'CASH', amount: -1 }] });
    const cc = contract(claim), sale = cc.saleAmountMinor - cc.priceReductionMinor, entry = claimEntry(d, cc.id)!;
    entry.lines.find((l) => l.account === 'SALES_ALLOWANCE')!.amount = sale + 1;
    entry.lines.find((l) => l.account === 'ACCOUNTS_RECEIVABLE')!.amount = -sale - 1; invoice(claim, d).amountMinor = -1;
    const fragments = ['받은 금액(', '수금 완료인데 받은 금액(', '클레임 분개는 직접 무역 계약에만 있어야 합니다', '이 늦은 감액 뒤 판매액('];
    const messages = [
      `${inv.id}: 받은 금액(${inv.amountMinor + 1})이 청구액(${inv.amountMinor})을 넘습니다`,
      `${inv.id}: 수금 완료인데 받은 금액(${inv.amountMinor})이 청구액(${inv.amountMinor + 1})과 다릅니다`,
      `CLAIM-${fc.id}: 클레임 분개는 직접 무역 계약에만 있어야 합니다`,
      `CLAIM-${cc.id}: 클레임(${sale + 1})이 늦은 감액 뒤 판매액(${sale})을 넘습니다`,
    ];
    // 첫 두 문장의 포함 관계 대신 각각의 고유 술어로 부재를 확인한다.
    const unique = ['을 넘습니다', '수금 완료인데', fragments[2]!, '이 늦은 감액 뒤 판매액('];
    copies.forEach((s, i) => {
      expect(messages[i]).toContain(i < 2 ? inv.id : i === 2 ? `CLAIM-${fc.id}` : `CLAIM-${cc.id}`);
      expect(() => roundtrip(s, configs[i]!)).toThrow(SaveError); expect(() => roundtrip(s, configs[i]!)).toThrow(messages[i]!);
      let error = ''; try { roundtrip(s, configs[i]!); } catch (e) { error = (e as Error).message; }
      for (let j = 0; j < 4; j++) if (j !== i && !(i === 3 && j === 0)) expect(error).not.toContain(unique[j]!);
    });
    expect(new Set(messages).size).toBe(4);
  }, 60000);
  it('항등식 ①②③④⑤b⑨: 독립 expected·realized와 단계 연결', () => {
    const normal = modeCase('ON_TIME'), claim = claimCase();
    const n = at(normal, contract(normal).completedDay! + 1); identity(n, normal.cfg, normal.id); record('정시 완료', normal, n);
    const ci = invoice(claim), cc = contract(claim), cs = at(claim, cc.completedDay! + 1), x = allowance(cs, cc.id), sale = cc.saleAmountMinor - cc.priceReductionMinor;
    expect(x).toBeGreaterThan(0); expect(rate(claim, cc.deliveredDay!)).not.toBe(rate(claim, ci.dueDay));
    const cr = identity(cs, claim.cfg, cc.id);
    expect(cr.components.claim).toBe(toKrw(sale - x, rate(claim, ci.dueDay)) - toKrw(sale, rate(claim, ci.dueDay)));
    expect(cr.components.cancel).toBe(0); expect(cr.components.collection).toBe(0);
    for (const mode of ['LATE', 'PARTIAL'] as const) {
      const r = changedRateCase(mode), inv = invoice(r), c = contract(r), s = at(r, c.completedDay! + 1), last = receiptEntries(s, inv).at(-1)!;
      expect(rate(r, last.day)).not.toBe(rate(r, inv.dueDay)); expect(rate(r, c.acceptedDay)).not.toBe(rate(r, inv.dueDay));
      const report = identity(s, r.cfg, c.id); expect(report.open).toBe(false); expect(report.components.collection).not.toBe(0); expect(report.components.collection).toBe(collectionValue(s, r));
      const opened = openChanged(r); expect(rate(r, opened.day)).not.toBe(rate(r, inv.dueDay));
      const openReport = identity(opened, r.cfg, c.id); expect(openReport.components.collection).not.toBe(0); expect(openReport.components.collection).toBe(collectionValue(opened, r));
      record(`항등식 완료 ${mode}`, r, s); record(`항등식 ⑤b ${mode}`, r, opened);
    }
    const transit = claim.states.find((s) => s.shipments.length && contract(claim, s).deliveredDay === null)!;
    expect(transit).toBeDefined(); expect(transit.invoices).toHaveLength(0);
    const report = identity(transit, claim.cfg, claim.id); expect(report.components.claim).toBe(0); expect(report.components.collection).toBe(0);
  }, 60000);
  it('항등식 ⑤a: 같은 환율 D+1 부분 채권의 ±1원', () => {
    const shared = sharedRuns();
    expect(shared.same).toBeDefined(); const { run: r, state: s, inv } = shared.same!, first = received(s, inv), rest = inv.amountMinor - first, rho = rate(r, inv.dueDay);
    expect(s.day).toBe(inv.dueDay + 1); expect(rate(r, s.day)).toBe(rho);
    expect(receiptEntries(s, inv).map((e) => e.id)).toEqual([`RECEIPT-RCPT-${inv.id}-1`]);
    expect(toKrw(first, rho) + toKrw(rest, rho)).not.toBe(toKrw(inv.amountMinor, rho));
    const report = identity(s, r.cfg, inv.contractId); expect(report.components.collection).toBe(toKrw(first, rho) + toKrw(rest, rho) - toKrw(inv.amountMinor, rho));
    expect(Math.abs(report.components.collection)).toBe(1); record('항등식 ⑤a', r, s);
  }, 60000);
  it.each([false, true])('항등식 ⑥: 출항 전 취소, 편 놓침·재예약 %s', (rebook) => {
    const cfg = cfgFor(), start = setup(cfg, 0, 0, false, rebook); let s = start.s;
    if (rebook) {
      while (s.day <= start.sailing.departureDay) s = step(s, cfg);
      expect(s.bookings[0]!.status).toBe('CANCELLED'); s = openDay(s, cfg).state;
      const next = listSailings(cfg, start.sailing.routeId, s.day + 1)[0]!;
      s = apply(s, cfg, { id: '재예약', type: 'BOOK_SAILING', contractId: start.id, sailingId: next.id });
    }
    s = apply(s, cfg, { id: '취소', type: 'CANCEL_CONTRACT', contractId: start.id });
    for (const prefix of ['FREIGHT-PREPAY-', 'FREIGHT-RELEASE-']) expect(s.ledger.entries.filter((e) => e.contractId === start.id && e.id.startsWith(prefix))).toHaveLength(rebook ? 2 : 1);
    const report = identity(s, cfg, start.id); expect(report.components.claim).toBe(0); expect(report.components.collection).toBe(0);
    record(`취소 ⑥${rebook ? 'b' : 'a'}`, { cfg, states: [s], end: s, id: start.id });
  }, 60000);
  it('채권 일정 정렬: dueDay·invoiceId 독립 정렬과 역순 사본', () => {
    const shared = sharedRuns();
    expect(shared.sorted).toBeDefined(); const { state: s, run: r } = shared.sorted!;
    const open = s.invoices.filter((i) => i.status !== 'PAID'); expect(open.length).toBeGreaterThanOrEqual(2);
    const expected = [...open].sort((a, b) => a.dueDay - b.dueDay || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(expected.map((i) => i.id)).not.toEqual([...open].sort((a, b) => a.id < b.id ? -1 : 1).map((i) => i.id));
    const copy = structuredClone(s); copy.invoices.reverse();
    for (const state of [s, copy]) {
      const rows = receivableSchedule(state, r.cfg);
      expect(rows.map((i) => [i.invoiceId, i.dueDay])).toEqual(expected.map((i) => [i.id, i.dueDay]));
      expect(campaignSummary(state, r.cfg).openInvoices.map((i) => [i.invoiceId, i.amountMinor])).toEqual(rows.map((i) => [i.invoiceId, i.outstandingMinor]));
    }
  }, 60000);
  it('결정성·저장: 두 완주·부분 중간 복원·클레임·끝 채권·커서', () => {
    const shared = sharedRuns();
    const r = modeCase('PARTIAL'), cfg = r.cfg;
    const a = runFrom(setup(cfg).s, cfg), b = runFrom(setup(cfg).s, cfg);
    expect(serializeSave(a.end)).toBe(serializeSave(b.end));
    const mid = at(r, invoice(r).dueDay + 1); expect(invoice(r, mid).status).toBe('OVERDUE'); expect(invoice(r, mid).receiptIds).toHaveLength(1);
    const restored = roundtrip(mid, cfg); expect(serializeSave(restored)).toBe(serializeSave(mid));
    expect(serializeSave(runFrom(restored, cfg, r.id).end)).toBe(serializeSave(runFrom(mid, cfg, r.id).end));
    const cl = claimCase(), delivered = at(cl, contract(cl).deliveredDay! + 1); expect(claimEntry(delivered, cl.id)).toBeDefined();
    expect(shared.late).toBeDefined();
    for (const [s, config] of [[delivered, cl.cfg], [shared.late!.state, shared.late!.run.cfg]] as const) expect(serializeSave(roundtrip(s, config))).toBe(serializeSave(s));
    for (const s of [...a.states, ...b.states, ...cl.states, ...shared.runs.flatMap((r) => r.states)]) expect(Object.keys(s.rng.cursors).filter((k) => /^(CLAIM:|COLLECT:)/.test(k))).toEqual([]);
  }, 60000);
  it('진단 기록: 찾은 시드·공유 다섯 사건·노출 수·계획 표', () => {
    const shared = sharedRuns();
    const events = Object.fromEntries((['late', 'partial', 'split', 'same', 'sorted'] as const).map((key) => {
      const p = shared[key]; expect(p, key).toBeDefined(); return [key, { seed: p!.run.cfg.seed, invoice: p!.inv.id, D: p!.inv.dueDay, rate: referenceRate(p!.run.cfg, p!.state.rng.seed, p!.inv.dueDay), day: p!.state.day }];
    }));
    let total = 0, minor = 0, major = 0, late = 0, partial = 0, beyond = 0;
    for (const r of shared.runs) for (const c of r.end.contracts.filter((c) => c.kind === 'DIRECT_TRADE')) {
      total++; const inv = r.end.invoices.find((i) => i.contractId === c.id), claim = claimFor(r.cfg, r.end.rng.seed, c.sellOfferId!, c.goodId), plan = collectionPlan(r.cfg, r.end.rng.seed, c.sellOfferId!, c.customerId);
      if (claimEntry(r.end, c.id)) { minor += Number(claim?.tier === 'MINOR'); major += Number(claim?.tier === 'MAJOR'); }
      if (inv) { late += Number(plan.mode === 'LATE'); partial += Number(plan.mode === 'PARTIAL'); beyond += Number(inv.dueDay + plan.days > r.cfg.campaignDays); }
    }
    evidence['공유 실행'] = { seeds: shared.runs.map((r) => r.cfg.seed), milliseconds: shared.times, events, exposure: { total, minor, major, late, partial, beyond } };
    evidence['계획 표'] = [modeCase('ON_TIME'), modeCase('LATE'), modeCase('PARTIAL'), claimCase()].map((r) => {
      const c = contract(r), p = r.cfg.operations!.risk!.profile;
      return { seed: r.cfg.seed, sellOffer: c.sellOfferId, good: c.goodId, damage: p.claims.byGood.find((row) => row.goodId === c.goodId)!.grade,
        claim: claimFor(r.cfg, r.end.rng.seed, c.sellOfferId!, c.goodId), customer: c.customerId,
        credit: p.collections.byCounterparty.find((row) => row.counterpartyId === c.customerId)!.grade, plan: planFor(r) };
    });
    console.info('TASK0064_EVIDENCE ' + JSON.stringify(evidence));
  }, 60000);
});
