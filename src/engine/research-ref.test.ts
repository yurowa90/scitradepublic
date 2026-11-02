// 아스트라 플레이 연구(references/playthrough_research_2026-10-05)의 제안 중 이번에 적용한 항목의 완료 조건.
// REF-02 계약 확정 전 검사·일괄 예약, REF-10 막힌 이유 표시.

import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay, planCommands, planState } from './engine';
import { summarize } from './ledger';
import { toMinor } from './money';
import { contractProgress } from './progress';
import { cashReservations } from './reservations';
import { runDays } from './testkit';
import type { Command, CommitPlan, ScenarioConfig } from './types';

const usd = (amount: number) => toMinor('USD', amount);
const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const cosmetics = (id: string, plan?: CommitPlan): Command => ({
  id, type: 'ACCEPT_TRADE', buyOfferId: 'OFFER_BUY_02', sellOfferId: 'OFFER_SELL_02', ...(plan ? { plan } : {}),
});
const fwd = (id: string, offerId: string, plan?: CommitPlan): Command => ({
  id, type: 'ACCEPT_FORWARDING', offerId, ...(plan ? { plan } : {}),
});

describe('REF-02 일괄 확정: 수락·준비 배정·운송편 예약을 한 번에, 하나라도 안 되면 전부 철회', () => {
  it('모두 가능하면 계약·배정·예약이 함께 생기고 단계별 명령과 같은 장부가 된다', () => {
    const atomic = runDays(createGame(config), config, 1, { 1: [cosmetics('A', { employeeId: 'EMP01', sailingId: 'ROUTE02-D002' })] });
    expect(atomic.results[1]![0]!.status).toBe('APPLIED');
    const stepwise = runDays(createGame(config), config, 1, {
      1: [cosmetics('A'), { id: 'B', type: 'ASSIGN_TASK', taskId: 'TASK001', employeeId: 'EMP01' }, { id: 'C', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: 'ROUTE02-D002' }],
    });
    expect(summarize(atomic.state.ledger, 'USD')).toEqual(summarize(stepwise.state.ledger, 'USD'));
    expect(atomic.state.tasks[0]!.status).toBe('DONE');
    expect(atomic.state.bookings[0]!.status).toBe('BOOKED');
  });

  it('운송편이 계약 구간과 다르면 수락까지 철회하고 견적·현금·예약을 그대로 둔다', () => {
    const game = openDay(createGame(config), config).state;
    const plan = planCommands(game, config, [cosmetics('A', { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' })]);
    expect(plan[0]!.status).toBe('REJECTED');
    expect(plan[0]!.reasonKo).toContain('한 번에 확정할 수 없습니다 — 운송편 예약 불가:');
    const { state } = runDays(createGame(config), config, 1, { 1: [cosmetics('A', { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' })] });
    expect(state.contracts).toHaveLength(0);
    expect(state.offers.find((o) => o.id === 'OFFER_BUY_02')!.status).toBe('OPEN');
    expect(summarize(state.ledger, 'USD').cash).toBe(usd(3000));
    expect(cashReservations(state, config)).toEqual([]);
  });

  it.each([
    [{ employeeId: '없는직원' }, '준비 배정 불가'],
    [{ employeeId: 'EMP01', sailingId: 'ROUTE01-D002' }, '운송편 예약 불가'],
  ] as const)('미리 보기와 확정 거절 기록은 같은 현재형 이유를 쓴다: %s', (commitPlan, failure) => {
    const cmd = cosmetics('REJECT', commitPlan);
    const game = openDay(createGame(config), config).state;
    const preview = planCommands(game, config, [cmd])[0]!;
    expect(preview.status).toBe('REJECTED');
    expect(preview.reasonKo).toMatch(new RegExp(`^한 번에 확정할 수 없습니다 — ${failure}: .+ 견적도 수락하지 않습니다\\.$`));
    expect(preview.reasonKo).not.toContain('철회했습니다');
    const committed = runDays(game, config, 1, { 1: [cmd] });
    expect(committed.results[1]![0]!.reasonKo).toBe(preview.reasonKo);
    expect(committed.state.processedCommands[cmd.id]!.reasonKo).toBe(preview.reasonKo);
    expect(committed.state.contracts).toHaveLength(0);
  });

  it('직원이 이미 다른 업무 중이면 두 번째 일괄 확정은 철회되고 첫 계약은 그대로다', () => {
    const { state, results } = runDays(createGame(config), config, 1, {
      1: [fwd('F1', 'OFFER_FWD_01', { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' }), fwd('F2', 'OFFER_FWD_02', { employeeId: 'EMP01', sailingId: 'ROUTE01-D009' })],
    });
    expect(results[1]!.map((r) => r.status)).toEqual(['APPLIED', 'REJECTED']);
    expect(results[1]![1]!.reasonKo).toContain('준비 배정 불가');
    expect(state.contracts.map((c) => c.serviceOfferId)).toEqual(['OFFER_FWD_01']);
    expect(state.offers.find((o) => o.id === 'OFFER_FWD_02')!.status).toBe('OPEN');
  });

  it('같은 명령 ID를 다시 보내도 일괄 확정은 한 번만 반영된다', () => {
    const cmd = fwd('SAME', 'OFFER_FWD_01', { employeeId: 'EMP02', sailingId: 'ROUTE01-D002' });
    const { state, results } = runDays(createGame(config), config, 1, { 1: [cmd, cmd] });
    expect(results[1]!.map((r) => r.status)).toEqual(['APPLIED', 'DUPLICATE']);
    expect([state.contracts.length, state.bookings.length]).toEqual([1, 1]);
  });
});

describe('REF-10 계약이 막힌 이유를 처리량·운항표와 같은 근거로 설명', () => {
  it('배정·예약 전: 담당 없음과 예약 없음을 따로 알리고, 하루가 지나 급한 편을 놓치면 납기 위험을 더한다', () => {
    // 1일 의사결정 중: 2일 편 예약이 아직 가능하다.
    const day1 = planState(openDay(createGame(config), config).state, config, [fwd('F1', 'OFFER_FWD_01')]).state;
    const p = contractProgress(day1, config, day1.contracts[0]!);
    expect(p.blockers.map((b) => b.code)).toEqual(['TASK_UNASSIGNED', 'NO_BOOKING']);
    expect(p.nextKo).toBe('준비 업무 배정 필요');
    // 아무것도 하지 않고 2일이 되면 다음 편은 9일 출항 → 14일 인도라 납기 8일을 넘긴다.
    const day2 = runDays(createGame(config), config, 1, { 1: [fwd('F1', 'OFFER_FWD_01')] }).state;
    expect(contractProgress(day2, config, day2.contracts[0]!).blockers.map((b) => b.code)).toEqual(['TASK_UNASSIGNED', 'NO_BOOKING', 'NEXT_SAILING_LATE']);
  });

  it('준비 속도가 출항에 못 미치면 출항 불참 위험을 미리 알린다', () => {
    const slow: ScenarioConfig = { ...config, terms: { ...config.terms, forwardingPrepWorkUnits: 6 } };
    const { state } = runDays(createGame(slow), slow, 1, { 1: [fwd('F1', 'OFFER_FWD_01', { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' })] });
    const p = contractProgress(state, slow, state.contracts[0]!);
    expect(p.blockers.map((b) => b.code)).toContain('TASK_WILL_MISS_SAILING');
    // 실제로도 2일 출항을 놓친다. 표시와 결과가 같다.
    const after = runDays(state, slow, 2).state;
    expect(after.bookings[0]!.status).toBe('CANCELLED');
  });

  it('납기를 넘기는 편을 예약하면 감액 위험을 알리고, 정상 편이면 위험이 없다', () => {
    const late = runDays(createGame(config), config, 1, { 1: [fwd('F1', 'OFFER_FWD_01', { employeeId: 'EMP01', sailingId: 'ROUTE01-D009' })] }).state;
    expect(contractProgress(late, config, late.contracts[0]!).blockers.map((b) => b.code)).toEqual(['BOOKED_SAILING_LATE']);
    const ok = runDays(createGame(config), config, 1, { 1: [fwd('F1', 'OFFER_FWD_01', { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' })] }).state;
    expect(contractProgress(ok, config, ok.contracts[0]!).blockers).toEqual([]);
  });

  it('하역 중단 대기와 수금 대기를 구분한다 (M1 지연 사례)', () => {
    const m1 = loadScenario('SCENARIO_M1_DELAY_ACCEPTED');
    const script = {
      1: [
        { id: 'A', type: 'ACCEPT_TRADE' as const, buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01', plan: { employeeId: 'EMP01', sailingId: 'ROUTE01-D002' } },
      ],
    };
    const waiting = runDays(createGame(m1), m1, 7, script).state;
    expect(contractProgress(waiting, m1, waiting.contracts[0]!).blockers.map((b) => b.code)).toEqual(['WAITING_PORT_RESTRICTION']);
    const delivered = runDays(createGame(m1), m1, 9, script).state;
    const p = contractProgress(delivered, m1, delivered.contracts[0]!);
    expect(p.blockers.map((b) => b.code)).toEqual(['AWAITING_PAYMENT']);
    expect(p.nextKo).toBe('11일 수금 대기');
  });
});
