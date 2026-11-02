import venues from '../../data/venues.json';
import characters from '../../data/characters.json';
import { esc } from './html';
import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay, planCommands, planState } from '../engine/engine';
import { employedDefs } from '../engine/employees';
import { runDays } from '../engine/testkit';
import type { Command, GameState } from '../engine/types';
import { batchUnlocked, crewEntryCard, candidateCard, crewRow, candidateLabel, crewEntries, crewFacetOptions, interviewBlock, interviewPreview, recruitmentPanel, taskSchedule } from './recruitment';
import { crewCard } from './card';
import { crewNoteKo, taskSchedule as engineTaskSchedule } from './crew-status';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const initial = () => openDay(createGame(config), config).state;
const steps: Command[] = [
  { id: 'A', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02' },
  { id: 'B', type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId: 'EMP01' },
  { id: 'C', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: 'ROUTE02-D002' },
];
const scout: Command = { id: 'S', type: 'SCOUT_SITE', venueId: 'VEN_PORT', employeeId: 'EMP02' };
const quest: Command = { id: 'Q', type: 'START_RECRUIT_QUEST', candidateId: 'EMP04', employeeId: 'EMP01' };
const hired = config.employees.find((e) => e.id === 'EMP04')!;
const check = (s: GameState) => (cmd: Command) => planCommands(s, config, [cmd])[0]!;
const panel = (s: GameState, interviewId: string | null = null) => recruitmentPanel(s, config, {}, interviewId, check(s));
const ready = () => openDay(runDays(createGame(config), config, 3, { 1: [scout], 2: [quest] }).state, config).state;

describe('한 번에 확정 화면 공개', () => {
  it('처음과 배정만 했을 때 숨긴다', () => {
    expect(batchUnlocked(initial())).toBe(false);
    expect(batchUnlocked(planState(initial(), config, steps.slice(0, 2)).state)).toBe(false);
  });
  it('단계별 배정·예약 반영 뒤 공개한다', () => {
    expect(batchUnlocked(runDays(createGame(config), config, 1, { 1: steps }).state)).toBe(true);
  });
  it('오늘 대기 명령만으로 공개하며 빼면 다시 숨긴다', () => {
    const state = initial();
    expect(batchUnlocked(planState(state, config, steps).state)).toBe(true);
    expect(batchUnlocked(state)).toBe(false);
    expect(batchUnlocked(planState(state, config, steps.slice(0, 2)).state)).toBe(false);
  });
  it('거절된 예약과 일괄 확정만으로는 공개하지 않는다', () => {
    const wrong: Command = { ...steps[2]!, type: 'BOOK_SAILING', contractId: 'CT001', sailingId: 'ROUTE01-D002' };
    expect(batchUnlocked(planState(initial(), config, [...steps.slice(0, 2), wrong]).state)).toBe(false);
    expect(batchUnlocked(planState(initial(), config, [{ ...steps[0]!, plan: { employeeId: 'EMP01', sailingId: 'ROUTE02-D002' } } as Command]).state)).toBe(false);
  });
});

describe('영입 화면의 엔진 연결', () => {
  it('1일 직원 각주는 미고용 3pt 후보를 처리량 범위에 포함하지 않는다', () => {
    expect(config.employees.find((e)=>e.id===hired.id)!.workUnitsPerDay).toBe(3);
    expect(crewNoteKo(config,initial())).toContain('하루 2pt');
    expect(crewNoteKo(config,initial())).not.toContain('2~3pt');
  });
  it.each(['SCOUT','TRAINING'] as const)('%s 카드 일정의 대체 경로는 taskSchedule을 전달한 경로와 같다', (kind) => {
    const command:Command=kind==='SCOUT' ? scout : {id:'T',type:'START_TRAINING',employeeId:'EMP02'};
    const s=planState(initial(),config,[command]).state;
    const def=config.employees.find((e)=>e.id==='EMP02')!;
    const task=s.tasks.find((t)=>t.assignedEmployeeId===def.id)!;
    const schedule=engineTaskSchedule(task,config);
    expect(schedule).toBe(kind==='SCOUT' ? '현장 조사 중 — 항만 물류단지 0/1pt' : '일반 훈련 중 — 0/1일');
    expect(crewCard(def,s,false,config)).toBe(crewCard(def,s,false,config,schedule));
  });
  it('미발견 후보는 수만 보이고 이름·종·단서를 숨긴다', () => {
    const html = panel(initial());
    expect(html).toContain('미발견 후보 4명');
    expect(html).toContain('항만 물류단지');
    for (const e of config.employees.slice(2)) expect(html).not.toContain(e.nameKo);
    expect(html).not.toContain('현무');
    expect(html).toContain('현장 조사(1pt)');
  });
  it('조사·발견·의뢰·면담·고용과 다음 날 카드가 같은 상태를 읽는다', () => {
    const scouting = planState(initial(), config, [scout]).state;
    expect(panel(scouting)).toContain('현장 조사 중 — 항만 물류단지 0/1pt');
    const discovered = openDay(runDays(createGame(config), config, 1, { 1: [scout] }).state, config).state;
    expect(panel(discovered)).toContain('현돌');
    expect(panel(discovered)).toContain('영입 의뢰(3pt)');
    const progressing = planState(discovered, config, [quest]).state;
    expect(candidateLabel(progressing, progressing.recruitment.candidates.find((c) => c.employeeId === hired.id)!)).toBe('의뢰 진행 중 0/3pt');
    const s = ready();
    expect(panel(s, hired.id)).toContain('현돌 고용');
    const cmd: Command = { id: 'H', type: 'HIRE_CANDIDATE', candidateId: hired.id };
    const today = planState(s, config, [cmd]).state;
    expect(panel(today)).toContain('고용 예정 — 5일부터 근무');
    expect(panel(today)).not.toContain('고용됨');
    const tomorrow = openDay(runDays(s, config, 4, { 4: [cmd] }).state, config).state;
    expect(employedDefs(tomorrow, config)).toContain(hired);
    expect(crewCard(hired, tomorrow, false, config)).toContain('대기 — 배정 가능');
  });
  it('카드·운영표 필터는 발견 후보만 포함하고 대기·업무 중에는 근무 직원을 보여 준다', () => {
    expect(crewEntries(initial(), config, 'all')).toHaveLength(2);
    expect(crewEntries(initial(), config, 'candidate')).toEqual([]);
    const s = ready();
    expect(crewEntries(s, config, 'candidate').map((x) => x.def.id)).toEqual(['EMP04', 'EMP06']);
    expect(crewEntries(s, config, 'all')).toHaveLength(4);
    expect(crewEntries(s, config, 'free')).toHaveLength(2);
    const busy = planState(initial(), config, [scout]).state;
    expect(crewEntries(busy, config, 'busy').map((x) => x.def.id)).toEqual(['EMP02']);
    const entry = crewEntries(busy, config, 'busy')[0]!;
    expect(crewCard(entry.def, busy, false, config, taskSchedule(entry.task!, config))).toContain('현장 조사 중 — 항만 물류단지 0/1pt');
  });
  it('현돌의 5일 면담 비용과 남은 급여를 표시한다', () => {
    const s = openDay(runDays(ready(), config, 4).state, config).state;
    const p = interviewPreview(s, config, hired);
    expect(p.signingFee).toBe(550_000);
    expect(p.dailyWage).toBe(110_000);
    expect(p.remainingWages).toBe(110_000 * (config.campaignDays - 5));
    expect(p.throughput).toBe(3);
    expect(interviewBlock(s, config, hired, check(s)({ id: 'H', type: 'HIRE_CANDIDATE', candidateId: hired.id }))).toContain('550,000');
  });
  it('원화 부족이면 엔진의 거절 이유와 비활성 고용 버튼을 표시한다', () => {
    const s = ready();
    s.ledger.entries.push({ ...s.ledger.entries[0]!, id: 'DRAIN', currency: 'KRW', lines: [{ account: 'WAGE_EXPENSE', amount: 100_000_000 }, { account: 'CASH', amount: -100_000_000 }] });
    const result = check(s)({ id: 'H', type: 'HIRE_CANDIDATE', candidateId: hired.id });
    expect(result.status).toBe('REJECTED');
    const html = interviewBlock(s, config, hired, result);
    expect(html).toContain('disabled');
    expect(html).toContain(result.reasonKo);
  });
  it('현재 계약의 준비 미배정·출항 불참 개수를 contractProgress에서 읽는다', () => {
    const s = planState(initial(), config, steps.slice(0, 1)).state;
    expect(interviewPreview(s, config, hired).unassigned).toBe(1);
    expect(interviewPreview(s, config, hired).willMiss).toBe(0);
    const busy = planState(initial(), config, steps).state;
    const task = busy.tasks[0]!;
    task.requiredWorkUnits = 100;
    expect(interviewPreview(busy, config, hired).willMiss).toBe(1);
    expect(taskSchedule(task, config)).toContain('수출 준비 중 — CT001');
  });
});

// HTML 전체를 검사하므로 속성·접근 이름에서 새는 정보도 잡는다.
const crewHtml = (s: GameState) => crewEntries(s, config, 'all').map(({ def, candidate, task }) =>
  crewEntryCard({ def, candidate, task }, s, config, false) +
  crewRow(def, s, config, false, candidate, task)).join('');
const actionButton = (html: string, action: string, target: string) => {
  const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
  const button = buttons.find((b) => b.includes(`data-action="${action}"`) && b.includes(target));
  expect(button, `${action} ${target} 버튼`).toBeDefined();
  return button!;
};
const assertDecision = (html: string, action: string, target: string, result: ReturnType<ReturnType<typeof check>>) => {
  expect(actionButton(html, action, target).includes('disabled')).toBe(result.status !== 'APPLIED');
  if (result.status !== 'APPLIED') expect(html).toContain(esc(result.reasonKo));
};

describe('재작업: HTML 공개·접근성·판정', () => {
  it('네 후보의 이름·종·단서를 패널·카드·운영표 전체에서 숨기고 조사한 두 명만 공개한다', () => {
    const before = panel(initial()) + crewHtml(initial());
    const discovered = openDay(runDays(createGame(config), config, 1, { 1: [scout] }).state, config).state;
    const after = panel(discovered) + crewHtml(discovered);
    for (const e of config.employees.slice(2)) {
      const character = characters.items.find((c) => c.id === e.id)!;
      for (const text of [e.nameKo, character.species_ko, character.recruitment.story_clue]) {
        expect(before).not.toContain(esc(text));
        if (['EMP04', 'EMP06'].includes(e.id)) expect(after).toContain(esc(text));
        else expect(after).not.toContain(esc(text));
      }
    }
    expect(crewEntries(discovered, config, 'candidate').map((e) => e.def.id)).toEqual(['EMP04', 'EMP06']);
    expect(after).toContain('aria-label="현돌 후보 카드, 발견"');
  });
  it('예약만 반영하거나 대기해도 배정 기록이 없으면 한 번에 확정을 숨긴다', () => {
    const onlyBooking = [steps[0]!, steps[2]!];
    expect(planCommands(initial(), config, onlyBooking).every((r) => r.status === 'APPLIED')).toBe(true);
    expect(batchUnlocked(planState(initial(), config, onlyBooking).state)).toBe(false);
    expect(batchUnlocked(runDays(createGame(config), config, 1, { 1: onlyBooking }).state)).toBe(false);
  });
  it('조사 버튼은 허용·바쁜 직원·이미 조사한 장소의 엔진 판정과 이유를 따른다', () => {
    const command = { ...scout, id: 'S-CHECK', employeeId: 'EMP01' };
    const s = initial();
    const allowed = check(s)(command);
    expect(allowed.status).toBe('APPLIED');
    assertDecision(recruitmentPanel(s, config, { VEN_PORT: 'EMP01' }, null, check(s)), 'scout', 'VEN_PORT', allowed);
    const busy = planState(s, config, steps.slice(0, 2)).state;
    const denied = check(busy)(command);
    expect(denied.status).toBe('REJECTED');
    assertDecision(recruitmentPanel(busy, config, { VEN_PORT: 'EMP01' }, null, check(busy)), 'scout', 'VEN_PORT', denied);
    const done = openDay(runDays(createGame(config), config, 1, { 1: [scout] }).state, config).state;
    const repeated = check(done)(command);
    expect(repeated.status).toBe('REJECTED');
    assertDecision(panel(done), 'scout', 'VEN_PORT', repeated);
  });
  it('의뢰는 발견 전 숨기며 발견 후 허용·거절을 버튼과 이유에 연결한다', () => {
    expect(check(initial())(quest).status).toBe('REJECTED');
    expect(panel(initial())).not.toContain('data-action="recruit-quest"');
    const s = openDay(runDays(createGame(config), config, 1, { 1: [scout] }).state, config).state;
    const allowed = check(s)(quest);
    expect(allowed.status).toBe('APPLIED');
    assertDecision(panel(s), 'recruit-quest', hired.id, allowed);
    const busy = planState(s, config, steps.slice(0, 2)).state;
    const denied = check(busy)(quest);
    expect(denied.status).toBe('REJECTED');
    assertDecision(recruitmentPanel(busy, config, { EMP04: 'EMP01' }, null, check(busy)), 'recruit-quest', hired.id, denied);
  });
  it('고용은 면담 전·자금 부족이면 꺼지고 면담 준비·자금 충족이면 켜진다', () => {
    const command: Command = { id: 'H-CHECK', type: 'HIRE_CANDIDATE', candidateId: hired.id };
    for (const s of [initial(), ready()]) {
      const result = check(s)(command);
      expect(result.status).toBe(s.day === 1 ? 'REJECTED' : 'APPLIED');
      assertDecision(interviewBlock(s, config, hired, result), 'hire', hired.id, result);
    }
    const poor = ready();
    poor.ledger.entries.push({ ...poor.ledger.entries[0]!, id: 'DRAIN-R1', currency: 'KRW', lines: [{ account: 'WAGE_EXPENSE', amount: 100_000_000 }, { account: 'CASH', amount: -100_000_000 }] });
    const result = check(poor)(command);
    expect(result.status).toBe('REJECTED');
    assertDecision(panel(poor, hired.id), 'hire', hired.id, result);
  });
  it('실제로 5일까지 진행한 면담 HTML에 비용·기간·가용액·비교 건수를 표시한다', () => {
    const s = openDay(runDays(createGame(config), config, 4, { 1: [steps[0]!, scout], 2: [quest] }).state, config).state;
    expect(s.day).toBe(5);
    const html = panel(s, hired.id);
    expect(html).toContain('<dd>550,000원</dd>');
    expect(html).toContain('<dd>9,350,000원</dd>');
    expect(html).toContain('남은 기간 급여 (6~90일)');
    expect(html).toContain('<dd>9,360,000원</dd>');
    expect(html).toContain('준비 미배정 1건 · 출항 불참 위험 0건');
    const lateCommands: Command[] = [
      { id: 'LATE-ASSIGN', type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId: 'EMP01' },
      { id: 'LATE-BOOK', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: 'ROUTE02-D009' },
    ];
    expect(planCommands(s, config, lateCommands).every((r) => r.status === 'APPLIED')).toBe(true);
    const late = planState(s, config, lateCommands).state;
    late.tasks.find((t) => t.id === 'TASK001')!.requiredWorkUnits = 100;
    expect(panel(late, hired.id)).toContain('준비 미배정 0건 · 출항 불참 위험 1건');
  });
  it('마지막 날에는 남은 기간 없음과 0원으로 표시한다', () => {
    const s = openDay(runDays(createGame(config), config, config.campaignDays - 1, { 1: [scout], 2: [quest] }).state, config).state;
    expect(panel(s, hired.id)).toContain('남은 기간 급여 (남은 기간 없음)</dt><dd>0원</dd>');
  });
  it('면담 펼침 상태와 이름 있는 영역 및 대상별 접근 이름을 연결한다', () => {
    const html = panel(ready(), hired.id);
    expect(html).toContain('aria-label="항만 물류단지 현장 조사 담당 직원"');
    expect(html).toContain('aria-label="현돌 면담" aria-expanded="true" aria-controls="interview-EMP04"');
    expect(html).toContain('id="interview-EMP04" role="region" aria-labelledby="interview-h-EMP04"');
    expect(panel(ready())).toContain('aria-expanded="false"');
    expect(panel(ready())).toContain('aria-labelledby="interview-h-EMP04" hidden');
  });
  it('고용 다음 날 crewEntries에서 직원 카드와 운영표를 그리며 후보 카드에서 제외한다', () => {
    const s = ready();
    const tomorrow = openDay(runDays(s, config, 4, { 4: [{ id: 'H', type: 'HIRE_CANDIDATE', candidateId: hired.id }] }).state, config).state;
    const entry = crewEntries(tomorrow, config, 'all').find((e) => e.def.id === hired.id)!;
    expect(entry.candidate).toBeUndefined();
    expect(entry.task).toBeUndefined();
    expect(crewEntries(tomorrow, config, 'candidate').some((e) => e.def.id === hired.id)).toBe(false);
    const html = crewHtml(tomorrow);
    expect(html).toContain('현돌 직원 카드');
    expect(html).not.toContain('현돌 후보 카드');
    expect(crewRow(entry.def, tomorrow, config, false, entry.candidate, entry.task)).toContain('대기<small>배정 가능');
  });
});


describe('재작업: 설정·HTML 이스케이프', () => {
  it('설정의 의뢰 pt를 사용한다', () => {
    const s = openDay(runDays(createGame(config), config, 1, { 1: [scout] }).state, config).state;
    const custom = { ...config, recruitment: { ...config.recruitment!, questWorkUnits: 7 } };
    expect(recruitmentPanel(s, custom, {}, null, check(s))).toContain('영입 의뢰(7pt)');
    expect(candidateLabel(s, { ...s.recruitment.candidates[0]!, stage: 'QUEST_RUNNING', questTaskId: null }, custom)).toContain('/7pt');
  });
  it('이름·종·단서·장소·거절 이유·업무 대상의 텍스트와 속성을 이스케이프한다', () => {
    const unsafe = `공통<&"'문자>`;
    const s = ready();
    const custom = structuredClone(config);
    custom.employees.find((e) => e.id === hired.id)!.nameKo = unsafe;
    const character = characters.items.find((e) => e.id === hired.id)!;
    const venue = venues.items.find((v) => v.id === 'VEN_PORT')!;
    const original = { species: character.species_ko, clue: character.recruitment.story_clue, title: venue.title_ko };
    try {
      character.species_ko = unsafe;
      character.recruitment.story_clue = unsafe;
      venue.title_ko = unsafe;
      const html = recruitmentPanel(s, custom, {}, hired.id, (cmd) => ({ ...check(s)(cmd), status: 'REJECTED', reasonKo: unsafe }));
      expect(html).not.toContain(unsafe);
      expect(html).toContain(esc(unsafe));
      const entry = crewEntries(s, custom, 'candidate').find((e) => e.def.id === hired.id)!;
      expect(candidateCard(entry.def, s, entry.candidate!, false, custom)).not.toContain(unsafe);
      const busy = planState(initial(), config, [scout]).state;
      busy.tasks[0]!.subjectId = unsafe;
      custom.recruitment!.scoutSites.push({ ...custom.recruitment!.scoutSites[0]!, venueId: unsafe, titleKo: unsafe });
      const worker = crewEntries(busy, custom, 'busy')[0]!;
      for (const rendered of [crewRow(worker.def, busy, custom, false, undefined, worker.task), crewCard(worker.def, busy, false, custom, taskSchedule(worker.task!, custom))]) {
        expect(rendered).not.toContain(unsafe);
        expect(rendered).toContain(esc(unsafe));
      }
    } finally {
      character.species_ko = original.species;
      character.recruitment.story_clue = original.clue;
      venue.title_ko = original.title;
    }
  });
});

describe('TASK-0005 접근 이름과 면담 값', () => {
  it('모든 버튼의 접근 이름은 보이는 글자를 포함하고 모든 영역 참조는 실제 id를 가리킨다', () => {
    for (const s of [initial(), openDay(runDays(createGame(config), config, 1, {1:[scout]}).state,config).state, ready()]) {
      const html = panel(s, hired.id);
      for (const b of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)) {
        const visible = b[2]!.replace(/<[^>]*>/g,'').trim();
        const label = b[1]!.match(/aria-label="([^"]*)"/)?.[1];
        expect(label).toBeDefined(); expect(label).toContain(visible);
      }
      const ids = new Set([...html.matchAll(/\bid="([^"]*)"/g)].map((m)=>m[1]));
      for (const ref of html.matchAll(/aria-(?:labelledby|controls)="([^"]*)"/g)) {
        for (const id of ref[1]!.split(' ')) expect(ids.has(id), id).toBe(true);
      }
    }
  });
  it('후보 단계 네 가지와 근무 시작 뒤 직원 카드 접근 이름을 같은 선택 함수로 만든다', () => {
    const discovered=openDay(runDays(createGame(config),config,1,{1:[scout]}).state,config).state;
    const running=openDay(runDays(discovered,config,2,{2:[quest]}).state,config).state;
    const interviewing=openDay(runDays(running,config,3).state,config).state;
    const hiredState=planState(interviewing,config,[{id:'H4',type:'HIRE_CANDIDATE',candidateId:hired.id}]).state;
    for(const [s,label] of [[discovered,'발견'],[running,'의뢰 진행 중 2/3pt'],[interviewing,'면담 가능'],[hiredState,'고용 예정 — 5일부터 근무']] as const) {
      const entry=crewEntries(s,config,'all').find((e)=>e.def.id===hired.id)!;
      expect(crewEntryCard(entry,s,config,false)).toContain(`aria-label="현돌 후보 카드, ${label}"`);
    }
    const day5=openDay(runDays(hiredState,config,4).state,config).state;
    const entry=crewEntries(day5,config,'all').find((e)=>e.def.id===hired.id)!;
    const html=crewEntryCard(entry,day5,config,false);
    expect(html).toContain('aria-label="현돌 직원 카드, 운영, 레벨 1, 대기 — 배정 가능"');
    expect(html).not.toContain('현돌 후보 카드');
    expect(crewNoteKo(config,day5)).toContain('하루 2~3pt');
  });
  it('허용 고용은 켜지고 이유 문단이 없으며 면담 dt/dd를 정확히 짝짓는다', () => {
    const s = openDay(runDays(createGame(config),config,4,{1:[steps[0]!,scout],2:[quest]}).state,config).state;
    const result = check(s)({id:'H5',type:'HIRE_CANDIDATE',candidateId:hired.id});
    expect(result.status).toBe('APPLIED');
    const html = interviewBlock(s,config,hired,result);
    expect(actionButton(html,'hire',hired.id)).not.toContain('disabled');
    expect(html).not.toContain('class="reason"');
    expect(Object.fromEntries([...html.matchAll(/<dt>(.*?)<\/dt><dd>(.*?)<\/dd>/g)].map((m)=>[m[1],m[2]]))).toEqual({
      '계약금 (일급×5)':'550,000원', '일급':'110,000원', '남은 기간 급여 (6~90일)':'9,350,000원',
      '하루 처리량':'3pt', '지금 원화 사용 가능액':'9,360,000원',
    });
    expect(html).toContain('<h4 id="interview-h-EMP04">');
  });
  it('0원 계약금 거절에는 엔진 이유를 유지하며 미지급 원인을 덧붙인다', () => {
    const cfg = structuredClone(config); cfg.recruitment!.signingFeeWageDays = 0;
    const s = ready();
    s.ledger.entries.push({...s.ledger.entries[0]!,id:'UNPAID',currency:'KRW',lines:[{account:'WAGE_EXPENSE',amount:20_000_000},{account:'ACCOUNTS_PAYABLE',amount:-20_000_000}]});
    s.obligations.push({id:'UNPAID',currency:'KRW',amountMinor:20_000_000,reasonKo:'미지급 급여',incurredDay:1,paidDay:null});
    const result = planCommands(s,cfg,[{id:'H0',type:'HIRE_CANDIDATE',candidateId:hired.id}])[0]!;
    expect(result.status).toBe('REJECTED');
    const html=interviewBlock(s,cfg,hired,result);
    expect(html).toContain(esc(result.reasonKo));expect(html).toContain('미지급 급여가 남아 있어');
  });
});

