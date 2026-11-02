import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { workloadSummary } from './capacity';
import { listSailings, routeBetween, routeOf } from './catalog';
import { counterpartyRecord } from './culture';
import { commitDay, createGame, openDay, planState } from './engine';
import { isAvailableFromToday } from './employees';
import { post, summarize } from './ledger';
import { payrollRunwayDay } from './previews';
import { campaignSummary, contractReport, onTimeDeliveryRate, tradePairs, tradePreview, upcomingPayments } from './reports';
import { spaceShortfall } from './reservations';
import { runDays, standardDayOneCommands } from './testkit';
import type { Command, GameState, Obligation, ScenarioConfig } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const open = (cfg = config) => openDay(createGame(cfg), cfg).state;
const trade = (cfg = config): Command => ({ id: 'ACCEPT', type: 'ACCEPT_TRADE', ...tradePairs(cfg)[0]! });
function plan(s: GameState, commands: Command[], cfg = config) {
  const result = planState(s, cfg, commands);
  expect(result.results.map((r) => r.status)).toEqual(commands.map(() => 'APPLIED'));
  return result.state;
}
function accepted(cfg = config) { return plan(open(cfg), [trade(cfg)], cfg); }
function booking(s: GameState, cfg = config): Command {
  const c = s.contracts[0]!;
  const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
  return { id: 'BOOK', type: 'BOOK_SAILING', contractId: c.id, sailingId: listSailings(cfg, route.id, s.day + 1)[0]!.id };
}
function assign(s: GameState, cfg = config): Command {
  const task = s.tasks.find((t) => t.status === 'QUEUED')!;
  const employee = cfg.employees.find((e) => isAvailableFromToday(s, e.id)
    && s.employees.find((st) => st.id === e.id)!.locationCityId === task.cityId)!;
  return { id: 'ASSIGN', type: 'ASSIGN_TASK', taskId: task.id, employeeId: employee.id };
}
function debt(s: GameState, cfg = config) {
  const amountMinor = cfg.employees[0]!.salaryPerDayMinor;
  const obligation: Obligation = { id: 'TEST-DEBT', currency: cfg.payrollCurrency, amountMinor, reasonKo: '시험 미지급', incurredDay: s.day, paidDay: null };
  s.obligations.push(obligation);
  post(s.ledger, { id: obligation.id, day: s.day, currency: obligation.currency, reason: obligation.reasonKo,
    lines: [{ account: 'WAGE_EXPENSE', amount: amountMinor }, { account: 'ACCOUNTS_PAYABLE', amount: -amountMinor }] });
  return obligation;
}
function delivered(offset = 0) {
  const cfg = structuredClone(loadScenario('SCENARIO_M1_ONE_TRADE'));
  const pair = tradePairs(cfg)[0]!;
  const day = tradePreview(cfg, pair.buyOfferId, pair.sellOfferId, 1)!.arrivalDay! + cfg.terms.customsDays;
  cfg.terms.deliveryDeadlineDay = day + offset;
  const s = runDays(createGame(cfg), cfg, day, { 1: standardDayOneCommands(cfg) }).state;
  return { s, cfg, day };
}
function pure<T>(s: GameState, cfg: ScenarioConfig, read: () => T): T {
  const before = structuredClone({ s, cfg });
  const result = read();
  expect({ s, cfg }).toEqual(before);
  return result;
}

