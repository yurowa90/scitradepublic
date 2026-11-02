import { loadScenario, OPERATIONS_SCENARIO_IDS } from '../../content/scenario';
import type { ScenarioConfig } from '../types';
import type { RiskContract, RiskLevel } from './risk-metrics';
import type { SimOutput, SimRun } from './sim';

export const isSingleGoodVariant = (config: ScenarioConfig) => config.operations!.market.trade.goods.length === 1;
export type JudgmentKind = '판정' | '진단' | '해당 없음';
// 열 순서 R0, R1, R2, R3. L2는 두 출력의 비교에서만 판정한다.
export const RISK_JUDGMENT_KINDS = {
  J1: ['판정', '판정', '판정', '판정'], J2: ['판정', '해당 없음', '해당 없음', '판정'],
  J2b: ['진단', '해당 없음', '해당 없음', '진단'], J3: ['판정', '해당 없음', '해당 없음', '판정'],
  'J4a~c': ['판정', '판정', '판정', '판정'], J4d: ['판정', '진단', '진단', '판정'],
  J5: ['판정', '해당 없음', '해당 없음', '판정'], J6: ['판정', '해당 없음', '해당 없음', '판정'],
  'J7(옛 정의)': ['판정', '진단', '진단', '진단'], 'J7(새 정의)': ['진단', '진단', '진단', '판정'],
  L0: ['판정', '해당 없음', '해당 없음', '해당 없음'], L1: ['해당 없음', '진단', '진단', '판정'],
  L3: ['해당 없음', '진단', '진단', '판정'], D: ['판정', '진단', '진단', '판정'],
  '진단 T': ['해당 없음', '해당 없음', '진단', '진단'], '진단 C': ['해당 없음', '진단', '진단', '진단'],
  '진단 F': ['해당 없음', '진단', '해당 없음', '진단'], '진단 B': ['해당 없음', '진단', '진단', '진단'],
} as const satisfies Record<string, readonly JudgmentKind[]>;
export type JudgmentId = keyof typeof RISK_JUDGMENT_KINDS;
export function judgmentKind(id: JudgmentId, level: RiskLevel, single: boolean): JudgmentKind {
  return id === 'D' && single ? '해당 없음' : RISK_JUDGMENT_KINDS[id][Number(level[1])]!;
}
export function judgmentRow(id: JudgmentId, level: RiskLevel, single: boolean, pass: boolean | null, evidence: string, missing: string[] = []): string {
  const kind = judgmentKind(id, level, single);
  const reason = kind !== '판정' ? '' : missing.length ? `실행 없음: ${missing.join(', ')}; ` : pass === null ? '근거 부족: ' : '';
  return `| ${id} | ${kind === '판정' ? missing.length || pass !== true ? '실패' : '통과' : kind} | ${reason}${evidence} |`;
}
export const L3_THRESHOLDS: Readonly<Record<number, number>> = { 10: 9, 11: 9, 12: 10, 13: 10, 14: 11, 15: 12, 16: 12, 17: 13, 18: 13, 19: 14, 20: 15 };
export const J4_BANDS = { R0: [1060000, 2120000], risk: [1069200, 2138500] } as const;
export const comparisonValue = (level?: RiskLevel): ((r: SimRun) => number) =>
  level && level !== 'R0' ? (r) => r.metrics.risk?.analysisValueMinor ?? NaN : (r) => r.metrics.currencies.USD!.netAssets;
