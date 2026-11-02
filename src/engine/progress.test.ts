import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay, planState } from './engine';
import { cargoSpace } from './catalog';
import { summarize } from './ledger';
import { contractProgress, portWaitStatus } from './progress';
import { runDays, standardDayOneCommands } from './testkit';
import type { Command } from './types';

const cosmetics: Command[] = [
  { id: 'A', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02' },
  { id: 'B', type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId: 'EMP01' },
  { id: 'C', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: 'ROUTE02-D002' },
];

describe('항만 대기와 오늘 도착 구분', () => {
  it('M2 화장품 6일 판단 단계는 경고 없이 오늘 도착을 안내하고 그대로 도착·인도한다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const state = openDay(runDays(createGame(config), config, 5, { 1: cosmetics }).state, config).state;
    expect(state.day).toBe(6);
    expect(state.shipments[0]).toMatchObject({ scheduledArrivalDay: 6, arrivalDay: null, observedWaitDays: 0 });
    const before = structuredClone(state);
    expect(contractProgress(state, config, state.contracts[0]!)).toEqual({
      nextKo: '오늘 도착 예정 — 하루 진행 때 하역합니다', blockers: [],
    });
    expect(state).toEqual(before);
    const after = runDays(state, config, 6).state;
    expect(after.shipments[0]).toMatchObject({ arrivalDay: 6, releaseDay: 6, observedWaitDays: 0, delayEventIds: [] });
    expect(after.contracts[0]).toMatchObject({ deliveredDay: 6, lateDays: 0, priceReductionMinor: 0 });
    expect(after.invoices[0]).toMatchObject({ dueDay: 12, amountMinor: 250_000 });
    expect(after.log).toContainEqual({ day: 6, textKo: 'SH001 도착: 상하이. 관세 100.00 USD 지급' });
    expect(after.ledger.entries.find((e) => e.id === 'SALE-CT001')).toMatchObject({ day: 6 });
    expect(summarize(after.ledger, 'USD')).toMatchObject({ cash: 72_000, accountsReceivable: 250_000 });
    const collected = runDays(after, config, 12).state;
    expect(collected.contracts[0]).toMatchObject({ status: 'COMPLETED', completedDay: 12 });
    expect(summarize(collected.ledger, 'USD')).toMatchObject({ cash: 322_000, accountsReceivable: 0 });
  });

  it.each([
    [5, 'SHANGHAI', 5, 8, 'AT_SEA'],
    [6, 'HAIPHONG', 6, 8, 'ARRIVING_TODAY'],
    [6, 'SHANGHAI', 7, 8, 'ARRIVING_TODAY'],
    [6, 'SHANGHAI', 4, 5, 'ARRIVING_TODAY'],
    [6, 'SHANGHAI', 6, 6, 'WAITING_RESTRICTION'],
  ] as const)('%i일·%s항 제한 %i~%i일은 %s이고 상태를 바꾸지 않는다', (day, cityId, startDay, endDay, status) => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    config.portRestrictions = [{ eventInstanceId: 'TEST', templateId: 'EV02', cityId, startDay, endDay,
      announceDay: 1, forecastKo: '시험용 하역 제한' }];
    const state = openDay(runDays(createGame(config), config, day - 1, { 1: cosmetics }).state, config).state;
    const before = structuredClone(state), beforeConfig = structuredClone(config);
    expect(portWaitStatus(state, config, state.shipments[0]!)).toBe(status);
    expect(state).toEqual(before);
    expect(config).toEqual(beforeConfig);
  });

  it('이미 도착한 화물은 뒤에 항만 제한이 생겨도 대기로 표시하지 않는다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const state = runDays(createGame(config), config, 6, { 1: cosmetics }).state;
    config.portRestrictions = [{ eventInstanceId: 'TEST', templateId: 'EV02', cityId: 'SHANGHAI',
      startDay: 7, endDay: 8, announceDay: 7, forecastKo: '시험용 하역 제한' }];
    expect(portWaitStatus(state, config, state.shipments[0]!)).toBe('ARRIVED');
  });

  it('예보 전이라도 제한 기간이면 하역 재개 대기로 판정한다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    config.portRestrictions = [{ eventInstanceId: 'LATE-FORECAST', templateId: 'EV02', cityId: 'SHANGHAI',
      startDay: 6, endDay: 8, announceDay: 7, forecastKo: '시험용 늦은 예보' }];
    const state = openDay(runDays(createGame(config), config, 5, { 1: cosmetics }).state, config).state;
    expect(state.day).toBeLessThan(config.portRestrictions[0]!.announceDay);
    const before = structuredClone(state);
    expect(portWaitStatus(state, config, state.shipments[0]!)).toBe('WAITING_RESTRICTION');
    expect(contractProgress(state, config, state.contracts[0]!)).toMatchObject({
      nextKo: '하역 재개 대기', blockers: [{ code: 'WAITING_PORT_RESTRICTION' }],
    });
    expect(state).toEqual(before);
  });

  it('M1 제한 양 끝날에는 실제 대기 일수로 경고하고 9일에는 하역 재개를 알린다', () => {
    const config = loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
    let state = runDays(createGame(config), config, 6, { 1: standardDayOneCommands(config) }).state;
    for (const day of [7, 8]) {
      state = openDay(state, config).state;
      expect(state.day).toBe(day);
      expect(contractProgress(state, config, state.contracts[0]!).nextKo).toBe('하역 재개 대기');
      expect(contractProgress(state, config, state.contracts[0]!).blockers).toEqual([{
        code: 'WAITING_PORT_RESTRICTION', severity: 'warn',
        messageKo: `하이퐁항 하역 중단으로 바다에서 대기 중입니다 (${day - 7}일째). 납기 8일을 넘기면 50.00 USD 감액됩니다.`,
      }]);
      state = runDays(state, config, day).state;
    }
    state = openDay(state, config).state;
    expect(state.shipments[0]!.observedWaitDays).toBe(2);
    expect(contractProgress(state, config, state.contracts[0]!)).toEqual({
      nextKo: '하역 재개 — 오늘 도착 예정 (대기 2일)', blockers: [],
    });
    const arrived = runDays(state, config, 9).state;
    expect(arrived.shipments[0]).toMatchObject({ arrivalDay: 9, observedWaitDays: 2 });
    expect(arrived.contracts[0]).toMatchObject({ deliveredDay: 9, priceReductionMinor: 5_000 });
    expect(summarize(runDays(arrived, config, 11).state.ledger, 'USD').cash).toBe(1_010_000);
  });
});

