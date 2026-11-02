import { carryAccrued, divHalfAway, isRiskRules, receivedForInvoice, dutyFor, referenceRate, rowCurrency, usdToKrwMinor } from './risk';
import { offerDef } from './market';
import { fixedCostsDue, lateDeliveryReduction, unpaidByCurrency } from './operations';
import type { OperationsState } from './types';
// 상태에서 계산하는 보고 값. 별도의 현금·이익을 저장하지 않는다.

import { listSailings, offerOf, routeBetween, routeOf } from './catalog';
import { contractAmount, summarize, type BookSummary } from './ledger';
import { cashReservations, spaceShortfall } from './reservations';
import type { Currency } from './money';
import type { Contract, ContractKind, GameState, ScenarioConfig } from './types';

export interface ContractReport {
  contract: Contract;
  /** 직접 무역: 상품 매출. 운송 주선: 서비스 매출. 한 계약에는 한 종류만 있다. */
  netRevenue: number;
  /** 직접 무역: 매출원가(매입+운임+관세). 운송 주선: 주선 원가(외부 운임). */
  directCost: number;
  cancellationExpense: number;
  contribution: number;
}

/** 모든 금액·기여는 선택한 통화 몫이다. 서로 다른 통화를 합하지 않는다. */
export function contractReport(s: GameState, contract: Contract, currency = contract.currency): ContractReport {
  const c = currency;
  const amount = (a: Parameters<typeof contractAmount>[3]) => contractAmount(s.ledger, c, contract.id, a);
  const netRevenue = amount('REVENUE') + amount('FORWARDING_REVENUE') + amount('SALES_ALLOWANCE');
  const directCost = amount('COST_OF_GOODS_SOLD') + amount('FORWARDING_COST');
  const cancellationExpense = amount('CANCELLATION_EXPENSE');
  return {
    contract,
    netRevenue,
    directCost,
    cancellationExpense,
    contribution: netRevenue - directCost - cancellationExpense - amount('RECEIVABLE_CARRY') - amount('BAD_DEBT'),
  };
}

export interface CompanyReport {
  trade: BookSummary;
  /** 원화 비용: 급여·영입 계약금·trainingExpense(훈련비)를 따로 집계한다. */
  payroll: BookSummary;
  contracts: ContractReport[];
  /** 회사 소유 재고 수량 (인도 전). 고객 화물은 포함하지 않는다. */
  inventoryUnits: number;
  /** 운송 주선으로 맡고 있는 고객 화물 수량 (회사 자산 아님). */
  customerCargoUnits: number;
}

export function companyReport(s: GameState, config: ScenarioConfig): CompanyReport {
  const held = (owner: 'COMPANY' | 'CUSTOMER') =>
    s.cargoLots
      .filter((l) => l.owner === owner && l.status !== 'DELIVERED' && l.status !== 'RETURNED_TO_OWNER')
      .reduce((a, l) => a + l.quantity, 0);
  return {
    trade: summarize(s.ledger, config.tradeCurrency),
    payroll: summarize(s.ledger, config.payrollCurrency),
    contracts: s.contracts.map((c) => contractReport(s, c)),
    inventoryUnits: held('COMPANY'),
    customerCargoUnits: held('CUSTOMER'),
  };
}

/** 견적 수락 전 비교용 예상치. 지연·취소가 없다는 가정의 계산이며 결과를 보장하지 않는다. */
export interface QuotePreview {
  kind: 'DIRECT_TRADE' | 'FORWARDING';
  routeId: string;
  purchase: number;
  freight: number;
  duty: number;
  /** 직접 무역: 판매대금. 운송 주선: 서비스 대금. */
  sale: number;
  /** 규칙 3: 원화 매입 제외, 판단 값 아님. */
  contributionBeforePayroll: number;
  /** 수락하려면 필요한 돈. 규칙 3: 원화 매입 제외, 판단 값 아님. */
  cashNeed: number;
  departureDay: number | null;
  arrivalDay: number | null;
  deliveryDeadlineDay: number;
  /** 다음 출항편으로 보내면 납기를 넘기는가. */
  lateOnNextSailing: boolean;
  /** 계약서의 대금일. */
  paymentDueDay: number;
  /** 다음 출항편으로 보낼 때 실제로 받는 날. 인도 전에는 받지 않으므로 계약상 대금일보다 늦을 수 있다. */
  receiptDay: number;
  surchargeMaxBp?: number;
  cashNeedByCurrency?: { currency: Currency; amountMinor: number }[];
  /** 추정, 환율이 바뀌면 달라짐. 저장·결산 금액이 아니다. */
  referenceEstimate?: { rateKrwPerUsd: number; saleKrw: number; pnlKrw: number };
  schedule: { day: number; labelKo: string; amount: number; currency?: Currency }[];
}

