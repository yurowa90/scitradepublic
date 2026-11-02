// 저장된 현지 활동 근거를 정의·완료 업무·장부와 양방향으로 대조한다.
import { cultureKey, cultureKeys } from './culture';
import type { GameState, ScenarioConfig } from './types';

/** closing: 하루 마감 중 검사(오늘 진행한 1일이 이미 더해진 상태). 불러오기는 false. */
export function cultureProblems(s: GameState, config: ScenarioConfig, closing = false): string[] {
  const problems: string[] = [];
  const tasks = s.tasks.filter((t) => t.kind === 'CULTURE');
  const expenses = s.ledger.entries.filter((e) => e.lines.some((l) => l.account === 'CULTURE_EXPENSE'));
  const { reports, experiences, relationEvents } = s.culture;
  if (!config.culture) {
    if (tasks.length || expenses.length || reports.length || experiences.length || relationEvents.length
      || Object.keys(s.xpAwards).some((key) => key.includes('CULTURE-FIRST-') || key.endsWith('|CULTURE_FIRST_XP'))) {
      problems.push('state.culture: 현지 활동이 꺼진 시나리오에는 기록이 없어야 합니다 (업무·비용·경험치도 금지)');
    }
    return problems;
  }
  const culture = config.culture;
  const check = (ok: boolean, message: string) => { if (!ok) problems.push(message); };
  for (const records of [reports, experiences, relationEvents]) {
    check(new Set(records.map((r) => r.key)).size === records.length, '현지 활동 기록 키 중복');
  }
  const employeeActivities = new Set<string>();
  for (const task of tasks) {
    const activity = culture.activities.find((a) => a.id === task.subjectId);
    check(!!activity, `${task.id}: 현지 활동 정의 없음`);
    if (!activity) continue;
    check(task.status === 'RUNNING' || task.status === 'DONE', `${task.id}: 현지 활동 업무 상태 오류`);
    check(task.cityId === activity.cityId && task.requiredWorkUnits === activity.durationDays && task.contractId === null,
      `${task.id}: 현지 활동 업무 정의 불일치`);
    check(task.assignedEmployeeId !== null && task.startedDay !== null && task.startedDay >= 1
      && task.progressWorkUnits >= 0 && task.progressWorkUnits <= task.requiredWorkUnits,
    `${task.id}: 현지 활동 배정·진행 오류`);
    if (task.status === 'RUNNING') {
      check(task.completedDay === null && task.startedDay !== null && task.startedDay <= s.day
        && task.progressWorkUnits < task.requiredWorkUnits, `${task.id}: 진행 중 현지 활동 날짜·미완료 오류`);
      // 진행 중 업무는 하루에 정확히 1일씩 진행한다. 불러오기 때는 경과일과 같고, 하루 마감 중에는 오늘 1일이 더해져 있다.
      check(task.startedDay !== null && task.progressWorkUnits === s.day - task.startedDay + (closing ? 1 : 0),
        `${task.id}: 진행 중 현지 활동 경과일·진행량 오류`);
    }
    if (task.status === 'DONE') check(task.completedDay !== null && task.startedDay !== null
      && task.completedDay === task.startedDay + activity.durationDays - 1 && task.completedDay <= s.day
      && task.progressWorkUnits === task.requiredWorkUnits, `${task.id}: 현지 활동 완료일·진행 오류`);
    const pair = `${task.assignedEmployeeId}|${activity.id}`;
    if (task.status !== 'ABORTED') {
      check(!employeeActivities.has(pair), `${task.id}: 직원·활동 업무 중복`);
      employeeActivities.add(pair);
    }
    const fees = s.ledger.entries.filter((e) => e.id === `CULTURE-FEE-${task.id}`);
    check(fees.length === 1, `${task.id}: 현지 활동비 중복 또는 누락`);
    const fee = fees[0];
    if (fee) check(fee.currency === activity.currency && fee.day === task.startedDay && fee.contractId === undefined
      && fee.lines.length === 2
      && fee.lines.filter((l) => l.account === 'CULTURE_EXPENSE' && l.amount === activity.costMinor).length === 1
      && fee.lines.filter((l) => l.account === 'CASH' && l.amount === -activity.costMinor).length === 1,
    `${task.id}: 현지 활동비 통화·금액·계정 오류`);
    check(!Object.keys(s.xpAwards).some((k) => k.split('|')[1] === `TASK-DONE-${task.id}`), `${task.id}: 문화 업무 일반 완료 경험치 금지`);
    if (task.status !== 'DONE' || !task.assignedEmployeeId) continue;
    const keys = cultureKeys(config, activity, task.assignedEmployeeId);
    const xpKey = `${task.assignedEmployeeId}|CULTURE-FIRST-${activity.id}|CULTURE_FIRST_XP`;
    if (config.growth && config.employees.find((e) => e.id === task.assignedEmployeeId)?.growth) {
      check(s.xpAwards[xpKey] === true && s.xpAwardAmounts[xpKey] === config.growth.taskCompletionXp,
        `${task.id}: CULTURE-FIRST 경험치 누락·금액 오류`);
    }
    check(experiences.filter((e) => e.key === keys.actorExperience && e.completedTaskId === task.id).length === 1,
      `${task.id}: 직접 경험 누락·중복`);
    check(reports.some((r) => r.key === keys.companyReport), `${task.id}: 회사 보고서 누락`);
    for (const contactId of activity.contactIds) check(relationEvents.filter((r) =>
      r.key === keys.relationship(contactId) && r.taskId === task.id).length === 1, `${task.id}: 함께한 활동 누락·중복`);
  }
  for (const expense of expenses) check(tasks.some((t) => expense.id === `CULTURE-FEE-${t.id}`), `${expense.id}: 현지 활동 업무 없는 비용`);

  // 키는 저장 필드로 재구성하고, 필드 자체도 활동 정의·실제 완료 업무와 대조한다.
  for (const [kind, records] of [['reports', reports], ['experiences', experiences], ['relationEvents', relationEvents]] as const) {
    for (const record of records) {
      const activity = culture.activities.find((a) => a.id === record.activityId);
      check(!!activity, `${record.key}: 기록의 현지 활동 정의 없음`);
      if (!activity) continue;
      const employeeId = 'reporterEmployeeId' in record ? record.reporterEmployeeId : record.employeeId;
      const taskId = 'completedTaskId' in record ? record.completedTaskId : record.taskId;
      const day = 'verifiedDay' in record ? record.verifiedDay : record.day;
      const task = tasks.find((t) => t.id === taskId);
      check(task?.status === 'DONE' && task.subjectId === record.activityId && task.assignedEmployeeId === employeeId
        && task.completedDay === day, `${record.key}: 기록과 완료 업무·담당자·날짜 불일치`);
      check(record.cityId === activity.cityId && record.contentRevision === activity.topic.contentRevision,
        `${record.key}: 기록 도시·내용 판본 불일치`);
      if ('topicId' in record) check(record.topicId === activity.topic.id, `${record.key}: 주제 불일치`);
      if ('countryCode' in record) check(record.countryCode === config.cities.find((c) => c.id === record.cityId)?.countryCode,
        `${record.key}: 경험 국가 불일치`);
      if ('sourceContactIds' in record) check(record.status === 'UNVERIFIED'
        && JSON.stringify(record.sourceContactIds) === JSON.stringify(activity.contactIds), `${record.key}: 보고서 출처·상태 오류`);
      if ('contactId' in record) check(activity.contactIds.includes(record.contactId) && record.kind === 'SHARED_ACTIVITY',
        `${record.key}: 함께한 인물·기록 종류 오류`);
      const template = kind === 'reports' ? activity.keyTemplates.companyReport
        : kind === 'experiences' ? activity.keyTemplates.actorExperience : activity.keyTemplates.relationship;
      const key = cultureKey(template, { company_id: culture.companyId, actor_id: employeeId,
        contact_id: 'contactId' in record ? record.contactId : '', activity_id: record.activityId,
        city_id: record.cityId, content_revision: record.contentRevision });
      check(record.key === key, `${record.key}: 다시 만든 기록 키와 다름`);
    }
  }
  for (const key of new Set([...Object.keys(s.xpAwards), ...Object.keys(s.xpAwardAmounts)])) {
    const [employeeId, eventId, kind] = key.split('|');
    if (!eventId?.startsWith('CULTURE-FIRST-') && kind !== 'CULTURE_FIRST_XP') continue;
    check(kind === 'CULTURE_FIRST_XP' && !!config.growth && s.xpAwardAmounts[key] === config.growth.taskCompletionXp
      && tasks.some((t) => t.status === 'DONE' && t.assignedEmployeeId === employeeId && eventId === `CULTURE-FIRST-${t.subjectId}`),
    `${key}: CULTURE-FIRST 경험치 근거 오류`);
  }
  return problems;
}
