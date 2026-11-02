import { unaffordableRecords } from './unaffordable';
import { carryAccrued, defaultFor, divHalfAway, isRiskRules, claimFor, collectionPlan, receivedForInvoice, dutyFor, surchargeBp, surchargeWeek, tariffSchedule } from './risk';
import { batchZero, generateBatch, offerDef, prepWorkUnitsFor } from './market';
import { allocateHandling, applyOperationsCommand, storageShortfall, fixedCostsDue, processPaymentDefault, lateDeliveryReduction } from './operations';
// 하루 단위 경제 엔진 (M1 거래 한 건 + M2a 복수 계약·운송 주선·자원 예약).
// openDay: 당일 사건을 한 번 적용·공개하고 입력을 기다린다.
// commitDay: 명령 검증·실행부터 운송·인도·결제·마감까지 고정 순서로 처리한다.
// 두 함수 모두 입력 상태를 바꾸지 않고 새 상태를 돌려준다. 현재 시각·네트워크·Math.random을 쓰지 않는다.

import {
  cargoSpace,
  cityName,
  findSailing,
  goodOf,
  listSailings,
  routeBetween,
  routeOf,
  unitKo,
  type Sailing,
} from './catalog';
import { balance, contractAmount, emptyLedger, post, type LedgerLine } from './ledger';
import { applyBasisPoints, formatMoney, type Currency } from './money';
import { cashLessUnpaidMinor, trainingAvailableMinor, fundsPosition, runningTaskOf, spaceShortfall, type CashReservation, type FundsPosition } from './reservations';
import { createRng } from './rng';
import {
  ENGINE_VERSION,
  EngineError,
  type Booking,
  type EngineCommand,
  type CommandResult,
  type CommitPlan,
  type Contract,
  type CreditTermId,
  type GameState,
  type Notice,
  type OfferDef,
  type ScenarioConfig,
  type Shipment,
  type Task,
} from './types';
import { isEmployed, isAvailableFromToday } from './employees';
import { checkInvariants } from './invariants';
import { cultureKeys, recordCultureCompletion } from './culture';
import { awardTaskCompletion } from './growth';
import { isDayBasedTask, taskSubjectKo } from './tasks';

export { cargoSpace, cityName, findSailing, listSailings, type Sailing } from './catalog';

export { EngineError } from './types';

const clone = <T>(value: T): T => structuredClone(value);
const pad = (n: number, width = 3) => String(n).padStart(width, '0');

// ── 생성 ──

export function createGame(config: ScenarioConfig): GameState {
  const ledger = emptyLedger();
  for (const [currency, minor] of Object.entries(config.startingCash) as [Currency, number][]) {
    if (!minor) continue;
    post(ledger, {
      id: `OPENING-${currency}`,
      day: 0,
      currency,
      lines: [
        { account: 'CASH', amount: minor },
        { account: 'OPENING_EQUITY', amount: -minor },
      ],
      reason: '시작 자금',
    });
  }
  return {
    meta: {
      engineVersion: ENGINE_VERSION,
      rulesVersion: config.rules.rulesVersion,
      dataVersion: config.dataVersion,
      scenarioId: config.id,
    },
    day: 1,
    phase: 'PENDING_OPEN',
    rng: createRng(config.seed),
    ledger,
    offers: config.offers.map((o) => ({ id: o.id, status: 'OPEN' as const })),
    contracts: [],
    cargoLots: [],
    bookings: [],
    shipments: [],
    tasks: [],
    employees: config.employees.map((e) => ({
      id: e.id,
      xp: e.growth?.startXp ?? 0,
      locationCityId: e.homeCityId,
      employmentStatus: config.recruitment?.candidateEmployeeIds.includes(e.id) ? 'candidate' as const : 'employed' as const,
      availableFromDay: 1,
    })),
    recruitment: {
      candidates: (config.recruitment?.candidateEmployeeIds ?? []).map((employeeId) => ({
        employeeId, stage: 'UNDISCOVERED', discoveredDay: null, questTaskId: null,
        interviewReadyDay: null, hiredDay: null,
      })),
      scoutedVenueIds: [],
    },
    culture: { reports: [], experiences: [], relationEvents: [] },
    operations: config.operations ? { ...(config.rules.rulesVersion === 'M2a-rules-4' ? { unaffordable: [] } : {}), batches: [batchZero(config)], offers: [], expansions: [], handlingLog: [], spaceContracts: [], exchanges: [], defaultEvents: [], outcome: 'IN_PROGRESS', failure: null } : null,
    invoices: [],
    obligations: [],
    notices: [],
    delayDecisions: [],
    appliedEventIds: {},
    xpAwards: {},
    xpAwardAmounts: {},
    processedCommands: {},
    closedDays: [],
    log: [],
  };
}

/** 예약한 출항편들이 차지한 무게·부피 합계 (취소된 예약 제외). */
export function bookedSpace(state: GameState, sailingId: string) {
  let massGrams = 0;
  let volumeLiters = 0;
  for (const b of state.bookings) {
    if (b.sailingId !== sailingId || b.status === 'CANCELLED') continue;
    massGrams += b.massGrams;
    volumeLiters += b.volumeLiters;
  }
  return { massGrams, volumeLiters };
}

// ── 일자 시작 ──

export function openDay(state: GameState, config: ScenarioConfig): { state: GameState; announcements: Notice[] } {
  // 이미 열린 날을 다시 열면 사건을 재적용하지 않는다.
  if (state.phase !== 'PENDING_OPEN') return { state, announcements: [] };
  const s = clone(state);
  const announcements: Notice[] = [];
  for (const r of config.portRestrictions) {
    if (r.announceDay !== s.day || s.appliedEventIds[r.eventInstanceId]) continue;
    const affected = s.shipments.filter(
      (sh) => sh.arrivalDay === null && contractOf(s, sh.contractId).destinationCityId === r.cityId,
    );
    const notice: Notice = {
      id: `NOTICE-${r.eventInstanceId}`,
      day: s.day,
      kind: 'PORT_RESTRICTION',
      eventInstanceId: r.eventInstanceId,
      titleKo: `${cityName(config, r.cityId)}항 하역 중단 예보`,
      bodyKo: `${r.forecastKo}. 이 기간에는 입항 선박이 하역하지 못하고 대기합니다. 지연은 실제로 기다린 날만큼 누적되며 미리 더하지 않습니다.`,
      affectedShipmentIds: affected.map((sh) => sh.id),
      evidenceKo: '시나리오에 고정된 가상 항만 공지(DESIGN). 실제 기상 자료가 아니며, M1에서는 예보와 실제 제한이 같습니다.',
    };
    s.notices.push(notice);
    for (const sh of affected) {
      s.delayDecisions.push({ noticeId: notice.id, shipmentId: sh.id, choice: null, decidedDay: null });
    }
    s.appliedEventIds[r.eventInstanceId] = true;
    announcements.push(notice);
    log(s, `항만 공지: ${notice.titleKo} (영향 화물 ${affected.length}건)`);
  }
  for (const event of tariffSchedule(s, config)) if (event.noticeDay === s.day) log(s, event.labelKo);
  if (s.meta.rulesVersion === 'M2a-rules-4') s.operations!.unaffordable!.push(...unaffordableRecords(s, config));
  s.phase = 'AWAITING_INPUT';
  return { state: s, announcements };
}

// ── 명령 ──

/** 상태를 바꾸지 않고 같은 날 대기 중인 명령들을 누적 검증한다. */
export function planCommands(state: GameState, config: ScenarioConfig, commands: EngineCommand[]): CommandResult[] {
  return planState(state, config, commands).results;
}

/**
 * 대기 명령을 실행했다고 가정한 사본 상태. 화면이 ‘오늘 실행 예정’인 계약·예약을 보여 줄 때 쓴다.
 * 날짜·운송·결제는 진행하지 않으며 원래 상태는 바뀌지 않는다.
 */
export function planState(
  state: GameState,
  config: ScenarioConfig,
  commands: EngineCommand[],
): { state: GameState; results: CommandResult[] } {
  const s = clone(state);
  const results = commands.map((cmd) => applyCommand(s, config, cmd));
  return { state: s, results };
}

function applyCommand(s: GameState, config: ScenarioConfig, cmd: EngineCommand): CommandResult {
  if (s.processedCommands[cmd.id]) {
    return { commandId: cmd.id, status: 'DUPLICATE', reasonKo: '이미 처리한 명령 ID입니다. 다시 실행하지 않습니다.' };
  }
  let rejection: string | null;
  if (config.operations && s.phase !== 'AWAITING_INPUT') {
    rejection = s.phase === 'ENDED' ? (s.operations?.outcome === 'FAILED' ? '캠페인이 끝났습니다(경영 실패).' : '캠페인이 끝났습니다.') : '하루를 연 뒤에 명령을 실행할 수 있습니다.';
  } else switch (cmd.type) {
    case 'EXCHANGE_CURRENCY':
    case 'EXPAND_WAREHOUSE':
    case 'SIGN_SPACE_CONTRACT':
      rejection = applyOperationsCommand(s, config, cmd);
      break;
    case 'START_CULTURE_ACTIVITY':
      rejection = startCultureActivity(s, config, cmd.activityId, cmd.employeeId);
      break;
    case 'START_TRAINING':
      rejection = startTraining(s, config, cmd.employeeId);
      break;
    case 'ACCEPT_TRADE':
      rejection = withPlan(s, config, cmd.plan, (t) => acceptTrade(t, config, cmd.buyOfferId, cmd.sellOfferId, cmd.quantity, cmd.creditTermId));
      break;
    case 'ACCEPT_FORWARDING':
      rejection = withPlan(s, config, cmd.plan, (t) => acceptForwarding(t, config, cmd.offerId));
      break;
    case 'SCOUT_SITE':
      rejection = scoutSite(s, config, cmd.venueId, cmd.employeeId);
      break;
    case 'START_RECRUIT_QUEST':
      rejection = startRecruitQuest(s, config, cmd.candidateId, cmd.employeeId);
      break;
    case 'HIRE_CANDIDATE':
      rejection = hireCandidate(s, config, cmd.candidateId);
      break;
    case 'ASSIGN_TASK':
      rejection = assignTask(s, config, cmd.taskId, cmd.employeeId);
      break;
    case 'BOOK_SAILING':
      rejection = bookSailing(s, config, cmd.contractId, cmd.sailingId);
      break;
    case 'CANCEL_CONTRACT':
      rejection = cancelContract(s, config, cmd.contractId);
      break;
    case 'RESPOND_TO_DELAY':
      rejection = respondToDelay(s, cmd.noticeId, cmd.shipmentId);
      break;
  }
  const status = rejection === null ? 'APPLIED' : 'REJECTED';
  const reasonKo = rejection ?? '처리됨';
  s.processedCommands[cmd.id] = { day: s.day, type: cmd.type, status, reasonKo };
  return { commandId: cmd.id, status, reasonKo };
}

