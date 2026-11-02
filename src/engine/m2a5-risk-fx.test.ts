import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadRiskProfile, loadScenario, OPERATIONS_SCENARIO_IDS, riskProfiles } from '../content/scenario';
import { dutyEstimate, listSailings, routeBetween, routeOf } from './catalog';
import { commitDay, createGame, openDay, planState } from './engine';
import { balance, contractAmount, post } from './ledger';
import { offerDef, openTradePairs } from './market';
import { marketTable } from './market-lazy';
import marketRulesData from '../../data/market_rules.json';
import { applyBasisPoints, formatMoney, type Currency } from './money';
import { dailyKrwDue, exchangeAmounts, paymentDefaultStatus, usdLotKrw } from './operations';
import { exchangePreview, quotePreview, weeklyBottleneck } from './readers';
import { campaignSummary, contractReport, contractRiskReport, preview, tradePreview } from './reports';
import { cashReservations, fundsPosition } from './reservations';
import { createRng, drawUniform } from './rng';
import { divHalfAway, dutyFor, krwToUsdMinor, referenceRate, usdToKrwMinor, withRiskLevel } from './risk';
import { deserializeSave, serializeSave } from './save';
import type { Contract, EngineCommand, GameState, ScenarioConfig } from './types';

vi.mock('./rng', async (importOriginal) => {
  const m = await importOriginal<typeof import('./rng')>();
  return { ...m, drawUniform: vi.fn(m.drawUniform) };
});
vi.mock('./risk', async (importOriginal) => {
  const m = await importOriginal<typeof import('./risk')>();
  return { ...m, referenceRate: vi.fn(m.referenceRate), dutyFor: vi.fn(m.dutyFor) };
});
const original = await vi.importActual<typeof import('./risk')>('./risk');
afterEach(() => { vi.mocked(referenceRate).mockImplementation(original.referenceRate); vi.mocked(dutyFor).mockImplementation(original.dutyFor); });
const base = loadScenario(OPERATIONS_SCENARIO_IDS[0]);
const profile = riskProfiles()[0]!;
const config = (seed = base.seed, level: 'R0' | 'R1' = 'R1') => withRiskLevel({ ...base, seed }, level, profile);
const fresh = (cfg: ScenarioConfig) => openDay(createGame(cfg), cfg).state;
function apply(s: GameState, cfg: ScenarioConfig, cmd: EngineCommand): GameState {
  const result = planState(s, cfg, [cmd]);
  expect(result.results[0], JSON.stringify(cmd)).toMatchObject({ status: 'APPLIED' });
  return result.state;
}
function exchange(s: GameState, cfg: ScenarioConfig, lots = 1, direction: 'USD_TO_KRW' | 'KRW_TO_USD' = 'USD_TO_KRW') {
  return apply(s, cfg, { id: `환전-${s.day}-${s.operations!.exchanges.length}`, type: 'EXCHANGE_CURRENCY', direction,
    usdAmountMinor: cfg.operations!.fx.lotUsdMinor * lots });
}
function advance(s: GameState, cfg: ScenarioConfig, day: number, fund = true): GameState {
  while (s.day < day && s.phase !== 'ENDED') {
    s = openDay(s, cfg).state;
    if (fund && fundsPosition(s, cfg, 'KRW').available < dailyKrwDue(s, cfg, s.day)) s = exchange(s, cfg, Math.ceil((dailyKrwDue(s, cfg, s.day) - fundsPosition(s, cfg, 'KRW').available) / usdLotKrw(cfg, s)));
    s = commitDay(s, cfg, []).state;
  }
  return s.phase === 'ENDED' ? s : openDay(s, cfg).state;
}
function setup(cfg: ScenarioConfig, later = 0, forwarding = false, book = true) {
  let s = fresh(cfg);
  const pair = openTradePairs(s, cfg)[0]!;
  const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
  const fwd = cfg.offers.find((o) => o.kind === 'forwarding')!;
  const route = routeBetween(cfg, forwarding ? fwd.cityId : buy.cityId, forwarding ? fwd.destinationCityId! : sell.cityId)!;
  const sailing = listSailings(cfg, route.id, s.day + 1)[later]!;
  const employee = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId)!;
  if (!forwarding && buy.currency === 'KRW') {
    s = exchange(s, cfg);
    const need = Math.max(0, buy.unitPriceMinor * buy.quantity + dailyKrwDue(s, cfg, s.day) - fundsPosition(s, cfg, 'KRW').available);
    if (need) s = exchange(s, cfg, Math.ceil(need / usdLotKrw(cfg, s)));
  }
  const plan = { employeeId: employee.id, ...(book ? { sailingId: sailing.id } : {}) };
  s = apply(s, cfg, forwarding ? { id: '주선', type: 'ACCEPT_FORWARDING', offerId: fwd.id, plan }
    : { id: '무역', type: 'ACCEPT_TRADE', ...pair, plan });
  return { s, c: s.contracts[0]!, sailing, pair };
}
function finished(cfg: ScenarioConfig, later = 0, forwarding = false) {
  let { s } = setup(cfg, later, forwarding);
  for (let n = 0; n <= cfg.campaignDays && s.contracts[0]!.status !== 'COMPLETED'; n++) s = advance(s, cfg, s.day + 1);
  expect(s.contracts[0]!.status).toBe('COMPLETED');
  return s;
}
function roundtrip(s: GameState, cfg: ScenarioConfig) {
  const saved = serializeSave(s);
  const restored = deserializeSave(saved, { config: cfg, dataVersion: cfg.dataVersion, rulesVersion: cfg.rules.rulesVersion });
  expect(serializeSave(restored)).toBe(saved);
  return restored;
}
function changedSeed(day: number) {
  const seed = Array.from({ length: 200 }, (_, i) => i + 1).find((seed) => referenceRate(config(seed), seed, day) !== profile.fx.startKrwPerUsd);
  expect(seed, '200개 안에서 환율 변화 시드').toBeDefined();
  return seed!;
}
function inject(s: GameState, currency: Currency, amountMinor: number, incurredDay: number, id: string) {
  s.obligations.push({ id, currency, amountMinor, incurredDay, paidDay: null, reasonKo: '시험 지급 의무' });
  post(s.ledger, { id, day: incurredDay, currency, reason: '시험 지급 의무',
    lines: [{ account: 'WAGE_EXPENSE', amount: amountMinor }, { account: 'ACCOUNTS_PAYABLE', amount: -amountMinor }] });
}
// 보고서 구현과 독립적으로 원장 현금·의무 연결을 읽는다.
function cashValue(s: GameState, cfg: ScenarioConfig, c: Contract) {
  const entries = s.ledger.entries.filter((e) => e.contractId === c.id);
  const ids = new Set(entries.map((e) => e.id));
  entries.push(...s.ledger.entries.filter((e) => e.id.startsWith('SETTLE-') && ids.has(e.id.slice(7))));
  let total = 0;
  const costs = new Map<number, number>();
  for (const e of entries) for (const l of e.lines.filter((l) => l.account === 'CASH')) {
    if (e.currency === 'KRW') total += l.amount;
    else {
      const r = referenceRate(cfg, s.rng.seed, e.day);
      if (e.id.startsWith('RECEIPT-')) total += toKrw(l.amount, r);
      else costs.set(r, (costs.get(r) ?? 0) + l.amount);
    }
  }
  for (const [r, n] of costs) total += toKrw(n, r);
  return total;
}
// 제품 환산 도우미와 독립된 정수식으로 기대·현금의 환산을 검산한다.
const halfAway = (n: number, d: number) => Math.sign(n) * Math.floor((2 * Math.abs(n) + d) / (2 * d));
const toKrw = (cents: number, rate: number) => halfAway(cents * rate, 100);
function expectedValue(s: GameState, cfg: ScenarioConfig, c: Contract) {
  const r = referenceRate(cfg, s.rng.seed, c.acceptedDay);
  const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
  const arrival = listSailings(cfg, route.id, c.acceptedDay + 1)[0]!.scheduledArrivalDay;
  const lateDays = Math.max(0, arrival + cfg.terms.customsDays - c.deliveryDeadlineDay);
  const reduction = Math.min(halfAway(c.saleAmountMinor * cfg.terms.lateDeliveryCapBasisPoints!, 10000), lateDays * cfg.terms.lateDeliveryPriceReductionMinor);
  const krwPurchase = c.buyOfferId !== null && offerDef(s, cfg, c.buyOfferId!)!.currency === 'KRW';
  const usdPurchase = krwPurchase ? halfAway(c.purchaseAmountMinor * 100, r) : c.purchaseAmountMinor;
  const duty = c.kind === 'DIRECT_TRADE' ? halfAway(usdPurchase * cfg.terms.dutyRateBasisPoints, 10000) : 0;
  return toKrw(c.saleAmountMinor - reduction, r) - (krwPurchase ? c.purchaseAmountMinor : 0)
    - toKrw((krwPurchase ? 0 : c.purchaseAmountMinor) + route.bookingFeeMinor + duty, r);
}
function assertIdentity(s: GameState, cfg: ScenarioConfig, c: Contract, realized: number) {
  const report = contractRiskReport(s, cfg, c.id);
  const { residual, ...stages } = report.components;
  expect(report.expected).toBe(expectedValue(s, cfg, c));
  expect(realized - expectedValue(s, cfg, c)).toBe(Object.values(stages).reduce((n, v) => n + v, 0));
  expect(residual).toBe(0);
}
const laterDay = base.operations!.market.publish.firstDay + base.operations!.market.publish.intervalDays;

