// 규칙 2 화면의 읽기 모델. 명령과 준비 예측은 사본에서 실행한다.
import { cargoSpace, listSailings, routeBetween } from './catalog';
import { workloadSummary } from './capacity';
import { isAvailableFromToday } from './employees';
import { creditTermCheck, planState } from './engine';
import { offerDef, prepWorkUnitsFor } from './market';
import { formatMoney } from './money';
import { allocateHandling, dailyKrwDue, exchangeAmounts, handlingCapacityPt, isHomePrep, lateDeliveryReduction, projectPrepCompletion,
  rentDueMinor, rentEntryId, spaceCovered, storageCapacityLiters, storageUsedLiters, usdLotKrw } from './operations';
import { payrollRunwayDay } from './previews';
import { preview, type QuotePreview } from './reports';
import { fundsPosition, runningTaskOf, sailingLoad, spaceShortfall } from './reservations';
import type { EngineCommand, ExchangeDirection, GameState, OfferDef, ScenarioConfig } from './types';

function previewId(s: GameState): string {
  let id = 'OPERATIONS-PREVIEW';
  while (s.processedCommands[id]) id += '-';
  return id;
}
export type QuoteOfferIds = { buyOfferId: string; sellOfferId: string } | { offerId: string };
export interface OperationsQuotePreview extends QuotePreview {
  riskGrades?: { damage: string; credit: string } | null;
  allowed: boolean; reasonKo: string | null;
  quantity: number; maxQuantity: number; quantityStep: number; prepWorkUnits: number;
  volumeLiters: number; massGrams: number; storageAfterLiters: number; storageCapacityLiters: number;
  counterpartySpreadPct: { buy: number | null; sell: number | null };
  serviceClass: OfferDef['serviceClass']; titleKo: string | null;
  /** 규칙 3: 원화 매입 제외, 판단 값 아님. */
  contributionPerPrepPtMinor: number; lateDeliveryReductionMinor: number;
  affectedContracts: { contractId: string; readyBefore: number | null; readyAfter: number | null; missesSailing: boolean }[];
}