/**
 * REF-02 일괄 확정: 수락 → 준비 배정 → 운송편 예약을 사본에서 차례로 시험하고, 모두 성공할 때만 반영한다.
 * 일부만 성공한 상태(수락했지만 배를 못 잡은 계약 등)를 남기지 않는다. 계획이 없으면 수락만 한다.
 */
function withPlan(
  s: GameState,
  config: ScenarioConfig,
  plan: CommitPlan | undefined,
  accept: (target: GameState) => string | null,
): string | null {
  if (!plan || (!plan.employeeId && !plan.sailingId)) return accept(s);
  const trial = clone(s);
  const rejected = accept(trial);
  if (rejected) return rejected;
  const contract = trial.contracts[trial.contracts.length - 1]!;
  if (plan.employeeId) {
    const r = assignTask(trial, config, contract.prepTaskId, plan.employeeId);
    if (r) return `한 번에 확정할 수 없습니다 — 준비 배정 불가: ${r} 견적도 수락하지 않습니다.`;
  }
  if (plan.sailingId) {
    const r = bookSailing(trial, config, contract.id, plan.sailingId);
    if (r) return `한 번에 확정할 수 없습니다 — 운송편 예약 불가: ${r} 견적도 수락하지 않습니다.`;
  }
  Object.assign(s, trial);
  return null;
}

function offerOpen(s: GameState, offer: OfferDef): string | null {
  const st = s.offers.find((o) => o.id === offer.id);
  if (!st || st.status !== 'OPEN') return `견적 ${offer.id}은(는) 더 이상 유효하지 않습니다.`;
  if (offer.validUntilDay < s.day) return `견적 ${offer.id}의 유효기간(${offer.validUntilDay}일)이 지났습니다.`;
  return null;
}

/** COMMITTED_OUTLAYS 규칙의 자금 부족 설명. 충분하면 null. */
function fundsShortfall(
  s: GameState,
  config: ScenarioConfig,
  currency: Currency,
  needMinor: number,
  breakdownKo: string,
  exclude?: (r: CashReservation) => boolean,
): string | null {
  return fundsShortfallText(currency, needMinor, breakdownKo, fundsPosition(s, config, currency, exclude));
}

function fundsShortfallText(currency: Currency, needMinor: number, breakdownKo: string, f: FundsPosition): string | null {
  if (f.available >= needMinor) return null;
  const parts = [`현금 ${formatMoney(currency, f.cash)}`];
  const contractsReserved = f.reserved - f.reservedCommitments;
  if (contractsReserved) parts.push(`다른 계약 예약 ${formatMoney(currency, contractsReserved)}`);
  if (f.reservedCommitments) parts.push(`선복 계약 요금 예약 ${formatMoney(currency, f.reservedCommitments)}`);
  if (f.unpaidObligations) parts.push(`미지급 ${formatMoney(currency, f.unpaidObligations)}`);
  return `사용 가능 자금이 부족합니다. 필요 ${formatMoney(currency, needMinor)}(${breakdownKo}), 사용 가능 ${formatMoney(currency, f.available)} = ${parts.join(' − ')}. 체결한 계약의 남은 운임·관세는 미리 묶어 둡니다.`;
}

function nextContractIds(s: GameState) {
  const n = s.contracts.length + 1;
  return { contractId: `CT${pad(n)}`, lotId: `LOT${pad(n)}`, taskId: `TASK${pad(n)}` };
}

export interface CreditTermCheck {
  allowed: boolean; reasonKo: string | null; saleAmountMinor: number; paymentDueDay: number;
  grade: string; limitMinor: number; exposureMinor: number;
  dateRule: boolean; limitBlocked: ('D15' | 'D30')[];
}

/** 인수와 공개 선택지가 공유하는 순수 판정. 자금·수량 검사는 인수 경로가 이어서 한다. */
export function creditTermCheck(s: GameState, config: ScenarioConfig, buyOfferId: string, sellOfferId: string,
  quantity: number, termId?: CreditTermId): CreditTermCheck {
  const buy = offerDef(s, config, buyOfferId), sell = offerDef(s, config, sellOfferId);
  const due = config.terms.paymentDueDay ?? sell?.paymentDueDay ?? config.campaignDays;
  const result: CreditTermCheck = { allowed: true, reasonKo: null, saleAmountMinor: (sell?.unitPriceMinor ?? 0) * quantity,
    paymentDueDay: due, grade: '', limitMinor: 0, exposureMinor: 0, dateRule: false, limitBlocked: [] };
  const reject = (reasonKo: string): CreditTermCheck => ({ ...result, allowed: false, reasonKo });
  if (!buy || !sell || buy.kind !== 'supplier' || sell.kind !== 'customer') return reject('이 시나리오에 없는 견적입니다.');
  if (config.rules.rulesVersion !== 'M2a-rules-4') {
    return termId === undefined ? result : reject('외상 조건은 이 규칙에서 쓸 수 없습니다');
  }
  const risk = config.operations?.risk, credit = risk?.credit;
  if (!credit || credit.profileId !== risk.profile.id) throw new Error('외상 설정이 없거나 위험 프로필과 다릅니다');
  const grade = risk.profile.collections.byCounterparty.find((r) => r.counterpartyId === sell.counterpartyId)?.grade;
  const limit = credit.limits.find((r) => r.grade === grade);
  if (!grade || !limit) throw new Error(`외상 등급·한도가 없습니다: ${sell.counterpartyId}`);
  result.grade = grade; result.limitMinor = limit.limitMinor;
  result.exposureMinor = s.contracts.filter((c) => c.kind === 'DIRECT_TRADE' && c.customerId === sell.counterpartyId
    && c.creditTermId !== undefined && c.creditTermId !== 'BASE'
    && (c.status === 'ACTIVE' || c.status === 'IN_PROGRESS')
    && (c.invoiceId === null || s.invoices.some((i) => i.id === c.invoiceId && (i.status === 'OUTSTANDING' || i.status === 'OVERDUE'))))
    .reduce((sum, c) => sum + c.saleAmountMinor, 0);
  const amount = (t: typeof credit.terms[number]) => {
    const n = sell.unitPriceMinor * quantity * (10000 + t.premiumBp);
    // 잘못된 수량은 기존 인수 검사에서 사유와 함께 거절한다.
    return Number.isSafeInteger(n) ? divHalfAway(n, 10000) : n / 10000;
  };
  const fitsDate = (t: typeof credit.terms[number]) => due + t.days + risk.profile.collections.lateMaxDays <= config.campaignDays;
  const fitsLimit = (t: typeof credit.terms[number]) => result.exposureMinor + amount(t) <= limit.limitMinor;
  for (const id of ['D15', 'D30'] as const) {
    const t = credit.terms.find((t) => t.id === id);
    if (!t) throw new Error(`외상 조건이 없습니다: ${id}`);
    if (fitsDate(t)) {
      result.dateRule = true;
      if (!fitsLimit(t)) result.limitBlocked.push(id);
    }
  }
  const term = credit.terms.find((t) => t.id === (termId ?? 'BASE'));
  if (!term) return reject('알 수 없는 외상 조건입니다');
  result.saleAmountMinor = amount(term); result.paymentDueDay = due + term.days;
  if (term.id !== 'BASE' && !fitsDate(term)) return reject('외상 기간이 캠페인 안에 끝나지 않습니다');
  if (term.id !== 'BASE' && !fitsLimit(term)) return reject('외상 한도 초과');
  return result;
}

export interface TradeFundsCheck {
  rule: 'IMMEDIATE_CASH' | 'SAME_CURRENCY' | 'SPLIT_CURRENCY';
  needs: { currency: Currency; needMinor: number; availableMinor: number; position: FundsPosition | null;
    parts: { purchaseMinor?: number; feeMinor?: number; dutyMinor?: number } }[];
}

/** 인수와 공개일 기록이 공유하는 순수 자금 계산. */
export function tradeFundsCheck(s: GameState, config: ScenarioConfig, buy: OfferDef, sell: OfferDef, quantity: number): TradeFundsCheck {
  const purchaseMinor = buy.unitPriceMinor * quantity;
  if (config.rules.fundsCheck === 'IMMEDIATE_CASH') return { rule: 'IMMEDIATE_CASH', needs: [{
    currency: buy.currency, needMinor: purchaseMinor, availableMinor: balance(s.ledger, buy.currency, 'CASH'),
    position: null, parts: { purchaseMinor },
  }] };
  const route = routeBetween(config, buy.cityId, sell.cityId)!;
  const feeMinor = route.bookingFeeMinor;
  const dutyMinor = dutyFor(config, s.rng.seed, buy.goodId, sell.cityId,
    listSailings(config, route.id, s.day + 1)[0]?.scheduledArrivalDay ?? s.day, s.day, purchaseMinor, buy.currency, s.day);
  const need = (currency: Currency, parts: TradeFundsCheck['needs'][number]['parts']) => {
    const position = fundsPosition(s, config, currency);
    return { currency, needMinor: Object.values(parts).reduce((sum, v) => sum + v, 0), availableMinor: position.available, position, parts };
  };
  return buy.currency === sell.currency
    ? { rule: 'SAME_CURRENCY', needs: [need(buy.currency, { purchaseMinor, feeMinor, dutyMinor })] }
    : { rule: 'SPLIT_CURRENCY', needs: [need(buy.currency, { purchaseMinor }), need(sell.currency, { feeMinor, dutyMinor })] };
}

