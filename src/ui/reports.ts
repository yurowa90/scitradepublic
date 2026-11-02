import { warehouseSummary } from '../engine/readers';
import { formatMoney } from '../engine/money';
import { contractProgress, type BlockerCode } from '../engine/progress';
import { fundsPosition } from '../engine/reservations';
import { cityName, goodOf, unitKo } from '../engine/catalog';
import type { WorkloadSummary } from '../engine/capacity';
import type { Currency } from '../engine/money';
import type { CompanyReport, CurrencyStanding, UpcomingPayment, UpcomingPaymentKind } from '../engine/reports';
import type { GameState, ScenarioConfig } from '../engine/types';
import { esc } from './html';

export function krwReportRows(report: CompanyReport, config: ScenarioConfig): string {
  const p = report.payroll;
  const rows: [string, number][] = [
    ['시작 운영 자금', p.openingEquity], ['급여', -p.wageExpense],
    ...(config.recruitment || config.growth ? [['영입 계약금', -p.recruitmentExpense], ['훈련비', -p.trainingExpense]] as [string, number][] : []),
    ...(config.culture ? [['현지 활동비', -p.cultureExpense]] as [string, number][] : []),
    ...(config.operations ? ([['창고 임차료', -p.rentExpense], ['창고 확장 설치비', -p.facilitySetupExpense], ['환전 차감', -p.fxSpreadExpense], ['통화 간 이체(환전)', p.currencyTransferNet]] as [string, number][]).filter(([, value]) => value !== 0) : []),
    ['운영 손익', p.profit], [config.operations ? '미지급(급여·임차료)' : '미지급 급여', p.accountsPayable], ['현금', p.cash],
  ];
  return rows.map(([label, amount]) => `<tr><th>${label}</th><td>${esc(formatMoney(config.payrollCurrency, amount))}</td></tr>`).join('');
}

export const KRW_REPORT_NOTE_KO = '급여는 원화로 매일 지급하며 계약금·훈련비는 한 번 내는 원화 비용입니다. USD 거래 장부와 합산하지 않습니다. 가상 환율 1,300원/달러는 보고에 쓰지 않습니다.';
export const KRW_REPORT_NOTE_CULTURE_KO = '급여는 원화로 매일 지급하며 계약금·훈련비·현지 활동비는 한 번 내는 원화 비용입니다. USD 거래 장부와 합산하지 않습니다. 가상 환율 1,300원/달러는 보고에 쓰지 않습니다.';

export function krwReportNoteKo(config: ScenarioConfig): string {
  if (config.operations) return '환전 명령으로 실제 바꾼 금액만 기록합니다. 통화는 합치지 않습니다.';
  if (config.culture) return KRW_REPORT_NOTE_CULTURE_KO;
  return config.recruitment || config.growth ? KRW_REPORT_NOTE_KO
    : '급여는 원화로 매일 지급합니다. USD 거래 장부와 합산하지 않습니다. 가상 환율 1,300원/달러는 보고에 쓰지 않습니다.';
}

export function rateKo(basisPoints: number): string {
  const whole = Math.floor(basisPoints / 100);
  const fraction = basisPoints % 100;
  return `${whole}${fraction ? `.${String(fraction).padStart(2, '0')}` : ''}%`;
}

export function qtyKo(config: ScenarioConfig, goodId: string, quantity: number): string {
  const good = goodOf(config, goodId);
  return `${good.nameKo} ${quantity.toLocaleString('ko-KR')}${unitKo(good)}`;
}

/** 회사 보고와 같은 보유 기준으로 품목별 수량을 읽는다. */
export function heldCargoByGood(s: GameState, config: ScenarioConfig, owner: 'COMPANY' | 'CUSTOMER') {
  return config.goods.flatMap((good) => {
    const quantity = s.cargoLots.filter((lot) => lot.owner === owner && lot.goodId === good.id
      && lot.status !== 'DELIVERED' && lot.status !== 'RETURNED_TO_OWNER').reduce((sum, lot) => sum + lot.quantity, 0);
    return quantity ? [{ goodId: good.id, quantity }] : [];
  });
}

