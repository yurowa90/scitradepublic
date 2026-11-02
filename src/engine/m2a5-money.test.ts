import { describe, expect, it } from 'vitest';
import { assumptionNotes, loadScenario, SCENARIO_IDS } from '../content/scenario';
import { commitDay, createGame, openDay, planState, restartWithSameSeed } from './engine';
import { balance, summarize, post } from './ledger';
import { batchZero, generateBatch } from './market';
import { lateDeliveryReduction, paymentDefaultStatus, processPaymentDefault } from './operations';
import { payrollRunwayDay } from './previews';
import { contractProgress } from './progress';
import { campaignSummary, contractReport, forwardingPreview } from './reports';
import { deserializeSave, serializeSave } from './save';
import { runDays } from './testkit';
import { applied, atDay, book, caseOf, config, fresh, planned, scriptOf } from './m2a5-testkit';
import type { GameState, EngineCommand } from './types';

const c6 = caseOf('P0-M2A5-06'), c7 = caseOf('P0-M2A5-07'), c8 = caseOf('P0-M2A5-08'), c9 = caseOf('P0-M2A5-09'), c14 = caseOf('P0-M2A5-14');
const n9 = c9.expected_numeric;
let cachedIdle: { days: Map<number, GameState>; failed: GameState } | undefined;
function idleRun() {
  if (!cachedIdle) {
    const days = new Map<number, GameState>();
    let state = createGame(config);
    while (state.phase !== 'ENDED') { state = commitDay(openDay(state, config).state, config, []).state; days.set(state.day - 1, state); }
    cachedIdle = { days, failed: state };
  }
  return cachedIdle;
}
const failedState = () => idleRun().failed;
let cachedCompleted: GameState | undefined;
const completedState = () => cachedCompleted ??= runDays(createGame(config), config, config.campaignDays, scriptOf(c14)).state;
const wages = c6.expected_numeric.wage_daily;
function expectedIdleBook(day: number, cash: number, payable: number, extra: Partial<ReturnType<typeof book>> = {}) {
  const wageExpense = day * wages, rentExpense = Math.ceil(day / config.operations!.fixedCosts.rent.periodDays) * config.operations!.fixedCosts.rent.amountMinor;
  return book('KRW', { cash, totalAssets: cash, accountsPayable: payable, wageExpense, rentExpense, profit: -wageExpense - rentExpense, ...extra });
}
function readAt(day: number) { return openDay(idleRun().days.get(day - 1)!, config).state; }
function rejected(reasonKo: string, command: EngineCommand) { return [{ commandId: command.id, status: 'REJECTED', reasonKo }]; }

describe('P0-M2A5-06 임차료·고정비', () => {
  it('첫날과 56일까지 원화 장부 전체·급여 가능일·재전송을 보존한다', () => {
    const n = c6.expected_numeric;
    expect(summarize(idleRun().days.get(c6.test_fixture.first_day)!.ledger, 'KRW')).toEqual(expectedIdleBook(c6.test_fixture.first_day, n.cash_day1, 0));
    expect(summarize(idleRun().days.get(c6.test_fixture.last_wait_day)!.ledger, 'KRW')).toEqual(expectedIdleBook(c6.test_fixture.last_wait_day, n.cash_day56, 0));
    expect([payrollRunwayDay(fresh(), config), payrollRunwayDay(fresh(loadScenario(SCENARIO_IDS[0])), loadScenario(SCENARIO_IDS[0]))]).toEqual([n.runway, n.legacy_runway]);
    const s = idleRun().days.get(c6.test_fixture.last_wait_day)!;
    expect(commitDay(s, config, [], c6.test_fixture.last_wait_day).state).toEqual(s);
    expect(deserializeSave(serializeSave(s), { dataVersion: config.dataVersion })).toEqual(s);
    expect(campaignSummary(s, config).contracts).toEqual({ total: 0, completed: 0, awaitingPayment: 0, inProgress: 0, cancelled: 0 });
  });
});

describe('P0-M2A5-07 환전·통화 간 이체', () => {
  it('왕복 환전의 두 통화 장부와 분개 전체가 맞고 같은 명령은 한 번만 적용한다', () => {
    const action = c7.actions[0]!, n = c7.expected_numeric;
    const first = planState(fresh(), config, action.commands.slice(0, 1));
    expect(first.results).toEqual(applied(action.commands.slice(0, 1)));
    expect(summarize(first.state.ledger, 'USD')).toEqual(book('USD', { cash: n.out_usd, totalAssets: n.out_usd, currencyTransferNet: n.usd_transfer }));
    expect(summarize(first.state.ledger, 'KRW')).toEqual(book('KRW', { cash: n.out_krw_cash, totalAssets: n.out_krw_cash, fxSpreadExpense: n.spread, profit: -n.spread, currencyTransferNet: n.krw_transfer }));
    expect(first.state.ledger.entries.slice(Object.keys(config.startingCash).length)).toEqual([
      { id: 'FX001-USD', day: action.day, currency: 'USD', reason: '환전: 1,000.00 USD → 1,287,000원(게임용 고정 환율 1,287원, 차감 13,000원)', lines: [{ account: 'CURRENCY_TRANSFER', amount: -n.usd_transfer }, { account: 'CASH', amount: n.usd_transfer }] },
      { id: 'FX001-KRW', day: action.day, currency: 'KRW', reason: '환전: 1,000.00 USD → 1,287,000원(게임용 고정 환율 1,287원, 차감 13,000원)', lines: [{ account: 'CASH', amount: n.out_krw_cash - config.startingCash.KRW! }, { account: 'FX_SPREAD_EXPENSE', amount: n.spread }, { account: 'CURRENCY_TRANSFER', amount: -n.krw_transfer }] },
    ]);
    const round = planState(first.state, config, action.commands.slice(1));
    expect(summarize(round.state.ledger, 'USD')).toEqual(book('USD'));
    expect(summarize(round.state.ledger, 'KRW')).toEqual(book('KRW', { cash: n.in_krw_cash, totalAssets: n.in_krw_cash, fxSpreadExpense: n.roundtrip_loss, profit: -n.roundtrip_loss }));
    const again = planState(round.state, config, action.commands);
    expect(again.state).toEqual(round.state);
    expect(again.results).toEqual(action.commands.map((cmd) => ({ commandId: cmd.id, status: 'DUPLICATE', reasonKo: '이미 처리한 명령 ID입니다. 다시 실행하지 않습니다.' })));
  });
  it('당일 환전은 같은 날 급여에 쓰이고 자동 환전은 없다', () => {
    const action = c7.actions[1]!, s = runDays(readAt(action.day), config, action.day, scriptOf(c7, 'same_day')).state;
    const spread = config.operations!.fx.lotUsdMinor * (config.operations!.fx.baseKrwPerUsd - config.operations!.fx.buyKrwPerUsd) / 100;
    expect(summarize(s.ledger, 'KRW')).toEqual(expectedIdleBook(action.day, c7.expected_numeric.day57_cash, 0, { fxSpreadExpense: spread,
      currencyTransferNet: config.operations!.fx.lotUsdMinor * config.operations!.fx.baseKrwPerUsd / 100,
      profit: -action.day * wages - 2 * config.operations!.fixedCosts.rent.amountMinor - spread }));
    expect(s.obligations).toEqual([]); expect(failedState().operations!.exchanges).toEqual([]);
  });
});

