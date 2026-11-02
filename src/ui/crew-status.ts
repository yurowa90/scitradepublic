import { employedDefs } from '../engine/employees';
import { formatMoney } from '../engine/money';
import { isDayBasedTask, taskSubjectKo } from '../engine/tasks';
import { EngineError, type GameState, type ScenarioConfig, type Task } from '../engine/types';

export function taskSchedule(t: Task, config: ScenarioConfig): string {
  const name = { CULTURE: '현지 활동', TRAINING: '일반 훈련', SCOUT: '현장 조사', RECRUIT_QUEST: '영입 의뢰', EXPORT_PREP: '수출 준비', FORWARDING_PREP: '주선 준비' }[t.kind];
  const subject = taskSubjectKo(config, t);
  return `${name} 중 — ${subject ? `${subject} ` : ''}${t.progressWorkUnits}/${t.requiredWorkUnits}${isDayBasedTask(t.kind) ? '일' : 'pt'}`;
}

export function crewNoteKo(config: ScenarioConfig, state?: GameState): string {
  const employees = state ? employedDefs(state, config)
    : config.employees.filter((e) => !config.recruitment?.candidateEmployeeIds.includes(e.id));
  const units = employees.map((e) => e.workUnitsPerDay);
  if (!units.length) units.push(0);
  const min = Math.min(...units), max = Math.max(...units);
  const daily = `하루 ${min === max ? min : `${min}~${max}`}pt`;
  const salaries = employees.map((e) => e.salaryPerDayMinor);
  if (!salaries.length) salaries.push(0);
  const minSalary = Math.min(...salaries), maxSalary = Math.max(...salaries);
  const salary = minSalary === maxSalary ? formatMoney(config.payrollCurrency, minSalary)
    : `${formatMoney(config.payrollCurrency, minSalary)}~${formatMoney(config.payrollCurrency, maxSalary)}`;
  const note = config.growth
    ? `레벨·능력은 성장 기록으로 보여 주며 아직 처리량(${daily})에는 쓰지 않습니다. 레벨이 올라도 급여·직책은 바뀌지 않습니다.`
    : `처리량은 고정값(${daily})만 씁니다. 능력·속성·레벨·시너지는 이 시나리오에서 쓰지 않습니다.`;
  return `${note} 일급 ${salary}.`;
}

/** 모든 직원 표시가 같은 글자와 기호로 근무·교육을 구분한다. */
export function crewStatusKo(task?: Task): string {
  if (!task) return '○ 대기';
  switch (task.kind) {
    case 'CULTURE': return `◇ 현지 활동 중 ${task.progressWorkUnits}/${task.requiredWorkUnits}일`;
    case 'TRAINING': return `◆ 교육 중 ${task.progressWorkUnits}/${task.requiredWorkUnits}일`;
    case 'EXPORT_PREP':
    case 'FORWARDING_PREP':
    case 'SCOUT':
    case 'RECRUIT_QUEST': return '● 업무 중';
    default: {
      const unknown: never = task.kind;
      throw new EngineError(`알 수 없는 업무 종류입니다 (${unknown}).`);
    }
  }
}
