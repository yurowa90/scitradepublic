import { describe, expect, it } from 'vitest';
import { ALL_SCENARIO_IDS, LOADABLE_SCENARIO_IDS, loadRiskProfile, loadScenario } from '../content/scenario';
import { loadSaveText } from '../ui/session';
import { commitDay, createGame, openDay, planState } from './engine';
import { post } from './ledger';
import { offerDef, openTradePairs } from './market';
import { storageShortfall } from './operations';
import { withRiskLevel } from './risk';
import { deserializeSave, serializeSave } from './save';
import { policyById } from './sim/policies';
import { simConfigV2 } from './sim/risk-metrics';
import { simulate } from './sim/sim';
import type { GameState } from './types';
import { unaffordableRecords } from './unaffordable';

const config = (seed = 2001) => ({ ...loadScenario('SCENARIO_M2_OPS_CREDIT'), seed });
const legacyMessage = (n: number) => `이전 저장 형식(판본 ${n})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`;
const fresh = () => { const c = config(); return { c, s: openDay(createGame(c), c).state }; };
function firstMarket() {
  const c = config();
  let s = openDay(createGame(c), c).state;
  // 1일 고정 시작 견적은 최대 한 단위다. 첫 반복 공개(k=1, 8일)에서 수량 선택을 검증한다.
  const day = c.operations!.market.publish.firstDay + c.operations!.market.publish.intervalDays;
  while (s.day < day) s = openDay(commitDay(s, c, []).state, c).state;
  const pair = openTradePairs(s, c).find((p) => {
    const b = offerDef(s, c, p.buyOfferId)!;
    return b.maxQuantity >= 2 * b.quantityStep;
  })!;
  expect(pair).toBeDefined();
  const buy = offerDef(s, c, pair.buyOfferId)!;
  expect(buy.publishDay).toBe(s.day);
  expect(buy.maxQuantity).toBeGreaterThanOrEqual(2 * buy.quantityStep);
  return { c, s, pair, buy };
}
function spend(s: GameState, currency: 'KRW' | 'USD', amount: number) {
  post(s.ledger, { id: `시험 지출-${currency}`, day: s.day, currency, reason: '자금 경계 시험',
    lines: [{ account: 'OPENING_EQUITY', amount }, { account: 'CASH', amount: -amount }] });
}
function deepFreeze(value: unknown) {
  if (value && typeof value === 'object') { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
}

describe('TASK-0074 형식 7·놓친 견적', () => {
  it('시나리오는 식별 칸 셋을 제외하면 R4 변환과 엄격히 같고 선택 목록에는 없다', () => {
    const { id: _a, titleKo: _b, baseScenarioId: _c, ...actual } = loadScenario('SCENARIO_M2_OPS_CREDIT');
    const { id: _d, titleKo: _e, baseScenarioId: _f, ...expected } = simConfigV2(loadScenario('SCENARIO_M2_OPS_COS_LAVER'), 'R4', 'RISK_PROFILE_V2');
    expect(actual).toStrictEqual(expected);
    expect(ALL_SCENARIO_IDS).not.toContain('SCENARIO_M2_OPS_CREDIT');
    expect(LOADABLE_SCENARIO_IDS).toEqual([...ALL_SCENARIO_IDS, 'SCENARIO_M2_OPS_CREDIT']);
  });
  it.each([2001, 2002, 2003])('시드 %i의 날마다 형식 7 왕복과 다시 열기는 바이트·기록이 같다', (seed) => {
    const c = config(seed); let checked = 0;
    const verify = (s: GameState) => {
      const text = serializeSave(s);
      expect(JSON.parse(text).formatVersion).toBe(7);
      expect(serializeSave(deserializeSave(text, { config: c, dataVersion: c.dataVersion }))).toBe(text);
      const loaded = loadSaveText(text);
      expect(loaded).not.toHaveProperty('errorKo');
      if ('state' in loaded) expect(loaded.state.operations!.unaffordable).toStrictEqual(s.operations!.unaffordable);
      checked++;
    };
    const { state } = simulate(c, policyById('MAX_CONTRIBUTION')!, seed, verify);
    verify(state);
    expect(checked).toBe(state.day);
    expect(state.phase).toBe('ENDED');
  }, 30000);
  it('최소 수량의 손 계산: 첫 반복 공개 조미김의 원화 부족', () => {
    const { c, s, pair, buy } = firstMarket();
    expect([s.day, buy.goodId, buy.quantityStep, buy.maxQuantity, buy.unitPriceMinor]).toEqual([8, 'SEASONED_LAVER', 100, 300, 24719]);
    spend(s, 'KRW', 7000000);
    // 자료 매입 기준 20달러×1,300=26,000원. 시드 2001의 k=1 지수 −1%, 지역 −1%, 거래처 −3%:
    // 반올림(26,000×0.99×0.99)=25,483, 반올림(25,483×0.97)=24,719원.
    // 필요 24,719원 × 100 = 2,471,900원. 가용 10,000,000 − 임차 450,000 − 급여 80,000×2×7 − 지출 7,000,000 − 예약 0 = 1,430,000원.
    expect(unaffordableRecords(s, c).find((r) => r.buyOfferId === pair.buyOfferId)).toStrictEqual({
      day: 8, ...pair, quantity: 100, shortfalls: [{ currency: 'KRW', needMinor: 2471900, availableMinor: 1430000 }],
    });
  });
  it('두 통화 손 계산은 KRW·USD 사전순이다', () => {
    const { c, s } = fresh(); const pair = openTradePairs(s, c)[0]!;
    spend(s, 'KRW', 9000000); spend(s, 'USD', 299000);
    // 원화 52,000×50=2,600,000, 가용 10,000,000−9,000,000=1,000,000.
    // 달러 운임 18,000센트 + 관세 (2,600,000×100/1,300)×5%=10,000센트; 가용 300,000−299,000=1,000센트.
    expect(unaffordableRecords(s, c)).toStrictEqual([{ day: 1, ...pair, quantity: 50, shortfalls: [
      { currency: 'KRW', needMinor: 2600000, availableMinor: 1000000 },
      { currency: 'USD', needMinor: 28000, availableMinor: 1000 },
    ] }]);
  });
  it('기록 함수는 모든 입력 칸·추첨 커서를 보존하고 얼린 상태도 읽는다', () => {
    const { c, s } = firstMarket(); spend(s, 'KRW', 7000000);
    const before = structuredClone(s), rows = unaffordableRecords(s, c);
    expect(rows.length).toBeGreaterThan(0);
    expect(s).toStrictEqual(before);
    const frozen = structuredClone(s); deepFreeze(frozen); deepFreeze(c);
    expect(unaffordableRecords(frozen, c)).toStrictEqual(rows);
    expect(frozen).toStrictEqual(before);
  });
  it('부족 기록이 있는 공개일을 다시 열어도 중복 행이 생기지 않는다', () => {
    const { c, s } = firstMarket(); spend(s, 'KRW', 7000000);
    s.phase = 'PENDING_OPEN'; s.operations!.unaffordable = [];
    const once = openDay(s, c).state;
    expect(once.operations!.unaffordable!.length).toBeGreaterThan(0);
    expect(openDay(once, c).state).toStrictEqual(once);
    const loaded = loadSaveText(serializeSave(once));
    expect(loaded).not.toHaveProperty('errorKo');
    if ('state' in loaded) expect(loaded.state.operations!.unaffordable).toStrictEqual(once.operations!.unaffordable);
  });
  it('시드 2001~2010 매일 최소 수량 인수의 자금 사유와 기록이 일치한다', () => {
    let rowCount = 0, pairsChecked = 0, oldPairs = 0;
    for (let seed = 2001; seed <= 2010; seed++) {
      const c = config(seed);
      simulate(c, policyById('MAX_CONTRIBUTION')!, seed, (s) => {
        const records = s.operations!.unaffordable!.filter((r) => r.day === s.day);
        rowCount += records.length;
        const pairs = openTradePairs(s, c).filter((p) => offerDef(s, c, p.buyOfferId)!.publishDay === s.day);
        expect(records.every((r) => pairs.some((p) => p.buyOfferId === r.buyOfferId && p.sellOfferId === r.sellOfferId))).toBe(true);
        oldPairs += openTradePairs(s, c).length - pairs.length;
        expect(records.map((r) => [r.buyOfferId, r.sellOfferId])).toEqual(records.map((r) => [r.buyOfferId, r.sellOfferId]).sort());
        for (const p of pairs) {
          const quantity = offerDef(s, c, p.buyOfferId)!.quantityStep;
          const result = planState(structuredClone(s), c, [{ id: '최소 수량 판정', type: 'ACCEPT_TRADE', ...p, quantity }]).results[0]!;
          const recorded = records.some((r) => r.buyOfferId === p.buyOfferId && r.sellOfferId === p.sellOfferId);
          if (recorded) expect(result.status).toBe('REJECTED');
          expect(/자금이 부족합니다/.test(result.reasonKo ?? '')).toBe(recorded);
          pairsChecked++;
        }
      });
    }
    expect(rowCount).toBeGreaterThanOrEqual(1); expect(oldPairs).toBeGreaterThan(0);
    console.info(`TASK-0074 판정 일치: 기록 ${rowCount}행, 오늘 짝 ${pairsChecked}개, 지난 공개 짝 ${oldPairs}개`);
  }, 60000);
  it('자금이 충분하고 창고만 부족한 짝은 기록하지 않는다', () => {
    const { c, s, pair, buy } = firstMarket();
    // 회사 소유가 아닌 보관 화물로 창고를 채워 자금·장부와 독립적인 공간 부족을 만든다.
    s.cargoLots.push({ id: '창고 채우기', owner: 'CUSTOMER', ownerPartyId: '시험 화주', goodId: buy.goodId,
      quantity: 100000, originCountryCode: 'KR', carryingAmountMinor: 0, currency: 'KRW',
      locationCityId: c.homeCityId, status: 'HELD_UNALLOCATED', contractId: null, shipmentId: null });
    expect(storageShortfall(s, c, buy.goodId, buy.quantityStep)).toContain('보관 공간 부족');
    const result = planState(s, c, [{ id: '공간 판정', type: 'ACCEPT_TRADE', ...pair, quantity: buy.quantityStep }]).results[0]!;
    expect(result).toMatchObject({ status: 'REJECTED' }); expect(result.reasonKo).toContain('보관 공간 부족');
    expect(unaffordableRecords(s, c).some((r) => r.buyOfferId === pair.buyOfferId && r.sellOfferId === pair.sellOfferId)).toBe(false);
  });
  it.each(['M1-rules-1', 'M2a-rules-1', 'M2a-rules-2', 'M2a-rules-3', 'M2a-rules-4'] as const)('%s의 키 유무와 반대 모양 거절', (version) => {
    const c = version === 'M1-rules-1' ? loadScenario('SCENARIO_M1_ONE_TRADE')
      : version === 'M2a-rules-1' ? loadScenario('SCENARIO_M2_MULTI_TRADE')
      : version === 'M2a-rules-2' ? loadScenario('SCENARIO_M2_OPERATIONS')
      : version === 'M2a-rules-3' ? withRiskLevel(loadScenario('SCENARIO_M2_OPS_COS_LAVER'), 'R3', loadRiskProfile('RISK_PROFILE_DEFAULT')) : config();
    c.seed = 2001;
    const s = openDay(createGame(c), c).state;
    expect(s.operations && Object.hasOwn(s.operations, 'unaffordable') || false).toBe(version === 'M2a-rules-4');
    expect(() => deserializeSave(serializeSave(s), { config: c, dataVersion: c.dataVersion })).not.toThrow();
    if (!s.operations) return;
    if (version === 'M2a-rules-4') delete s.operations.unaffordable; else s.operations.unaffordable = [];
    expect(() => deserializeSave(serializeSave(s), { config: c, dataVersion: c.dataVersion })).toThrow('state.operations.unaffordable');
  });
  it.each(['날짜 역전', '미래 날짜', '중복 짝', '행 모양'] as const)('기록 %s 저장은 거절한다', (damage) => {
    const { c, s } = firstMarket(); spend(s, 'KRW', 7000000);
    const row = unaffordableRecords(s, c)[0]!;
    s.operations!.unaffordable = damage === '날짜 역전' ? [{ ...row, day: 8 }, { ...row, day: 7 }]
      : damage === '미래 날짜' ? [{ ...row, day: 9 }] : damage === '중복 짝' ? [row, row] : [{ ...row, quantity: 1.5 }];
    expect(() => deserializeSave(serializeSave(s), { config: c, dataVersion: c.dataVersion }))
      .toThrow(damage === '행 모양' ? 'quantity' : '놓친 견적의 날짜 순서');
  });
  it.each([1, 2, 3, 4, 5, 6])('판본 %i는 새 문구로 거절한다', (n) => {
    const { c, s } = fresh(), file = JSON.parse(serializeSave(s)); file.formatVersion = n;
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: c.dataVersion })).toThrow(legacyMessage(n));
    expect(loadSaveText(JSON.stringify(file))).toEqual({ errorKo: legacyMessage(n) });
  });
  it.each([8, '7', 6.5])('지원 밖 판본 %s는 기존 문구로 거절한다', (n) => {
    const { c, s } = fresh(), file = JSON.parse(serializeSave(s)); file.formatVersion = n;
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: c.dataVersion })).toThrow(`지원하지 않는 저장 형식 판본입니다 (${n}).`);
  });
  it.each(['offers', 'day', 'dataVersion', 'rulesVersion'])('형식 6의 %s 손상보다 판본 거절이 먼저다', (field) => {
    const { c, s } = fresh(), file = JSON.parse(serializeSave(s)); file.formatVersion = 6;
    if (field === 'offers') file.state.offers = [null];
    else if (field === 'day') delete file.state.day;
    else file[field] = '다른 판본';
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: c.dataVersion })).toThrow(legacyMessage(6));
    expect(loadSaveText(JSON.stringify(file))).toEqual({ errorKo: legacyMessage(6) });
  });
  it('부산 판은 형식 판본 거절보다 먼저다', () => {
    const { c, s } = fresh(), file = JSON.parse(serializeSave(s)); file.formatVersion = 6; file.dataVersion = '0.4.9';
    const message = '이전 판(부산 본사)의 저장입니다. 이번 판에서는 열 수 없습니다.';
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: c.dataVersion })).toThrow(message);
    expect(loadSaveText(JSON.stringify(file))).toEqual({ errorKo: message });
  });
  it('엔진 원천에서 기록은 선언·생성·공개·저장 검사 외의 결정에 쓰이지 않는다', () => {
    const sources = import.meta.glob('./**/*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const allowed = new Set(['./types.ts', './unaffordable.ts', './save-shape.ts', './operations-invariants.ts']);
    for (const [file, source] of Object.entries(sources).filter(([p]) => !p.endsWith('.test.ts'))) {
      if (allowed.has(file)) continue;
      if (file !== './engine.ts') { expect(source, file).not.toContain('unaffordable'); continue; }
      const declarations = [...source.matchAll(/^(?:export )?function (\w+)\(/gm)];
      const preamble = source.slice(0, declarations[0]!.index).replace(/^import .*?;\n/gm, '');
      expect(preamble).not.toContain('unaffordable');
      declarations.forEach((m, i) => {
        if (m[1] === 'createGame' || m[1] === 'openDay') return;
        expect(source.slice(m.index, declarations[i + 1]?.index ?? source.length), m[1]).not.toContain('unaffordable');
      });
    }
  });
});
