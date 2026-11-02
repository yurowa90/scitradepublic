import { describe, expect, it } from 'vitest';
import cases from '../../../tests/acceptance_cases.json';
import { ALL_SCENARIO_IDS, loadScenario, SCENARIO_IDS } from '../../content/scenario';
import { loadMapCities } from '../../content/map';
import { compareOutputs } from './compare';
import { listSailings, routeBetween } from '../catalog';
import { createGame, openDay, planState, commitDay } from '../engine';
import { summarize } from '../ledger';
import { createOperationsCollector } from './operations-metrics';
import { atDay, applied } from '../m2a5-testkit';
import { runDays } from '../testkit';
import { projectPrepCompletion } from '../operations';
import type { ScenarioConfig } from '../types';
import { d03Tables, mergeD03, predictJ6, runD03 } from './d03';
import { policyById } from './policies';
import { runSuite, serializeSimOutput, simulate } from './sim';
import { d03PolicyIds, parseVariant, withLateMode } from './variants';

const spec = cases.cases.find((c) => c.id === 'P0-M2A5-17')!;
const n = spec.expected_numeric as { idle_failure_day: number; zero: number; first_matching_seed: number; search_seeds: number[];
  recruit_lead_days: number; worker_seeds: number; cap30_bp: number; flat200_minor: number; j6_rows: { extraJobsPerWeek: number; usableAfter: number }[];
  j6_expected: { value: number; arrow: string }; j6_half_rows: { extraJobsPerWeek: number; usableAfter: number }[]; j6_half_expected: { value: number; arrow: string } };
const f = spec.test_fixture as { policies: string[]; small_policies: string[]; variant: string; parsed_variant: unknown; command_types: string[]; table_titles: string[]; daily_command_ranks: Record<string, number>; judgements: string[] };
const config = loadScenario(spec.scenario_id as (typeof ALL_SCENARIO_IDS)[number]);
const cache = new Map<string, ReturnType<typeof simulate>>();
function run(id: string, seed: number) { const k = `${id}/${seed}`; if (!cache.has(k)) cache.set(k, simulate(config, policyById(id)!, seed)); return cache.get(k)!; }
function first(id: string, predicate: (r: ReturnType<typeof simulate>) => boolean) {
  const seed = n.search_seeds.find((seed) => predicate(run(id, seed)));
  expect({ seed }, `${id}: 조건을 만족하는 시드가 없으면 수치 조정 없이 질문으로 보고`).toEqual({ seed: n.first_matching_seed });
  return run(id, seed!);
}

