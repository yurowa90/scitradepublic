import { describe, expect, it, vi } from 'vitest';
import { loadScenario, OPERATIONS_SCENARIO_IDS, riskProfiles } from '../content/scenario';
import { listSailings, routeBetween, type Sailing } from './catalog';
import { commitDay, createGame, openDay, planState } from './engine';
import { balance, post } from './ledger';
import { offerDef, openTradePairs } from './market';
import { dailyKrwDue, usdLotKrw } from './operations';
import { quotePreview } from './readers';
import { contractRiskReport, preview } from './reports';
import { cashReservations, fundsPosition } from './reservations';
import { drawUniform } from './rng';
import { dutyFor, referenceRate, surchargeBp, surchargeWeek, tariffEvents, tariffSchedule, withRiskLevel, type TariffEvent } from './risk';
import { deserializeSave, serializeSave } from './save';
import type { Contract, EngineCommand, GameState, RiskProfile, ScenarioConfig } from './types';
import type { Currency } from './money';

vi.mock('./rng', async (original) => {
  const m = await original<typeof import('./rng')>();
  return { ...m, drawUniform: vi.fn(m.drawUniform) };
});
vi.mock('./risk', async (original) => {
  const m = await original<typeof import('./risk')>();
  return { ...m, dutyFor: vi.fn(m.dutyFor) };
});
const rng = await vi.importActual<typeof import('./rng')>('./rng');
const base = loadScenario(OPERATIONS_SCENARIO_IDS[0]);
const profile = riskProfiles()[0]!;
const cfgFor = (seed = 1, p = profile, level: 'R0' | 'R1' | 'R2' = 'R2') => withRiskLevel({ ...base, seed }, level, p);
const reverseProfile = () => {
  const p = structuredClone(profile);
  p.tariff.maxChanges = 6; p.tariff.lagDays = [0, 10]; p.tariff.maxBp = 700;
  return p;
};
const half = (n: number, d: number) => Math.sign(n) * Math.floor((2 * Math.abs(n) + d) / (2 * d));
const toKrw = (n: number, r: number) => half(n * r, 100);
const bpAmount = (n: number, bp: number) => half(n * bp, 10000);
const country = (cfg: ScenarioConfig, city: string) => cfg.cities.find((c) => c.id === city)!.countryCode;
const week = (cfg: ScenarioConfig, day: number) => Math.floor((day - cfg.operations!.market.publish.firstDay) / cfg.operations!.market.publish.intervalDays) + 1;
const fresh = (cfg: ScenarioConfig) => openDay(createGame(cfg), cfg).state;
// 읽기 함수는 추첨 회차를 공개하지 않으므로 공지·시행 날짜로 사건을 대조한다.
type Notice = Pick<TariffEvent, 'countryCode' | 'noticeDay' | 'effectiveDay'>;
const eventKey = (e: Notice) => [e.countryCode, e.noticeDay, e.effectiveDay];
const sameNotice = (a: Notice, b: Notice) => a.countryCode === b.countryCode
  && a.noticeDay === b.noticeDay && a.effectiveDay === b.effectiveDay;

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
function oracleRates(cfg: ScenarioConfig, seed: number, e: TariffEvent, k: number) {
  const events = oracleEvents(cfg, seed);
  return cfg.operations!.risk!.profile.tariff.base.filter((r) => r.countryCode === e.countryCode).map((r) => ({ goodId: r.goodId,
    fromBp: oracleRate(cfg, events.filter((v) => v.countryCode !== e.countryCode || v.round !== e.round), e.countryCode, r.goodId, k, e.effectiveDay),
    toBp: oracleRate(cfg, events, e.countryCode, r.goodId, k, e.effectiveDay) }));
}
function oracleLabel(cfg: ScenarioConfig, e: TariffEvent, rates: ReturnType<typeof oracleRates>) {
  const cities = cfg.cities.filter((c) => c.countryCode === e.countryCode).map((c) => c.nameKo).join('·');
  return `${e.countryCode}${cities ? `(${cities})` : ''} 관세 일괄 변경(가상 세율): ${rates.map((r) =>
    `${cfg.goods.find((g) => g.id === r.goodId)!.nameKo} ${r.fromBp / 100}% → ${r.toBp / 100}%`).join(', ')} (${e.effectiveDay}일부터)`;
}
function apply(s: GameState, cfg: ScenarioConfig, cmd: EngineCommand) {
  const r = planState(s, cfg, [cmd]);
  expect(r.results[0], JSON.stringify(cmd)).toMatchObject({ status: 'APPLIED' });
  return r.state;
}
function fund(s: GameState, cfg: ScenarioConfig, purchase = 0) {
  const need = purchase + dailyKrwDue(s, cfg, s.day) - fundsPosition(s, cfg, 'KRW').available;
  if (need <= 0) return s;
  const lots = Math.ceil(need / usdLotKrw(cfg, s)), lot = cfg.operations!.fx.lotUsdMinor;
  if (lots * lot > fundsPosition(s, cfg, 'USD').available) return s;
  return apply(s, cfg, { id: `환전-${s.day}-${s.operations!.exchanges.length}`, type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: lots * lot });
}
function advance(s: GameState, cfg: ScenarioConfig, day: number, funded = true) {
  while (s.day < day && s.phase !== 'ENDED') {
    s = openDay(s, cfg).state;
    s = commitDay(funded ? fund(s, cfg) : s, cfg, []).state;
  }
  return openDay(s, cfg).state;
}
type Pair = ReturnType<typeof openTradePairs>[number];
function tryTrade(s: GameState, cfg: ScenarioConfig, pair: Pair, sailing: Sailing) {
  const buy = offerDef(s, cfg, pair.buyOfferId)!;
  s = fund(s, cfg, buy.unitPriceMinor * buy.quantity);
  const employee = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId)!;
  const cmd: EngineCommand = { id: `무역-${s.day}-${s.contracts.length}`, type: 'ACCEPT_TRADE', ...pair,
    plan: { employeeId: employee.id, sailingId: sailing.id } };
  const result = planState(s, cfg, [cmd]);
  return { ...result, cmd, before: s };
}
function setup(cfg: ScenarioConfig, later = 0, forwarding = false) {
  let s = fresh(cfg);
  const pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
  const route = routeBetween(cfg, buy.cityId, sell.cityId)!, sailing = listSailings(cfg, route.id, s.day + 1)[later]!;
  if (forwarding) {
    const fwd = cfg.offers.find((o) => o.kind === 'forwarding' && o.cityId === route.fromCityId && o.destinationCityId === route.toCityId)!;
    expect(fwd).toBeDefined();
    const employeeId = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId)!.id;
    s = apply(s, cfg, { id: '주선', type: 'ACCEPT_FORWARDING', offerId: fwd.id, plan: { employeeId, sailingId: sailing.id } });
  } else {
    const result = tryTrade(s, cfg, pair, sailing);
    expect(result.results[0]!.status).toBe('APPLIED'); s = result.state;
  }
  return { s, c: s.contracts[0]!, sailing, pair };
}
function finish(s: GameState, cfg: ScenarioConfig, id: string) {
  while (s.phase !== 'ENDED' && s.contracts.find((c) => c.id === id)!.status !== 'COMPLETED') s = advance(s, cfg, s.day + 1);
  expect(s.contracts.find((c) => c.id === id)!.status).toBe('COMPLETED');
  return s;
}
function inject(s: GameState, amount: number, id: string, day = s.day) {
  s.obligations.push({ id, currency: 'USD', amountMinor: amount, incurredDay: day, paidDay: null, reasonKo: '시험 의무' });
  post(s.ledger, { id, day, currency: 'USD', reason: '시험 의무', lines: [
    { account: 'WAGE_EXPENSE', amount }, { account: 'ACCOUNTS_PAYABLE', amount: -amount },
  ] });
}
const entryAmount = (s: GameState, prefix: string, c: Contract) => s.ledger.entries.find((e) => e.contractId === c.id && e.id.startsWith(prefix));
function contractPreview(s: GameState, cfg: ScenarioConfig, c: Contract) {
  return preview({ ...cfg, seed: s.rng.seed }, c.kind, c.originCityId, c.destinationCityId, c.acceptedDay,
    { purchase: c.purchaseAmountMinor, sale: c.saleAmountMinor }, c.deliveryDeadlineDay, c.paymentDueDay,
    { goodId: c.goodId, purchaseCurrency: c.buyOfferId ? offerDef(s, cfg, c.buyOfferId)!.currency : c.currency })!;
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

describe('TASK-0063 순수 일정과 공지', () => {
  it.each([false, true])('일정 오라클: 200시드·관세·부대비·마지막 공개일 뒤 주차 (역전 사본 %s)', (reverse) => {
    const cfg = cfgFor(1, reverse ? reverseProfile() : profile), p = cfg.operations!.risk!.profile;
    const lateRoute = cfg.routes.find((r) => listSailings(cfg, r.id).filter((x) => x.departureDay > cfg.operations!.market.publish.lastDay).length >= 2);
    expect(lateRoute).toBeDefined();
    const late = listSailings(cfg, lateRoute!.id).filter((x) => x.departureDay > cfg.operations!.market.publish.lastDay);
    expect(surchargeWeek(cfg, late[0]!.departureDay)).not.toBe(surchargeWeek(cfg, late[1]!.departureDay));
    for (const route of cfg.routes) for (const sailing of listSailings(cfg, route.id)) expect(surchargeWeek(cfg, sailing.departureDay)).toBe(week(cfg, sailing.departureDay));
    for (let seed = 1; seed <= 200; seed++) {
      const events = oracleEvents(cfg, seed);
      expect(tariffEvents(cfg, seed)).toEqual(events);
      const days = [...new Set([1, cfg.campaignDays, ...events.flatMap((e) => [e.noticeDay - 1, e.noticeDay, e.effectiveDay])])];
      for (const row of p.tariff.base) {
        const city = cfg.cities.find((c) => c.countryCode === row.countryCode)!;
        for (const k of days) for (const t of days) {
          const amount = 1000000;
          expect(dutyFor(cfg, seed, row.goodId, city.id, t, k, amount, 'USD', 1))
            .toBe(bpAmount(amount, oracleRate(cfg, events, row.countryCode, row.goodId, k, t)));
        }
      }
      for (const route of cfg.routes) for (const w of new Set(listSailings(cfg, route.id).map((s) => week(cfg, s.departureDay)))) {
        expect(surchargeBp(cfg, seed, route.id, w)).toBe(oracleSurcharge(cfg, seed, route.id, w));
      }
      vi.mocked(drawUniform).mockClear(); vi.mocked(dutyFor).mockClear();
    }
  }, 30000);
  it('관세 일정 순수성·빈 일정·횟수·범위', () => {
    const cfg = cfgFor(); let empty = false, changed = false;
    for (let seed = 1; seed <= 200; seed++) {
      const events = tariffEvents(cfg, seed); expect(events).toEqual(tariffEvents(cfg, seed));
      empty ||= events.length === 0; changed ||= events.length > 0;
      for (const cc of new Set(profile.tariff.base.map((r) => r.countryCode))) expect(events.filter((e) => e.countryCode === cc).length).toBeLessThanOrEqual(profile.tariff.maxChanges);
      for (const e of events) {
        expect(e.stepBp).toBeGreaterThanOrEqual(profile.tariff.stepBp[0]!); expect(e.stepBp).toBeLessThanOrEqual(profile.tariff.stepBp[1]!);
        expect(e.effectiveDay - e.noticeDay).toBeGreaterThanOrEqual(profile.tariff.lagDays[0]!);
        expect(e.effectiveDay - e.noticeDay).toBeLessThanOrEqual(profile.tariff.lagDays[1]!); expect(e.effectiveDay).toBeLessThanOrEqual(cfg.campaignDays);
      }
    }
    expect(empty).toBe(true); expect(changed).toBe(true);
  });
  it('흐름 유일성: 200시드별 관찰, 두 번째 회차와 커서 0', () => {
    const cfg = cfgFor(); let second = false;
    for (let seed = 1; seed <= 200; seed++) {
      vi.mocked(drawUniform).mockClear();
      tariffEvents(cfg, seed);
      for (const r of cfg.routes) for (const w of new Set(listSailings(cfg, r.id).map((x) => week(cfg, x.departureDay)))) surchargeBp(cfg, seed, r.id, w);
      referenceRate(cfg, seed, cfg.operations!.market.publish.lastDay);
      const pairs = vi.mocked(drawUniform).mock.calls.map(([state, stream]) => [stream, state.cursors[stream]] as const);
      expect(new Set(pairs.map((v) => JSON.stringify(v))).size).toBe(pairs.length);
      for (const [stream, cursor] of pairs) {
        expect(stream).toMatch(/^(FX-REF|TARIFF:[^:]+:(count|\d+:(notice|lag|step))|SURCHARGE:[^:]+:\d+:(zero|value))$/);
        if (stream !== 'FX-REF') expect(cursor).toBe(0);
        const round = /^TARIFF:[^:]+:(\d+):notice$/.exec(stream);
        if (round && Number(round[1]) >= 2) second = true;
      }
    }
    expect(second).toBe(true);
  });
  it('사건 범위: 다른 기준 세율, 실제 경계 자르기, 품목 순서 보존', () => {
    const p = structuredClone(profile), cc = p.tariff.base[0]!.countryCode, rows = p.tariff.base.filter((r) => r.countryCode === cc);
    expect(rows.length).toBeGreaterThanOrEqual(2);
    rows[0]!.rateBp = p.tariff.minBp + Math.floor((p.tariff.maxBp - p.tariff.minBp) / 2);
    rows[1]!.rateBp = p.tariff.maxBp - 1;
    const cfg = cfgFor(1, p); let clipped = false, unclipped = false, clippedComparisons = 0;
    const used = rows.filter((r) => cfg.goods.some((g) => g.id === r.goodId));
    for (let seed = 1; seed <= 200; seed++) {
      const events = oracleEvents(cfg, seed);
      expect(tariffEvents(cfg, seed)).toEqual(events);
      const city = cfg.cities.find((c) => c.countryCode === cc)!;
      const days = [...new Set([1, cfg.campaignDays, ...events.flatMap((e) => [e.noticeDay - 1, e.noticeDay, e.effectiveDay])])];
      for (const row of used) for (const k of days) for (const t of days) {
        expect(dutyFor(cfg, seed, row.goodId, city.id, t, k, 1000000, 'USD', 1))
          .toBe(bpAmount(1000000, oracleRate(cfg, events, cc, row.goodId, k, t)));
      }
      if (clipped && unclipped) continue;
      for (const e of events.filter((e) => e.countryCode === cc)) {
        const state = advance(fresh({ ...cfg, seed }), { ...cfg, seed }, e.noticeDay);
        expect(state.day).toBe(e.noticeDay);
        const rates = tariffSchedule(state, cfg).find((v) => sameNotice(v, e))!.rates;
        expect(rates).toEqual(oracleRates(cfg, seed, e, e.noticeDay));
        const a = used.map((row) => rates.find((r) => r.goodId === row.goodId)!.fromBp);
        const b = used.map((row) => rates.find((r) => r.goodId === row.goodId)!.toBp);
        if (a.some((r, i) => r + e.stepBp !== b[i])) { clipped = true; clippedComparisons++; }
        if (a.every((r, i) => r + e.stepBp === b[i])) { unclipped = true; expect(b[1]! - b[0]!).toBe(a[1]! - a[0]!); }
        expect(a[0]).toBeLessThanOrEqual(a[1]!); expect(b[0]).toBeLessThanOrEqual(b[1]!);
        if (clipped && unclipped) break;
      }
      vi.mocked(drawUniform).mockClear(); vi.mocked(dutyFor).mockClear();
    }
    expect(clipped).toBe(true); expect(unclipped).toBe(true); expect(clippedComparisons).toBeGreaterThan(0);
  });
  it('공지 순서: 같은 날 두 나라와 과거 사건을 오라클 정렬·로그에 대조', () => {
    const p = structuredClone(profile); p.tariff.maxChanges = 6;
    let found: { cfg: ScenarioConfig; day: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed, p), events = oracleEvents(cfg, seed);
      for (const e of events) {
        if (!events.some((v) => v.noticeDay === e.noticeDay && v.countryCode !== e.countryCode)
          || !events.some((v) => v.noticeDay < e.noticeDay)
          || !events.some((a) => events.some((b) => a.countryCode === b.countryCode
            && a.noticeDay < b.noticeDay && b.noticeDay <= e.noticeDay && a.round > b.round))) continue;
        const state = advance(fresh(cfg), cfg, e.noticeDay);
        if (state.day === e.noticeDay && state.phase !== 'ENDED') { found = { cfg, day: e.noticeDay }; break; }
      }
    }
    expect(found).toBeDefined(); const { cfg, day } = found!, state = advance(fresh(cfg), cfg, day);
    const countries = [...new Set(p.tariff.base.map((r) => r.countryCode))];
    const ordered = oracleEvents(cfg, cfg.seed).filter((e) => e.noticeDay <= day)
      .sort((a, b) => a.noticeDay - b.noticeDay || countries.indexOf(a.countryCode) - countries.indexOf(b.countryCode) || a.round - b.round);
    expect(new Set(ordered.filter((e) => e.noticeDay === day).map((e) => e.countryCode)).size).toBeGreaterThan(1);
    expect(ordered.some((e) => e.noticeDay < day)).toBe(true);
    expect(ordered.some((a) => ordered.some((b) => a.countryCode === b.countryCode
      && a.noticeDay < b.noticeDay && a.round > b.round))).toBe(true);
    const schedule = tariffSchedule(state, cfg);
    expect(schedule.map(eventKey)).toEqual(ordered.map(eventKey));
    for (const [i, e] of schedule.entries()) {
      expect(e).not.toHaveProperty('round');
      expect(e.seq).toBe(ordered.slice(0, i + 1).filter((v) => v.countryCode === e.countryCode).length);
    }
    expect(state.log.filter((l) => l.day === day && l.textKo.includes('관세 일괄 변경')).map((l) => l.textKo))
      .toEqual(ordered.filter((e) => e.noticeDay === day).map((e) => oracleLabel(cfg, e, oracleRates(cfg, cfg.seed, e, day))));
  });
  it('무의미 사건 없음: 흐름은 뽑되 로그에서 생략, 음수 걸음 대조', () => {
    const p = structuredClone(profile), cc = p.tariff.base[0]!.countryCode;
    for (const row of p.tariff.base.filter((r) => r.countryCode === cc)) row.rateBp = p.tariff.maxBp;
    p.tariff.stepBp = [0, profile.tariff.stepBp[1]!];
    let found: { cfg: ScenarioConfig; seed: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed, p); vi.mocked(drawUniform).mockClear(); const events = tariffEvents(cfg, seed);
      if (!vi.mocked(drawUniform).mock.calls.some(([, stream]) => stream === `TARIFF:${cc}:1:notice`)) continue;
      expect(events.filter((e) => e.countryCode === cc)).toEqual([]); found = { cfg, seed };
    }
    expect(found).toBeDefined();
    const s = advance(fresh(found!.cfg), found!.cfg, found!.cfg.campaignDays + 1);
    expect(s.log.some((l) => l.textKo.startsWith(cc) && l.textKo.includes('관세 일괄 변경'))).toBe(false);
    p.tariff.stepBp = [...profile.tariff.stepBp]; let contrast = false, gapChecked = false;
    for (let seed = 1; seed <= 200; seed++) {
      const cfg = cfgFor(seed, p), events = tariffEvents(cfg, seed); expect(events).toEqual(oracleEvents(cfg, seed));
      const selected = events.filter((e) => e.countryCode === cc); contrast ||= selected.length > 0;
      if (!gapChecked && selected.some((e) => e.round > selected.length)) {
        const day = Math.max(...selected.map((e) => e.noticeDay)), state = advance(fresh(cfg), cfg, day);
        if (state.day === day && state.phase !== 'ENDED') {
          expect(integer(seed, `TARIFF:${cc}:count`, 0, p.tariff.maxChanges)).toBeGreaterThan(selected.length);
          expect(selected.some((e) => e.round > selected.length)).toBe(true);
          const schedule = tariffSchedule(state, cfg).filter((e) => e.countryCode === cc);
          expect(schedule.map(eventKey)).toEqual(selected.map(eventKey));
          expect(schedule.map((e) => e.seq)).toEqual(selected.map((_, i) => i + 1));
          for (const e of schedule) expect(e).not.toHaveProperty('round');
          gapChecked = true;
        }
      }
      for (const e of selected.filter((e) => e.stepBp > 0)) expect(selected.some((v) => v.stepBp < 0 && v.effectiveDay <= e.effectiveDay && (v.noticeDay < e.noticeDay || (v.noticeDay === e.noticeDay && v.round < e.round)))).toBe(true);
    }
    expect(contrast).toBe(true); expect(gapChecked).toBe(true);
  });
});

