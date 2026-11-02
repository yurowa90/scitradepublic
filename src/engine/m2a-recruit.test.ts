// P0-M2A-04: 발견·의뢰·고용을 분리하고 기존 예약·장부·저장 경로에서 검증한다.
import { describe, expect, it } from 'vitest';
import acceptance from '../../tests/acceptance_cases.json';
import { expectedM2, loadScenario } from '../content/scenario';
import { crewCard } from '../ui/card';
import { createGame, openDay, planCommands, planState } from './engine';
import { employedDefs, isEmployed } from './employees';
import { checkInvariants } from './invariants';
import { post, summarize } from './ledger';
import { companyReport } from './reports';
import { runningTaskOf } from './reservations';
import { deserializeSave, SAVE_FORMAT_VERSION, serializeSave } from './save';
import { runDays, type DayScript } from './testkit';
import type { Command, GameState, ScenarioConfig } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const spec = acceptance.cases.find((c) => c.id === 'P0-M2A-04')!.expected_numeric!;
const scout = (id = 'SCOUT', venueId = 'VEN_PORT', employeeId = 'EMP02'): Command => ({ id, type: 'SCOUT_SITE', venueId, employeeId });
const quest = (id = 'QUEST', candidateId = 'EMP04', employeeId = 'EMP01'): Command => ({ id, type: 'START_RECRUIT_QUEST', candidateId, employeeId });
const hire = (id = 'HIRE', candidateId = 'EMP04'): Command => ({ id, type: 'HIRE_CANDIDATE', candidateId });
const assign = (employeeId: string, id = 'ASSIGN'): Command => ({ id, type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId });
const trade = (employeeId?: string): Command => ({
  id: 'TRADE', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01',
  ...(employeeId ? { plan: { employeeId } } : {}),
});
const candidate = (s: GameState, id = 'EMP04') => s.recruitment.candidates.find((c) => c.employeeId === id)!;
const wages = (s: GameState, id = 'EMP04') => s.ledger.entries.filter((e) => e.id.startsWith('WAGE-') && e.id.endsWith(`-${id}`));
const script: DayScript = { 1: [scout()], 2: [quest()], 4: [hire()] };
const until = (lastDay: number, cfg = config, commands = script) => runDays(createGame(cfg), cfg, lastDay, commands).state;
const plan = (s: GameState, commands: Command[], cfg = config) => planState(openDay(s, cfg).state, cfg, commands);

function unchangedExceptCommand(before: GameState, after: GameState) {
  expect({ ...after, processedCommands: before.processedCommands }).toEqual(before);
}

