// 회사 성장 자료와 처리는 운영 자료를 연 뒤에만 등록한다.
import { growthData } from '../content/ops-data';
import type { CompanyStage, CustomerTrust, GameState, GrowthLadderConfig, GrowthMetrics, OfferDef, ScenarioConfig, CreditTermId } from './types';
import type { CreditTermCheck } from './engine';
import { contractReport, onTimeDeliveryRate } from './reports';
import { balanceSheetAt } from './path11-readers';
import { referenceRate, usdToKrwMinor } from './risk';
import { applyBasisPoints } from './money';
import { halfUp, offerDef } from './market';

export function prepareLadderConfig(config: ScenarioConfig, scenarioRecord: Record<string, unknown>, opts: { debugAllUnlocked?: boolean } = {}): void {
  const [file, id] = String(scenarioRecord.growth_ladder_ref).split('#');
  const ladder = growthData().items.find((item) => item.id === id);
  if (!config.operations || file !== 'growth_ladder.json' || !ladder) throw new Error('성장 사다리 자료를 찾을 수 없습니다.');
  const growth: GrowthLadderConfig = { ladder: structuredClone(ladder), ...(opts.debugAllUnlocked ? { debugAllUnlocked: true } : {}) };
  config.operations.growth = growth;
  if (!growth.debugAllUnlocked) {
    const cap = growth.ladder.stages[0]!.unlocks.lot_cap_multiple!;
    config.offers = config.offers.map((offer) => offer.kind === 'forwarding' ? { ...offer }
      : { ...offer, maxQuantity: Math.min(offer.maxQuantity, cap * offer.quantityStep) });
  }
}

const stages: CompanyStage[] = ['S1', 'S2', 'S3', 'S4'];
const levels: CustomerTrust[] = ['NEW', 'REGULAR', 'PRIORITY'];
const active = (config: ScenarioConfig) => config.operations?.growth && !config.operations.growth.debugAllUnlocked;
const ladderOf = (config: ScenarioConfig) => config.operations!.growth!.ladder;