const median = (xs: number[]): number => { const s = [...xs].sort((a, b) => a - b), i = Math.floor(s.length / 2); return !s.length ? NaN : s.length % 2 ? s[i]! : (s[i - 1]! + s[i]!) / 2; };
const num = (n: number) => Number.isFinite(n) ? n.toFixed(2) : '—';
export const directContracts = (r: SimRun) => r.metrics.risk!.contracts.filter((c) => c.kind === 'DIRECT_TRADE');
const lossCount = (cs: RiskContract[]) => cs.filter((c) => c.realized < 0).length;
export function lossStats(runs: SimRun[]) {
  const contracts = runs.flatMap(directContracts);
  const bySeed = runs.map((r) => { const cs = directContracts(r); return { seed: r.seed, loss: lossCount(cs), total: cs.length }; });
  const classes = (['열린', '완료', '취소'] as const).map((kind) => {
    const cs = contracts.filter((c) => c.class === kind); return { class: kind, loss: lossCount(cs), total: cs.length };
  });
  const ratios = bySeed.filter((x) => x.total).map((x) => x.loss / x.total).sort((a, b) => a - b);
  const middle = Math.floor(ratios.length / 2);
  return { loss: lossCount(contracts), total: contracts.length, bySeed, classes,
    sensitivityLoss: contracts.filter((c) => (c.class === '열린' ? c.openFixedRateKrw : c.realized) < 0).length,
    median: median(ratios), q1: median(ratios.slice(0, middle)), q3: median(ratios.slice(Math.ceil(ratios.length / 2))) };
}
export const lossBandPasses = (loss: number, total: number) => total > 0 && 20n * BigInt(loss) >= BigInt(total) && 4n * BigInt(loss) <= BigInt(total);
/** 옛 USD 비중도 위험 판정에서는 분수의 중앙을 정수로 비교한다. */
export function oldJ7Passes(runs: SimRun[]): boolean | null {
  const ratios = runs.map((r) => {
    const b = r.metrics.operations!.currencies.USD!.business;
    const a = BigInt(b.directTrade), total = a + BigInt(b.handlingForwarding) + BigInt(b.standardForwarding);
    return total === 0n ? { a: 0n, b: 1n } : total < 0n ? { a: -a, b: -total } : { a, b: total };
  }).sort((x, y) => { const d = x.a * y.b - y.a * x.b; return d < 0n ? -1 : d > 0n ? 1 : 0; });
  if (!ratios.length) return null;
  const i = Math.floor(ratios.length / 2), right = ratios[i]!, left = ratios.length % 2 ? right : ratios[i - 1]!;
  return 2n * (left.a * right.b + right.a * left.b) >= left.b * right.b;
}
export function newJ7(runs: SimRun[]) {
  const ratios = runs.flatMap((r) => {
    const cs = r.metrics.risk!.contracts, a = cs.filter((c) => c.kind === 'DIRECT_TRADE').reduce((s, c) => s + BigInt(c.realized), 0n);
    const b = cs.reduce((s, c) => s + BigInt(c.realized), 0n); return b > 0n ? [{ a, b }] : [];
  }).sort((x, y) => { const d = x.a * y.b - y.a * x.b; return d < 0n ? -1 : d > 0n ? 1 : 0; });
  const n = ratios.length, i = Math.floor(n / 2), right = ratios[i], left = n % 2 ? right : ratios[i - 1];
  const numerator = left && right ? left.a * right.b + right.a * left.b : 0n;
  const denominator = left && right ? 2n * left.b * right.b : 0n;
  return { n, excluded: runs.length - n, numerator, denominator,
    pass: n < 10 ? null : 4n * numerator >= denominator, percent: denominator ? Number(numerator) / Number(denominator) * 100 : NaN };
}
export function marginComparison(base: SimRun[], mb: SimRun[]) {
  const a = lossStats(base), b = lossStats(mb);
  let m = 0, wins = 0;
  for (const x of a.bySeed) {
    const y = b.bySeed.find((y) => y.seed === x.seed);
    if (!y || !x.total || !y.total) continue;
    const difference = BigInt(y.loss) * BigInt(x.total) - BigInt(x.loss) * BigInt(y.total);
    if (!difference) continue;
    m++; if (difference < 0n) wins++;
  }
  const reduction = a.total > 0 && b.total > 0 && 4n * BigInt(b.loss) * BigInt(a.total) <= 3n * BigInt(a.loss) * BigInt(b.total);
  const sign = m >= 10 && L3_THRESHOLDS[m] !== undefined && wins >= L3_THRESHOLDS[m]!;
  const volume = b.total >= 30 && 2n * BigInt(b.total) >= BigInt(a.total);
  return { a, b, m, wins, reduction, sign, volume, pass: m < 10 ? null : reduction && sign && volume };
}
export function diversity(base: SimRun[], focus: SimRun[], value: (r: SimRun) => number) {
  let expandWins = 0, focusWins = 0, pairs = 0;
  for (const r of base) {
    const f = focus.find((f) => f.seed === r.seed && f.scenarioId === r.scenarioId);
    if (!f || !Number.isFinite(value(r)) || !Number.isFinite(value(f))) continue;
    pairs++; if (value(r) > value(f)) expandWins++; if (value(f) > value(r)) focusWins++;
  }
  return { expandWins, focusWins, pairs, pass: pairs ? 20n * BigInt(expandWins) >= 3n * BigInt(pairs) && 20n * BigInt(focusWins) >= 3n * BigInt(pairs) : null };
}
export function diagnostics(runs: SimRun[], base: SimRun[], seeds: readonly number[]) {
  const cs = base.flatMap(directContracts), onTime = cs.filter((c) => c.onTime), negative = cs.filter((c) => c.components.fx < 0);
  const uniqueSeeds = [...new Set(seeds)];
  const causes: Record<string, number> = {};
  for (const c of cs.filter((c) => c.realized < 0)) {
    const worst = (['fx', 'tariff', 'surcharge', 'claim', 'collection', 'late', 'cancel'] as const)
      .filter((k) => c.components[k] < 0).sort((a, b) => c.components[a] - c.components[b])[0];
    const key = worst ?? '음수 칸 없음'; causes[key] = (causes[key] ?? 0) + 1;
  }
  return { tariff: { affected: onTime.filter((c) => c.components.tariff !== 0).length, total: onTime.length }, causes,
    fx: { affected: negative.length, total: cs.length, median: median(cs.map((c) => c.components.fx)) },
    bounds: { affected: uniqueSeeds.filter((seed) => runs.some((r) => r.seed === seed && r.metrics.risk!.referenceRateBounds)).length, total: uniqueSeeds.length } };
}
export function missingRuns(output: SimOutput, scenarioId: string, ids: readonly string[]): string[] {
  return ids.flatMap((id) => output.meta.seeds.filter((seed) => !output.runs.some((r) => r.scenarioId === scenarioId && r.policyId === id && r.seed === seed))
    .map((seed) => `${scenarioId}/${id}/${seed}`));
}
export function riskTables(output: SimOutput): string {
  const risk = output.meta.risk!;
  if (risk.rules !== undefined) throw new Error('v1 표는 rules 메타가 있는 출력을 받지 않습니다.');
  const level = risk.level, value = comparisonValue(level);
  const lines = ['', '## ⑨ 위험 판정', ''];
  for (const scenarioId of output.meta.scenarioIds) {
    const single = isSingleGoodVariant(loadScenario(scenarioId as Parameters<typeof loadScenario>[0]));
    const runs = output.runs.filter((r) => r.scenarioId === scenarioId), get = (id: string) => runs.filter((r) => r.policyId === id);
    const base = get('MAX_CONTRIBUTION'), a = lossStats(base), mb = marginComparison(base, get('MARGIN_BUFFER')), j7 = newJ7(base), d = diversity(base, get('FOCUS'), value), diag = diagnostics(runs, base, output.meta.seeds);
    lines.push(`### ${scenarioId}`, '', '| 판정 | 결과 | 근거 |', '|---|---|---|');
    const row = (id: JudgmentId, pass: boolean | null, evidence: string, ids = ['MAX_CONTRIBUTION']) => lines.push(judgmentRow(id, level, single, pass, evidence, missingRuns(output, scenarioId, ids)));
    row('J7(새 정의)', j7.pass, `중앙 ${num(j7.percent)}%, 남은 시드 ${j7.n}, 분모 ≤ 0 제외 ${j7.excluded}`);
    row('L0', base.length ? a.loss === 0 : null, `기준 손실 ${a.loss}/${a.total}; LATE_OK 손실 ${get('LATE_OK').length ? lossStats(get('LATE_OK')).loss : '—'} (기록만)`);
    row('L1', a.total ? lossBandPasses(a.loss, a.total) : null, `모은 손실 ${a.loss}/${a.total}`);
    row('L3', mb.pass, `① ${mb.reduction ? '충족' : '미충족'} (${mb.b.loss}/${mb.b.total} 대 ${a.loss}/${a.total}), ② ${mb.wins}/${mb.m} (문턱 ${L3_THRESHOLDS[mb.m] ?? '—'}), ③ ${mb.volume ? '충족' : '미충족'} (${mb.b.total}건)`, ['MAX_CONTRIBUTION', 'MARGIN_BUFFER']);
    row('D', d.pass, `EXPAND(MAX_CONTRIBUTION) ${d.expandWins}, FOCUS ${d.focusWins}, 짝 ${d.pairs}`, ['MAX_CONTRIBUTION', 'FOCUS']);
    row('진단 T', null, `${diag.tariff.affected}/${diag.tariff.total}`);
    row('진단 C', null, JSON.stringify(diag.causes));
    row('진단 F', null, `${diag.fx.affected}/${diag.fx.total}, fx 중앙 ${num(diag.fx.median)}원`);
    row('진단 B', null, `${diag.bounds.affected}/${diag.bounds.total}`, []);
    lines.push('', `L2 재료: ${a.loss}/${a.total}; 시드별 ${JSON.stringify(a.bySeed)}`,
      `완료·분류별 손실: ${JSON.stringify(a.classes)}; 열린 고정 환율 민감도 ${a.sensitivityLoss}/${a.total}`,
      `시드별 손실 비율 중앙 ${num(a.median * 100)}%, 사분위 ${num(a.q1 * 100)}% / ${num(a.q3 * 100)}%`,
      `(iii) 재료: 합 ${base.reduce((s, r) => s + r.metrics.risk!.directAccepted, 0)}; 시드별 ${JSON.stringify(base.map((r) => ({ seed: r.seed, directAccepted: r.metrics.risk!.directAccepted })))}`, '');
  }
  lines.push('### 변형 사이 차이', '', '변형 사이: 생성기 묶음이 다름(H19-1)', '', '| 비교 | 시드 | 비교 값 차이 |', '|---|---:|---:|');
  for (let i = 1; i < output.meta.scenarioIds.length; i++) for (let j = 0; j < i; j++) for (const seed of output.meta.seeds) {
    const a = output.runs.find((r) => r.scenarioId === output.meta.scenarioIds[j] && r.seed === seed && r.policyId === 'MAX_CONTRIBUTION');
    const b = output.runs.find((r) => r.scenarioId === output.meta.scenarioIds[i] && r.seed === seed && r.policyId === 'MAX_CONTRIBUTION');
    lines.push(`| ${output.meta.scenarioIds[i]} − ${output.meta.scenarioIds[j]} | ${seed} | ${a && b ? num(value(b) - value(a)) : '—'} |`);
  }
  return lines.join('\n') + '\n';
}