describe('TASK-0062 참고 환율과 통화별 계약', () => {
  it('프로필 다섯 묶음과 R0·R1 설정 변환·정적 견적', () => {
    for (const raw of marketRulesData.risk_profiles) {
      expect(loadRiskProfile(raw.id)).toEqual({
        id: raw.id, dataBasis: raw.data_basis, status: raw.status, basis: raw.basis,
        fx: { startKrwPerUsd: raw.fx.start_krw_per_usd, stepBp: raw.fx.step_bp, minKrwPerUsd: raw.fx.min_krw_per_usd, maxKrwPerUsd: raw.fx.max_krw_per_usd },
        tariff: { base: raw.tariff.base.map((r) => ({ countryCode: r.country_code, goodId: r.good_id, rateBp: r.rate_bp })),
          maxChanges: raw.tariff.max_changes, lagDays: raw.tariff.lag_days, stepBp: raw.tariff.step_bp, minBp: raw.tariff.min_bp,
          maxBp: raw.tariff.max_bp, basis: raw.tariff.basis, status: raw.tariff.status },
        surcharge: { pZeroBp: raw.surcharge.p_zero_bp, minBp: raw.surcharge.min_bp, maxBp: raw.surcharge.max_bp },
        claims: { byGood: raw.claims.by_good.map((r) => ({ goodId: r.good_id, grade: r.grade, pClaimBp: r.p_claim_bp })), basis: raw.claims.basis,
          minor: { weightBp: raw.claims.minor.weight_bp, minBp: raw.claims.minor.min_bp, maxBp: raw.claims.minor.max_bp },
          major: { weightBp: raw.claims.major.weight_bp, minBp: raw.claims.major.min_bp, maxBp: raw.claims.major.max_bp } },
        collections: { byCounterparty: raw.collections.by_counterparty.map((r) => ({ counterpartyId: r.counterparty_id, grade: r.grade })),
          grades: raw.collections.grades.map((r) => ({ grade: r.grade, pOnTimeBp: r.p_on_time_bp, pLateBp: r.p_late_bp, pPartialBp: r.p_partial_bp })),
          basis: raw.collections.basis, partialBp: raw.collections.partial_bp, lateMinDays: raw.collections.late_min_days, lateMaxDays: raw.collections.late_max_days },
      });
    }
    expect(() => loadRiskProfile('없는 프로필')).toThrow();
    expect(Object.keys(profile)).toEqual(expect.arrayContaining(['fx', 'tariff', 'surcharge', 'claims', 'collections']));
    const before = JSON.stringify(base), cfg = config();
    expect(withRiskLevel(base, 'R0', profile)).toBe(base);
    expect(JSON.stringify(base)).toBe(before);
    expect(cfg.operations!.risk!.layers).toEqual(['FX']);
    expect(cfg.offers.filter((o) => o.kind === 'supplier').every((o) => o.currency === 'KRW')).toBe(true);
    expect(Object.keys(createGame(cfg))).toEqual(Object.keys(createGame(base)));
  });
  it('환산 도우미: 원·센트와 양수·음수 절반 반올림', () => {
    expect(krwToUsdMinor(2600000, 1300)).toBe(200000);
    expect(divHalfAway(1, 2)).toBe(1); expect(divHalfAway(-1, 2)).toBe(-1);
    expect(usdToKrwMinor(-50, 1300)).toBe(-650);
    expect(usdToKrwMinor(1, 50)).toBe(1); expect(usdToKrwMinor(-1, 50)).toBe(-1);
    expect(krwToUsdMinor(-13, 2600)).toBe(-1); expect(krwToUsdMinor(13, 2600)).toBe(1);
    expect(() => divHalfAway(1, 0)).toThrow();
  });
  it('환율 순수성: 주간 경계·반올림 여유·상하한·마지막 공개일', () => {
    const cfg = config(), p = cfg.operations!.market.publish, fx = profile.fx;
    for (let seed = 1; seed <= 200; seed++) {
      let previous = fx.startKrwPerUsd;
      for (let day = p.firstDay; day <= p.lastDay; day += p.intervalDays) {
        const r = referenceRate(cfg, seed, day);
        expect(referenceRate(cfg, seed, day)).toBe(r);
        expect(r).toBeGreaterThanOrEqual(fx.minKrwPerUsd); expect(r).toBeLessThanOrEqual(fx.maxKrwPerUsd);
        expect(Math.abs(r - previous) * 10000).toBeLessThanOrEqual(previous * fx.stepBp + 5000);
        for (let i = 1; i < p.intervalDays; i++) expect(referenceRate(cfg, seed, day + i)).toBe(r);
        previous = r;
      }
      expect(referenceRate(cfg, seed, cfg.campaignDays + p.intervalDays)).toBe(referenceRate(cfg, seed, p.lastDay));
    }
    const a = changedSeed(laterDay);
    const b = Array.from({ length: 200 }, (_, i) => i + 1).find((b) => referenceRate(cfg, b, laterDay) !== referenceRate(cfg, a, laterDay));
    expect(b).toBeDefined();
    const off = structuredClone(cfg); off.operations!.risk!.layers = [];
    expect(referenceRate(off, a, laterDay)).toBe(fx.startKrwPerUsd);
    expect(referenceRate(base, a, laterDay)).toBe(base.operations!.fx.baseKrwPerUsd);
    expect(() => referenceRate({ ...base, operations: null }, a, laterDay)).toThrow();
  });
  it('흐름 유일성: 관찰한 FX-REF 호출 번호가 정확히 1부터 마지막 걸음까지다', () => {
    const cfg = config(), p = cfg.operations!.market.publish;
    const count = Math.floor((p.lastDay - p.firstDay) / p.intervalDays);
    vi.mocked(drawUniform).mockClear();
    referenceRate(cfg, cfg.seed, p.lastDay);
    const pairs = vi.mocked(drawUniform).mock.calls.map(([rng, stream]) => [stream, rng.cursors[stream]]);
    expect(pairs).toHaveLength(count);
    expect(new Set(pairs.map((pair) => JSON.stringify(pair))).size).toBe(count);
    expect(pairs).toEqual(Array.from({ length: count }, (_, i) => ['FX-REF', i + 1]));
  });
  it('경로 오라클: 200시드의 모든 날을 독립 정수식으로 계산한다', () => {
    const cfg = config(), p = cfg.operations!.market.publish, fx = profile.fx;
    const count = Math.floor((p.lastDay - p.firstDay) / p.intervalDays);
    for (let seed = 1; seed <= 200; seed++) {
      const rates = [fx.startKrwPerUsd], steps: number[] = [];
      for (let k = 1; k <= count; k++) {
        const u = drawUniform({ seed, cursors: { 'FX-REF': k } }, 'FX-REF').value;
        const step = Math.floor(u * (2 * fx.stepBp + 1)) - fx.stepBp;
        steps.push(step);
        rates.push(Math.max(fx.minKrwPerUsd, Math.min(fx.maxKrwPerUsd, halfAway(rates[k - 1]! * (10000 + step), 10000))));
      }
      expect(new Set(steps).size).toBeGreaterThan(1);
      for (let day = 1; day <= cfg.campaignDays; day++) {
        const week = Math.max(0, Math.floor((Math.min(day, p.lastDay) - p.firstDay) / p.intervalDays));
        expect(referenceRate(cfg, seed, day), `시드 ${seed}, ${day}일`).toBe(rates[week]);
      }
      vi.mocked(drawUniform).mockClear();
    }
  });
  it('환전·환율 상태 무관·시드 일치·저장·결정성', () => {
    const cfg = config(changedSeed(laterDay));
    const s = advance(fresh(cfg), cfg, laterDay), before = JSON.stringify(s), pair = openTradePairs(s, cfg)[0]!;
    const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    expect(cfg.seed).toBe(s.rng.seed);
    exchangePreview(s, cfg, 'USD_TO_KRW', cfg.operations!.fx.lotUsdMinor);
    quotePreview(s, cfg, pair); cashReservations(s, cfg); paymentDefaultStatus(s, cfg);
    preview(cfg, 'DIRECT_TRADE', buy.cityId, sell.cityId, s.day, { purchase: buy.unitPriceMinor * buy.quantity, sale: sell.unitPriceMinor * buy.quantity }, sell.deliveryDeadlineDay!, sell.paymentDueDay!, { goodId: buy.goodId });
    const one = exchange(s, cfg), two = exchange(one, cfg);
    expect(JSON.stringify(s)).toBe(before); expect(exchange(s, cfg)).toEqual(one);
    const r = referenceRate(cfg, s.rng.seed, s.day), deduction = applyBasisPoints(r, cfg.operations!.fx.spreadBasisPoints);
    expect(r).not.toBe(profile.fx.startKrwPerUsd);
    expect(two.operations!.exchanges.slice(-2).map((e) => e.rateKrwPerUsd)).toEqual([r - deduction, r - deduction]);
    const reverse = exchange(two, cfg, 1, 'KRW_TO_USD');
    expect(reverse.operations!.exchanges.at(-1)!.rateKrwPerUsd).toBe(r + deduction);
    for (const e of reverse.operations!.exchanges) expect(e.krwMinor).toBe(e.usdMinor * e.rateKrwPerUsd / 100);
    const closed = commitDay(reverse, cfg, []).state;
    roundtrip(closed, cfg); roundtrip(two, cfg);
    expect(exchangePreview(roundtrip(two, cfg), cfg, 'USD_TO_KRW', cfg.operations!.fx.lotUsdMinor)).toEqual(exchangePreview(two, cfg, 'USD_TO_KRW', cfg.operations!.fx.lotUsdMinor));
    expect(() => exchangeAmounts(cfg, 'USD_TO_KRW', cfg.operations!.fx.lotUsdMinor)).toThrow();
  });
  it('새 흐름 없음: rules-2 90일과 R1 두 환율 주 환전·인도 뒤 커서 불변', () => {
    const cfg = config(changedSeed(laterDay));
    let s = finished(cfg); s = exchange(advance(s, cfg, Math.max(s.day, laterDay)), cfg);
    expect(s.operations!.exchanges.length).toBeGreaterThanOrEqual(2);
    expect(new Set(s.operations!.exchanges.map((e) => referenceRate(cfg, s.rng.seed, e.day))).size).toBeGreaterThan(1);
    expect(s.rng).toEqual(createRng(cfg.seed)); expect(Object.keys(s.rng.cursors).some((k) => k.startsWith('FX-'))).toBe(false);
    let old = fresh(base);
    while (old.phase !== 'ENDED') {
      const employee = old.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === base.homeCityId
        && !old.tasks.some((t) => t.assignedEmployeeId === e.id && t.status === 'RUNNING'));
      if (employee) for (const offer of [...base.offers, ...old.operations!.offers].filter((o) => o.kind === 'forwarding' && o.publishDay <= old.day && o.validUntilDay >= old.day && old.offers.some((v) => v.id === o.id && v.status === 'OPEN'))) {
        const route = routeBetween(base, offer.cityId, offer.destinationCityId!)!;
        const sailing = listSailings(base, route.id, old.day + 1)[0];
        if (!sailing) continue;
        const trial = planState(old, base, [{ id: `90일-${offer.id}`, type: 'ACCEPT_FORWARDING', offerId: offer.id,
          plan: { employeeId: employee.id, sailingId: sailing.id } }]);
        if (trial.results[0]!.status === 'APPLIED') { old = trial.state; break; }
      }
      old = advance(old, base, old.day + 1);
    }
    expect(old.closedDays).toHaveLength(base.campaignDays); expect(old.rng).toEqual(createRng(base.seed));
  });
  it('시세표·행: 통화와 단가 크기, 상태 행 키 보존', () => {
    const cfg = config(), old = advance(fresh(base), base, laterDay), s = advance(fresh(cfg), cfg, laterDay);
    for (const row of cfg.operations!.market.rows.filter((r) => r.side === 'BUY')) {
      const r0 = base.operations!.market.rows.find((r) => r.cityId === row.cityId && r.goodId === row.goodId && r.side === row.side)!;
      expect(row.basePriceMinor).toBe(usdToKrwMinor(r0.basePriceMinor, profile.fx.startKrwPerUsd));
    }
    for (const offer of s.operations!.offers.filter((o) => o.kind === 'supplier')) {
      const r0 = old.operations!.offers.find((o) => o.id === offer.id)!;
      expect(Math.abs(offer.unitPriceMinor * 100 - r0.unitPriceMinor * profile.fx.startKrwPerUsd)).toBeLessThanOrEqual(r0.unitPriceMinor * profile.fx.startKrwPerUsd / 100);
    }
    for (const row of marketTable(s, cfg)) expect(row.currency).toBe(row.side === 'BUY' ? 'KRW' : 'USD');
    expect(Object.keys(s.operations!.batches[0]!.rows[0]!)).toEqual(Object.keys(old.operations!.batches[0]!.rows[0]!));
  });
  it('원화 매입 계약: 통화별 매입·운임·두 매출원가·계약 보고서', () => {
    const cfg = config(), s = finished(cfg), c = s.contracts[0]!;
    expect(s.ledger.entries.find((e) => e.id === `PURCHASE-${c.id}`)!.currency).toBe('KRW');
    expect(s.ledger.entries.find((e) => e.id.startsWith('FREIGHT-PREPAY-'))!.currency).toBe('USD');
    const cogs = s.ledger.entries.filter((e) => e.id.startsWith(`COGS-${c.id}`));
    expect(cogs.map((e) => e.id)).toEqual([`COGS-${c.id}-KRW`, `COGS-${c.id}-USD`]);
    for (const e of s.ledger.entries) expect(e.lines.reduce((n, l) => n + l.amount, 0)).toBe(0);
    expect(contractReport(s, c, 'KRW').directCost).toBe(c.purchaseAmountMinor);
    const freight = s.bookings.find((b) => b.id === c.bookingId)!.prepaidFreightMinor;
    const duty = s.shipments.find((sh) => sh.contractId === c.id)!.dutyMinor!;
    expect(contractReport(s, c).contribution).toBe(c.saleAmountMinor - c.priceReductionMinor - freight - duty);
    expect(cogs.find((e) => e.id === `COGS-${c.id}-USD`)!.lines.find((l) => l.account === 'COST_OF_GOODS_SOLD')!.amount).toBe(freight + duty);
    expect(cogs.find((e) => e.id === `COGS-${c.id}-KRW`)!.lines.find((l) => l.account === 'COST_OF_GOODS_SOLD')!.amount).toBe(c.purchaseAmountMinor);
    expect(contractAmount(s.ledger, 'USD', c.id, 'INVENTORY')).toBe(0);
    expect(campaignSummary(s, cfg).byCurrency.find((b) => b.currency === 'KRW')!.contractContribution).toBe(-c.purchaseAmountMinor);
    roundtrip(s, cfg);
  });
  it('미리보기 기본값·참고 추정·자금 검사', () => {
    const cfg = config(), s = fresh(cfg), pair = openTradePairs(s, cfg)[0]!;
    const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    const money = { purchase: buy.unitPriceMinor * buy.quantity, sale: sell.unitPriceMinor * buy.quantity };
    const args = [cfg, 'DIRECT_TRADE', buy.cityId, sell.cityId, s.day, money, sell.deliveryDeadlineDay!, sell.paymentDueDay!] as const;
    expect(() => preview(...args)).toThrow('품목');
    const p = preview(...args, { goodId: buy.goodId })!;
    expect(p.schedule.every((r) => r.currency)).toBe(true);
    expect(p.schedule.find((r) => r.labelKo === '매입 대금 지급')).toMatchObject({ amount: -money.purchase, currency: 'KRW' });
    expect(p.cashNeed).toBe(p.freight + p.duty); expect(p.contributionBeforePayroll).toBe(p.sale - p.freight - p.duty);
    const r = referenceRate(cfg, cfg.seed, s.day);
    expect(p.referenceEstimate).toEqual({ rateKrwPerUsd: r, saleKrw: usdToKrwMinor(p.sale, r), pnlKrw: usdToKrwMinor(p.sale, r) - money.purchase - usdToKrwMinor(p.freight + p.duty, r) });
    expect(p.cashNeedByCurrency).toEqual([{ currency: 'KRW', amountMinor: money.purchase }, { currency: 'USD', amountMinor: p.freight + p.duty }]);
    const drained = exchange(s, cfg, Math.floor(fundsPosition(s, cfg, 'KRW').available / exchangeAmounts(cfg, 'KRW_TO_USD', cfg.operations!.fx.lotUsdMinor, s.rng.seed, s.day).krw), 'KRW_TO_USD');
    expect(fundsPosition(drained, cfg, 'KRW').available).toBeLessThan(money.purchase);
    const krw = planState(drained, cfg, [{ id: '부족', type: 'ACCEPT_TRADE', ...pair }]);
    expect(krw.results[0]!.status).toBe('REJECTED'); expect(krw.results[0]!.reasonKo).toContain(`필요 ${formatMoney('KRW', p.cashNeedByCurrency!.find((v) => v.currency === 'KRW')!.amountMinor)}`);
    const allUsd = Math.floor(fundsPosition(s, cfg, 'USD').available / cfg.operations!.fx.lotUsdMinor);
    const funded = exchange(s, cfg, allUsd);
    expect(fundsPosition(funded, cfg, 'KRW').available).toBeGreaterThanOrEqual(money.purchase);
    const usd = planState(funded, cfg, [{ id: '달러 부족', type: 'ACCEPT_TRADE', ...pair }]);
    expect(usd.results[0]!.status).toBe('REJECTED'); expect(usd.results[0]!.reasonKo).toContain(`필요 ${formatMoney('USD', p.cashNeedByCurrency!.find((v) => v.currency === 'USD')!.amountMinor)}`);
    expect(tradePreview(cfg, pair.buyOfferId, pair.sellOfferId, s.day)).toEqual(p);
  });

});