function opened(config: ScenarioConfig, stage: CompanyStage) {
  const rows = ladderOf(config).stages.slice(0, stages.indexOf(stage) + 1);
  return { goods: rows.flatMap((r) => r.unlocks.goods), creditTerms: rows.flatMap((r) => r.unlocks.credit_terms),
    lotCapMultiple: Math.max(...rows.map((r) => r.unlocks.lot_cap_multiple ?? 0)) };
}
function initialCustomers(config: ScenarioConfig): import('./types').GrowthState['customers'] {
  const ids = new Set(config.operations!.market.trade.goods.flatMap((g) => g.sellCounterparties.map((p) => p.counterpartyId)));
  return Object.fromEntries([...ids].map((id) => [id, { level: 'NEW', changedDay: null, lastChangeReason: null }]));
}
export function initialLocks(s: GameState, config: ScenarioConfig): void {
  if (!active(config)) return;
  s.operations!.growth = { stage: 'S1', reachedDays: { S1: 1 },
    customers: initialCustomers(config),
    lastEvalDay: null, evaluations: [] };
  applyBatchLocks(s, config, config.offers);
}
export function applyBatchLocks(s: GameState, config: ScenarioConfig, offers: OfferDef[]): void {
  if (!active(config)) return;
  const growth = s.operations!.growth!, access = opened(config, growth.stage);
  for (const offer of offers) {
    if (offer.kind === 'forwarding') continue;
    if (!access.goods.includes(offer.goodId)) {
      s.offers.find((o) => o.id === offer.id)!.status = 'LOCKED';
      continue;
    }
    // 0번 묶음의 상한은 로더가 설정 사본에 적용한다.
    if (offer.batchK !== 0) offer.maxQuantity = Math.min(offer.maxQuantity, access.lotCapMultiple * offer.quantityStep);
    if (offer.kind === 'customer' && offer.batchK !== 0) {
      const bp = ladderOf(config).trust[growth.customers[offer.counterpartyId]?.level ?? 'NEW'].sale_premium_bp;
      offer.unitPriceMinor += applyBasisPoints(offer.unitPriceMinor, bp);
    }
  }
}
const direct = (s: GameState) => s.contracts.filter((c) => c.kind === 'DIRECT_TRADE' && c.status !== 'CANCELLED');
function claims(s: GameState, day: number) {
  const ids = new Set(direct(s).map((c) => c.id));
  return s.ledger.entries.filter((e) => e.id.startsWith('CLAIM-') && e.day <= day && ids.has(e.contractId!));
}
export function growthMetrics(s: GameState, config: ScenarioConfig, day: number): GrowthMetrics {
  const view = { ...s, day, ledger: { ...s.ledger, entries: s.ledger.entries.filter((e) => e.day <= day) } };
  const rate = referenceRate(config, s.rng.seed, day);
  const krw = (currency: string, amount: number) => currency === 'USD' ? usdToKrwMinor(amount, rate) : amount;
  const delivered = direct(view).filter((c) => c.deliveredDay !== null && c.deliveredDay <= day);
  const times = onTimeDeliveryRate({ ...view, contracts: view.contracts.filter((c) => c.acceptedDay <= day)
    .map((c) => c.deliveredDay !== null && c.deliveredDay > day ? { ...c, deliveredDay: null } : c) }, { kind: 'DIRECT_TRADE' });
  const denominator = times.delivered + times.pastDeadlineUndelivered;
  const currencies = [...new Set(view.ledger.entries.map((e) => e.currency))];
  const net = (at: number) => balanceSheetAt(view, config, at).byCurrency.reduce((n, row) => n + krw(row.currency,
    row.assets.reduce((a, r) => a + r.amountMinor, 0) - row.liabilities.reduce((a, r) => a + r.amountMinor, 0)), 0);
  const allClaims = claims(view, day), previous = s.operations!.growth!.lastEvalDay;
  const customers = Object.values(s.operations!.growth!.customers);
  return { delivered: delivered.length, onTimeBp: denominator ? Math.floor(times.onTime * 10000 / denominator) : null,
    claimsSinceLastEval: allClaims.filter((e) => e.day > (previous ?? 0)).length,
    regularCustomers: customers.filter((c) => c.level !== 'NEW').length,
    priorityCustomers: customers.filter((c) => c.level === 'PRIORITY').length,
    contributionKrw: delivered.reduce((n, c) => n + currencies.reduce((m, currency) => m + krw(currency, contractReport(view, c, currency).contribution), 0), 0),
    netWorthGainKrw: net(day) - balanceSheetAt(view, config, 1).byCurrency.reduce((n, row) => {
      const amount = row.assets.reduce((a, r) => a + r.amountMinor, 0) - row.liabilities.reduce((a, r) => a + r.amountMinor, 0);
      return n + (row.currency === 'USD' ? usdToKrwMinor(amount, referenceRate(config, s.rng.seed, 1)) : amount);
    }, 0),
    claimRateBp: delivered.length ? Math.floor(new Set(allClaims.map((e) => e.contractId)).size * 10000 / delivered.length) : null };
}
function requirements(config: ScenarioConfig, stage: CompanyStage, metrics: GrowthMetrics) {
  const requires = ladderOf(config).stages[stages.indexOf(stage)]!.requires;
  return Object.entries(requires).map(([metric, required]) => {
    let current: number | null;
    let threshold: number;
    if (typeof required === 'object') {
      current = required.level === 'PRIORITY' ? metrics.priorityCustomers : metrics.regularCustomers;
      threshold = required.count;
    } else {
      threshold = required;
      const values: Record<string, number | null> = {
        delivered_min: metrics.delivered, on_time_bp_min: metrics.onTimeBp, claims_since_last_eval_max: metrics.claimsSinceLastEval,
        contribution_krw_min: metrics.contributionKrw, net_worth_gain_krw_min: metrics.netWorthGainKrw, claim_rate_bp_max: metrics.claimRateBp,
      };
      current = values[metric] ?? null;
    }
    return { metric, current, required: threshold, met: current !== null && (metric.endsWith('_max') ? current <= threshold : current >= threshold) };
  });
}
function updateTrust(s: GameState, config: ScenarioConfig, day: number): void {
  const growth = s.operations!.growth!, after = growth.lastEvalDay ?? 0, allClaims = claims(s, day);
  for (const [id, customer] of Object.entries(growth.customers)) {
    const contracts = direct(s).filter((c) => c.customerId === id);
    const ids = new Set(contracts.map((c) => c.id));
    const customerClaims = allClaims.filter((e) => ids.has(e.contractId!));
    const late = contracts.some((c) => c.deliveredDay !== null && c.deliveredDay > after && c.deliveredDay <= day && c.deliveredDay > c.deliveryDeadlineDay);
    const claimed = customerClaims.some((e) => e.day > after);
    const old = levels.indexOf(customer.level);
    if (late || claimed) {
      if (old > 0) { customer.level = levels[old - 1]!; customer.changedDay = day; customer.lastChangeReason = claimed ? 'DOWN_CLAIM' : 'DOWN_LATE'; }
      continue;
    }
    if (old === levels.length - 1) continue;
    const next = levels[old + 1]!, rule = ladderOf(config).trust[next].requires;
    const onTime = contracts.filter((c) => c.deliveredDay !== null && c.deliveredDay <= day && c.deliveredDay <= c.deliveryDeadlineDay).length;
    if (onTime < ('on_time_with_customer_min' in rule ? rule.on_time_with_customer_min! : 0)) continue;
    if ('claims_since_last_eval_max' in rule && customerClaims.filter((e) => e.day > after).length > rule.claims_since_last_eval_max!) continue;
    if ('recent_n' in rule) {
      const recent = contracts.filter((c) => c.deliveredDay !== null && c.deliveredDay <= day)
        .sort((a, b) => b.deliveredDay! - a.deliveredDay! || a.id.localeCompare(b.id)).slice(0, rule.recent_n);
      if (recent.filter((c) => customerClaims.some((e) => e.contractId === c.id)).length > rule.recent_claims_max!) continue;
    }
    customer.level = next; customer.changedDay = day; customer.lastChangeReason = 'UP';
  }
}
function recordEvaluation(s: GameState, config: ScenarioConfig, day: number, final: boolean): void {
  const growth = s.operations!.growth!;
  if (growth.lastEvalDay === day) return;
  if (!final) updateTrust(s, config, day);
  const stageBefore = growth.stage, metrics = growthMetrics(s, config, day);
  const next = stages[stages.indexOf(stageBefore) + 1];
  if (next && (!final || next === 'S4') && requirements(config, next, metrics).every((r) => r.met)) {
    growth.stage = next; growth.reachedDays[next] = day;
  }
  growth.evaluations.push({ day, stageBefore, stageAfter: growth.stage, metrics });
  growth.lastEvalDay = day;
}
export function evaluateGrowth(s: GameState, config: ScenarioConfig, day: number): void {
  if (active(config)) recordEvaluation(s, config, day, false);
}
export function finalS4(s: GameState, config: ScenarioConfig): void {
  if (active(config) && s.operations!.outcome === 'COMPLETED') recordEvaluation(s, config, config.campaignDays, true);
}
function nextEvaluation(s: GameState, config: ScenarioConfig): number | null {
  if (s.phase === 'ENDED') return null;
  const p = config.operations!.market.publish, after = Math.max(s.day - 1, s.operations!.growth!.lastEvalDay ?? 0);
  for (let publish = p.firstDay + p.intervalDays; publish <= p.lastDay; publish += p.intervalDays) if (publish - 1 > after) return publish - 1;
  return config.campaignDays > after ? config.campaignDays : null;
}
export function companyStageReport(s: GameState, config: ScenarioConfig) {
  if (!active(config) || !s.operations?.growth) return null;
  const g = s.operations.growth, next = stages[stages.indexOf(g.stage) + 1];
  const access = opened(config, g.stage), all = opened(config, 'S4');
  return { stage: g.stage, reachedDays: { ...g.reachedDays }, nextEvalDay: nextEvaluation(s, config),
    requirements: next ? requirements(config, next, growthMetrics(s, config, Math.min(s.day, config.campaignDays))) : [],
    opened: access, locked: { goods: all.goods.filter((id) => !access.goods.includes(id)).map((id) => ({ id, ...lockDetails(s, config, 'GOOD', id) })),
      creditTerms: all.creditTerms.filter((id) => !access.creditTerms.includes(id)).map((id) => ({ id, ...lockDetails(s, config, 'CREDIT_TERM', id) })),
      lotCap: access.lotCapMultiple < all.lotCapMultiple ? lockDetails(s, config, 'LOT_CAP') : null } };
}
const metricNames: Record<string, string> = { delivered_min: '직접 무역 인도 건수', on_time_bp_min: '정시 인도율(bp)',
  claims_since_last_eval_max: '지난 평가 뒤 클레임 건수', trusted_customers_min: '조건을 채운 거래처 수',
  contribution_krw_min: '누적 기여이익(원)', net_worth_gain_krw_min: '순자산 증가(원)', claim_rate_bp_max: '클레임률(bp)' };
