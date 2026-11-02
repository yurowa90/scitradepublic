import { loadScenario } from '../../content/scenario';
import { usdToKrwMinor } from '../risk';
import { median } from './d03';
import { rateAtV2, simConfigV2, type RiskLevelV2 } from './risk-metrics';
import { directContracts, missingRuns } from './risk-tables';
import { EXPECTATIONS, getRuns, j4dV2, LEVELS_V2, matchingMeta, num, r0Record, rejectionTotalsV2,
  SIGN_THRESHOLDS_V2, stageEvidence, validateR0, validateV2, type Evidence, type JudgmentKeyV2 } from './risk-tables-v2';
import type { SimOutput, SimRun } from './sim';
import { withLateMode } from './variants';

export type JudgmentKindV3 = '판정' | '진단' | '해당 없음' | '기록' | '관문' | '재현 기록';
export const RISK_JUDGMENT_KINDS_V3 = {
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
} as const satisfies Record<string, Record<'R0' | RiskLevelV2, JudgmentKindV3>>;
export type JudgmentKeyV3 = keyof typeof RISK_JUDGMENT_KINDS_V3;
const KEYS = Object.keys(RISK_JUDGMENT_KINDS_V3) as JudgmentKeyV3[];
const SCENARIO = 'SCENARIO_M2_OPS_COS_LAVER';
const NEW_KEYS = ['J10', '진단 J10②', '진단 X'];
export const FUNDS_NOTE_V3 = '자금 거절은 기본 분류이고 후보마다 마지막 사유만 남으며, 거래 감소와 기계적으로 연동된다. J10과 독립된 증거가 아니다(판정표 v3 3.2).';

export function judgmentKindV3(key: JudgmentKeyV3, level: 'R0' | RiskLevelV2): JudgmentKindV3 {
  return RISK_JUDGMENT_KINDS_V3[key][level];
}
function resultV3(key: JudgmentKeyV3, level: 'R0' | RiskLevelV2, pass: boolean | null, missing: string[], gateFailed: boolean): string {
  const kind = judgmentKindV3(key, level);
  if (kind === '판정' && gateFailed) return '판정 보류';
  if (kind === '관문') return pass === true ? '통과' : '실패';
  if (kind === '판정') return pass === true && !missing.length ? '통과' : '실패';
  return kind === '재현 기록' ? '기록' : kind;
}
export function judgmentRowV3(key: JudgmentKeyV3, level: 'R0' | RiskLevelV2, pass: boolean | null, evidence: string, missing: string[] = [], gateFailed = false): string {
  const kind = judgmentKindV3(key, level);
  if (kind === '해당 없음') return `| ${key} | 해당 없음 | — |`;
  const reason = missing.length ? `실행 없음: ${missing.join(', ')}; ` : kind === '판정' && pass === null ? '근거 부족: ' : '';
  return `| ${key} | ${resultV3(key, level, pass, missing, gateFailed)} | ${reason}${evidence} |`;
}
const pairsV3 = (base: SimRun[], tg: SimRun[]) => base.flatMap((b) => {
  const t = tg.find((r) => r.seed === b.seed && r.scenarioId === b.scenarioId);
  return t ? [{ base: b, tg: t }] : [];
});
const direct = (r: SimRun) => r.metrics.risk!.directAccepted;
const funds = (r: SimRun) => r.metrics.operations!.rejectionsV2!.candidate.funds;
const ratio = (a: number, b: number) => b && Number.isFinite(a / b) ? (a / b).toFixed(3) : '—';
export function j10V3(base: SimRun[], tg: SimRun[]) {
  const pairs = pairsV3(base, tg);
  let decrease = 0, increase = 0, ties = 0;
  for (const p of pairs) {
    if (direct(p.tg) < direct(p.base)) decrease++;
    else if (direct(p.tg) > direct(p.base)) increase++;
    else ties++;
  }
  const m = decrease + increase, threshold = SIGN_THRESHOLDS_V2[m];
  return { decrease, increase, ties, m, threshold, pass: m >= 10 && threshold !== undefined && decrease >= threshold,
    sumTg: pairs.reduce((s, p) => s + direct(p.tg), 0), sumBase: pairs.reduce((s, p) => s + direct(p.base), 0),
    medTg: median(pairs.map((p) => direct(p.tg))), medBase: median(pairs.map((p) => direct(p.base))) };
}
export function fundsV3(base: SimRun[], tg: SimRun[]) {
  const pairs = pairsV3(base, tg);
  let increase = 0, decrease = 0, ties = 0;
  for (const p of pairs) {
    if (funds(p.tg) > funds(p.base)) increase++;
    else if (funds(p.tg) < funds(p.base)) decrease++;
    else ties++;
  }
  const a = rejectionTotalsV2(pairs.map((p) => p.tg)), b = rejectionTotalsV2(pairs.map((p) => p.base));
  const m = increase + decrease;
  return { increase, decrease, ties, m, threshold: SIGN_THRESHOLDS_V2[m], sumTg: a.candidate.funds, sumBase: b.candidate.funds,
    percentTg: a.total ? a.candidate.funds * 100 / a.total : NaN, percentBase: b.total ? b.candidate.funds * 100 / b.total : NaN };
}

