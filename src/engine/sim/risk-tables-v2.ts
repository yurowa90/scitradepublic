import { loadScenario } from '../../content/scenario';
import { baselineId, cell, median, predictJ6, type Cell } from './d03';
import { directContracts, J4_BANDS, lossBandPasses, lossStats, missingRuns, newJ7 } from './risk-tables';
import type { RiskLevelV2 } from './risk-metrics';
import type { SimOutput, SimRun } from './sim';
import { bundleKindV2, d03PolicyIds, parseVariant, variantName, type Investment } from './variants';

export type JudgmentKindV2 = '판정' | '진단' | '해당 없음' | '기록';
export const LEVELS_V2 = ['R0P', 'R1', 'R2', 'R3', 'R4'] as const;
const SCENARIO = 'SCENARIO_M2_OPS_COS_LAVER';
const BASE = 'MAX_CONTRIBUTION';
export const RISK_JUDGMENT_KINDS_V2 = {
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
} as const satisfies Record<string, Record<'R0' | RiskLevelV2, JudgmentKindV2>>;
export type JudgmentKeyV2 = keyof typeof RISK_JUDGMENT_KINDS_V2;
const KEYS = Object.keys(RISK_JUDGMENT_KINDS_V2) as JudgmentKeyV2[];
export function judgmentKindV2(key: JudgmentKeyV2, level: 'R0' | RiskLevelV2): JudgmentKindV2 {
  return RISK_JUDGMENT_KINDS_V2[key][level];
}
export function judgmentRowV2(key: JudgmentKeyV2, level: 'R0' | RiskLevelV2, pass: boolean | null, evidence: string, missing: string[] = []): string {
  const kind = judgmentKindV2(key, level);
  if (kind === '해당 없음') return `| ${key} | 해당 없음 | — |`;
  const reason = missing.length ? `실행 없음: ${missing.join(', ')}; ` : kind === '판정' && pass === null ? '근거 부족: ' : '';
  return `| ${key} | ${kind === '판정' ? pass === true && !missing.length ? '통과' : '실패' : kind} | ${reason}${evidence} |`;
}
export const SIGN_THRESHOLDS_V2: Readonly<Record<number, number>> = {
  10: 9, 11: 9, 12: 10, 13: 10, 14: 11, 15: 12, 16: 12, 17: 13, 18: 13, 19: 14,
  20: 15, 21: 15, 22: 16, 23: 16, 24: 17, 25: 18, 26: 18, 27: 19, 28: 19, 29: 20,
  30: 20, 31: 21, 32: 22, 33: 22, 34: 23, 35: 23, 36: 24, 37: 24, 38: 25, 39: 26, 40: 26,
};
export const valueV2 = (r: SimRun) => r.metrics.risk?.analysisValueMinor ?? NaN;
export const unpaid = (r: SimRun) => r.metrics.operations!.unpaidAtEnd.find((x) => x.currency === 'KRW')?.amountMinor ?? 0;
export const healthy = (r: SimRun) => r.metrics.operations!.outcome !== 'FAILED' && unpaid(r) === 0;
export const num = (n: number) => Number.isFinite(n) ? n.toFixed(2) : '—';
const dollars = (n: number, sign = false) => Number.isFinite(n) ? `${sign && n >= 0 ? '+' : ''}${Math.round(n / 100).toLocaleString('en-US')}` : '—';
export const getRuns = (o: SimOutput, id = BASE) => o.runs.filter((r) => r.scenarioId === SCENARIO && r.policyId === id);
const directCount = (rs: SimRun[]) => rs.reduce((s, r) => s + r.metrics.risk!.directAccepted, 0);
const volumeText = (id: string, rs: SimRun[]) => `${id} 직접 무역 합 ${directCount(rs)}, 중앙 ${num(median(rs.map((r) => r.metrics.risk!.directAccepted)))}`;
export const sameSeeds = (a: SimOutput, b: SimOutput) => JSON.stringify([...a.meta.seeds].sort((x, y) => x - y)) === JSON.stringify([...b.meta.seeds].sort((x, y) => x - y));
export function validateV2(output: SimOutput): RiskLevelV2 {
  const risk = output.meta.risk;
  if (risk?.rules !== 'M2a-rules-4') throw new Error('v2 명령은 rules-4 출력만 받습니다.');
  if (output.meta.lateMode !== 'base') throw new Error('v2 표는 lateMode base만 받습니다.');
  if (JSON.stringify(output.meta.scenarioIds) !== JSON.stringify([SCENARIO])) throw new Error('v2 표는 (다) 시나리오만 받습니다.');
  if (!LEVELS_V2.includes(risk.level)) throw new Error('알 수 없는 v2 단계입니다.');
  return risk.level;
}
export function matchingMeta(a: SimOutput, b: SimOutput) {
  validateV2(a); validateV2(b);
  for (const key of ['profileId', 'tuningRound', 'marketRulesSha256'] as const) if (a.meta.risk![key] !== b.meta.risk![key]) throw new Error(`다른 메타: ${key}`);
  for (const key of ['engineVersion', 'dataVersion', 'format', 'lateMode', 'scenarioIds'] as const) if (JSON.stringify(a.meta[key]) !== JSON.stringify(b.meta[key])) throw new Error(`다른 메타: ${key}`);
  if (!sameSeeds(a, b)) throw new Error('다른 메타: seeds');
}
export function newJ7V2(runs: SimRun[]) {
  const r = newJ7(runs);
  return { ...r, pass: r.n < 20 ? null : 4n * r.numerator >= r.denominator };
}
export function j9V2(base: SimRun[], tg: SimRun[]) {
  const fraction = (r: SimRun) => directContracts(r).reduce((s, c) => ({ a: s.a + BigInt(Math.abs(c.components.fx)), b: s.b + BigInt(c.saleKrwAtAcceptMinor!) }), { a: 0n, b: 0n });
  let wins = 0, losses = 0, ties = 0;
  for (const r of base) {
    const other = tg.find((t) => t.seed === r.seed && t.scenarioId === r.scenarioId);
    if (!other) continue;
    const a = fraction(r), b = fraction(other), difference = b.a * a.b - a.a * b.b;
    if (difference > 0n) wins++; else if (difference < 0n) losses++; else ties++;
  }
  const m = wins + losses, threshold = SIGN_THRESHOLDS_V2[m];
  return { wins, losses, ties, m, threshold, pass: m >= 10 && threshold !== undefined && wins >= threshold };
}
export function causesV2(base: SimRun[]) {
  const causes: Record<string, number> = {};
  for (const c of base.flatMap(directContracts).filter((c) => c.realized < 0)) {
    const worst = (['fx', 'tariff', 'surcharge', 'claim', 'collection', 'default', 'carry', 'late', 'cancel'] as const)
      .filter((k) => (c.components[k] ?? 0) < 0).sort((a, b) => (c.components[a] ?? 0) - (c.components[b] ?? 0))[0];
    const key = worst ?? '음수 칸 없음'; causes[key] = (causes[key] ?? 0) + 1;
  }
  return causes;
}
export function marginRawV2(base: SimRun[], mb: SimRun[]) {
  const a = lossStats(base), b = lossStats(mb);
  let m = 0, wins = 0;
  for (const x of a.bySeed) {
    const y = b.bySeed.find((y) => y.seed === x.seed);
    if (!y || !x.total || !y.total) continue;
    const difference = BigInt(y.loss) * BigInt(x.total) - BigInt(x.loss) * BigInt(y.total);
    if (!difference) continue;
    m++; if (difference < 0n) wins++;
  }
  return { a, b, m, wins };
}
export function pairedValuesV2(base: SimRun[], other: SimRun[]) {
  const values = base.flatMap((b) => {
    const r = other.find((r) => r.seed === b.seed && r.scenarioId === b.scenarioId);
    return r ? [valueV2(r) - valueV2(b)] : [];
  }).sort((a, b) => a - b);
  return { positive: values.filter((v) => v > 0).length, negative: values.filter((v) => v < 0).length, ties: values.filter((v) => v === 0).length,
    median: median(values), q1: median(values.slice(0, Math.floor(values.length / 2))), q3: median(values.slice(Math.ceil(values.length / 2))) };
}
export const LIQUIDITY_NOTE = '사전 기대는 유동성 효과(외상 정책이 첫날 D30으로 현금이 묶여 뒤 거래를 놓침)를 뺀 값이다(H28-1).';
export const EXPECTATIONS = {
  '진단 J8': `중앙 35/40, 띠 8~32 안 확률 0.14(DESIGN-v2 2.4). ${LIQUIDITY_NOTE}`,
  '진단 L4': `중앙 36/40(DESIGN-v2 2.4). ${LIQUIDITY_NOTE}`,
  '진단 V': `평균 +21 USD/시드(표준편차 54), 동점 약 27, TG 우세 약 11.8, CA 우세 약 1.2(판정표 v2 3.5, DESIGN-v2 2.4). ${LIQUIDITY_NOTE}`,
};
const CREDIT_KEYS = ['defaultsConfirmed', 'badDebtMinor', 'defaultsUnconfirmed', 'unconfirmedMinor', 'carryMinor', 'limitBlocked', 'lateReceipts', 'partialReceipts', 'pendingPartialReceipts', 'pendingOverdue', 'dateEligible', 'dateLimitEligible'] as const;
export function creditTotalsV2(runs: SimRun[]) {
  const totals = Object.fromEntries(CREDIT_KEYS.map((k) => [k, 0])) as Record<typeof CREDIT_KEYS[number], number>;
  const termCounts = { BASE: 0, D15: 0, D30: 0 };
  for (const r of runs) {
    const c = r.metrics.risk!.credit!;
    for (const k of CREDIT_KEYS) totals[k] += c[k];
    for (const k of ['BASE', 'D15', 'D30'] as const) termCounts[k] += c.termCounts[k];
  }
  const direct = directCount(runs);
  return { ...totals, termCounts, direct, pendingDelay: totals.pendingOverdue - totals.defaultsUnconfirmed,
    datePercent: direct ? totals.dateEligible * 100 / direct : NaN, dateLimitPercent: direct ? totals.dateLimitEligible * 100 / direct : NaN };
}
const REJECTION_KEYS = ['funds', 'storage', 'handling', 'sailing', 'staff', 'onTime', 'credit'] as const;
export function rejectionTotalsV2(runs: SimRun[]) {
  const candidate = Object.fromEntries(REJECTION_KEYS.map((k) => [k, 0])) as Record<typeof REJECTION_KEYS[number], number>;
  let pair = 0, quote = 0, skippedNotOpen = 0;
  for (const r of runs) {
    const v = r.metrics.operations!.rejectionsV2!;
    for (const k of REJECTION_KEYS) candidate[k] += v.candidate[k];
    pair += v.pair; quote += v.quote; skippedNotOpen += v.skippedNotOpen;
  }
  return { candidate, total: REJECTION_KEYS.reduce((s, k) => s + candidate[k], 0), pair, quote, skippedNotOpen };
}
const rejectionSummary = (id: string, runs: SimRun[]) => {
  const r = rejectionTotalsV2(runs); return `${id} credit ${r.candidate.credit}, 짝 ${r.pair}, 견적 ${r.quote}`;
};
function creditSummary(output: SimOutput) {
  const tg = creditTotalsV2(getRuns(output, 'TERM_GREEDY')), base = creditTotalsV2(getRuns(output)), n = getRuns(output).length;
  return `25% 관문 값(보고만): TERM_GREEDY 날짜+한도 ${num(tg.dateLimitPercent)}%, 사전 대리값 31.5%(DESIGN-v2 2.2, R3 대리값); 기준 회사 시드당 대손 확정 ${num(n ? base.defaultsConfirmed / n : NaN)}, 합 ${num(n ? (base.defaultsConfirmed + base.defaultsUnconfirmed) / n : NaN)}; 확정 0.44, 합 0.59. 출처: 세션 A 계산, DESIGN-v2 2.0의 \`diag/m4.json\`(R3, 시드 1001~1040, 기준 회사 425계약)에 V2 등급 확률을 넣어 Σ p_등급 × 1[실효 결제일 + 15 ≤ 90] ÷ 40(확정), 같은 식에서 절단을 뺀 값(합). J1 일회 점검(시드 2001~2010)에서 확정 8건(기대 약 4.4).`;
}
function diagnosticTables(output: SimOutput): string[] {
  const ids = [...new Set(output.runs.map((r) => r.policyId))].sort();
  const lines = ['', '### 진단 U 정책별', '', '| 정책 | defaultsConfirmed | badDebtMinor (USD 센트) | defaultsUnconfirmed | unconfirmedMinor (USD 센트) | carryMinor (USD 센트) | limitBlocked | termCounts (BASE/D15/D30) | lateReceipts | partialReceipts | pendingPartialReceipts | pendingOverdue | dateEligible | dateLimitEligible | 직접 무역 수 | 끝난 때 미결 지연(대손 아님) | 날짜 비율 | 날짜+한도 비율 |', '|---|---:|---:|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];
  for (const id of ids) {
    const c = creditTotalsV2(getRuns(output, id));
    lines.push(`| ${id} | ${c.defaultsConfirmed} | ${c.badDebtMinor} | ${c.defaultsUnconfirmed} | ${c.unconfirmedMinor} | ${c.carryMinor} | ${c.limitBlocked} | ${c.termCounts.BASE}/${c.termCounts.D15}/${c.termCounts.D30} | ${c.lateReceipts} | ${c.partialReceipts} | ${c.pendingPartialReceipts} | ${c.pendingOverdue} | ${c.dateEligible} | ${c.dateLimitEligible} | ${c.direct} | ${c.pendingDelay}${c.pendingDelay < 0 ? ' ⚠ 정의 확인' : ''} | ${num(c.datePercent)}% | ${num(c.dateLimitPercent)}% |`);
  }
  lines.push('', '금액은 청구서 통화 USD 센트 정수이며 환산하지 않는다. 미확정 대손은 수금 없이 OVERDUE로 남아 pendingOverdue에 포함되므로, 끝난 때 미결 지연(대손 아님)은 pendingOverdue − defaultsUnconfirmed다. 네 수금 칸은 서로 겹치지 않는다.',
    creditSummary(output),
    'v1 대비 지연·부분 수금 건수는 내지 않는다(H27-2 (b)).',
    'v2 R3는 판본 1 R3와 같은 층이 아니다. 값을 직접 견주지 않는다(판정표 v2 2절).',
    '', '### 진단 거절 정책별', '', `| 정책 | ${REJECTION_KEYS.join(' | ')} | 후보 합 | 짝 | 견적 | OPEN 아님 건너뜀 |`, '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const id of ids) {
    const r = rejectionTotalsV2(getRuns(output, id));
    lines.push(`| ${id} | ${REJECTION_KEYS.map((k) => r.candidate[k]).join(' | ')} | ${r.total} | ${r.pair} | ${r.quote} | ${r.skippedNotOpen} |`);
  }
  lines.push('', '후보 단위·OPEN 아님 건너뜀은 운송 주선 후보를 포함하고, 짝·견적은 직접 무역만 센다. 단위끼리 더하거나 나누지 않는다.');
  return lines;
}

// v1의 고용·순위 계산을 복사했다. v1 출력 경로에는 의존성을 더하지 않는다.
function fullCalculations(output: SimOutput) {
  const runs = output.runs.filter((r) => r.scenarioId === SCENARIO), ids = [...new Set(runs.map((r) => r.policyId))].sort();
  const get = (id: string) => getRuns(output, id), value = valueV2;
  const baseline = get(BASE), n = baseline.length;
  const campaignDays = loadScenario(SCENARIO).campaignDays;
  const stats = (id: string, base = baselineId(id)) => cell(get(id), get(base), value);
  const hires = ids.filter((id) => { const v = parseVariant(id)!; return v.hires.length === 1 && !v.early; });
  const coreHires = hires.filter((id) => { const v = parseVariant(id)!; return [8, 30, 50].includes(v.hires[0]!.day) && v.investment !== 'SE22'; });
  const clear = hires.filter((id) => stats(id).arrow);
  const j6 = clear.map((id) => {
    const v = parseVariant(id)!, h = v.hires[0]!, rs = get(id), bs = get(baselineId(id));
    const measurements = bs.flatMap((r) => r.metrics.operations!.bottlenecks.filter((b) => b.day === h.day && b.pt === h.pt));
    const prediction = predictJ6(measurements), actual = stats(id).arrow;
    const highSeeds = rs.filter((r) => {
      const actual = r.metrics.operations!.actualHires[0]?.actualDay;
      const ds = r.metrics.operations!.utilization.filter((d) => actual !== null && actual !== undefined && d.day >= actual);
      return ds.length && ds.filter((d) => d.handlingUsedPt / d.handlingCapacityPt >= 0.9 || d.storageUsedLiters / d.storageCapacityLiters >= 0.9).length >= ds.length / 2;
    }).length;
    const waiting = median(rs.map((r) => r.metrics.operations!.warehouseWaitingTaskDays));
    const pairs = rs.map((r) => ({ r, b: bs.find((b) => b.seed === r.seed)! }));
    const increases = pairs.map(({ r, b }) => r.metrics.operations!.handlingJobs - b.metrics.operations!.handlingJobs);
    const realized = pairs.flatMap(({ r }, i) => {
      const actualDay = r.metrics.operations!.actualHires[0]!.actualDay;
      const extra = prediction.value;
      return actualDay === null || !extra ? [] : [increases[i]! / (extra * (campaignDays - actualDay + 1) / 7)];
    });
    const excluded = rs.filter((r) => r.metrics.operations!.actualHires[0]!.actualDay === null).length;
    return { increase: median(increases), realization: median(realized), excluded, id, prediction, actual, matched: prediction.arrow === actual, highSeeds, waiting, n: measurements.length };
  });
  const eligible = ids.filter((id) => { const v = parseVariant(id)!; return !['IDLE', 'NO_FX', 'MARGIN_BUFFER', 'FOCUS', 'TERM_GREEDY', 'CREDIT_AWARE'].includes(v.acceptance) && !v.react && v.hires.length < 2; });
  const complete = eligible.filter((id) => get(id).length === n);
  const near = new Map(complete.map((id) => [id, 0])), wins = new Map(complete.map((id) => [id, 0]));
  for (const seed of output.meta.seeds) {
    const rs = complete.flatMap(get).filter((r) => r.seed === seed), best = Math.max(...rs.map(value));
    for (const r of rs) if (best - value(r) <= 30000) near.set(r.policyId, near.get(r.policyId)! + 1);
    const winner = rs.find((r) => value(r) === best); if (winner) wins.set(winner.policyId, wins.get(winner.policyId)! + 1);
  }
  const strongest = [...near].sort((a, b) => b[1] - a[1])[0];
  const shares = baseline.map((r) => {
    const b = r.metrics.operations!.currencies.USD!.business, total = b.directTrade + b.handlingForwarding + b.standardForwarding;
    return { direct: total ? b.directTrade * 100 / total : 0, handling: total ? b.handlingForwarding * 100 / total : 0, standard: total ? b.standardForwarding * 100 / total : 0 };
  });
  return { ids, get, stats, coreHires, j6, complete, strongest, shares, wins };
}
export interface Evidence { pass: boolean | null; evidence: string; missing: string[] }
export interface Stage { level: RiskLevelV2; rows: Record<JudgmentKeyV2, Evidence>; full: ReturnType<typeof fullCalculations> | null }
export function stageEvidence(output: SimOutput): Stage {
  const level = validateV2(output), base = getRuns(output), n = base.length;
  const full = bundleKindV2(level) === 'full' ? fullCalculations(output) : null;
  const rows = {} as Record<JudgmentKeyV2, Evidence>;
  // 해당 없음은 콜백을 실행하지 않는다. 축소 묶음에서는 고용 격자도 만들지 않는다.
  const add = (key: JudgmentKeyV2, calculate: () => { pass: boolean | null; evidence: string }, needed: readonly string[] = [BASE]) => {
    rows[key] = judgmentKindV2(key, level) === '해당 없음' ? { pass: null, evidence: '—', missing: [] }
      : { ...calculate(), missing: missingRuns(output, SCENARIO, needed) };
  };
  const fullIds = d03PolicyIds('base');
  const hireIds = fullIds.filter((p) => parseVariant(p)!.hires.length <= 1 && !parseVariant(p)!.early);
  add('J1', () => ({ pass: n ? base.every(healthy) : null, evidence: `기준 ${n}시드, 실패 ${base.filter((r) => r.metrics.operations!.outcome === 'FAILED').length}, 끝 원화 미지급 ${base.filter((r) => unpaid(r) > 0).length}` }));
  add('J2', () => {
    const groups = [BASE, 'LATE_OK'].map((p) => { const cs = full!.coreHires.filter((id) => parseVariant(id)!.acceptance === p).map((id) => full!.stats(id)); return { p, count: cs.length, up: cs.filter((c) => c.arrow === '↑').length, down: cs.filter((c) => c.arrow === '↓').length }; });
    return { pass: groups.every((g) => g.count === 24) && n >= 10 ? groups.every((g) => g.up > 0 && g.down > 0) : null,
      evidence: groups.map((g) => `${g.p}: ${g.count}칸 ↑${g.up} ↓${g.down}`).join('; ') };
  }, hireIds);
  add('J3', () => {
    const { strongest, complete } = full!;
    return { pass: !strongest || n < 10 ? null : 20n * BigInt(strongest[1]) < 17n * BigInt(n),
      evidence: `후보 ${complete.length}정책, 가장 강한 ${strongest?.[0] ?? '없음'}: ${strongest?.[1] ?? 0}/${n}시드 (1위와 300 USD 안)` };
  }, fullIds.filter((p) => { const v = parseVariant(p)!; return !['IDLE', 'NO_FX', 'MARGIN_BUFFER', 'TERM_GREEDY', 'CREDIT_AWARE'].includes(v.acceptance) && !v.react && v.hires.length < 2; }));
  add('J4a~c', () => {
    const nofx = getRuns(output, 'NO_FX'), failures = nofx.filter((r) => r.metrics.operations!.outcome === 'FAILED').length;
    const shape = base.every((r) => { const o = r.metrics.operations!; return o.maxBatchOffers <= 10 && o.forwardingPrepMin >= 2 && o.forwardingPrepMax <= 12 && r.metrics.currencies.KRW!.cash >= 0; });
    return { pass: n && nofx.length ? shape && 4n * BigInt(failures) >= 3n * BigInt(nofx.length) : null,
      evidence: `기준 ${n}시드, 최대 묶음 ${Math.max(0, ...base.map((r) => r.metrics.operations!.maxBatchOffers))}견적, 준비 ${Math.min(...base.map((r) => r.metrics.operations!.forwardingPrepMin))}~${Math.max(0, ...base.map((r) => r.metrics.operations!.forwardingPrepMax))}pt; NO_FX 실패 ${failures}/${nofx.length}` };
  }, [BASE, 'NO_FX']);
  add('J4d', () => ({ pass: null, evidence: `분석값 중앙 ${num(median(base.map(valueV2)) / 100)}` }));
  add('J5', () => {
    const id = full!.ids.find((id) => parseVariant(id)!.hires.length === 2), c = id ? full!.stats(id) : null;
    return { pass: c?.n ? 20n * BigInt(c.gains) <= 3n * BigInt(n) : null, evidence: `두 명 고용 이득 ${c?.gains ?? 0}/${c?.n ?? 0}시드` };
  }, ['MAX_CONTRIBUTION~inv:SE~hire:2pt@22+3pt@36', 'MAX_CONTRIBUTION~inv:SE']);
  add('J6', () => {
    const cs = full!.j6, matches = cs.filter((c) => c.matched).length;
    const groups = [BASE, 'LATE_OK'].map((p) => { const group = cs.filter((c) => parseVariant(c.id)!.acceptance === p); return `${p} ${group.filter((c) => c.matched).length}/${group.length}칸`; }).join('; ');
    return { pass: cs.length ? 5n * BigInt(matches) >= 4n * BigInt(cs.length) : null,
      evidence: `${matches}/${cs.length}칸 (${cs.length ? (matches * 100 / cs.length).toFixed(1) : '—'}%), ${cs.reduce((s, c) => s + c.n, 0)}시드 관측; ${groups}` };
  }, hireIds);
  add('J7(새 정의)', () => { const j = newJ7V2(base); return { pass: j.pass, evidence: `중앙 ${num(j.percent)}%, 남은 시드 ${j.n}, 분모 ≤ 0 제외 ${j.excluded}` }; });
  add('L1', () => { const a = lossStats(base); return { pass: a.total ? lossBandPasses(a.loss, a.total) : null, evidence: `모은 손실 ${a.loss}/${a.total}` }; });
  add('J9', () => { const j = j9V2(base, getRuns(output, 'TERM_GREEDY')); return { pass: j.pass, evidence: `TG 우세 ${j.wins}/${j.m} (문턱 ${j.threshold ?? '—'}, 동점 ${j.ties}); 사전 기대 33 대 7(DESIGN-v2 2.6)` }; }, [BASE, 'TERM_GREEDY']);
  for (const [key, id] of [['진단 J8', 'TERM_GREEDY'], ['진단 L4', 'CREDIT_AWARE']] as const) add(key, () => {
    const other = getRuns(output, id), p = pairedValuesV2(base, other);
    return { pass: null, evidence: `${id} > 기준 ${p.positive}, 같음 ${p.ties}, 작음 ${p.negative}; ${volumeText(id, other)}; ${volumeText(BASE, base)}; 사전 기대 ${EXPECTATIONS[key]}` };
  }, [BASE, id]);
  add('진단 V', () => {
    const p = pairedValuesV2(getRuns(output, 'TERM_GREEDY'), getRuns(output, 'CREDIT_AWARE'));
    return { pass: null, evidence: `CA − TG 중앙 ${num(p.median / 100)} USD, 사분위 ${num(p.q1 / 100)} / ${num(p.q3 / 100)} USD; 동점 ${p.ties}, 양수 ${p.positive}, 음수 ${p.negative}; 사전 기대 ${EXPECTATIONS['진단 V']}` };
  }, ['TERM_GREEDY', 'CREDIT_AWARE']);
  add('진단 T', () => { const cs = base.flatMap(directContracts).filter((c) => c.onTime); return { pass: null, evidence: `${cs.filter((c) => c.components.tariff !== 0).length}/${cs.length}` }; });
  add('진단 C', () => ({ pass: null, evidence: JSON.stringify(causesV2(base)) }));
  add('진단 F', () => { const cs = base.flatMap(directContracts); return { pass: null, evidence: `${cs.filter((c) => c.components.fx < 0).length}/${cs.length}, fx 중앙 ${num(median(cs.map((c) => c.components.fx)))}원` }; });
  add('진단 B', () => { const seeds = [...new Set(output.meta.seeds)]; return { pass: null, evidence: `${seeds.filter((seed) => output.runs.some((r) => r.seed === seed && r.metrics.risk!.referenceRateBounds)).length}/${seeds.length}` }; }, []);
  add('진단 U', () => ({ pass: null, evidence: creditSummary(output) }), [BASE, 'TERM_GREEDY']);
  add('진단 M', () => {
    const m = marginRawV2(base, getRuns(output, 'MARGIN_BUFFER'));
    return { pass: null, evidence: `판정표 v2 3.1 밖의 기록(판본 1 L3 연속성); MARGIN_BUFFER 손실 ${m.b.loss}/${m.b.total}, 기준 손실 ${m.a.loss}/${m.a.total}; 낮은 시드 ${m.wins}/${m.m}, MARGIN_BUFFER 직접 무역 계약 ${m.b.total}건` };
  }, [BASE, 'MARGIN_BUFFER']);
  add('진단 거절', () => ({ pass: null, evidence: `${rejectionSummary('TERM_GREEDY', getRuns(output, 'TERM_GREEDY'))}; ${rejectionSummary(BASE, base)}` }), [BASE, 'TERM_GREEDY']);
  return { level, rows, full };
}
function rowText(stage: Stage, key: JudgmentKeyV2, j4d?: Evidence) {
  const e = key === 'J4d' && stage.level === 'R4' && j4d ? j4d : stage.rows[key];
  if (key === 'J4d' && stage.level === 'R4' && !j4d) return `| J4d | 보류(v2-report에서 판정) | ${e.missing.length ? `실행 없음: ${e.missing.join(', ')}; ` : ''}${e.evidence} |`;
  return judgmentRowV2(key, stage.level, e.pass, e.evidence, e.missing);
}
const J4_NOTE = 'J4는 개연성 점검이다(묶음 견적 수·준비 pt·환전 없이 실패·기준 순자산 범위).';
function judgmentTables(stage: Stage, risk: boolean, j4d?: Evidence): string[] {
  return ['', risk ? '## ⑨ 위험 판정' : '## ⑤ J1~J7 판정과 근거 수', '', ...(!risk ? [J4_NOTE, ''] : []),
    '| 판정 | 결과 | 근거 |', '|---|---|---|', ...KEYS.slice(risk ? 8 : 0, risk ? undefined : 8).map((k) => rowText(stage, k, j4d))];
}

export function d03TablesV2(output: SimOutput): string {
  const stage = stageEvidence(output), { level, full } = stage, risk = output.meta.risk!;
  const base = getRuns(output), n = base.length;
  const display = (c: Cell) => c.n ? `${dollars(c.median, true)} (${c.gains})${c.arrow ? ` ${c.arrow}` : ''}` : '—';
  const lines = [`# D03 v2 단계 표 (${level})`, '',
    `시드 ${output.meta.seeds[0]}~${output.meta.seeds.at(-1)} (${output.meta.seeds.length}개) · 실행 ${output.runs.length}회 · 프로필 ${risk.profileId} · 조정 회차 ${risk.tuningRound} · marketRulesSha256 ${risk.marketRulesSha256.slice(0, 12)}`,
    '비교 금액은 분석값(USD 정수 표시)이며 원화 순자산을 고정 기준 환율로 환산한다.',
    '같은 시드의 분석값 차이 중앙값 (이득 시드 수)이다. 두 정책 중앙값끼리 뺀 값은 아니다. 이득은 순자산 증가·실패 없음·끝 원화 미지급 0이다.',
    '①은 보통·고용·투자 없음 대비, ②는 같은 수락의 투자 없음 대비, ③·④는 같은 수락·투자의 고용 없음 대비다. 조사 선행은 같은 고용·투자의 조사 선행 없는 실행 대비다.',
    'S=1일 선복, E=7일 확장, SE=둘 다, SE22=22일 둘 다. ↑는 중앙 ≥ +300 USD·이득 ≥ 0.75N·실패 ≤ floor(0.05N), ↓는 중앙 ≤ −300 USD·이득 ≤ 0.25N이다. N<10이면 화살표를 쓰지 않는다.',
    '', '## ① 기준 표', '', '| 정책 | 기준 대비 분석값 | 분석값 중앙 | 실패 | 끝 KRW 현금 중앙 | 끝 KRW 미지급 중앙 | 직접 무역 수 중앙 |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const id of ['IDLE', 'NO_FX', BASE, 'LATE_OK', ...(full ? ['MAX_CONTRIBUTION~fx:react'] : []), 'MARGIN_BUFFER', 'TERM_GREEDY', 'CREDIT_AWARE']) {
    const rs = getRuns(output, id);
    if (!rs.length) continue;
    lines.push(`| ${id} | ${display(cell(rs, base, valueV2))} | ${dollars(median(rs.map(valueV2)))} | ${rs.filter((r) => r.metrics.operations!.outcome === 'FAILED').length}/${rs.length} | ${median(rs.map((r) => r.metrics.currencies.KRW!.cash)).toLocaleString('en-US')} | ${median(rs.map(unpaid)).toLocaleString('en-US')} | ${num(median(rs.map((r) => r.metrics.risk!.directAccepted)))} |`);
  }
  if (full) {
    const { ids, stats } = full;
    lines.push('', '## ② 투자만', '', '| 정책 | 투자 없음 대비 분석값 |', '|---|---:|');
    for (const id of ids.filter((id) => { const v = parseVariant(id)!; return v.investment !== 'none' && !v.hires.length; })) lines.push(`| ${id} | ${display(stats(id))} |`);
    for (const [acceptance, title] of [['MAX_CONTRIBUTION', '③ 고용 표(보통)'], ['LATE_OK', '④ 고용 표(적극)']]) {
      const investments = ['none', 'S', 'E', 'SE', 'SE22'];
      lines.push('', `## ${title}`, '', `| 고용 | ${investments.join(' | ')} |`, `|---|${investments.map(() => '---:|').join('')}`);
      for (const pt of [2, 3]) for (const day of [8, 29, 30, 31, 50]) {
        lines.push(`| ${pt}pt ${day}일 | ${investments.map((investment) => display(stats(variantName({ acceptance: acceptance!, investment: investment as Investment, hires: [{ pt, day }], react: false, early: false })))).join(' | ')} |`);
      }
    }
  } else for (const title of ['② 투자만', '③ 고용 표(보통)', '④ 고용 표(적극)']) lines.push('', `## ${title}`, '', '해당 없음(축소 묶음)');
  lines.push(...judgmentTables(stage, false));
  if (full) {
    const { ids, get, stats, j6, wins, strongest, shares } = full, baseline = base;
    lines.push('', '### J6 칸별 병목 예측', '', '| 정책 | 추가 업무/주 중앙 | 예측 | 실측 | 일치 | 예측 시드 수 | 처리 증가 실측 | 실현률 | 불일치: 이용률 높은 시드 | 불일치: 창고 대기 업무-일 중앙 |', '|---|---:|---|---|---|---:|---:|---|---:|---:|');
    for (const c of j6) lines.push(`| ${c.id} | ${c.prediction.value} | ${c.prediction.arrow} | ${c.actual} | ${c.matched ? '일치' : '불일치'} | ${c.n} | ${c.increase} | ${Number.isNaN(c.realization) ? '—' : c.realization.toFixed(3)} (미고용 제외 ${c.excluded}) | ${c.matched ? '—' : c.highSeeds} | ${c.matched ? '—' : c.waiting} |`);
    lines.push('', '처리 증가 실측은 같은 시드·수락·투자의 고용 없는 실행 대비 수락 HANDLING 건수 차이 중앙값이다(취소 제외). 실현률은 각 시드의 차이를 이 칸의 예측 추가 업무/주 × (캠페인 일수 − 실제 고용일 + 1) / 7로 나눈 뒤 중앙값을 낸다. 미고용 시드는 실현률에서 제외하며 예측 0은 —다.');
    lines.push('', '보관 예측은 정상 상태의 리틀의 법칙 추정이다. 도착 집중·높은 이용률의 대기는 놓칠 수 있다. 이용률 높은 시드는 실제 고용일 이후 마감의 절반 이상에서 보관 또는 처리 이용률이 90% 이상인 경우다.');
    lines.push('', '## ⑥ 시드별 1위 정책 분포와 가장 강한 정책', '', '| 1위 정책 (동점은 정책 이름 순) | 시드 수 |', '|---|---:|');
    for (const [id, count] of wins) if (count) lines.push(`| ${id} | ${count} |`);
    lines.push('', `가장 강한 정책: ${strongest?.[0] ?? '—'} (${strongest?.[1] ?? 0}/${n}시드에서 1위와 300 USD 안). 실패 실행도 순자산 그대로 포함한다.`, '', '## ⑦ 사업별 기여이익 비중 (USD 몫만·진단)', '', '| 사업 | USD 기여이익 중앙 | 시드별 비중 중앙 |', '|---|---:|---:|');
    for (const [field, share, label] of [['directTrade', 'direct', '직접 무역'], ['handlingForwarding', 'handling', '작업 포함 주선'], ['standardForwarding', 'standard', '일반 주선']] as const) lines.push(`| ${label} | ${dollars(median(baseline.map((r) => r.metrics.operations!.currencies.USD!.business[field])))} | ${median(shares.map((s) => s[share])).toFixed(2)}% |`);
    lines.push('', '## ⑧ 계획 고용일과 실제 고용일이 다른 실행 수', '', '| 정책 | 고용일이 다른 실행 / 전체 실행 | 실제 고용일 (null=미고용) | 예측 불일치 계약 합계 |', '|---|---:|---|---:|');
    for (const id of ids) { const rs = get(id); lines.push(`| ${id} | ${rs.filter((r) => r.metrics.operations!.actualHires.some((h) => h.actualDay !== h.plannedDay)).length}/${rs.length} | ${[...new Set(rs.map((r) => r.metrics.operations!.actualHires.map((h) => h.actualDay ?? 'null').join('+')))].join(', ') || '—'} | ${rs.reduce((sum, r) => sum + r.metrics.operations!.projectionMisses, 0)} |`); }
    lines.push('', '### 진단·조사 선행 비교', '', '| 정책 | 대응 기준 대비 분석값 |', '|---|---:|');
    for (const id of ids.filter((id) => { const v = parseVariant(id)!; return v.early || v.hires.length > 1; })) lines.push(`| ${id} | ${display(stats(id))} |`);
  } else {
    for (const title of ['J6 칸별 병목 예측', '⑥ 시드별 1위 정책 분포와 가장 강한 정책', '⑦ 사업별 기여이익 비중 (USD 몫만·진단)', '⑧ 계획 고용일과 실제 고용일이 다른 실행 수', '진단·조사 선행 비교']) lines.push('', `## ${title}`, '', '해당 없음(축소 묶음)');
  }
  const a = lossStats(base);
  lines.push(...judgmentTables(stage, true), '', `L2 재료: ${a.loss}/${a.total}; 시드별 ${JSON.stringify(a.bySeed)}`,
    `완료·분류별 손실: ${JSON.stringify(a.classes)}; 열린 고정 환율 민감도 ${a.sensitivityLoss}/${a.total}`,
    `시드별 손실 비율 중앙 ${num(a.median * 100)}%, 사분위 ${num(a.q1 * 100)}% / ${num(a.q3 * 100)}%`, ...diagnosticTables(output));
  return lines.join('\n') + '\n';
}

// 중앙을 두 배 한 정수를 직접 만들어 홀수 센트 중앙도 손실 없이 비교한다.
function medianTwice(values: number[]): bigint | null {
  if (!values.length || values.some((v) => !Number.isSafeInteger(v))) return null;
  const s = [...values].sort((a, b) => a - b), i = Math.floor(s.length / 2);
  return BigInt(s[i]!) + BigInt(s.length % 2 ? s[i]! : s[i - 1]!);
}
const medianUsd = (runs: SimRun[]) => { const x = median(runs.map(valueV2)) / 100; return Number.isFinite(x) ? x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 3 }) : '—'; };
export function j4dV2(r0p: SimOutput, r4: SimOutput): Evidence {
  const m = medianTwice(getRuns(r0p).map(valueV2)), x = medianTwice(getRuns(r4).map(valueV2));
  return { pass: m === null || x === null ? null : x >= 2n * BigInt(J4_BANDS.risk[0]) && x <= m,
    evidence: `R4 중앙 ${medianUsd(getRuns(r4))}, M′(R0P 중앙) ${medianUsd(getRuns(r0p))}, 하한 10,692`,
    missing: [r0p, r4].flatMap((o) => missingRuns(o, SCENARIO, [BASE]).map((m) => `${o.meta.risk!.level}/${m}`)) };
}
export function validateR0(r0: SimOutput, v2: SimOutput) {
  const risk = r0.meta.risk;
  if (!risk || Object.hasOwn(risk, 'rules') || risk.level !== 'R0') throw new Error('--r0은 rules 키가 없는 v1 R0 출력이어야 합니다.');
  if (r0.meta.lateMode !== 'base') throw new Error('v2 표는 lateMode base만 받습니다.');
  if (!r0.meta.scenarioIds.includes(SCENARIO)) throw new Error('--r0에 (다) 시나리오가 필요합니다.');
  if (!sameSeeds(r0, v2)) throw new Error('다른 --r0 메타: seeds');
  if (risk.marketRulesSha256 !== v2.meta.risk!.marketRulesSha256) throw new Error('다른 --r0 메타: marketRulesSha256');
}
export function r0Record(key: JudgmentKeyV2, r0?: SimOutput): string {
  if (!r0 || !['J1', 'J4a~c', 'J7(새 정의)', 'L1'].includes(key)) return '기록 없음';
  const base = getRuns(r0), n = base.length;
  if (!n) return '기록: 기준 회사 실행 없음';
  if (key === 'J1') return `기록: 실패 ${base.filter((r) => r.metrics.operations!.outcome === 'FAILED').length}/${n}, 끝 원화 미지급 ${base.filter((r) => unpaid(r) > 0).length}/${n}`;
  if (key === 'J4a~c') {
    const nofx = getRuns(r0, 'NO_FX');
    return nofx.length ? `기록: NO_FX 실패 ${nofx.filter((r) => r.metrics.operations!.outcome === 'FAILED').length}/${nofx.length}, 최대 묶음 ${Math.max(...base.map((r) => r.metrics.operations!.maxBatchOffers))}견적` : '기록: NO_FX 실행 없음';
  }
  if (key === 'J7(새 정의)') { const j = newJ7(base); return `기록: 중앙 ${num(j.percent)}%, 남은 시드 ${j.n}`; }
  const a = lossStats(base); return `기록: 손실 ${a.loss}/${a.total}`;
}
export function v2Report(outputs: SimOutput[], r0?: SimOutput, r0Path?: string): string {
  if (outputs.length !== 5) throw new Error('다섯 단계 출력이 필요합니다.');
  const levels = outputs.map(validateV2);
  if (new Set(levels).size !== 5) throw new Error('단계 중복·누락: R0P·R1·R2·R3·R4가 하나씩 필요합니다.');
  const ordered = LEVELS_V2.map((level) => outputs.find((o) => o.meta.risk!.level === level)!);
  const first = ordered[0]!, meta = first.meta, risk = meta.risk!;
  for (const o of ordered) matchingMeta(first, o);
  if (r0) validateR0(r0, first);
  const stages = ordered.map(stageEvidence), j4 = j4dV2(first, ordered[4]!);
  const lines = ['# 판정표 v2 보고', '', `시드 ${meta.seeds[0]}~${meta.seeds.at(-1)} (${meta.seeds.length}개) · 프로필 ${risk.profileId} · 조정 회차 ${risk.tuningRound}`,
    `marketRulesSha256 ${risk.marketRulesSha256} · engineVersion ${meta.engineVersion} · dataVersion ${meta.dataVersion}`,
    ordered.map((o) => `${o.meta.risk!.level} 실행 ${o.runs.length}회`).join(' · '), r0 ? `R0 입력: ${r0Path ?? '선택 입력'} (실행 ${r0.runs.length}회)` : 'R0 입력 없음',
    '', '## J4d와 M′', '', '| 판정 | 결과 | 근거 |', '|---|---|---|', judgmentRowV2('J4d', 'R4', j4.pass, j4.evidence, j4.missing),
    '', '| 키 | R0 | R0P | R1 | R2 | R3 | R4 |', '|---|---|---|---|---|---|---|'];
  for (const key of KEYS) lines.push(`| ${key} | ${r0Record(key, r0)} | ${stages.map((s) => {
    const kind = judgmentKindV2(key, s.level), e = key === 'J4d' && s.level === 'R4' ? j4 : s.rows[key];
    return kind === '판정' ? e.pass === true && !e.missing.length ? '통과' : '실패' : kind;
  }).join(' | ')} |`);
  lines.push('', 'R0 열은 기록이며 위험 효과의 기준 경로는 R0P다(판정표 v2 2절).', ...Object.entries(EXPECTATIONS).map(([k, v]) => `${k} 사전 기대: ${v}`));
  for (const s of stages) lines.push('', `### ${s.level}`, ...judgmentTables(s, false, j4), ...judgmentTables(s, true, j4));
  return lines.join('\n') + '\n';
}
export function compareRiskV2(a: SimOutput, b: SimOutput) {
  const al = validateV2(a), bl = validateV2(b);
  if (LEVELS_V2.indexOf(bl) !== LEVELS_V2.indexOf(al) + 1) throw new Error('바로 다음 위험 층만 비교합니다.');
  matchingMeta(a, b);
  for (const o of [a, b]) { const missing = missingRuns(o, SCENARIO, [BASE]); if (missing.length) throw new Error(`실행 없음: ${missing.join(', ')}`); }
  const result = lossChange(a, b, BASE);
  return { ...result, kind: bl === 'R3' || bl === 'R4' ? '판정' : '진단', pass: result.rate && result.count };
}
function lossChange(a: SimOutput, b: SimOutput, id: string) {
  const as = lossStats(getRuns(a, id)), bs = lossStats(getRuns(b, id));
  const pairs = [...a.meta.seeds].sort((x, y) => x - y).map((seed) => ({ seed, a: as.bySeed.find((s) => s.seed === seed)!.loss, b: bs.bySeed.find((s) => s.seed === seed)!.loss }));
  const increase = pairs.filter((p) => p.b > p.a).length, decrease = pairs.filter((p) => p.b < p.a).length;
  const rate = as.total > 0 && bs.total > 0 && 100n * (BigInt(bs.loss) * BigInt(as.total) - BigInt(as.loss) * BigInt(bs.total)) >= BigInt(as.total) * BigInt(bs.total);
  return { a: as, b: bs, pairs, increase, decrease, same: pairs.length - increase - decrease, rate, count: increase > decrease,
    differencePp: as.total && bs.total ? 100 * (bs.loss / bs.total - as.loss / as.total) : NaN };
}
export function riskCompareTablesV2(a: SimOutput, b: SimOutput): string {
  const r = compareRiskV2(a, b);
  const result = (pass: boolean) => r.kind === '판정' ? pass ? '통과' : '실패' : '진단';
  const hypothetical = (pass: boolean) => r.kind === '진단' ? ` (판정이었다면 ${pass ? '통과' : '실패'})` : '';
  const lines = [`# 위험 층 비교 v2 ${a.meta.risk!.level} → ${b.meta.risk!.level}`, '', '| 판정 | 결과 | 근거 |', '|---|---|---|',
    `| L2 ① | ${result(r.rate)} | ${r.a.loss}/${r.a.total} → ${r.b.loss}/${r.b.total}, 차이 ${num(r.differencePp)}%p${hypothetical(r.rate)} |`,
    `| L2 ② | ${result(r.count)} | 늘어남 ${r.increase}, 줄어듦 ${r.decrease}, 같음 ${r.same}${hypothetical(r.count)} |`,
    `| L2 | ${result(r.pass)} | ① ${r.a.loss}/${r.a.total} → ${r.b.loss}/${r.b.total} (${num(r.differencePp)}%p), ② 늘어남 ${r.increase}, 줄어듦 ${r.decrease}, 같음 ${r.same}; ①과 ② 모두${hypothetical(r.pass)} |`];
  if (a.meta.risk!.level === 'R0P') {
    const missing = [a, b].flatMap((o) => missingRuns(o, SCENARIO, ['TERM_GREEDY']));
    if (missing.length) lines.push(`| J9 판본 1식 | 진단 | 실행 없음: ${missing.join(', ')} |`);
    else {
      const tg = lossChange(a, b, 'TERM_GREEDY');
      lines.push(`| J9 판본 1식 | 진단 | TERM_GREEDY 변화 ${num(tg.differencePp)}%p, 기준 회사 변화 ${num(r.differencePp)}%p, 차이 ${num(tg.differencePp - r.differencePp)}%p; TERM_GREEDY 늘어남 ${tg.increase}, 줄어듦 ${tg.decrease}, 같음 ${tg.same}; 사전 기대 TERM_GREEDY − 기준 회사 = 0.00%p(판정표 v2 3.2) |`);
    }
  }
  lines.push('', `시드별 손실 수: ${JSON.stringify(r.pairs)}`);
  return lines.join('\n') + '\n';
}