function lockDetails(s: GameState, config: ScenarioConfig, kind: 'GOOD' | 'CREDIT_TERM' | 'LOT_CAP', id?: string) {
  const ladder = ladderOf(config), g = s.operations!.growth!, text = ladder.lock_texts[kind];
  const target = ladder.stages.find((stage) => kind === 'GOOD' ? (stage.unlocks.goods as string[]).includes(id!)
    : kind === 'CREDIT_TERM' ? (stage.unlocks.credit_terms as string[]).includes(id!)
      : (stage.unlocks.lot_cap_multiple ?? 0) > opened(config, g.stage).lotCapMultiple);
  const next = (target?.id ?? stages[stages.indexOf(g.stage) + 1] ?? 'S4') as CompanyStage;
  const all = requirements(config, next, growthMetrics(s, config, Math.min(s.day, config.campaignDays)));
  const unmet = all.filter((r) => !r.met);
  const details = (unmet.length ? unmet : all).map((r) => {
    const slots: Record<string, unknown> = { stage: ladder.stages[stages.indexOf(next)]!.name_ko, metric: metricNames[r.metric],
      current: r.current ?? '실적 없음', required: r.required, next_eval_day: nextEvaluation(s, config) ?? config.campaignDays };
    return text.how_to_unlock_ko.replace(/\{([^{}]+)\}/g, (_, key: string) => String(slots[key]));
  });
  return { reasonKo: text.reason_ko, howToUnlockKo: details.join(' ') };
}
export function lockMessage(s: GameState, config: ScenarioConfig, kind: 'GOOD' | 'CREDIT_TERM' | 'LOT_CAP', id?: string): string {
  const text = lockDetails(s, config, kind, id);
  return [text.reasonKo, text.howToUnlockKo].join(' ');
}
export function stageLockedTerms(s: GameState, config: ScenarioConfig, result: CreditTermCheck, termId?: CreditTermId): CreditTermCheck {
  if (!active(config)) return result;
  const access = opened(config, s.operations!.growth!.stage);
  result.stageLocked = (['D15', 'D30'] as const).filter((id) => !access.creditTerms.includes(id));
  if (result.allowed && termId && termId !== 'BASE' && result.stageLocked.includes(termId)) return { ...result, allowed: false, reasonKo: lockMessage(s, config, 'CREDIT_TERM', termId) };
  return result;
}
export function trustCreditGrade(s: GameState, config: ScenarioConfig, customerId: string, grade: string | undefined): string | undefined {
  if (!active(config) || !grade) return grade;
  const level = s.operations!.growth!.customers[customerId]?.level ?? 'NEW';
  const step = ladderOf(config).trust[level].credit_grade_step;
  const grades = ['A', 'B', 'C'];
  return grades[Math.max(0, grades.indexOf(grade) - step)] ?? grade;
}
export function lockedOfferReason(s: GameState, config: ScenarioConfig, offers: OfferDef[]): string | null {
  if (!active(config)) return null;
  const locked = offers.find((o) => s.offers.find((st) => st.id === o.id)?.status === 'LOCKED');
  return locked ? lockMessage(s, config, 'GOOD', locked.goodId) : null;
}