// 상태 없는 미리보기 탐색도 시드가 설정에 든 동일한 설정을 사용한다.
function previewContexts(cfg: ScenarioConfig) {
  const s = fresh(cfg);
  return openTradePairs(s, cfg).map((pair) => {
    const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    return { good: buy.goodId, city: sell.cityId, origin: buy.cityId, cc: country(cfg, sell.cityId),
      amount: buy.unitPriceMinor * buy.quantity, route: routeBetween(cfg, buy.cityId, sell.cityId)! };
  });
}
type Context = ReturnType<typeof previewContexts>[number];
function atPreview(cfg: ScenarioConfig, ctx: Context, d: number, currency: Currency = 'USD') {
  return preview(cfg, 'DIRECT_TRADE', ctx.origin, ctx.city, d, { purchase: ctx.amount, sale: ctx.amount * 2 }, cfg.campaignDays, cfg.campaignDays, { goodId: ctx.good, purchaseCurrency: currency })!;
}
describe('TASK-0063 공지 기준과 누설 차단', () => {
  it('공지 순서 역전 ①: 시행일 누적과 공지일 누적의 실제 관세 차이', () => {
    let found: { cfg: ScenarioConfig; ctx: Context; d: number; right: number; wrong: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed, reverseProfile()), events = tariffEvents(cfg, seed), oracle = oracleEvents(cfg, seed);
      for (const ctx of previewContexts(cfg)) for (const d of events.map((e) => e.noticeDay)) {
        const first = listSailings(cfg, ctx.route.id, d + 1)[0]; if (!first) continue;
        const right = bpAmount(ctx.amount, oracleRate(cfg, oracle, ctx.cc, ctx.good, d, first.scheduledArrivalDay));
        const wrong = bpAmount(ctx.amount, oracleRate(cfg, oracle, ctx.cc, ctx.good, d, first.scheduledArrivalDay, true));
        if (right !== wrong) { found = { cfg, ctx, d, right, wrong }; break; }
      }
    }
    expect(found).toBeDefined(); const { cfg, ctx, d, right, wrong } = found!;
    expect(right).not.toBe(wrong); expect(atPreview(cfg, ctx, d).duty).toBe(right);
  });
  it('공지 순서 역전 ②: 미래 비공지, 당시 로그, 오늘 기준 재계산', () => {
    let found: { cfg: ScenarioConfig; ctx: Context; e1: TariffEvent; e2: TariffEvent; old: number; next: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed, reverseProfile()), events = tariffEvents(cfg, seed);
      for (const ctx of previewContexts(cfg)) for (const e1 of events) for (const e2 of events) {
        if (e1.countryCode !== ctx.cc || e2.countryCode !== ctx.cc || e1.noticeDay >= e2.noticeDay || e1.effectiveDay <= e2.effectiveDay) continue;
        const a = listSailings(cfg, ctx.route.id, e2.noticeDay)[0]?.scheduledArrivalDay;
        if (!a || a < e1.effectiveDay) continue;
        const old = oracleDuty(cfg, seed, ctx.good, ctx.city, a, e2.noticeDay - 1, ctx.amount, 'USD', 1);
        const next = oracleDuty(cfg, seed, ctx.good, ctx.city, a, e2.noticeDay, ctx.amount, 'USD', 1);
        if (old === next || JSON.stringify(oracleRates(cfg, seed, e1, e1.noticeDay)) === JSON.stringify(oracleRates(cfg, seed, e1, e2.noticeDay))) continue;
        const s = advance(fresh(cfg), cfg, e2.noticeDay);
        if (s.day !== e2.noticeDay || s.phase === 'ENDED') continue;
        found = { cfg, ctx, e1, e2, old, next }; break;
      }
    }
    expect(found).toBeDefined(); const { cfg, ctx, e1, e2, old, next } = found!;
    expect(old).not.toBe(next);
    const earlyRates = oracleRates(cfg, cfg.seed, e1, e1.noticeDay), laterRates = oracleRates(cfg, cfg.seed, e1, e2.noticeDay);
    expect(earlyRates).not.toEqual(laterRates);
    expect(atPreview(cfg, ctx, e2.noticeDay - 1).duty).toBe(old);
    const before = advance(fresh(cfg), cfg, e1.noticeDay - 1);
    expect(tariffSchedule(before, cfg).some((e) => sameNotice(e, e1))).toBe(false);
    const early = advance(before, cfg, e1.noticeDay), late = advance(early, cfg, e2.noticeDay);
    expect(tariffSchedule(early, cfg).find((e) => sameNotice(e, e1))!.rates).toEqual(earlyRates);
    expect(early.log.filter((l) => l.day === e1.noticeDay).map((l) => l.textKo)).toContain(oracleLabel(cfg, e1, earlyRates));
    expect(tariffSchedule(late, cfg).find((e) => sameNotice(e, e1))!.rates).toEqual(laterRates);
    expect(late.log.filter((l) => l.day === e2.noticeDay).map((l) => l.textKo)).toContain(oracleLabel(cfg, e2, oracleRates(cfg, cfg.seed, e2, e2.noticeDay)));
    for (const s of [early, late]) {
      const schedule = tariffSchedule(s, cfg).filter((e) => e.noticeDay === s.day);
      expect(s.log.filter((l) => l.day === s.day && l.textKo.includes('관세 일괄 변경')).map((l) => l.textKo)).toEqual(schedule.map((e) => e.labelKo));
    }
  });
  it('비공지 미반영·공지 반영: 다음 첫 편 시행 전후 관세가 실제로 다름', () => {
    let found: { cfg: ScenarioConfig; ctx: Context; e: TariffEvent; a: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed);
      for (const ctx of previewContexts(cfg)) for (const e of tariffEvents(cfg, seed).filter((e) => e.countryCode === ctx.cc)) {
        const a = listSailings(cfg, ctx.route.id, e.noticeDay)[0]?.scheduledArrivalDay;
        if (!a || a < e.effectiveDay || e.noticeDay <= 1) continue;
        if (oracleDuty(cfg, seed, ctx.good, ctx.city, a, e.noticeDay - 1, ctx.amount, 'KRW', e.noticeDay - 1) !== oracleDuty(cfg, seed, ctx.good, ctx.city, a, a, ctx.amount, 'KRW', e.noticeDay - 1)) found = { cfg, ctx, e, a };
      }
    }
    expect(found).toBeDefined(); const { cfg, ctx, e, a } = found!, d = e.noticeDay - 1;
    expect(a).toBeGreaterThanOrEqual(e.effectiveDay);
    expect(dutyFor(cfg, cfg.seed, ctx.good, ctx.city, a, d, ctx.amount, 'KRW', d)).not.toBe(dutyFor(cfg, cfg.seed, ctx.good, ctx.city, a, a, ctx.amount, 'KRW', d));
    expect(atPreview(cfg, ctx, d, 'KRW').duty).toBe(oracleDuty(cfg, cfg.seed, ctx.good, ctx.city, a, d, ctx.amount, 'KRW', d));
    const announcedArrival = listSailings(cfg, ctx.route.id, e.noticeDay + 1)[0]!.scheduledArrivalDay;
    expect(announcedArrival).toBeGreaterThanOrEqual(e.effectiveDay);
    expect(oracleDuty(cfg, cfg.seed, ctx.good, ctx.city, announcedArrival, e.noticeDay, ctx.amount, 'KRW', e.noticeDay))
      .not.toBe(oracleDuty(cfg, cfg.seed, ctx.good, ctx.city, announcedArrival, e.noticeDay - 1, ctx.amount, 'KRW', e.noticeDay));
    expect(atPreview(cfg, ctx, e.noticeDay, 'KRW').duty).toBe(oracleDuty(cfg, cfg.seed, ctx.good, ctx.city, announcedArrival, e.noticeDay, ctx.amount, 'KRW', e.noticeDay));
  });
  it('goodId 누락·관세 표 누락 예외·USD 매입도 달라진 표 세율', () => {
    const cfg = cfgFor(), ctx = previewContexts(cfg)[0]!;
    expect(() => preview(cfg, 'DIRECT_TRADE', ctx.origin, ctx.city, 1, { purchase: ctx.amount, sale: ctx.amount }, 20, 30)).toThrow();
    const bad = structuredClone(cfg); bad.operations!.risk!.profile.tariff.base = bad.operations!.risk!.profile.tariff.base.filter((r) => r.countryCode !== ctx.cc || r.goodId !== ctx.good);
    expect(() => dutyFor(bad, 1, ctx.good, ctx.city, 1, 1, ctx.amount, 'KRW', 1)).toThrow('관세 표');
    let found: { seed: number; amount: number; duty: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const amount = 1000000, duty = oracleDuty(cfg, seed, ctx.good, ctx.city, cfg.campaignDays, cfg.campaignDays, amount, 'USD', 1);
      if (duty !== bpAmount(amount, cfg.terms.dutyRateBasisPoints)) found = { seed, amount, duty };
    }
    expect(found).toBeDefined(); const f = found!;
    expect(f.duty).not.toBe(bpAmount(f.amount, cfg.terms.dutyRateBasisPoints));
    expect(dutyFor(cfg, f.seed, ctx.good, ctx.city, cfg.campaignDays, cfg.campaignDays, f.amount, 'USD', 1)).toBe(f.duty);
  });
});