describe('P0-M2A5-08 지급 순서', () => {
  it('큰 임차료 의무를 건너뛰어 낼 수 있는 급여를 내고 14일째 실패한다', () => {
    const n = c8.expected_numeric;
    let s = createGame(config);
    for (const [day, cash] of n.cash_days as [number, number][]) {
      s = runDays(s, config, day, scriptOf(c8)).state;
      const spread = n.fx_spread, transfer = n.fx_transfer;
      const payable = day === n.cash_days[0][0] ? 0 : n.cause_amount + (day === n.cash_days.at(-1)[0] ? wages / 2 : 0);
      expect(summarize(s.ledger, 'KRW')).toEqual(expectedIdleBook(day, cash, payable, { fxSpreadExpense: spread, currencyTransferNet: transfer,
        profit: -day * wages - Math.ceil(day / config.operations!.fixedCosts.rent.periodDays) * config.operations!.fixedCosts.rent.amountMinor - spread }));
    }
    s = runDays(s, config, n.failure_day).state;
    expect(summarize(s.ledger, 'KRW')).toEqual(expectedIdleBook(n.failure_day, n.cash_days.at(-1)[1], n.unpaid, { fxSpreadExpense: n.fx_spread, currencyTransferNet: n.fx_transfer,
      profit: -n.failure_day * wages - 3 * config.operations!.fixedCosts.rent.amountMinor - n.fx_spread }));
    expect(s.operations!.failure!.obligationId).toBe(c8.test_fixture.cause_id);
    expect(s.obligations.filter((o) => o.paidDay === null).map((o) => o.amountMinor)).toEqual([n.cause_amount, ...Array(n.count - 1).fill(wages / 2)]);
  });
  it('갚을 수 없는 과거 의무 뒤의 작은 과거 의무는 갚는다', () => {
    const f = c8.test_fixture, n = c8.expected_numeric;
    const cfg = { ...config, startingCash: { ...config.startingCash, USD: f.old_obligations_cash } };
    const s = fresh(cfg);
    s.obligations.push(...structuredClone(f.old_obligations));
    expect(post(s.ledger, f.old_obligations_entry)).toBe(true);
    const closed = commitDay(s, cfg, []).state;
    expect(closed.obligations).toEqual(n.settled_obligations);
    expect(summarize(closed.ledger, 'USD')).toEqual(book('USD', n.old_obligations_book, cfg));
  });

});

