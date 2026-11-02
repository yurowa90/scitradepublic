import { describe, expect, it } from 'vitest';
import { loadCreditProfile, loadRiskProfile, loadScenario } from '../content/scenario';
import raw from '../../data/market_rules.json';
import { commitDay, createGame, openDay, planState, creditTermCheck } from './engine';
import { checkInvariants } from './invariants';
import { offerDef, openTradePairs } from './market';
import { quotePreview } from './readers';
import { creditTermOptions } from './readers-lazy';
import { preview } from './reports';
import { exchangeAmounts, paymentDefaultStatus, usdLotKrw } from './operations';
import { isRiskRules, referenceRate, rowCurrency, withRiskLevel, withRiskLevelV2 } from './risk';
import { deserializeSave, serializeSave } from './save';
import type { Contract, CreditTermId, GameState, ScenarioConfig } from './types';

const profile = () => loadRiskProfile('RISK_PROFILE_V2');
const credit = () => loadCreditProfile('RISK_PROFILE_V2');
const base = () => ({ ...loadScenario('SCENARIO_M2_OPS_COS_LAVER'), seed: 2001 });
const config = (level: 'R0P' | 'R1' | 'R2' | 'R3' = 'R0P') => withRiskLevelV2(base(), level, profile(), credit());
const fresh = (c: ScenarioConfig) => openDay(createGame(c), c).state;
function fixture(c = config()) {
  let s = fresh(c);
  const fx = planState(s, c, [{ id: '환전', type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: c.operations!.fx.lotUsdMinor * 3 }]);
  expect(fx.results[0]!.status, fx.results[0]!.reasonKo ?? '').toBe('APPLIED'); s = fx.state;
  const pair = openTradePairs(s, c)[0]!;
  const buy = offerDef(s, c, pair.buyOfferId)!, sell = offerDef(s, c, pair.sellOfferId)!;
  return { c, s, pair, buy, sell, quantity: buy.quantity };
}
function accept(f: ReturnType<typeof fixture>, term?: CreditTermId) {
  return planState(f.s, f.c, [{ id: '무역', type: 'ACCEPT_TRADE', ...f.pair, quantity: f.quantity,
    ...(term === undefined ? {} : { creditTermId: term }) }]);
}
function check(f: ReturnType<typeof fixture>, term: CreditTermId = 'BASE') {
  return creditTermCheck(f.s, f.c, f.pair.buyOfferId, f.pair.sellOfferId, f.quantity, term);
}
function contract(f: ReturnType<typeof fixture>) {
  const r = accept(f, 'D15'); expect(r.results[0]!.status).toBe('APPLIED'); return r.state.contracts[0]!;
}

