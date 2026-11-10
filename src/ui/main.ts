// 최소 화면: 견적판·계약(UI_TRADE), 자원 예약, 세계지도(UI_WORLD), 경영 보고(UI_REPORT), 동료 카드.
// 화면은 엔진 상태를 읽고 명령을 대기열에 넣을 뿐, 현금·재고·예약을 따로 들고 있지 않다.

import './style.css';
import { applyPixelScale } from './pixel';
import { spriteHtml } from './sprite';
import { esc, josa } from './html';
import { CULTURE_KO, cultureAnchorBlocks, culturePanelScreen, cultureResultTasks, cultureTab, cultureToastText } from './culture';
import { employedDefs } from '../engine/employees';
import { LOADABLE_SCENARIO_IDS, SELECTABLE_SCENARIO_IDS, scenarioTitle, isOperationsScenario, assumptionNotes, loadScenario, type AnyScenarioId } from '../content/scenario';
import { cargoSpace, goodOf, routeBetween, unitKo } from '../engine/catalog';
import { cityName, createGame, listSailings, openDay, planCommands, planState, restartWithSameSeed } from '../engine/engine';
import { formatMoney } from '../engine/money';
import { campaignSummary, onTimeDeliveryRate, upcomingPayments, companyReport, contractReport, forwardingPreview, tradePairs, tradePreview, type QuotePreview } from '../engine/reports';
import { cashReservations, fmtKg, fmtM3, fundsPosition, runningTaskOf, sailingLoad } from '../engine/reservations';
import { serializeSave } from '../engine/save';
import { contractProgress, portWaitStatus } from '../engine/progress';
import type { CommandResult, CommitPlan, Contract, EmployeeDef, GameState, ScenarioConfig } from '../engine/types';
import { attributeKo, roleKo, taskName } from './card';
import { officeButton, batchUnlocked, crewEntryCard, crewRow, crewEntries, crewFacetOptions, recruitmentPanel, taskSchedule, venueTitle } from './recruitment';
import { type UiCommand as Command, initialUiState, loadSaveText, advanceDay, hasUnsavedWork, nextAnnouncement, liveRegionText } from './session';
import { offerDef, openTradePairs } from '../engine/market';
import { exchangePreview, quotePreview, type OperationsQuotePreview } from '../engine/readers';
import { counterpartyNameKo, routeLabel } from './ops-labels';
import { lazyScreen, ScreenLoadExhaustedError } from './lazy';
import { paymentDefaultStatus } from '../engine/operations';
import { cancellationPreviewKo, lastDepartureWarnings } from './trade';
import { receiptSchedule, bottlenecks, cargoListKo, heldCargoByGood, obligationLineKo, qtyKo as reportQtyKo, rateKo, settlementRows, upcomingSummary, workloadLinesKo, krwReportRows, krwReportNoteKo, type UndatedPayments } from './reports';
import { crewNoteKo, crewStatusKo } from './crew-status';
import { taskSubjectKo } from '../engine/tasks';
import { employeeDetail, growthMessages, growthStatus, payrollRunwayKo } from './growth';
import { payrollRunwayDay } from '../engine/previews';
import { workloadSummary } from '../engine/capacity';
import { scheduleBlock, scheduleKeys } from './schedule';
import { FOCUS_FALLBACK_SELECTORS, focusFallbackIds, FIXED_REGION_SELECTOR } from './focus';
import { MAP_ATTRIBUTION, mapLegend, renderWorldMap, MapMeasurementMemory, mapPresentation, readMapScroll, mapScrollPosition, mapRedrawDecision, type MapMode, type MapMark, mapMarks, nearestMarks } from './map';

declare const __BUILD_ID__: string | undefined;
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

const SAVE_KEY = 'scitrade-save';
/** M1 시제품이 쓰던 저장 칸. 불러오기만 하며, 저장 형식 1~6은 엔진이 명시 문구로 거절한다. */
const LEGACY_SAVE_KEY = 'scitrade-m1-save';
const SCENARIO_TITLES = Object.fromEntries(SELECTABLE_SCENARIO_IDS.map((id) => [id, scenarioTitle(id)])) as Record<(typeof SELECTABLE_SCENARIO_IDS)[number], string>;

let opsScreens: typeof import('./ops-screens') | null = null;
let culturePanel: typeof import('./culture-panel') | null = null;
const opsScreen = lazyScreen(() => import('./ops-screens'));
const situationScreen = lazyScreen(() => import('./situation'));
const officeScreen = lazyScreen(() => import('./office-scene'));
let officeOpen = false;
let situationOpen = false;
/** 시험 준비도 실제 진입과 같은 약속을 공유한다. */
export async function ensureOpsScreens(): Promise<void> {
  await opsScreen.ensure();
  opsScreens = opsScreen.get();
}
export async function ensureCulturePanel(): Promise<void> {
  await culturePanelScreen.ensure();
  culturePanel = culturePanelScreen.get();
}
let enteringScenario = false;
const SCREEN_LOAD_WARNING = '화면 일부를 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 눌러 주세요.';
function screenLoadWarning(error: unknown, fromSave = false) {
  ui.flash = error instanceof ScreenLoadExhaustedError
    ? { kind: 'warn', action: 'reload', text: fromSave
      ? '화면 일부를 불러오지 못했습니다. 새로 고침한 뒤 ‘불러오기’를 다시 눌러 주세요. 저장된 상태는 그대로 있습니다.'
      : '화면 일부를 불러오지 못했습니다. 연결을 확인한 뒤 저장하고 새로 고침해 주세요.' }
    : { kind: 'warn', text: SCREEN_LOAD_WARNING };
  render();
}

let config: ScenarioConfig;
let state: GameState;
let savedState: GameState | null = null;
let skipNextBeforeUnload = false;
let previousPaymentLevel: ReturnType<typeof paymentDefaultStatus>['level'] = 'NONE';
let announcedFlash: ReturnType<typeof initialUiState>['flash'] = null;
let lastTabAt = -Infinity, tabX = 0, tabY = 0;
/** 대기 명령을 반영한 ‘오늘 실행 예정’ 사본. 거래·예약 화면 표시에만 쓰고 보고·현금은 확정 상태(state)를 쓴다. */
let view: GameState;
let ui = initialUiState();
let investmentOpen: boolean | undefined;
let investmentSignature = '';
let selectedExchange: ReturnType<typeof import('./ops-screens').exchangeSelection> | undefined;
let mapMode: MapMode = 'route';
const mapMeasurements = new MapMeasurementMemory();
const MAP_BASE_OUTSIDE_SVG = false;
let mapScrollRatio: number | undefined;
let resetMapScroll = true;
let commandSeq = 0;
let ignoreClicksUntil = 0;
let activation: { element: HTMLElement; pointer: boolean } | null = null;
let statusbarObserver: ResizeObserver | undefined;
const actionSizes = new Map<string, { height: number; width: number }>();
/** 누른 버튼이 칸 안에서 있던 높이. 예정 표시를 그 자리에 둔다. */
const actionOffsets = new Map<string, number>();

/** 세 열 배치의 오른쪽 세 칸. */
const SIDE_PANELS = '.crew, .resources, .queue';
/** 하루 진행 뒤 오른쪽 칸에서 읽던 자리 후보. */
const SIDE_ANCHORS = '.crew h2, .crew h3, .crew h4, .crew article.card, .crew tbody tr, .resources h2, .resources h3, .resources li, .queue h2, .queue li, .queue .growth-notices';
/** 마지막으로 누르거나 굴리거나 초점을 둔 열(배치안 A). */
let lastColumn: 'main' | 'side' | null = null;
/** 동료를 카드로 골랐으면 상세를 그 카드 바로 아래에 둔다. 운영표 줄로 골랐으면 운영표 아래. */
let detailUnder: 'card' | 'roster' = 'card';
/** Esc로 닫는 칸. 안쪽 칸이 앞이다(기록장은 현지 패널 안). */
type LayerKey = 'book' | 'local' | 'interview' | 'detail' | 'map' | 'path11';
const LAYER_ORDER: LayerKey[] = ['book', 'local', 'interview', 'detail', 'map', 'path11'];
/** 칸마다 마지막으로 열거나 그 안을 누르거나 초점을 둔 순번. */
const layerTouched: Record<LayerKey, number> = { book: 0, local: 0, interview: 0, detail: 0, map: 0, path11: 0 };
let layerSeq = 0;
/** 지도 상세에서 고른 표시와 가까운 후보의 열쇠. */
let mapPick: string | null = null;
let mapNear: string[] = [];

/** 다시 그려도 배정·예약 자리가 줄어들어 다음 버튼이 움직이지 않게 한다. */
function queuedStatus(slot: string, text: string): string {
  const offset = actionOffsets.get(slot);
  return `<div class="sailings queued-slot" style="min-height:${actionSizes.get(slot)?.height ?? 0}px;width:${actionSizes.get(slot)?.width ?? 0}px;max-width:100%${offset === undefined ? '' : `;justify-content:flex-start;padding-top:${Math.round(offset)}px`}"><span class="pill" id="status-${esc(slot)}" tabindex="-1">${text}</span></div>`;
}

function measureStatusbar() {
  statusbarObserver?.disconnect();
  const bar = app.querySelector<HTMLElement>('.statusbar')!;
  const update = () => document.documentElement.style.setProperty('--topbar-h', `${bar.getBoundingClientRect().height}px`);
  update();
  statusbarObserver = new ResizeObserver(update);
  statusbarObserver.observe(bar);
}

function focusWithoutScroll(target: HTMLElement | undefined | null) {
  if (!target) return;
  const bar = app.querySelector<HTMLElement>('.statusbar')!;
  const rect = target.getBoundingClientRect();
  const center = (rect.top + rect.bottom) / 2;
  // 화면 밖 제목 대신 항상 보이는 하루 진행으로 옮긴다. 화면 위치는 유지한다.
  const bandBottom = Math.min(window.innerHeight, app.querySelector<HTMLElement>('.flash-toast')?.getBoundingClientRect().top ?? Infinity);
  if (!target.closest('.statusbar') && (center < bar.getBoundingClientRect().bottom || center > bandBottom)) {
    const nextDay = app.querySelector<HTMLButtonElement>('[data-action="end-day"]')!;
    target = nextDay.disabled ? document.getElementById('status-h')! : nextDay;
  }
  target.focus({ preventScroll: true });
}

const app = document.querySelector<HTMLDivElement>('#app')!;
document.body.insertAdjacentHTML('beforeend', '<div id="live-status" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>');
const liveStatus = document.getElementById('live-status')!;

// Chromium은 Tab 누름(keydown) 뒤, focusin 전에 화면을 옮긴다. 그래서 위치는 Tab을 누른 순간에 적고
// 고정 영역으로 초점이 들어올 때 그 위치로 되돌린다(Claude 검수: focusin에서 적으면 이미 옮겨진 뒤다).
// Tab이 아닌 키(Enter 등)나 코드가 옮긴 초점에는 손대지 않는다.
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Tab') { lastTabAt = Date.now(); tabX = window.scrollX; tabY = window.scrollY; }
  else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(ev.key)) lastTabAt = -Infinity;
  if (ev.key === 'Escape' && !ev.repeat && !ev.isComposing && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) closeTopLayer(ev);
}, true);
document.addEventListener('focusin', (ev) => {
  if (activation || Date.now() - lastTabAt > 100) return;
  lastTabAt = -Infinity;
  if (!(ev.target as HTMLElement).closest(FIXED_REGION_SELECTOR)) return;
  if (window.scrollX !== tabX || window.scrollY !== tabY) window.scrollTo(tabX, tabY);
});
window.addEventListener('beforeunload', (ev) => {
  if (skipNextBeforeUnload) { skipNextBeforeUnload = false; return; }
  if (!hasUnsavedWork(ui.pending, state, savedState)) return;
  ev.preventDefault();
  ev.returnValue = '';
});

function startScenario(id: (typeof LOADABLE_SCENARIO_IDS)[number]) {
  config = loadScenario(id);
  state = openDay(createGame(config), config).state;
  resetUi();
  savedState = state;
}

function resetUi() {
  investmentOpen = undefined;
  investmentSignature = '';
  previousPaymentLevel = 'NONE';
  ui = initialUiState();
  resetMapScroll = true;
  mapScrollRatio = undefined;
  mapMeasurements.clear();
  actionSizes.clear();
  actionOffsets.clear();
  lastColumn = null;
  detailUnder = 'card';
  for (const key of LAYER_ORDER) layerTouched[key] = 0;
  mapPick = null;
  mapNear = [];
}

function newId(type: string): string {
  commandSeq += 1;
  return `UI-${state.day}-${type}-${Date.now().toString(36)}-${commandSeq}`;
}

const usd = (minor: number) => formatMoney(config.tradeCurrency, minor);
const krw = (minor: number) => formatMoney(config.payrollCurrency, minor);
const committedRule = () => config.rules.fundsCheck === 'COMMITTED_OUTLAYS';

const PARTY_KO: Record<string, string> = {
  SUPPLIER_DEMO: '의류 공급자',
  CUSTOMER_DEMO: '하이퐁 의류 고객',
  SUPPLIER_DEMO_COSMETICS: '화장품 공급자',
  CUSTOMER_DEMO_SHANGHAI: '상하이 화장품 고객',
  SHIPPER_DEMO_FURNITURE: '가구 화주',
  SHIPPER_DEMO_AUTOPARTS: '자동차 부품 화주',
};
const partyKo = (id: string | null) => (id ? (PARTY_KO[id] ?? counterpartyNameKo(config, id)) : '-');
const qtyKo = (goodId: string, quantity: number) => reportQtyKo(config, goodId, quantity);
const employeeName = (id: string | null) => config.employees.find((e) => e.id === id)?.nameKo ?? '미배정';

/** 대기열 뒤에 후보 명령을 붙였을 때의 검증 결과. 상태는 바꾸지 않는다. */
function tryCommand(cmd: Command): CommandResult {
  return planCommands(state, config, [...ui.pending, cmd]).at(-1)!;
}

/** 보정은 알림을 결정하기 전에 계산한다. 다시 그리기는 알림을 바꾸지 않는다. */
function exchangeAdjustment(planned: GameState, before: number): string {
  if (!config.operations) return '';
  const next = opsScreens!.exchangeSelection(planned, config, ui.exchangeDirection, before);
  if (next.lots >= before) return '';
  return `남은 ${ui.exchangeDirection === 'USD_TO_KRW' ? 'USD' : '원화'}에 맞춰 다음 환전 금액을 ${formatMoney('USD', next.usdMinor)}(${next.lots}묶음)으로 줄였습니다.`;
}
type QueueAnchor = { top: number; slot?: string; button?: boolean };

