import { describe, expect, it } from 'vitest';
import { ALL_SCENARIO_IDS, EXPERIMENT_SCENARIO_IDS, loadScenario, OPERATIONS_SCENARIO_IDS, riskProfiles, SCENARIO_IDS } from '../content/scenario';
import { cargoSpace } from './catalog';
import { commitDay, createGame, openDay } from './engine';
import { batchZero, generateBatch } from './market';
import { claimFor, collectionPlan, dutyFor, tariffEvents, withRiskLevel } from './risk';
import type { ScenarioConfig } from './types';

type ExperimentId = (typeof EXPERIMENT_SCENARIO_IDS)[number];
const seeds = Array.from({ length: 20 }, (_, i) => 2001 + i);
const baseConfig = () => loadScenario(OPERATIONS_SCENARIO_IDS[0]);
const market = (cfg: ScenarioConfig) => cfg.operations!.market;
const focus = (cfg: ScenarioConfig) => cfg.offers.find((o) => o.kind === 'supplier')!.goodId;
const sellers = (cfg: ScenarioConfig) => market(cfg).trade.goods.flatMap((g) => g.sellCounterparties.map((p) => p.counterpartyId));

// 생성과 위험 변환은 it 안에서 처음 실행한다. 초기화 예외도 해당 시험의 실패로 남긴다.
const batches = new Map<string, { cfg: ScenarioConfig; generated: ReturnType<typeof generateBatch>[] }[]>();
function published(id: ExperimentId, level: 'R0' | 'R3') {
  const key = `${id}:${level}`;
  if (!batches.has(key)) {
    const runs = seeds.map((seed) => {
      const experiment = loadScenario(id);
      const cfg = level === 'R3' ? withRiskLevel({ ...experiment, seed }, 'R3', riskProfiles()[0]!) : { ...experiment, seed };
      const p = market(cfg).publish;
      let index = batchZero(cfg).index;
      const generated: ReturnType<typeof generateBatch>[] = [];
      for (let k = 1; k <= (p.lastDay - p.firstDay) / p.intervalDays; k++) {
        const result = generateBatch(seed, k, index, cfg);
        generated.push(result);
        index = result.batch.index;
      }
      return { cfg, generated };
    });
    batches.set(key, runs);
  }
  return batches.get(key)!;
}

function inherited(cfg: ScenarioConfig) {
  const { id, titleKo, baseScenarioId, offers, goods, operations, ...rest } = cfg;
  const { market: m, ...operationsRest } = operations!;
  const { index, rows, trade, ...marketRest } = m;
  return { ...rest, operations: { ...operationsRest, market: marketRest } };
}