describe('P0-M2A5-09 지급 불이행 단계·경영 실패', () => {
  it('경고·위험·실패 경계와 두 종류 환전 회복량 전체가 맞다', () => {
    expect(paymentDefaultStatus(readAt(n9.danger_day), config).recovery).toEqual(n9.recovery64);
    expect(paymentDefaultStatus(readAt(n9.failure_day), config).recovery).toEqual(n9.recovery71);
    const warning = failedState().operations!.defaultEvents.find((e) => e.level === 'WARNING')!;
    const danger = failedState().operations!.defaultEvents.find((e) => e.level === 'DANGER')!;
    expect(failedState().operations!.defaultEvents).toEqual([
      { day: n9.first_unpaid_day, level: 'WARNING', obligationId: c9.test_fixture.cause_id, currency: 'KRW', amountMinor: n9.due_to_survive, incurredDay: n9.first_unpaid_day, dueToSurviveMinor: 0, lotsToSurvive: 0, lotsToClearAll: 1, usdAvailableMinor: n9.cash_usd },
      { day: n9.danger_day, level: 'DANGER', obligationId: c9.test_fixture.cause_id, currency: 'KRW', amountMinor: n9.due_to_survive, incurredDay: n9.first_unpaid_day, dueToSurviveMinor: 0, lotsToSurvive: 0, lotsToClearAll: n9.recovery64.lotsToClearAll, usdAvailableMinor: n9.cash_usd },
    ]);
    const expectedFailure = { day: n9.failure_day, obligationId: c9.test_fixture.cause_id, currency: 'KRW', amountMinor: n9.due_to_survive,
      reasonKo: `${config.employees.find((e) => e.id === c9.test_fixture.cause_employee)!.nameKo} ${n9.first_unpaid_day}일 급여`, incurredDay: n9.first_unpaid_day,
      unpaidByCurrency: [{ currency: 'USD', amountMinor: 0, count: 0 }, { currency: 'KRW', amountMinor: n9.unpaid, count: n9.count }],
      cashByCurrency: [{ currency: 'USD', amountMinor: n9.cash_usd }, { currency: 'KRW', amountMinor: n9.cash_krw }],
      warningEvent: warning, dangerEvent: danger, optionalKrwSpendBeforeFirstUnpaid: [], usdCommitmentsSinceIncurred: [] };
    expect(failedState().operations!.failure).toEqual(expectedFailure);
    expect([failedState().day, failedState().phase, failedState().operations!.outcome, failedState().operations!.batches.length]).toEqual([n9.next_day, 'ENDED', 'FAILED', n9.batches]);
    expect(summarize(failedState().ledger, 'KRW')).toEqual(expectedIdleBook(n9.failure_day, n9.cash_krw, n9.unpaid));
  });
  it('충분한 환전은 밀린 지급을 해소하고 최소 환전은 실패일만 미룬다', () => {
    for (const variant of ['B', 'C']) {
      const a = c9.actions.find((a) => a.variant === variant)!, expectedDay = n9[variant + '_fail_day'];
      const restored = runDays(readAt(a.day), config, a.day, scriptOf(c9, variant)).state;
      const cash = n9[variant + '_cash70'];
      const usd = (a.commands[0] as Extract<EngineCommand, { type: 'EXCHANGE_CURRENCY' }>).usdAmountMinor;
      const received = usd * config.operations!.fx.buyKrwPerUsd / 100, transfer = usd * config.operations!.fx.baseKrwPerUsd / 100;
      const payrollExpense = a.day * wages, rent = 3 * config.operations!.fixedCosts.rent.amountMinor;
      const payable = payrollExpense + rent - config.startingCash.KRW! - received + cash;
      expect(summarize(restored.ledger, 'KRW')).toEqual(book('KRW', { cash, totalAssets: cash, accountsPayable: payable, wageExpense: payrollExpense, rentExpense: rent,
        fxSpreadExpense: transfer - received, currencyTransferNet: transfer, profit: -payrollExpense - rent - transfer + received }));
      const end = runDays(restored, config, config.campaignDays).state;
      expect([end.operations!.failure!.day, end.day]).toEqual([expectedDay, expectedDay + 1]);
      if (variant === 'B') expect(restored.operations!.defaultEvents.filter((e) => e.day === a.day)).toEqual([]);
    }
  });
  it('실패 전 선복 서명 약정을 남기고 실패 뒤 출항편 요금은 내지 않는다', () => {
    const s = runDays(createGame(config), config, config.campaignDays, scriptOf(c9, 'D')).state;
    expect(s.operations!.failure).toEqual({ ...failedState().operations!.failure, usdCommitmentsSinceIncurred: n9.D_commitments });
    expect(s.ledger.entries.filter((e) => e.lines.some((l) => l.account === 'SPACE_CONTRACT_EXPENSE'))).toEqual([]);
  });
  it('다음 묶음 전날 실패하면 공개 단계 전체를 건너뛴다', () => {
    const cfg = { ...config, startingCash: { ...config.startingCash, KRW: c9.test_fixture.prepublish_start_krw } };
    const s = runDays(createGame(cfg), cfg, cfg.campaignDays).state;
    expect([s.operations!.failure!.day, s.operations!.batches.map((b) => b.publishDay)])
      .toEqual([n9.prepublish_failure.day, n9.prepublish_failure.publish_days]);
  });
  it('같은 날 계약과 선복 서명은 입력 순서대로 실패 기록에 남는다', () => {
    for (const reverse of [false, true]) {
      const commands = [...c9.test_fixture.same_day_commands];
      if (reverse) commands.reverse();
      const s = runDays(createGame(config), config, n9.failure_day, { [n9.first_unpaid_day]: commands }).state;
      const commitments = [...n9.same_day_commitments];
      if (reverse) commitments.reverse();
      expect(s.operations!.failure).toEqual({ ...failedState().operations!.failure,
        cashByCurrency: [{ currency: 'USD', amountMinor: n9.same_day_cash }, { currency: 'KRW', amountMinor: n9.cash_krw }],
        warningEvent: { ...failedState().operations!.failure!.warningEvent, usdAvailableMinor: n9.same_day_warning_available },
        dangerEvent: { ...failedState().operations!.failure!.dangerEvent, usdAvailableMinor: n9.same_day_danger_available },
        usdCommitmentsSinceIncurred: commitments });
    }
  });
  it('첫 미지급 전 14일 선택 지출만 포함하고 경계 밖·당일 지출은 뺀다', () => {
    const s = structuredClone(failedState());
    s.day = n9.failure_day; s.operations!.outcome = 'IN_PROGRESS'; s.operations!.failure = null;
    for (const entry of c9.test_fixture.optional_entries) expect(post(s.ledger, entry)).toBe(true);
    processPaymentDefault(s, config);
    expect(s.operations!.failure).toEqual({ ...failedState().operations!.failure,
      cashByCurrency: [{ currency: 'USD', amountMinor: n9.cash_usd }, { currency: 'KRW', amountMinor: n9.optional_cash }],
      optionalKrwSpendBeforeFirstUnpaid: n9.optional_spending });
  });
  it('USD 원인 의무에는 합산한 다음 수금과 원화 환전 필요액을 제시한다', () => {
    const cfg = { ...config, startingCash: { ...config.startingCash, USD: 0 } }, s = fresh(cfg);
    s.obligations.push(c9.test_fixture.usd_recovery.obligation);
    s.invoices.push(...c9.test_fixture.usd_recovery.invoices);
    expect(paymentDefaultStatus(s, cfg).recovery).toEqual(n9.usd_recovery);
    s.invoices = [];
    expect(paymentDefaultStatus(s, cfg).recovery).toEqual({ ...n9.usd_recovery, nextReceipt: null });
  });

});

