import { dutyFor } from './risk';
import { offerDef } from './market';
import { coveredSailings, spaceCovered, spaceEntryId } from './operations';
// 하나의 예약 체계: 자금(체결한 계약이 앞으로 낼 돈), 직원 시간(진행 중 업무), 선복(출항편의 무게·부피).
// 예약은 상태에서 매번 계산하며 따로 저장하지 않는다. 같은 돈·직원·공간을 두 곳에 기록하지 않기 위해서다.

import { cargoSpace, listSailings, routeBetween, routeOf, type Sailing } from './catalog';
import { isAvailableFromToday } from './employees';
import { balance } from './ledger';
import type { Currency } from './money';
import type { GameState, ScenarioConfig, Task } from './types';

// ── 자금 ──

export interface CashReservation {
  contractId: string;
  /** FREIGHT: 아직 예약하지 않은 운송편의 선지급 운임. DUTY: 아직 내지 않은 수입 관세(직접 무역만). */
  kind: 'FREIGHT' | 'DUTY';
  currency: Currency;
  amountMinor: number;
}

/** 진행 중인 계약이 앞으로 낼 것으로 정해진 돈. 매입대금은 수락 때 이미 냈으므로 포함하지 않는다. */
export function cashReservations(s: GameState, config: ScenarioConfig): CashReservation[] {
  const out: CashReservation[] = [];
  for (const c of s.contracts) {
    if (c.status !== 'ACTIVE' && c.status !== 'IN_PROGRESS') continue;
    const shipment = s.shipments.find((sh) => sh.contractId === c.id);
    const booking = c.bookingId ? s.bookings.find((b) => b.id === c.bookingId) : undefined;
    const route = routeBetween(config, c.originCityId, c.destinationCityId);
    if (route && !shipment && (!booking || booking.status === 'CANCELLED')) {
      out.push({ contractId: c.id, kind: 'FREIGHT', currency: route.currency, amountMinor: route.bookingFeeMinor });
    }
    if (c.kind === 'DIRECT_TRADE' && (!shipment || shipment.dutyMinor === null)) {
      const tariffDay = shipment ? Math.max(shipment.scheduledArrivalDay, s.day)
        : booking?.status === 'BOOKED' ? booking.departureDay + routeOf(config, booking.routeId).transitDays
          : route ? listSailings(config, route.id, s.day + 1)[0]?.scheduledArrivalDay ?? s.day : s.day;
      const duty = dutyFor(config, s.rng.seed, c.goodId, c.destinationCityId, tariffDay, s.day,
        c.purchaseAmountMinor, offerDef(s, config, c.buyOfferId!)!.currency, c.acceptedDay);
      if (duty > 0) out.push({ contractId: c.id, kind: 'DUTY', currency: c.currency, amountMinor: duty });
    }
  }
  return out;
}

export interface FundsPosition {
  currency: Currency;
  cash: number;
  /** 다른 계약을 위해 묶어 둔 돈. */
  reserved: number;
  reservedCommitments: number;
  /** 이미 생긴 미지급 의무. 현금이 들어오면 먼저 갚는다. */
  unpaidObligations: number;
  /** 새 지출에 쓸 수 있는 돈 = 현금 − 예약 − 미지급. 음수일 수 있다. */
  available: number;
}

/**
 * 자금 위치. `exclude`로 고른 예약은 빼고 계산한다
 * (예: 운임을 실제로 낼 때 그 계약의 운임 예약은 자기 돈이므로 제외).
 */
export function fundsPosition(
  s: GameState,
  config: ScenarioConfig,
  currency: Currency,
  exclude: (r: CashReservation) => boolean = () => false,
): FundsPosition {
  const cash = balance(s.ledger, currency, 'CASH');
  const reservedCommitments = commitmentReservations(s, config).filter((r) => r.currency === currency).reduce((sum, r) => sum + r.amountMinor, 0);
  const reserved = reservedCommitments + cashReservations(s, config)
    .filter((r) => r.currency === currency && !exclude(r))
    .reduce((acc, r) => acc + r.amountMinor, 0);
  const unpaidObligations = s.obligations
    .filter((o) => o.currency === currency && o.paidDay === null)
    .reduce((acc, o) => acc + o.amountMinor, 0);
  return { currency, cash, reserved, reservedCommitments, unpaidObligations, available: cash - reserved - unpaidObligations };
}