describe('P0-M2A5-17 비교 실행기', () => {
  it('기본 runSuite 시나리오·운영 지표 부재', () => {
    const out = runSuite({ seeds: [n.first_matching_seed], policyIds: [f.policies[0]!] });
    expect(out.meta.scenarioIds).toEqual([...SCENARIO_IDS]);
    expect(out.runs.map((r) => Object.hasOwn(r.metrics, 'operations'))).toEqual(SCENARIO_IDS.map(() => false));
  });
  it('첫 조건 충족 시드: 실패일·환전·완료·통화별 항등식·명령 키', () => {
    const idle = first(f.policies[0]!, (r) => r.run.metrics.operations!.failureDay === n.idle_failure_day);
    const noFx = first(f.policies[1]!, (r) => r.state.operations!.outcome === 'FAILED');
    const active = first(f.policies[2]!, (r) => r.state.operations!.outcome === 'COMPLETED');
    expect({ idle: idle.run.metrics.operations!.failureDay, noFx: noFx.state.operations!.outcome, active: active.state.operations!.outcome,
      unpaid: active.run.metrics.currencies.KRW!.accountsPayable, fx: active.state.operations!.exchanges.length > n.zero })
      .toEqual({ idle: n.idle_failure_day, noFx: 'FAILED', active: 'COMPLETED', unpaid: n.zero, fx: true });
    for (const { state, run } of [idle, noFx, active]) {
      expect(Object.keys(run.commands.appliedByType)).toEqual(f.command_types);
      for (const currency of [config.tradeCurrency, config.payrollCurrency]) {
        const b = summarize(state.ledger, currency);
        expect({ currency, net: run.metrics.currencies[currency]!.netAssets }).toEqual({ currency, net: b.openingEquity + b.profit + b.currencyTransferNet });
      }
    }
  }, 60_000);
  it('정시 거르기는 예약 명령과 수락 계획에서 확인한다', () => {
    const evaluate = (id: string, seed: number) => {
      const late: boolean[] = [];
      const result = simulate(config, policyById(id)!, seed, (state, commands) => {
        let planned = state;
        for (const cmd of commands) {
          planned = planState(planned, config, [cmd]).state;
          if (cmd.type === 'ACCEPT_TRADE' || cmd.type === 'ACCEPT_FORWARDING') {
            const missed = projectPrepCompletion(planned, config, { assignQueued: true }).filter((p) => {
              const b = planned.bookings.find((b) => b.contractId === p.contractId && b.status === 'BOOKED');
              return b && (p.readyDay === null || p.readyDay > b.departureDay);
            });
            expect(missed).toEqual([]);
          }
          const booking = cmd.type === 'BOOK_SAILING' ? planned.bookings.find((b) => b.contractId === cmd.contractId && b.sailingId === cmd.sailingId)
            : (cmd.type === 'ACCEPT_TRADE' || cmd.type === 'ACCEPT_FORWARDING') && cmd.plan?.sailingId ? planned.bookings.at(-1) : undefined;
          if (!booking) continue;
          const c = planned.contracts.find((c) => c.id === booking.contractId)!;
          const s = listSailings(config, booking.routeId).find((s) => s.id === booking.sailingId)!;
          late.push(s.scheduledArrivalDay + config.terms.customsDays > c.deliveryDeadlineDay);
        }
      });
      return { late, result };
    };
    const normal = evaluate(f.policies[2]!, n.first_matching_seed);
    expect({ bookings: normal.late.length > n.zero, allOnTime: normal.late.every((x) => !x) }).toEqual({ bookings: true, allOnTime: true });
    const seed = n.search_seeds.find((seed) => { const r = evaluate(f.policies[3]!, seed); return r.late.some(Boolean) && r.result.run.metrics.delivery.late > n.zero; });
    expect({ seed }).toEqual({ seed: n.first_matching_seed });
  }, 60_000);
  it('결정성과 작은 D03 주입 묶음의 표·판정', () => {
    const a = runD03({ seeds: [n.first_matching_seed], policyIds: f.small_policies });
    expect(runD03({ seeds: [n.first_matching_seed], policyIds: f.small_policies })).toEqual(a);
    expect(compareOutputs(a, a)).toEqual({ identical: true, onlyInBefore: [], onlyInAfter: [], diffs: [], metaDiffs: [], comparedRuns: a.runs.length });
    expect(mergeD03([{ ...a, runs: a.runs.slice(0, 1) }, { ...a, runs: a.runs.slice(1) }], 'base')).toEqual(a);
    const table = d03Tables(a);
    expect(f.table_titles.map((t) => table.includes(t))).toEqual(f.table_titles.map(() => true));
    expect(f.judgements.map((j) => table.includes(`| ${j} |`))).toEqual(f.judgements.map(() => true));
    expect(() => mergeD03([a, a], 'base')).toThrow('중복 실행 키');
  }, 60_000);
  it.each([
    [1059999, '실패', '10,600', '50.0%'],
    [1060000, '통과', '10,600', '50.0%'],
    [2077806, '통과', '20,778', '2.0%'],
    [2120000, '통과', '21,200', '0.0%'],
    [2141200, '실패', '21,412', '-1.0%'],
  ] as const)('J4 개연성 점검은 순자산 %i의 판정과 상한 여유를 표시한다', (net, result, dollars, margin) => {
    const baseline = structuredClone(run(f.policies[2]!, n.first_matching_seed).run);
    baseline.metrics.currencies.USD!.netAssets = net;
    baseline.metrics.currencies.KRW!.cash = 0;
    Object.assign(baseline.metrics.operations!, { maxBatchOffers: 10, forwardingPrepMin: 2, forwardingPrepMax: 12 });
    const noFx = structuredClone(baseline);
    noFx.policyId = f.policies[1]!; noFx.metrics.operations!.outcome = 'FAILED';
    const output = runD03({ seeds: [baseline.seed], policyIds: [] });
    output.runs = [baseline, noFx]; output.meta.policyIds = [baseline.policyId, noFx.policyId];
    const table = d03Tables(output);
    expect(table).toContain('J4는 개연성 점검이다');
    expect(table.split('\n').find((line) => line.startsWith('| J4 |'))).toEqual(
      `| J4 | ${result} | 기준 1시드, 최대 묶음 10견적, 준비 2~12pt; NO_FX 실패 1/1; USD 중앙 ${dollars}; 상한 21,200까지 여유 ${margin} |`);
  });
  it.each(['cap30', 'flat200'] as const)('감액 변형 %s의 J2는 화살표 수를 보존하고 진단(Q14)으로 표시한다', (mode) => {
    const template = run(f.policies[2]!, n.first_matching_seed).run;
    const output = runD03({ seeds: [template.seed], policyIds: [], late: mode });
    output.meta.seeds = Array.from({ length: 10 }, (_, i) => i + 1);
    output.meta.policyIds = d03PolicyIds(mode);
    output.runs = output.meta.policyIds.flatMap((policyId) => output.meta.seeds.map((seed) => {
      const r = structuredClone(template), hire = parseVariant(policyId)!.hires[0];
      r.policyId = policyId; r.seed = seed;
      r.metrics.operations!.unpaidAtEnd = [];
      r.metrics.operations!.actualHires = hire ? [{ pt: hire.pt, plannedDay: hire.day, actualDay: hire.day }] : [];
      if (hire) r.metrics.currencies.USD!.netAssets += hire.pt === 2 ? 40000 : -40000;
      return r;
    }));
    const evidence = 'MAX_CONTRIBUTION: 24칸 ↑12 ↓12; LATE_OK: 24칸 ↑12 ↓12';
    const rows = d03Tables(output).split('\n');
    expect(rows.find((line) => line.startsWith('| J2 |'))).toEqual(
      `| J2 | 진단(Q14) | 감액 변형은 비교용 규칙이라 판정하지 않음 — ${evidence} |`);
    for (const id of ['J2b', 'J3', 'J5']) expect(rows.find((line) => line.startsWith(`| ${id} |`))).toContain('| 해당 없음 |');
    output.meta.lateMode = 'base';
    expect(d03Tables(output).split('\n').find((line) => line.startsWith('| J2 |'))).toEqual(`| J2 | 통과 | ${evidence} |`);
    for (const r of output.runs) if (parseVariant(r.policyId)!.hires.length) r.metrics.currencies.USD!.netAssets = template.metrics.currencies.USD!.netAssets - 40000;
    expect(d03Tables(output).split('\n').find((line) => line.startsWith('| J2 |'))).toEqual(
      '| J2 | 실패 | MAX_CONTRIBUTION: 24칸 ↑0 ↓24; LATE_OK: 24칸 ↑0 ↓24 |');
  });
});

