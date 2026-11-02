import { beforeAll, describe, expect, it } from 'vitest';
import { loadScenario } from '../../content/scenario';
import { simMain, USAGE, type SimIo } from './cli';
import { d03Tables } from './d03';
import { policyById } from './policies';
import { simConfigV2, type RiskContract, type RiskLevelV2 } from './risk-metrics';
import { lossBandPasses, riskCompareTables, riskTables } from './risk-tables';
import { causesV2, compareRiskV2, creditTotalsV2, d03TablesV2, j4dV2, j9V2, judgmentKindV2, judgmentRowV2, LEVELS_V2,
  LIQUIDITY_NOTE, marginRawV2, newJ7V2, pairedValuesV2, rejectionTotalsV2, RISK_JUDGMENT_KINDS_V2, riskCompareTablesV2,
  SIGN_THRESHOLDS_V2, v2Report } from './risk-tables-v2';
import { simulate, SIM_FORMAT, type SimOutput, type SimRun } from './sim';
import { d03PolicyIdsV2, parseVariant } from './variants';

const SCENARIO = 'SCENARIO_M2_OPS_COS_LAVER', BASE = 'MAX_CONTRIBUTION', SHA = 'a'.repeat(64);
const POLICIES = [BASE, 'NO_FX', 'TERM_GREEDY', 'CREDIT_AWARE', 'MARGIN_BUFFER'];
let template: SimRun, contractTemplate: RiskContract, meta: SimOutput['meta'];
beforeAll(() => {
  const config = simConfigV2(loadScenario(SCENARIO), 'R4', 'RISK_PROFILE_V2');
  const actual = simulate(config, policyById(BASE)!, 2001, undefined, 'R4');
  template = structuredClone(actual.run);
  contractTemplate = structuredClone(template.metrics.risk!.contracts.find((c) => c.kind === 'DIRECT_TRADE')!);
  // 보고에 필요한 칸만 남긴 작은 고정물. 시드·정책마다 다시 복제한다.
  const o = template.metrics.operations!;
  o.utilization = []; o.bottlenecks = []; o.actualHires = []; o.unpaidAtEnd = [];
  o.outcome = 'COMPLETED'; o.maxBatchOffers = 9; o.forwardingPrepMin = 2; o.forwardingPrepMax = 11;
  template.metrics.risk!.contracts = [];
  meta = { tool: 'scitrade-sim', format: SIM_FORMAT, engineVersion: actual.state.meta.engineVersion, dataVersion: actual.state.meta.dataVersion,
    scenarioIds: [SCENARIO], policyIds: POLICIES, seeds: [2001], lateMode: 'base',
    risk: { rules: 'M2a-rules-4', level: 'R4', profileId: 'RISK_PROFILE_V2', tuningRound: 0, marketRulesSha256: SHA } };
}, 60000);
function contract(realized = 100, fx = 0, sale = 1000): RiskContract {
  const c = structuredClone(contractTemplate);
  c.realized = realized; c.openFixedRateKrw = realized; c.saleKrwAtAcceptMinor = sale;
  for (const key of Object.keys(c.components) as (keyof typeof c.components)[]) c.components[key] = 0;
  c.components.fx = fx; return c;
}
function contracts(r: SimRun, cs: RiskContract[]) {
  r.metrics.risk!.contracts = cs;
  const n = cs.filter((c) => c.kind === 'DIRECT_TRADE').length;
  r.metrics.risk!.directAccepted = n;
  r.metrics.risk!.credit!.termCounts = { BASE: n, D15: 0, D30: 0 };
}
function run(id = BASE, seed = 2001, value = 1200000): SimRun {
  const r = structuredClone(template); r.policyId = id; r.seed = seed;
  r.metrics.risk!.analysisValueMinor = value;
  const c = r.metrics.risk!.credit!;
  for (const k of Object.keys(c) as (keyof typeof c)[]) if (k !== 'termCounts') c[k] = 0;
  r.metrics.operations!.rejectionsV2 = { candidate: { funds: 0, storage: 0, handling: 0, sailing: 0, staff: 0, onTime: 0, credit: 0 }, pair: 0, quote: 0, skippedNotOpen: 0 };
  r.metrics.operations!.actualHires = parseVariant(id)!.hires.map((h) => ({ pt: h.pt, plannedDay: h.day, actualDay: h.day }));
  contracts(r, [contract()]); return r;
}
function output(level: RiskLevelV2 = 'R4', n = 3, ids: readonly string[] = POLICIES): SimOutput {
  const m = structuredClone(meta); m.risk!.level = level; m.policyIds = [...ids]; m.seeds = Array.from({ length: n }, (_, i) => 2001 + i);
  return { meta: m, runs: ids.flatMap((id) => m.seeds.map((s) => run(id, s))) };
}
const get = (o: SimOutput, id = BASE) => o.runs.filter((r) => r.policyId === id);
function five(n = 3) { return LEVELS_V2.map((l) => output(l, n)); }
function r0(n = 3) {
  const o = output('R0P', n); o.meta.risk = { level: 'R0', profileId: 'RISK_PROFILE_DEFAULT', tuningRound: 0, marketRulesSha256: SHA }; return o;
}
function memoryIo(outputs: SimOutput[] = []) {
  const files = new Map<string, string>(outputs.map((o) => [o.meta.risk!.level, JSON.stringify(o)])), stdout: string[] = [], stderr: string[] = [];
  const io: SimIo = { readText: (p) => files.get(p)!, writeText: (p, s) => { files.set(p, s); }, out: (s) => { stdout.push(s); }, err: (s) => { stderr.push(s); }, now: () => 0, marketRulesSha256: () => SHA };
  return { files, stdout, stderr, io };
}
const row = (text: string, key: string) => text.split('\n').find((l) => l.startsWith(`| ${key} |`))!;
const riskKeys = ['L1', 'J9', '진단 J8', '진단 L4', '진단 V', '진단 T', '진단 C', '진단 F', '진단 B', '진단 U', '진단 M', '진단 거절'];

