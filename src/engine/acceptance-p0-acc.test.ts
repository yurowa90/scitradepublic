// tests/acceptance_cases.json의 통화 없는 회계 사례(P0-ACC-01, P0-ACC-02)를 장부·수금 규칙에 연결한다.
// 각 사례는 새 상태에서 시작하며 이전 사례 상태를 이어받지 않는다.

import { describe, expect, it } from 'vitest';
import acceptance from '../../tests/acceptance_cases.json';
import { loadScenario } from '../content/scenario';
import { applyReceipt, createGame } from './engine';
import { emptyLedger, post, summarize, type Ledger } from './ledger';
import { deserializeSave, serializeSave } from './save';
import { listSailings, routeBetween } from './catalog';
import { companyReport, tradePreview } from './reports';
import { runDays } from './testkit';
import type { ScenarioConfig, GameState } from './types';

type Case = { id: string; expected_numeric: Record<string, number> };
const cases = (acceptance as unknown as { cases: Case[] }).cases;
const spec = (id: string) => cases.find((c) => c.id === id)!.expected_numeric;

function xxx(ledger: Ledger, id: string, lines: [Parameters<typeof post>[1]['lines'][number]['account'], number][]) {
  post(ledger, { id, day: 1, currency: 'XXX', reason: id, lines: lines.map(([account, amount]) => ({ account, amount })) });
}

describe('P0-ACC-01 외상 판매의 현금·채권·이익 분리', () => {
  it('엔진 명령 경로(수락·예약·출항·도착·인도·급여)로도 같은 값이 나온다', () => {
    const e = spec('P0-ACC-01');
    const base = loadScenario('SCENARIO_M1_ONE_TRADE');
    const buy = base.offers.find((o) => o.kind === 'supplier')!;
    const sell = base.offers.find((o) => o.kind === 'customer')!;
    const route = routeBetween(base, buy.cityId, sell.cityId)!;
    // 명세 시작 현금 100, 1단계 매입 60, 2단계 운임 5·관세 3, 3단계 판매 90, 4단계 임금 4.
    const cfg: ScenarioConfig = { ...base, tradeCurrency: 'XXX', payrollCurrency: 'XXX', startingCash: { XXX: 100 },
      routes: [{ ...route, currency: 'XXX', bookingFeeMinor: 5 }],
      offers: [{ ...buy, currency: 'XXX', quantity: 1, unitPriceMinor: 60 },
        { ...sell, currency: 'XXX', quantity: 1, unitPriceMinor: 90 }],
      employees: [{ ...base.employees[0]!, salaryCurrency: 'XXX', salaryPerDayMinor: 0 },
        { ...base.employees[0]!, id: 'ACC-WAGE', salaryCurrency: 'XXX', salaryPerDayMinor: 4 }],
      terms: { ...base.terms, dutyRateBasisPoints: 500 },
    };
    const deliveryDay = tradePreview(cfg, buy.id, sell.id, 1)!.arrivalDay! + cfg.terms.customsDays;
    cfg.terms.deliveryDeadlineDay = deliveryDay;
    cfg.terms.paymentDueDay = deliveryDay + 1;
    const start = createGame(cfg);
    start.employees.find((employee) => employee.id === 'ACC-WAGE')!.availableFromDay = deliveryDay;
    const result = runDays(start, cfg, deliveryDay, { 1: [{ id: 'ACC-ACCEPT', type: 'ACCEPT_TRADE',
      buyOfferId: buy.id, sellOfferId: sell.id,
      plan: { employeeId: cfg.employees[0]!.id, sailingId: listSailings(cfg, route.id, 2)[0]!.id } }] });
    const s = result.state;
    expect(result.results[1]![0]!.status).toBe('APPLIED');
    const b = summarize(s.ledger, 'XXX');
    expect(b.cash).toBe(e.company_cash);
    expect(b.accountsReceivable).toBe(e.accounts_receivable);
    expect(b.inventory).toBe(e.inventory_carrying_amount);
    expect(b.revenue).toBe(e.revenue);
    expect(b.costOfGoodsSold).toBe(e.cost_of_goods_sold);
    expect(b.wageExpense).toBe(e.wage_expense);
    expect(b.profit).toBe(e.profit);
    expect(b.totalAssets).toBe(e.total_assets);
    expect(companyReport(s, cfg).inventoryUnits).toBe(e.inventory_units);
    expect(s.cargoLots.filter((lot) => lot.status === 'DELIVERED')).toHaveLength(1);
    expect(s.contracts[0]!.deliveredDay).toBe(deliveryDay);
    const prefixes = ['PURCHASE-', 'FREIGHT-PREPAY-', 'FREIGHT-CAPITALIZE-', 'DUTY-', 'SALE-', 'COGS-', 'WAGE-D'];
    for (const prefix of prefixes) expect(s.ledger.entries.filter((entry) => entry.id.startsWith(prefix))).toHaveLength(1);
    expect(s.ledger.entries).toHaveLength(prefixes.length + 1);
    const capitalized = s.ledger.entries.flatMap((entry) => entry.lines)
      .filter((line) => line.account === 'INVENTORY' && line.amount > 0).reduce((sum, line) => sum + line.amount, 0);
    expect(b.costOfGoodsSold).toBe(capitalized);
    const expenseAccounts = s.ledger.entries.flatMap((entry) => entry.lines)
      .filter((line) => line.account.endsWith('_EXPENSE') || line.account.endsWith('_COST') || line.account === 'COST_OF_GOODS_SOLD')
      .map((line) => line.account);
    expect(new Set(expenseAccounts)).toEqual(new Set(['COST_OF_GOODS_SOLD', 'WAGE_EXPENSE']));
  });

  it('매입·운송·관세는 매출원가 68을 한 번만 구성한다', () => {
    const e = spec('P0-ACC-01');
    const l = emptyLedger();
    xxx(l, 'open', [['CASH', 100], ['OPENING_EQUITY', -100]]);
    xxx(l, 'purchase', [['INVENTORY', 60], ['CASH', -60]]);
    xxx(l, 'freight', [['INVENTORY', 5], ['CASH', -5]]);
    xxx(l, 'duty', [['INVENTORY', 3], ['CASH', -3]]);
    xxx(l, 'sale', [['ACCOUNTS_RECEIVABLE', 90], ['REVENUE', -90]]);
    xxx(l, 'cogs', [['COST_OF_GOODS_SOLD', 68], ['INVENTORY', -68]]);
    xxx(l, 'wage', [['WAGE_EXPENSE', 4], ['CASH', -4]]);
    const b = summarize(l, 'XXX');
    expect(b.cash).toBe(e.company_cash);
    expect(b.accountsReceivable).toBe(e.accounts_receivable);
    expect(b.inventory).toBe(e.inventory_carrying_amount);
    expect(b.revenue).toBe(e.revenue);
    expect(b.costOfGoodsSold).toBe(e.cost_of_goods_sold);
    expect(b.wageExpense).toBe(e.wage_expense);
    expect(b.profit).toBe(e.profit);
    expect(b.totalAssets).toBe(e.total_assets);
  });
});

