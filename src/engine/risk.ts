// 위험 값은 설정·시드·날짜로만 계산한다. 상태의 난수 커서를 소비하지 않는다.
import { cityName, dutyEstimate, goodOf } from './catalog';
import { applyBasisPoints, type Currency } from './money';
import { drawUniform } from './rng';
import type { CreditProfile, CreditTermId, GameState, MarketSide, RiskProfile, ScenarioConfig } from './types';

export function drawAt(seed: number, stream: string, index: number): number {
  return drawUniform({ seed, cursors: { [stream]: index } }, stream).value;
}

/** 정수 나눗셈, 정확히 절반이면 0에서 먼 쪽으로 반올림한다. */
export function divHalfAway(n: number, d: number): number {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(d) || d <= 0) throw new Error('환산에는 정수와 양수 분모가 필요합니다');
  return Math.sign(n) * Math.floor((2 * Math.abs(n) + d) / (2 * d));
}
export const krwToUsdMinor = (krw: number, rate: number): number => divHalfAway(krw * 100, rate);
export const usdToKrwMinor = (cents: number, rate: number): number => divHalfAway(cents * rate, 100);

export function referenceRate(config: ScenarioConfig, seed: number, day: number): number {
  const o = config.operations;
  if (!o) throw new Error('참고 환율은 운영 설정이 필요합니다');
  if (!o.risk) return o.fx.baseKrwPerUsd;
  const fx = o.risk.profile.fx;
  let rate = fx.startKrwPerUsd;
  if (!o.risk.layers.includes('FX')) return rate;
  const p = o.market.publish;
  const week = Math.max(0, Math.floor((Math.min(day, p.lastDay) - p.firstDay) / p.intervalDays));
  for (let k = 1; k <= week; k++) {
    const step = Math.floor(drawAt(seed, 'FX-REF', k) * (2 * fx.stepBp + 1)) - fx.stepBp;
    rate = Math.max(fx.minKrwPerUsd, Math.min(fx.maxKrwPerUsd, divHalfAway(rate * (10000 + step), 10000)));
  }
  return rate;
}

export function rowCurrency(config: ScenarioConfig, side: MarketSide): Currency {
  return isRiskRules(config.rules.rulesVersion) && config.operations?.risk && side === 'BUY' ? 'KRW' : 'USD';
}

export interface TariffEvent {
  countryCode: string; round: number; noticeDay: number; effectiveDay: number; stepBp: number;
}

const uniformInt = (seed: number, stream: string, min: number, max: number) =>
  min + Math.floor(drawAt(seed, stream, 0) * (max - min + 1));
const clampRate = (p: RiskProfile['tariff'], rate: number) => Math.max(p.minBp, Math.min(p.maxBp, rate));
const effectiveOrder = (a: TariffEvent, b: TariffEvent) =>
  a.effectiveDay - b.effectiveDay || a.noticeDay - b.noticeDay || a.round - b.round;

// 공지된 사건만 시행일 순으로 누적하고 매 걸음에서 범위를 자른다.
function knownRate(p: RiskProfile['tariff'], row: RiskProfile['tariff']['base'][number],
  events: TariffEvent[], knownDay: number, tariffDay: number): number {
  return events.filter((e) => e.countryCode === row.countryCode && e.noticeDay <= knownDay && e.effectiveDay <= tariffDay)
    .sort(effectiveOrder).reduce((rate, e) => clampRate(p, rate + e.stepBp), row.rateBp);
}

/** 공지 순서로 무의미 사건을 버린다. 뒤에 공지될 사건으로 되살리지 않는다. */
export function tariffEvents(config: ScenarioConfig, seed: number): TariffEvent[] {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('TARIFF')) return [];
  const p = risk.profile.tariff, kept: TariffEvent[] = [];
  for (const countryCode of new Set(p.base.map((r) => r.countryCode))) {
    const prefix = `TARIFF:${countryCode}`;
    const count = uniformInt(seed, `${prefix}:count`, 0, p.maxChanges);
    const candidates: TariffEvent[] = [];
    for (let round = 1; round <= count; round++) {
      const lag = uniformInt(seed, `${prefix}:${round}:lag`, p.lagDays[0]!, p.lagDays[1]!);
      const noticeDay = uniformInt(seed, `${prefix}:${round}:notice`, 1, config.campaignDays - p.lagDays[1]!);
      candidates.push({ countryCode, round, noticeDay, effectiveDay: noticeDay + lag,
        stepBp: uniformInt(seed, `${prefix}:${round}:step`, p.stepBp[0]!, p.stepBp[1]!) });
    }
    for (const e of candidates.sort((a, b) => a.noticeDay - b.noticeDay || a.round - b.round)) {
      if (p.base.filter((r) => r.countryCode === countryCode).some((row) => {
        const a = knownRate(p, row, kept, e.noticeDay, e.effectiveDay);
        return a !== clampRate(p, a + e.stepBp);
      })) kept.push(e);
    }
  }
  return kept;
}