export function cargoListKo(config: ScenarioConfig, items: { goodId: string; quantity: number }[]): string {
  return items.map((item) => qtyKo(config, item.goodId, item.quantity)).join(' · ') || '없음';
}

/** 날짜를 정하지 못한 지급. 금액은 통화마다 따로 둔다. */
export interface UndatedPayments { count: number; amounts: { currency: Currency; amountMinor: number }[] }

export function upcomingSummary(rows: UpcomingPayment[], config: ScenarioConfig): {
  currencies: Currency[];
  lines: { kind: UpcomingPaymentKind; labelKo: string; amounts: (number | null)[] }[];
  /** 실을 자리가 남은 출항편이 없어 운임 날짜가 없는 계약의 지급. */
  noSailing: UndatedPayments;
  /** 운송편을 아직 예약하지 않아 관세 날짜가 없는 지급. */
  unbooked: UndatedPayments;
} {
  const currencies = [...new Set([config.tradeCurrency, config.payrollCurrency, ...rows.map((r) => r.currency).sort()])];
  const labels: [UpcomingPaymentKind, string][] = [
    ['OVERDUE', '밀린 지급 (현금이 들어오면 먼저 갚음)'],
    ...(config.operations ? [['RENT', '창고 임차료 (기간마다 자동)'], ['SPACE_FEE', '선복 계약 요금 (출항마다 자동)']] as [UpcomingPaymentKind, string][] : []),
    ['WAGE', '급여 (하루 진행 때 자동)'],
    ['FREIGHT', '운임 (운송편을 예약할 때)'], ['DUTY', '관세 (도착할 때 자동)'],
  ];
  // 기간 표에는 날짜가 정해진 지급만 넣는다.
  const dated = rows.filter((r) => r.day !== null);
  const noSailingContracts = new Set(rows.filter((r) => r.kind === 'FREIGHT' && r.day === null).map((r) => r.contractId));
  const undated = (pick: (r: UpcomingPayment) => boolean): UndatedPayments => {
    const chosen = rows.filter((r) => r.day === null && pick(r));
    return { count: chosen.length, amounts: currencies.flatMap((currency) => {
      const matching = chosen.filter((r) => r.currency === currency);
      return matching.length ? [{ currency, amountMinor: matching.reduce((sum, r) => sum + r.amountMinor, 0) }] : [];
    }) };
  };
  return { currencies, lines: labels.map(([kind, labelKo]) => ({ kind, labelKo,
    amounts: currencies.map((currency) => {
      const matching = dated.filter((r) => r.kind === kind && r.currency === currency);
      return matching.length ? matching.reduce((sum, r) => sum + r.amountMinor, 0) : null;
    }),
  })), noSailing: undated((r) => noSailingContracts.has(r.contractId)),
  unbooked: undated((r) => !noSailingContracts.has(r.contractId)) };
}

export function workloadLinesKo(summary: WorkloadSummary, config: ScenarioConfig): string[] {
  const lines = summary.byCity.map((row) => {
    const { unassignedWorkUnits: u, runningWorkUnits: r, staffWorkUnitsPerDay: staff,
      dayTaskWorkUnitsPerDay: dayTask, idleWorkUnitsPerDay: idle, daysToClear } = row;
    const end = daysToClear === 0 ? '남은 업무 없음' : daysToClear === null ? '지금 이 업무를 처리할 사람이 없음' : `약 ${daysToClear}일`;
    return `${cityName(config, row.cityId)}: 남은 업무 ${u + r}pt(배정 전 ${u}pt · 진행 중 ${r}pt), 하루 처리 ${staff - dayTask}pt${dayTask ? `(훈련·현지 활동 중 ${dayTask}pt 빼고)` : ''} → ${end}. 지금 바로 맡길 수 있는 처리량 하루 ${idle}pt.`;
  });
  for (const row of summary.startingLater) lines.push(`${config.employees.find((e) => e.id === row.employeeId)!.nameKo}: ${row.availableFromDay}일부터 근무(하루 ${row.workUnitsPerDay}pt).`);
  return lines.length ? lines : ['직원과 남은 업무가 없습니다.'];
}

