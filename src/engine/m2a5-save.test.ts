import { describe, expect, it } from 'vitest';
import fixture from './fixtures/save-v5-m2.json';
import { loadScenario, SCENARIO_IDS } from '../content/scenario';
import { commitDay, createGame, openDay, planState } from './engine';
import { checkInvariants } from './invariants';
import { summarize } from './ledger';
import { campaignSummary, upcomingPayments } from './reports';
import { findSailing } from './catalog';
import { fundsPosition, sailingLoad } from './reservations';
import { deserializeSave, SAVE_FORMAT_VERSION, serializeSave } from './save';
import { checkSaveShape } from './save-shape';
import { runDays } from './testkit';
import { applied, atDay, book, caseOf, config, fresh, planned, scriptOf } from './m2a5-testkit';
import type { EngineCommand, GameState } from './types';

const c12 = caseOf('P0-M2A5-12'), c13 = caseOf('P0-M2A5-13');
const load = (s: GameState, cfg = config) => deserializeSave(serializeSave(s), { dataVersion: cfg.dataVersion, config: cfg });

describe('P0-M2A5-12 기존 기대값 보존', () => {
  it('화장품과 주선 두 건의 하루별 장부·자금 예약을 보존한다', () => {
    const n = c12.expected_numeric, script = scriptOf(c12);
    const first = runDays(createGame(config), config, c12.actions[0]!.day, script);
    expect(first.results[c12.actions[0]!.day]).toEqual(applied(c12.actions[0]!.commands));
    expect(fundsPosition(first.state, config, 'USD')).toEqual(n.day1_funds);
    const seventh = runDays(first.state, config, config.operations!.market.publish.intervalDays, script).state;
    expect(summarize(seventh.ledger, 'USD')).toEqual(book('USD', n.day7_book));
    const end = runDays(seventh, config, c12.test_fixture.last_check_day, script).state;
    expect(summarize(end.ledger, 'USD')).toEqual(book('USD', n.day17_book));
    expect(summarize(end.ledger, 'KRW')).toEqual(book('KRW', { cash: n.day17_krw, totalAssets: n.day17_krw,
      rentExpense: config.operations!.fixedCosts.rent.amountMinor, wageExpense: c12.test_fixture.last_check_day * caseOf('P0-M2A5-06').expected_numeric.wage_daily,
      profit: n.day17_krw - config.startingCash.KRW! }));
  });
  it('의류 경로도 기존 USD 검산 값을 보존한다', () => {
    const script = structuredClone(scriptOf(c12));
    const command = script[c12.actions[0]!.day]![0] as Extract<EngineCommand, { type: 'ACCEPT_TRADE' }>;
    command.buyOfferId = c12.test_fixture.apparel_buy; command.sellOfferId = c12.test_fixture.apparel_sell;
    command.plan!.sailingId = c12.test_fixture.apparel_sailing;
    const end = runDays(createGame(config), config, c12.test_fixture.last_check_day, script).state;
    expect(summarize(end.ledger, 'USD')).toEqual(book('USD', c12.expected_numeric.apparel_book));
  });
  it('두 거절 경로의 전체 문장·자금·선복 값과 철회를 보존한다', () => {
    for (const f of c12.test_fixture.rejections) for (const signed of [false, true]) {
      const initial = signed ? planState(fresh(), config, [c12.test_fixture.rejection_space_command]).state : fresh();
      const before = planState(initial, config, f.commands.slice(0, -1));
      expect(before.results).toEqual(applied(f.commands.slice(0, -1)));
      const rejected = planState(before.state, config, f.commands.slice(-1));
      expect(rejected.results).toEqual([{ commandId: f.commands.at(-1).id, status: 'REJECTED', reasonKo: f.reason }]);
      expect(fundsPosition(rejected.state, config, 'USD')).toEqual(f.funds);
      if (f.sailing_id) expect(sailingLoad(rejected.state, config, findSailing(config, f.sailing_id)!)).toEqual(f.load);
      expect({ ...rejected.state, processedCommands: before.state.processedCommands }).toEqual(before.state);
    }
  });

});

