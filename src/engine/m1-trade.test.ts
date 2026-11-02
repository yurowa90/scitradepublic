import { describe, expect, it } from 'vitest';
import { expectedTradeResult, loadScenario, assumptionNotes } from '../content/scenario';
import { commitDay, createGame, openDay, planCommands } from './engine';
import { InvariantError, checkInvariants } from './invariants';
import { summarize } from './ledger';
import { toMinor } from './money';
import { contractReport } from './reports';
import { SaveError, deserializeSave, serializeSave } from './save';
import { runDays, standardDayOneCommands } from './testkit';
import type { ScenarioConfig } from './types';

const usd = (amount: number) => toMinor('USD', amount);

function usdBook(state: ReturnType<typeof createGame>) {
  return summarize(state.ledger, 'USD');
}

describe('data/scenarios.json 계약 조건 연결', () => {
  it('계약 조건과 지연 사건을 상수가 아닌 데이터에서 읽는다', () => {
    const base = loadScenario('SCENARIO_M1_ONE_TRADE');
    expect(base.terms.prepWorkUnits).toBe(2);
    expect(base.terms.preDepartureFreightRefundMinor + base.terms.preDepartureCancellationFeeMinor).toBe(base.routes[0]!.bookingFeeMinor);
    expect(base.terms.lateDeliveryPriceReductionMinor).toBe(usd(50));
    expect(base.portRestrictions).toHaveLength(0);
    // 변형 시나리오는 기본 시나리오의 계약 조건을 상속하고 자기 사건만 더한다.
    const delay = loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
    expect(delay.terms.preDepartureCancellationFeeMinor).toBe(base.terms.preDepartureCancellationFeeMinor);
    expect(delay.terms.paymentDueDay).toBe(11);
    expect(delay.portRestrictions).toEqual([
      expect.objectContaining({ eventInstanceId: 'EVI_M1_EV02_HAIPHONG', cityId: 'HAIPHONG', announceDay: 5, startDay: 7, endDay: 8 }),
    ]);
    expect(loadScenario('SCENARIO_M1_CANCEL_PREDEPARTURE').portRestrictions).toHaveLength(0);
    expect(assumptionNotes('SCENARIO_M1_ONE_TRADE').length).toBeGreaterThan(0);
    expect(assumptionNotes('SCENARIO_M1_DELAY_ACCEPTED').at(-1)).toContain('하역 중단 7~8일');
  });
});

describe('M1 정상 거래 — SCENARIO_M1_ONE_TRADE', () => {
  const config = loadScenario('SCENARIO_M1_ONE_TRADE');
  const expected = expectedTradeResult('SCENARIO_M1_ONE_TRADE');
  const script = { 1: standardDayOneCommands(config) };

  it('시나리오 일정(예약1·출항2·도착7)을 운항표에서 그대로 만든다', () => {
    const { state, results } = runDays(createGame(config), config, 7, script);
    expect(results[1]!.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'APPLIED']);
    const sh = state.shipments[0]!;
    expect(sh.departureDay).toBe(config.expectedTimeline.departureDay);
    expect(sh.arrivalDay).toBe(config.expectedTimeline.arrivalDay);
    expect(state.tasks[0]!.completedDay).toBe(1);
  });

  it('인도 후 수금 전: 현금과 채권·이익을 분리한다', () => {
    const { state } = runDays(createGame(config), config, 7, script);
    const book = usdBook(state);
    const ct = contractReport(state, state.contracts[0]!);
    expect(book.cash).toBe(usd(10000 - 1000 - 200 - 50));
    expect(book.accountsReceivable).toBe(usd(1400));
    expect(book.inventory).toBe(0);
    expect(book.revenue).toBe(usd(expected.revenue_usd!));
    expect(book.costOfGoodsSold).toBe(usd(expected.purchase_usd! + expected.freight_usd! + expected.duty_usd!));
    expect(ct.contribution).toBe(usd(expected.contribution_before_payroll_usd!));
    expect(state.contracts[0]!.lateDays).toBe(0);
    expect(state.invoices[0]!.dueDay).toBe(10);
    expect(state.contracts[0]!.status).toBe('IN_PROGRESS');
  });

  it('10일 수금 뒤 채권 0, 이익은 다시 늘지 않는다', () => {
    const { state } = runDays(createGame(config), config, 10, script);
    const book = usdBook(state);
    expect(book.cash).toBe(usd(10150));
    expect(book.accountsReceivable).toBe(0);
    expect(book.revenue).toBe(usd(1400));
    expect(book.profit).toBe(usd(150));
    expect(state.contracts[0]!.status).toBe('COMPLETED');
    expect(state.contracts[0]!.completedDay).toBe(10);
  });

  it('KRW 급여는 별도 장부에서만 차감된다', () => {
    const { state } = runDays(createGame(config), config, 10, script);
    const krw = summarize(state.ledger, 'KRW');
    expect(krw.wageExpense).toBe(80000 * 10);
    expect(krw.cash).toBe(10_000_000 - 80000 * 10);
    expect(usdBook(state).wageExpense).toBe(0);
    expect(state.ledger.entries.every((e) => e.lines.length >= 2)).toBe(true);
  });
});