// 도움말은 구현 상수에서 복사하지 않고 승인 전문을 고정한다.
const EXPECTED_USAGE = `사용법:
  sim run [--scenarios A,B] [--policies X,Y] [--seeds N] [--out PATH]
  sim d03 [--risk R0|R1|R2|R3] [--scenarios A,B] [--round 0~3] [--seed-base N] [--seeds N] [--seed-from N] [--seed-to N] [--late base|cap30|flat200] [--workers N] [--out PATH]
  sim d03 --risk-v2 R0P|R1|R2|R3|R4 --seed-base N [--profile ID] [--round 0~3] [--scenarios A] [--seeds N] [--seed-from N] [--seed-to N] [--late base|cap30|flat200] [--workers N] [--out PATH]
  sim d03 --tables-from a.json,b.json [--late base|cap30|flat200]
  sim risk-compare A B
  sim v2-tables FILE
  sim risk-compare-v2 A B
  sim v2-report R0P R1 R2 R3 R4 [--r0 FILE]
  sim v3-tables FILE
  sim v3-report --base R0P,R1,R2,R3,R4 [--base-r0 FILE] [--oos R0P,R1,R2,R3,R4] [--oos-r0 FILE]
  sim compare BEFORE AFTER [--limit N]
  sim summary FILE
  sim help | --help
run의 시드 수 N은 기본 목록의 앞 1~20개입니다. 비교 표시 한도는 0 이상의 정수입니다.
D03의 --seed-base N은 시드 목록을 N~N+(시드 수−1)로 바꿉니다(시드 수 기본 20, 최대 40). --seed-base 없이 시드 수는 20 이하입니다. 분할 번호는 이 목록에 적용됩니다.
종료 코드: 0 성공, 1 비교 결과 다름, 2 사용법·입력·실행 오류, 3 v3 J1 관문 실패(출력은 모두 냄).
`;
describe('TASK-0068b 표·보고·비교', () => {
  it('1 CLI 도움말 전문·인수·rules·lateMode·시나리오 검사', () => {
    expect(USAGE).toBe(EXPECTED_USAGE);
    const mem = memoryIo([...five(), r0()]);
    const bad = (args: string[], message: string) => {
      expect(simMain(args, mem.io), args.join(' ')).toBe(2);
      expect(mem.stderr.at(-1)).toContain(`비교 실행기 오류: ${message}`);
      expect(mem.stderr.at(-1)!.endsWith(USAGE)).toBe(true);
    };
    for (const [action, args] of [['v2-tables', ['R0P']], ['risk-compare-v2', ['R0P', 'R1']], ['v2-report', [...LEVELS_V2]]] as const) {
      expect(simMain([action, ...args], mem.io), mem.stderr.join('')).toBe(0);
      bad([action, ...args.slice(1)], action === 'v2-report' ? '다섯 단계' : 'v2 출력 파일');
      bad([action, ...args, 'R4'], action === 'v2-report' ? '다섯 단계' : 'v2 출력 파일');
      bad([action, 'R0', ...args.slice(1)], 'v2 명령은 rules-4 출력만 받습니다.');
      const cap = output('R0P'); cap.meta.lateMode = 'cap30'; mem.files.set('cap', JSON.stringify(cap));
      bad([action, 'cap', ...args.slice(1)], 'v2 표는 lateMode base만 받습니다.');
      const scenario = output('R0P'); scenario.meta.scenarioIds = ['SCENARIO_M2_OPERATIONS']; mem.files.set('scenario', JSON.stringify(scenario));
      bad([action, 'scenario', ...args.slice(1)], 'v2 표는 (다) 시나리오만');
    }
    bad(['v2-report', 'R0P', 'R1', 'R2', 'R3', 'R3'], '단계 중복·누락');
    bad(['v2-report', ...LEVELS_V2, '--r0'], '--r0 값');
    bad(['v2-report', ...LEVELS_V2, '--r0', 'R0', '--r0', 'R0'], '--r0은 한 번');
    bad(['v2-report', ...LEVELS_V2, '--unknown'], '알 수 없는 인수');
    expect(simMain(['v2-report', ...LEVELS_V2, '--r0', 'R0'], mem.io)).toBe(0);
  });
  it('2 6열 종류표 전체·키 순서·이름 조회', () => {
    expect(RISK_JUDGMENT_KINDS_V2).toEqual({
      J1: { R0: '기록', R0P: '판정', R1: '판정', R2: '판정', R3: '판정', R4: '판정' },
      J2: { R0: '기록', R0P: '진단', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '진단' },
      J3: { R0: '기록', R0P: '판정', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '판정' },
      'J4a~c': { R0: '기록', R0P: '판정', R1: '판정', R2: '판정', R3: '판정', R4: '판정' },
      J4d: { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '판정' },
      J5: { R0: '기록', R0P: '판정', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '판정' },
      J6: { R0: '기록', R0P: '판정', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '판정' },
      'J7(새 정의)': { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '판정' },
      L1: { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '판정' },
      J9: { R0: '기록', R0P: '해당 없음', R1: '판정', R2: '진단', R3: '진단', R4: '진단' },
      '진단 J8': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 L4': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 V': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 T': { R0: '기록', R0P: '해당 없음', R1: '해당 없음', R2: '진단', R3: '진단', R4: '진단' },
      '진단 C': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 F': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '해당 없음', R3: '진단', R4: '진단' },
      '진단 B': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 U': { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 M': { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
      '진단 거절': { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
    });
    expect(Object.keys(RISK_JUDGMENT_KINDS_V2)).toEqual(['J1', 'J2', 'J3', 'J4a~c', 'J4d', 'J5', 'J6', 'J7(새 정의)', ...riskKeys]);
    for (const key of ['J2b', 'J7(옛 정의)', 'L0', 'L3', 'D']) expect(RISK_JUDGMENT_KINDS_V2).not.toHaveProperty(key);
    expect(judgmentKindV2('J1', 'R0')).toBe('기록'); expect(judgmentKindV2('J1', 'R0P')).toBe('판정');
    expect(judgmentKindV2('J4d', 'R0P')).toBe('진단'); expect(judgmentKindV2('J4d', 'R4')).toBe('판정');
    expect(judgmentKindV2('J9', 'R0P')).toBe('해당 없음'); expect(judgmentKindV2('J9', 'R1')).toBe('판정');
    expect(judgmentRowV2('J1', 'R0P', true, '근거')).toBe('| J1 | 통과 | 근거 |');
    expect(judgmentRowV2('J1', 'R0P', false, '근거')).toBe('| J1 | 실패 | 근거 |');
    expect(judgmentRowV2('J1', 'R4', null, '근거')).toContain('실패 | 근거 부족: 근거');
    expect(judgmentRowV2('J1', 'R4', true, '근거', ['빠짐'])).toContain('실패 | 실행 없음: 빠짐');
    expect(judgmentRowV2('J3', 'R3', false, '계산 금지')).toBe('| J3 | 해당 없음 | — |');
  });
  it('3 문턱표 31개 이항 재계산과 최소 표본 9·10', () => {
    for (const [n, w, pass] of [[9, 9, false], [10, 9, true]] as const) {
      const o = fxFixture(n, w); expect(j9V2(get(o), get(o, 'TERM_GREEDY')).pass).toBe(pass);
    }
    const literal = [9, 9, 10, 10, 11, 12, 12, 13, 13, 14, 15, 15, 16, 16, 17, 18, 18, 19, 19, 20, 20, 21, 22, 22, 23, 23, 24, 24, 25, 26, 26];
    const calculated: Record<number, number> = {};
    for (let m = 10; m <= 40; m++) {
      const choose = [1n]; for (let i = 1; i <= m; i++) choose.push(choose[i - 1]! * BigInt(m - i + 1) / BigInt(i));
      calculated[m] = choose.findIndex((_, k) => 20n * choose.slice(k).reduce((s, n) => s + n, 0n) <= 2n ** BigInt(m));
    }
    expect(calculated).toEqual(SIGN_THRESHOLDS_V2); console.info('문턱 재계산', JSON.stringify(calculated));
    expect(SIGN_THRESHOLDS_V2).toEqual(Object.fromEntries(literal.map((k, i) => [i + 10, k])));

  });
  it('4 판정 경계 J3·J5·J4c 39·40시드와 J1·J6 실행 없음', () => {
    for (const n of [39, 40]) {
      const o = output('R4', n, d03PolicyIdsV2('R4'));
      for (const [fails, pass] of [[30, true], [29, false]] as const) {
        get(o, 'NO_FX').forEach((r, i) => { r.metrics.operations!.outcome = i < fails ? 'FAILED' : 'COMPLETED'; });
        expect(row(d03TablesV2(o), 'J4a~c')).toContain(pass ? '| 통과 |' : '| 실패 |');
      }
      const double = get(o, 'MAX_CONTRIBUTION~inv:SE~hire:2pt@22+3pt@36');
      for (const gains of [5, 6, 7]) {
        double.forEach((r, i) => { r.metrics.risk!.analysisValueMinor = 1200000 + (i < gains ? 1 : -1); });
        expect(row(d03TablesV2(o), 'J5')).toContain(20 * gains <= 3 * n ? '| 통과 |' : '| 실패 |');
      }
    }
    const o = output('R4', 40, d03PolicyIdsV2('R4'));
    for (const strongest of [33, 34]) {
      // 변형 둘이 나머지 시드를 나누고, TG·CA는 순위 후보 밖이다.
      for (const r of o.runs) {
        const i = r.seed - 2001, leader = i < strongest ? BASE : 'LATE_OK';
        r.metrics.risk!.analysisValueMinor = r.policyId === leader ? 2000000 : 1000000;
      }
      expect(row(d03TablesV2(o), 'J3')).toContain(strongest === 33 ? '| 통과 |' : '| 실패 |');
    }
    const reduced = output('R3');
    expect(row(d03TablesV2(reduced), 'J1')).toContain('| 통과 |');
    get(reduced)[0]!.metrics.operations!.unpaidAtEnd = [{ currency: 'KRW', amountMinor: 1 }];
    expect(row(d03TablesV2(reduced), 'J1')).toContain('| 실패 |');
    expect(row(d03TablesV2(output()), 'J6')).toContain('실행 없음:');
  }, 60000);
  it('4 J6 칸별 예측 4/5 경계와 순위 밖 고용 격자', () => {
    const o = output('R4', 10, d03PolicyIdsV2('R4'));
    const days = [8, 29, 30, 31, 50];
    for (const r of get(o)) r.metrics.operations!.bottlenecks = days.map((day) => ({ day, pt: 2, extraJobsPerWeek: 1, usableAfter: day, otherPtPerWeek: 0, storageDetail: { otherOccupancyLiters: 0, otherPeakLiters: 0, handlingDwellDays: 1, windowDays: 28 } }));
    for (const day of days) for (const r of get(o, `MAX_CONTRIBUTION~hire:2pt@${day}`)) r.metrics.risk!.analysisValueMinor = 1300000;
    for (const matches of [4, 3]) {
      for (const r of get(o)) r.metrics.operations!.bottlenecks.forEach((b, i) => { b.extraJobsPerWeek = i < matches ? 1 : 0.25; });
      const text = d03TablesV2(o);
      expect(row(text, 'J6')).toContain(matches === 4 ? '| 통과 | 4/5칸' : '| 실패 | 3/5칸');
      expect(text).toContain('처리 증가 실측은 같은 시드·수락·투자의 고용 없는 실행 대비');
      expect(text).toContain('보관 예측은 정상 상태의 리틀의 법칙 추정이다.');
    }
  });
  it('4 J7 최소 잔여 19·20과 L1 양끝 교차곱', () => {
    const o = output('R4', 40), base = get(o);
    base.forEach((r, i) => contracts(r, [contract(i < 19 ? 100 : -1)]));
    expect(newJ7V2(base)).toMatchObject({ pass: null, n: 19, excluded: 21 });
    expect(row(d03TablesV2(o), 'J7(새 정의)')).toContain('실패 | 근거 부족:');
    contracts(base[19]!, [contract(100)]); expect(newJ7V2(base)).toMatchObject({ pass: true, n: 20 });
    for (const [loss, total, pass] of [[1, 20, true], [1, 4, true], [1, 21, false], [2, 7, false]] as const) {
      expect(lossBandPasses(loss, total)).toBe(pass);
      const one = output('R4', 1); contracts(get(one)[0]!, Array.from({ length: total }, (_, i) => contract(i < loss ? -1 : 1)));
      expect(row(d03TablesV2(one), 'L1')).toContain(pass ? '| 통과 |' : '| 실패 |');
    }
  });
  it('4 J9 판매액 분모·동점 제거·40과 38 문턱', () => {
    for (const [w, ties, pass] of [[26, 0, true], [25, 0, false], [25, 2, true], [24, 2, false]] as const) {
      const o = fxFixture(40, w, ties), j = j9V2(get(o), get(o, 'TERM_GREEDY'));
      expect(j).toMatchObject({ pass, wins: w, ties, m: 40 - ties });
      expect(row(d03TablesV2(o), 'J9')).toContain(pass ? '| 통과 |' : '| 실패 |');
    }
    const o = fxFixture(10, 9, 1);
    contracts(get(o)[9]!, []); contracts(get(o, 'TERM_GREEDY')[9]!, [contract(1, 0, 0)]);
    expect(j9V2(get(o), get(o, 'TERM_GREEDY'))).toMatchObject({ ties: 1, m: 9, pass: false });
  });
  it('4 진단 J8·L4·V 부호·사분위·직접 무역 수·유동성 주석', () => {
    const o = output('R3', 5), tg = get(o, 'TERM_GREEDY'), ca = get(o, 'CREDIT_AWARE');
    const tv = [0, 200, -200, 400, 0], cv = [-400, 100, -200, 600, 800];
    tg.forEach((r, i) => { r.metrics.risk!.analysisValueMinor = 1200000 + tv[i]!; contracts(r, [contract(), contract()]); });
    ca.forEach((r, i) => { r.metrics.risk!.analysisValueMinor = 1200000 + cv[i]!; });
    expect(pairedValuesV2(get(o), tg)).toMatchObject({ positive: 2, negative: 1, ties: 2 });
    expect(pairedValuesV2(get(o), ca)).toMatchObject({ positive: 3, negative: 2, ties: 0 });
    expect(pairedValuesV2(tg, ca)).toEqual({ positive: 2, negative: 2, ties: 1, median: 0, q1: -250, q3: 500 });
    const text = d03TablesV2(o);
    expect(row(text, '진단 J8')).toContain('TERM_GREEDY > 기준 2, 같음 2, 작음 1');
    expect(row(text, '진단 L4')).toContain('CREDIT_AWARE > 기준 3, 같음 0, 작음 2');
    expect(row(text, '진단 J8')).toContain('TERM_GREEDY 직접 무역 합 10, 중앙 2.00; MAX_CONTRIBUTION 직접 무역 합 5, 중앙 1.00');
    expect(row(text, '진단 V')).toContain('중앙 0.00 USD, 사분위 -2.50 / 5.00 USD; 동점 1, 양수 2, 음수 2');
    for (const key of ['진단 J8', '진단 L4', '진단 V']) {
      expect(row(text, key)).toContain(LIQUIDITY_NOTE);
      expect(row(text, key).match(/H28-1/g)).toHaveLength(1);
    }
  });
  it('4 진단 C 대손·이자·동률 원인과 진단 M 원시값만', () => {
    const o = output('R4', 4), base = get(o), mb = get(o, 'MARGIN_BUFFER');
    const bad = contract(-100, -20); bad.components.default = -200;
    contracts(base[0]!, [bad, contract(100)]); contracts(mb[0]!, [contract(100)]);
    contracts(base[1]!, [contract(100)]); contracts(mb[1]!, [contract(-1), contract(100)]);
    contracts(base[2]!, [contract(-1)]); contracts(mb[2]!, [contract(-1)]);
    contracts(base[3]!, [contract(-2), contract(-3), contract(100)]); contracts(mb[3]!, [contract(-4), contract(100), contract(200)]);
    expect(causesV2([base[0]!])).toEqual({ default: 1 });
    expect(row(d03TablesV2(o), '진단 C')).toContain('"default":1');
    const raw = marginRawV2(base, mb); expect(raw).toMatchObject({ m: 3, wins: 2, a: { loss: 4, total: 7 }, b: { loss: 3, total: 7 } });
    const m = row(d03TablesV2(o), '진단 M');
    expect(m).toContain('MARGIN_BUFFER 손실 3/7, 기준 손실 4/7; 낮은 시드 2/3, MARGIN_BUFFER 직접 무역 계약 7건');
    expect(m).not.toMatch(/통과|실패|충족|문턱/);
    bad.components.default = 0; bad.components.carry = -200; expect(causesV2([base[0]!])).toEqual({ carry: 1 });
    bad.components.carry = -20; expect(causesV2([base[0]!])).toEqual({ fx: 1 });
  });
  it('5 J4d R0P의 M′·하한·같음·반 센트 중앙', () => {
    for (const [x, y, pass] of [[1300000, 1300000, true], [1300001, 1300000, false], [1069199, 1250000, false], [1069200, 1250000, true]] as const) {
      const os = five(39); get(os[0]!).forEach((r) => { r.metrics.risk!.analysisValueMinor = y; });
      get(os[4]!).forEach((r) => { r.metrics.risk!.analysisValueMinor = x; });
      expect(j4dV2(os[0]!, os[4]!).pass).toBe(pass); expect(row(v2Report(os), 'J4d')).toContain(pass ? '| 통과 |' : '| 실패 |');
      expect(row(d03TablesV2(os[4]!), 'J4d')).toContain('보류(v2-report에서 판정)');
    }
    const os = five(40);
    get(os[0]!).forEach((r) => { r.metrics.risk!.analysisValueMinor = 1300000; });
    get(os[4]!).forEach((r, i) => { r.metrics.risk!.analysisValueMinor = i < 20 ? 1300000 : 1300001; });
    expect(j4dV2(os[0]!, os[4]!).pass).toBe(false); expect(() => v2Report(os)).not.toThrow();
    get(os[0]!).forEach((r, i) => { r.metrics.risk!.analysisValueMinor = i < 20 ? 1300000 : 1300001; });
    expect(j4dV2(os[0]!, os[4]!).pass).toBe(true);
  });
  it('6 비교 바로 다음 층·메타 모든 키·기준 실행 누락', () => {
    for (const [a, b] of [['R0P', 'R1'], ['R1', 'R2'], ['R2', 'R3'], ['R3', 'R4']] as const) {
      const result = compareRiskV2(output(a), output(b)); expect(result.kind).toBe(b === 'R3' || b === 'R4' ? '판정' : '진단');
      const text = riskCompareTablesV2(output(a), output(b));
      expect(text.includes('J9 판본 1식')).toBe(a === 'R0P'); expect(text).not.toContain('(iii)');
      if (a === 'R0P') expect(text.indexOf('| J9 판본 1식')).toBeLessThan(text.indexOf('시드별 손실 수:'));
      expect(row(text, 'L2')).toContain(result.kind === '진단' ? '| 진단 |' : '| 실패 |');
      if (result.kind === '진단') expect(row(text, 'L2')).toContain('판정이었다면 실패');
    }
    for (const [a, b] of [['R1', 'R3'], ['R4', 'R3'], ['R1', 'R0P']] as const) expect(() => compareRiskV2(output(a), output(b))).toThrow('바로 다음');
    for (const key of ['profileId', 'tuningRound', 'marketRulesSha256'] as const) {
      const b = output('R4'); if (key === 'tuningRound') b.meta.risk![key]++; else b.meta.risk![key] = '다름';
      expect(() => compareRiskV2(output('R3'), b), key).toThrow(key);
    }
    for (const key of ['engineVersion', 'dataVersion', 'format', 'seeds'] as const) {
      const b = output('R4'); if (key === 'format') b.meta[key]++; else if (key === 'seeds') b.meta.seeds = [2091]; else b.meta[key] = '다름';
      expect(() => compareRiskV2(output('R3'), b), key).toThrow(key);
    }
    expect(() => compareRiskV2(r0(), output('R1'))).toThrow('rules-4');
    const missing = output('R4'); missing.runs = missing.runs.filter((r) => r.policyId !== BASE);
    expect(() => compareRiskV2(output('R3'), missing)).toThrow('실행 없음:');
    const tg = output('R1'); tg.runs = tg.runs.filter((r) => r.policyId !== 'TERM_GREEDY');
    expect(row(riskCompareTablesV2(output('R0P'), tg), 'J9 판본 1식')).toContain('실행 없음:');
    const reverse = output('R4'); reverse.meta.seeds.reverse(); expect(() => compareRiskV2(output('R3'), reverse)).not.toThrow();
  });
  it('6 L2 ② 21·19 대 20·20과 ① 정확히 1%p', () => {
    for (const up of [21, 20]) {
      const a = output('R3', 40), b = output('R4', 40);
      get(a).forEach((r, i) => contracts(r, [contract(i < up ? 100 : -100)]));
      get(b).forEach((r, i) => contracts(r, [contract(i < up ? -100 : 100)]));
      const result = compareRiskV2(a, b); expect(result).toMatchObject({ increase: up, decrease: 40 - up, count: up === 21 });
      expect(row(riskCompareTablesV2(a, b), 'L2 ②')).toContain(up === 21 ? '| 통과 |' : '| 실패 |');
    }
    for (const total of [100, 101]) {
      const a = output('R3', 1), b = output('R4', 1);
      contracts(get(a)[0]!, Array.from({ length: total }, () => contract(1)));
      contracts(get(b)[0]!, Array.from({ length: total }, (_, i) => contract(i ? 1 : -1)));
      expect(compareRiskV2(a, b).rate).toBe(total === 100);
    }
    // ①만 참: 손실 1/101 → 3/101(+약 1.98%p), 늘어남 1 = 줄어듦 1.
    // ②만 참: 손실 1/600 → 2/600(+약 0.17%p), 늘어남 2 > 줄어듦 1.
    const mixed = [
      { totals: [100, 1], before: [0, 1], after: [3, 0], rate: true, count: false, increase: 1 },
      { totals: [200, 200, 200], before: [0, 0, 1], after: [1, 1, 0], rate: false, count: true, increase: 2 },
    ];
    for (const fixture of mixed) {
      const a = output('R3', fixture.totals.length), b = output('R4', fixture.totals.length);
      get(a).forEach((r, i) => contracts(r, Array.from({ length: fixture.totals[i]! }, (_, j) => contract(j < fixture.before[i]! ? -1 : 1))));
      get(b).forEach((r, i) => contracts(r, Array.from({ length: fixture.totals[i]! }, (_, j) => contract(j < fixture.after[i]! ? -1 : 1))));
      expect(compareRiskV2(a, b)).toMatchObject({ rate: fixture.rate, count: fixture.count, pass: false,
        increase: fixture.increase, decrease: 1 });
      expect(row(riskCompareTablesV2(a, b), 'L2')).toContain('| 실패 |');
    }
  });
  it('7 보고 단계 중복·누락·순서·메타·R0 선택과 필터', () => {
    const os = five(), text = v2Report(os);
    expect(v2Report([os[3]!, os[0]!, os[4]!, os[1]!, os[2]!])).toBe(text);
    expect(() => v2Report(os.slice(1))).toThrow('다섯 단계');
    expect(() => v2Report([...os.slice(0, 4), os[3]!])).toThrow('단계 중복');
    const wrong = five(); wrong[2]!.meta.risk!.profileId = '다름'; expect(() => v2Report(wrong)).toThrow('profileId');
    const six = (t: string) => t.split('| 키 | R0 |')[1]!.split('R0 열은')[0]!;
    expect(six(text).match(/기록 없음/g)).toHaveLength(20);
    expect(row(six(text), 'J4d')).toBe('| J4d | 기록 없음 | 진단 | 진단 | 진단 | 진단 | 통과 |');
    const failed = five();
    get(failed[2]!)[0]!.metrics.operations!.unpaidAtEnd = [{ currency: 'KRW', amountMinor: 1 }];
    expect(row(six(v2Report(failed)), 'J1')).toBe('| J1 | 기록 없음 | 통과 | 통과 | 실패 | 통과 | 통과 |');
    const mixed = r0(); mixed.meta.scenarioIds.push('SCENARIO_M2_OPERATIONS');
    const alien = run(); alien.scenarioId = 'SCENARIO_M2_OPERATIONS'; alien.metrics.operations!.outcome = 'FAILED'; mixed.runs.push(alien);
    const report = v2Report(os, mixed, 'r0.json'), table = six(report);
    expect(table.match(/기록:/g)).toHaveLength(4); expect(table.match(/기록 없음/g)).toHaveLength(16);
    expect(row(table, 'J1')).toContain('기록: 실패 0/3, 끝 원화 미지급 0/3');
    expect(row(table, 'J4a~c')).toContain('기록: NO_FX 실패 0/3, 최대 묶음 9견적');
    expect(row(table, 'J7(새 정의)')).toContain('기록: 중앙 100.00%, 남은 시드 3');
    expect(row(table, 'L1')).toContain('기록: 손실 0/3');
    const mem = memoryIo(os);
    for (const bad of [r0(2), output('R4'), { ...r0(), meta: { ...r0().meta, risk: { ...r0().meta.risk!, level: 'R1' as const } } }, { ...r0(), meta: { ...r0().meta, lateMode: 'cap30' as const } }]) {
      mem.files.set('bad', JSON.stringify(bad)); expect(simMain(['v2-report', ...LEVELS_V2, '--r0', 'bad'], mem.io)).toBe(2);
    }
    const badSha = r0(); badSha.meta.risk!.marketRulesSha256 = 'b'.repeat(64); expect(() => v2Report(os, badSha)).toThrow('marketRulesSha256');
    const wrongScenario = r0(); wrongScenario.meta.scenarioIds = ['SCENARIO_M2_OPERATIONS']; expect(() => v2Report(os, wrongScenario)).toThrow('(다)');
    for (const level of LEVELS_V2) {
      const stage = report.split(`### ${level}\n`)[1]!.split('\n### ')[0]!;
      const standalone = d03TablesV2(os.find((o) => o.meta.risk!.level === level)!);
      for (const key of Object.keys(RISK_JUDGMENT_KINDS_V2)) if (key !== 'J4d' || level !== 'R4') expect(row(stage, key)).toBe(row(standalone, key));
    }
  });
  it('8 진단 U 정책 합·미결 차감·TG 날짜+한도 관문', () => {
    const o = output('R3', 2), tg = get(o, 'TERM_GREEDY');
    tg.forEach((r, i) => {
      contracts(r, Array.from({ length: i ? 6 : 4 }, () => contract()));
      Object.assign(r.metrics.risk!.credit!, { defaultsConfirmed: i + 1, badDebtMinor: 101 + i, defaultsUnconfirmed: i ? 0 : 2, unconfirmedMinor: 203 + i, carryMinor: 7 + i,
        limitBlocked: 1, termCounts: i ? { BASE: 1, D15: 2, D30: 3 } : { BASE: 1, D15: 1, D30: 2 },
        lateReceipts: 1, partialReceipts: 2, pendingPartialReceipts: 1, pendingOverdue: i ? 0 : 3, dateEligible: 4, dateLimitEligible: 2 });
    });
    expect(creditTotalsV2(tg)).toEqual({ defaultsConfirmed: 3, badDebtMinor: 203, defaultsUnconfirmed: 2, unconfirmedMinor: 407, carryMinor: 15, limitBlocked: 2,
      lateReceipts: 2, partialReceipts: 4, pendingPartialReceipts: 2, pendingOverdue: 3, dateEligible: 8, dateLimitEligible: 4, termCounts: { BASE: 2, D15: 3, D30: 5 }, direct: 10, pendingDelay: 1, datePercent: 80, dateLimitPercent: 40 });
    const text = d03TablesV2(o), u = text.split('### 진단 U 정책별')[1]!;
    expect(row(u, 'TERM_GREEDY')).toContain('| 3 | 203 | 2 | 407 | 15 | 2 | 2/3/5 | 2 | 4 | 2 | 3 | 8 | 4 | 10 | 1 | 80.00% | 40.00% |');
    expect(row(text, '진단 U')).toContain('TERM_GREEDY 날짜+한도 40.00%');
    expect(row(text, '진단 U')).toContain('31.5%');
    expect(row(text, '진단 U')).toContain('확정 0.44, 합 0.59');
    // ⑨ 진단 U 행 한 번 + 정책별 표 아래 요약 한 번 = 두 번.
    expect(text.match(/확정 0\.44, 합 0\.59/g)).toHaveLength(2);
    for (const s of ['USD 센트', 'v1 대비 지연·부분 수금 건수는 내지 않는다(H27-2 (b)).', '값을 직접 견주지 않는다(판정표 v2 2절).']) expect(text).toContain(s);
    tg[0]!.metrics.risk!.credit!.pendingOverdue = 0; expect(d03TablesV2(o)).toContain('-2 ⚠ 정의 확인');
  });
  it('9 진단 거절 합과 skippedNotOpen 분모 분리', () => {
    const o = output('R3', 2), tg = get(o, 'TERM_GREEDY');
    Object.assign(tg[0]!.metrics.operations!.rejectionsV2!, { candidate: { funds: 1, storage: 0, handling: 1, sailing: 0, staff: 0, onTime: 0, credit: 1 }, pair: 2, quote: 3, skippedNotOpen: 1 });
    Object.assign(tg[1]!.metrics.operations!.rejectionsV2!, { candidate: { funds: 0, storage: 0, handling: 0, sailing: 0, staff: 0, onTime: 0, credit: 2 }, pair: 4, quote: 5, skippedNotOpen: 2 });
    expect(rejectionTotalsV2(tg)).toEqual({ candidate: { funds: 1, storage: 0, handling: 1, sailing: 0, staff: 0, onTime: 0, credit: 3 }, total: 5, pair: 6, quote: 8, skippedNotOpen: 3 });
    const text = d03TablesV2(o);
    expect(row(text.split('### 진단 거절 정책별')[1]!, 'TERM_GREEDY')).toBe('| TERM_GREEDY | 1 | 0 | 1 | 0 | 0 | 0 | 3 | 5 | 6 | 8 | 3 |');
    expect(row(text, '진단 거절')).toContain('TERM_GREEDY credit 3, 짝 6, 견적 8');
    expect(text).toContain('후보 단위·OPEN 아님 건너뜀은 운송 주선 후보를 포함하고, 짝·견적은 직접 무역만 센다. 단위끼리 더하거나 나누지 않는다.');
  });
  it('10 단계 표 구성·R3 축소·순서·J3 TG와 CA 제외', () => {
    // R1에서 해당 없는 T의 onTime 값을 읽으면 실패하게 한다.
    const r1 = output('R1');
    for (const r of r1.runs) for (const c of r.metrics.risk!.contracts) Object.defineProperty(c, 'onTime', { get() { throw new Error('해당 없음 진단 T 계산'); } });
    expect(() => d03TablesV2(r1)).not.toThrow();
    const r0p = output('R0P');
    for (const r of get(r0p, 'TERM_GREEDY')) for (const c of r.metrics.risk!.contracts) Object.defineProperty(c, 'saleKrwAtAcceptMinor', { get() { throw new Error('해당 없음 J9 계산'); } });
    expect(() => d03TablesV2(r0p)).not.toThrow();
    for (const level of ['R3', 'R4'] as const) {
      const o = output(level), text = d03TablesV2(o);
      expect(text.startsWith(`# D03 v2 단계 표 (${level})`)).toBe(true);
      for (const title of ['② 투자만', '③ 고용 표(보통)', '④ 고용 표(적극)', 'J6 칸별 병목 예측', '⑥ 시드별 1위 정책 분포와 가장 강한 정책', '⑦ 사업별 기여이익 비중 (USD 몫만·진단)', '⑧ 계획 고용일과 실제 고용일이 다른 실행 수', '진단·조사 선행 비교']) {
        expect(text.split(title)[1]!.trimStart().startsWith('해당 없음(축소 묶음)')).toBe(level === 'R3');
      }
      for (const forbidden of ['J2b', 'J7(옛 정의)', '| L0 ', '| L3 ', '| D ', '(iii)', '변형 사이']) expect(text).not.toContain(forbidden);
      const risk = text.split('## ⑨ 위험 판정')[1]!;
      expect(risk.split('\n').filter((s) => /^\| (L1|J9|진단 )/.test(s)).slice(0, 12).map((s) => s.split(' | ')[0]!.slice(2))).toEqual(riskKeys);
    }
    for (const excluded of ['TERM_GREEDY', 'CREDIT_AWARE']) {
      const o = output('R4', 40, d03PolicyIdsV2('R4'));
      for (const r of o.runs) r.metrics.risk!.analysisValueMinor = r.policyId === excluded ? 2000000 : 1200000;
      const j = row(d03TablesV2(o), 'J3'); expect(j).not.toContain(`가장 강한 ${excluded}`); expect(j).toContain('가장 강한 LATE_OK');
    }
  }, 60000);
  it('11 실제 R4 실행에서 단계 표·12행·조건 합계 스모크', () => {
    const mem = memoryIo(), path = 'smoke.json';
    expect(simMain(['d03', '--risk-v2', 'R4', '--policies', 'MAX_CONTRIBUTION,TERM_GREEDY,CREDIT_AWARE,MARGIN_BUFFER', '--seed-base', '2001', '--seeds', '2', '--out', path], mem.io), mem.stderr.join('')).toBe(0);
    expect(simMain(['v2-tables', path], mem.io), mem.stderr.join('')).toBe(0);
    const text = mem.stdout.at(-1)!;
    for (const key of riskKeys) expect(row(text, key), key).toBeTruthy();
    const u = text.split('### 진단 U 정책별')[1]!.split('### 진단 거절')[0]!;
    let terms = 0, direct = 0;
    for (const id of [BASE, 'TERM_GREEDY', 'CREDIT_AWARE', 'MARGIN_BUFFER']) {
      const fields = row(u, id).split(' | '); const sum = fields[7]!.split('/').reduce((s, n) => s + Number(n), 0);
      expect(sum).toBe(Number(fields[14])); terms += sum; direct += Number(fields[14]);
    }
    expect(terms).toBeGreaterThan(0); expect(terms).toBe(direct);
  }, 60000);
  it('12 v1 표·비교의 rules 거절 유지', () => {
    expect(() => d03Tables(output())).toThrow('v1 표'); expect(() => riskTables(output())).toThrow('v1 표');
    expect(() => riskCompareTables(output('R1'), output('R2'))).toThrow('v1 risk-compare');
  });
});
function fxFixture(n: number, wins: number, ties = 0) {
  const o = output('R1', n), base = get(o), tg = get(o, 'TERM_GREEDY');
  base.forEach((r, i) => {
    // TG 절대 성분은 작아도 판매액 비율은 더 크다. 분모 1 변형은 승패를 뒤집는다.
    contracts(r, [contract(100, -20, 1000)]);
    contracts(tg[i]!, [contract(100, i < wins ? -10 : i >= n - ties ? -4 : -2, 200)]);
  });
  return o;
}