function acceptTrade(s: GameState, config: ScenarioConfig, buyOfferId: string, sellOfferId: string, requestedQuantity?: number, creditTermId?: CreditTermId): string | null {
  const buy = offerDef(s, config, buyOfferId);
  const sell = offerDef(s, config, sellOfferId);
  if (!buy || !sell || buy.kind !== 'supplier' || sell.kind !== 'customer') return '이 시나리오에 없는 견적입니다.';
  for (const offer of [buy, sell]) {
    const closed = offerOpen(s, offer);
    if (closed) return closed;
  }
  const quantity = requestedQuantity ?? buy.quantity;
  const credit = creditTermCheck(s, config, buyOfferId, sellOfferId, quantity, creditTermId);
  if (!credit.allowed) return credit.reasonKo;
  if (config.operations) {
    if (buy.goodId !== sell.goodId || buy.publishDay !== sell.publishDay) return '같은 묶음·같은 상품의 매입·판매만 묶을 수 있습니다.';
    if (!Number.isSafeInteger(quantity) || quantity < buy.quantityStep || quantity > Math.min(buy.maxQuantity, sell.maxQuantity) || quantity % buy.quantityStep !== 0) {
      return `수량은 ${buy.quantityStep}${unitKo(goodOf(config, buy.goodId))} 단위로 ${buy.quantityStep} ~ ${Math.min(buy.maxQuantity, sell.maxQuantity)}${unitKo(goodOf(config, buy.goodId))}까지 고를 수 있습니다.`;
    }
  } else if (buy.goodId !== sell.goodId || buy.quantity !== sell.quantity || quantity !== buy.quantity) return '같은 상품·같은 수량의 매입·판매만 묶을 수 있습니다 (분할 거래는 이후 단계).';
  if (buy.currency !== sell.currency && !isRiskRules(config.rules.rulesVersion)) return '매입과 판매의 통화가 다릅니다.';
  const route = routeBetween(config, buy.cityId, sell.cityId);
  if (!route) return '두 항구를 잇는 노선이 없습니다.';

  const purchase = buy.unitPriceMinor * quantity;
  const funds = tradeFundsCheck(s, config, buy, sell, quantity);
  const shortages = funds.needs.map((need) => {
    const { currency, needMinor, availableMinor, position, parts } = need;
    if (availableMinor >= needMinor) return null;
    if (funds.rule === 'IMMEDIATE_CASH') {
      return `매입 자금이 부족합니다. 필요 ${formatMoney(currency, needMinor)}, 사용 가능 ${formatMoney(currency, availableMinor)}.`;
    }
    const breakdown = [
      parts.purchaseMinor === undefined ? null : `매입 ${formatMoney(currency, parts.purchaseMinor)}`,
      parts.feeMinor === undefined ? null : `운임 ${formatMoney(currency, parts.feeMinor)}`,
      parts.dutyMinor === undefined ? null : `관세 ${formatMoney(currency, parts.dutyMinor)}`,
    ].filter((v) => v !== null).join(' + ');
    return fundsShortfallText(currency, needMinor, breakdown, position!);
  }).filter(Boolean);
  if (shortages.length) return shortages.join(' ');

  const storage = storageShortfall(s, config, buy.goodId, quantity);
  if (storage) return storage;
  const good = goodOf(config, buy.goodId);
  const { contractId, lotId, taskId } = nextContractIds(s);
  const contract: Contract = {
    id: contractId,
    kind: 'DIRECT_TRADE',
    status: 'ACTIVE',
    buyOfferId: buy.id,
    sellOfferId: sell.id,
    serviceOfferId: null,
    supplierId: buy.counterpartyId,
    customerId: sell.counterpartyId,
    goodId: buy.goodId,
    quantity: quantity,
    purchaseAmountMinor: purchase,
    saleAmountMinor: credit.saleAmountMinor,
    ...(config.rules.rulesVersion === 'M2a-rules-4' ? {
      creditTermId: creditTermId ?? 'BASE',
      creditEligible: { dateRule: credit.dateRule, limitBlocked: credit.limitBlocked },
    } : {}),
    currency: sell.currency,
    originCityId: buy.cityId,
    destinationCityId: sell.cityId,
    deliveryDeadlineDay: config.terms.deliveryDeadlineDay ?? sell.deliveryDeadlineDay ?? config.campaignDays,
    paymentDueDay: credit.paymentDueDay,
    acceptedDay: s.day,
    ownerEmployeeId: null,
    cargoLotId: lotId,
    prepTaskId: taskId,
    bookingId: null,
    invoiceId: null,
    deliveredDay: null,
    lateDays: 0,
    priceReductionMinor: 0,
    cancelledDay: null,
    completedDay: null,
  };
  s.contracts.push(contract);
  s.cargoLots.push({
    id: lotId,
    owner: 'COMPANY',
    ownerPartyId: null,
    goodId: buy.goodId,
    quantity: quantity,
    originCountryCode: buy.originCountryCode ?? config.cities.find((c) => c.id === buy.cityId)?.countryCode ?? 'UNKNOWN',
    carryingAmountMinor: purchase,
    currency: buy.currency,
    locationCityId: buy.cityId,
    status: 'PREPARING',
    contractId,
    shipmentId: null,
  });
  s.tasks.push({
    id: taskId,
    kind: 'EXPORT_PREP',
    contractId,
    subjectId: null,
    cityId: buy.cityId,
    requiredWorkUnits: prepWorkUnitsFor(config, buy, quantity),
    progressWorkUnits: 0,
    status: 'QUEUED',
    assignedEmployeeId: null,
    startedDay: null,
    completedDay: null,
  });
  postOrThrow(s, {
    id: `PURCHASE-${contractId}`,
    currency: buy.currency,
    contractId,
    reason: `${good.nameKo} ${quantity}${unitKo(good)} 매입 (현금 → 재고)`,
    lines: [
      { account: 'INVENTORY', amount: purchase },
      { account: 'CASH', amount: -purchase },
    ],
  });
  for (const st of s.offers) if (st.id === buy.id || st.id === sell.id) st.status = 'ACCEPTED';
  log(s, config.operations ? `계약 ${contractId} 체결: ${config.operations.market.counterparties.find((p) => p.id === buy.counterpartyId)!.nameKo} → ${config.operations.market.counterparties.find((p) => p.id === sell.counterpartyId)!.nameKo}, ${good.nameKo} ${quantity}${unitKo(good)} 매입 ${formatMoney(buy.currency, purchase)} 현금 지급, 판매 ${formatMoney(sell.currency, contract.saleAmountMinor)} (납기 ${contract.deliveryDeadlineDay}일)` : `계약 ${contractId} 체결: ${good.nameKo} ${quantity}${unitKo(good)} 매입 ${formatMoney(buy.currency, purchase)} 현금 지급, 판매 ${formatMoney(sell.currency, contract.saleAmountMinor)} (납기 ${contract.deliveryDeadlineDay}일)`);
  return null;
}

function acceptForwarding(s: GameState, config: ScenarioConfig, offerId: string): string | null {
  if (!config.rules.forwardingEnabled) return '이 시나리오에서는 운송 주선을 받지 않습니다 (M2 기능).';
  const offer = offerDef(s, config, offerId);
  if (!offer || offer.kind !== 'forwarding' || !offer.destinationCityId) return '이 시나리오에 없는 운송 주선 의뢰입니다.';
  const closed = offerOpen(s, offer);
  if (closed) return closed;
  const route = routeBetween(config, offer.cityId, offer.destinationCityId);
  if (!route) return '두 항구를 잇는 노선이 없습니다.';
  if (route.currency !== offer.currency) return '서비스 대금과 운임의 통화가 다릅니다.';
  if (config.rules.fundsCheck === 'COMMITTED_OUTLAYS') {
    const short = fundsShortfall(s, config, offer.currency, route.bookingFeeMinor, `운임 ${formatMoney(offer.currency, route.bookingFeeMinor)}`);
    if (short) return short;
  }

  const storage = storageShortfall(s, config, offer.goodId, offer.quantity);
  if (storage) return storage;
  const good = goodOf(config, offer.goodId);
  const { contractId, lotId, taskId } = nextContractIds(s);
  s.contracts.push({
    id: contractId,
    kind: 'FORWARDING',
    status: 'ACTIVE',
    buyOfferId: null,
    sellOfferId: null,
    serviceOfferId: offer.id,
    supplierId: null,
    customerId: offer.counterpartyId,
    goodId: offer.goodId,
    quantity: offer.quantity,
    purchaseAmountMinor: 0,
    saleAmountMinor: offer.serviceFeeMinor,
    currency: offer.currency,
    originCityId: offer.cityId,
    destinationCityId: offer.destinationCityId,
    deliveryDeadlineDay: offer.deliveryDeadlineDay ?? config.campaignDays,
    paymentDueDay: offer.paymentDueDay ?? config.campaignDays,
    acceptedDay: s.day,
    ownerEmployeeId: null,
    cargoLotId: lotId,
    prepTaskId: taskId,
    bookingId: null,
    invoiceId: null,
    deliveredDay: null,
    lateDays: 0,
    priceReductionMinor: 0,
    cancelledDay: null,
    completedDay: null,
  });
  // 고객 소유 화물: 회사 재고 장부에 올리지 않는다 (장부가액 0).
  s.cargoLots.push({
    id: lotId,
    owner: 'CUSTOMER',
    ownerPartyId: offer.counterpartyId,
    goodId: offer.goodId,
    quantity: offer.quantity,
    originCountryCode: offer.originCountryCode ?? config.cities.find((c) => c.id === offer.cityId)?.countryCode ?? 'UNKNOWN',
    carryingAmountMinor: 0,
    currency: offer.currency,
    locationCityId: offer.cityId,
    status: 'PREPARING',
    contractId,
    shipmentId: null,
  });
  s.tasks.push({
    id: taskId,
    kind: 'FORWARDING_PREP',
    contractId,
    subjectId: null,
    cityId: offer.cityId,
    requiredWorkUnits: prepWorkUnitsFor(config, offer, offer.quantity),
    progressWorkUnits: 0,
    status: 'QUEUED',
    assignedEmployeeId: null,
    startedDay: null,
    completedDay: null,
  });
  for (const st of s.offers) if (st.id === offer.id) st.status = 'ACCEPTED';
  log(s, config.operations ? `계약 ${contractId} 체결(운송 주선): ${config.operations.market.counterparties.find((p) => p.id === offer.counterpartyId)!.nameKo} 화물 ${good.nameKo} ${offer.quantity}${unitKo(good)}, ${cityName(config, offer.cityId)} → ${cityName(config, offer.destinationCityId)}` : `계약 ${contractId} 체결 (운송 주선): ${offer.counterpartyId}의 ${good.nameKo} ${offer.quantity}${unitKo(good)}을(를) ${cityName(config, offer.cityId)} → ${cityName(config, offer.destinationCityId)} 운송. 서비스 대금 ${formatMoney(offer.currency, offer.serviceFeeMinor)} (납기 ${offer.deliveryDeadlineDay}일). 고객 화물이므로 매입·재고가 없습니다`);
  return null;
}

