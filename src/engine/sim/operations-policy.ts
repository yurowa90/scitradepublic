import policyConstants from './policy-constants.json';
import { listSailings, routeBetween } from '../catalog';
import { isAvailableFromToday } from '../employees';
import { planState } from '../engine';
import { offerDef, openTradePairs, prepWorkUnitsFor } from '../market';
import { dailyKrwDue, handlingOrder, lateDeliveryReduction, projectPrepCompletion, rentDueMinor, usdLotKrw } from '../operations';
import { creditTermOptions } from '../readers-lazy';
import { preview, type QuotePreview } from '../reports';
import { krwToUsdMinor } from '../risk';
import type { Currency } from '../money';
import { fundsPosition, runningTaskOf, spaceShortfall } from '../reservations';
import { drawUniform, type RngState } from '../rng';
import type { CreditTermId, EngineCommand, GameState, ScenarioConfig } from '../types';
import { candidateFor, type Variant } from './variants';
import type { PolicyDecision, ProjectionBooking } from './policies';

// 고정 품목은 실행기 전용 정책 상수다. 시나리오 품목 배열에서 고르지 않는다.
export const FOCUS_GOOD_ID = policyConstants.focusGoodId;
export function decisionContribution(p: QuotePreview, sale: number, purchaseCurrency: Currency): number {
  return sale - p.freight - p.duty - (purchaseCurrency === 'KRW'
    ? krwToUsdMinor(p.purchase, p.referenceEstimate!.rateKrwPerUsd) : p.purchase);
}
export const marginBufferAccepts = (contribution: number, sale: number): boolean => 10n * BigInt(contribution) >= BigInt(sale);
export function directTradeCandidates(state: GameState, config: ScenarioConfig, day: number) {
  const candidates: { buyOfferId: string; sellOfferId: string; quantity: number; purchaseCurrency: Currency;
    sale: number; contribution: number; preview: QuotePreview }[] = [];
  for (const pair of openTradePairs(state, config)) {
    const buy = offerDef(state, config, pair.buyOfferId)!, sell = offerDef(state, config, pair.sellOfferId)!;
    for (let quantity = Math.min(buy.maxQuantity, sell.maxQuantity); quantity >= buy.quantityStep; quantity -= buy.quantityStep) {
      const sale = sell.unitPriceMinor * quantity;
      const p = preview(config, 'DIRECT_TRADE', buy.cityId, sell.cityId, day,
        { purchase: buy.unitPriceMinor * quantity, sale }, sell.deliveryDeadlineDay!, sell.paymentDueDay!,
        { goodId: buy.goodId, purchaseCurrency: buy.currency });
      if (p) candidates.push({ ...pair, quantity, purchaseCurrency: buy.currency, sale,
        contribution: decisionContribution(p, sale, buy.currency), preview: p });
    }
  }
  return candidates;
}

export type DirectCandidate = ReturnType<typeof directTradeCandidates>[number];
export function termCandidate(state: GameState, config: ScenarioConfig, c: DirectCandidate, acceptance: string, day: number):
  { creditTermId: CreditTermId | undefined; sale: number; contribution: number; preview: QuotePreview } {
  if (acceptance !== 'TERM_GREEDY' && acceptance !== 'CREDIT_AWARE') {
    return { creditTermId: undefined, sale: c.sale, contribution: c.contribution, preview: c.preview };
  }
  const options = creditTermOptions(state, config, c.buyOfferId, c.sellOfferId, c.quantity);
  const order: CreditTermId[] = acceptance === 'CREDIT_AWARE' && options[0]?.grade === 'C' ? ['BASE'] : ['D30', 'D15', 'BASE'];
  const term = order.map((id) => options.find((t) => t.termId === id)).find((t) => t?.allowed);
  if (!term) throw new Error('고를 수 있는 외상 조건이 없습니다.');
  const buy = offerDef(state, config, c.buyOfferId)!, sell = offerDef(state, config, c.sellOfferId)!;
  const sale = term.saleAmountMinor;
  const p = preview(config, 'DIRECT_TRADE', buy.cityId, sell.cityId, day,
    { purchase: c.preview.purchase, sale }, sell.deliveryDeadlineDay!, term.paymentDueDay,
    { goodId: buy.goodId, purchaseCurrency: c.purchaseCurrency })!;
  return { creditTermId: term.termId, sale, contribution: decisionContribution(p, sale, c.purchaseCurrency), preview: p };
}

