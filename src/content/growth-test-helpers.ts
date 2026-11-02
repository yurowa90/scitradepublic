// 시험 전용: S1 상한을 적용하기 전의 기반 설정에서 항등 설정을 만든다.
import { loadScenario } from './scenario';
import scenarios from '../../data/scenarios.json';
import { prepareLadderConfig } from '../engine/growth-ladder';

export function debugLadderConfig() {
  const record = scenarios.items.find((item) => item.id === 'SCENARIO_M2_OPS_LADDER')!;
  const config = loadScenario('SCENARIO_M2_OPS_CREDIT');
  config.id = record.id;
  config.baseScenarioId = record.base_scenario_id!;
  config.titleKo = record.title_ko!;
  prepareLadderConfig(config, record, { debugAllUnlocked: true });
  for (const level of ['NEW', 'REGULAR', 'PRIORITY'] as const) config.operations!.growth!.ladder.trust[level].sale_premium_bp = 0;
  return config;
}