function taskLabel(kind: Task['kind']): string {
  return { EXPORT_PREP: '수출 준비', FORWARDING_PREP: '운송 주선 준비(화물 인수·선적 서류)',
    SCOUT: '현장 조사', RECRUIT_QUEST: '영입 의뢰', CULTURE: '현지 활동', TRAINING: '일반 훈련' }[kind];
}

function employeeUnavailable(s: GameState, config: ScenarioConfig, employeeId: string, cityId: string): string | null {
  const emp = s.employees.find((e) => e.id === employeeId);
  const def = config.employees.find((e) => e.id === employeeId);
  if (!emp || !def || !isEmployed(s, employeeId)) return '고용 중인 직원이 아닙니다.';
  if (!isAvailableFromToday(s, employeeId)) return `${def.nameKo}은(는) ${emp.availableFromDay}일부터 업무를 맡을 수 있습니다.`;
  if (emp.locationCityId !== cityId) {
    return `${def.nameKo}은(는) ${cityName(config, emp.locationCityId)}에 있습니다. 이 업무는 ${cityName(config, cityId)} 현지 인력이 필요합니다.`;
  }
  const busy = runningTaskOf(s, employeeId);
  if (busy) return `${def.nameKo}은(는) 다른 업무(${[taskSubjectKo(config, busy), taskLabel(busy.kind)].filter(Boolean).join(' ')})를 진행 중입니다. 한 사람은 한 번에 업무 하나만 맡습니다.`;
  return null;
}

function assignTask(s: GameState, config: ScenarioConfig, taskId: string, employeeId: string): string | null {
  const task = s.tasks.find((t) => t.id === taskId);
  if (!task) return '업무를 찾을 수 없습니다.';
  return assignTaskObject(s, config, task, employeeId);
}

/** 배정 검사를 마친 뒤에만 업무·계약·로그를 갱신한다. */
function assignTaskObject(s: GameState, config: ScenarioConfig, task: Task, employeeId: string): string | null {
  if (task.status !== 'QUEUED') return '이미 배정했거나 종료된 업무입니다.';
  const rejection = employeeUnavailable(s, config, employeeId, task.cityId);
  if (rejection) return rejection;
  task.status = 'RUNNING';
  task.assignedEmployeeId = employeeId;
  task.startedDay = s.day;
  if (task.contractId !== null) {
    const contract = contractOf(s, task.contractId);
    contract.ownerEmployeeId = employeeId;
    if (contract.status === 'ACTIVE') contract.status = 'IN_PROGRESS';
  }
  const def = config.employees.find((e) => e.id === employeeId)!;
  const label = [taskSubjectKo(config, task), taskLabel(task.kind)].filter(Boolean).join(' ');
  switch (task.kind) {
    case 'CULTURE': {
      const activity = config.culture!.activities.find((a) => a.id === task.subjectId)!;
      log(s, `${def.nameKo} ${activity.titleKo} 시작 (${task.requiredWorkUnits}일, 현지 활동비 ${formatMoney(activity.currency, activity.costMinor)})`);
      break;
    }
    case 'TRAINING': {
      const fee = config.growth!.ordinaryTraining;
      log(s, `${def.nameKo} ${label} 시작 (${task.requiredWorkUnits}일, 훈련비 ${formatMoney(fee.currency, fee.feeMinor)})`);
      break;
    }
    case 'EXPORT_PREP':
    case 'FORWARDING_PREP':
    case 'SCOUT':
    case 'RECRUIT_QUEST':
      log(s, `${def.nameKo}에게 ${label} 업무 배정 (${task.requiredWorkUnits} 업무 포인트)`);
      break;
    default: {
      const unknown: never = task.kind;
      throw new EngineError(`알 수 없는 업무 종류입니다 (${unknown}).`);
    }
  }
  return null;
}

function startCultureActivity(s: GameState, config: ScenarioConfig, activityId: string, employeeId: string): string | null {
  if (!config.culture) return '이 시나리오에서는 현지 활동을 할 수 없습니다.';
  const activity = config.culture.activities.find((a) => a.id === activityId);
  if (!activity) return '현지 활동을 찾을 수 없습니다.';
  const unavailable = employeeUnavailable(s, config, employeeId, activity.cityId);
  if (unavailable) return unavailable;
  const employee = config.employees.find((e) => e.id === employeeId)!;
  const keys = cultureKeys(config, activity, employeeId);
  if (s.culture.experiences.some((e) => e.key === keys.actorExperience)) {
    return `${employee.nameKo}은(는) 이미 이 활동에 참여했습니다. 다시 해도 새로 생기는 기록이 없습니다.`;
  }
  const running = s.tasks.find((t) => t.kind === 'CULTURE' && t.subjectId === activityId
    && t.status === 'RUNNING' && t.assignedEmployeeId !== employeeId);
  if (running) return `같은 활동에 오늘 이미 ${config.employees.find((e) => e.id === running.assignedEmployeeId)!.nameKo}이(가) 갑니다. 끝난 뒤에 보낼 수 있습니다.`;
  const taskId = `CULTURE-${activityId}-${employeeId}-D${s.day}`;
  if (s.tasks.some((t) => t.id === taskId)) return '이미 생성된 업무 ID입니다.';
  const available = cashLessUnpaidMinor(s, config, activity.currency);
  if (available < activity.costMinor) return `현지 활동비 자금이 부족합니다. 필요 ${formatMoney(activity.currency, activity.costMinor)}, 사용 가능 ${formatMoney(activity.currency, available)}.`;
  const task: Task = { id: taskId, kind: 'CULTURE', contractId: null, subjectId: activityId, cityId: activity.cityId,
    requiredWorkUnits: activity.durationDays, progressWorkUnits: 0, status: 'QUEUED',
    assignedEmployeeId: null, startedDay: null, completedDay: null };
  const rejection = assignTaskObject(s, config, task, employeeId);
  if (rejection) return rejection;
  s.tasks.push(task);
  postOrThrow(s, { id: `CULTURE-FEE-${taskId}`, currency: activity.currency, reason: `${employee.nameKo} 현지 활동비`,
    lines: [{ account: 'CULTURE_EXPENSE', amount: activity.costMinor }, { account: 'CASH', amount: -activity.costMinor }] });
  return null;
}

function startTraining(s: GameState, config: ScenarioConfig, employeeId: string): string | null {
  if (!config.growth) return '이 시나리오에서는 일반 훈련을 할 수 없습니다.';
  const emp = s.employees.find((e) => e.id === employeeId);
  const cityId = emp?.locationCityId ?? config.homeCityId;
  const unavailable = employeeUnavailable(s, config, employeeId, cityId);
  if (unavailable) return unavailable;
  if (cityId !== config.homeCityId) return `일반 훈련은 ${cityName(config, config.homeCityId)}에서만 할 수 있습니다.`;
  const def = config.employees.find((e) => e.id === employeeId)!;
  if (!def.growth) return '성장 정보가 없는 직원입니다.';
  const training = config.growth.ordinaryTraining;
  const taskId = `TRAINING-${employeeId}-D${s.day}`;
  if (s.tasks.some((t) => t.id === taskId)) return '이미 생성된 업무 ID입니다.';
  const available = trainingAvailableMinor(s, config, training.currency);
  if (available < training.feeMinor) return `훈련비 자금이 부족합니다. 필요 ${formatMoney(training.currency, training.feeMinor)}, 사용 가능 ${formatMoney(training.currency, available)}.`;
  const task: Task = {
    id: taskId, kind: 'TRAINING', contractId: null, subjectId: employeeId, cityId,
    requiredWorkUnits: training.durationDays, progressWorkUnits: 0, status: 'QUEUED',
    assignedEmployeeId: null, startedDay: null, completedDay: null,
  };
  const rejection = assignTaskObject(s, config, task, employeeId);
  if (rejection) return rejection;
  s.tasks.push(task);
  postOrThrow(s, {
    id: `TRAINING-FEE-${taskId}`, currency: training.currency, reason: `${def.nameKo} 일반 훈련비`,
    lines: [{ account: 'TRAINING_EXPENSE', amount: training.feeMinor }, { account: 'CASH', amount: -training.feeMinor }],
  });
  return null;
}

function recruitmentUnavailable(s: GameState, config: ScenarioConfig): string | null {
  if (!config.recruitment) return '이 시나리오에서는 동료 영입을 할 수 없습니다.';
  if (s.recruitment.candidates.length === 0) return '이 저장에는 영입 후보 정보가 없습니다.';
  return null;
}

/** 계약 업무 ID와 별도 접두사를 써 기존 계약의 순번을 유지한다. */
function startRecruitmentTask(s: GameState, config: ScenarioConfig, task: Task, employeeId: string): string | null {
  if (s.tasks.some((existing) => existing.id === task.id)) return '이미 생성된 업무 ID입니다.';
  const rejection = assignTaskObject(s, config, task, employeeId);
  if (rejection) return rejection;
  s.tasks.push(task);
  return null;
}

function scoutSite(s: GameState, config: ScenarioConfig, venueId: string, employeeId: string): string | null {
  const unavailable = recruitmentUnavailable(s, config);
  if (unavailable) return unavailable;
  const def = config.recruitment!;
  const site = def.scoutSites.find((x) => x.venueId === venueId);
  if (!site) return '조사할 수 있는 장소가 아닙니다.';
  if (s.recruitment.scoutedVenueIds.includes(venueId)
    || s.tasks.some((t) => t.kind === 'SCOUT' && t.subjectId === venueId && t.status === 'RUNNING')) {
    return '이미 조사했거나 조사 중인 장소입니다.';
  }
  if (!s.recruitment.candidates.some((c) => site.candidateEmployeeIds.includes(c.employeeId) && c.stage === 'UNDISCOVERED')) {
    return '이 장소에는 아직 발견하지 않은 후보가 없습니다.';
  }
  return startRecruitmentTask(s, config, {
    id: `SCOUT-${venueId}`, kind: 'SCOUT', contractId: null, subjectId: venueId, cityId: site.cityId,
    requiredWorkUnits: def.scoutWorkUnits, progressWorkUnits: 0, status: 'QUEUED',
    assignedEmployeeId: null, startedDay: null, completedDay: null,
  }, employeeId);
}