describe('TASK-0067a 판본·프로필', () => {
  it.each([
    ['R0P', []], ['R1', ['FX']], ['R2', ['FX', 'TARIFF', 'SURCHARGE']],
    ['R3', ['FX', 'TARIFF', 'SURCHARGE', 'CLAIM', 'COLLECTION']],
  ] as const)('%s 변환·원본 보존', (level, layers) => {
    const b = base(), before = structuredClone(b), p = profile();
    // 변환·원본 보존은 최종 판매 마진과 무관하게 k=0으로 검사한다.
    const { saleMarginK: _, ...cr } = credit();
    const c = withRiskLevelV2(b, level, p, cr);
    expect(c.rules.rulesVersion).toBe('M2a-rules-4'); expect(c.operations!.risk!.layers).toEqual(layers);
    expect(c.operations!.risk!.credit).toEqual(cr); expect(c.operations!.risk!.credit).not.toBe(cr);
    expect(rowCurrency(c, 'BUY')).toBe('KRW'); expect(b).toEqual(before);
    if (level === 'R0P') for (const d of [1, 8, 90]) expect(referenceRate(c, 2001, d)).toBe(1300);
    expect(() => withRiskLevelV2(b, level, p, { ...cr, profileId: '다른 ID' })).toThrow('ID');
  });
  it('위험 술어는 rules-3·4만 포함한다', () => {
    for (const v of ['M1-rules-1', 'M2a-rules-1', 'M2a-rules-2']) expect(isRiskRules(v)).toBe(false);
    expect(isRiskRules('M2a-rules-3')).toBe(true); expect(isRiskRules('M2a-rules-4')).toBe(true);
  });
  it('등급과 무관한 미리보기·양방향 환전·필요액은 rules-3 R3와 같다', () => {
    const a = withRiskLevel(base(), 'R3', loadRiskProfile('RISK_PROFILE_DEFAULT')), b = config('R3');
    const f = fixture(b), s = f.s; s.day = 15;
    expect(referenceRate(b, 2001, s.day)).not.toBe(1300);
    const args = ['DIRECT_TRADE', f.buy.cityId, f.sell.cityId, s.day,
      { purchase: f.buy.unitPriceMinor * f.quantity, sale: f.sell.unitPriceMinor * f.quantity }, 30, 40,
      { goodId: f.buy.goodId }] as const;
    expect(preview(b, ...args)).toEqual(preview(a, ...args));
    for (const direction of ['USD_TO_KRW', 'KRW_TO_USD'] as const) {
      expect(exchangeAmounts(b, direction, 100000, 2001, s.day)).toEqual(exchangeAmounts(a, direction, 100000, 2001, s.day));
      const cmd = { id: direction, type: 'EXCHANGE_CURRENCY' as const, direction, usdAmountMinor: 100000 };
      const x = planState(s, a, [cmd]), y = planState(s, b, [cmd]);
      expect(x.results[0]!.status).toBe('APPLIED'); expect(y.results).toEqual(x.results);
      expect(y.state.ledger).toEqual(x.state.ledger);
    }
    expect(usdLotKrw(b, s)).toEqual(usdLotKrw(a, s));
    for (const currency of ['KRW', 'USD'] as const) {
      const t = structuredClone(s);
      t.obligations.push({ id: '미지급', currency, amountMinor: 90000000, incurredDay: 1, paidDay: null, reasonKo: '시험' });
      expect(paymentDefaultStatus(t, b)).toEqual(paymentDefaultStatus(t, a));
      if (currency === 'USD') expect(paymentDefaultStatus(t, b).recovery.krwToUsdRequiredMinor).toBeGreaterThan(0);
    }
  });
  it('세 시나리오의 V2 품목별 등급 표', () => {
    const expected = [
      ['M2A5_PYEONGTAEK', [['A', 'B'], ['C', 'B']]],
      ['M2A5_PYEONGTAEK_COS', [['A', 'B']]],
      ['M2A5_PYEONGTAEK_COS_LAVER', [['A', 'B'], ['C', 'B']]],
    ] as const;
    for (const [id, grades] of expected) {
      const r = raw.rule_sets.find((r) => r.id === id)!;
      expect(r.trade.goods.map((g) => g.sell_counterparties.map((p) => profile().collections.byCounterparty.find((x) => x.counterpartyId === p.counterparty_id)!.grade))).toEqual(grades);
    }
  });
  it('최종 V2 판매 마진은 1이고 DEFAULT에는 외상 칸이 없다', () => {
    expect(loadCreditProfile('RISK_PROFILE_V2').saleMarginK).toBe(1);
    expect(loadRiskProfile('RISK_PROFILE_DEFAULT')).not.toHaveProperty('credit');
    expect(() => loadCreditProfile('RISK_PROFILE_DEFAULT')).toThrow();
  });
  it('기존 로더 모양과 새 외상 로더의 원문 값', () => {
    const p = profile(), c = credit(), v = raw.risk_profiles.find((p) => p.id === 'RISK_PROFILE_V2')!;
    expect(Object.keys(p)).toEqual(Object.keys(loadRiskProfile('RISK_PROFILE_DEFAULT')));
    expect(Object.hasOwn(p, 'credit')).toBe(false);
    for (const g of p.collections.grades) expect(Object.hasOwn(g, 'pDefaultBp')).toBe(false);
    expect(c).toEqual({ profileId: v.id, saleMarginK: 1, terms: v.credit_terms!.map((t) => ({ id: t.id, days: t.days, factorPct: t.factor_pct, premiumBp: t.premium_bp })),
      limitUnitMinor: v.credit_limit_unit_minor, limits: v.credit_limits!.map((r) => ({ grade: r.grade, lots: r.lots, limitMinor: r.limit_minor })),
      pDefaultBpByGrade: v.collections.grades.map((g) => ({ grade: g.grade, pDefaultBp: 'p_default_bp' in g ? g.p_default_bp : undefined })), carryBpPerDay: v.collections.carry_bp_per_day, recoveryBp: v.collections.recovery_bp });
    expect(() => loadCreditProfile('RISK_PROFILE_DEFAULT')).toThrow();
    expect(() => loadCreditProfile('없는 프로필')).toThrow();
  });
});

