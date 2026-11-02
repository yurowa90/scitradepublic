// 저장 불러오기 경계에서 모양·참조 검사를 우회하지 못하도록 한다.
import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { commitDay, createGame, openDay, planState } from './engine';
import { post } from './ledger';
import { createRng, drawUniform } from './rng';
import { deserializeSave, SaveError, serializeSave } from './save';
import { runDays } from './testkit';
import type { Command, GameState } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const trade: Command = { id: 'TRADE', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01',
  plan: { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' } };
const training: Command = { id: 'TRAIN', type: 'START_TRAINING', employeeId: 'EMP01' };
// 화면과 동일하게 설정 없이 시나리오를 복원한다.
const reload = (s: GameState) => deserializeSave(serializeSave(s), { dataVersion: config.dataVersion });
const planned = (command: Command) => planState(openDay(createGame(config), config).state, config, [command]).state;
const traded = (day: number) => runDays(createGame(config), config, day, { 1: [trade] }).state;
function reject(s: GameState, message: string) {
  expect(() => reload(s)).toThrow(SaveError);
  expect(() => reload(s)).toThrow(message);
}
function recruited(day: number) {
  return runDays(createGame(config), config, day, {
    1: [{ id: 'SCOUT', type: 'SCOUT_SITE', venueId: 'VEN_PORT', employeeId: 'EMP02' }],
    2: [{ id: 'QUEST', type: 'START_RECRUIT_QUEST', candidateId: 'EMP04', employeeId: 'EMP01' }],
    4: [{ id: 'HIRE', type: 'HIRE_CANDIDATE', candidateId: 'EMP04' }],
  }).state;
}

describe('이관 결과와 저장 모양 경로', () => {
  it.each([1, 2, 3, 4])('판본 7 offers[0] 손상과 옛 판본 %i 모양 손상을 경로로 거절한다', (version) => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    const file = JSON.parse(serializeSave(createGame(cfg)));
    file.state.offers = [null];
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: cfg.dataVersion });
    expect(load).toThrow(SaveError);
    expect(load).toThrow('state.offers[0]');
    file.formatVersion = version;
    expect(load).toThrow(`이전 저장 형식(판본 ${version})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });

  it.each([
    ['장부 양수 소수', 'state.ledger.entries[0].lines[0].amount', (s: GameState) => { s.ledger.entries[0]!.lines[0]!.amount = 0.5; s.ledger.entries[0]!.lines[1]!.amount = -0.5; }],
    ['장부 음수 소수', 'state.ledger.entries[0].lines[1].amount', (s: GameState) => { s.ledger.entries[0]!.lines[1]!.amount = -0.5; }],
    ['계약 소수 수량', 'state.contracts[0].quantity', (s: GameState) => { s.contracts[0]!.quantity = 1.5; }],
    ['난수 커서 소수', 'state.rng.cursors.trade', (s: GameState) => { s.rng.cursors.trade = 0.5; }],
    ['난수 커서 음수', 'state.rng.cursors.trade', (s: GameState) => { s.rng.cursors.trade = -1; }],
    ['난수 커서 문자열', 'state.rng.cursors.trade', (s: GameState) => { s.rng.cursors.trade = '0' as unknown as number; }],
    ['0일', 'state.day', (s: GameState) => { s.day = 0; }],
    ['음수 일자', 'state.day', (s: GameState) => { s.day = -1; }],
  ] as const)('%s는 정확한 경로의 SaveError다', (_label, path, corrupt) => {
    const s = planned(trade);
    corrupt(s);
    reject(s, path);
  });

  it.each(['scenarioId', 'rulesVersion', 'dataVersion'] as const)('설정 없는 화면 경로도 메타 %s 불일치를 거절한다', (field) => {
    const s = traded(1);
    expect(reload(s)).toEqual(s);
    const file = JSON.parse(serializeSave(s));
    file.state.meta[field] = 'MISMATCH';
    const load = () => deserializeSave(JSON.stringify(file), { dataVersion: config.dataVersion });
    expect(load).toThrow(SaveError);
    expect(load).toThrow('저장 메타 정보와 설정이 다릅니다.');
  });
});

describe('종료 상태도 포함하는 저장 불변 조건', () => {
  it.each(['employed', 'candidate'] as const)('%s 직원도 시나리오 정의가 반드시 있어야 한다', (status) => {
    const s = createGame(config);
    const employee = s.employees.find((e) => e.employmentStatus === status)!;
    // 관계와 보상이 없는 직원만 변경해 정의 검사 자체를 검증한다.
    const oldId = employee.id;
    employee.id = 'UNDEFINED';
    for (const candidate of s.recruitment.candidates) if (candidate.employeeId === oldId) candidate.employeeId = employee.id;
    reject(s, 'UNDEFINED: 직원 정의가 없습니다');
  });

  it.each(['고아', '누락', '같은 개수의 교체'])('ledger.postedIds의 %s 키를 거절한다', (kind) => {
    const s = createGame(config);
    const id = s.ledger.entries[0]!.id;
    if (kind !== '고아') delete s.ledger.postedIds[id];
    if (kind !== '누락') s.ledger.postedIds.ORPHAN = true;
    reject(s, 'ledger.postedIds와 실제 원장 항목 ID가 다릅니다');
  });

  it('DONE 업무의 중복 ID와 없는 담당자를 각각 거절한다', () => {
    const base = traded(1);
    expect(base.tasks[0]!.status).toBe('DONE');
    expect(reload(base)).toEqual(base);
    const duplicate = structuredClone(base);
    duplicate.tasks.push(structuredClone(duplicate.tasks[0]!));
    reject(duplicate, '업무 ID는 유일해야 합니다');
    base.tasks[0]!.assignedEmployeeId = 'MISSING';
    reject(base, '업무 담당자 MISSING 직원이 없습니다');
  });

  it.each(['IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const)('%s 계약의 중복 ID·없는 담당자·없는 준비 업무를 각각 거절한다', (status) => {
    const base = status === 'IN_PROGRESS' ? planned(trade) : status === 'COMPLETED' ? traded(17)
      : planState(openDay(createGame(config), config).state, config, [trade, { id: 'CANCEL', type: 'CANCEL_CONTRACT', contractId: 'CT001' }]).state;
    expect(base.contracts[0]!.status).toBe(status);
    expect(reload(base)).toEqual(base);
    const duplicate = structuredClone(base);
    duplicate.contracts.push(structuredClone(duplicate.contracts[0]!));
    reject(duplicate, '계약 ID는 유일해야 합니다');
    const owner = structuredClone(base);
    owner.contracts[0]!.ownerEmployeeId = 'MISSING';
    reject(owner, '계약 담당자 MISSING 직원이 없습니다');
    base.contracts[0]!.prepTaskId = 'MISSING';
    reject(base, '준비 업무 MISSING가 없습니다');
  });

  it.each([2, 4])('%i일 영입 후보의 중복과 없는 업무·직원 참조를 거절한다', (day) => {
    const base = recruited(day);
    const candidate = base.recruitment.candidates.find((c) => c.employeeId === 'EMP04')!;
    expect(candidate.stage).toBe(day === 4 ? 'HIRED' : 'QUEST_RUNNING');
    expect(reload(base)).toEqual(base);
    const duplicate = structuredClone(base);
    duplicate.recruitment.candidates.push(structuredClone(candidate));
    reject(duplicate, '영입 후보 직원 ID는 유일해야 합니다');
    const quest = structuredClone(base);
    quest.recruitment.candidates.find((c) => c.employeeId === 'EMP04')!.questTaskId = 'MISSING';
    reject(quest, '영입 의뢰 업무 MISSING가 없습니다');
    candidate.employeeId = 'MISSING';
    reject(base, '영입 후보 MISSING 직원이 없습니다');
  });

  it.each([2, 4])('%i일 진행 중·DONE 영입 의뢰의 없는 후보 참조를 거절한다', (day) => {
    const s = recruited(day);
    const task = s.tasks.find((t) => t.kind === 'RECRUIT_QUEST')!;
    expect(task.status).toBe(day === 4 ? 'DONE' : 'RUNNING');
    task.subjectId = 'MISSING';
    reject(s, '영입 의뢰 대상 MISSING 후보가 없습니다');
  });

  it('미고용 후보 직원의 중복 ID도 거절한다', () => {
    const s = createGame(config);
    const candidate = s.employees.find((e) => e.employmentStatus === 'candidate')!;
    s.employees.push(structuredClone(candidate));
    reject(s, '직원 ID는 유일해야 합니다');
  });

  it.each(['RUNNING', 'DONE'] as const)('%s 훈련의 비용 누락을 거절한다', (status) => {
    const s = status === 'RUNNING' ? planned(training) : runDays(createGame(config), config, 1, { 1: [training] }).state;
    expect(s.tasks[0]!.status).toBe(status);
    expect(reload(s)).toEqual(s);
    const feeId = s.ledger.entries.find((e) => e.id.startsWith('TRAINING-FEE-'))!.id;
    // 항목과 중복 방지 키를 함께 없애 장부 ID 검사에 기대지 않는다.
    s.ledger.entries = s.ledger.entries.filter((e) => e.id !== feeId);
    delete s.ledger.postedIds[feeId];
    reject(s, '훈련비 중복 또는 누락 기록');
  });

  it('일반 업무 TASK001을 가리키는 훈련비도 고아 비용이다', () => {
    const s = traded(1);
    post(s.ledger, { id: 'TRAINING-FEE-TASK001', day: s.day, currency: 'KRW', reason: '잘못된 훈련비 검증',
      lines: [{ account: 'TRAINING_EXPENSE', amount: 50_000 }, { account: 'CASH', amount: -50_000 }] });
    reject(s, '훈련 업무 없는 훈련비 기록');
  });
});

it.each([8, 19, 41, 73, 101, 208, 509, 1009])('시드 %i의 명령 혼합은 매일 저장 왕복 뒤에도 같은 상태로 진행한다', (seed) => {
  let uninterrupted = createGame(config);
  let restored = reload(uninterrupted);
  let rng = createRng(seed);
  const pool: Command[] = [trade, training,
    { id: '', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02', plan: { sailingId: 'ROUTE02-D009' } },
    { id: '', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { employeeId: 'EMP02', sailingId: 'ROUTE01-D009' } },
    { id: '', type: 'CANCEL_CONTRACT', contractId: 'CT001' },
    { id: '', type: 'CANCEL_CONTRACT', contractId: 'CT002' },
    { id: '', type: 'SCOUT_SITE', employeeId: 'EMP02', venueId: 'VEN_PORT' },
    { id: '', type: 'START_RECRUIT_QUEST', employeeId: 'EMP01', candidateId: 'EMP04' },
    { id: '', type: 'HIRE_CANDIDATE', candidateId: 'EMP04' },
    { id: '', type: 'START_TRAINING', employeeId: 'EMP04' },
    { id: '', type: 'ASSIGN_TASK', employeeId: 'EMP01', taskId: 'TASK001' },
  ];
  const statuses = new Set<string>();
  for (let day = 1; day <= 20; day++) {
    const commands: Command[] = [];
    for (let i = 0; i < 3; i++) {
      const draw = drawUniform(rng, '명령 선택');
      rng = draw.rng;
      commands.push({ ...pool[Math.floor(draw.value * pool.length)]!, id: `RANDOM-${day}-${i}` });
    }
    const direct = commitDay(openDay(uninterrupted, config).state, config, commands);
    uninterrupted = direct.state;
    direct.results.forEach((r) => statuses.add(r.status));
    const roundTrip = commitDay(reload(openDay(restored, config).state), config, commands);
    expect(roundTrip.results).toEqual(direct.results);
    restored = reload(roundTrip.state);
    expect(restored).toEqual(uninterrupted);
  }
  expect([...statuses].sort()).toEqual(['APPLIED', 'REJECTED']);
});
