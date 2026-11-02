import { lateDeliveryReduction, projectPrepCompletion } from './operations';
import { applyBasisPoints } from './money';
// REF-10 계약 진행과 막힌 이유. 상태에서 계산하는 읽기 전용 보고이며 상태를 바꾸지 않는다.
// "무엇이 다음 단계를 막고 있는가"를 화면이 직원 처리량·운항표·사건과 같은 근거로 설명하게 한다.

import { cityName, findSailing, listSailings, routeBetween } from './catalog';
import { employedDefs } from './employees';
import { formatMoney } from './money';
import { spaceShortfall } from './reservations';
import type { Contract, GameState, ScenarioConfig, Shipment } from './types';

/** 오늘 하루 진행의 하역 가능 여부를 읽는다. 과거 대기 일수는 현재 제한을 뜻하지 않는다. */
export function portWaitStatus(s: GameState, config: ScenarioConfig, shipment: Shipment):
  'AT_SEA' | 'ARRIVING_TODAY' | 'WAITING_RESTRICTION' | 'ARRIVED' {
  if (shipment.arrivalDay !== null) return 'ARRIVED';
  if (s.day < shipment.scheduledArrivalDay) return 'AT_SEA';
  const contract = s.contracts.find((c) => c.id === shipment.contractId);
  const restricted = config.portRestrictions.some((r) =>
    r.cityId === contract?.destinationCityId && r.startDay <= s.day && s.day <= r.endDay);
  return restricted ? 'WAITING_RESTRICTION' : 'ARRIVING_TODAY';
}

export type BlockerCode =
  | 'TASK_UNASSIGNED'
  | 'TASK_WILL_MISS_SAILING'
  | 'NO_BOOKING'
  | 'NEXT_SAILING_LATE'
  | 'BOOKED_SAILING_LATE'
  | 'NO_SAILING_LEFT'
  | 'WAITING_PORT_RESTRICTION'
  | 'DUTY_UNPAID'
  | 'AWAITING_PAYMENT';

export interface Blocker {
  code: BlockerCode;
  /** info: 기다리면 되는 상태, warn: 플레이어 행동이 필요함, risk: 그대로 두면 비용·지연이 생김. */
  severity: 'info' | 'warn' | 'risk';
  messageKo: string;
}

export interface ContractProgress {
  nextKo: string;
  blockers: Blocker[];
}

