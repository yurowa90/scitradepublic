// 본사 운영의 계산과 명령. 금액은 통화별 최소 단위이며 환전도 두 장부에 따로 기록한다.
import { cargoSpace, cityName, listSailings, routeBetween, routeOf, type Sailing } from './catalog';
import { isRiskRules, dutyFor, referenceRate } from './risk';
import { offerDef } from './market';
import { isAvailableFromToday } from './employees';
import { balance, post, type LedgerEntry } from './ledger';
import { applyBasisPoints, formatMoney, MINOR_PER_MAJOR, type Currency } from './money';
import { fundsPosition, cashLessUnpaidMinor } from './reservations';
import { isDayBasedTask } from './tasks';
import type { DefaultEvent, ExchangeDirection, FailureRecord, GameState, HandlingAllocation, OperationsCommand, ScenarioConfig, Task } from './types';

const pad = (n: number) => String(n).padStart(3, '0');
const log = (s: GameState, textKo: string) => s.log.push({ day: s.day, textKo });
const activeExpansion = (s: GameState, day: number) => s.operations?.expansions.some((e) => e.effectiveDay <= day) ?? false;

export function storageUsedLiters(s: GameState, config: ScenarioConfig): number {
  return s.cargoLots.filter((l) => l.locationCityId === config.homeCityId
    && ['PREPARING', 'AWAITING_DEPARTURE', 'HELD_UNALLOCATED'].includes(l.status))
    .reduce((sum, l) => sum + cargoSpace(config, l.goodId, l.quantity).volumeLiters, 0);
}
export function storageCapacityLiters(s: GameState, config: ScenarioConfig, day = s.day): number {
  const f = config.operations?.facility;
  return f ? f.storageLiters + (activeExpansion(s, day) ? f.expansion.storageLiters : 0) : Infinity;
}
export function handlingCapacityPt(s: GameState, config: ScenarioConfig, day = s.day): number {
  const f = config.operations?.facility;
  return f ? f.handlingWorkUnitsPerDay + (activeExpansion(s, day) ? f.expansion.handlingWorkUnitsPerDay : 0) : Infinity;
}
export function isHomePrep(task: Task, config: ScenarioConfig): boolean {
  return task.cityId === config.homeCityId && (task.kind === 'EXPORT_PREP' || task.kind === 'FORWARDING_PREP');
}
export function handlingOrder(s: GameState, tasks: Task[]): Task[] {
  const key = (t: Task) => {
    const b = s.bookings.find((b) => b.contractId === t.contractId && b.status === 'BOOKED');
    return [b ? 0 : 1, b?.departureDay ?? s.contracts.find((c) => c.id === t.contractId)?.deliveryDeadlineDay ?? Infinity] as const;
  };
  return [...tasks].sort((a, b) => {
    const ak = key(a), bk = key(b);
    return ak[0] - bk[0] || ak[1] - bk[1] || ((a.contractId ?? '') < (b.contractId ?? '') ? -1 : (a.contractId ?? '') > (b.contractId ?? '') ? 1 : 0);
  });
}
export function allocateHandling(s: GameState, config: ScenarioConfig, day = s.day): { capacityPt: number; allocations: HandlingAllocation[] } {
  const capacityPt = handlingCapacityPt(s, config, day);
  let left = capacityPt;
  const allocations = handlingOrder(s, s.tasks.filter((t) => t.status === 'RUNNING' && isHomePrep(t, config))).map((t) => {
    const e = s.employees.find((e) => e.id === t.assignedEmployeeId);
    const rate = e?.employmentStatus === 'employed' && e.availableFromDay <= day
      ? config.employees.find((d) => d.id === e.id)?.workUnitsPerDay ?? 0 : 0;
    const wantPt = Math.min(rate, t.requiredWorkUnits - t.progressWorkUnits);
    const gotPt = Math.min(left, wantPt); left -= gotPt;
    return { taskId: t.id, contractId: t.contractId!, wantPt, gotPt };
  });
  return { capacityPt, allocations };
}