type EventCase = { cfg: ScenarioConfig; s: GameState; c: Contract; e: TariffEvent; sailing: Sailing; p: NonNullable<ReturnType<typeof preview>> };
function findEventCase(predicate: (v: EventCase) => boolean, p = profile, later = 0): EventCase {
  for (let seed = 1; seed <= 200; seed++) {
    const cfg = cfgFor(seed, p), publish = cfg.operations!.market.publish;
    for (const e of tariffEvents(cfg, seed)) {
      const d = publish.firstDay + Math.floor((e.noticeDay - 1 - publish.firstDay) / publish.intervalDays) * publish.intervalDays;
      if (d < publish.firstDay || d > publish.lastDay) continue;
      const opened = advance(fresh(cfg), cfg, d);
      if (opened.phase === 'ENDED' || opened.day !== d) continue;
      for (const pair of openTradePairs(opened, cfg)) {
        const buy = offerDef(opened, cfg, pair.buyOfferId)!, sell = offerDef(opened, cfg, pair.sellOfferId)!;
        if (country(cfg, sell.cityId) !== e.countryCode) continue;
        const route = routeBetween(cfg, buy.cityId, sell.cityId)!, sailing = listSailings(cfg, route.id, d + 1)[later];
        if (!sailing) continue;
        const previewValue = quotePreview(opened, cfg, pair)!;
        if (!previewValue) continue;
        const trial = tryTrade(opened, cfg, pair, sailing);
        if (trial.results[0]!.status !== 'APPLIED') continue;
        const v = { cfg, s: trial.state, c: trial.state.contracts.at(-1)!, e, sailing, p: previewValue };
        if (predicate(v)) return v;
      }
    }
  }
  expect.fail('200시드 안에서 수락 가능한 사건·편을 찾지 못함');
}
let exposureCache: EventCase | undefined;
function exposureCase() {
  return exposureCache ??= findEventCase(({ cfg, c, e, sailing, p }) => !p.lateOnNextSailing && c.acceptedDay < e.noticeDay
    && sailing.scheduledArrivalDay >= e.effectiveDay && sailing.scheduledArrivalDay + cfg.terms.customsDays <= c.deliveryDeadlineDay
    && oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, sailing.scheduledArrivalDay, sailing.scheduledArrivalDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay) !== p.duty);
}
function stageTariff(s: GameState, cfg: ScenarioConfig, c: Contract, duty: number) {
  const p = contractPreview(s, cfg, c), entry = entryAmount(s, 'DUTY-', c);
  const obligation = s.obligations.find((o) => o.id === entry?.id);
  const day = obligation ? obligation.paidDay ?? s.day : entry?.day ?? s.day;
  const r = rateAt(cfg, s.rng.seed, day), freight = entryAmount(s, 'FREIGHT-PREPAY-', c)!;
  const fr = rateAt(cfg, s.rng.seed, freight.day) === r ? p.freight : 0;
  return toKrw(-(fr + duty), r) - toKrw(-(fr + p.duty), r);
}
describe('TASK-0063 엔진의 관세 적용일', () => {
  it('도착일 세율(정시): 공지 뒤 바뀐 관세와 환산 묶음 차이', () => {
    const v = exposureCase(), { cfg, c, e, sailing, p } = v;
    expect(p.lateOnNextSailing).toBe(false); expect(sailing.scheduledArrivalDay + cfg.terms.customsDays).toBeLessThanOrEqual(c.deliveryDeadlineDay);
    expect(c.acceptedDay).toBeLessThan(e.noticeDay); expect(e.effectiveDay).toBeLessThanOrEqual(sailing.scheduledArrivalDay);
    const s = finish(v.s, cfg, c.id), sh = s.shipments.find((x) => x.contractId === c.id)!;
    const amount = oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, sh.arrivalDay!, sh.arrivalDay!, c.purchaseAmountMinor, 'KRW', c.acceptedDay);
    const duty = entryAmount(s, 'DUTY-', c)!;
    expect(duty.lines.find((l) => l.account === 'INVENTORY')!.amount).toBe(amount);
    expect(amount).not.toBe(p.duty);
    const report = identity(s, cfg, c.id);
    expect(report.components.tariff).not.toBe(0); expect(report.components.tariff).toBe(stageTariff(s, cfg, c, amount));
    expect(s.contracts.find((x) => x.id === c.id)!.priceReductionMinor).toBe(0);
    console.log('정시 사례', JSON.stringify({ seed: cfg.seed, notice: e.noticeDay, arrival: sh.arrivalDay, components: report.components }));
  });
  it('관세 0 도착: 뒤 인상에도 완료·남은 관세 없음, 미리보기와 도착 전 대조', () => {
    const copy = structuredClone(profile), cc = copy.tariff.base[0]!.countryCode;
    for (const row of copy.tariff.base.filter((r) => r.countryCode === cc)) row.rateBp = 100;
    const v = findEventCase(({ cfg, c, e, sailing }) => {
      const events = oracleEvents(cfg, cfg.seed), n = sailing.scheduledArrivalDay;
      return e.countryCode === cc && e.stepBp < 0 && e.effectiveDay <= n
        && oracleRate(cfg, events, cc, c.goodId, n, n) === 0
        && events.some((later) => later.countryCode === cc && later.stepBp > 0 && later.noticeDay > n
          && oracleRate(cfg, events, cc, c.goodId, later.effectiveDay, later.effectiveDay) > 0);
    }, copy);
    const { cfg, c, sailing } = v, events = oracleEvents(cfg, cfg.seed), n = sailing.scheduledArrivalDay;
    const positive = events.find((e) => e.countryCode === cc && e.stepBp > 0 && e.noticeDay > n
      && oracleRate(cfg, events, cc, c.goodId, e.effectiveDay, e.effectiveDay) > 0)!;
    expect(positive).toBeDefined(); expect(oracleRate(cfg, events, cc, c.goodId, n, n)).toBe(0);
    const before = advance(v.s, cfg, n);
    expect(before.shipments.find((sh) => sh.contractId === c.id)!.dutyMinor).toBeNull();
    vi.mocked(dutyFor).mockClear(); contractRiskReport(before, cfg, c.id);
    expect(vi.mocked(dutyFor)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(dutyFor).mock.calls.filter((args) => args[5] !== c.acceptedDay)).toHaveLength(1);
    const arrived = advance(before, cfg, n + 1), sh = arrived.shipments.find((sh) => sh.contractId === c.id)!;
    expect(sh.arrivalDay).toBe(n); expect(sh.dutyMinor).toBe(0); expect(sh.dutyPaid).toBe(true);
    expect(entryAmount(arrived, 'DUTY-', c)).toBeUndefined();
    const completed = finish(arrived, cfg, c.id), arrivalRate = rateAt(cfg, cfg.seed, sh.arrivalDay!);
    const publish = cfg.operations!.market.publish;
    const evaluationDay = Array.from({ length: cfg.campaignDays }, (_, i) => i + 1).find((day) =>
      day >= Math.max(completed.day, positive.effectiveDay)
      && (day - publish.firstDay) % publish.intervalDays === 0
      && rateAt(cfg, cfg.seed, day) !== arrivalRate);
    expect(evaluationDay).toBeDefined();
    const s = advance(completed, cfg, evaluationDay!);
    expect(s.day).toBe(evaluationDay);
    expect(rateAt(cfg, cfg.seed, s.day)).not.toBe(arrivalRate);
    expect(s.phase).not.toBe('ENDED'); expect(s.contracts.find((v) => v.id === c.id)!.status).toBe('COMPLETED');
    expect(s.day).toBeGreaterThanOrEqual(positive.effectiveDay);
    expect(oracleRate(cfg, events, cc, c.goodId, s.day, s.day)).toBeGreaterThan(0);
    vi.mocked(dutyFor).mockClear(); const report = contractRiskReport(s, cfg, c.id);
    // 0062 계약대로 0단계 미리보기 호출은 남는다. 남은 관세를 구하는 호출만 0회다.
    expect(vi.mocked(dutyFor)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dutyFor).mock.calls.every((args) => args[5] === c.acceptedDay)).toBe(true);
    expect(vi.mocked(dutyFor).mock.calls.filter((args) => args[5] !== c.acceptedDay)).toHaveLength(0);
    expect(report.open).toBe(false);
    expect(report.realized).toBe(independent(s, cfg, c).realized);
    const first = listSailings(cfg, sailing.routeId, c.acceptedDay + 1)[0]!;
    const old = oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, first.scheduledArrivalDay, c.acceptedDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay);
    const r = arrivalRate, freight = entryAmount(s, 'FREIGHT-PREPAY-', c)!;
    const fr = rateAt(cfg, cfg.seed, freight.day) === r ? freight.lines.find((l) => l.account === 'PREPAID_FREIGHT')!.amount : 0;
    expect(old).toBeGreaterThan(0);
    const freightMinor = freight.lines.find((l) => l.account === 'PREPAID_FREIGHT')!.amount;
    const freightRate = rateAt(cfg, cfg.seed, freight.day), invoice = s.invoices.find((i) => i.contractId === c.id)!;
    const lateDays = Math.max(0, first.scheduledArrivalDay + cfg.terms.customsDays - c.deliveryDeadlineDay);
    const sale0 = c.saleAmountMinor - Math.min(bpAmount(c.saleAmountMinor, cfg.terms.lateDeliveryCapBasisPoints!),
      lateDays * cfg.terms.lateDeliveryPriceReductionMinor);
    // 2단계의 기대 금액을 환율별로 묶어 환산한다. 날짜만 바꾼 변형도 따로 계산한다.
    const expectedFx = (dutyDay: number) => {
      const costs = new Map<number, number>([[freightRate, -freightMinor]]);
      const dutyRate = rateAt(cfg, cfg.seed, dutyDay);
      costs.set(dutyRate, (costs.get(dutyRate) ?? 0) - old);
      return toKrw(sale0, rateAt(cfg, cfg.seed, Math.min(invoice.dueDay, s.day))) - c.purchaseAmountMinor
        + [...costs].reduce((sum, [rate, amount]) => sum + toKrw(amount, rate), 0) - independent(s, cfg, c).expected;
    };
    const evaluationRate = rateAt(cfg, cfg.seed, s.day), evaluationFr = freightRate === evaluationRate ? freightMinor : 0;
    const wrongTariff = toKrw(-evaluationFr, evaluationRate) - toKrw(-(evaluationFr + old), evaluationRate);
    expect(expectedFx(sh.arrivalDay!)).not.toBe(expectedFx(s.day));
    expect(toKrw(-fr, r) - toKrw(-(fr + old), r)).not.toBe(wrongTariff);
    expect(report.components.fx).toBe(expectedFx(sh.arrivalDay!));
    expect(report.components.fx).not.toBe(expectedFx(s.day));
    expect(report.components.tariff).not.toBe(wrongTariff);
    expect(report.components.tariff).toBe(toKrw(-fr, r) - toKrw(-(fr + old), r));
    expect(report.components.residual).toBe(0); identity(s, cfg, c.id);
    // 같은 설정에서 공지된 0 세율을 실제 다음 편 미리보기에 적용한다.
    const zeroDay = Array.from({ length: n }, (_, i) => i + 1).find((day) => {
      const a = listSailings(cfg, sailing.routeId, day + 1)[0]?.scheduledArrivalDay;
      return a !== undefined && oracleRate(cfg, events, cc, c.goodId, day, a) === 0;
    });
    expect(zeroDay).toBeDefined();
    const p = preview(cfg, 'DIRECT_TRADE', c.originCityId, c.destinationCityId, zeroDay!,
      { purchase: c.purchaseAmountMinor, sale: c.saleAmountMinor }, c.deliveryDeadlineDay, c.paymentDueDay,
      { goodId: c.goodId, purchaseCurrency: 'KRW' })!;
    expect(p.duty).toBe(0);
    expect(p.schedule.find((line) => line.day === p.arrivalDay && line.labelKo.startsWith('도착')))
      .toMatchObject({ labelKo: '도착·관세 지급', amount: 0 });
    console.log('관세 0 도착 사례', JSON.stringify({ seed: cfg.seed, country: cc, baseBp: 100, stepBp: copy.tariff.stepBp,
      accepted: c.acceptedDay, arrival: n, evaluation: s.day, positive, old, r, fr, evaluationRate, wrongFx: expectedFx(s.day), wrongTariff, components: report.components }));
  }, 60000);
  it('도착 공지 기준일: 도착일 아침 공지·동일 일 시행', () => {
    const p = structuredClone(profile); p.tariff.lagDays = [0, 0];
    const v = findEventCase(({ cfg, c, e, sailing, p }) => sailing.scheduledArrivalDay === e.noticeDay
      && oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, e.noticeDay, e.noticeDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay)
        !== oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, e.noticeDay, e.noticeDay - 1, c.purchaseAmountMinor, 'KRW', c.acceptedDay)
      && c.acceptedDay < sailing.departureDay && oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, e.noticeDay, e.noticeDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay) !== p.duty, p);
    expect(v.sailing.scheduledArrivalDay).toBe(v.e.noticeDay); expect(v.e.effectiveDay).toBe(v.e.noticeDay);
    expect(oracleDuty(v.cfg, v.cfg.seed, v.c.goodId, v.c.destinationCityId, v.e.noticeDay, v.e.noticeDay, v.c.purchaseAmountMinor, 'KRW', v.c.acceptedDay))
      .not.toBe(oracleDuty(v.cfg, v.cfg.seed, v.c.goodId, v.c.destinationCityId, v.e.noticeDay, v.e.noticeDay - 1, v.c.purchaseAmountMinor, 'KRW', v.c.acceptedDay));
    const s = advance(v.s, v.cfg, v.e.noticeDay + 1), sh = s.shipments[0]!;
    expect(sh.arrivalDay).toBe(v.e.noticeDay);
    expect(sh.dutyMinor).toBe(oracleDuty(v.cfg, v.cfg.seed, v.c.goodId, v.c.destinationCityId, v.e.noticeDay, v.e.noticeDay, v.c.purchaseAmountMinor, 'KRW', v.c.acceptedDay));
  });
  it('자금 예약 관세·미래 누설 없음(a): 운송 중 공지 전후와 양성 대조', () => {
    const v = findEventCase(({ cfg, c, e, sailing }) => sailing.departureDay < e.noticeDay - 1 && e.noticeDay <= sailing.scheduledArrivalDay
      && e.effectiveDay > e.noticeDay - 1 && e.effectiveDay <= sailing.scheduledArrivalDay
      && oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, sailing.scheduledArrivalDay, e.noticeDay - 1, c.purchaseAmountMinor, 'KRW', c.acceptedDay)
        !== oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, sailing.scheduledArrivalDay, e.noticeDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay));
    const { cfg, c, e, sailing } = v;
    const before = advance(v.s, cfg, e.noticeDay - 1), after = advance(before, cfg, e.noticeDay);
    expect(country(cfg, c.destinationCityId)).toBe(e.countryCode);
    expect(e.effectiveDay).toBeGreaterThan(before.day); expect(sailing.scheduledArrivalDay).toBeGreaterThanOrEqual(e.effectiveDay);
    expect(dutyFor(cfg, cfg.seed, c.goodId, c.destinationCityId, sailing.scheduledArrivalDay, before.day, c.purchaseAmountMinor, 'KRW', c.acceptedDay))
      .not.toBe(dutyFor(cfg, cfg.seed, c.goodId, c.destinationCityId, sailing.scheduledArrivalDay, sailing.scheduledArrivalDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay));
    const reports = [];
    for (const s of [before, after]) {
      expect(s.shipments[0]!.arrivalDay).toBeNull(); expect(s.shipments[0]!.departureDay).toBeLessThan(s.day);
      const amount = oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, sailing.scheduledArrivalDay, s.day, c.purchaseAmountMinor, 'KRW', c.acceptedDay);
      expect(cashReservations(s, cfg).find((r) => r.contractId === c.id && r.kind === 'DUTY')!.amountMinor).toBe(amount);
      const report = identity(s, cfg, c.id); expect(report.components.tariff).toBe(stageTariff(s, cfg, c, amount)); reports.push(report);
    }
    expect(reports[0]!.components.tariff).not.toBe(reports[1]!.components.tariff);
  });
  it('수락 자금 검사 관세: 늦은 plan 편보다 다음 첫 편이 먼저 시행 전 도착', () => {
    const p = structuredClone(profile); p.tariff.lagDays = [10, 10];
    let found: { cfg: ScenarioConfig; before: GameState; pair: Pair; first: Sailing; later: Sailing; e: TariffEvent; cmd: EngineCommand } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed, p), publish = cfg.operations!.market.publish;
      for (const e of tariffEvents(cfg, seed)) {
        const d = publish.firstDay + Math.ceil((e.noticeDay - publish.firstDay) / publish.intervalDays) * publish.intervalDays;
        if (d >= e.effectiveDay || d > publish.lastDay) continue;
        const s = advance(fresh(cfg), cfg, d); if (s.phase === 'ENDED' || s.day !== d) continue;
        for (const pair of openTradePairs(s, cfg)) {
          const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
          if (country(cfg, sell.cityId) !== e.countryCode) continue;
          const sails = listSailings(cfg, routeBetween(cfg, buy.cityId, sell.cityId)!.id, d + 1), first = sails[0], later = sails.find((x) => x.scheduledArrivalDay >= e.effectiveDay);
          if (!first || !later || first.scheduledArrivalDay >= e.effectiveDay) continue;
          const amount = buy.unitPriceMinor * buy.quantity;
          if (oracleDuty(cfg, seed, buy.goodId, sell.cityId, first.scheduledArrivalDay, d, amount, 'KRW', d) === oracleDuty(cfg, seed, buy.goodId, sell.cityId, later.scheduledArrivalDay, d, amount, 'KRW', d)) continue;
          const trial = tryTrade(s, cfg, pair, later);
          if (trial.results[0]!.status === 'APPLIED') { found = { cfg, before: trial.before, pair, first, later, e, cmd: trial.cmd }; break; }
        }
        if (found) break;
      }
    }
    expect(found).toBeDefined(); const { cfg, before, pair, first, later, e, cmd } = found!;
    expect(e.noticeDay).toBeLessThanOrEqual(before.day); expect(before.day).toBeLessThan(e.effectiveDay);
    expect(first.scheduledArrivalDay).toBeLessThan(e.effectiveDay); expect(later.scheduledArrivalDay).toBeGreaterThanOrEqual(e.effectiveDay);
    const buy = offerDef(before, cfg, pair.buyOfferId)!, sell = offerDef(before, cfg, pair.sellOfferId)!;
    const expected = oracleDuty(cfg, cfg.seed, buy.goodId, sell.cityId, first.scheduledArrivalDay, before.day, buy.unitPriceMinor * buy.quantity, 'KRW', before.day);
    vi.mocked(dutyFor).mockClear(); const result = planState(before, cfg, [cmd]); expect(result.results[0]!.status).toBe('APPLIED');
    expect(vi.mocked(dutyFor).mock.calls[0]![4]).toBe(first.scheduledArrivalDay);
    expect(vi.mocked(dutyFor).mock.results[0]!.value).toBe(expected); expect(quotePreview(before, cfg, pair)!.duty).toBe(expected);
  });
  it('운송 중 예약 tariffDay: 항만 제한으로 예정일이 지나면 오늘', () => {
    const v = exposureCase(), cfg = structuredClone(v.cfg), arrival = v.sailing.scheduledArrivalDay;
    cfg.portRestrictions.push({ ...cfg.portRestrictions[0]!, eventInstanceId: '시험-항만', cityId: v.c.destinationCityId,
      announceDay: v.c.acceptedDay + 1, startDay: arrival, endDay: arrival + cfg.operations!.market.publish.intervalDays });
    const s = advance(v.s, cfg, arrival + 1), sh = s.shipments[0]!;
    expect(sh.scheduledArrivalDay).toBeLessThan(s.day); expect(sh.arrivalDay).toBeNull();
    vi.mocked(dutyFor).mockClear(); const reserved = cashReservations(s, cfg);
    expect(vi.mocked(dutyFor).mock.calls.find((call) => call[2] === v.c.goodId)![4]).toBe(s.day);
    expect(reserved.find((r) => r.contractId === v.c.id && r.kind === 'DUTY')!.amountMinor)
      .toBe(oracleDuty(cfg, cfg.seed, v.c.goodId, v.c.destinationCityId, s.day, s.day, v.c.purchaseAmountMinor, 'KRW', v.c.acceptedDay));
  });
});

