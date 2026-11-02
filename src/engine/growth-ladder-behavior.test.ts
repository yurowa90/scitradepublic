import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { debugLadderConfig } from '../content/growth-test-helpers';
import { commitDay, createGame, creditTermCheck, openDay, planState } from './engine';
import { applyBatchLocks, companyStageReport, customerTrustReport, evaluateGrowth, finalS4, growthMetrics, growthProblems, prepareLadderConfig } from './growth-ladder';
import { batchZero, generateBatch } from './market';
import { applyBasisPoints } from './money';
import { referenceRate, usdToKrwMinor } from './risk';
import { simulate } from './sim/sim';
import { policyById } from './sim/policies';
import { deserializeSave, serializeSave } from './save';
import type { GameState, ScenarioConfig } from './types';

const config = () => ({ ...loadScenario('SCENARIO_M2_OPS_LADDER'), seed: 2001 });
function sample(c = config()) {
  const s = openDay(createGame(c), c).state;
  const buy = c.offers.find((o) => o.kind === 'supplier')!, sell = c.offers.find((o) => o.kind === 'customer')!;
  const result = planState(s, c, [{ id: '실적-견본', type: 'ACCEPT_TRADE', buyOfferId: buy.id, sellOfferId: sell.id, quantity: buy.quantityStep }]);
  expect(result.state.contracts).toHaveLength(1);
  return { s, c, buy, sell, contract: result.state.contracts[0]! };
}
function deliveries(n: number, c = config()) {
  const f = sample(c);
  f.s.contracts = Array.from({ length: n }, (_, i) => ({ ...structuredClone(f.contract), id: `실적${i}`, deliveredDay: 3 + i, deliveryDeadlineDay: 30 }));
  return f;
}
function addBatch(s: GameState, c: ScenarioConfig, k = 1) {
  const generated = generateBatch(s.rng.seed, k, s.operations!.batches.at(-1)!.index, c);
  s.operations!.batches.push(generated.batch); s.operations!.offers.push(...generated.offers);
  s.offers.push(...generated.offers.map((o) => ({ id: o.id, status: 'OPEN' as const })));
  applyBatchLocks(s, c, generated.offers);
  return generated;
}
function claim(s: GameState, contractId: string, day: number) {
  s.ledger.entries.push({ id: `CLAIM-${contractId}`, contractId, day, currency: 'USD', reason: '시험 클레임',
    lines: [{ account: 'SALES_ALLOWANCE', amount: 100 }, { account: 'ACCOUNTS_RECEIVABLE', amount: -100 }] });
}

