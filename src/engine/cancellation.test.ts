import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, EngineError, openDay, planState } from './engine';
import { checkInvariants } from './invariants';
import { summarize } from './ledger';
import { runDays } from './testkit';
import type { Command } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const accept: Command = { id: 'TRADE', type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02' };
const book: Command = { id: 'BOOK', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: 'ROUTE02-D009' };
const cancel: Command = { id: 'CANCEL', type: 'CANCEL_CONTRACT', contractId: 'CT001' };

describe('예약별 선급 운임에서 고정 취소비 정산', () => {
  it.each(['취소', '출항 불참'])('ROUTE02 %s: 130 USD 환급·50 USD 비용으로 정산하고 다음 날도 진행한다', (path) => {
    const first = runDays(createGame(config), config, 1, { 1: [accept, book] });
    expect(first.results[1]!.map((r) => r.status)).toEqual(['APPLIED', 'APPLIED']);
    const lastDay = path === '취소' ? 2 : 9;
    const result = runDays(first.state, config, lastDay, path === '취소' ? { 2: [cancel] } : {});
    if (path === '취소') expect(result.results[2]![0]!.status).toBe('APPLIED');
    const s = result.state;
    const release = s.ledger.entries.find((e) => e.id === 'FREIGHT-RELEASE-BK001')!;
    expect(release.lines).toEqual([
      { account: 'PREPAID_FREIGHT', amount: -18_000 },
      { account: 'CASH', amount: 13_000 },
      { account: 'CANCELLATION_EXPENSE', amount: 5_000 },
    ]);
    expect(release.reason).toContain('130.00 USD 환급, 취소비 50.00 USD');
    const purchase = s.contracts[0]!.purchaseAmountMinor;
    const report = summarize(s.ledger, 'USD');
    expect(report).toMatchObject({ cash: config.startingCash.USD! - purchase - 5_000,
      inventory: purchase, prepaidFreight: 0, cancellationExpense: 5_000, accountsPayable: 0 });
    expect(report.totalAssets).toBe(report.openingEquity + report.profit);
    expect(s.ledger.entries.every((e) => e.lines.reduce((sum, l) => sum + l.amount, 0) === 0)).toBe(true);
    expect(s.bookings[0]!.status).toBe('CANCELLED');
    expect(s.shipments).toEqual([]);
    expect(s.cargoLots[0]).toMatchObject({ owner: 'COMPANY', carryingAmountMinor: purchase,
      status: path === '취소' ? 'HELD_UNALLOCATED' : 'PREPARING',
      contractId: path === '취소' ? null : 'CT001', locationCityId: 'PYEONGTAEK' });
    checkInvariants(s, config);
    const continued = runDays(s, config, lastDay + 1).state;
    expect(continued.day).toBe(lastDay + 2);
    expect(continued.ledger.entries.filter((e) => e.id === release.id)).toHaveLength(1);
    checkInvariants(continued, config);
  });

  it.each(['취소', '출항 불참'])('운송 주선 예약 %s도 정산하고 고객 화물을 회사 재고로 만들지 않는다', (path) => {
    const s = runDays(createGame(config), config, path === '취소' ? 2 : 9, {
      1: [{ id: 'FWD', type: 'ACCEPT_FORWARDING', offerId: 'OFFER_FWD_01' }, { ...book, sailingId: 'ROUTE01-D009' }],
      2: path === '취소' ? [cancel] : [],
    }).state;
    expect(s.ledger.entries.find((e) => e.id === 'FREIGHT-RELEASE-BK001')!.lines).toEqual([
      { account: 'PREPAID_FREIGHT', amount: -20_000 }, { account: 'CASH', amount: 15_000 },
      { account: 'CANCELLATION_EXPENSE', amount: 5_000 },
    ]);
    expect(summarize(s.ledger, 'USD')).toMatchObject({ inventory: 0, prepaidFreight: 0, forwardingWip: 0, cancellationExpense: 5_000 });
    expect(s.cargoLots[0]).toMatchObject({ owner: 'CUSTOMER', carryingAmountMinor: 0,
      status: path === '취소' ? 'RETURNED_TO_OWNER' : 'PREPARING' });
    expect(runDays(s, config, s.day).state.day).toBe(s.day + 1);
    checkInvariants(s, config);
  });

  it('취소비가 선급 운임보다 크면 입력을 보존하고 자료 오류를 명시한다', () => {
    const s = planState(openDay(createGame(config), config).state, config, [accept, book]).state;
    const before = structuredClone(s);
    const cfg = structuredClone(config);
    cfg.terms.preDepartureCancellationFeeMinor = 18_001;
    const execute = () => planState(s, cfg, [cancel]);
    expect(execute).toThrow(/자료 오류.*취소비.*선급운임/);
    expect(execute).not.toThrow(EngineError);
    expect(s).toEqual(before);
  });
});