describe('TASK-0013 수금일과 선복 안내', () => {
  it.each([11, 12, 13])('%i일 미수 화장품 계약은 수금일 전후를 구분하고 상태를 바꾸지 않는다', (day) => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const state = openDay(runDays(createGame(config), config, Math.min(day - 1, 11), { 1: cosmetics }).state, config).state;
    // 기한이 지난 미수 상태도 읽기 모델에서 같은 오늘 안내를 쓴다.
    state.day = day;
    const before = structuredClone(state);
    expect(contractProgress(state, config, state.contracts[0]!)).toEqual({
      nextKo: day < 12 ? '12일 수금 대기' : '오늘 수금 예정 — 하루 진행 때 받습니다',
      blockers: [{ code: 'AWAITING_PAYMENT', severity: 'info', messageKo: day < 12
        ? '인도는 끝났고 12일에 2,500.00 USD를 받습니다. 그때까지 현금은 들어오지 않습니다.'
        : '인도는 끝났고 오늘 하루 진행 때 2,500.00 USD를 받습니다.' }],
    });
    expect(state).toEqual(before);
  });

  it.each(['무게', '부피'] as const)('%s가 가득 찬 첫 편 대신 실을 수 있는 편으로 안내·납기 위험을 계산한다', (dimension) => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    const firstOffer = config.offers.find((o) => o.id === 'OFFER_FWD_01')!;
    const occupied = cargoSpace(config, firstOffer.goodId, firstOffer.quantity);
    const route = config.routes.find((r) => r.id === 'ROUTE01')!;
    route.capacityKg = dimension === '무게' ? occupied.massGrams / 1000 : 1_000_000;
    route.capacityM3 = dimension === '부피' ? occupied.volumeLiters / 1000 : 1_000_000;
    const state = openDay(runDays(createGame(config), config, 1, { 1: [
      { id: 'F1', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01', plan: { sailingId: 'ROUTE01-D009' } },
      { id: 'F2', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_02' },
    ] }).state, config).state;
    expect(state.bookings).toHaveLength(1);
    const contract = state.contracts[1]!;
    const before = structuredClone(state), beforeConfig = structuredClone(config);
    expect(contractProgress(state, config, contract).blockers).toContainEqual({
      code: 'NO_BOOKING', severity: 'warn',
      messageKo: '운송편을 예약하지 않았습니다. 9일 편은 선복이 부족합니다. 실을 수 있는 첫 출항은 16일이고 예약 마감은 15일입니다.',
    });
    expect(contractProgress(state, config, contract).blockers).toContainEqual({
      code: 'NEXT_SAILING_LATE', severity: 'risk',
      messageKo: '다음 편으로도 21일 인도라 납기 15일을 넘깁니다 (감액 50.00 USD).',
    });
    expect(state).toEqual(before); expect(config).toEqual(beforeConfig);

    config.campaignDays = 15;
    expect(contractProgress(state, config, contract).blockers).toEqual([
      { code: 'TASK_UNASSIGNED', severity: 'warn', messageKo: '준비 업무 2pt를 아직 아무에게도 배정하지 않았습니다. 배정하기 전에는 화물이 출발할 수 없습니다.' },
      { code: 'NO_SAILING_LEFT', severity: 'risk', messageKo: '캠페인 안에 이 화물을 실을 공간이 남은 출항편이 없습니다.' },
    ]);
    state.bookings[0]!.status = 'CANCELLED';
    expect(contractProgress(state, config, contract).blockers).toContainEqual({
      code: 'NO_BOOKING', severity: 'warn', messageKo: '운송편을 예약하지 않았습니다. 다음 출항은 9일이고 예약 마감은 8일입니다.',
    });
    expect(contractProgress(state, config, contract).blockers.some((b) => b.code === 'NEXT_SAILING_LATE')).toBe(false);
    state.day = 15;
    expect(contractProgress(state, config, contract).blockers.at(-1)?.code).toBe('NO_SAILING_LEFT');
  });

  it('빈 배에도 이 화물을 실을 수 없으면 위험 안내를 한다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
    config.routes.find((r) => r.id === 'ROUTE02')!.capacityKg = 0;
    const state = planState(openDay(createGame(config), config).state, config, [cosmetics[0]!]).state;
    expect(contractProgress(state, config, state.contracts[0]!).blockers.at(-1)).toEqual({
      code: 'NO_SAILING_LEFT', severity: 'risk', messageKo: '캠페인 안에 이 화물을 실을 공간이 남은 출항편이 없습니다.',
    });
  });
});