export interface PrepProjection { taskId: string; contractId: string; employeeId: string | null; readyDay: number | null; todayPt: number; todayWantPt: number; waitDays: number }
/** 차단 기간에는 본사 준비를 맡지도 진행하지도 않는다. 배정 시에는 직원 처리량만으로 차단 전 완료를 판단한다. */
export function projectPrepCompletion(state: GameState, config: ScenarioConfig,
  options: { assignQueued?: boolean; blocked?: { employeeId: string; fromDay: number; toDay: number }[] } = {}): PrepProjection[] {
  const s = structuredClone(state);
  const projections = s.tasks.filter((t) => isHomePrep(t, config) && (t.status === 'RUNNING' || (options.assignQueued && t.status === 'QUEUED')))
    .map((t): PrepProjection => ({ taskId: t.id, contractId: t.contractId!, employeeId: t.assignedEmployeeId, readyDay: null, todayPt: 0, todayWantPt: 0, waitDays: 0 }));
  for (let day = s.day; day <= config.campaignDays && projections.some((p) => p.readyDay === null); day++) {
    s.day = day;
    if (options.assignQueued) for (const t of handlingOrder(s, s.tasks.filter((t) => isHomePrep(t, config) && t.status === 'QUEUED'))) {
      const emp = config.employees.find((e) => isAvailableFromToday(s, e.id)
        && s.employees.find((x) => x.id === e.id)?.locationCityId === t.cityId
        && !s.tasks.some((task) => task.status === 'RUNNING' && task.assignedEmployeeId === e.id)
        && !options.blocked?.some((b) => b.employeeId === e.id && day <= b.toDay
          && (day >= b.fromDay || Math.ceil((t.requiredWorkUnits - t.progressWorkUnits) / e.workUnitsPerDay) > b.fromDay - day)));
      if (emp) { t.assignedEmployeeId = emp.id; t.status = 'RUNNING'; projections.find((p) => p.taskId === t.id)!.employeeId = emp.id; }
    }
    // 차단 중인 준비 업무는 배분에서도 빼서 다른 직원의 처리 용량을 먹지 않는다.
    const paused = s.tasks.filter((t) => t.status === 'RUNNING' && isHomePrep(t, config)
      && options.blocked?.some((b) => b.employeeId === t.assignedEmployeeId && b.fromDay <= day && day <= b.toDay));
    for (const t of paused) t.status = 'QUEUED';
    const allocation = allocateHandling(s, config, day);
    for (const t of s.tasks.filter((t) => t.status === 'RUNNING')) {
      if (!t.assignedEmployeeId || !isAvailableFromToday(s, t.assignedEmployeeId)) continue;
      const a = allocation.allocations.find((a) => a.taskId === t.id);
      const amount = a?.gotPt ?? (isDayBasedTask(t.kind) ? 1 : config.employees.find((e) => e.id === t.assignedEmployeeId)!.workUnitsPerDay);
      const p = projections.find((p) => p.taskId === t.id);
      if (p && a) {
        if (day === state.day) { p.todayPt = a.gotPt; p.todayWantPt = a.wantPt; }
        if (a.gotPt < a.wantPt) p.waitDays++;
      }
      t.progressWorkUnits = Math.min(t.requiredWorkUnits, t.progressWorkUnits + amount);
      if (t.progressWorkUnits === t.requiredWorkUnits) { t.status = 'DONE'; if (p) p.readyDay = day; }
    }
    for (const t of paused) t.status = 'RUNNING';
    // 실제 출항에 실패하면 다음 날부터는 예약 없는 업무 순서로 계산한다.
    for (const b of s.bookings.filter((b) => b.status === 'BOOKED' && b.departureDay === day)) b.status = 'CANCELLED';
  }
  return projections;
}