let surchargeSeeds: { positive: number; zero: number } | undefined;
function costSeeds() {
  if (surchargeSeeds) return surchargeSeeds;
  let positive: number | undefined, zero: number | undefined;
  for (let seed = 1; seed <= 200 && (!positive || !zero); seed++) {
    const cfg = cfgFor(seed), ctx = previewContexts(cfg)[0]!, sail = listSailings(cfg, ctx.route.id, 2)[1]!;
    const bp = oracleSurcharge(cfg, seed, ctx.route.id, week(cfg, sail.departureDay));
    if (bp === 0) zero ??= seed;
    if (bp > 0 && rateAt(cfg, seed, sail.departureDay) !== rateAt(cfg, seed, 1)) positive ??= seed;
  }
  expect(positive).toBeDefined(); expect(zero).toBeDefined();
  return surchargeSeeds = { positive: positive!, zero: zero! };
}
describe('TASK-0063 출항 부대비와 항등식', () => {
  it('부대비 ①②③·미래 누설 없음(b): 같은 편의 양수·0·주선 대조', () => {
    const { positive, zero } = costSeeds();
    for (const [seed, forwarding] of [[positive, false], [zero, false], [positive, true]] as const) {
      const cfg = cfgFor(seed), x = setup(cfg, 1, forwarding), booking = x.s.bookings[0]!;
      const bp = oracleSurcharge(cfg, seed, booking.routeId, week(cfg, x.sailing.departureDay));
      expect(bp > 0).toBe(seed === positive);
      expect(x.sailing.departureDay).not.toBe(x.c.acceptedDay);
      const before = advance(x.s, cfg, x.sailing.departureDay);
      expect(before.ledger.entries.some((e) => e.id.startsWith('SURCHARGE-'))).toBe(false);
      expect(identity(before, cfg, x.c.id).components.surcharge).toBe(0);
      const after = advance(before, cfg, x.sailing.departureDay + 1);
      expect(after.bookings[0]!.status).toBe('DEPARTED');
      const entries = after.ledger.entries.filter((e) => e.id.startsWith('SURCHARGE-'));
      if (!forwarding && seed === positive) {
        expect(entries).toHaveLength(1); expect(entries[0]!.id).toBe(`SURCHARGE-${booking.id}`);
        expect(entries[0]!.day).toBe(x.sailing.departureDay); expect(entries[0]!.contractId).toBe(x.c.id);
        expect(entries[0]!.lines.find((l) => l.account === 'INVENTORY')!.amount).toBe(bpAmount(booking.prepaidFreightMinor, bp));
        expect(identity(after, cfg, x.c.id).components.surcharge).not.toBe(0);
      } else {
        expect(entries).toEqual([]); expect(identity(after, cfg, x.c.id).components.surcharge).toBe(0);
      }
    }
  });
  it('편 놓침: 준비 미배정으로 해제된 예약에 부대비 없음', () => {
    let found: { cfg: ScenarioConfig; s: GameState; sailing: Sailing } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed); let s = fresh(cfg);
      const pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
      const route = routeBetween(cfg, buy.cityId, sell.cityId)!, sailing = listSailings(cfg, route.id, s.day + 1)[0]!;
      if (oracleSurcharge(cfg, seed, route.id, week(cfg, sailing.departureDay)) <= 0) continue;
      s = fund(s, cfg, buy.unitPriceMinor * buy.quantity);
      const trial = planState(s, cfg, [{ id: '준비 미배정', type: 'ACCEPT_TRADE', ...pair, plan: { sailingId: sailing.id } }]);
      if (trial.results[0]!.status === 'APPLIED') found = { cfg, s: trial.state, sailing };
    }
    expect(found).toBeDefined(); const { cfg, sailing } = found!, b = found!.s.bookings[0]!;
    expect(oracleSurcharge(cfg, cfg.seed, b.routeId, week(cfg, sailing.departureDay))).toBeGreaterThan(0);
    const s = advance(found!.s, cfg, sailing.departureDay + 1);
    expect(s.bookings.find((v) => v.id === b.id)!.status).toBe('CANCELLED');
    expect(s.ledger.entries.some((e) => e.id === `SURCHARGE-${b.id}`)).toBe(false);
    expect(s.obligations.some((o) => o.id === `SURCHARGE-${b.id}`)).toBe(false);
    expect(identity(s, cfg, b.contractId).components.surcharge).toBe(0);
  });
  it('부대비 ④: 둘째 편, 다른 환율, 원장 현금과 4단계 환산', () => {
    const cfg = cfgFor(costSeeds().positive), x = setup(cfg, 1), s = finish(x.s, cfg, x.c.id), c = s.contracts[0]!;
    const cost = entryAmount(s, 'SURCHARGE-', c)!, duty = entryAmount(s, 'DUTY-', c)!, freight = entryAmount(s, 'FREIGHT-PREPAY-', c)!;
    const amount = cost.lines.find((l) => l.account === 'INVENTORY')!.amount, d = duty.lines.find((l) => l.account === 'INVENTORY')!.amount;
    expect(amount).toBeGreaterThan(0); expect(cost.day).toBe(x.sailing.departureDay);
    for (const e of [cost, duty]) expect(e.lines.some((l) => l.account === 'CASH')).toBe(true);
    const r = rateAt(cfg, cfg.seed, cost.day); expect(r).not.toBe(rateAt(cfg, cfg.seed, c.acceptedDay));
    const cr = (rateAt(cfg, cfg.seed, freight.day) === r ? x.s.bookings[0]!.prepaidFreightMinor : 0) + (rateAt(cfg, cfg.seed, duty.day) === r ? d : 0);
    const report = identity(s, cfg, c.id);
    expect(report.components.surcharge).toBe(toKrw(-(cr + amount), r) - toKrw(-cr, r));
    expect(s.ledger.entries.filter((e) => e.contractId === c.id && e.currency === 'USD').flatMap((e) => e.lines).filter((l) => l.account === 'INVENTORY').reduce((n, l) => n + l.amount, 0)).toBe(0);
    console.log('부대비 사례', JSON.stringify({ seed: cfg.seed, amount, components: report.components }));
  });
  it('부대비 ⑤: 실제 운임의 반올림과 floor가 다른 편', () => {
    let found: { cfg: ScenarioConfig; s: GameState; sailing: Sailing } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed), opened = fresh(cfg);
      for (const pair of openTradePairs(opened, cfg)) {
        const buy = offerDef(opened, cfg, pair.buyOfferId)!, sell = offerDef(opened, cfg, pair.sellOfferId)!;
        const route = routeBetween(cfg, buy.cityId, sell.cityId)!;
        for (const sailing of listSailings(cfg, route.id, opened.day + 1)) {
          const bp = oracleSurcharge(cfg, seed, route.id, week(cfg, sailing.departureDay));
          if ((route.bookingFeeMinor * bp) % 10000 < 5000) continue;
          const trial = tryTrade(opened, cfg, pair, sailing); if (trial.results[0]!.status !== 'APPLIED') continue;
          const s = advance(trial.state, cfg, sailing.departureDay + 1);
          if (s.bookings[0]!.status === 'DEPARTED') { found = { cfg, s, sailing }; break; }
        }
        if (found) break;
      }
    }
    expect(found).toBeDefined(); const { cfg, s, sailing } = found!, b = s.bookings[0]!;
    const bp = oracleSurcharge(cfg, cfg.seed, b.routeId, week(cfg, sailing.departureDay)), n = b.prepaidFreightMinor * bp;
    expect(Math.floor(n / 10000)).not.toBe(Math.floor((n + 5000) / 10000));
    const entries = s.ledger.entries.filter((e) => e.id === `SURCHARGE-${b.id}`); expect(entries).toHaveLength(1);
    expect(entries[0]!.lines.find((l) => l.account === 'INVENTORY')!.amount).toBe(Math.floor((n + 5000) / 10000));
  });
  it('항등식: 열린 운송 중의 평가일 환율·관세 미지급·부대비 미지급', () => {
    const cfg = cfgFor(costSeeds().positive), x = setup(cfg, 1);
    const travelling = advance(x.s, cfg, x.sailing.departureDay + 1);
    expect(travelling.shipments[0]!.arrivalDay).toBeNull(); expect(rateAt(cfg, cfg.seed, travelling.day)).not.toBe(rateAt(cfg, cfg.seed, x.c.acceptedDay));
    expect(identity(travelling, cfg, x.c.id).open).toBe(true);
    const first = setup(cfg), preArrival = advance(first.s, cfg, first.sailing.scheduledArrivalDay - 1);
    inject(preArrival, balance(preArrival.ledger, 'USD', 'CASH') + preArrival.invoices.filter((i) => i.dueDay === preArrival.day).reduce((n, i) => n + i.amountMinor, 0), '관세 전 현금 정산');
    const unpaidDuty = advance(preArrival, cfg, first.sailing.scheduledArrivalDay + 1);
    expect(unpaidDuty.shipments[0]!.dutyPaid).toBe(false);
    expect(unpaidDuty.obligations.some((o) => o.id.startsWith('DUTY-') && o.paidDay === null)).toBe(true);
    expect(rateAt(cfg, cfg.seed, unpaidDuty.day)).not.toBe(rateAt(cfg, cfg.seed, first.c.acceptedDay));
    expect(rateAt(cfg, cfg.seed, unpaidDuty.day)).not.toBe(cfg.operations!.fx.baseKrwPerUsd);
    expect(identity(unpaidDuty, cfg, first.c.id).open).toBe(true);
    const preDeparture = advance(x.s, cfg, x.sailing.departureDay - 1);
    inject(preDeparture, balance(preDeparture.ledger, 'USD', 'CASH') + preDeparture.invoices.filter((i) => i.dueDay === preDeparture.day).reduce((n, i) => n + i.amountMinor, 0), '부대비 전 현금 정산');
    let unpaidSurcharge = advance(preDeparture, cfg, x.sailing.departureDay + 1);
    expect(unpaidSurcharge.obligations.some((o) => o.id.startsWith('SURCHARGE-') && o.paidDay === null)).toBe(true);
    expect(identity(unpaidSurcharge, cfg, x.c.id).components.surcharge).not.toBe(0);
    const surchargeId = `SURCHARGE-${x.s.bookings[0]!.id}`, departureRate = rateAt(cfg, cfg.seed, x.sailing.departureDay);
    while (unpaidSurcharge.phase !== 'ENDED'
      && unpaidSurcharge.obligations.some((o) => o.id === surchargeId && o.paidDay === null)
      && rateAt(cfg, cfg.seed, unpaidSurcharge.day) === departureRate) {
      unpaidSurcharge = advance(unpaidSurcharge, cfg, unpaidSurcharge.day + 1);
    }
    const obligation = unpaidSurcharge.obligations.find((o) => o.id === surchargeId)!;
    expect(obligation.paidDay).toBeNull(); expect(unpaidSurcharge.phase).not.toBe('ENDED');
    const evaluationRate = rateAt(cfg, cfg.seed, unpaidSurcharge.day);
    expect(evaluationRate).not.toBe(departureRate);
    // 3단계 USD 비용 중 해당 환율인 운임·관세만 합한다. 제품 단계 값은 읽지 않는다.
    const surchargeExpected = (s: GameState, r: number) => {
      const sh = s.shipments.find((v) => v.contractId === x.c.id)!;
      const duty = entryAmount(s, 'DUTY-', x.c), freight = entryAmount(s, 'FREIGHT-PREPAY-', x.c)!;
      const dutyObligation = s.obligations.find((o) => o.id === duty?.id);
      const dutyDay = dutyObligation ? dutyObligation.paidDay ?? s.day : duty?.day ?? s.day;
      const dutyAmount = duty ? duty.lines.find((l) => l.account === 'INVENTORY')!.amount
        : sh.dutyMinor !== null ? 0 : oracleDuty(cfg, cfg.seed, x.c.goodId, x.c.destinationCityId,
          Math.max(sh.scheduledArrivalDay, s.day), s.day, x.c.purchaseAmountMinor, 'KRW', x.c.acceptedDay);
      const cr = (rateAt(cfg, cfg.seed, Math.min(dutyDay, s.day)) === r ? dutyAmount : 0)
        + (rateAt(cfg, cfg.seed, freight.day) === r ? freight.lines.find((l) => l.account === 'PREPAID_FREIGHT')!.amount : 0);
      return toKrw(-(cr + obligation.amountMinor), r) - toKrw(-cr, r);
    };
    const unpaidReport = identity(unpaidSurcharge, cfg, x.c.id);
    expect(unpaidReport.components.surcharge).toBe(surchargeExpected(unpaidSurcharge, evaluationRate));
    // 미지급 의무는 그대로 두고 상환 자금만 넣는다. 다음 마감의 공개 엔진이 갚는다.
    const paidDay = unpaidSurcharge.day, funded = structuredClone(unpaidSurcharge);
    post(funded.ledger, { id: '부대비 상환 자금', day: paidDay, currency: 'USD', reason: '시험 상환 자금', lines: [
      { account: 'CASH', amount: obligation.amountMinor }, { account: 'OPENING_EQUITY', amount: -obligation.amountMinor },
    ] });
    let paid = advance(funded, cfg, paidDay + 1);
    expect(paid.obligations.find((o) => o.id === surchargeId)!.paidDay).toBe(paidDay);
    expect(rateAt(cfg, cfg.seed, paidDay)).not.toBe(departureRate);
    while (paid.phase !== 'ENDED' && rateAt(cfg, cfg.seed, paid.day) === evaluationRate) paid = advance(paid, cfg, paid.day + 1);
    expect(paid.phase).not.toBe('ENDED'); expect(rateAt(cfg, cfg.seed, paid.day)).not.toBe(evaluationRate);
    const paidReport = identity(paid, cfg, x.c.id);
    expect(paidReport.components.surcharge).toBe(surchargeExpected(paid, rateAt(cfg, cfg.seed, paidDay)));
    console.log('미지급·상환 환율 사례', JSON.stringify({ seed: cfg.seed, departure: x.sailing.departureDay, departureRate,
      unpaidDay: unpaidSurcharge.day, evaluationRate, paidDay, laterDay: paid.day, laterRate: rateAt(cfg, cfg.seed, paid.day),
      surcharge: obligation.amountMinor, unpaidComponents: unpaidReport.components, paidComponents: paidReport.components }));
  });
  it('항등식: 관세 차이가 생긴 출항 전 취소의 3·4단계는 0', () => {
    const v = findEventCase(({ cfg, c, e, p }) => {
      const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!, t = e.noticeDay;
      const arrival = listSailings(cfg, route.id, t + 1)[0]?.scheduledArrivalDay ?? t;
      return e.noticeDay > c.acceptedDay && oracleDuty(cfg, cfg.seed, c.goodId, c.destinationCityId, arrival, t, c.purchaseAmountMinor, 'KRW', c.acceptedDay) !== p.duty;
    }, profile, 1);
    let s = apply(v.s, v.cfg, { id: '출항 전 취소', type: 'CANCEL_CONTRACT', contractId: v.c.id });
    s = advance(s, v.cfg, v.e.noticeDay);
    const c = s.contracts[0]!, route = routeBetween(v.cfg, c.originCityId, c.destinationCityId)!;
    expect(c.status).toBe('CANCELLED'); expect(s.day).toBeGreaterThanOrEqual(v.e.noticeDay);
    const arrival = listSailings(v.cfg, route.id, s.day + 1)[0]?.scheduledArrivalDay ?? s.day;
    expect(dutyFor(v.cfg, s.rng.seed, c.goodId, c.destinationCityId, arrival, s.day, c.purchaseAmountMinor, 'KRW', c.acceptedDay)).not.toBe(v.p.duty);
    const r = identity(s, v.cfg, c.id); expect(r.components.tariff).toBe(0); expect(r.components.surcharge).toBe(0);
  });
  it('주선(R2): 표에 없는 품목도 출항 전·운송 중·도착 뒤·완료에 관세 호출 없음', () => {
    const cfg = cfgFor(costSeeds().positive), s0 = fresh(cfg);
    const fwd = cfg.offers.find((o) => o.kind === 'forwarding' && !profile.tariff.base.some((r) => r.countryCode === country(cfg, o.destinationCityId!) && r.goodId === o.goodId));
    expect(fwd).toBeDefined();
    const route = routeBetween(cfg, fwd!.cityId, fwd!.destinationCityId!)!, sailing = listSailings(cfg, route.id, s0.day + 1)[0]!;
    let s = apply(s0, cfg, { id: '표 밖 주선', type: 'ACCEPT_FORWARDING', offerId: fwd!.id, plan: { sailingId: sailing.id,
      employeeId: s0.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId)!.id } });
    const id = s.contracts[0]!.id, stages = new Set<string>();
    while (s.phase !== 'ENDED') {
      const c = s.contracts[0]!, sh = s.shipments[0];
      stages.add(c.status === 'COMPLETED' ? '완료' : !sh ? '출항 전' : sh.arrivalDay === null ? '운송 중' : '도착 뒤');
      vi.mocked(dutyFor).mockClear(); const report = contractRiskReport(s, cfg, id);
      expect(vi.mocked(dutyFor)).not.toHaveBeenCalled(); expect(report.components).toMatchObject({ tariff: 0, surcharge: 0, residual: 0 });
      identity(s, cfg, id);
      if (c.status === 'COMPLETED') break;
      s = advance(s, cfg, s.day + 1);
    }
    expect([...stages].sort()).toEqual(['도착 뒤', '완료', '운송 중', '출항 전'].sort());
  });
});

