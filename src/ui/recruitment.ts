// 영입 화면의 읽기 전용 정보. 경제 상태와 명령 허용 여부는 엔진에서 가져온다.
import characters from '../../data/characters.json';
import venues from '../../data/venues.json';
import { planState } from '../engine/engine';
import { payrollRunwayDay } from '../engine/previews';
import { payrollRunwayKo } from './growth';
import { cityName } from '../engine/catalog';
import { employedDefs } from '../engine/employees';
import { formatMoney } from '../engine/money';
import { contractProgress } from '../engine/progress';
import { fundsPosition, runningTaskOf } from '../engine/reservations';
import type { CandidateState, Command, CommandResult, EmployeeDef, GameState, ScenarioConfig, Task } from '../engine/types';
import { crewCard, roleBadge } from './card';
import { characterSprite } from './assets';

import { levelProgress } from '../engine/growth';
import { crewStatusKo, taskSchedule } from './crew-status';
export { taskSchedule } from './crew-status';
import { esc } from './html';
import { hiringOutlook } from '../engine/readers';
import { constraintLabel } from './ops-labels';
export const venueTitle = (id: string) => venues.items.find((v) => v.id === id)?.title_ko ?? id;
export const species = (id: string) => characters.items.find((c) => c.id === id)?.species_ko ?? '';

/** 대기 명령을 반영한 planState도 같은 기록 구조를 사용한다. */
export function batchUnlocked(state: GameState): boolean {
  const applied = Object.values(state.processedCommands).filter((r) => r.status === 'APPLIED' && r.day <= state.day);
  return applied.some((r) => r.type === 'ASSIGN_TASK') && applied.some((r) => r.type === 'BOOK_SAILING');
}

export function candidateLabel(s: GameState, c: CandidateState, config?: ScenarioConfig): string {
  const t = s.tasks.find((t) => t.id === c.questTaskId);
  switch (c.stage) {
    case 'UNDISCOVERED': return '미발견';
    case 'DISCOVERED': return '발견';
    case 'QUEST_RUNNING': return `의뢰 진행 중 ${t?.progressWorkUnits ?? 0}/${t?.requiredWorkUnits ?? config?.recruitment?.questWorkUnits ?? 0}pt`;
    case 'INTERVIEW_READY': return '면담 가능';
    case 'HIRED': {
      const e = s.employees.find((e) => e.id === c.employeeId);
      // 고용은 하루 진행 때 확정되고 다음 날부터 근무한다. 근무 시작일이 아직 오지 않았다면 오늘 할 일에 들어 있는 상태다.
      return e && e.availableFromDay > s.day ? `고용 예정 — ${e.availableFromDay}일부터 근무` : '고용됨';
    }
  }
}

const beforeInterview = (c: CandidateState) => c.stage === 'DISCOVERED' || c.stage === 'QUEST_RUNNING';
/** 영입 의뢰를 넣기 전에도 고용 비용을 알 수 있게 한다. 면담은 남은 기간 급여·처리량 변화까지 확인하는 단계로 남는다. */
const signingFeeRule = (e: EmployeeDef, c: CandidateState, config: ScenarioConfig) => {
  if (!beforeInterview(c)) return '';
  const days = config.recruitment?.signingFeeWageDays ?? 0;
  return `<p>고용하면 계약금 ${formatMoney('KRW', days * e.salaryPerDayMinor)}(일급 ${formatMoney('KRW', e.salaryPerDayMinor)} × ${days}일)을 한 번 냅니다. 고용 여부는 면담 뒤에 정합니다.</p>`;
};

export type CrewFilter = 'all' | 'free' | 'busy' | 'candidate';

/** 카드와 운영표가 동일한 목록을 사용한다. 미발견 후보는 모든 필터에서 제외한다. */
export function crewEntries(s: GameState, config: ScenarioConfig, filter: CrewFilter, facets: { role?: string | null; attribute?: string | null } = {}) {
  const workingIds = new Set(employedDefs(s, config).map((e) => e.id));
  return config.employees.flatMap((def) => {
    const hired = workingIds.has(def.id);
    const candidate = hired ? undefined : s.recruitment.candidates.find((c) => c.employeeId === def.id && c.stage !== 'UNDISCOVERED');
    const task = runningTaskOf(s, def.id);
    const visible = filter === 'candidate' ? Boolean(candidate)
      : filter === 'all' ? hired || Boolean(candidate)
      : hired && ((filter === 'busy') === Boolean(task));
    return visible && (!facets.role || def.role === facets.role)
      && (!facets.attribute || (def.character.attribute ?? 'none') === facets.attribute) ? [{ def, candidate, task }] : [];
  });
}