describe('정시 인도율', () => {
  it('납기 당일 정시와 하루 늦은 인도를 엔진 lateDays와 대조한다', () => {
    for (const offset of [0, -1]) {
      const { s, cfg, day } = delivered(offset);
      expect(s.contracts[0]!.deliveredDay).toBe(day);
      expect(s.contracts[0]!.lateDays).toBe(Math.max(0, -offset));
      expect(pure(s, cfg, () => onTimeDeliveryRate(s))).toMatchObject({ delivered: 1, onTime: offset === 0 ? 1 : 0, late: offset === 0 ? 0 : 1 });
    }
  });
  it('취소·미인도 제외, 납기 경과와 내림 비율, 거래처·통화·종류 필터', () => {
    const s = accepted();
    const c = s.contracts[0]!;
    s.day = c.deliveryDeadlineDay + 1;
    s.contracts = [
      { ...c, id: 'ONTIME-A', deliveredDay: c.deliveryDeadlineDay },
      { ...c, id: 'ONTIME-B', kind: 'FORWARDING', currency: config.payrollCurrency, customerId: 'PROBE_SHIPPER', supplierId: null, deliveredDay: c.deliveryDeadlineDay },
      { ...c, id: 'LATE', deliveredDay: c.deliveryDeadlineDay + 1 },
      // 엔진이 만드는 취소 계약은 인도일이 없다. 납기가 지나도 경과 미인도에 넣지 않는다.
      { ...c, id: 'CANCELLED', status: 'CANCELLED', cancelledDay: 2, deliveredDay: null },
      { ...c, id: 'PAST' }, { ...c, id: 'TODAY', deliveryDeadlineDay: s.day },
    ];
    expect(onTimeDeliveryRate(s)).toEqual({ delivered: 3, onTime: 2, late: 1, rateBasisPoints: 6666, pastDeadlineUndelivered: 1 });
    const parties = new Set(s.contracts.flatMap((c) => [c.customerId, c.supplierId]).filter((p): p is string => p !== null));
    for (const partyId of parties) {
      const record = counterpartyRecord(s, partyId);
      expect(onTimeDeliveryRate(s, { partyId })).toMatchObject({ onTime: record.onTime, late: record.late });
    }
    expect(onTimeDeliveryRate(s, { partyId: 'PROBE_SHIPPER' })).toMatchObject({ delivered: 1, onTime: 1, late: 0 });
    expect(onTimeDeliveryRate(s, { currency: config.payrollCurrency })).toMatchObject({ delivered: 1, onTime: 1 });
    expect(onTimeDeliveryRate(s, { kind: 'FORWARDING' })).toMatchObject({ delivered: 1, late: 0 });
    expect(onTimeDeliveryRate(s, { currency: config.tradeCurrency, kind: 'FORWARDING' }).delivered).toBe(0);
    expect(onTimeDeliveryRate(open()).rateBasisPoints).toBeNull();
  });
});

