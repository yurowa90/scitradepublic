import { isAvailableFromToday } from './employees';
import { runningTaskOf } from './reservations';
import { isDayBasedTask } from './tasks';
import type { GameState, ScenarioConfig, Task } from './types';

export type TaskUnit = 'WORK_UNITS' | 'DAYS';

export interface EmployeeCapacity {
  employeeId: string;
  /** 상태의 locationCityId. */
  cityId: string;
  /** 정의의 값(LEGACY_FIXED). */
  workUnitsPerDay: number;
  /** 진행 중 업무. 없으면 null이며, 지금 새 업무를 맡을 수 있다. */
  running: { taskId: string; kind: Task['kind']; unit: TaskUnit; remaining: number } | null;
}

export interface CityWorkload {
  cityId: string;
  /** 담당 없이 QUEUED인 업무 포인트 업무의 남은 양. */
  unassignedWorkUnits: number;
  unassignedTaskIds: string[];
  /** 배정되어 RUNNING인 업무 포인트 업무의 남은 양. */
  runningWorkUnits: number;
  /** 오늘 근무하는 고용 직원의 하루 처리량 합계. */
  staffWorkUnitsPerDay: number;
  /** 그 가운데 일수 업무(훈련·현지 활동) 중이라 업무 포인트를 처리하지 못하는 처리량. */
  dayTaskWorkUnitsPerDay: number;
  /** 진행 중 업무가 없는 직원의 처리량. 미배정 업무를 지금 맡길 수 있는 몫. */
  idleWorkUnitsPerDay: number;
  /** ceil((unassigned + running) ÷ (staff − dayTask)). 업무가 없으면 0. 업무가 있는데 처리량이 0이면 null. */
  daysToClear: number | null;
}

export interface WorkloadSummary {
  day: number;
  /** 직원이나 셀 업무(미배정·진행 중)가 있는 도시만 넣는다. cityId 오름차순. */
  byCity: CityWorkload[];
  /** 오늘 근무하는 고용 직원. config.employees 순서. */
  employees: EmployeeCapacity[];
  /** 고용은 확정했지만 근무 시작일이 오지 않은 직원. */
  startingLater: { employeeId: string; availableFromDay: number; workUnitsPerDay: number }[];
}

/**
 * LEGACY_FIXED 처리량으로 비교한다. 한 사람은 한 번에 업무 하나만 맡으므로
 * daysToClear보다 실제 완료가 늦을 수 있다. 일수 업무는 포인트 업무량과 섞지 않는다.
 */
export function workloadSummary(s: GameState, config: ScenarioConfig): WorkloadSummary {
  const cities = new Map<string, CityWorkload>();
  const city = (cityId: string): CityWorkload => {
    let row = cities.get(cityId);
    if (!row) {
      row = { cityId, unassignedWorkUnits: 0, unassignedTaskIds: [], runningWorkUnits: 0,
        staffWorkUnitsPerDay: 0, dayTaskWorkUnitsPerDay: 0, idleWorkUnitsPerDay: 0, daysToClear: 0 };
      cities.set(cityId, row);
    }
    return row;
  };
  const employees: EmployeeCapacity[] = [];
  const startingLater: WorkloadSummary['startingLater'] = [];
  for (const def of config.employees) {
    const emp = s.employees.find((e) => e.id === def.id);
    if (!emp || emp.employmentStatus !== 'employed') continue;
    const row = city(emp.locationCityId);
    if (!isAvailableFromToday(s, emp.id)) {
      startingLater.push({ employeeId: emp.id, availableFromDay: emp.availableFromDay, workUnitsPerDay: def.workUnitsPerDay });
      continue;
    }
    const task = runningTaskOf(s, emp.id);
    employees.push({ employeeId: emp.id, cityId: emp.locationCityId, workUnitsPerDay: def.workUnitsPerDay,
      running: task ? { taskId: task.id, kind: task.kind, unit: isDayBasedTask(task.kind) ? 'DAYS' : 'WORK_UNITS',
        remaining: task.requiredWorkUnits - task.progressWorkUnits } : null });
    row.staffWorkUnitsPerDay += def.workUnitsPerDay;
    if (task && isDayBasedTask(task.kind)) row.dayTaskWorkUnitsPerDay += def.workUnitsPerDay;
    if (!task) row.idleWorkUnitsPerDay += def.workUnitsPerDay;
  }
  for (const task of s.tasks) {
    if (isDayBasedTask(task.kind)) continue;
    const remaining = task.requiredWorkUnits - task.progressWorkUnits;
    // 끝났거나 중단된 업무만 있는 도시는 빈 행을 만들지 않는다(Claude 검수).
    if (task.status === 'QUEUED' && task.assignedEmployeeId === null) {
      const row = city(task.cityId);
      row.unassignedWorkUnits += remaining;
      row.unassignedTaskIds.push(task.id);
    } else if (task.status === 'RUNNING' && task.assignedEmployeeId !== null) city(task.cityId).runningWorkUnits += remaining;
  }
  for (const row of cities.values()) {
    const work = row.unassignedWorkUnits + row.runningWorkUnits;
    const capacity = row.staffWorkUnitsPerDay - row.dayTaskWorkUnitsPerDay;
    row.daysToClear = work === 0 ? 0 : capacity === 0 ? null : Math.ceil(work / capacity);
  }
  return { day: s.day, byCity: [...cities.values()].sort((a, b) => a.cityId < b.cityId ? -1 : a.cityId > b.cityId ? 1 : 0), employees, startingLater };
}