export function quotePreview(s: GameState, config: ScenarioConfig, offerIds: QuoteOfferIds, quantity?: number): OperationsQuotePreview {
  const trade = 'buyOfferId' in offerIds;
  const buy = offerDef(s, config, trade ? offerIds.buyOfferId : offerIds.offerId);
  const sell = trade ? offerDef(s, config, offerIds.sellOfferId) : buy;
  const q = trade ? quantity ?? buy?.quantity ?? 0 : buy?.quantity ?? 0;
  const command: EngineCommand = trade
    ? { id: previewId(s), type: 'ACCEPT_TRADE', ...offerIds, quantity }
    : { id: previewId(s), type: 'ACCEPT_FORWARDING', ...offerIds };
  const accepted = planState(s, config, [command]);
  const result = accepted.results[0]!, allowed = result.status === 'APPLIED';
  const deadline = (trade ? config.terms.deliveryDeadlineDay : null) ?? sell?.deliveryDeadlineDay ?? config.campaignDays;
  const due = (trade ? config.terms.paymentDueDay : null) ?? sell?.paymentDueDay ?? config.campaignDays;
  const grossSale = trade ? (sell?.unitPriceMinor ?? 0) * q : buy?.serviceFeeMinor ?? 0;
  const route = buy && sell && routeBetween(config, buy.cityId, trade ? sell.cityId : sell.destinationCityId!);
  // 정상 실행에서는 config.seed와 s.rng.seed가 같다. 상태가 있는 읽기는 상태 시드를 따른다.
  const base = buy && sell && preview({ ...config, seed: s.rng.seed }, trade ? 'DIRECT_TRADE' : 'FORWARDING', buy.cityId,
    trade ? sell.cityId : sell.destinationCityId!, s.day,
    { purchase: trade ? buy.unitPriceMinor * q : 0, sale: grossSale }, deadline, due, { goodId: buy.goodId, purchaseCurrency: buy.currency });
  // 알 수 없는 견적도 명령의 거절 문장을 반환한다. 계산할 수 없는 수치는 0·일정은 null이다.
  const quote: QuotePreview = base || { kind: trade ? 'DIRECT_TRADE' : 'FORWARDING', routeId: route?.id ?? '',
    purchase: 0, freight: 0, duty: 0, sale: 0, contributionBeforePayroll: 0, cashNeed: 0,
    departureDay: null, arrivalDay: null, deliveryDeadlineDay: deadline, lateOnNextSailing: false,
    paymentDueDay: due, receiptDay: due, schedule: [] };
  const prep = buy ? prepWorkUnitsFor(config, buy, q) : 0;
  const space = buy ? cargoSpace(config, buy.goodId, q) : { volumeLiters: 0, massGrams: 0 };
  const spread = (o: OfferDef | undefined, side: 'BUY' | 'SELL') => trade && o
    ? s.operations?.batches.find((b) => b.publishDay === o.publishDay)?.counterpartyPct
      ?.find((p) => p.goodId === o.goodId && p.side === side)?.pct ?? null : null;
  const affectedContracts: OperationsQuotePreview['affectedContracts'] = [];
  if (allowed) {
    const employee = config.employees.find((e) => isAvailableFromToday(s, e.id)
      && s.employees.find((x) => x.id === e.id)?.locationCityId === config.homeCityId && !runningTaskOf(s, e.id));
    const plan = { employeeId: employee?.id };
    let planned = planState(s, config, [{ ...command, plan }]).state;
    // 정시 인도·준비 완료·남은 선복을 모두 만족하는 첫 편을 예약한다.
    for (const sailing of route ? listSailings(config, route.id, s.day + 1) : []) {
      if (sailing.scheduledArrivalDay + config.terms.customsDays > deadline) break;
      if (spaceShortfall(s, config, sailing, buy!.goodId, q)) continue;
      const trial = planState(s, config, [{ ...command, plan: { ...plan, sailingId: sailing.id } }]);
      if (trial.results[0]!.status !== 'APPLIED') continue;
      const newContract = trial.state.contracts.at(-1)!;
      const ready = projectPrepCompletion(trial.state, config, { assignQueued: true }).find((p) => p.contractId === newContract.id)?.readyDay;
      if (ready !== null && ready !== undefined && ready <= sailing.departureDay) { planned = trial.state; break; }
    }
    const before = projectPrepCompletion(s, config, { assignQueued: true });
    const after = projectPrepCompletion(planned, config, { assignQueued: true });
    for (const p of before) {
      const readyAfter = after.find((a) => a.taskId === p.taskId)!.readyDay;
      if ((readyAfter ?? Infinity) <= (p.readyDay ?? Infinity)) continue;
      const booking = s.bookings.find((b) => b.contractId === p.contractId && b.status === 'BOOKED');
      affectedContracts.push({ contractId: p.contractId, readyBefore: p.readyDay, readyAfter,
        missesSailing: readyAfter === null || (!!booking && booking.departureDay < readyAfter) });
    }
  }
  const risk = config.operations?.risk;
  let riskGrades: OperationsQuotePreview['riskGrades'] = null;
  if (risk && trade && buy && sell) {
    const damage = risk.profile.claims.byGood.find((r) => r.goodId === buy.goodId);
    const credit = risk.profile.collections.byCounterparty.find((r) => r.counterpartyId === sell.counterpartyId);
    if (!damage) throw new Error(`클레임 표에 품목이 없습니다: ${buy.goodId}`);
    if (!credit) throw new Error(`수금 표에 거래처가 없습니다: ${sell.counterpartyId}`);
    riskGrades = { damage: damage.grade, credit: credit.grade };
  }
  return { ...quote, ...(risk ? { riskGrades } : {}), allowed, reasonKo: allowed ? null : result.reasonKo, quantity: q,
    maxQuantity: Math.min(buy?.maxQuantity ?? 0, sell?.maxQuantity ?? 0), quantityStep: buy?.quantityStep ?? 0,
    prepWorkUnits: prep, ...space, storageAfterLiters: storageUsedLiters(s, config) + space.volumeLiters,
    storageCapacityLiters: storageCapacityLiters(s, config), counterpartySpreadPct: { buy: spread(buy, 'BUY'), sell: spread(sell, 'SELL') },
    serviceClass: buy?.serviceClass ?? null, titleKo: buy?.titleKo ?? null,
    contributionPerPrepPtMinor: prep > 0 ? Math.floor(quote.contributionBeforePayroll / prep) : 0,
    lateDeliveryReductionMinor: lateDeliveryReduction(config, grossSale, quote.arrivalDay === null ? 0 : quote.arrivalDay + config.terms.customsDays - deadline),
    affectedContracts };
}