describe('TASK-0018 고용 뒤 원화 미리 보기',()=>{
  it('고용 가능이면 사본의 사용액과 더 이른 지급 가능일을 보이고 입력을 보존한다',async()=>{
    const {fundsPosition}=await import('../engine/reservations');
    const {payrollRunwayDay}=await import('../engine/previews');
    const {payrollRunwayKo}=await import('./growth');
    const {formatMoney}=await import('../engine/money');
    const s=ready(),before=structuredClone(s);
    const command={id:'고용 미리 보기',type:'HIRE_CANDIDATE' as const,candidateId:hired.id};
    // 기존에 처리한 미리 보기 ID와 충돌해도 새 명령으로 계산한다.
    s.processedCommands[`PREVIEW-HIRE-AFTER-${hired.id}`]= {...check(s)(command),status:'APPLIED',day:s.day,type:command.type};
    const unchanged=structuredClone(s),after=planState(s,config,[command]).state;
    const available=(state:GameState)=>fundsPosition(state,config,'KRW').available;
    const day=(state:GameState)=>payrollRunwayDay(state,config);
    const runway=(state:GameState)=>payrollRunwayKo(day(state),s.day,config.campaignDays);
    const html=interviewBlock(s,config,hired,check(s)(command));
    expect(html.match(/class="hire-after"/g)).toHaveLength(2);
    expect(html).toContain(`고용하면 원화 사용 가능액: 지금 ${formatMoney('KRW',available(s))} → 고용 뒤 ${formatMoney('KRW',available(after))}`);
    expect(available(after)).toBe(available(s)-hired.salaryPerDayMinor*config.recruitment!.signingFeeWageDays);
    expect(html).toContain(`원화 급여 지급 가능일: 지금 ${runway(s)} → 고용하면 ${runway(after)}`);
    expect(day(after)!).toBeLessThan(day(s)!);
    expect(s).toEqual(unchanged);expect(before.employees).toEqual(s.employees);
  });
  it('고용 대기는 반영한 지급 가능일 하나만 표시한다',async()=>{
    const {payrollRunwayDay}=await import('../engine/previews');
    const {payrollRunwayKo}=await import('./growth');
    const s=planState(ready(),config,[{id:'고용',type:'HIRE_CANDIDATE',candidateId:hired.id}]).state;
    const html=interviewBlock(s,config,hired,check(s)({id:'중복',type:'HIRE_CANDIDATE',candidateId:hired.id}),true,'고용 예정');
    expect(html.match(/class="hire-after"/g)).toHaveLength(1);
    expect(html).toContain(`원화 급여 지급 가능일: ${payrollRunwayKo(payrollRunwayDay(s,config),s.day,config.campaignDays)} (오늘 할 일의 고용 반영)`);
    expect(html).not.toContain('고용하면 원화');
  });
  it('원화가 부족하면 새 줄을 표시하지 않는다',()=>{
    const cfg=structuredClone(config);cfg.startingCash.KRW=0;
    const s=ready();s.ledger=createGame(cfg).ledger;
    const result=planState(s,cfg,[{id:'고용',type:'HIRE_CANDIDATE',candidateId:hired.id}]).results[0]!;
    expect(result.status).toBe('REJECTED');
    expect(interviewBlock(s,cfg,hired,result)).not.toContain('hire-after');
  });
});