describe('P0-M2A-04 발견·의뢰: 직원 시간을 쓰지만 고용을 만들지 않는다', () => {
  it('후보 정의 4명과 기존 고용 직원 2명을 분리하고 M1에는 영입을 켜지 않는다', () => {
    const initial = createGame(config);
    expect(config.employees.map((e) => e.id)).toEqual(['EMP01', 'EMP02', 'EMP03', 'EMP04', 'EMP05', 'EMP06']);
    expect(employedDefs(initial, config)).toHaveLength(spec.employed_after_discovery!);
    expect(initial.recruitment.candidates.every((c) => c.stage === 'UNDISCOVERED')).toBe(true);
    expect(loadScenario('SCENARIO_M1_ONE_TRADE').recruitment).toBeNull();
    checkInvariants(initial, config);
  });

  it('1일 항만 조사로 2일 현돌·바름을 발견해도 인원·원화 장부·운영 목록은 그대로다', () => {
    const s = until(1);
    const baseline = runDays(createGame(config), config, 1).state;
    expect(s.day).toBe(2);
    expect(candidate(s)).toMatchObject({ stage: 'DISCOVERED', discoveredDay: 1 });
    expect(candidate(s, 'EMP06').stage).toBe('DISCOVERED');
    expect(candidate(s, 'EMP03').stage).toBe('UNDISCOVERED');
    expect(s.recruitment.scoutedVenueIds).toEqual(['VEN_PORT']);
    expect(s.ledger).toEqual(baseline.ledger);
    expect(employedDefs(s, config)).toHaveLength(spec.employed_after_discovery!);
    expect(plan(s, [trade(), assign('EMP04')]).results[1]!.reasonKo).toContain('고용 중인 직원이 아닙니다');
    expect(wages(s)).toEqual([]);
    expect(crewCard(config.employees.find((e) => e.id === 'EMP04')!, s, false, config)).toBe('');
    checkInvariants(s, config);
  });

  it('조사 업무가 같은 날 준비 업무·일괄 확정·다른 장소 조사와 겹칠 수 없다', () => {
    const s = openDay(createGame(config), config).state;
    const commands = [scout(), trade(), assign('EMP02'), scout('AGAIN'), scout('OTHER', 'VEN_LOUNGE')];
    const p = plan(s, commands);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'REJECTED', 'REJECTED', 'REJECTED']);
    expect(p.results[2]!.reasonKo).toContain('다른 업무');
    expect(p.results[3]!.reasonKo).toContain('조사 중');
    expect(runningTaskOf(p.state, 'EMP02')!.kind).toBe('SCOUT');
    expect(planCommands(s, config, commands)).toEqual(p.results);
    const atomic = plan(s, [scout(), trade('EMP02')]);
    expect(atomic.results[1]!.reasonKo).toContain('한 번에 확정할 수 없습니다 — 준비 배정 불가:');
    expect(atomic.state.contracts).toEqual([]);
    expect(plan(until(1), [scout('DONE')]).results[0]!.reasonKo).toContain('이미 조사');
    checkInvariants(p.state, config);
  });

  it('없는 장소·후보 담당자·다른 도시 직원·발견할 후보가 없는 장소를 거절한다', () => {
    const s = openDay(createGame(config), config).state;
    for (const cmd of [scout('BAD', 'NO_SITE'), scout('CANDIDATE', 'VEN_PORT', 'EMP04')]) {
      const p = plan(s, [cmd]);
      expect(p.results[0]!.status).toBe('REJECTED');
      unchangedExceptCommand(s, p.state);
    }
    s.employees.find((e) => e.id === 'EMP02')!.locationCityId = 'HAIPHONG';
    expect(plan(s, [scout()]).results[0]!.reasonKo).toContain('현지 인력');
    candidate(s).stage = 'DISCOVERED';
    candidate(s, 'EMP06').stage = 'DISCOVERED';
    expect(plan(s, [scout()]).results[0]!.reasonKo).toContain('아직 발견하지 않은 후보가 없습니다');
  });

  it('발견 전 의뢰·면담 전 고용을 거절하고 귀솔의 3pt 의뢰는 이틀 걸린다', () => {
    expect(plan(createGame(config), [quest(), hire()]).results.map((r) => r.status)).toEqual(['REJECTED', 'REJECTED']);
    const working = until(2);
    expect(candidate(working)).toMatchObject({ stage: 'QUEST_RUNNING', questTaskId: 'RECRUIT-EMP04', interviewReadyDay: null });
    expect(runningTaskOf(working, 'EMP01')!.progressWorkUnits).toBe(2);
    const busy = plan(working, [quest('TWICE', 'EMP04', 'EMP02'), trade(), assign('EMP01'), quest('OTHER', 'EMP06')]);
    expect(busy.results.map((r) => r.status)).toEqual(['REJECTED', 'APPLIED', 'REJECTED', 'REJECTED']);
    expect(busy.results[0]!.reasonKo).toBe('발견한 후보에게만 영입 의뢰를 시작할 수 있습니다.');
    expect(busy.state.tasks).toHaveLength(working.tasks.length + 1);
    expect(candidate(busy.state, 'EMP06').stage).toBe('DISCOVERED');
    expect(busy.state.tasks.some((t) => t.id === 'RECRUIT-EMP06')).toBe(false);
    const ready = until(3);
    expect(candidate(ready)).toMatchObject({ stage: 'INTERVIEW_READY', interviewReadyDay: 3 });
    expect(isEmployed(ready, 'EMP04')).toBe(false);
    expect(ready.ledger).toEqual(runDays(createGame(config), config, 3).state.ledger);
    checkInvariants(ready, config);
  });

  it.each([2, 3, 4])('%i일 마감 뒤 다른 대기 직원도 같은 후보 의뢰를 다시 시작할 수 없다', (day) => {
    const s = openDay(until(day), config).state;
    expect(runningTaskOf(s, 'EMP02')).toBeUndefined();
    const p = plan(s, [quest('RETRY', 'EMP04', 'EMP02')]);
    expect(p.results[0]!.status).toBe('REJECTED');
    expect(p.results[0]!.reasonKo).toBe('발견한 후보에게만 영입 의뢰를 시작할 수 있습니다.');
    expect(p.state.tasks).toHaveLength(s.tasks.length);
    unchangedExceptCommand(s, p.state);
  });

  it.each([1, 2])('%i일 마감 뒤 면담 전 고용은 장부와 상태를 바꾸지 않는다', (day) => {
    const s = openDay(until(day), config).state;
    expect(candidate(s).stage).toBe(day === 1 ? 'DISCOVERED' : 'QUEST_RUNNING');
    const p = plan(s, [hire()]);
    expect(p.results[0]!.status).toBe('REJECTED');
    expect(p.results[0]!.reasonKo).toBe('면담 가능한 후보만 고용할 수 있습니다.');
    unchangedExceptCommand(s, p.state);
  });

  it('업무 ID가 이미 있거나 담당자가 바쁘면 새 영입 업무를 남기지 않는다', () => {
    // 단계 검사와 독립적으로 기존 업무 ID 충돌 방어를 시험한다.
    const collision = openDay(until(2), config).state;
    candidate(collision).stage = 'DISCOVERED';
    const duplicate = plan(collision, [quest('COLLISION', 'EMP04', 'EMP02')]);
    expect(duplicate.results[0]!.reasonKo).toBe('이미 생성된 업무 ID입니다.');
    expect(duplicate.state.tasks).toHaveLength(collision.tasks.length);
    unchangedExceptCommand(collision, duplicate.state);

    const busy = openDay(until(2), config).state;
    const rejected = plan(busy, [quest('BUSY', 'EMP06', 'EMP01')]);
    expect(rejected.results[0]!.status).toBe('REJECTED');
    expect(rejected.results[0]!.reasonKo).toContain('다른 업무');
    expect(rejected.state.tasks).toHaveLength(busy.tasks.length);
    unchangedExceptCommand(busy, rejected.state);
  });

  it('조사·의뢰 명령 ID를 재전송해도 업무와 진행량을 복제하지 않는다', () => {
    const commands = { 1: [scout(), scout()], 2: [scout(), quest(), quest()], 3: [quest()] };
    const run = runDays(createGame(config), config, 3, commands);
    expect(run.results[1]!.map((r) => r.status)).toEqual(['APPLIED', 'DUPLICATE']);
    expect(run.results[2]!.map((r) => r.status)).toEqual(['DUPLICATE', 'APPLIED', 'DUPLICATE']);
    expect(run.results[3]![0]!.status).toBe('DUPLICATE');
    expect(run.state.tasks).toHaveLength(2);
    expect(candidate(run.state).interviewReadyDay).toBe(3);
  });
});