function queue(cmd: Command) {
  const previousContracts = new Set(view.contracts.map((c) => c.id));
  for (const slot of app.querySelectorAll<HTMLElement>('[data-action-slot]')) {
    const rect = slot.getBoundingClientRect();
    actionSizes.set(slot.dataset.actionSlot!, { height: rect.height, width: rect.width });
  }
  const slotEl = activation?.element.closest<HTMLElement>('[data-action-slot]');
  const anchor: QueueAnchor | null = slotEl ? { slot: slotEl.dataset.actionSlot!, top: slotEl.getBoundingClientRect().top }
    : activation?.element.getBoundingClientRect ? { button: true, top: activation.element.getBoundingClientRect().top } : null;
  if (anchor?.slot && activation) actionOffsets.set(anchor.slot, Math.max(0, activation.element.getBoundingClientRect().top - anchor.top));
  // 끝난 캠페인에는 하루 진행이 없어 넣은 명령이 실행되지 않는다. 엔진 검증 전에 거절한다.
  const result: CommandResult = state.phase === 'ENDED'
    ? { commandId: cmd.id, status: 'REJECTED', reasonKo: `${config.operations && state.operations?.outcome === 'FAILED' ? '경영 실패로 캠페인이 끝나 새 명령' : `${config.campaignDays}일 캠페인이 끝나 새 명령`}을 넣을 수 없습니다. 결산은 경영 보고에 있습니다.` }
    : tryCommand(cmd);
  if (result.status !== 'APPLIED') {
    ui.flash = { kind: 'warn', text: result.reasonKo };
  } else {
    const warning = cmd.type === 'EXCHANGE_CURRENCY' ? exchangePreview(view, config, cmd.direction, cmd.usdAmountMinor).warningKo : null;
    ui.pending.push(cmd);
    const adjustment = config.operations ? exchangeAdjustment(planState(state, config, ui.pending).state, ui.exchangeLots) : '';
    const exchangeText = cmd.type === 'EXCHANGE_CURRENCY' ? [warning, `환전 ${cmd.direction === 'USD_TO_KRW' ? 'USD→KRW' : 'KRW→USD'} ${formatMoney('USD', cmd.usdAmountMinor)}를 오늘 할 일에 넣었습니다. ‘하루 진행’을 누르면 실행됩니다. 그 전에는 시간이 흐르지 않습니다.`,
      adjustment].filter(Boolean).join(' ') : null;
    ui.flash = exchangeText ? { kind: warning ? 'warn' : 'info', text: exchangeText } : { kind: 'info', text: ['오늘 할 일에 넣었습니다. ‘하루 진행’을 누르면 실행됩니다. 그 전에는 시간이 흐르지 않습니다.', adjustment].filter(Boolean).join(' ') };
  }
  const accepted = result.status === 'APPLIED' && (cmd.type === 'ACCEPT_TRADE' || cmd.type === 'ACCEPT_FORWARDING');
  render(accepted, accepted ? null : anchor);
  if (accepted) {
    const contract = view.contracts.find((c) => !previousContracts.has(c.id));
    const heading = contract && document.getElementById(`contract-h-${contract.id}`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus({ preventScroll: true });
  }
  ignoreClicksUntil = Date.now() + 500;
}

function endDay() {
  if (state.phase !== 'AWAITING_INPUT') return;
  const committed = advanceDay(state, config, ui.pending);
  if ('errorKo' in committed) {
    ui.flash = { kind: 'warn', text: committed.errorKo! };
    render();
    ignoreClicksUntil = Date.now() + 500;
    return;
  }
  const rejected = committed.results.filter((r) => r.status === 'REJECTED');
  const barBottom = app.querySelector<HTMLElement>('.statusbar')?.getBoundingClientRect().bottom ?? 0;
  const bandBottom = Math.min(window.innerHeight, app.querySelector<HTMLElement>('.flash-toast')?.getBoundingClientRect().top ?? Infinity);
  // 계약은 3판 기준 그대로다: 막대 아래에 걸친 첫 카드의 제목은 막대 위에 있어도 기준이 된다.
  const card = Array.from(app.querySelectorAll<HTMLElement>('.contract')).find((e) => { const r = e.getBoundingClientRect(); return r.bottom > barBottom && r.top < window.innerHeight; });
  const heads: HTMLElement[] = [];
  const cardHead = card?.querySelector<HTMLElement>('h3[id]');
  if (cardHead) heads.push(cardHead);
  if (ui.cultureOpen) {
    const inBand = (r: DOMRect | undefined) => r !== undefined && r.bottom > barBottom && r.top < bandBottom;
    // 계약 카드가 없으면 견적판을 읽는 중이다. 위 패널 높이가 바뀌어도 거래 칸을 제자리에 둔다.
    const tradeHead = document.getElementById('trade-h');
    if (!cardHead && tradeHead && inBand(app.querySelector<HTMLElement>('.trade')?.getBoundingClientRect())) heads.push(tradeHead);
    // 결과 카드·직원 줄·기록장 보고서는 블록이 띠에 걸치면 기준이 된다. 네 칸을 읽는 중에 위에 새 결과가 생겨도 자리를 지킨다.
    let reportInBand = false;
    for (const [blockId, headId] of cultureAnchorBlocks(state, config, ui)) {
      const head = document.getElementById(headId);
      if (head && inBand(document.getElementById(blockId)?.getBoundingClientRect())) {
        heads.push(head);
        reportInBand ||= blockId.startsWith('culture-report-');
      }
    }
    // 펼친 기록장의 보고서가 띠에 걸치면 기록장 제목 대신 그 보고서가 기준이다. 새 보고서는 제목 바로 아래(목록 맨 위)에 끼어든다.
    for (const id of ['culture-h', ...(reportInBand ? [] : ['culture-book-h'])]) {
      const head = document.getElementById(id);
      const top = head?.getBoundingClientRect().top;
      if (head && top !== undefined && top >= barBottom && top < bandBottom) heads.push(head);
    }
  }
  const reading = heads.map((head) => ({ id: head.id, top: head.getBoundingClientRect().top })).sort((a, b) => a.top - b.top);
  // 배치안 A: 세 열에서 마지막 조작이 오른쪽 칸이면 그 칸의 후보를 기준으로 삼는다(M2만).
  // 막대 아래에서 시작하는 후보를 먼저 쓴다. 없으면 막대에 걸친 후보를 쓴다.
  const sideBoxes = config.culture && lastColumn === 'side' && !isOneColumn()
    ? Array.from(app.querySelectorAll<HTMLElement>(SIDE_ANCHORS)).map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.height > 0 && r.bottom > barBottom + 1 && r.top < bandBottom).sort((a, b) => a.r.top - b.r.top)
    : [];
  const sideReading = [...sideBoxes.filter(({ r }) => r.top >= barBottom - 1), ...sideBoxes.filter(({ r }) => r.top < barBottom - 1)]
    .map(({ el, r }) => ({ key: sideKey(el), top: r.top }));
  ui.growthNotices = growthMessages(state, committed.state, config);
  ui.growthNoticesDay = state.day;
  ui.growthNoticesFresh = true;
  ui.schedulePrev = scheduleKeys(view, config);
  state = committed.state;
  ui.pending = [];
  ui.cultureEmployeeId = null;
  ui.flash = cultureToastText(state, config, rejected) ?? (rejected.length
    ? { kind: 'warn', text: `실행하지 못한 명령: ${rejected.map((r) => r.reasonKo).join(' / ')}` }
    : null);
  ui.cultureResultFresh = ui.flash?.action === 'culture-result';
  if (state.phase === 'ENDED') {
    const text = (rejected.length ? `실행하지 못한 명령: ${rejected.map((r) => r.reasonKo).join(' / ')} ` : '')
      + (config.operations && state.operations?.outcome === 'FAILED'
        ? `${state.operations.failure!.day}일 경영 실패로 캠페인이 끝났습니다. 경영 보고에서 원인과 결산을 확인하세요.`
        : `${config.campaignDays}일 캠페인이 끝났습니다. 경영 보고의 ${config.campaignDays}일 결산에서 통화별 결과를 확인하세요.`);
    ui.flash = { kind: rejected.length ? 'warn' : 'info', text };
    ui.cultureResultFresh = false;
    render();
    const heading = document.getElementById(config.operations && state.operations?.outcome === 'FAILED' ? 'failure-h' : 'settlement-h')!;
    heading.scrollIntoView({ block: 'start' });
    heading.focus({ preventScroll: true });
    ignoreClicksUntil = Date.now() + 500;
    return;
  }
  render();
  if (sideReading.length) {
    const all = Array.from(app.querySelectorAll<HTMLElement>(SIDE_ANCHORS));
    const hit = sideReading.map((s) => ({ ...s, element: all.find((el) => sideKey(el) === s.key) })).find((s) => s.element);
    if (hit) { const dy = hit.element!.getBoundingClientRect().top - hit.top; if (Math.abs(dy) >= 1) window.scrollBy(0, dy); }
  } else {
    const remaining = reading.map((head) => ({ ...head, element: document.getElementById(head.id) })).find((head) => head.element);
    if (remaining) { const dy = remaining.element!.getBoundingClientRect().top - remaining.top; if (Math.abs(dy) >= 1) window.scrollBy(0, dy); }
  }
  ignoreClicksUntil = Date.now() + 500;
}

/** 펼친 칸의 실행 단추를 띠 안으로 최소 거리만 가져온다. 칸 제목은 막대 아래 8px 밑에 남긴다. 누른 뒤 생길 아래쪽 알림 자리 72px을 미리 비운다. */
function revealBelow(target: HTMLElement | null, head: HTMLElement | null) {
  if (!target) return;
  const top = app.querySelector<HTMLElement>('.statusbar')!.getBoundingClientRect().bottom;
  const bottom = Math.min(window.innerHeight - 72, app.querySelector<HTMLElement>('.flash-toast')?.getBoundingClientRect().top ?? Infinity);
  let dy = target.getBoundingClientRect().bottom + 8 - bottom;
  if (dy < 1) return;
  if (head) dy = Math.min(dy, head.getBoundingClientRect().top - top - 8);
  if (dy >= 1) window.scrollBy(0, dy);
}

/** 오른쪽 칸 후보의 열쇠. 다시 그린 뒤에도 같은 열쇠로 찾는다. id → 직원 → 칸·태그·글자 앞 24자. */
function sideKey(el: HTMLElement): string {
  if (el.id) return `#${el.id}`;
  const panel = el.closest(SIDE_PANELS)!.classList[1];
  return `${panel}|${el.tagName}|${el.dataset.emp ?? (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 24)}`;
}

// ── 화면 조각 ──

function stageOf(c: Contract): number {
  const lot = view.cargoLots.find((l) => l.id === c.cargoLotId);
  if (c.status === 'COMPLETED') return 8;
  if (c.deliveredDay !== null) return 7;
  switch (lot?.status) {
    case 'ARRIVED_RELEASING':
      return 6;
    case 'IN_TRANSIT':
      return 5;
    case 'AWAITING_DEPARTURE':
      return 4;
    default:
      return c.ownerEmployeeId ? 3 : 2;
  }
}

const STAGES = {
  DIRECT_TRADE: ['견적', '체결·매입', '준비 배정', '수출 준비', '출발 대기', '운송', '도착·통관', '인도·청구', '수금·종결'],
  FORWARDING: ['의뢰', '체결·화물 인수', '준비 배정', '주선 준비', '출발 대기', '운송', '도착·반출', '인도·청구', '수금·종결'],
};

function pipeline(c: Contract): string {
  if (c.status === 'CANCELLED') {
    return c.kind === 'FORWARDING'
      ? `<p class="pill warn">계약 취소됨 (${c.cancelledDay}일) — 고객 화물은 화주에게 돌려줌</p>`
      : `<p class="pill warn">계약 취소됨 (${c.cancelledDay}일) — 상품은 회사 재고로 ${esc(cityName(config, c.originCityId))}에 남음</p>`;
  }
  const current = stageOf(c);
  return `<ol class="pipeline">${STAGES[c.kind].map(
    (label, i) => `<li class="${i < current ? 'done' : i === current ? 'now' : ''}" ${i === current ? 'aria-current="step"' : ''}>${label}</li>`,
  ).join('')}</ol>`;
}

function topbar(): string {
  const r = companyReport(state, config);
  const f = fundsPosition(state, config, config.tradeCurrency);
  const nextReceipt = receiptSchedule(state)[0];
  const warnings = lastDepartureWarnings(view, config);
  const phaseText =
    state.phase === 'AWAITING_INPUT' ? '의사결정 중 · 시간 정지' : state.phase === 'ENDED' ? '캠페인 종료' : '다음 날 준비';
  return `
  <header class="topbar">
  <div class="masthead">
    <div class="brand"><span class="logo">Scitrade</span><span class="sub">시제품 · 모든 숫자는 가상값</span></div>
    <label class="scenario">시나리오
      <select data-action="scenario">
        ${SELECTABLE_SCENARIO_IDS.map((id) => `<option value="${id}" ${id === config.id ? 'selected' : ''}>${esc(SCENARIO_TITLES[id])}</option>`).join('')}
      </select>
    </label>
    <div class="actions">
      <button data-action="save">저장</button>
      <button data-action="load">불러오기</button>
      <button data-action="export">내보내기</button>
      <label class="file-btn">가져오기<input type="file" accept="application/json" data-action="import" class="visually-hidden" /></label>
      <button data-action="restart">처음부터</button>
      <details class="build-info"><summary>정보</summary><p>빌드 ${esc(BUILD_ID)}</p></details>
    </div>
  </div>
  <div class="statusbar${config.operations ? ' operations-statusbar' : ''}" id="status-h" tabindex="-1" role="region" aria-label="오늘 상태">
    <div class="day"><div class="date"><b>${Math.min(state.day, config.campaignDays)}일</b> / ${config.campaignDays}</div><span>${phaseText}</span></div>
    <div class="stat"><span>거래 현금 (USD)</span><b>${usd(r.trade.cash)}</b></div>
    ${committedRule() ? `<div class="stat"><span>사용 가능 (예약 제외)</span><b class="${f.available < 0 ? 'neg' : ''}">${usd(f.available)}</b></div>` : ''}
    <div class="stat"><span>운영 현금 (KRW)</span><b>${krw(r.payroll.cash)}</b></div>
    ${config.operations ? opsScreens!.operationsTopbar(view, config, state, ui.pending) : ''}<div class="stat"><span>다음 수금</span><b>${nextReceipt ? `${nextReceipt.dueDay}일 ${formatMoney(nextReceipt.currency, nextReceipt.outstandingMinor)}` : '없음'}</b></div>
    ${config.culture ? `<button class="queue-chip" id="queue-chip" data-action="queue-jump" aria-label="오늘 할 일 ${ui.pending.length}건 보기">오늘 할 일 <b>${ui.pending.length}</b>건</button>` : ''}<div class="day-action"><small class="amount-basis">${config.operations ? '다른 금액은 확정 기준' : '금액은 확정 기준'}</small><button class="primary" data-action="end-day" ${state.phase !== 'AWAITING_INPUT' ? 'disabled' : ''}>하루 진행 ▶</button>${warnings.length ? `<p class="reason">${esc(warnings.join(" "))}</p>` : ''}</div>
  </div>
  </header>`;
}

/** 보이는 지도 표시 전부를 목록 하나로 고른다. */
function mapPicker(marks: MapMark[], picked: MapMark | undefined): string {
  const groups = [...new Set(marks.map((m) => m.group))];
  return `<label class="map-pick">지도에서 볼 곳 <select data-action="map-pick" id="map-pick">
      <option value=""${picked ? '' : ' selected'}>고르세요</option>
      ${groups.map((g) => `<optgroup label="${esc(g)}">${marks.filter((m) => m.group === g).map((m) => `<option value="${esc(m.key)}"${picked?.key === m.key ? ' selected' : ''}>${esc(m.nameKo)}</option>`).join('')}</optgroup>`).join('')}
    </select></label>`;
}

/** 지도 아래 상세 칸. 가까운 후보가 여럿이면 단추로 고른다. */
function mapDetail(marks: MapMark[], picked: MapMark | undefined): string {
  const near = mapNear.map((key) => marks.find((m) => m.key === key)).filter((m): m is MapMark => Boolean(m));
  if (near.length > 1) {
    return `<div class="map-detail" id="map-detail">
      <h3 id="map-detail-h" tabindex="-1">이 근처에 여러 곳이 있습니다</h3>
      <div class="map-near">${near.map((m) => `<button data-action="map-near" data-mark="${esc(m.key)}">${esc(m.nameKo)} <small>${esc(m.group)}</small></button>`).join('')}</div>
      <button data-action="map-close">닫기</button>
    </div>`;
  }
  if (!picked) return '';
  return `<div class="map-detail" id="map-detail">
      <h3 id="map-detail-h" tabindex="-1">${esc(picked.nameKo)} <small>${esc(picked.group)}</small></h3>
      <ul>${picked.lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ul>
      <button data-action="map-close">닫기</button>
    </div>`;
}