/** 오늘 기준 계산값. 뒤 공지로 앞 사건의 비교 세율도 달라질 수 있다. */
export function tariffSchedule(s: GameState, config: ScenarioConfig) {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('TARIFF')) return [];
  const p = risk.profile.tariff;
  const day = s.phase === 'ENDED' ? s.operations?.failure?.day ?? config.campaignDays : s.day;
  const countries = [...new Set(p.base.map((r) => r.countryCode))];
  const events = tariffEvents(config, s.rng.seed).filter((e) => e.noticeDay <= day);
  const sequences = new Map<string, number>();
  return [...events].sort((a, b) => a.noticeDay - b.noticeDay
    || countries.indexOf(a.countryCode) - countries.indexOf(b.countryCode) || a.round - b.round).map((e) => {
    const rates = p.base.filter((r) => r.countryCode === e.countryCode).map((row) => ({ goodId: row.goodId,
      fromBp: knownRate(p, row, events.filter((v) => v !== e), day, e.effectiveDay),
      toBp: knownRate(p, row, events, day, e.effectiveDay) }));
    const cities = config.cities.filter((c) => c.countryCode === e.countryCode).map((c) => cityName(config, c.id)).join('·');
    const labelKo = `${e.countryCode}${cities ? `(${cities})` : ''} 관세 일괄 변경(가상 세율): ${rates.map((r) =>
      `${goodOf(config, r.goodId).nameKo} ${r.fromBp / 100}% → ${r.toBp / 100}%`).join(', ')} (${e.effectiveDay}일부터)`;
    const seq = (sequences.get(e.countryCode) ?? 0) + 1;
    sequences.set(e.countryCode, seq);
    return { countryCode: e.countryCode, seq, noticeDay: e.noticeDay, effectiveDay: e.effectiveDay, rates, labelKo };
  });
}

export function surchargeWeek(config: ScenarioConfig, departureDay: number): number {
  const p = config.operations!.market.publish;
  return Math.floor((departureDay - p.firstDay) / p.intervalDays) + 1;
}

export function surchargeBp(config: ScenarioConfig, seed: number, routeId: string, week: number): number {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('SURCHARGE')) return 0;
  const p = risk.profile.surcharge, prefix = `SURCHARGE:${routeId}:${week}`;
  return uniformInt(seed, `${prefix}:zero`, 0, 9999) < p.pZeroBp ? 0
    : uniformInt(seed, `${prefix}:value`, p.minBp, p.maxBp);
}

/** 과세가격 환율은 수락일에 고정하고, 세율은 공지 기준일과 신고일로 고른다. */
export function dutyFor(config: ScenarioConfig, seed: number, goodId: string, destinationCityId: string,
  tariffDay: number, knownThroughDay: number, purchaseMinor: number, purchaseCurrency: Currency, valueFxDay: number): number {
  const taxable = purchaseCurrency === 'KRW'
    ? krwToUsdMinor(purchaseMinor, referenceRate(config, seed, valueFxDay)) : purchaseMinor;
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('TARIFF')) return dutyEstimate(config, taxable);
  const country = config.cities.find((c) => c.id === destinationCityId)?.countryCode;
  const p = risk.profile.tariff, row = p.base.find((r) => r.countryCode === country && r.goodId === goodId);
  if (!row) throw new Error(`관세 표에 도착국·품목이 없습니다: ${country}, ${goodId}`);
  return applyBasisPoints(taxable, knownRate(p, row, tariffEvents(config, seed), knownThroughDay, tariffDay));
}

