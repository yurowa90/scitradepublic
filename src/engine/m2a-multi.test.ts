// M2a 첫 단계: 복수 계약·운송 주선·자원 예약 (SCENARIO_M2_MULTI_TRADE, tests/acceptance_cases.json의 P0-M2A-01~03).
// 기대값은 data/scenarios.json의 expected_paths_usd·expected_rejections와 인수 명세에서 읽는다.

import { describe, expect, it } from 'vitest';
import acceptance from '../../tests/acceptance_cases.json';
import { expectedM2, loadScenario, type ExpectedPath } from '../content/scenario';
import { createGame, openDay, planCommands } from './engine';
import { InvariantError, checkInvariants } from './invariants';
import { summarize } from './ledger';
import { toMinor } from './money';
import { companyReport, contractReport, forwardingPreview, tradePairs, tradePreview } from './reports';
import { cashReservations, fundsPosition } from './reservations';
import { SaveError, deserializeSave, serializeSave, SAVE_FORMAT_VERSION } from './save';
import { runDays, standardDayOneCommands, type DayScript } from './testkit';
import type { Command, GameState, ScenarioConfig } from './types';

const usd = (amount: number) => toMinor('USD', amount);
const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const { paths, rejections } = expectedM2('SCENARIO_M2_MULTI_TRADE');
type Case = { id: string; expected_numeric: Record<string, number> };
const spec = (id: string) => (acceptance as unknown as { cases: Case[] }).cases.find((c) => c.id === id)!.expected_numeric;
const n = (path: ExpectedPath | Record<string, unknown>, key: string) => usd(path[key] as number);
const book = (s: GameState) => summarize(s.ledger, 'USD');
const funds = (s: GameState) => fundsPosition(s, config, 'USD');

const acceptTrade = (id: string, buyOfferId: string, sellOfferId: string): Command => ({ id, type: 'ACCEPT_TRADE', buyOfferId, sellOfferId });
const acceptFwd = (id: string, offerId: string): Command => ({ id, type: 'ACCEPT_FORWARDING', offerId });
const assign = (id: string, taskId: string, employeeId: string): Command => ({ id, type: 'ASSIGN_TASK', taskId, employeeId });
const bookCmd = (id: string, contractId: string, sailingId: string): Command => ({ id, type: 'BOOK_SAILING', contractId, sailingId });

/**
 * 경로 기대값을 명령으로 옮긴다. 수락 순서대로 CT001, CT002...가 된다.
 * 1일: 수락·예약, 앞의 두 준비 업무를 EMP01·EMP02에게. 2일: 세 번째 준비 업무를 EMP01에게.
 */
function pathScript(path: ExpectedPath): DayScript {
  const offersInOrder = [...path.trades.map(([buy]) => buy), ...path.forwarding_offer_ids];
  const day1: Command[] = [
    ...path.trades.map(([buy, sell], i) => acceptTrade(`ACC-${i}`, buy, sell)),
    ...path.forwarding_offer_ids.map((o, i) => acceptFwd(`FWD-${i}`, o)),
  ];
  const ct = (i: number) => `CT00${i + 1}`;
  offersInOrder.forEach((offerId, i) => day1.push(bookCmd(`BOOK-${i}`, ct(i), path.sailing_by_offer[offerId]!)));
  day1.push(assign('ASG-0', 'TASK001', 'EMP01'), assign('ASG-1', 'TASK002', 'EMP02'));
  return { 1: day1, 2: [assign('ASG-2', 'TASK003', 'EMP01')] };
}