describe('TASK-0062 날짜·관세·손익', () => {
  it('묶음 계산은 상태 날짜의 양방향 환율과 정확히 같다', () => {
    const day = base.operations!.paymentDefault.failureAgeDays + laterDay;
    const cfg = config(changedSeed(day));
    // 의무는 전날 마감 뒤, 오늘을 열기 전에 넣는다.
    let s = advance(fresh(cfg), cfg, day - 1);
    s = commitDay(s, cfg, []).state;
    const fx = cfg.operations!.fx, r = referenceRate(cfg, s.rng.seed, s.day), deduction = applyBasisPoints(r, fx.spreadBasisPoints);
    const L = fx.lotUsdMinor * (r - deduction) / 100, F = fx.lotUsdMinor * fx.buyKrwPerUsd / 100;
    expect(L).not.toBe(F);
    const x = Math.min(L, F) + 1, cash = balance(s.ledger, 'KRW', 'CASH');
    inject(s, 'KRW', cash + x, day - cfg.operations!.paymentDefault.failureAgeDays, '시험-원화');
    const usd = structuredClone(s);
    s = openDay(s, cfg).state;
    const status = paymentDefaultStatus(s, cfg);
    expect(Math.ceil(x / L)).not.toBe(Math.ceil(x / F));
    expect(usdLotKrw(cfg, s)).toBe(L);
    expect(status.recovery.lotsToSurvive).toBe(Math.ceil(x / L));
    const y = s.obligations.filter((o) => o.currency === 'KRW' && o.paidDay === null).reduce((n, o) => n + o.amountMinor, 0) + dailyKrwDue(s, cfg, s.day) - cash;
    expect(status.recovery.lotsToClearAll).toBe(Math.ceil(Math.max(0, y) / L));
    const amount = balance(usd.ledger, 'USD', 'CASH') + fx.lotUsdMinor + 1;
    inject(usd, 'USD', amount, day - cfg.operations!.paymentDefault.failureAgeDays, '시험-달러');
    const u = openDay(usd, cfg).state, short = amount - balance(u.ledger, 'USD', 'CASH');
    expect(short).toBeGreaterThan(0);
    expect(paymentDefaultStatus(u, cfg).oldest!.currency).toBe('USD');
    expect(paymentDefaultStatus(u, cfg).recovery.krwToUsdRequiredMinor).toBe(Math.ceil(short / fx.lotUsdMinor) * fx.lotUsdMinor * (r + deduction) / 100);
    const candidate = cfg.recruitment!.candidateEmployeeIds[0]!;
    const wage = cfg.employees.find((e) => e.id === candidate)!.salaryPerDayMinor * 7;
    expect(weeklyBottleneck(s, cfg, candidate).wageUsdLotsPerWeek).toBe(Math.ceil(wage / L));
    expect(() => usdLotKrw(cfg)).toThrow();
  });
  it('관세 과세가격: 수락일 고정·매일 예약·도착, 늦은 편 미리보기', () => {
    const cfg = config(changedSeed(laterDay));
    let { s, c, sailing } = setup(cfg, 1);
    const r = referenceRate(cfg, s.rng.seed, c.acceptedDay), arrivalRate = referenceRate(cfg, s.rng.seed, sailing.scheduledArrivalDay);
    expect(r).not.toBe(arrivalRate);
    const expected = halfAway(halfAway(c.purchaseAmountMinor * 100, r) * cfg.terms.dutyRateBasisPoints, 10000);
    const p = preview(cfg, c.kind, c.originCityId, c.destinationCityId, c.acceptedDay,
      { purchase: c.purchaseAmountMinor, sale: c.saleAmountMinor }, c.deliveryDeadlineDay, c.paymentDueDay, { goodId: c.goodId })!;
    expect(p.duty).toBe(expected);
    while (s.day <= sailing.scheduledArrivalDay) {
      expect(cashReservations(s, cfg).find((v) => v.kind === 'DUTY')!.amountMinor).toBe(expected);
      s = advance(s, cfg, s.day + 1);
    }
    expect(s.shipments[0]!.dutyMinor).toBe(expected);
    const dutyEntry = s.ledger.entries.find((e) => e.id === `DUTY-${s.shipments[0]!.id}`)!;
    expect(dutyEntry.currency).toBe('USD');
    expect(dutyEntry.lines.find((l) => l.account === 'INVENTORY')!.amount).toBe(expected);
    let candidate: { p: NonNullable<ReturnType<typeof preview>>; day: number; purchase: number; sale: number } | undefined;
    let search = advance(fresh(cfg), cfg, laterDay);
    while (search.day <= 30 && !candidate) {
      for (const pair of openTradePairs(search, cfg)) {
        const lateBuy = offerDef(search, cfg, pair.buyOfferId)!, lateSell = offerDef(search, cfg, pair.sellOfferId)!;
        const purchase = lateBuy.unitPriceMinor * lateBuy.quantity, sale = lateSell.unitPriceMinor * lateBuy.quantity;
        const q = preview(cfg, c.kind, lateBuy.cityId, lateSell.cityId, search.day, { purchase, sale },
          lateSell.deliveryDeadlineDay!, lateSell.paymentDueDay!, { goodId: lateBuy.goodId })!;
        const rate = referenceRate(cfg, cfg.seed, search.day);
        if (rate !== profile.fx.startKrwPerUsd && q.lateOnNextSailing && q.arrivalDay !== null
          && rate !== referenceRate(cfg, cfg.seed, q.arrivalDay)
          && dutyEstimate(cfg, krwToUsdMinor(purchase, rate)) !== dutyEstimate(cfg, krwToUsdMinor(purchase, referenceRate(cfg, cfg.seed, q.arrivalDay)))) {
          candidate = { p: q, day: search.day, purchase, sale };
          break;
        }
      }
      if (!candidate) search = advance(search, cfg, search.day + 1);
    }
    expect(candidate, '유효 기간·바뀐 환율의 늦은 편').toBeDefined();
    const late = candidate!.p, rate = referenceRate(cfg, cfg.seed, candidate!.day);
    expect(late.duty).toBe(dutyEstimate(cfg, krwToUsdMinor(candidate!.purchase, rate)));
    expect(late.sale).toBeLessThan(candidate!.sale);
    expect(late.referenceEstimate).toEqual({ rateKrwPerUsd: rate, saleKrw: toKrw(late.sale, rate),
      pnlKrw: toKrw(late.sale, rate) - candidate!.purchase - toKrw(late.freight + late.duty, rate) });
  });
  it.each([[0, false], [0, true], [1, false], [1, true]] as const)('손익 읽기: 독립 현금 재계산·환율 부호·R0 (편 %s, 주선 %s)', (later, forwarding) => {
    const cfg = config(changedSeed(laterDay)), s = finished(cfg, later, forwarding), c = s.contracts[0]!;
    const report = contractRiskReport(s, cfg, c.id);
    expect(report.realized).toBe(cashValue(s, cfg, c)); expect(report.components.residual).toBe(0);
    assertIdentity(s, cfg, c, cashValue(s, cfg, c));
    expect(report.components.fx).not.toBe(0);
    const receipt = s.ledger.entries.find((e) => e.contractId === c.id && e.id.startsWith('RECEIPT-'))!;
    const change = referenceRate(cfg, s.rng.seed, receipt.day) - referenceRate(cfg, s.rng.seed, c.acceptedDay);
    expect(Math.sign(report.components.fx)).toBe(Math.sign(change));
    const oldCfg = config(cfg.seed, 'R0'), old = finished(oldCfg, later, forwarding), oldC = old.contracts[0]!;
    const oldReport = contractRiskReport(old, oldCfg, oldC.id);
    expect(old.obligations.filter((o) => o.paidDay === null)).toEqual([]);
    expect(oldReport.realized).toBe(contractReport(old, oldC).contribution * oldCfg.operations!.fx.baseKrwPerUsd / 100);
    expect(oldReport.components.fx).toBe(0); expect(oldReport.components.residual).toBe(0);
  });
  it('늦은 편 손익: schedule은 0, 수금일 환율로 감액 차이만 계산', () => {
    const cfg = config(changedSeed(laterDay)), s = finished(cfg, 1), c = s.contracts[0]!;
    expect(c.lateDays).toBeGreaterThan(0);
    const p = tradePreview(cfg, c.buyOfferId!, c.sellOfferId!, c.acceptedDay)!;
    const r = referenceRate(cfg, s.rng.seed, s.invoices[0]!.dueDay), report = contractRiskReport(s, cfg, c.id);
    expect(report.components.schedule).toBe(0);
    expect(report.components.late).toBe(usdToKrwMinor(c.saleAmountMinor - c.priceReductionMinor, r) - usdToKrwMinor(p.sale, r));
    expect(report.expected).toBe(p.referenceEstimate!.pnlKrw);
    expect(report.realized).toBe(cashValue(s, cfg, c)); expect(report.components.residual).toBe(0);
  });
  it.each(['R0', 'R1'] as const)('취소 %s: 운임 현금 환급·취소비와 원화 매입 분리', (level) => {
    const cfg = config(changedSeed(laterDay), level);
    let { s, c } = setup(cfg, 1);
    s = advance(s, cfg, laterDay);
    s = apply(s, cfg, { id: '취소', type: 'CANCEL_CONTRACT', contractId: c.id }); c = s.contracts[0]!;
    const release = s.ledger.entries.find((e) => e.id.startsWith('FREIGHT-RELEASE-'))!;
    const refund = release.lines.find((l) => l.account === 'CASH')!.amount;
    const fee = release.lines.find((l) => l.account === 'CANCELLATION_EXPENSE')!.amount;
    expect(fee).toBe(cfg.terms.preDepartureCancellationFeeMinor);
    if (level === 'R1') {
      expect(release.currency).toBe('USD');
      expect(s.ledger.entries.some((e) => e.contractId === c.id && e.currency === 'KRW' && e.lines.some((l) => l.account === 'CASH' && l.amount > 0))).toBe(false);
    }
    expect(refund).toBe(s.bookings[0]!.prepaidFreightMinor - fee);
    const report = contractRiskReport(s, cfg, c.id), p = tradePreview(cfg, c.buyOfferId!, c.sellOfferId!, c.acceptedDay)!;
    const r0 = referenceRate(cfg, cfg.seed, c.acceptedDay), rc = referenceRate(cfg, cfg.seed, c.cancelledDay!);
    expect(report.components.cancel).toBe(usdToKrwMinor(refund, rc) - (usdToKrwMinor(p.sale, r0) - usdToKrwMinor(p.duty, r0)));
    expect(report.realized).toBe(cashValue(s, cfg, c)); expect(report.components.residual).toBe(0);
    expect(s.ledger.entries.some((e) => e.id.startsWith('PURCHASE-') && e.lines.some((l) => l.account === 'CASH' && l.amount > 0))).toBe(false);
    roundtrip(commitDay(s, cfg, []).state, cfg);
  });
  it('불변식: 균형 유지 환전 변조와 혼합 통화 짝의 정확한 오류', () => {
    const cfg = config(changedSeed(laterDay));
    const s = advance(setup(cfg, 1).s, cfg, laterDay), fx = exchange(s, cfg);
    const bad = structuredClone(fx), entry = bad.ledger.entries.find((e) => e.id === `${bad.operations!.exchanges.at(-1)!.id}-KRW`)!;
    entry.lines.find((l) => l.account === 'CURRENCY_TRANSFER')!.amount += 1;
    entry.lines.find((l) => l.account === 'FX_SPREAD_EXPENSE')!.amount -= 1;
    expect(entry.lines.reduce((n, l) => n + l.amount, 0)).toBe(0);
    expect(() => deserializeSave(serializeSave(bad), { config: cfg, dataVersion: cfg.dataVersion })).toThrow('환전 분개 짝 또는 통화 간 이체가 다릅니다');
    const wrong = structuredClone(s); wrong.contracts[0]!.currency = 'KRW';
    expect(() => deserializeSave(serializeSave(wrong), { config: cfg, dataVersion: cfg.dataVersion })).toThrow('혼합 통화 계약은 매입 KRW·판매 USD·계약 USD여야 합니다');
  });
});

