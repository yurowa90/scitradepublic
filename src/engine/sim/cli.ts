import '../../content/ops-data-entry';
import { EXPERIMENT_SCENARIO_IDS, OPERATIONS_SCENARIO_IDS, loadCreditProfile } from '../../content/scenario';
import type { RiskLevel, RiskLevelV2 } from './risk-metrics';
import { riskCompareTables } from './risk-tables';
import { d03TablesV3, gateFailedV3, v3Report, validateShaV3 } from './risk-tables-v3';
import { d03TablesV2, riskCompareTablesV2, v2Report } from './risk-tables-v2';
import { d03Tables, mergeD03, runD03, requestedRisk, workerOptions } from './d03';
import { parseVariant, type LateMode } from './variants';
export { mergeD03, runD03, requestedRisk, workerOptions };
import { compareOutputs, formatCompare, summarizeOutput } from './compare';
import { runSuite, serializeSimOutput, SIM_FORMAT, SIM_SEEDS, type SimOutput } from './sim';

export interface SimIo {
  readText(path: string): string;
  writeText(path: string, text: string): void;
  out(text: string): void;
  err(text: string): void;
  now(): number;
  marketRulesSha256?(): string;
}
export const USAGE = `사용법:
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
function integer(value: string, min: number, max: number, label: string): number {
  const n = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label}: ${min}~${max} 정수여야 합니다.`);
  return n;
}
function readOutput(path: string, io: SimIo): SimOutput {
  let value: unknown;
  try { value = JSON.parse(io.readText(path)); }
  catch (error) { throw new Error(`입력 파일을 읽을 수 없습니다 (${path}): ${error instanceof Error ? error.message : String(error)}`); }
  if (!value || typeof value !== 'object') throw new Error(`비교 실행기 출력이 아닙니다: ${path}`);
  const output = value as SimOutput;
  if (output.meta?.tool !== 'scitrade-sim' || output.meta?.format !== SIM_FORMAT || !Array.isArray(output.runs)) {
    throw new Error(`비교 실행기 출력 형식이 아닙니다: ${path} (도구·형식 판본·실행 목록 확인)`);
  }
  return output;
}

export function d03Options(args: readonly string[]) {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--risk', '--risk-v2', '--profile', '--scenarios', '--round', '--policies', '--seed-base', '--seeds', '--seed-from', '--seed-to', '--late', '--workers', '--out', '--tables-from'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(`잘못된 D03 인수: ${key}`);
    options.set(key, value);
  }
  const count = integer(options.get('--seeds') ?? '20', 1, 40, '시드 수');
  const seedBase = options.has('--seed-base') ? integer(options.get('--seed-base')!, 0, Number.MAX_SAFE_INTEGER - (count - 1), '시드 기준값') : undefined;
  if (seedBase === undefined && count > 20) throw new Error('--seed-base 없이 시드 수는 20 이하입니다.');
  const seeds = seedBase === undefined ? SIM_SEEDS : Array.from({ length: count }, (_, i) => seedBase + i);
  // 분할 범위는 선택한 시드 목록의 1부터 시작하는 번호다.
  const from = integer(options.get('--seed-from') ?? '1', 1, count, '시드 시작 번호');
  const to = integer(options.get('--seed-to') ?? String(count), from, count, '시드 끝 번호');
  const late = options.get('--late') ?? 'base';
  if (!['base', 'cap30', 'flat200'].includes(late)) throw new Error(`알 수 없는 감액: ${late}`);
  const riskV2 = options.has('--risk-v2');
  if (riskV2 && options.has('--risk')) throw new Error('--risk와 --risk-v2는 함께 쓸 수 없습니다.');
  if (!riskV2 && options.has('--profile')) throw new Error('--profile은 --risk-v2가 필요합니다.');
  if (riskV2 && seedBase === undefined) throw new Error('--risk-v2는 --seed-base가 필요합니다.');
  const profileId = riskV2 ? options.get('--profile') ?? 'RISK_PROFILE_V2' : undefined;
  if (profileId) loadCreditProfile(profileId);
  const risk = options.get(riskV2 ? '--risk-v2' : '--risk');
  if (risk && !(riskV2 ? ['R0P', 'R1', 'R2', 'R3', 'R4'] : ['R0', 'R1', 'R2', 'R3']).includes(risk)) throw new Error('알 수 없는 위험 층');
  const policyIds = options.get('--policies')?.split(',');
  if (!riskV2 && policyIds?.some((id) => ['TERM_GREEDY', 'CREDIT_AWARE'].includes(parseVariant(id)?.acceptance ?? ''))) throw new Error('외상 정책은 --risk-v2가 필요합니다.');
  if (!risk && options.has('--round')) throw new Error('--round는 --risk가 필요합니다.');
  const scenarioIds = options.get('--scenarios')?.split(',') ?? (riskV2 ? ['SCENARIO_M2_OPS_COS_LAVER'] : undefined);
  if (scenarioIds) for (const id of scenarioIds) {
    if (riskV2 && id !== 'SCENARIO_M2_OPS_COS_LAVER') throw new Error('v2는 (다) 시나리오만 실행합니다.');
    if (!([...OPERATIONS_SCENARIO_IDS, ...EXPERIMENT_SCENARIO_IDS] as string[]).includes(id)) throw new Error(`알 수 없는 시나리오: ${id}`);
    if (!risk && (EXPERIMENT_SCENARIO_IDS as readonly string[]).includes(id)) throw new Error('실험 시나리오는 --risk가 필요합니다.');
  }
  return { ...(risk ? { risk: risk as RiskLevel | RiskLevelV2, tuningRound: integer(options.get('--round') ?? '0', 0, 3, '조정 회차') } : {}),
    ...(riskV2 ? { riskV2: true, profileId } : {}), ...(scenarioIds ? { scenarioIds } : {}), ...(options.has('--policies') ? { policyIds: options.get('--policies')!.split(',') } : {}), seeds: seeds.slice(from - 1, to), late: late as LateMode,
    workers: integer(options.get('--workers') ?? '1', 1, 32, '워커 수'), out: options.get('--out'), tablesFrom: options.get('--tables-from')?.split(',') };
}
export function writeD03(output: SimOutput, io: SimIo, out?: string) {
  if (output.meta.risk?.rules) {
    const { level, profileId } = output.meta.risk;
    // 직렬화 직전에도 외상 프로필 ID가 유효한지 확인한다.
    if (loadCreditProfile(profileId).profileId !== profileId) throw new Error('요청과 다른 위험 프로필입니다.');
    if (out) io.writeText(out, serializeSimOutput(output));
    io.out(`v2 실행 ${output.runs.length}회 · 단계 ${level} · 프로필 ${profileId} · 시드 ${output.meta.seeds[0]}~${output.meta.seeds.at(-1)} (표는 TASK-0068b)\n`);
    return;
  }
  if (out) io.writeText(out, serializeSimOutput(output));
  io.out(d03Tables(output));
}