function worldMap(): string {
  const marks = mapMarks(view, config, mapMode);
  const picked = marks.find((m) => m.key === mapPick);
  const moving = view.shipments.filter((x) => x.arrivalDay === null);
  const waiting = moving.filter((x) => portWaitStatus(view, config, x) === 'WAITING_RESTRICTION');
  const status = moving.length
    ? `운항 중 화물 ${moving.length}건${waiting.length ? ` · 대기 ${waiting.length}건 (하역 재개를 기다림)` : ''}`
    : '운항 중인 화물 없음';
  const routeText = config.routes
    .map((r) => `${r.id} ${cityName(config, r.fromCityId)}→${cityName(config, r.toCityId)} ${r.transitDays}일·${r.departureIntervalDays}일마다·운임 ${usd(r.bookingFeeMinor)}`)
    .join(' / ');
  return `
  <section class="panel world" aria-labelledby="world-h">
    <div class="world-head">
      <h2 id="world-h">세계지도 <small>${status}</small></h2>
      <button data-action="situation" aria-haspopup="dialog">상황실</button>
      <div class="seg" role="group" aria-label="지도 범위">
        <button data-action="map-mode" data-mode="route" aria-pressed="${mapMode === 'route'}">이번 항로</button>
        <button data-action="map-mode" data-mode="world" aria-pressed="${mapMode === 'world'}">전 세계</button>
      </div>
    </div>
    ${mapPicker(marks, picked)}
    <div data-map-frame ${mapPresentation(config, mapMode).attributes} class="map-frame ${mapPresentation(config, mapMode).world ? 'is-world' : ''}">${renderWorldMap(view, config, mapMode, { ...mapMeasurements.get(mapMode), baseOutsideSvg: MAP_BASE_OUTSIDE_SVG, picked: picked?.key })}</div>
    ${mapPresentation(config, mapMode).hint}
    ${mapDetail(marks, picked)}
    ${mapLegend()}
    <p class="muted small">${esc(routeText)}. 항로선은 표시용이며 실제 항로 자료가 아닙니다. 세계 거점은 물동량·금융센터·해운 도시 순위로 골랐고, 2장(세계 확장)에서 열립니다. 목록에서 고르거나 지도의 거점·해협·배를 누르면 지도 아래에 자세한 내용이 나옵니다. ${MAP_ATTRIBUTION}.</p>
  </section>`;
}

function reporter(role: string): EmployeeDef | undefined {
  return employedDefs(view, config).find((e) => e.role === role) ?? employedDefs(view, config)[0];
}

function quoteCheck(q: QuotePreview | OperationsQuotePreview, cmd: Command) {
  const check = tryCommand(cmd);
  if ('allowed' in q && !q.allowed) { check.status = 'REJECTED'; check.reasonKo = q.reasonKo!; }
  return check;
}

function quoteBlock(q: QuotePreview | OperationsQuotePreview, rows: string, cmd: Command, extra: string[], validUntil: number, key: string, originCityId: string): string {
  const check = quoteCheck(q, cmd);
  const reasonId = config.operations && check.status !== 'APPLIED' ? `quote-reason-${key}` : null;
  const sailing = q.departureDay !== null
    ? `다음 출항 ${q.departureDay}일 → ${q.arrivalDay}일 도착 예정 (납기 ${q.deliveryDeadlineDay}일)${q.lateOnNextSailing ? ' ⚠ 납기 초과 — 감액 반영' : ''}`
    : '남은 출항편 없음';
  // 견적의 대금일은 계약 조건이다. 인도가 늦으면 실제로 받는 날도 늦어진다.
  const receipt = q.departureDay !== null
    ? `<li>대금은 ${q.receiptDay}일에 받을 예정${q.receiptDay > q.paymentDueDay ? ` (인도가 계약상 대금일 ${q.paymentDueDay}일보다 늦기 때문)` : ''}</li>`
    : '';
  const needs = q.cashNeedByCurrency?.map((m) => formatMoney(m.currency, m.amountMinor)).join(' · ') ?? usd(q.cashNeed);
  const purchaseCurrency = cmd.type === 'ACCEPT_TRADE' ? offerDef(view, config, cmd.buyOfferId)!.currency : config.tradeCurrency;
  const estimate = purchaseCurrency === 'KRW' ? q.referenceEstimate : undefined;
  const first = Object.keys(offerCommands)[0] === key;
  const purchase = formatMoney(purchaseCurrency, q.purchase);
  const need = committedRule()
    ? `수락에 필요한 돈: ${needs} (매입·운임·관세를 미리 묶음).`
    : `수락하면 매입 대금 ${purchase}${josa(purchase, '을/를')} 지금 현금으로 냅니다.`;
  const actionAttr = cmd.type === 'ACCEPT_TRADE'
    ? `data-action="accept" data-buy="${esc(cmd.buyOfferId)}" data-sell="${esc(cmd.sellOfferId)}"`
    : cmd.type === 'ACCEPT_FORWARDING' ? `data-action="accept-fwd" data-offer="${esc(cmd.offerId)}"` : '';
  return `
    <table class="money">${rows}<tr class="total"><th>${estimate ? '예상 이익 (원화 매입 포함 · 급여 전)' : '예상 기여이익 (급여 전)'}</th>${estimate ? `<td${estimate.pnlKrw < 0 ? ' class="neg"' : ''}>${estimate.pnlKrw >= 0 ? '+' : '−'}${usd(Math.abs(opsScreens!.referenceUsd(estimate.pnlKrw, estimate.rateKrwPerUsd)))}</td>` : `<td>${usd(q.contributionBeforePayroll)}</td>`}</tr></table>
    ${estimate ? `<p class="reference-profit">기준 환율 ${estimate.rateKrwPerUsd.toLocaleString('ko-KR')}원/USD로 환산한 참고값입니다. USD로만 보면 ${q.contributionBeforePayroll >= 0 ? '+' : '−'}${usd(Math.abs(q.contributionBeforePayroll))}(원화 매입 ${purchase} 제외).</p>` : ''}
    ${first ? `<details class="term-help"><summary>거래 용어 풀이</summary><p>이 거래 하나로 남는 돈. 판매 − 매입 − 운임 − 관세. 동료 급여·임차료 같은 고정비는 아직 빼지 않았습니다.${estimate ? ' 원화로 사는 거래는 원화 매입 대금까지 뺀 값을 먼저 보여 줍니다.' : ''}</p><p>pt = 업무량 단위. 동료 한 명이 하루 2pt 처리</p><p>선복: 배에 실을 자리.</p><p>신고가액: 화주가 신고한 물건 값.</p></details>` : ''}
    <ul class="quote-facts"><li>${sailing}</li>${receipt}<li>${need}</li>${extra.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
    <details><summary>현금 일정 미리 보기 — 이익과 현금은 다른 날 움직입니다</summary>
      <ul class="schedule">${q.schedule.map((x) => `<li><span>${x.day}일</span>${esc(x.labelKo)}<b>${x.amount === 0 ? '현금 변화 없음' : (x.amount > 0 ? '+' : '−') + formatMoney(x.currency ?? config.tradeCurrency, Math.abs(x.amount))}</b></li>`).join('')}</ul>
      <p class="muted">지연·취소가 없다는 가정의 계산이며 결과를 보장하지 않습니다.</p>
    </details>
    <p class="muted small">견적 유효: ${validUntil}일까지 · 모든 수치는 가상값</p>
    <div class="accept-row">
      <button ${actionAttr}${reasonId ? ` aria-describedby="${esc(reasonId)}"` : ''} ${check.status !== 'APPLIED' ? 'disabled' : ''}>견적만 수락</button>${check.status !== 'APPLIED' ? `<p class="reason"${reasonId ? ` id="${esc(reasonId)}"` : ''}>${esc(check.reasonKo)}</p>` : ''}
    </div>
    ${check.status === 'APPLIED' ? planner(cmd, q, key, originCityId) : ''}`;
}

/** 직원이 지금(대기 명령 반영) 다른 업무 중인지. 카드·운영표·계획 선택이 같은 판단을 쓴다 (REF-01). */
const busyTask = (employeeId: string) => runningTaskOf(view, employeeId);

/** REF-02 한 번에 확정: 준비 담당과 운송편을 함께 골라 하나의 명령으로 넣는다. 하나라도 안 되면 수락까지 철회된다. */
function planner(cmd: Command, q: QuotePreview, key: string, originCityId: string): string {
  if (!batchUnlocked(view)) return '<p class="muted small">첫 계약을 단계별로 마치면 한 번에 확정을 쓸 수 있습니다</p>';
  if (cmd.type !== 'ACCEPT_TRADE' && cmd.type !== 'ACCEPT_FORWARDING') return '';
  const sailings = listSailings(config, q.routeId, view.day + 1).slice(0, 3);
  const local = employedDefs(view, config).filter((e) => view.employees.find((x) => x.id === e.id)?.locationCityId === originCityId);
  const defaults: CommitPlan = {
    employeeId: local.find((e) => !busyTask(e.id))?.id,
    sailingId: (sailings.find((s) => s.scheduledArrivalDay + config.terms.customsDays <= q.deliveryDeadlineDay) ?? sailings[0])?.id,
  };
  const plan = ui.touchedPlans.has(key) ? (ui.plans[key] ?? defaults) : defaults;
  ui.plans[key] = plan;
  const planned: Command = { ...cmd, id: newId('PLAN'), plan };
  const check = tryCommand(planned);
  const empOptions = local
    .map((e) => {
      const t = busyTask(e.id);
      return `<option value="${esc(e.id)}" ${plan.employeeId === e.id ? 'selected' : ''} ${t ? 'disabled' : ''}>${esc(e.nameKo)} · 하루 ${e.workUnitsPerDay}pt${t ? ` (${esc(crewStatusKo(t))} · ${esc(taskSchedule(t, config))})` : ''}</option>`;
    })
    .join('');
  const sailOptions = sailings
    .map((s) => {
      const late = s.scheduledArrivalDay + config.terms.customsDays > q.deliveryDeadlineDay;
      return `<option value="${esc(s.id)}" ${plan.sailingId === s.id ? 'selected' : ''}>${s.departureDay}일 출항 → ${s.scheduledArrivalDay}일 도착${late ? ' (납기 초과)' : ''}</option>`;
    })
    .join('');
  return `
    <div class="planner" role="group" aria-label="한 번에 확정">
      <label>준비 담당 <select data-action="plan-emp" data-key="${esc(key)}"><option value="">나중에 배정</option>${empOptions}</select></label>
      <label>운송편 <select data-action="plan-sailing" data-key="${esc(key)}"><option value="">나중에 예약</option>${sailOptions}</select></label>
      <button class="primary" data-action="accept-plan" data-key="${esc(key)}" ${check.status !== 'APPLIED' ? 'disabled' : ''}>수락·배정·예약 한 번에</button>
      <p class="muted small">셋 중 하나라도 실행할 수 없으면 수락까지 모두 취소하고 아무것도 바꾸지 않습니다.</p>
      ${check.status !== 'APPLIED' ? `<p class="reason">${esc(check.reasonKo)}</p>` : ''}
    </div>`;
}

/** 화면의 견적 카드가 만든 기본 수락 명령 (키로 다시 찾는다). */
const offerCommands: Record<string, Command> = {};

/** 실패로 만료 처리가 멈춘 기록도 표시 시점의 유효기간으로 거른다. */
export function visibleForwardingOffers(view: GameState, config: ScenarioConfig) {
  const offers = config.operations ? view.offers.filter((o) => o.status === 'OPEN').map((o) => offerDef(view, config, o.id)!) : config.offers;
  return offers.filter((o) => o.kind === 'forwarding' && view.offers.some((s) => s.id === o.id && s.status === 'OPEN')
    && o.publishDay <= view.day && o.validUntilDay >= view.day);
}

function offerBoard(): string {
  if (config.operations && state.phase === 'ENDED') return `${opsScreens!.marketBlock(state, config)}<p>캠페인이 끝나 견적을 받을 수 없습니다</p>`;
  const isOpen = (id: string) => view.offers.find((o) => o.id === id)?.status === 'OPEN';
  const cards: string[] = [];
  for (const key of Object.keys(offerCommands)) delete offerCommands[key];
  for (const pair of (config.operations ? openTradePairs(view, config) : tradePairs(config))) {
    if (!isOpen(pair.buyOfferId) || !isOpen(pair.sellOfferId)) continue;
    const buy = offerDef(view, config, pair.buyOfferId)!;
    const sell = offerDef(view, config, pair.sellOfferId)!;
    const key = `${buy.id}+${sell.id}`;
    const quantity = config.operations ? ui.offerQuantities[key] ?? buy.quantity : buy.quantity;
    const q = config.operations ? quotePreview(view, config, pair, quantity) : tradePreview(config, buy.id, sell.id, view.day)!;
    const by = reporter('sales');
    const g = goodOf(config, buy.goodId);
    const deadline = config.terms.deliveryDeadlineDay ?? sell.deliveryDeadlineDay;
    const due = config.terms.paymentDueDay ?? sell.paymentDueDay;
    const rows = `
      <tr><th>매입 (${quantity}${esc(unitKo(g))} × ${formatMoney(buy.currency, buy.unitPriceMinor)})</th><td>−${formatMoney(buy.currency, q.purchase)}</td></tr>
      <tr><th>운임 (선지급)</th><td>−${usd(q.freight)}</td></tr>
      <tr><th>관세 (회사 부담 · 가상 ${config.terms.dutyRateBasisPoints / 100}%)</th><td>−${usd(q.duty)}</td></tr>
      <tr><th>판매 (${quantity}${esc(unitKo(g))} × ${formatMoney(sell.currency, sell.unitPriceMinor)})${q.lateOnNextSailing ? ' − 지연 감액' : ''}</th><td>+${formatMoney(sell.currency, q.sale)}</td></tr>`;
    const cmd: Command = { id: newId('ACCEPT'), type: 'ACCEPT_TRADE', buyOfferId: buy.id, sellOfferId: sell.id, ...(config.operations ? { quantity, ...opsScreens!.path11Term(config, ui, key) } : {}) };
    offerCommands[`${buy.id}+${sell.id}`] = cmd;
    const space = cargoSpace(config, buy.goodId, quantity);
    cards.push(`
    <article class="offer">
      <h3><span class="kind kind-trade">직접 무역</span> ${esc(qtyKo(buy.goodId, quantity))} · ${esc(cityName(config, buy.cityId))} → ${esc(cityName(config, sell.cityId))}</h3>
      <p class="report-line">📋 <b>${esc(by?.nameKo ?? '직원')}의 보고</b> — “${esc(cityName(config, buy.cityId))} 공급자가 ${esc(g.nameKo)} ${quantity}${esc(unitKo(g))}${josa(unitKo(g), '을/를')} 내놨고, ${esc(cityName(config, sell.cityId))} 고객이 같은 수량을 원합니다. 납기 ${deadline}일, 계약상 대금일은 ${due}일입니다.”</p>
      <details class="duty-note"><summary>DDP 유사 단순화 · 왜 회사가 내나요?</summary><p>이 게임은 회사가 수입 통관까지 맡는 조건(DDP와 비슷)으로 단순화했습니다. 실제로는 보통 수입자가 내고, 과세가격은 수입국 규칙(한국은 운임·보험료 포함 CIF)으로 정합니다. 이 게임은 매입가의 ${config.terms.dutyRateBasisPoints / 100}%로 계산합니다.</p></details>
      ${config.operations ? opsScreens!.quantityControl(key, q as OperationsQuotePreview, config, buy.goodId, buy.quantity, quoteCheck(q, cmd).status !== 'APPLIED' ? `quote-reason-${key}` : undefined) : ''}${config.operations ? opsScreens!.path11Credit(view, config, ui, key, quantity) : ''}${quoteBlock(q, rows, cmd, [`차지할 선복 ${fmtKg(space.massGrams)} · ${fmtM3(space.volumeLiters)}`, ...(config.operations ? opsScreens!.operationsQuoteFacts(q as OperationsQuotePreview, view, config) : [])], Math.min(buy.validUntilDay, sell.validUntilDay), `${buy.id}+${sell.id}`, buy.cityId)}
    </article>`);
  }
  for (const offer of visibleForwardingOffers(view, config)) {
    if (!offer.destinationCityId) continue;
    const q = config.operations ? quotePreview(view, config, { offerId: offer.id }) : forwardingPreview(config, offer.id, view.day)!;
    const by = reporter('operations');
    const space = cargoSpace(config, offer.goodId, offer.quantity);
    const route = routeBetween(config, offer.cityId, offer.destinationCityId);
    const rows = `
      <tr><th>서비스 대금 (건당)${q.lateOnNextSailing ? ' − 지연 감액' : ''}</th><td>+${usd(q.sale)}</td></tr>
      <tr><th>운임 (외부 운송사에 선지급)</th><td>−${usd(q.freight)}</td></tr>
      <tr><th>관세</th><td>수입자 부담 (회사 0)</td></tr>`;
    const cmd: Command = { id: newId('FWD'), type: 'ACCEPT_FORWARDING', offerId: offer.id };
    offerCommands[offer.id] = cmd;
    cards.push(`
    <article class="offer forwarding">
      <h3><span class="kind kind-fwd">운송 주선</span> ${config.operations && offer.titleKo ? esc(offer.titleKo) + ' · ' : ''}고객 화물 ${esc(qtyKo(offer.goodId, offer.quantity))} · ${esc(cityName(config, offer.cityId))} → ${esc(cityName(config, offer.destinationCityId))}</h3>
      <p class="report-line">📋 <b>${esc(by?.nameKo ?? '직원')}의 보고</b> — “${esc(partyKo(offer.counterpartyId))}가 ${esc(qtyKo(offer.goodId, offer.quantity))}${josa(qtyKo(offer.goodId, offer.quantity), '을/를')} ${esc(cityName(config, offer.destinationCityId))}까지 보내 달라고 합니다. 화물은 고객 것이고, 우리는 운송을 주선해 서비스 대금을 받습니다. 납기 ${offer.deliveryDeadlineDay}일, 계약상 대금일은 ${offer.paymentDueDay}일입니다.”</p>
      ${quoteBlock(q, rows, cmd, [
        `차지할 선복 ${fmtKg(space.massGrams)} · ${fmtM3(space.volumeLiters)}${route ? ` (편당 한도 ${route.capacityKg.toLocaleString('ko-KR')}kg · ${route.capacityM3}m³)` : ''}`,
        offer.declaredCargoValueMinor ? `고객 화물(신고가액 ${formatMoney(offer.currency, offer.declaredCargoValueMinor)})은 고객 것입니다. 회사 재고·매출에 넣지 않습니다.` : '',
        ...(config.operations ? opsScreens!.operationsQuoteFacts(q as OperationsQuotePreview, view, config) : []),
      ].filter(Boolean), offer.validUntilDay, offer.id, offer.cityId)}
    </article>`);
  }
  if (!cards.length) return config.operations ? opsScreens!.marketBlock(view, config) + opsScreens!.exchangeBlock(view, config, ui.exchangeDirection, ui.exchangeLots, selectedExchange) : '';
  return `${config.operations ? opsScreens!.marketBlock(view, config) + opsScreens!.exchangeBlock(view, config, ui.exchangeDirection, ui.exchangeLots, selectedExchange) : ''}<div class="offer-board"><h3 class="board-title">견적판 <small>${cards.length}건 · 무엇을 맡을지 고르세요</small></h3>${cards.join('')}</div>`;
}

