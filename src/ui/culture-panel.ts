// 판정·수치·문장은 엔진 읽기 함수와 자료에서 받고, 화면은 문구와 HTML만 만든다.
import venues from '../../data/venues.json';
import { cityName } from '../engine/catalog';
import { cultureBook } from '../engine/culture';
import { isAvailableFromToday } from '../engine/employees';
import { planState } from '../engine/engine';
import { formatMoney } from '../engine/money';
import { CULTURE_UNCHANGED_KO } from '../engine/previews-lazy';
import { culturePreview } from '../engine/previews-lazy';
import { runningTaskOf } from '../engine/reservations';
import { taskSubjectKo } from '../engine/tasks';
import type { Command, CommandResult, CultureActivityDef, GameState, ScenarioConfig, Task } from '../engine/types';
import { taskName } from './card';
import { crewStatusKo, taskSchedule } from './crew-status';
import { esc } from './html';
import type { initialUiState } from './session';

type CultureUi = Pick<ReturnType<typeof initialUiState>, 'cultureOpen' | 'cultureActivityId' | 'cultureEmployeeId'
  | 'cultureBookOpen' | 'cultureSeenDay' | 'cultureShowFromDay'>;
type Book = ReturnType<typeof cultureBook>;
type Report = Book['reports'][number];
type Preview = ReturnType<typeof culturePreview>;
type Status = (slot: string, text: string) => string;

import { CULTURE_KO as TAB_KO, cultureResultTasks } from './culture';