export interface FractionV3 { num: bigint; den: bigint }
function fractionMedian(xs: FractionV3[]): FractionV3 | null {
  if (!xs.length) return null;
  const i = Math.floor(xs.length / 2), b = xs[i]!;
  if (xs.length % 2) return b;
  const a = xs[i - 1]!;
  return { num: a.num * b.den + b.num * a.den, den: 2n * a.den * b.den };
}
export function fractionStatsV3(ratios: FractionV3[]) {
  const sorted = [...ratios].sort((a, b) => {
    const difference = a.num * b.den - b.num * a.den;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
  return { median: fractionMedian(sorted), q1: fractionMedian(sorted.slice(0, Math.floor(sorted.length / 2))),
    q3: fractionMedian(sorted.slice(Math.ceil(sorted.length / 2))) };
}
const percent = (f: FractionV3 | null) => f ? (Number(f.num * 100n) / Number(f.den)).toFixed(3) : '—';
export function fxDelayV3(output: SimOutput) {
  const level = validateV2(output), cfg = simConfigV2(withLateMode(loadScenario(SCENARIO), 'base'), level, output.meta.risk!.profileId);
  return ([15, 30] as const).map((d) => {
    let contracts = 0, clipped = 0, zero = 0, excluded = 0;
    const ratios: (FractionV3 & { seed: number })[] = [];
    for (const r of getRuns(output)) {
      let numerator = 0n, denominator = 0n;
      for (const c of directContracts(r)) {
        const T = Math.min(c.evaluationDay, cfg.operations!.market.publish.lastDay);
        const day0 = Math.min(c.paymentDueDay!, T), dayD = Math.min(c.paymentDueDay! + d, T), eff = dayD - day0;
        contracts++; if (eff < d) clipped++; if (eff === 0) zero++;
        numerator += BigInt(Math.abs(usdToKrwMinor(c.saleAmountMinor!, rateAtV2(cfg, r.seed, dayD))
          - usdToKrwMinor(c.saleAmountMinor!, rateAtV2(cfg, r.seed, day0))));
        denominator += BigInt(c.saleKrwAtAcceptMinor!);
      }
      if (denominator === 0n) excluded++;
      else ratios.push({ seed: r.seed, num: numerator, den: denominator });
    }
    return { d, contracts, clipped, zero, excluded, ratios, ...fractionStatsV3(ratios) };
  });
}

export function stageV3(output: SimOutput, j4d?: Evidence) {
  const old = stageEvidence(output), base = getRuns(output), tg = getRuns(output, 'TERM_GREEDY');
  const j = j10V3(base, tg), f = fundsV3(base, tg), fx = fxDelayV3(output);
  const missing = missingRuns(output, SCENARIO, ['MAX_CONTRIBUTION', 'TERM_GREEDY']);
  const rows: Record<JudgmentKeyV3, Evidence> = { ...old.rows,
    J10: { pass: j.pass, missing, evidence: `감소 ${j.decrease}/${j.m} (문턱 ${j.threshold ?? '—'}, 동점 ${j.ties}); 직접 무역 합 TG ${j.sumTg} 대 기준 ${j.sumBase}(비 ${ratio(j.sumTg, j.sumBase)}), 시드 중앙 ${num(j.medTg)} 대 ${num(j.medBase)}(비 ${ratio(j.medTg, j.medBase)})` },
    '진단 J10②': { pass: null, missing, evidence: `증가 ${f.increase}/${f.m} (문턱 ${f.threshold ?? '—'}, 동점 ${f.ties}); funds 합 TG ${f.sumTg} 대 기준 ${f.sumBase}(비 ${ratio(f.sumTg, f.sumBase)}); funds ÷ 후보 합 TG ${num(f.percentTg)}% · 기준 ${num(f.percentBase)}%` },
    '진단 X': { pass: null, missing: missingRuns(output, SCENARIO, ['MAX_CONTRIBUTION']),
      evidence: fx.map((x) => `d=${x.d} 중앙 ${percent(x.median)}% (사분위 ${percent(x.q1)}% / ${percent(x.q3)}%), 잘림 ${x.clipped}건(그중 0일 ${x.zero}건)`).join('; ') + `; 제외 시드 ${fx[0]!.excluded}` },
  };
  if (old.level === 'R4') rows.J4d = j4d ?? { ...rows.J4d, evidence: `${rows.J4d.evidence}; M′는 v3-report에서` };
  return { level: old.level, rows, fx, gateFailed: old.rows.J1.pass !== true };
}
type StageV3 = ReturnType<typeof stageV3>;
function evidenceTable(stage: StageV3, gateFailed: boolean): string[] {
  return ['', '| 판정 | 결과 | 근거 |', '|---|---|---|', ...KEYS.filter((k) => judgmentKindV3(k, stage.level) !== '해당 없음').map((k) => {
    const e = stage.rows[k]; return judgmentRowV3(k, stage.level, e.pass, e.evidence, e.missing, gateFailed);
  }), '', FUNDS_NOTE_V3];
}
const stopLine = (failures: string[]) => `**멈춤: J1 관문 실패(${failures.join(', ')}). 판정표 v3 3.5에 따라 측정을 멈추고 원인을 보고한다.**`;
export function d03TablesV3(output: SimOutput): string {
  const s = stageV3(output), risk = output.meta.risk!;
  const lines = [`# D03 v3 단계 표 (${s.level})`, '',
    `시드 ${output.meta.seeds[0]}~${output.meta.seeds.at(-1)} (${output.meta.seeds.length}개) · 실행 ${output.runs.length}회 · 프로필 ${risk.profileId} · 조정 회차 ${risk.tuningRound} · marketRulesSha256 ${risk.marketRulesSha256.slice(0, 12)}`];
  if (s.gateFailed) lines.push('', stopLine([s.level]));
  lines.push('', '## 판정·관문·진단(판정표 v3)', ...evidenceTable(s, s.gateFailed), '', '### J10 시드별 부호', '',
    '| 시드 | TG 직접 무역 | 기준 직접 무역 | 부호 | TG funds | 기준 funds | 부호 |', '|---|---:|---:|---|---:|---:|---|');
  const base = getRuns(output), tg = getRuns(output, 'TERM_GREEDY');
  for (const seed of [...output.meta.seeds].sort((a, b) => a - b)) {
    const b = base.find((r) => r.seed === seed), t = tg.find((r) => r.seed === seed);
    const sign = (value: (r: SimRun) => number) => !b || !t ? '실행 없음' : value(t) < value(b) ? '감소' : value(t) > value(b) ? '증가' : '동점';
    lines.push(`| ${seed} | ${t ? direct(t) : '—'} | ${b ? direct(b) : '—'} | ${sign(direct)} | ${t ? funds(t) : '—'} | ${b ? funds(b) : '—'} | ${sign(funds)} |`);
  }
  lines.push('', '### 진단 X 계약 잘림', '', '| d | 대상 계약 | eff < d | eff = 0 | 제외 시드 |', '|---|---:|---:|---:|---:|',
    ...s.fx.map((x) => `| ${x.d} | ${x.contracts} | ${x.clipped} | ${x.zero} | ${x.excluded} |`), '',
    '판본 2 표(진단 U·거절 정책별, ①~⑧)는 같은 파일로 sim v2-tables를 돌려 본다. 판본 2 판정 칸의 통과·실패는 v3에서 재현 기록이다.');
  return lines.join('\n') + '\n';
}

export function validateShaV3(outputs: SimOutput[], sha?: string): void {
  if (sha === undefined) throw new Error('v3 표는 현재 자료 sha 검사 함수가 필요합니다.');
  if (outputs.some((o) => o.meta.risk?.marketRulesSha256 !== sha)) throw new Error('v3 표는 현재 자료와 같은 sha의 출력만 받습니다.');
}
export interface R0InputsV3 { base?: SimOutput; oos?: SimOutput; basePath?: string; oosPath?: string }
function orderedBundle(outputs: SimOutput[]): SimOutput[] {
  if (outputs.length !== 5) throw new Error('다섯 단계 출력이 필요합니다.');
  const levels = outputs.map(validateV2);
  if (new Set(levels).size !== 5) throw new Error('단계 중복·누락: R0P·R1·R2·R3·R4가 하나씩 필요합니다.');
  for (const o of outputs) matchingMeta(outputs[0]!, o);
  return LEVELS_V2.map((level) => outputs.find((o) => o.meta.risk!.level === level)!);
}
export function v3Report(base: SimOutput[], oos?: SimOutput[], r0s: R0InputsV3 = {}): string {
  const groups = [{ label: '기준', outputs: orderedBundle(base), r0: r0s.base, path: r0s.basePath },
    ...(oos ? [{ label: '표본 밖 1', outputs: orderedBundle(oos), r0: r0s.oos, path: r0s.oosPath }] : [])];
  if (r0s.oos && !oos) throw new Error('--oos-r0은 --oos가 필요합니다.');
  if (oos) {
    const a = groups[0]!.outputs[0]!, b = groups[1]!.outputs[0]!;
    // 묶음 사이에서는 시드만 달라야 한다. v2 검사에 같은 시드를 주고 나머지 메타를 그대로 검증한다.
    matchingMeta(a, { ...b, meta: { ...b.meta, seeds: a.meta.seeds } });
    if (a.meta.seeds.some((seed) => b.meta.seeds.includes(seed))) throw new Error('기준·표본 밖 시드 집합이 겹칩니다.');
  }
  const bundles = groups.map((g) => {
    if (g.r0) validateR0(g.r0, g.outputs[0]!);
    const j4 = j4dV2(g.outputs[0]!, g.outputs[4]!);
    const stages = g.outputs.map((o) => stageV3(o, j4));
    return { ...g, stages, gateFailed: stages.some((s) => s.gateFailed) };
  });
  const lines = ['# 판정표 v3 보고', ''];
  for (const b of bundles) {
    const { meta } = b.outputs[0]!, risk = meta.risk!;
    lines.push(`${b.label}: 시드 ${Math.min(...meta.seeds)}~${Math.max(...meta.seeds)} (${meta.seeds.length}개) · 프로필 ${risk.profileId} · 조정 회차 ${risk.tuningRound}`,
      `marketRulesSha256 ${risk.marketRulesSha256} · engineVersion ${meta.engineVersion} · dataVersion ${meta.dataVersion}`,
      b.outputs.map((o) => `${o.meta.risk!.level} 실행 ${o.runs.length}회`).join(' · '), b.r0 ? `R0 입력: ${b.path ?? '선택 입력'} (실행 ${b.r0.runs.length}회)` : 'R0 입력 없음');
  }
  const failures = bundles.flatMap((b) => b.stages.filter((s) => s.gateFailed).map((s) => `${b.label} ${s.level}`));
  if (failures.length) lines.push('', stopLine(failures));
  const cell = (key: JudgmentKeyV3, index: number, bundleIndex: number) => {
    const b = bundles[bundleIndex]; if (!b) return '측정 전';
    const s = b.stages[index]!, e = s.rows[key]; return resultV3(key, s.level, e.pass, e.missing, b.gateFailed);
  };
  lines.push('', '## J1 관문', '', '| 단계 | 기준 | 표본 밖 1 |', '|---|---|---|',
    ...LEVELS_V2.map((l, i) => `| ${l} | ${cell('J1', i, 0)} | ${cell('J1', i, 1)} |`),
    '', '## J10 최종(판정표 v3 4절: 네 검정 모두 통과)', '', '| 검정 | 기준 | 표본 밖 1 |', '|---|---|---|');
  const results = [0, 4].flatMap((i) => [cell('J10', i, 0), cell('J10', i, 1)]);
  const final = failures.length ? '판정 보류' : !oos ? '미정' : results.includes('실패') ? '실패' : '통과';
  for (const i of [0, 4]) lines.push(`| ${LEVELS_V2[i]} | ${cell('J10', i, 0)} | ${cell('J10', i, 1)} |`);
  lines.push(`| 최종 | ${final} | ${oos ? final : '측정 전'} |`);
  for (const [i, label] of ['기준', '표본 밖 1'].entries()) {
    lines.push('', `## 6열 표(${label})`, '');
    const b = bundles[i]; if (!b) { lines.push('측정 전'); continue; }
    lines.push('| 키 | R0 | R0P | R1 | R2 | R3 | R4 |', '|---|---|---|---|---|---|---|');
    for (const key of KEYS) lines.push(`| ${key} | ${NEW_KEYS.includes(key) ? '기록 없음' : r0Record(key as JudgmentKeyV2, b.r0)} | ${LEVELS_V2.map((_, j) => cell(key, j, i)).join(' | ')} |`);
  }
  for (const b of bundles) for (const s of b.stages) lines.push('', `### ${b.label} ${s.level}`, ...evidenceTable(s, b.gateFailed));
  lines.push('', ...Object.entries(EXPECTATIONS).map(([k, v]) => `${k} 사전 기대: ${v}`),
    'J10은 재현 판정이다. 가설과 판정 단계의 선택, 사전 기대의 근거가 모두 이미 본 자료에서 나왔다(판정표 v3 3.3).',
    '시드별 감소 시드 수는 이 보고에서 처음 센다.',
    'L2와 J9 판본 1식(R0P→R1)은 묶음마다 risk-compare-v2 네 쌍의 출력에서 재현 기록으로 읽는다.');
  return lines.join('\n') + '\n';
}

/** 출력과 종료 코드는 같은 J1 근거를 사용한다. */
export function gateFailedV3(outputs: SimOutput[]): boolean {
  return outputs.some((o) => stageEvidence(o).rows.J1.pass !== true);
}