describe('M1 출항 전 취소 — SCENARIO_M1_CANCEL_PREDEPARTURE (P0-ACC-13)', () => {
  const config = loadScenario('SCENARIO_M1_CANCEL_PREDEPARTURE');
  const e = expectedTradeResult('SCENARIO_M1_CANCEL_PREDEPARTURE');
  const script = {
    1: standardDayOneCommands(config),
    2: [{ id: 'CMD-CANCEL', type: 'CANCEL_CONTRACT' as const, contractId: 'CT001' }],
  };

  it('운임은 순취소비만 손익에 남고 재고는 자산으로 남는다', () => {
    const { state, results } = runDays(createGame(config), config, 5, script);
    expect(results[2]![0]!.status).toBe('APPLIED');
    const book = usdBook(state);
    const ct = contractReport(state, state.contracts[0]!);
    const lot = state.cargoLots[0]!;
    expect(book.cash).toBe(usd(e.cash_after!));
    expect(lot.quantity).toBe(e.remaining_inventory_units);
    expect(lot.status).toBe('HELD_UNALLOCATED');
    expect(lot.locationCityId).toBe('PYEONGTAEK');
    expect(book.inventory).toBe(usd(e.inventory_cost!));
    expect(book.accountsReceivable).toBe(usd(e.accounts_receivable!));
    expect(book.revenue).toBe(usd(e.revenue!));
    expect(book.cancellationExpense).toBe(usd(e.cancellation_expense!));
    expect(ct.contribution).toBe(usd(e.contribution!));
    expect(book.cash + book.inventory + book.prepaidFreight).toBe(usd(e.assets_cash_plus_inventory!));
    expect(state.shipments).toHaveLength(0);
    expect(state.ledger.entries.some((x) => x.id.startsWith('DUTY-'))).toBe(false);
  });

  it('출항한 뒤에는 취소할 수 없다', () => {
    const { state, results } = runDays(createGame(config), config, 3, {
      1: standardDayOneCommands(config),
      3: [{ id: 'CMD-LATE-CANCEL', type: 'CANCEL_CONTRACT', contractId: 'CT001' }],
    });
    expect(results[3]![0]!.status).toBe('REJECTED');
    expect(state.contracts[0]!.status).toBe('IN_PROGRESS');
  });
});