export const CULTURE_PANEL_KO = {
  closeLocal: (city: string) => `${city} 현지 닫기`,
  book: (city: string) => `${city} 기록장`,
  bookToggle: (city: string, open: boolean) => `${city} 기록장 ${open ? '닫기' : '열기'}`,
  intro: '열어 보기만 하면 시간·돈이 들지 않습니다. 날짜는 위쪽 ‘하루 진행 ▶’으로만 넘어갑니다.',
  venues: {
    VEN_TRADE: ['견적·계약은 ‘거래·계약’ 칸의 견적판에서 합니다.', '견적·계약은 ‘거래·계약’ 칸, 동료 현장 조사는 ‘동료’ 칸에서 합니다.'],
    VEN_PORT: ['운송편 예약은 각 계약 카드에서 합니다.', '운송편 예약은 각 계약 카드, 동료 현장 조사는 ‘동료’ 칸에서 합니다.'],
    VEN_LOUNGE: ['이번 판에서는 여기서 할 일이 없습니다.', '동료 현장 조사는 ‘동료’ 칸에서 합니다.'],
    VEN_CULTURE: ['직원 1명을 보내 만난 사람의 말과 그 말이 닿는 범위를 네 칸으로 기록합니다. 아래에서 고릅니다.'],
    VEN_FINANCE: ['주식 거래와 상장(회사 주식을 시장에 내놓기)은 이번 판에 없습니다. 현금은 위쪽 막대와 ‘경영 보고’에서 봅니다.'],
  } as Record<string, string[]>,
  frame: '현지 활동 기록은 네 칸으로 남습니다.',
  fields: [
    ['알게 된 점', '누가 무엇을 말했나', 'findingKo'],
    ['범위', '몇 명·어디·언제 확인했나', 'scopeKo'],
    ['이 기록이 말하지 않는 것', '넓혀 읽으면 안 되는 것', 'notClaimedKo'],
    ['아직 모르는 것', '다음에 확인할 것', 'openQuestionKo'],
  ] as const,
  limit: '넓혀 읽지 않기',
  chooseActivity: '① 활동 고르기', activityGroup: '현지 활동 고르기',
  activityFacts: (cost: string, days: number, contacts: string) => `${cost} · 기간 ${days}일 · 만나는 사람: ${contacts}`,
  topic: (title: string) => `기록 주제: ${title}`,
  inQueue: (employee: string) => `오늘 할 일에 넣음 — ${employee}`,
  chooseEmployee: '② 갈 직원 고르기',
  employeeHint: (city: string) => `${city}에 있고 오늘 쉬는 직원만 고를 수 있습니다`,
  starts: (day: number) => `${day}일부터 근무`,
  preview: (employee: string, title: string) => `미리 보기 — ${employee} · ${title}`,
  costLabel: '이 활동에 쓰는 것',
  cost: (days: number, cost: string) => `직원 1명의 ${days === 1 ? '하루' : `${days}일`} 업무 · 원화 ${cost}`,
  busy: (employee: string, from: number | null, until: number | null) => `${employee}: ${from === until ? `오늘(${from}일) 하루` : `${from}~${until}일`} 동안 다른 업무를 맡을 수 없습니다.`,
  waiting: (subject: string, name: string, left: number, departure: number | null) => `⚠ 기다리는 업무: ${subject ? `${subject} ` : ''}${name} ${left}pt${departure === null ? '' : ` (${departure}일 출항편 예약됨)`} — 아직 아무에게도 배정하지 않았습니다.`,
  otherEmployees: (city: string, names: string[]) => `오늘 쉬는 다른 ${city} 직원: ${names.length ? names.join(' · ') : '없음. 이 활동을 하면 오늘 이 업무를 맡을 사람이 없습니다.'}`,
  finish: (day: number | null) => `끝나는 날: ${day}일`,
  campaignWarning: (days: number) => `⚠ 캠페인 마지막 날(${days}일)까지 끝나지 않습니다. 기록·경험치는 생기지 않고 활동비는 나갑니다.`,
  funds: (before: string, after: string, planned: boolean) => `활동에 쓸 수 있는 원화: 지금 ${before} → 활동 뒤 ${after}${planned ? ' (오늘 할 일 반영)' : ''}`,
  runway: (before: string, after: string) => `원화 급여 지급 가능일: 지금 ${before} → 활동하면 ${after}`,
  runwayEnd: (days: number) => `${days}일(캠페인 끝)까지`,
  runwayUnpaid: '없음', runwayDay: (day: number) => `${day}일까지`,
  wages: '급여는 활동비와 별도로 평소대로 지급합니다.',
  unpaid: (day: number, already: boolean) => `⚠ ${already ? '지금도' : '이 활동비를 내면'} 오늘(${day}일) 급여 일부가 미지급으로 남습니다.`,
  newRecords: (xp: boolean) => xp ? '새로 생길 기록과 경험치' : '새로 생길 기록',
  companyNew: (topic: string) => `회사 보고서(처음 생김) — ${topic}`,
  companyExists: '회사 보고서는 이미 있어 새로 생기지 않음',
  experience: (employee: string) => `${employee}의 직접 경험 기록`,
  together: (pairs: string[]) => `함께한 활동: ${pairs.join(' · ')}`,
  xp: (amount: number) => `첫 완료 경험치 +${amount}`,
  unchanged: '바뀌지 않는 것', unchangedResult: '바뀌지 않은 것',
  denied: (reason: string) => `⚠ 시작할 수 없음: ${reason}`,
  noNewRecords: '시작할 수 없으므로 새로 생기는 기록이 없습니다.',
  queue: '오늘 할 일에 넣기', queued: '현지 활동 예정',
  queueHint: '넣기만 해서는 시간이 흐르지 않습니다. 활동비는 ‘하루 진행’ 때 나갑니다.',
  unqueueHint: '빼려면 ‘오늘 할 일’에서 ‘빼기’를 누르세요.',
  recordDate: (day: number | null, activity: string, newReport: boolean) => `${day}일 ${newReport ? '기록' : '활동'} · ${activity}`,
  source: (names: string[]) => `출처 ${names.length}명: ${names.join(', ')}`,
  unverified: '다른 출처로 아직 확인하지 않은 기록',
  reporter: (employee: string) => `기록한 직원 ${employee}`,
  existingReport: (day: number, employee: string) => `회사 보고서는 ${day}일에 이미 있습니다. 네 칸은 그대로입니다. · 이번 활동 직원 ${employee}`,
  spent: '쓴 것',
  spentText: (employee: string, from: number | null, until: number | null, cost: string) => `${employee}의 ${from === until ? `하루 업무(${from}일)` : `${from}~${until}일 업무`} · 원화 ${cost}`,
  bookHint: '회사 보고서·직원의 직접 경험 기록·함께한 활동은 서로 다른 기록입니다.',
  reports: '회사 보고서', emptyReports: '회사 보고서가 없습니다. 현지 활동을 마치면 위의 네 칸으로 남습니다.',
  experiences: '직원의 직접 경험 기록', experienceHint: '그 직원이 직접 듣고 본 기록입니다. 기록 자체는 능력·처리량을 바꾸지 않습니다.',
  emptyExperiences: '직접 경험 기록이 없습니다.',
  relations: '함께한 활동', relationHint: '점수가 아니라 누가 누구와 무엇을 함께했는지 적은 기록입니다.',
  emptyRelations: '함께한 활동이 없습니다.', contacts: '만난 사람', emptyContacts: '만난 사람이 없습니다.',
  experienceEntry: (employee: string, activity: string, day: number) => `${employee} — ${activity} (${day}일)`,
  relationEntry: (employee: string, contact: string, activity: string, day: number) => `${employee} — ${contact} · ${activity} (${day}일)`,
  trust: '거래 신뢰는 계약을 약속대로 지켰는지에서만 나옵니다. 현지 활동은 이것을 바꾸지 않습니다.',
};