describe('TASK-0085 평가와 잠금', () => {
  it('S1은 화장품 양쪽 판매지를 열고 조미김만 잠그며 묶음 목록을 보존한다 (V2)', () => {
    const cities = new Set<string>();
    for (let seed = 2001; seed <= 2020; seed++) {
      const c = config(); c.seed = seed;
      const s = createGame(c), before = createGame(loadScenario('SCENARIO_M2_OPS_CREDIT'));
      const b = addBatch(s, c);
      const original = generateBatch(seed, 1, before.operations!.batches[0]!.index, loadScenario('SCENARIO_M2_OPS_CREDIT'));
      expect(b.batch).toEqual(original.batch);
      expect(s.offers.map((o) => o.id)).toEqual(s.operations!.batches.flatMap((b) => b.offerIds));
      for (const o of b.offers) {
        expect(s.offers.find((st) => st.id === o.id)!.status).toBe(o.kind !== 'forwarding' && o.goodId === 'SEASONED_LAVER' ? 'LOCKED' : 'OPEN');
        if (o.kind === 'customer' && o.goodId === 'COSMETICS') cities.add(o.cityId);
      }
    }
    expect([...cities].sort()).toEqual([...config().operations!.market.trade.sellCityIds].sort());
  });
  it('0번 묶음 로더 상한과 조미김 고정물 잠금 (K2·V8·V14)', () => {
    const base = loadScenario('SCENARIO_M2_OPS_CREDIT'), c = config();
    const fixture = structuredClone(base);
    for (const o of fixture.offers.filter((o) => o.kind !== 'forwarding')) o.maxQuantity = 5 * o.quantityStep;
    prepareLadderConfig(fixture, { growth_ladder_ref: 'growth_ladder.json#LADDER_CH1' });
    for (const o of fixture.offers.filter((o) => o.kind !== 'forwarding')) expect(o.maxQuantity).toBe(o.quantityStep);
    for (const o of c.offers.filter((o) => o.kind !== 'forwarding')) expect(o.maxQuantity).toBe(o.quantityStep);
    const extra = { ...c.offers.find((o) => o.kind === 'supplier')!, id: '0번-조미김', goodId: 'SEASONED_LAVER' };
    c.offers.push(extra);
    const s = createGame(c);
    expect(s.offers.find((o) => o.id === extra.id)!.status).toBe('LOCKED');
    expect(s.operations!.batches[0]).toEqual(batchZero(c));
    expect(debugLadderConfig().offers).toEqual(base.offers);
  });
  it('문턱을 채우면 S2, 인도 문턱에서 1건 모자라면 S1이다', () => {
    for (const n of [2, 3]) {
      const { s, c } = deliveries(n); evaluateGrowth(s, c, 7);
      expect(s.operations!.growth!.stage).toBe(n === 3 ? 'S2' : 'S1');
    }
  });
  it('평가는 생성 바로 앞이므로 같은 묶음에 S2 물량·D15가 반영된다 (B2·V1)', () => {
    const c = config(); c.operations!.growth!.ladder.stages[1]!.requires = {}; c.operations!.market.trade.maxLotsChoices = [5];
    let s = createGame(c);
    for (let day = 1; day <= 7; day++) s = commitDay(openDay(s, c).state, c, []).state;
    expect(s.operations!.growth!.reachedDays.S2).toBe(7);
    const offers = s.operations!.offers.filter((o) => o.goodId === 'COSMETICS' && o.kind !== 'forwarding');
    const base = generateBatch(2001, 1, s.operations!.batches[0]!.index, c).offers;
    for (const o of offers) expect(o.maxQuantity).toBe(Math.min(base.find((b) => b.id === o.id)!.maxQuantity, 2 * o.quantityStep));
    expect(offers.some((o) => o.maxQuantity === 2 * o.quantityStep)).toBe(true);
    const buy = offers.find((o) => o.kind === 'supplier')!, sell = offers.find((o) => o.kind === 'customer')!;
    expect(creditTermCheck(s, c, buy.id, sell.id, buy.quantityStep, 'D15')).toMatchObject({ allowed: true, stageLocked: ['D30'] });
    const lockedIds = s.offers.filter((o) => o.status === 'LOCKED').map((o) => o.id);
    s.operations!.growth!.stage = 'S3'; addBatch(s, c, 2);
    expect(lockedIds.every((id) => s.offers.find((o) => o.id === id)!.status === 'LOCKED')).toBe(true);
  });
  it('한 평가 한 단계만 오르고 이후 실적 하락에도 회사 단계는 내리지 않는다 (V4·V11)', () => {
    const { s, c } = deliveries(15); c.operations!.growth!.ladder.stages[2]!.requires.contribution_krw_min = 0;
    evaluateGrowth(s, c, 21); expect(s.operations!.growth!.stage).toBe('S2');
    evaluateGrowth(s, c, 28); expect(s.operations!.growth!.stage).toBe('S3');
    s.contracts = []; evaluateGrowth(s, c, 35);
    expect(s.operations!.growth!.stage).toBe('S3');
    expect(s.operations!.growth!.reachedDays).toEqual({ S1: 1, S2: 21, S3: 28 });
  });
  it('늦은 인도는 신뢰를 한 등급 내리고 같은 평가에서 다시 올리지 않는다 (V3)', () => {
    const { s, c, sell } = deliveries(6);
    evaluateGrowth(s, c, 14); expect(s.operations!.growth!.customers[sell.counterpartyId]!.level).toBe('REGULAR');
    s.contracts[5]!.deliveredDay = 20; s.contracts[5]!.deliveryDeadlineDay = 19;
    evaluateGrowth(s, c, 21);
    expect(s.operations!.growth!.customers[sell.counterpartyId]).toMatchObject({ level: 'NEW', changedDay: 21, lastChangeReason: 'DOWN_LATE' });
    expect(s.operations!.growth!.stage).toBe('S2');
  });
  it('클레임은 인도일이 아니라 수금 분개일의 평가 구간에 센다 (V13)', () => {
    const { s, c, sell } = deliveries(6); claim(s, s.contracts[0]!.id, 20);
    evaluateGrowth(s, c, 14);
    expect(s.operations!.growth!.customers[sell.counterpartyId]!.level).toBe('REGULAR');
    expect(s.operations!.growth!.evaluations[0]!.metrics.claimsSinceLastEval).toBe(0);
    evaluateGrowth(s, c, 21);
    expect(s.operations!.growth!.evaluations[1]!.metrics.claimsSinceLastEval).toBe(1);
    expect(s.operations!.growth!.customers[sell.counterpartyId]).toMatchObject({ level: 'NEW', lastChangeReason: 'DOWN_CLAIM' });
    evaluateGrowth(s, c, 28);
    expect(s.operations!.growth!.customers[sell.counterpartyId]!.level).toBe('REGULAR');
    evaluateGrowth(s, c, 35);
    expect(s.operations!.growth!.customers[sell.counterpartyId]!.level).toBe('PRIORITY');
  });
  it('잠긴 견적·상한 초과·외상은 거절되고 경제 상태가 바뀌지 않는다', () => {
    const { s, c, buy, sell } = sample();
    const b = addBatch(s, c); s.day = 8;
    const laver = b.offers.filter((o) => o.goodId === 'SEASONED_LAVER');
    const pairs = [
      { id: '잠금', buyOfferId: laver.find((o) => o.kind === 'supplier')!.id, sellOfferId: laver.find((o) => o.kind === 'customer')!.id },
      { id: '상한', buyOfferId: buy.id, sellOfferId: sell.id, quantity: buy.quantityStep * 2 },
      { id: '외상', buyOfferId: buy.id, sellOfferId: sell.id, creditTermId: 'D15' as const },
    ];
    for (const pair of pairs) {
      s.day = pair.id === '잠금' ? 8 : 1;
      const before = JSON.stringify(s), result = planState(s, c, [{ ...pair, type: 'ACCEPT_TRADE' }]);
      expect(result.results[0]!.status).toBe('REJECTED');
      expect(result.state.contracts).toEqual(s.contracts); expect(result.state.ledger).toEqual(s.ledger);
      expect(JSON.stringify(s)).toBe(before);
      if (pair.id !== '상한') expect(result.results[0]!.reasonKo).toContain('다음 평가일');
    }
    expect(creditTermCheck(s, c, buy.id, sell.id, buy.quantityStep, 'D30').stageLocked).toEqual(['D15', 'D30']);
    sell.paymentDueDay = 89;
    expect(creditTermCheck(s, c, buy.id, sell.id, buy.quantityStep, 'D30')).toMatchObject({ allowed: false, stageLocked: ['D15', 'D30'] });
  });
  it('생성 후 판매처별 가산만 바뀌고 묶음 기록·난수·다른 판매처는 같다 (V6)', () => {
    const c = config(), s = createGame(c), base = loadScenario('SCENARIO_M2_OPS_CREDIT');
    s.operations!.growth!.stage = 'S3';
    const customerId = c.operations!.market.trade.goods[0]!.sellCounterparties[0]!.counterpartyId;
    s.operations!.growth!.customers[customerId]!.level = 'REGULAR';
    let changed = 0, unchanged = 0;
    for (let k = 1; k <= 5; k++) {
      const original = generateBatch(2001, k, s.operations!.batches.at(-1)!.index, base), generated = addBatch(s, c, k);
      expect(generated.batch).toEqual(original.batch);
      for (const o of generated.offers.filter((o) => o.kind === 'customer')) {
        const price = original.offers.find((b) => b.id === o.id)!.unitPriceMinor;
        expect(o.unitPriceMinor).toBe(price + (o.counterpartyId === customerId ? applyBasisPoints(price, 100) : 0));
        if (o.counterpartyId === customerId) changed++; else unchanged++;
      }
    }
    expect(changed).toBeGreaterThan(0); expect(unchanged).toBeGreaterThan(0);
    expect(s.rng.cursors).toEqual({});
  });
  it('생성 고리는 신뢰 가산 전에 난수 묶음 원본을 확정한다 (V6)', () => {
    const c = config(); c.operations!.growth!.ladder.trust.NEW.sale_premium_bp = 100;
    const original = generateBatch(2001, 1, batchZero(c).index, c);
    let s = createGame(c);
    for (let d = 1; d <= 7; d++) s = commitDay(openDay(s, c).state, c, []).state;
    expect(s.operations!.batches[1]).toEqual(original.batch);
    const sell = s.operations!.offers.find((o) => o.kind === 'customer' && o.goodId === 'COSMETICS')!;
    const base = original.offers.find((o) => o.id === sell.id)!.unitPriceMinor;
    expect(sell.unitPriceMinor).toBe(base + applyBasisPoints(base, 100));
  });
  it('우선 신뢰는 한 단계 위 외상 한도와 250bp 판매가, 외상 가산 순서를 쓴다', () => {
    const c = config(), s = createGame(c); s.operations!.growth!.stage = 'S3';
    for (const v of Object.values(s.operations!.growth!.customers)) v.level = 'PRIORITY';
    const original = generateBatch(2001, 1, s.operations!.batches[0]!.index, c), b = addBatch(s, c);
    for (const sell of b.offers.filter((o) => o.kind === 'customer')) {
      const buy = b.offers.find((o) => o.kind === 'supplier' && o.goodId === sell.goodId)!;
      const basePrice = original.offers.find((o) => o.id === sell.id)!.unitPriceMinor;
      expect(sell.unitPriceMinor).toBe(basePrice + applyBasisPoints(basePrice, 250));
      const grade = c.operations!.risk!.profile.collections.byCounterparty.find((r) => r.counterpartyId === sell.counterpartyId)!.grade;
      const check = creditTermCheck(s, c, buy.id, sell.id, buy.quantityStep, 'D15');
      expect(check.grade).toBe(grade === 'C' ? 'B' : 'A');
      expect(check.saleAmountMinor).toBe(sell.unitPriceMinor * buy.quantityStep + applyBasisPoints(sell.unitPriceMinor * buy.quantityStep, 300));
    }
  });
  it('S4 마감은 90일에 한 번만 기록하며 S2에서 S3로 올리지 않는다', () => {
    const { s, c } = deliveries(15);
    const g = s.operations!.growth!; g.stage = 'S3';
    for (const customer of Object.values(g.customers)) customer.level = 'PRIORITY';
    s.ledger.entries.push({ id: 'S4-이익', day: 30, currency: 'KRW', reason: '마감 판정 시험',
      lines: [{ account: 'CASH', amount: 5000000 }, { account: 'REVENUE', amount: -5000000 }] });
    s.day = 91; s.phase = 'ENDED'; s.operations!.outcome = 'COMPLETED';
    finalS4(s, c); finalS4(s, c);
    expect(g.stage).toBe('S4'); expect(g.evaluations).toHaveLength(1); expect(g.reachedDays.S4).toBe(90);
    expect(companyStageReport(s, c)!.nextEvalDay).toBeNull();
    g.stage = 'S2'; g.lastEvalDay = null; finalS4(s, c); expect(g.stage).toBe('S2');
  });
  it('불변식은 단계 역전·도달일·평가 밖 신뢰·잠금 계약·가산 위조를 거절한다', () => {
    const c = config(); let s = createGame(c);
    for (let d = 1; d <= 7; d++) s = commitDay(openDay(s, c).state, c, []).state;
    expect(growthProblems(s, c)).toEqual([]);
    const mutations: ((s: GameState) => void)[] = [
      (s) => { s.operations!.growth!.stage = 'S2'; },
      (s) => { s.operations!.growth!.reachedDays.S1 = 2; },
      (s) => { Object.values(s.operations!.growth!.customers)[0]!.changedDay = 2; },
      (s) => { s.operations!.offers.find((o) => o.kind === 'customer' && o.goodId === 'COSMETICS')!.unitPriceMinor++; },
      (s) => { s.offers.find((o) => o.status === 'LOCKED')!.status = 'OPEN'; },
    ];
    for (const mutate of mutations) { const copy = structuredClone(s); mutate(copy); expect(growthProblems(copy, c).length).toBeGreaterThan(0); }
    expect(serializeSave(deserializeSave(serializeSave(s), { dataVersion: c.dataVersion }))).toBe(serializeSave(s));
  });
});