describe('TASK-0063 호환성과 진단', () => {
  it('새 층이 꺼진 R1: 관세·분개·일정·로그·상한 키 불변', () => {
    const cfg = cfgFor(1, profile, 'R1'), x = setup(cfg, 1), s = advance(finish(x.s, cfg, x.c.id), cfg, cfg.campaignDays + 1);
    expect(s.phase).toBe('ENDED'); expect(s.ledger.entries.some((e) => e.id.startsWith('SURCHARGE-'))).toBe(false);
    const amount = bpAmount(half(x.c.purchaseAmountMinor * 100, rateAt(cfg, cfg.seed, x.c.acceptedDay)), cfg.terms.dutyRateBasisPoints);
    expect(entryAmount(s, 'DUTY-', x.c)!.lines.find((l) => l.account === 'INVENTORY')!.amount).toBe(amount);
    expect(tariffEvents(cfg, cfg.seed)).toEqual([]); expect(tariffSchedule(s, cfg)).toEqual([]);
    expect(s.log.some((l) => l.textKo.includes('관세 일괄 변경'))).toBe(false);
    expect(contractPreview(s, cfg, x.c)).not.toHaveProperty('surchargeMaxBp');
    expect(surchargeBp(cfg, cfg.seed, x.sailing.routeId, week(cfg, x.sailing.departureDay))).toBe(0);
  });
  it('R2 변환·부대비 상한·기대값 식·종류별 키 존재', () => {
    const r1 = cfgFor(1, profile, 'R1'), r2 = cfgFor(), clone = structuredClone(r2);
    expect(r2.operations!.risk!.layers).toEqual(['FX', 'TARIFF', 'SURCHARGE']); clone.operations!.risk!.layers = ['FX']; expect(clone).toEqual(r1);
    const x = setup(r2), q = quotePreview(x.s, r2, x.pair)!, p = contractPreview(x.s, r2, x.c);
    expect(q.surchargeMaxBp).toBe(profile.surcharge.maxBp); expect(p.surchargeMaxBp).toBe(profile.surcharge.maxBp);
    const r = rateAt(r2, r2.seed, x.c.acceptedDay);
    expect(p.referenceEstimate!.pnlKrw).toBe(toKrw(p.sale, r) - p.purchase - toKrw(p.freight + p.duty, r));
    expect(p.cashNeed).toBe(p.freight + p.duty);
    for (const level of ['R0', 'R1', 'R2'] as const) for (const forwarding of [false, true]) {
      if (level === 'R2' && !forwarding) continue;
      const cfg = cfgFor(1, profile, level), v = setup(cfg, 0, forwarding);
      expect(contractPreview(v.s, cfg, v.c)).not.toHaveProperty('surchargeMaxBp');
      if (!forwarding) expect(quotePreview(v.s, cfg, v.pair)).not.toHaveProperty('surchargeMaxBp');
      else expect(quotePreview(v.s, cfg, { offerId: v.c.serviceOfferId! })).not.toHaveProperty('surchargeMaxBp');
    }
  });
  it('결정성·저장·커서 불변과 끝난 상태의 공지 평가일', () => {
    const cfg = cfgFor(costSeeds().positive), a = setup(cfg, 1), b = setup(cfg, 1);
    expect(a.s).toEqual(b.s);
    const s = finish(a.s, cfg, a.c.id), again = finish(b.s, cfg, b.c.id); expect(s).toEqual(again);
    const text = serializeSave(s), restored = deserializeSave(text, { config: cfg, dataVersion: cfg.dataVersion, rulesVersion: cfg.rules.rulesVersion });
    expect(serializeSave(restored)).toBe(text); expect(tariffSchedule(restored, cfg)).toEqual(tariffSchedule(s, cfg));
    expect(Object.keys(s.rng.cursors).filter((k) => /^(TARIFF|SURCHARGE|FX-REF)/.test(k))).toEqual([]);
    const ended = advance(s, cfg, cfg.campaignDays + 1), k = ended.operations?.failure?.day ?? cfg.campaignDays;
    expect(ended.phase).toBe('ENDED');
    expect(tariffSchedule(ended, cfg).map(eventKey).sort()).toEqual(oracleEvents(cfg, cfg.seed).filter((e) => e.noticeDay <= k).map(eventKey).sort());
    console.log('순수 함수 표', JSON.stringify([1, 2, costSeeds().positive].map((seed) => ({ seed, events: tariffEvents(cfg, seed),
      surcharge: cfg.routes.map((r) => ({ route: r.id, weeks: [1, 2, 3].map((w) => surchargeBp(cfg, seed, r.id, w)) })) }))));
  });
  it('실패 종료의 공지 평가일: 실패 다음 날·그 뒤 사건과 세율 제외', () => {
    let found: { cfg: ScenarioConfig; s: GameState } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed), opened = fresh(cfg), pair = openTradePairs(opened, cfg)[0]!;
      const buy = offerDef(opened, cfg, pair.buyOfferId)!, sell = offerDef(opened, cfg, pair.sellOfferId)!;
      for (let quantity = buy.quantityStep; quantity <= Math.min(buy.maxQuantity, sell.maxQuantity); quantity += buy.quantityStep) {
        const trial = planState(opened, cfg, [{ id: '실패 종료 매입', type: 'ACCEPT_TRADE', ...pair, quantity }]);
        if (trial.results[0]!.status !== 'APPLIED') continue;
        const s = advance(trial.state, cfg, cfg.campaignDays + 1, false), f = s.operations?.failure;
        if (!f) continue;
        const events = oracleEvents(cfg, seed);
        if (events.some((e) => e.noticeDay === f.day + 1) && events.some((e) => e.noticeDay > f.day + 1)) { found = { cfg, s }; break; }
      }
    }
    expect(found).toBeDefined(); const { cfg, s } = found!;
    expect(s.phase).toBe('ENDED'); expect(s.operations!.failure).not.toBeNull();
    const f = s.operations!.failure!.day, events = oracleEvents(cfg, cfg.seed);
    expect(tariffEvents(cfg, cfg.seed).some((e) => e.noticeDay === f + 1)).toBe(true);
    expect(events.some((e) => e.noticeDay > f + 1)).toBe(true); expect(s.day).toBe(f + 1);
    const countries = [...new Set(cfg.operations!.risk!.profile.tariff.base.map((r) => r.countryCode))];
    const expected = events.filter((e) => e.noticeDay <= f)
      .sort((a, b) => a.noticeDay - b.noticeDay || countries.indexOf(a.countryCode) - countries.indexOf(b.countryCode) || a.round - b.round);
    const schedule = tariffSchedule(s, cfg);
    expect(schedule.some((e) => e.noticeDay === f + 1)).toBe(false);
    expect(schedule.some((e) => e.noticeDay > f + 1)).toBe(false);
    expect(schedule.map(eventKey)).toEqual(expected.map(eventKey));
    for (const e of schedule) expect(e.rates).toEqual(oracleRates(cfg, cfg.seed, events.find((v) => sameNotice(v, e))!, f));
    console.log('실패 종료 공지 사례', JSON.stringify({ seed: cfg.seed, failureDay: f, day: s.day, events, visible: schedule }));
  }, 60000);
  it('원천 검사: 부대비는 출항 분기·주차 함수 인수, 관세 일정은 위험 모듈·아침 공지만', () => {
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });
    for (const [path, raw] of Object.entries(sources)) {
      const source = raw.replace(/export function (surchargeBp|surchargeWeek|tariffEvents)\(/g, '정의(');
      if (path !== './engine.ts') expect(source).not.toMatch(/\bsurchargeBp\(/);
      else {
        const start = source.indexOf('function processDepartures('), end = source.indexOf('function processArrivals(');
        expect(source.slice(0, start) + source.slice(end)).not.toMatch(/\bsurchargeBp\(/);
        const departures = source.slice(start, end);
        expect(departures.match(/\bsurchargeBp\(/g)).toHaveLength(1);
        expect(departures).toMatch(/surchargeBp\(config, s\.rng\.seed, booking\.routeId, surchargeWeek\(config, (booking\.departureDay|s\.day)\)\)/);
      }
      if (path !== './risk.ts') expect(raw).not.toMatch(/function surchargeWeek\(/);
      if (path !== './risk.ts' && path !== './engine.ts') expect(source).not.toMatch(/\btariffEvents\(/);
      if (path === './risk.ts') {
        const withoutReaders = (raw.slice(0, raw.indexOf('export function tariffSchedule('))
          + raw.slice(raw.indexOf('export function surchargeWeek('), raw.indexOf('export function dutyFor('))
          + raw.slice(raw.indexOf('export function withRiskLevel('))).replace(/export function tariffEvents\(/g, '정의(');
        expect(withoutReaders).not.toMatch(/\btariffEvents\(/);
      }
      if (path === './engine.ts') {
        const begin = source.indexOf('export function openDay('), end = source.indexOf('export function planCommands(');
        expect(source.slice(0, begin) + source.slice(end)).not.toMatch(/\btariffEvents\(/);
      }
    }
  });
  it('실패 기록 약정: 수락 뒤 공지로 실제 세율이 달라도 수락일 기대를 기록', () => {
    let found: { cfg: ScenarioConfig; s: GameState; c: Contract; a: number } | undefined;
    for (let seed = 1; seed <= 200 && !found; seed++) {
      const cfg = cfgFor(seed); let s = fresh(cfg);
      while (s.phase !== 'ENDED' && !s.obligations.some((o) => o.paidDay === null) && !found) {
        for (const pair of openTradePairs(s, cfg)) {
          const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
          for (let quantity = buy.quantityStep; quantity <= Math.min(buy.maxQuantity, sell.maxQuantity); quantity += buy.quantityStep) {
            const trial = planState(s, cfg, [{ id: '실패 전 매입', type: 'ACCEPT_TRADE', ...pair, quantity }]);
            if (trial.results[0]!.status !== 'APPLIED') continue;
            let closed = commitDay(trial.state, cfg, []).state;
            if (!closed.obligations.some((o) => o.currency === 'KRW' && o.incurredDay === s.day && o.paidDay === null)) continue;
            while (closed.phase !== 'ENDED') closed = commitDay(openDay(closed, cfg).state, cfg, []).state;
            const fail = closed.operations!.failure; if (!fail) continue;
            const c = closed.contracts[0]!, a = listSailings(cfg, routeBetween(cfg, c.originCityId, c.destinationCityId)!.id, c.acceptedDay + 1)[0]!.scheduledArrivalDay;
            if (!tariffEvents(cfg, seed).some((e) => e.countryCode === country(cfg, c.destinationCityId) && c.acceptedDay < e.noticeDay && e.noticeDay <= fail.day && e.effectiveDay <= a)) continue;
            if (oracleDuty(cfg, seed, c.goodId, c.destinationCityId, a, c.acceptedDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay) === oracleDuty(cfg, seed, c.goodId, c.destinationCityId, a, fail.day, c.purchaseAmountMinor, 'KRW', c.acceptedDay)) continue;
            found = { cfg, s: closed, c, a }; break;
          }
          if (found) break;
        }
        if (!found) s = advance(s, cfg, s.day + 1, false);
      }
    }
    expect(found).toBeDefined(); const { cfg, s, c, a } = found!, fail = s.operations!.failure!;
    expect(tariffEvents(cfg, cfg.seed).some((e) => e.countryCode === country(cfg, c.destinationCityId) && c.acceptedDay < e.noticeDay && e.noticeDay <= fail.day && e.effectiveDay <= a)).toBe(true);
    expect(dutyFor(cfg, cfg.seed, c.goodId, c.destinationCityId, a, c.acceptedDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay)).not.toBe(dutyFor(cfg, cfg.seed, c.goodId, c.destinationCityId, a, fail.day, c.purchaseAmountMinor, 'KRW', c.acceptedDay));
    const p = contractPreview(s, cfg, c);
    expect(fail.usdCommitmentsSinceIncurred.find((r) => r.id === c.id)!.amountMinor).toBe(p.freight + p.duty);
    expect(identity(s, cfg, c.id).evaluationDay).toBe(fail.day);
  }, 60000);
  it('정시 노출: 공개 함수 명령 구동기, 시드 1부터 첫 적중까지', () => {
    let result: { seed: number; changed: number; total: number } | undefined;
    const cumulative: { seed: number; changed: number; total: number }[] = [];
    for (let seed = 1; seed <= 200 && !result; seed++) {
      const cfg = cfgFor(seed); let s = fresh(cfg);
      const accepted = new Set<string>();
      while (s.phase !== 'ENDED') {
        s = fund(s, cfg);
        const p = cfg.operations!.market.publish;
        if (s.day <= p.lastDay && (s.day - p.firstDay) % p.intervalDays === 0) {
          const pairs = openTradePairs(s, cfg).map((pair) => ({ pair, q: quotePreview(s, cfg, pair)! }))
            .filter((v) => !v.q.lateOnNextSailing && v.q.referenceEstimate!.pnlKrw > 0)
            .sort((a, b) => b.q.referenceEstimate!.pnlKrw - a.q.referenceEstimate!.pnlKrw);
          for (const { pair, q } of pairs) {
            const sail = listSailings(cfg, q.routeId, s.day + 1)[0]!;
            const trial = tryTrade(s, cfg, pair, sail);
            if (trial.results[0]!.status !== 'APPLIED') continue;
            s = trial.state; accepted.add(s.contracts.at(-1)!.id); break;
          }
        }
        s = advance(s, cfg, s.day + 1);
      }
      const onTime = s.contracts.filter((c) => accepted.has(c.id) && c.deliveredDay !== null && c.deliveredDay <= c.deliveryDeadlineDay);
      const changed = onTime.filter((c) => {
        const report = identity(s, cfg, c.id), sh = s.shipments.find((v) => v.contractId === c.id)!;
        const first = listSailings(cfg, routeBetween(cfg, c.originCityId, c.destinationCityId)!.id, c.acceptedDay + 1)[0]!;
        const events = oracleEvents(cfg, seed), cc = country(cfg, c.destinationCityId);
        const different = oracleRate(cfg, events, cc, c.goodId, sh.arrivalDay!, sh.arrivalDay!)
          !== oracleRate(cfg, events, cc, c.goodId, c.acceptedDay, first.scheduledArrivalDay);
        expect(report.components.tariff !== 0).toBe(different);
        return different;
      }).length;
      cumulative.push({ seed, changed, total: onTime.length });
      if (changed) result = { seed, changed, total: onTime.length };
    }
    expect(result).toBeDefined(); expect(result!.changed).toBeGreaterThan(0);
    console.log('정시 노출 비율', JSON.stringify({ ...result, ratio: result!.changed / result!.total, cumulative }));
  }, 60000);
});
