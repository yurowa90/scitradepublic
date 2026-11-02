import { cultureKeys } from './culture';
import { isAvailableFromToday } from './employees';
import { planState } from './engine';
import { cashLessUnpaidMinor, runningTaskOf } from './reservations';
import { payrollRunwayDay } from './previews';
import type { GameState, ScenarioConfig } from './types';

export const CULTURE_UNCHANGED_KO = '가격·하루 처리량·운임·관세·거래 신뢰';

/** 실제 시작 명령과 같은 검사를 사본에서 수행한다. 거절되어도 지출 시의 비교값을 제공한다. */
export function culturePreview(state: GameState, config: ScenarioConfig, activityId: string, employeeId: string) {
  const activity = config.culture?.activities.find((a) => a.id === activityId);
  const currency = activity?.currency ?? config.payrollCurrency;
  const cost = { currency, minor: activity?.costMinor ?? 0 };
  let id = 'CULTURE-PREVIEW';
  while (state.processedCommands[id]) id += '-';
  const phaseReason = state.phase === 'PENDING_OPEN' ? '하루를 연 뒤에 현지 활동을 시작할 수 있습니다.'
    : state.phase === 'ENDED' ? '캠페인이 끝났습니다.' : null;
  const result = phaseReason === null
    ? planState(state, config, [{ id, type: 'START_CULTURE_ACTIVITY', activityId, employeeId }]).results[0]!
    : { status: 'REJECTED', reasonKo: phaseReason };
  const allowed = result.status === 'APPLIED';
  const availableBeforeMinor = cashLessUnpaidMinor(state, config, currency);
  const keys = activity ? cultureKeys(config, activity, employeeId) : null;
  const hasExperience = keys !== null && state.culture.experiences.some((e) => e.key === keys.actorExperience);
  const xpKey = `${employeeId}|CULTURE-FIRST-${activityId}|CULTURE_FIRST_XP`;
  const hasGrowth = config.growth && config.employees.find((e) => e.id === employeeId)?.growth
    && state.employees.some((e) => e.id === employeeId && e.employmentStatus === 'employed');
  return { allowed, reasonKo: allowed ? null : result.reasonKo, cost, durationDays: activity?.durationDays ?? 0,
    busyFromDay: activity ? state.day : null,
    busyUntilDay: activity ? state.day + activity.durationDays - 1 : null,
    availableBeforeMinor, availableAfterMinor: availableBeforeMinor - cost.minor,
    payrollRunwayBefore: payrollRunwayDay(state, config),
    payrollRunwayAfter: payrollRunwayDay(state, config, currency === config.payrollCurrency ? cost.minor : 0),
    waitingTasks: state.tasks.filter((t) => t.cityId === activity?.cityId && t.status === 'QUEUED' && t.assignedEmployeeId === null)
      .map((task) => ({ task: structuredClone(task), reservedDepartureDay: state.bookings.find((b) =>
        b.contractId === task.contractId && b.status === 'BOOKED')?.departureDay ?? null })),
    otherFreeLocalEmployeeIds: state.employees.filter((e) => e.id !== employeeId && e.locationCityId === activity?.cityId
      && isAvailableFromToday(state, e.id) && !runningTaskOf(state, e.id)).map((e) => e.id),
    newRecords: {
      companyReport: keys && state.culture.reports.some((r) => r.key === keys.companyReport) ? 'EXISTS' as const : 'NEW' as const,
      actorExperience: activity !== undefined && !hasExperience,
      relationContactIds: activity?.contactIds.filter((id) => !state.culture.relationEvents.some((r) => r.key === keys!.relationship(id))) ?? [],
      firstCompletionXp: activity && hasGrowth && !state.xpAwards[xpKey] ? config.growth!.taskCompletionXp : 0,
    },
    unchangedKo: CULTURE_UNCHANGED_KO,
  };
}
