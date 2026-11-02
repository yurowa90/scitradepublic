import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay, planCommands } from './engine';
import { campaignSummary, tradePairs, upcomingPayments } from './reports';
import { deserializeSave, serializeSave } from './save';
import { acceptAllFeasible, runToCampaignEnd } from './testkit';
import type { GameState } from './types';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const start = openDay(createGame(config), config).state;
const commands = acceptAllFeasible(start, config);
const ended = runToCampaignEnd(start, config, { [start.day]: commands }).state;

function identities(s: GameState) {
  const report = campaignSummary(s, config);
  for (const row of report.byCurrency) {
    expect(row.netAssets).toBe(row.totalAssets - row.accountsPayable);
    expect(row.netAssets).toBe(row.openingEquity + row.profit);
    expect(row.accountsReceivable).toBe(report.openInvoices.filter((i) => i.currency === row.currency).reduce((sum, i) => sum + i.amountMinor, 0));
    expect(row.accountsPayable).toBe(report.unpaidObligations.filter((o) => o.currency === row.currency).reduce((sum, o) => sum + o.amountMinor, 0));
  }
  expect(report.openInvoices).toEqual(s.invoices.filter((i) => i.status !== 'PAID')
    .map((i) => ({ invoiceId: i.id, contractId: i.contractId, currency: i.currency, amountMinor: i.amountMinor, dueDay: i.dueDay }))
    .sort((a, b) => a.dueDay - b.dueDay || a.invoiceId.localeCompare(b.invoiceId)));
  expect(report.unpaidObligations).toEqual(s.obligations.filter((o) => o.paidDay === null)
    .map((o) => ({ obligationId: o.id, currency: o.currency, amountMinor: o.amountMinor, incurredDay: o.incurredDay, reasonKo: o.reasonKo }))
    .sort((a, b) => a.incurredDay - b.incurredDay || a.obligationId.localeCompare(b.obligationId)));
}

describe('첫날 정책 도우미', () => {
  it('앞서 고른 직원을 빼고 직접 무역과 운송 주선을 함께 고른다', () => {
    const pair = tradePairs(config)[0]!;
    const fwd = config.offers.find((o) => o.kind === 'forwarding')!;
    const cfg = { ...config, offers: config.offers.filter((o) => [pair.buyOfferId, pair.sellOfferId, fwd.id].includes(o.id)) };
    const cmds = acceptAllFeasible(openDay(createGame(cfg), cfg).state, cfg);
    expect(cmds.map((c) => c.type)).toEqual(['ACCEPT_TRADE', 'ACCEPT_FORWARDING']);
    const staff = cmds.map((c) => (c as { plan?: { employeeId?: string } }).plan?.employeeId);
    expect(staff.every((id) => typeof id === 'string')).toBe(true);
    expect(new Set(staff).size).toBe(2);
  });
});

describe('M2 캠페인 결산', () => {
  it('정책은 입력을 보존하고 실행 가능한 계획과 연속 명령 ID를 만든다', () => {
    const before = structuredClone(start);
    expect(acceptAllFeasible(start, config)).toEqual(commands);
    expect(start).toEqual(before);
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.map((c) => c.id)).toEqual(commands.map((_, i) => `AUTO-D${start.day}-${i + 1}`));
    expect(planCommands(start, config, commands).every((r) => r.status === 'APPLIED')).toBe(true);
    const unavailable = structuredClone(start);
    unavailable.employees.forEach((e) => { e.availableFromDay = start.day + 1; });
    expect(acceptAllFeasible(unavailable, config)).toEqual([]);
  });
  it('캠페인 마지막 날까지 한 번씩 마감하고 종료한다', () => {
    expect(ended.phase).toBe('ENDED');
    expect(ended.day).toBe(config.campaignDays + 1);
    expect(ended.closedDays).toEqual(Array.from({ length: config.campaignDays }, (_, i) => i + 1));
    expect(campaignSummary(ended, config)).toMatchObject({ ended: true, campaignDays: config.campaignDays, lastClosedDay: config.campaignDays });
  });
  it('정책으로 한 건 이상 인도하고 정시·지연 건수가 일치한다', () => {
    const { onTime } = campaignSummary(ended, config);
    expect(onTime.delivered).toBeGreaterThanOrEqual(1);
    expect(onTime.onTime + onTime.late).toBe(onTime.delivered);
    expect(onTime.delivered).toBe(ended.contracts.filter((c) => c.deliveredDay !== null).length);
  });
  it('통화별 순자산 항등식과 미수·미지급 명세가 일치한다', () => {
    identities(ended);
    expect(campaignSummary(ended, config).unpaidObligations.length).toBeGreaterThan(0);
  });
  it('거래·급여 통화를 중복 없이 분리한다', () => {
    const report = campaignSummary(ended, config);
    const currencies = report.byCurrency.map((r) => r.currency);
    expect(currencies.slice(0, 2)).toEqual([config.tradeCurrency, config.payrollCurrency]);
    expect(new Set(currencies).size).toBe(currencies.length);
    expect(Object.keys(report).sort()).toEqual(['ended', 'campaignDays', 'lastClosedDay', 'byCurrency', 'onTime', 'contracts', 'openInvoices', 'unpaidObligations'].sort());
  });
  it('주요 계약 없이도 정상 결산한다', () => {
    const empty = runToCampaignEnd(createGame(config), config).state;
    expect(empty.phase).toBe('ENDED');
    expect(campaignSummary(empty, config)).toMatchObject({ ended: true, onTime: { delivered: 0, rateBasisPoints: null }, contracts: { total: 0 } });
    identities(empty);
  });
  it('상태·설정을 보존하고 저장 복원 뒤 결산이 같다', () => {
    const before = structuredClone({ ended, config });
    const report = campaignSummary(ended, config);
    const restored = deserializeSave(serializeSave(ended), { dataVersion: config.dataVersion, config });
    expect(campaignSummary(restored, config)).toEqual(report);
    expect({ ended, config }).toEqual(before);
    report.unpaidObligations[0]!.reasonKo = '반환값만 수정';
    expect({ ended, config }).toEqual(before);
  });
  it('종료 뒤 지급 목록은 미지급금과 같은 OVERDUE뿐이다', () => {
    const rows = upcomingPayments(ended, config);
    expect(rows.every((r) => r.kind === 'OVERDUE')).toBe(true);
    for (const standing of campaignSummary(ended, config).byCurrency) {
      expect(rows.filter((r) => r.currency === standing.currency).reduce((sum, r) => sum + r.amountMinor, 0)).toBe(standing.accountsPayable);
    }
  });
});