describe('M1 지연 수락 — SCENARIO_M1_DELAY_ACCEPTED (P0-ACC-14)', () => {
  const config = loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
  const e = expectedTradeResult('SCENARIO_M1_DELAY_ACCEPTED');
  const script = {
    1: standardDayOneCommands(config),
    5: [{ id: 'CMD-KEEP', type: 'RESPOND_TO_DELAY' as const, noticeId: 'NOTICE-EVI_M1_EV02_HAIPHONG', shipmentId: 'SH001', choice: 'KEEP_SHIPMENT_BOOKING' as const }],
  };

  it('공통 지연 2일을 한 번만 더해 9일에 인도하고 감액한다', () => {
    const { state, results } = runDays(createGame(config), config, 9, script);
    expect(results[5]![0]!.status).toBe('APPLIED');
    const sh = state.shipments[0]!;
    expect(sh.scheduledArrivalDay).toBe(7);
    expect(sh.arrivalDay).toBe(config.expectedTimeline.arrivalDay);
    expect(sh.observedWaitDays).toBe(2);
    expect(sh.delayEventIds).toEqual(['EVI_M1_EV02_HAIPHONG']);
    expect(state.notices).toHaveLength(1);

    const book = usdBook(state);
    const ct = contractReport(state, state.contracts[0]!);
    expect(book.cash).toBe(usd(e.cash_before_collection!));
    expect(state.cargoLots[0]!.status).toBe('DELIVERED');
    expect(book.accountsReceivable).toBe(usd(e.accounts_receivable!));
    expect(ct.netRevenue).toBe(usd(e.net_revenue!));
    expect(ct.directCost).toBe(usd(e.direct_cost!));
    expect(ct.contribution).toBe(usd(e.contribution!));
    expect(book.cancellationExpense).toBe(0);
    expect(state.contracts[0]!.lateDays).toBe(1);
    expect(state.invoices[0]!.dueDay).toBe(11);
  });

  it('11일 수금 뒤 현금 10100, 채권 0', () => {
    const { state } = runDays(createGame(config), config, 11, script);
    const book = usdBook(state);
    expect(book.cash).toBe(usd(e.cash_after_collection!));
    expect(book.accountsReceivable).toBe(0);
    expect(book.profit).toBe(usd(100));
  });

  it('지연 공지 전에는 미래 사건이 상태에 공개되지 않는다', () => {
    const { state } = runDays(createGame(config), config, 4, script);
    expect(state.notices).toHaveLength(0);
    const opened = openDay(state, config).state;
    expect(opened.notices).toHaveLength(1);
    // 같은 날을 다시 열어도 공지를 다시 만들지 않는다.
    expect(openDay(opened, config).state.notices).toHaveLength(1);
  });
});

