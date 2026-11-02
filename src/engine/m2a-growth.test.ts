// CHAR-ACC-01·02·08: 경험치·훈련을 실제 업무, 예약, 장부, 저장 경로에서 검증한다.
import { describe, expect, it } from 'vitest';
import acceptance from '../../tests/character_acceptance_cases.json';
import rules from '../../data/character_rules.json';
import { expectedTradeResult, loadScenario } from '../content/scenario';
import { crewCard } from '../ui/card';
import { taskSchedule } from '../ui/recruitment';
import { commitDay, createGame, openDay, planState } from './engine';
import { awardTaskCompletion, awardXp, levelFor, statsFor } from './growth';
import { checkInvariants } from './invariants';
import { post, summarize } from './ledger';
import { companyReport } from './reports';
import { runningTaskOf } from './reservations';
import { deserializeSave, SAVE_FORMAT_VERSION, SaveError, serializeSave } from './save';
import { runDays, standardDayOneCommands, type DayScript } from './testkit';
import type { Command, GameState, ScenarioConfig } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const employee = (s: GameState, id = 'EMP01') => s.employees.find((e) => e.id === id)!;
const training = (id = 'TRAIN', employeeId = 'EMP01'): Command => ({ id, type: 'START_TRAINING', employeeId });
const trade = (assigned = true): Command => ({ id: 'TRADE', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01', ...(assigned ? { plan: { employeeId: 'EMP01' } } : {}) });
const assign = (id = 'ASSIGN'): Command => ({ id, type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId: 'EMP01' });
const until = (day: number, cfg = config, script: DayScript = {}) => runDays(createGame(cfg), cfg, day, script).state;
const reload = (s: GameState, cfg = config) => deserializeSave(serializeSave(s), { dataVersion: cfg.dataVersion, config: cfg });

function unchangedExceptCommand(before: GameState, after: GameState) {
  expect({ ...after, processedCommands: before.processedCommands }).toEqual(before);
}

function withoutGrowth(state: GameState) {
  const s = structuredClone(state);
  for (const emp of s.employees) emp.xp = 0;
  s.xpAwards = {};
  s.xpAwardAmounts = {};
  s.log = s.log.filter((l) => !/레벨 \d+ 달성/.test(l.textKo));
  return s;
}

function fixtureConfig(): ScenarioConfig {
  const setup = acceptance.items.find((c) => c.id === 'CHAR-ACC-08')!.setup;
  const cfg = structuredClone(config);
  cfg.recruitment = null;
  cfg.employees = [cfg.employees[0]!];
  cfg.employees[0]!.salaryPerDayMinor = setup.regular_salary_due_krw!;
  cfg.startingCash.KRW = setup.starting_cash_krw!;
  cfg.growth!.ordinaryTraining = {
    currency: 'KRW', feeMinor: setup.general_training_fee_krw!,
    durationDays: setup.general_training_duration_days!, xpOnCompletion: setup.general_training_xp_on_completion!,
  };
  return cfg;
}

describe('CHAR-ACC-01 직원별 완료 경험치 중복 방지', () => {
  it('각자 준비 업무를 마친 두 직원에게 10씩 주고 완료 재처리·저장 뒤에도 한 번이다', () => {
    const s = until(2, config, { 1: [trade(), { id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP02' } }] });
    expect(employee(s).xp).toBe(10);
    expect(employee(s, 'EMP02').xp).toBe(10);
    expect(Object.keys(s.xpAwards).sort()).toEqual([
      'EMP01|TASK-DONE-TASK001|TASK_COMPLETION_XP',
      'EMP02|TASK-DONE-TASK002|TASK_COMPLETION_XP',
    ]);
    for (const state of [s, reload(s)]) {
      const before = structuredClone(state);
      for (const task of state.tasks) expect(awardTaskCompletion(state, config, task)).toBe(false);
      expect(state).toEqual(before);
      checkInvariants(state, config);
    }
  });

  it('CHAR-ACC-01 같은 완료 사건도 직원별로 지급하고 재전송을 차단한다', () => {
    const spec = acceptance.items.find((c) => c.id === 'CHAR-ACC-01')!.setup;
    let s = createGame(config);
    for (let retry = 0; retry < 3; retry++) {
      for (const id of ['EMP01', 'EMP02']) {
        expect(awardXp(s, config, id, spec.completed_event_id!, 'TASK_COMPLETION_XP', spec.xp_per_employee!)).toBe(retry === 0);
      }
      s = reload(s);
    }
    expect([employee(s).xp, employee(s, 'EMP02').xp]).toEqual([10, 10]);
    expect(Object.keys(s.xpAwards)).toHaveLength(2);
    checkInvariants(s, config);
  });

  it('취소·미배정·진행 중 준비 업무에는 경험치를 주지 않는다', () => {
    const s = until(1, config, { 1: [trade(), { id: 'CANCEL', type: 'CANCEL_CONTRACT', contractId: 'CT001' }] });
    expect(s.tasks[0]!.status).toBe('ABORTED');
    expect(awardTaskCompletion(s, config, s.tasks[0]!)).toBe(false);
    expect(awardXp(s, config, 'EMP01', 'TASK-DONE-TASK001', 'TASK_COMPLETION_XP', 10)).toBe(false);
    expect(employee(s).xp).toBe(0);
    expect(s.xpAwards).toEqual({});
    const slow = { ...config, terms: { ...config.terms, prepWorkUnits: 100 } };
    for (const assigned of [false, true]) {
      const incomplete = until(1, slow, { 1: [trade(assigned)] });
      expect(awardTaskCompletion(incomplete, slow, incomplete.tasks[0]!)).toBe(false);
      expect(employee(incomplete).xp).toBe(0);
      checkInvariants(incomplete, slow);
    }
    checkInvariants(s, config);
  });

  it('조사·영입 의뢰는 완료 담당자에게만 각각 10을 주며 고용 때 경험치를 초기화하지 않는다', () => {
    const cfg = structuredClone(config);
    cfg.employees.find((e) => e.id === 'EMP04')!.growth!.startXp = 90;
    const script: DayScript = {
      1: [{ id: 'SCOUT', type: 'SCOUT_SITE', venueId: 'VEN_PORT', employeeId: 'EMP02' }],
      2: [{ id: 'QUEST', type: 'START_RECRUIT_QUEST', candidateId: 'EMP04', employeeId: 'EMP01' }],
      4: [{ id: 'HIRE', type: 'HIRE_CANDIDATE', candidateId: 'EMP04' }],
      5: [training('NEW-HIRE', 'EMP04')],
    };
    expect(employee(until(4, cfg, script), 'EMP04').xp).toBe(90);
    const s = until(5, cfg, script);
    expect([employee(s).xp, employee(s, 'EMP02').xp, employee(s, 'EMP04').xp]).toEqual([10, 10, 150]);
    checkInvariants(s, cfg);
  });
});

describe('CHAR-ACC-02 누적 경험치로 레벨·능력 재계산', () => {
  it('CHAR-ACC-02 90에서 230을 받아 320·레벨 3·54/42가 되고 다시 계산해도 같다', () => {
    const spec = acceptance.items.find((c) => c.id === 'CHAR-ACC-02')!;
    const cfg = fixtureConfig();
    const def = cfg.employees[0]!;
    def.growth = { baseStats: { primary: spec.setup.primary_ability!, secondary: spec.setup.secondary_ability! }, primaryStat: 'primary', secondaryStat: 'secondary', startXp: spec.setup.cumulative_xp! };
    const s = createGame(cfg);
    const initialDef = structuredClone(def);
    expect(awardXp(s, cfg, def.id, 'MULTI-LEVEL', 'TASK_COMPLETION_XP', spec.setup.award_xp!)).toBe(true);
    for (const state of [s, reload(s, cfg)]) {
      expect(employee(state).xp).toBe(spec.expected.cumulative_xp);
      expect(levelFor(employee(state).xp)).toBe(spec.expected.level);
      expect(statsFor(def, employee(state).xp)).toEqual({ primary: spec.expected.primary_ability, secondary: spec.expected.secondary_ability });
      expect(crewCard(def, state, false, cfg)).toContain(`레벨 ${spec.expected.level}`);
      checkInvariants(state, cfg);
    }
    const levelLogs = spec.expected.crossed_thresholds!.map((xp) =>
      `${def.nameKo} 레벨 ${rules.xp_thresholds.find((t) => t.cumulative_xp === xp)!.level} 달성`);
    expect(s.log.filter((l) => l.textKo.includes('레벨')).map((l) => l.textKo)).toEqual(levelLogs);
    expect(def).toEqual(initialDef);
    expect(JSON.parse(serializeSave(s)).state.employees[0]).not.toHaveProperty('level');
    expect(JSON.parse(serializeSave(s)).state.employees[0]).not.toHaveProperty('stats');
  });

  it('모든 문턱의 직전·정확한 값과 레벨 10·능력 100 상한을 지킨다', () => {
    for (const t of rules.xp_thresholds) {
      expect(levelFor(t.cumulative_xp)).toBe(t.level);
      if (t.level > 1) expect(levelFor(t.cumulative_xp - 1)).toBe(t.level - 1);
    }
    const def = structuredClone(config.employees[0]!);
    def.growth = { baseStats: { primary: 99, secondary: 99, other: 40 }, primaryStat: 'primary', secondaryStat: 'secondary', startXp: 0 };
    expect(levelFor(1_000_000)).toBe(10);
    expect(statsFor(def, 1_000_000)).toEqual({ primary: 100, secondary: 100, other: 40 });
  });
});

describe('CHAR-ACC-08 일반 훈련 비용·급여·예약', () => {
  it('CHAR-ACC-08 훈련비 20,000·급여 10,000·현금 470,000·경험치 60이며 중복하지 않는다', () => {
    const cfg = fixtureConfig();
    const spec = acceptance.items.find((c) => c.id === 'CHAR-ACC-08')!.expected;
    const direct = commitDay(openDay(createGame(cfg), cfg).state, cfg, [training()]);
    expect(direct.results[0]!.status).toBe('APPLIED');
    expect(companyReport(direct.state, cfg).payroll).toMatchObject({
      trainingExpense: spec.training_fee_expense_krw, wageExpense: spec.regular_salary_expense_krw,
      cash: spec.ending_cash_krw,
    });
    expect(employee(direct.state).xp).toBe(spec.cumulative_xp);
    const opened = openDay(createGame(cfg), cfg).state;
    const started = planState(opened, cfg, [training(), training(), training('SECOND')]);
    expect(started.results.map((r) => r.status)).toEqual(['APPLIED', 'DUPLICATE', 'REJECTED']);
    expect(runningTaskOf(started.state, 'EMP01')!.id).toBe('TRAINING-EMP01-D1');
    expect(companyReport(started.state, cfg).payroll.trainingExpense).toBe(spec.training_fee_expense_krw);
    expect(companyReport(started.state, cfg).payroll.wageExpense).toBe(0);
    const restoredStart = reload(started.state, cfg);
    const done = commitDay(restoredStart, cfg, [training()]).state;
    const report = companyReport(done, cfg).payroll;
    expect(report.trainingExpense).toBe(spec.training_fee_expense_krw);
    expect(report.wageExpense).toBe(spec.regular_salary_expense_krw);
    expect(report.cash).toBe(spec.ending_cash_krw);
    expect(cfg.startingCash.KRW! - report.cash).toBe(spec.total_cash_outflow_krw);
    expect(report.profit).toBe(-30_000);
    expect(report.totalAssets).toBe(report.openingEquity + report.profit + report.accountsPayable);
    expect(employee(done).xp).toBe(spec.cumulative_xp);
    expect(levelFor(employee(done).xp)).toBe(spec.level);
    expect(Object.keys(done.xpAwards)).toEqual(['EMP01|TASK-DONE-TRAINING-EMP01-D1|TRAINING_XP']);
    expect(awardXp(done, cfg, 'EMP01', 'TASK-DONE-TRAINING-EMP01-D1', 'TASK_COMPLETION_XP', 10)).toBe(false);
    expect(done.ledger.entries.filter((e) => e.id.startsWith('WAGE-'))).toHaveLength(1);
    const restored = reload(done, cfg);
    expect(planState(restored, cfg, [training()]).state).toEqual(restored);
    expect(commitDay(restored, cfg, [training()], 1).state).toEqual(restored);
    expect(awardTaskCompletion(restored, cfg, restored.tasks[0]!)).toBe(false);
    expect(restored).toEqual(done);
    checkInvariants(restored, cfg);
  });

  it('훈련 중 준비 업무는 거절하고 다음 날에는 배정한다', () => {
    const s = openDay(createGame(config), config).state;
    const p = planState(s, config, [trade(false), training(), assign()]);
    expect(p.results.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'REJECTED']);
    expect(p.state.tasks.find((t) => t.id === 'TASK001')!.status).toBe('QUEUED');
    expect(crewCard(config.employees[0]!, p.state, false, config)).toContain('0/1일');
    expect(taskSchedule(runningTaskOf(p.state, 'EMP01')!, config)).toContain('일반 훈련');
    const tomorrow = until(1, config, { 1: [trade(false), training()] });
    expect(planState(openDay(tomorrow, config).state, config, [assign('NEXT')]).results[0]!.status).toBe('APPLIED');
    checkInvariants(p.state, config);
  });

  it.each([0, 100])('직원 처리량 %i여도 이틀 훈련은 하루에 1일 진행하고 저장 뒤 이어진다', (workUnitsPerDay) => {
    const cfg = fixtureConfig();
    cfg.employees[0]!.workUnitsPerDay = workUnitsPerDay;
    cfg.growth!.ordinaryTraining.durationDays = 2;
    const first = until(1, cfg, { 1: [training()] });
    expect(first.tasks[0]).toMatchObject({ status: 'RUNNING', progressWorkUnits: 1 });
    expect(employee(first).xp).toBe(0);
    const second = runDays(reload(first, cfg), cfg, 2).state;
    expect(second).toEqual(until(2, cfg, { 1: [training()] }));
    expect(second.tasks[0]).toMatchObject({ status: 'DONE', completedDay: 2, progressWorkUnits: 2 });
    expect(employee(second).xp).toBe(60);
    expect(summarize(second.ledger, 'KRW')).toMatchObject({ trainingExpense: 20_000, wageExpense: 20_000 });
    checkInvariants(second, cfg);
  });

  it('자금이 1원 부족하면 명령 기록만 남기고, 정확한 금액이면 시작한다', () => {
    for (const shortfall of [1, 0]) {
      const cfg = fixtureConfig();
      cfg.startingCash.KRW = cfg.growth!.ordinaryTraining.feeMinor - shortfall;
      const s = openDay(createGame(cfg), cfg).state;
      const p = planState(s, cfg, [training()]);
      expect(p.results[0]!.status).toBe(shortfall ? 'REJECTED' : 'APPLIED');
      if (shortfall) unchangedExceptCommand(s, p.state);
      else expect(summarize(p.state.ledger, 'KRW').cash).toBe(0);
      checkInvariants(p.state, cfg);
    }
  });

  it('현금에서 미지급 의무를 빼고 훈련을 판단한다', () => {
    const cfg = fixtureConfig();
    const s = openDay(createGame(cfg), cfg).state;
    const debt = 480_001;
    post(s.ledger, { id: 'DEBT', day: 1, currency: 'KRW', reason: '미지급 비용 검증', lines: [{ account: 'CANCELLATION_EXPENSE', amount: debt }, { account: 'ACCOUNTS_PAYABLE', amount: -debt }] });
    s.obligations.push({ id: 'DEBT', currency: 'KRW', amountMinor: debt, reasonKo: '미지급 비용', incurredDay: 1, paidDay: null });
    const p = planState(s, cfg, [training()]);
    expect(p.results[0]!.reasonKo).toContain('훈련비 자금이 부족');
    unchangedExceptCommand(s, p.state);
    checkInvariants(p.state, cfg);
  });

  it('후보·없는 직원·근무 시작 전·다른 도시·업무 중 훈련은 명령 기록 외 상태를 보존한다', () => {
    for (const employeeId of ['EMP04', 'MISSING']) {
      const s = openDay(createGame(config), config).state;
      const p = planState(s, config, [training('REJECT', employeeId)]);
      expect(p.results[0]!.status).toBe('REJECTED');
      unchangedExceptCommand(s, p.state);
    }
    for (const reason of ['future', 'city', 'busy']) {
      let s = openDay(createGame(config), config).state;
      if (reason === 'future') employee(s).availableFromDay = 2;
      if (reason === 'city') employee(s).locationCityId = 'HAIPHONG';
      if (reason === 'busy') s = planState(s, config, [trade()]).state;
      const p = planState(s, config, [training()]);
      expect(p.results[0]!.status).toBe('REJECTED');
      unchangedExceptCommand(s, p.state);
      expect(p.state.processedCommands.TRAIN).toMatchObject({ status: 'REJECTED' });
      if (reason === 'busy') {
        expect(s.processedCommands.TRADE).toMatchObject({ status: 'APPLIED' });
        expect(p.state.processedCommands.TRADE).toEqual(s.processedCommands.TRADE);
      }
      checkInvariants(p.state, config);
    }
  });
});

describe('기준 경로·판본 이관·불변 조건', () => {
  it('M1에서는 훈련·경험치를 끄고 기존 거래 검산을 유지한다', () => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    const s = openDay(createGame(cfg), cfg).state;
    expect(cfg.growth).toBeNull();
    expect(cfg.employees.every((e) => e.growth === null)).toBe(true);
    const p = planState(s, cfg, [training()]);
    expect(p.results[0]!.status).toBe('REJECTED');
    unchangedExceptCommand(s, p.state);
    expect(awardXp(s, cfg, 'EMP01', 'DISABLED', 'TRAINING_XP', 60)).toBe(false);
    const done = until(17, cfg, { 1: standardDayOneCommands(cfg) });
    expect(employee(done).xp).toBe(0);
    expect(done.xpAwards).toEqual({});
    const contribution = expectedTradeResult('SCENARIO_M1_ONE_TRADE').contribution_before_payroll_usd!;
    expect(summarize(done.ledger, 'USD').cash).toBe(cfg.startingCash.USD! + contribution * 100);
    checkInvariants(done, cfg);
  });

  it('성장만 켠 M2 경로는 17일 현금 3,500 USD·급여 2,720,000원을 유지한다', () => {
    const script: DayScript = {
      1: [
        { id: 'T', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02', plan: { employeeId: 'EMP01', sailingId: 'ROUTE02-D002' } },
        { id: 'F1', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP02', sailingId: 'ROUTE01-D002' } },
        { id: 'F2', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_02', plan: { sailingId: 'ROUTE01-D009' } },
      ], 2: [{ id: 'A3', type: 'ASSIGN_TASK', taskId: 'TASK003', employeeId: 'EMP01' }],
    };
    const s = until(17, config, script);
    const disabled = until(17, { ...config, growth: null }, script);
    expect(withoutGrowth(s)).toEqual(withoutGrowth(disabled));
    const highLevel = structuredClone(config);
    for (const def of highLevel.employees) def.growth!.startXp = 4500;
    const high = until(17, highLevel, script);
    expect(withoutGrowth(high)).toEqual(withoutGrowth(disabled));
    expect(high.ledger).toEqual(s.ledger);
    expect(high.tasks).toEqual(s.tasks);
    expect(high.shipments).toEqual(s.shipments);
    expect(summarize(s.ledger, 'USD').cash).toBe(350_000);
    expect(summarize(s.ledger, 'KRW')).toMatchObject({ wageExpense: 2_720_000, recruitmentExpense: 0, trainingExpense: 0 });
    expect([employee(s).xp, employee(s, 'EMP02').xp]).toEqual([20, 10]);
    checkInvariants(s, config);
  });

  it.each([1, 2, 3, 4])('판본 %i은 새 문구로 거절한다', (version) => {
    const file = { ...JSON.parse(serializeSave(createGame(config))), formatVersion: version };
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion })).toThrow(`이전 저장 형식(판본 ${version})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('판본 3은 새 문구로 거절한다', () => {
    const file = { ...JSON.parse(serializeSave(createGame(config))), formatVersion: 3 };
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion })).toThrow(`이전 저장 형식(판본 ${3})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('경험치 불일치·지급액 누락·중단 업무 보상·훈련비 중복을 탐지한다', () => {
    const cfg = fixtureConfig();
    const s = until(1, cfg, { 1: [training()] });
    const mismatch = structuredClone(s);
    employee(mismatch).xp++;
    expect(() => checkInvariants(mismatch, cfg)).toThrow(/경험치와 시작 경험치/);
    const missing = structuredClone(s);
    missing.xpAwardAmounts = {};
    expect(() => checkInvariants(missing, cfg)).toThrow(/경험치 지급 기록 오류/);
    const aborted = structuredClone(s);
    aborted.tasks[0]!.status = 'ABORTED';
    expect(() => checkInvariants(aborted, cfg)).toThrow(/ABORTED 업무/);
    const duplicate = structuredClone(s);
    duplicate.ledger.entries.push(structuredClone(duplicate.ledger.entries.find((e) => e.id.startsWith('TRAINING-FEE-'))!));
    expect(() => checkInvariants(duplicate, cfg)).toThrow(/훈련비 중복/);
    checkInvariants(s, cfg);
  });
});

describe('재작업 1 회귀 방어', () => {
  it('거절한 훈련 ID는 다음 날 조건을 갖춰도 DUPLICATE이며 훈련비가 빠지지 않는다', () => {
    const cfg = fixtureConfig();
    let s = openDay(createGame(cfg), cfg).state;
    employee(s).availableFromDay = 2;
    const rejected = planState(s, cfg, [training()]);
    expect(rejected.results[0]!.status).toBe('REJECTED');
    unchangedExceptCommand(s, rejected.state);
    s = openDay(commitDay(rejected.state, cfg, []).state, cfg).state;
    expect(planState(s, cfg, [training('FRESH')]).results[0]!.status).toBe('APPLIED');
    const retry = planState(s, cfg, [training()]);
    expect(retry.results[0]!.status).toBe('DUPLICATE');
    expect(rejected.state.processedCommands.TRAIN).toMatchObject({ status: 'REJECTED' });
    expect(retry.state).toEqual(s);
    expect(summarize(retry.state.ledger, 'KRW').trainingExpense).toBe(0);
  });

  it.each(['담당자 불일치', '미고용', '지급량 불일치', '적은 지급량', '보상 종류 불일치'])('awardXp는 %s에서 false이고 상태를 보존한다', (reason) => {
    const s = until(2, config, { 1: [trade()] });
    employee(s).xp = 0;
    s.xpAwards = {};
    s.xpAwardAmounts = {};
    if (reason === '미고용') employee(s).employmentStatus = 'candidate';
    const before = structuredClone(s);
    expect(awardXp(s, config, reason === '담당자 불일치' ? 'EMP02' : 'EMP01',
      'TASK-DONE-TASK001', reason === '보상 종류 불일치' ? 'TRAINING_XP' : 'TASK_COMPLETION_XP',
      reason === '지급량 불일치' ? 11 : reason === '적은 지급량' ? 9 : 10)).toBe(false);
    expect(s).toEqual(before);
  });

  it.each(['TRAINING', 'EXPORT_PREP', 'FORWARDING_PREP', 'SCOUT', 'RECRUIT_QUEST'])('%s 완료 로그 다음에 레벨 달성 로그를 쓴다', (kind) => {
    const cfg = structuredClone(config);
    for (const def of cfg.employees) def.growth!.startXp = 90;
    let s = openDay(createGame(cfg), cfg).state;
    const cmd: Command = kind === 'TRAINING' ? training() : kind === 'EXPORT_PREP' ? trade()
      : kind === 'FORWARDING_PREP' ? { id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP01' } }
      : kind === 'SCOUT' ? { id: 'SCOUT', type: 'SCOUT_SITE', venueId: 'VEN_PORT', employeeId: 'EMP01' }
      : { id: 'QUEST', type: 'START_RECRUIT_QUEST', candidateId: 'EMP04', employeeId: 'EMP01' };
    if (kind === 'RECRUIT_QUEST') s.recruitment.candidates.find((c) => c.employeeId === 'EMP04')!.stage = 'DISCOVERED';
    s = commitDay(s, cfg, [cmd]).state;
    if (s.tasks[0]!.status !== 'DONE') s = runDays(s, cfg, 3).state;
    const texts = s.log.map((l) => l.textKo);
    const complete = texts.findIndex((l) => l.startsWith('귀솔:') && l.includes('완료'));
    const level = texts.indexOf('귀솔 레벨 2 달성');
    expect(complete).toBeGreaterThanOrEqual(0);
    expect(level).toBeGreaterThan(complete);
  });

  function oldSave(cfg = config) {
    const file = JSON.parse(serializeSave(createGame(cfg)));
    file.formatVersion = 3;
    delete file.state.xpAwards;
    delete file.state.xpAwardAmounts;
    for (const e of file.state.employees) delete e.xp;
    return file;
  }

  it('판본 3은 새 문구로 거절한다', () => {
    const file = { ...JSON.parse(serializeSave(createGame(config))), formatVersion: 3 };
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion })).toThrow(`이전 저장 형식(판본 ${3})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('판본 7은 다른 시나리오 설정을 거절하고 판본 3은 새 문구로 거절한다', () => {
    const file = JSON.parse(serializeSave(createGame(config)));
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config: { ...config, id: 'OTHER' } });
    expect(load).toThrow('이관 설정과 저장 시나리오가 다릅니다.');
    file.formatVersion = 3;
    expect(load).toThrow(`이전 저장 형식(판본 ${3})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each([1, 2, 3, 4])('판본 7의 알 수 없는 시나리오와 옛 판본 %i를 거절한다', (version) => {
    const file = JSON.parse(serializeSave(createGame(config)));
    file.scenarioId = 'MISSING';
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion });
    expect(load).toThrow('알 수 없는 저장 시나리오입니다 (MISSING).');
    file.formatVersion = version;
    expect(load).toThrow(`이전 저장 형식(판본 ${version})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('훈련 업무 없는 훈련비와 업무 종류가 다른 보상 키를 탐지한다', () => {
    const cfg = fixtureConfig();
    const s = until(1, cfg, { 1: [training()] });
    const orphan = structuredClone(s);
    orphan.ledger.entries.find((e) => e.id.startsWith('TRAINING-FEE-'))!.id = 'ORPHAN';
    expect(() => checkInvariants(orphan, cfg)).toThrow(/훈련 업무 없는 훈련비/);
    const wrongKind = structuredClone(s);
    const key = Object.keys(wrongKind.xpAwards)[0]!;
    const wrongKey = key.replace('TRAINING_XP', 'TASK_COMPLETION_XP');
    wrongKind.xpAwards = { [wrongKey]: true };
    wrongKind.xpAwardAmounts = { [wrongKey]: 60 };
    expect(() => checkInvariants(wrongKind, cfg)).toThrow(/보상 종류가 다릅니다/);
  });

  it.each(['지급액 누락', '경험치 불일치', '배열 누락', '직원 모양', '장부 모양', '단계 오류'])('판본 7 %s를 불러올 때 SaveError로 거절한다', (reason) => {
    const cfg = fixtureConfig();
    const file = JSON.parse(serializeSave(until(1, cfg, { 1: [training()] })));
    if (reason === '지급액 누락') delete file.state.xpAwardAmounts;
    if (reason === '경험치 불일치') file.state.employees[0].xp++;
    if (reason === '배열 누락') delete file.state.tasks;
    if (reason === '직원 모양') file.state.employees[0].availableFromDay = '2';
    if (reason === '장부 모양') file.state.ledger.entries[0].lines = null;
    if (reason === '단계 오류') file.state.phase = 'INVALID';
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: cfg.dataVersion, config: cfg })).toThrow(SaveError);
    file.formatVersion = 4;
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config: cfg })).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each([1, 2, 3, 4])('판본 7의 모양·불변 조건과 옛 판본 %i 거절을 검사한다', (version) => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    for (const reason of ['shape', 'invariant']) {
      const file = JSON.parse(serializeSave(createGame(cfg)));
      if (reason === 'shape') file.state.obligations = null;
      else file.state.ledger.entries[0].lines[0].amount++;
      const load = () => deserializeSave(JSON.stringify(file), { dataVersion: cfg.dataVersion, config: cfg });
      expect(load).toThrow(SaveError);
      file.formatVersion = version;
      expect(load).toThrow(`이전 저장 형식(판본 ${version})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
    }
  });
});

describe('재작업 2 저장 검증·보상 방어', () => {
  it.each([
    ['state.offers[0]', (s: any) => { s.offers = [null]; }],
    ['state.log', (s: any) => { s.log = null; }],
    ['state.recruitment.scoutedVenueIds', (s: any) => { s.recruitment.scoutedVenueIds = null; }],
    ['state.employees[0].availableFromDay', (s: any) => { s.employees[0].availableFromDay = '1'; }],
    ['state.ledger.entries[0].lines', (s: any) => { s.ledger.entries[0].lines = {}; }],
  ] as const)('판본 7 모양 손상 %s를 정확한 경로의 SaveError로 거절한다', (path, corrupt) => {
    const file = JSON.parse(serializeSave(createGame(config)));
    corrupt(file.state);
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config });
    expect(load).toThrow(SaveError);
    expect(load).toThrow(path);
    file.formatVersion = 4;
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config: config })).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each(['state.scenarioId', 'state.rulesVersion', 'state.dataVersion', 'config.rulesVersion', 'config.dataVersion'])
  ('판본 7 메타 정보 불일치 %s를 거절한다', (field) => {
    const file = JSON.parse(serializeSave(createGame(config)));
    const cfg = structuredClone(config);
    if (field.startsWith('state.')) file.state.meta[field.split('.')[1]!] = 'MISMATCH';
    else if (field === 'config.rulesVersion') cfg.rules.rulesVersion = 'M1-rules-1';
    else cfg.dataVersion = 'MISMATCH';
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config: cfg });
    expect(load).toThrow(SaveError);
    expect(load).toThrow('저장 메타 정보와 설정이 다릅니다.');
    file.formatVersion = 4;
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config: cfg })).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it('판본 7는 설정을 전달하지 않는 화면 경로에서도 정상 복원하고 손상을 거절한다', () => {
    const state = until(1, config, { 1: [training()] });
    const file = JSON.parse(serializeSave(state));
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion });
    expect(load()).toEqual(state);
    file.state.offers = [null];
    expect(load).toThrow(SaveError);
    expect(load).toThrow('state.offers[0]');
    file.formatVersion = 4;
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion, config: config })).toThrow(`이전 저장 형식(판본 ${4})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each([
    ['employees', '직원'], ['tasks', '업무'], ['contracts', '계약'], ['ledger', '장부 항목'],
  ] as const)('판본 4 %s ID 중복을 거절한다', (field, label) => {
    const s = planState(openDay(createGame(config), config).state, config, [trade()]).state;
    const entries = field === 'ledger' ? s.ledger.entries : s[field];
    // 장부는 기초 자본 분개를 복제해 별도 훈련비 중복 방어에 기대지 않는다.
    entries.push(structuredClone(entries[0]!) as never);
    const load = () => reload(s);
    expect(load).toThrow(SaveError);
    expect(load).toThrow(`${label} ID는 유일해야 합니다`);
  });

  it.each(['업무 담당자', '계약 담당자', '영입 후보'])('판본 4 %s의 없는 직원 참조를 거절한다', (reference) => {
    const s = planState(openDay(createGame(config), config).state, config, [trade()]).state;
    if (reference === '업무 담당자') s.tasks[0]!.assignedEmployeeId = 'MISSING';
    if (reference === '계약 담당자') s.contracts[0]!.ownerEmployeeId = 'MISSING';
    if (reference === '영입 후보') s.recruitment.candidates[0]!.employeeId = 'MISSING';
    expect(() => reload(s)).toThrow(SaveError);
    expect(() => reload(s)).toThrow(`${reference} MISSING 직원이 없습니다`);
  });

  it('일반 업무에 TRAINING_XP를 기록하면 보상 종류 불일치를 탐지한다', () => {
    const s = until(2, config, { 1: [trade()] });
    const key = Object.keys(s.xpAwards)[0]!;
    const wrongKey = key.replace('TASK_COMPLETION_XP', 'TRAINING_XP');
    s.xpAwards = { [wrongKey]: true };
    s.xpAwardAmounts = { [wrongKey]: s.xpAwardAmounts[key]! };
    expect(() => checkInvariants(s, config)).toThrow(/보상 종류가 다릅니다/);
  });

  it('TRAINING-FEE- 접두어가 있어도 일치하는 훈련 업무가 없으면 비용을 거절한다', () => {
    const cfg = fixtureConfig();
    const s = until(1, cfg, { 1: [training()] });
    s.ledger.entries.find((e) => e.id.startsWith('TRAINING-FEE-'))!.id = 'TRAINING-FEE-MISSING';
    expect(() => checkInvariants(s, cfg)).toThrow(/훈련 업무 없는 훈련비/);
  });

  it('훈련 완료에 일반 업무 보상 종류를 요청하면 지급 전에 거절하고 상태를 보존한다', () => {
    const s = until(1, config, { 1: [training()] });
    employee(s).xp = 0;
    s.xpAwards = {};
    s.xpAwardAmounts = {};
    const before = structuredClone(s);
    expect(awardXp(s, config, 'EMP01', 'TASK-DONE-TRAINING-EMP01-D1', 'TASK_COMPLETION_XP', 60)).toBe(false);
    expect(s).toEqual(before);
  });
});

it('현재 저장 판본은 7이다', () => { expect(SAVE_FORMAT_VERSION).toBe(7); });