describe('TASK-0085 읽기 함수 손계산', () => {
  it('인도 3건과 납기 경과 미인도 1건의 정시율은 7500bp다 (V5)', () => {
    const { s, c, contract } = deliveries(3); s.day = 7;
    s.contracts.push({ ...contract, id: '미인도', deliveredDay: null, deliveryDeadlineDay: 6 });
    const before = JSON.stringify(s), report = companyStageReport(s, c)!;
    expect(report.requirements.find((r) => r.metric === 'delivered_min')).toEqual({ metric: 'delivered_min', current: 3, required: 3, met: true });
    expect(report.requirements.find((r) => r.metric === 'on_time_bp_min')).toEqual({ metric: 'on_time_bp_min', current: 7500, required: 8000, met: false });
    expect(customerTrustReport(s, c).find((r) => r.customerId === contract.customerId)!.requirements[0]).toMatchObject({ current: 3, required: 2, remaining: 0 });
    expect(JSON.stringify(s)).toBe(before);
  });
  it('USD 매출·KRW 원가와 순자산은 평가일 환율로 손계산한다 (V10)', () => {
    const { s, c } = deliveries(1); s.day = 21;
    s.ledger.entries.push({ id: 'USD-매출', contractId: s.contracts[0]!.id, day: 3, currency: 'USD', reason: '시험 매출',
      lines: [{ account: 'CASH', amount: 12345 }, { account: 'REVENUE', amount: -12345 }] },
    { id: 'KRW-원가', contractId: s.contracts[0]!.id, day: 3, currency: 'KRW', reason: '시험 원가',
      lines: [{ account: 'CASH', amount: -30000 }, { account: 'COST_OF_GOODS_SOLD', amount: 30000 }] });
    const rate = referenceRate(c, 2001, 21), start = referenceRate(c, 2001, 1);
    expect(rate).not.toBe(c.operations!.fx.baseKrwPerUsd);
    const m = growthMetrics(s, c, 21), openingUsd = c.startingCash.USD ?? 0;
    expect(m.contributionKrw).toBe(usdToKrwMinor(12345, rate) - 30000);
    expect(m.netWorthGainKrw).toBe(usdToKrwMinor(openingUsd + 12345, rate) - usdToKrwMinor(openingUsd, start) - 30000);
    s.operations!.growth!.stage = 'S2';
    expect(companyStageReport(s, c)!.requirements.find((r) => r.metric === 'contribution_krw_min')).toMatchObject({ current: m.contributionKrw, required: 3000000 });
  });
  it('실적이 없으면 정시율 null이며 신뢰 변화는 평가 전에는 없다', () => {
    const { s, c, sell } = deliveries(2);
    expect(customerTrustReport(s, c).find((r) => r.customerId === sell.counterpartyId)!.level).toBe('NEW');
    s.contracts = [];
    expect(growthMetrics(s, c, 7).onTimeBp).toBeNull();
    evaluateGrowth(s, c, 7); expect(s.operations!.growth!.stage).toBe('S1');
  });
});