describe('공개된 동료의 직무·속성 필터', () => {
  it('crewFacetOptions는 설정 순서로 공개 값만 중복 없이 반환한다', () => {
    const s = initial(), entries = crewEntries(s, config, 'all');
    const options = crewFacetOptions(s, config);
    expect(options).toEqual({ roles: [...new Set(entries.map(({ def }) => def.role))],
      attributes: [...new Set(entries.map(({ def }) => def.character.attribute ?? 'none'))] });
    const hiddenOnly = config.employees.filter((e) => !entries.some(({ def }) => def.id === e.id))
      .map((e) => e.character.attribute ?? 'none').filter((a) => !entries.some(({ def }) => (def.character.attribute ?? 'none') === a));
    for (const a of hiddenOnly) expect(options.attributes).not.toContain(a);
  });
  it('상태·직무·속성을 함께 걸며 기존 세 인수 호출을 보존한다', () => {
    for (const s of [initial(), ready()]) for (const filter of ['all', 'free', 'busy', 'candidate'] as const) {
      const entries = crewEntries(s, config, filter), options = crewFacetOptions(s, config);
      expect(entries).toEqual(crewEntries(s, config, filter, {}));
      for (const role of options.roles) {
        expect(crewEntries(s, config, filter, { role })).toEqual(entries.filter(({ def }) => def.role === role));
        for (const attribute of options.attributes) expect(crewEntries(s, config, filter, { role, attribute }))
          .toEqual(entries.filter(({ def }) => def.role === role && (def.character.attribute ?? 'none') === attribute));
      }
      for (const attribute of options.attributes) expect(crewEntries(s, config, filter, { attribute }))
        .toEqual(entries.filter(({ def }) => (def.character.attribute ?? 'none') === attribute));
    }
  });
});
