import { describe, expect, it } from 'vitest';
import { loadScenario, OPERATIONS_SCENARIO_IDS } from '../content/scenario';
import { commitDay, createGame, openDay, planState } from './engine';
import { offerDef, openTradePairs } from './market';
import { deserializeSave, SaveError, serializeSave, type SaveFile } from './save';
import { runDays } from './testkit';
import type { GameState } from './types';

const config = loadScenario(OPERATIONS_SCENARIO_IDS[0]);
const publish = config.operations!.market.publish;
function generatedState(): GameState {
  let state = createGame(config);
  // 묶음 0은 고정 견적이다. 설정의 다음 공개일부터 직접 무역 쌍과 주선 견적이 함께 있는 날을 찾는다.
  for (let day = publish.firstDay + publish.intervalDays; day <= publish.lastDay; day += publish.intervalDays) {
    state = openDay(runDays(state, config, day - 1).state, config).state;
    if (openTradePairs(state, config).some((pair) => offerDef(state, config, pair.buyOfferId)!.batchK! > 0)
      && state.operations!.offers.some((o) => o.batchK! > 0 && o.kind === 'forwarding' && o.publishDay === day)) return state;
    if (state.phase === 'ENDED') break;
  }
  throw new Error('생성 직접 무역 쌍과 운송 주선 견적을 함께 찾지 못했습니다');
}
let cachedState: GameState | undefined;
const fixture = () => cachedState ??= generatedState();
const read = (text: string) => deserializeSave(text, { dataVersion: config.dataVersion, config });
const generatedPair = (s: GameState) => openTradePairs(s, config).find((p) => offerDef(s, config, p.buyOfferId)!.batchK! > 0)!;
const buy = (s: GameState) => s.operations!.offers.find((o) => o.id === generatedPair(s).buyOfferId)!;
const forwarding = (s: GameState) => s.operations!.offers.find((o) => o.batchK! > 0 && o.kind === 'forwarding')!;
const batch = (s: GameState) => s.operations!.batches.find((b) => b.k === buy(s).batchK)!;
const absent = {
  party: `${config.operations!.market.counterparties[0]!.id}-없음`,
  city: `${config.cities[0]!.id}-없음`,
  good: `${config.goods[0]!.id}-없음`,
  template: `${config.operations!.market.forwarding.templates[0]!.id}-없음`,
};
const cases: [string, (s: GameState) => void, string][] = [
  ['offers.quantity 배수', (s) => { const o = buy(s); o.quantityStep = Math.max(2, o.quantityStep); o.quantity = o.quantityStep + 1; o.maxQuantity = o.quantityStep * 3; }, '견적의 수량·단위·최대 수량이 맞지 않습니다'],
  ['offers.quantityStep 0', (s) => { buy(s).quantityStep = 0; }, '견적의 수량·단위·최대 수량이 맞지 않습니다'],
  ['offers.maxQuantity 배수', (s) => { const o = buy(s); o.quantityStep = Math.max(2, o.quantityStep); o.quantity = o.quantityStep; o.maxQuantity = o.quantityStep * 2 + 1; }, '견적의 수량·단위·최대 수량이 맞지 않습니다'],

  ['offers.counterpartyId', (s) => { buy(s).counterpartyId = absent.party; }, '생성 견적이 설정에 없는 거래처를 가리킵니다'],
  ['offers.cityId', (s) => { buy(s).cityId = absent.city; }, '생성 견적이 설정에 없는 도시를 가리킵니다'],
  ['offers.destinationCityId', (s) => { forwarding(s).destinationCityId = absent.city; }, '생성 견적이 설정에 없는 도착 도시를 가리킵니다'],
  ['offers.goodId', (s) => { buy(s).goodId = absent.good; }, '생성 견적이 설정에 없는 품목을 가리킵니다'],
  ['offers.templateId', (s) => { forwarding(s).templateId = absent.template; }, '생성 견적이 설정에 없는 견본을 가리킵니다'],
  ['batches.rows.cityId', (s) => { batch(s).rows[0]!.cityId = absent.city; }, '공개 묶음 시세 행이 설정에 없는 도시를 가리킵니다'],
  ['batches.rows.goodId', (s) => { batch(s).rows[0]!.goodId = absent.good; }, '공개 묶음 시세 행이 설정에 없는 품목을 가리킵니다'],
  ['batches.index.goodId', (s) => { batch(s).index[0]!.goodId = absent.good; }, '공개 묶음 지수가 설정에 없는 품목을 가리킵니다'],
  ['batches.counterpartyPct.goodId', (s) => { batch(s).counterpartyPct![0]!.goodId = absent.good; }, '공개 묶음 거래처 보정률이 설정에 없는 품목을 가리킵니다'],
  ['batches.maxLots.goodId', (s) => { batch(s).maxLots![0]!.goodId = absent.good; }, '공개 묶음 최대 묶음 수가 설정에 없는 품목을 가리킵니다'],
  ['batches.destinations.cityId', (s) => { batch(s).destinations![0]!.cityId = absent.city; }, '공개 묶음 목적지가 설정에 없는 도시를 가리킵니다'],
  ['batches.destinations.goodId', (s) => { batch(s).destinations![0]!.goodId = absent.good; }, '공개 묶음 목적지가 설정에 없는 품목을 가리킵니다'],
  ['batches.templateIds', (s) => { batch(s).templateIds[0] = absent.template; }, '공개 묶음 견본 목록이 설정에 없는 견본을 가리킵니다'],
];

describe('생성 견적·공개 묶음 저장 참조', () => {
  it('정상 저장은 전체 상태를 보존하고 생성 견적 쌍을 수락한다', () => {
    const state = fixture(), saved = serializeSave(state), pair = generatedPair(state);
    expect(forwarding(state)).toBeDefined();
    expect(buy(state).destinationCityId).toBeNull();
    expect(buy(state).templateId).toBeNull();
    const loaded = read(saved);
    expect(loaded).toEqual(state);
    const commands = [{ id: '저장-생성-수락', type: 'ACCEPT_TRADE' as const, ...pair }];
    const opened = openDay(loaded, config).state;
    expect(planState(opened, config, commands)).toEqual(planState(state, config, commands));
    expect(planState(opened, config, commands).results).toEqual([{ commandId: commands[0]!.id, status: 'APPLIED', reasonKo: '처리됨' }]);
    expect(commitDay(opened, config, commands)).toEqual(commitDay(state, config, commands));
  });

  it.each(cases)('%s 한 칸 변조는 가져오기에서 한국어 SaveError로 거부한다', (_field, mutate, message) => {
    const state = fixture(), saved = serializeSave(state);
    const file: SaveFile = JSON.parse(saved);
    mutate(file.state);
    let error: unknown;
    try { read(JSON.stringify(file)); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as Error).message).toContain('저장 상태 검증 실패:');
    expect((error as Error).message).toContain(message);
    // 거래처도 명령 실행의 nameKo 예외까지 가지 않고 이 경로에서 거부한다.
    expect((error as Error).message).not.toContain('nameKo');
    expect(serializeSave(state)).toBe(saved);
  });
});
