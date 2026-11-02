// 회사 보고서·직원의 직접 경험·인물과 함께한 활동은 서로 다른 기록이다.
import { awardXp } from './growth';
import { EngineError, type CultureActivityDef, type GameState, type ScenarioConfig, type Task } from './types';

const KEY_FIELDS = ['company_id', 'actor_id', 'contact_id', 'activity_id', 'city_id', 'content_revision'] as const;
type CultureKeyFields = Record<typeof KEY_FIELDS[number], string>;

export function cultureKey(template: string, fields: Partial<CultureKeyFields>): string {
  const key = template.replace(/\{([^{}]*)\}/g, (_, field: string) => {
    if (!KEY_FIELDS.includes(field as keyof CultureKeyFields)) throw new EngineError(`알 수 없는 현지 활동 키 자리입니다 (${field}).`);
    const value = fields[field as keyof CultureKeyFields];
    if (value === undefined) throw new EngineError(`현지 활동 키 값이 없습니다 (${field}).`);
    return value;
  });
  if (/[{}]/.test(key)) throw new EngineError('현지 활동 키 템플릿의 괄호가 올바르지 않습니다.');
  return key;
}

export function cultureKeys(config: ScenarioConfig, activity: CultureActivityDef, employeeId: string) {
  const fields = { company_id: config.culture!.companyId, actor_id: employeeId,
    activity_id: activity.id, city_id: activity.cityId, content_revision: activity.topic.contentRevision };
  return {
    companyReport: cultureKey(activity.keyTemplates.companyReport, fields),
    actorExperience: cultureKey(activity.keyTemplates.actorExperience, fields),
    relationship: (contactId: string) => cultureKey(activity.keyTemplates.relationship, { ...fields, contact_id: contactId }),
  };
}

/** 엔진이 완료 상태를 확정한 업무를 tasks 순서대로 기록한다. */
export function recordCultureCompletion(s: GameState, config: ScenarioConfig, task: Task): void {
  const activity = config.culture?.activities.find((a) => a.id === task.subjectId);
  if (!activity || task.kind !== 'CULTURE' || task.status !== 'DONE' || !task.assignedEmployeeId
    || task.completedDay === null || !s.tasks.includes(task)) throw new EngineError('완료한 현지 활동 업무가 필요합니다.');
  const employeeId = task.assignedEmployeeId;
  const keys = cultureKeys(config, activity, employeeId);
  const common = { activityId: activity.id, cityId: activity.cityId, contentRevision: activity.topic.contentRevision };
  const newReport = !s.culture.reports.some((r) => r.key === keys.companyReport);
  if (newReport) s.culture.reports.push({ ...common, key: keys.companyReport, topicId: activity.topic.id,
    sourceContactIds: [...activity.contactIds], reporterEmployeeId: employeeId, taskId: task.id,
    day: task.completedDay, status: 'UNVERIFIED' });
  if (!s.culture.experiences.some((e) => e.key === keys.actorExperience)) {
    s.culture.experiences.push({ ...common, key: keys.actorExperience, employeeId, topicId: activity.topic.id,
      countryCode: config.cities.find((c) => c.id === activity.cityId)!.countryCode,
      completedTaskId: task.id, verifiedDay: task.completedDay });
  }
  for (const contactId of activity.contactIds) {
    const key = keys.relationship(contactId);
    if (!s.culture.relationEvents.some((r) => r.key === key)) s.culture.relationEvents.push({
      ...common, key, employeeId, contactId, taskId: task.id, day: task.completedDay, kind: 'SHARED_ACTIVITY',
    });
  }
  const name = config.employees.find((e) => e.id === employeeId)!.nameKo;
  // 현재 P0 인물 제목은 ‘역할 이름’ 형태다. 로그에서는 마지막 이름만 쓴다.
  const contacts = activity.contactIds.map((id) => config.culture!.contacts.find((c) => c.id === id)!.nameKo.trim().split(/\s+/).at(-1)!);
  const lastCode = contacts.at(-1)?.at(-1)?.charCodeAt(0) ?? 0;
  const particle = lastCode >= 0xAC00 && lastCode <= 0xD7A3 && (lastCode - 0xAC00) % 28 !== 0 ? '과' : '와';
  s.log.push({ day: s.day, textKo: `${name}: ${activity.titleKo} 완료 — 회사 기록 ${newReport ? '새로 1건' : '이미 있음'} · 직접 경험 · ${contacts.join('·')}${particle} 함께한 활동` });
  if (config.growth) awardXp(s, config, employeeId, `CULTURE-FIRST-${activity.id}`, 'CULTURE_FIRST_XP', config.growth.taskCompletionXp);
}

/** 기록이 없는 고용 직원·인물 쌍도 포함한다. 반환값도 사본이어서 화면 편집이 상태에 스며들지 않는다. */
export function cultureBook(state: GameState, config: ScenarioConfig) {
  const contacts = config.culture?.contacts ?? [];
  return structuredClone({
    reports: state.culture.reports.map((report) => ({ ...report,
      reportKo: config.culture?.activities.find((a) => a.id === report.activityId)?.reportKo ?? null })),
    employees: state.employees.filter((e) => e.employmentStatus === 'employed').map((employee) => ({
      employeeId: employee.id,
      experiences: state.culture.experiences.filter((e) => e.employeeId === employee.id),
    })),
    relations: state.employees.filter((e) => e.employmentStatus === 'employed').flatMap((employee) => contacts.map((contact) => ({
      employeeId: employee.id, contactId: contact.id,
      events: state.culture.relationEvents.filter((r) => r.employeeId === employee.id && r.contactId === contact.id),
    }))),
  });
}

/** 거래 이행은 계약에서만 읽는다. 인도 후 수금 대기 중인 계약도 납기 실적에 포함한다. */
export function counterpartyRecord(state: GameState, partyId: string) {
  const contracts = state.contracts.filter((c) => c.customerId === partyId || c.supplierId === partyId);
  return {
    inProgress: contracts.filter((c) => c.status !== 'CANCELLED' && c.deliveredDay === null && c.status !== 'COMPLETED').length,
    onTime: contracts.filter((c) => c.status !== 'CANCELLED' && c.deliveredDay !== null && c.deliveredDay <= c.deliveryDeadlineDay).length,
    late: contracts.filter((c) => c.status !== 'CANCELLED' && c.deliveredDay !== null && c.deliveredDay > c.deliveryDeadlineDay).length,
    cancelled: contracts.filter((c) => c.status === 'CANCELLED').length,
  };
}