export function storageShortfall(s: GameState, config: ScenarioConfig, goodId: string, quantity: number): string | null {
  if (!config.operations) return null;
  const used = storageUsedLiters(s, config), capacity = storageCapacityLiters(s, config), volume = cargoSpace(config, goodId, quantity).volumeLiters;
  if (used + volume <= capacity) return null;
  return `보관 공간 부족 — ${cityName(config, config.homeCityId)} 창고 ${used / 1000} / ${capacity / 1000} m³, 이 화물 ${volume / 1000} m³. ${s.operations!.expansions.length ? '출항하면' : '출항하거나 확장하면'} 공간이 생깁니다.`;
}
export function coveredSailings(config: ScenarioConfig, routeId: string, signedDay: number): Sailing[] {
  if (!config.operations) return [];
  return listSailings(config, routeId, signedDay + config.operations.spaceContract.leadDays)
    .filter((s) => s.scheduledArrivalDay <= config.campaignDays);
}
export function spaceCovered(s: GameState, config: ScenarioConfig, sailing: Sailing): boolean {
  return !!config.operations && !!s.operations?.spaceContracts.some((c) => c.routeId === sailing.routeId
    && sailing.departureDay >= c.firstSailingDay && sailing.departureDay <= c.lastSailingDay);
}
export const spaceEntryId = (routeId: string, day: number) => `SPACE-${routeId}-D${pad(day)}`;
export const rentEntryId = (day: number) => `RENT-D${pad(day)}`;
export function rentDueMinor(s: GameState, config: ScenarioConfig, day: number): number {
  const o = config.operations;
  if (!o || day > config.campaignDays) return 0;
  const rent = o.fixedCosts.rent;
  return day >= rent.firstDueDay && (day - rent.firstDueDay) % rent.periodDays === 0
    ? rent.amountMinor + (activeExpansion(s, day) ? o.facility.expansion.rentIncreaseMinor : 0) : 0;
}
export function fixedCostsDue(s: GameState, config: ScenarioConfig, day: number) {
  const rows: { id: string; currency: Currency; amountMinor: number; account: 'RENT_EXPENSE' | 'SPACE_CONTRACT_EXPENSE'; reasonKo: string }[] = [];
  const rent = rentDueMinor(s, config, day);
  if (rent) rows.push({ id: rentEntryId(day), currency: config.operations!.fixedCosts.rent.currency, amountMinor: rent, account: 'RENT_EXPENSE', reasonKo: `${cityName(config, config.homeCityId)} 창고 ${day}일 임차료` });
  for (const c of s.operations?.spaceContracts ?? []) {
    if (coveredSailings(config, c.routeId, c.signedDay).some((sailing) => sailing.departureDay === day)) {
      rows.push({ id: spaceEntryId(c.routeId, day), currency: c.currency, amountMinor: c.feeMinor,
        account: 'SPACE_CONTRACT_EXPENSE', reasonKo: `${routeName(config, c.routeId)} ${day}일 선복 계약 요금` });
    }
  }
  return rows;
}
function routeName(config: ScenarioConfig, routeId: string) { const r = routeOf(config, routeId); return `${cityName(config, r.fromCityId)} → ${cityName(config, r.toCityId)}`; }

export function lateDeliveryReduction(config: ScenarioConfig, saleAmountMinor: number, lateDays: number): number {
  if (lateDays <= 0) return 0;
  const t = config.terms;
  return t.lateDeliveryBasis === 'PER_LATE_DAY_CAPPED'
    ? Math.min(t.lateDeliveryPriceReductionMinor * lateDays, applyBasisPoints(saleAmountMinor, t.lateDeliveryCapBasisPoints!))
    : t.lateDeliveryPriceReductionMinor;
}