export function preview(
  config: ScenarioConfig,
  kind: 'DIRECT_TRADE' | 'FORWARDING',
  fromCityId: string,
  toCityId: string,
  bookingDay: number,
  money: { purchase: number; sale: number },
  deadline: number,
  paymentDueDay: number,
  opts?: { goodId?: string; purchaseCurrency?: Currency },
): QuotePreview | null {
  const risk = isRiskRules(config.rules.rulesVersion);
  if (risk && kind === 'DIRECT_TRADE' && !opts?.goodId) throw new Error('규칙 3 직접 무역 미리보기에는 품목이 필요합니다');
  const purchaseCurrency = opts?.purchaseCurrency ?? (risk ? rowCurrency(config, 'BUY') : config.tradeCurrency);
  const route = routeBetween(config, fromCityId, toCityId);
  if (!route) return null;
  const sailing = listSailings(config, route.id, bookingDay + 1)[0];
  const freight = route.bookingFeeMinor;
  const duty = kind === 'DIRECT_TRADE' ? dutyFor(config, config.seed, opts?.goodId ?? '', toCityId,
    sailing?.scheduledArrivalDay ?? bookingDay, bookingDay, money.purchase, purchaseCurrency, bookingDay) : 0;
  const arrival = sailing ? sailing.scheduledArrivalDay : null;
  const release = arrival === null ? null : arrival + config.terms.customsDays;
  const late = release !== null && release > deadline;
  const sale = money.sale - lateDeliveryReduction(config, money.sale, release === null ? 0 : release - deadline);
  const due = release === null ? paymentDueDay : Math.max(paymentDueDay, release);
  const schedule: QuotePreview['schedule'] = [];
  if (money.purchase) schedule.push({ day: bookingDay, labelKo: '매입 대금 지급', amount: -money.purchase });
  schedule.push({ day: bookingDay, labelKo: '운임 선지급', amount: -freight });
  if (arrival !== null) {
    schedule.push(kind === 'FORWARDING'
      ? { day: arrival, labelKo: '도착 (고객 화물: 관세는 수입자 부담)', amount: 0 }
      : { day: arrival, labelKo: '도착·관세 지급', amount: duty === 0 ? 0 : -duty });
  }
  if (release !== null) schedule.push({ day: release, labelKo: kind === 'FORWARDING' ? '인도: 주선 매출·채권 인식 (현금 변화 없음)' : '인도: 매출·채권 인식 (현금 변화 없음)', amount: 0 });
  schedule.push({ day: due, labelKo: '외상대금 수금', amount: sale });
  const usdPurchase = risk && purchaseCurrency === 'KRW' ? 0 : money.purchase;
  // 상태 없는 미리보기는 config.seed를 쓴다. 정상 실행에서는 상태 시드와 같다.
  const rate = risk ? referenceRate(config, config.seed, bookingDay) : 0;
  const saleKrw = risk ? usdToKrwMinor(sale, rate) : 0;
  if (risk) for (const row of schedule) row.currency = row.labelKo === '매입 대금 지급' ? purchaseCurrency : 'USD';
  return {
    ...(risk ? { cashNeedByCurrency: purchaseCurrency === 'KRW' && money.purchase
      ? [{ currency: purchaseCurrency, amountMinor: money.purchase }, { currency: 'USD' as const, amountMinor: freight + duty }]
      : [{ currency: 'USD' as const, amountMinor: usdPurchase + freight + duty }],
      referenceEstimate: { rateKrwPerUsd: rate, saleKrw,
        pnlKrw: saleKrw - (purchaseCurrency === 'KRW' ? money.purchase : 0) - usdToKrwMinor(usdPurchase + freight + duty, rate) } } : {}),
    ...(risk && kind === 'DIRECT_TRADE' && config.operations?.risk?.layers.includes('SURCHARGE')
      ? { surchargeMaxBp: config.operations.risk.profile.surcharge.maxBp } : {}),
    kind,
    routeId: route.id,
    purchase: money.purchase,
    freight,
    duty,
    sale,
    contributionBeforePayroll: sale - usdPurchase - freight - duty,
    cashNeed: usdPurchase + freight + duty,
    departureDay: sailing?.departureDay ?? null,
    arrivalDay: arrival,
    deliveryDeadlineDay: deadline,
    lateOnNextSailing: late,
    paymentDueDay,
    receiptDay: due,
    schedule,
  };
}

