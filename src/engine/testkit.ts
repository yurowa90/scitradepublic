// 테스트와 화면 자동 진행에서 함께 쓰는 실행 도우미.

import { commitDay, openDay, planCommands, planState } from './engine';
import { listSailings, routeBetween } from './catalog';
import { isAvailableFromToday } from './employees';
import { runningTaskOf } from './reservations';
import { tradePairs } from './reports';
import { offerDef } from './market';
import type { EngineCommand, Command, CommandResult, GameState, ScenarioConfig } from './types';

export type DayScript = Record<number, EngineCommand[]>;

/** 현재 날짜부터 lastDay 마감까지 진행한다. 각 날의 명령은 script에서 가져온다. */
export function runDays(
  state: GameState,
  config: ScenarioConfig,
  lastDay: number,
  script: DayScript = {},
): { state: GameState; results: Record<number, CommandResult[]> } {
  let s = state;
  const results: Record<number, CommandResult[]> = {};
  while (s.phase !== 'ENDED' && s.day <= lastDay) {
    s = openDay(s, config).state;
    const day = s.day;
    const committed = commitDay(s, config, script[day] ?? []);
    results[day] = committed.results;
    s = committed.state;
  }
  return { state: s, results };
}

/** M1 기본 진행: 1일차에 견적 수락·준비 업무 배정·2일 출항편 예약. */
export function standardDayOneCommands(config: ScenarioConfig): Command[] {
  const employee = config.employees[0];
  const buy = config.offers.find((o) => o.kind === 'supplier');
  const sell = config.offers.find((o) => o.kind === 'customer');
  const route = config.routes[0];
  if (!employee || !buy || !sell || !route) throw new Error('M1 기본 진행에 필요한 직원·견적·노선이 없습니다.');
  return [
    { id: 'CMD-ACCEPT', type: 'ACCEPT_TRADE', buyOfferId: buy.id, sellOfferId: sell.id },
    { id: 'CMD-ASSIGN', type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId: employee.id },
    { id: 'CMD-BOOK', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: `${route.id}-D002` },
  ];
}

/**
 * 견적·도시 ID를 모르는 첫날 정책. 직접 무역 쌍 → 운송 주선 견적 순으로 시도한다.
 * 앞 명령을 반영한 상태에서 첫 근무 직원과 첫 출항편을 함께 확정한다(REF-02).
 * 거절된 후보는 다른 직원으로 재시도하지 않는다. 입력 상태는 바꾸지 않는다.
 */
export function acceptAllFeasible(state: GameState, config: ScenarioConfig, idPrefix = 'AUTO'): Command[] {
  const selected: Command[] = [];
  const candidates = [
    ...tradePairs(config).map((pair) => ({
      from: offerDef(state, config, pair.buyOfferId)!.cityId, to: offerDef(state, config, pair.sellOfferId)!.cityId,
      command: { type: 'ACCEPT_TRADE' as const, ...pair },
    })),
    ...config.offers.filter((o) => o.kind === 'forwarding').map((o) => ({
      from: o.cityId, to: o.destinationCityId, command: { type: 'ACCEPT_FORWARDING' as const, offerId: o.id },
    })),
  ];
  for (const candidate of candidates) {
    const planned = planState(state, config, selected).state;
    const employee = config.employees.find((e) => isAvailableFromToday(planned, e.id)
      && planned.employees.find((p) => p.id === e.id)?.locationCityId === candidate.from && !runningTaskOf(planned, e.id));
    const route = candidate.to && routeBetween(config, candidate.from, candidate.to);
    const sailing = route && listSailings(config, route.id, state.day + 1)[0];
    if (!employee || !sailing) continue;
    const command: Command = { ...candidate.command, id: `${idPrefix}-D${state.day}-${selected.length + 1}`,
      plan: { employeeId: employee.id, sailingId: sailing.id } };
    if (planCommands(state, config, [...selected, command]).at(-1)?.status === 'APPLIED') selected.push(command);
  }
  return selected;
}

/** 현재 날짜부터 캠페인 마지막 날까지 마감한다. */
export function runToCampaignEnd(state: GameState, config: ScenarioConfig, script: DayScript = {}): ReturnType<typeof runDays> {
  return runDays(state, config, config.campaignDays, script);
}