describe('M2 시나리오 데이터 연결', () => {
  it('규칙 판본·자금 예약·운송 주선을 데이터에서 켠다', () => {
    expect(config.rules).toEqual({ rulesVersion: 'M2a-rules-1', fundsCheck: 'COMMITTED_OUTLAYS', forwardingEnabled: true });
    expect(config.startingCash.USD).toBe(usd(3000));
    expect(config.routes.map((r) => r.id)).toEqual(['ROUTE01', 'ROUTE02']);
    expect(config.offers.filter((o) => o.kind === 'forwarding')).toHaveLength(2);
    expect(tradePairs(config)).toEqual([
      { buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01' },
      { buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02' },
    ]);
    // M1 시나리오는 이전 규칙 그대로다.
    expect(loadScenario('SCENARIO_M1_DELAY_ACCEPTED').rules).toEqual({ rulesVersion: 'M1-rules-1', fundsCheck: 'IMMEDIATE_CASH', forwardingEnabled: false });
  });

  it('수락 전 미리 보기는 필요 자금과 기여이익을 계산한다 (보장값 아님)', () => {
    const b = tradePreview(config, 'OFFER_BUY_02', 'OFFER_SELL_02', 1)!;
    expect([b.cashNeed, b.contributionBeforePayroll, b.routeId]).toEqual([usd(2280), usd(220), 'ROUTE02']);
    const f = forwardingPreview(config, 'OFFER_FWD_01', 1)!;
    expect([f.cashNeed, f.duty, f.contributionBeforePayroll, f.lateOnNextSailing]).toEqual([usd(200), 0, usd(180), false]);
  });
});

describe.each(paths.map((p) => [p.id, p] as const))('경로 %s', (_id, path) => {
  const script = pathScript(path);

  it('1일: 매입·운임을 내고 남은 관세만 예약으로 남는다', () => {
    const { state, results } = runDays(createGame(config), config, 1, script);
    expect(results[1]!.every((r) => r.status === 'APPLIED')).toBe(true);
    const f = funds(state);
    expect(f.cash).toBe(n(path, 'cash_after_day1'));
    expect(f.reserved).toBe(n(path, 'reserved_after_day1'));
    expect(f.available).toBe(n(path, 'available_after_day1'));
    expect(cashReservations(state, config).every((r) => r.kind === 'DUTY')).toBe(true);
  });

  it(`${path.final_day}일: 상품 매출과 주선 매출을 나눠 기대값과 일치`, () => {
    const { state } = runDays(createGame(config), config, path.final_day, script);
    const b = book(state);
    expect(b.cash).toBe(n(path, 'cash_final'));
    expect(b.revenue).toBe(n(path, 'goods_revenue'));
    expect(b.costOfGoodsSold).toBe(n(path, 'cost_of_goods_sold'));
    expect(b.forwardingRevenue).toBe(n(path, 'forwarding_revenue'));
    expect(b.forwardingCost).toBe(n(path, 'forwarding_cost'));
    expect([b.accountsReceivable, b.inventory, b.prepaidFreight, b.forwardingWip]).toEqual([0, 0, 0, 0]);
    const contribution = companyReport(state, config).contracts.reduce((a, r) => a + r.contribution, 0);
    expect(contribution).toBe(n(path, 'contribution'));
    expect(state.contracts.every((c) => c.status === 'COMPLETED')).toBe(true);
    expect(state.contracts.every((c) => c.lateDays === 0)).toBe(true);
    expect(cashReservations(state, config)).toEqual([]);
  });
});

describe('P0-M2A-02 운송 주선: 고객 화물과 회사 재고 분리', () => {
  const path = paths.find((p) => p.id === 'PATH_COSMETICS_AND_FORWARDING')!;
  const e = spec('P0-M2A-02');

  it('출항 뒤 회사 재고에는 화장품만, 고객 화물은 수량으로만 따로 센다', () => {
    const { state } = runDays(createGame(config), config, 2, pathScript(path));
    const r = companyReport(state, config);
    expect(r.inventoryUnits).toBe(50);
    // TASK-0015에서 고객 화물을 자동차 부품 200상자로 바꿨다. 금액 기대값은 그대로다.
    expect(r.customerCargoUnits).toBe(120 + 200);
    expect(r.trade.inventory).toBe(usd(2000 + 180));
    expect(r.trade.forwardingWip).toBe(usd(200));
    expect(state.cargoLots.filter((l) => l.owner === 'CUSTOMER').every((l) => l.carryingAmountMinor === 0)).toBe(true);
    // 고객 화물의 신고가액(9,600·12,000)은 어디에도 자산으로 잡히지 않는다.
    expect(r.trade.totalAssets).toBe(usd(3000));
  });

  it('7일: 가구 인도로 주선 매출만 생기고 관세는 내지 않는다', () => {
    const { state } = runDays(createGame(config), config, 7, pathScript(path));
    const b = book(state);
    expect(b.cash).toBe(usd(e.cash_after_day7!));
    expect(b.accountsReceivable).toBe(usd(e.accounts_receivable_after_day7!));
    const fwd = state.contracts.find((c) => c.serviceOfferId === 'OFFER_FWD_01')!;
    expect(contractReport(state, fwd)).toMatchObject({ netRevenue: usd(380), directCost: usd(200), contribution: usd(180) });
    expect(state.shipments.find((s) => s.contractId === fwd.id)!.dutyMinor).toBe(0);
    expect(state.ledger.entries.some((x) => x.id.startsWith('DUTY-') && x.contractId === fwd.id)).toBe(false);
  });

  it('17일 최종값이 인수 명세와 같다', () => {
    const { state } = runDays(createGame(config), config, 17, pathScript(path));
    const b = book(state);
    expect([b.revenue, b.costOfGoodsSold, b.forwardingRevenue, b.forwardingCost, b.cash]).toEqual(
      [e.goods_revenue!, e.cost_of_goods_sold!, e.forwarding_revenue!, e.forwarding_cost!, e.cash_final_day17!].map(usd),
    );
  });
});

describe('P0-M2A-01 복수 계약의 자금 예약', () => {
  const e = spec('P0-M2A-01');
  const r = rejections.REJECT_SECOND_DIRECT_TRADE!;
  const [b1, s1] = r.first_trade as [string, string];
  const [b2, s2] = r.second_trade as [string, string];

  it('두 번째 거래는 현금으로는 매입할 수 있어도 사용 가능 자금이 부족해 거절한다', () => {
    const { state, results } = runDays(createGame(config), config, 1, { 1: [acceptTrade('A', b1, s1), acceptTrade('B', b2, s2)] });
    expect(results[1]!.map((x) => x.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(results[1]![1]!.reasonKo).toContain('사용 가능 자금이 부족');
    expect(state.contracts).toHaveLength(e.contracts_after!);
    expect(state.offers.find((o) => o.id === b2)!.status).toBe('OPEN');
    const f = funds(state);
    expect([f.cash, f.reserved, f.available]).toEqual([e.cash_after_first!, e.reserved_after_first!, e.available_after_first!].map(usd));
    expect(f.cash).toBeGreaterThanOrEqual(usd(2000));
    expect(f.available).toBeLessThan(usd(e.needed_for_second!));
  });

  it('M1 규칙(지금 현금만 확인)이었다면 두 거래를 모두 받고 첫 거래 운임을 못 낸다', () => {
    const m1Rule: ScenarioConfig = { ...config, rules: { ...config.rules, fundsCheck: 'IMMEDIATE_CASH' } };
    const game = openDay(createGame(m1Rule), m1Rule).state;
    const plan = planCommands(game, m1Rule, [acceptTrade('A', b1, s1), acceptTrade('B', b2, s2), bookCmd('BK', 'CT001', 'ROUTE01-D002')]);
    expect(plan.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED', 'REJECTED']);
    expect(plan[2]!.reasonKo).toContain('운임 선지급 자금이 부족');
  });

  it('운임을 내면 그 계약의 운임 예약이 풀리고 관세 예약은 도착 때 풀린다', () => {
    const script = { 1: [acceptTrade('A', b1, s1), assign('AS', 'TASK001', 'EMP01'), bookCmd('BK', 'CT001', 'ROUTE01-D002')] };
    const day1 = runDays(createGame(config), config, 1, script).state;
    expect(cashReservations(day1, config)).toEqual([{ contractId: 'CT001', kind: 'DUTY', currency: 'USD', amountMinor: usd(50) }]);
    const day7 = runDays(createGame(config), config, 7, script).state;
    expect(cashReservations(day7, config)).toEqual([]);
    expect(book(day7).cash).toBe(usd(3000 - 1250));
  });
});

describe('P0-M2A-03 선복·직원 중복 예약 방지', () => {
  const e = spec('P0-M2A-03');
  const cmds: Command[] = [
    acceptFwd('F1', 'OFFER_FWD_01'),
    acceptFwd('F2', 'OFFER_FWD_02'),
    bookCmd('B1', 'CT001', 'ROUTE01-D002'),
    bookCmd('B2', 'CT002', 'ROUTE01-D002'),
    assign('A1', 'TASK001', 'EMP01'),
    assign('A2', 'TASK002', 'EMP01'),
  ];

  it('같은 날 대기 명령을 누적 검증해 넘치는 선복과 겹치는 업무를 거절한다', () => {
    const game = openDay(createGame(config), config).state;
    const plan = planCommands(game, config, cmds);
    expect(plan.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED', 'REJECTED', 'APPLIED', 'REJECTED']);
    expect(plan[3]!.reasonKo).toContain('부피');
    expect(plan[5]!.reasonKo).toContain('다른 업무');
  });

  it('거절된 예약은 운임을 받지 않으며 남은 화물은 다음 편에 실을 수 있다', () => {
    const { state, results } = runDays(createGame(config), config, 1, { 1: cmds });
    expect(results[1]!.filter((x) => x.status === 'REJECTED')).toHaveLength(e.rejected_bookings! + e.rejected_assignments!);
    const f = funds(state);
    expect([f.cash, f.reserved]).toEqual([usd(e.cash_after_day1!), usd(e.reserved_after_day1!)]);
    const later = runDays(state, config, 2, { 2: [bookCmd('B3', 'CT002', 'ROUTE01-D009'), assign('A3', 'TASK002', 'EMP02')] });
    expect(later.results[2]!.map((x) => x.status)).toEqual(['APPLIED', 'APPLIED']);
  });

  it('공간 때문에 급한 화물을 다음 편으로 미루면 납기를 넘겨 감액된다', () => {
    const script: DayScript = {
      1: [acceptFwd('F1', 'OFFER_FWD_01'), acceptFwd('F2', 'OFFER_FWD_02'), bookCmd('B2', 'CT002', 'ROUTE01-D002'), bookCmd('B1', 'CT001', 'ROUTE01-D009'), assign('A2', 'TASK002', 'EMP01')],
      2: [assign('A1', 'TASK001', 'EMP01')],
    };
    const { state } = runDays(createGame(config), config, 17, script);
    const furniture = state.contracts.find((c) => c.serviceOfferId === 'OFFER_FWD_01')!;
    expect([furniture.deliveredDay, furniture.lateDays, furniture.priceReductionMinor]).toEqual([14, 6, usd(50)]);
    expect(contractReport(state, furniture).contribution).toBe(usd(380 - 50 - 200));
  });
});

describe('운송 주선의 취소·출항 불참·중복 명령', () => {
  it('출항 전 취소: 운임만 정산하고 고객 화물은 화주에게 돌려준다 (재고 없음)', () => {
    const { state } = runDays(createGame(config), config, 1, {
      1: [acceptFwd('F1', 'OFFER_FWD_01'), bookCmd('B1', 'CT001', 'ROUTE01-D002'), { id: 'X', type: 'CANCEL_CONTRACT', contractId: 'CT001' }],
    });
    const b = book(state);
    expect([b.cash, b.cancellationExpense, b.inventory, b.forwardingRevenue]).toEqual([usd(3000 - 200 + 150), usd(50), 0, 0]);
    expect(state.cargoLots[0]!.status).toBe('RETURNED_TO_OWNER');
    expect(companyReport(state, config).customerCargoUnits).toBe(0);
    expect(cashReservations(state, config)).toEqual([]);
  });

  it('준비 미완료로 출항을 놓치면 운임을 정산하고 운임 예약이 다시 생긴다', () => {
    const { state } = runDays(createGame(config), config, 2, { 1: [acceptFwd('F1', 'OFFER_FWD_01'), bookCmd('B1', 'CT001', 'ROUTE01-D002')] });
    expect(state.bookings[0]!.status).toBe('CANCELLED');
    expect(book(state).cash).toBe(usd(3000 - 50));
    expect(cashReservations(state, config)).toEqual([{ contractId: 'CT001', kind: 'FREIGHT', currency: 'USD', amountMinor: usd(200) }]);
  });

  it('같은 명령 ID를 다시 보내도 계약·화물을 복제하지 않는다', () => {
    const f = acceptFwd('SAME', 'OFFER_FWD_01');
    const { state, results } = runDays(createGame(config), config, 2, { 1: [f, f], 2: [f] });
    expect(results[1]!.map((x) => x.status)).toEqual(['APPLIED', 'DUPLICATE']);
    expect(results[2]![0]!.status).toBe('DUPLICATE');
    expect([state.contracts.length, state.cargoLots.length, state.tasks.length]).toEqual([1, 1, 1]);
  });

  it('M1 시나리오에서는 운송 주선을 받지 않는다', () => {
    const m1 = loadScenario('SCENARIO_M1_ONE_TRADE');
    const plan = planCommands(openDay(createGame(m1), m1).state, m1, [acceptFwd('F', 'OFFER_FWD_01')]);
    expect(plan[0]!.status).toBe('REJECTED');
  });
});

describe('저장 판본 2와 이관', () => {
  const path = paths[0]!;

  it('복수 계약 진행 중 저장·불러오기 후 결과가 연속 진행과 같다', () => {
    const script = pathScript(path);
    const continuous = runDays(createGame(config), config, path.final_day, script).state;
    const atDay4 = runDays(createGame(config), config, 4, script).state;
    const reloaded = deserializeSave(serializeSave(atDay4), { dataVersion: config.dataVersion, rulesVersion: config.rules.rulesVersion });
    expect(runDays(reloaded, config, path.final_day, script).state).toEqual(continuous);
  });

  it('M2 저장을 M1 규칙으로 읽으려 하면 거절한다', () => {
    const text = serializeSave(createGame(config));
    expect(() => deserializeSave(text, { dataVersion: config.dataVersion, rulesVersion: 'M1-rules-1' })).toThrow(SaveError);
  });

  it('판본 1은 새 문구로 거절한다', () => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    const file = { ...JSON.parse(serializeSave(createGame(cfg))), formatVersion: 1 };
    expect(() => deserializeSave(JSON.stringify(file), { dataVersion: cfg.dataVersion })).toThrow(`이전 저장 형식(판본 ${1})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });
});

describe('M2a 불변 조건', () => {
  const path = paths[0]!;

  it('고객 화물에 회사 장부가액이 생기면 마감 검사가 실패한다', () => {
    const { state } = runDays(createGame(config), config, 2, pathScript(path));
    const broken = structuredClone(state);
    broken.cargoLots.find((l) => l.owner === 'CUSTOMER')!.carryingAmountMinor = 1;
    expect(() => checkInvariants(broken, config)).toThrow(InvariantError);
  });

  it('선복 한도를 넘는 예약 기록이 있으면 마감 검사가 실패한다', () => {
    const { state } = runDays(createGame(config), config, 1, pathScript(path));
    const broken = structuredClone(state);
    const b = broken.bookings.find((x) => x.sailingId === 'ROUTE01-D009')!;
    b.volumeLiters = 31_000;
    expect(() => checkInvariants(broken, config)).toThrow(/선복 한도/);
  });
});