describe('임박 지급', () => {
  it('오늘부터 날·통화별 급여와 미래 근무자 급여를 설정에서 계산한다', () => {
    const s = open();
    const future = s.employees.find((e) => e.id === config.recruitment!.candidateEmployeeIds[0])!;
    future.employmentStatus = 'employed';
    future.availableFromDay = s.day + 3;
    const rows = pure(s, config, () => upcomingPayments(s, config, config.campaignDays)).filter((r) => r.kind === 'WAGE');
    for (let d = s.day; d <= config.campaignDays; d++) {
      const defs = config.employees.filter((def) => def.salaryPerDayMinor > 0 && s.employees.some((e) => e.id === def.id
        && e.employmentStatus === 'employed' && e.availableFromDay <= d));
      for (const currency of new Set(defs.map((def) => def.salaryCurrency))) {
        const paid = defs.filter((def) => def.salaryCurrency === currency);
        const row = rows.find((r) => r.day === d && r.currency === currency)!;
        expect(row).toMatchObject({ amountMinor: paid.reduce((sum, def) => sum + def.salaryPerDayMinor, 0),
          trigger: 'AUTO', contractId: null, sourceId: `WAGE-D${String(d).padStart(3, '0')}-${currency}`, labelKo: `${paid.length}명 급여` });
        expect(new Set(row.employeeIds)).toEqual(new Set(paid.map((def) => def.id)));
      }
    }
    expect(rows.filter((r) => r.day! < future.availableFromDay).every((r) => !r.employeeIds.includes(future.id))).toBe(true);
    expect(rows.find((r) => r.day === future.availableFromDay)!.employeeIds).toContain(future.id);
  });
  it('운임은 공간이 있는 첫 편의 전날이며 예약하면 사라진다', () => {
    const s = accepted();
    const c = s.contracts[0]!;
    const route = routeBetween(config, c.originCityId, c.destinationCityId)!;
    const sailings = listSailings(config, route.id, s.day + 1);
    const expected = sailings.find((sailing) => spaceShortfall(s, config, sailing, c.goodId, c.quantity) === null)!;
    expect(upcomingPayments(s, config, config.campaignDays).find((r) => r.kind === 'FREIGHT')).toMatchObject({
      amountMinor: route.bookingFeeMinor, currency: route.currency, day: expected.departureDay - 1, trigger: 'ON_BOOKING', contractId: c.id, sourceId: c.id, employeeIds: [],
    });
    const booked = plan(s, [booking(s)]);
    expect(upcomingPayments(booked, config, config.campaignDays).some((r) => r.kind === 'FREIGHT')).toBe(false);
    // 이미 꽉 찬 첫 편은 건너뛰고 다음 편을 제시한다.
    const full = structuredClone(s);
    full.bookings.push({ ...booked.bookings[0]!, massGrams: Math.round(route.capacityKg * 1000) });
    expect(upcomingPayments(full, config, config.campaignDays).find((r) => r.kind === 'FREIGHT')!.day).toBe(sailings[1]!.departureDay - 1);
  });
  it('관세는 예약·출항·도착 단계에 따라 바뀌며 주선에는 없다', () => {
    const s = accepted();
    expect(upcomingPayments(s, config, config.campaignDays).find((r) => r.kind === 'DUTY')!.day).toBeNull();
    const booked = plan(s, [assign(s), booking(s)]);
    const b = booked.bookings[0]!;
    const arrival = b.departureDay + routeOf(config, b.routeId).transitDays;
    const row = upcomingPayments(booked, config, config.campaignDays).find((r) => r.kind === 'DUTY')!;
    expect(row).toMatchObject({ day: arrival, trigger: 'AUTO', currency: config.tradeCurrency, contractId: s.contracts[0]!.id, employeeIds: [] });
    const cancelled = structuredClone(booked);
    cancelled.bookings[0]!.status = 'CANCELLED';
    expect(upcomingPayments(cancelled, config, config.campaignDays).find((r) => r.kind === 'DUTY')!.day).toBeNull();
    const sailed = runDays(booked, config, b.departureDay).state;
    expect(upcomingPayments(sailed, config, config.campaignDays).find((r) => r.kind === 'DUTY')!.day).toBe(sailed.shipments[0]!.scheduledArrivalDay);
    const waiting = structuredClone(sailed);
    waiting.day = arrival + 1;
    expect(upcomingPayments(waiting, config, config.campaignDays).find((r) => r.kind === 'DUTY')!.day).toBe(waiting.day);
    const arrived = runDays(sailed, config, arrival).state;
    expect(arrived.shipments[0]!.dutyPaid).toBe(true);
    expect(upcomingPayments(arrived, config, config.campaignDays).some((r) => r.kind === 'DUTY')).toBe(false);
    const forwarding = plan(open(), [{ id: 'FORWARD', type: 'ACCEPT_FORWARDING', offerId: config.offers.find((o) => o.kind === 'forwarding')!.id }]);
    expect(upcomingPayments(forwarding, config, config.campaignDays).some((r) => r.kind === 'DUTY')).toBe(false);
  });
  it('미지급은 기간과 무관하게 맨 앞이며 지급 완료되면 빠진다', () => {
    const s = accepted();
    const obligation = debt(s);
    const rows = upcomingPayments(s, config, s.day - 1);
    expect(rows[0]).toEqual({ kind: 'OVERDUE', currency: obligation.currency, amountMinor: obligation.amountMinor,
      day: obligation.incurredDay, trigger: 'OVERDUE', contractId: null, employeeIds: [], sourceId: obligation.id, labelKo: `미지급: ${obligation.reasonKo}` });
    obligation.paidDay = s.day;
    expect(upcomingPayments(s, config, config.campaignDays).some((r) => r.kind === 'OVERDUE')).toBe(false);
  });
  it('기간 밖 날짜는 제외하고 미정 날짜는 남기며 기본 창은 오늘부터 7일이다', () => {
    const s = accepted();
    const freightDay = upcomingPayments(s, config, config.campaignDays).find((r) => r.kind === 'FREIGHT')!.day!;
    expect(upcomingPayments(s, config, freightDay).some((r) => r.kind === 'FREIGHT')).toBe(true);
    expect(upcomingPayments(s, config, freightDay - 1).some((r) => r.kind === 'FREIGHT')).toBe(false);
    const late = accepted();
    late.day = config.campaignDays - 1;
    const capped = upcomingPayments(late, config, late.day + 6);
    expect(capped.every((r) => r.day === null || r.day <= config.campaignDays)).toBe(true);
    expect(capped).toEqual(upcomingPayments(late, config));
    const short = upcomingPayments(s, config, s.day - 1);
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((r) => r.day === null)).toBe(true);
    expect(upcomingPayments(s, config)).toEqual(upcomingPayments(s, config, Math.min(config.campaignDays, s.day + 6)));
    s.day = config.campaignDays;
    const last = upcomingPayments(s, config);
    expect(last.filter((r) => r.kind === 'WAGE').every((r) => r.day === config.campaignDays)).toBe(true);
    expect(last.find((r) => r.kind === 'FREIGHT')!.day).toBeNull();
  });
  it('종료 상태 임박 지급은 중간 상태에 급여·운임·관세가 있어도 OVERDUE뿐이다', () => {
    const s = accepted();
    debt(s);
    expect(new Set(upcomingPayments(s, config, config.campaignDays).map((r) => r.kind))).toEqual(new Set(['WAGE', 'FREIGHT', 'DUTY', 'OVERDUE']));
    const ended: GameState = { ...s, phase: 'ENDED' };
    const expected = upcomingPayments(s, config, config.campaignDays).filter((r) => r.kind === 'OVERDUE');
    expect(upcomingPayments(ended, config)).toEqual(expected);
    expect(upcomingPayments(ended, config, s.day + 6)).toEqual(expected);
  });
  it('통화·행 식별자·정렬은 결정적이며 상태와 반환값을 공유하지 않는다', () => {
    const s = accepted();
    debt(s);
    s.obligations.push({ ...s.obligations[0]!, id: 'A-DEBT' }, { ...s.obligations[0]!, id: 'OLD-DEBT', incurredDay: s.day - 1 });
    const rows = pure(s, config, () => upcomingPayments(s, config, config.campaignDays));
    expect(rows.slice(0, 3).map((r) => r.sourceId)).toEqual(['OLD-DEBT', 'A-DEBT', 'TEST-DEBT']);
    expect(rows.filter((r) => r.kind === 'WAGE').every((r) => r.currency === config.payrollCurrency)).toBe(true);
    expect(rows.filter((r) => r.kind === 'FREIGHT' || r.kind === 'DUTY').every((r) => r.currency === config.tradeCurrency)).toBe(true);
    expect(new Set(rows.map((r) => `${r.kind}/${r.sourceId}`)).size).toBe(rows.length);
    const dated = rows.filter((r) => r.kind !== 'OVERDUE' && r.day !== null);
    expect(dated.map((r) => r.day)).toEqual(dated.map((r) => r.day).sort((a, b) => a! - b!));
    expect(dated.filter((r) => r.day === s.day).map((r) => r.kind)).toEqual(['WAGE', 'FREIGHT']);
    expect(rows.at(-1)!.kind).toBe('DUTY');
    const before = structuredClone(s);
    rows.find((r) => r.kind === 'WAGE')!.employeeIds.push(config.employees[0]!.id);
    rows[0]!.amountMinor++;
    expect(s).toEqual(before);
  });
  it('미지급과 급여 누적이 현금을 넘는 시점은 payrollRunwayDay와 같다', () => {
    for (const cfg of [config, { ...config, campaignDays: open().day + 6 }]) {
      const s = open(cfg);
      debt(s, cfg);
      const future = s.employees.find((e) => e.id === cfg.recruitment!.candidateEmployeeIds[0])!;
      future.employmentStatus = 'employed';
      future.availableFromDay = s.day + 3;
      const rows = upcomingPayments(s, cfg, cfg.campaignDays).filter((r) => r.currency === cfg.payrollCurrency);
      let cumulative = rows.filter((r) => r.kind === 'OVERDUE').reduce((sum, r) => sum + r.amountMinor, 0);
      let last: number | null = null;
      for (const row of rows.filter((r) => r.kind === 'WAGE')) {
        cumulative += row.amountMinor;
        if (cumulative > summarize(s.ledger, cfg.payrollCurrency).cash) { last = row.day! - 1; break; }
      }
      expect(payrollRunwayDay(s, cfg)).toBe(last);
      expect(last === null).toBe(cfg !== config);
    }
  });
});