function openUnpaid(seed: number) {
  const cfg = config(seed);
  let { s, c, sailing } = setup(cfg);
  s = advance(s, cfg, sailing.scheduledArrivalDay - 1);
  // 도착 전날 입력 뒤·마감 전: 오늘 수금까지 포함한 현금을 기존 의무 정산이 먼저 가져간다.
  const cash = balance(s.ledger, 'USD', 'CASH') + s.invoices.filter((i) => i.currency === 'USD' && i.dueDay === s.day).reduce((n, i) => n + i.amountMinor, 0);
  inject(s, 'USD', cash, s.day, '도착 전 정산');
  s = advance(s, cfg, sailing.scheduledArrivalDay + 1);
  expect(s.shipments[0]!.dutyPaid).toBe(false);
  const day = Array.from({ length: Math.max(0, c.deliveryDeadlineDay - s.day + 1) }, (_, i) => s.day + i)
    .find((d) => referenceRate(cfg, seed, d) !== cfg.operations!.fx.baseKrwPerUsd && referenceRate(cfg, seed, d) !== referenceRate(cfg, seed, c.acceptedDay));
  if (day === undefined) return undefined;
  s = advance(s, cfg, day);
  return { cfg, s, c: s.contracts[0]! };
}
let failureCache: { cfg: ScenarioConfig; before: GameState; ended: GameState } | undefined;
function failureCase() {
  if (failureCache) return failureCache;
  for (let seed = 1; seed <= 200; seed++) {
    const cfg = config(seed);
    let s = fresh(cfg);
    while (s.phase !== 'ENDED' && !s.obligations.some((o) => o.paidDay === null)) {
      for (const pair of openTradePairs(s, cfg)) {
        const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
        for (let quantity = buy.quantityStep; quantity <= Math.min(buy.maxQuantity, sell.maxQuantity); quantity += buy.quantityStep) {
          const trial = planState(s, cfg, [{ id: '실패 전 매입', type: 'ACCEPT_TRADE', ...pair, quantity }]);
          if (trial.results[0]!.status !== 'APPLIED') continue;
          const closed = commitDay(trial.state, cfg, []).state;
          if (!closed.obligations.some((o) => o.currency === 'KRW' && o.incurredDay === s.day && o.paidDay === null)) continue;
          let before = openDay(closed, cfg).state;
          while (before.phase !== 'ENDED') {
            const ended = commitDay(before, cfg, []).state;
            if (ended.operations!.outcome === 'FAILED') {
              failureCache = { cfg, before, ended };
              return failureCache;
            }
            before = openDay(ended, cfg).state;
          }
        }
      }
      s = advance(s, cfg, s.day + 1, false);
    }
  }
  expect(failureCache, '200개 안에서 매입 당일 급여 미지급·열린 계약 실패').toBeDefined();
  return failureCache!;
}
function expectedDutyCall(cfg: ScenarioConfig, s: GameState, c: Contract, tariffDay: number, knownThroughDay: number) {
  return [cfg, s.rng.seed, c.goodId, c.destinationCityId, tariffDay, knownThroughDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay];
}