export function exchangePreview(s: GameState, config: ScenarioConfig, direction: ExchangeDirection, usdAmountMinor: number) {
  const { state: after, results } = planState(s, config, [{ id: previewId(s), type: 'EXCHANGE_CURRENCY', direction, usdAmountMinor }]);
  const allowed = results[0]!.status === 'APPLIED';
  const { krw: krwMinor, spread: spreadKrwMinor } = exchangeAmounts(config, direction, usdAmountMinor, s.rng.seed, s.day);
  const krwAvailableAfter = fundsPosition(after, config, 'KRW').available, today = dailyKrwDue(s, config, s.day);
  return { allowed, reasonKo: allowed ? null : results[0]!.reasonKo, krwMinor, spreadKrwMinor,
    usdAvailableBefore: fundsPosition(s, config, 'USD').available, usdAvailableAfter: fundsPosition(after, config, 'USD').available,
    krwAvailableBefore: fundsPosition(s, config, 'KRW').available, krwAvailableAfter,
    runwayBefore: payrollRunwayDay(s, config), runwayAfter: payrollRunwayDay(after, config),
    warningKo: allowed && direction === 'KRW_TO_USD' && krwAvailableAfter < today
      ? `환전 뒤 원화 ${formatMoney('KRW', krwAvailableAfter)}으로는 오늘 급여·임차료 ${formatMoney('KRW', today)}을 다 낼 수 없습니다.` : null };
}

