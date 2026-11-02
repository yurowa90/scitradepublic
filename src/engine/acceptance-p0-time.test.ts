import { describe, expect, it } from 'vitest';
import acceptance from '../../tests/acceptance_cases.json';
import { loadScenario } from '../content/scenario';
import { commitDay, createGame, openDay } from './engine';
import { summarize } from './ledger';
import { drawUniform } from './rng';
import { deserializeSave, serializeSave } from './save';
import { runDays } from './testkit';
import type { Command, GameState, ScenarioConfig } from './types';

type TimeCase = { id: string; initial_state: Record<string, number>; expected_numeric: Record<string, number> };
const spec = (acceptance as unknown as { cases: TimeCase[] }).cases.find((c) => c.id === 'P0-TIME-01')!;
const initial = spec.initial_state;
const expected = spec.expected_numeric;
const day = initial.simulation_day!;
const wage = expected.wage_expense_each_branch!;
const base = loadScenario('SCENARIO_M2_MULTI_TRADE');
const cfg: ScenarioConfig = { ...base, seed: initial.random_seed!, payrollCurrency: 'XXX',
  startingCash: { XXX: initial.company_cash! + wage * (day - 1) },
  employees: [{ ...base.employees[0]!, salaryCurrency: 'XXX', salaryPerDayMinor: wage }],
  recruitment: null, culture: null,
  portRestrictions: [{ eventInstanceId: 'EVENT_A', templateId: 'TEST_EVENT', cityId: base.routes[0]!.toCityId,
    announceDay: day, startDay: day + 1, endDay: day + 1, forecastKo: '시험용 가상 공지' }],
};
const commands: Command[] = [{ id: 'CMD-T01', type: 'CANCEL_CONTRACT', contractId: 'NO-SUCH-CONTRACT' }];
const restore = (s: GameState) => deserializeSave(serializeSave(s), { dataVersion: cfg.dataVersion, config: cfg });
const wageEntries = (s: GameState) => s.ledger.entries.filter((e) => e.day === day && e.id.startsWith('WAGE-D'));

function prepare() {
  let s = createGame(cfg);
  for (let i = 0; i < initial.random_cursor!; i++) s.rng = drawUniform(s.rng, 'events').rng;
  s = runDays(s, cfg, day - 1).state;
  expect(s.phase).toBe('PENDING_OPEN');
  expect(s.day).toBe(day);
  expect(summarize(s.ledger, 'XXX').cash).toBe(initial.company_cash);
  return s;
}

// 명세의 입력 대기·사건 0건은 동시에 성립하지 않는다. 사건 적용 전/후 저장으로 나눠 확인한다.
describe('P0-TIME-01 저장·불러오기 후 하루 마감과 사건 적용 재현', () => {
  for (const opened of [false, true]) {
    const timing = opened ? '(나) openDay 뒤' : '(가) openDay 전';
    function branches() {
      const prepared = prepare();
      const saved = opened ? openDay(prepared, cfg).state : prepared;
      expect(Object.keys(saved.appliedEventIds)).toHaveLength(opened ? expected.event_applied_count_each_branch! : 0);
      const a = openDay(saved, cfg);
      const b = openDay(restore(saved), cfg);
      expect(a.announcements).toHaveLength(opened ? 0 : expected.event_applied_count_each_branch!);
      expect(b.announcements).toEqual(a.announcements);
      if (opened) {
        expect(a.state).toBe(saved);
        expect(b.state).toEqual(saved);
      }
      const A = commitDay(a.state, cfg, commands);
      const B = commitDay(b.state, cfg, commands);
      expect(A.results[0]!.status).toBe('REJECTED');
      expect(B.results).toEqual(A.results);
      return { A: A.state, B: B.state, prepared };
    }
    it(`${timing}: 분기 동일성과 급여·마감·사건 횟수`, () => {
      const { A, B } = branches();
      expect(A).toEqual(B);
      for (const s of [A, B]) {
        expect(summarize(s.ledger, 'XXX').cash).toBe(initial.company_cash! - wage);
        expect(wageEntries(s).flatMap((e) => e.lines).filter((l) => l.account === 'WAGE_EXPENSE')
          .reduce((sum, l) => sum + l.amount, 0)).toBe(wage);
        expect(s.closedDays.filter((d) => d === day)).toHaveLength(expected.daily_closure_count_each_branch!);
        expect(Object.keys(s.appliedEventIds)).toHaveLength(expected.event_applied_count_each_branch!);
        expect(s.notices.filter((n) => n.eventInstanceId === 'EVENT_A')).toHaveLength(expected.event_applied_count_each_branch!);
      }
    });
    it(`${timing}: 마감 재전송은 저장 복원 전후 모두 무시한다`, () => {
      const { B } = branches();
      for (const s of [B, restore(B)]) {
        const result = commitDay(s, cfg, commands, day);
        expect(result.alreadyClosed).toBe(true);
        expect(result.state).toEqual(B);
        expect(summarize(result.state.ledger, 'XXX').cash).toBe(summarize(B.ledger, 'XXX').cash);
        expect(wageEntries(result.state)).toEqual(wageEntries(B));
      }
    });
    it(`${timing}: 사건 재전송과 명령 ID 보존`, () => {
      const { B } = branches();
      const duplicate = { ...cfg, portRestrictions: [...cfg.portRestrictions, { ...cfg.portRestrictions[0]!, announceDay: day + 1 }] };
      const next = openDay(restore(B), duplicate);
      expect(next.announcements).toEqual([]);
      expect(Object.keys(next.state.appliedEventIds)).toHaveLength(expected.event_applied_count_each_branch!);
      expect(next.state.notices.filter((n) => n.eventInstanceId === 'EVENT_A')).toHaveLength(expected.event_applied_count_each_branch!);
      expect(commitDay(next.state, duplicate, commands).results[0]!.status).toBe('DUPLICATE');
    });
    it(`${timing}: 난수 커서와 다음 추첨을 보존한다`, () => {
      const { A, B, prepared } = branches();
      for (const s of [A, B]) {
        expect(s.rng).toEqual(prepared.rng);
        expect(s.rng.cursors.events).toBe(initial.random_cursor);
      }
      expect(drawUniform(A.rng, 'events')).toEqual(drawUniform(B.rng, 'events'));
    });
  }
  it.todo('검사비 3(EVENT_A 비용 사건, M3) 반영 뒤 분기마다 현금 company_cash_each_branch 확인');
});