describe('진행 중 결산', () => {
  it('통화 분리: 급여 통화 현금 변화는 거래 통화 보고를 바꾸지 않는다', () => {
    const s = runDays(createGame(config), config, 1).state;
    const before = campaignSummary(s, config);
    expect(before.ended).toBe(false);
    expect(before.lastClosedDay).toBe(s.day - 1);
    const copy = structuredClone(s);
    const amount = config.employees[0]!.salaryPerDayMinor;
    post(copy.ledger, { id: 'EXTRA-WAGE', day: s.day, currency: config.payrollCurrency, reason: '시험 급여',
      lines: [{ account: 'WAGE_EXPENSE', amount }, { account: 'CASH', amount: -amount }] });
    const after = campaignSummary(copy, config);
    expect(after.byCurrency.find((r) => r.currency === config.tradeCurrency)).toEqual(before.byCurrency.find((r) => r.currency === config.tradeCurrency));
    expect(after.byCurrency.find((r) => r.currency === config.payrollCurrency)!.cash).toBe(before.byCurrency.find((r) => r.currency === config.payrollCurrency)!.cash - amount);
    expect(campaignSummary(createGame(config), config).lastClosedDay).toBe(0);
  });
  it('인도 후 수금 전 미수와 수금 대기 계약이 일치한다', () => {
    const { s, cfg, day } = delivered();
    expect(day).toBeLessThan(cfg.terms.paymentDueDay!);
    const report = pure(s, cfg, () => campaignSummary(s, cfg));
    const standing = report.byCurrency.find((r) => r.currency === cfg.tradeCurrency)!;
    expect(standing.accountsReceivable).toBeGreaterThan(0);
    expect(standing.accountsReceivable).toBe(report.openInvoices.filter((i) => i.currency === cfg.tradeCurrency).reduce((sum, i) => sum + i.amountMinor, 0));
    expect(report.contracts.awaitingPayment).toBe(1);
    const before = structuredClone(s);
    report.openInvoices[0]!.amountMinor++;
    expect(s).toEqual(before);
    const beyond = structuredClone(s);
    beyond.invoices[0]!.dueDay = cfg.campaignDays + 1;
    expect(campaignSummary(beyond, cfg).openInvoices[0]!.dueDay).toBe(cfg.campaignDays + 1);
  });
  it('계약 네 분류와 취소 포함 기여이익, 다른 장부 통화 정렬', () => {
    const s = accepted();
    const c = s.contracts[0]!;
    s.contracts = [c, { ...c, id: 'DONE', status: 'COMPLETED', deliveredDay: s.day },
      { ...c, id: 'WAIT', status: 'IN_PROGRESS', deliveredDay: s.day }, { ...c, id: 'CANCEL', status: 'CANCELLED' }];
    const amount = config.terms.preDepartureCancellationFeeMinor;
    post(s.ledger, { id: 'CANCEL-COST', day: s.day, currency: c.currency, contractId: 'CANCEL', reason: '시험 취소',
      lines: [{ account: 'CANCELLATION_EXPENSE', amount }, { account: 'CASH', amount: -amount }] });
    for (const currency of ['XXX'] as const) post(s.ledger, { id: `OPEN-${currency}`, day: s.day, currency, reason: '시험 시작 자본',
      lines: [{ account: 'CASH', amount }, { account: 'OPENING_EQUITY', amount: -amount }] });
    const report = campaignSummary(s, config);
    expect(report.contracts).toEqual({ total: 4, completed: 1, awaitingPayment: 1, inProgress: 1, cancelled: 1 });
    const { total, completed, awaitingPayment, inProgress, cancelled } = report.contracts;
    expect(completed + awaitingPayment + inProgress + cancelled).toBe(total);
    expect(report.byCurrency.map((r) => r.currency)).toEqual([config.tradeCurrency, config.payrollCurrency, 'XXX']);
    for (const row of report.byCurrency) expect(row.contractContribution).toBe(s.contracts.filter((c) => c.currency === row.currency).reduce((sum, c) => sum + contractReport(s, c).contribution, 0));
    expect(campaignSummary(s, { ...config, payrollCurrency: config.tradeCurrency }).byCurrency.map((r) => r.currency))
      .toEqual([config.tradeCurrency, ...new Set(s.ledger.entries.map((e) => e.currency).filter((c) => c !== config.tradeCurrency).sort())]);
  });
});