function contractPanel(c: Contract): string {
  const lot = view.cargoLots.find((l) => l.id === c.cargoLotId);
  const task = view.tasks.find((t) => t.id === c.prepTaskId);
  const booking = c.bookingId ? view.bookings.find((b) => b.id === c.bookingId) : undefined;
  const shipment = view.shipments.find((s) => s.contractId === c.id);
  const entries = view.ledger.entries.filter((e) => e.contractId === c.id);
  const actions: string[] = [];
  const active = c.status === 'ACTIVE' || c.status === 'IN_PROGRESS';
  const route = routeBetween(config, c.originCityId, c.destinationCityId);
  const forwarding = c.kind === 'FORWARDING';

  const queuedAssignment = task && ui.pending.some((p) => p.type === 'ASSIGN_TASK' && p.taskId === task.id);
  if (active && task && (task.status === 'QUEUED' || queuedAssignment)) {
    const queued = queuedAssignment;
    if (queued) {
      actions.push(queuedStatus(`assign-${task.id}`, '준비 업무 배정 예정'));
    } else {
      const buttons = employedDefs(view, config).map((emp) => {
        const check = tryCommand({ id: newId('ASSIGN'), type: 'ASSIGN_TASK', taskId: task.id, employeeId: emp.id });
        return `<button data-action="assign" data-task="${esc(task.id)}" data-emp="${esc(emp.id)}" ${check.status !== 'APPLIED' ? `disabled title="${esc(check.reasonKo)}"` : ''}>${esc(emp.nameKo)}에게<small>${check.status === 'APPLIED' ? `하루 ${emp.workUnitsPerDay}pt` : esc(busyTask(emp.id) ? `${crewStatusKo(busyTask(emp.id))} — ${taskSchedule(busyTask(emp.id)!, config)}` : check.reasonKo)}</small></button>`;
      });
      actions.push(`<div class="sailings" data-action-slot="assign-${esc(task.id)}"><span>${forwarding ? '운송 주선 준비(화물 인수·선적 서류)' : '수출 준비'} ${task.requiredWorkUnits}pt 맡기기</span><div class="row">${buttons.join('')}</div></div>`);
    }
  }
  const queuedBooking = ui.pending.some((p) => p.type === 'BOOK_SAILING' && p.contractId === c.id);
  if (active && route && (((!booking || booking.status === 'CANCELLED') && !shipment) || queuedBooking)) {
    const queued = queuedBooking;
    if (queued) {
      actions.push(queuedStatus(`book-${c.id}`, '운송편 예약 예정'));
    } else {
      const options = listSailings(config, route.id, view.day + 1).slice(0, 3).map((s) => {
        const load = sailingLoad(view, config, s);
        const need = cargoSpace(config, c.goodId, c.quantity);
        const cmd: Command = { id: newId('BOOK'), type: 'BOOK_SAILING', contractId: c.id, sailingId: s.id };
        const check = tryCommand(cmd);
        const late = s.scheduledArrivalDay + config.terms.customsDays > c.deliveryDeadlineDay;
        return `<button data-action="book" data-sailing="${esc(s.id)}" data-contract="${esc(c.id)}" ${check.status !== 'APPLIED' ? `disabled title="${esc(check.reasonKo)}"` : ''}>
          ${s.departureDay}일 출항 → ${s.scheduledArrivalDay}일 도착 예정${late ? ' ⚠ 납기 초과' : ''}<small>남은 ${fmtM3(load.capacityLiters - load.volumeLiters)} · ${fmtKg(load.capacityGrams - load.massGrams)} / 이 화물 ${fmtM3(need.volumeLiters)} · ${fmtKg(need.massGrams)}${check.status !== 'APPLIED' ? ` — ${esc(check.reasonKo)}` : ''}</small></button>${check.status !== 'APPLIED' ? `<p class="reason">${esc(check.reasonKo)}</p>` : ''}`;
      });
      actions.push(`<div class="sailings" data-action-slot="book-${esc(c.id)}"><span>운송편 예약 (${esc(route.id)}, 운임 ${usd(route.bookingFeeMinor)} 선지급)</span>${options.join('')}</div>`);
    }
  }
  if (active && booking?.status !== 'DEPARTED' && !shipment) {
    const queued = ui.pending.some((p) => p.type === 'CANCEL_CONTRACT' && p.contractId === c.id);
    if (!queued) {
      const t = config.terms;
      actions.push(`<button class="danger" data-action="cancel" data-contract="${esc(c.id)}">출항 전 취소</button>
        <p class="muted small">취소하면: ${esc(cancellationPreviewKo(view, config, c.id))}고객 보상 ${usd(t.customerCancellationCompensationMinor)}, ${forwarding ? '고객 화물은 화주에게 돌려줍니다.' : '공급자 반품 없음 → 산 상품은 재고로 남습니다.'}</p>`);
    } else actions.push('<span class="pill warn">출항 전 취소 예정</span>');
  }

  const cargo = !lot
    ? '-'
    : lot.owner === 'CUSTOMER'
      ? `${qtyKo(lot.goodId, lot.quantity)} · ${cityName(config, lot.locationCityId)} · 고객 화물(${partyKo(lot.ownerPartyId)}) — 회사 장부가액 없음`
      : `${qtyKo(lot.goodId, lot.quantity)} · ${cityName(config, lot.locationCityId)} · 장부가액 ${formatMoney(lot.currency, lot.status === 'DELIVERED' ? 0 : lot.carryingAmountMinor)}`;
  const facts = [
    ['종류', forwarding ? `운송 주선 — ${partyKo(c.customerId)}의 화물` : `직접 무역 — ${partyKo(c.supplierId)} → ${partyKo(c.customerId)}`],
    ['담당', c.ownerEmployeeId ? employeeName(c.ownerEmployeeId) : '미배정'],
    ['화물', cargo],
    ['운송', shipment ? `${shipment.id} · ${shipment.departureDay}일 출항 · 도착 ${shipment.arrivalDay !== null ? `${shipment.arrivalDay}일` : `${shipment.scheduledArrivalDay}일 예정`}${shipment.observedWaitDays ? ` (항만 대기 ${shipment.observedWaitDays}일)` : ''}` : booking?.status === 'BOOKED' ? `${booking.sailingId} 예약됨` : '미예약'],
    ['납기', `${c.deliveryDeadlineDay}일 ${c.deliveredDay !== null ? (c.lateDays > 0 ? `→ ${c.deliveredDay}일 인도 (${c.lateDays}일 지연, 감액 ${usd(c.priceReductionMinor)})` : `→ ${c.deliveredDay}일 인도 (납기 내)`) : ''}`],
    [forwarding ? '서비스 대금' : '판매대금', c.status === 'CANCELLED' ? '청구 없음 (계약 취소)' : c.invoiceId ? (() => { const inv = view.invoices.find((i) => i.id === c.invoiceId)!; return `${formatMoney(inv.currency, inv.amountMinor)} · ${inv.dueDay}일 결제 · ${inv.status === 'PAID' ? '수금 완료' : inv.status === 'WRITTEN_OFF' ? '대손' : '미수'}`; })() : `${usd(c.saleAmountMinor)} (인도 후 청구)`],
  ];
  return `
  <div class="contract ${forwarding ? 'forwarding' : ''}">
    <h3 id="contract-h-${esc(c.id)}" tabindex="-1"><span class="kind ${forwarding ? 'kind-fwd' : 'kind-trade'}">${forwarding ? '운송 주선' : '직접 무역'}</span> ${esc(c.id)} · ${esc(qtyKo(c.goodId, c.quantity))} ${esc(cityName(config, c.originCityId))} → ${esc(cityName(config, c.destinationCityId))}${state.contracts.some((x) => x.id === c.id) ? '' : ' <span class="pill">오늘 실행 예정</span>'}</h3>
    ${pipeline(c)}
    ${progressBox(c)}
    <dl class="facts">${facts.map(([k, v]) => `<dt>${esc(k ?? '')}</dt><dd>${esc(v ?? '')}</dd>`).join('')}</dl>
    <div class="actions-row">${actions.join('')}</div>
    <details><summary>이 계약의 돈 흐름 (${entries.length}건)</summary>
      <ul class="entries">${entries.map((e) => `<li><span>${e.day}일</span>${esc(e.reason)}<b>${e.lines.map((l) => `${esc(accountKo(l.account))} ${l.amount > 0 ? '+' : '−'}${formatMoney(e.currency, Math.abs(l.amount))}`).join(' · ')}</b></li>`).join('')}</ul>
    </details>
  </div>`;
}

const SEVERITY_KO = { info: '참고', warn: '조치 필요', risk: '위험' } as const;

/** REF-10: 다음 단계와 막힌 이유. 직원 처리량·운항표·사건과 같은 근거로 계산한다. */
function progressBox(c: Contract): string {
  const p = contractProgress(view, config, c);
  return `
    <div class="progress-box">
      <p><b>다음</b> ${esc(p.nextKo)}</p>
      ${p.blockers.length ? `<ul class="blockers">${p.blockers.map((b) => `<li class="sev-${b.severity}"><span class="sev-label">${SEVERITY_KO[b.severity]}</span>${esc(b.messageKo)}</li>`).join('')}</ul>` : '<p class="muted small">막힌 곳 없음</p>'}
    </div>`;
}

function closedContracts(): string {
  const closed = view.contracts.filter((c) => c.status === 'COMPLETED' || c.status === 'CANCELLED');
  if (!closed.length) return '';
  return `
  <details class="closed"><summary>종결된 계약 ${closed.length}건</summary>
    <ul class="entries">${closed.map((c) => {
      const r = contractReport(view, c);
      return `<li><span>${esc(c.id)}</span>${c.kind === 'FORWARDING' ? '운송 주선' : '직접 무역'} · ${esc(qtyKo(c.goodId, c.quantity))} ${esc(cityName(config, c.originCityId))} → ${esc(cityName(config, c.destinationCityId))} · ${c.status === 'CANCELLED' ? '취소' : view.invoices.some((i) => i.contractId === c.id && i.status === 'WRITTEN_OFF') ? '대손' : `${c.completedDay}일 수금`}<b>기여이익 ${r.contribution < 0 ? '−' : ''}${usd(Math.abs(r.contribution))}</b></li>`;
    }).join('')}</ul>
  </details>`;
}

function accountKo(a: string): string {
  return ({
    CASH: '현금', INVENTORY: '재고', PREPAID_FREIGHT: '선급운임', FORWARDING_WIP: '주선 진행원가', ACCOUNTS_RECEIVABLE: '매출채권', ACCOUNTS_PAYABLE: '미지급금',
    REVENUE: '매출', COST_OF_GOODS_SOLD: '매출원가', FORWARDING_REVENUE: '주선 매출', FORWARDING_COST: '주선 원가',
    CANCELLATION_EXPENSE: '취소비', WAGE_EXPENSE: '급여', OPENING_EQUITY: '자본',
  } as Record<string, string>)[a] ?? a;
}

function delayPanel(): string {
  const open = state.delayDecisions.filter((d) => d.choice === null);
  const notices = state.notices;
  if (!notices.length) return '';
  return notices.map((n) => {
    const decision = open.find((d) => d.noticeId === n.id);
    const queued = decision && ui.pending.some((p) => p.type === 'RESPOND_TO_DELAY' && p.noticeId === n.id);
    return `
    <div class="notice">
      <h3>⚠ ${esc(n.titleKo)} <small>${n.day}일 공지</small></h3>
      <p>${esc(n.bodyKo)}</p>
      <p class="muted small">근거: ${esc(n.evidenceKo)}</p>
      ${decision ? (queued ? '<span class="pill">현재 예약으로 대기 — 결정 예정</span>' : `
      <div class="choices">
        <button data-action="keep" data-notice="${esc(n.id)}" data-shipment="${esc(decision.shipmentId)}">현재 예약으로 대기<small>예약은 유지, 하역 재개까지 일정이 밀림. 납기를 넘기면 계약 조건대로 ${usd(config.terms.lateDeliveryPriceReductionMinor)} 감액</small></button>
        <button disabled>대체편 예약<small>대체 노선 선택은 이번 판에 없습니다</small></button>
        <button disabled>고객과 납기 협상<small>계약 변경 협상은 이번 판에 없습니다</small></button>
      </div>`) : '<p class="pill">대응 결정 완료: 현재 예약으로 대기</p>'}
    </div>`;
  }).join('');
}

function tradePanel(): string {
  const active = view.contracts.filter((c) => c.status === 'ACTIVE' || c.status === 'IN_PROGRESS');
  const anyExpired = view.offers.some((o) => o.status === 'EXPIRED');
  const publish = config.operations?.market.publish;
  let nextPublish: number | null = null;
  if (publish) for (let day = publish.firstDay; day <= publish.lastDay; day += publish.intervalDays) {
    if (day > view.day) { nextPublish = day; break; }
  }
  return `
  <section class="panel trade" aria-labelledby="trade-h">
    <h2 id="trade-h" tabindex="-1">거래·계약 <small>진행 중 ${active.length}건</small></h2>${config.culture ? `
    ${cultureTab(state, config, ui)}` : ''}
    ${delayPanel()}
    ${offerBoard()}
    ${active.map(contractPanel).join('')}
    ${closedContracts()}
    ${!view.contracts.length && anyExpired ? `<p class="muted">${nextPublish === null ? '견적이 만료되었습니다. ‘처음부터’로 다시 시작할 수 있습니다.' : `다음 견적 묶음은 ${nextPublish}일에 나옵니다`}</p>` : ''}
  </section>`;
}