export function usdFundsParts(s: GameState, config: ScenarioConfig): string[] {
  const f = fundsPosition(s, config, 'USD');
  const parts = [`현금 ${formatMoney('USD', f.cash)}`];
  if (f.reserved - f.reservedCommitments) parts.push(`다른 계약 예약 ${formatMoney('USD', f.reserved - f.reservedCommitments)}`);
  if (f.reservedCommitments) parts.push(`선복 계약 요금 예약 ${formatMoney('USD', f.reservedCommitments)}`);
  if (f.unpaidObligations) parts.push(`미지급 ${formatMoney('USD', f.unpaidObligations)}`);
  return parts;
}
/** 환전 명령과 미리 보기가 공유하는 두 통화 금액. */
export function exchangeAmounts(config: ScenarioConfig, direction: ExchangeDirection, usd: number, seed?: number, day?: number) {
  const fx = config.operations?.fx;
  if (isRiskRules(config.rules.rulesVersion)) {
    if (seed === undefined || day === undefined || !fx) throw new Error('규칙 3 환전에는 시드와 날짜가 필요합니다');
    const r = referenceRate(config, seed, day), deduction = applyBasisPoints(r, fx.spreadBasisPoints);
    const rate = direction === 'USD_TO_KRW' ? r - deduction : r + deduction;
    const base = usd * r / MINOR_PER_MAJOR.USD, krw = usd * rate / MINOR_PER_MAJOR.USD;
    return { rate, base, krw, spread: Math.abs(base - krw) };
  }
  const rate = fx ? direction === 'USD_TO_KRW' ? fx.buyKrwPerUsd : fx.sellKrwPerUsd : 0;
  const base = usd * (fx?.baseKrwPerUsd ?? 0) / MINOR_PER_MAJOR.USD;
  const krw = usd * rate / MINOR_PER_MAJOR.USD;
  return { rate, base, krw, spread: Math.abs(base - krw) };
}
export function applyOperationsCommand(s: GameState, config: ScenarioConfig, cmd: OperationsCommand): string | null {
  const o = config.operations, state = s.operations;
  if (!o || !state) return '이 시나리오에서는 할 수 없습니다(M2a-5 기능).';
  const write = (entry: Omit<LedgerEntry, 'day'>) => {
    if (!post(s.ledger, { ...entry, day: s.day })) throw new Error(`분개 ${entry.id} 중복`);
  };
  switch (cmd.type) {
    case 'EXCHANGE_CURRENCY': {
      const usd = cmd.usdAmountMinor;
      if (!Number.isSafeInteger(usd) || usd <= 0 || usd % o.fx.lotUsdMinor !== 0) return `환전은 ${o.fx.lotUsdMinor / MINOR_PER_MAJOR.USD} USD 단위입니다. 요청 ${formatMoney('USD', usd)}.`;
      const toKrw = cmd.direction === 'USD_TO_KRW';
      const { rate, base, krw, spread } = exchangeAmounts(config, cmd.direction, usd, s.rng.seed, s.day);
      const usdFunds = fundsPosition(s, config, 'USD'), krwFunds = fundsPosition(s, config, 'KRW');
      if (toKrw && usdFunds.available < usd) return `환전할 수 있는 USD가 부족합니다. 요청 ${formatMoney('USD', usd)}, 사용 가능 ${formatMoney('USD', usdFunds.available)} = ${usdFundsParts(s, config).join(' − ')}.`;
      if (!toKrw && krwFunds.available < krw) return `환전할 수 있는 원화가 부족합니다. 필요 ${formatMoney('KRW', krw)}, 사용 가능 ${formatMoney('KRW', krwFunds.available)} = 현금 ${formatMoney('KRW', krwFunds.cash)}${krwFunds.unpaidObligations ? ` − 미지급 ${formatMoney('KRW', krwFunds.unpaidObligations)}` : ''}.`;
      const id = `FX${pad(state.exchanges.length + 1)}`;
      const from = toKrw ? formatMoney('USD', usd) : formatMoney('KRW', krw), to = toKrw ? formatMoney('KRW', krw) : formatMoney('USD', usd);
      const reason = `환전: ${from} → ${to}(${isRiskRules(config.rules.rulesVersion) ? '오늘 참고 환율' : '게임용 고정 환율'} ${formatMoney('KRW', rate)}, 차감 ${formatMoney('KRW', spread)})`;
      const usdEntry: Omit<LedgerEntry, 'day'> = { id: `${id}-USD`, currency: 'USD', reason,
        lines: [{ account: toKrw ? 'CURRENCY_TRANSFER' : 'CASH', amount: usd }, { account: toKrw ? 'CASH' : 'CURRENCY_TRANSFER', amount: -usd }] };
      const krwEntry: Omit<LedgerEntry, 'day'> = { id: `${id}-KRW`, currency: 'KRW', reason,
        lines: toKrw ? [{ account: 'CASH', amount: krw }, { account: 'FX_SPREAD_EXPENSE', amount: spread }, { account: 'CURRENCY_TRANSFER', amount: -base }]
          : [{ account: 'CURRENCY_TRANSFER', amount: base }, { account: 'FX_SPREAD_EXPENSE', amount: spread }, { account: 'CASH', amount: -krw }] };
      krwEntry.lines = krwEntry.lines.filter((l) => l.amount !== 0);
      if (toKrw) { write(usdEntry); write(krwEntry); } else { write(krwEntry); write(usdEntry); }
      state.exchanges.push({ id, day: s.day, direction: cmd.direction, usdMinor: usd, krwMinor: krw, rateKrwPerUsd: rate, spreadKrwMinor: spread });
      log(s, reason); return null;
    }
    case 'EXPAND_WAREHOUSE': {
      if (state.expansions.length >= o.facility.expansion.maxCount) return `창고 확장은 한 번만 할 수 있습니다(이미 ${state.expansions[0]!.effectiveDay}일부터 확장).`;
      const available = cashLessUnpaidMinor(s, config, 'KRW'), fee = o.facility.expansion.setupFeeMinor;
      if (available < fee) return `창고 설치비 자금이 부족합니다. 필요 ${formatMoney('KRW', fee)}, 사용 가능 ${formatMoney('KRW', available)}.`;
      write({ id: 'FACILITY-SETUP-WH01', currency: 'KRW', reason: '창고 확장 설치비', lines: [{ account: 'FACILITY_SETUP_EXPENSE', amount: fee }, { account: 'CASH', amount: -fee }] });
      const effectiveDay = s.day + o.facility.expansion.effectiveAfterDays;
      state.expansions.push({ id: 'WH-EXP-1', orderedDay: s.day, effectiveDay });
      let next: number | null = null;
      for (let d = effectiveDay; d <= config.campaignDays; d++) if (rentDueMinor(s, config, d)) { next = d; break; }
      log(s, `창고 확장 계약: ${effectiveDay}일부터 보관 ${storageCapacityLiters(s, config, effectiveDay) / 1000} m³·처리 ${handlingCapacityPt(s, config, effectiveDay)}pt. ${next === null ? '남은 임차일이 없어 증액분은 내지 않습니다' : `임차료는 다음 임차일(${next}일)부터 ${formatMoney('KRW', rentDueMinor(s, config, next))}`}`);
      return null;
    }
    case 'SIGN_SPACE_CONTRACT': {
      if (!o.spaceContract.routeIds.includes(cmd.routeId)) return '이 노선은 선복 계약을 맺을 수 없습니다.';
      const existing = state.spaceContracts.find((c) => c.routeId === cmd.routeId);
      if (existing) return `이 노선에는 이미 선복 계약이 있습니다(${existing.firstSailingDay}일 편부터).`;
      const sailings = coveredSailings(config, cmd.routeId, s.day);
      if (!sailings.length) return '남은 기간에 계약을 적용할 출항편이 없습니다.';
      const available = fundsPosition(s, config, 'USD').available, fee = o.spaceContract.feeMinor;
      if (available < fee) return `선복 계약 요금 자금이 부족합니다. 필요 ${formatMoney('USD', fee)}, 사용 가능 ${formatMoney('USD', available)}.`;
      const first = sailings[0]!.departureDay, last = sailings.at(-1)!.departureDay;
      state.spaceContracts.push({ id: `SPC-${cmd.routeId}`, routeId: cmd.routeId, signedDay: s.day, firstSailingDay: first, lastSailingDay: last, sailingCount: sailings.length, feeMinor: fee, currency: o.spaceContract.currency });
      log(s, `선복 장기 계약: ${routeName(config, cmd.routeId)} ${first}일 편부터 ${last}일 편까지 ${sailings.length}편, 편마다 +${o.spaceContract.extraLiters / 1000} m³·+${(o.spaceContract.extraGrams / 1000).toLocaleString('ko-KR')} kg, 편당 ${formatMoney('USD', fee)}(쓰지 않아도 냄, 해지 없음), 합계 ${formatMoney('USD', sailings.length * fee)}. 출항 ${o.spaceContract.reserveDaysAhead}일 전부터 그 편 요금을 묶어 둡니다.`);
      return null;
    }
  }
}

