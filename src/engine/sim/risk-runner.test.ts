import { describe, expect, it } from 'vitest';
import { EXPERIMENT_SCENARIO_IDS, loadScenario, OPERATIONS_SCENARIO_IDS, SCENARIO_IDS, riskProfiles } from '../../content/scenario';
import { commitDay, createGame, openDay, planState } from '../engine';
import { generateBatch, offerDef } from '../market';
import { dailyKrwDue, usdLotKrw } from '../operations';
import { preview, contractRiskReport } from '../reports';
import { quotePreview } from '../readers';
import { fundsPosition } from '../reservations';
import { claimFor, collectionPlan, krwToUsdMinor, withRiskLevel } from '../risk';
import { createRng } from '../rng';
import { ENGINE_VERSION, type EngineCommand, type GameState, type ScenarioConfig } from '../types';
import { d03Options, simMain, type SimIo } from './cli';
import { cell, d03Tables, mergeD03, requestedRisk, runD03, workerOptions } from './d03';
import { createMetricsCollector } from './metrics';
import { createOperationsCollector } from './operations-metrics';
import { decideOperations, decisionContribution, directTradeCandidates, FOCUS_GOOD_ID, marginBufferAccepts } from './operations-policy';
import { policyById, SIM_POLICIES } from './policies';
import { riskMetrics, type RiskContract, type RiskLevel, type RiskMeta } from './risk-metrics';
import { compareRisk, comparisonValue, diagnostics, diversity, isSingleGoodVariant, judgmentKind, L3_THRESHOLDS,
  lossBandPasses, lossStats, marginComparison, newJ7, oldJ7Passes, RISK_JUDGMENT_KINDS, riskCompareTables, riskTables } from './risk-tables';
import { serializeSimOutput, simulate, runSuite, SIM_FORMAT, type SimOutput, type SimRun } from './sim';
import { d03PolicyIds, parseVariant } from './variants';

function riskSeeds(from: number, count: number): number[] {
  if (from < 2001) throw new Error('시험 시드는 2001 이상이어야 합니다.');
  return Array.from({ length: count }, (_, i) => from + i);
}
const cfg = (level: RiskLevel, seed: number, scenario: string = OPERATIONS_SCENARIO_IDS[0]) =>
  ({ ...withRiskLevel(loadScenario(scenario as Parameters<typeof loadScenario>[0]), level, riskProfiles()[0]!), seed });
const meta = (level: RiskLevel): RiskMeta => ({ level, profileId: riskProfiles()[0]!.id, tuningRound: 0, marketRulesSha256: 'a'.repeat(64) });
const cache = new Map<string, ReturnType<typeof simulate>>();
function simulation(level: RiskLevel, policyId: string, seed: number, scenario: string = OPERATIONS_SCENARIO_IDS[0]) {
  const key = `${level}/${policyId}/${seed}/${scenario}`;
  if (!cache.has(key)) cache.set(key, simulate(cfg(level, seed, scenario), policyById(policyId)!, seed, undefined, level));
  return cache.get(key)!;
}
function contract(realized: number, patch: Partial<RiskContract> = {}): RiskContract {
  return { contractId: '계약', sellOfferId: '판매', goodId: FOCUS_GOOD_ID, kind: 'DIRECT_TRADE', status: 'COMPLETED', class: '완료', onTime: true,
    realized, openFixedRateKrw: realized, evaluationDay: 80,
    components: { schedule: 0, fx: 0, tariff: 0, surcharge: 0, late: 0, claim: 0, cancel: 0, collection: 0, open_valuation: 0, residual: 0 }, ...patch };
}
function fixture(level: RiskLevel, policies = ['MAX_CONTRIBUTION', 'NO_FX', 'LATE_OK', 'MARGIN_BUFFER', 'FOCUS'], count = 20,
  scenarios: readonly string[] = OPERATIONS_SCENARIO_IDS): SimOutput {
  const seeds = riskSeeds(2001, count), config = loadScenario(OPERATIONS_SCENARIO_IDS[0]), state = createGame({ ...config, seed: seeds[0]! });
  // 모은 숫자를 손으로 설정한다. simulate/runD03는 호출하지 않는다.
  const metrics = createMetricsCollector(config).finish(state, config);
  const operations = createOperationsCollector(config, 'MAX_CONTRIBUTION').finish(state);
  Object.assign(operations, { maxBatchOffers: 10, forwardingPrepMin: 2, forwardingPrepMax: 12, outcome: 'COMPLETED' });
  metrics.currencies.USD!.netAssets = 1500000;
  const runs = scenarios.flatMap((scenarioId) => policies.flatMap((policyId) => seeds.map((seed): SimRun => ({ scenarioId, policyId, seed,
    commands: { applied: 0, rejected: 0, duplicate: 0, appliedByType: {} }, metrics: { ...structuredClone(metrics),
      operations: { ...structuredClone(operations), staffUtilizationBasisPoints: 0 },
      risk: { analysisValueMinor: 1600000, contracts: [contract(1)], directAccepted: 1, referenceRateBounds: false } } }))));
  return { meta: { tool: 'scitrade-sim', format: SIM_FORMAT, engineVersion: ENGINE_VERSION, dataVersion: config.dataVersion,
    scenarioIds: [...scenarios], policyIds: policies, seeds, lateMode: 'base', risk: meta(level) }, runs };
}
const baseRuns = (o: SimOutput) => o.runs.filter((r) => r.policyId === 'MAX_CONTRIBUTION');
const row = (text: string, id: string) => text.split('\n').find((line) => line.startsWith(`| ${id} |`))!;
const setLosses = (r: SimRun, loss: number, total: number) => { r.metrics.risk!.contracts = Array.from({ length: total }, (_, i) => contract(i < loss ? -1 : 1)); r.metrics.risk!.directAccepted = total; };

// Node 파일 접근은 시험에서만 동적으로 연다. 실행기 TS에는 파일 경계가 없다.
async function nodeIo() {
  const fs = await import('node:fs' as string) as { readFileSync(path: string | URL, encoding: string): string; readdirSync(path: string): string[];
    mkdtempSync(path: string): string; rmSync(path: string, opts: object): void };
  const cp = await import('node:child_process' as string) as { execFile(file: string, args: string[], opts: object, cb: (error: Error | null, stdout: string, stderr: string) => void): void };
  return { fs, exec: (args: string[]) => new Promise<string>((resolve, reject) => cp.execFile('node', ['src/engine/sim/run.mjs', ...args],
    { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(stderr || error.message)) : resolve(stdout))) };
}