/** 표시용 산술만 수행하며 비용 지출·허용 판정·상태 저장은 하지 않는다. */
export function interviewPreview(s: GameState, config: ScenarioConfig, e: EmployeeDef) {
  const blockers = s.contracts.flatMap((c) => contractProgress(s, config, c).blockers);
  return {
    signingFee: e.salaryPerDayMinor * (config.recruitment?.signingFeeWageDays ?? 0),
    dailyWage: e.salaryPerDayMinor,
    remainingWages: e.salaryPerDayMinor * Math.max(0, config.campaignDays - s.day),
    throughput: e.workUnitsPerDay,
    availableKrw: fundsPosition(s, config, 'KRW').available,
    unassigned: blockers.filter((b) => b.code === 'TASK_UNASSIGNED').length,
    willMiss: blockers.filter((b) => b.code === 'TASK_WILL_MISS_SAILING').length,
  };
}

export function interviewBlock(s: GameState, config: ScenarioConfig, e: EmployeeDef, check: CommandResult, expanded = true, queuedHire = '', state = s): string {
  const p = interviewPreview(s, config, e);
  const won = (n: number) => formatMoney('KRW', n);
  const runway = (state:GameState) => payrollRunwayKo(payrollRunwayDay(state,config),s.day,config.campaignDays);
  let afterHire = '';
  if (queuedHire) {
    afterHire = `<p class="hire-after">원화 급여 지급 가능일: ${runway(s)} (오늘 할 일의 고용 반영)</p>`;
  } else if (check.status === 'APPLIED') {
    let id = `PREVIEW-HIRE-AFTER-${e.id}`;
    while (s.processedCommands[id]) id += '-';
    const after = planState(s,config,[{id,type:'HIRE_CANDIDATE',candidateId:e.id}]).state;
    afterHire = `<p class="hire-after">고용하면 원화 사용 가능액: 지금 ${won(fundsPosition(s,config,'KRW').available)} → 고용 뒤 ${won(fundsPosition(after,config,'KRW').available)}</p>
      <p class="hire-after">원화 급여 지급 가능일: 지금 ${runway(s)} → 고용하면 ${runway(after)}</p>`;
  }
  const outlook = config.operations && !queuedHire ? hiringOutlook(state, config, e.id) : null;
  const names = outlook?.bottleneck.binding.after.map(constraintLabel).join('·');
  const extra = outlook ? `<ul class="hiring-outlook"><li>이 직원 하루 일급 ${won(outlook.wageKrwPerDay)} — 일주일이면 USD 약 ${formatMoney('USD', outlook.wageUsdLotsPerWeek! * config.operations!.fx.lotUsdMinor)} 환전</li><li>최근 4묶음 작업 견적 ${outlook.recentHandlingOfferedPt}pt / 받은 ${outlook.recentHandlingAcceptedPt}pt</li><li>작업 포함 주선 1건 기여이익 ${formatMoney('USD', outlook.bottleneck.contributionPerJobMinor)}</li><li>다음 주 받을 수 있는 작업 포함 주선: 지금 ${outlook.bottleneck.usableBefore}건 → 고용 뒤 ${outlook.bottleneck.usableAfter}건(가장 좁은 곳: ${names})</li>${outlook.bottleneck.extraJobsPerWeek === 0 ? `<li>이 직원을 뽑아도 ${names}에 막혀 더 받을 수 없습니다</li>` : ''}</ul>` : '';
  return `<div class="interview" id="interview-${esc(e.id)}" role="region" aria-labelledby="interview-h-${esc(e.id)}" ${expanded ? '' : 'hidden'}>
    <h4 id="interview-h-${esc(e.id)}">면담 — ${esc(e.nameKo)}</h4><dl class="interview-facts">
    <div><dt>계약금 (일급×${config.recruitment?.signingFeeWageDays})</dt><dd>${won(p.signingFee)}</dd></div>
    <div><dt>일급</dt><dd>${won(p.dailyWage)}</dd></div>
    <div><dt>남은 기간 급여 (${s.day < config.campaignDays ? `${s.day + 1}~${config.campaignDays}일` : '남은 기간 없음'})</dt><dd>${won(p.remainingWages)}</dd></div>
    <div><dt>하루 처리량</dt><dd>${p.throughput}pt</dd></div>
    <div><dt>지금 원화 사용 가능액</dt><dd>${won(p.availableKrw)}</dd></div></dl>${extra}${afterHire}
    <p>지금 인원으로 버티면: 준비 미배정 ${p.unassigned}건 · 출항 불참 위험 ${p.willMiss}건</p>
    ${queuedHire || `<div data-action-slot="hire-${esc(e.id)}"><button data-action="hire" data-candidate="${esc(e.id)}" ${check.status !== 'APPLIED' ? 'disabled' : ''} aria-label="${esc(e.nameKo)} 고용">${esc(e.nameKo)} 고용</button>
    ${check.status !== 'APPLIED' ? `<p class="reason">${esc(check.reasonKo)}${p.signingFee === 0 && check.reasonKo.startsWith('영입 계약금 자금이 부족합니다.') && fundsPosition(s, config, 'KRW').unpaidObligations > 0 ? ' 미지급 급여가 남아 있어 계약금이 0원이어도 고용할 수 없습니다.' : ''}</p>` : '<p class="muted small">계약금은 한 번 지급하며, 업무와 급여는 고용 다음 날부터 시작합니다.</p>'}</div>`}
  </div>`;
}

