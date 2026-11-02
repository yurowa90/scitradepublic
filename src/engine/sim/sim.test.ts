import { describe, expect, it } from 'vitest';
import { loadScenario, M2_SCENARIO_IDS, SCENARIO_IDS } from '../../content/scenario';
import { loadMapCities } from '../../content/map';
import { createGame, openDay } from '../engine';
import { summarize } from '../ledger';
import type { Currency } from '../money';
import { payrollRunwayDay } from '../previews';
import { createRng } from '../rng';
import type { ScenarioConfig } from '../types';
import { simMain, type SimIo } from './cli';
import { compareOutputs, formatCompare, runKey, summarizeOutput } from './compare';
import { createMetricsCollector, deliveryCounts } from './metrics';
import { policyById, SIM_POLICIES } from './policies';
import { runSuite, serializeSimOutput, simulate, SIM_SEEDS, type SimOutput } from './sim';
import simSource from './sim.ts?raw';
import policiesSource from './policies.ts?raw';
import metricsSource from './metrics.ts?raw';
import compareSource from './compare.ts?raw';
import cliSource from './cli.ts?raw';
import runSource from './run.mjs?raw';

const configs = SCENARIO_IDS.map(loadScenario);
const results = new Map<string, ReturnType<typeof simulate>>();
function cached(config: ScenarioConfig, policyId: string, seed = SIM_SEEDS[0]!) {
  const key = runKey({ scenarioId: config.id, policyId, seed });
  if (!results.has(key)) results.set(key, simulate(config, policyById(policyId)!, seed));
  return results.get(key)!;
}
let suite: SimOutput | undefined;
const twoSeedSuite = () => suite ??= runSuite({ seeds: SIM_SEEDS.slice(0, 2) });

function idsOf(config: ScenarioConfig): string[] {
  return [...new Set([
    ...config.cities.map((x) => x.id), ...config.goods.map((x) => x.id), ...config.routes.map((x) => x.id),
    ...config.offers.flatMap((x) => [x.id, x.counterpartyId]), ...config.employees.map((x) => x.id),
    ...config.portRestrictions.flatMap((x) => [x.eventInstanceId, x.templateId]),
    ...(config.recruitment?.scoutSites.map((x) => x.venueId) ?? []),
    ...(config.culture?.activities.flatMap((x) => [x.id, x.venueId, x.topic.id]) ?? []),
    ...(config.culture?.contacts.map((x) => x.id) ?? []),
  ])];
}
function renameIds(config: ScenarioConfig): ScenarioConfig {
  const ids = idsOf(config).sort();
  const replacements = new Map(ids.map((id, i) => [id, `Z${String(ids.length - i).padStart(3, '0')}`]));
  const renamed = JSON.parse(JSON.stringify(config), (_key, value: unknown) =>
    typeof value === 'string' ? replacements.get(value) ?? value : value) as ScenarioConfig;
  for (const id of ids) expect(JSON.stringify(renamed)).not.toContain(JSON.stringify(id));
  return renamed;
}
function checkShape(value: unknown): void {
  if (typeof value === 'number') expect(Number.isSafeInteger(value)).toBe(true);
  else if (value !== null && typeof value === 'object') for (const child of Object.values(value)) checkShape(child);
  else expect(value === null || typeof value === 'string').toBe(true);
}
const commandTypes = ['ACCEPT_FORWARDING', 'ACCEPT_TRADE', 'ASSIGN_TASK', 'BOOK_SAILING', 'CANCEL_CONTRACT', 'RESPOND_TO_DELAY'];

