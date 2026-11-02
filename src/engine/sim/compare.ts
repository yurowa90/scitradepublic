import { formatMoney, type Currency } from '../money';
import { policyById } from './policies';
import type { SimOutput, SimRun } from './sim';

export interface MetricDiff { run: string; path: string; before: number | string | null; after: number | string | null }
export interface CompareResult {
  identical: boolean;
  onlyInBefore: string[];
  onlyInAfter: string[];
  diffs: MetricDiff[];
  metaDiffs: MetricDiff[];
  /** 요약 첫 줄에 표시할 양쪽 공통 실행 수. */
  comparedRuns: number;
}
export function runKey(run: Pick<SimRun, 'scenarioId' | 'policyId' | 'seed'>): string {
  return `${run.scenarioId}/${run.policyId}/${run.seed}`;
}

type Leaf = MetricDiff['before'];
function flatten(value: unknown, path: string, result = new Map<string, Leaf>()): Map<string, Leaf> {
  if (value === null || typeof value === 'number' || typeof value === 'string') result.set(path, value);
  else if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (!entries.length) result.set(path, Array.isArray(value) ? '[]' : '{}');
    for (const [key, child] of entries) flatten(child, `${path}.${key}`, result);
  } else throw new Error(`비교할 수 없는 값입니다: ${path}`);
  return result;
}
function differences(before: unknown, after: unknown, run: string, root: string): MetricDiff[] {
  const a = flatten(before, root), b = flatten(after, root);
  return [...new Set([...a.keys(), ...b.keys()])].sort()
    .filter((path) => a.has(path) !== b.has(path) || a.get(path) !== b.get(path))
    .map((path) => ({ run, path, before: a.get(path) ?? null, after: b.get(path) ?? null }));
}
function indexRuns(output: SimOutput): Map<string, SimRun> {
  const result = new Map<string, SimRun>();
  for (const run of output.runs) {
    const key = runKey(run);
    if (result.has(key)) throw new Error(`중복 실행 키입니다: ${key}`);
    result.set(key, run);
  }
  return result;
}
export function compareOutputs(before: SimOutput, after: SimOutput): CompareResult {
  const a = indexRuns(before), b = indexRuns(after);
  const onlyInBefore = [...a.keys()].filter((key) => !b.has(key));
  const onlyInAfter = [...b.keys()].filter((key) => !a.has(key));
  const diffs: MetricDiff[] = [];
  let comparedRuns = 0;
  for (const [key, run] of a) {
    const other = b.get(key);
    if (!other) continue;
    comparedRuns++;
    diffs.push(...[...differences(run.commands, other.commands, key, 'commands'),
      ...differences(run.metrics, other.metrics, key, 'metrics')].sort((x, y) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  }
  return { identical: !onlyInBefore.length && !onlyInAfter.length && !diffs.length,
    onlyInBefore, onlyInAfter, diffs, metaDiffs: differences(before.meta, after.meta, '', 'meta'), comparedRuns };
}

export function formatCompare(result: CompareResult, limit = 50): string {
  const lines = [result.identical
    ? `비교 결과: 같음 (실행 ${result.comparedRuns}회, 지표 차이 0건)`
    : `비교 결과: 다름 — 지표 차이 ${result.diffs.length}건, 앞에만 있는 실행 ${result.onlyInBefore.length}회, 뒤에만 있는 실행 ${result.onlyInAfter.length}회`];
  for (const diff of result.diffs.slice(0, limit)) lines.push(`- ${diff.run} ${diff.path}: ${diff.before} → ${diff.after}`);
  if (result.diffs.length > limit) lines.push(`… 외 ${result.diffs.length - limit}건`);
  for (const key of result.onlyInBefore) lines.push(`- 앞에만 있는 실행: ${key}`);
  for (const key of result.onlyInAfter) lines.push(`- 뒤에만 있는 실행: ${key}`);
  for (const diff of result.metaDiffs) lines.push(`메타 차이(판정에 넣지 않음): ${diff.path} ${diff.before} → ${diff.after}`);
  return lines.join('\n') + '\n';
}

function range(values: number[], format: (n: number) => string = String): string {
  if (!values.length) return '해당 없음';
  const min = Math.min(...values), max = Math.max(...values);
  return min === max ? format(min) : `${format(min)}~${format(max)}`;
}
export function summarizeOutput(output: SimOutput): string {
  const groups = new Map<string, SimRun[]>();
  for (const run of output.runs) {
    const key = `${run.scenarioId}/${run.policyId}`;
    const group = groups.get(key) ?? [];
    group.push(run);
    groups.set(key, group);
  }
  const lines = [
    '| 시나리오 | 정책 | 실행 수 | 서로 다른 결과 수 | 기말 순자산(통화별 최소~최대) | 현금 부족일(통화별 최소~최대) | 계약 기여이익(통화별 최소~최대) | 정시 인도율(최소~최대) | 직원 대기일(최소~최대) |',
    '| --- | --- | ---: | ---: | --- | --- | --- | --- | --- |',
  ];
  for (const runs of groups.values()) {
    const first = runs[0]!;
    const currencies = [...new Set(runs.flatMap((r) => Object.keys(r.metrics.currencies)))];
    const moneyRange = (field: 'netAssets' | 'contractContribution' | 'shortfallDays') => currencies.map((currency) => {
      const values = runs.flatMap((r) => r.metrics.currencies[currency] ? [r.metrics.currencies[currency]![field]] : []);
      return field === 'shortfallDays' ? `${currency} ${range(values)}일` : `${currency} ${range(values, (n) => formatMoney(currency as Currency, n))}`;
    }).join(' / ');
    const rates = runs.map((r) => r.metrics.delivery.rateBasisPoints);
    const rateRange = range(rates.filter((n): n is number => n !== null), (n) => `${(n / 100).toFixed(1)}%`);
    const rate = rates.some((n) => n === null) && rates.some((n) => n !== null) ? `${rateRange} / 해당 없음` : rateRange;
    lines.push(`| ${first.scenarioId} | ${policyById(first.policyId)?.labelKo ?? first.policyId} | ${runs.length} | ${new Set(runs.map((r) => JSON.stringify(r.metrics))).size} | ${moneyRange('netAssets')} | ${moneyRange('shortfallDays')} | ${moneyRange('contractContribution')} | ${rate} | ${range(runs.map((r) => r.metrics.staff.idleEmployeeDays))} |`);
  }
  return lines.join('\n') + '\n';
}