function dataIds(c: ScenarioConfig): string[] {
  const ids = new Set<string>([c.id]);
  function visit(value: unknown, key = '') {
    if (typeof value === 'string' && (/id$/i.test(key) || /ids$/i.test(key))) ids.add(value);
    else if (Array.isArray(value)) value.forEach((v) => visit(v, key));
    else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) visit(v, k);
  }
  visit(c); return [...ids];
}

describe('M2a-5 실행기 성질', () => {
  it('handlingJobs는 취소를 빼고 납기 지난 미인도 작업 포함 주선도 센다', () => {
    const opened = atDay(8, config);
    const offers = opened.operations!.offers.filter((o) => o.serviceClass === 'HANDLING' && o.publishDay === opened.day);
    const trade = config.offers.find((o) => o.kind === 'supplier')!;
    const buy = opened.operations!.offers.find((o) => o.kind === 'supplier' && o.goodId === trade.goodId)!;
    const sell = opened.operations!.offers.find((o) => o.kind === 'customer' && o.goodId === buy.goodId)!;
    const standard = opened.operations!.offers.find((o) => o.serviceClass === 'STANDARD')!;
    const commands = [
      ...offers.slice(0, 2).map((o, i) => ({ id: `COUNT-H-${i}`, type: 'ACCEPT_FORWARDING' as const, offerId: o.id })),
      { id: 'COUNT-TRADE', type: 'ACCEPT_TRADE' as const, buyOfferId: buy.id, sellOfferId: sell.id },
      { id: 'COUNT-STANDARD', type: 'ACCEPT_FORWARDING' as const, offerId: standard.id },
    ];
    const accepted = planState(opened, config, commands);
    expect(accepted.results).toEqual(applied(commands));
    const cancel = { id: 'COUNT-CANCEL', type: 'CANCEL_CONTRACT' as const, contractId: accepted.state.contracts[1]!.id };
    const cancelled = planState(accepted.state, config, [cancel]);
    expect(cancelled.results).toEqual(applied([cancel]));
    const state = runDays(cancelled.state, config, 30).state;
    expect({ handlingJobs: createOperationsCollector(config, 'MAX_CONTRIBUTION').finish(state).handlingJobs,
      missed: state.contracts[0]!.deliveryDeadlineDay < state.day && state.contracts[0]!.deliveredDay === null,
      cancelled: state.contracts[1]!.cancelledDay }).toEqual({ handlingJobs: 1, missed: true, cancelled: 8 });
  });
  it('규칙 1 새 정책은 기존 최대 기여이익과 같은 지표', () => {
    for (const scenario of SCENARIO_IDS) {
      const cfg = loadScenario(scenario), normal = simulate(cfg, policyById(f.policies[2]!)!, n.first_matching_seed).run;
      for (const id of [f.policies[1]!, f.policies[3]!]) expect(simulate(cfg, policyById(id)!, n.first_matching_seed).run.metrics).toEqual(normal.metrics);
    }
  }, 60_000);
  it('변형 이름·영입 실제 날짜·이름 바꾸기 설정 불변', () => {
    expect(parseVariant(f.variant)).toEqual(f.parsed_variant);
    const ids = dataIds(config).sort(), replacements = new Map(ids.map((id, i) => [id, `RENAME-${ids.length - i}`]));
    const renamed = JSON.parse(JSON.stringify(config), (_key, value: unknown) => typeof value === 'string' ? replacements.get(value) ?? value : value) as ScenarioConfig;
    const a = run(f.variant, n.first_matching_seed).run;
    const b = simulate(renamed, policyById(f.variant)!, n.first_matching_seed).run;
    expect(b.metrics).toEqual(a.metrics); expect(b.commands).toEqual(a.commands);
    expect(a.metrics.operations!.actualHires).toEqual(parseVariant(f.variant)!.hires.map((h) => ({ pt: h.pt, plannedDay: h.day, actualDay: h.day })));
  }, 60_000);
  it('영입 차단은 실제 고용 당일까지이고 하루 명령 순서가 고정된다', () => {
    const recruiter = config.employees.filter((e) => !config.recruitment!.candidateEmployeeIds.includes(e.id)).at(-1)!;
    const h = parseVariant(f.variant)!.hires[0]!;
    const assignments: number[] = [];
    const result = simulate(config, policyById(f.variant)!, n.first_matching_seed, (state, commands) => {
      const ranks = commands.map((c) => f.daily_command_ranks[c.type]!);
      expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
      if (commands.some((c) => c.type === 'ASSIGN_TASK' && c.employeeId === recruiter.id
        || (c.type === 'ACCEPT_TRADE' || c.type === 'ACCEPT_FORWARDING') && c.plan?.employeeId === recruiter.id)) assignments.push(state.day);
    });
    const hired = result.run.metrics.operations!.actualHires[0]!.actualDay!;
    expect(assignments.filter((day) => day >= h.day - n.recruit_lead_days && day <= hired)).toEqual([]);
  }, 60_000);
  it('감액 변형은 설정 사본만 바꾼다', () => {
    const before = structuredClone(config), cap = withLateMode(config, 'cap30'), flat = withLateMode(config, 'flat200');
    expect(config).toEqual(before);
    expect(cap).toEqual({ ...before, terms: { ...before.terms, lateDeliveryCapBasisPoints: n.cap30_bp } });
    expect(flat).toEqual({ ...before, terms: { ...before.terms, lateDeliveryBasis: 'FLAT_ONCE', lateDeliveryPriceReductionMinor: n.flat200_minor, lateDeliveryCapBasisPoints: null } });
  });
  it('J6 진단 열은 시드별 처리 차이·실제 고용일·미고용 제외·예측 0을 구분한다', () => {
    const baseline = run(f.policies[2]!, n.first_matching_seed).run;
    const hireId = `${f.policies[2]}~hire:2pt@30`;
    const runs = Array.from({ length: 10 }, (_, i) => {
      const b = structuredClone(baseline), r = structuredClone(baseline);
      b.seed = i + 1; r.seed = i + 1; r.policyId = hireId;
      b.metrics.operations!.handlingJobs = 10;
      r.metrics.operations!.handlingJobs = 11 + i;
      r.metrics.currencies.USD!.netAssets += 40000;
      r.metrics.operations!.utilization = []; r.metrics.operations!.warehouseWaitingTaskDays = 0;
      r.metrics.operations!.actualHires = [{ pt: 2, plannedDay: 30, actualDay: i < 8 ? 21 : null }];
      b.metrics.operations!.bottlenecks.forEach((x) => x.extraJobsPerWeek = 2);
      return [b, r];
    }).flat();
    const output = runD03({ seeds: [n.first_matching_seed], policyIds: [] });
    output.runs = runs; output.meta.seeds = Array.from({ length: 10 }, (_, i) => i + 1);
    output.meta.policyIds = [baseline.policyId, hireId];
    const row = () => d03Tables(output).split('\n').find((line) => line.startsWith(`| ${hireId} |`) && line.includes('미고용 제외'));
    expect(row()).toEqual(`| ${hireId} | 2 | ↑ | ↑ | 일치 | 10 | 5.5 | 0.225 (미고용 제외 2) | — | — |`);
    runs.forEach((r) => r.metrics.operations!.bottlenecks.forEach((x) => x.extraJobsPerWeek = 0));
    expect(row()).toEqual(`| ${hireId} | 0 | ↓ | ↑ | 불일치 | 10 | 5.5 | — (미고용 제외 2) | 0 | 0 |`);
  });
  it('J6 계산 단위: 추가 업무량과 짝수 중앙값', () => {
    expect(predictJ6(n.j6_rows)).toEqual(n.j6_expected);
    expect(predictJ6(n.j6_half_rows)).toEqual(n.j6_half_expected);
  });
  it('전체 sim 소스의 자료 ID·도시·시각·비결정 호출 금지', () => {
    const configs = ALL_SCENARIO_IDS.map(loadScenario), forbidden = new Set([...configs.flatMap((c) => [...dataIds(c), ...c.cities.map((x) => x.nameKo)]), ...loadMapCities().flatMap((c) => [c.id, c.nameKo])]);
    const sources = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    for (const [file, source] of Object.entries(sources).filter(([f]) => !f.endsWith('.test.ts'))) {
      for (const word of forbidden) {
        const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        expect(source, `${file}: ${word}`).not.toMatch(/[가-힣]/.test(word) ? new RegExp(escaped) : new RegExp(`\\b${escaped}\\b`));
      }
      expect(source).not.toMatch(/\b(CT|LOT|TASK|BK|SH)\d{3}\b|Math\.random|Date\.now|new Date|\bconfig\.id\s*===/);
      expect(source).not.toMatch(/process\.|from ['"]node:|require\(/);
    }
  });
  it('워커 1·2 출력 바이트 동일 (작은 주입 묶음)', async () => {
    // 저장소는 Node 타입 패키지를 쓰지 않는다. 기존 Vite 설정처럼 경계 API만 선언한다.
    const { execFile } = await import('node:child_process' as string) as { execFile: (file: string, args: string[], options: object, callback: (error: Error | null) => void) => void };
    const { mkdtempSync, readFileSync, rmSync } = await import('node:fs' as string) as {
      mkdtempSync: (prefix: string) => string; readFileSync: (path: string, encoding: string) => string; rmSync: (path: string, options: object) => void };
    const { tmpdir } = await import('node:os' as string) as { tmpdir: () => string };
    const { join } = await import('node:path' as string) as { join: (...paths: string[]) => string };
    const dir = mkdtempSync(join(tmpdir(), 'd03-workers-'));
    try {
      const files = [join(dir, 'one.json'), join(dir, 'two.json')];
      for (const [i, path] of files.entries()) await new Promise<void>((resolve, reject) => execFile('node', ['src/engine/sim/run.mjs', 'd03', '--seeds', String(n.worker_seeds), '--policies', f.small_policies.join(','), '--workers', String(i + 1), '--out', path], { maxBuffer: 4 * 1024 * 1024 }, (error) => error ? reject(error) : resolve()));
      expect(readFileSync(files[1]!, 'utf8')).toEqual(readFileSync(files[0]!, 'utf8'));
      const a = JSON.parse(readFileSync(files[0]!, 'utf8'));
      expect(serializeSimOutput(a)).toEqual(readFileSync(files[0]!, 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 60_000);
});


describe('M2a-5 차단 예측 실행 대조', () => {
  it('재현 변형·시드의 예측 불일치와 미인도가 0이고 실제 배정도 차단 경계를 지킨다', () => {
    const recruiter = config.employees.filter((e) => !config.recruitment!.candidateEmployeeIds.includes(e.id)).at(-1)!;
    const violations: { day: number; remaining: number }[] = [];
    const result = simulate(config, policyById('MAX_CONTRIBUTION~inv:SE~hire:2pt@30')!, 1001, (state, commands) => {
      let planned = state;
      for (const cmd of commands) {
        const before = planned; planned = planState(planned, config, [cmd]).state;
        const task = cmd.type === 'ASSIGN_TASK' ? before.tasks.find((t) => t.id === cmd.taskId)
          : cmd.type === 'ACCEPT_TRADE' || cmd.type === 'ACCEPT_FORWARDING' ? planned.tasks.at(-1) : undefined;
        const employee = cmd.type === 'ASSIGN_TASK' ? cmd.employeeId
          : cmd.type === 'ACCEPT_TRADE' || cmd.type === 'ACCEPT_FORWARDING' ? cmd.plan?.employeeId : undefined;
        if (task && employee === recruiter.id && state.day <= 30) {
          const remaining = task.requiredWorkUnits - task.progressWorkUnits;
          if (state.day >= 27 || Math.ceil(remaining / recruiter.workUnitsPerDay) > 27 - state.day) violations.push({ day: state.day, remaining });
        }
      }
    });
    expect({ misses: result.run.metrics.operations!.projectionMisses, undelivered: result.run.metrics.delivery.pastDeadlineUndelivered, violations })
      .toEqual({ misses: 0, undelivered: 0, violations: [] });
  }, 60_000);
  it('정시 예측 예약을 실제로 배정하지 않아 출항을 놓치면 계약을 한 번 센다', () => {
    const policy = 'MAX_CONTRIBUTION', collector = createOperationsCollector(config, policy);
    let s = openDay(createGame(config), config).state;
    const offer = config.offers.find((o) => o.kind === 'forwarding')!;
    const route = routeBetween(config, offer.cityId, offer.destinationCityId!)!;
    const sailing = listSailings(config, route.id, s.day + 1)[0]!;
    const planned = planState(s, config, [{ id: 'MISSED-ACCEPT', type: 'ACCEPT_FORWARDING', offerId: offer.id, plan: { sailingId: sailing.id } }]);
    expect(planned.results.map((r) => r.status)).toEqual(['APPLIED']); s = planned.state;
    const b = s.bookings.at(-1)!, p = projectPrepCompletion(s, config, { assignQueued: true })[0]!;
    expect(p.readyDay !== null && p.readyDay <= b.departureDay).toEqual(true);
    const promised = { bookingId: b.id, contractId: b.contractId, readyDay: p.readyDay!, departureDay: b.departureDay };
    while (s.day <= b.departureDay) {
      s = openDay(s, config).state; collector.observeOpened(s);
      const day = s.day; s = commitDay(s, config, []).state;
      collector.observeClosed(s, day, {}, day === 1 ? [promised, promised] : []);
    }
    expect({ projectionMisses: collector.finish(s).projectionMisses, status: s.bookings.at(-1)!.status })
      .toEqual({ projectionMisses: 1, status: 'CANCELLED' });
  });
});