function startRecruitQuest(s: GameState, config: ScenarioConfig, candidateId: string, employeeId: string): string | null {
  const unavailable = recruitmentUnavailable(s, config);
  if (unavailable) return unavailable;
  const def = config.recruitment!;
  const candidate = s.recruitment.candidates.find((c) => c.employeeId === candidateId);
  const site = def.scoutSites.find((x) => x.candidateEmployeeIds.includes(candidateId));
  if (!candidate || !site) return '영입 후보를 찾을 수 없습니다.';
  if (candidate.stage !== 'DISCOVERED') return '발견한 후보에게만 영입 의뢰를 시작할 수 있습니다.';
  const taskId = `RECRUIT-${candidateId}`;
  const rejection = startRecruitmentTask(s, config, {
    id: taskId, kind: 'RECRUIT_QUEST', contractId: null, subjectId: candidateId, cityId: site.cityId,
    requiredWorkUnits: def.questWorkUnits, progressWorkUnits: 0, status: 'QUEUED',
    assignedEmployeeId: null, startedDay: null, completedDay: null,
  }, employeeId);
  if (rejection) return rejection;
  candidate.stage = 'QUEST_RUNNING';
  candidate.questTaskId = taskId;
  return null;
}

function hireCandidate(s: GameState, config: ScenarioConfig, candidateId: string): string | null {
  const unavailable = recruitmentUnavailable(s, config);
  if (unavailable) return unavailable;
  const candidate = s.recruitment.candidates.find((c) => c.employeeId === candidateId);
  const emp = s.employees.find((e) => e.id === candidateId);
  const def = config.employees.find((e) => e.id === candidateId);
  if (!candidate || !emp || !def) return '영입 후보를 찾을 수 없습니다.';
  if (candidate.stage !== 'INTERVIEW_READY' || isEmployed(s, candidateId)) return '면담 가능한 후보만 고용할 수 있습니다.';
  const fee = config.recruitment!.signingFeeWageDays * def.salaryPerDayMinor;
  const available = cashLessUnpaidMinor(s, config, def.salaryCurrency);
  if (available < fee) return `영입 계약금 자금이 부족합니다. 필요 ${formatMoney(def.salaryCurrency, fee)}, 사용 가능 ${formatMoney(def.salaryCurrency, available)}.`;
  if (fee > 0) postOrThrow(s, {
    id: `SIGNING-${candidateId}`, currency: def.salaryCurrency, reason: `${def.nameKo} 영입 계약금`,
    lines: [{ account: 'RECRUITMENT_EXPENSE', amount: fee }, { account: 'CASH', amount: -fee }],
  });
  emp.employmentStatus = 'employed';
  emp.availableFromDay = s.day + 1;
  candidate.stage = 'HIRED';
  candidate.hiredDay = s.day;
  log(s, `${def.nameKo} 고용 확정: 계약금 ${formatMoney(def.salaryCurrency, fee)}, ${emp.availableFromDay}일부터 근무·급여 시작`);
  return null;
}

function bookSailing(s: GameState, config: ScenarioConfig, contractId: string, sailingId: string): string | null {
  const contract = s.contracts.find((c) => c.id === contractId);
  if (!contract) return '계약을 찾을 수 없습니다.';
  if (contract.status !== 'ACTIVE' && contract.status !== 'IN_PROGRESS') return '진행 중인 계약이 아닙니다.';
  const existing = contract.bookingId ? s.bookings.find((b) => b.id === contract.bookingId) : undefined;
  if (existing && existing.status !== 'CANCELLED') return '이미 운송편을 예약했습니다.';
  const sailing = findSailing(config, sailingId);
  if (!sailing) return '운항표에 없는 출항편입니다.';
  const route = routeOf(config, sailing.routeId);
  if (route.fromCityId !== contract.originCityId || route.toCityId !== contract.destinationCityId) {
    return '계약 구간과 노선이 다릅니다.';
  }
  if (sailing.departureDay <= s.day) return `예약 마감이 지났습니다. 출항(${sailing.departureDay}일) 전날까지 예약해야 합니다.`;
  const lot = s.cargoLots.find((l) => l.id === contract.cargoLotId);
  if (!lot || lot.locationCityId !== route.fromCityId) return '출발항에 실을 화물이 없습니다.';

  const short = spaceShortfall(s, config, sailing, lot.goodId, lot.quantity);
  if (short) return `이 출항편의 남은 화물 공간이 부족합니다 (${short}).`;
  const fee = route.bookingFeeMinor;
  if (config.rules.fundsCheck === 'IMMEDIATE_CASH') {
    const cash = balance(s.ledger, route.currency, 'CASH');
    if (cash < fee) return `운임 선지급 자금이 부족합니다. 필요 ${formatMoney(route.currency, fee)}, 사용 가능 ${formatMoney(route.currency, cash)}.`;
  } else {
    // 이 계약의 운임 예약은 지금 쓰려는 바로 그 돈이므로 빼고 계산한다.
    const own = (r: CashReservation) => r.contractId === contract.id && r.kind === 'FREIGHT';
    const shortfall = fundsShortfall(s, config, route.currency, fee, `운임 ${formatMoney(route.currency, fee)}`, own);
    if (shortfall) return `운임 선지급 자금이 부족합니다. ${shortfall}`;
  }

  const space = cargoSpace(config, lot.goodId, lot.quantity);
  const booking: Booking = {
    id: `BK${pad(s.bookings.length + 1)}`,
    contractId,
    routeId: route.id,
    sailingId: sailing.id,
    departureDay: sailing.departureDay,
    massGrams: space.massGrams,
    volumeLiters: space.volumeLiters,
    prepaidFreightMinor: fee,
    status: 'BOOKED',
  };
  s.bookings.push(booking);
  contract.bookingId = booking.id;
  postOrThrow(s, {
    id: `FREIGHT-PREPAY-${booking.id}`,
    currency: route.currency,
    contractId,
    reason: `${sailing.id} 화물 공간 예약, 운임 선지급 (현금 → 선급운임)`,
    lines: [
      { account: 'PREPAID_FREIGHT', amount: fee },
      { account: 'CASH', amount: -fee },
    ],
  });
  log(s, `${contract.id} 운송편 예약: ${sailing.departureDay}일 출항 ${sailing.id}, 운임 ${formatMoney(route.currency, fee)} 선지급`);
  return null;
}

/** 출항 전 예약 해제. 운임 환급과 취소비를 계약 조건대로 정산한다. */
function releaseBooking(s: GameState, config: ScenarioConfig, booking: Booking, why: string) {
  const fee = config.terms.preDepartureCancellationFeeMinor;
  const refund = booking.prepaidFreightMinor - fee;
  if (refund < 0) {
    throw new Error(`${booking.id}: 자료 오류 — 취소비(${fee})가 선급운임(${booking.prepaidFreightMinor})보다 큽니다.`);
  }
  const currency = routeOf(config, booking.routeId).currency;
  const lines: LedgerLine[] = [{ account: 'PREPAID_FREIGHT', amount: -booking.prepaidFreightMinor }];
  if (refund > 0) lines.push({ account: 'CASH', amount: refund });
  if (fee > 0) lines.push({ account: 'CANCELLATION_EXPENSE', amount: fee });
  postOrThrow(s, {
    id: `FREIGHT-RELEASE-${booking.id}`,
    currency,
    contractId: booking.contractId,
    reason: `${why}: 운임 ${formatMoney(currency, refund)} 환급, 취소비 ${formatMoney(currency, fee)}`,
    lines,
  });
  booking.status = 'CANCELLED';
}

function cancelContract(s: GameState, config: ScenarioConfig, contractId: string): string | null {
  const contract = s.contracts.find((c) => c.id === contractId);
  if (!contract) return '계약을 찾을 수 없습니다.';
  if (contract.status !== 'ACTIVE' && contract.status !== 'IN_PROGRESS') return '취소할 수 있는 상태가 아닙니다.';
  const booking = contract.bookingId ? s.bookings.find((b) => b.id === contract.bookingId) : undefined;
  if (booking?.status === 'DEPARTED') return '이미 출항한 화물은 취소할 수 없습니다. 인도 후 정산만 가능합니다 (출항 후 취소는 M3).';

  if (booking && booking.status === 'BOOKED') releaseBooking(s, config, booking, `${contract.id} 출항 전 취소`);
  const compensation = config.terms.customerCancellationCompensationMinor;
  if (compensation > 0) {
    payOrAccrue(s, config, contract.currency, compensation, `CANCEL-COMP-${contract.id}`, '고객 취소 보상', contract.id, 'CANCELLATION_EXPENSE');
  }
  const task = s.tasks.find((t) => t.id === contract.prepTaskId);
  if (task && (task.status === 'QUEUED' || task.status === 'RUNNING')) task.status = 'ABORTED';
  const lot = s.cargoLots.find((l) => l.id === contract.cargoLotId);
  const good = goodOf(config, contract.goodId);
  if (lot && lot.owner === 'CUSTOMER') {
    // 고객 화물은 화주에게 돌려준다. 회사 장부에는 원래 없었으므로 재고가 생기지 않는다.
    lot.status = 'RETURNED_TO_OWNER';
  } else if (lot) {
    // 공급자 반품 없음: 회사 소유 재고로 출발항에 남는다.
    lot.status = 'HELD_UNALLOCATED';
    lot.contractId = null;
  }
  contract.status = 'CANCELLED';
  contract.cancelledDay = s.day;
  log(s, contract.kind === 'FORWARDING'
    ? `${contract.id} 출항 전 취소. 고객 화물 ${good.nameKo} ${contract.quantity}${unitKo(good)}은(는) 화주에게 돌려줌`
    : `${contract.id} 출항 전 취소. 상품 ${contract.quantity}${unitKo(good)}은(는) 반품 없이 회사 재고로 ${cityName(config, contract.originCityId)}에 남음`);
  return null;
}