const CULTURE_KO = { ...TAB_KO, ...CULTURE_PANEL_KO };

const employeeName = (config: ScenarioConfig, id: string | null) => config.employees.find((e) => e.id === id)?.nameKo ?? '';
const contactName = (config: ScenarioConfig, id: string) => config.culture?.contacts.find((c) => c.id === id)?.nameKo ?? '';
const localVenues = (config: ScenarioConfig) => venues.items.filter((v) => v.city_id === config.homeCityId);
const newest = <T>(items: T[], day: (item: T) => number): T[] => [...items].reverse().sort((a, b) => day(b) - day(a));

export function cultureVenues(config: ScenarioConfig): string {
  if (!config.culture) return '';
  return `<dl class="local-venues">${localVenues(config).map((v) => {
    const scout = config.recruitment?.scoutSites.some((s) => s.venueId === v.id) ?? false;
    const texts = CULTURE_KO.venues[v.id]!;
    return `<div><dt>${esc(v.title_ko)}</dt><dd>${esc(texts[scout ? 1 : 0] ?? texts[0]!)}</dd></div>`;
  }).join('')}</dl>`;
}

function recordFour(report: Report): string {
  if (!report.reportKo) return '';
  return `<ol class="rec4">${CULTURE_KO.fields.map(([label, hint, field]) => `<li class="rec-field"${field === 'notClaimedKo' ? ' data-limit="true"' : ''}><div class="rec-label"><b>${label}</b><small>${hint}</small>${field === 'notClaimedKo' ? `<small class="rec-limit">${CULTURE_KO.limit}</small>` : ''}</div><p>${esc(report.reportKo![field])}</p></li>`).join('')}</ol>`;
}

/** 결과와 기록장은 같은 네 칸을 쓰고, 업무 공백·비용은 결과에서만 보여 준다. */
function recordCard(report: Report, activity: CultureActivityDef, config: ScenarioConfig, task?: Task): string {
  const employee = employeeName(config, task ? task.assignedEmployeeId : report.reporterEmployeeId);
  const headingId = task ? `culture-result-h-${task.id}` : `culture-report-h-${report.taskId}`;
  const sources = CULTURE_KO.source(report.sourceContactIds.map((id) => contactName(config, id)));
  const level = task ? 'h3' : 'h5';
  return `<article class="${task ? 'cul-result' : 'cul-report'}" id="${esc(task ? `culture-result-${task.id}` : `culture-report-${report.taskId}`)}" aria-labelledby="${esc(headingId)}"><${level} id="${esc(headingId)}" tabindex="-1">${esc(activity.topic.titleKo)}${task ? ` <small>${esc(CULTURE_KO.recordDate(task.completedDay, activity.titleKo, report.taskId === task.id))}</small>` : ''}</${level}>
    ${task && report.taskId !== task.id ? `<p class="rec-meta">${esc(CULTURE_KO.existingReport(report.day, employee))}</p>` : ''}
    <p class="rec-meta">${task ? '' : `${report.day}일 · `}${esc(CULTURE_KO.reporter(employeeName(config, report.reporterEmployeeId)))} · ${esc(sources)}${report.status === 'UNVERIFIED' ? ` · ${CULTURE_KO.unverified}` : ''}</p>
    ${recordFour(report)}${task ? `<p class="spent"><b>${CULTURE_KO.spent}</b> ${esc(CULTURE_KO.spentText(employee, task.startedDay, task.completedDay, formatMoney(activity.currency, activity.costMinor)))}</p><p class="unchanged"><b>${CULTURE_KO.unchangedResult}</b> ${CULTURE_UNCHANGED_KO}</p>` : ''}</article>`;
}