/** 보고서는 저장 상태를 고치지 않고 평가에 쓰는 동일한 실적을 읽는다. */
export function customerTrustReport(s: GameState, config: ScenarioConfig) {
  if (!active(config) || !s.operations?.growth) return [];
  const g = s.operations.growth, day = Math.min(s.day, config.campaignDays), allClaims = claims(s, day);
  return Object.entries(g.customers).map(([customerId, customer]) => {
    const contracts = direct(s).filter((c) => c.customerId === customerId && c.deliveredDay !== null && c.deliveredDay <= day);
    const onTime = contracts.filter((c) => c.deliveredDay! <= c.deliveryDeadlineDay).length;
    const next = levels[levels.indexOf(customer.level) + 1] ?? null;
    const rule: Record<string, number> = next ? ladderOf(config).trust[next].requires : {};
    const recent = [...contracts].sort((a, b) => b.deliveredDay! - a.deliveredDay! || a.id.localeCompare(b.id))
      .slice(0, 'recent_n' in rule ? rule.recent_n : 0);
    const values: Record<string, number> = { on_time_with_customer_min: onTime,
      claims_since_last_eval_max: allClaims.filter((e) => e.day > (g.lastEvalDay ?? 0) && contracts.some((c) => c.id === e.contractId)).length,
      recent_claims_max: recent.filter((c) => allClaims.some((e) => e.contractId === c.id)).length };
    const requirements = Object.entries(rule).filter(([metric]) => metric !== 'recent_n').map(([metric, required]) => {
      const current = values[metric]!;
      const remaining = Math.max(0, metric.endsWith('_max') ? current - required : required - current);
      return { metric, current, required, remaining, met: remaining === 0 };
    });
    return { customerId, ...customer, nextLevel: next, requirements, nextEvalDay: nextEvaluation(s, config) };
  });
}