export function compareRisk(a: SimOutput, b: SimOutput) {
  if (a.meta.risk?.rules !== undefined || b.meta.risk?.rules !== undefined) throw new Error('v1 risk-compare는 rules 메타가 있는 출력을 받지 않습니다.');
  const ar = a.meta.risk, br = b.meta.risk;
  if (!ar || !br) throw new Error('risk 메타가 필요합니다.');
  if (!['R0', 'R1', 'R2'].includes(ar.level) || ['R0', 'R1', 'R2', 'R3'].indexOf(br.level) !== ['R0', 'R1', 'R2', 'R3'].indexOf(ar.level) + 1) throw new Error('바로 다음 위험 층만 비교합니다.');
  for (const key of ['profileId', 'tuningRound', 'marketRulesSha256'] as const) if (ar[key] !== br[key]) throw new Error(`다른 메타: ${key}`);
  for (const key of ['engineVersion', 'dataVersion', 'format', 'lateMode', 'scenarioIds'] as const) if (JSON.stringify(a.meta[key]) !== JSON.stringify(b.meta[key])) throw new Error(`다른 메타: ${key}`);
  if (JSON.stringify([...a.meta.seeds].sort((x, y) => x - y)) !== JSON.stringify([...b.meta.seeds].sort((x, y) => x - y))) throw new Error('다른 메타: seeds');
  return a.meta.scenarioIds.map((scenarioId) => {
    for (const output of [a, b]) {
      const missing = missingRuns(output, scenarioId, ['MAX_CONTRIBUTION']);
      if (missing.length) throw new Error(`실행 없음: ${missing.join(', ')}`);
    }
    const get = (o: SimOutput) => o.runs.filter((r) => r.scenarioId === scenarioId && r.policyId === 'MAX_CONTRIBUTION');
    const as = lossStats(get(a)), bs = lossStats(get(b));
    const pairs = [...a.meta.seeds].sort((x, y) => x - y).map((seed) => ({ seed, a: as.bySeed.find((r) => r.seed === seed)!.loss, b: bs.bySeed.find((r) => r.seed === seed)!.loss }));
    const increase = pairs.filter((p) => p.b > p.a).length, decrease = pairs.filter((p) => p.b < p.a).length;
    const rate = as.total > 0 && bs.total > 0 && 100n * (BigInt(bs.loss) * BigInt(as.total) - BigInt(as.loss) * BigInt(bs.total)) >= BigInt(as.total) * BigInt(bs.total);
    const count = increase > decrease;
    const sum = (o: SimOutput) => get(o).reduce((s, r) => s + r.metrics.risk!.directAccepted, 0);
    return { scenarioId, a: { loss: as.loss, total: as.total }, b: { loss: bs.loss, total: bs.total },
      differencePp: as.total && bs.total ? 100 * (bs.loss / bs.total - as.loss / as.total) : null,
      rate, increase, decrease, same: pairs.length - increase - decrease, count, pass: rate && count, pairs,
      ...(ar.level === 'R0' && (OPERATIONS_SCENARIO_IDS as readonly string[]).includes(scenarioId) ? {
        iii: { a: sum(a), b: sum(b), pass: 2n * BigInt(sum(b)) >= BigInt(sum(a)),
          pairs: [...a.meta.seeds].sort((x, y) => x - y).map((seed) => ({ seed, a: get(a).find((r) => r.seed === seed)!.metrics.risk!.directAccepted, b: get(b).find((r) => r.seed === seed)!.metrics.risk!.directAccepted })) } } : {}) };
  });
}
export function riskCompareTables(a: SimOutput, b: SimOutput): string {
  return `# 위험 층 비교 ${a.meta.risk?.level} → ${b.meta.risk?.level}\n\n` + compareRisk(a, b).map((r) =>
    `## ${r.scenarioId}\n\n| 판정 | 결과 | 근거 |\n|---|---|---|\n| L2 ① | ${r.rate ? '통과' : '실패'} | ${r.a.loss}/${r.a.total} → ${r.b.loss}/${r.b.total}, 차이 ${num(r.differencePp ?? NaN)}%p |\n| L2 ② | ${r.count ? '통과' : '실패'} | 늘어남 ${r.increase}, 줄어듦 ${r.decrease}, 같음 ${r.same} |\n| L2 | ${r.pass ? '통과' : '실패'} | ①과 ② 모두 |\n시드별 손실 수: ${JSON.stringify(r.pairs)}\n` +
    (r.iii ? `\n(iii): ${r.iii.pass ? '통과' : '실패'}, R0 ${r.iii.a}, R1 ${r.iii.b}\n시드별 직접 무역 수: ${JSON.stringify(r.iii.pairs)}\n` : '')).join('\n');
}
