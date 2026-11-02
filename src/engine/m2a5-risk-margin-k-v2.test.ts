import { describe, expect, it } from 'vitest';
import raw from '../../data/market_rules.json';
import { loadCreditProfile, loadRiskProfile, loadScenario } from '../content/scenario';
import { withRiskLevelV2 } from './risk';
import { policyById } from './sim/policies';
import { simConfigV2, type RiskLevelV2 } from './sim/risk-metrics';
import { simulate } from './sim/sim';
import type { RiskLayer, ScenarioConfig } from './types';

const profileId = 'RISK_PROFILE_V2';
const base = () => ({ ...loadScenario('SCENARIO_M2_OPS_COS_LAVER'), seed: 2001 });
const levels: RiskLevelV2[] = ['R0P', 'R1', 'R2', 'R3', 'R4'];
const layers: Record<RiskLevelV2, RiskLayer[]> = {
  R0P: [], R1: ['FX'], R2: ['FX', 'TARIFF', 'SURCHARGE'],
  R3: ['FX', 'TARIFF', 'SURCHARGE', 'CLAIM', 'COLLECTION'],
  R4: ['FX', 'TARIFF', 'SURCHARGE', 'CLAIM', 'COLLECTION', 'DEFAULT', 'CARRY'],
};
const configured = (k: number, level: RiskLevelV2 = 'R4', input = base()) =>
  withRiskLevelV2(input, level, loadRiskProfile(profileId), { ...loadCreditProfile(profileId), saleMarginK: k });
const sells = (c: ScenarioConfig) => c.operations!.market.rows.filter((r) => r.side === 'SELL').map((r) => r.basePriceMinor);

// 원본 (다) 행 순서: 화장품 BUY·하이퐁·상하이, 김 BUY·하이퐁·상하이.
// BUY 40·20 USD × 1300 = 52000·26000원. SELL은 원본 51.70·53·25.60·26.60 USD 그대로다.
function expectedZero(input: ScenarioConfig, level: RiskLevelV2): ScenarioConfig {
  const c = structuredClone(input), profile = loadRiskProfile(profileId);
  const goods = new Set(input.goods.map((g) => g.id));
  profile.tariff.base = profile.tariff.base.filter((r) => goods.has(r.goodId));
  profile.claims.byGood = profile.claims.byGood.filter((r) => goods.has(r.goodId));
  c.rules.rulesVersion = 'M2a-rules-4';
  const { saleMarginK: _, ...credit } = loadCreditProfile(profileId);
  c.operations!.risk = { profile, layers: [...layers[level]], credit };
  const prices = [52000, 5170, 5300, 26000, 2560, 2660];
  c.operations!.market.rows.forEach((r, i) => { r.basePriceMinor = prices[i]!; });
  for (const offer of c.offers) if (offer.kind === 'supplier') {
    // 정적 BUY도 종전대로 센트 × 1300 / 100을 원 정수로 반올림한다.
    offer.unitPriceMinor = Math.floor(offer.unitPriceMinor * 13 + 0.5);
    offer.currency = 'KRW';
  }
  return c;
}

function withRawK(value: unknown, check: () => void, absent = false) {
  const p: Record<string, unknown> = raw.risk_profiles.find((p) => p.id === profileId)!;
  const had = Object.hasOwn(p, 'sale_margin_k'), saved = p.sale_margin_k;
  try {
    if (absent) delete p.sale_margin_k;
    else p.sale_margin_k = value;
    check();
  } finally {
    if (had) p.sale_margin_k = saved;
    else delete p.sale_margin_k;
  }
}