describe('P0-M2A5-13 저장 판본 7과 재현', () => {
  it('마감 직후·환전 계획·확장 계획 저장을 전체 상태로 재현한다', () => {
    const script = scriptOf(c13), days = c13.expected_numeric.save_days as number[];
    const close = runDays(createGame(config), config, days[0]!).state;
    expect(close.phase).toBe('PENDING_OPEN');
    expect(load(close)).toEqual(close);
    let live = close, restored = load(close);
    for (const a of c13.actions) {
      live = openDay(runDays(live, config, a.day - 1, script).state, config).state;
      restored = openDay(runDays(restored, config, a.day - 1, script).state, config).state;
      live = planState(live, config, a.commands).state;
      restored = load(planState(restored, config, a.commands).state);
      expect(restored).toEqual(live);
    }
    expect(runDays(restored, config, config.campaignDays).state).toEqual(runDays(live, config, config.campaignDays).state);
    expect([JSON.parse(serializeSave(live)).formatVersion, SAVE_FORMAT_VERSION]).toEqual([c13.expected_numeric.save_version, c13.expected_numeric.save_version]);
  });
  it('판본 5는 새 문구로 거절한다', () => {
    expect(() => deserializeSave(JSON.stringify(fixture), { dataVersion: config.dataVersion })).toThrow(`이전 저장 형식(판본 ${5})의 저장입니다. 이번 판(판본 7)에서는 열 수 없습니다. 새로 시작해 주세요.`);
  });
  it('생성 견적의 모든 필드가 저장 모양 검사 대상이다', () => {
    const original = runDays(createGame(config), config, c13.expected_numeric.save_days[0]).state;
    for (const field of Object.keys(original.operations!.offers[0]!)) {
      const damaged = JSON.parse(serializeSave(original));
      delete damaged.state.operations.offers[0][field];
      expect(() => deserializeSave(JSON.stringify(damaged), { dataVersion: config.dataVersion })).toThrow(`operations.offers[0].${field}`);
    }
    expect(() => checkSaveShape(original)).not.toThrow();
  });
  it('운영 상태의 모든 하위 필드 누락과 잘못된 자료형을 거절한다', () => {
    const c9 = caseOf('P0-M2A5-09');
    const original = runDays(createGame(config), config, config.campaignDays).state;
    const ops = original.operations!;
    ops.expansions = planned(caseOf('P0-M2A5-10')).state.operations!.expansions;
    ops.exchanges = planned(caseOf('P0-M2A5-07')).state.operations!.exchanges;
    ops.spaceContracts = planState(fresh(), config, c9.test_fixture.same_day_commands.slice(0, 1)).state.operations!.spaceContracts;
    ops.handlingLog = commitDay(planned(caseOf('P0-M2A5-04')).state, config, []).state.operations!.handlingLog;
    ops.failure!.optionalKrwSpendBeforeFirstUnpaid = c9.expected_numeric.optional_spending;
    ops.failure!.usdCommitmentsSinceIncurred = c9.expected_numeric.same_day_commitments;
    expect(() => checkSaveShape(original)).not.toThrow();
    const paths: (string | number)[][] = [];
    const shapes = new Set<string>();
    function collect(value: unknown, path: (string | number)[]) {
      if (Array.isArray(value)) { value.forEach((v, i) => collect(v, [...path, i])); return; }
      if (!value || typeof value !== 'object') return;
      for (const [key, child] of Object.entries(value)) {
        if (key === 'offers') continue; // 견적 전체 필드는 바로 앞 시험이 다룬다.
        const next = [...path, key], shape = next.map((k) => typeof k === 'number' ? '[]' : k).join('.');
        // 같은 배열 원소 모양은 한 번 검사하고, null인 첫 원소 뒤의 하위 모양도 찾아간다.
        if (!shapes.has(shape)) { shapes.add(shape); paths.push(next); }
        collect(child, next);
      }
    }
    collect(ops, ['operations']);
    const serialized = serializeSave(original);
    for (const path of paths) for (const damage of ['missing', 'type']) {
      const damaged = JSON.parse(serialized);
      let parent = damaged.state;
      for (const key of path.slice(0, -1)) parent = parent[key];
      const key = path.at(-1)!;
      if (damage === 'missing') delete parent[key]; else parent[key] = false;
      const label = path.map((k, i) => typeof k === 'number' ? `[${k}]` : `${i ? '.' : ''}${k}`).join('');
      expect(() => deserializeSave(JSON.stringify(damaged), { dataVersion: config.dataVersion })).toThrow(label);
    }
  });

});