function resourcePanel(): string {
  const f = fundsPosition(view, config, config.tradeCurrency);
  const reservations = cashReservations(view, config);
  const bar = (used: number, cap: number) => {
    const pct = cap ? Math.min(100, Math.round((used / cap) * 100)) : 0;
    return `<span class="bar ${pct >= 100 ? 'full' : pct >= 80 ? 'high' : ''}" role="img" aria-label="${pct}% 사용"><span style="width:${pct}%"></span></span>`;
  };
  const crew = employedDefs(view, config).map((e) => {
    const t = runningTaskOf(view, e.id);
    return `<li><b>${esc(e.nameKo)}</b> ${t ? `${esc(crewStatusKo(t))} — ${esc(taskSchedule(t, config))}` : '<span class="ok">대기 — 배정 가능</span>'}<small>${esc(cityName(config, view.employees.find((x) => x.id === e.id)?.locationCityId ?? null))} · 하루 ${e.workUnitsPerDay}pt</small></li>`;
  });
  const sailings = config.routes.flatMap((r) => listSailings(config, r.id, view.day).slice(0, 2)).sort((a, b) => a.departureDay - b.departureDay || a.id.localeCompare(b.id));
  const space = sailings.map((s) => {
    const load = sailingLoad(view, config, s);
    const on = view.bookings.filter((b) => b.sailingId === s.id && b.status !== 'CANCELLED').map((b) => b.contractId);
    return `<li><b>${esc(s.id)}</b> ${s.departureDay}일 출항 ${esc(cityName(config, config.routes.find((r) => r.id === s.routeId)?.fromCityId ?? null))}→${esc(cityName(config, config.routes.find((r) => r.id === s.routeId)?.toCityId ?? null))}
      <div class="meter">부피 ${bar(load.volumeLiters, load.capacityLiters)} ${fmtM3(load.volumeLiters)} / ${fmtM3(load.capacityLiters)}</div>
      <div class="meter">무게 ${bar(load.massGrams, load.capacityGrams)} ${fmtKg(load.massGrams)} / ${fmtKg(load.capacityGrams)}</div>
      <small>${on.length ? `실을 계약: ${esc(on.join(', '))}` : '예약 없음'}</small></li>`;
  });
  return `
  <section class="panel resources" aria-labelledby="res-h">
    <h2 id="res-h">자원 예약 <small>오늘 할 일까지 반영 · 같은 돈·사람·공간을 두 번 쓰지 않습니다</small></h2>
    <h3>자금 (USD)</h3>
    <table class="money">
      <tr><th>현금 (오늘 할 일 실행 뒤)</th><td>${usd(f.cash)}</td></tr>
      <tr><th>체결 계약의 남은 지출 예약</th><td>−${usd(config.operations ? f.reserved - f.reservedCommitments : f.reserved)}</td></tr>${config.operations ? `<tr><th>선복 계약 요금 예약</th><td>−${usd(f.reservedCommitments)}</td></tr>` : ''}
      ${f.unpaidObligations ? `<tr><th>미지급</th><td>−${usd(f.unpaidObligations)}</td></tr>` : ''}
      <tr class="total"><th>사용 가능 (오늘 할 일 실행 뒤)</th><td class="${f.available < 0 ? 'neg' : ''}">${usd(f.available)}</td></tr>
    </table>
    ${reservations.length ? `<ul class="reserve-list">${reservations.map((r) => `<li>${esc(r.contractId)} ${r.kind === 'FREIGHT' ? '운임 (예약 전)' : '관세 (도착 때)'} <b>${usd(r.amountMinor)}</b></li>`).join('')}</ul>` : config.operations && f.reservedCommitments ? '<p class="muted small">선복 계약 요금은 위 표에 별도로 예약했습니다.</p>' : '<p class="muted small">묶인 돈이 없습니다.</p>'}
    <p class="muted small">${committedRule() ? '새 계약·운임은 사용 가능 자금으로만 판단합니다.' : '새 계약은 지금 현금만 확인합니다. 예약은 참고 표시입니다.'}</p>
    <h3>직원 시간</h3>
    <ul class="crew-time">${crew.join('')}</ul>
    <h3>선복 · 다가오는 출항편</h3>
    <ul class="space-list">${space.join('') || '<li class="muted">남은 출항편이 없습니다.</li>'}</ul>
  </section>`;
}

/** 계약 제목이 실제로 있는 오늘 실행 예정 사본에만 이동 단추를 붙인다. */
function contractLink(id: string): string {
  const contract = view.contracts.find((c) => c.id === id && (c.status === 'ACTIVE' || c.status === 'IN_PROGRESS'));
  return contract ? `<button class="link" data-action="goto-contract" data-contract="${esc(id)}" aria-label="${esc(id)} 계약으로 가기">${esc(id)}</button>` : esc(id);
}

function deliveryRateBlock(): string {
  const r = onTimeDeliveryRate(state);
  // 끝난 캠페인에는 더 인도할 날이 없다. 앞으로 할 일처럼 안내하지 않는다.
  const ended = state.phase === 'ENDED';
  const links = (late: boolean) => state.contracts.filter((c) => c.status !== 'CANCELLED' && (late
    ? c.deliveredDay !== null && c.deliveredDay > c.deliveryDeadlineDay
    : c.deliveredDay === null && c.deliveryDeadlineDay < state.day)).map((c) => contractLink(c.id)).join(', ');
  const none = ended ? '정시 인도율: 인도한 계약이 없습니다.' : '정시 인도율: 아직 인도한 계약이 없습니다.';
  const past = ended ? `납기 안에 인도하지 못하고 캠페인이 끝난 계약: ${links(false)} (인도하지 않아 정시 인도율에 넣지 않았습니다)`
    : `납기가 지났는데 아직 인도하지 못한 계약: ${links(false)} (인도하면 정시 인도율에 들어갑니다)`;
  return `<p>${r.delivered === 0 ? none : `정시 인도율 ${rateKo(r.rateBasisPoints!)} — 인도 ${r.delivered}건 중 납기 안 ${r.onTime}건`}</p>${r.late ? `<p>납기를 넘겨 인도한 계약: ${links(true)}</p>` : ''}${r.pastDeadlineUndelivered ? `<p>${past}</p>` : ''}`;
}

function upcomingBlock(): string {
  const from = state.day, to = Math.min(config.campaignDays, state.day + 6);
  const rows = upcomingPayments(state, config, to);
  const ended = state.phase === 'ENDED';
  if (ended && !rows.length) return '<p>캠페인이 끝나 앞으로 낼 돈은 없습니다.</p>';
  const summary = upcomingSummary(rows, config);
  const list: string[] = [];
  for (const currency of summary.currencies) {
    const overdue = rows.filter((p) => p.kind === 'OVERDUE' && p.currency === currency);
    if (!overdue.length) continue;
    list.push(`<li><span>${Math.min(...overdue.map((p) => p.day!))}일부터</span>밀린 지급 ${overdue.length}건 (현금이 들어오면 먼저 갚음) <b>${esc(formatMoney(currency, -overdue.reduce((sum, p) => sum + p.amountMinor, 0)))}</b></li>`);
  }
  for (const p of rows) {
    if (p.kind !== 'FREIGHT' && p.kind !== 'DUTY') {
      if (config.operations && (p.kind === 'RENT' || p.kind === 'SPACE_FEE')) list.push(`<li><span>${p.day}일</span>${esc(p.labelKo)} <b>${esc(formatMoney(p.currency, -p.amountMinor))}</b></li>`);
      continue;
    }
    const date = p.day === null ? '날짜 미정' : `${p.day}${p.kind === 'FREIGHT' ? '일까지' : '일'}`;
    list.push(`<li><span>${date}</span>${contractLink(p.contractId!)} ${p.kind === 'FREIGHT' ? '운송편 예약 때 운임 선지급' : '도착 때 수입 관세 (회사 부담 · DDP 유사 단순화)'} <b>${esc(formatMoney(p.currency, -p.amountMinor))}</b></li>`);
  }
  return `<table class="money due-table"><caption>${ended ? '남은 미지급 (캠페인 종료)' : `앞으로 낼 돈 (${from === to ? from : `${from}~${to}`}일)`}</caption><thead><tr><th scope="col">항목</th>${summary.currencies.map((c) => `<th scope="col">${esc(c)}</th>`).join('')}</tr></thead><tbody>${summary.lines.filter((line) => !ended || line.kind === 'OVERDUE').map((line) => `<tr><th scope="row">${esc(line.labelKo)}</th>${line.amounts.map((amount, i) => `<td>${amount === null ? '—' : esc(formatMoney(summary.currencies[i]!, amount))}</td>`).join('')}</tr>`).join('')}</tbody></table><p class="muted small">통화가 달라 USD와 KRW를 더하지 않습니다.</p>${undatedKo(summary.unbooked, '운송편을 아직 예약하지 않아 관세 낼 날을')}${undatedKo(summary.noSailing, '캠페인 안에 실을 자리가 남은 출항편이 없어 날짜를')}${list.length ? `<ul class="due-list">${list.join('')}</ul>` : ''}`;
}

/** 날짜를 정하지 못한 지급은 기간 표 밖에 원인별로 적는다. 금액은 통화마다 따로 쓴다. */
function undatedKo(u: UndatedPayments, cause: string): string {
  if (!u.count) return '';
  const amounts = u.amounts.map((a) => formatMoney(a.currency, a.amountMinor)).join(' · ');
  return `<p class="muted small">${esc(`${cause} 정하지 못한 지급이 ${u.count}건(${amounts}) 있습니다. 위 표에는 넣지 않았습니다.`)}</p>`;
}

function operationsBlock(): string {
  const groups = bottlenecks(state, config);
  const other = groups.filter((g) => g.kind !== '사람').reduce((sum, g) => sum + g.items.length, 0);
  // 끝난 화면의 정시 인도율은 결산 안에 한 번만 둔다.
  return `<div class="report-ops"><h3>운영 지표</h3>${state.phase === 'ENDED' ? '' : deliveryRateBlock()}${upcomingBlock()}${state.phase === 'ENDED' ? '' : `${config.operations ? opsScreens!.warehouseBlock(state, view, config, ui.pending, investmentOpen) : ''}<h4>업무 부하</h4><ul class="workload">${workloadLinesKo(workloadSummary(state, config), config).map((line) => `<li>${esc(line)}</li>`).join('')}</ul><p class="muted small">한 사람은 한 번에 업무 하나만 맡아 실제로는 더 걸릴 수 있습니다. 처리량은 고정값이며 레벨·능력은 쓰지 않습니다.</p><h4>막힌 곳</h4><ul class="bottleneck">${groups.map((g) => `<li><b>${g.kind}</b> ${g.items.length ? `${g.items.length}건<ul>${g.items.map((i) => `<li>${i.contractId ? contractLink(i.contractId) + ' ' : ''}${esc(i.textKo)}</li>`).join('')}</ul>` : '없음'}</li>`).join('')}</ul>${other ? `<p class="muted small">사람을 더 뽑아도 돈·시간·선복${config.operations ? '·창고' : ''} 쪽 막힘 ${other}건은 풀리지 않습니다.</p>` : ''}`}</div>`;
}

function settlementBlock(): string {
  if (state.phase !== 'ENDED') return '';
  const sum = campaignSummary(state, config);
  const c = sum.contracts;
  const unpaid: string[] = [];
  for (const standing of sum.byCurrency) {
    const rows = sum.unpaidObligations.filter((o) => o.currency === standing.currency);
    if (!rows.length) continue;
    const first = Math.min(...rows.map((o) => o.incurredDay)), last = Math.max(...rows.map((o) => o.incurredDay));
    unpaid.push(`<p>남은 미지급 ${esc(standing.currency)}: ${esc(formatMoney(standing.currency, rows.reduce((a, o) => a + o.amountMinor, 0)))} — ${rows.length}건, ${first === last ? first : `${first}~${last}`}일 발생</p>`);
  }
  const books = `<p>통화마다 따로 결산합니다. USD와 KRW는 더하지 않습니다.</p><div class="books">${sum.byCurrency.map((st) => `<table class="money"><caption>결산 · ${esc(st.currency)}</caption>${settlementRows(st, config).map(([label, value, total]) => `<tr${total ? ' class="total"' : ''}><th>${esc(label)}</th><td>${esc(formatMoney(st.currency, value))}</td></tr>`).join('')}</table>`).join('')}</div>`;
  return `<div class="settlement"><h3 id="settlement-h" tabindex="-1">${sum.operations?.outcome === 'FAILED' ? `${sum.operations.failure!.day}일 마감 결산` : `${sum.campaignDays}일 결산`}</h3>${config.operations ? opsScreens!.netAssetChangeKo(state, config, sum.operations?.failure?.day ?? sum.campaignDays) + opsScreens!.operationsSettlement(sum) : ''}${config.operations ? opsScreens!.path11Settlement(state, config, sum.operations?.failure?.day ?? sum.campaignDays, ui, books) : books}<p>계약 ${c.total}건 — 수금 완료 ${c.completed}건 · 인도 뒤 수금 대기 ${c.awaitingPayment}건 · 진행 중 ${c.inProgress}건 · 취소 ${c.cancelled}건</p>${deliveryRateBlock()}<p>받지 못한 대금: ${sum.openInvoices.map((i) => `${contractLink(i.contractId)} ${i.dueDay}일 ${esc(formatMoney(i.currency, i.amountMinor))}`).join(', ') || '없음'}</p>${unpaid.join('') || '<p>남은 미지급: 없음</p>'}${sum.unpaidObligations.length ? `<details class="muted small"><summary>남은 미지급 목록 (${sum.unpaidObligations.length}건)</summary><ul>${sum.unpaidObligations.map((o) => `<li>${esc(obligationLineKo(o))} ${esc(formatMoney(o.currency, o.amountMinor))}</li>`).join('')}</ul></details>` : ''}</div>`;
}

function reportPanel(): string {
  const r = companyReport(state, config);
  const t = r.trade, p = r.payroll;
  const f = fundsPosition(state, config, config.tradeCurrency);
  const fwdOn = config.rules.forwardingEnabled;
  const company = cargoListKo(config, heldCargoByGood(state, config, 'COMPANY'));
  const customer = cargoListKo(config, heldCargoByGood(state, config, 'CUSTOMER'));
  const why: string[] = [];
  if (t.accountsReceivable > 0) {
    const open = state.invoices.filter((i) => i.status !== 'PAID' && i.status !== 'WRITTEN_OFF').sort((a, b) => a.dueDay - b.dueDay);
    why.push(esc(`매출 ${usd(t.accountsReceivable)}는 이미 이익에 들어갔지만 현금은 나중에 들어옵니다 (매출채권: `)
      + open.map((i) => contractLink(i.contractId) + esc(` ${i.dueDay}일 ${usd(i.amountMinor)}`)).join(', ') + esc(').'));
  }
  if (t.inventory > 0) why.push(esc(`재고 ${company}(${usd(t.inventory)})는 현금이 이미 나갔지만 팔기 전까지 비용이 아닙니다.`));
  if (t.prepaidFreight > 0) why.push(esc('이 게임 장부에서는 출항하면 운임을 상품 원가에 넣습니다(실제 회계에서는 판매 운송비를 판매비로 보는 경우가 많습니다). 운송 주선에서는 주선 진행원가가 됩니다.'));
  if (t.forwardingWip > 0) why.push(esc(`주선 진행원가 ${usd(t.forwardingWip)}는 고객 화물을 실은 운임입니다. 인도해 서비스 매출을 올리는 날 비용이 됩니다.`));
  if (r.customerCargoUnits > 0) why.push(esc(`맡은 고객 화물 ${customer}는 고객 자산이라 위 표 어디에도 없습니다. 우리 몫은 서비스 대금뿐입니다.`));
  if (config.operations && f.reserved + f.unpaidObligations > 0) {
    const parts = [f.reserved - f.reservedCommitments > 0 ? `체결한 계약이 낼 운임·관세 ${usd(f.reserved - f.reservedCommitments)}` : '',
      f.reservedCommitments > 0 ? `선복 장기 계약의 다가오는 출항 요금 ${usd(f.reservedCommitments)}` : '',
      f.unpaidObligations > 0 ? `미지급 ${usd(f.unpaidObligations)}` : ''].filter(Boolean);
    why.push(esc(`사용 가능 자금(${usd(f.available)})은 현금보다 ${usd(f.reserved + f.unpaidObligations)} 적습니다. ${parts.join(', ')} 때문입니다.`));
  } else if (committedRule() && f.reserved > 0) why.push(esc(`사용 가능 자금(${usd(f.available)})은 현금보다 ${usd(f.reserved + f.unpaidObligations)} 적습니다. 체결한 계약이 낼 운임·관세를 미리 묶어 두었기 때문입니다.`));
  const endedWithUnpaid = config.operations && state.phase === 'ENDED' && state.obligations.some((o) => o.paidDay === null);
  const exchangeAdvice = config.operations
    ? state.phase === 'ENDED' ? (endedWithUnpaid ? '캠페인이 끝나 더 갚을 수 없습니다. 남은 미지급은 결산에 있습니다.' : '')
      : `환전 칸에서 ${opsScreens!.fxLotKo(config)} 단위로 원화로 바꿀 수 있습니다. 자동 환전은 없습니다.`
    : '이번 판에는 달러를 원화로 바꾸는 기능이 없습니다.';
  if (t.profit > 0) {
    const runway = state.phase === 'ENDED' ? '' : `(원화 급여 지급 가능일: ${payrollRunwayKo(payrollRunwayDay(state, config), state.day, config.campaignDays)})`;
    why.push(esc(`거래 손익 ${usd(t.profit)}는 달러 장부의 이익입니다. 급여 같은 원화 비용은 원화 현금 ${krw(p.cash)}에서만 나갑니다${runway}. ${exchangeAdvice}`));
  } else if (p.accountsPayable > 0) why.push(esc(`원화 미지급 급여가 ${krw(p.accountsPayable)} 있습니다. 달러 현금 ${usd(t.cash)}로는 원화 급여를 낼 수 없습니다. ${exchangeAdvice}`));
  if (endedWithUnpaid && t.profit <= 0 && p.accountsPayable === 0) why.push(esc(exchangeAdvice));
  if (!why.length) why.push(esc('지금은 현금과 장부가 같은 이야기를 하고 있습니다. 거래를 진행하며 차이가 생기는 순간을 확인해 보세요.'));
  const neg = (minor: number, fmt: (m: number) => string) => (minor === 0 ? fmt(0) : '−' + fmt(minor));
  const row = (k: string, v: string, cls = '') => `<tr class="${esc(cls)}"><th>${esc(k)}</th><td>${esc(v)}</td></tr>`;
  return `
  <section class="panel report" aria-labelledby="report-h">
    <h2 id="report-h">경영 보고 <small>하루 진행으로 확정된 상태 · 오늘 할 일은 하루 진행 뒤 반영</small></h2>
    ${config.operations ? opsScreens!.paymentAlert(state, config) + opsScreens!.failureBlock(state, config) : ''}${settlementBlock()}
    <div class="books">
      <table class="money"><caption>거래 장부 · USD</caption>
        ${row('현금', usd(t.cash))}${row(`재고 (${company})`, usd(t.inventory))}${row('선급운임', usd(t.prepaidFreight))}${fwdOn ? row('주선 진행원가', usd(t.forwardingWip)) : ''}${row('매출채권', usd(t.accountsReceivable))}${row('자산 합계', usd(t.totalAssets), 'total')}${row('미지급금', usd(t.accountsPayable))}
        ${row('상품 매출', usd(t.revenue))}${row('매출원가', neg(t.costOfGoodsSold, usd))}${fwdOn ? row('주선 매출', usd(t.forwardingRevenue)) + row('주선 원가', neg(t.forwardingCost, usd)) : ''}${row('취소비', neg(t.cancellationExpense, usd))}${row('USD 거래 손익(급여·임차료·원화 비용 제외)', usd(t.profit), 'total')}
        ${fwdOn ? `<tr><td colspan="2" class="muted small">${esc(`맡은 고객 화물 ${customer} — 회사 자산이 아니라 표에 넣지 않습니다.`)}</td></tr>` : ''}
      </table>
      <table class="money"><caption>운영 장부 · KRW</caption>
        ${krwReportRows(r, config)}
        <tr><td colspan="2" class="muted small">${esc(krwReportNoteKo(config))}</td></tr>
      </table>
    </div>
    ${config.operations ? opsScreens!.path11Report(state, config, ui) : ''}${operationsBlock()}
    <div class="why"><h3>현금과 이익이 다른 이유</h3><ul>${why.map((w) => `<li>${w}</li>`).join('')}</ul></div>
  </section>`;
}