export function contractProgress(s: GameState, config: ScenarioConfig, c: Contract): ContractProgress {
  if (c.status === 'CANCELLED') return { nextKo: '취소된 계약', blockers: [] };
  if (c.status === 'COMPLETED' && s.invoices.some((i) => i.id === c.invoiceId && i.status === 'WRITTEN_OFF')) {
    return { nextKo: `${c.completedDay}일 대금 회수 불능 · 대손 종결`, blockers: [] };
  }
  if (c.status === 'COMPLETED') return { nextKo: c.invoiceId === null && c.priceReductionMinor === c.saleAmountMinor
    ? `${c.completedDay}일 인도 완료 · 전액 감액으로 종결` : `${c.completedDay}일 수금 완료 · 종결`, blockers: [] };
  const blockers: Blocker[] = [];
  const money = (minor: number) => formatMoney(c.currency, minor);
  const late = (days: number) => lateDeliveryReduction(config, c.saleAmountMinor, days);
  const lostFee = config.terms.preDepartureCancellationFeeMinor;
  const task = s.tasks.find((t) => t.id === c.prepTaskId);
  const booking = c.bookingId ? s.bookings.find((b) => b.id === c.bookingId && b.status !== 'CANCELLED') : undefined;
  const shipment = s.shipments.find((sh) => sh.contractId === c.id);

  if (c.deliveredDay !== null) {
    const inv = s.invoices.find((i) => i.id === c.invoiceId);
    if (inv && inv.status !== 'PAID' && inv.status !== 'WRITTEN_OFF') {
      if (s.day >= inv.dueDay) {
        blockers.push({ code: 'AWAITING_PAYMENT', severity: 'info', messageKo: `인도는 끝났고 오늘 하루 진행 때 ${money(inv.amountMinor)}를 받습니다.` });
        return { nextKo: '오늘 수금 예정 — 하루 진행 때 받습니다', blockers };
      }
      blockers.push({ code: 'AWAITING_PAYMENT', severity: 'info', messageKo: `인도는 끝났고 ${inv.dueDay}일에 ${money(inv.amountMinor)}를 받습니다. 그때까지 현금은 들어오지 않습니다.` });
    }
    return { nextKo: inv ? `${inv.dueDay}일 수금 대기` : '정산 대기', blockers };
  }

  if (shipment) {
    if (shipment.arrivalDay === null) {
      const status = portWaitStatus(s, config, shipment);
      if (status === 'WAITING_RESTRICTION') {
        blockers.push({ code: 'WAITING_PORT_RESTRICTION', severity: 'warn', messageKo: `${cityName(config, c.destinationCityId)}항 하역 중단으로 바다에서 대기 중입니다 (${shipment.observedWaitDays}일째). 납기 ${c.deliveryDeadlineDay}일을 넘기면 ${config.terms.lateDeliveryBasis === 'PER_LATE_DAY_CAPPED' && config.terms.lateDeliveryCapBasisPoints !== null ? `늦은 하루마다 ${money(config.terms.lateDeliveryPriceReductionMinor)}씩, 최대 ${money(applyBasisPoints(c.saleAmountMinor, config.terms.lateDeliveryCapBasisPoints!))}까지` : money(late(1))} 감액됩니다.` });
        return { nextKo: '하역 재개 대기', blockers };
      }
      if (status === 'ARRIVING_TODAY') {
        return { nextKo: shipment.observedWaitDays > 0
          ? `하역 재개 — 오늘 도착 예정 (대기 ${shipment.observedWaitDays}일)`
          : '오늘 도착 예정 — 하루 진행 때 하역합니다', blockers };
      }
      return { nextKo: `운송 중 · ${shipment.scheduledArrivalDay}일 도착 예정`, blockers };
    }
    if (!shipment.dutyPaid) {
      blockers.push({ code: 'DUTY_UNPAID', severity: 'risk', messageKo: `관세 ${money(shipment.dutyMinor ?? 0)}가 미지급이라 반출할 수 없습니다. 현금이 들어오면 먼저 갚습니다.` });
      return { nextKo: '관세 납부 대기', blockers };
    }
    return { nextKo: `통관·반출 중 · ${shipment.releaseDay}일 인도 예정`, blockers };
  }

  // 출항 전: 준비 업무와 운송편 예약.
  const route = routeBetween(config, c.originCityId, c.destinationCityId);
  const sailing = booking ? findSailing(config, booking.sailingId) : undefined;
  let readyDay: number | null = null;
  if (task?.status === 'QUEUED') {
    blockers.push({ code: 'TASK_UNASSIGNED', severity: 'warn', messageKo: `준비 업무 ${task.requiredWorkUnits}pt를 아직 아무에게도 배정하지 않았습니다. 배정하기 전에는 화물이 출발할 수 없습니다.` });
  } else if (task?.status === 'RUNNING') {
    const emp = employedDefs(s, config).find((e) => e.id === task.assignedEmployeeId);
    const rate = emp?.workUnitsPerDay ?? 0;
    const remaining = task.requiredWorkUnits - task.progressWorkUnits;
    // 업무는 하루 마감 때 진행되고, 출항은 같은 날 업무 진행 뒤에 처리한다. 그래서 출항일에 끝나도 실을 수 있다.
    readyDay = config.operations ? projectPrepCompletion(s, config).find((p) => p.taskId === task.id)?.readyDay ?? null : rate > 0 ? s.day + Math.ceil(remaining / rate) - 1 : null;
    if (sailing && (readyDay === null || readyDay > sailing.departureDay)) {
      blockers.push({ code: 'TASK_WILL_MISS_SAILING', severity: 'risk', messageKo: `${config.operations ? '창고 처리 순서를 반영하면' : `지금 속도(하루 ${rate}pt)면`} 준비가 ${readyDay ?? '?'}일에 끝나 ${sailing.departureDay}일 출항을 놓칩니다. 놓치면 운임 중 ${money(lostFee)}를 잃고 다시 예약해야 합니다.` });
    }
  } else if (task?.status === 'DONE') {
    readyDay = task.completedDay;
  }

  if (sailing) {
    const release = sailing.scheduledArrivalDay + config.terms.customsDays;
    if (release > c.deliveryDeadlineDay) {
      blockers.push({ code: 'BOOKED_SAILING_LATE', severity: 'risk', messageKo: `예약한 ${sailing.departureDay}일 편은 ${release}일 인도 예정이라 납기 ${c.deliveryDeadlineDay}일을 ${release - c.deliveryDeadlineDay}일 넘깁니다 (감액 ${money(late(release - c.deliveryDeadlineDay))}).` });
    }
  } else if (route) {
    const sailings = listSailings(config, route.id, s.day + 1);
    const first = sailings[0];
    const next = sailings.find((sailing) => spaceShortfall(s, config, sailing, c.goodId, c.quantity) === null);
    if (!next) {
      blockers.push({ code: 'NO_SAILING_LEFT', severity: 'risk', messageKo: '캠페인 안에 이 화물을 실을 공간이 남은 출항편이 없습니다.' });
    } else {
      const departure = first && first.id !== next.id
        ? `${first.departureDay}일 편은 선복이 부족합니다. 실을 수 있는 첫 출항은 ${next.departureDay}일`
        : `다음 출항은 ${next.departureDay}일`;
      blockers.push({ code: 'NO_BOOKING', severity: 'warn', messageKo: `운송편을 예약하지 않았습니다. ${departure}이고 예약 마감은 ${next.departureDay - 1}일입니다.` });
      const release = next.scheduledArrivalDay + config.terms.customsDays;
      if (release > c.deliveryDeadlineDay) {
        blockers.push({ code: 'NEXT_SAILING_LATE', severity: 'risk', messageKo: `다음 편으로도 ${release}일 인도라 납기 ${c.deliveryDeadlineDay}일을 넘깁니다 (감액 ${money(late(release - c.deliveryDeadlineDay))}).` });
      }
    }
  }

  let nextKo: string;
  if (task?.status === 'QUEUED') nextKo = '준비 업무 배정 필요';
  else if (!sailing) nextKo = '운송편 예약 필요';
  else if (task?.status === 'RUNNING') nextKo = `준비 중 · ${readyDay ?? '?'}일 완료 예상 · ${sailing.departureDay}일 출항`;
  else nextKo = `출발 대기 · ${sailing.departureDay}일 출항`;
  return { nextKo, blockers };
}