function respondToDelay(s: GameState, noticeId: string, shipmentId: string): string | null {
  const decision = s.delayDecisions.find((d) => d.noticeId === noticeId && d.shipmentId === shipmentId);
  if (!decision) return '대응할 지연 공지가 없습니다.';
  if (decision.choice !== null) return '이미 대응을 결정했습니다.';
  decision.choice = 'KEEP_SHIPMENT_BOOKING';
  decision.decidedDay = s.day;
  log(s, `${shipmentId}: 현재 예약으로 대기하기로 결정`);
  return null;
}

// ── 하루 마감 ──

export interface CommitResult {
  state: GameState;
  results: CommandResult[];
  /** 이미 마감한 날을 다시 마감하려 한 경우 true. 상태는 그대로다. */
  alreadyClosed: boolean;
}

export function commitDay(
  state: GameState,
  config: ScenarioConfig,
  commands: EngineCommand[],
  closingDay: number = state.day,
): CommitResult {
  if (state.closedDays.includes(closingDay) || closingDay !== state.day) {
    return { state, results: [], alreadyClosed: true };
  }
  if (state.phase !== 'AWAITING_INPUT') {
    throw new EngineError(`${state.day}일은 아직 열리지 않았습니다. openDay를 먼저 호출하세요.`);
  }
  const s = clone(state);
  const day = s.day;

  // 2~3. 명령 검증·실행 (앞 명령의 예약·지출을 반영해 순서대로 검증)
  const results = commands.map((cmd) => applyCommand(s, config, cmd));
  // 3. 직원 업무 진행 (LEGACY_FIXED 처리량)
  progressTasks(s, config);
  // 4. 출항·이동·도착·통관
  processDepartures(s, config);
  processArrivals(s, config);
  // 5. 인도·납기 판정
  processDeliveries(s, config);
  // 6. 수금 → 밀린 지급 → 급여
  processCollections(s, config);
  settleObligations(s);
  for (const cost of fixedCostsDue(s, config, day)) payOrAccrue(s, config, cost.currency, cost.amountMinor, cost.id, cost.reasonKo, undefined, cost.account);
  processPayroll(s, config);
  processPaymentDefault(s, config);
  // 7. 다음 날 견적 갱신 (M2a: 유효기간 만료만)
  if (s.operations?.outcome !== 'FAILED') {
  for (const st of s.offers) {
    const def = offerDef(s, config, st.id);
    if (def && st.status === 'OPEN' && def.validUntilDay < day + 1) {
      st.status = 'EXPIRED';
      log(s, `견적 ${st.id} 유효기간 만료`);
    }
  }
  if (s.operations && config.operations) {
    const pub = config.operations.market.publish, next = day + 1;
    if (next <= pub.lastDay && (next - pub.firstDay) % pub.intervalDays === 0) {
      const generated = generateBatch(s.rng.seed, (next - pub.firstDay) / pub.intervalDays, s.operations.batches.at(-1)!.index, config);
      s.operations.batches.push(generated.batch); s.operations.offers.push(...generated.offers);
      s.offers.push(...generated.offers.map((o) => ({ id: o.id, status: 'OPEN' as const })));
    }
  }
  }
  // 8. 불변 조건 검사·마감
  s.closedDays.push(day);
  s.day = day + 1;
  s.phase = s.day > config.campaignDays || s.operations?.outcome === 'FAILED' ? 'ENDED' : 'PENDING_OPEN';
  if (s.operations && s.operations.outcome !== 'FAILED' && s.phase === 'ENDED') s.operations.outcome = 'COMPLETED';
  // 종료 표시까지 반영한 상태를 검증한다. 기존 검사는 마감 날짜를 유지한다.
  const checking = { ...s, day };
  checkInvariants(checking, config, { closing: true });
  return { state: s, results, alreadyClosed: false };
}

function progressTasks(s: GameState, config: ScenarioConfig) {
  const allocation = config.operations ? allocateHandling(s, config) : null;
  if (allocation && s.operations) s.operations.handlingLog.push({ day: s.day, capacityPt: allocation.capacityPt,
    usedPt: allocation.allocations.reduce((sum, a) => sum + a.gotPt, 0), waits: allocation.allocations.filter((a) => a.gotPt < a.wantPt) });
  for (const task of s.tasks) {
    if (task.status !== 'RUNNING' || !task.assignedEmployeeId || !isAvailableFromToday(s, task.assignedEmployeeId)) continue;
    const def = config.employees.find((e) => e.id === task.assignedEmployeeId);
    if (!def) continue;
    task.progressWorkUnits = Math.min(task.requiredWorkUnits, task.progressWorkUnits + (allocation?.allocations.find((a) => a.taskId === task.id)?.gotPt ?? (isDayBasedTask(task.kind) ? 1 : def.workUnitsPerDay)));
    if (task.progressWorkUnits >= task.requiredWorkUnits) {
      task.status = 'DONE';
      task.completedDay = s.day;
      switch (task.kind) {
        case 'CULTURE':
          recordCultureCompletion(s, config, task);
          break;
        case 'TRAINING':
          log(s, `${def.nameKo}: 일반 훈련 완료`);
          break;
        case 'SCOUT': {
          const site = config.recruitment!.scoutSites.find((x) => x.venueId === task.subjectId)!;
          for (const c of s.recruitment.candidates) {
            if (c.stage !== 'UNDISCOVERED' || !site.candidateEmployeeIds.includes(c.employeeId)) continue;
            c.stage = 'DISCOVERED';
            c.discoveredDay = s.day;
            log(s, `${config.employees.find((e) => e.id === c.employeeId)!.nameKo} 발견: 영입 의뢰 가능`);
          }
          s.recruitment.scoutedVenueIds.push(site.venueId);
          log(s, `${def.nameKo}: ${taskSubjectKo(config, task)} 현장 조사 완료`);
          break;
        }
        case 'RECRUIT_QUEST': {
          const c = s.recruitment.candidates.find((x) => x.employeeId === task.subjectId)!;
          c.stage = 'INTERVIEW_READY';
          c.interviewReadyDay = s.day;
          log(s, `${def.nameKo}: ${config.employees.find((e) => e.id === c.employeeId)!.nameKo} 영입 의뢰 완료 → 면담 가능`);
          break;
        }
        case 'EXPORT_PREP':
        case 'FORWARDING_PREP': {
          const lot = s.cargoLots.find((l) => task.contractId !== null && l.contractId === task.contractId);
          if (lot && lot.status === 'PREPARING') lot.status = 'AWAITING_DEPARTURE';
          log(s, `${def.nameKo}: ${task.contractId} ${taskLabel(task.kind)} 완료 → 출발 대기`);
          break;
        }
        default: {
          const unknown: never = task.kind;
          throw new EngineError(`알 수 없는 업무 종류입니다 (${unknown}).`);
        }
      }
      awardTaskCompletion(s, config, task);
    }
  }
}

function processDepartures(s: GameState, config: ScenarioConfig) {
  for (const booking of s.bookings) {
    if (booking.status !== 'BOOKED' || booking.departureDay !== s.day) continue;
    const contract = contractOf(s, booking.contractId);
    const route = routeOf(config, booking.routeId);
    const lot = s.cargoLots.find((l) => l.id === contract.cargoLotId);
    if (!lot || lot.status !== 'AWAITING_DEPARTURE' || lot.locationCityId !== route.fromCityId) {
      releaseBooking(s, config, booking, `${contract.id} 준비 미완료로 출항 불참`);
      contract.bookingId = null;
      log(s, `${contract.id}: 준비가 끝나지 않아 ${booking.sailingId}에 싣지 못함. 다음 출항편을 다시 예약해야 합니다.`);
      continue;
    }
    const shipment: Shipment = {
      id: `SH${pad(s.shipments.length + 1)}`,
      bookingId: booking.id,
      contractId: contract.id,
      cargoLotId: lot.id,
      departureDay: s.day,
      scheduledArrivalDay: s.day + route.transitDays,
      arrivalDay: null,
      releaseDay: null,
      observedWaitDays: 0,
      delayEventIds: [],
      dutyMinor: null,
      dutyPaid: false,
    };
    s.shipments.push(shipment);
    booking.status = 'DEPARTED';
    lot.status = 'IN_TRANSIT';
    lot.locationCityId = null;
    lot.shipmentId = shipment.id;
    if (contract.kind === 'FORWARDING') {
      // 고객 화물의 운임은 회사 재고 원가가 아니다. 서비스를 마칠(인도) 때까지 진행원가로 둔다.
      postOrThrow(s, {
        id: `FREIGHT-WIP-${booking.id}`,
        currency: route.currency,
        contractId: contract.id,
        reason: `${booking.sailingId} 출항: 고객 화물 운임을 주선 진행원가로 (선급운임 → 주선 진행원가)`,
        lines: [
          { account: 'FORWARDING_WIP', amount: booking.prepaidFreightMinor },
          { account: 'PREPAID_FREIGHT', amount: -booking.prepaidFreightMinor },
        ],
      });
    } else {
      if (lot.currency === contract.currency) lot.carryingAmountMinor += booking.prepaidFreightMinor;
      postOrThrow(s, {
        id: `FREIGHT-CAPITALIZE-${booking.id}`,
        currency: route.currency,
        contractId: contract.id,
        reason: `${booking.sailingId} 출항: 선급운임을 상품 원가에 포함 (선급운임 → 재고)`,
        lines: [
          { account: 'INVENTORY', amount: booking.prepaidFreightMinor },
          { account: 'PREPAID_FREIGHT', amount: -booking.prepaidFreightMinor },
        ],
      });
      const surcharge = config.operations?.risk?.layers.includes('SURCHARGE')
        ? applyBasisPoints(booking.prepaidFreightMinor,
          surchargeBp(config, s.rng.seed, booking.routeId, surchargeWeek(config, booking.departureDay))) : 0;
      if (surcharge) {
        payOrAccrue(s, config, route.currency, surcharge, `SURCHARGE-${booking.id}`,
          `${booking.sailingId} 출항 부대비`, contract.id, 'INVENTORY');
        if (lot.currency === contract.currency) lot.carryingAmountMinor += surcharge;
        log(s, `${contract.id}: 출항 부대비 ${formatMoney(route.currency, surcharge)}`);
      }
    }
    log(s, `${shipment.id} 출항: ${cityName(config, route.fromCityId)} → ${cityName(config, route.toCityId)}, 도착 예정 ${shipment.scheduledArrivalDay}일 (${contract.id})`);
  }
}