/** 일반 훈련은 기존 규칙대로 현금에서 미지급 의무만 뺀다. 계약 자금 예약은 차감하지 않는다. */
export function trainingAvailableMinor(s: GameState, config: ScenarioConfig, currency: Currency): number {
  return cashLessUnpaidMinor(s, config, currency);
}

/** 훈련·고용의 공통 자금 기준: 현금 − 미지급 의무. */
export function cashLessUnpaidMinor(s: GameState, config: ScenarioConfig, currency: Currency): number {
  const funds = fundsPosition(s, config, currency);
  return funds.cash - funds.unpaidObligations;
}

// ── 선복 ──

export interface SailingLoad {
  sailingId: string;
  massGrams: number;
  volumeLiters: number;
  capacityGrams: number;
  capacityLiters: number;
}

export function sailingLoad(s: GameState, config: ScenarioConfig, sailing: Sailing): SailingLoad {
  const route = routeOf(config, sailing.routeId);
  let massGrams = 0;
  let volumeLiters = 0;
  for (const b of s.bookings) {
    if (b.sailingId !== sailing.id || b.status === 'CANCELLED') continue;
    massGrams += b.massGrams;
    volumeLiters += b.volumeLiters;
  }
  return {
    sailingId: sailing.id,
    massGrams,
    volumeLiters,
    capacityGrams: Math.round(route.capacityKg * 1000) + (spaceCovered(s, config, sailing) ? config.operations!.spaceContract.extraGrams : 0),
    capacityLiters: Math.round(route.capacityM3 * 1000) + (spaceCovered(s, config, sailing) ? config.operations!.spaceContract.extraLiters : 0),
  };
}

/** 화물을 더 실을 수 있으면 null, 아니면 부족한 항목 설명. */
export function spaceShortfall(
  s: GameState,
  config: ScenarioConfig,
  sailing: Sailing,
  goodId: string,
  quantity: number,
): string | null {
  const load = sailingLoad(s, config, sailing);
  const need = cargoSpace(config, goodId, quantity);
  const short: string[] = [];
  if (load.massGrams + need.massGrams > load.capacityGrams) {
    short.push(`무게 ${fmtKg(need.massGrams)} 필요, 남은 ${fmtKg(load.capacityGrams - load.massGrams)}`);
  }
  if (load.volumeLiters + need.volumeLiters > load.capacityLiters) {
    short.push(`부피 ${fmtM3(need.volumeLiters)} 필요, 남은 ${fmtM3(load.capacityLiters - load.volumeLiters)}`);
  }
  return short.length ? short.join(' · ') : null;
}

export const fmtKg = (grams: number) => `${(grams / 1000).toLocaleString('ko-KR')}kg`;
export const fmtM3 = (liters: number) => `${(liters / 1000).toLocaleString('ko-KR')}m³`;

// ── 직원 시간 ──

/** 직원이 지금 맡고 있는 업무. 한 사람은 한 번에 업무 하나만 진행한다(M2a). */
export function runningTaskOf(s: GameState, employeeId: string): Task | undefined {
  if (!isAvailableFromToday(s, employeeId)) return undefined;
  return s.tasks.find((t) => t.status === 'RUNNING' && t.assignedEmployeeId === employeeId);
}

/** 해지할 수 없는 선복 계약 가운데 이동 창 안에 든 출항편만 예약한다. */
export function commitmentReservations(s: GameState, config: ScenarioConfig) {
  if (!s.operations || !config.operations) return [];
  return s.operations.spaceContracts.flatMap((c) => coveredSailings(config, c.routeId, c.signedDay)
    .filter((v) => s.day <= v.departureDay && v.departureDay <= s.day + config.operations!.spaceContract.reserveDaysAhead
      && !s.ledger.postedIds[spaceEntryId(c.routeId, v.departureDay)])
    .map((v) => ({ spaceContractId: c.id, sailingId: v.id, day: v.departureDay, currency: c.currency, amountMinor: c.feeMinor })));
}