describe('명령·자원 검증', () => {
  const config = loadScenario('SCENARIO_M1_ONE_TRADE');

  it('같은 명령 ID는 같은 날·다음 날 재전송해도 한 번만 처리한다', () => {
    const accept = standardDayOneCommands(config)[0]!;
    const { state, results } = runDays(createGame(config), config, 2, { 1: [accept, accept], 2: [accept] });
    expect(results[1]!.map((r) => r.status)).toEqual(['APPLIED', 'DUPLICATE']);
    expect(results[2]![0]!.status).toBe('DUPLICATE');
    expect(state.contracts).toHaveLength(1);
    expect(state.ledger.entries.filter((x) => x.id.startsWith('PURCHASE-'))).toHaveLength(1);
    expect(usdBook(state).cash).toBe(usd(9000));
  });

  it('매입 자금이 부족하면 계약을 거절하고 장부를 바꾸지 않는다', () => {
    const poor: ScenarioConfig = { ...config, startingCash: { ...config.startingCash, USD: usd(999) } };
    const { state, results } = runDays(createGame(poor), poor, 1, { 1: standardDayOneCommands(poor) });
    expect(results[1]![0]!.status).toBe('REJECTED');
    expect(results[1]![0]!.reasonKo).toContain('매입 자금이 부족');
    expect(state.contracts).toHaveLength(0);
    expect(usdBook(state).cash).toBe(usd(999));
  });

  it('같은 날 대기 명령은 앞 명령의 지출을 반영해 누적 검증한다', () => {
    const tight: ScenarioConfig = { ...config, startingCash: { ...config.startingCash, USD: usd(1100) } };
    const game = openDay(createGame(tight), tight).state;
    const plan = planCommands(game, tight, standardDayOneCommands(tight));
    expect(plan.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED', 'REJECTED']);
    expect(plan[2]!.reasonKo).toContain('운임 선지급 자금이 부족');
    // 계획은 상태를 바꾸지 않는다.
    expect(game.contracts).toHaveLength(0);
  });

  it('출항 당일에는 예약할 수 없다', () => {
    const cmds = standardDayOneCommands(config);
    const { results } = runDays(createGame(config), config, 2, { 1: cmds.slice(0, 2), 2: [cmds[2]!] });
    expect(results[2]![0]!.status).toBe('REJECTED');
    expect(results[2]![0]!.reasonKo).toContain('예약 마감');
  });

  it('준비가 끝나지 않으면 출항을 놓치고 운임은 취소 조건으로 정산한다', () => {
    const cmds = standardDayOneCommands(config);
    const { state } = runDays(createGame(config), config, 2, { 1: [cmds[0]!, cmds[2]!] });
    expect(state.bookings[0]!.status).toBe('CANCELLED');
    expect(state.contracts[0]!.bookingId).toBeNull();
    expect(state.shipments).toHaveLength(0);
    expect(usdBook(state).cash).toBe(usd(10000 - 1000 - 200 + 150));
    expect(usdBook(state).cancellationExpense).toBe(usd(50));
  });

  it('원화가 부족하면 급여를 음수 현금 대신 미지급 의무로 남긴다', () => {
    const broke: ScenarioConfig = { ...config, startingCash: { ...config.startingCash, KRW: 100000 } };
    const { state } = runDays(createGame(broke), broke, 2);
    const krw = summarize(state.ledger, 'KRW');
    expect(krw.cash).toBe(20000);
    expect(krw.accountsPayable).toBe(80000);
    expect(state.obligations.filter((o) => o.paidDay === null)).toHaveLength(1);
  });
});

describe('일자 마감·저장·재현', () => {
  const config = loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
  const script = {
    1: standardDayOneCommands(config),
    5: [{ id: 'CMD-KEEP', type: 'RESPOND_TO_DELAY' as const, noticeId: 'NOTICE-EVI_M1_EV02_HAIPHONG', shipmentId: 'SH001', choice: 'KEEP_SHIPMENT_BOOKING' as const }],
  };

  it('이미 마감한 날을 다시 마감하면 상태가 바뀌지 않는다', () => {
    const { state } = runDays(createGame(config), config, 3, script);
    const again = commitDay(state, config, [], 3);
    expect(again.alreadyClosed).toBe(true);
    expect(again.state).toBe(state);
  });

  it('중간 저장·불러오기 후 진행 결과가 연속 진행과 같다', () => {
    const continuous = runDays(createGame(config), config, 12, script).state;

    const atDay4 = runDays(createGame(config), config, 4, script).state;
    const reloaded = deserializeSave(serializeSave(atDay4), { dataVersion: config.dataVersion });
    const fromSave = runDays(reloaded, config, 12, script).state;
    expect(fromSave).toEqual(continuous);

    // 의사결정 대기 중(사건 공개 후)에 저장해도 사건을 다시 적용하지 않는다.
    const opened5 = openDay(atDay4, config).state;
    const reopened = deserializeSave(serializeSave(opened5), { dataVersion: config.dataVersion });
    expect(openDay(reopened, config).state.notices).toHaveLength(1);
    expect(runDays(reopened, config, 12, script).state).toEqual(continuous);
  });

  it('다른 규칙·데이터 판본의 저장은 거절한다', () => {
    const state = createGame(config);
    const text = serializeSave(state);
    expect(() => deserializeSave(text, { dataVersion: '9.9.9' })).toThrow(SaveError);
    const other = JSON.parse(text);
    other.rulesVersion = 'M0-rules-0';
    expect(() => deserializeSave(JSON.stringify(other), { dataVersion: config.dataVersion })).toThrow(/경제 규칙 판본/);
  });

  it('장부와 화물 기록이 어긋나면 마감 검사가 실패한다', () => {
    const { state } = runDays(createGame(config), config, 3, script);
    const broken = structuredClone(state);
    broken.cargoLots[0]!.carryingAmountMinor += 1;
    expect(() => checkInvariants(broken, config)).toThrow(InvariantError);
  });
});