export function tradePreview(config: ScenarioConfig, buyOfferId: string, sellOfferId: string, bookingDay: number): QuotePreview | null {
  const buy = offerOf(config, buyOfferId);
  const sell = offerOf(config, sellOfferId);
  if (!buy || !sell) return null;
  return preview(
    config,
    'DIRECT_TRADE',
    buy.cityId,
    sell.cityId,
    bookingDay,
    { purchase: buy.unitPriceMinor * buy.quantity, sale: sell.unitPriceMinor * sell.quantity },
    config.terms.deliveryDeadlineDay ?? sell.deliveryDeadlineDay ?? config.campaignDays,
    config.terms.paymentDueDay ?? sell.paymentDueDay ?? config.campaignDays,
    { goodId: buy.goodId, purchaseCurrency: buy.currency },
  );
}

export function forwardingPreview(config: ScenarioConfig, offerId: string, bookingDay: number): QuotePreview | null {
  const offer = offerOf(config, offerId);
  if (!offer?.destinationCityId) return null;
  return preview(
    config,
    'FORWARDING',
    offer.cityId,
    offer.destinationCityId,
    bookingDay,
    { purchase: 0, sale: offer.serviceFeeMinor },
    offer.deliveryDeadlineDay ?? config.campaignDays,
    offer.paymentDueDay ?? config.campaignDays,
  );
}

/** 시나리오에서 묶을 수 있는 직접 무역 쌍 (같은 상품·같은 수량, 노선 있음). */
export function tradePairs(config: ScenarioConfig): { buyOfferId: string; sellOfferId: string }[] {
  const pairs: { buyOfferId: string; sellOfferId: string }[] = [];
  for (const buy of config.offers.filter((o) => o.kind === 'supplier')) {
    for (const sell of config.offers.filter((o) => o.kind === 'customer')) {
      if (buy.goodId === sell.goodId && buy.quantity === sell.quantity && routeBetween(config, buy.cityId, sell.cityId)) {
        pairs.push({ buyOfferId: buy.id, sellOfferId: sell.id });
      }
    }
  }
  return pairs;
}

export interface DeliveryFilter {
  currency?: Currency;
  kind?: ContractKind;
  /** 고객 또는 공급자 ID와 일치하는 계약. */
  partyId?: string;
}

export interface OnTimeDelivery {
  delivered: number;
  onTime: number;
  late: number;
  /** 정시 건수 × 10000 ÷ 인도 건수의 내림. 인도 실적이 없으면 null. */
  rateBasisPoints: number | null;
  /** 분모에서 제외하는 납기 경과 미인도 계약. */
  pastDeadlineUndelivered: number;
}

export function onTimeDeliveryRate(s: GameState, filter: DeliveryFilter = {}): OnTimeDelivery {
  let onTime = 0;
  let late = 0;
  let pastDeadlineUndelivered = 0;
  for (const c of s.contracts) {
    if (c.status === 'CANCELLED'
      || (filter.currency !== undefined && c.currency !== filter.currency)
      || (filter.kind !== undefined && c.kind !== filter.kind)
      || (filter.partyId !== undefined && c.customerId !== filter.partyId && c.supplierId !== filter.partyId)) continue;
    if (c.deliveredDay === null) {
      if (c.deliveryDeadlineDay < s.day) pastDeadlineUndelivered++;
    } else if (c.deliveredDay <= c.deliveryDeadlineDay) onTime++;
    else late++;
  }
  const delivered = onTime + late;
  return { delivered, onTime, late, rateBasisPoints: delivered ? Math.floor(onTime * 10000 / delivered) : null, pastDeadlineUndelivered };
}

export type UpcomingPaymentKind = 'OVERDUE' | 'WAGE' | 'FREIGHT' | 'DUTY' | 'RENT' | 'SPACE_FEE';

export interface UpcomingPayment {
  kind: UpcomingPaymentKind;
  currency: Currency;
  amountMinor: number;
  /** 발생일·급여일·예약 마감일·도착 예정일. 미정이면 null. */
  day: number | null;
  trigger: 'AUTO' | 'ON_BOOKING' | 'OVERDUE';
  contractId: string | null;
  employeeIds: string[];
  /** (kind, sourceId)로 행을 식별한다. 급여는 날짜와 통화를 함께 쓴다. */
  sourceId: string;
  labelKo: string;
}