export function claimFor(config: ScenarioConfig, seed: number, sellOfferId: string, goodId: string):
  null | { tier: 'MINOR' | 'MAJOR'; rateBp: number } {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('CLAIM')) return null;
  const p = risk.profile.claims, row = p.byGood.find((r) => r.goodId === goodId);
  if (!row) throw new Error(`클레임 표에 품목이 없습니다: ${goodId}`);
  const prefix = `CLAIM:${sellOfferId}`;
  if (uniformInt(seed, `${prefix}:hit`, 0, 9999) >= row.pClaimBp) return null;
  const tier = uniformInt(seed, `${prefix}:tier`, 0, 9999) < p.minor.weightBp ? 'MINOR' : 'MAJOR';
  const range = tier === 'MINOR' ? p.minor : p.major;
  return { tier, rateBp: uniformInt(seed, `${prefix}:rate`, range.minBp, range.maxBp) };
}

export function collectionPlan(config: ScenarioConfig, seed: number, sellOfferId: string, counterpartyId: string):
  { mode: 'ON_TIME' | 'LATE' | 'PARTIAL'; days: number } {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('COLLECTION')) return { mode: 'ON_TIME', days: 0 };
  const p = risk.profile.collections, row = p.byCounterparty.find((r) => r.counterpartyId === counterpartyId);
  if (!row) throw new Error(`수금 표에 거래처가 없습니다: ${counterpartyId}`);
  const grade = p.grades.find((r) => r.grade === row.grade);
  if (!grade) throw new Error(`수금 표에 신용등급이 없습니다: ${row.grade}`);
  const prefix = `COLLECT:${sellOfferId}`, v = uniformInt(seed, `${prefix}:mode`, 0, 9999);
  if (v < grade.pOnTimeBp) return { mode: 'ON_TIME', days: 0 };
  return { mode: v < grade.pOnTimeBp + grade.pLateBp ? 'LATE' : 'PARTIAL',
    days: uniformInt(seed, `${prefix}:days`, p.lateMinDays, p.lateMaxDays) };
}

/** 대손 추첨은 수금 방식·지연 일수와 독립된 흐름을 쓴다. */
export function defaultFor(config: ScenarioConfig, seed: number, sellOfferId: string, customerId: string,
  termId: CreditTermId): boolean {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('DEFAULT')) return false;
  const grade = risk.profile.collections.byCounterparty.find((r) => r.counterpartyId === customerId)?.grade;
  const base = risk.credit?.pDefaultBpByGrade.find((r) => r.grade === grade);
  const term = risk.credit?.terms.find((t) => t.id === termId);
  if (!base || !term) throw new Error(`대손 설정에 거래처·외상 조건이 없습니다: ${customerId}, ${termId}`);
  const probability = divHalfAway(base.pDefaultBp * term.factorPct, 100);
  return uniformInt(seed, `COLLECT:${sellOfferId}:default`, 0, 9999) < probability;
}

/** 분개일 전날까지의 마감 잔액 × bp 합. 반올림은 누적 합계에 한 번만 한다. */
export function carryAccrued(s: GameState, config: ScenarioConfig, invoiceId: string, day: number): number {
  const risk = config.operations?.risk;
  if (!risk?.layers.includes('CARRY')) return 0;
  const inv = s.invoices.find((i) => i.id === invoiceId);
  if (!inv || s.contracts.find((c) => c.id === inv.contractId)?.kind !== 'DIRECT_TRADE') return 0;
  const prefix = `RECEIPT-RCPT-${invoiceId}`;
  const receipts = s.ledger.entries.filter((e) => e.id === prefix || e.id.startsWith(`${prefix}-`));
  const writtenOffDay = s.ledger.entries.find((e) => e.id === `BADDEBT-${invoiceId}`)?.day;
  let accrued = 0;
  for (let d = inv.dueDay + 1; d < day; d++) {
    if (inv.status === 'WRITTEN_OFF' && writtenOffDay !== undefined && d >= writtenOffDay) break;
    const received = receipts.filter((e) => e.day <= d).flatMap((e) => e.lines)
      .filter((l) => l.account === 'CASH').reduce((sum, l) => sum + l.amount, 0);
    accrued += (inv.amountMinor - received) * risk.credit!.carryBpPerDay;
  }
  return accrued;
}