describe('TASK-0067a 외상 판정', () => {
  it.each(['M1-rules-1', 'M2a-rules-1', 'M2a-rules-2', 'M2a-rules-3'] as const)('%s는 BASE도 외상 지정 거절·키 없음', (version) => {
    const c = version === 'M2a-rules-3' ? withRiskLevel(base(), 'R1', loadRiskProfile('RISK_PROFILE_DEFAULT')) : base();
    c.rules.rulesVersion = version;
    const f = fixture(c);
    for (const term of ['BASE', 'D15'] as const) expect(accept(f, term).results[0]).toMatchObject({ status: 'REJECTED', reasonKo: '외상 조건은 이 규칙에서 쓸 수 없습니다' });
    const r = accept(f); expect(r.results[0]!.status).toBe('APPLIED');
    expect(Object.hasOwn(r.state.contracts[0]!, 'creditTermId')).toBe(false);
    expect(Object.hasOwn(r.state.contracts[0]!, 'creditEligible')).toBe(false);
    expect(creditTermOptions(f.s, c, f.pair.buyOfferId, f.pair.sellOfferId)).toEqual([]);
  });
  it('실제 M1 운영 설정 없는 시나리오도 외상 지정을 거절한다', () => {
    const c = { ...loadScenario('SCENARIO_M1_ONE_TRADE'), seed: 2001 }, s = fresh(c);
    const buy = c.offers.find((o) => o.kind === 'supplier')!, sell = c.offers.find((o) => o.kind === 'customer')!;
    expect(c.operations).toBeNull();
    for (const creditTermId of ['BASE', 'D15'] as const) {
      const r = planState(s, c, [{ id: creditTermId, type: 'ACCEPT_TRADE', buyOfferId: buy.id, sellOfferId: sell.id, creditTermId }]);
      expect(r.results[0]).toMatchObject({ status: 'REJECTED', reasonKo: '외상 조건은 이 규칙에서 쓸 수 없습니다' });
    }
  });
  it('생략은 BASE·가산 반올림과 선택 가능 기록', () => {
    const f = fixture(), r = accept(f); expect(r.results[0]!.status).toBe('APPLIED');
    expect(r.state.contracts[0]).toMatchObject({ creditTermId: 'BASE', saleAmountMinor: f.sell.unitPriceMinor * f.quantity,
      paymentDueDay: f.c.terms.paymentDueDay ?? f.sell.paymentDueDay, creditEligible: { dateRule: true, limitBlocked: [] } });
    expect(check(f, 'D15').saleAmountMinor).toBe(Math.floor((f.sell.unitPriceMinor * f.quantity * 10300 + 5000) / 10000));
    f.c.terms.paymentDueDay = 60;
    const grade = check(f).grade;
    f.c.operations!.risk!.credit!.limits.find((r) => r.grade === grade)!.limitMinor = 1;
    expect(check(f)).toMatchObject({ allowed: true, dateRule: true, limitBlocked: ['D15'] });
    f.c.terms.paymentDueDay = 61;
    expect(check(f)).toMatchObject({ allowed: true, dateRule: false, limitBlocked: [] });
  });
  it.each([[1017, 1048], [1010, 1040]] as const)('단가 %i의 가산은 정수 %i로 반올림한다', (unitPriceMinor, expected) => {
    const f = fixture();
    f.sell.unitPriceMinor = unitPriceMinor;
    f.buy.quantityStep = 1; f.quantity = 1;
    // D15 300bp: 1017 × 10300 = 10475100(나머지 5100), 1010 × 10300 = 10403000(나머지 3000).
    expect(check(f, 'D15').saleAmountMinor).toBe(expected);
    const r = accept(f, 'D15');
    expect(r.results[0]!.status).toBe('APPLIED');
    expect(r.state.contracts[0]!.saleAmountMinor).toBe(expected);
    expect(() => checkInvariants(r.state, f.c)).not.toThrow();
  });
  it.each([['D15', 60], ['D30', 45]] as const)('%s 날짜 90은 허용·91은 거절', (term, due) => {
    const f = fixture(); f.c.terms.paymentDueDay = due;
    expect(check(f, term).allowed).toBe(true); expect(accept(f, term).results[0]!.status).toBe('APPLIED');
    f.c.terms.paymentDueDay = due + 1;
    expect(check(f, term)).toMatchObject({ allowed: false, reasonKo: '외상 기간이 캠페인 안에 끝나지 않습니다' });
    expect(accept(f, term).results[0]!.reasonKo).toBe(check(f, term).reasonKo);
  });
  it('한도 합계 일치는 허용·1센트 초과는 거절', () => {
    const f = fixture(), c = contract(f); f.s.contracts.push({ ...c, id: '노출', saleAmountMinor: 100 });
    const r = check(f, 'D15'), limit = f.c.operations!.risk!.credit!.limits.find((x) => x.grade === r.grade)!;
    limit.limitMinor = 100 + r.saleAmountMinor;
    expect(check(f, 'D15')).toMatchObject({ allowed: true, exposureMinor: 100 });
    limit.limitMinor--;
    expect(check(f, 'D15')).toMatchObject({ allowed: false, reasonKo: '외상 한도 초과' });
  });
  it('인도 전 비BASE만 노출·취소/완료/BASE/다른 거래처/PAID 제외', () => {
    const f = fixture(), c = contract(f);
    const rows: Partial<Contract>[] = [
      { id: '인도 전', status: 'ACTIVE', saleAmountMinor: 101 },
      { id: '취소', status: 'CANCELLED', saleAmountMinor: 202 },
      { id: '완료', status: 'COMPLETED', saleAmountMinor: 303 },
      { id: '수금된 완료', status: 'COMPLETED', invoiceId: 'I-PAID', saleAmountMinor: 909 },
      { id: 'BASE', creditTermId: 'BASE', saleAmountMinor: 404 },
      { id: '다른 거래처', customerId: '다름', saleAmountMinor: 505 },
      { id: '수금 완료', status: 'IN_PROGRESS', invoiceId: 'I-PAID', saleAmountMinor: 606 },
      { id: '미수', status: 'IN_PROGRESS', invoiceId: 'I-OUTSTANDING', saleAmountMinor: 707 },
      { id: '연체', status: 'IN_PROGRESS', invoiceId: 'I-OVERDUE', saleAmountMinor: 808 },
    ];
    f.s.contracts = rows.map((r) => ({ ...c, ...r }));
    for (const status of ['PAID', 'OUTSTANDING', 'OVERDUE'] as const) f.s.invoices.push({ id: `I-${status}`, contractId: '고정물', currency: 'USD', amountMinor: 1, dueDay: 1, issuedDay: 1, status, receiptIds: [] });
    expect(check(f).exposureMinor).toBe(101 + 707 + 808);
  });
  it('여러 날짜·한도에서 읽기와 인수는 같은 판정·금액·날짜', () => {
    for (const due of [20, 45, 60, 61]) for (const limit of [1, 1200000]) {
      const f = fixture(); f.c.terms.paymentDueDay = due;
      for (const r of f.c.operations!.risk!.credit!.limits) r.limitMinor = limit;
      for (const o of creditTermOptions(f.s, f.c, f.pair.buyOfferId, f.pair.sellOfferId, f.quantity)) {
        const r = accept(f, o.termId);
        if (!o.allowed) expect(r.results[0]).toMatchObject({ status: 'REJECTED', reasonKo: o.reasonKo });
        else { expect(r.results[0]!.status).toBe('APPLIED'); expect(r.state.contracts[0]).toMatchObject({ saleAmountMinor: o.saleAmountMinor, paymentDueDay: o.paymentDueDay }); }
      }
    }
  });
  it('외상 거절은 수량·자금 검사보다 먼저다', () => {
    const f = fixture(); f.c.terms.paymentDueDay = 90; f.quantity = 0;
    expect(accept(f, 'D15').results[0]!.reasonKo).toBe('외상 기간이 캠페인 안에 끝나지 않습니다');
  });
  it('확률·계수 차이는 공개 선택지·미리보기에 누설되지 않는다', () => {
    const f = fixture(), other = structuredClone(f.c);
    for (const g of other.operations!.risk!.credit!.pDefaultBpByGrade) g.pDefaultBp += 100;
    for (const t of other.operations!.risk!.credit!.terms) t.factorPct += 10;
    const s = fresh(other);
    expect(creditTermOptions(s, other, f.pair.buyOfferId, f.pair.sellOfferId)).toEqual(creditTermOptions(fresh(f.c), f.c, f.pair.buyOfferId, f.pair.sellOfferId));
    expect(quotePreview(s, other, f.pair)).toEqual(quotePreview(fresh(f.c), f.c, f.pair));
  });
});