/**
 * 표시용 지급 일정. 급여를 계약 자금 예약에 추가하지 않는다.
 * `throughDay`는 캠페인 마지막 날(`config.campaignDays`)로 잘린다. 엔진은 그 뒤 날을 처리하지 않는다.
 */
export function upcomingPayments(
  s: GameState,
  config: ScenarioConfig,
  throughDay: number = Math.min(config.campaignDays, s.day + 6),
): UpcomingPayment[] {
  const overdue: UpcomingPayment[] = s.obligations.filter((o) => o.paidDay === null).map((o) => ({
    kind: 'OVERDUE', currency: o.currency, amountMinor: o.amountMinor, day: o.incurredDay,
    trigger: 'OVERDUE', contractId: null, employeeIds: [], sourceId: o.id, labelKo: `미지급: ${o.reasonKo}`,
  }));
  overdue.sort((a, b) => a.day! - b.day! || compareText(a.sourceId, b.sourceId));
  if (s.phase === 'ENDED') return overdue;

  const last = Math.min(throughDay, config.campaignDays);
  const rows: UpcomingPayment[] = [];
  for (let day = s.day; day <= last; day++) {
    for (const cost of fixedCostsDue(s, config, day)) {
      if (s.ledger.postedIds[cost.id]) continue;
      rows.push({ kind: cost.account === 'RENT_EXPENSE' ? 'RENT' : 'SPACE_FEE', currency: cost.currency,
        amountMinor: cost.amountMinor, day, trigger: 'AUTO', contractId: null, employeeIds: [],
        sourceId: cost.id, labelKo: cost.reasonKo });
    }
    const wages = new Map<Currency, UpcomingPayment>();
    for (const emp of s.employees) {
      if (emp.employmentStatus !== 'employed' || emp.availableFromDay > day) continue;
      const def = config.employees.find((e) => e.id === emp.id);
      if (!def || def.salaryPerDayMinor <= 0) continue;
      let row = wages.get(def.salaryCurrency);
      if (!row) {
        row = { kind: 'WAGE', currency: def.salaryCurrency, amountMinor: 0, day, trigger: 'AUTO',
          contractId: null, employeeIds: [], sourceId: `WAGE-D${String(day).padStart(3, '0')}-${def.salaryCurrency}`, labelKo: '' };
        wages.set(def.salaryCurrency, row);
      }
      row.amountMinor += def.salaryPerDayMinor;
      row.employeeIds.push(emp.id);
    }
    for (const row of wages.values()) {
      row.labelKo = `${row.employeeIds.length}명 급여`;
      rows.push(row);
    }
  }
  for (const reservation of cashReservations(s, config)) {
    const c = s.contracts.find((c) => c.id === reservation.contractId)!;
    let day: number | null = null;
    if (reservation.kind === 'FREIGHT') {
      const route = routeBetween(config, c.originCityId, c.destinationCityId);
      const sailing = route && listSailings(config, route.id, s.day + 1)
        .find((sailing) => spaceShortfall(s, config, sailing, c.goodId, c.quantity) === null);
      if (sailing) day = sailing.departureDay - 1;
    } else {
      const shipment = s.shipments.find((sh) => sh.contractId === c.id);
      const booking = s.bookings.find((b) => b.id === c.bookingId && b.status !== 'CANCELLED');
      if (shipment) day = Math.max(shipment.scheduledArrivalDay, s.day);
      else if (booking) day = booking.departureDay + routeOf(config, booking.routeId).transitDays;
    }
    if (day !== null && day > last) continue;
    rows.push({ ...reservation, day, trigger: reservation.kind === 'FREIGHT' ? 'ON_BOOKING' : 'AUTO',
      employeeIds: [], sourceId: c.id,
      labelKo: reservation.kind === 'FREIGHT' ? `${c.id} 운임 (예약 때 선지급)` : `${c.id} 수입 관세 (도착 때)`,
    });
  }
  const order = { OVERDUE: 0, RENT: 1, SPACE_FEE: 2, WAGE: 3, FREIGHT: 4, DUTY: 5 };
  rows.sort((a, b) => (a.day === null ? Infinity : a.day) - (b.day === null ? Infinity : b.day)
    || order[a.kind] - order[b.kind] || compareText(a.currency, b.currency) || compareText(a.sourceId, b.sourceId));
  return [...overdue, ...rows];
}

