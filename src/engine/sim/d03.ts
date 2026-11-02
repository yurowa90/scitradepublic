import { withRiskLevel } from '../risk';
import { simConfigV2, type RiskLevel, type RiskLevelV2, type RiskMeta } from './risk-metrics';
import { comparisonValue, isSingleGoodVariant, J4_BANDS, judgmentRow, missingRuns, riskTables, oldJ7Passes, type JudgmentId } from './risk-tables';
import { loadScenario, OPERATIONS_SCENARIO_IDS, EXPERIMENT_SCENARIO_IDS, riskProfiles, loadCreditProfile } from '../../content/scenario';
import { ENGINE_VERSION } from '../types';
import { policyById } from './policies';
import { simulate, SIM_FORMAT, SIM_SEEDS, type SimOutput, type SimRun } from './sim';
import { d03PolicyIds, d03PolicyIdsV2, parseVariant, variantName, withLateMode, type Investment, type LateMode } from './variants';

// 모형 판정 4의 개연성 점검. 상한은 Q14(2026-10-13)에서 시작 분석값의 1.8배 → 2.0배로 다시 정함.
const J4_NET_MIN_MINOR = 1060000;
const J4_NET_MAX_MINOR = 2120000;

export function median(values: readonly number[]): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b), i = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[i]! : (sorted[i - 1]! + sorted[i]!) / 2;
}
export const usdAssets = (r: SimRun) => r.metrics.currencies.USD!.netAssets;
const unpaid = (r: SimRun) => r.metrics.operations!.unpaidAtEnd.find((x) => x.currency === 'KRW')?.amountMinor ?? 0;
const healthy = (r: SimRun) => r.metrics.operations!.outcome !== 'FAILED' && unpaid(r) === 0;
export interface Cell { median: number; gains: number; failures: number; n: number; arrow: string }
export function cell(runs: SimRun[], baselines: SimRun[], value = usdAssets): Cell {
  const pairs = runs.map((r) => ({ r, b: baselines.find((b) => b.seed === r.seed && b.scenarioId === r.scenarioId) }));
  if (pairs.some((p) => !p.b)) return { median: NaN, gains: 0, failures: 0, n: 0, arrow: '' };
  const diffs = pairs.map(({ r, b }) => value(r) - value(b!)), n = diffs.length;
  const m = median(diffs), gains = pairs.filter(({ r, b }) => value(r) > value(b!) && healthy(r)).length;
  const failures = runs.filter((r) => r.metrics.operations!.outcome === 'FAILED').length;
  return { median: m, gains, failures, n, arrow: n < 10 ? '' : m >= 30000 && 4 * gains >= 3 * n && 20 * failures <= n ? '↑' : m <= -30000 && 4 * gains <= n ? '↓' : '' };
}
export function predictJ6(rows: { extraJobsPerWeek: number; usableAfter: number }[]) {
  const value = median(rows.map((r) => r.extraJobsPerWeek));
  return { value, arrow: Number.isNaN(value) ? '' : value >= 0.5 ? '↑' : '↓' };
}
export function baselineId(id: string): string {
  const v = parseVariant(id)!;
  return variantName(v.early ? { ...v, early: false } : v.hires.length ? { ...v, hires: [] } : { ...v, investment: 'none' });
}
export interface D03Options { seeds?: readonly number[]; policyIds?: readonly string[]; late?: LateMode; scenarioIds?: readonly string[];
  risk?: RiskLevel | RiskLevelV2; riskV2?: boolean; profileId?: string; tuningRound?: number; marketRulesSha256?: string }
