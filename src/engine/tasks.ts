import { EngineError, type ScenarioConfig, type Task } from './types';

/** 플레이어가 읽는 업무 대상. 훈련은 담당 직원이 이미 문장의 주어다. */
export function taskSubjectKo(config: ScenarioConfig, task: Task): string | null {
  switch (task.kind) {
    case 'CULTURE': return config.culture?.activities.find((a) => a.id === task.subjectId)?.titleKo ?? null;
    case 'SCOUT': return config.recruitment?.scoutSites.find((s) => s.venueId === task.subjectId)?.titleKo ?? null;
    case 'RECRUIT_QUEST': return config.employees.find((e) => e.id === task.subjectId)?.nameKo ?? null;
    case 'TRAINING': return null;
    case 'EXPORT_PREP':
    case 'FORWARDING_PREP': return task.contractId;
    default: {
      const unknown: never = task.kind;
      throw new EngineError(`알 수 없는 업무 종류입니다 (${unknown}).`);
    }
  }
}

/** 업무 진행량·표시 단위가 같은 기준을 쓰도록 한다. */
export function isDayBasedTask(kind: Task['kind']): boolean {
  switch (kind) {
    case 'CULTURE':
    case 'TRAINING': return true;
    case 'EXPORT_PREP':
    case 'FORWARDING_PREP':
    case 'SCOUT':
    case 'RECRUIT_QUEST': return false;
    default: {
      const unknown: never = kind;
      throw new EngineError(`알 수 없는 업무 종류입니다 (${unknown}).`);
    }
  }
}