describe('P0-M2A-04 고용: 계약금 한 번, 다음 날부터 배정·급여', () => {
  it('550,000원 계약금을 내고 다음 날부터 목록·급여·실제 준비 처리량에 반영한다', () => {
    const ready = until(3, config, { ...script, 1: [scout(), trade()] });
    const p = plan(ready, [hire(), assign('EMP04')]);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(p.results[1]!.reasonKo).toContain('5일부터');
    expect(candidate(p.state)).toMatchObject({ stage: 'HIRED', hiredDay: spec.hired_day });
    expect(p.state.employees.find((e) => e.id === 'EMP04')!.availableFromDay).toBe(spec.available_from_day);
    expect(isEmployed(p.state, 'EMP04')).toBe(true);
    expect(employedDefs(p.state, config)).toHaveLength(2);
    const def = config.employees.find((e) => e.id === 'EMP04')!;
    expect(crewCard(def, p.state, false, config)).toBe('');
    const report = companyReport(p.state, config).payroll;
    expect(report.recruitmentExpense).toBe(spec.signing_fee);
    expect(report.wageExpense).toBe(companyReport(ready, config).payroll.wageExpense);
    expect(companyReport(ready, config).payroll.cash - report.cash).toBe(spec.signing_fee);
    expect(report.totalAssets).toBe(report.openingEquity + report.profit + report.accountsPayable);
    const day5 = runDays(ready, config, 4, { 4: [hire(), assign('EMP04')] }).state;
    expect(wages(day5)).toEqual([]);
    expect(employedDefs(day5, config)).toHaveLength(3);
    expect(crewCard(def, day5, false, config)).toContain('현돌 직원 카드');
    const done = runDays(day5, config, 5, { 5: [assign('EMP04', 'NEXT')] }).state;
    expect(wages(done).map((e) => e.day)).toEqual([spec.available_from_day]);
    expect(wages(done)[0]!.lines[0]!.amount).toBe(spec.daily_wage);
    expect(done.tasks.find((t) => t.id === 'TASK001')).toMatchObject({ status: 'DONE', completedDay: 5, assignedEmployeeId: 'EMP04' });
    expect(done.cargoLots[0]!.status).toBe('AWAITING_DEPARTURE');
    checkInvariants(p.state, config);
    checkInvariants(done, config);
  });

  it('같은 날 고용한 직원을 포함한 일괄 확정은 수락까지 철회한다', () => {
    // 의뢰 담당 처리량만 3pt로 둬 견적 유효기간인 3일에 고용·일괄 확정을 시도한다.
    const fast = { ...config, employees: config.employees.map((e) => e.id === 'EMP01' ? { ...e, workUnitsPerDay: 3 } : e) };
    const p = plan(until(2, fast), [hire(), trade('EMP04')], fast);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(p.results[1]!.reasonKo).toContain('4일부터');
    expect(p.state.contracts).toEqual([]);
    expect(summarize(p.state.ledger, 'USD').cash).toBe(config.startingCash.USD);
  });

  it('현돌은 근무 시작일부터 하루 3pt씩 처리하며 의뢰 업무와 같은 예약을 쓴다', () => {
    const heavy = { ...config, terms: { ...config.terms, prepWorkUnits: 6 } };
    const commands = { ...script, 1: [scout(), trade()], 5: [assign('EMP04')] };
    const day6 = until(5, heavy, commands);
    expect(runningTaskOf(day6, 'EMP04')).toMatchObject({ kind: 'EXPORT_PREP', progressWorkUnits: 3 });
    expect(plan(day6, [quest('Q6', 'EMP06', 'EMP04')], heavy).results[0]!.reasonKo).toContain('다른 업무');
    const done = runDays(day6, heavy, 6).state;
    expect(done.tasks.find((t) => t.id === 'TASK001')).toMatchObject({ progressWorkUnits: 6, status: 'DONE', completedDay: 6 });
    checkInvariants(done, heavy);
  });

  it('동일 ID는 DUPLICATE, 새 ID 재고용은 거절하며 저장 뒤에도 계약금은 한 번이다', () => {
    const p = plan(until(3), [hire(), hire(), hire('NEW')]);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'DUPLICATE', 'REJECTED']);
    const restored = deserializeSave(serializeSave(p.state), { dataVersion: config.dataVersion });
    const again = plan(restored, [hire(), hire('AFTER-LOAD')]);
    expect(again.results.map((r) => r.status)).toEqual(['DUPLICATE', 'REJECTED']);
    expect(again.state.ledger.entries.filter((e) => e.id === 'SIGNING-EMP04')).toHaveLength(1);
    expect(summarize(again.state.ledger, 'KRW').recruitmentExpense).toBe(spec.signing_fee);
    checkInvariants(again.state, config);
  });

  it.each([1, 2, 3, 4])('%i일 영입 진행 저장·불러오기 뒤 상태·장부가 연속 실행과 같다', (day) => {
    const commands = { ...script, 1: [scout(), trade()], 5: [assign('EMP04')] };
    const partial = until(day, config, commands);
    const reloaded = deserializeSave(serializeSave(partial), { dataVersion: config.dataVersion, rulesVersion: config.rules.rulesVersion });
    const continued = runDays(reloaded, config, 7, commands).state;
    expect(continued).toEqual(until(7, config, commands));
    checkInvariants(continued, config);
  });

  it('시작 원화 부족 시 고용을 거절하고 장부·후보·업무·미지급 의무를 그대로 둔다', () => {
    const poor: ScenarioConfig = { ...config, startingCash: { ...config.startingCash, KRW: 1_000_000 } };
    const s = openDay(until(3, poor), poor).state;
    const p = plan(s, [hire()], poor);
    expect(p.results[0]!.reasonKo).toContain('계약금 자금이 부족');
    unchangedExceptCommand(s, p.state);
    expect(p.state.obligations).toEqual([]);
    checkInvariants(p.state, poor);
  });

  it('일급 0원 후보는 장부 기록 없이 고용하고 다음 날부터 업무를 맡는다', () => {
    const free = { ...config, employees: config.employees.map((e) => e.id === 'EMP04' ? { ...e, salaryPerDayMinor: 0 } : e) };
    const ready = until(3, free, { ...script, 1: [scout(), trade()] });
    const p = plan(ready, [hire(), assign('EMP04')], free);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(p.results[1]!.reasonKo).toContain('5일부터');
    expect(p.state.ledger).toEqual(ready.ledger);
    expect(candidate(p.state)).toMatchObject({ stage: 'HIRED', hiredDay: 4 });
    expect(p.state.employees.find((e) => e.id === 'EMP04')!.availableFromDay).toBe(5);
    const next = runDays(p.state, free, 4).state;
    const assigned = plan(next, [assign('EMP04', 'NEXT')], free);
    expect(assigned.results[0]!.status).toBe('APPLIED');
    const done = runDays(assigned.state, free, 5).state;
    expect(done.tasks.find((t) => t.id === 'TASK001')!.status).toBe('DONE');
    expect(wages(done)).toEqual([]);
    expect(done.ledger.entries.some((e) => e.id === 'SIGNING-EMP04')).toBe(false);
    checkInvariants(done, free);
  });

  it.each([0, 1])('사용 가능 원화가 계약금보다 %i원 적을 때 경계값을 지킨다', (shortfall) => {
    const cfg = { ...config, startingCash: { ...config.startingCash, KRW: 3 * 160_000 + spec.signing_fee! - shortfall } };
    const s = openDay(until(3, cfg), cfg).state;
    expect(summarize(s.ledger, 'KRW').cash).toBe(spec.signing_fee! - shortfall);
    const p = plan(s, [hire()], cfg);
    expect(p.results[0]!.status).toBe(shortfall === 0 ? 'APPLIED' : 'REJECTED');
    if (shortfall === 0) {
      expect(summarize(p.state.ledger, 'KRW').cash).toBe(0);
      expect(candidate(p.state).stage).toBe('HIRED');
    } else {
      expect(p.results[0]!.reasonKo).toContain('계약금 자금이 부족');
      unchangedExceptCommand(s, p.state);
    }
    checkInvariants(p.state, cfg);
  });

  it('현금이 계약금보다 많아도 같은 통화 미지급 의무를 빼면 부족할 수 있다', () => {
    const s = openDay(until(3), config).state;
    const cash = summarize(s.ledger, 'KRW').cash;
    const debt = cash - spec.signing_fee! + 1;
    post(s.ledger, { id: 'OLD-DEBT', day: 3, currency: 'KRW', reason: '기존 미지급 비용 검증', lines: [
      { account: 'CANCELLATION_EXPENSE', amount: debt }, { account: 'ACCOUNTS_PAYABLE', amount: -debt },
    ] });
    s.obligations.push({ id: 'OLD-DEBT', currency: 'KRW', amountMinor: debt, reasonKo: '기존 비용', incurredDay: 3, paidDay: null });
    const p = plan(s, [hire()]);
    expect(cash).toBeGreaterThan(spec.signing_fee!);
    expect(p.results[0]!.status).toBe('REJECTED');
    unchangedExceptCommand(s, p.state);
    checkInvariants(p.state, config);
  });

  it('같은 날 두 고용을 누적 검증할 때 먼저 낸 계약금만큼 가용 자금이 줄어든다', () => {
    const limited = { ...config, startingCash: { ...config.startingCash, KRW: 1_180_000 } };
    const ready = until(3, limited, { 1: [scout()], 2: [quest(), quest('Q6', 'EMP06', 'EMP02')] });
    const p = plan(ready, [hire(), hire('H6', 'EMP06')], limited);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(candidate(p.state, 'EMP06').stage).toBe('INTERVIEW_READY');
    expect(summarize(p.state.ledger, 'KRW').cash).toBe(150_000);
    expect(p.state.obligations).toEqual([]);
    checkInvariants(p.state, limited);
  });

  it('라운지·무역회관·항만의 네 후보 모두 자기 일급으로 순차 고용할 수 있다', () => {
    const commands: DayScript = {
      1: [scout()], 2: [quest()],
      4: [hire(), scout('LOUNGE', 'VEN_LOUNGE'), quest('Q6', 'EMP06')],
      6: [hire('H6', 'EMP06'), quest('Q3', 'EMP03', 'EMP04'), scout('TRADE-SITE', 'VEN_TRADE')],
      7: [hire('H3', 'EMP03'), quest('Q5', 'EMP05', 'EMP04')],
      8: [hire('H5', 'EMP05')],
    };
    const run = runDays(createGame(config), config, 9, commands);
    expect(Object.values(run.results).flat().every((r) => r.status === 'APPLIED')).toBe(true);
    expect(run.state.recruitment.candidates.every((c) => c.stage === 'HIRED')).toBe(true);
    expect(employedDefs(run.state, config)).toHaveLength(6);
    expect(summarize(run.state.ledger, 'KRW').recruitmentExpense).toBe(2 * 550_000 + 2 * 450_000);
    checkInvariants(run.state, config);
  });
});