export const rejectionCounts = () => ({ funds: 0, storage: 0, handling: 0, sailing: 0, staff: 0, onTime: 0 });
export const rejectionUnits = () => ({ candidate: { ...rejectionCounts(), credit: 0 }, pair: 0, quote: 0, skippedNotOpen: 0 });
export type RejectionUnits = ReturnType<typeof rejectionUnits>;
export function decideOperations(id: string, v: Variant, state: GameState, config: ScenarioConfig, initialRng: RngState): PolicyDecision {
  const commands: EngineCommand[] = [], rejections = rejectionCounts(), projectionBookings: ProjectionBooking[] = [];
  const units = config.rules.rulesVersion === 'M2a-rules-4' ? rejectionUnits() : undefined;
  const attemptedPairs = new Set<string>(), acceptedPairs = new Set<string>();
  const attemptedQuotes = new Set<string>(), acceptedQuotes = new Set<string>();
  const reject = (reason: keyof RejectionUnits['candidate']) => {
    if (reason !== 'credit') rejections[reason]++;
    if (units) units.candidate[reason]++;
  };
  let current = state, rng = initialRng;
  if (v.acceptance === 'IDLE') return { commands, rng, rejections, projectionBookings, ...(units ? { rejectionUnits: units } : {}) };
  const nextId = () => `SIM-${id}-D${state.day}-${commands.length + 1}`;
  const trial = (cmd: EngineCommand) => planState(current, config, [cmd]);
  const add = (cmd: EngineCommand) => {
    const p = trial(cmd);
    if (p.results[0]!.status !== 'APPLIED') return false;
    if (cmd.type === 'BOOK_SAILING') recordProjections(p.state);
    commands.push(cmd); current = p.state; return true;
  };
  const recruiter = config.employees.filter((e) => !config.recruitment?.candidateEmployeeIds.includes(e.id)).at(-1);
  const hires = v.hires.map((h) => ({ ...h, candidate: candidateFor(config, h.pt) })).filter((h) => h.candidate);
  const blocks = () => recruiter ? hires.flatMap((h) => {
    const c = current.recruitment.candidates.find((c) => c.employeeId === h.candidate!.id)!;
    if (c.hiredDay !== null && c.hiredDay < state.day) return [];
    const firstHireAttempt = Math.max(h.day, (c.interviewReadyDay ?? h.day - 1) + 1);
    if (c.hiredDay === null && c.interviewReadyDay !== null && state.day > firstHireAttempt + 6) return [];
    // 미래는 예정일을 쓰고, 지연되면 아침마다 연장한다. 고용 당일도 비워 둔다.
    return [{ employeeId: recruiter.id, fromDay: h.day - 3, toDay: c.hiredDay ?? Math.max(h.day, state.day) }];
  }) : [];
  const available = (remainingPt: number) => config.employees.filter((e) => isAvailableFromToday(current, e.id)
    && current.employees.find((x) => x.id === e.id)?.locationCityId === config.homeCityId && !runningTaskOf(current, e.id)
    && !blocks().some((b) => b.employeeId === e.id && state.day <= b.toDay
      && (state.day >= b.fromDay || Math.ceil(remainingPt / e.workUnitsPerDay) > b.fromDay - state.day)));
  const projections = (s: GameState) => projectPrepCompletion(s, config, { assignQueued: true, blocked: blocks() });
  const projectionSafe = (s: GameState) => projections(s).every((p) => {
    const b = s.bookings.find((b) => b.contractId === p.contractId && b.status === 'BOOKED');
    return !b || (p.readyDay !== null && p.readyDay <= b.departureDay);
  });
  const recordProjections = (s: GameState) => {
    const added = s.bookings.filter((b) => b.status === 'BOOKED' && !current.bookings.some((old) => old.id === b.id));
    if (!added.length) return;
    const predicted = projections(s);
    for (const b of added) {
      const p = predicted.find((p) => p.contractId === b.contractId);
      const readyDay = p ? p.readyDay : s.day;
      if (readyDay !== null && readyDay <= b.departureDay) projectionBookings.push({ bookingId: b.id, contractId: b.contractId, readyDay, departureDay: b.departureDay });
    }
  };
  for (const d of state.delayDecisions) if (d.choice === null) add({ id: nextId(), type: 'RESPOND_TO_DELAY', noticeId: d.noticeId, shipmentId: d.shipmentId, choice: 'KEEP_SHIPMENT_BOOKING' });
  const ops = config.operations!;
  const expandDay = v.investment === 'SE22' ? 22 : 7;
  const wantsExpand = ['E', 'SE', 'SE22'].includes(v.investment) && state.day >= expandDay && !current.operations!.expansions.length;
  const hireToday = hires.filter((h) => {
    const c = current.recruitment.candidates.find((c) => c.employeeId === h.candidate!.id)!;
    return c.stage === 'INTERVIEW_READY' && state.day >= Math.max(h.day, c.interviewReadyDay! + 1)
      && state.day <= Math.max(h.day, c.interviewReadyDay! + 1) + 6;
  });
  if (v.acceptance !== 'NO_FX' && (!v.react || fundsPosition(current, config, 'KRW').unpaidObligations > 0)) {
    const end = Math.min(config.campaignDays, state.day + (v.react ? 0 : 6));
    let expense = 0;
    for (let day = state.day; day <= end; day++) {
      expense += dailyKrwDue(current, config, day);
      if (wantsExpand && day >= state.day + ops.facility.expansion.effectiveAfterDays && rentDueMinor(current, config, day)) expense += ops.facility.expansion.rentIncreaseMinor;
    }
    expense += (wantsExpand ? ops.facility.expansion.setupFeeMinor : 0)
      + hireToday.reduce((sum, h) => sum + h.candidate!.salaryPerDayMinor * (config.recruitment!.signingFeeWageDays + end - state.day), 0);
    const lots = Math.min(Math.ceil(Math.max(0, expense - fundsPosition(current, config, 'KRW').available) / usdLotKrw(config, current)),
      Math.max(0, Math.floor(fundsPosition(current, config, 'USD').available / ops.fx.lotUsdMinor)));
    if (lots) add({ id: nextId(), type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: lots * ops.fx.lotUsdMinor });
  }
  if (wantsExpand) add({ id: nextId(), type: 'EXPAND_WAREHOUSE' });
  if (['S', 'SE', 'SE22'].includes(v.investment) && state.day >= (v.investment === 'SE22' ? 22 : 1)) {
    for (const routeId of ops.spaceContract.routeIds) if (!current.operations!.spaceContracts.some((c) => c.routeId === routeId)) add({ id: nextId(), type: 'SIGN_SPACE_CONTRACT', routeId });
  }
  for (const h of hires) {
    const c = current.recruitment.candidates.find((c) => c.employeeId === h.candidate!.id)!;
    if (c.stage === 'HIRED' || !recruiter) continue;
    if (c.stage === 'UNDISCOVERED' && state.day >= (v.early ? 3 : h.day - 3)) {
      const site = config.recruitment!.scoutSites.find((s) => s.candidateEmployeeIds.includes(c.employeeId))!;
      add({ id: nextId(), type: 'SCOUT_SITE', venueId: site.venueId, employeeId: recruiter.id });
    } else if (c.stage === 'DISCOVERED' && state.day >= h.day - 2) add({ id: nextId(), type: 'START_RECRUIT_QUEST', candidateId: c.employeeId, employeeId: recruiter.id });
    else if (hireToday.some((x) => x.candidate!.id === c.employeeId)) add({ id: nextId(), type: 'HIRE_CANDIDATE', candidateId: c.employeeId });
  }
  const late = v.acceptance === 'LATE_OK' || v.acceptance === 'SEEDED_RANDOM';
  for (const c of current.contracts.filter((c) => ['ACTIVE', 'IN_PROGRESS'].includes(c.status) && !current.shipments.some((s) => s.contractId === c.id))) {
    if (current.bookings.some((b) => b.contractId === c.id && b.status === 'BOOKED')) continue;
    const route = routeBetween(config, c.originCityId, c.destinationCityId);
    const preparation = projectPrepCompletion(current, config, { assignQueued: true, blocked: blocks() }).find((p) => p.contractId === c.id);
    if (preparation?.readyDay === null) continue;
    const ready = preparation?.readyDay;
    const sailings = route ? listSailings(config, route.id, Math.max(state.day + 1, ready ?? state.day + 1)) : [];
    sailings.sort((a, b) => Number(a.scheduledArrivalDay + config.terms.customsDays > c.deliveryDeadlineDay) - Number(b.scheduledArrivalDay + config.terms.customsDays > c.deliveryDeadlineDay));
    for (const s of sailings) {
      if (!late && s.scheduledArrivalDay + config.terms.customsDays > c.deliveryDeadlineDay) continue;
      if (add({ id: nextId(), type: 'BOOK_SAILING', contractId: c.id, sailingId: s.id })) break;
    }
  }
  for (const t of handlingOrder(current, current.tasks.filter((t) => t.status === 'QUEUED' && t.contractId !== null))) {
    for (const e of available(t.requiredWorkUnits - t.progressWorkUnits)) {
      const cmd: EngineCommand = { id: nextId(), type: 'ASSIGN_TASK', taskId: t.id, employeeId: e.id };
      const p = trial(cmd);
      if (p.results[0]!.status === 'APPLIED' && projectionSafe(p.state)) { commands.push(cmd); current = p.state; break; }
    }
  }
  type Acceptance = Extract<EngineCommand, { type: 'ACCEPT_TRADE' | 'ACCEPT_FORWARDING' }>;
  const candidates: { command: Acceptance; offerId: string; sale: number; contribution: number; deadline: number; routeId: string; quantity: number;
    direct?: ReturnType<typeof directTradeCandidates>[number] }[] = [];
  if (v.acceptance !== 'ASSET_LIGHT') for (const c of directTradeCandidates(current, config, state.day)) {
    if (v.acceptance === 'MARGIN_BUFFER' && !marginBufferAccepts(c.contribution, c.sale)) continue;
    if (v.acceptance === 'FOCUS' && offerDef(current, config, c.buyOfferId)!.goodId !== FOCUS_GOOD_ID) continue;
    const term = termCandidate(current, config, c, v.acceptance, state.day);
    candidates.push({ command: { id: '', type: 'ACCEPT_TRADE', buyOfferId: c.buyOfferId, sellOfferId: c.sellOfferId, quantity: c.quantity },
      offerId: c.buyOfferId, quantity: c.quantity, sale: term.sale, contribution: term.contribution,
      deadline: c.preview.deliveryDeadlineDay, routeId: c.preview.routeId, direct: c });
  }
  for (const o of current.offers.filter((o) => o.status === 'OPEN').map((o) => offerDef(current, config, o.id)!)) {
    if (o.kind !== 'forwarding' || o.validUntilDay < state.day) continue;
    const p = preview(config, 'FORWARDING', o.cityId, o.destinationCityId!, state.day, { purchase: 0, sale: o.serviceFeeMinor }, o.deliveryDeadlineDay!, o.paymentDueDay!);
    if (p) candidates.push({ command: { id: '', type: 'ACCEPT_FORWARDING', offerId: o.id }, offerId: o.id, quantity: o.quantity, sale: o.serviceFeeMinor,
      contribution: o.serviceFeeMinor - p.freight, deadline: p.deliveryDeadlineDay, routeId: p.routeId });
  }
  candidates.sort((a, b) => (v.acceptance === 'ON_TIME_FIRST' ? a.deadline - b.deadline : 0) || (a.offerId === b.offerId ? b.quantity - a.quantity : b.contribution - a.contribution));
  for (const c of candidates) {
    if (c.contribution <= 0) continue;
    if (!current.offers.some((o) => o.id === c.offerId && o.status === 'OPEN')) {
      if (units) units.skippedNotOpen++;
      continue;
    }
    if (v.acceptance === 'SEEDED_RANDOM') { const d = drawUniform(rng, 'sim.policy.SEEDED_RANDOM'); rng = d.rng; if (d.value >= 0.5) continue; }
    const pairKey = c.direct ? JSON.stringify([c.direct.buyOfferId, c.direct.sellOfferId]) : undefined;
    if (units && pairKey) { attemptedPairs.add(pairKey); attemptedQuotes.add(c.offerId); }
    // 앞선 수락이 같은 거래처의 노출액을 바꾸므로 최신 상태에서 다시 고른다.
    const term = c.direct ? termCandidate(current, config, c.direct, v.acceptance, state.day) : undefined;
    if (term && term.contribution <= 0) { reject('credit'); continue; }
    const sale = term?.sale ?? c.sale, contribution = term?.contribution ?? c.contribution;
    let exchangeUsd = 0;
    if (v.acceptance !== 'NO_FX' && c.direct?.purchaseCurrency === 'KRW'
      && offerDef(current, config, c.direct.sellOfferId)!.currency !== 'KRW') {
      let expense = 0;
      for (let day = state.day; day <= Math.min(config.campaignDays, state.day + (v.react ? 0 : 6)); day++) expense += dailyKrwDue(current, config, day);
      const krwShort = c.direct.preview.purchase - (fundsPosition(current, config, 'KRW').available - expense);
      if (krwShort > 0) {
        exchangeUsd = Math.ceil(krwShort / usdLotKrw(config, current)) * ops.fx.lotUsdMinor;
        const usdCap = fundsPosition(current, config, 'USD').available
          - (c.direct.preview.cashNeedByCurrency?.find((x) => x.currency === 'USD')?.amountMinor ?? 0);
        if (exchangeUsd > usdCap) { reject('funds'); continue; }
      }
    }
    const offer = offerDef(current, config, c.offerId)!;
    const prep = prepWorkUnitsFor(config, offer, c.quantity);
    let reason: keyof typeof rejections = 'onTime', accepted = false;
    for (const s of listSailings(config, c.routeId, state.day + 1)) {
      const daysLate = s.scheduledArrivalDay + config.terms.customsDays - c.deadline;
      if (!late && daysLate > 0) continue;
      if (contribution - lateDeliveryReduction(config, sale, daysLate) <= 0) continue;
      if (spaceShortfall(current, config, s, offer.goodId, c.quantity)) { reason = 'sailing'; continue; }
      const employees = available(prep);
      for (const employee of employees.length ? employees : [undefined]) {
        const ex: EngineCommand | undefined = exchangeUsd ? { id: nextId(), type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: exchangeUsd } : undefined;
        const cmd: Acceptance = { ...c.command, ...(term?.creditTermId ? { creditTermId: term.creditTermId } : {}), id: ex ? `SIM-${id}-D${state.day}-${commands.length + 2}` : nextId(), plan: { ...(employee ? { employeeId: employee.id } : {}), sailingId: s.id } };
        const p = ex ? planState(current, config, [ex, cmd]) : trial(cmd), result = p.results[ex ? 1 : 0]!;
        if (ex && p.results[0]!.status !== 'APPLIED') { reason = 'funds'; continue; }
        if (result.status !== 'APPLIED') { reason = result.reasonKo.includes('보관') ? 'storage' : result.reasonKo.includes('직원') ? 'staff' : 'funds'; continue; }
        if (prep > 0 && !projectionSafe(p.state)) { reason = 'handling'; continue; }
        recordProjections(p.state);
        if (ex) commands.push(ex);
        commands.push(cmd); current = p.state; accepted = true; break;
      }
      if (accepted) break;
    }
    if (!accepted) reject(reason);
    else if (units && pairKey) { acceptedPairs.add(pairKey); acceptedQuotes.add(c.offerId); }
  }
  if (units) {
    units.pair = [...attemptedPairs].filter((key) => !acceptedPairs.has(key)).length;
    units.quote = [...attemptedQuotes].filter((key) => !acceptedQuotes.has(key)).length;
  }
  return { commands, rng, rejections, projectionBookings, ...(units ? { rejectionUnits: units } : {}) };
}
