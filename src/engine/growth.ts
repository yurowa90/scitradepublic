// 누적 경험치만 상태에 저장한다. 레벨·능력은 원값에서 매번 계산한다.
import rules from '../../data/character_rules.json';
import { EngineError, type EmployeeDef, type GameState, type ScenarioConfig, type Task } from './types';

export type XpRewardKind = 'TASK_COMPLETION_XP' | 'TRAINING_XP' | 'CULTURE_FIRST_XP';

/** 일반 업무 완료 보상의 종류와 양을 한 곳에서 정한다. */
export function completionReward(kind: Task['kind'], config: ScenarioConfig): { rewardKind: XpRewardKind; amount: number } | null {
  switch (kind) {
    case 'CULTURE': return null;
    case 'TRAINING': return config.growth
      ? { rewardKind: 'TRAINING_XP', amount: config.growth.ordinaryTraining.xpOnCompletion } : null;
    case 'EXPORT_PREP':
    case 'FORWARDING_PREP':
    case 'SCOUT':
    case 'RECRUIT_QUEST': return config.growth
      ? { rewardKind: 'TASK_COMPLETION_XP', amount: config.growth.taskCompletionXp } : null;
    default: {
      const unknown: never = kind;
      throw new EngineError(`알 수 없는 업무 종류입니다 (${unknown}).`);
    }
  }
}

export function levelFor(xp: number): number {
  return rules.xp_thresholds.reduce((level, threshold) =>
    xp >= threshold.cumulative_xp ? Math.min(rules.level_max, threshold.level) : level, rules.level_min);
}

export function statsFor(def: EmployeeDef, xp: number): Record<string, number> | null {
  const growth = def.growth;
  if (!growth) return null;
  const steps = levelFor(xp) - 1;
  return Object.fromEntries(Object.entries(growth.baseStats).map(([stat, base]) => {
    const gain = stat === growth.primaryStat ? rules.level_gain.primary_stat
      : stat === growth.secondaryStat ? rules.level_gain.secondary_stat : 0;
    return [stat, Math.min(rules.final_stat_cap, base + steps * gain)];
  }));
}

/** 엔진 내부 보상 처리. 호출자는 실제 완료 사건과 지급량을 확정한 뒤 사본 상태에 호출한다. */
export function awardXp(
  s: GameState, config: ScenarioConfig, employeeId: string,
  completionEventId: string, rewardKind: XpRewardKind, amount: number,
): boolean {
  const def = config.employees.find((e) => e.id === employeeId);
  const emp = s.employees.find((e) => e.id === employeeId);
  if (!config.growth || !def?.growth || !emp || emp.employmentStatus !== 'employed') return false;
  if (completionEventId.startsWith('TASK-DONE-')) {
    const task = s.tasks.find((t) => `TASK-DONE-${t.id}` === completionEventId);
    if (!task || task.status !== 'DONE' || task.assignedEmployeeId !== employeeId) return false;
    const reward = completionReward(task.kind, config);
    if (!reward || rewardKind !== reward.rewardKind || amount !== reward.amount) return false;
  }
  if (completionEventId.startsWith('CULTURE-FIRST-') || rewardKind === 'CULTURE_FIRST_XP') {
    const activityId = completionEventId.slice('CULTURE-FIRST-'.length);
    if (completionEventId !== `CULTURE-FIRST-${activityId}` || rewardKind !== 'CULTURE_FIRST_XP'
      || amount !== config.growth.taskCompletionXp || !config.culture?.activities.some((a) => a.id === activityId)
      || !s.tasks.some((t) => t.kind === 'CULTURE' && t.subjectId === activityId && t.status === 'DONE'
        && t.assignedEmployeeId === employeeId)) return false;
  }
  const key = `${employeeId}|${completionEventId}|${rewardKind}`;
  if (s.xpAwards[key]) return false;
  if (!Number.isSafeInteger(amount) || amount <= 0 || !Number.isSafeInteger(emp.xp + amount)) {
    throw new Error('경험치 지급량은 누적 가능한 양의 정수여야 합니다.');
  }
  const before = levelFor(emp.xp);
  emp.xp += amount;
  s.xpAwards[key] = true;
  s.xpAwardAmounts[key] = amount;
  for (let level = before + 1; level <= levelFor(emp.xp); level++) {
    s.log.push({ day: s.day, textKo: `${def.nameKo} 레벨 ${level} 달성` });
  }
  return true;
}

/** 완료한 실제 업무만 보상한다. 훈련은 일반 완료 보상과 배타적이다. */
export function awardTaskCompletion(s: GameState, config: ScenarioConfig, task: Task): boolean {
  if (!config.growth || !s.tasks.includes(task) || task.status !== 'DONE' || !task.assignedEmployeeId) return false;
  const reward = completionReward(task.kind, config);
  return reward !== null && awardXp(s, config, task.assignedEmployeeId, `TASK-DONE-${task.id}`,
    reward.rewardKind, reward.amount);
}

/** 최대 레벨에는 다음 문턱이 없다. 상태에 없는 직원 ID는 null을 반환한다. */
export function levelProgress(state: GameState, config: ScenarioConfig, employeeId: string) {
  const emp = state.employees.find((e) => e.id === employeeId);
  if (!emp) return null;
  const xp = emp.xp;
  const def = config.employees.find((e) => e.id === employeeId);
  const level = levelFor(xp);
  const levelFloorXp = rules.xp_thresholds.find((t) => t.level === level)!.cumulative_xp;
  const nextLevelXp = rules.xp_thresholds.find((t) => t.level === level + 1)?.cumulative_xp ?? null;
  return { level, xp, levelFloorXp, nextLevelXp, xpToNext: nextLevelXp === null ? null : nextLevelXp - xp,
    stats: def ? statsFor(def, xp) : null };
}