describe('P0-M2A5-14 결산과 같은 시드 다시', () => {
  it('실패 결산과 같은 시드의 재시작은 저장된 시장을 재현한다', () => {
    const summary = campaignSummary(failedState(), config), restarted = restartWithSameSeed(failedState(), config);
    expect(summary.operations).toEqual({ outcome: 'FAILED', failure: failedState().operations!.failure,
      arrearsAtEnd: failedState().operations!.failure!.unpaidByCurrency, defaultEvents: failedState().operations!.defaultEvents, exchanges: [],
      fixedCostsByCurrency: [{ currency: 'USD', rentExpense: 0, facilitySetupExpense: 0, spaceContractExpense: 0, fxSpreadExpense: 0 },
        { currency: 'KRW', rentExpense: 3 * config.operations!.fixedCosts.rent.amountMinor, facilitySetupExpense: 0, spaceContractExpense: 0, fxSpreadExpense: 0 }] });
    expect(restarted).toEqual(createGame(config));
    expect(runDays(restarted, config, c14.test_fixture.restart_day).state.operations!.batches[1]).toEqual(caseOf('P0-M2A5-01').expected_numeric.generated.batch);
  });
  it('90일에 나이 14 미만 미지급을 남겨도 정상 완료이며 통화별 명세를 낸다', () => {
    const n = c14.expected_numeric;
    expect(completedState().operations!.outcome).toBe('COMPLETED');
    expect(campaignSummary(completedState(), config).operations!.arrearsAtEnd).toEqual([{ currency: 'USD', amountMinor: 0, count: 0 }, { currency: 'KRW', amountMinor: n.unpaid, count: n.count }]);
    expect(summarize(completedState().ledger, 'KRW')).toEqual(expectedIdleBook(n.completed_day, n.cash_final, n.unpaid, { fxSpreadExpense: n.fx_spread, currencyTransferNet: n.fx_transfer,
      profit: -n.completed_day * wages - 3 * config.operations!.fixedCosts.rent.amountMinor - n.fx_spread }));
    expect(completedState().operations!.failure).toEqual(null);
  });
});

describe('P0-M2A5-15 통화 분리', () => {
  it('USD가 있어도 원화 의무를 자동으로 갚거나 합산하지 않는다', () => {
    expect(summarize(failedState().ledger, 'USD')).toEqual(book('USD'));
    expect(failedState().operations!.exchanges).toEqual([]);
    expect(paymentDefaultStatus(failedState(), config).cashByCurrency).toEqual(failedState().operations!.failure!.cashByCurrency);
    expect(Object.keys(campaignSummary(failedState(), config))).toEqual(['operations', 'ended', 'campaignDays', 'lastClosedDay', 'byCurrency', 'onTime', 'contracts', 'openInvoices', 'unpaidObligations']);
  });
});