describe('저장 이관·기준 경로·불변 조건', () => {
  it('판본 2는 새 문구로 거절한다', () => {
    const file = { ...JSON.parse(serializeSave(createGame(config))), formatVersion: 2 };
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion })).toThrow(`이전 저장 형식(판본 ${2})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });
  it('현재 저장 판본은 7이다', () => { expect(SAVE_FORMAT_VERSION).toBe(7); });

  it('M1은 세 영입 명령을 모두 거절하며 업무·장부가 바뀌지 않는다', () => {
    const m1 = loadScenario('SCENARIO_M1_ONE_TRADE');
    const s = openDay(createGame(m1), m1).state;
    const p = plan(s, [scout(), quest(), hire()], m1);
    expect(p.results.every((r) => r.status === 'REJECTED' && r.reasonKo.includes('이 시나리오'))).toBe(true);
    unchangedExceptCommand(s, p.state);
    checkInvariants(p.state, m1);
  });

  it('영입 없는 M2 17일 경로는 3,500 USD와 기존 원화 급여를 유지한다', () => {
    const path = expectedM2('SCENARIO_M2_MULTI_TRADE').paths.find((p) => p.id === 'PATH_COSMETICS_AND_FORWARDING')!;
    const commands: DayScript = {
      1: [
        { id: 'T', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02', plan: { employeeId: 'EMP01', sailingId: 'ROUTE02-D002' } },
        { id: 'F1', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP02', sailingId: 'ROUTE01-D002' } },
        { id: 'F2', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_02', plan: { sailingId: 'ROUTE01-D009' } },
      ],
      2: [{ id: 'A3', type: 'ASSIGN_TASK', taskId: 'TASK003', employeeId: 'EMP01' }],
    };
    const s = until(17, config, commands);
    const oldConfig = { ...config, recruitment: null, employees: config.employees.slice(0, 2) };
    expect(s.ledger).toEqual(until(17, oldConfig, commands).ledger);
    expect(summarize(s.ledger, 'USD').cash).toBe((path.cash_final as number) * 100);
    expect(summarize(s.ledger, 'KRW').wageExpense).toBe(17 * 160_000);
    expect(summarize(s.ledger, 'KRW').recruitmentExpense).toBe(0);
    checkInvariants(s, config);
  });

  it('중복 업무 ID를 불변 조건 위반으로 탐지한다', () => {
    const s = until(2);
    s.tasks.push(structuredClone(s.tasks[0]!));
    expect(() => checkInvariants(s, config)).toThrow(/업무 ID는 유일/);
  });

  it('후보의 진행 업무·급여, 고용 상태 불일치, 이른 급여, 중복 계약금을 탐지한다', () => {
    const workingCandidate = until(2);
    workingCandidate.tasks.find((t) => t.kind === 'RECRUIT_QUEST')!.assignedEmployeeId = 'EMP04';
    expect(() => checkInvariants(workingCandidate, config)).toThrow(/근무 가능한 고용 직원/);
    const hired = until(5);
    const mismatch = structuredClone(hired);
    mismatch.employees.find((e) => e.id === 'EMP04')!.employmentStatus = 'candidate';
    expect(() => checkInvariants(mismatch, config)).toThrow(/고용 확정 후보/);
    expect(() => checkInvariants(mismatch, config)).toThrow(/미고용 직원의 급여/);
    const early = structuredClone(hired);
    wages(early)[0]!.day = 4;
    expect(() => checkInvariants(early, config)).toThrow(/근무 시작일 이전 급여/);
    const duplicate = structuredClone(hired);
    duplicate.ledger.entries.push(structuredClone(duplicate.ledger.entries.find((e) => e.id === 'SIGNING-EMP04')!));
    expect(() => checkInvariants(duplicate, config)).toThrow(/계약금 중복/);
  });
});