describe('위험 판정 경계와 입력', () => {
  it('시험 시드 보호와 실행 키 고정, EXPAND 별칭', async () => {
    expect(() => riskSeeds(2000, 1)).toThrow();
    const crypto = await import('node:crypto' as string) as { createHash(name: string): { update(value: string): { digest(encoding: string): string } } };
    expect(crypto.createHash('sha256').update(JSON.stringify(d03PolicyIds('base'))).digest('hex'))
      .toBe('7a5aeac78372d053b5ef045616908a550a456f270545a30b2e47bbe2cb49c754');
    expect(d03PolicyIds('base')).toHaveLength(117);
    for (const id of ['MARGIN_BUFFER', 'FOCUS', 'EXPAND']) { expect(d03PolicyIds('base')).not.toContain(id); expect(SIM_POLICIES.map((p) => p.id)).not.toContain(id); }
    expect(policyById('EXPAND')).toBeUndefined();
    expect(parseVariant('FOCUS')).toBeDefined(); expect(parseVariant('MARGIN_BUFFER')).toBeDefined();
  });
  it('L1 경계와 손실 비율·민감도·상호 배타 분류', () => {
    expect(lossBandPasses(1, 20)).toBe(true); expect(lossBandPasses(5, 20)).toBe(true);
    expect(lossBandPasses(1, 21)).toBe(false); expect(lossBandPasses(6, 23)).toBe(false); expect(lossBandPasses(0, 0)).toBe(false);
    const o = fixture('R3', ['MAX_CONTRIBUTION'], 2), rs = baseRuns(o);
    rs[0]!.metrics.risk!.contracts = [contract(-2, { class: '열린', status: 'IN_PROGRESS', openFixedRateKrw: 1 }), contract(1), contract(-1, { class: '취소', status: 'CANCELLED' })];
    rs[1]!.metrics.risk!.contracts = [contract(2)];
    const stats = lossStats(rs);
    expect(stats).toMatchObject({ loss: 2, total: 4, sensitivityLoss: 1, median: 1 / 3, q1: 0, q3: 2 / 3 });
    expect(stats.classes.map((x) => [x.loss, x.total])).toEqual([[1, 1], [0, 2], [1, 1]]);
  });
  it('J7 새 정의는 분수 중앙과 분모 제외, 짝수 평균 경계를 지킨다', () => {
    const rs = baseRuns(fixture('R3', ['MAX_CONTRIBUTION'], 12));
    const put = (r: SimRun, a: number, b: number) => { r.metrics.risk!.contracts = [contract(a), contract(b - a, { kind: 'FORWARDING' })]; };
    rs.forEach((r, i) => put(r, i < 6 ? 1 : 4, 10));
    expect(newJ7(rs)).toMatchObject({ pass: true, percent: 25, excluded: 0 });
    rs.forEach((r, i) => put(r, i < 6 ? 1 : 3, 10));
    expect(newJ7(rs).pass).toBe(false);
    rs.forEach((r) => put(r, 1, 4)); expect(newJ7(rs).pass).toBe(true);
    put(rs[0]!, 1, 0); put(rs[1]!, 1, -1); expect(newJ7(rs)).toMatchObject({ n: 10, excluded: 2, pass: true });
    put(rs[2]!, 0, 0); expect(newJ7(rs)).toMatchObject({ n: 9, pass: null });
    expect(riskTables({ ...fixture('R3', ['MAX_CONTRIBUTION'], 12), runs: rs })).toContain('분모 ≤ 0 제외 3');
    expect(newJ7(rs.slice(3))).toMatchObject({ percent: 25, pass: null });
    rs.forEach((r,i)=>{const b=r.metrics.operations!.currencies.USD!.business;b.directTrade=i<6?1:4;b.handlingForwarding=10-b.directTrade;b.standardForwarding=0;});
    expect(oldJ7Passes(rs)).toBe(true);rs[0]!.metrics.operations!.currencies.USD!.business.directTrade=0;
    // 중앙에 닿는 두 값이 모두 내려가면 25% 아래다.
    rs.forEach((r)=>{r.metrics.operations!.currencies.USD!.business.directTrade=1;r.metrics.operations!.currencies.USD!.business.handlingForwarding=4;});
    expect(oldJ7Passes(rs)).toBe(false);
  });
  it('L0는 기준 회사만 판정하고 LATE_OK는 기록한다', () => {
    const o = fixture('R0'); o.runs.filter((r) => r.policyId === 'LATE_OK').forEach((r) => setLosses(r, 1, 1));
    expect(row(riskTables(o), 'L0')).toContain('통과'); expect(row(riskTables(o), 'L0')).toContain('LATE_OK 손실 20');
    setLosses(baseRuns(o)[0]!, 1, 1); expect(row(riskTables(o), 'L0')).toContain('실패');
  });
  it('J7 새 정의와 옛 정의는 홀수 11개의 가운데 비율 하나를 쓴다', () => {
    const rs = baseRuns(fixture('R3', ['MAX_CONTRIBUTION'], 11));
    const put = (r: SimRun, a: number, b: number) => {
      r.metrics.risk!.contracts = [contract(a), contract(b - a, { kind: 'FORWARDING' })];
      Object.assign(r.metrics.operations!.currencies.USD!.business,
        { directTrade: a, handlingForwarding: b - a, standardForwarding: 0 });
    };
    rs.forEach((r, i) => put(r, i < 5 ? 1 : 9, 10));
    put(rs[5]!, 1, 4);
    expect(newJ7(rs)).toMatchObject({ n: 11, pass: true, percent: 25 });
    expect(oldJ7Passes(rs)).toBe(true);
    put(rs[5]!, 24, 100);
    expect(newJ7(rs)).toMatchObject({ n: 11, pass: false, percent: 24 });
    expect(oldJ7Passes(rs)).toBe(false);
  });
  it('L3 문턱을 이항 분포로 재계산하고 대상 0·동점·건수 경계를 확인한다', () => {
    const choose = (n: number, k: number) => { let c = 1; for (let i = 1; i <= k; i++) c = c * (n - i + 1) / i; return c; };
    for (let m = 10; m <= 20; m++) {
      const threshold = Array.from({ length: m + 1 }, (_, k) => k).find((k) => Array.from({ length: m - k + 1 }, (_, j) => choose(m, k + j)).reduce((a, b) => a + b, 0) / 2 ** m <= 0.05);
      expect(L3_THRESHOLDS[m]).toBe(threshold);
    }
    const o = fixture('R3'), a = baseRuns(o), b = o.runs.filter((r) => r.policyId === 'MARGIN_BUFFER');
    a.forEach((r) => setLosses(r, 4, 4)); b.forEach((r) => setLosses(r, 3, 4));
    expect(marginComparison(a, b)).toMatchObject({ reduction: true, sign: true, volume: true, pass: true });
    setLosses(b[0]!, 0, 0); setLosses(b[1]!, 4, 4); expect(marginComparison(a, b).m).toBe(18);
    for (let i = 2; i < 11; i++) setLosses(b[i]!, 4, 4); expect(marginComparison(a, b)).toMatchObject({ m: 9, pass: null });
    a.forEach((r) => setLosses(r, 1, 3)); b.forEach((r, i) => setLosses(r, 0, i < 10 ? 2 : 1));
    expect(marginComparison(a, b)).toMatchObject({ volume: true, pass: true });
    setLosses(b[0]!, 0, 1); expect(marginComparison(a, b).volume).toBe(false);
    setLosses(b[0]!, 0, 2); setLosses(a[0]!, 1, 4); expect(marginComparison(a, b).volume).toBe(false);
    for (const [m, threshold] of [[20, 15], [13, 10]] as const) {
      for (const wins of [threshold, threshold - 1]) {
        const base = a.slice(0, m), margin = b.slice(0, m);
        base.forEach((r) => setLosses(r, 1, 2));
        margin.forEach((r, i) => setLosses(r, i < wins ? 0 : 2, 2));
        expect(marginComparison(base, margin)).toMatchObject({ m, wins, sign: wins === threshold });
      }
    }
  });
  it('D는 같은 변형·시드 짝만 비교하고 단일 품목이면 모든 층에서 해당 없음이다', () => {
    for (const level of ['R0', 'R1', 'R2', 'R3'] as const) for (const scenario of [...OPERATIONS_SCENARIO_IDS, ...EXPERIMENT_SCENARIO_IDS]) {
      const o = fixture(level, ['MAX_CONTRIBUTION', 'FOCUS'], 20, [scenario]);
      const a = baseRuns(o), b = o.runs.filter((r) => r.policyId === 'FOCUS');
      expect(diversity(a, b, comparisonValue(level))).toMatchObject({ focusWins: 0, expandWins: 0, pass: false });
      b.forEach((r, i) => { r.metrics.currencies.USD!.netAssets += i < 3 ? 1 : -1; r.metrics.risk!.analysisValueMinor! += i < 3 ? 1 : -1; });
      o.runs.reverse();
      expect(diversity(a, b, comparisonValue(level))).toMatchObject({ focusWins: 3, expandWins: 17, pass: true });
      const single = isSingleGoodVariant(loadScenario(scenario));
      expect(row(riskTables(o), 'D')).toContain(single ? '해당 없음' : ['R1', 'R2'].includes(level) ? '진단' : '통과');
    }
    const multi = fixture('R0', ['MAX_CONTRIBUTION', 'FOCUS'], 20, [OPERATIONS_SCENARIO_IDS[0], EXPERIMENT_SCENARIO_IDS[1]]);
    const a = multi.runs.filter((r) => r.scenarioId === OPERATIONS_SCENARIO_IDS[0]);
    const c = multi.runs.filter((r) => r.scenarioId === EXPERIMENT_SCENARIO_IDS[1]);
    a.filter((r) => r.policyId === 'FOCUS').forEach((r, i) => { r.metrics.currencies.USD!.netAssets += i < 3 ? 1 : -1; });
    // (다)는 두 정책이 동점이다. 섞으면 (가)의 FOCUS 3승이 3/40으로 희석된다.
    c.forEach((r) => { r.metrics.currencies.USD!.netAssets *= 2; });
    const value = comparisonValue('R0'), focus = multi.runs.filter((r) => r.policyId === 'FOCUS').reverse();
    expect(diversity(baseRuns({ ...multi, runs: a }), focus, value)).toMatchObject({ pairs: 20, expandWins: 17, focusWins: 3, pass: true });
    expect(diversity(baseRuns(multi), focus, value)).toMatchObject({ pairs: 40, pass: false });
    expect(diversity(baseRuns({ ...multi, runs: c }), a.filter((r) => r.policyId === 'FOCUS'), value)).toMatchObject({ pairs: 0, pass: null });
    const sections = riskTables(multi);
    expect(row(sections.split(`### ${OPERATIONS_SCENARIO_IDS[0]}`)[1]!, 'D')).toContain('통과');
    expect(row(sections.split(`### ${EXPERIMENT_SCENARIO_IDS[1]}`)[1]!, 'D')).toContain('실패');
    const cross = riskTables(multi).split('### 변형 사이 차이')[1]!;
    expect(cross).toContain('변형 사이: 생성기 묶음이 다름(H19-1)'); expect(cross).not.toMatch(/통과|실패|판정/);
  });
  it('판정 종류와 실행 없음·근거 부족을 구분하며 축소 묶음에는 고용 표가 없다', () => {
    const expected: Record<string, string[]> = {
      J1: ['판정','판정','판정','판정'], J2: ['판정','해당 없음','해당 없음','판정'], J2b: ['진단','해당 없음','해당 없음','진단'],
      J3: ['판정','해당 없음','해당 없음','판정'], 'J4a~c': ['판정','판정','판정','판정'], J4d: ['판정','진단','진단','판정'],
      J5: ['판정','해당 없음','해당 없음','판정'], J6: ['판정','해당 없음','해당 없음','판정'], 'J7(옛 정의)': ['판정','진단','진단','진단'],
      'J7(새 정의)': ['진단','진단','진단','판정'], L0: ['판정','해당 없음','해당 없음','해당 없음'], L1: ['해당 없음','진단','진단','판정'],
      L3: ['해당 없음','진단','진단','판정'], D: ['판정','진단','진단','판정'], '진단 T': ['해당 없음','해당 없음','진단','진단'],
      '진단 C': ['해당 없음','진단','진단','진단'], '진단 F': ['해당 없음','진단','해당 없음','진단'], '진단 B': ['해당 없음','진단','진단','진단'],
    };
    expect(RISK_JUDGMENT_KINDS).toEqual(expected);
    for (const [i, level] of (['R0','R1','R2','R3'] as const).entries()) {
      const o = fixture(level), text = d03Tables(o); expect(text).not.toContain('미측정');
      for (const id of Object.keys(RISK_JUDGMENT_KINDS) as (keyof typeof RISK_JUDGMENT_KINDS)[]) {
        expect(judgmentKind(id, level, false)).toBe(expected[id]![i]);
        const line = row(text, id); expect(line).toBeDefined();
        if (id === 'J7(옛 정의)' && level !== 'R0') expect(line).toContain('| | USD 몫만·진단');
        else expect(line).toMatch(expected[id]![i] === '판정' ? /통과|실패/ : new RegExp(expected[id]![i]!));
      }
      if (level === 'R1' || level === 'R2') expect(text.match(/해당 없음\(축소 묶음\)/g)).toHaveLength(2);
      o.runs = []; const missing = d03Tables(o); expect(row(missing, 'J1')).toContain('실패 | 실행 없음:');
    }
    const full = fixture('R0', d03PolicyIds('base')); expect(row(d03Tables(full), 'J6')).toContain('실패 | 근거 부족:');
  });
  it('분석값 전환은 표 ①·cell·J3·J4d·D·⑥에 모두 적용된다', () => {
    for (const level of ['R0','R1','R2','R3'] as const) {
      const o = fixture(level, ['MAX_CONTRIBUTION','LATE_OK','FOCUS']);
      const a = baseRuns(o), b = o.runs.filter((r) => r.policyId === 'LATE_OK');
      a.forEach((r) => { r.metrics.currencies.USD!.netAssets = 2100000; r.metrics.risk!.analysisValueMinor = 1100000; });
      b.forEach((r) => { r.metrics.currencies.USD!.netAssets = 1000000; r.metrics.risk!.analysisValueMinor = 2500000; });
      const text = d03Tables(o), risk = level !== 'R0';
      expect(row(text, 'MAX_CONTRIBUTION')).toContain(risk ? '11,000' : '21,000');
      expect(row(text, 'LATE_OK')).toContain(risk ? '+14,000' : '-11,000');
      expect(text).toContain(risk ? '같은 시드의 분석값 차이' : '같은 시드의 USD 순자산 차이');
      expect(text).toContain(risk ? '| 기준 대비 분석값 | 분석값 중앙 |' : '| 기준 대비 USD | USD 순자산 중앙 |');
      expect(text).toContain(risk ? '| 투자 없음 대비 분석값 |' : '| 투자 없음 대비 USD |');
      expect(cell(b, a, comparisonValue(level)).median).toBe(risk ? 1400000 : -1100000);
      expect(row(text, 'J3')).toContain(risk ? 'LATE_OK' : 'MAX_CONTRIBUTION');
      expect(text).toContain(`| ${risk ? 'LATE_OK' : 'MAX_CONTRIBUTION'} | 20 |`);
      expect(row(text, 'J4d')).toContain(risk ? '11,000' : '21,000');
      expect(row(riskTables(o), 'D')).toContain(risk ? 'FOCUS 20' : 'EXPAND(MAX_CONTRIBUTION) 20');
      expect(text.includes('USD 몫만·진단')).toBe(risk);
    }
  });
  it('J3에서 새 정책 둘은 제외하고 MAX_CONTRIBUTION은 남긴다', () => {
    const o = fixture('R3', ['MAX_CONTRIBUTION','LATE_OK','MARGIN_BUFFER','FOCUS']);
    o.runs.filter((r) => ['MARGIN_BUFFER','FOCUS'].includes(r.policyId)).forEach((r) => { r.metrics.risk!.analysisValueMinor = 9999999; });
    expect(row(d03Tables(o), 'J3')).toContain('후보 2정책, 가장 강한 MAX_CONTRIBUTION');
  });
  it('J4d 두 띠는 양끝을 포함하고 J4a~c와 별도 행이다', () => {
    for (const level of ['R0','R1','R2','R3'] as const) for (const [v, pass] of (level === 'R0' ? [[10600,true],[21200,true],[10599,false],[21201,false]] : [[10692,true],[21385,true],[10691,false],[21386,false]]) as [number, boolean][]) {
      const o = fixture(level); baseRuns(o).forEach((r) => { r.metrics.currencies.USD!.netAssets = v * 100; r.metrics.risk!.analysisValueMinor = v * 100; });
      const text = d03Tables(o); expect(row(text, 'J4a~c')).toBeDefined();
      expect(row(text, 'J4d')).toContain(level === 'R1' || level === 'R2' ? '진단' : pass ? '통과' : '실패');
      expect(row(text, 'J4d')).toContain(level === 'R0' ? '10,600~21,200' : '10,692~21,385');
    }
  });
  it('J4a~c 근거에 기준 회사의 준비 최소·최대 pt를 적는다', () => {
    const o = fixture('R1', ['MAX_CONTRIBUTION', 'NO_FX'], 2), rs = baseRuns(o);
    Object.assign(rs[0]!.metrics.operations!, { forwardingPrepMin: 4, forwardingPrepMax: 7 });
    Object.assign(rs[1]!.metrics.operations!, { forwardingPrepMin: 3, forwardingPrepMax: 11 });
    expect(row(d03Tables(o), 'J4a~c')).toContain('준비 3~11pt');
  });
  it('진단 T·C·F·B는 기준 회사와 실행을 구분한다', () => {
    const o = fixture('R3', ['MAX_CONTRIBUTION','FOCUS'], 2);
    const cs = [contract(-2),contract(2,{onTime:false}),contract(1,{kind:'FORWARDING'})]; cs[0]!.components.tariff = -3; cs[1]!.components.fx = -4;
    baseRuns(o).forEach((r) => { r.metrics.risk!.contracts = structuredClone(cs); });
    o.runs[0]!.metrics.risk!.referenceRateBounds = true;
    // 같은 시드의 두 정책 모두 참이어도 B는 한 번만 센다.
    o.runs[2]!.metrics.risk!.referenceRateBounds = true;
    expect(cs.some((c) => c.kind === 'FORWARDING' && c.onTime)).toBe(true);
    expect(diagnostics(o.runs, baseRuns(o), o.meta.seeds)).toEqual({ tariff: {affected:2,total:2}, causes:{tariff:2}, fx:{affected:2,total:4,median:-2}, bounds:{affected:1,total:2} });
    expect(row(riskTables(o), '진단 B')).toContain('진단 | 1/2');
    for (const level of ['R0','R1','R2','R3'] as const) {
      o.meta.risk!.level = level; const text = riskTables(o);
      expect(row(text,'진단 T')).toContain(['R2','R3'].includes(level) ? '진단 | 2/2' : '해당 없음');
      expect(row(text,'진단 F')).toContain(['R1','R3'].includes(level) ? '진단 | 2/4' : '해당 없음');
      for (const id of ['진단 C','진단 B']) expect(row(text,id)).toContain(level === 'R0' ? '해당 없음' : '진단');
    }
  });
});