describe('M2a-5 문장 반례', () => {
  it('S1 보관 부족과 선복 부족·확장 완료를 구분한다', () => {
    const c = caseOf('P0-M2A5-03'), action = c.actions[0]!;
    const accepted = planState(atDay(action.day), config, action.commands.slice(0, -1)).state;
    const a = planState(accepted, config, action.commands.slice(-1));
    expect(a.results[0]!.reasonKo).toBe('보관 공간 부족 — 평택 창고 33 / 40 m³, 이 화물 9 m³. 출항하거나 확장하면 공간이 생깁니다.');
    const expanded = planState(accepted, config, [{ id: 'EXPAND-TODAY', type: 'EXPAND_WAREHOUSE' }]).state;
    const b = planState(expanded, config, action.commands.slice(-1));
    expect(b.results[0]!.reasonKo).toBe('보관 공간 부족 — 평택 창고 33 / 40 m³, 이 화물 9 m³. 출항하면 공간이 생깁니다.');
    expect(b.results[0]!.reasonKo).not.toContain('확장하면');
    const offers = config.offers.filter((o) => o.kind === 'forwarding');
    const route = config.routes.find((r) => r.toCityId === offers[0]!.destinationCityId)!;
    const cmds: EngineCommand[] = offers.map((o, i) => ({ id: `SPACE-${i}`, type: 'ACCEPT_FORWARDING', offerId: o.id,
      plan: { employeeId: config.employees[i]!.id, sailingId: `${route.id}-D002` } }));
    const result = planState(fresh(), config, cmds);
    expect(result.results[1]!.reasonKo).toBe('한 번에 확정할 수 없습니다 — 운송편 예약 불가: 이 출항편의 남은 화물 공간이 부족합니다 (부피 8m³ 필요, 남은 6m³). 견적도 수락하지 않습니다.');
    expect(result.results[1]!.reasonKo).not.toContain('보관 공간 부족');
  });
  it('S2 상한 밖 수량은 거절하고 최대 수량은 수락한다', () => {
    const c = caseOf('P0-M2A5-02'), a = c.actions[0]!, cmd = a.commands[0] as Extract<EngineCommand, { type: 'ACCEPT_TRADE' }>;
    const invalid = { ...cmd, quantity: cmd.quantity! + config.operations!.market.trade.goods[0]!.baseLot };
    expect(planState(atDay(a.day), config, [invalid]).results[0]!.reasonKo).toBe('수량은 100개 단위로 100 ~ 200개까지 고를 수 있습니다.');
    expect(planState(atDay(a.day), config, [cmd]).results).toEqual(applied([cmd]));
  });
  it('S3 다른 묶음은 거절하고 같은 묶음은 수락한다', () => {
    const c = caseOf('P0-M2A5-02'), a = c.actions[0]!, s = atDay(a.day), cmd = a.commands[0] as Extract<EngineCommand, { type: 'ACCEPT_TRADE' }>;
    const changed = structuredClone(s); changed.operations!.offers.find((o) => o.id === cmd.sellOfferId)!.publishDay--;
    expect(planState(changed, config, [cmd]).results[0]!.reasonKo).toBe('같은 묶음·같은 상품의 매입·판매만 묶을 수 있습니다.');
    expect(planState(s, config, [cmd]).results).toEqual(applied([cmd]));
  });
  it('S4 USD 부족 설명에서 없는 선복 요금·미지급은 뺀다', () => {
    const s = planned(caseOf('P0-M2A5-12')).state;
    const cmd: EngineCommand = { id: 'FX-NO-USD', type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: c7.test_fixture.insufficient_usd };
    const reason = planState(s, config, [cmd]).results[0]!.reasonKo;
    expect(reason).toBe('환전할 수 있는 USD가 부족합니다. 요청 400.00 USD, 사용 가능 320.00 USD = 현금 420.00 USD − 다른 계약 예약 100.00 USD.');
    expect(reason).not.toContain('선복 계약 요금 예약'); expect(reason).not.toContain('미지급');
  });
  it('S5 원화 부족 설명에서 미지급 0이면 차감 항목을 뺀다', () => {
    const cmd: EngineCommand = { id: 'FX-NO-KRW', type: 'EXCHANGE_CURRENCY', direction: 'KRW_TO_USD', usdAmountMinor: c7.test_fixture.insufficient_krw };
    const reason = planState(fresh(), config, [cmd]).results[0]!.reasonKo;
    expect(reason).toBe('환전할 수 있는 원화가 부족합니다. 필요 131,300,000원, 사용 가능 10,000,000원 = 현금 10,000,000원.');
    expect(reason).not.toContain('− 미지급');
  });
  it('S6 환전 방향에 맞는 고정 환율만 적는다', () => {
    const p = planned(c7);
    expect(p.state.log.map((l) => l.textKo)).toEqual(['환전: 1,000.00 USD → 1,287,000원(게임용 고정 환율 1,287원, 차감 13,000원)', '환전: 1,313,000원 → 1,000.00 USD(게임용 고정 환율 1,313원, 차감 13,000원)']);
    expect(p.state.log[0]!.textKo).not.toContain('1,313'); expect(p.state.log[1]!.textKo).not.toContain('1,287');
  });
  it('S7 남은 임차일이 없는 확장에는 다음 임차일을 약속하지 않는다', () => {
    const c = caseOf('P0-M2A5-10'), p = planned(c);
    expect(p.state.log.at(-1)!.textKo).toBe('창고 확장 계약: 23일부터 보관 60 m³·처리 9pt. 임차료는 다음 임차일(31일)부터 700,000원');
    const later = atDay(c.test_fixture.late_expansion_day, config, scriptOf(c14));
    const q = planState(later, config, c.actions[0]!.commands);
    expect(q.state.log.at(-1)!.textKo).toBe('창고 확장 계약: 63일부터 보관 60 m³·처리 9pt. 남은 임차일이 없어 증액분은 내지 않습니다');
    expect(q.state.log.at(-1)!.textKo).not.toContain('다음 임차일');
  });
  it('S8 확장을 한 번만 허용한다', () => {
    const c = caseOf('P0-M2A5-10'), p = planned(c), cmd: EngineCommand = { id: 'SECOND', type: 'EXPAND_WAREHOUSE' };
    expect(p.results).toEqual(applied(c.actions[0]!.commands));
    expect(planState(p.state, config, [cmd]).results[0]!.reasonKo).toBe('창고 확장은 한 번만 할 수 있습니다(이미 23일부터 확장).');
  });
  it('S9 캠페인 뒤 도착하는 편은 서명 기록에 넣지 않는다', () => {
    const route = config.routes.find((r) => r.transitDays === Math.max(...config.routes.map((r) => r.transitDays)))!;
    const p = planState(fresh(), config, [{ id: 'SPACE-SIGN', type: 'SIGN_SPACE_CONTRACT', routeId: route.id }]);
    const reason = p.state.log.at(-1)!.textKo;
    expect(reason).toBe('선복 장기 계약: 평택 → 하이퐁 9일 편부터 79일 편까지 11편, 편마다 +10 m³·+1,500 kg, 편당 30.00 USD(쓰지 않아도 냄, 해지 없음), 합계 330.00 USD. 출항 7일 전부터 그 편 요금을 묶어 둡니다.');
    expect(reason).not.toContain('12편'); expect(reason).not.toContain('360.00 USD');
  });
  it('S10 규칙 1 미지급 문장과 규칙 2 유예 문장을 나눈다', () => {
    const s = idleRun().days.get(n9.first_unpaid_day)!;
    const text = s.log.find((l) => l.day === n9.first_unpaid_day && l.textKo.startsWith('지급 불가:'))!.textKo;
    expect(text).toBe('지급 불가: 물보리 57일 급여 80,000원 → 미지급 의무로 기록 (14일 안에 갚지 못하면 경영 실패)');
    expect(text).not.toContain('유예기간은 아직 확정되지 않음');
    const cfg = { ...loadScenario(SCENARIO_IDS[0]), startingCash: { ...config.startingCash, KRW: 0 } };
    const legacy = runDays(createGame(cfg), cfg, c6.test_fixture.first_day).state;
    expect(legacy.log.find((l) => l.textKo.startsWith('지급 불가:'))!.textKo).toBe('지급 불가: 귀솔 1일 급여 80,000원 → 미지급 의무로 기록 (지급 불이행 유예기간은 아직 확정되지 않음)');
    expect(legacy.log.map((l) => l.textKo).join('\n')).not.toContain('14일 안에');
  });
  it('S11 나이 6까지 위험이라고 쓰지 않고 미지급 없는 날에는 경고하지 않는다', () => {
    expect(failedState().log.find((l) => l.textKo.startsWith('지급 불이행 경고:'))!.textKo).toBe('지급 불이행 경고: 57일 물보리 57일 급여 80,000원이 밀렸습니다. 71일 마감까지 갚지 못하면 경영 실패입니다.');
    expect(failedState().log.find((l) => l.textKo.startsWith('지급 불이행 위험:'))!.textKo).toBe('지급 불이행 위험: 57일 물보리 57일 급여 80,000원이 밀렸습니다. 71일 마감까지 갚지 못하면 경영 실패입니다.');
    expect(idleRun().days.get(n9.warning_last_day)!.log.map((l) => l.textKo).join('\n')).not.toContain('지급 불이행 위험:');
    expect(idleRun().days.get(n9.first_unpaid_day - 1)!.log.map((l) => l.textKo).join('\n')).not.toContain('지급 불이행 경고:');
  });
  it('S12 정상 완료와 경영 실패의 종료 문장을 구분한다', () => {
    const cmd: EngineCommand = { id: 'AFTER-END', type: 'EXPAND_WAREHOUSE' };
    expect(failedState().log.at(-1)!.textKo).toBe('경영 실패: 57일에 생긴 물보리 57일 급여 80,000원을 14일 동안 갚지 못했습니다');
    expect(planState(failedState(), config, [cmd]).results).toEqual(rejected('캠페인이 끝났습니다(경영 실패).', cmd));
    expect(planState(completedState(), config, [cmd]).results).toEqual(rejected('캠페인이 끝났습니다.', cmd));
    expect(completedState().log.filter((l) => l.textKo.startsWith('경영 실패:'))).toEqual([]);
    expect(planState(completedState(), config, [cmd]).results[0]!.reasonKo).not.toContain('경영 실패');
  });
  it('S13 준비 예측에는 창고 순서를 반영하고 규칙 1 문장은 보존한다', () => {
    const s = planned(caseOf('P0-M2A5-04')).state, c = s.contracts[2]!;
    expect(contractProgress(s, config, c).blockers.filter((b) => b.code === 'TASK_WILL_MISS_SAILING')).toEqual([]);
    const b = s.bookings.find((b) => b.contractId === c.id)!; b.sailingId = s.bookings[0]!.sailingId; b.departureDay = s.bookings[0]!.departureDay;
    expect(contractProgress(s, config, c).blockers.find((b) => b.code === 'TASK_WILL_MISS_SAILING')!.messageKo)
      .toBe('창고 처리 순서를 반영하면 준비가 13일에 끝나 9일 출항을 놓칩니다. 놓치면 운임 중 50.00 USD를 잃고 다시 예약해야 합니다.');
    expect(contractProgress(s, loadScenario(SCENARIO_IDS[0]), c).blockers.find((b) => b.code === 'TASK_WILL_MISS_SAILING')!.messageKo)
      .toBe('지금 속도(하루 2pt)면 준비가 13일에 끝나 9일 출항을 놓칩니다. 놓치면 운임 중 50.00 USD를 잃고 다시 예약해야 합니다.');
  });
  it('S14 자금 부족의 선복 요금 예약은 계약이 있을 때만 적는다', () => {
    const c = caseOf('P0-M2A5-02'), s = atDay(c.actions[0]!.day);
    const cfg = { ...config, startingCash: { ...config.startingCash, USD: c.expected_numeric.need } };
    const base = atDay(c.actions[0]!.day, cfg);
    const signed = planState(base, cfg, [{ id: 'SIGN', type: 'SIGN_SPACE_CONTRACT', routeId: config.routes[0]!.id }]).state;
    signed.operations!.spaceContracts[0]!.signedDay = c.test_fixture.funds_signed_day; signed.operations!.spaceContracts[0]!.firstSailingDay = c.test_fixture.funds_first_sailing_day;
    const result = planState(signed, cfg, c.actions[0]!.commands).results[0]!.reasonKo;
    expect(result).toBe('사용 가능 자금이 부족합니다. 필요 2,259.00 USD(매입 1,980.00 USD + 운임 180.00 USD + 관세 99.00 USD), 사용 가능 2,229.00 USD = 현금 2,259.00 USD − 선복 계약 요금 예약 30.00 USD. 체결한 계약의 남은 운임·관세는 미리 묶어 둡니다.');
    expect(planState(s, config, c.actions[0]!.commands).results[0]!.reasonKo).not.toContain('선복 계약 요금 예약');
  });
  it('S16 원화 미지급이 없으면 지출 보류 설명은 없다', () => {
    expect(paymentDefaultStatus(readAt(n9.failure_day), config).recovery.heldSpendingKo).toBe('미지급이 있는 동안 고용 계약금·훈련·현지 활동·창고 확장은 자금 기준에서 막힙니다');
    expect(paymentDefaultStatus(fresh(), config).recovery.heldSpendingKo).toEqual(null);
  });
  it('S17 계약 체결 기록은 거래처 이름을 쓰고 내부 ID와 겹조사는 없다', () => {
    const p = planned(caseOf('P0-M2A5-02'));
    expect(p.state.log.find((l) => l.textKo.startsWith('계약 CT001 체결'))!.textKo).toBe('계약 CT001 체결: 의류 공급자 → 상하이 의류 고객, 의류 200개 매입 1,980.00 USD 현금 지급, 판매 3,028.00 USD (납기 15일)');
    const q = planned(caseOf('P0-M2A5-04'));
    expect(q.state.log.find((l) => l.textKo.startsWith('계약 CT002 체결'))!.textKo).toBe('계약 CT002 체결(운송 주선): 전자제품 화주 화물 전자제품 300상자, 평택 → 하이퐁');
    for (const text of [...p.state.log, ...q.state.log].filter((l) => l.textKo.startsWith('계약 ')).map((l) => l.textKo)) {
      expect(text).not.toContain('을(를)');
      for (const party of config.operations!.market.counterparties) expect(text).not.toContain(party.id);
    }
  });
  it('S18 새 시나리오 가정 문장은 준비량과 하루 비례 감액을 설명한다', () => {
    const notes = assumptionNotes(config.id as Parameters<typeof assumptionNotes>[0]);
    expect(notes[1]).toBe('직접 무역 수출 준비는 기본 단위 2pt에 단위가 하나 늘 때마다 1pt를 더한다. 일반 운송 주선 준비는 6m³당 1pt(최소 2pt), 작업 포함 운송 주선은 견적마다 12pt다. 직원 1명은 한 번에 업무 1건만 맡는다.');
    expect(notes.join('\n')).not.toContain('각각 2pt'); expect(notes.join('\n')).not.toContain('50 USD 한 번');
  });
  it('S19 늦은 편 안내의 감액은 늦은 날 수에 비례하고 규칙 1은 정액이다', () => {
    const c = caseOf('P0-M2A5-02'), s = planned(c).state, ct = s.contracts[0]!;
    ct.deliveryDeadlineDay = c.expected_numeric.arrival - 3;
    expect(contractProgress(s, config, ct).blockers.find((b) => b.code === 'BOOKED_SAILING_LATE')!.messageKo).toBe('예약한 9일 편은 13일 인도 예정이라 납기 10일을 3일 넘깁니다 (감액 150.00 USD).');
    expect(contractProgress(s, loadScenario(SCENARIO_IDS[0]), ct).blockers.find((b) => b.code === 'BOOKED_SAILING_LATE')!.messageKo).toBe('예약한 9일 편은 13일 인도 예정이라 납기 10일을 3일 넘깁니다 (감액 50.00 USD).');
    ct.deliveryDeadlineDay = c.expected_numeric.arrival - 1;
    expect(contractProgress(s, config, ct).blockers.find((b) => b.code === 'BOOKED_SAILING_LATE')!.messageKo).toBe('예약한 9일 편은 13일 인도 예정이라 납기 12일을 1일 넘깁니다 (감액 50.00 USD).');
    s.bookings[0]!.status = 'CANCELLED'; ct.bookingId = null;
    expect(contractProgress(s, config, ct).blockers.find((b) => b.code === 'NEXT_SAILING_LATE')!.messageKo).toBe('다음 편으로도 13일 인도라 납기 12일을 넘깁니다 (감액 50.00 USD).');
  });
  it('S20 하역 대기는 하루 금액과 상한을 함께 표시한다', () => {
    const c = caseOf('P0-M2A5-02'), s = runDays(planned(c).state, config, c.expected_numeric.departure).state;
    s.day = c.expected_numeric.arrival;
    const ct = s.contracts[0]!, cfg = structuredClone(config);
    cfg.portRestrictions.push({ eventInstanceId: 'TEST-WAIT', templateId: 'TEST-WAIT', cityId: ct.destinationCityId,
      announceDay: s.day, startDay: s.day, endDay: s.day, forecastKo: '시험 하역 중단' });
    expect(contractProgress(s, cfg, ct).blockers[0]!.messageKo).toBe('상하이항 하역 중단으로 바다에서 대기 중입니다 (0일째). 납기 15일을 넘기면 늦은 하루마다 50.00 USD씩, 최대 3,028.00 USD까지 감액됩니다.');
    const legacy = { ...loadScenario(SCENARIO_IDS[0]), portRestrictions: cfg.portRestrictions };
    expect(contractProgress(s, legacy, ct).blockers[0]!.messageKo).toBe('상하이항 하역 중단으로 바다에서 대기 중입니다 (0일째). 납기 15일을 넘기면 50.00 USD 감액됩니다.');
  });
  it('S21 전액 감액은 인도일에 청구서 없이 종결하고 1 cent는 수금한다', () => {
    const f = c7.test_fixture.zero_net, n = c7.expected_numeric.zero_net;
    for (const variant of f.variants) {
      const cfg = structuredClone(config), offer = cfg.offers.find((o) => o.id === variant.offer_id)!;
      offer.deliveryDeadlineDay = f.deadline_day;
      offer.paymentDueDay = f.due_day;
      if (offer.kind === 'forwarding') offer.serviceFeeMinor = variant.amount;
      else offer.unitPriceMinor = variant.amount / offer.quantity;
      const p = planState(fresh(cfg), cfg, [variant.command]);
      expect(p.results).toEqual(applied([variant.command]));
      const before = p.state.contracts[0]!;
      const s = runDays(p.state, cfg, variant.arrival_day).state;
      const delivery = s.log.find((l) => l.textKo.startsWith('CT001 ') && l.textKo.includes('인도 완료'))!.textKo;
      expect(delivery).toBe(variant.delivery_text);
      expect(s.contracts).toEqual([{ ...before, status: 'COMPLETED', completedDay: variant.arrival_day,
        deliveredDay: variant.arrival_day, lateDays: variant.late_days, priceReductionMinor: variant.amount }]);
      expect(s.invoices).toEqual([]);
      expect(delivery).not.toContain('수금 예정');
      expect(s.log.map((l) => l.textKo).join('\n')).not.toContain('대금 0.00 USD 수금');
      expect(contractProgress(s, cfg, s.contracts[0]!).nextKo).toBe(`${variant.arrival_day}일 인도 완료 · 전액 감액으로 종결`);
      expect(summarize(s.ledger, 'USD')).toEqual(book('USD', variant.book));
    }
    const cfg = structuredClone(config), offer = cfg.offers.find((o) => o.id === f.variants[0].offer_id)!;
    offer.deliveryDeadlineDay = f.deadline_day; offer.paymentDueDay = f.due_day; offer.serviceFeeMinor = f.positive_amount;
    const p = planState(fresh(cfg), cfg, [f.variants[0].command]);
    const s = runDays(p.state, cfg, f.variants[0].arrival_day).state;
    const delivery = s.log.find((l) => l.textKo.startsWith('CT001 고객 화물 인도 완료'))!.textKo;
    expect(delivery).toBe(n.positive_delivery);
    expect(delivery).not.toContain('받을 대금이 없습니다');
    expect(s.invoices).toEqual(n.positive_invoices);
    const paid = runDays(s, cfg, f.due_day).state;
    expect(paid.log.find((l) => l.textKo.startsWith('CT001 대금'))!.textKo).toBe(n.positive_receipt);
    expect(paid.invoices).toEqual(n.paid_invoices);
  });
  it('S22 캠페인 뒤 실패일 대신 미지급을 남긴 종료를 경고한다', () => {
    expect(completedState().log.find((l) => l.textKo.startsWith('지급 불이행 경고:'))!.textKo)
      .toBe('지급 불이행 경고: 79일 귀솔 79일 급여 80,000원이 밀렸습니다. 90일 캠페인이 끝날 때까지 갚지 못하면 미지급을 남기고 끝납니다.');
    expect(completedState().log.find((l) => l.textKo.startsWith('지급 불이행 위험:'))!.textKo)
      .toBe('지급 불이행 위험: 79일 귀솔 79일 급여 80,000원이 밀렸습니다. 90일 캠페인이 끝날 때까지 갚지 못하면 미지급을 남기고 끝납니다.');
    expect(completedState().log.find((l) => l.textKo.startsWith('지급 불가:'))!.textKo)
      .toBe('지급 불가: 귀솔 79일 급여 80,000원 → 미지급 의무로 기록 (90일 캠페인이 끝날 때까지 갚지 못하면 미지급을 남기고 끝남)');
    expect(completedState().log.map((l) => l.textKo).join('\n')).not.toContain('93일 마감');
    expect(failedState().log.find((l) => l.textKo.startsWith('지급 불이행 경고:'))!.textKo)
      .toBe('지급 불이행 경고: 57일 물보리 57일 급여 80,000원이 밀렸습니다. 71일 마감까지 갚지 못하면 경영 실패입니다.');
    expect(failedState().log.find((l) => l.textKo.startsWith('지급 불이행 위험:'))!.textKo)
      .toBe('지급 불이행 위험: 57일 물보리 57일 급여 80,000원이 밀렸습니다. 71일 마감까지 갚지 못하면 경영 실패입니다.');
    expect(failedState().log.map((l) => l.textKo).join('\n')).not.toContain('미지급을 남기고 끝남');
  });
  it('S23 현금 0도 부족 설명에 남기고 미지급만 뺀다', () => {
    for (const f of c7.test_fixture.zero_cash) {
      const cfg = { ...config, startingCash: { ...config.startingCash, [f.currency]: 0 } };
      const s = fresh(cfg);
      if (f.obligation) s.obligations.push(f.obligation);
      const reason = planState(s, cfg, [f.command]).results[0]!.reasonKo;
      expect(reason).toBe(f.reason);
      expect(reason).not.toContain('= 미지급');
      if (!f.obligation) expect(reason).not.toContain('− 미지급');
    }
  });
  it('S24 하역 대기는 운영 기능이 아니라 감액 방식으로 문장을 고른다', () => {
    const c = caseOf('P0-M2A5-02'), s = runDays(planned(c).state, config, c.expected_numeric.departure).state;
    s.day = c.expected_numeric.arrival;
    const ct = s.contracts[0]!, cfg = structuredClone(config);
    cfg.portRestrictions.push({ eventInstanceId: 'TEST-WAIT', templateId: 'TEST-WAIT', cityId: ct.destinationCityId,
      announceDay: s.day, startDay: s.day, endDay: s.day, forecastKo: '시험 하역 중단' });
    const flat = { ...cfg, terms: { ...cfg.terms, lateDeliveryBasis: 'FLAT_ONCE' as const, lateDeliveryCapBasisPoints: null } };
    const flatText = contractProgress(s, flat, ct).blockers[0]!.messageKo;
    expect(flatText).toBe('상하이항 하역 중단으로 바다에서 대기 중입니다 (0일째). 납기 15일을 넘기면 50.00 USD 감액됩니다.');
    expect(flatText).not.toContain('늦은 하루마다'); expect(flatText).not.toContain('NaN');
    const proportional = { ...cfg, operations: null };
    const perDayText = contractProgress(s, proportional, ct).blockers[0]!.messageKo;
    expect(perDayText).toBe('상하이항 하역 중단으로 바다에서 대기 중입니다 (0일째). 납기 15일을 넘기면 늦은 하루마다 50.00 USD씩, 최대 3,028.00 USD까지 감액됩니다.');
    expect(perDayText).not.toContain('넘기면 50.00 USD 감액');
  });
});