export function cultureResults(state: GameState, config: ScenarioConfig, fromDay: number): string {
  if (!config.culture) return '';
  const book = cultureBook(state, config);
  return cultureResultTasks(state, config, fromDay).map((task) => {
    const activity = config.culture!.activities.find((a) => a.id === task.subjectId);
    const report = book.reports.find((r) => r.activityId === task.subjectId);
    return activity && report ? recordCard(report, activity, config, task) : '';
  }).join('');
}

export function cultureNotebook(state: GameState, config: ScenarioConfig, open: boolean): string {
  if (!config.culture) return '';
  const city = cityName(config, config.homeCityId);
  const book = cultureBook(state, config);
  const reports = newest(book.reports, (r) => r.day);
  const experiences = newest(book.employees.flatMap((e) => e.experiences), (e) => e.verifiedDay);
  const events = newest(book.relations.flatMap((r) => r.events), (e) => e.day);
  const met = new Set(events.map((e) => e.contactId));
  const activityTitle = (id: string) => config.culture!.activities.find((a) => a.id === id)?.titleKo ?? '';
  return `<section class="culture-book"><h3 id="culture-book-h" tabindex="-1">${esc(CULTURE_KO.book(city))} <small>${CULTURE_KO.bookHint}</small></h3><button data-action="culture-book" aria-expanded="${open}"${open ? ' aria-controls="culture-book-body"' : ''}>${esc(CULTURE_KO.bookToggle(city, open))}</button>${open ? `<div id="culture-book-body">
    <h4>${CULTURE_KO.reports}</h4>${reports.map((r) => recordCard(r, config.culture!.activities.find((a) => a.id === r.activityId)!, config)).join('') || `<p>${CULTURE_KO.emptyReports}</p>`}
    <h4>${CULTURE_KO.experiences}</h4><p class="small muted">${CULTURE_KO.experienceHint}</p>${experiences.length ? `<ul>${experiences.map((e) => `<li>${esc(CULTURE_KO.experienceEntry(employeeName(config, e.employeeId), activityTitle(e.activityId), e.verifiedDay))}</li>`).join('')}</ul>` : `<p>${CULTURE_KO.emptyExperiences}</p>`}
    <h4>${CULTURE_KO.relations}</h4><p class="small muted">${CULTURE_KO.relationHint}</p>${events.length ? `<ul>${events.map((e) => `<li>${esc(CULTURE_KO.relationEntry(employeeName(config, e.employeeId), contactName(config, e.contactId), activityTitle(e.activityId), e.day))}</li>`).join('')}</ul>` : `<p>${CULTURE_KO.emptyRelations}</p>`}
    <h4>${CULTURE_KO.contacts}</h4>${met.size ? `<ul>${config.culture.contacts.filter((c) => met.has(c.id)).map((c) => `<li>${esc(c.nameKo)} — ${esc(c.informationScopeKo)}</li>`).join('')}</ul>` : `<p>${CULTURE_KO.emptyContacts}</p>`}
    <p class="book-trust">${CULTURE_KO.trust}</p></div>` : ''}</section>`;
}