function crewPanel(): string {
  const shown = crewEntries(view, config, ui.crewFilter, { role: ui.crewRole, attribute: ui.crewAttribute });
  const options = crewFacetOptions(view, config);
  const facet = (label: string, id: string, action: string, values: string[], chosen: string | null, name: (value: string) => string) =>
    values.length < 2 ? '' : `<label>${label} <select id="${id}" data-action="${action}"><option value="" ${chosen === null ? 'selected' : ''}>전체</option>${values.map((value) => `<option value="${esc(value)}" ${value === chosen ? 'selected' : ''}>${esc(name(value))}</option>`).join('')}</select></label>`;
  const facets = facet('직무', 'crew-role', 'crew-role', options.roles, ui.crewRole, roleKo)
    + facet('속성', 'crew-attr', 'crew-attr', options.attributes, ui.crewAttribute, attributeKo);
  const filterBtn = (f: typeof ui.crewFilter, label: string) =>
    `<button data-action="crew-filter" data-filter="${f}" aria-pressed="${ui.crewFilter === f}">${label}</button>`;
  // REF-01·05: 카드와 운영표가 같은 직원 상태(view)를 같은 필터로 보여 준다. 행을 고르면 카드도 함께 선택된다.
  const rows = shown.map(({ def, candidate, task }) => crewRow(def, view, config, ui.selectedCard === def.id, candidate, task)).join('');
  const detail = ui.selectedCard && employedDefs(view,config).some((e)=>e.id===ui.selectedCard) ? employeeDetail(view,config,config.employees.find((e)=>e.id===ui.selectedCard)!,ui.detailId===ui.selectedCard,ui.pending.some((p)=>p.type==='START_TRAINING' && p.employeeId===ui.selectedCard)) : '';
  // 배치 공통: 카드로 골랐고 그 카드가 보이면 상세를 카드 바로 아래에 둔다(M2만).
  const inline = Boolean(config.culture && detail && detailUnder === 'card' && shown.some((entry) => entry.def.id === ui.selectedCard));
  return `
  <aside class="panel crew" aria-labelledby="crew-h">
    <h2 id="crew-h" tabindex="-1">동료 <small>${employedDefs(view, config).length}명 고용 중</small>${officeButton(state)}</h2>
    <div class="seg crew-filter" role="group" aria-label="동료 보기">${filterBtn('all', '전체')}${filterBtn('free', '대기')}${filterBtn('busy', '업무·훈련 중')}${config.recruitment ? filterBtn('candidate', '후보') : ''}</div>
    ${facets ? `<div class="crew-facets" role="group" aria-label="직무·속성으로 걸러 보기">${facets}</div>` : ''}
    <div class="crew-cards">${shown.map((entry) => crewEntryCard(entry, view, config, ui.selectedCard === entry.def.id) + (inline && entry.def.id === ui.selectedCard ? `<div class="card-detail">${detail}</div>` : '')).join('') || '<p class="muted small">이 조건의 동료가 없습니다.</p>'}</div>
    <table class="roster"><caption>운영표 — 카드와 같은 상태</caption>
      <thead><tr><th scope="col">동료·직무</th><th scope="col">상태·위치</th><th scope="col">처리량·일급</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    ${inline ? '' : detail}
    ${recruitmentPanel(view, config, ui.recruitSelections, ui.interviewId, tryCommand, ui.pending.filter((p): p is import('../engine/types').Command => p.type !== 'EXCHANGE_CURRENCY' && p.type !== 'EXPAND_WAREHOUSE' && p.type !== 'SIGN_SPACE_CONTRACT'), queuedStatus, state)}
    <p class="muted small">${esc(crewNoteKo(config, view))}</p>
  </aside>`;
}

function planLabel(plan: CommitPlan | undefined): string {
  if (!plan || (!plan.employeeId && !plan.sailingId)) return '';
  const parts = [plan.employeeId ? `준비 ${employeeName(plan.employeeId)}` : '', plan.sailingId ? `${plan.sailingId} 예약` : ''].filter(Boolean);
  return ` + ${parts.join(' + ')} (한 번에 확정)`;
}

function commandLabel(c: Command): string {
  switch (c.type) {
    case 'START_CULTURE_ACTIVITY': {
      const activity = config.culture?.activities.find((a) => a.id === c.activityId);
      return `${activity?.titleKo ?? c.activityId} → ${employeeName(c.employeeId)}${activity ? ` (${formatMoney(activity.currency, activity.costMinor)}·${activity.durationDays}일)` : ''}`;
    }
    case 'START_TRAINING':
      return `${employeeName(c.employeeId)} 일반 훈련`;
    case 'ACCEPT_TRADE': {
      const buy = offerDef(view, config, c.buyOfferId);
      return `직접 무역 수락·매입 (${buy ? qtyKo(buy.goodId, c.quantity ?? buy.quantity) : c.buyOfferId})${planLabel(c.plan)}${config.operations ? opsScreens!.path11CommandLabel(config, c) : ''}`;
    }
    case 'ACCEPT_FORWARDING': {
      const o = offerDef(view, config, c.offerId);
      return `운송 주선 수락 (${o ? qtyKo(o.goodId, o.quantity) : c.offerId})${planLabel(c.plan)}`;
    }
    case 'EXPAND_WAREHOUSE':
      return '창고 확장';
    case 'SIGN_SPACE_CONTRACT':
      return `선복 계약 ${routeLabel(config, c.routeId)}`;
    case 'EXCHANGE_CURRENCY':
      return `환전 ${c.direction === 'USD_TO_KRW' ? 'USD→KRW' : 'KRW→USD'} ${formatMoney('USD', c.usdAmountMinor)}`;
    case 'SCOUT_SITE':
      return `${venueTitle(c.venueId)} 현장 조사 → ${employeeName(c.employeeId)}`;
    case 'START_RECRUIT_QUEST':
      return `${employeeName(c.candidateId)} 영입 의뢰 → ${employeeName(c.employeeId)}`;
    case 'HIRE_CANDIDATE':
      return `${employeeName(c.candidateId)} 고용`;
    case 'ASSIGN_TASK': {
      const t = view.tasks.find((x) => x.id === c.taskId);
      return `${t ? `${taskSubjectKo(config, t) ?? ''} ${taskName(t.kind)}` : c.taskId} → ${employeeName(c.employeeId)}`;
    }
    case 'BOOK_SAILING':
      return `${c.contractId} 운송편 예약 (${c.sailingId})`;
    case 'CANCEL_CONTRACT':
      return `${c.contractId} 출항 전 취소`;
    case 'RESPOND_TO_DELAY':
      return '지연 대응: 현재 예약으로 대기';
  }
}

function queuePanel(): string {
  const plan = planCommands(state, config, ui.pending);
  const pending = ui.pending.length ? `<ol class="pending">${ui.pending.map((c, i) => `<li class="${plan[i]?.status === 'APPLIED' ? '' : 'bad'}">${esc(commandLabel(c))}${plan[i]?.status !== 'APPLIED' ? ` — ${esc(plan[i]?.reasonKo ?? '')}` : ''}<button class="link" data-action="unqueue" data-index="${i}" data-command="${esc(c.id)}" aria-label="${esc(commandLabel(c))} 빼기">빼기</button></li>`).join('')}</ol>` : '';
  return `
  <section class="panel queue" aria-labelledby="queue-h">
    <h2 id="queue-h" tabindex="-1">오늘 할 일 <small>${state.phase === 'ENDED' ? (config.operations && state.operations?.outcome === 'FAILED' ? `${state.operations.failure!.day}일 · 경영 실패` : `${config.campaignDays}일 · 캠페인 종료`) : `${state.day}일 · 하루 진행 때 이 순서로 실행`}</small></h2>
    ${ui.flash ? `<p class="flash ${ui.flash.kind}">${esc(ui.flash.text)}</p>` : ''}
    ${ui.pending.length ? `<p class="muted small amount-basis-note">${config.operations ? '급여 가능일은 대기 중인 명령을 반영합니다. 지급 상태는 확정 기준이고, 하루 진행 뒤 예상을 따로 보입니다.' : '위쪽 막대의 금액은 확정 기준입니다.'} 여기 넣은 일은 하루 진행 뒤에 반영됩니다.</p>` : ''}
    ${state.phase === 'ENDED' ? `<p class="muted">캠페인이 끝났습니다. 결산은 경영 보고에 있습니다.</p><button class="link" data-action="skip-to" data-target="settlement-h">결산 보기</button>${pending}` : pending || '<p class="muted">대기 중인 명령이 없습니다. 아무것도 하지 않고 하루를 보낼 수도 있습니다.</p>'}
    ${ui.growthNoticesDay === null ? '' : growthStatus(ui.growthNotices, ui.growthNoticesDay)}
    ${state.phase === 'ENDED' ? '' : scheduleBlock(view, config, { open: ui.scheduleOpen, prev: ui.schedulePrev, link: contractLink })}
  </section>`;
}

function logPanel(): string {
  const items = [...state.log].reverse().slice(0, 40);
  return `
  <section class="panel log" aria-labelledby="log-h">
    <h2 id="log-h">기록</h2>
    <ul>${items.map((l) => `<li><span>${l.day}일</span>${esc(l.textKo)}</li>`).join('') || '<li class="muted">아직 기록이 없습니다.</li>'}</ul>
    <details class="muted small"><summary>이 시제품이 가정한 값</summary><ul>${assumptionNotes(config.id as AnyScenarioId).filter((n) => !/^규칙 [^:]+: /.test(n)).map((n) => `<li>${esc(n)}</li>`).join('')}</ul></details>
  </section>`;
}

/** 한 열 배치 조건. style.css 112행 `@media (max-width: 1000px)`와 같은 글자다. */
const ONE_COLUMN_QUERY = '(max-width: 1000px)';
const oneColumnQuery = window.matchMedia(ONE_COLUMN_QUERY);
function isOneColumn(): boolean { return oneColumnQuery.matches; }
/** 한 열 여부가 바뀌면(회전·창 크기) 패널 순서를 다시 그린다. 초점은 같은 조작에 그대로 두고 굴리지 않는다. */
function onColumnChange() {
  const was = document.activeElement as HTMLElement | null;
  const key = was && was !== document.body ? { id: was.id, tag: was.tagName, data: { ...was.dataset } } : null;
  render(true);
  if (!key || (!key.id && !key.data.action)) return;
  const again = (key.id ? document.getElementById(key.id) : null) ?? Array.from(app.querySelectorAll<HTMLElement>('[data-action]'))
    .find((el) => el.tagName === key.tag && Object.entries(key.data).every(([k, v]) => el.dataset[k] === v));
  if (again) again.focus({ preventScroll: true });
}
oneColumnQuery.addEventListener('change', onColumnChange);

for (const type of ['pointerdown', 'wheel', 'touchstart', 'focusin']) {
  app.addEventListener(type, (ev) => {
    const el = ev.target as HTMLElement;
    if (el.closest(SIDE_PANELS)) lastColumn = 'side';
    else if (el.closest('.layout')) lastColumn = 'main';
    if (type === 'pointerdown' || type === 'focusin') touchLayers(el);
  }, { capture: true, passive: true });
}

/** 열린 칸과 그 칸의 안 판정 선택자·연 단추. 안쪽 칸이 앞이다. */
function openLayers(): { key: LayerKey; within: string; opener: () => HTMLElement | null }[] {
  const layers: { key: LayerKey; within: string; opener: () => HTMLElement | null }[] = [];
  if (ui.cultureOpen && ui.cultureBookOpen) layers.push({ key: 'book', within: '#culture-book-body, [data-action="culture-book"]', opener: () => app.querySelector<HTMLElement>('[data-action="culture-book"]') });
  if (ui.cultureOpen) layers.push({ key: 'local', within: '#local, #local-tab', opener: () => document.getElementById('local-tab') });
  const iv = ui.interviewId;
  if (iv && document.getElementById(`interview-${iv}`)) layers.push({ key: 'interview', within: `#interview-${iv}, [data-action="interview"][data-candidate="${iv}"]`, opener: () => app.querySelector<HTMLElement>(`[data-action="interview"][data-candidate="${iv}"]`) });
  const dt = ui.detailId;
  if (dt && dt === ui.selectedCard && document.getElementById(`growth-${dt}`)) layers.push({ key: 'detail', within: `#growth-${dt}, [data-action="detail"][data-emp="${dt}"]`, opener: () => app.querySelector<HTMLElement>(`[data-action="detail"][data-emp="${dt}"]`) });
  if (document.getElementById('map-detail')) layers.push({ key: 'map', within: '#map-detail, #map-pick, [data-map-frame]', opener: () => document.getElementById('map-pick') });
  if (ui.path11DialogOpen) layers.push({ key: 'path11', within: '#p11-dialog', opener: () => app.querySelector<HTMLElement>('[data-action="p11-dialog"]') });
  return layers;
}
/** 누르거나 초점을 둔 곳이 열린 칸 안이면 그 칸을 맨 위로 올린다. */
function touchLayers(el: HTMLElement) {
  const seq = ++layerSeq;
  for (const layer of openLayers()) if (el.closest(layer.within)) layerTouched[layer.key] = seq;
}
function markOpened(key: LayerKey) { layerTouched[key] = ++layerSeq; }
/** 닫은 칸을 연 단추를 띠 안으로 최소 거리만 옮기고 초점을 둔다(closeCulture 976~980행과 같은 띠). */
function revealOpener(el: HTMLElement | null) {
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const top = app.querySelector<HTMLElement>('.statusbar')!.getBoundingClientRect().bottom + 8;
  const bottom = Math.min(window.innerHeight, app.querySelector<HTMLElement>('.flash-toast')?.getBoundingClientRect().top ?? Infinity) - 8;
  const dy = rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
  if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
  el.focus({ preventScroll: true });
}
/** D13: Esc로 맨 위 칸을 닫고 연 단추로 초점을 돌려준다. */
function closeTopLayer(ev: KeyboardEvent) {
  if (situationOpen || officeOpen) return;
  const layers = openLayers();
  if (!layers.length) return;
  const top = layers.reduce((a, b) => (layerTouched[b.key] > layerTouched[a.key] ? b : a));
  ev.preventDefault();
  if (top.key === 'local') return closeCulture();
  if (top.key === 'book') ui.cultureBookOpen = false;
  if (top.key === 'interview') ui.interviewId = null;
  if (top.key === 'detail') ui.detailId = null;
  if (top.key === 'path11') ui.path11DialogOpen = false;
  if (top.key === 'map') { mapPick = null; mapNear = []; }
  render(true);
  revealOpener(top.opener() ?? document.getElementById('crew-h'));
  ignoreClicksUntil = Date.now() + 500;
}