describe('M2a-5 늦은 인도 감액', () => {
  it('하루 비례와 상한·정액을 인도와 미리 보기에서 함께 계산한다', () => {
    const initial = config.offers.find((o) => o.kind === 'forwarding')!;
    for (const lateDays of [1, Math.ceil(initial.serviceFeeMinor / config.terms.lateDeliveryPriceReductionMinor) + 1]) {
      const cfg = structuredClone(config), offer = cfg.offers.find((o) => o.id === initial.id)!;
      const route = cfg.routes.find((r) => r.toCityId === offer.destinationCityId)!;
      const arrival = route.firstDepartureDay + route.transitDays;
      offer.deliveryDeadlineDay = arrival - lateDays;
      const command: EngineCommand = { id: 'LATE', type: 'ACCEPT_FORWARDING', offerId: offer.id,
        plan: { employeeId: cfg.employees[0]!.id, sailingId: `${route.id}-D${String(route.firstDepartureDay).padStart(3, '0')}` } };
      const s = runDays(createGame(cfg), cfg, arrival, { 1: [command] }).state;
      const reduction = Math.min(initial.serviceFeeMinor, config.terms.lateDeliveryPriceReductionMinor * lateDays), net = initial.serviceFeeMinor - reduction;
      expect(contractReport(s, s.contracts[0]!)).toEqual({ contract: { ...s.contracts[0]!, lateDays, priceReductionMinor: reduction }, netRevenue: net, directCost: route.bookingFeeMinor, cancellationExpense: 0, contribution: net - route.bookingFeeMinor });
      expect([lateDeliveryReduction(cfg, initial.serviceFeeMinor, lateDays), lateDeliveryReduction(loadScenario(SCENARIO_IDS[0]), initial.serviceFeeMinor, lateDays)])
        .toEqual([reduction, config.terms.lateDeliveryPriceReductionMinor]);
      const preview = forwardingPreview(cfg, offer.id, 1)!;
      expect(preview).toEqual({ ...preview, sale: net, contributionBeforePayroll: net - route.bookingFeeMinor,
        schedule: preview.schedule.map((row) => row.labelKo === '외상대금 수금' ? { ...row, amount: net } : row) });
    }
  });
});

describe('M2a-5 통화별 항등식', () => {
  it('환전·임차료·설치비·선복 요금이 있는 모든 마감에서 성립한다', () => {
    const cfg = { ...config, startingCash: { ...config.startingCash, KRW: config.startingCash.KRW! * 10 } };
    const scripts = { ...scriptOf(c7), ...scriptOf(caseOf('P0-M2A5-10')) };
    scripts[1] = [...c7.actions[0]!.commands, ...caseOf('P0-M2A5-11').actions[1]!.commands];
    let s = createGame(cfg);
    while (s.phase !== 'ENDED') {
      s = commitDay(openDay(s, cfg).state, cfg, scripts[s.day] ?? []).state;
      for (const currency of ['USD', 'KRW'] as const) {
        const b = summarize(s.ledger, currency);
        expect({ currency, assetsLessPayable: b.totalAssets - b.accountsPayable }).toEqual({ currency, assetsLessPayable: b.openingEquity + b.profit + b.currencyTransferNet });
      }
    }
  });
});