/** 실행 환경의 로케일에 영향을 받지 않는 ID·통화 정렬. */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface CurrencyStanding {
  currency: Currency;
  cash: number;
  inventory: number;
  prepaidFreight: number;
  forwardingWip: number;
  accountsReceivable: number;
  accountsPayable: number;
  totalAssets: number;
  /** 자산 합계 − 미지급금 = 시작 자본 + 누적 손익 + 통화 간 이체. */
  netAssets: number;
  openingEquity: number;
  profit: number;
  /** 취소 계약을 포함한 이 통화 계약의 기여이익 합계. */
  contractContribution: number;
  rentExpense: number;
  facilitySetupExpense: number;
  spaceContractExpense: number;
  fxSpreadExpense: number;
  currencyTransferNet: number;

}

export interface CampaignSummary {
  ended: boolean;
  campaignDays: number;
  lastClosedDay: number;
  byCurrency: CurrencyStanding[];
  onTime: OnTimeDelivery;
  contracts: { total: number; completed: number; awaitingPayment: number; inProgress: number; cancelled: number };
  openInvoices: { invoiceId: string; contractId: string; currency: Currency; amountMinor: number; dueDay: number }[];
  operations?: { outcome: OperationsState['outcome']; failure: OperationsState['failure'];
    arrearsAtEnd: ReturnType<typeof unpaidByCurrency>; defaultEvents: OperationsState['defaultEvents'];
    fixedCostsByCurrency: { currency: Currency; rentExpense: number; facilitySetupExpense: number; spaceContractExpense: number; fxSpreadExpense: number }[]; exchanges: OperationsState['exchanges'] };
  unpaidObligations: { obligationId: string; currency: Currency; amountMinor: number; incurredDay: number; reasonKo: string }[];
}

/** 호출한 순간의 장부와 계약을 읽는다. 통화 환산·실패 판정·수금 예측은 하지 않는다. */
export function campaignSummary(s: GameState, config: ScenarioConfig): CampaignSummary {
  const currencies = [...new Set([config.tradeCurrency, config.payrollCurrency,
    ...s.ledger.entries.map((e) => e.currency).sort(compareText)])];
  const byCurrency = currencies.map((currency): CurrencyStanding => {
    const b = summarize(s.ledger, currency);
    return {
      currency, cash: b.cash, inventory: b.inventory, prepaidFreight: b.prepaidFreight, forwardingWip: b.forwardingWip,
      accountsReceivable: b.accountsReceivable, accountsPayable: b.accountsPayable, totalAssets: b.totalAssets,
      netAssets: b.totalAssets - b.accountsPayable, openingEquity: b.openingEquity, profit: b.profit,
      rentExpense: b.rentExpense,
      facilitySetupExpense: b.facilitySetupExpense,
      spaceContractExpense: b.spaceContractExpense,
      fxSpreadExpense: b.fxSpreadExpense,
      currencyTransferNet: b.currencyTransferNet,
      contractContribution: s.contracts.filter((c) => s.ledger.entries.some((e) => e.contractId === c.id && e.currency === currency))
        .reduce((sum, c) => sum + contractReport(s, c, currency).contribution, 0),
    };
  });
  const contracts = { total: s.contracts.length, completed: 0, awaitingPayment: 0, inProgress: 0, cancelled: 0 };
  for (const c of s.contracts) {
    if (c.status === 'COMPLETED') contracts.completed++;
    else if (c.status === 'CANCELLED') contracts.cancelled++;
    else if (c.deliveredDay !== null) contracts.awaitingPayment++;
    else contracts.inProgress++;
  }
  return {
    ...(config.operations && s.operations ? { operations: { outcome: s.operations.outcome, failure: structuredClone(s.operations.failure),
      arrearsAtEnd: unpaidByCurrency(s, config), defaultEvents: structuredClone(s.operations.defaultEvents), exchanges: structuredClone(s.operations.exchanges),
      fixedCostsByCurrency: byCurrency.map((b) => ({ currency: b.currency, rentExpense: b.rentExpense, facilitySetupExpense: b.facilitySetupExpense, spaceContractExpense: b.spaceContractExpense, fxSpreadExpense: b.fxSpreadExpense })) } } : {}),
    ended: s.phase === 'ENDED', campaignDays: config.campaignDays,
    lastClosedDay: s.closedDays.reduce((last, day) => Math.max(last, day), 0), byCurrency,
    onTime: onTimeDeliveryRate(s), contracts,
    openInvoices: s.invoices.filter((i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF').map((i) => ({
      invoiceId: i.id, contractId: i.contractId, currency: i.currency, amountMinor: i.amountMinor - receivedForInvoice(s, i.id), dueDay: i.dueDay,
    })).sort((a, b) => a.dueDay - b.dueDay || compareText(a.invoiceId, b.invoiceId)),
    unpaidObligations: s.obligations.filter((o) => o.paidDay === null).map((o) => ({
      obligationId: o.id, currency: o.currency, amountMinor: o.amountMinor, incurredDay: o.incurredDay, reasonKo: o.reasonKo,
    })).sort((a, b) => a.incurredDay - b.incurredDay || compareText(a.obligationId, b.obligationId)),
  };
}