export function unpaidByCurrency(s: GameState, config: ScenarioConfig): FailureRecord['unpaidByCurrency'] {
  return [...new Set([config.tradeCurrency, config.payrollCurrency, ...s.obligations.map((o) => o.currency)])].map((currency) => {
    const obs = s.obligations.filter((o) => o.currency === currency && o.paidDay === null);
    return { currency, amountMinor: obs.reduce((sum, o) => sum + o.amountMinor, 0), count: obs.length };
  });
}
export function dailyKrwDue(s: GameState, config: ScenarioConfig, day: number): number {
  const wage = config.employees.filter((e) => e.salaryCurrency === 'KRW' && s.employees.some((x) => x.id === e.id && x.employmentStatus === 'employed' && x.availableFromDay <= day))
    .filter((e) => !s.ledger.postedIds[`WAGE-D${pad(day)}-${e.id}`]).reduce((sum, e) => sum + e.salaryPerDayMinor, 0);
  return wage + (s.ledger.postedIds[rentEntryId(day)] ? 0 : rentDueMinor(s, config, day));
}
/** USD 한 묶음을 원화로 바꿀 때 받는 금액. 임금 조달과 미지급 회복에 함께 쓴다. */
export function usdLotKrw(config: ScenarioConfig, s?: GameState): number {
  if (isRiskRules(config.rules.rulesVersion)) {
    if (!s) throw new Error('규칙 3 묶음 계산에는 상태가 필요합니다');
    return exchangeAmounts(config, 'USD_TO_KRW', config.operations!.fx.lotUsdMinor, s.rng.seed, s.day).krw;
  }
  return config.operations ? config.operations.fx.lotUsdMinor * config.operations.fx.buyKrwPerUsd / MINOR_PER_MAJOR.USD : 0;
}
export function paymentDefaultStatus(s: GameState, config: ScenarioConfig, day = s.day) {
  const cfg = config.operations?.paymentDefault;
  const unpaid = unpaidByCurrency(s, config);
  const cash = unpaid.map(({ currency }) => ({ currency, amountMinor: balance(s.ledger, currency, 'CASH') }));
  const oldest = [...s.obligations.filter((o) => o.paidDay === null)].sort((a, b) => a.incurredDay - b.incurredDay || (a.currency === b.currency ? 0 : a.currency === 'USD' ? -1 : 1))[0];
  const ageDays = oldest ? day - oldest.incurredDay : 0;
  const failAtCloseOfDay = oldest && cfg ? oldest.incurredDay + cfg.failureAgeDays : null;
  const krwUnpaid = unpaid.find((u) => u.currency === 'KRW')?.amountMinor ?? 0;
  const krwCash = balance(s.ledger, 'KRW', 'CASH');
  const usdAvailableMinor = fundsPosition(s, config, 'USD').available;
  const lotKrw = usdLotKrw(config, s);
  const dueToSurviveMinor = cfg ? s.obligations.filter((o) => o.paidDay === null && o.currency === 'KRW' && o.incurredDay + cfg.failureAgeDays <= day).reduce((sum, o) => sum + o.amountMinor, 0) : 0;
  const usdOldest = oldest?.currency === 'USD';
  const nextReceipt = s.invoices.filter((i) => i.currency === 'USD' && i.status !== 'PAID' && i.status !== 'WRITTEN_OFF').sort((a, b) => a.dueDay - b.dueDay)[0];
  const usdShort = oldest && usdOldest ? Math.max(0, oldest.amountMinor - balance(s.ledger, 'USD', 'CASH')) : 0;
  const fx = config.operations?.fx;
  return { level: s.operations?.outcome === 'FAILED' ? 'FAILED' as const : !cfg || !oldest ? 'NONE' as const : ageDays >= cfg.dangerFromAgeDays ? 'DANGER' as const : 'WARNING' as const,
    oldest: oldest ? { obligationId: oldest.id, currency: oldest.currency, amountMinor: oldest.amountMinor, reasonKo: oldest.reasonKo, incurredDay: oldest.incurredDay } : null,
    ageDays, dangerFromDay: oldest && cfg ? oldest.incurredDay + cfg.dangerFromAgeDays : null, failAtCloseOfDay,
    failsAtCloseToday: failAtCloseOfDay !== null && day >= failAtCloseOfDay,
    unpaidByCurrency: unpaid, cashByCurrency: cash,
    recovery: { dueToSurviveMinor, lotsToSurvive: usdOldest || !lotKrw ? null : Math.ceil(Math.max(0, dueToSurviveMinor - krwCash) / lotKrw),
      lotsToClearAll: usdOldest || !lotKrw ? null : Math.ceil(Math.max(0, krwUnpaid + dailyKrwDue(s, config, day) - krwCash) / lotKrw),
      usdAvailableLots: fx ? Math.max(0, Math.floor(usdAvailableMinor / fx.lotUsdMinor)) : 0,
      nextReceipt: usdOldest && nextReceipt ? { day: nextReceipt.dueDay, amountMinor: s.invoices.filter((i) => i.currency === 'USD' && i.status !== 'PAID' && i.status !== 'WRITTEN_OFF' && i.dueDay === nextReceipt.dueDay).reduce((sum, i) => sum + i.amountMinor, 0) } : null,
      krwToUsdRequiredMinor: usdOldest && fx ? Math.ceil(usdShort / fx.lotUsdMinor) * fx.lotUsdMinor * (isRiskRules(config.rules.rulesVersion) ? exchangeAmounts(config, 'KRW_TO_USD', fx.lotUsdMinor, s.rng.seed, s.day).rate : fx.sellKrwPerUsd) / MINOR_PER_MAJOR.USD : null,
      heldSpendingKo: krwUnpaid > 0 ? '미지급이 있는 동안 고용 계약금·훈련·현지 활동·창고 확장은 자금 기준에서 막힙니다' : null } };
}