/** 고른 표시를 강조하고 상세 칸을 펼침 띠 안으로 가져온다. */
function pickMapMark(key: string | null, focusHead = false) {
  mapPick = key;
  mapNear = [];
  if (key) markOpened('map');
  render(focusHead);
  // 세계지도에서 고른 표시가 틀 밖이면 틀 가운데로 가져온다.
  const frame = app.querySelector<HTMLElement>('[data-map-frame]')!;
  const dot = frame.querySelector('.picked [data-mark-dot], [data-mark-dot].picked');
  if (dot) {
    const f = frame.getBoundingClientRect(), r = dot.getBoundingClientRect();
    if (r.left < f.left || r.right > f.right) frame.scrollLeft += (r.left + r.right) / 2 - (f.left + f.right) / 2;
  }
  if (focusHead) document.getElementById('map-detail-h')?.focus({ preventScroll: true });
  liveStatus.textContent = liveRegionText(liveStatus.textContent ?? '', key ? `${document.getElementById('map-detail-h')?.textContent ?? ''}: 지도 아래에 자세한 내용` : '');
  revealBelow(document.getElementById('map-detail'), document.getElementById('map-detail-h'));
  ignoreClicksUntil = Date.now() + 500;
}

/** 이름표는 바로 고르고, 그 밖의 점은 22px 안의 후보를 찾는다. */
function tapMap(target: Element, x: number, y: number) {
  const label = target.closest('.ribbon, .gate-label')?.closest<HTMLElement>('[data-mark]');
  if (label) return pickMapMark(label.dataset.mark!);
  const points = Array.from(app.querySelectorAll<Element>('[data-map-frame] [data-mark-dot]')).map((dot) => {
    const r = dot.getBoundingClientRect();
    return { key: dot.closest<HTMLElement>('[data-mark]')!.dataset.mark!, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  const near = nearestMarks(points, x, y);
  if (near.length === 1) return pickMapMark(near[0]!);
  if (near.length > 1) {
    mapPick = null;
    mapNear = near;
    markOpened('map');
    render();
    revealBelow(document.getElementById('map-detail'), document.getElementById('map-detail-h'));
    ignoreClicksUntil = Date.now() + 500;
  }
}

function render(skipFocus = false, anchor: QueueAnchor | null = null) {
  if (config.operations && !opsScreens) throw new Error('규칙 2 화면 묶음을 먼저 불러와야 합니다.');
  if (ui.cultureOpen && !culturePanel) throw new Error('문화 패널 묶음을 먼저 불러와야 합니다.');
  document.title = `Scitrade — ${config.titleKo}`;
  view = planState(state, config, ui.pending).state;
  selectedExchange = config.operations ? opsScreens!.exchangeSelection(view, config, ui.exchangeDirection, ui.exchangeLots) : undefined;
  if (selectedExchange) ui.exchangeLots = selectedExchange.lots;
  if (ui.offerQuantitiesDay !== view.day) { ui.offerQuantities = {}; ui.offerQuantitiesDay = view.day; }
  for (const key of Object.keys(ui.offerQuantities)) {
    if (key.split('+').some((id) => view.offers.find((o) => o.id === id)?.status !== 'OPEN')) delete ui.offerQuantities[key];
  }
  const path11 = opsScreens?.path11Render(false, app, state, view, config, ui) ?? '';
  const previousMarket = document.getElementById('market-scroll');
  const marketScrollLeft = previousMarket?.scrollLeft;
  const previousInvestment = document.getElementById('investment-details') as HTMLDetailsElement | null;
  const signature = JSON.stringify([ui.pending.filter((c) => c.type === 'EXPAND_WAREHOUSE' || c.type === 'SIGN_SPACE_CONTRACT').map((c) => c.id), view.operations?.expansions, view.operations?.spaceContracts]);
  investmentOpen = signature === investmentSignature ? previousInvestment?.open ?? investmentOpen : undefined;
  investmentSignature = signature;
  const previousMap = app.querySelector<HTMLElement>('.map-frame.is-world');
  if (previousMap) mapScrollRatio = readMapScroll(true, previousMap.dataset.measured === 'true', resetMapScroll,
    previousMap.scrollLeft, previousMap.scrollWidth, previousMap.clientWidth, mapScrollRatio);
  const focused = activation?.element ?? document.activeElement as HTMLElement | null;
  // 태그와 모든 대상 속성을 비교한다. 대기열 순번은 삭제 시 바뀌므로 명령 ID를 쓴다.
  const focusData = focused?.dataset.action ? { ...focused.dataset } : null;
  if (focusData) delete focusData.index;
  const tag = focused?.tagName;
  const blockHeading = focused?.closest(FOCUS_FALLBACK_SELECTORS.join(', '))?.querySelector('h3, h4')?.id
    ?? focused?.closest('.contract, .panel')?.querySelector('h3[id], h2[id]')?.id;
  app.innerHTML = `
    <nav class="skip-links" aria-label="바로 가기"><button data-action="skip-to" data-target="trade-h">거래로 바로 가기</button><button data-action="skip-to" data-target="queue-h">오늘 할 일로 바로 가기</button></nav>
    ${topbar()}
    ${ui.flash ? `<div class="flash-toast flash ${ui.flash.kind}">${esc(ui.flash.text)}${ui.flash.action === 'culture-result' ? `<button data-action="culture-result">${CULTURE_KO.resultButton}</button>` : ui.flash.action === 'reload' ? '<button data-action="reload">새로 고침</button>' : ''}</div>` : ''}
    <main class="layout ${mapPresentation(config, mapMode).world ? 'map-wide' : ''}">
      ${config.culture ? `<div class="maincol">${ui.cultureOpen ? culturePanel!.culturePanel(state, view, ui.pending.filter((p): p is import('../engine/types').Command => p.type !== 'EXCHANGE_CURRENCY' && p.type !== 'EXPAND_WAREHOUSE' && p.type !== 'SIGN_SPACE_CONTRACT'), config, ui, queuedStatus) : ''}${tradePanel()}</div>` : tradePanel()}
      ${(isOneColumn() ? [queuePanel, crewPanel, resourcePanel, reportPanel, worldMap, logPanel]
        : [crewPanel, resourcePanel, queuePanel, worldMap, reportPanel, logPanel]).map((panel) => panel()).join('\n      ')}
    </main>${path11}`;
  opsScreens?.path11Render(true, app, state, view, config, ui);
  const marketScroll = document.getElementById('market-scroll');
  if (marketScroll && marketScrollLeft !== undefined) marketScroll.scrollLeft = marketScrollLeft;
  const toastEl = app.querySelector<HTMLElement>('.flash-toast');
  document.documentElement.style.setProperty('--toast-h', toastEl ? `${Math.ceil(window.innerHeight - toastEl.getBoundingClientRect().top) + 8}px` : '0px');
  measureStatusbar();
  if (anchor?.slot) {
    const now = document.getElementById(`status-${anchor.slot}`)?.parentElement ?? app.querySelector<HTMLElement>(`[data-action-slot="${anchor.slot}"]`);
    const dy = now ? now.getBoundingClientRect().top - anchor.top : 0;
    if (dy >= 1) window.scrollBy(0, dy);
  }
  // 다음 하루 진행·초기화까지 글은 남기고, 화면 읽기 알림은 첫 그리기만 한다.
  let announcement = nextAnnouncement({ flash: ui.flash, announcedFlash,
    growthFresh: ui.growthNoticesFresh, growthNotices: ui.growthNotices, growthDay: ui.growthNoticesDay });
  const paymentLevel = config.operations ? paymentDefaultStatus(state, config).level : 'NONE';
  if (state.phase !== 'ENDED' && paymentLevel !== previousPaymentLevel && (paymentLevel === 'WARNING' || paymentLevel === 'DANGER')) {
    announcement = [announcement, `지급 ${paymentLevel === 'WARNING' ? '경고' : '위험'} 단계가 되었습니다`].filter(Boolean).join(' ');
  }
  previousPaymentLevel = paymentLevel;
  if (announcement !== null) liveStatus.textContent = liveRegionText(liveStatus.textContent ?? '', announcement);
  announcedFlash = ui.flash;
  ui.growthNoticesFresh = false;
  ui.cultureResultFresh = false;
  const frame = app.querySelector<HTMLElement>('[data-map-frame]')!;
  frame.dataset.viewportKey = mapRedrawDecision(config, mapMode, mapMeasurements.get(mapMode)).key;
  const positionMap = () => {
    const center = Number(frame.querySelector<HTMLElement>('[data-map-center]')?.dataset.mapCenter ?? 0.5);
    const left = mapScrollPosition(mapPresentation(config, mapMode).world, mapScrollRatio, center, frame.scrollWidth, frame.clientWidth);
    if (left !== undefined) frame.scrollLeft = left;
  };
  if (mapMeasurements.has(mapMode)) {
    frame.dataset.measured = 'true';
    positionMap();
    resetMapScroll = false;
  }
  applyPixelScale(app, (frame, width, dpr) => {
    const measurement = { availableWidth: width, dpr };
    const decision = mapRedrawDecision(config, mapMode, measurement, frame.dataset.viewportKey);
    mapScrollRatio = readMapScroll(mapPresentation(config, mapMode).world, frame.dataset.measured === 'true', resetMapScroll,
      frame.scrollLeft, frame.scrollWidth, frame.clientWidth, mapScrollRatio);
    mapMeasurements.remember(mapMode, width, dpr);
    if (decision.redraw) {
      frame.innerHTML = renderWorldMap(view, config, mapMode, { ...measurement, baseOutsideSvg: MAP_BASE_OUTSIDE_SVG, picked: mapPick });
      frame.dataset.viewportKey = decision.key;
    }
    frame.dataset.measured = 'true';
    positionMap();
    resetMapScroll = false;
  });
  if (focusData && !skipFocus) {
    const target = Array.from(app.querySelectorAll<HTMLElement>('[data-action]')).find((el) =>
      el.tagName === tag && Object.entries(focusData).every(([key, value]) => el.dataset[key] === value));
    const slot = focusData.action === 'assign' ? `assign-${focusData.task}` : focusData.action === 'book' ? `book-${focusData.contract}`
      : focusData.action === 'culture-queue' ? `culture-${focusData.activity}-${focusData.emp}` : undefined;
    const ids = [slot ? `status-${slot}` : undefined, ...focusFallbackIds(focusData, blockHeading)];
    const fallback = ids.filter((id): id is string => Boolean(id) && !(activation?.pointer && id === 'queue-h'))
      .map((id) => document.getElementById(id)).find(Boolean);
    if (target && anchor?.button) {
      const bottom = Math.min(window.innerHeight - 72, toastEl?.getBoundingClientRect().top ?? Infinity) - 8;
      const dy = target.getBoundingClientRect().bottom - bottom;
      if (dy >= 1) window.scrollBy(0, dy);
      target.focus({ preventScroll: true });
    } else focusWithoutScroll(target && !(target instanceof HTMLButtonElement && target.disabled) ? target : fallback);
  }
}

function showGrowthControl() {
  const control = app.querySelector<HTMLElement>('[data-action="detail"]');
  control?.scrollIntoView({ block: 'nearest' });
  control?.focus({ preventScroll: true });
}

/** 본 날을 바꾸기 전에 표시 시작일을 기억해, 여는 순간 결과가 사라지지 않게 한다. */
function markCultureSeen() {
  ui.cultureShowFromDay = ui.cultureSeenDay ?? state.day - 1;
  ui.cultureSeenDay = state.day;
}

async function openCulture(result = false) {
  try { if (!culturePanel) await ensureCulturePanel(); }
  catch (error) { screenLoadWarning(error); return; }
  // 같은 약속을 기다린 두 번째 열기는 첫 번째 결과를 그대로 둔다.
  if (enteringScenario || ui.cultureOpen && !result) return;
  ui.cultureTabTop = result ? null : document.getElementById('local-tab')?.getBoundingClientRect().top ?? null;
  markCultureSeen();
  // ‘결과 보기’는 같은 날 탭으로 먼저 열었어도 방금 마감한 날의 결과를 보여 준다.
  if (result) ui.cultureShowFromDay = Math.min(ui.cultureShowFromDay!, state.day - 1);
  ui.cultureOpen = true;
  markOpened('local');
  if (result) ui.flash = null;
  render(true);
  const task = result ? cultureResultTasks(state, config, state.day - 1).find((t) => t.completedDay === state.day - 1) : null;
  const heading = (task && document.getElementById(`culture-result-h-${task.id}`)) || document.getElementById('local-h');
  heading?.scrollIntoView({ block: 'start' });
  heading?.focus({ preventScroll: true });
  ignoreClicksUntil = Date.now() + 500;
}

function closeCulture() {
  ui.cultureOpen = false;
  render(true);
  const tab = document.getElementById('local-tab');
  if (tab) {
    const rect = tab.getBoundingClientRect();
    const top = (app.querySelector<HTMLElement>('.statusbar')?.getBoundingClientRect().bottom ?? 0) + 8;
    const bottom = Math.min(window.innerHeight, app.querySelector<HTMLElement>('.flash-toast')?.getBoundingClientRect().top ?? Infinity) - 8;
    const dy = ui.cultureTabTop !== null ? rect.top - ui.cultureTabTop
      : rect.top < top ? rect.top - top : rect.bottom > bottom ? rect.bottom - bottom : 0;
    if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
    tab.focus({ preventScroll: true });
  }
  ui.cultureTabTop = null;
  ignoreClicksUntil = Date.now() + 500;
}

/** 직원 고르기 뒤 제목부터 넣기 칸까지를 고정 막대와 알림 사이로 최소 거리만 움직인다. */
function showCulturePreview(employeeId: string) {
  const head = document.getElementById('culture-emp-h');
  const slot = document.getElementById('culture-slot');
  const employee = document.getElementById(`culture-emp-${employeeId}`);
  if (head && slot && employee) {
    const top = app.querySelector<HTMLElement>('.statusbar')?.getBoundingClientRect().bottom ?? 0;
    const toastTop = app.querySelector<HTMLElement>('.flash-toast')?.getBoundingClientRect().top ?? Infinity;
    const bottom = Math.min(window.innerHeight - 72, toastTop);
    const headTop = head.getBoundingClientRect().top;
    const slotBottom = slot.getBoundingClientRect().bottom;
    const needed = slotBottom > bottom ? slotBottom - bottom : headTop < top ? headTop - top : 0;
    const dy = Math.min(needed, employee.getBoundingClientRect().top - top - 8);
    if (Math.abs(dy) >= 1) window.scrollBy(0, dy);
  }
  employee?.focus({ preventScroll: true });
}

// ── 이벤트 ──

app.addEventListener('click', (ev) => {
  const el = (ev.target as HTMLElement).closest<HTMLElement>('[data-action]');
  if (!el && (ev.target as HTMLElement).closest('[data-map-frame]') && Date.now() >= ignoreClicksUntil) return tapMap(ev.target as Element, ev.clientX, ev.clientY);
  if (!el || enteringScenario || situationOpen || officeOpen || (el as HTMLButtonElement).disabled || Date.now() < ignoreClicksUntil) return;
  activation = { element: el, pointer: ev.detail > 0 };
  const d = el.dataset;
  try {
    if (opsScreens?.path11Handle(d.action, app, ui, render, markOpened, revealOpener)) return;
    switch (d.action) {
      case 'open-office':
        enteringScenario = true;
        return officeScreen.ensure().then(() => {
          officeOpen = true;
          officeScreen.get()!.openOffice(state, config, el, () => { officeOpen = false; }, { spriteHtml, runningTaskOf });
        }).catch((error: unknown) => { officeOpen = false; screenLoadWarning(error); })
          .finally(() => { enteringScenario = false; });
      case 'situation':
        enteringScenario = true;
        return situationScreen.ensure().then(() => {
          situationOpen = true;
          situationScreen.get()!.openSituation(state, config, el, () => { situationOpen = false; }, paymentDefaultStatus(state, config));
        }).catch((error: unknown) => { situationOpen = false; screenLoadWarning(error); })
          .finally(() => { enteringScenario = false; });
      case 'reload':
        if (state && hasUnsavedWork(ui.pending, state, savedState) && !confirm('새로 고침하면 저장하지 않은 진행과 오늘 할 일이 사라집니다. 새로 고칠까요?')) return;
        skipNextBeforeUnload = true;
        location.reload();
        return;
      case 'skip-to': {
        if (d.target !== 'trade-h' && d.target !== 'queue-h' && d.target !== 'settlement-h' && d.target !== 'exchange-h') return;
        const heading = document.getElementById(d.target)!;
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
        return;
      }
      case 'goto-contract': {
        const heading = document.getElementById(`contract-h-${d.contract}`);
        if (!heading) return;
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
        ignoreClicksUntil = Date.now() + 500;
        return;
      }
      case 'schedule-toggle':
        ui.scheduleOpen = !ui.scheduleOpen;
        render();
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'culture-tab':
        return ui.cultureOpen ? closeCulture() : openCulture();
      case 'culture-close':
        return closeCulture();
      case 'culture-result':
        return openCulture(true);
      case 'culture-act':
        if (ui.cultureActivityId !== d.activity) ui.cultureEmployeeId = null;
        ui.cultureActivityId = d.activity!;
        render();
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'culture-emp':
        ui.cultureEmployeeId = d.emp!;
        render(true);
        showCulturePreview(d.emp!);
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'culture-queue':
        return queue({ id: newId('CULTURE'), type: 'START_CULTURE_ACTIVITY', activityId: d.activity!, employeeId: d.emp! });
      case 'culture-book':
        ui.cultureBookOpen = !ui.cultureBookOpen;
        if (ui.cultureBookOpen) markOpened('book');
        render();
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'train':
        return queue({ id: newId('TRAIN'), type: 'START_TRAINING', employeeId: d.emp! });
      case 'detail':
        ui.detailId = ui.detailId === d.emp ? null : d.emp!;
        if (ui.detailId) markOpened('detail');
        render();
        if (ui.detailId) revealBelow(app.querySelector<HTMLElement>(`[data-action="train"][data-emp="${ui.detailId}"]`) ?? document.getElementById(`status-train-${ui.detailId}`),
          app.querySelector<HTMLElement>(`#growth-${ui.detailId} .training h4`));
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'scout':
        return queue({ id: newId('SCOUT'), type: 'SCOUT_SITE', venueId: d.venue!, employeeId: d.emp! });
      case 'recruit-quest':
        return queue({ id: newId('QUEST'), type: 'START_RECRUIT_QUEST', candidateId: d.candidate!, employeeId: d.emp! });
      case 'interview':
        ui.interviewId = ui.interviewId === d.candidate ? null : d.candidate!;
        if (ui.interviewId) markOpened('interview');
        render();
        if (ui.interviewId) revealBelow(app.querySelector<HTMLElement>(`[data-action="hire"][data-candidate="${ui.interviewId}"]`) ?? document.getElementById(`status-hire-${ui.interviewId}`),
          document.getElementById(`interview-h-${ui.interviewId}`));
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'hire':
        return queue({ id: newId('HIRE'), type: 'HIRE_CANDIDATE', candidateId: d.candidate! });
      case 'end-day': {
        const warnings = lastDepartureWarnings(view, config);
        if (warnings.length && !confirm(`${warnings.join(' ')} 예약 없이 하루를 진행할까요?`)) return;
        return endDay();
      }
      case 'queue-jump': {
        const heading = document.getElementById('queue-h')!;
        heading.scrollIntoView({ block: 'start' });
        heading.focus({ preventScroll: true });
        ignoreClicksUntil = Date.now() + 500;
        return;
      }
      case 'accept':
        return queue({ id: newId('ACCEPT'), type: 'ACCEPT_TRADE', buyOfferId: d.buy!, sellOfferId: d.sell!, ...(config.operations ? { quantity: ui.offerQuantities[`${d.buy}+${d.sell}`] ?? offerDef(view, config, d.buy!)!.quantity, ...opsScreens!.path11Term(config, ui, `${d.buy}+${d.sell}`) } : {}) });
      case 'expand-warehouse':
        return queue({ id: newId('EXPAND'), type: 'EXPAND_WAREHOUSE' });
      case 'sign-space-contract':
        return queue({ id: newId('SPACE'), type: 'SIGN_SPACE_CONTRACT', routeId: el.dataset.route! });
      case 'exchange':
        return queue({ id: newId('FX'), type: 'EXCHANGE_CURRENCY', direction: ui.exchangeDirection, usdAmountMinor: ui.exchangeLots * config.operations!.fx.lotUsdMinor });
      case 'accept-fwd':
        return queue({ id: newId('FWD'), type: 'ACCEPT_FORWARDING', offerId: d.offer! });
      case 'assign':
        return queue({ id: newId('ASSIGN'), type: 'ASSIGN_TASK', taskId: d.task!, employeeId: d.emp! });
      case 'book':
        return queue({ id: newId('BOOK'), type: 'BOOK_SAILING', contractId: d.contract!, sailingId: d.sailing! });
      case 'cancel':
        return queue({ id: newId('CANCEL'), type: 'CANCEL_CONTRACT', contractId: d.contract! });
      case 'keep':
        return queue({ id: newId('KEEP'), type: 'RESPOND_TO_DELAY', noticeId: d.notice!, shipmentId: d.shipment!, choice: 'KEEP_SHIPMENT_BOOKING' });
      case 'unqueue': {
        const index = ui.pending.findIndex((c) => c.id === d.command);
        if (index < 0) return;
        ui.pending.splice(index, 1);
        ui.flash = null;
        render();
        ignoreClicksUntil = Date.now() + 500;
        return;
      }
      case 'map-mode':
        mapMode = d.mode === 'world' ? 'world' : 'route';
        if (!mapMarks(view, config, mapMode).some((m) => m.key === mapPick)) mapPick = null;
        mapNear = [];
        return render();
      case 'map-near':
        return pickMapMark(d.mark ?? null, true);
      case 'map-close':
        mapPick = null;
        mapNear = [];
        render(true);
        revealOpener(document.getElementById('map-pick'));
        ignoreClicksUntil = Date.now() + 500;
        return;
      case 'select-card':
        detailUnder = el.tagName === 'ARTICLE' ? 'card' : 'roster';
        ui.selectedCard = d.emp ?? null;
        render();
        showGrowthControl();
        return;
      case 'crew-filter':
        ui.crewFilter = d.filter === 'free' || d.filter === 'busy' || d.filter === 'candidate' ? d.filter : 'all';
        return render();
      case 'accept-plan': {
        const base = offerCommands[d.key!];
        if (!base || (base.type !== 'ACCEPT_TRADE' && base.type !== 'ACCEPT_FORWARDING')) return;
        return queue({ ...base, id: newId('PLAN'), plan: { ...ui.plans[d.key!] } });
      }
      case 'restart':
        if (config.operations && !opsScreens) throw new Error('규칙 2 화면 묶음을 먼저 불러와야 합니다.');
        if (!confirm('처음부터 시작하면 현재 진행과 오늘 할 일이 사라집니다. 다시 시작할까요?')) return;
        if (config.operations && state.operations?.outcome === 'FAILED') {
          state = openDay(restartWithSameSeed(state, config), config).state;
          resetUi();
          savedState = state;
        } else startScenario(config.id as AnyScenarioId);
        return render();
      case 'save':
        try {
          localStorage.setItem(SAVE_KEY, serializeSave(state));
          savedState = state;
          ui.flash = { kind: 'info', text: `${Math.min(state.day, config.campaignDays)}일 상태를 이 브라우저에 저장했습니다. 대기 중인 명령은 저장하지 않습니다.` };
        } catch {
          ui.flash = { kind: 'warn', text: '이 브라우저에서는 저장할 수 없습니다. ‘내보내기’로 파일을 받아 두세요.' };
        }
        return render();
      case 'load': {
        let text: string | null = null;
        try {
          text = localStorage.getItem(SAVE_KEY) ?? localStorage.getItem(LEGACY_SAVE_KEY);
        } catch {
          text = null;
        }
        if (text && !confirm('불러오면 현재 진행과 오늘 할 일이 사라집니다. 저장된 상태를 불러올까요?')) return;
        return text ? loadText(text, true) : ((ui.flash = { kind: 'warn', text: '저장된 상태가 없습니다.' }), render());
      }
      case 'export': {
        const blob = new Blob([serializeSave(state)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `scitrade-${config.id}-day${state.day}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        savedState = state;
        return;
      }
    }
  } finally { activation = null; }
});

app.addEventListener('keydown', (ev) => {
  const el = ev.target as HTMLElement;
  if (!(el instanceof HTMLButtonElement) && el.dataset.action === 'select-card' && (ev.key === 'Enter' || ev.key === ' ')) {
    ev.preventDefault();
    detailUnder = el.tagName === 'ARTICLE' ? 'card' : 'roster';
    ui.selectedCard = el.dataset.emp ?? null;
    render();
    showGrowthControl();
  }
});

app.addEventListener('change', async (ev) => {
  if (opsScreens?.path11Change(ev, view, config, ui, render, liveStatus, liveRegionText)) return;
  const el = ev.target as HTMLInputElement | HTMLSelectElement;
  if (el.dataset.action === 'scenario') {
    if (!confirm('시나리오를 바꾸면 현재 진행과 오늘 할 일이 사라집니다. 바꿀까요?')) {
      el.value = config.id;
      return;
    }
    if (enteringScenario) { el.value = config.id; return; }
    const id = el.value as AnyScenarioId;
    enteringScenario = true;
    try {
      if (isOperationsScenario(id) && !opsScreens) await ensureOpsScreens();
      startScenario(id);
      render();
    } catch (error) {
      el.value = config.id;
      screenLoadWarning(error);
    } finally { enteringScenario = false; }
  } else if (el.dataset.action === 'offer-quantity') {
    const buy = offerDef(view, config, el.dataset.key!.split('+')[0]!);
    const sell = offerDef(view, config, el.dataset.key!.split('+')[1]!);
    const key = el.dataset.key!;
    const before = buy && sell ? quoteCheck(quotePreview(view, config, { buyOfferId: buy.id, sellOfferId: sell.id }, ui.offerQuantities[key] ?? buy.quantity), offerCommands[key]!).status === 'APPLIED' : false;
    const quantity = Number(el.value);
    if (buy && sell && Number.isInteger(quantity) && quantity >= buy.quantity && quantity <= Math.min(buy.maxQuantity, sell.maxQuantity) && (quantity - buy.quantity) % buy.quantityStep === 0) ui.offerQuantities[el.dataset.key!] = quantity;
    render();
    if (buy && sell) {
      const check = quoteCheck(quotePreview(view, config, { buyOfferId: buy.id, sellOfferId: sell.id }, ui.offerQuantities[key] ?? buy.quantity), offerCommands[key]!);
      if (before !== (check.status === 'APPLIED')) liveStatus.textContent = liveRegionText(liveStatus.textContent ?? '',
        `수량 ${qtyKo(buy.goodId, ui.offerQuantities[key] ?? buy.quantity)}: ${check.status === 'APPLIED' ? '수락할 수 있습니다' : `수락할 수 없습니다 — ${check.reasonKo}`}`);
    }
  } else if (el.dataset.action === 'exchange-direction' || el.dataset.action === 'exchange-amount') {
    if (el.dataset.action === 'exchange-direction') ui.exchangeDirection = el.value === 'KRW_TO_USD' ? 'KRW_TO_USD' : 'USD_TO_KRW';
    else if (/^[0-9]+$/.test(el.value) && Number.isSafeInteger(Number(el.value))) ui.exchangeLots = Number(el.value);
    const adjustment = exchangeAdjustment(view, ui.exchangeLots);
    render();
    if (adjustment) liveStatus.textContent = liveRegionText(liveStatus.textContent ?? '', adjustment);
  } else if (el.dataset.action === 'map-pick') {
    pickMapMark(el.value || null);
  } else if (el.dataset.action === 'crew-role' || el.dataset.action === 'crew-attr') {
    if (el.dataset.action === 'crew-role') ui.crewRole = el.value || null;
    else ui.crewAttribute = el.value || null;
    render();
  } else if (el.dataset.action === 'recruit-emp') {
    ui.recruitSelections[el.dataset.key!] = el.value;
    render();
  } else if (el.dataset.action === 'plan-emp' || el.dataset.action === 'plan-sailing') {
    const key = el.dataset.key!;
    const plan = { ...(ui.plans[key] ?? {}) };
    const value = el.value || undefined;
    if (el.dataset.action === 'plan-emp') plan.employeeId = value;
    else plan.sailingId = value;
    ui.plans[key] = plan;
    ui.touchedPlans.add(key);
    render();
  } else if (el.dataset.action === 'import' && el instanceof HTMLInputElement && el.files?.[0]) {
    if (!confirm('가져오면 현재 진행과 오늘 할 일이 사라집니다. 파일을 불러올까요?')) { el.value = ''; return; }
    await loadText(await el.files[0].text());
  }
});

async function loadText(text: string, fromSave = false) {
  if (enteringScenario) return;
  let scenarioId: string | undefined;
  try { scenarioId = JSON.parse(text)?.scenarioId; } catch {}
  if (scenarioId && (LOADABLE_SCENARIO_IDS as readonly string[]).includes(scenarioId) && isOperationsScenario(scenarioId) && !opsScreens) {
    enteringScenario = true;
    try { await ensureOpsScreens(); }
    catch (error) { screenLoadWarning(error, fromSave); return; }
    finally { enteringScenario = false; }
  }
  const loaded = loadSaveText(text);
  if ('errorKo' in loaded) {
    ui.flash = { kind: 'warn', text: loaded.errorKo };
  } else {
    config = loaded.config;
    state = loaded.state;
    savedState = state;
    resetUi();
    ui.flash = { kind: 'info', text: `${config.titleKo} ${Math.min(state.day, config.campaignDays)}일 상태를 불러왔습니다. 이미 공개된 사건은 다시 적용하지 않습니다.` };
  }
  render();
}

export const initialScreenReady = (async () => {
  if (isOperationsScenario('SCENARIO_M2_OPS_CREDIT')) await ensureOpsScreens();
  startScenario('SCENARIO_M2_OPS_CREDIT');
  render();
})().catch(() => {
  app.innerHTML = `<p class="flash warn">${SCREEN_LOAD_WARNING}</p><button data-action="reload">새로 고침</button>`;
});

// 첫 렌더 뒤 자개 틀만 받는다. 실패하면 기존 금선 틀을 유지한다.
const loadNajeon = () => { void import('./card-najeon.css').catch(() => undefined); };
if (window.requestIdleCallback) window.requestIdleCallback(loadNajeon);
else setTimeout(loadNajeon, 0);

// 첫 그리기를 마친 뒤 한가할 때 받는다. 실패는 진입점에서 다시 시도한다.
const prefetchScreens = () => {
  void Promise.all([ensureOpsScreens(), ensureCulturePanel()]).catch(() => console.warn(SCREEN_LOAD_WARNING));
};
if (window.requestIdleCallback) window.requestIdleCallback(prefetchScreens);
else setTimeout(prefetchScreens, 1);