function processArrivals(s: GameState, config: ScenarioConfig) {
  for (const sh of s.shipments) {
    if (sh.arrivalDay !== null || sh.scheduledArrivalDay > s.day) continue;
    const contract = contractOf(s, sh.contractId);
    const restriction = config.portRestrictions.find(
      (r) => r.cityId === contract.destinationCityId && r.startDay <= s.day && s.day <= r.endDay,
    );
    if (restriction) {
      // 사건 인스턴스는 하나. 매일 실제로 기다린 날만 누적하고 총 지연일을 미리 더하지 않는다.
      sh.observedWaitDays += 1;
      if (!sh.delayEventIds.includes(restriction.eventInstanceId)) sh.delayEventIds.push(restriction.eventInstanceId);
      log(s, `${sh.id}: ${cityName(config, contract.destinationCityId)}항 하역 중단으로 대기 (${sh.observedWaitDays}일째)`);
      continue;
    }
    sh.arrivalDay = s.day;
    sh.releaseDay = s.day + config.terms.customsDays;
    const lot = s.cargoLots.find((l) => l.id === sh.cargoLotId)!;
    lot.status = 'ARRIVED_RELEASING';
    lot.locationCityId = contract.destinationCityId;
    const waited = sh.observedWaitDays > 0 ? ` (대기 ${sh.observedWaitDays}일)` : '';
    if (contract.kind === 'FORWARDING') {
      // 고객 화물의 관세는 수입자(고객)가 부담한다는 시나리오 가정. 회사 장부에 관세가 생기지 않는다.
      sh.dutyMinor = 0;
      sh.dutyPaid = true;
      log(s, `${sh.id} 도착: ${cityName(config, contract.destinationCityId)}${waited}. 고객 화물이므로 관세는 수입자 부담`);
      continue;
    }
    // 통관: 가상 과세 규칙 — 공급자 상품 송장 금액만 과세가격으로 본다.
    const duty = dutyFor(config, s.rng.seed, contract.goodId, contract.destinationCityId, s.day, s.day,
      contract.purchaseAmountMinor, offerDef(s, config, contract.buyOfferId!)!.currency, contract.acceptedDay);
    sh.dutyMinor = duty;
    if (duty === 0) {
      sh.dutyPaid = true;
    } else {
      const paid = payOrAccrue(s, config, contract.currency, duty, `DUTY-${sh.id}`, `${sh.id} 수입 관세 (가상 세율)`, contract.id, 'INVENTORY');
      sh.dutyPaid = paid;
      if (lot.currency === contract.currency) lot.carryingAmountMinor += duty;
    }
    log(s, `${sh.id} 도착: ${cityName(config, contract.destinationCityId)}${waited}. 관세 ${formatMoney(contract.currency, duty)}${sh.dutyPaid ? ' 지급' : ' 미지급 — 납부 전 반출 불가'}`);
  }
}

function processDeliveries(s: GameState, config: ScenarioConfig) {
  for (const sh of s.shipments) {
    if (sh.arrivalDay === null || sh.releaseDay === null || sh.releaseDay > s.day || !sh.dutyPaid) continue;
    const lot = s.cargoLots.find((l) => l.id === sh.cargoLotId)!;
    if (lot.status !== 'ARRIVED_RELEASING') continue;
    const contract = contractOf(s, sh.contractId);
    const lateDays = Math.max(0, s.day - contract.deliveryDeadlineDay);
    const reduction = lateDeliveryReduction(config, contract.saleAmountMinor, lateDays);
    const netSale = contract.saleAmountMinor - reduction;
    contract.deliveredDay = s.day;
    contract.lateDays = lateDays;
    contract.priceReductionMinor = reduction;
    const forwarding = contract.kind === 'FORWARDING';
    const what = forwarding ? '서비스' : '판매';

    if (netSale > 0) postOrThrow(s, {
      id: `SALE-${contract.id}`,
      currency: contract.currency,
      contractId: contract.id,
      reason: `${forwarding ? '고객 화물 인도 완료' : '인도 완료'}${reduction > 0 ? `(납기 ${lateDays}일 경과). 계약 조건에 따른 ${what}대금 감액 ${formatMoney(contract.currency, reduction)} 후` : '.'} 외상 ${forwarding ? '주선 매출 (주선 매출 → 매출채권)' : '매출 (매출 → 매출채권)'}`,
      lines: [
        { account: 'ACCOUNTS_RECEIVABLE', amount: netSale },
        { account: forwarding ? 'FORWARDING_REVENUE' : 'REVENUE', amount: -netSale },
      ],
    });
    if (forwarding) {
      const booking = s.bookings.find((b) => b.id === sh.bookingId)!;
      postOrThrow(s, {
        id: `FWD-COST-${contract.id}`,
        currency: contract.currency,
        contractId: contract.id,
        reason: '서비스를 마친 운송 주선의 운임을 주선 원가로 (주선 진행원가 → 주선 원가)',
        lines: [
          { account: 'FORWARDING_COST', amount: booking.prepaidFreightMinor },
          { account: 'FORWARDING_WIP', amount: -booking.prepaidFreightMinor },
        ],
      });
    } else if (lot.currency !== contract.currency) {
      for (const currency of [lot.currency, contract.currency]) {
        const amount = currency === lot.currency ? lot.carryingAmountMinor : contractAmount(s.ledger, currency, contract.id, 'INVENTORY');
        postOrThrow(s, { id: `COGS-${contract.id}-${currency}`, currency, contractId: contract.id,
          reason: '인도한 상품의 통화별 장부가액을 매출원가로 대체 (재고 → 매출원가)',
          lines: [{ account: 'COST_OF_GOODS_SOLD', amount }, { account: 'INVENTORY', amount: -amount }] });
      }
    } else {
      postOrThrow(s, {
        id: `COGS-${contract.id}`,
        currency: contract.currency,
        contractId: contract.id,
        reason: '인도한 상품의 장부가액(매입+운임+관세)을 매출원가로 대체 (재고 → 매출원가)',
        lines: [
          { account: 'COST_OF_GOODS_SOLD', amount: lot.carryingAmountMinor },
          { account: 'INVENTORY', amount: -lot.carryingAmountMinor },
        ],
      });
    }
    lot.status = 'DELIVERED';
    if (netSale === 0) {
      contract.status = 'COMPLETED';
      contract.completedDay = s.day;
      log(s, `${contract.id} ${forwarding ? '고객 화물 ' : ''}인도 완료. 납기 ${lateDays}일 경과로 계약 금액 ${formatMoney(contract.currency, contract.saleAmountMinor)} 전액이 감액되어 받을 대금이 없습니다.`);
      continue;
    }
    let claimMinor = 0;
    if (contract.kind === 'DIRECT_TRADE') {
      const claim = claimFor(config, s.rng.seed, contract.sellOfferId!, contract.goodId);
      claimMinor = claim ? applyBasisPoints(netSale, claim.rateBp) : 0;
      if (claimMinor > 0) postOrThrow(s, {
        id: `CLAIM-${contract.id}`, currency: contract.currency, contractId: contract.id,
        reason: '화물 손상 감액 청구 (매출 에누리 → 매출채권 차감)',
        lines: [{ account: 'SALES_ALLOWANCE', amount: claimMinor }, { account: 'ACCOUNTS_RECEIVABLE', amount: -claimMinor }],
      });
    }
    const invoiceId = `INV-${contract.id}`;
    const dueDay = Math.max(contract.paymentDueDay, s.day);
    s.invoices.push({
      id: invoiceId,
      contractId: contract.id,
      currency: contract.currency,
      amountMinor: netSale - claimMinor,
      issuedDay: s.day,
      dueDay,
      status: 'OUTSTANDING',
      receiptIds: [],
    });
    contract.invoiceId = invoiceId;
    log(s, `${contract.id} ${forwarding ? '고객 화물 ' : ''}인도 완료${lateDays > 0 ? ` (납기 ${lateDays}일 경과, 감액 ${formatMoney(contract.currency, reduction)})` : ' (납기 내)'}. ${forwarding ? '주선 매출' : '매출'} ${formatMoney(contract.currency, netSale)}는 채권으로 남고 현금은 ${dueDay}일 수금 예정`);
    if (claimMinor > 0) log(s, `${contract.id} 화물 일부 손상: 고객이 대금 ${formatMoney(contract.currency, claimMinor)} 감액 청구`);
  }
}

function processCollections(s: GameState, config: ScenarioConfig) {
  for (const inv of s.invoices) {
    if (inv.status === 'PAID' || inv.status === 'WRITTEN_OFF' || inv.dueDay > s.day) continue;
    const contract = contractOf(s, inv.contractId);
    if (contract.kind === 'DIRECT_TRADE' && defaultFor(config, s.rng.seed, contract.sellOfferId!, contract.customerId, contract.creditTermId ?? 'BASE')) {
      if (s.day === inv.dueDay + config.operations!.risk!.profile.collections.lateMaxDays) {
        writeOffInvoice(s, config, inv.id);
      } else {
        inv.status = 'OVERDUE';
        if (s.day === inv.dueDay) log(s, `${inv.contractId} 결제일에 대금이 들어오지 않음(남은 ${formatMoney(inv.currency, inv.amountMinor - receivedForInvoice(s, inv.id))})`);
      }
      continue;
    }
    if (contract.kind !== 'DIRECT_TRADE' || !config.operations?.risk?.layers.includes('COLLECTION')) {
      if (applyReceipt(s, `RCPT-${inv.id}`, inv.id)) postCarry(s, config, inv.id);
      continue;
    }
    const plan = collectionPlan(config, s.rng.seed, contract.sellOfferId!, contract.customerId);
    const before = receivedForInvoice(s, inv.id);
    if (plan.mode === 'ON_TIME' || (plan.mode === 'LATE' && s.day >= inv.dueDay + plan.days)) {
      if (applyReceipt(s, `RCPT-${inv.id}`, inv.id)) postCarry(s, config, inv.id);
    } else if (plan.mode === 'PARTIAL') {
      const first = applyBasisPoints(inv.amountMinor, config.operations.risk.profile.collections.partialBp);
      if (applyPartialReceipt(s, `RCPT-${inv.id}-1`, inv.id, first)) postCarry(s, config, inv.id);
      if (s.day >= inv.dueDay + plan.days && applyPartialReceipt(s, `RCPT-${inv.id}-2`, inv.id, inv.amountMinor - first)) postCarry(s, config, inv.id);
    }
    const received = receivedForInvoice(s, inv.id), remaining = inv.amountMinor - received;
    if (remaining > 0) inv.status = 'OVERDUE';
    if (s.day === inv.dueDay && received === before) {
      log(s, `${inv.contractId} 결제일에 대금이 들어오지 않음(남은 ${formatMoney(inv.currency, remaining)})`);
    }
  }
}