export function recruitmentPanel(s: GameState, config: ScenarioConfig, selections: Record<string, string>, interviewId: string | null, check: (cmd: Command) => CommandResult, pending: Command[] = [], status = (_slot: string, text: string) => `<span class="pill">${text}</span>`, state = s): string {
  if (!config.recruitment) return '';
  const employeeSelect = (key: string, label: string, cmd: (id: string) => Command) => {
    const employees = employedDefs(s, config);
    const chosen = selections[key] ?? employees.find((e) => check(cmd(e.id)).status === 'APPLIED')?.id ?? employees[0]?.id ?? '';
    const result = check(cmd(chosen));
    return { chosen, result, html: `<label>담당 직원 <select data-action="recruit-emp" data-key="${esc(key)}" aria-label="${esc(label)} 담당 직원"><option value="" ${!chosen ? 'selected' : ''}>직원 선택</option>${employees.map((e) => `<option value="${esc(e.id)}" ${chosen === e.id ? 'selected' : ''}>${esc(e.nameKo)}${runningTaskOf(s, e.id) ? ` (${esc(crewStatusKo(runningTaskOf(s, e.id)))})` : ''}</option>`).join('')}</select></label>` };
  };
  const sites = config.recruitment.scoutSites.map((site) => {
    const title = venueTitle(site.venueId);
    const scouted = s.recruitment.scoutedVenueIds.includes(site.venueId);
    const task = s.tasks.find((t) => t.kind === 'SCOUT' && t.subjectId === site.venueId && t.status === 'RUNNING');
    const queued = pending.some((p) => p.type === 'SCOUT_SITE' && p.venueId === site.venueId);
    const choice = employeeSelect(site.venueId, `${title} 현장 조사`, (employeeId) => ({ id: `PREVIEW-SCOUT-${site.venueId}`, type: 'SCOUT_SITE', venueId: site.venueId, employeeId }));
    return `<article class="recruit-site"><h4 id="site-h-${esc(site.venueId)}" tabindex="-1">${esc(title)}</h4><p>${scouted ? '조사 완료' : task ? esc(taskSchedule(task, config)) : '미조사'}</p>${queued ? status(`scout-${site.venueId}`, '현장 조사 예정') : `<div data-action-slot="scout-${esc(site.venueId)}">${choice.html}<button data-action="scout" data-venue="${esc(site.venueId)}" aria-label="${esc(title)} 현장 조사(${config.recruitment!.scoutWorkUnits}pt)" data-emp="${esc(choice.chosen)}" ${choice.result.status !== 'APPLIED' ? 'disabled' : ''}>현장 조사(${config.recruitment!.scoutWorkUnits}pt)</button>${choice.result.status !== 'APPLIED' ? `<p class="reason">${esc(choice.result.reasonKo)}</p>` : ''}</div>`}</article>`;
  });
  const candidates = s.recruitment.candidates.filter((c) => c.stage !== 'UNDISCOVERED').map((c) => {
    const e = config.employees.find((e) => e.id === c.employeeId)!;
    const queuedQuest = pending.some((p) => p.type === 'START_RECRUIT_QUEST' && p.candidateId === e.id);
    const queuedHire = pending.some((p) => p.type === 'HIRE_CANDIDATE' && p.candidateId === e.id);
    const clue = characters.items.find((x) => x.id === e.id)?.recruitment.story_clue ?? '';
    const choice = employeeSelect(e.id, `${e.nameKo} 영입 의뢰`, (employeeId) => ({ id: `PREVIEW-QUEST-${e.id}`, type: 'START_RECRUIT_QUEST', candidateId: e.id, employeeId }));
    return `<article class="recruit-candidate"><h4 id="candidate-h-${esc(e.id)}" tabindex="-1">${esc(e.nameKo)} · ${esc(species(e.id))} ${roleBadge(e.role)}</h4><p>${esc(clue)}</p><p class="pill">${esc(candidateLabel(s, c, config))}</p>
      ${signingFeeRule(e, c, config)}
      ${queuedQuest ? status(`quest-${e.id}`, '영입 의뢰 예정') : c.stage === 'DISCOVERED' ? `<div data-action-slot="quest-${esc(e.id)}">${choice.html}<button aria-label="${esc(e.nameKo)} 영입 의뢰(${config.recruitment!.questWorkUnits}pt)" data-action="recruit-quest" data-candidate="${esc(e.id)}" data-emp="${esc(choice.chosen)}" ${choice.result.status !== 'APPLIED' ? 'disabled' : ''}>영입 의뢰(${config.recruitment!.questWorkUnits}pt)</button>${choice.result.status !== 'APPLIED' ? `<p class="reason">${esc(choice.result.reasonKo)}</p>` : ''}</div>` : ''}
      ${c.stage === 'INTERVIEW_READY' || queuedHire ? `<button aria-label="${esc(e.nameKo)} 면담" aria-expanded="${interviewId === e.id}" aria-controls="interview-${esc(e.id)}" data-action="interview" data-candidate="${esc(e.id)}">${esc(e.nameKo)} 면담</button>${interviewBlock(s, config, e, check({ id: `PREVIEW-HIRE-${e.id}`, type: 'HIRE_CANDIDATE', candidateId: e.id }), interviewId === e.id, queuedHire ? status(`hire-${e.id}`, '고용 예정') : '', state)}` : ''}</article>`;
  });
  return `<section class="recruitment" aria-labelledby="recruit-h"><h3 id="recruit-h">${esc(cityName(config, config.homeCityId))} 동료 영입</h3>${sites.join('')}<p class="muted">미발견 후보 ${s.recruitment.candidates.filter((c) => c.stage === 'UNDISCOVERED').length}명</p>${candidates.join('')}</section>`;
}

