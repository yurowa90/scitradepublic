import { beforeAll, describe, expect, it } from 'vitest';
import { loadScenario } from '../../content/scenario';
import { drawUniform } from '../rng';
import { simMain, USAGE, type SimIo } from './cli';
import { policyById } from './policies';
import { simConfigV2, type RiskContract, type RiskLevelV2 } from './risk-metrics';
import { j4dV2, LEVELS_V2, RISK_JUDGMENT_KINDS_V2, stageEvidence, type JudgmentKindV2 } from './risk-tables-v2';
import { d03TablesV3, fundsV3, fxDelayV3, j10V3, judgmentKindV3, judgmentRowV3, RISK_JUDGMENT_KINDS_V3,
  stageV3, v3Report, type FractionV3, type JudgmentKeyV3 } from './risk-tables-v3';
import { simulate, SIM_FORMAT, type SimOutput, type SimRun } from './sim';

const SCENARIO = 'SCENARIO_M2_OPS_COS_LAVER', BASE = 'MAX_CONTRIBUTION', TG = 'TERM_GREEDY', SHA = 'a'.repeat(64);
let template: SimRun, contractTemplate: RiskContract, meta: SimOutput['meta'];
beforeAll(() => {
  const actual = simulate(simConfigV2(loadScenario(SCENARIO), 'R4', 'RISK_PROFILE_V2'), policyById(BASE)!, 2001, undefined, 'R4');
  template = structuredClone(actual.run);
  contractTemplate = structuredClone(template.metrics.risk!.contracts.find((c) => c.kind === 'DIRECT_TRADE')!);
  const o = template.metrics.operations!;
  o.utilization = []; o.bottlenecks = []; o.actualHires = []; o.unpaidAtEnd = []; o.outcome = 'COMPLETED';
  template.metrics.risk!.contracts = [];
  meta = { tool: 'scitrade-sim', format: SIM_FORMAT, engineVersion: actual.state.meta.engineVersion, dataVersion: actual.state.meta.dataVersion,
    scenarioIds: [SCENARIO], policyIds: [BASE, TG], seeds: [2001], lateMode: 'base',
    risk: { rules: 'M2a-rules-4', level: 'R4', profileId: 'RISK_PROFILE_V2', tuningRound: 1, marketRulesSha256: SHA } };
}, 60000);
function run(id: string, seed: number, count: number): SimRun {
  const r = structuredClone(template); r.policyId = id; r.seed = seed; r.metrics.risk!.directAccepted = count;
  r.metrics.risk!.analysisValueMinor = 1234567;
  r.metrics.operations!.rejectionsV2 = { candidate: { funds: 1, storage: 2, handling: 3, sailing: 4, staff: 5, onTime: 6, credit: 7 }, pair: 0, quote: 0, skippedNotOpen: 10000 };
  return r;
}
function output(level: RiskLevelV2 = 'R4', n = 12, decreases = 10, ties = 0, start = 2001): SimOutput {
  const m = structuredClone(meta); m.risk!.level = level; m.seeds = Array.from({ length: n }, (_, i) => start + i);
  return { meta: m, runs: m.seeds.flatMap((s, i) => [run(BASE, s, 20 + i), run(TG, s, i < decreases ? 7 + i : i < decreases + ties ? 20 + i : 27 + i)]) };
}
const get = (o: SimOutput, id = BASE) => o.runs.filter((r) => r.policyId === id);
function five(start = 2001) { return LEVELS_V2.map((l) => output(l, 12, 10, 0, start)); }
function r0(start = 2001) {
  const o = output('R0P', 12, 10, 0, start); o.meta.risk = { level: 'R0', profileId: 'RISK_PROFILE_DEFAULT', tuningRound: 1, marketRulesSha256: SHA }; return o;
}
function memoryIo(base = five(), oos?: SimOutput[]) {
  const files = new Map<string, string>();
  base.forEach((o, i) => files.set(`b${i}`, JSON.stringify(o)));
  oos?.forEach((o, i) => files.set(`o${i}`, JSON.stringify(o)));
  files.set('br0', JSON.stringify(r0())); files.set('or0', JSON.stringify(r0(2101)));
  const stdout: string[] = [], stderr: string[] = [];
  const io: SimIo = { readText: (p) => files.get(p)!, writeText: (p, s) => { files.set(p, s); }, out: (s) => { stdout.push(s); }, err: (s) => { stderr.push(s); }, now: () => 0, marketRulesSha256: () => SHA };
  return { io, files, stdout, stderr };
}
const baseArgs = ['v3-report', '--base', 'b0,b1,b2,b3,b4'];
const bothArgs = [...baseArgs, '--oos', 'o0,o1,o2,o3,o4'];
const row = (text: string, key: string) => text.split('\n').find((l) => l.startsWith(`| ${key} |`))!;
const section = (text: string, title: string) => text.split(title + '\n')[1]!.split(/\n#{2,3} /)[0]!;
const cross = (a: FractionV3, b: FractionV3) => a.num * b.den - b.num * a.den;
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

describe('TASK-0071 판정표 v3', () => {
  it('1 CLI 도움말 전문·입력 검사·sha 우선순위·종료 0과 3', () => {
    expect(USAGE).toBe(EXPECTED_USAGE);
    const mem = memoryIo(five(), five(2101));
    const bad = (args: string[], message: string, io = mem.io) => {
      expect(simMain(args, io), args.join(' ')).toBe(2);
      expect(mem.stderr.at(-1)).toContain(`비교 실행기 오류: ${message}`);
      expect(mem.stderr.at(-1)!.endsWith(USAGE)).toBe(true);
    };
    expect(simMain(['help'], mem.io)).toBe(0); expect(mem.stdout.at(-1)).toBe(EXPECTED_USAGE);
    expect(simMain(['v3-tables', 'b4'], mem.io)).toBe(0);
    expect(simMain([...bothArgs, '--base-r0', 'br0', '--oos-r0', 'or0'], mem.io), mem.stderr.join('')).toBe(0);
    expect(simMain(['v3-report', '--base', 'b4,b2,b0,b3,b1'], mem.io)).toBe(0);
    bad(['v3-report'], '--base가 필요합니다.');
    bad(['v3-report', '--base', 'b0,b1'], '다섯 단계 출력');
    bad(['v3-report', '--base', 'b0,b1,b2,b3,b3'], '단계 중복·누락');
    bad(['v3-tables'], 'v3 출력 파일 1개');
    bad(['v3-tables', 'b4', 'b3'], 'v3 출력 파일 1개');
    bad([...baseArgs, '--oos-r0', 'or0'], '--oos-r0은 --oos가 필요합니다.');
    bad([...baseArgs, '--unknown', 'x'], '잘못된 v3-report 인수');
    bad([...baseArgs, '--oos'], '잘못된 v3-report 인수');
    for (const key of ['--base', '--oos', '--base-r0', '--oos-r0']) {
      const value = key.includes('r0') ? 'br0' : 'b0,b1,b2,b3,b4';
      bad([...baseArgs, ...(key === '--base' ? [] : [key, value]), key, value], '잘못된 v3-report 인수');
    }
    for (const key of ['profileId', 'tuningRound', 'marketRulesSha256', 'engineVersion', 'dataVersion', 'format', 'lateMode', 'scenarioIds']) {
      const changed = five(2101);
      for (const o of changed) {
        if (key === 'profileId') o.meta.risk!.profileId = 'RISK_PROFILE_DEFAULT';
        else if (key === 'tuningRound') o.meta.risk!.tuningRound = 2;
        else if (key === 'marketRulesSha256') o.meta.risk!.marketRulesSha256 = 'b'.repeat(64);
        else if (key === 'lateMode') o.meta.lateMode = 'cap30';
        else if (key === 'scenarioIds') o.meta.scenarioIds = ['SCENARIO_M2_OPERATIONS'];
        else Object.assign(o.meta, { [key]: '다름' });
      }
      changed.forEach((o, i) => mem.files.set(`o${i}`, JSON.stringify(o)));
      const message = key === 'marketRulesSha256' ? 'v3 표는 현재 자료와 같은 sha의 출력만 받습니다.'
        : key === 'format' ? '비교 실행기 출력 형식이 아닙니다:' : key === 'lateMode' ? 'v2 표는 lateMode base만 받습니다.'
        : key === 'scenarioIds' ? 'v2 표는 (다) 시나리오만 받습니다.' : `다른 메타: ${key}`;
      bad(bothArgs, message);
    }
    five(2101).forEach((o, i) => mem.files.set(`o${i}`, JSON.stringify(o)));
    const changed = output('R2'); changed.meta.risk!.tuningRound = 2;
    mem.files.set('b2', JSON.stringify(changed)); bad(baseArgs, '다른 메타: tuningRound');
    mem.files.set('b2', JSON.stringify(output('R2')));
    five().forEach((o, i) => mem.files.set(`o${i}`, JSON.stringify(o)));
    bad(bothArgs, '기준·표본 밖 시드 집합이 겹칩니다.');
    five(2101).forEach((o, i) => mem.files.set(`o${i}`, JSON.stringify(o)));
    bad(['v3-tables', 'br0'], 'v2 명령은 rules-4 출력만 받습니다.');
    bad(['v3-report', '--base', 'br0,b1,b2,b3,b4'], 'v2 명령은 rules-4 출력만 받습니다.');
    for (const args of [['v3-tables', 'b4'], baseArgs]) bad(args, 'v3 표는 현재 자료 sha 검사 함수가 필요합니다.', { ...mem.io, marketRulesSha256: undefined });
    for (const path of ['b4', 'br0', 'or0']) {
      const original = mem.files.get(path)!;
      const o = JSON.parse(original) as SimOutput; o.meta.risk!.marketRulesSha256 = 'b'.repeat(64); mem.files.set(path, JSON.stringify(o));
      bad([...bothArgs, '--base-r0', 'br0', '--oos-r0', 'or0'], 'v3 표는 현재 자료와 같은 sha의 출력만 받습니다.');
      if (path === 'b4') bad(['v3-tables', path], 'v3 표는 현재 자료와 같은 sha의 출력만 받습니다.');
      mem.files.set(path, original);
    }
    const invalidR0 = r0(); invalidR0.meta.seeds = [2301]; mem.files.set('bad-r0', JSON.stringify(invalidR0));
    bad([...baseArgs, '--base-r0', 'bad-r0'], '다른 --r0 메타: seeds');
    bad([...bothArgs, '--oos-r0', 'br0'], '다른 --r0 메타: seeds');
    for (const [key, value, message] of [['lateMode', 'cap30', 'v2 표는 lateMode base만 받습니다.'], ['scenarioIds', ['SCENARIO_M2_OPERATIONS'], '--r0에 (다) 시나리오가 필요합니다.']] as const) {
      const o = r0(); Object.assign(o.meta, { [key]: value }); mem.files.set('bad-r0', JSON.stringify(o));
      bad([...baseArgs, '--base-r0', 'bad-r0'], message);
    }
    const otherSeeds = output('R2'); otherSeeds.meta.seeds = [2301]; mem.files.set('b2', JSON.stringify(otherSeeds));
    bad(baseArgs, '다른 메타: seeds'); mem.files.set('b2', JSON.stringify(output('R2')));
    bad([...baseArgs, '--base-r0', 'b0'], '--r0은 rules 키가 없는 v1 R0 출력이어야 합니다.');
    for (const [key, value, message] of [['lateMode', 'cap30', 'v2 표는 lateMode base만 받습니다.'], ['scenarioIds', ['SCENARIO_M2_OPERATIONS'], 'v2 표는 (다) 시나리오만 받습니다.']] as const) {
      const o = output(); Object.assign(o.meta, { [key]: value }); mem.files.set('bad', JSON.stringify(o));
      bad(['v3-tables', 'bad'], message);
    }
    const failed = output(); get(failed)[0]!.metrics.operations!.outcome = 'FAILED'; mem.files.set('b4', JSON.stringify(failed));
    expect(simMain(['v3-tables', 'b4'], mem.io)).toBe(3); expect(simMain(baseArgs, mem.io)).toBe(3);
  });
  it('2 종류표 리터럴 전체·키 순서·이름 조회와 v2 형 불변', () => {
    expect(RISK_JUDGMENT_KINDS_V3).toEqual({
  J1: { R0: '기록', R0P: '관문', R1: '관문', R2: '관문', R3: '관문', R4: '관문' },
  J2: { R0: '기록', R0P: '진단', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '진단' },
  J3: { R0: '기록', R0P: '재현 기록', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '재현 기록' },
  'J4a~c': { R0: '기록', R0P: '재현 기록', R1: '재현 기록', R2: '재현 기록', R3: '재현 기록', R4: '재현 기록' },
  J4d: { R0: '기록', R0P: '재현 기록', R1: '재현 기록', R2: '재현 기록', R3: '재현 기록', R4: '재현 기록' },
  J5: { R0: '기록', R0P: '재현 기록', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '재현 기록' },
  J6: { R0: '기록', R0P: '재현 기록', R1: '해당 없음', R2: '해당 없음', R3: '해당 없음', R4: '재현 기록' },
  'J7(새 정의)': { R0: '기록', R0P: '재현 기록', R1: '재현 기록', R2: '재현 기록', R3: '재현 기록', R4: '재현 기록' },
  L1: { R0: '기록', R0P: '재현 기록', R1: '재현 기록', R2: '재현 기록', R3: '재현 기록', R4: '재현 기록' },
  J9: { R0: '기록', R0P: '해당 없음', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
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
  J10: { R0: '기록', R0P: '판정', R1: '진단', R2: '진단', R3: '진단', R4: '판정' },
  '진단 J10②': { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
  '진단 X': { R0: '기록', R0P: '진단', R1: '진단', R2: '진단', R3: '진단', R4: '진단' },
});
    const unchanged: Record<string, Record<'R0' | RiskLevelV2, JudgmentKindV2>> = RISK_JUDGMENT_KINDS_V2;
    expect(unchanged).toEqual({
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
    expect(Object.keys(RISK_JUDGMENT_KINDS_V3)).toEqual(['J1', 'J2', 'J3', 'J4a~c', 'J4d', 'J5', 'J6', 'J7(새 정의)', 'L1', 'J9', '진단 J8', '진단 L4', '진단 V', '진단 T', '진단 C', '진단 F', '진단 B', '진단 U', '진단 M', '진단 거절', 'J10', '진단 J10②', '진단 X']);
    for (const [k, l, expected] of [['J1', 'R0P', '관문'], ['J10', 'R0P', '판정'], ['J10', 'R2', '진단'], ['J3', 'R1', '해당 없음'], ['J3', 'R4', '재현 기록'], ['J9', 'R1', '진단']] as const) expect(judgmentKindV3(k, l)).toBe(expected);
    expect(judgmentRowV3('J10', 'R4', null, '근거')).toBe('| J10 | 실패 | 근거 부족: 근거 |');
    expect(judgmentRowV3('J3', 'R1', false, '무시')).toBe('| J3 | 해당 없음 | — |');
  });
  it('3 J10 동점 제외·문턱 경계 m 9·10·38·39·40', () => {
    for (const [n, d, ties, threshold, pass] of [[40, 26, 0, 26, true], [40, 25, 0, 26, false], [40, 25, 2, 25, true], [40, 24, 2, 25, false],
      [9, 9, 0, undefined, false], [12, 9, 2, 9, true], [12, 8, 2, 9, false], [39, 26, 0, 26, true], [39, 25, 0, 26, false]] as const) {
      const o = output('R4', n, d, ties), j = j10V3(get(o), get(o, TG));
      expect(j, `${n}/${d}/${ties}`).toMatchObject({ decrease: d, increase: n - d - ties, ties, m: n - ties, threshold, pass });
    }
  });
  it('3 J10 시드 짝·짝수 중앙 비·섞은 TG와 가운데 누락·기준 누락', () => {
    const o = output('R4', 12, 12); o.runs = [...get(o), ...get(o, TG).reverse()];
    expect(stageV3(o).rows.J10.evidence).toBe('감소 12/12 (문턱 10, 동점 0); 직접 무역 합 TG 150 대 기준 306(비 0.490), 시드 중앙 12.50 대 25.50(비 0.490)');
    o.runs = o.runs.filter((r) => r.policyId !== TG || r.seed !== 2006);
    expect(stageV3(o).rows.J10.evidence).toBe('감소 11/11 (문턱 9, 동점 0); 직접 무역 합 TG 138 대 기준 281(비 0.491), 시드 중앙 13.00 대 26.00(비 0.500)');
    expect(row(d03TablesV3(o), 'J10')).toContain('| 실패 | 실행 없음: SCENARIO_M2_OPS_COS_LAVER/TERM_GREEDY/2006;');
    const b = output('R4', 12, 12); b.runs = b.runs.filter((r) => r.policyId !== BASE || r.seed !== 2006);
    expect(row(d03TablesV3(b), 'J10')).toContain('| 실패 | 실행 없음: SCENARIO_M2_OPS_COS_LAVER/MAX_CONTRIBUTION/2006;');
    // J1은 지시서의 v2 pass === true 규칙 그대로이며 누락 짝은 J10에서 실패한다.
    expect(stageEvidence(b).rows.J1.pass).toBe(true); expect(stageV3(b).gateFailed).toBe(false);
    expect(row(d03TablesV3(b), 'J1')).toContain('| 통과 | 실행 없음:');
    const missing = memoryIo([b]); expect(simMain(['v3-tables', 'b0'], missing.io)).toBe(0);
    const zero = output('R4', 12, 12); get(zero).forEach((r) => { r.metrics.risk!.directAccepted = 0; });
    expect(stageV3(zero).rows.J10.evidence).toContain('(비 —), 시드 중앙');
    expect(stageV3(zero).rows.J10.evidence.endsWith('(비 —)')).toBe(true);
  });
  it('4 자금 거절 부호·일곱 사유 비중·진단 문구', () => {
    const o = output('R4', 12);
    get(o, TG).forEach((r, i) => { r.metrics.operations!.rejectionsV2!.candidate.funds = i < 9 ? 5 : i < 11 ? 1 : 0; });
    expect(fundsV3(get(o), get(o, TG))).toEqual({ increase: 9, decrease: 1, ties: 2, m: 10, threshold: 9,
      sumTg: 47, sumBase: 12, percentTg: 47 * 100 / 371, percentBase: 12 * 100 / 336 });
    const line = row(d03TablesV3(o), '진단 J10②');
    expect(line).toBe('| 진단 J10② | 진단 | 증가 9/10 (문턱 9, 동점 2); funds 합 TG 47 대 기준 12(비 3.917); funds ÷ 후보 합 TG 12.67% · 기준 3.57% |');
    expect(line).not.toMatch(/통과|실패/);
    expect(d03TablesV3(o)).toContain('자금 거절은 기본 분류이고 후보마다 마지막 사유만 남으며, 거래 감소와 기계적으로 연동된다. J10과 독립된 증거가 아니다(판정표 v3 3.2).');
  });
  it('5 진단 X R0P 영·R4 독립 환율 오라클·lastDay/E 잘림·분모 0·짝수 중앙', () => {
    const o = output('R4', 3, 3), base = get(o);
    base[0]!.metrics.risk!.contracts = [contract(41, 90, 10003, 100003), contract(55, 90, 20007, 200007),
      contract(82, 90, 30011, 300011), contract(30, 43, 40009, 400009)];
    base[1]!.metrics.risk!.contracts = [contract(12, 90, 7109, 220013)];
    base[2]!.metrics.risk!.contracts = [];
    for (const x of fxDelayV3(o)) {
      expect(x).toMatchObject({ contracts: 5, clipped: x.d === 15 ? 2 : 3, zero: 1, excluded: 1 });
      const expected = base.slice(0, 2).map((r) => ({ num: r.metrics.risk!.contracts.reduce((s, c) => s + oracleX(c, r.seed, x.d), 0n),
        den: r.metrics.risk!.contracts.reduce((s, c) => s + BigInt(c.saleKrwAtAcceptMinor!), 0n) }));
      expect(x.ratios.map(({ num, den }) => ({ num, den }))).toEqual(expected);
      const [a, b] = [...expected].sort((a, b) => cross(a, b) < 0n ? -1 : 1) as [FractionV3, FractionV3];
      expect(cross(x.median!, { num: a.num * b.den + b.num * a.den, den: 2n * a.den * b.den })).toBe(0n);
      expect(x.q1).toMatchObject(a); expect(x.q3).toMatchObject(b); expect(cross(a, b)).not.toBe(0n);
    }
    const early = base[0]!.metrics.risk!.contracts[3]!;
    expect(oracleX(early, 2001, 30)).not.toBe(oracleX({ ...early, evaluationDay: 90 }, 2001, 30));
    const r0p = structuredClone(o); r0p.meta.risk!.level = 'R0P';
    for (const x of fxDelayV3(r0p)) { expect(x.ratios.every((r) => r.num === 0n)).toBe(true); expect(x.excluded).toBe(1); }
    expect(stageV3(r0p).rows['진단 X'].evidence).toContain('중앙 0.000%');
    const empty = output('R4', 1); expect(fxDelayV3(empty)[0]).toMatchObject({ excluded: 1, median: null, q1: null, q3: null });
  });
  it('5 진단 X double 동률의 반대 입력 순서·홀수 유리수 중앙과 사분위', () => {
    const o = output('R4', 3, 3);
    // 세 분수는 double로 같지만 참 순서는 두 번째 < 세 번째 < 첫 번째다.
    for (const [i, r] of get(o).entries()) {
      const c = contract(41, 90, 101, 0), n = oracleX(c, r.seed, 15);
      expect(n).toBeGreaterThan(0n);
      let den = n * 10000000000000000n + [-1n, 1n, 0n][i]!;
      const cs = [c];
      while (den > 0n) {
        const part = den > 1000000000000000n ? 1000000000000000n : den;
        cs.push(contract(82, 90, 0, Number(part))); den -= part;
      }
      r.metrics.risk!.contracts = cs;
    }
    const x = fxDelayV3(o)[0]!, a = x.ratios[0]!, b = x.ratios[1]!, c = x.ratios[2]!;
    expect(Number(a.num) / Number(a.den)).toBe(Number(b.num) / Number(b.den));
    expect(cross(b, c)).toBeLessThan(0n); expect(cross(c, a)).toBeLessThan(0n);
    expect(cross(x.median!, c)).toBe(0n); expect(cross(x.q1!, b)).toBe(0n); expect(cross(x.q3!, a)).toBe(0n);
  });
  it('6 J1 묶음 보류·네 검정 최종 우선순위·단계 표와 종료 3', () => {
    const base = five(), oos = five(2101); get(base[2]!)[0]!.metrics.operations!.outcome = 'FAILED';
    for (const outside of [oos, undefined, oos.map((o) => output(o.meta.risk!.level as RiskLevelV2, 12, 0, 0, 2101))]) {
      const text = v3Report(base, outside);
      expect(text).toContain('**멈춤: J1 관문 실패(기준 R2). 판정표 v3 3.5에 따라 측정을 멈추고 원인을 보고한다.**');
      expect(text.indexOf('**멈춤:')).toBeLessThan(text.indexOf('## J1 관문'));
      expect(section(text, '## J10 최종(판정표 v3 4절: 네 검정 모두 통과)')).toContain('| R0P | 판정 보류 |');
      expect(section(text, '## J10 최종(판정표 v3 4절: 네 검정 모두 통과)')).toContain('| R4 | 판정 보류 |');
      expect(section(text, '## J10 최종(판정표 v3 4절: 네 검정 모두 통과)')).toContain('| 최종 | 판정 보류 |');
      expect(row(section(text, '## 6열 표(기준)'), 'J10')).toBe('| J10 | 기록 없음 | 판정 보류 | 진단 | 진단 | 진단 | 판정 보류 |');
      expect(row(section(text, '## 6열 표(기준)'), 'J1')).toBe('| J1 | 기록 없음 | 통과 | 통과 | 실패 | 통과 | 통과 |');
      if (outside) expect(row(section(text, '## 6열 표(표본 밖 1)'), 'J10')).not.toContain('판정 보류');
      const mem = memoryIo(base, outside); expect(simMain(outside ? bothArgs : baseArgs, mem.io)).toBe(3);
    }
    const failed = output('R4'); get(failed)[0]!.metrics.operations!.outcome = 'FAILED';
    const mem = memoryIo([failed]); expect(simMain(['v3-tables', 'b0'], mem.io)).toBe(3);
    const text = mem.stdout.at(-1)!;
    expect(row(text, 'J10')).toContain('| 판정 보류 |'); expect(row(text, 'J1')).toContain('| 실패 |');
    expect(text).toContain('**멈춤: J1 관문 실패(R4).'); expect(text.indexOf('**멈춤:')).toBeLessThan(text.indexOf('## 판정·관문·진단'));
    get(oos[1]!)[0]!.metrics.operations!.unpaidAtEnd = [{ currency: 'KRW', amountMinor: 1 }];
    expect(v3Report(base, oos)).toContain('J1 관문 실패(기준 R2, 표본 밖 1 R1)');
  });
  it('7 재현 기록 결과·v2 근거 보존·J4d 묶음별 M′·R0 기록', () => {
    const base = five(), oos = five(2101);
    get(base[0]!).forEach((r) => { r.metrics.risk!.analysisValueMinor = 1700123; });
    get(oos[0]!).forEach((r) => { r.metrics.risk!.analysisValueMinor = 2100457; });
    get(oos[4]!).forEach((r) => { r.metrics.risk!.analysisValueMinor = 1300789; });
    const keys = ['J3', 'J4a~c', 'J4d', 'J5', 'J6', 'J7(새 정의)', 'L1'] as const;
    const text = v3Report(base, oos, { base: r0(), oos: r0(2101), basePath: 'br0', oosPath: 'or0' });
    expect(text).toContain('R0 입력: br0'); expect(text).toContain('R0 입력: or0');
    for (const [label, bundle] of [['기준', base], ['표본 밖 1', oos]] as const) {
      const single = d03TablesV3(bundle[4]!); expect(single).not.toContain('보류');
      for (const key of keys) {
        const e = stageEvidence(bundle[4]!).rows[key];
        expect(row(single, key).split(' | ')[1]).toBe('기록');
        expect(row(single, key)).toContain(e.evidence);
        expect(row(section(text, `## 6열 표(${label})`), key).split('|').map((s) => s.trim()).slice(2, -1)).not.toContain('통과');
        expect(row(section(text, `## 6열 표(${label})`), key).split('|').map((s) => s.trim()).slice(2, -1)).not.toContain('실패');
        expect(row(section(text, `## 6열 표(${label})`), key).split('|').map((s) => s.trim()).at(-2)).toBe('기록');
      }
      expect(row(single, 'J4d')).toBe(`| J4d | 기록 | ${stageEvidence(bundle[4]!).rows.J4d.evidence}; M′는 v3-report에서 |`);
      expect(row(section(text, `### ${label} R4`), 'J4d')).toBe(`| J4d | 기록 | ${j4dV2(bundle[0]!, bundle[4]!).evidence} |`);
      for (const key of ['J10', '진단 J10②', '진단 X']) expect(row(section(text, `## 6열 표(${label})`), key)).toContain('| 기록 없음 |');
    }
    expect(j4dV2(base[0]!, base[4]!).evidence).not.toBe(j4dV2(oos[0]!, oos[4]!).evidence);
    expect(row(section(text, '## 6열 표(기준)'), 'J1')).toContain('기록: 실패 0/12, 끝 원화 미지급 0/12');
  });
  it('8 J9 R1은 진단이고 v2 근거 문자열 그대로', () => {
    const o = output('R1'); expect(row(d03TablesV3(o), 'J9')).toBe(`| J9 | 진단 | ${stageEvidence(o).rows.J9.evidence} |`);
  });
  it('9 최종 표 측정 전·미정·네 칸 통과·표본 밖 R4만 실패', () => {
    const base = five(), oos = five(2101);
    const first = v3Report(base);
    expect(section(first, '## J1 관문').match(/측정 전/g)).toHaveLength(5);
    expect(section(first, '## J10 최종(판정표 v3 4절: 네 검정 모두 통과)')).toContain('| 최종 | 미정 | 측정 전 |');
    expect(section(first, '## 6열 표(표본 밖 1)').trim()).toBe('측정 전');
    expect(v3Report(base, oos)).toContain('| 최종 | 통과 | 통과 |');
    base[0] = output('R0P', 40, 26); base[4] = output('R4', 40, 25, 2);
    oos[0] = output('R0P', 40, 24, 3, 2101); oos[4] = output('R4', 40, 23, 4, 2101);
    // 나머지 단계의 메타 시드도 각 묶음과 맞춘다.
    for (const i of [1, 2, 3]) { base[i] = output(LEVELS_V2[i]!, 40, 26); oos[i] = output(LEVELS_V2[i]!, 40, 26, 0, 2101); }
    const text = v3Report(base, oos), table = section(text, '## J10 최종(판정표 v3 4절: 네 검정 모두 통과)');
    expect(table).toContain('| R0P | 통과 | 통과 |'); expect(table).toContain('| R4 | 통과 | 실패 |'); expect(table).toContain('| 최종 | 실패 | 실패 |');
  });
  it('10 실제 R4 두 시드 CLI 실행과 v3-tables 스모크', () => {
    const mem = memoryIo([]);
    expect(simMain(['d03', '--risk-v2', 'R4', '--policies', `${BASE},${TG}`, '--seed-base', '2001', '--seeds', '2', '--out', 'smoke'], mem.io), mem.stderr.join('')).toBe(0);
    expect(simMain(['v3-tables', 'smoke'], mem.io), mem.stderr.join('')).toBe(0);
    for (const key of ['J10', '진단 J10②', '진단 X']) expect(row(mem.stdout.at(-1)!, key)).toBeTruthy();
  }, 60000);
});

function contract(due: number, evaluationDay: number, sale: number, den: number): RiskContract {
  return { ...structuredClone(contractTemplate), paymentDueDay: due, evaluationDay, saleAmountMinor: sale, saleKrwAtAcceptMinor: den };
}
function oracleRate(seed: number, day: number): number {
  const cfg = simConfigV2(loadScenario(SCENARIO), 'R4', 'RISK_PROFILE_V2'), fx = cfg.operations!.risk!.profile.fx, p = cfg.operations!.market.publish;
  let rate = fx.startKrwPerUsd;
  for (let k = 1; k <= Math.max(0, Math.floor((Math.min(day, p.lastDay) - p.firstDay) / p.intervalDays)); k++) {
    const draw = drawUniform({ seed, cursors: { 'FX-REF': k } }, 'FX-REF').value;
    const step = Math.floor(draw * (2 * fx.stepBp + 1)) - fx.stepBp;
    rate = Math.max(fx.minKrwPerUsd, Math.min(fx.maxKrwPerUsd, Math.floor((rate * (10000 + step) + 5000) / 10000)));
  }
  return rate;
}
function oracleX(c: RiskContract, seed: number, d: number): bigint {
  const T = Math.min(c.evaluationDay, 78), start = Math.min(c.paymentDueDay!, T), end = Math.min(c.paymentDueDay! + d, T);
  return BigInt(Math.abs(Math.floor((c.saleAmountMinor! * oracleRate(seed, end) + 50) / 100) - Math.floor((c.saleAmountMinor! * oracleRate(seed, start) + 50) / 100)));
}
