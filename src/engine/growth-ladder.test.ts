import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { growthData, growthEngine, opsData, OPS_DATA_MISSING, resetOpsDataForTest,
  setGrowthData, setGrowthEngine, setOpsData } from '../content/ops-data';
import { loadSaveText } from '../ui/session';
import { createGame, openDay, planState } from './engine';
import { checkSaveShape } from './save-shape';
import { deserializeSave, serializeSave } from './save';

const config = () => ({ ...loadScenario('SCENARIO_M2_OPS_LADDER'), seed: 2001 });

describe('TASK-0085 사다리 저장 경계', () => {
  it('운영 자료를 싣기 전에는 저장 모양 검사보다 OPS_DATA_MISSING이 먼저 난다', () => {
    const c = config(), s = createGame(c);
    const file = JSON.parse(serializeSave(s));
    // 모양을 일부러 깨뜨려 검사 순서까지 고정한다.
    delete file.state.operations.growth;
    const text = JSON.stringify(file);
    const ops = opsData(), data = growthData(), engine = growthEngine();
    resetOpsDataForTest();
    try {
      expect(() => loadSaveText(text)).toThrow(OPS_DATA_MISSING);
      expect(() => deserializeSave(text, { dataVersion: c.dataVersion })).toThrow(OPS_DATA_MISSING);
    } finally {
      setOpsData(ops); setGrowthData(data); setGrowthEngine(engine);
    }
    expect(() => deserializeSave(text, { dataVersion: c.dataVersion })).toThrow('state.operations.growth');
  });
  it('사다리 저장은 형식 7로 왕복한다', () => {
    const c = config(), s = createGame(c), text = serializeSave(s);
    expect(JSON.parse(text).formatVersion).toBe(7);
    expect(serializeSave(deserializeSave(text, { dataVersion: c.dataVersion }))).toBe(text);
  });
  it('사다리 밖 LOCKED 견적을 거절한다 (R5·V15)', () => {
    const s = createGame(loadScenario('SCENARIO_M2_OPS_CREDIT'));
    s.offers[0]!.status = 'LOCKED';
    expect(() => checkSaveShape(s)).toThrow('사다리에서만 허용합니다');
  });
  it('사다리 밖 stageLocked 키를 거절한다 (R5)', () => {
    const c = loadScenario('SCENARIO_M2_OPS_CREDIT');
    let s = openDay(createGame(c), c).state;
    const buy = c.offers.find(o => o.kind === 'supplier')!;
    const sell = c.offers.find(o => o.kind === 'customer')!;
    s = planState(s, c, [{ id: '저장-시험', type: 'ACCEPT_TRADE', buyOfferId: buy.id, sellOfferId: sell.id, quantity: buy.quantityStep }]).state;
    expect(s.contracts).toHaveLength(1);
    s.contracts[0]!.creditEligible!.stageLocked = [];
    expect(() => checkSaveShape(s)).toThrow('사다리에서만 허용합니다');
  });
  it('사다리 밖 growth 키를 거절하고 사다리 안에서는 필수로 검사한다', () => {
    const c = config(), s = createGame(c);
    const other = createGame(loadScenario('SCENARIO_M2_OPS_CREDIT'));
    other.operations!.growth = s.operations!.growth;
    expect(() => checkSaveShape(other)).toThrow('사다리에서만 허용합니다');
    delete s.operations!.growth;
    expect(() => checkSaveShape(s)).toThrow('state.operations.growth');
  });
  it('0번 묶음 견적은 첫 평가일 전에 끝난다', () => {
    const c = config(), p = c.operations!.market.publish;
    for (const o of c.offers) expect(o.validUntilDay).toBeLessThan(p.firstDay + p.intervalDays - 1);
  });
});
