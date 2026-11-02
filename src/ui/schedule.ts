// 오늘 실행 예정 사본에서 읽는 일정. 날짜 예상은 상태나 장부를 바꾸지 않는다.
import { lateDeliveryReduction } from '../engine/operations';
import { cityName, routeOf } from '../engine/catalog';
import { isAvailableFromToday } from '../engine/employees';
import { formatMoney, type Currency } from '../engine/money';
import { upcomingPayments, type UpcomingPayment } from '../engine/reports';
import { isDayBasedTask, taskSubjectKo } from '../engine/tasks';
import type { GameState, ScenarioConfig } from '../engine/types';
import { taskName } from './card';
import { esc } from './html';

export type ScheduleKind = 'TASK_DONE' | 'DEPARTURE' | 'ARRIVAL' | 'DELIVERY' | 'DEADLINE' | 'RECEIPT' | 'PAYMENT';
export interface ScheduleItem {
  /** 하루 진행 전후의 같은 일정을 식별한다. */
  key: string;
  kind: ScheduleKind;
  /** 지난 날짜도 남긴다. 날짜를 정하지 못하면 null이다. */
  day: number | null;
  contractId: string | null;
  /** 계약 ID는 화면에서 따로 붙인다. */
  textKo: string;
  /** 지금 처리량·운항표로 계산한 날인지 표시한다. */
  estimate: boolean;
  /** 수입은 양수, 지급은 음수이며 한 통화만 담는다. */
  money: { currency: Currency; amountMinor: number } | null;
}

export function scheduleWindow(s: GameState, config: ScenarioConfig): { from: number; to: number } {
  return { from: s.day, to: Math.min(config.campaignDays, s.day + 6) };
}