describe('TASK-0069 판매 마진 k', () => {
  it.each(levels)('1 항등: %s의 k=0 설정은 손 계산 기대값과 엄격히 같다', (level) => {
    const input = base(), saved = structuredClone(input), credit = { ...loadCreditProfile(profileId), saleMarginK: 0 };
    const actual = withRiskLevelV2(input, level, loadRiskProfile(profileId), credit);
    expect(actual).toStrictEqual(expectedZero(input, level));
    expect(actual.operations!.risk!.credit).not.toHaveProperty('saleMarginK');
    expect(input).toStrictEqual(saved);
    expect(credit.saleMarginK).toBe(0);
  });

  it.each([
    [1, [5370, 5500, 2660, 2760]],
    [3, [5770, 5900, 2860, 2960]],
    [-2, [4770, 4900, 2360, 2460]],
  ] as const)('2가 식: k=%s의 모든 SELL과 나머지 설정 보존', (k, prices) => {
    for (const level of levels) {
      const input = base(), saved = structuredClone(input), zero = expectedZero(input, level);
      const credit = { ...loadCreditProfile(profileId), saleMarginK: k };
      const actual = withRiskLevelV2(input, level, loadRiskProfile(profileId), credit);
      // 화장품 가산은 200·600·-400센트, 김 가산은 100·300·-200센트다.
      expect(sells(actual)).toEqual(prices);
      expect(actual.operations!.market.rows.filter((r) => r.side === 'BUY')).toStrictEqual(
        zero.operations!.market.rows.filter((r) => r.side === 'BUY'));
      expect(actual.offers).toStrictEqual(zero.offers);
      expect(actual.offers.find((o) => o.id === 'OFFER_SELL_02_NEW')!.unitPriceMinor).toBe(5000);
      // SELL 값만 되돌리면 주선 화물을 포함한 모든 칸이 k=0과 같아야 한다.
      actual.operations!.market.rows.forEach((r, i) => { r.basePriceMinor = zero.operations!.market.rows[i]!.basePriceMinor; });
      expect(actual).toStrictEqual(zero);
      expect(input).toStrictEqual(saved);
      expect(credit.saleMarginK).toBe(k);
    }
  });

  it.each([
    // SELL₀=100: 100+10×5/100=100.5→101, 100+11×5/100=100.55→101,
    // 100+9×5/100=100.45→100, 100+10×(-5)/100=99.5→100.
    // 음수 k에서도 가산분만 반올림하지 않고 SELL 합계를 반올림한다.
    [10, 1, 101], [11, 1, 101], [9, 1, 100], [10, -1, 100],
  ])('2나 나머지: BUY=%s, k=%s이면 SELL=%s', (buy, k, expected) => {
    const input = base();
    input.operations!.market.rows = [
      { ...input.operations!.market.rows[0]!, basePriceMinor: buy! },
      { ...input.operations!.market.rows[1]!, basePriceMinor: 100 },
    ];
    expect(sells(configured(k!, 'R4', input))).toEqual([expected]);
  });

  it.each([1, 3, -2])('3 검증기 식: 현재 자료 k=%s의 base는 정수이고 엔진과 같다', (k) => {
    const rule = raw.rule_sets.find((r) => r.id === 'M2A5_PYEONGTAEK_COS_LAVER')!;
    const engine = sells(configured(k));
    rule.rows.filter((r) => r.side === 'SELL').forEach((r, i) => {
      const buy = rule.rows.find((b) => b.side === 'BUY' && b.good_id === r.good_id)!;
      // Python credit_limit_sales의 Fraction(amount)*100 + buys[good]*Fraction(5*margin_k,100).
      // 여기서는 현재 자료의 정수 센트와 k만 대입한다. 나머지 고정물은 2나에서 검사한다.
      const base = r.base_price.amount * 100 + (buy.base_price.amount * 100) * (5 * k) / 100;
      expect(Number.isInteger(base)).toBe(true);
      expect(Math.floor(base + 0.5)).toBe(engine[i]);
    });
  });

  it('4 R0P 적용: k=+1의 R0P와 R4 SELL은 같다', () => {
    expect(sells(configured(1, 'R0P'))).toEqual([5370, 5500, 2660, 2760]);
    expect(sells(configured(1, 'R0P'))).toEqual(sells(configured(1, 'R4')));
  });

  it('5 실행기 경로: 자료 k=+1이 SELL에 닿고 credit에는 남지 않는다', () => {
    withRawK(1, () => {
      const c = simConfigV2(base(), 'R4', profileId);
      expect(sells(c)).toEqual([5370, 5500, 2660, 2760]);
      expect(c.operations!.risk!.credit).not.toHaveProperty('saleMarginK');
    });
  });

  it('6 실제 실행: R4 MAX_CONTRIBUTION 시드 2001을 끝내고 판매액이 달라진다', () => {
    const policy = policyById('MAX_CONTRIBUTION')!;
    const zero = simulate(configured(0), policy, 2001, undefined, 'R4');
    const changed = simulate(configured(1), policy, 2001, undefined, 'R4');
    for (const result of [zero, changed]) {
      expect(result.state.phase).toBe('ENDED');
      expect(result.state.operations!.failure).toBeNull();
    }
    const saleTotal = (s: typeof zero.state) => s.contracts.filter((c) => c.kind === 'DIRECT_TRADE')
      .reduce((sum, c) => sum + c.saleAmountMinor, 0);
    expect(saleTotal(changed.state)).not.toBe(saleTotal(zero.state));
  }, 60000);

  it.each([4, 2.5, '1', -3, null, true])('7 로더 거절: k=%s', (value) => {
    withRawK(value, () => expect(() => loadCreditProfile(profileId))
      .toThrow(`판매 마진 k는 -2~3 정수여야 합니다: ${profileId}`));
  });
  it('7 로더 생략: k=0이거나 없으면 키가 없다', () => {
    withRawK(0, () => expect(loadCreditProfile(profileId)).not.toHaveProperty('saleMarginK'));
    withRawK(undefined, () => expect(loadCreditProfile(profileId)).not.toHaveProperty('saleMarginK'), true);
  });
  it.each([-2, -1, 1, 2, 3])('7 로더 허용: k=%s는 CreditProfile에 싣는다', (k) => {
    withRawK(k, () => expect(loadCreditProfile(profileId).saleMarginK).toBe(k));
  });

  it.each([0, 1])('예외: k=%s에서 BUY 누락·중복을 거절한다', (k) => {
    for (const count of [0, 2]) {
      const input = base(), buy = input.operations!.market.rows[0]!;
      input.operations!.market.rows = [
        ...Array.from({ length: count }, () => ({ ...buy })), input.operations!.market.rows[1]!,
      ];
      expect(() => configured(k, 'R4', input)).toThrow('판매 마진 계산에는 품목별 BUY 행이 하나 필요합니다: COSMETICS');
    }
  });
  it.each([0, -1])('예외: 새 SELL=%s센트는 거절한다', (expected) => {
    const input = base();
    input.operations!.market.rows[0]!.basePriceMinor = 20;
    input.operations!.market.rows[1]!.basePriceMinor = 1;
    expect(() => configured(expected - 1, 'R4', input)).toThrow('판매 마진 적용 후 SELL은 1센트 이상이어야 합니다: COSMETICS');
  });
});