describe('M2a-5 불변 조건', () => {
  const warehouse = planned(caseOf('P0-M2A5-03')).state;
  it('보관 초과 저장을 거절한다', () => {
    const s = structuredClone(warehouse); s.cargoLots[0]!.quantity *= 2;
    expect(() => load(s)).toThrow('보관량이 창고 보관 한도를 넘었습니다');
  });
  it('처리 초과와 직원별 배분 초과를 거절한다', () => {
    const s = commitDay(planned(caseOf('P0-M2A5-04')).state, config, []).state;
    const over = structuredClone(s); over.operations!.handlingLog.at(-1)!.usedPt++;
    expect(() => load(over)).toThrow('창고 처리량이 하루 처리 한도를 넘었습니다');
    s.operations!.handlingLog.at(-1)!.waits[0]!.gotPt = config.operations!.facility.handlingWorkUnitsPerDay;
    expect(() => load(s)).toThrow('업무별 창고 배분량이 직원 처리량을 넘었습니다');
  });
  it('선복 합계가 확장 한도를 넘으면 거절한다', () => {
    const s = structuredClone(warehouse); s.bookings[0]!.volumeLiters *= 2;
    expect(() => load(s)).toThrow('예약 화물이 선복 한도를 넘었습니다');
  });
  it('미래 공개·누락 묶음·중복 견적을 거절한다', () => {
    const original = atDay(c13.expected_numeric.save_days[1]);
    const future = structuredClone(original); future.operations!.offers[0]!.publishDay++;
    expect(() => load(future)).toThrow('공개 묶음·견적에 미래 공개 또는 누락이 있습니다');
    const missing = structuredClone(original); missing.operations!.batches.pop();
    expect(() => load(missing)).toThrow('공개 묶음·견적에 미래 공개 또는 누락이 있습니다');
    const duplicate = structuredClone(original); duplicate.operations!.offers.push(duplicate.operations!.offers[0]!);
    expect(() => load(duplicate)).toThrow('생성 견적 ID는 유일해야 합니다');
  });
  it('환전 분개 짝·통화 이체 불일치를 거절한다', () => {
    const s = planned(caseOf('P0-M2A5-07')).state;
    const entry = s.ledger.entries.find((e) => e.id === 'FX001-KRW')!;
    s.ledger.entries = s.ledger.entries.filter((e) => e !== entry); delete s.ledger.postedIds[entry.id];
    expect(() => load(s)).toThrow('환전 분개 짝 또는 통화 간 이체가 다릅니다');
  });
  it('통화별 항등식과 임차료 누락·중복을 거절한다', () => {
    const original = runDays(createGame(config), config, c6day()).state;
    const s = structuredClone(original), entry = s.ledger.entries.find((e) => e.id.startsWith('RENT-'))!;
    s.ledger.entries.push(structuredClone(entry));
    expect(() => load(s)).toThrow('고정비 분개 중복 또는 누락');
    const missing = structuredClone(original); missing.ledger.entries = missing.ledger.entries.filter((e) => e.id !== entry.id); delete missing.ledger.postedIds[entry.id];
    expect(() => load(missing)).toThrow('고정비 분개 중복 또는 누락');
    const bad = structuredClone(original); bad.ledger.entries[0]!.lines[0]!.amount++;
    expect(() => load(bad)).toThrow('통화별 순자산 항등식이 다릅니다');
  });
  it('실패·정상 완료 표시가 마감 상태와 다르면 거절한다', () => {
    const s = runDays(createGame(config), config, config.campaignDays).state;
    s.operations!.failure = null;
    expect(() => load(s)).toThrow('캠페인 실패·완료 표시가 상태와 다릅니다');
    const freshState = fresh(); freshState.operations!.outcome = 'COMPLETED';
    expect(() => load(freshState)).toThrow('캠페인 실패·완료 표시가 상태와 다릅니다');
  });
  it('확장 두 건·잘못된 효력일·노선 계약 중복을 거절한다', () => {
    const original = planned(caseOf('P0-M2A5-10')).state;
    const two = structuredClone(original); two.operations!.expansions.push({ ...two.operations!.expansions[0]! });
    expect(() => load(two)).toThrow('창고 확장 횟수 또는 효력일 오류');
    original.operations!.expansions[0]!.effectiveDay--;
    expect(() => load(original)).toThrow('창고 확장 횟수 또는 효력일 오류');
    const s = planState(fresh(), config, caseOf('P0-M2A5-11').actions[1]!.commands).state;
    s.operations!.spaceContracts.push({ ...s.operations!.spaceContracts[0]! });
    expect(() => load(s)).toThrow('선복 계약은 노선당 한 건이어야 합니다');
  });
  it('규칙 1과 규칙 2의 operations 유무를 양방향으로 대조한다', () => {
    const cfg = loadScenario(SCENARIO_IDS[0]), s = fresh(cfg); s.operations = fresh().operations;
    expect(() => load(s, cfg)).toThrow('설정과 상태의 operations 유무가 다릅니다');
    const other = fresh(); other.operations = null;
    expect(() => load(other)).toThrow('설정과 상태의 operations 유무가 다릅니다');
  });
});
function c6day() { return caseOf('P0-M2A5-06').test_fixture.first_day as number; }