describe('TASK-0062 열린 계약·실패·누설', () => {
  it('열린 계약: 운송 중 관세 예상과 도착 뒤 미지급을 한 번만 평가', () => {
    let unpaid: ReturnType<typeof openUnpaid>;
    for (let seed = 1; seed <= 200 && !unpaid; seed++) unpaid = openUnpaid(seed);
    expect(unpaid, '200개 안에서 도착 뒤 미지급·다른 환율').toBeDefined();
    const cfg = unpaid!.cfg;
    const travelling = setup(cfg, 1);
    travelling.s = advance(travelling.s, cfg, travelling.sailing.departureDay + 1);
    expect(travelling.s.shipments[0]!.arrivalDay).toBe(null);
    for (const [s, c] of [[travelling.s, travelling.s.contracts[0]!], [unpaid!.s, unpaid!.c]] as const) {
      const r = referenceRate(cfg, s.rng.seed, s.day), r0 = referenceRate(cfg, s.rng.seed, c.acceptedDay);
      expect(r).not.toBe(cfg.operations!.fx.baseKrwPerUsd); expect(r).not.toBe(r0);
      const sh = s.shipments[0]!;
      const delivery = sh.releaseDay ?? sh.scheduledArrivalDay + cfg.terms.customsDays;
      const reduction = Math.min(c.saleAmountMinor * cfg.terms.lateDeliveryCapBasisPoints! / 10000,
        Math.max(0, delivery - c.deliveryDeadlineDay) * cfg.terms.lateDeliveryPriceReductionMinor);
      const sale = c.saleAmountMinor - reduction;
      const duty = sh.arrivalDay === null ? dutyEstimate(cfg, krwToUsdMinor(c.purchaseAmountMinor, r0)) : 0;
      const unpaidDuty = s.obligations.filter((o) => o.paidDay === null && s.ledger.entries.some((e) => e.id === o.id && e.contractId === c.id)).reduce((n, o) => n + o.amountMinor, 0);
      expect(sale + duty + unpaidDuty).toBeGreaterThan(0);
      const report = contractRiskReport(s, cfg, c.id), cash = cashValue(s, cfg, c);
      const realized = cash + toKrw(sale, r) - toKrw(duty + unpaidDuty, r);
      expect(report.realized).toBe(realized);
      assertIdentity(s, cfg, c, realized);
      expect(report.openFixedRateKrw).toBe(cash + usdToKrwMinor(sale, cfg.operations!.fx.baseKrwPerUsd) - usdToKrwMinor(duty + unpaidDuty, cfg.operations!.fx.baseKrwPerUsd));
      expect(report.open).toBe(true); expect(report.components.open_valuation).toBe(0); expect(report.components.residual).toBe(0);
    }
  });
  it('미래 누설 없음: 열린 시점의 차단과 날짜가 지난 양성 대조', () => {
    const cfg = config(changedSeed(laterDay));
    const early = setup(cfg, 1), c = early.c;
    const t = advance(early.s, cfg, c.acceptedDay + 1);
    const tPrime = advance(t, cfg, early.sailing.scheduledArrivalDay + cfg.terms.customsDays + 1);
    const futureDay = Math.max(c.paymentDueDay, early.sailing.scheduledArrivalDay + cfg.terms.customsDays);
    const p = cfg.operations!.market.publish;
    const week = (d: number) => Math.floor((d - p.firstDay) / p.intervalDays);
    expect(week(futureDay)).toBeGreaterThan(week(t.day));
    const change = (conf: ScenarioConfig, seed: number, day: number) => original.referenceRate(conf, seed, day)
      + (week(day) > week(t.day) ? profile.fx.stepBp : 0);
    expect(change(cfg, cfg.seed, futureDay)).not.toBe(original.referenceRate(cfg, cfg.seed, futureDay));
    const before = contractRiskReport(t, cfg, c.id), control = contractRiskReport(tPrime, cfg, c.id);
    expect(before.open).toBe(true);
    vi.mocked(referenceRate).mockImplementation(change);
    expect(contractRiskReport(t, cfg, c.id)).toEqual(before);
    expect(contractRiskReport(tPrime, cfg, c.id)).not.toEqual(control);
  });
  it('실패 기록·실패 종료 평가일: USD 약정·넓힌 원화 매입 창·남은 흐름', () => {
    const { cfg, ended: s } = failureCase(), fail = s.operations!.failure!, c = s.contracts[0]!;
    expect(cfg.seed).toBeLessThanOrEqual(200);
    expect(c.acceptedDay).toBe(fail.incurredDay); expect(c.acceptedDay).not.toBe(fail.day);
    const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!, arrival = listSailings(cfg, route.id, c.acceptedDay + 1)[0]!.scheduledArrivalDay;
    const duty = dutyFor(cfg, s.rng.seed, c.goodId, c.destinationCityId, arrival, c.acceptedDay, c.purchaseAmountMinor, 'KRW', c.acceptedDay);
    expect(fail.usdCommitmentsSinceIncurred.find((r) => r.id === c.id)!.amountMinor).toBe(route.bookingFeeMinor + duty);
    const purchases = s.ledger.entries.filter((e) => e.currency === 'KRW' && e.id.startsWith('PURCHASE-')
      && e.day >= fail.incurredDay - cfg.operations!.paymentDefault.failureAgeDays && e.day <= fail.day);
    expect(purchases.length).toBeGreaterThan(0);
    expect(fail.optionalKrwSpendBeforeFirstUnpaid.filter((r) => r.entryId.startsWith('PURCHASE-')).map((r) => r.entryId)).toEqual(purchases.map((e) => e.id));
    const report = contractRiskReport(s, cfg, c.id);
    expect(report.evaluationDay).toBe(fail.day); expect(report.evaluationDay).not.toBe(s.day); expect(report.open).toBe(true);
    const sail = listSailings(cfg, route.id, fail.day + 1)[0]!;
    const release = sail.scheduledArrivalDay + cfg.terms.customsDays;
    const sale = c.saleAmountMinor - Math.min(applyBasisPoints(c.saleAmountMinor, cfg.terms.lateDeliveryCapBasisPoints!), Math.max(0, release - c.deliveryDeadlineDay) * cfg.terms.lateDeliveryPriceReductionMinor);
    const r = referenceRate(cfg, s.rng.seed, fail.day);
    expect(report.realized).toBe(cashValue(s, cfg, c) + usdToKrwMinor(sale, r) - usdToKrwMinor(route.bookingFeeMinor + duty, r));
    expect(report.components.residual).toBe(0);
  });
  it('USD 원인 실패 rules-2: 직접 무역 매입 포함·주선 운임·원화 매입 없음', () => {
    const cfg = config(base.seed, 'R0');
    let { s } = setup(cfg, 0, false, false);
    const fwd = cfg.offers.find((o) => o.kind === 'forwarding')!;
    s = apply(s, cfg, { id: '실패 주선', type: 'ACCEPT_FORWARDING', offerId: fwd.id });
    const d = s.day;
    s = commitDay(s, cfg, []).state;
    const amount = cfg.startingCash.USD! + s.contracts.reduce((n, c) => n + c.saleAmountMinor, 0) + cfg.operations!.fx.lotUsdMinor;
    inject(s, 'USD', amount, d, '실패 USD 의무');
    s = advance(s, cfg, d + cfg.operations!.paymentDefault.failureAgeDays + 1, false);
    const failure = s.operations!.failure!;
    expect(failure).toMatchObject({ obligationId: '실패 USD 의무', currency: 'USD', amountMinor: amount });
    for (const c of s.contracts) {
      const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
      const duty = c.kind === 'DIRECT_TRADE' ? dutyEstimate(cfg, c.purchaseAmountMinor) : 0;
      const row = failure.usdCommitmentsSinceIncurred.find((r) => r.id === c.id);
      expect(row).toBeDefined(); expect(row!.amountMinor).toBe(c.purchaseAmountMinor + route.bookingFeeMinor + duty);
    }
    expect(failure.optionalKrwSpendBeforeFirstUnpaid.some((r) => r.entryId.startsWith('PURCHASE-'))).toBe(false);
  });
  it('관세 호출 인수: 여섯 경로와 예약 없음·BOOKED·운송 중', () => {
    const cfg = config(changedSeed(laterDay));
    const unbooked = setup(cfg, 0, false, false), c = unbooked.c;
    const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
    const first = listSailings(cfg, route.id, c.acceptedDay + 1)[0]!;
    const calls = () => vi.mocked(dutyFor).mock.calls;
    const clear = () => vi.mocked(dutyFor).mockClear();
    clear();
    preview(cfg, c.kind, c.originCityId, c.destinationCityId, c.acceptedDay,
      { purchase: c.purchaseAmountMinor, sale: c.saleAmountMinor }, c.deliveryDeadlineDay, c.paymentDueDay, { goodId: c.goodId });
    expect(calls().length).toBeGreaterThan(0);
    for (const call of calls()) expect(call).toEqual(expectedDutyCall(cfg, unbooked.s, c, first.scheduledArrivalDay, c.acceptedDay));
    let freshState = exchange(fresh(cfg), cfg);
    clear();
    freshState = apply(freshState, cfg, { id: '수락만', type: 'ACCEPT_TRADE', ...unbooked.pair });
    expect(calls().length).toBeGreaterThan(0);
    for (const call of calls()) expect(call).toEqual(expectedDutyCall(cfg, freshState, c, first.scheduledArrivalDay, c.acceptedDay));
    const later = listSailings(cfg, route.id, c.acceptedDay + 2)[1]!;
    const booked = apply(unbooked.s, cfg, { id: '나중 예약', type: 'BOOK_SAILING', contractId: c.id, sailingId: later.id });
    const bookedTomorrow = advance(booked, cfg, c.acceptedDay + 1);
    expect(later.scheduledArrivalDay).not.toBe(listSailings(cfg, route.id, bookedTomorrow.day + 1)[0]!.scheduledArrivalDay);
    const inTransit = advance(bookedTomorrow, cfg, later.departureDay + 1);
    const emptyTomorrow = advance(unbooked.s, cfg, c.acceptedDay + 1);
    for (const [s, tariff] of [[emptyTomorrow, listSailings(cfg, route.id, emptyTomorrow.day + 1)[0]!.scheduledArrivalDay],
      [bookedTomorrow, later.scheduledArrivalDay], [inTransit, Math.max(inTransit.shipments[0]!.scheduledArrivalDay, inTransit.day)]] as const) {
      expect(s.day).not.toBe(c.acceptedDay); expect(s.contracts).toHaveLength(1);
      clear(); cashReservations(s, cfg);
      expect(calls()).toEqual([expectedDutyCall(cfg, s, c, tariff, s.day)]);
    }
    const arrivalState = advance(inTransit, cfg, later.scheduledArrivalDay);
    clear(); const arrived = commitDay(arrivalState, cfg, []).state;
    expect(calls().length).toBeGreaterThan(0);
    for (const call of calls()) expect(call).toEqual(expectedDutyCall(cfg, arrivalState, c, arrivalState.day, arrivalState.day));
    clear(); contractRiskReport(arrived, cfg, c.id);
    expect(calls().length).toBeGreaterThan(0);
    for (const call of calls()) expect(call).toEqual(expectedDutyCall(cfg, arrived, c, first.scheduledArrivalDay, c.acceptedDay));
    clear(); contractRiskReport(inTransit, cfg, c.id);
    const expected = [expectedDutyCall(cfg, inTransit, c, first.scheduledArrivalDay, c.acceptedDay), expectedDutyCall(cfg, inTransit, c, later.scheduledArrivalDay, inTransit.day)];
    expect(calls()).toEqual(expected);
    const f = failureCase(), fc = f.before.contracts[0]!;
    expect(fc.acceptedDay).not.toBe(f.before.day);
    clear(); commitDay(f.before, f.cfg, []);
    const failureCalls = calls().filter((call) => call[5] === fc.acceptedDay);
    expect(failureCalls.length).toBeGreaterThan(0);
    const fr = routeBetween(f.cfg, fc.originCityId, fc.destinationCityId)!;
    for (const call of failureCalls) expect(call).toEqual(expectedDutyCall(f.cfg, f.before, fc, listSailings(f.cfg, fr.id, fc.acceptedDay + 1)[0]!.scheduledArrivalDay, fc.acceptedDay));
  });
});