describe('업무량과 가용 처리량', () => {
  it('미배정 준비 업무를 배정하면 진행 중으로 옮기고 하루 처리량만큼 줄어든다', () => {
    const cfg = { ...config, terms: { ...config.terms, prepWorkUnits: config.employees.reduce((sum, e) => sum + e.workUnitsPerDay, 0) * 3 + 1 } };
    const s = accepted(cfg);
    const cityId = s.tasks[0]!.cityId;
    const queued = workloadSummary(s, cfg).byCity.find((c) => c.cityId === cityId)!;
    expect(queued.unassignedWorkUnits).toBe(cfg.terms.prepWorkUnits);
    expect(queued.unassignedTaskIds).toEqual([s.tasks[0]!.id]);
    const assigned = plan(s, [assign(s, cfg)], cfg);
    const report = workloadSummary(assigned, cfg);
    const row = report.byCity.find((c) => c.cityId === cityId)!;
    expect(row.unassignedWorkUnits).toBe(0);
    expect(row.runningWorkUnits).toBe(cfg.terms.prepWorkUnits);
    expect(row.daysToClear).toBe(Math.ceil(row.runningWorkUnits / row.staffWorkUnitsPerDay));
    const worker = report.employees.find((e) => e.running !== null)!;
    expect(worker.running).toMatchObject({ unit: 'WORK_UNITS', remaining: cfg.terms.prepWorkUnits });
    expect(row.idleWorkUnitsPerDay).toBe(row.staffWorkUnitsPerDay - worker.workUnitsPerDay);
    expect(row.dayTaskWorkUnitsPerDay).toBe(0);
    const next = commitDay(assigned, cfg, []).state;
    expect(workloadSummary(next, cfg).byCity.find((c) => c.cityId === cityId)!.runningWorkUnits).toBe(cfg.terms.prepWorkUnits - worker.workUnitsPerDay);
    expect(workloadSummary(next, cfg).employees.find((e) => e.employeeId === worker.employeeId)!.running!.remaining)
      .toBe(cfg.terms.prepWorkUnits - worker.workUnitsPerDay);
  });
  it('훈련 중 처리량은 일수 업무에 들어가며 유휴에 들어가지 않는다', () => {
    const s = open();
    const employee = config.employees.find((e) => isAvailableFromToday(s, e.id))!;
    const trained = plan(s, [{ id: 'TRAIN', type: 'START_TRAINING', employeeId: employee.id }]);
    const report = pure(trained, config, () => workloadSummary(trained, config));
    const worker = report.employees.find((e) => e.employeeId === employee.id)!;
    const city = report.byCity.find((c) => c.cityId === worker.cityId)!;
    expect(worker.running).toMatchObject({ kind: 'TRAINING', unit: 'DAYS', remaining: config.growth!.ordinaryTraining.durationDays });
    expect(city.dayTaskWorkUnitsPerDay).toBe(employee.workUnitsPerDay);
    expect(city.idleWorkUnitsPerDay).toBe(city.staffWorkUnitsPerDay - employee.workUnitsPerDay);
    expect(city.unassignedWorkUnits + city.runningWorkUnits).toBe(0);
    expect(city.daysToClear).toBe(0);
  });
  it('현지 활동도 일수 단위이고 업무 포인트 처리량을 점유한다', () => {
    const s = open();
    const activity = config.culture!.activities.find((a) => s.employees.some((e) => isAvailableFromToday(s, e.id) && e.locationCityId === a.cityId))!;
    const employee = config.employees.find((def) => s.employees.some((e) => e.id === def.id && isAvailableFromToday(s, e.id) && e.locationCityId === activity.cityId))!;
    const working = plan(s, [{ id: 'CULTURE', type: 'START_CULTURE_ACTIVITY', activityId: activity.id, employeeId: employee.id }]);
    const report = workloadSummary(working, config);
    expect(report.employees.find((e) => e.employeeId === employee.id)!.running).toMatchObject({ kind: 'CULTURE', unit: 'DAYS', remaining: activity.durationDays });
    expect(report.byCity.find((c) => c.cityId === activity.cityId)!.dayTaskWorkUnitsPerDay).toBe(employee.workUnitsPerDay);
  });
  it('내일 근무자는 startingLater에만 있으며 순서와 상태 위치를 따른다', () => {
    const s = open();
    const future = s.employees.find((e) => e.id === config.recruitment!.candidateEmployeeIds[0])!;
    future.employmentStatus = 'employed';
    future.availableFromDay = s.day + 1;
    const report = workloadSummary(s, config);
    expect(report.startingLater).toEqual([{ employeeId: future.id, availableFromDay: future.availableFromDay,
      workUnitsPerDay: config.employees.find((e) => e.id === future.id)!.workUnitsPerDay }]);
    expect(report.employees.map((e) => e.employeeId)).toEqual(config.employees.filter((e) => isAvailableFromToday(s, e.id)).map((e) => e.id));
    expect(report.employees.some((e) => e.employeeId === future.id)).toBe(false);
    for (const row of report.byCity) expect(row.staffWorkUnitsPerDay).toBe(report.employees.filter((e) => e.cityId === row.cityId).reduce((sum, e) => sum + e.workUnitsPerDay, 0));
  });
  it('업무 없으면 0, 모두 훈련 중이라 처리량이 없으면 null이다', () => {
    const s = open();
    expect(workloadSummary(s, config).byCity.every((c) => c.daysToClear === 0)).toBe(true);
    const commands: Command[] = config.employees.filter((e) => isAvailableFromToday(s, e.id))
      .map((e, i) => ({ id: `TRAIN-${i}`, type: 'START_TRAINING', employeeId: e.id }));
    const busy = plan(s, [...commands, trade()]);
    const row = workloadSummary(busy, config).byCity.find((c) => c.cityId === busy.tasks.find((t) => t.kind === 'EXPORT_PREP')!.cityId)!;
    expect(row.unassignedWorkUnits).toBe(config.terms.prepWorkUnits);
    expect(row.dayTaskWorkUnitsPerDay).toBe(row.staffWorkUnitsPerDay);
    expect(row.idleWorkUnitsPerDay).toBe(0);
    expect(row.daysToClear).toBeNull();
  });
  it('다른 도시 업무는 본사 처리량을 쓸 수 없으며 반환 객체는 독립적이다', () => {
    const s = accepted();
    const cityId = config.routes[0]!.toCityId;
    s.tasks[0]!.cityId = cityId;
    const report = pure(s, config, () => workloadSummary(s, config));
    expect(report.byCity.find((c) => c.cityId === cityId)).toMatchObject({ staffWorkUnitsPerDay: 0, daysToClear: null, unassignedWorkUnits: config.terms.prepWorkUnits });
    expect(report.byCity.map((c) => c.cityId)).toEqual(report.byCity.map((c) => c.cityId).sort());
    const before = structuredClone(s);
    report.byCity.find((c) => c.cityId === cityId)!.unassignedTaskIds.push('반환값만 수정');
    report.employees[0]!.cityId = cityId;
    expect(s).toEqual(before);
    s.employees.find((e) => e.id === report.employees[0]!.employeeId)!.locationCityId = cityId;
    expect(workloadSummary(s, config).byCity.find((c) => c.cityId === cityId)!.staffWorkUnitsPerDay).toBe(config.employees.find((e) => e.id === report.employees[0]!.employeeId)!.workUnitsPerDay);
  });
});