function previewHtml(p: Preview, state: GameState, config: ScenarioConfig, activity: CultureActivityDef, employee: string, otherPending: boolean): string {
  const unchanged = `<p class="unchanged"><b>${CULTURE_KO.unchanged}</b> ${esc(p.unchangedKo)}</p>`;
  const title = `<h4 id="culture-pv-h">${esc(CULTURE_KO.preview(employee, activity.titleKo))}</h4>`;
  if (!p.allowed) return `<div id="culture-preview">${title}<p class="reason">${esc(CULTURE_KO.denied(p.reasonKo!))}</p><p>${CULTURE_KO.noNewRecords}</p>${unchanged}</div>`;
  const money = (minor: number) => formatMoney(p.cost.currency, minor);
  const beyondCampaign = p.busyUntilDay !== null && p.busyUntilDay > config.campaignDays;
  const runway = (day: number | null) => day === null ? CULTURE_KO.runwayEnd(config.campaignDays)
    : day < state.day ? CULTURE_KO.runwayUnpaid : CULTURE_KO.runwayDay(day);
  const alreadyUnpaid = p.payrollRunwayBefore !== null && p.payrollRunwayBefore < state.day;
  const unpaid = p.payrollRunwayAfter !== null && p.payrollRunwayAfter < state.day;
  const records = [p.newRecords.companyReport === 'NEW' ? CULTURE_KO.companyNew(activity.topic.titleKo) : CULTURE_KO.companyExists,
    ...(p.newRecords.actorExperience ? [CULTURE_KO.experience(employee)] : []),
    ...(p.newRecords.relationContactIds.length ? [CULTURE_KO.together(p.newRecords.relationContactIds.map((id) => `${employee} — ${contactName(config, id)}`))] : []),
    ...(p.newRecords.firstCompletionXp ? [CULTURE_KO.xp(p.newRecords.firstCompletionXp)] : [])];
  return `<div id="culture-preview">${title}
    <p class="culture-cost"><b>${CULTURE_KO.costLabel}:</b> ${esc(CULTURE_KO.cost(p.durationDays, money(p.cost.minor)))}</p>
    <p>${esc(CULTURE_KO.busy(employee, p.busyFromDay, p.busyUntilDay))}</p>
    ${p.waitingTasks.length ? `${p.waitingTasks.map(({task, reservedDepartureDay}) => `<p class="reason">${esc(CULTURE_KO.waiting(taskSubjectKo(config, task) ?? '', taskName(task.kind), task.requiredWorkUnits - task.progressWorkUnits, reservedDepartureDay))}</p>`).join('')}<p>${esc(CULTURE_KO.otherEmployees(cityName(config, activity.cityId), p.otherFreeLocalEmployeeIds.map((id) => employeeName(config, id))))}</p>` : ''}
    ${beyondCampaign ? `<p class="reason">${esc(CULTURE_KO.campaignWarning(config.campaignDays))}</p>` : p.durationDays > 1 ? `<p>${esc(CULTURE_KO.finish(p.busyUntilDay))}</p>` : ''}
    <p>${esc(CULTURE_KO.funds(money(p.availableBeforeMinor), money(p.availableAfterMinor), otherPending))}</p>
    <p>${esc(CULTURE_KO.runway(runway(p.payrollRunwayBefore), runway(p.payrollRunwayAfter)))}${unpaid ? '' : `<br>${CULTURE_KO.wages}`}</p>
    ${unpaid ? `<p class="reason">${esc(CULTURE_KO.unpaid(state.day, alreadyUnpaid))}</p>` : ''}
    ${beyondCampaign ? '' : `<div class="culture-new"><p>${CULTURE_KO.newRecords(p.newRecords.firstCompletionXp > 0)}</p><ul>${records.map((text) => `<li>${esc(text)}</li>`).join('')}</ul></div>`}
    ${unchanged}</div>`;
}

