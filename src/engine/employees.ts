// 고용 여부는 상태만 판단한다. 고용 확정과 실제 근무 시작일은 구분한다.
import type { GameState, ScenarioConfig } from './types';

export function isEmployed(s: GameState, id: string): boolean {
  return s.employees.some((e) => e.id === id && e.employmentStatus === 'employed');
}

export function isAvailableFromToday(s: GameState, id: string): boolean {
  return isEmployed(s, id) && s.employees.some((e) => e.id === id && e.availableFromDay <= s.day);
}

/** 운영 목록·처리량·급여는 근무 시작일부터 포함한다. 업무 중 여부는 예약에서 따로 판단한다. */
export function employedDefs(s: GameState, config: ScenarioConfig) {
  return config.employees.filter((e) => isAvailableFromToday(s, e.id));
}