/** 평가 기록과 당시 견적에 맞춰 저장·마감의 성장 불변식을 확인한다. */
export function growthProblems(s: GameState, config: ScenarioConfig): string[] {
  const problems: string[] = [], g = s.operations?.growth;
  if (!active(config)) {
    if (g) problems.push('성장 상태는 사다리에서만 허용합니다');
    return problems;
  }
  if (!g) return ['성장 상태가 없습니다'];
  const p = config.operations!.market.publish;
  const isEval = (day: number) => day >= p.firstDay + p.intervalDays - 1 && day < p.lastDay
    && (day + 1 - p.firstDay) % p.intervalDays === 0;
  const history = { ...s, operations: { ...s.operations!, growth: { stage: 'S1' as CompanyStage, reachedDays: { S1: 1 },
    customers: initialCustomers(config), lastEvalDay: null as number | null, evaluations: [] } } };
  const snapshots = new Map<number, import('./types').GrowthState['customers']>([[0, structuredClone(history.operations.growth.customers)]]);
  let last = 0, stage: CompanyStage = 'S1';
  const reached: Partial<Record<CompanyStage, number>> = { S1: 1 };
  for (const e of g.evaluations) {
    const final = e.day === config.campaignDays;
    if (e.day <= last || e.day > s.day || (!isEval(e.day) && !final) || (final && s.operations!.outcome !== 'COMPLETED')) problems.push('성장 평가일 순서가 다릅니다');
    const before = stages.indexOf(e.stageBefore), after = stages.indexOf(e.stageAfter);
    if (e.stageBefore !== stage || after < before || after > before + 1 || (final && after !== before && e.stageAfter !== 'S4')) problems.push('회사 단계는 한 평가에 한 단계만 오릅니다');
    if (after > before) {
      reached[e.stageAfter] = e.day;
      if (!requirements(config, e.stageAfter, e.metrics).every((r) => r.met)) problems.push('성장 조건을 채우지 않은 승급입니다');
    }
    if (!final) updateTrust(history, config, e.day);
    history.operations.growth.lastEvalDay = e.day;
    snapshots.set(e.day, structuredClone(history.operations.growth.customers));
    stage = e.stageAfter; last = e.day;
  }
  if (g.stage !== stage || stages.some((key) => g.reachedDays[key] !== reached[key])
    || g.lastEvalDay !== (last || null)) problems.push('회사 단계·도달일·평가 기록이 다릅니다');
  const expectedCustomers = history.operations.growth.customers;
  if (Object.keys(g.customers).length !== Object.keys(expectedCustomers).length || Object.entries(expectedCustomers).some(([id, expected]) => {
    const actual = g.customers[id];
    return !actual || actual.level !== expected.level || actual.changedDay !== expected.changedDay || actual.lastChangeReason !== expected.lastChangeReason;
  })) problems.push('거래처 신뢰는 평가일에 한 등급만 바뀝니다');
  for (const offer of [...config.offers, ...s.operations!.offers]) {
    if (offer.kind === 'forwarding') continue;
    const evalDay = offer.batchK === 0 ? 0 : offer.publishDay - 1;
    const at = g.evaluations.find((e) => e.day === evalDay)?.stageAfter ?? 'S1';
    const access = opened(config, at), status = s.offers.find((v) => v.id === offer.id)?.status;
    const locked = !access.goods.includes(offer.goodId);
    if (locked !== (status === 'LOCKED')) problems.push('품목 잠금은 생성 묶음에서 고정됩니다');
    if (!locked && offer.maxQuantity > access.lotCapMultiple * offer.quantityStep) problems.push('물량 상한이 회사 단계보다 큽니다');
    if (offer.kind !== 'customer' || offer.batchK === 0 || locked) continue;
    const batch = s.operations!.batches.find((b) => b.k === offer.batchK)!;
    const row = batch.rows.find((r) => r.cityId === offer.cityId && r.goodId === offer.goodId && r.side === 'SELL');
    const pct = batch.counterpartyPct?.find((r) => r.goodId === offer.goodId && r.side === 'SELL');
    const customer = snapshots.get(evalDay)?.[offer.counterpartyId];
    if (!row || !pct || !customer) { problems.push('판매가 가산의 공개 묶음·신뢰 기록이 없습니다'); continue; }
    const base = halfUp(row.basePriceMinor * (100 + pct.pct), 100);
    const bp = ladderOf(config).trust[customer.level].sale_premium_bp;
    if (offer.unitPriceMinor !== base + applyBasisPoints(base, bp)) problems.push('판매가 가산 bp가 신뢰 등급표와 다릅니다');
  }
  for (const c of s.contracts.filter((c) => c.kind === 'DIRECT_TRADE')) {
    for (const id of [c.buyOfferId, c.sellOfferId]) {
      const offer = offerDef(s, config, id!);
      const stage = [...g.evaluations].reverse().find((e) => e.day < c.acceptedDay)?.stageAfter ?? 'S1';
      if (s.offers.find((o) => o.id === id)?.status === 'LOCKED' || (offer && !opened(config, stage).goods.includes(offer.goodId))) problems.push('잠긴 품목·견적을 계약했습니다');
    }
  }
  return problems;
}