describe('M2a-5 규칙 1 불변', () => {
  it.each(SCENARIO_IDS)('%s의 결산 칸·지급 행·미지급 문장·새 명령 거절을 보존한다', (id) => {
    const cfg = loadScenario(id), s = fresh(cfg), before = structuredClone(s);
    const newCommands: EngineCommand[] = [caseOf('P0-M2A5-07').actions[0]!.commands[0]!, caseOf('P0-M2A5-10').actions[0]!.commands[0]!, caseOf('P0-M2A5-11').actions[1]!.commands[0]!];
    const p = planState(s, cfg, newCommands);
    expect(p.results).toEqual(newCommands.map((c) => ({ commandId: c.id, status: 'REJECTED', reasonKo: '이 시나리오에서는 할 수 없습니다(M2a-5 기능).' })));
    expect({ ...p.state, processedCommands: before.processedCommands }).toEqual(before);
    expect(Object.keys(campaignSummary(s, cfg))).toEqual(['ended', 'campaignDays', 'lastClosedDay', 'byCurrency', 'onTime', 'contracts', 'openInvoices', 'unpaidObligations']);
    expect(upcomingPayments(s, cfg, s.day)).toEqual([{ kind: 'WAGE', currency: cfg.payrollCurrency,
      amountMinor: cfg.employees.filter((e) => !cfg.recruitment?.candidateEmployeeIds.includes(e.id)).reduce((sum, e) => sum + e.salaryPerDayMinor, 0),
      day: s.day, trigger: 'AUTO', contractId: null, employeeIds: s.employees.filter((e) => e.employmentStatus === 'employed').map((e) => e.id), sourceId: 'WAGE-D001-KRW', labelKo: `${s.employees.filter((e) => e.employmentStatus === 'employed').length}명 급여` }]);
    const poor = { ...cfg, startingCash: { ...cfg.startingCash, KRW: 0 } };
    const end = runDays(createGame(poor), poor, s.day).state;
    expect(end.log.filter((l) => l.textKo.startsWith('지급 불가:')).map((l) => l.textKo)).toEqual(cfg.employees.filter((e) => !cfg.recruitment?.candidateEmployeeIds.includes(e.id))
      .map((e) => `지급 불가: ${e.nameKo} 1일 급여 ${e.salaryPerDayMinor.toLocaleString('ko-KR')}원 → 미지급 의무로 기록 (지급 불이행 유예기간은 아직 확정되지 않음)`));
    expect(end.log.map((l) => l.textKo).join('\n')).not.toContain('14일 안에');
    expect(() => checkInvariants(end, cfg)).not.toThrow();
  });
});
