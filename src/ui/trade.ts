import { planState } from '../engine/engine';
import { formatMoney } from '../engine/money';
import { listSailings, routeBetween } from '../engine/catalog';
import type { GameState, ScenarioConfig } from '../engine/types';

/** 견적과 같은 출항편 목록에서 납기 안 마지막 편의 예약 마감을 읽는다. */
export function lastDepartureWarnings(view: GameState, config: ScenarioConfig): string[] {
  if (view.phase !== 'AWAITING_INPUT') return [];
  return view.contracts.flatMap((c) => {
    if (c.bookingId || (c.status !== 'ACTIVE' && c.status !== 'IN_PROGRESS')) return [];
    const route = routeBetween(config, c.originCityId, c.destinationCityId);
    if (!route) return [];
    const last = listSailings(config, route.id, view.day + 1)
      .filter((s) => s.scheduledArrivalDay + config.terms.customsDays <= c.deliveryDeadlineDay).at(-1);
    return last?.departureDay === view.day + 1
      ? [`⚠ ${c.id}: 오늘 예약하지 않으면 납기 안 마지막 출항편(${last.departureDay}일)을 놓칩니다.`] : [];
  });
}

/** 환급을 재계산하지 않고 취소 명령이 새로 만든 운임 정산 분개만 읽는다. */
export function cancellationPreviewKo(state: GameState, config: ScenarioConfig, contractId: string): string {
  let id = 'UI-CANCEL-PREVIEW';
  while (state.processedCommands[id]) id += '-';
  const planned = planState(state, config, [{ id, type: 'CANCEL_CONTRACT', contractId }]);
  if (planned.results[0]!.status !== 'APPLIED') return planned.results[0]!.reasonKo;
  const oldIds = new Set(state.ledger.entries.map((e) => e.id));
  const entry = planned.state.ledger.entries.find((e) => !oldIds.has(e.id) && e.contractId === contractId
    && e.lines.some((l) => l.account === 'PREPAID_FREIGHT'));
  if (!entry) return '';
  const refund = entry.lines.find((l) => l.account === 'CASH')?.amount ?? 0;
  const fee = entry.lines.find((l) => l.account === 'CANCELLATION_EXPENSE')?.amount ?? 0;
  return `운임 ${formatMoney(entry.currency, refund)} 환급·취소비 ${formatMoney(entry.currency, fee)}, `;
}