type Shape = (value: unknown, path: string) => void;
const scalar = (test: (v: unknown) => boolean): Shape => (v, path) => {
  if (!test(v)) throw new Error(`${path}: 저장 필드 모양이 올바르지 않습니다.`);
};
const int = scalar((v) => Number.isSafeInteger(v));
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (fields: Record<string, Shape>): Shape => (v, path) => {
  if (!record(v)) throw new Error(`${path}: 객체가 필요합니다.`);
  for (const [key, shape] of Object.entries(fields)) shape(v[key], `${path}.${key}`);
};
const array = (shape: Shape): Shape => (v, path) => {
  if (!Array.isArray(v)) throw new Error(`${path}: 배열이 필요합니다.`);
  v.forEach((item, i) => shape(item, `${path}[${i}]`));
};
const map = (shape: Shape): Shape => (v, path) => {
  if (!record(v)) throw new Error(`${path}: 기록 객체가 필요합니다.`);
  for (const [key, item] of Object.entries(v)) shape(item, `${path}.${key}`);
};
const oneOf = (...values: unknown[]) => scalar((v) => values.includes(v));
const nullable = (shape: Shape): Shape => (v, path) => { if (v !== null) shape(v, path); };
const optional = (shape: Shape): Shape => (v, path) => { if (v !== undefined) shape(v, path); };
const ni = nullable(int);

const growthShape = obj({ stage: oneOf('S1', 'S2', 'S3', 'S4'),
      reachedDays: obj({ S1: int, S2: optional(int), S3: optional(int), S4: optional(int) }),
      customers: map(obj({ level: oneOf('NEW', 'REGULAR', 'PRIORITY'), changedDay: ni, lastChangeReason: oneOf(null, 'UP', 'DOWN_LATE', 'DOWN_CLAIM') })),
      lastEvalDay: ni, evaluations: array(obj({ day: int, stageBefore: oneOf('S1', 'S2', 'S3', 'S4'), stageAfter: oneOf('S1', 'S2', 'S3', 'S4'),
        metrics: obj({ delivered: int, onTimeBp: ni, claimsSinceLastEval: int, regularCustomers: int, priorityCustomers: int,
          contributionKrw: int, netWorthGainKrw: int, claimRateBp: ni }) })) });

export function checkGrowthSaveShape(s: GameState): void {
  growthShape(s.operations?.growth, 'state.operations.growth');
  for (const offer of s.offers) {
    if (!['OPEN', 'ACCEPTED', 'EXPIRED', 'LOCKED'].includes(offer.status)) throw new Error('저장 견적 상태가 올바르지 않습니다.');
  }
  for (const contract of s.contracts) {
    if (contract.creditEligible && Object.hasOwn(contract.creditEligible, 'stageLocked')) {
      array(oneOf('D15', 'D30'))(contract.creditEligible.stageLocked, 'state.contracts.creditEligible.stageLocked');
    }
  }
}

// 숫자 슬롯은 등록 계약이다. 첫 화면에는 함수 이름·자료 본문을 싣지 않는다.
export const growthHooks = [prepareLadderConfig, initialLocks, evaluateGrowth, applyBatchLocks, stageLockedTerms, finalS4, trustCreditGrade, lockedOfferReason, checkGrowthSaveShape, growthProblems] as const;