function recentBatches(s: GameState) {
  return (s.operations?.batches ?? []).filter((b) => b.k !== 0 && b.publishDay <= s.day)
    .sort((a, b) => a.publishDay - b.publishDay).slice(-4);
}
function batchOffers(s: GameState, publishDay: number) {
  return s.operations!.offers.filter((o) => o.publishDay === publishDay && o.kind !== 'customer');
}
function acceptedPrep(s: GameState, config: ScenarioConfig, publishDay: number, handling: boolean) {
  const ids = new Set(batchOffers(s, publishDay).filter((o) => (o.serviceClass === 'HANDLING') === handling).map((o) => o.id));
  const contracts = new Set(s.contracts.filter((c) => ids.has(c.serviceOfferId ?? c.buyOfferId!)).map((c) => c.id));
  return s.tasks.filter((t) => isHomePrep(t, config) && contracts.has(t.contractId!)).reduce((sum, t) => sum + t.requiredWorkUnits, 0);
}
function candidate(s: GameState, config: ScenarioConfig, id?: string) {
  return config.recruitment?.candidateEmployeeIds.includes(id ?? '') && !s.employees.some((e) => e.id === id && e.employmentStatus === 'employed')
    ? config.employees.find((e) => e.id === id) : undefined;
}
export type BottleneckConstraint = 'DEMAND' | 'STAFF' | 'WAREHOUSE_HANDLING' | 'STORAGE' | 'SAILING';
export interface WeeklyBottleneck {
  unit: 'HANDLING_JOBS_PER_WEEK'; demand: { handlingOffered: number; handlingPt: number; batches: number } | null;
  storageDetail: { otherOccupancyLiters: number; otherPeakLiters: number; handlingDwellDays: number; windowDays: number };
  otherPtPerWeek: number; rows: { constraint: BottleneckConstraint; before: number | null; after: number | null }[];
  binding: { before: BottleneckConstraint[]; after: BottleneckConstraint[] };
  usableBefore: number; usableAfter: number; extraJobsPerWeek: number; remainingHandlingBatches: number;
  contributionPerJobMinor: number; wageKrwPerWeek: number | null; wageUsdLotsPerWeek: number | null;
}
export function weeklyBottleneck(s: GameState, config: ScenarioConfig, candidateId?: string): WeeklyBottleneck {
  const o = config.operations!;
  const templates = o.market.forwarding.templates.filter((t) => t.serviceClass === 'HANDLING');
  const volume = Math.max(...templates.map((t) => cargoSpace(config, t.goodId, t.quantity).volumeLiters));
  const prep = Math.max(...templates.map((t) => t.prepWorkUnits!));
  const batches = recentBatches(s), hire = candidate(s, config, candidateId);
  const offered = batches.reduce((sum, b) => sum + batchOffers(s, b.publishDay).filter((o) => o.serviceClass === 'HANDLING').length, 0);
  const demand = batches.length ? { handlingOffered: offered, handlingPt: offered * prep, batches: batches.length } : null;
  const windowStart = Math.max(1, s.day - 28), windowDays = s.day - windowStart;
  const handling = (c: GameState['contracts'][number]) => c.kind === 'FORWARDING'
    && offerDef(s, config, c.serviceOfferId!)?.serviceClass === 'HANDLING';
  // 시작 견적은 한 번만 나오므로 반복 거래의 주간 부담으로 외삽하지 않는다.
  const initialOffers = new Set(config.offers.map((offer) => offer.id));
  const recurringContracts = s.contracts.filter((c) => !initialOffers.has(c.serviceOfferId ?? c.buyOfferId!));
  const otherContracts = new Set(recurringContracts.filter((c) => !handling(c)
    && c.acceptedDay >= windowStart && c.acceptedDay < s.day).map((c) => c.id));
  const otherPrep = s.tasks.filter((t) => isHomePrep(t, config) && otherContracts.has(t.contractId!))
    .reduce((sum, t) => sum + t.requiredWorkUnits, 0);
  const otherPtPerWeek = windowDays ? Math.floor(otherPrep * 7 / windowDays) : 0;
  const staff = config.employees.filter((e) => s.employees.some((x) => x.id === e.id && x.employmentStatus === 'employed' && x.locationCityId === config.homeCityId))
    .reduce((sum, e) => sum + e.workUnitsPerDay, 0);
  const routes = config.routes.filter((r) => r.fromCityId === config.homeCityId && templates.some((t) => t.destinationCityId === r.toCityId));
  // 예약은 출항 전날까지다. 노선 간격이 다르면 가장 긴 체류를 기준으로 보관 한도를 추정한다.
  const fallbackDwellDays = Math.max(...routes.map((r) => r.departureIntervalDays)) + 1;
  const occupancy = Array<number>(windowDays).fill(0), dwell: number[] = [];
  for (const c of recurringContracts) {
    if (c.originCityId !== config.homeCityId) continue;
    // 취소 회사 화물은 lot.contractId가 끊겨도 계약의 cargoLotId로 추적한다.
    const lot = s.cargoLots.find((l) => l.id === c.cargoLotId);
    if (!lot) continue;
    const departure = s.shipments.find((sh) => sh.contractId === c.id)?.departureDay;
    if (handling(c)) {
      if (departure !== undefined && departure >= windowStart && departure < s.day) dwell.push(departure - c.acceptedDay + 1);
      continue;
    }
    const out = departure ?? (lot.status === 'RETURNED_TO_OWNER' ? c.cancelledDay! : Infinity);
    const liters = cargoSpace(config, lot.goodId, lot.quantity).volumeLiters;
    // 명령은 출항·반환보다 먼저다. 수락 당일을 제외하고 나간 날까지 센다.
    for (let i = 0; i < windowDays; i++) if (c.acceptedDay < windowStart + i && windowStart + i <= out) occupancy[i]! += liters;
  }
  const storageDetail = {
    otherOccupancyLiters: windowDays ? Math.floor(occupancy.reduce((sum, n) => sum + n, 0) / windowDays) : 0,
    otherPeakLiters: Math.max(0, ...occupancy),
    handlingDwellDays: dwell.length ? Math.ceil(dwell.reduce((sum, n) => sum + n, 0) / dwell.length) : fallbackDwellDays,
    windowDays,
  };
  const sailing = routes.reduce((sum, r) => {
    const next = listSailings(config, r.id, s.day + 1)[0];
    if (!next) return sum;
    const load = sailingLoad(s, config, next);
    const mass = Math.max(...templates.filter((t) => t.destinationCityId === r.toCityId).map((t) => cargoSpace(config, t.goodId, t.quantity).massGrams));
    return sum + Math.min(Math.floor(load.capacityLiters / volume), Math.floor(load.capacityGrams / mass));
  }, 0);
  const jobs = (pt: number) => Math.floor(Math.max(0, pt * 7 - otherPtPerWeek) / prep);
  const same = (constraint: BottleneckConstraint, n: number | null) => ({ constraint, before: n, after: n });
  const rows: WeeklyBottleneck['rows'] = [same('DEMAND', demand ? Math.floor(offered / batches.length) : null),
    { constraint: 'STAFF', before: jobs(staff), after: jobs(staff + (hire?.workUnitsPerDay ?? 0)) },
    same('WAREHOUSE_HANDLING', jobs(handlingCapacityPt(s, config))),
    same('STORAGE', Math.floor(Math.max(0, storageCapacityLiters(s, config) - storageDetail.otherPeakLiters) * 7 / (storageDetail.handlingDwellDays * volume))), same('SAILING', sailing)];
  const usableBefore = Math.min(...rows.flatMap((r) => r.before === null ? [] : [r.before]));
  const usableAfter = Math.min(...rows.flatMap((r) => r.after === null ? [] : [r.after]));
  let remainingHandlingBatches = 0;
  for (let day = o.market.publish.firstDay; day <= o.market.publish.lastDay; day += o.market.publish.intervalDays) {
    if (day > s.day && templates.some((t) => day + t.deadlineOffsetDays <= config.campaignDays && day + t.paymentOffsetDays <= config.campaignDays)) remainingHandlingBatches++;
  }
  const wageKrwPerWeek = hire ? hire.salaryPerDayMinor * 7 : null;
  return { unit: 'HANDLING_JOBS_PER_WEEK', demand, otherPtPerWeek, storageDetail, rows,
    binding: { before: rows.filter((r) => r.before === usableBefore).map((r) => r.constraint), after: rows.filter((r) => r.after === usableAfter).map((r) => r.constraint) },
    usableBefore, usableAfter, extraJobsPerWeek: hire ? usableAfter - usableBefore : 0, remainingHandlingBatches,
    contributionPerJobMinor: Math.min(...templates.map((t) => t.serviceFeeMinor - routeBetween(config, config.homeCityId, t.destinationCityId)!.bookingFeeMinor)),
    wageKrwPerWeek, wageUsdLotsPerWeek: wageKrwPerWeek === null ? null : Math.ceil(wageKrwPerWeek / usdLotKrw(config, s)) };
}