describe('위험 정책과 엔진 연결', () => {
  it('진단 B는 R3의 실패일과 관계없이 같은 시드의 두 정책에서 같다', () => {
    const pairs = riskSeeds(2001, 20).map((seed) => ({
      base: simulation('R3', 'MAX_CONTRIBUTION', seed), nofx: simulation('R3', 'NO_FX', seed),
    }));
    expect(pairs.some(({ base }) => base.run.metrics.risk!.referenceRateBounds)).toBe(true);
    expect(pairs.some(({ base, nofx }) => (base.state.operations!.failure?.day ?? cfg('R3', base.run.seed).campaignDays)
      !== (nofx.state.operations!.failure?.day ?? cfg('R3', nofx.run.seed).campaignDays))).toBe(true);
    for (const { base, nofx } of pairs) expect(nofx.run.metrics.risk!.referenceRateBounds, `시드 ${base.run.seed}`)
      .toBe(base.run.metrics.risk!.referenceRateBounds);
  }, 300000);
  it('rules-2 출력에는 위험 필드가 없고 위험 실행은 결정적이다', () => {
    const seeds = riskSeeds(2001, 1), plain = runD03({seeds, policyIds:['IDLE']});
    expect(plain.meta).not.toHaveProperty('risk'); expect(plain.runs[0]!.metrics).not.toHaveProperty('risk');
    expect(d03Tables(plain)).not.toContain('USD 몫만·진단');
    const regular = simulate(loadScenario(OPERATIONS_SCENARIO_IDS[0]), policyById('IDLE')!, seeds[0]!);
    expect(regular.run.metrics).not.toHaveProperty('risk');
    const suite=runSuite({scenarioIds:[SCENARIO_IDS[0]],policyIds:['IDLE'],seeds});
    expect(suite.meta).not.toHaveProperty('risk');expect(suite.runs[0]!.metrics).not.toHaveProperty('risk');
    const options = {seeds, policyIds:['MAX_CONTRIBUTION'], risk:'R1' as const, marketRulesSha256:meta('R1').marketRulesSha256};
    expect(serializeSimOutput(runD03(options))).toBe(serializeSimOutput(runD03(options)));
  }, 60000);
  it('결정 기여 부호·크기와 USD·KRW 분기는 늦은 감액 전 판매를 쓴다', () => {
    let count = 0; const checks: (()=>void)[] = [];
    for (const level of ['R0','R1'] as const) {
      let lateFound = false;
      for (const seed of riskSeeds(2001, 8)) {
        const config = cfg(level, seed); let state = createGame(config);
        for (let day = 1; day <= config.campaignDays; day++) {
          state = openDay(state, config).state;
          for (const c of directTradeCandidates(state, config, day)) {
            const p = c.preview, sale = offerDef(state, config, c.sellOfferId)!.unitPriceMinor * c.quantity;
            if (level === 'R1' && !p.lateOnNextSailing) {
              count++;
              const {pnlKrw,rateKrwPerUsd: rate} = p.referenceEstimate!;
              checks.push(()=>{if (c.contribution !== 0) expect(Math.sign(c.contribution)).toBe(Math.sign(pnlKrw));
                expect(Math.abs(100 * pnlKrw - c.contribution * rate)).toBeLessThanOrEqual(100 + rate / 2);});
            }
            if (p.lateOnNextSailing && p.sale < sale) {
              lateFound = true;
              const expected = sale - p.freight - p.duty - (level === 'R0' ? p.purchase : krwToUsdMinor(p.purchase, p.referenceEstimate!.rateKrwPerUsd));
              checks.push(()=>{expect(c.sale).toBe(sale); expect(c.contribution).toBe(expected); expect(decisionContribution(p,sale,c.purchaseCurrency)).toBe(expected);});
            }
          }
          state = commitDay(state, config, []).state; if (state.phase === 'ENDED') break;
        }
        if (lateFound && (level === 'R0' || count)) break;
      }
      expect(lateFound).toBe(true);
    }
    expect(count).toBeGreaterThan(0); checks.forEach((check)=>check());
  }, 60000);
  it('수락 순서는 관측 후보의 D를 따르고 R2 관세는 quotePreview와 같다', () => {
    let found = false, tariffs = 0;
    for (const seed of riskSeeds(2001, 10)) {
      const config = cfg('R1',seed);
      simulate(config, policyById('MAX_CONTRIBUTION')!, seed, (s, commands) => {
        const accepts = commands.filter((c) => c.type === 'ACCEPT_TRADE');
        if (accepts.length < 2 || !accepts.some((a) => offerDef(s,config,a.buyOfferId)!.currency === 'KRW')) return;
        found = true;
        const candidates = directTradeCandidates(s, config, s.day).sort((a,b) => a.buyOfferId === b.buyOfferId ? b.quantity - a.quantity : b.contribution - a.contribution);
        const positions = accepts.map((a) => candidates.findIndex((c) => c.buyOfferId === a.buyOfferId && c.sellOfferId === a.sellOfferId && c.quantity === a.quantity));
        expect(positions.every((p) => p >= 0)).toBe(true); expect(positions).toEqual([...positions].sort((a,b) => a-b));
      });
      if (found) break;
    }
    expect(found).toBe(true);
    const config = cfg('R2',riskSeeds(2001,1)[0]!), state = openDay(createGame(config),config).state;
    for (const c of directTradeCandidates(state,config,state.day)) { tariffs++; expect(c.preview.duty).toBe(quotePreview(state,config,{buyOfferId:c.buyOfferId,sellOfferId:c.sellOfferId},c.quantity).duty); }
    expect(tariffs).toBeGreaterThan(0);
  }, 60000);
  it('환전 짝은 원화 부족일 때만 두 명령을 적용하고 NO_FX 자신의 상태에서도 끈다', () => {
    let paired = false, alone = false, noFxOpportunity = false;
    for (const seed of riskSeeds(2001, 10)) {
      const config = cfg('R1', seed);
      for (const policyId of ['MAX_CONTRIBUTION','NO_FX']) simulate(config,policyById(policyId)!,seed,(s,commands) => {
        let current = s;
        for (let i = 0; i < commands.length; i++) {
          const command = commands[i]!;
          if (command.type === 'ACCEPT_TRADE') {
            const candidate = directTradeCandidates(current,config,s.day).find((c) => c.buyOfferId === command.buyOfferId && c.quantity === command.quantity)!;
            if (candidate && candidate.purchaseCurrency === 'KRW') {
              let expense=0; for(let d=s.day;d<=Math.min(config.campaignDays,s.day+6);d++) expense+=dailyKrwDue(current,config,d);
              const short = candidate.preview.purchase-(fundsPosition(current,config,'KRW').available-expense);
              if (short<=0 && commands[i-1]?.type !== 'EXCHANGE_CURRENCY') alone=true;
            }
          }
          const next = commands[i+1];
          if(policyId==='MAX_CONTRIBUTION' && command.type==='EXCHANGE_CURRENCY' && next?.type==='ACCEPT_TRADE') {
            const c=directTradeCandidates(current,config,s.day).find((c)=>c.buyOfferId===next.buyOfferId && c.quantity===next.quantity)!;
            let expense=0; for(let d=s.day;d<=Math.min(config.campaignDays,s.day+6);d++) expense+=dailyKrwDue(current,config,d);
            if(c && c.preview.purchase-(fundsPosition(current,config,'KRW').available-expense)>0) {
              paired=true; expect(command.id.endsWith(`-${i+1}`)).toBe(true); expect(next.id.endsWith(`-${i+2}`)).toBe(true);
              expect(planState(current,config,[command,next]).results.map((r)=>r.status)).toEqual(['APPLIED','APPLIED']);
            }
          }
          current=planState(current,config,[command]).state;
        }
        if(policyId==='NO_FX') {
          expect(commands.filter((c)=>c.type==='EXCHANGE_CURRENCY')).toHaveLength(0);
          for(const c of directTradeCandidates(s,config,s.day).filter((c)=>c.contribution>0 && !c.preview.lateOnNextSailing && c.purchaseCurrency==='KRW')) {
            let expense=0;for(let d=s.day;d<=Math.min(config.campaignDays,s.day+6);d++) expense+=dailyKrwDue(s,config,d);
            const short=c.preview.purchase-(fundsPosition(s,config,'KRW').available-expense);
            const usd=Math.ceil(short/usdLotKrw(config,s))*config.operations!.fx.lotUsdMinor;
            const cap=fundsPosition(s,config,'USD').available-c.preview.cashNeedByCurrency!.find((x)=>x.currency==='USD')!.amountMinor;
            if(short>0 && usd<=cap) noFxOpportunity=true;
          }
        }
      });
      if(paired && alone && noFxOpportunity) break;
    }
    expect(paired).toBe(true); expect(alone).toBe(true); expect(noFxOpportunity).toBe(true);
  }, 60000);
  it('환전 성공 뒤 보관 거절은 ACCEPT 사유로 세며 두 명령을 버린다', () => {
    const seed=riskSeeds(2001,1)[0]!, config=cfg('R1',seed);
    let found: {state:GameState; candidate:ReturnType<typeof directTradeCandidates>[number]} | undefined;
    simulate(config,policyById('MAX_CONTRIBUTION')!,seed,(state,commands)=>{
      if(found) return;
      let current=state;
      for(let i=0;i<commands.length;i++) {
        const ex=commands[i]!,acc=commands[i+1];
        if(ex.type==='EXCHANGE_CURRENCY' && acc?.type==='ACCEPT_TRADE') {
          const c=directTradeCandidates(current,config,state.day).find((c)=>c.buyOfferId===acc.buyOfferId && c.quantity===acc.quantity);
          if(c) {found={state:structuredClone(current),candidate:c};return;}
        }
        current=planState(current,config,[ex]).state;
      }
    });
    expect(found).toBeDefined();
    const state=found!.state, original=found!.candidate, buy=offerDef(state,config,original.buyOfferId)!;
    buy.maxQuantity=buy.quantityStep; const q=buy.quantityStep;
    for(const o of state.offers) if(![original.buyOfferId,original.sellOfferId].includes(o.id)) o.status='EXPIRED';
    // 현금은 원장 잔액을 낮추는 분개로 구성한다. 정책의 아침 환전 뒤에도 매입이 부족하도록 한다.
    const available=fundsPosition(state,config,'KRW').available;
    state.ledger.entries.push({id:'시험-원화',day:state.day,currency:'KRW',reason:'시험',lines:[{account:'CASH',amount:-available},{account:'OPENING_EQUITY',amount:available}]});
    config.operations!.facility.storageLiters=0;
    const decide=decideOperations('MAX_CONTRIBUTION',parseVariant('MAX_CONTRIBUTION')!,state,config,createRng(seed));
    const c=directTradeCandidates(state,config,state.day).find((c)=>c.buyOfferId===buy.id && c.quantity===q)!;
    expect(c).toBeDefined();
    let current=state;
    for(const cmd of decide.commands) current=planState(current,config,[cmd]).state;
    let expense=0;for(let d=state.day;d<=Math.min(config.campaignDays,state.day+6);d++) expense+=dailyKrwDue(current,config,d);
    const short=c.preview.purchase-(fundsPosition(current,config,'KRW').available-expense); expect(short).toBeGreaterThan(0);
    const ex:EngineCommand={id:'시험-ex',type:'EXCHANGE_CURRENCY',direction:'USD_TO_KRW',usdAmountMinor:Math.ceil(short/usdLotKrw(config,current))*config.operations!.fx.lotUsdMinor};
    const acc:EngineCommand={id:'시험-acc',type:'ACCEPT_TRADE',buyOfferId:c.buyOfferId,sellOfferId:c.sellOfferId,quantity:q};
    const results=planState(current,config,[ex,acc]).results;
    expect(results[0]!.status).toBe('APPLIED');expect(results[1]!.status).toBe('REJECTED');expect(results[1]!.reasonKo).toContain('보관');
    expect(decide.rejections).toMatchObject({storage:1,funds:0});
    expect(decide.commands.some((cmd)=>cmd.type==='ACCEPT_TRADE' && cmd.buyOfferId===c.buyOfferId && cmd.quantity===q)).toBe(false);
    expect(decide.commands.some((cmd)=>cmd.type==='EXCHANGE_CURRENCY' && cmd.usdAmountMinor===ex.usdAmountMinor)).toBe(false);
  },60000);
  it('MARGIN_BUFFER 경계 술어와 실제 수락 경로를 확인한다',()=>{
    const sale=1000;expect(marginBufferAccepts(sale/10,sale)).toBe(true);expect(marginBufferAccepts(sale/10-1,sale)).toBe(false);
    let control=false,accepted=0;
    for(const seed of riskSeeds(2001,10)) {
      const config=cfg('R1',seed);
      for(const id of ['MAX_CONTRIBUTION','MARGIN_BUFFER']) simulate(config,policyById(id)!,seed,(s,commands)=>{
        const candidates=directTradeCandidates(s,config,s.day);
        for(const acc of commands) if(acc.type==='ACCEPT_TRADE') {
          const c=candidates.find((c)=>c.buyOfferId===acc.buyOfferId && c.quantity===acc.quantity)!;
          if(id==='MARGIN_BUFFER') {accepted++;expect(10*c.contribution).toBeGreaterThanOrEqual(c.sale);}
          else if(10*c.contribution<c.sale) control=true;
        }
      });
      if(control && accepted) break;
    }
    expect(control).toBe(true);expect(accepted).toBeGreaterThan(0);
  },60000);
  it('FOCUS는 (가)·(다)에서 고정 품목만 받고 (나)의 정적 품목과 같다',()=>{
    const single=EXPERIMENT_SCENARIO_IDS.map((id)=>loadScenario(id)).find(isSingleGoodVariant)!;
    expect(single.offers.find((o)=>o.publishDay===1 && o.kind==='supplier')!.goodId).toBe(FOCUS_GOOD_ID);
    expect(loadScenario(OPERATIONS_SCENARIO_IDS[0]).operations!.market.trade.goods[0]!.goodId).not.toBe(FOCUS_GOOD_ID);
    for(const scenario of [OPERATIONS_SCENARIO_IDS[0],EXPERIMENT_SCENARIO_IDS[1]]) {
      const seed=riskSeeds(2001,1)[0]!, base=simulation('R0','MAX_CONTRIBUTION',seed,scenario), focus=simulation('R0','FOCUS',seed,scenario);
      expect(base.state.contracts.some((c)=>c.kind==='DIRECT_TRADE' && c.goodId!==FOCUS_GOOD_ID)).toBe(true);
      const direct=focus.state.contracts.filter((c)=>c.kind==='DIRECT_TRADE');expect(direct.length).toBeGreaterThan(0);
      expect(direct.every((c)=>c.goodId===FOCUS_GOOD_ID)).toBe(true);
      const config=cfg('R0',seed,scenario), s=openDay(createGame(config),config).state;
      for(const o of s.offers) if(offerDef(s,config,o.id)!.kind!=='forwarding') o.status='EXPIRED';
      const a=policyById('MAX_CONTRIBUTION')!.decide(s,config,createRng(seed)).commands;
      const b=policyById('FOCUS')!.decide(s,config,createRng(seed)).commands;
      expect(a.map(({id,...cmd})=>cmd)).toEqual(b.map(({id,...cmd})=>cmd));
    }
  },60000);
  it('열린 계약은 완료와 중복되지 않는다',()=>{
    const seed=riskSeeds(2001,1)[0]!, config=cfg('R1',seed), state=openDay(createGame(config),config).state;
    let accepted:GameState|undefined;
    for(const c of directTradeCandidates(state,config,state.day)) {
      const p=planState(state,config,[{id:'시험-열린',type:'ACCEPT_TRADE',buyOfferId:c.buyOfferId,sellOfferId:c.sellOfferId,quantity:c.quantity}]);
      if(p.results[0]!.status==='APPLIED') {accepted=p.state;break;}
    }
    expect(accepted).toBeDefined();
    expect(contractRiskReport(accepted!,config,accepted!.contracts[0]!.id).open).toBe(true);
    const metrics=createMetricsCollector(config).finish(accepted!,config), risk=riskMetrics(accepted!,config,metrics,'R1');
    expect(risk.directAccepted).toBe(1);expect(risk.contracts).toHaveLength(1);expect(risk.contracts[0]!.class).toBe('열린');
  });
  it('분석값·계약 분류·R0 보고서와 onTime 재구성이 엔진과 같다',()=>{
    const seed=riskSeeds(2001,1)[0]!, r1=simulation('R1','MAX_CONTRIBUTION',seed), config=cfg('R1',seed);
    expect(r1.run.metrics.risk!.analysisValueMinor).toBe(r1.run.metrics.currencies.USD!.netAssets+krwToUsdMinor(r1.run.metrics.currencies.KRW!.netAssets,config.operations!.fx.baseKrwPerUsd));
    let yes=0,no=0;
    for(const level of ['R0','R2'] as const) {
      const result=simulation(level,'LATE_OK',seed), config=cfg(level,seed), risk=result.run.metrics.risk!;
      const direct=risk.contracts.filter((c)=>c.kind==='DIRECT_TRADE');
      expect(['열린','완료','취소'].reduce((n,k)=>n+direct.filter((c)=>c.class===k).length,0)).toBe(risk.directAccepted);
      for(const c of result.state.contracts) {
        const reported=risk.contracts.find((r)=>r.contractId===c.id)!, r=contractRiskReport(result.state,config,c.id);
        expect(reported).toMatchObject({realized:r.realized,components:r.components,evaluationDay:r.evaluationDay,openFixedRateKrw:r.openFixedRateKrw});
        expect(reported.class).toBe(r.open?'열린':c.status==='COMPLETED'?'완료':'취소');
        if(level==='R0') {expect(r.components.fx).toBe(0);expect(risk).not.toHaveProperty('analysisValueMinor');}
        else {
          const p=preview(config,c.kind,c.originCityId,c.destinationCityId,c.acceptedDay,{purchase:c.purchaseAmountMinor,sale:c.saleAmountMinor},c.deliveryDeadlineDay,c.paymentDueDay,
            {goodId:c.goodId,purchaseCurrency:c.buyOfferId?offerDef(result.state,config,c.buyOfferId)!.currency:c.currency})!;
          const sh=result.state.shipments.find((s)=>s.contractId===c.id);
          const expected=!p.lateOnNextSailing && sh?.arrivalDay!=null && sh.arrivalDay+config.terms.customsDays<=c.deliveryDeadlineDay;
          expect(reported.onTime).toBe(expected);if(expected) yes++;else no++;
        }
      }
    }
    expect(yes).toBeGreaterThan(0);expect(no).toBeGreaterThan(0);
  },60000);
});