describe('품목 폭 실험 시나리오', () => {
  it('목록: 실험은 학생·기본 운영 목록 밖에서 읽힌다', () => {
    expect(EXPERIMENT_SCENARIO_IDS).toHaveLength(2);
    for (const id of EXPERIMENT_SCENARIO_IDS) {
      expect(ALL_SCENARIO_IDS).not.toContain(id);
      expect(OPERATIONS_SCENARIO_IDS).not.toContain(id);
      expect(SCENARIO_IDS).not.toContain(id);
      expect(loadScenario(id).id).toBe(id);
    }
  });

  it.each(EXPERIMENT_SCENARIO_IDS)('상속: %s의 운영·시장 공통 설정 전체가 같다', (id) => {
    expect(inherited(loadScenario(id))).toEqual(inherited(baseConfig()));
  });

  it('품목: 정적 매입의 FOCUS를 유지하고 새 품목 하나만 넓힌다', () => {
    const [narrow, wide] = EXPERIMENT_SCENARIO_IDS.map(loadScenario) as [ScenarioConfig, ScenarioConfig];
    const supplier = narrow.offers.find((o) => o.kind === 'supplier')!;
    expect(baseConfig().offers).toContainEqual(supplier);
    expect(wide.offers.find((o) => o.kind === 'supplier')).toEqual(supplier);
    const a = new Set(market(narrow).trade.goods.map((g) => g.goodId));
    const b = new Set(market(wide).trade.goods.map((g) => g.goodId));
    expect(a.has(supplier.goodId)).toBe(true);
    expect(b.has(supplier.goodId)).toBe(true);
    expect(a.size).toBe(1);
    expect(b.size).toBe(2);
    const added = [...b].filter((id) => id !== supplier.goodId);
    expect(added).toHaveLength(1);
    expect(market(baseConfig()).trade.goods.map((g) => g.goodId)).not.toContain(added[0]);
  });

  it.each(EXPERIMENT_SCENARIO_IDS)('견적 수: %s의 R0 공개 묶음은 2G+6 이하', (id) => {
    const runs = published(id, 'R0');
    const counts = runs.flatMap(({ generated }) => generated.map((b) => b.offers.length));
    expect(counts.length).toBeGreaterThan(0);
    const limit = 2 * market(runs[0]!.cfg).trade.goods.length + 6;
    expect(Math.max(...counts)).toBeLessThanOrEqual(limit);
  }, 60000);

  it('거래처: 새 판매처 넷을 덮고 두 품목군의 등급을 구분한다', () => {
    const [narrow, wide] = EXPERIMENT_SCENARIO_IDS.map(loadScenario) as [ScenarioConfig, ScenarioConfig];
    const old = new Set(sellers(baseConfig()));
    const added = new Set([...sellers(narrow), ...sellers(wide)].filter((id) => !old.has(id)));
    expect(added.size).toBe(4);
    const rows = riskProfiles()[0]!.collections.byCounterparty;
    for (const id of added) expect(rows.some((r) => r.counterpartyId === id)).toBe(true);
    const group = (cfg: ScenarioConfig, goodId: string) => market(cfg).trade.goods.find((g) => g.goodId === goodId)!.sellCounterparties.map((p) => p.counterpartyId);
    const cosmetics = group(wide, focus(wide));
    expect(new Set(group(narrow, focus(narrow)))).toEqual(new Set(cosmetics));
    const extra = market(wide).trade.goods.find((g) => g.goodId !== focus(wide))!;
    const laver = group(wide, extra.goodId);
    expect(cosmetics).toHaveLength(2);
    expect(laver).toHaveLength(2);
    const grades = (ids: string[]) => new Set(ids.map((id) => rows.find((r) => r.counterpartyId === id)!.grade));
    expect(grades(cosmetics).size).toBe(1);
    expect(grades(laver).size).toBe(1);
    expect(grades(laver)).not.toEqual(grades(cosmetics));
  });

  it('위험 변환: 모든 공개 묶음의 새 품목·판매처가 순수 위험 함수를 통과한다', () => {
    const runs = EXPERIMENT_SCENARIO_IDS.flatMap((id) => published(id, 'R3'));
    const wide = loadScenario(EXPERIMENT_SCENARIO_IDS[1]);
    const addedGood = market(wide).trade.goods.find((g) => g.goodId !== focus(wide))!.goodId;
    const old = new Set(sellers(baseConfig()));
    const addedParties = new Set(sellers(wide).filter((id) => !old.has(id)));
    const sales = runs.flatMap(({ generated }) => generated.flatMap((b) => b.offers.filter((o) => o.kind === 'customer')));
    expect(sales.some((o) => o.goodId === addedGood)).toBe(true);
    expect(addedParties.size).toBe(4);
    for (const id of addedParties) expect(sales.some((o) => o.counterpartyId === id)).toBe(true);
    for (const { cfg, generated } of runs) for (const { batch, offers } of generated) {
      for (const sell of offers.filter((o) => o.kind === 'customer')) {
        const buy = offers.find((o) => o.kind === 'supplier' && o.goodId === sell.goodId)!;
        expect(buy).toBeDefined();
        expect(claimFor(cfg, cfg.seed, sell.id, sell.goodId)).toBeDefined();
        expect(collectionPlan(cfg, cfg.seed, sell.id, sell.counterpartyId)).toBeDefined();
        expect(dutyFor(cfg, cfg.seed, sell.goodId, sell.cityId, batch.publishDay, batch.publishDay,
          buy.unitPriceMinor * buy.quantity, buy.currency, batch.publishDay)).toBeGreaterThanOrEqual(0);
      }
    }
  }, 60000);

  it.each([OPERATIONS_SCENARIO_IDS[0], ...EXPERIMENT_SCENARIO_IDS])('김 없는 시나리오 구동: %s, R2·R3 20시드', (id) => {
    const shared = riskProfiles()[0]!;
    // 공유 프로필에 시나리오 밖 품목이 있어야 이 시험이 실제 거르기를 검증한다.
    for (const missingId of [OPERATIONS_SCENARIO_IDS[0], EXPERIMENT_SCENARIO_IDS[0]]) {
      const goods = new Set(loadScenario(missingId).goods.map((g) => g.id));
      expect(shared.tariff.base.some((r) => !goods.has(r.goodId))).toBe(true);
    }
    for (const seed of seeds) for (const level of ['R2', 'R3'] as const) {
      const cfg = withRiskLevel({ ...loadScenario(id), seed }, level, shared);
      const goods = new Set(cfg.goods.map((g) => g.id));
      const profile = cfg.operations!.risk!.profile;
      expect(profile.tariff.base.every((r) => goods.has(r.goodId))).toBe(true);
      expect(profile.claims.byGood.every((r) => goods.has(r.goodId))).toBe(true);
      if (level === 'R2') {
        const base = withRiskLevel({ ...baseConfig(), seed }, 'R2', shared);
        expect(tariffEvents(cfg, seed)).toEqual(tariffEvents(base, seed));
      }
      let s = createGame(cfg);
      while (s.phase !== 'ENDED') {
        expect(s.day).toBeLessThanOrEqual(cfg.campaignDays);
        s = openDay(s, cfg).state;
        s = commitDay(s, cfg, []).state;
      }
      expect(s.phase).toBe('ENDED');
    }
  }, 180000);

  it('(가) 설정 동일: 공유 프로필과 불필요한 품목 행을 뺀 사본', () => {
    const base = { ...baseConfig(), seed: seeds[0]! }, shared = riskProfiles()[0]!;
    const before = structuredClone(shared), reduced = structuredClone(shared);
    const goods = new Set(base.goods.map((g) => g.id));
    reduced.tariff.base = reduced.tariff.base.filter((r) => goods.has(r.goodId));
    reduced.claims.byGood = reduced.claims.byGood.filter((r) => goods.has(r.goodId));
    expect(reduced.tariff.base.length).toBeLessThan(shared.tariff.base.length);
    for (const level of ['R1', 'R2', 'R3'] as const) {
      expect(withRiskLevel(base, level, shared)).toEqual(withRiskLevel(base, level, reduced));
    }
    expect(shared).toEqual(before);
    expect(withRiskLevel(base, 'R0', shared)).toBe(base);
  });

  it('1묶음 크기: 두 품목의 무게·부피가 같다', () => {
    const cfg = loadScenario(EXPERIMENT_SCENARIO_IDS[1]);
    const cosmetics = market(cfg).trade.goods.find((g) => g.goodId === focus(cfg))!;
    const laver = market(cfg).trade.goods.find((g) => g.goodId !== focus(cfg))!;
    expect(cargoSpace(cfg, cosmetics.goodId, cosmetics.baseLot)).toEqual(cargoSpace(cfg, laver.goodId, laver.baseLot));
  });

  it.each(EXPERIMENT_SCENARIO_IDS)('1일 시작: %s의 정적 화장품 한 쌍과 주선 둘', (id) => {
    const cfg = { ...loadScenario(id), seed: seeds[0]! };
    const trade = cfg.offers.filter((o) => o.kind !== 'forwarding');
    expect(trade).toHaveLength(2);
    expect(trade.map((o) => o.kind).sort()).toEqual(['customer', 'supplier']);
    expect(new Set(trade.map((o) => o.goodId))).toEqual(new Set([focus(cfg)]));
    expect(cfg.offers.filter((o) => o.kind === 'forwarding')).toEqual(baseConfig().offers.filter((o) => o.kind === 'forwarding'));
    expect(cfg.offers.filter((o) => o.kind === 'forwarding')).toHaveLength(2);
    const started = openDay(createGame(cfg), cfg).state;
    expect(started.day).toBe(1);
    expect(commitDay(started, cfg, []).state.day).toBe(2);
  });
});