export function hiringOutlook(s: GameState, config: ScenarioConfig, candidateId: string) {
  const hire = candidate(s, config, candidateId), bottleneck = weeklyBottleneck(s, config, candidateId);
  return { workUnitsPerDay: hire?.workUnitsPerDay ?? 0, wageKrwPerDay: hire?.salaryPerDayMinor ?? 0,
    wageUsdLotsPerWeek: bottleneck.wageUsdLotsPerWeek, bottleneck,
    recentHandlingOfferedPt: bottleneck.demand?.handlingPt ?? 0,
    recentHandlingAcceptedPt: recentBatches(s).reduce((sum, b) => sum + acceptedPrep(s, config, b.publishDay, true), 0) };
}

export function warehouseSummary(s: GameState, config: ScenarioConfig) {
  const allocation = allocateHandling(s, config), waits = allocation.allocations.filter((a) => a.gotPt < a.wantPt);
  const projections = projectPrepCompletion(s, config, { assignQueued: true });
  const home = workloadSummary(s, config).byCity.find((c) => c.cityId === config.homeCityId);
  const open = s.offers.filter((o) => o.status === 'OPEN').map((o) => offerDef(s, config, o.id)!)
    .filter((o) => o.kind !== 'customer' && o.publishDay <= s.day && o.validUntilDay >= s.day);
  const expansion = s.operations?.expansions[0];
  let nextDueDay: number | null = null;
  for (let day = s.day; day <= config.campaignDays; day++) {
    if (rentDueMinor(s, config, day) && !s.ledger.postedIds[rentEntryId(day)]) { nextDueDay = day; break; }
  }
  return { storage: { usedLiters: storageUsedLiters(s, config), capacityLiters: storageCapacityLiters(s, config),
    heldUnallocatedLiters: s.cargoLots.filter((l) => l.locationCityId === config.homeCityId && l.status === 'HELD_UNALLOCATED')
      .reduce((sum, l) => sum + cargoSpace(config, l.goodId, l.quantity).volumeLiters, 0) },
    handling: { capacityPtToday: allocation.capacityPt, plannedUsePtToday: allocation.allocations.reduce((sum, a) => sum + a.gotPt, 0),
      waits, waitTaskCount: waits.length, waitPt: waits.reduce((sum, a) => sum + a.wantPt - a.gotPt, 0) },
    prepDaysToClear: projections.some((p) => p.readyDay === null) ? null : projections.length ? Math.max(...projections.map((p) => p.readyDay!)) - s.day + 1 : 0,
    demand: { batchPublishDay: s.operations?.batches.filter((b) => b.publishDay <= s.day).at(-1)?.publishDay ?? null,
      openVolumeLiters: open.reduce((sum, o) => sum + cargoSpace(config, o.goodId, o.quantity).volumeLiters, 0),
      openPrepPt: open.reduce((sum, o) => sum + prepWorkUnitsFor(config, o, o.quantity), 0),
      recent: recentBatches(s).map((b) => { const offers = batchOffers(s, b.publishDay); return { publishDay: b.publishDay,
        offeredPrepPt: offers.reduce((sum, o) => sum + prepWorkUnitsFor(config, o, o.quantity), 0),
        acceptedPrepPt: acceptedPrep(s, config, b.publishDay, false) + acceptedPrep(s, config, b.publishDay, true),
        handlingOffered: offers.filter((o) => o.serviceClass === 'HANDLING').length, handlingAccepted: acceptedPrep(s, config, b.publishDay, true) }; }) },
    staff: { workUnitsPerDay: home?.staffWorkUnitsPerDay ?? 0, idleWorkUnitsToday: home?.idleWorkUnitsPerDay ?? 0 },
    sailings: config.routes.filter((r) => r.fromCityId === config.homeCityId).flatMap((r) => {
      const next = listSailings(config, r.id, s.day + 1)[0];
      if (!next) return [];
      const load = sailingLoad(s, config, next);
      return [{ sailingId: next.id, usedLiters: load.volumeLiters, capacityLiters: load.capacityLiters,
        usedGrams: load.massGrams, capacityGrams: load.capacityGrams, spaceContract: spaceCovered(s, config, next) }];
    }), rent: { amountMinor: nextDueDay === null ? 0 : rentDueMinor(s, config, nextDueDay), nextDueDay },
    expansion: { status: !expansion ? 'NONE' as const : expansion.effectiveDay > s.day ? 'ORDERED' as const : 'ACTIVE' as const,
      effectiveDay: expansion?.effectiveDay ?? null }, spaceContracts: structuredClone(s.operations?.spaceContracts ?? []), bottleneck: weeklyBottleneck(s, config) };
}
