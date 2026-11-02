import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { crewStatusKo, taskSchedule } from '../ui/crew-status';
import { commitDay, createGame, EngineError, openDay, planState } from './engine';
import * as growth from './growth';
import { balance, post } from './ledger';
import { formatMoney, type Currency } from './money';
import { cashLessUnpaidMinor, fundsPosition, trainingAvailableMinor } from './reservations';
import * as tasks from './tasks';
import type { Command, GameState, ScenarioConfig, Task } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const trade: Command = { id: 'TRADE', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01', plan: { employeeId: 'EMP01' } };
const cases: { kind: Task['kind']; dayBased: boolean; subject: string | null; status: string; schedule: string; log: string; command: Command; reward: growth.XpRewardKind; amount: number }[] = [
  { kind: 'EXPORT_PREP', dayBased: false, subject: 'CT001', status: '● 업무 중', schedule: '수출 준비 중 — CT001 0/2pt',
    log: '귀솔에게 CT001 수출 준비 업무 배정 (2 업무 포인트)', command: trade, reward: 'TASK_COMPLETION_XP', amount: 10 },
  { kind: 'FORWARDING_PREP', dayBased: false, subject: 'CT001', status: '● 업무 중', schedule: '주선 준비 중 — CT001 0/2pt',
    log: '귀솔에게 CT001 운송 주선 준비(화물 인수·선적 서류) 업무 배정 (2 업무 포인트)',
    command: { id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP01' } }, reward: 'TASK_COMPLETION_XP', amount: 10 },
  { kind: 'SCOUT', dayBased: false, subject: '항만 물류단지', status: '● 업무 중', schedule: '현장 조사 중 — 항만 물류단지 0/1pt',
    log: '귀솔에게 항만 물류단지 현장 조사 업무 배정 (1 업무 포인트)',
    command: { id: 'SCOUT', type: 'SCOUT_SITE', venueId: 'VEN_PORT', employeeId: 'EMP01' }, reward: 'TASK_COMPLETION_XP', amount: 10 },
  { kind: 'RECRUIT_QUEST', dayBased: false, subject: '현돌', status: '● 업무 중', schedule: '영입 의뢰 중 — 현돌 0/3pt',
    log: '귀솔에게 현돌 영입 의뢰 업무 배정 (3 업무 포인트)',
    command: { id: 'QUEST', type: 'START_RECRUIT_QUEST', candidateId: 'EMP04', employeeId: 'EMP01' }, reward: 'TASK_COMPLETION_XP', amount: 10 },
  { kind: 'TRAINING', dayBased: true, subject: null, status: '◆ 교육 중 0/1일', schedule: '일반 훈련 중 — 0/1일',
    log: '귀솔 일반 훈련 시작 (1일, 훈련비 50,000원)',
    command: { id: 'TRAIN', type: 'START_TRAINING', employeeId: 'EMP01' }, reward: 'TRAINING_XP', amount: 60 },
];

afterEach(() => vi.restoreAllMocks());

describe('다섯 업무의 기존 값·문장 보존', () => {
  it.each(cases)('$kind: 진행 단위·대상·배정 로그·직원 표시·보상이 같다', c => {
    const s = openDay(createGame(config), config).state;
    if (c.kind === 'RECRUIT_QUEST') s.recruitment.candidates.find(e => e.employeeId === 'EMP04')!.stage = 'DISCOVERED';
    const p = planState(s, config, [c.command]);
    expect(p.results[0]!.status).toBe('APPLIED');
    const task = p.state.tasks[0]!;
    expect(task.kind).toBe(c.kind);
    expect(tasks.isDayBasedTask(c.kind)).toBe(c.dayBased);
    expect(tasks.taskSubjectKo(config, task)).toBe(c.subject);
    expect(p.state.log.at(-1)!.textKo).toBe(c.log);
    expect(crewStatusKo(task)).toBe(c.status);
    expect(taskSchedule(task, config)).toBe(c.schedule);
    expect(growth.completionReward(c.kind, config)).toEqual({ rewardKind: c.reward, amount: c.amount });
    expect(growth.completionReward(c.kind, { ...config, growth: null })).toBeNull();
  });

  it('대기 문구와 진행 중 교육 문구도 유지한다', () => {
    expect(crewStatusKo()).toBe('○ 대기');
    const task = { kind: 'TRAINING', progressWorkUnits: 1, requiredWorkUnits: 2, subjectId: 'EMP01' } as Task;
    expect(crewStatusKo(task)).toBe('◆ 교육 중 1/2일');
    expect(taskSchedule(task, config)).toBe('일반 훈련 중 — 1/2일');
  });

  it('3pt 직원도 일반 훈련은 하루에 1일만 진행한다', () => {
    const cfg = structuredClone(config);
    cfg.employees[0]!.workUnitsPerDay = 3;
    cfg.growth!.ordinaryTraining.durationDays = 3;
    const s = openDay(createGame(cfg), cfg).state;
    const next = commitDay(s, cfg, [{ id: 'TRAIN', type: 'START_TRAINING', employeeId: 'EMP01' }]).state;
    expect(next.tasks[0]).toMatchObject({ status: 'RUNNING', progressWorkUnits: 1, requiredWorkUnits: 3 });
  });
});

function unknownTaskState() {
  const s = openDay(createGame(config), config).state;
  s.tasks.push({ id: 'UNKNOWN-TASK', kind: 'UNKNOWN' as Task['kind'], contractId: null, subjectId: null,
    cityId: 'PYEONGTAEK', status: 'RUNNING', requiredWorkUnits: 1, progressWorkUnits: 0,
    assignedEmployeeId: 'EMP01', startedDay: 1, completedDay: null });
  return s;
}
function rejectUnknownCompletion() {
  const s = unknownTaskState();
  const before = structuredClone(s);
  expect(() => commitDay(s, config, [])).toThrow(EngineError);
  expect(s).toEqual(before);
  expect(s.log.some(l => l.textKo.includes('출발 대기'))).toBe(false);
}

describe('모르는 업무 종류는 조용히 처리하지 않는다', () => {
  it('실제 하루 진행은 EngineError이며 입력·로그를 보존한다', rejectUnknownCompletion);

  it('진행 단위를 통과시켜도 완료 분기 자체가 EngineError를 던진다', () => {
    // 완료 분기의 방어를 단위·보상 검사와 분리한다. 옛 else 복원 변형을 직접 잡는다.
    vi.spyOn(tasks, 'isDayBasedTask').mockReturnValue(false);
    vi.spyOn(growth, 'awardTaskCompletion').mockReturnValue(false);
    rejectUnknownCompletion();
  });

  it('대상·단위·직원 표시·보상 함수도 알 수 없는 종류를 거절한다', () => {
    const task = unknownTaskState().tasks[0]!;
    expect(() => tasks.taskSubjectKo(config, task)).toThrow(EngineError);
    expect(() => tasks.isDayBasedTask(task.kind)).toThrow(EngineError);
    expect(() => crewStatusKo(task)).toThrow(EngineError);
    expect(() => growth.completionReward(task.kind, config)).toThrow(EngineError);
    expect(() => growth.completionReward(task.kind, { ...config, growth: null })).toThrow(EngineError);
  });
});

function fundsCase(name: string): { s: GameState; cfg: ScenarioConfig } {
  const cfg = loadScenario(name === 'M1 시작' ? 'SCENARIO_M1_ONE_TRADE' : 'SCENARIO_M2_MULTI_TRADE');
  let s = openDay(createGame(cfg), cfg).state;
  if (name === 'M2 계약 예약') s = planState(s, cfg, [trade]).state;
  if (name === '미지급 의무') {
    for (const currency of ['KRW', 'USD'] as const) {
      const amountMinor = currency === 'KRW' ? 120_000 : 1234;
      post(s.ledger, { id: `DEBT-${currency}`, day: 1, currency, reason: '미지급 의무 시험', lines: [
        { account: 'CANCELLATION_EXPENSE', amount: amountMinor }, { account: 'ACCOUNTS_PAYABLE', amount: -amountMinor },
      ] });
      s.obligations.push({ id: `DEBT-${currency}`, currency, amountMinor, reasonKo: '미지급 의무 시험', incurredDay: 1, paidDay: null });
      // 이미 낸 의무는 다시 빼지 않는다.
      s.obligations.push({ id: `PAID-${currency}`, currency, amountMinor: 777, reasonKo: '과거 지급', incurredDay: 1, paidDay: 1 });
    }
  }
  return { s, cfg };
}

const fundCases = [
  { name: 'M1 시작', USD: 1_000_000, KRW: 10_000_000 },
  { name: 'M2 시작', USD: 300_000, KRW: 10_000_000 },
  { name: 'M2 계약 예약', USD: 200_000, KRW: 10_000_000 },
  { name: '미지급 의무', USD: 298_766, KRW: 9_880_000 },
];

describe('현금에서 미지급 의무만 뺀 자금 보존', () => {
  it.each(fundCases)('$name: 두 통화 금액은 훈련·고용의 기존 기준과 같다', c => {
    const { s, cfg } = fundsCase(c.name);
    const before = structuredClone(s);
    for (const currency of ['KRW', 'USD'] as const) {
      const expected = c[currency];
      const oldFunds = fundsPosition(s, cfg, currency);
      expect(cashLessUnpaidMinor(s, cfg, currency)).toBe(expected);
      expect(trainingAvailableMinor(s, cfg, currency)).toBe(expected);
      expect(oldFunds.cash - oldFunds.unpaidObligations).toBe(expected);
      if (c.name === 'M2 계약 예약' && currency === 'USD') {
        expect(oldFunds.reserved).toBe(25_000);
        expect(oldFunds.available).toBe(175_000);
      }
    }
    expect(s).toEqual(before);
  });

  for (const currency of ['KRW', 'USD'] as const) {
    it.each(fundCases)(`$name: 고용 거절은 ${currency} 사용 가능 금액을 그대로 보여 준다`, c => {
      const { s, cfg } = fundsCase(c.name);
      // M1도 같은 자금 함수를 대조할 수 있도록 영입 자격만 시험 설정으로 연다.
      cfg.recruitment = structuredClone(config.recruitment);
      cfg.recruitment!.signingFeeWageDays = 1000;
      if (!cfg.employees.some(e => e.id === 'EMP04')) cfg.employees.push(structuredClone(config.employees.find(e => e.id === 'EMP04')!));
      const def = cfg.employees.find(e => e.id === 'EMP04')!;
      def.salaryCurrency = currency;
      if (!s.employees.some(e => e.id === 'EMP04')) s.employees.push({ id: 'EMP04', xp: 0, locationCityId: 'PYEONGTAEK', employmentStatus: 'candidate', availableFromDay: 1 });
      s.recruitment.candidates = [{ employeeId: 'EMP04', stage: 'INTERVIEW_READY', discoveredDay: 1,
        questTaskId: null, interviewReadyDay: 1, hiredDay: null }];
      const fee = 1000 * def.salaryPerDayMinor;
      const before = structuredClone(s);
      const p = planState(s, cfg, [{ id: 'HIRE', type: 'HIRE_CANDIDATE', candidateId: 'EMP04' }]);
      expect(p.results[0]!.status).toBe('REJECTED');
      expect(p.results[0]!.reasonKo).toBe(`영입 계약금 자금이 부족합니다. 필요 ${formatMoney(currency, fee)}, 사용 가능 ${formatMoney(currency, c[currency])}.`);
      expect({ ...p.state, processedCommands: before.processedCommands }).toEqual(before);
      expect(s).toEqual(before);
    });
  }

  it('미지급 의무가 현금을 넘어도 음수 값을 보존한다', () => {
    const { s, cfg } = fundsCase('미지급 의무');
    const currency: Currency = 'KRW';
    s.obligations.find(o => o.currency === currency && o.paidDay === null)!.amountMinor = balance(s.ledger, currency, 'CASH') + 1;
    expect(cashLessUnpaidMinor(s, cfg, currency)).toBe(-1);
    expect(trainingAvailableMinor(s, cfg, currency)).toBe(-1);
  });
});