export function processPaymentDefault(s: GameState, config: ScenarioConfig): void {
  if (!s.operations || !config.operations) return;
  const status = paymentDefaultStatus(s, config), oldest = status.oldest;
  if (!oldest || status.level === 'NONE' || status.level === 'FAILED') return;
  const { operations: ops } = s;
  if (!ops.defaultEvents.some((e) => e.obligationId === oldest.obligationId && e.level === status.level)) {
    const e: DefaultEvent = { day: s.day, level: status.level, obligationId: oldest.obligationId, currency: oldest.currency,
      amountMinor: oldest.amountMinor, incurredDay: oldest.incurredDay, dueToSurviveMinor: status.recovery.dueToSurviveMinor,
      lotsToSurvive: status.recovery.lotsToSurvive, lotsToClearAll: status.recovery.lotsToClearAll, usdAvailableMinor: fundsPosition(s, config, 'USD').available };
    ops.defaultEvents.push(e);
    log(s, `지급 불이행 ${e.level === 'WARNING' ? '경고' : '위험'}: ${oldest.incurredDay}일 ${oldest.reasonKo} ${formatMoney(oldest.currency, oldest.amountMinor)}이 밀렸습니다. ${status.failAtCloseOfDay! > config.campaignDays ? `${config.campaignDays}일 캠페인이 끝날 때까지 갚지 못하면 미지급을 남기고 끝납니다.` : `${status.failAtCloseOfDay}일 마감까지 갚지 못하면 경영 실패입니다.`}`);
  }
  if (!status.failsAtCloseToday) return;
  const commitments: (FailureRecord['usdCommitmentsSinceIncurred'][number] & { order: number })[] = [];
  for (const c of s.contracts.filter((c) => c.currency === 'USD' && c.acceptedDay >= oldest.incurredDay && c.acceptedDay <= s.day)) {
    const route = routeBetween(config, c.originCityId, c.destinationCityId);
    const buyCurrency = c.buyOfferId ? offerDef(s, config, c.buyOfferId)!.currency : c.currency;
    const tariffDay = route ? listSailings(config, route.id, c.acceptedDay + 1)[0]?.scheduledArrivalDay ?? c.acceptedDay : c.acceptedDay;
    commitments.push({ kind: 'CONTRACT', id: c.id, day: c.acceptedDay,
      amountMinor: (buyCurrency === c.currency ? c.purchaseAmountMinor : 0) + (route?.bookingFeeMinor ?? 0) + (c.kind === 'DIRECT_TRADE' ? dutyFor(config, s.rng.seed, c.goodId, c.destinationCityId, tariffDay, c.acceptedDay, c.purchaseAmountMinor, buyCurrency, c.acceptedDay) : 0),
      order: s.log.findIndex((l) => l.textKo.startsWith(`계약 ${c.id} 체결`)) });
  }
  for (const c of ops.spaceContracts.filter((c) => c.currency === 'USD' && c.signedDay >= oldest.incurredDay && c.signedDay <= s.day)) {
    commitments.push({ kind: 'SPACE_CONTRACT', id: c.id, day: c.signedDay, amountMinor: c.sailingCount * c.feeMinor,
      order: s.log.findIndex((l) => l.day === c.signedDay && l.textKo.startsWith(`선복 장기 계약: ${routeName(config, c.routeId)} `)) });
  }
  ops.outcome = 'FAILED';
  ops.failure = { day: s.day, ...oldest, unpaidByCurrency: status.unpaidByCurrency, cashByCurrency: status.cashByCurrency,
    warningEvent: ops.defaultEvents.find((e) => e.obligationId === oldest.obligationId && e.level === 'WARNING') ?? null,
    dangerEvent: ops.defaultEvents.find((e) => e.obligationId === oldest.obligationId && e.level === 'DANGER') ?? null,
    optionalKrwSpendBeforeFirstUnpaid: s.ledger.entries.filter((e) => e.currency === 'KRW' && e.day >= oldest.incurredDay - config.operations!.paymentDefault.failureAgeDays && (e.id.startsWith('PURCHASE-') ? e.day <= s.day : e.day < oldest.incurredDay)
      && /^(SIGNING-|TRAINING-FEE-|CULTURE-FEE-|FACILITY-SETUP-|PURCHASE-)/.test(e.id)).map((e) => ({ entryId: e.id, day: e.day,
        amountMinor: -e.lines.filter((l) => l.account === 'CASH').reduce((sum, l) => sum + l.amount, 0), reasonKo: e.reason })),
    usdCommitmentsSinceIncurred: commitments.sort((a, b) => a.day - b.day || a.order - b.order).map(({ order: _order, ...c }) => c) };
  log(s, `경영 실패: ${oldest.incurredDay}일에 생긴 ${oldest.reasonKo} ${formatMoney(oldest.currency, oldest.amountMinor)}을 ${config.operations.paymentDefault.failureAgeDays}일 동안 갚지 못했습니다`);
}