describe('TASK-0062 원천 검사와 보고 사례', () => {
  it('관세 원천 호출은 risk.ts의 dutyFor 몸통 안에만 있다', () => {
    const sources = import.meta.glob<string>(['./*.ts', '!./*.test.ts'], { query: '?raw', import: 'default', eager: true });
    for (const [path, source] of Object.entries(sources)) {
      const name = path.slice(2);
      const withoutDefinition = source.replace(/export function dutyEstimate\(/g, '정의(');
      if (name !== 'risk.ts') expect(withoutDefinition).not.toMatch(/\bdutyEstimate\(/);
      else {
        const start = source.indexOf('export function dutyFor('), end = source.indexOf('export function withRiskLevel(');
        expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
        expect(source.slice(0, start) + source.slice(end)).not.toMatch(/\bdutyEstimate\(/);
      }
    }
  });
  it('편 놓침 뒤 재예약은 추가 현금 줄만 cancel 단계에 포함한다', () => {
    const cfg = config(changedSeed(laterDay));
    let s = exchange(fresh(cfg), cfg);
    const pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    const route = routeBetween(cfg, buy.cityId, sell.cityId)!, first = listSailings(cfg, route.id, s.day + 1)[0]!;
    s = apply(s, cfg, { id: '준비 없이 수락', type: 'ACCEPT_TRADE', ...pair, plan: { sailingId: first.id } });
    s = advance(s, cfg, first.departureDay + 1);
    expect(s.bookings[0]!.status).toBe('CANCELLED');
    const c = s.contracts[0]!, next = listSailings(cfg, route.id, s.day + 1)[0]!;
    s = apply(s, cfg, { id: '다시 예약', type: 'BOOK_SAILING', contractId: c.id, sailingId: next.id });
    const employee = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === cfg.homeCityId)!;
    s = apply(s, cfg, { id: '준비 배정', type: 'ASSIGN_TASK', taskId: c.prepTaskId, employeeId: employee.id });
    while (s.contracts[0]!.status !== 'COMPLETED' && s.phase !== 'ENDED') s = advance(s, cfg, s.day + 1);
    const report = contractRiskReport(s, cfg, c.id);
    expect(report.realized).toBe(cashValue(s, cfg, c)); expect(report.components.residual).toBe(0);
    const extras = s.ledger.entries.filter((e) => e.id.startsWith('FREIGHT-RELEASE-') || e.id === `FREIGHT-PREPAY-${s.bookings[1]!.id}`);
    expect(report.components.cancel).toBe(extras.reduce((sum, e) => sum + usdToKrwMinor(e.lines.filter((l) => l.account === 'CASH').reduce((n, l) => n + l.amount, 0), referenceRate(cfg, cfg.seed, e.day)), 0));
  });
  it('정시·늦은 편·취소·열린 계약 보고 사례를 계산한 그대로 남긴다', () => {
    const cfg = config(changedSeed(laterDay));
    const normal = finished(cfg), late = finished(cfg, 1), initial = setup(cfg, 1);
    const cancelled = apply(advance(initial.s, cfg, laterDay), cfg, { id: '표 취소', type: 'CANCEL_CONTRACT', contractId: initial.c.id });
    const later = setup(cfg, 2);
    const open = advance(later.s, cfg, laterDay);
    expect(open.day).toBeLessThan(later.sailing.departureDay);
    const futureDay = later.sailing.scheduledArrivalDay + cfg.terms.customsDays;
    expect(referenceRate(cfg, cfg.seed, futureDay)).not.toBe(referenceRate(cfg, cfg.seed, open.day));
    let completed = open;
    while (completed.contracts[0]!.status !== 'COMPLETED' && completed.phase !== 'ENDED') completed = advance(completed, cfg, completed.day + 1);
    expect(completed.contracts[0]!.status).toBe('COMPLETED');
    expect(contractRiskReport(open, cfg, open.contracts[0]!.id).realized).not.toBe(contractRiskReport(completed, cfg, completed.contracts[0]!.id).realized);
    console.log('TASK0062_R1_OPEN=' + JSON.stringify({ seed: cfg.seed, sailing: later.sailing.id, evaluationDay: open.day,
      evaluationRate: referenceRate(cfg, cfg.seed, open.day), futureDay, futureRate: referenceRate(cfg, cfg.seed, futureDay), completed: contractRiskReport(completed, cfg, completed.contracts[0]!.id) }));
    const samples = [normal, late, cancelled, open].map((s, i) => ({ label: ['정시', '늦은 편', '취소', '열린 출항 전'][i], seed: cfg.seed,
      ...contractRiskReport(s, cfg, s.contracts[0]!.id) }));
    for (const row of samples) expect(row.components.residual).toBe(0);
    console.log('TASK0062_REPORTS=' + JSON.stringify(samples));
  });
});

describe('TASK-0062-R1 독립 회귀', () => {
  it('혼합 계약 USD 재고 불변식: 인도 전 음수와 인도 뒤 잔액을 거부한다', () => {
    const cfg = config();
    for (const [delivered, delta] of [[false, -1], [true, -1], [true, 1]] as const) {
      const s = delivered ? finished(cfg) : setup(cfg).s, c = s.contracts[0]!;
      expect(c.deliveredDay !== null).toBe(delivered);
      expect(contractAmount(s.ledger, 'USD', c.id, 'INVENTORY')).toBe(0);
      post(s.ledger, { id: '시험 USD 재고 변조', day: s.day, contractId: c.id, currency: 'USD', reason: '시험 균형 분개',
        lines: [{ account: 'INVENTORY', amount: delta }, { account: 'COST_OF_GOODS_SOLD', amount: -delta }] });
      expect(() => deserializeSave(serializeSave(s), { config: cfg, dataVersion: cfg.dataVersion }))
        .toThrow(`혼합 계약 ${c.id}의 USD 재고 잔액(${delta})이 맞지 않습니다`);
    }
  });
  it.each(['KRW', 'USD'] as const)('자금 검사 경계: %s 기준 − 1은 거절, 기준은 수락', (currency) => {
    const cfg = config();
    const funded = exchange(fresh(cfg), cfg, 2), pair = openTradePairs(funded, cfg)[0]!;
    const p = quotePreview(funded, cfg, pair)!;
    const need = p.cashNeedByCurrency!.find((v) => v.currency === currency)!.amountMinor;
    expect(need).toBeGreaterThan(0);
    for (const difference of [-1, 0]) {
      const s = structuredClone(funded), available = fundsPosition(s, cfg, currency).available;
      expect(available).toBeGreaterThan(need);
      inject(s, currency, available - need - difference, s.day, `경계 의무-${currency}`);
      expect(fundsPosition(s, cfg, currency).available).toBe(need + difference);
      const result = planState(s, cfg, [{ id: `경계-${difference}`, type: 'ACCEPT_TRADE', ...pair }]).results[0]!;
      expect(result.status).toBe(difference === -1 ? 'REJECTED' : 'APPLIED');
      if (difference === -1) expect(result.reasonKo).toContain(`필요 ${formatMoney(currency, need)}`);
    }
  });
  it('참고 추정: 바뀐 환율 날의 미리보기와 수락 기대', () => {
    const cfg = config(changedSeed(laterDay));
    const day = Array.from({ length: cfg.campaignDays }, (_, i) => i + 1)
      .find((d) => referenceRate(cfg, cfg.seed, d) !== profile.fx.startKrwPerUsd);
    expect(day).toBeDefined();
    let s = exchange(advance(fresh(cfg), cfg, day!), cfg, 2);
    const pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    const p = preview(cfg, 'DIRECT_TRADE', buy.cityId, sell.cityId, s.day,
      { purchase: buy.unitPriceMinor * buy.quantity, sale: sell.unitPriceMinor * buy.quantity }, sell.deliveryDeadlineDay!, sell.paymentDueDay!, { goodId: buy.goodId })!;
    const rate = referenceRate(cfg, cfg.seed, s.day);
    expect(rate).not.toBe(profile.fx.startKrwPerUsd);
    expect(p.referenceEstimate).toEqual({ rateKrwPerUsd: rate, saleKrw: toKrw(p.sale, rate),
      pnlKrw: toKrw(p.sale, rate) - p.purchase - toKrw(p.freight + p.duty, rate) });
    s = apply(s, cfg, { id: '바뀐 날 수락', type: 'ACCEPT_TRADE', ...pair });
    const c = s.contracts[0]!;
    expect(c.acceptedDay).toBe(day);
    expect(contractRiskReport(s, cfg, c.id).expected).toBe(p.referenceEstimate!.pnlKrw);
    expect(contractRiskReport(s, cfg, c.id).expected).toBe(expectedValue(s, cfg, c));
  });
  it.each(['R0', 'R1'] as const)('편 놓침 뒤 재예약 전 %s: 평가일 운임과 독립 현금 항등식', (level) => {
    const cfg = config(changedSeed(laterDay), level);
    let s = fresh(cfg);
    if (level === 'R1') s = exchange(s, cfg, 2);
    const pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    const route = routeBetween(cfg, buy.cityId, sell.cityId)!, first = listSailings(cfg, route.id, s.day + 1)[0]!;
    s = apply(s, cfg, { id: '준비 미배정', type: 'ACCEPT_TRADE', ...pair, plan: { sailingId: first.id } });
    s = advance(s, cfg, first.departureDay + 1);
    const prepaid = s.ledger.entries.find((e) => e.id.startsWith('FREIGHT-PREPAY-'))!;
    if (level === 'R1') {
      const day = Array.from({ length: cfg.campaignDays - s.day }, (_, i) => s.day + i)
        .find((d) => referenceRate(cfg, cfg.seed, d) !== referenceRate(cfg, cfg.seed, prepaid.day));
      expect(day, '첫 선지급일과 다른 환율의 평가일').toBeDefined();
      s = advance(s, cfg, day!);
      expect(referenceRate(cfg, cfg.seed, s.day)).not.toBe(referenceRate(cfg, cfg.seed, prepaid.day));
    }
    const c = s.contracts[0]!;
    expect(s.bookings[0]!.status).toBe('CANCELLED'); expect(c.bookingId).toBeNull();
    expect(s.shipments.some((sh) => sh.contractId === c.id)).toBe(false);
    expect(cashReservations(s, cfg)).toContainEqual({ contractId: c.id, kind: 'FREIGHT', currency: 'USD', amountMinor: route.bookingFeeMinor });
    const next = listSailings(cfg, route.id, s.day + 1)[0]!;
    const lateDays = Math.max(0, next.scheduledArrivalDay + cfg.terms.customsDays - c.deliveryDeadlineDay);
    const sale = c.saleAmountMinor - Math.min(halfAway(c.saleAmountMinor * cfg.terms.lateDeliveryCapBasisPoints!, 10000), lateDays * cfg.terms.lateDeliveryPriceReductionMinor);
    const r = referenceRate(cfg, cfg.seed, s.day), r0 = referenceRate(cfg, cfg.seed, c.acceptedDay);
    const duty = halfAway((level === 'R1' ? halfAway(c.purchaseAmountMinor * 100, r0) : c.purchaseAmountMinor) * cfg.terms.dutyRateBasisPoints, 10000);
    // 현금 비용과 남은 운임·관세를 같은 환율끼리 합친 뒤 한 번 환산한다.
    const costs = new Map<number, number>([[r, -route.bookingFeeMinor - duty]]);
    let realized = toKrw(sale, r);
    for (const e of s.ledger.entries.filter((e) => e.contractId === c.id)) {
      for (const line of e.lines.filter((l) => l.account === 'CASH')) {
        if (e.currency === 'KRW') realized += line.amount;
        else {
          const rate = referenceRate(cfg, cfg.seed, e.day);
          costs.set(rate, (costs.get(rate) ?? 0) + line.amount);
        }
      }
    }
    for (const [rate, amount] of costs) realized += toKrw(amount, rate);
    const report = contractRiskReport(s, cfg, c.id);
    expect(report.realized).toBe(realized); expect(report.open).toBe(true);
    assertIdentity(s, cfg, c, realized);
    if (level === 'R0') expect(report.components.cancel).toBe(-usdToKrwMinor(cfg.terms.preDepartureCancellationFeeMinor, cfg.operations!.fx.baseKrwPerUsd));
  });
  it('환율 상태 무관: 진행 중 혼합 계약·미지급 의무에서도 읽기는 저장을 바꾸지 않는다', () => {
    const cfg = config(changedSeed(laterDay));
    let { s } = setup(cfg, 2);
    s = advance(s, cfg, laterDay);
    inject(s, 'KRW', balance(s.ledger, 'KRW', 'CASH') + 1, s.day, '읽기 원화 의무');
    const before = serializeSave(s), c = s.contracts[0]!;
    expect(c.deliveredDay).toBeNull();
    expect(offerDef(s, cfg, c.buyOfferId!)!.currency).not.toBe(c.currency);
    const pair = openTradePairs(s, cfg)[0]!;
    expect(pair).toBeDefined();
    exchangePreview(s, cfg, 'USD_TO_KRW', cfg.operations!.fx.lotUsdMinor);
    quotePreview(s, cfg, pair);
    vi.mocked(dutyFor).mockClear();
    expect(cashReservations(s, cfg).some((r) => r.contractId === c.id && r.kind === 'DUTY')).toBe(true);
    expect(vi.mocked(dutyFor).mock.calls.length).toBeGreaterThan(0);
    const status = paymentDefaultStatus(s, cfg);
    expect(status.oldest).not.toBeNull(); expect(status.recovery.lotsToClearAll).toBeGreaterThan(0);
    contractRiskReport(s, cfg, c.id);
    weeklyBottleneck(s, cfg, cfg.recruitment!.candidateEmployeeIds[0]!);
    const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
    preview(cfg, 'DIRECT_TRADE', buy.cityId, sell.cityId, s.day,
      { purchase: buy.unitPriceMinor * buy.quantity, sale: sell.unitPriceMinor * buy.quantity }, sell.deliveryDeadlineDay!, sell.paymentDueDay!, { goodId: buy.goodId });
    expect(serializeSave(s)).toBe(before);
  });
  it('결정성: 같은 공개 명령 구동기를 두 번 돌린 저장 문자열이 같다', () => {
    const cfg = config(changedSeed(laterDay));
    const drive = () => {
      let s = finished(cfg, 2);
      s = exchange(s, cfg);
      return serializeSave(commitDay(s, cfg, []).state);
    };
    expect(drive()).toBe(drive());
  });
});