export function requestedRisk(options: D03Options): RiskMeta | undefined {
  if (!options.risk) {
    if (options.tuningRound !== undefined) throw new Error('--round는 --risk가 필요합니다.');
    return undefined;
  }
  if (!(options.riskV2 ? ['R0P', 'R1', 'R2', 'R3', 'R4'] : ['R0', 'R1', 'R2', 'R3']).includes(options.risk)) throw new Error('알 수 없는 위험 층');
  const tuningRound = options.tuningRound ?? 0;
  if (!Number.isInteger(tuningRound) || tuningRound < 0 || tuningRound > 3) throw new Error('조정 회차는 0~3입니다.');
  const profiles = riskProfiles().filter((p) => p.id === 'RISK_PROFILE_DEFAULT');
  if (!profiles.length) throw new Error('공유 위험 프로필은 하나여야 합니다.');
  if (!options.marketRulesSha256 || !/^[a-f0-9]{64}$/.test(options.marketRulesSha256)) throw new Error('자료 sha256이 필요합니다.');
  if (options.riskV2) {
    const profileId = options.profileId ?? 'RISK_PROFILE_V2';
    loadCreditProfile(profileId);
    return { rules: 'M2a-rules-4', level: options.risk as RiskLevelV2, profileId, tuningRound, marketRulesSha256: options.marketRulesSha256 };
  }
  return { level: options.risk as RiskLevel, profileId: profiles[0]!.id, tuningRound, marketRulesSha256: options.marketRulesSha256 };
}
export function workerOptions(options: D03Options, i: number, count: number): D03Options {
  return { ...options, seeds: (options.seeds ?? SIM_SEEDS).filter((_, j) => j % count === i) };
}
export function runD03(options: D03Options = {}): SimOutput {
  const seeds = [...(options.seeds ?? SIM_SEEDS)], policyIds = [...(options.policyIds ?? (options.riskV2 ? d03PolicyIdsV2(options.risk as RiskLevelV2) : d03PolicyIds(options.late)))];
  if (!seeds.length || new Set(seeds).size !== seeds.length || new Set(policyIds).size !== policyIds.length) throw new Error('빈 시드 또는 중복 실행 키입니다.');
  const runs: SimRun[] = [];
  const risk = requestedRisk(options), scenarioIds = [...(options.scenarioIds ?? (options.riskV2 ? ['SCENARIO_M2_OPS_COS_LAVER'] : OPERATIONS_SCENARIO_IDS))];
  if (!scenarioIds.length || new Set(scenarioIds).size !== scenarioIds.length) throw new Error('빈 목록 또는 중복 시나리오입니다.');
  const configs = scenarioIds.map((id) => {
    if (!([...OPERATIONS_SCENARIO_IDS, ...EXPERIMENT_SCENARIO_IDS] as string[]).includes(id)) throw new Error(`알 수 없는 시나리오: ${id}`);
    if (!risk && (EXPERIMENT_SCENARIO_IDS as readonly string[]).includes(id)) throw new Error('실험 시나리오는 --risk가 필요합니다.');
    if (options.riskV2 && id !== 'SCENARIO_M2_OPS_COS_LAVER') throw new Error('v2는 (다) 시나리오만 실행합니다.');
    const config = withLateMode(loadScenario(id as Parameters<typeof loadScenario>[0]), options.late ?? 'base');
    return risk?.rules ? simConfigV2(config, risk.level, risk.profileId)
      : risk ? withRiskLevel(config, risk.level, riskProfiles()[0]!) : config;
  });
  for (const config of configs) for (const id of policyIds) {
    if (!options.riskV2 && ['TERM_GREEDY', 'CREDIT_AWARE'].includes(parseVariant(id)?.acceptance ?? '')) throw new Error('외상 정책은 --risk-v2가 필요합니다.');
    const policy = policyById(id);
    if (!policy) throw new Error(`알 수 없는 정책: ${id}`);
    for (const seed of seeds) runs.push(simulate(config, policy, seed, undefined, risk?.level).run);
  }
  return ordered({ meta: { tool: 'scitrade-sim', format: SIM_FORMAT, engineVersion: ENGINE_VERSION, dataVersion: configs[0]!.dataVersion,
    scenarioIds, policyIds, seeds, lateMode: options.late ?? 'base', ...(risk ? { risk } : {}) }, runs });
}
function key(r: SimRun) { return JSON.stringify([r.scenarioId, r.policyId, r.seed]); }
function ordered(out: SimOutput): SimOutput {
  out.runs.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  out.meta.policyIds.sort(); out.meta.scenarioIds.sort(); out.meta.seeds.sort((a, b) => a - b); return out;
}
export function mergeD03(outputs: SimOutput[], late: LateMode, risk?: RiskMeta): SimOutput {
  if (!outputs.length) throw new Error('합칠 실행이 없습니다.');
  const seen = new Set<string>(), first = outputs[0]!;
  for (const o of outputs) {
    const actual = o.meta.risk;
    if (!!actual !== !!risk || (actual && risk && (Object.keys(actual).length !== Object.keys(risk).length
      || (Object.keys(risk) as (keyof RiskMeta)[]).some((key) => actual[key] !== risk[key])))) throw new Error('요청과 다른 위험 메타입니다.');
    if (o.meta.lateMode !== late || o.meta.engineVersion !== first.meta.engineVersion || o.meta.dataVersion !== first.meta.dataVersion || o.meta.format !== SIM_FORMAT) throw new Error('감액·엔진·자료·형식 판본이 다른 실행입니다.');
    for (const r of o.runs) { const k = key(r); if (seen.has(k)) throw new Error(`중복 실행 키: ${k}`); seen.add(k); }
  }
  const runs = outputs.flatMap((o) => o.runs);
  return ordered({ meta: { ...first.meta, scenarioIds: [...new Set(runs.map((r) => r.scenarioId))], policyIds: [...new Set(runs.map((r) => r.policyId))], seeds: [...new Set(runs.map((r) => r.seed))] }, runs });
}
export function d03Tables(output: SimOutput): string {
  const mode = output.meta.lateMode ?? 'base', risk = output.meta.risk;
  if (risk?.rules !== undefined) throw new Error('v1 표는 rules 메타가 있는 출력을 받지 않습니다.');
  const value = comparisonValue(risk?.level), analysis = risk && risk.level !== 'R0';
  const comparisonUnit = analysis ? '분석값' : 'USD';
  const dollars = (minor: number, sign = false) => Number.isNaN(minor) ? risk ? '—' : '미측정' : `${sign && minor >= 0 ? '+' : ''}${Math.round(minor / 100).toLocaleString('en-US')}`;
  const display = (c: Cell) => c.n ? `${dollars(c.median, true)} (${c.gains})${c.arrow ? ` ${c.arrow}` : ''}` : risk ? '—' : '미측정';
  const lines = [`# D03 엔진 재측정 (${mode})`, '', `시드 ${output.meta.seeds.join(', ')} · 실행 ${output.runs.length}회. 금액은 USD 정수 표시, 원화는 별도다.`,
    '같은 시드의 USD 순자산 차이 중앙값 (이득 시드 수)이다. 두 정책 중앙값끼리 뺀 값은 아니다. 이득은 순자산 증가·실패 없음·끝 원화 미지급 0이다.',
    '①은 보통·고용·투자 없음 대비, ②는 같은 수락의 투자 없음 대비, ③·④는 같은 수락·투자의 고용 없음 대비다. 조사 선행은 같은 고용·투자의 조사 선행 없는 실행 대비다.',
    'S=1일 선복, E=7일 확장, SE=둘 다, SE22=22일 둘 다. ↑는 중앙 ≥ +300 USD·이득 ≥ 0.75N·실패 ≤ floor(0.05N), ↓는 중앙 ≤ −300 USD·이득 ≤ 0.25N이다. N<10이면 화살표를 쓰지 않는다.', ''];
  for (const scenarioId of output.meta.scenarioIds) {
    const campaignDays = loadScenario(scenarioId as Parameters<typeof loadScenario>[0]).campaignDays;
    const runs = output.runs.filter((r) => r.scenarioId === scenarioId), ids = [...new Set(runs.map((r) => r.policyId))];
    const get = (id: string) => runs.filter((r) => r.policyId === id);
    const stats = (id: string, base = baselineId(id)) => cell(get(id), get(base), value);
    const single = isSingleGoodVariant(loadScenario(scenarioId as Parameters<typeof loadScenario>[0]));
    const baseline = get('MAX_CONTRIBUTION'), n = baseline.length;
    lines.push(`## ${scenarioId}`, '', '## ① 기준 표', '', `| 정책 | 기준 대비 ${comparisonUnit} | USD 순자산 중앙 | 실패 | 끝 KRW 현금 중앙 | 끝 KRW 미지급 중앙 |`, '|---|---:|---:|---:|---:|---:|');
    for (const id of ['IDLE', 'NO_FX', 'MAX_CONTRIBUTION', 'LATE_OK', 'MAX_CONTRIBUTION~fx:react'].filter((id) => ids.includes(id))) {
      const rs = get(id); lines.push(`| ${id} | ${display(stats(id, 'MAX_CONTRIBUTION'))} | ${dollars(median(rs.map(value)))} | ${rs.filter((r) => r.metrics.operations!.outcome === 'FAILED').length}/${rs.length} | ${median(rs.map((r) => r.metrics.currencies.KRW!.cash)).toLocaleString('en-US')} | ${median(rs.map(unpaid)).toLocaleString('en-US')} |`);
    }
    if (mode === 'base') {
      lines.push('', '## ② 투자만', '', `| 정책 | 투자 없음 대비 ${comparisonUnit} |`, '|---|---:|');
      for (const id of ids.filter((id) => { const v = parseVariant(id)!; return v.investment !== 'none' && !v.hires.length; })) lines.push(`| ${id} | ${display(stats(id))} |`);
    }
    const hires = ids.filter((id) => { const v = parseVariant(id)!; return v.hires.length === 1 && !v.early; });
    for (const [acceptance, title] of [['MAX_CONTRIBUTION', '③ 고용 표(보통)'], ['LATE_OK', '④ 고용 표(적극)']]) {
      if (risk && ['R1', 'R2'].includes(risk.level)) { lines.push('', `## ${title}`, '', '해당 없음(축소 묶음)'); continue; }
      const investments = mode === 'base' ? ['none', 'S', 'E', 'SE', 'SE22'] : ['none', 'S', 'E', 'SE'];
      lines.push('', `## ${title}`, '', `| 고용 | ${investments.join(' | ')} |`, `|---|${investments.map(() => '---:|').join('')}`);
      for (const pt of [2, 3]) for (const day of mode === 'base' ? [8, 29, 30, 31, 50] : [8, 30, 50]) {
        lines.push(`| ${pt}pt ${day}일 | ${investments.map((investment) => display(stats(variantName({ acceptance: acceptance!, investment: investment as Investment, hires: [{ pt, day }], react: false, early: false })))).join(' | ')} |`);
      }
    }
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
    const eligible = ids.filter((id) => { const v = parseVariant(id)!; return !['IDLE', 'NO_FX', 'MARGIN_BUFFER', 'FOCUS'].includes(v.acceptance) && !v.react && v.hires.length < 2; });
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
    lines.push('', '## ⑤ J1~J7 판정과 근거 수', '', 'J4는 개연성 점검이다(묶음 견적 수·준비 pt·환전 없이 실패·기준 순자산 범위).', '', '| 판정 | 결과 | 근거 |', '|---|---|---|');
    const judge = (id: string, pass: boolean | null, evidence: string) => {
      if (!risk) { lines.push(`| ${id} | ${pass === null ? mode !== 'base' && id === 'J2' ? '진단(Q14)' : mode !== 'base' && ['J2b', 'J3', 'J5'].includes(id) ? '해당 없음' : '미측정' : pass ? '통과' : '실패'} | ${evidence} |`); return; }
      const key = (id === 'J7' ? 'J7(옛 정의)' : id) as JudgmentId;
      if (id === 'J7' && analysis) { lines.push(`| ${key} | | USD 몫만·진단; ${evidence} |`); return; }
      const full = d03PolicyIds('base');
      const needed = id === 'J4a~c' ? ['MAX_CONTRIBUTION', 'NO_FX'] : id === 'J2' || id === 'J6'
        ? full.filter((p) => parseVariant(p)!.hires.length <= 1 && !parseVariant(p)!.early)
        : id === 'J5' ? ['MAX_CONTRIBUTION~inv:SE~hire:2pt@22+3pt@36', 'MAX_CONTRIBUTION~inv:SE']
        : id === 'J3' ? full.filter((p) => { const v = parseVariant(p)!; return !['IDLE', 'NO_FX'].includes(v.acceptance) && !v.react && v.hires.length < 2; })
        : ['MAX_CONTRIBUTION'];
      lines.push(judgmentRow(key, risk.level, single, pass, evidence, missingRuns(output, scenarioId, needed)));
    };
    judge('J1', n ? baseline.every(healthy) : null, `기준 ${n}시드, 실패 ${baseline.filter((r) => r.metrics.operations!.outcome === 'FAILED').length}, 끝 원화 미지급 ${baseline.filter((r) => unpaid(r) > 0).length}`);
    const groups = ['MAX_CONTRIBUTION', 'LATE_OK'].map((p) => { const cs = coreHires.filter((id) => parseVariant(id)!.acceptance === p).map((id) => stats(id)); return { p, count: cs.length, up: cs.filter((c) => c.arrow === '↑').length, down: cs.filter((c) => c.arrow === '↓').length }; });
    judge('J2', mode !== 'base' ? null : groups.every((g) => g.count === 24) && n >= 10 ? groups.every((g) => g.up > 0 && g.down > 0) : null, (mode !== 'base' ? '감액 변형은 비교용 규칙이라 판정하지 않음 — ' : '') + groups.map((g) => `${g.p}: ${g.count}칸 ↑${g.up} ↓${g.down}`).join('; '));
    const middle = coreHires.filter((id) => parseVariant(id)!.hires[0]!.day === 30 && stats(id).arrow);
    const stable = middle.filter((id) => { const v = parseVariant(id)!, c = stats(id); return [29, 31].every((day) => {
      const x = stats(variantName({ ...v, hires: [{ ...v.hires[0]!, day }] })); return x.n > 0 && (!x.arrow || x.arrow === c.arrow) && Math.sign(x.median) === Math.sign(c.median);
    }); }).length;
    judge('J2b', mode !== 'base' || n < 10 ? null : stable === middle.length, mode !== 'base' ? '줄인 묶음에 29·31일 고용이 없음' : `${stable}/${middle.length}칸, 인접 29·31일 부호·반대 판정 확인`);
    judge('J3', mode !== 'base' || !strongest || n < 10 ? null : 20 * strongest[1] < 17 * n, `후보 ${complete.length}정책, 가장 강한 ${strongest?.[0] ?? '없음'}: ${strongest?.[1] ?? 0}/${n}시드 (1위와 300 USD 안)`);
    const nofx = get('NO_FX'), nofxFailed = nofx.filter((r) => r.metrics.operations!.outcome === 'FAILED').length;
    const shape = baseline.every((r) => { const o = r.metrics.operations!; return o.maxBatchOffers <= 10 && o.forwardingPrepMin >= 2 && o.forwardingPrepMax <= 12 && r.metrics.currencies.KRW!.cash >= 0; });
    const net = median(baseline.map(value));
    if (!risk) {
    judge('J4', n && nofx.length ? shape && nofxFailed >= 0.75 * nofx.length && net >= J4_NET_MIN_MINOR && net <= J4_NET_MAX_MINOR : null, `기준 ${n}시드, 최대 묶음 ${Math.max(0, ...baseline.map((r) => r.metrics.operations!.maxBatchOffers))}견적, 준비 ${Math.min(...baseline.map((r) => r.metrics.operations!.forwardingPrepMin))}~${Math.max(0, ...baseline.map((r) => r.metrics.operations!.forwardingPrepMax))}pt; NO_FX 실패 ${nofxFailed}/${nofx.length}; USD 중앙 ${dollars(net)}; 상한 ${dollars(J4_NET_MAX_MINOR)}까지 여유 ${Number.isNaN(net) ? '미측정' : ((J4_NET_MAX_MINOR - net) / J4_NET_MAX_MINOR * 100).toFixed(1) + '%'}`);
    } else {
      judge('J4a~c', n && nofx.length ? shape && 4 * nofxFailed >= 3 * nofx.length : null,
        `기준 ${n}시드, 최대 묶음 ${Math.max(0, ...baseline.map((r) => r.metrics.operations!.maxBatchOffers))}견적, 준비 ${Math.min(...baseline.map((r) => r.metrics.operations!.forwardingPrepMin))}~${Math.max(0, ...baseline.map((r) => r.metrics.operations!.forwardingPrepMax))}pt; NO_FX 실패 ${nofxFailed}/${nofx.length}`);
      const band = risk.level === 'R0' ? J4_BANDS.R0 : J4_BANDS.risk;
      judge('J4d', Number.isFinite(net) ? net >= band[0] && net <= band[1] : null,
        `${analysis ? '분석값' : 'USD'} 중앙 ${dollars(net)}, 띠 ${dollars(band[0])}~${dollars(band[1])}`);
    }
    const double = ids.find((id) => parseVariant(id)!.hires.length === 2), doubleCell = double ? stats(double) : null;
    judge('J5', mode !== 'base' || !doubleCell?.n ? null : 20 * doubleCell.gains <= 3 * doubleCell.n, mode !== 'base' ? '줄인 묶음에 두 명 고용 진단이 없음' : `두 명 고용 이득 ${doubleCell?.gains ?? 0}/${doubleCell?.n ?? 0}시드`);
    const matches = j6.filter((c) => c.matched).length;
    const j6Groups = ['MAX_CONTRIBUTION', 'LATE_OK'].map((p) => {
      const cs = j6.filter((c) => parseVariant(c.id)!.acceptance === p);
      return `${p} ${cs.filter((c) => c.matched).length}/${cs.length}칸`;
    }).join('; ');
    judge('J6', j6.length ? 5 * matches >= 4 * j6.length : null, `${matches}/${j6.length}칸 (${j6.length ? (matches * 100 / j6.length).toFixed(1) : '미측정'}%), ${j6.reduce((s, c) => s + c.n, 0)}시드 관측; ${j6Groups}`);
    const direct = median(shares.map((s) => s.direct));
    judge('J7', risk ? oldJ7Passes(baseline) : n ? direct >= 25 : null, `${n}시드, 직접 무역 ${direct.toFixed(2)}%, 작업 포함 ${median(shares.map((s) => s.handling)).toFixed(2)}%, 일반 ${median(shares.map((s) => s.standard)).toFixed(2)}% (각 시드 비중의 중앙)`);
    lines.push('', '### J6 칸별 병목 예측', '', '| 정책 | 추가 업무/주 중앙 | 예측 | 실측 | 일치 | 예측 시드 수 | 처리 증가 실측 | 실현률 | 불일치: 이용률 높은 시드 | 불일치: 창고 대기 업무-일 중앙 |', '|---|---:|---|---|---|---:|---:|---|---:|---:|');
    for (const c of j6) lines.push(`| ${c.id} | ${c.prediction.value} | ${c.prediction.arrow} | ${c.actual} | ${c.matched ? '일치' : '불일치'} | ${c.n} | ${c.increase} | ${Number.isNaN(c.realization) ? '—' : c.realization.toFixed(3)} (미고용 제외 ${c.excluded}) | ${c.matched ? '—' : c.highSeeds} | ${c.matched ? '—' : c.waiting} |`);
    lines.push('', '처리 증가 실측은 같은 시드·수락·투자의 고용 없는 실행 대비 수락 HANDLING 건수 차이 중앙값이다(취소 제외). 실현률은 각 시드의 차이를 이 칸의 예측 추가 업무/주 × (캠페인 일수 − 실제 고용일 + 1) / 7로 나눈 뒤 중앙값을 낸다. 미고용 시드는 실현률에서 제외하며 예측 0은 —다.');
    lines.push('', '보관 예측은 정상 상태의 리틀의 법칙 추정이다. 도착 집중·높은 이용률의 대기는 놓칠 수 있다. 이용률 높은 시드는 실제 고용일 이후 마감의 절반 이상에서 보관 또는 처리 이용률이 90% 이상인 경우다.');
    if (mode === 'base') {
      lines.push('', '## ⑥ 시드별 1위 정책 분포와 가장 강한 정책', '', '| 1위 정책 (동점은 정책 이름 순) | 시드 수 |', '|---|---:|');
      for (const [id, count] of wins) if (count) lines.push(`| ${id} | ${count} |`);
      lines.push('', `가장 강한 정책: ${strongest?.[0] ?? '미측정'} (${strongest?.[1] ?? 0}/${n}시드에서 1위와 300 USD 안). 실패 실행도 순자산 그대로 포함한다.`, '', '## ⑦ 사업별 기여이익 비중', '', '| 사업 | USD 기여이익 중앙 | 시드별 비중 중앙 |', '|---|---:|---:|');
      for (const [field, share, label] of [['directTrade', 'direct', '직접 무역'], ['handlingForwarding', 'handling', '작업 포함 주선'], ['standardForwarding', 'standard', '일반 주선']] as const) lines.push(`| ${label} | ${dollars(median(baseline.map((r) => r.metrics.operations!.currencies.USD!.business[field])))} | ${median(shares.map((s) => s[share])).toFixed(2)}% |`);
    }
    {
      lines.push('', '## ⑧ 계획 고용일과 실제 고용일이 다른 실행 수', '', '| 정책 | 고용일이 다른 실행 / 전체 실행 | 실제 고용일 (null=미고용) | 예측 불일치 계약 합계 |', '|---|---:|---|---:|');
      for (const id of ids) { const rs = get(id); lines.push(`| ${id} | ${rs.filter((r) => r.metrics.operations!.actualHires.some((h) => h.actualDay !== h.plannedDay)).length}/${rs.length} | ${[...new Set(rs.map((r) => r.metrics.operations!.actualHires.map((h) => h.actualDay ?? 'null').join('+')))].join(', ') || '—'} | ${rs.reduce((sum, r) => sum + r.metrics.operations!.projectionMisses, 0)} |`); }
    }
    if (mode === 'base') {
      lines.push('', '### 진단·조사 선행 비교', '', '| 정책 | 대응 기준 대비 USD |', '|---|---:|');
      for (const id of ids.filter((id) => { const v = parseVariant(id)!; return v.early || v.hires.length > 1; })) lines.push(`| ${id} | ${display(stats(id))} |`);
    }
  }
  let text = lines.join('\n') + '\n';
  if (risk) {
    text = text.replaceAll('미측정', '—').replaceAll('NaN', '—');
    if (analysis) text = text.replaceAll('USD 순자산', '분석값').replaceAll('기준 대비 USD', '기준 대비 분석값')
      .replace('금액은 USD 정수 표시, 원화는 별도다.', '비교 금액은 분석값(USD 정수 표시)이며 원화 순자산을 고정 기준 환율로 환산한다.')
      .replace('## ⑦ 사업별 기여이익 비중', '## ⑦ 사업별 기여이익 비중 (USD 몫만·진단)');
    text += riskTables(output);
  }
  return text;
}