describe('TASK-0085 항등과 90일', () => {
  it.each([2001, 2002, 2003, 2004, 2005])('IDLE %i는 S2에 도달하지 않는다 (G6)', (seed) => {
    const { state } = simulate(config(), policyById('IDLE')!, seed);
    expect(state.operations!.growth!.stage).toBe('S1');
    expect(state.operations!.growth!.reachedDays.S2).toBeUndefined();
  });
  it.each(['MAX_CONTRIBUTION', 'FOCUS', 'TERM_GREEDY'].flatMap((policy) => [2001, 2002, 2003, 2004, 2005].map((seed) => ({ policy, seed }))))(
    '$policy/$seed debug는 CREDIT 결과·최종 상태와 바이트 항등이다 (G2·V7·V12)', ({ policy, seed }) => {
      const a = simulate(debugLadderConfig(), policyById(policy)!, seed), b = simulate(loadScenario('SCENARIO_M2_OPS_CREDIT'), policyById(policy)!, seed);
      const withoutIdentity = (x: typeof a) => JSON.stringify({ state: { ...x.state, meta: undefined }, run: { ...x.run, scenarioId: undefined } });
      expect(Object.hasOwn(a.state.operations!, 'growth')).toBe(false);
      for (const contract of a.state.contracts) expect(Object.hasOwn(contract.creditEligible ?? {}, 'stageLocked')).toBe(false);
      expect(withoutIdentity(a)).toBe(withoutIdentity(b));
    }, 120000);
  it('90일 정상 마감에서 마지막 평가를 기록하고 FAILED에는 덧붙이지 않는다', () => {
    const c = config(); c.startingCash.KRW = 100000000;
    const { state } = simulate(c, policyById('IDLE')!, 2001);
    expect(state.operations!.outcome).toBe('COMPLETED');
    expect(state.operations!.growth!.evaluations.at(-1)!.day).toBe(90);
    expect(growthProblems(state, c)).toEqual([]);
    const failed = simulate(config(), policyById('IDLE')!, 2001).state;
    expect(failed.operations!.outcome).toBe('FAILED');
    expect(failed.operations!.growth!.evaluations.some((e) => e.day === 90)).toBe(false);
  });
  it('기준 정책의 실제 사다리 실행은 모든 마감 불변식과 저장 왕복을 통과한다', () => {
    const c = config(), { state } = simulate(c, policyById('MAX_CONTRIBUTION')!, 2001);
    expect(growthProblems(state, c)).toEqual([]);
    expect(serializeSave(deserializeSave(serializeSave(state), { dataVersion: c.dataVersion }))).toBe(serializeSave(state));
  }, 120000);
});