describe('TASK-0067a 저장·불변식', () => {
  it('형식 6 rules-4 외상 계약 왕복·rules-3 기대 판본 거절', () => {
    const f = fixture(), r = accept(f, 'D30'); expect(r.results[0]!.status).toBe('APPLIED');
    const text = serializeSave(r.state); expect(JSON.parse(text).formatVersion).toBe(7);
    expect(serializeSave(deserializeSave(text, { config: f.c, dataVersion: f.c.dataVersion, rulesVersion: 'M2a-rules-4' }))).toBe(text);
    const c3 = withRiskLevel(base(), 'R3', loadRiskProfile('RISK_PROFILE_DEFAULT'));
    expect(() => deserializeSave(text, { config: c3, dataVersion: c3.dataVersion, rulesVersion: 'M2a-rules-3' })).toThrow('이 시나리오의 규칙은 M2a-rules-3이며');
  });
  it('이전 판본의 외상 키와 rules-4 날짜·금액 조작을 찾는다', () => {
    const f = fixture(), s = accept(f, 'D15').state;
    expect(() => checkInvariants(s, f.c)).not.toThrow();
    for (const [key, message] of [['paymentDueDay', '외상 결제일'], ['saleAmountMinor', '외상 판매액']] as const) {
      const x = structuredClone(s); x.contracts[0]![key]++;
      expect(() => checkInvariants(x, f.c)).toThrow(message);
    }
    for (const key of ['creditTermId', 'creditEligible'] as const) {
      const c3 = withRiskLevel(base(), 'R3', loadRiskProfile('RISK_PROFILE_DEFAULT')), f3 = fixture(c3), x = accept(f3).state;
      if (key === 'creditTermId') x.contracts[0]!.creditTermId = 'BASE';
      else x.contracts[0]!.creditEligible = { dateRule: false, limitBlocked: [] };
      expect(() => checkInvariants(x, c3)).toThrow('외상 조건 키');
    }
    for (const key of ['creditTermId', 'creditEligible'] as const) {
      const x = structuredClone(s); delete x.contracts[0]![key];
      expect(() => checkInvariants(x, f.c)).toThrow('외상 조건과 선택 가능 기록');
    }
  });
  it('rules-4 저장의 판매 견적 ID가 없으면 불변식 문제를 기록한다', () => {
    const f = fixture(), r = accept(f, 'D15');
    expect(r.results[0]!.status).toBe('APPLIED');
    const saved = JSON.parse(serializeSave(r.state));
    saved.state.contracts[0].sellOfferId = '없는 판매 견적';
    expect(() => checkInvariants(saved.state, f.c)).toThrow('판매 견적 없는 판매 견적이 없습니다');
  });
  it.each(['R0P', 'R1'] as const)('%s 환전 뒤 불변식', (level) => {
    const c = config(level); let s = fixture(c).s;
    while (s.day < 15) s = openDay(commitDay(s, c, []).state, c).state;
    const r = planState(s, c, [{ id: '후속 환전', type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: 100000 }]);
    expect(r.results[0]!.status).toBe('APPLIED'); expect(() => checkInvariants(r.state, c)).not.toThrow();
  });
});