export function scheduleItems(s: GameState, config: ScenarioConfig, throughDay = scheduleWindow(s, config).to): ScheduleItem[] {
  const items: ScheduleItem[] = [];
  const add = (key: string, kind: ScheduleKind, day: number | null, contractId: string | null,
    textKo: string, estimate = false, money: ScheduleItem['money'] = null) => {
    items.push({ key, kind, day, contractId, textKo, estimate, money });
  };
  if (s.phase !== 'ENDED') {
    for (const task of s.tasks) {
      if (task.status !== 'RUNNING' || !task.assignedEmployeeId || !isAvailableFromToday(s, task.assignedEmployeeId)) continue;
      const emp = config.employees.find((e) => e.id === task.assignedEmployeeId)!;
      const rate = isDayBasedTask(task.kind) ? 1 : emp.workUnitsPerDay;
      const day = s.day + Math.ceil((task.requiredWorkUnits - task.progressWorkUnits) / rate) - 1;
      const subject = task.contractId || task.kind === 'TRAINING' ? '' : `${taskSubjectKo(config, task) ?? ''} `;
      add(`TASK:${task.id}`, 'TASK_DONE', day, task.contractId, `${subject}${taskName(task.kind)} 완료 — ${emp.nameKo}`, true);
    }
    for (const booking of s.bookings) {
      if (booking.status !== 'BOOKED' || booking.departureDay < s.day) continue;
      const route = routeOf(config, booking.routeId);
      add(`DEP:${booking.id}`, 'DEPARTURE', booking.departureDay, booking.contractId,
        `출항 — ${cityName(config, route.fromCityId)} → ${cityName(config, route.toCityId)}`);
    }
    for (const c of s.contracts) {
      if ((c.status !== 'ACTIVE' && c.status !== 'IN_PROGRESS') || c.deliveredDay !== null) continue;
      const sh = s.shipments.find((sh) => sh.contractId === c.id);
      const booking = s.bookings.find((b) => b.id === c.bookingId && b.status === 'BOOKED');
      const arrival = sh ? (sh.arrivalDay === null ? Math.max(sh.scheduledArrivalDay, s.day) : null)
        : booking ? booking.departureDay + routeOf(config, booking.routeId).transitDays : null;
      const delivery = sh && sh.arrivalDay !== null
        ? sh.dutyPaid && sh.releaseDay !== null ? Math.max(sh.releaseDay, s.day) : null
        : arrival === null ? null : arrival + config.terms.customsDays;
      if (arrival !== null) add(`ARR:${c.id}`, 'ARRIVAL', arrival, c.id,
        `${config.terms.customsDays === 0 ? '도착·인도' : '도착'} — ${cityName(config, c.destinationCityId)}`, true);
      if (config.terms.customsDays > 0 && (arrival !== null || sh?.arrivalDay != null)) add(`DLV:${c.id}`, 'DELIVERY', delivery, c.id, '인도', true);
      add(`DUE:${c.id}`, 'DEADLINE', c.deliveryDeadlineDay, c.id,
        c.deliveryDeadlineDay < s.day ? `납기 지남 (${c.deliveryDeadlineDay}일)` : '납기');
      if (delivery !== null) {
        const amountMinor = c.saleAmountMinor - lateDeliveryReduction(config, c.saleAmountMinor, delivery - c.deliveryDeadlineDay);
        if (amountMinor > 0) add(`RCV:${c.id}`, 'RECEIPT', Math.max(c.paymentDueDay, delivery), c.id, '수금', true,
          { currency: c.currency, amountMinor });
      }
    }
    for (const invoice of s.invoices) if (invoice.status !== 'PAID') add(`RCV:${invoice.contractId}`, 'RECEIPT',
      invoice.dueDay, invoice.contractId, '수금', false, { currency: invoice.currency, amountMinor: invoice.amountMinor });
  }
  const payments = upcomingPayments(s, config, throughDay);
  const wages = new Map<Currency, UpcomingPayment>();
  for (const p of payments) {
    if (p.kind === 'OVERDUE') continue;
    let key: string, text: string;
    if (p.kind === 'WAGE') {
      const before = wages.get(p.currency);
      wages.set(p.currency, p);
      if (before && before.amountMinor === p.amountMinor && before.employeeIds.join('\0') === p.employeeIds.join('\0')) continue;
      key = `PAY:WAGE:${p.currency}:${p.amountMinor}:${p.employeeIds.length}`;
      text = before ? `${p.labelKo}로 바뀜` : `${p.labelKo} (매일)`;
    } else {
      key = `PAY:${p.kind}:${p.sourceId}`;
      switch (p.kind) {
        case 'RENT': text = '창고 임차료'; break;
        case 'SPACE_FEE': text = p.labelKo; break;
        case 'FREIGHT': text = '운송편 예약 마감 · 운임 선지급'; break;
        case 'DUTY': text = '수입 관세'; break;
        default: { const missing: never = p.kind; throw new Error(`알 수 없는 지급 종류: ${missing}`); }
      }
    }
    add(key, 'PAYMENT', p.day, p.contractId, text, false, { currency: p.currency, amountMinor: -p.amountMinor });
  }
  for (const currency of new Set(payments.filter((p) => p.kind === 'OVERDUE').map((p) => p.currency))) {
    const rows = payments.filter((p) => p.kind === 'OVERDUE' && p.currency === currency);
    const day = Math.min(...rows.map((p) => p.day!));
    add(`PAY:OVERDUE:${currency}`, 'PAYMENT', day, null,
      `밀린 지급 ${rows.length}건 (${day}일부터, 현금이 들어오면 먼저 갚음)`, false,
      { currency, amountMinor: -rows.reduce((sum, p) => sum + p.amountMinor, 0) });
  }
  const order: Record<ScheduleKind, number> = { TASK_DONE: 0, DEPARTURE: 1, ARRIVAL: 2, DELIVERY: 3, DEADLINE: 4, RECEIPT: 5, PAYMENT: 6 };
  return items.filter((i) => i.day === null || i.day < s.day || i.day <= throughDay).sort((a, b) =>
    (a.day ?? Infinity) - (b.day ?? Infinity) || order[a.kind] - order[b.kind] || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export function scheduleKeys(s: GameState, config: ScenarioConfig): Record<string, number | null> {
  return Object.fromEntries(scheduleItems(s, config, config.campaignDays).map((i) => [i.key, i.day]));
}

export function scheduleBlock(s: GameState, config: ScenarioConfig, opts: {
  open: boolean; prev: Record<string, number | null> | null; link: (contractId: string) => string;
}): string {
  const { from, to } = scheduleWindow(s, config);
  const items = scheduleItems(s, config, to);
  const line = (i: ScheduleItem) => {
    const prev = opts.prev;
    const changed = prev === null ? '' : !(i.key in prev) ? ' <span class="tag">새 일정</span>'
      : prev[i.key] !== i.day && !i.key.startsWith('PAY:WAGE:') && !i.key.startsWith('PAY:OVERDUE:')
        ? ` <span class="tag">날짜 바뀜 (원래 ${prev[i.key] ?? '날짜 미정'}${prev[i.key] === null ? '' : '일'})</span>` : '';
    return `<li>${i.contractId ? opts.link(i.contractId) + ' ' : ''}${esc(i.textKo)}${i.money ? ` <b>${i.money.amountMinor > 0 ? '+' : ''}${esc(formatMoney(i.money.currency, i.money.amountMinor))}</b>` : ''}${i.estimate ? ' <span class="tag tag-estimate">예상</span>' : ''}${changed}</li>`;
  };
  const groups = new Map<string, ScheduleItem[]>();
  for (const i of items) {
    const label = i.day === null ? '날짜 미정' : i.day < s.day ? '지난 날짜' : `${i.day}일${i.day === s.day ? ' (오늘)' : ''}`;
    groups.set(label, [...(groups.get(label) ?? []), i]);
  }
  const later = scheduleItems(s, config, config.campaignDays).filter((i) => i.day !== null && i.day > to);
  return `<div class="schedule-block"><button class="link" id="schedule-toggle" data-action="schedule-toggle" aria-expanded="${opts.open}" aria-controls="schedule-body">앞으로 ${to - from + 1}일 일정 (${items.length}건)</button>${opts.open ? `<div id="schedule-body">${items.length ? `<ol class="schedule-days">${[...groups].map(([label, rows]) => `<li><b>${esc(label)}</b><ul>${rows.map(line).join('')}</ul></li>`).join('')}</ol>` : `<p class="muted">앞으로 ${to - from + 1}일 동안 정해진 일이 없습니다.</p>`}${later.length ? `<p class="muted small">그 뒤 일정 ${later.length}건 — 가장 가까운 날은 ${Math.min(...later.map((i) => i.day!))}일입니다.</p>` : ''}<p class="muted small">‘예상’은 지금 처리량과 운항표로 계산한 날입니다. 사건이 생기면 바뀔 수 있습니다.</p></div>` : ''}</div>`;
}