/** 카드와 운영표 모두 공개된 동료 목록만 전달받는다. */
export function candidateCard(e: EmployeeDef, s: GameState, c: CandidateState, selected: boolean, config: ScenarioConfig): string {
  const status = esc(candidateLabel(s, c, config));
  return `<article class="card ${selected ? 'is-selected' : ''}" data-action="select-card" data-emp="${esc(e.id)}" tabindex="0" role="button" aria-pressed="${selected}" aria-label="${esc(e.nameKo)} 후보 카드, ${status}"><h3>${esc(e.nameKo)} · ${esc(species(e.id))}</h3>${selected ? '<span class="card-picked">✓ 선택됨</span>' : ''}${roleBadge(e.role)}<p>${status}</p><p>하루 ${e.workUnitsPerDay}pt · 일급 ${formatMoney('KRW', e.salaryPerDayMinor)}</p>${signingFeeRule(e, c, config)}<p class="muted small">그림 미제작</p></article>`;
}
export function crewRow(e: EmployeeDef, s: GameState, config: ScenarioConfig, selected: boolean, candidate?: CandidateState, task?: Task): string {
  const loc = s.employees.find((x) => x.id === e.id)?.locationCityId;
  const location = cityName(config, loc ?? null);
  return `<tr class="${selected ? 'is-selected' : ''}" data-action="select-card" data-emp="${esc(e.id)}"><th scope="row"><button class="roster-pick" data-action="select-card" data-emp="${esc(e.id)}" aria-pressed="${selected}"><span class="nm">${esc(e.nameKo)}</span></button>${selected ? '<small class="picked">✓ 선택됨</small>' : ''}${roleBadge(e.role)}${config.growth && !candidate ? `<small>레벨 ${levelProgress(s,config,e.id)?.level ?? 1}</small>` : ''}</th><td>${candidate ? esc(candidateLabel(s, candidate, config)) : task ? `${esc(crewStatusKo(task))}<small>${esc(taskSchedule(task, config))}</small>` : '○ 대기<small>배정 가능</small>'}<small>${esc(location)}</small></td><td class="num">${e.workUnitsPerDay}pt/일<small>${formatMoney('KRW', e.salaryPerDayMinor)}</small></td></tr>`;
}

/** 실제 화면과 시험이 같은 카드 선택 경로를 쓴다. */
export function crewEntryCard(entry: ReturnType<typeof crewEntries>[number], s: GameState, config: ScenarioConfig, selected: boolean): string {
  const { def, candidate, task } = entry;
  return candidate ? candidateCard(def, s, candidate, selected, config)
    : crewCard(def, s, selected, config, task ? taskSchedule(task, config) : undefined);
}

export function crewFacetOptions(s: GameState, config: ScenarioConfig): { roles: string[]; attributes: string[] } {
  const visible = crewEntries(s, config, 'all');
  return { roles: [...new Set(visible.map(({ def }) => def.role))],
    attributes: [...new Set(visible.map(({ def }) => def.character.attribute ?? 'none'))] };
}

/** 사무실은 현재 고용된 동료에게 승인 업무 시트가 있을 때만 연다. */
export function officeButton(state: GameState): string {
  return state.employees.some((e) => e.employmentStatus === 'employed' && characterSprite(e.id))
    ? '<button data-action="open-office" aria-haspopup="dialog">사무실 보기</button>' : '';
}