describe('위험 경로 경계와 비교 도구',()=>{
  it('미래 누설은 전체 sim의 import와 다시 내보내기에서 막는다',async()=>{
    const {fs}=await nodeIo();
    const allowed=new Set(['krwToUsdMinor','usdToKrwMinor','rowCurrency','divHalfAway','withRiskLevel']);
    // 확장자와 상대 경로 표기가 달라도 같은 파일로 판정한다.
    const resolveModule=(file:string,module:string)=>new URL(module, `file:///${file}`).pathname.replace(/\.(?:ts|js|mjs)$/, '');
    const riskModule=resolveModule('src/engine/sim/operations-policy.ts','../risk');
    const policyFiles=new Set(['operations-policy.ts','policies.ts','variants.ts'].map((name)=>`/src/engine/sim/${name}`));
    const reports=new Set(['risk-metrics','risk-tables'].map((name)=>`/src/engine/sim/${name}`));
    const violations=(file:string,raw:string):string[]=>{
      const source=raw.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,''), errors:string[]=[];
      const isPolicy=policyFiles.has(`/${file}`), isReport=reports.has(`/${file.replace(/\.ts$/, '')}`);
      const declarations=source.matchAll(/(?:^|[;\n])\s*(import|export)\s+([^;]+?)\s+from\s+['"]([^'"]+)['"]/g);
      for(const [,kind,binding,module] of declarations) {
        const target=resolveModule(file,module!);
        if(isPolicy && reports.has(target)) errors.push('정책에서 보고서 접근');
        if(target!==riskModule) continue;
        if(kind==='export') {errors.push('위험 모듈 다시 내보내기');continue;}
        if(isReport) continue;
        if(binding!.startsWith('type ')) continue;
        if(!/^\{[\s\S]*\}$/.test(binding!)) {errors.push('위험 모듈 namespace·기본 import');continue;}
        for(const e of binding!.replace(/[{}]/g,'').split(',').map((s)=>s.trim()).filter(Boolean)) {
          if(e.startsWith('type '))continue;
          const imported=e.split(/\s+as\s+/)[0]!;
          if(!allowed.has(imported) && !(file==='src/engine/sim/risk-runner.test.ts' && ['claimFor','collectionPlan'].includes(imported))) errors.push(`허용 밖 import: ${imported}`);
        }
      }
      for(const [,module] of source.matchAll(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
        const target=resolveModule(file,module!);
        if(target===riskModule && !isReport || isPolicy && reports.has(target)) errors.push('위험 모듈·보고서 동적 import');
      }
      return errors;
    };
    // 검사기 자체에도 양성·음성 대조를 둔다. 문자열은 검사 대상 코드와 구분한다.
    const file='src/engine/sim/operations-policy.ts';
    for(const module of ['../risk','../risk.ts','../risk.js','../sim/../risk.ts']) {
      expect(violations(file,`im${'port'} { tariffEvents as events } from '${module}';`)).toContain('허용 밖 import: tariffEvents');
      expect(violations(file,`const risk = im${'port'}('${module}');`)).toContain('위험 모듈·보고서 동적 import');
      expect(violations(file,`ex${'port'} { tariffEvents } from '${module}';`)).toContain('위험 모듈 다시 내보내기');
      expect(violations('src/engine/sim/risk-metrics.ts',`ex${'port'} * from '${module}';`)).toContain('위험 모듈 다시 내보내기');
      expect(violations(file,`im${'port'} { krwToUsdMinor as convert } from '${module}';`)).toEqual([]);
    }
    expect(violations('src/engine/sim/nested/helper.ts',`im${'port'} { tariffEvents } from '../../risk.js';`)).toContain('허용 밖 import: tariffEvents');
    const walk=(dir:string):void=>{for(const name of fs.readdirSync(dir)) {
      const path=`${dir}/${name}`;
      if(!name.includes('.')) {walk(path);continue;}
      if(!/\.(?:ts|mjs)$/.test(name)) continue;
      expect(violations(path,fs.readFileSync(path,'utf8')),path).toEqual([]);
    }};
    walk('src/engine/sim');
  });
  it('워커 선택지와 합치기는 요청의 위험 메타 전체를 검사한다',()=>{
    const options={seeds:riskSeeds(2001,2),policyIds:['MAX_CONTRIBUTION'],scenarioIds:[...EXPERIMENT_SCENARIO_IDS],late:'base' as const,risk:'R1' as const,tuningRound:2,marketRulesSha256:meta('R1').marketRulesSha256};
    expect(workerOptions(options,1,2)).toEqual({...options,seeds:riskSeeds(2002,1)});
    const o=fixture('R1',['MAX_CONTRIBUTION'],2), x=structuredClone(o);x.runs=x.runs.slice(0,1);o.runs=o.runs.slice(1);
    expect(mergeD03([o,x],'base',meta('R1')).runs).toHaveLength(2);
    const plain=structuredClone(x);delete plain.meta.risk;
    expect(()=>mergeD03([plain,o],'base',meta('R1'))).toThrow();expect(()=>mergeD03([o],'base')).toThrow();
    for(const key of ['level','profileId','tuningRound','marketRulesSha256'] as const) {
      const changed=structuredClone(x);
      if(key==='level') changed.meta.risk!.level='R2';else if(key==='tuningRound') changed.meta.risk!.tuningRound=1;
      else changed.meta.risk![key]='b'.repeat(64);
      expect(()=>mergeD03([o,changed],'base',meta('R1'))).toThrow();
      expect(()=>mergeD03([changed],'base',meta('R1'))).toThrow();
      const both=structuredClone(o);both.meta.risk=changed.meta.risk;
      expect(()=>mergeD03([changed,both],'base',meta('R1'))).toThrow();
      const io:SimIo={now:()=>0,out:()=>{},err:()=>{},readText:()=>serializeSimOutput(changed),writeText:()=>{},marketRulesSha256:()=>meta('R1').marketRulesSha256};
      expect(simMain(['d03','--tables-from','file','--risk','R1','--seed-base','2001','--seeds','1','--policies','IDLE'],io)).toBe(2);
    }
    expect(requestedRisk(options)).toEqual({...meta('R1'),tuningRound:2});
  });
  it('CLI 인수·Node 해시·워커 1과 2의 JSON은 결정적이다',async()=>{
    const {fs,exec}=await nodeIo(), dir=fs.mkdtempSync('/tmp/risk-runner-');
    const safe=['--seed-base',String(riskSeeds(2001,1)[0]),'--seeds','1','--policies','IDLE'];
    for(const extra of [['--round','4','--risk','R1'],['--round','-1','--risk','R1'],['--round','1'],['--scenarios',EXPERIMENT_SCENARIO_IDS[0]]]) {
      expect(()=>d03Options([...safe,...extra])).toThrow(); await expect(exec(['d03',...safe,...extra])).rejects.toThrow();
    }
    try {
      for(const workers of [1,2]) await exec(['d03','--seed-base',String(riskSeeds(2001,1)[0]),'--seeds','2','--policies','IDLE','--risk','R1','--workers',String(workers),'--out',`${dir}/${workers}.json`]);
      const one=fs.readFileSync(`${dir}/1.json`,'utf8'); expect(fs.readFileSync(`${dir}/2.json`,'utf8')).toBe(one);
      const crypto=await import('node:crypto' as string) as {createHash(name:string):{update(text:string):{digest(encoding:string):string}}};
      expect((JSON.parse(one) as SimOutput).meta.risk!.marketRulesSha256).toBe(crypto.createHash('sha256').update(fs.readFileSync('data/market_rules.json','utf8')).digest('hex'));
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
  },60000);
  it('risk-compare는 이웃 층·메타·기준 실행을 검사하고 입력 오류를 2로 낸다',()=>{
    const a=fixture('R0',['MAX_CONTRIBUTION']),b=fixture('R1',['MAX_CONTRIBUTION']);
    const code=(x:SimOutput,y:SimOutput)=>simMain(['risk-compare','a','b'],{readText:(p)=>serializeSimOutput(p==='a'?x:y),writeText:()=>{},out:()=>{},err:()=>{},now:()=>0});
    expect(code(a,b)).toBe(0);
    for(const level of ['R0','R2','R3'] as const) {const bad=structuredClone(b);bad.meta.risk!.level=level;expect(code(a,bad)).toBe(2);}
    expect(code(b,a)).toBe(2);
    for(const key of ['profileId','tuningRound','marketRulesSha256'] as const) {const bad=structuredClone(b);if(key==='tuningRound')bad.meta.risk!.tuningRound++;else bad.meta.risk![key]+='x';expect(code(a,bad)).toBe(2);}
    for(const key of ['engineVersion','dataVersion','format','lateMode','scenarioIds','seeds'] as const) {
      const bad=structuredClone(b);
      if(key==='format')bad.meta.format++;else if(key==='seeds')bad.meta.seeds=riskSeeds(2002,20);else if(key==='scenarioIds')bad.meta.scenarioIds=[EXPERIMENT_SCENARIO_IDS[0]];
      else if(key==='lateMode')bad.meta.lateMode='cap30';else bad.meta[key]+='x';
      expect(code(a,bad)).toBe(2);
    }
    for(const side of [0,1]) {const pair=[structuredClone(a),structuredClone(b)];delete pair[side]!.meta.risk;expect(code(pair[0]!,pair[1]!)).toBe(2);}
    const missing=structuredClone(b);missing.runs.pop();expect(code(a,missing)).toBe(2);
  });
  it('risk-compare는 비율 +1.0%p와 +0.9%p를 구분하고 두 조건을 모두 요구한다',()=>{
    const a=fixture('R0',['MAX_CONTRIBUTION'],1),b=fixture('R1',['MAX_CONTRIBUTION'],1);
    setLosses(a.runs[0]!,20,100);setLosses(b.runs[0]!,21,100);
    expect(compareRisk(a,b)[0]).toMatchObject({rate:true,count:true,pass:true});
    setLosses(b.runs[0]!,209,1000);expect(compareRisk(a,b)[0]).toMatchObject({rate:false,count:true,pass:false});
    // 분모가 달라 건수가 내려가도 비율은 정확히 1%p 오른다.
    // 정수 계약 수로 20/100 -> 21/100 대신 20/200 -> 11/100을 쓴다.
    setLosses(a.runs[0]!,20,200);setLosses(b.runs[0]!,11,100);
    expect(compareRisk(a,b)[0]).toMatchObject({rate:true,count:false,pass:false,decrease:1});
    setLosses(a.runs[0]!,10,100);setLosses(b.runs[0]!,10,50);
    expect(compareRisk(a,b)[0]).toMatchObject({rate:true,increase:0,decrease:0,count:false,pass:false});
    const iii=compareRisk(a,b)[0]!.iii!;expect(iii).toMatchObject({a:100,b:50,pass:true});
    expect(riskCompareTables(a,b)).toContain('(iii): 통과');
    a.meta.risk!.level='R1';b.meta.risk!.level='R2';expect(compareRisk(a,b)[0]).not.toHaveProperty('iii');
    a.meta.risk!.level='R0';b.meta.risk!.level='R1';
    for(const o of [a,b]) {o.meta.scenarioIds=[EXPERIMENT_SCENARIO_IDS[0]];o.runs.forEach((r)=>r.scenarioId=EXPERIMENT_SCENARIO_IDS[0]);}
    expect(compareRisk(a,b)[0]).not.toHaveProperty('iii');
  });
  it('risk-compare는 runs만 섞어도 시드 값으로 짝을 짓는다',()=>{
    const a=fixture('R1',['MAX_CONTRIBUTION'],3),b=fixture('R2',['MAX_CONTRIBUTION'],3);
    [1,2,4].forEach((n,i)=>setLosses(a.runs[i]!,n,10));[2,3,4].forEach((n,i)=>setLosses(b.runs[i]!,n,10));
    const before=compareRisk(a,b);
    b.runs=[b.runs[2]!,b.runs[0]!,b.runs[1]!];
    const positional=b.runs.filter((r,i)=>lossStats([r]).loss>lossStats([a.runs[i]!]).loss).length;
    expect(positional).not.toBe(before[0]!.increase);expect(compareRisk(a,b)).toEqual(before);
    b.meta.seeds.reverse();expect(compareRisk(a,b)).toEqual(before);
  });
  it('공통 난수 전제는 함께 받은 견적의 관측 클레임·수금과 공개 묶음으로 확인한다',()=>{
    for(const scenario of [OPERATIONS_SCENARIO_IDS[0],EXPERIMENT_SCENARIO_IDS[1]]) {
      let common=0,claimPairs=0,latePairs=0; const checks:(()=>void)[]=[];
      for(const seed of riskSeeds(2001,30)) {
        const config=cfg('R3',seed,scenario), a=simulation('R3','MAX_CONTRIBUTION',seed,scenario), b=simulation('R3','FOCUS',seed,scenario);
        const end=(s:GameState)=>s.operations!.failure?.day??config.campaignDays;
        for(const batch of a.state.operations!.batches.filter((x)=>x.publishDay<=Math.min(end(a.state),end(b.state)))) {
          const other=b.state.operations!.batches.find((x)=>x.k===batch.k);checks.push(()=>expect(other).toEqual(batch));
          checks.push(()=>expect(batch.offerIds.map((id)=>offerDef(a.state,config,id))).toEqual(other!.offerIds.map((id)=>offerDef(b.state,config,id))));
        }
        for(const ca of a.state.contracts.filter((c)=>c.kind==='DIRECT_TRADE')) {
          const cb=b.state.contracts.find((c)=>c.kind==='DIRECT_TRADE' && c.sellOfferId===ca.sellOfferId);if(!cb)continue;common++;
          const ia=a.state.invoices.find((i)=>i.contractId===ca.id),ib=b.state.invoices.find((i)=>i.contractId===cb.id);if(!ia || !ib)continue;
          const observed=(s:GameState,c:GameState['contracts'][number])=>{
            const entry=s.ledger.entries.find((e)=>e.contractId===c.id && e.id.startsWith('CLAIM-'));
            const amount=entry?.lines.find((l)=>l.account==='SALES_ALLOWANCE')?.amount??0;
            const inv=s.invoices.find((i)=>i.contractId===c.id)!;
            const receipts=s.ledger.entries.filter((e)=>e.contractId===c.id && e.id.startsWith('RECEIPT-'));
            return {claim:!!entry,amount,invoice:inv.amountMinor,offsets:receipts.map((e)=>e.day-inv.dueDay),paid:receipts.reduce((sum,e)=>sum+(e.lines.find((l)=>l.account==='CASH')?.amount??0),0)};
          };
          const oa=observed(a.state,ca),ob=observed(b.state,cb);
          for(const [c,o] of [[ca,oa],[cb,ob]] as const) {
            const draw=claimFor(config,seed,c.sellOfferId!,c.goodId),sale=c.saleAmountMinor-c.priceReductionMinor;
            checks.push(()=>{expect(o.claim).toBe(!!draw);expect(o.amount).toBe(draw?Math.floor((sale*draw.rateBp+5000)/10000):0);
              expect(o.invoice).toBe(sale-o.amount);});
          }
          checks.push(()=>expect(oa.claim).toBe(ob.claim));
          if(ca.saleAmountMinor-ca.priceReductionMinor===cb.saleAmountMinor-cb.priceReductionMinor && oa.claim) {claimPairs++;checks.push(()=>{expect(oa.amount).toBe(ob.amount);expect(oa.invoice).toBe(ob.invoice);});}
          const pa=collectionPlan(config,seed,ca.sellOfferId!,offerDef(a.state,config,ca.sellOfferId!)!.counterpartyId);
          const pb=collectionPlan(config,seed,cb.sellOfferId!,offerDef(b.state,config,cb.sellOfferId!)!.counterpartyId);
          if(ia.dueDay+pa.days>end(a.state) || ib.dueDay+pb.days>end(b.state))continue;
          for(const [p,o] of [[pa,oa],[pb,ob]] as const) {
            checks.push(()=>{expect(o.offsets).toEqual(p.mode==='ON_TIME'?[0]:p.mode==='LATE'?[p.days]:[0,p.days]);expect(o.paid).toBe(o.invoice);});
          }
          checks.push(()=>expect(oa.offsets).toEqual(ob.offsets));
          if(oa.offsets.some((d)=>d>0))latePairs++;
        }
        if(seed>=riskSeeds(2003,1)[0]! && common && claimPairs && latePairs)break;
      }
      expect(common).toBeGreaterThan(0);expect(claimPairs).toBeGreaterThan(0);expect(latePairs).toBeGreaterThan(0);checks.forEach((check)=>check());
    }
    const seed=riskSeeds(2001,1)[0]!, one=cfg('R3',seed,EXPERIMENT_SCENARIO_IDS[0]),two=cfg('R3',seed,EXPERIMENT_SCENARIO_IDS[1]);
    let different=false;
    let ai=one.operations!.market.index.goods.map((goodId)=>({goodId,bp:one.operations!.market.index.startBp,stepPct:null as number|null}));
    let bi=two.operations!.market.index.goods.map((goodId)=>({goodId,bp:two.operations!.market.index.startBp,stepPct:null as number|null}));
    for(let k=1;k<5;k++) {
      const a=generateBatch(seed,k,ai,one),b=generateBatch(seed,k,bi,two);ai=a.batch.index;bi=b.batch.index;
      if(JSON.stringify(a.offers.filter((o)=>o.kind==='forwarding'))!==JSON.stringify(b.offers.filter((o)=>o.kind==='forwarding')))different=true;
    }
    expect(different).toBe(true);
  },120000);
});