/** 수금 ID의 원장 현금 줄만 읽는다. 청구서에는 받은 금액을 따로 저장하지 않는다. */
export function receivedForInvoice(s: GameState, invoiceId: string): number {
  const id = `RECEIPT-RCPT-${invoiceId}`;
  return s.ledger.entries.filter((e) => e.id === id || e.id.startsWith(`${id}-`))
    .flatMap((e) => e.lines).filter((l) => l.account === 'CASH').reduce((sum, l) => sum + l.amount, 0);
}

/** 측정용 설정 변환. 원화 매입 단가를 만드는 자리는 이 함수 하나다. */
export function withRiskLevel(config: ScenarioConfig, level: 'R0' | 'R1' | 'R2' | 'R3', profile: RiskProfile): ScenarioConfig {
  if (level === 'R0') return config;
  if (!config.operations) throw new Error('위험 단계는 운영 설정이 필요합니다');
  const c = structuredClone(config);
  c.rules.rulesVersion = 'M2a-rules-3';
  c.operations!.risk = { profile: structuredClone(profile), layers: level === 'R3'
    ? ['FX', 'TARIFF', 'SURCHARGE', 'CLAIM', 'COLLECTION'] : level === 'R2' ? ['FX', 'TARIFF', 'SURCHARGE'] : ['FX'] };
  // 공유 프로필에서 이 시나리오에 없는 품목만 제외한다. 필요한 행의 누락은 실행 시 예외로 남긴다.
  const usedGoods = new Set(config.goods.map((g) => g.id));
  const usedProfile = c.operations!.risk.profile;
  usedProfile.tariff.base = usedProfile.tariff.base.filter((row) => usedGoods.has(row.goodId));
  usedProfile.claims.byGood = usedProfile.claims.byGood.filter((row) => usedGoods.has(row.goodId));
  for (const row of c.operations!.market.rows) {
    if (row.side === 'BUY') row.basePriceMinor = usdToKrwMinor(row.basePriceMinor, profile.fx.startKrwPerUsd);
  }
  for (const offer of c.offers) {
    if (offer.kind !== 'supplier') continue;
    offer.unitPriceMinor = usdToKrwMinor(offer.unitPriceMinor, profile.fx.startKrwPerUsd);
    offer.currency = 'KRW';
  }
  return c;
}

export const isRiskRules = (v: string): boolean => v === 'M2a-rules-3' || v === 'M2a-rules-4';

/** 판본 4도 같은 원화 변환을 쓰되, 외상 설정과 층은 별도로 고정한다. */
export function withRiskLevelV2(config: ScenarioConfig, level: 'R0P' | 'R1' | 'R2' | 'R3' | 'R4',
  profile: RiskProfile, credit: CreditProfile): ScenarioConfig {
  if (profile.id !== credit.profileId) throw new Error('위험 프로필과 외상 프로필 ID가 다릅니다');
  const c = withRiskLevel(config, level === 'R0P' ? 'R1' : level === 'R4' ? 'R3' : level, profile);
  c.rules.rulesVersion = 'M2a-rules-4';
  c.operations!.risk!.credit = structuredClone(credit);
  delete c.operations!.risk!.credit.saleMarginK;
  const k = credit.saleMarginK ?? 0;
  for (const row of c.operations!.market.rows) {
    if (row.side !== 'SELL') continue;
    // 입력의 BUY는 USD 센트다. 변환된 사본의 원화 BUY를 쓰지 않는다.
    const buys = config.operations!.market.rows.filter((r) => r.side === 'BUY' && r.goodId === row.goodId);
    if (buys.length !== 1) throw new Error(`판매 마진 계산에는 품목별 BUY 행이 하나 필요합니다: ${row.goodId}`);
    const sell = divHalfAway(row.basePriceMinor * 100 + buys[0]!.basePriceMinor * 5 * k, 100);
    if (sell < 1) throw new Error(`판매 마진 적용 후 SELL은 1센트 이상이어야 합니다: ${row.goodId}`);
    row.basePriceMinor = sell;
  }
  if (level === 'R0P') c.operations!.risk!.layers = [];
  if (level === 'R4') c.operations!.risk!.layers.push('DEFAULT', 'CARRY');
  return c;
}