export type BottleneckKind = '돈' | '시간' | '사람' | '선복' | '창고';
export const BOTTLENECK_OF: Record<BlockerCode, BottleneckKind | null> = {
  TASK_UNASSIGNED: '사람', TASK_WILL_MISS_SAILING: '사람', NO_BOOKING: '선복', NO_SAILING_LEFT: '선복',
  NEXT_SAILING_LATE: '시간', BOOKED_SAILING_LATE: '시간', WAITING_PORT_RESTRICTION: '시간',
  DUTY_UNPAID: '돈', AWAITING_PAYMENT: null,
};

export function bottlenecks(s: GameState, config: ScenarioConfig): {
  kind: BottleneckKind; items: { contractId: string | null; textKo: string }[];
}[] {
  const groups = (['돈', '시간', '사람', '선복', ...(config.operations ? ['창고' as const] : [])] as BottleneckKind[]).map((kind) => ({ kind,
    items: [] as { contractId: string | null; textKo: string }[] }));
  for (const currency of new Set([config.tradeCurrency, config.payrollCurrency])) {
    const unpaid = fundsPosition(s, config, currency).unpaidObligations;
    if (unpaid > 0) groups[0]!.items.push({ contractId: null,
      textKo: `미지급금이 ${formatMoney(currency, unpaid)} 있습니다. 현금이 들어오면 먼저 갚습니다.` });
  }
  const available = fundsPosition(s, config, config.tradeCurrency).available;
  if (config.rules.fundsCheck === 'COMMITTED_OUTLAYS' && available < 0) groups[0]!.items.push({ contractId: null,
    textKo: `사용 가능 자금이 ${formatMoney(config.tradeCurrency, available)}입니다. 체결한 계약의 운임·관세 예약이 현금보다 많습니다.` });
  for (const c of s.contracts) for (const blocker of contractProgress(s, config, c).blockers) {
    const kind = BOTTLENECK_OF[blocker.code];
    if (blocker.severity !== 'info' && kind !== null) groups.find((g) => g.kind === kind)!.items.push({ contractId: c.id, textKo: blocker.messageKo });
  }
  if (config.operations) {
    const q = warehouseSummary(s, config), items = groups.find((g) => g.kind === '창고')!.items;
    for (const wait of q.handling.waits) items.push({ contractId: wait.contractId,
      textKo: `${wait.contractId} 준비 업무가 창고 처리 한도에 걸려 오늘 ${wait.gotPt}/${wait.wantPt}pt만 진행합니다` });
    if (q.storage.usedLiters >= q.storage.capacityLiters * 0.9) items.push({ contractId: null,
      textKo: `창고 보관 ${q.storage.usedLiters / 1000}/${q.storage.capacityLiters / 1000} m³ — 새 화물을 받기 어렵습니다` });
  }
  return groups;
}

/** 결산의 남은 미지급 한 줄. 급여 이유에는 이미 날짜가 있어 앞에 다시 붙이지 않는다. */
export function obligationLineKo(o: { incurredDay: number; reasonKo: string }): string {
  return new RegExp(`(^|[^0-9])${o.incurredDay}일`).test(o.reasonKo) ? o.reasonKo : `${o.incurredDay}일 ${o.reasonKo}`;
}

export function settlementRows(st: CurrencyStanding, config: ScenarioConfig): [string, number, boolean][] {
  const rows: [string, number, boolean][] = [['현금', st.cash, false]];
  for (const [label, value] of [['재고', st.inventory], ['선급운임', st.prepaidFreight],
    ['주선 진행원가', st.forwardingWip], ['매출채권', st.accountsReceivable]] as [string, number][]) {
    if (st.currency === config.tradeCurrency || value !== 0) rows.push([label, value, false]);
  }
  rows.push(['자산 합계', st.totalAssets, true], ['미지급금', st.accountsPayable, false],
    ['순자산 (자산 − 미지급금)', st.netAssets, true], ['시작 자본', st.openingEquity, false], ['손익', st.profit, false]);
  if (st.currency === config.tradeCurrency || st.contractContribution !== 0) rows.push(['계약 기여이익 합계', st.contractContribution, false]);
  if (config.operations && st.currencyTransferNet !== 0) rows.push(['통화 간 이체(환전)', st.currencyTransferNet, false]);
  return rows;
}