describe('P0-ACC-02 외상대금 수금과 중복 수금 방지', () => {
  function fixtureState(): GameState {
    const s = createGame(loadScenario('SCENARIO_M1_ONE_TRADE'));
    s.ledger = emptyLedger();
    xxx(s.ledger, 'open', [['CASH', 100], ['OPENING_EQUITY', -100]]);
    xxx(s.ledger, 'net-before', [['CASH', -72], ['ACCOUNTS_RECEIVABLE', 90], ['REVENUE', -90], ['COST_OF_GOODS_SOLD', 68], ['WAGE_EXPENSE', 4]]);
    s.invoices.push({ id: 'INV_A', contractId: 'CT_A', currency: 'XXX', amountMinor: 90, issuedDay: 1, dueDay: 1, status: 'OUTSTANDING', receiptIds: [] });
    return s;
  }

  it('같은 수금 ID를 재전송하고 저장·불러오기 후 다시 보내도 한 번만 반영한다', () => {
    const e = spec('P0-ACC-02');
    const s = fixtureState();
    const before = summarize(s.ledger, 'XXX');
    expect([before.cash, before.accountsReceivable, before.profit]).toEqual([28, 90, 18]);

    expect(applyReceipt(s, 'RECEIPT_A', 'INV_A')).toBe(true);
    expect(applyReceipt(s, 'RECEIPT_A', 'INV_A')).toBe(false);
    const reloaded = deserializeSave(serializeSave(s), { dataVersion: s.meta.dataVersion });
    expect(applyReceipt(reloaded, 'RECEIPT_A', 'INV_A')).toBe(false);

    const b = summarize(reloaded.ledger, 'XXX');
    expect(b.cash).toBe(e.company_cash);
    expect(b.accountsReceivable).toBe(e.accounts_receivable);
    expect(b.revenue).toBe(e.revenue);
    expect(b.profit).toBe(e.profit);
    expect(b.totalAssets).toBe(e.total_assets);
    expect(reloaded.invoices[0]!.receiptIds).toHaveLength(e.receipt_applied_count!);
  });
});