/** 약정된 청구 결제일과 원장의 실제 수금만 보여 준다. */


interface RiskFlow { amount: number; currency: Currency; day: number; cost: boolean }

/** 추정, 환율이 바뀌면 달라짐. 원장의 현금과 평가일까지 알려진 남은 흐름만 읽고 저장하지 않는다. */
export function contractRiskReport(s: GameState, config: ScenarioConfig, contractId: string) {
  const c = s.contracts.find((v) => v.id === contractId);
  if (!c) throw new Error(`계약이 없습니다: ${contractId}`);
  const evaluationDay = s.phase === 'ENDED' ? s.operations?.failure?.day ?? config.campaignDays : s.day;
  const cfg = { ...config, seed: s.rng.seed }; // 정상 실행에서는 설정·상태 시드가 같다.
  const buyCurrency = c.buyOfferId ? offerDef(s, config, c.buyOfferId)!.currency : c.currency;
  const p = preview(cfg, c.kind, c.originCityId, c.destinationCityId, c.acceptedDay,
    { purchase: c.purchaseAmountMinor, sale: c.saleAmountMinor }, c.deliveryDeadlineDay, c.paymentDueDay,
    { goodId: c.goodId, purchaseCurrency: buyCurrency });
  if (!p || !config.operations) throw new Error('계약 손익에는 노선과 운영 설정이 필요합니다');
  const rateAt = (day: number) => referenceRate(config, s.rng.seed, Math.min(day, evaluationDay));
  // 같은 환율의 USD 비용을 합친 뒤 한 번 반올림한다. 판매·수금은 각각 환산한다.
  const value = (flows: RiskFlow[], fixedRate?: number): number => {
    let total = 0;
    const costs = new Map<number, number>();
    for (const f of flows) {
      if (f.currency === 'KRW') { total += f.amount; continue; }
      const rate = fixedRate ?? rateAt(f.day);
      if (f.cost) costs.set(rate, (costs.get(rate) ?? 0) + f.amount);
      else total += usdToKrwMinor(f.amount, rate);
    }
    for (const [rate, amount] of costs) total += usdToKrwMinor(amount, rate);
    return total;
  };
  const flow = (amount: number, day: number, cost = true, currency: Currency = c.currency): RiskFlow => ({ amount, day, cost, currency });
  const entries = s.ledger.entries.filter((e) => e.contractId === c.id && e.day <= evaluationDay);
  const ids = new Set(entries.map((e) => e.id));
  const obligations = s.obligations.filter((o) => ids.has(o.id));
  const settlements = s.ledger.entries.filter((e) => e.day <= evaluationDay && obligations.some((o) => e.id === `SETTLE-${o.id}`));
  const cashFlows = [...entries, ...settlements].flatMap((e) => e.lines.filter((l) => l.account === 'CASH')
    .map((l) => flow(l.amount, e.day, !e.id.startsWith('RECEIPT-'), e.currency)));
  const prepayments = entries.filter((e) => e.id.startsWith('FREIGHT-PREPAY-'));
  const firstPrepayment = prepayments[0];
  const shipment = s.shipments.find((sh) => sh.contractId === c.id);
  const booking = s.bookings.find((b) => b.id === c.bookingId && b.status === 'BOOKED');
  const route = routeOf(config, p.routeId);
  const tariffDay = shipment ? Math.max(shipment.scheduledArrivalDay, evaluationDay)
    : booking ? booking.departureDay + route.transitDays
      : listSailings(config, route.id, evaluationDay + 1)[0]?.scheduledArrivalDay ?? evaluationDay;
  const dutyEntry = entries.find((e) => e.id.startsWith('DUTY-'));
  const arrived = !!shipment && shipment.dutyMinor !== null;
  const cancelled = c.status === 'CANCELLED';
  const invoice = s.invoices.find((i) => i.contractId === c.id);
  const deliveryDay = c.deliveredDay ?? Math.max(evaluationDay, shipment?.releaseDay ?? tariffDay + config.terms.customsDays);
  const sale = c.saleAmountMinor - (c.deliveredDay !== null ? c.priceReductionMinor
    : lateDeliveryReduction(config, c.saleAmountMinor, deliveryDay - c.deliveryDeadlineDay));
  const receipts = entries.filter((e) => e.id.startsWith('RECEIPT-')).flatMap((e) => e.lines.filter((l) => l.account === 'CASH'))
    .reduce((n, l) => n + l.amount, 0);
  const pendingDuty = !cancelled && c.kind === 'DIRECT_TRADE' && !arrived
    ? dutyFor(config, s.rng.seed, c.goodId, c.destinationCityId, tariffDay, evaluationDay,
      c.purchaseAmountMinor, buyCurrency, c.acceptedDay) : null;
  const v2 = config.rules.rulesVersion === 'M2a-rules-4';
  const writtenOff = v2 && invoice?.status === 'WRITTEN_OFF';
  const carryEntries = v2 ? entries.filter((e) => e.id.startsWith('CARRY-')) : [];
  const postedCarry = carryEntries.flatMap((e) => e.lines).filter((l) => l.account === 'RECEIVABLE_CARRY')
    .reduce((sum, l) => sum + l.amount, 0);
  const lastClosedDay = s.closedDays.reduce((last, day) => Math.max(last, day), 0);
  const pendingCarry = v2 && invoice ? divHalfAway(carryAccrued(s, cfg, invoice.id, Math.min(evaluationDay, lastClosedDay) + 1), 10000) - postedCarry : 0;
  const remaining: RiskFlow[] = [];
  if (!cancelled) {
    const outstanding = writtenOff ? 0 : invoice ? invoice.amountMinor - receipts : c.status === 'COMPLETED' ? 0 : sale;
    if (outstanding) remaining.push(flow(outstanding, evaluationDay, false));
    if (!shipment && !booking) remaining.push(flow(-p.freight, evaluationDay));
    if (pendingDuty) remaining.push(flow(-pendingDuty, evaluationDay));
  }
  for (const o of obligations.filter((o) => o.paidDay === null)) remaining.push(flow(-o.amountMinor, evaluationDay, true, o.currency));
  if (pendingCarry) remaining.push(flow(-pendingCarry, evaluationDay));
  const realized = value([...cashFlows, ...remaining]);
  const open = remaining.some((f) => f.amount !== 0);
  // 실현값과 별도로, 기대 흐름의 순차 대체를 계산한다. 단계 차이로 실현값을 만들지 않는다.
  const baseline = [flow(-p.purchase, c.acceptedDay, true, buyCurrency), flow(-p.freight, c.acceptedDay),
    flow(-p.duty, c.acceptedDay), flow(p.sale, c.acceptedDay, false)];
  const expected = value(baseline);
  const paidDay = (id: string | undefined, fallback: number) => {
    const o = obligations.find((o) => o.id === id);
    return o ? o.paidDay ?? evaluationDay : fallback;
  };
  const fxFlows = baseline.map((f) => ({ ...f }));
  fxFlows[1]!.day = firstPrepayment?.day ?? (cancelled ? c.acceptedDay : evaluationDay);
  fxFlows[2]!.day = cancelled ? c.acceptedDay : dutyEntry ? paidDay(dutyEntry.id, dutyEntry.day)
    : arrived ? shipment.arrivalDay! : evaluationDay;
  fxFlows[3]!.day = cancelled ? c.acceptedDay : invoice?.dueDay ?? Math.max(c.paymentDueDay, deliveryDay);
  const afterFx = value(fxFlows);
  const tariffFlows = fxFlows.map((f) => ({ ...f }));
  if (!cancelled && c.kind === 'DIRECT_TRADE') tariffFlows[2]!.amount =
    -(dutyEntry?.lines.find((l) => l.account === 'INVENTORY')?.amount ?? (arrived ? 0 : (pendingDuty ?? 0)));
  const afterTariff = value(tariffFlows);
  const surchargeFlows = [...tariffFlows];
  if (!cancelled && c.kind === 'DIRECT_TRADE') for (const e of entries.filter((e) => e.id.startsWith('SURCHARGE-'))) {
    const amount = e.lines.find((l) => l.account === 'INVENTORY')!.amount;
    surchargeFlows.push(flow(-amount, paidDay(e.id, e.day), true, e.currency));
  }
  const afterSurcharge = value(surchargeFlows);
  const lateFlows = surchargeFlows.map((f) => ({ ...f }));
  if (!cancelled) lateFlows[3]!.amount = sale;
  const afterLate = value(lateFlows);
  const claimFlows = lateFlows.map((f) => ({ ...f }));
  if (!cancelled && c.kind === 'DIRECT_TRADE') {
    const claim = entries.find((e) => e.id === `CLAIM-${c.id}`);
    if (claim) claimFlows[3]!.amount = sale - claim.lines.filter((l) => l.account === 'SALES_ALLOWANCE').reduce((n, l) => n + l.amount, 0);
  }
  const afterClaim = value(claimFlows);
  const cancelFlows = cancelled ? claimFlows.filter((_, i) => i === 0 || (i === 1 && !!firstPrepayment)) : [...claimFlows];
  if (!cancelled && firstPrepayment && !shipment && !booking) cancelFlows.push(flow(-p.freight, evaluationDay));
  const adjustments = new Set(entries.filter((e) => e.id.startsWith('FREIGHT-RELEASE-') || e.id.startsWith('CANCEL-COMP-')
    || (e.id.startsWith('FREIGHT-PREPAY-') && e !== firstPrepayment)).map((e) => e.id));
  for (const e of [...entries, ...settlements]) {
    if (!adjustments.has(e.id) && !(e.id.startsWith('SETTLE-') && adjustments.has(e.id.slice('SETTLE-'.length)))) continue;
    for (const l of e.lines) if (l.account === 'CASH') cancelFlows.push(flow(l.amount, e.day, true, e.currency));
  }
  // 취소 보상이 미지급이면 현금 지급 때까지 평가일의 의무로 남는다.
  for (const o of obligations) if (o.paidDay === null && adjustments.has(o.id)) cancelFlows.push(flow(-o.amountMinor, evaluationDay, true, o.currency));
  const afterCancel = value(cancelFlows);
  const collectionFlows = !cancelled && invoice ? cancelFlows.filter((_, i) => i !== 3) : [...cancelFlows];
  const recoveryId = invoice ? `RECEIPT-RCPT-${invoice.id}-R` : '';
  const confirmationDay = writtenOff ? entries.find((e) => e.id === `BADDEBT-${invoice!.id}`)!.day : evaluationDay;
  let uncollected: RiskFlow | undefined;
  if (!cancelled && invoice) {
    let normalReceipts = 0;
    for (const e of entries.filter((e) => e.id.startsWith('RECEIPT-') && (!writtenOff || e.id !== recoveryId))) {
      for (const l of e.lines) if (l.account === 'CASH') {
        collectionFlows.push(flow(l.amount, e.day, false, e.currency));
        normalReceipts += l.amount;
      }
    }
    const outstanding = invoice.amountMinor - normalReceipts;
    if (outstanding) {
      uncollected = flow(outstanding, confirmationDay, false, invoice.currency);
      collectionFlows.push(uncollected);
    }
  }
  // 판본 4: 미회수액을 확정일의 회수액으로 바꾼 뒤, 실제·미기재 이자 비용을 더한다.
  const defaultFlows = writtenOff ? collectionFlows.filter((f) => f !== uncollected) : [...collectionFlows];
  if (writtenOff) for (const e of entries.filter((e) => e.id === recoveryId)) {
    for (const l of e.lines) if (l.account === 'CASH') defaultFlows.push(flow(l.amount, e.day, false, e.currency));
  }
  const carryFlows = [...defaultFlows];
  for (const e of carryEntries) for (const l of e.lines) if (l.account === 'CASH') carryFlows.push(flow(l.amount, e.day, true, e.currency));
  if (pendingCarry) carryFlows.push(flow(-pendingCarry, evaluationDay));
  const components = { schedule: 0, fx: afterFx - expected, tariff: afterTariff - afterFx, surcharge: afterSurcharge - afterTariff,
    late: afterLate - afterSurcharge, claim: afterClaim - afterLate, cancel: afterCancel - afterClaim, collection: value(collectionFlows) - afterCancel,
    ...(v2 ? { default: value(defaultFlows) - value(collectionFlows), carry: value(carryFlows) - value(defaultFlows) } : {}),
    open_valuation: 0, residual: 0 };
  components.residual = realized - expected - Object.values(components).reduce((sum, n) => sum + n, 0);
  return { contractId, kind: c.kind, evaluationDay, expected, realized, open,
    openFixedRateKrw: value(cashFlows) + value(remaining, config.operations.fx.baseKrwPerUsd), components };
}