/** 수금 뒤에도 PAID 상태를 거르지 않고 마지막 이자를 적는다. */
function postCarry(s: GameState, config: ScenarioConfig, invoiceId: string) {
  const inv = s.invoices.find((i) => i.id === invoiceId)!;
  const entries = s.ledger.entries.filter((e) => e.id.startsWith(`CARRY-${invoiceId}-`));
  const posted = entries.flatMap((e) => e.lines).filter((l) => l.account === 'RECEIVABLE_CARRY')
    .reduce((sum, l) => sum + l.amount, 0);
  const amount = divHalfAway(carryAccrued(s, config, invoiceId, s.day), 10000) - posted;
  if (amount === 0) return;
  postOrThrow(s, { id: `CARRY-${invoiceId}-${entries.length + 1}`, currency: inv.currency, contractId: inv.contractId,
    reason: '결제일 뒤 지연 이자 (채권 보유 비용 → 현금 지급)',
    lines: [{ account: 'RECEIVABLE_CARRY', amount }, { account: 'CASH', amount: -amount }] });
}

function writeOffInvoice(s: GameState, config: ScenarioConfig, invoiceId: string) {
  const inv = s.invoices.find((i) => i.id === invoiceId)!;
  const remaining = inv.amountMinor - receivedForInvoice(s, invoiceId);
  const recovery = applyBasisPoints(remaining, config.operations!.risk!.credit!.recoveryBp);
  const loss = remaining - recovery, receiptId = `RCPT-${invoiceId}-R`;
  if (recovery > 0) {
    postOrThrow(s, { id: `RECEIPT-${receiptId}`, currency: inv.currency, contractId: inv.contractId,
      reason: '회수 불능 대금 일부 회수 (매출채권 → 현금)',
      lines: [{ account: 'CASH', amount: recovery }, { account: 'ACCOUNTS_RECEIVABLE', amount: -recovery }] });
    inv.receiptIds.push(receiptId);
  }
  postCarry(s, config, invoiceId);
  postOrThrow(s, { id: `BADDEBT-${invoiceId}`, currency: inv.currency, contractId: inv.contractId,
    reason: '회수 불능 대금 대손 처리 (대손 비용 → 매출채권 차감)',
    lines: [{ account: 'BAD_DEBT', amount: loss }, { account: 'ACCOUNTS_RECEIVABLE', amount: -loss }] });
  inv.status = 'WRITTEN_OFF';
  const contract = contractOf(s, inv.contractId);
  contract.status = 'COMPLETED';
  contract.completedDay = s.day;
  log(s, `${inv.contractId} 대금 회수 불능 확정: ${formatMoney(inv.currency, recovery)} 회수, ${formatMoney(inv.currency, loss)} 대손 처리`);
}

/** 부분 수금은 금액을 받아 분개하고 마지막 수금에서만 계약을 종결한다. */
function applyPartialReceipt(s: GameState, receiptId: string, invoiceId: string, amount: number): boolean {
  const inv = s.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === 'PAID' || inv.status === 'WRITTEN_OFF' || inv.receiptIds.includes(receiptId)) return false;
  if (amount === 0 || !post(s.ledger, {
    id: `RECEIPT-${receiptId}`, day: s.day, currency: inv.currency, contractId: inv.contractId,
    reason: '외상대금 부분 수금 (매출채권 → 현금)',
    lines: [{ account: 'CASH', amount }, { account: 'ACCOUNTS_RECEIVABLE', amount: -amount }],
  })) return false;
  inv.receiptIds.push(receiptId);
  const remaining = inv.amountMinor - receivedForInvoice(s, inv.id);
  if (remaining === 0) {
    inv.status = 'PAID';
    const contract = contractOf(s, inv.contractId);
    contract.status = 'COMPLETED';
    contract.completedDay = s.day;
    log(s, `${inv.contractId} 대금 나머지 ${formatMoney(inv.currency, amount)} 수금. 계약 종결`);
  } else {
    log(s, `${inv.contractId} 대금 일부 ${formatMoney(inv.currency, amount)} 수금(남은 ${formatMoney(inv.currency, remaining)})`);
  }
  return true;
}

/**
 * 수금 적용. 같은 수금 ID는 한 번만 반영한다 (재전송·저장 후 재전송 포함).
 * 반환값: 실제로 반영했으면 true.
 */
export function applyReceipt(s: GameState, receiptId: string, invoiceId: string): boolean {
  const inv = s.invoices.find((i) => i.id === invoiceId);
  if (!inv || inv.status === 'PAID' || inv.status === 'WRITTEN_OFF' || inv.receiptIds.includes(receiptId)) return false;
  const posted = inv.amountMinor === 0 || post(s.ledger, {
    id: `RECEIPT-${receiptId}`,
    day: s.day,
    currency: inv.currency,
    contractId: inv.contractId,
    reason: '외상대금 수금 (매출채권 → 현금). 매출·이익은 인도 때 이미 인식',
    lines: [
      { account: 'CASH', amount: inv.amountMinor },
      { account: 'ACCOUNTS_RECEIVABLE', amount: -inv.amountMinor },
    ],
  });
  if (!posted) return false;
  inv.receiptIds.push(receiptId);
  inv.status = 'PAID';
  const contract = s.contracts.find((c) => c.id === inv.contractId);
  if (contract) {
    contract.status = 'COMPLETED';
    contract.completedDay = s.day;
  }
  log(s, `${inv.contractId} 대금 ${formatMoney(inv.currency, inv.amountMinor)} 수금. 계약 종결`);
  return true;
}

/** 필수 지급. 현금이 부족하면 무제한 마이너스 대신 미지급 의무(부채)로 기록한다. */
function payOrAccrue(
  s: GameState,
  config: ScenarioConfig,
  currency: Currency,
  amount: number,
  obligationId: string,
  reasonKo: string,
  contractId: string | undefined,
  debitAccount: 'INVENTORY' | 'CANCELLATION_EXPENSE' | 'WAGE_EXPENSE' | 'RENT_EXPENSE' | 'SPACE_CONTRACT_EXPENSE',
): boolean {
  const cash = balance(s.ledger, currency, 'CASH');
  if (cash >= amount) {
    postOrThrow(s, {
      id: obligationId,
      currency,
      contractId,
      reason: reasonKo,
      lines: [
        { account: debitAccount, amount },
        { account: 'CASH', amount: -amount },
      ],
    });
    return true;
  }
  postOrThrow(s, {
    id: obligationId,
    currency,
    contractId,
    reason: `${reasonKo} — 현금 부족으로 미지급`,
    lines: [
      { account: debitAccount, amount },
      { account: 'ACCOUNTS_PAYABLE', amount: -amount },
    ],
  });
  s.obligations.push({ id: obligationId, currency, amountMinor: amount, reasonKo, incurredDay: s.day, paidDay: null });
  log(s, `지급 불가: ${reasonKo} ${formatMoney(currency, amount)} → 미지급 의무로 기록 (${config.operations ? (s.day + config.operations.paymentDefault.failureAgeDays > config.campaignDays ? `${config.campaignDays}일 캠페인이 끝날 때까지 갚지 못하면 미지급을 남기고 끝남` : `${config.operations.paymentDefault.failureAgeDays}일 안에 갚지 못하면 경영 실패`) : '지급 불이행 유예기간은 아직 확정되지 않음'})`);
  return false;
}

function settleObligations(s: GameState) {
  for (const ob of s.obligations) {
    if (ob.paidDay !== null) continue;
    if (balance(s.ledger, ob.currency, 'CASH') < ob.amountMinor) continue;
    postOrThrow(s, {
      id: `SETTLE-${ob.id}`,
      currency: ob.currency,
      reason: `밀린 지급: ${ob.reasonKo}`,
      lines: [
        { account: 'ACCOUNTS_PAYABLE', amount: ob.amountMinor },
        { account: 'CASH', amount: -ob.amountMinor },
      ],
    });
    ob.paidDay = s.day;
    if (ob.id.startsWith('DUTY-')) {
      const sh = s.shipments.find((x) => `DUTY-${x.id}` === ob.id);
      if (sh) sh.dutyPaid = true;
    }
    log(s, `밀린 지급 완료: ${ob.reasonKo} ${formatMoney(ob.currency, ob.amountMinor)}`);
  }
}

function processPayroll(s: GameState, config: ScenarioConfig) {
  for (const emp of s.employees) {
    if (!isAvailableFromToday(s, emp.id)) continue;
    const def = config.employees.find((e) => e.id === emp.id);
    if (!def || def.salaryPerDayMinor === 0) continue;
    payOrAccrue(s, config, def.salaryCurrency, def.salaryPerDayMinor, `WAGE-D${pad(s.day)}-${emp.id}`, `${def.nameKo} ${s.day}일 급여`, undefined, 'WAGE_EXPENSE');
  }
}

// ── 공통 도우미 ──

function postOrThrow(
  s: GameState,
  entry: { id: string; currency: Currency; reason: string; lines: LedgerLine[]; contractId?: string | undefined },
) {
  const { contractId, ...rest } = entry;
  const posted = post(s.ledger, { ...rest, day: s.day, ...(contractId ? { contractId } : {}) });
  if (!posted) throw new EngineError(`분개 ${entry.id}가 이미 기록되어 있습니다. 같은 사건을 두 번 처리하려 했습니다.`);
}

function contractOf(s: GameState, id: string): Contract {
  const c = s.contracts.find((x) => x.id === id);
  if (!c) throw new EngineError(`계약 ${id}이(가) 없습니다.`);
  return c;
}

function log(s: GameState, textKo: string) {
  s.log.push({ day: s.day, textKo });
}

/** 시작 조건을 보존하고 시장 시드만 현재 저장에서 가져온다. */
export function restartWithSameSeed(state: GameState, config: ScenarioConfig): GameState {
  return createGame({ ...config, seed: state.rng.seed });
}