describe('화면 없는 비교 실행기', () => {
  it('1 결정성과 모양: 같은 입력의 바이트·실행 순서·정수', () => {
    const a = twoSeedSuite(), b = runSuite({ seeds: SIM_SEEDS.slice(0, 2) });
    expect(serializeSimOutput(a)).toBe(serializeSimOutput(b));
    expect(a.runs).toHaveLength(SCENARIO_IDS.length * SIM_POLICIES.length * 2);
    expect(a.runs.map(runKey)).toEqual(SCENARIO_IDS.flatMap((scenarioId) => SIM_POLICIES.flatMap((p) =>
      SIM_SEEDS.slice(0, 2).map((seed) => runKey({ scenarioId, policyId: p.id, seed })))));
    checkShape(a);
  }, 60_000);

  it('2 명령 결과: 거절·중복 없이 종류별 적용 수가 맞는다', () => {
    for (const run of twoSeedSuite().runs) {
      expect(run.commands.rejected, runKey(run)).toBe(0);
      expect(run.commands.duplicate, runKey(run)).toBe(0);
      expect(Object.keys(run.commands.appliedByType)).toEqual(commandTypes);
      expect(Object.values(run.commands.appliedByType).reduce((a, b) => a + b, 0)).toBe(run.commands.applied);
      if (run.policyId === 'IDLE') {
        expect(run.commands.applied).toBe(0);
        expect(run.metrics.contracts.total).toBe(0);
      }
    }
  }, 60_000);

  it('3 장부 항등식: 캠페인 종료·통화별 순자산·기여이익·직원 집계', () => {
    for (const config of configs) for (const policy of SIM_POLICIES) {
      const { state, run: { metrics: m } } = cached(config, policy.id);
      expect(state.phase).toBe('ENDED');
      expect(m.closedDays).toBe(config.campaignDays);
      for (const [currency, value] of Object.entries(m.currencies)) {
        const book = summarize(state.ledger, currency as Currency);
        for (const field of ['cash', 'accountsReceivable', 'accountsPayable', 'inventory', 'profit'] as const) expect(value[field]).toBe(book[field]);
        expect(value.netAssets).toBe(book.totalAssets - book.accountsPayable);
        expect(value.netAssets).toBe(book.openingEquity + book.profit);
        expect(value.contractContribution).toBe(value.contributionDirectTrade + value.contributionForwarding);
      }
      expect(m.contracts.total).toBe(m.contracts.directTrade + m.contracts.forwarding);
      expect(m.delivery.delivered).toBe(m.delivery.onTime + m.delivery.late);
      expect(m.staff.idleEmployeeDays).toBeLessThanOrEqual(m.staff.availableEmployeeDays);
    }
  }, 60_000);

  it('4 지급 가능일: 현금 부족은 마감 당일부터 센다', () => {
    for (const original of configs) for (const synthetic of [false, true]) {
      const config = synthetic ? { ...original, startingCash: { ...original.startingCash, [original.payrollCurrency]: 1 } } : original;
      const runway = payrollRunwayDay(openDay(createGame(config), config).state, config);
      const result = synthetic ? simulate(config, policyById('IDLE')!, SIM_SEEDS[0]!) : cached(config, 'IDLE');
      const m = result.run.metrics.currencies[config.payrollCurrency]!;
      expect(m.firstShortfallDay).toBe(runway === null ? null : runway + 1);
      expect(m.shortfallDays).toBe(runway === null ? 0 : config.campaignDays - runway);
      expect(m.shortfallBasisPoints).toBe(Math.floor(m.shortfallDays * 10000 / config.campaignDays));
      if (synthetic) { expect(runway).toBe(0); expect(m.firstShortfallDay).toBe(1); }
    }
  }, 60_000);

  it('5 정시 경계: 납기 당일·다음 날·미인도·취소·빈 분모', () => {
    const contract = configs.flatMap((c) => cached(c, 'MAX_CONTRIBUTION').state.contracts).find((c) => c.deliveredDay !== null)!;
    expect(contract).toBeDefined();
    const deadline = contract.deliveryDeadlineDay, day = deadline + 2;
    const contracts = [
      { ...contract, deliveredDay: deadline },
      { ...contract, deliveredDay: deadline + 1 },
      { ...contract, deliveredDay: null, status: 'IN_PROGRESS' as const },
      { ...contract, status: 'CANCELLED' as const },
      { ...contract, deliveredDay: null, status: 'IN_PROGRESS' as const, deliveryDeadlineDay: day },
    ];
    expect(deliveryCounts({ day, contracts })).toEqual({ delivered: 2, onTime: 1, late: 1, rateBasisPoints: 5000, pastDeadlineUndelivered: 1 });
    expect(deliveryCounts({ day, contracts: [] }).rateBasisPoints).toBeNull();
  }, 60_000);

  it('6 정책 난수 분리와 순수성: 엔진 난수 독립·탐색 다양성', () => {
    for (const config of configs) {
      const state = openDay(createGame(config), config).state;
      const stateBefore = JSON.stringify(state), configBefore = JSON.stringify(config);
      for (const policy of SIM_POLICIES) {
        const rng = createRng(SIM_SEEDS[0]!), rngBefore = JSON.stringify(rng);
        const first = policy.decide(state, config, rng);
        expect(policy.decide(state, config, rng)).toEqual(first);
        expect(JSON.stringify(state)).toBe(stateBefore);
        expect(JSON.stringify(config)).toBe(configBefore);
        expect(JSON.stringify(rng)).toBe(rngBefore);
        const altered = { ...state, rng: { seed: state.rng.seed + 1, cursors: { x: 3 } } };
        expect(policy.decide(altered, config, rng).commands).toEqual(first.commands);
        if (policy.id !== 'SEEDED_RANDOM') {
          expect(first.rng).toEqual(rng);
          expect(policy.decide(state, config, createRng(SIM_SEEDS[1]!)).commands).toEqual(first.commands);
        }
        expect(new Set(first.commands.map((c) => c.id)).size).toBe(first.commands.length);
        first.commands.forEach((c, i) => expect(c.id).toBe(`SIM-${policy.id}-D${String(state.day).padStart(3, '0')}-${String(i + 1).padStart(2, '0')}`));
        for (const command of first.commands) if (command.type === 'ACCEPT_TRADE' || command.type === 'ACCEPT_FORWARDING') {
          expect(command.plan?.employeeId).toBeDefined(); expect(command.plan?.sailingId).toBeDefined();
        }
      }
    }
    const config = configs.find((c) => c.id === M2_SCENARIO_IDS[0])!;
    const variants = new Set(SIM_SEEDS.map((seed) => JSON.stringify(cached(config, 'SEEDED_RANDOM', seed).run.metrics)));
    expect(variants.size).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('7 이름 바꾸기 불변: 역순 ID에서도 명령 집계·지표가 같다', () => {
    for (const config of configs) {
      const renamed = renameIds(config);
      for (const policy of SIM_POLICIES.filter((p) => p.id !== 'IDLE')) {
        for (const seed of SIM_SEEDS.slice(0, policy.id === 'SEEDED_RANDOM' ? 2 : 1)) {
          const before = cached(config, policy.id, seed).run;
          const after = simulate(renamed, policy, seed).run;
          expect(after.metrics, runKey(before)).toEqual(before.metrics);
          expect(after.commands, runKey(before)).toEqual(before.commands);
        }
      }
    }
  }, 60_000);

  it('8 소스 검사: 자료의 고유 ID·도시 이름·비결정적 호출·Node API 없음', () => {
    const forbidden = new Set<string>([...SCENARIO_IDS, ...configs.flatMap((c) => [...idsOf(c), ...c.cities.map((x) => x.nameKo)]),
      ...loadMapCities().flatMap((c) => [c.id, c.nameKo])]);
    const sources = { simSource, policiesSource, metricsSource, compareSource, cliSource, runSource };
    for (const [name, source] of Object.entries(sources)) {
      for (const value of forbidden) {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const pattern = /[가-힣]/.test(value) ? new RegExp(escaped) : new RegExp(`\\b${escaped}\\b`);
        expect(source, `${name}: ${value}`).not.toMatch(pattern);
      }
      expect(source).not.toMatch(/\b(CT|LOT|TASK|BK|SH)\d{3}\b|Math\.random|Date\.now|new Date/);
      if (name !== 'runSource') expect(source).not.toMatch(/process\.|from ['"]node:|require\(/);
    }
  });

  it('9 비교: 깊은 금액·경로 누락·실행 누락·메타·표시 한도', () => {
    const out = runSuite({ scenarioIds: [SCENARIO_IDS[0]], seeds: SIM_SEEDS.slice(0, 1) });
    const same = compareOutputs(out, structuredClone(out));
    expect(same.identical).toBe(true); expect(same.diffs).toEqual([]);
    expect(formatCompare(same)).toContain(`비교 결과: 같음 (실행 ${out.runs.length}회`);
    const altered = structuredClone(out), currency = Object.keys(altered.runs[0]!.metrics.currencies)[0]!;
    const value = altered.runs[0]!.metrics.currencies[currency]!;
    value.netAssets++;
    const changed = compareOutputs(out, altered);
    expect(changed.identical).toBe(false);
    expect(changed.diffs).toEqual([{ run: runKey(out.runs[0]!), path: `metrics.currencies.${currency}.netAssets`, before: value.netAssets - 1, after: value.netAssets }]);
    expect(formatCompare(changed)).toContain('비교 결과: 다름');
    expect(formatCompare(changed, 0)).toContain('… 외 1건');
    const missing = structuredClone(out), removed = missing.runs.pop()!;
    const subset = compareOutputs(out, missing);
    expect(subset.identical).toBe(false); expect(subset.onlyInBefore).toEqual([runKey(removed)]);
    expect(compareOutputs(missing, out).onlyInAfter).toEqual([runKey(removed)]);
    const meta = structuredClone(out); meta.meta.dataVersion += '-변경';
    const metaOnly = compareOutputs(out, meta);
    expect(metaOnly.identical).toBe(true); expect(metaOnly.metaDiffs).toHaveLength(1);
    expect(formatCompare(metaOnly)).toContain('메타 차이(판정에 넣지 않음)');
    const pathMissing = structuredClone(out);
    delete pathMissing.runs[0]!.commands.appliedByType[commandTypes[0]!];
    expect(compareOutputs(out, pathMissing).diffs).toEqual([{ run: runKey(out.runs[0]!),
      path: `commands.appliedByType.${commandTypes[0]}`, before: 0, after: null }]);
    const nullMissing = structuredClone(out);
    Reflect.deleteProperty(nullMissing.runs[0]!.metrics.delivery, 'rateBasisPoints');
    expect(compareOutputs(out, nullMissing).diffs).toHaveLength(1);
    expect(summarizeOutput(out)).toContain('| 시나리오 | 정책 |');
  }, 60_000);

  it('10 명령줄: 메모리 입출력·종료 코드·잘못된 입력', () => {
    const files = new Map<string, string>();
    let stdout = '', stderr = '', tick = 0;
    const io: SimIo = { readText: (path) => { if (!files.has(path)) throw new Error('파일 없음'); return files.get(path)!; },
      writeText: (path, text) => { files.set(path, text); }, out: (text) => { stdout += text; }, err: (text) => { stderr += text; }, now: () => tick++ * 1000 };
    const invoke = (...argv: string[]) => { stdout = ''; stderr = ''; return simMain(argv, io); };
    expect(invoke('run', '--scenarios', SCENARIO_IDS[0], '--policies', 'IDLE', '--seeds', '1', '--out', 'a.json')).toBe(0);
    const output = JSON.parse(files.get('a.json')!) as SimOutput;
    expect(output.runs).toHaveLength(1); expect(stderr).toContain('실행 1회'); expect(stdout).toBe('');
    expect(invoke('compare', 'a.json', 'a.json')).toBe(0);
    output.runs[0]!.metrics.closedDays++;
    files.set('b.json', serializeSimOutput(output));
    expect(invoke('compare', 'a.json', 'b.json', '--limit', '1')).toBe(1);
    expect(invoke('summary', 'a.json')).toBe(0); expect(stdout).toContain('|');
    for (const value of ['0', '21', '1.5', 'NaN']) expect(invoke('run', '--seeds', value)).toBe(2);
    expect(invoke('run', '--policies', '없는정책')).toBe(2);
    for (const policy of SIM_POLICIES) expect(stderr).toContain(policy.id);
    expect(invoke('run', '--scenarios', '없는시나리오')).toBe(2);
    for (const id of SCENARIO_IDS) expect(stderr).toContain(id);
    for (const bad of ['{}', 'null', '{', JSON.stringify({ meta: { tool: 'scitrade-sim', format: -1 }, runs: [] })]) {
      files.set('bad.json', bad); expect(invoke('compare', 'a.json', 'bad.json')).toBe(2);
    }
    expect(invoke('compare', 'a.json', '없음')).toBe(2);
    expect(invoke()).toBe(2); expect(stderr).toContain('사용법');
    expect(invoke('run', '--seeds')).toBe(2);
    expect(invoke('run', '--seeds', '1', '--seeds', '2')).toBe(2);
    expect(invoke('run', '--없는인수', '1')).toBe(2);
    expect(invoke('help')).toBe(0); expect(stdout).toContain('사용법');
    expect(invoke('--help')).toBe(0);
    expect(invoke('run', '--scenarios', SCENARIO_IDS[0], '--policies', 'IDLE', '--seeds', '1')).toBe(0);
    expect((JSON.parse(stdout) as SimOutput).runs).toHaveLength(1);
  }, 60_000);

  it('날짜 지표: 운송일수·대금일만 밀려도 지표가 달라진다(Claude 검수)', () => {
    const config = configs.find((c) => c.id === 'SCENARIO_M2_MULTI_TRADE')!;
    const policy = policyById('MAX_CONTRIBUTION')!, seed = SIM_SEEDS[0]!;
    const base = simulate(config, policy, seed).run.metrics;
    const transit = structuredClone(config);
    transit.routes = transit.routes.map((r) => ({ ...r, transitDays: r.transitDays + 1 }));
    const paid = structuredClone(config);
    paid.offers = paid.offers.map((o) => (o.paymentDueDay == null ? o : { ...o, paymentDueDay: o.paymentDueDay + 5 }));
    for (const shifted of [transit, paid]) expect(simulate(shifted, policy, seed).run.metrics).not.toEqual(base);
    // 운송일수 이동은 인도일 목록이, 대금일 이동은 현금 곡선이 잡는다(인도일은 그대로).
    expect(simulate(transit, policy, seed).run.metrics.timing.deliveredDays).not.toEqual(base.timing.deliveredDays);
    const paidMetrics = simulate(paid, policy, seed).run.metrics;
    expect(paidMetrics.timing.deliveredDays).toEqual(base.timing.deliveredDays);
    expect(paidMetrics.currencies[config.tradeCurrency]!.cashDaySum).not.toBe(base.currencies[config.tradeCurrency]!.cashDaySum);
    // 날짜 지표를 빼면 운송일수 +1은 구별되지 않는다. 그래서 날짜 지표가 필요하다.
    const strip = (m: typeof base) => ({ ...m, timing: null, currencies: Object.fromEntries(Object.entries(m.currencies).map(([k, v]) => [k, { ...v, cashDaySum: 0 }])) });
    expect(strip(simulate(transit, policy, seed).run.metrics)).toEqual(strip(base));
  }, 60_000);

  it('마감 지표: 당일 완료 업무·근무 시작일·대기 업무와 읽기 순수성', () => {
    const config = configs[0]!;
    const sample = cached(config, 'MAX_CONTRIBUTION').state;
    const state = structuredClone(sample), day = 3;
    const employee = state.employees.find((e) => e.employmentStatus === 'employed')!;
    const task = state.tasks[0]!;
    state.employees = [{ ...employee, availableFromDay: day }];
    state.tasks = [{ ...task, assignedEmployeeId: employee.id, startedDay: day, completedDay: day, status: 'DONE' },
      { ...task, assignedEmployeeId: null, startedDay: null, completedDay: null, status: 'QUEUED' }];
    state.obligations = [];
    const collector = createMetricsCollector(config), original = JSON.stringify(state);
    collector.observeClosedDay(state, config, day - 1);
    collector.observeClosedDay(state, config, day);
    collector.observeClosedDay(state, config, day + 1);
    const metrics = collector.finish(state, config);
    expect(metrics.staff).toEqual({ availableEmployeeDays: 2, idleEmployeeDays: 1, waitingTaskDays: 3 });
    expect(JSON.stringify(state)).toBe(original);
    expect(collector.finish(state, config)).toEqual(metrics);
    const empty = createMetricsCollector(config).finish(createGame(config), config);
    expect(empty.closedDays).toBe(0);
    expect(Object.keys(empty.currencies)).toEqual([...new Set([config.tradeCurrency, config.payrollCurrency])]);
    expect(empty.currencies[config.payrollCurrency]!.shortfallBasisPoints).toBe(0);
  }, 60_000);
});
