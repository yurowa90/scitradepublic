// 첫 화면에서도 쓰는 이름표. 규칙 2 화면 묶음에 의존하지 않는다.
import { cityName, routeOf } from '../engine/catalog';
import type { BottleneckConstraint } from '../engine/readers';
import type { ScenarioConfig } from '../engine/types';

const labels: Record<BottleneckConstraint, string> = {
  DEMAND: '수요', STAFF: '직원', WAREHOUSE_HANDLING: '창고 처리', STORAGE: '보관', SAILING: '선복',
};
export const constraintLabel = (constraint: BottleneckConstraint) => labels[constraint];
export function routeLabel(config: ScenarioConfig, routeId: string): string {
  const route = routeOf(config, routeId);
  return `${cityName(config, route.fromCityId)} → ${cityName(config, route.toCityId)}`;
}
export function counterpartyNameKo(config: ScenarioConfig, id: string): string {
  return config.operations?.market.counterparties.find((p) => p.id === id)?.nameKo ?? '거래처';
}