/** 대기 중인 쌍은 그 명령 하나만 빼고 비교한다. 그 밖의 예약과 비용은 계획 상태에 남긴다. */
export function culturePanel(state: GameState, view: GameState, pending: Command[], config: ScenarioConfig, ui: CultureUi,
  status: Status = (slot, text) => `<span class="pill" id="status-${esc(slot)}" tabindex="-1">${text}</span>`): string {
  if (!config.culture || !ui.cultureOpen) return '';
  const city = cityName(config, config.homeCityId);
  const cultureVenue = venues.items.find((v) => v.id === 'VEN_CULTURE')!;
  const activity = config.culture.activities.find((a) => a.id === ui.cultureActivityId);
  const employee = view.employees.find((e) => e.id === ui.cultureEmployeeId);
  const pair = pending.find((cmd) => cmd.type === 'START_CULTURE_ACTIVITY' && cmd.activityId === activity?.id && cmd.employeeId === employee?.id);
  const previewState = pair ? planState(state, config, pending.filter((cmd) => cmd !== pair)).state : view;
  const p = activity && employee ? culturePreview(previewState, config, activity.id, employee.id) : null;
  const activities = config.culture.activities.map((a) => {
    const queued = pending.find((cmd) => cmd.type === 'START_CULTURE_ACTIVITY' && cmd.activityId === a.id);
    return `<button data-action="culture-act" data-activity="${esc(a.id)}" aria-pressed="${a.id === ui.cultureActivityId}"><b>${esc(a.titleKo)}</b><small>${esc(CULTURE_KO.activityFacts(formatMoney(a.currency, a.costMinor), a.durationDays, a.contactIds.map((id) => contactName(config, id)).join(' · ')))}</small><small>${esc(CULTURE_KO.topic(a.topic.titleKo))}</small>${queued?.type === 'START_CULTURE_ACTIVITY' ? `<small>${esc(CULTURE_KO.inQueue(employeeName(config, queued.employeeId)))}</small>` : ''}</button>`;
  }).join('');
  const employees = activity ? view.employees.filter((e) => e.employmentStatus === 'employed' && e.locationCityId === activity.cityId).map((e) => {
    const task = runningTaskOf(view, e.id);
    const queued = task?.kind === 'CULTURE' && task.subjectId === activity.id && pending.some((cmd) => cmd.type === 'START_CULTURE_ACTIVITY' && cmd.activityId === activity.id && cmd.employeeId === e.id);
    const available = isAvailableFromToday(view, e.id);
    const label = !available ? CULTURE_KO.starts(e.availableFromDay) : `${crewStatusKo(task)}${task && !queued ? ` — ${taskSchedule(task, config)}` : ''}`;
    return `<button id="culture-emp-${esc(e.id)}" data-action="culture-emp" data-activity="${esc(activity.id)}" data-emp="${esc(e.id)}" aria-pressed="${ui.cultureEmployeeId === e.id}"${available && (!task || queued) ? '' : ' disabled'}>${esc(employeeName(config, e.id))} · ${esc(label)}</button>`;
  }).join('') : '';
  const slot = activity && employee && p ? `<div id="culture-slot" data-action-slot="culture-${esc(activity.id)}-${esc(employee.id)}">${pair ? `${status(`culture-${activity.id}-${employee.id}`, CULTURE_KO.queued)}<p class="small muted">${CULTURE_KO.unqueueHint}</p>` : `<button class="primary" data-action="culture-queue" data-activity="${esc(activity.id)}" data-emp="${esc(employee.id)}"${p.allowed ? '' : ' disabled'}>${CULTURE_KO.queue}</button>${p.allowed ? `<p class="small muted">${CULTURE_KO.queueHint}</p>` : ''}`}</div>` : '';
  return `<section class="panel local" id="local" aria-labelledby="local-h"><div class="local-head"><h2 id="local-h" tabindex="-1">${esc(CULTURE_KO.local(city))}</h2><button data-action="culture-close" data-where="head">${CULTURE_KO.close}</button></div><div id="local-body">
    ${cultureResults(state, config, ui.cultureShowFromDay ?? state.day - 1)}
    <p class="local-intro">${CULTURE_KO.intro}</p>${cultureVenues(config)}
    <section class="culture-activity" aria-labelledby="culture-h"><h3 id="culture-h" tabindex="-1">${esc(cultureVenue.title_ko)}</h3><div class="culture-frame"><p>${CULTURE_KO.frame}</p><ol>${CULTURE_KO.fields.map(([label, hint]) => `<li>${label} — ${hint}</li>`).join('')}</ol></div>
    <h4>${CULTURE_KO.chooseActivity}</h4><div class="culture-choices" role="group" aria-label="${CULTURE_KO.activityGroup}">${activities}</div>
    ${activity ? `<h4 id="culture-emp-h" tabindex="-1">${CULTURE_KO.chooseEmployee}</h4><p class="small muted">${esc(CULTURE_KO.employeeHint(cityName(config, activity.cityId)))}</p><div class="culture-employees" id="culture-employees">${employees}</div>` : ''}
    ${p && activity && employee ? previewHtml(p, state, config, activity, employeeName(config, employee.id), pending.some((cmd) => cmd !== pair)) : ''}${slot}</section>
    ${cultureNotebook(state, config, ui.cultureBookOpen)}<button class="local-end" data-action="culture-close" data-where="end">${esc(CULTURE_KO.closeLocal(city))}</button></div></section>`;
}