/** 종료 코드: 성공·같음 0, 비교 결과 다름 1, 사용법·입력·실행 오류 2, v3 J1 관문 실패 3(출력은 모두 냄). */
export function simMain(argv: readonly string[], io: SimIo): number {
  try {
    const [action, ...args] = argv;
    if ((action === 'help' || action === '--help') && !args.length) { io.out(USAGE); return 0; }
    if (action === 'd03') {
      const parsed = d03Options(args), start = io.now();
      const options = { ...parsed, ...(parsed.risk ? { marketRulesSha256: io.marketRulesSha256?.() } : {}) };
      const inputs = options.tablesFrom?.map((path) => readOutput(path, io));
      if (inputs?.some((o) => o.meta.risk?.rules !== undefined)) throw new Error('v1 --tables-from은 rules 메타가 있는 출력을 받지 않습니다.');
      const output = inputs ? mergeD03(inputs, options.late, requestedRisk(options)) : runD03(options);
      if (options.riskV2 && output.meta.risk?.profileId !== options.profileId) throw new Error('요청과 다른 위험 프로필입니다.');
      writeD03(output, io, options.out);
      io.err(`실행 ${output.runs.length}회 · ${((io.now() - start) / 1000).toFixed(2)}초\n`);
      return 0;
    }
    if (action === 'run') {
      const options = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i]!, value = args[i + 1];
        if (!['--scenarios', '--policies', '--seeds', '--out'].includes(key)) throw new Error(`알 수 없는 인수: ${key}`);
        if (!value || value.startsWith('--')) throw new Error(`인수 값이 필요합니다: ${key}`);
        if (options.has(key)) throw new Error(`중복 인수: ${key}`);
        options.set(key, value);
      }
      if (options.get('--policies')?.split(',').some((id) => ['TERM_GREEDY', 'CREDIT_AWARE'].includes(parseVariant(id)?.acceptance ?? ''))) throw new Error('외상 정책은 --risk-v2가 필요합니다.');
      const count = integer(options.get('--seeds') ?? String(SIM_SEEDS.length), 1, SIM_SEEDS.length, '시드 수');
      const start = io.now();
      const output = runSuite({
        ...(options.has('--scenarios') ? { scenarioIds: options.get('--scenarios')!.split(',') } : {}),
        ...(options.has('--policies') ? { policyIds: options.get('--policies')!.split(',') } : {}),
        seeds: SIM_SEEDS.slice(0, count),
      });
      const text = serializeSimOutput(output);
      const path = options.get('--out');
      if (path) io.writeText(path, text); else io.out(text);
      io.err(`실행 ${output.runs.length}회 · ${((io.now() - start) / 1000).toFixed(2)}초\n`);
      return 0;
    }
    if (action === 'v3-tables') {
      if (args.length !== 1 || args[0]!.startsWith('--')) throw new Error('v3 출력 파일 1개가 필요합니다.');
      const output = readOutput(args[0]!, io);
      validateShaV3([output], io.marketRulesSha256?.());
      io.out(d03TablesV3(output)); return gateFailedV3([output]) ? 3 : 0;
    }
    if (action === 'v3-report') {
      const options = new Map<string, string>();
      for (let i = 0; i < args.length; i += 2) {
        const key = args[i]!, value = args[i + 1];
        if (!['--base', '--oos', '--base-r0', '--oos-r0'].includes(key) || !value || value.startsWith('--') || options.has(key)) throw new Error(`잘못된 v3-report 인수: ${key}`);
        options.set(key, value);
      }
      if (!options.has('--base')) throw new Error('--base가 필요합니다.');
      const base = options.get('--base')!.split(',').map((p) => readOutput(p, io));
      const oos = options.get('--oos')?.split(',').map((p) => readOutput(p, io));
      const basePath = options.get('--base-r0'), oosPath = options.get('--oos-r0');
      const baseR0 = basePath ? readOutput(basePath, io) : undefined, oosR0 = oosPath ? readOutput(oosPath, io) : undefined;
      validateShaV3([...base, ...(oos ?? []), ...(baseR0 ? [baseR0] : []), ...(oosR0 ? [oosR0] : [])], io.marketRulesSha256?.());
      io.out(v3Report(base, oos, { base: baseR0, oos: oosR0, basePath, oosPath }));
      return gateFailedV3([...base, ...(oos ?? [])]) ? 3 : 0;
    }
    if (action === 'v2-tables' || action === 'risk-compare-v2') {
      const count = action === 'v2-tables' ? 1 : 2;
      if (args.length !== count || args.some((a) => a.startsWith('--'))) throw new Error(`v2 출력 파일 ${count}개가 필요합니다.`);
      const inputs = args.map((p) => readOutput(p, io));
      io.out(action === 'v2-tables' ? d03TablesV2(inputs[0]!) : riskCompareTablesV2(inputs[0]!, inputs[1]!)); return 0;
    }
    if (action === 'v2-report') {
      const paths: string[] = [];
      let r0Path: string | undefined;
      for (let i = 0; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === '--r0') {
          if (r0Path !== undefined) throw new Error('--r0은 한 번만 받습니다.');
          const value = args[++i];
          if (!value || value.startsWith('--')) throw new Error('--r0 값이 필요합니다.');
          r0Path = value;
        } else if (arg.startsWith('--')) throw new Error(`알 수 없는 인수: ${arg}`);
        else paths.push(arg);
      }
      if (paths.length !== 5) throw new Error('다섯 단계 출력 파일이 필요합니다.');
      io.out(v2Report(paths.map((p) => readOutput(p, io)), r0Path ? readOutput(r0Path, io) : undefined, r0Path)); return 0;
    }
    if (action === 'risk-compare') {
      if (args.length !== 2 || args.some((a) => a.startsWith('--'))) throw new Error('위험 출력 파일 두 개가 필요합니다.');
      io.out(riskCompareTables(readOutput(args[0]!, io), readOutput(args[1]!, io))); return 0;
    }
    if (action === 'compare') {
      if (!(args.length === 2 || (args.length === 4 && args[2] === '--limit')) || args.slice(0, 2).some((a) => a.startsWith('--'))) {
        throw new Error('비교할 파일 두 개와 선택적인 --limit 값이 필요합니다.');
      }
      const limit = args.length === 4 ? integer(args[3]!, 0, Number.MAX_SAFE_INTEGER, '표시 한도') : 50;
      const result = compareOutputs(readOutput(args[0]!, io), readOutput(args[1]!, io));
      io.out(formatCompare(result, limit));
      return result.identical ? 0 : 1;
    }
    if (action === 'summary' && args.length === 1 && !args[0]!.startsWith('--')) {
      io.out(summarizeOutput(readOutput(args[0]!, io))); return 0;
    }
    throw new Error(action ? `명령이나 인수를 확인하세요: ${action}` : '명령이 필요합니다.');
  } catch (error) {
    io.err(`비교 실행기 오류: ${error instanceof Error ? error.message : String(error)}\n${USAGE}`);
    return 2;
  }
}
