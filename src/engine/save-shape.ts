import type { OfferDef, MarketBatch, OperationsState, DefaultEvent } from './types';
// 저장은 외부 입력이다. 판본 7의 필수 필드·배열 원소까지 확인한 뒤 엔진에 넘긴다.
import { ACCOUNT_KIND } from './ledger';
import { MINOR_PER_MAJOR } from './money';
import type { GameState, DayPhase, OfferState, Contract, CargoLot, Booking, Task,
  CultureReport, CultureRelationEvent, EmployeeState, CandidateState, Invoice, Notice, DelayDecision, CommandRecord } from './types';

// 실행 시점 상수가 없는 열거형도 전수 목록을 요구해 타입에 값이 늘면 컴파일에서 확인한다.
export const SAVE_ENUMS = {
  offerKind: { supplier: true, customer: true, forwarding: true } satisfies Record<OfferDef['kind'], true>,
  serviceClass: { STANDARD: true, HANDLING: true } satisfies Record<NonNullable<OfferDef['serviceClass']>, true>,
  marketSide: { BUY: true, SELL: true } satisfies Record<MarketBatch['rows'][number]['side'], true>,
  exchangeDirection: { USD_TO_KRW: true, KRW_TO_USD: true } satisfies Record<OperationsState['exchanges'][number]['direction'], true>,
  campaignOutcome: { IN_PROGRESS: true, COMPLETED: true, FAILED: true } satisfies Record<OperationsState['outcome'], true>,
  defaultLevel: { WARNING: true, DANGER: true } satisfies Record<DefaultEvent['level'], true>,
  cultureReportStatus: { UNVERIFIED: true } satisfies Record<CultureReport['status'], true>,
  cultureRelationKind: { SHARED_ACTIVITY: true } satisfies Record<CultureRelationEvent['kind'], true>,
  currency: MINOR_PER_MAJOR,
  account: ACCOUNT_KIND,
  phase: { PENDING_OPEN: true, AWAITING_INPUT: true, ENDED: true } satisfies Record<DayPhase, true>,
  offerStatus: { OPEN: true, ACCEPTED: true, EXPIRED: true } satisfies Record<OfferState['status'], true>,
  contractKind: { DIRECT_TRADE: true, FORWARDING: true } satisfies Record<Contract['kind'], true>,
  contractStatus: { ACTIVE: true, IN_PROGRESS: true, COMPLETED: true, CANCELLED: true } satisfies Record<Contract['status'], true>,
  cargoOwner: { COMPANY: true, CUSTOMER: true } satisfies Record<CargoLot['owner'], true>,
  cargoStatus: { PREPARING: true, AWAITING_DEPARTURE: true, IN_TRANSIT: true, ARRIVED_RELEASING: true,
    DELIVERED: true, HELD_UNALLOCATED: true, RETURNED_TO_OWNER: true } satisfies Record<CargoLot['status'], true>,
  bookingStatus: { BOOKED: true, DEPARTED: true, CANCELLED: true } satisfies Record<Booking['status'], true>,
  taskKind: { CULTURE: true, EXPORT_PREP: true, FORWARDING_PREP: true, SCOUT: true, RECRUIT_QUEST: true, TRAINING: true } satisfies Record<Task['kind'], true>,
  taskStatus: { QUEUED: true, RUNNING: true, DONE: true, ABORTED: true } satisfies Record<Task['status'], true>,
  employmentStatus: { employed: true, candidate: true } satisfies Record<EmployeeState['employmentStatus'], true>,
  candidateStage: { UNDISCOVERED: true, DISCOVERED: true, QUEST_RUNNING: true, INTERVIEW_READY: true, HIRED: true } satisfies Record<CandidateState['stage'], true>,
  invoiceStatus: { OUTSTANDING: true, OVERDUE: true, PAID: true, WRITTEN_OFF: true } satisfies Record<Invoice['status'], true>,
  noticeKind: { PORT_RESTRICTION: true } satisfies Record<Notice['kind'], true>,
  delayChoice: { KEEP_SHIPMENT_BOOKING: true } satisfies Record<NonNullable<DelayDecision['choice']>, true>,
  commandStatus: { APPLIED: true, REJECTED: true } satisfies Record<CommandRecord['status'], true>,
};

type Shape = (value: unknown, path: string) => void;
const scalar = (test: (v: unknown) => boolean): Shape => (v, path) => {
  if (!test(v)) throw new Error(`${path}: 저장 필드 모양이 올바르지 않습니다.`);
};
const str = scalar((v) => typeof v === 'string');
const int = scalar((v) => Number.isSafeInteger(v));
const bool = scalar((v) => typeof v === 'boolean');
const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const obj = (fields: Record<string, Shape>): Shape => (v, path) => {
  if (!record(v)) throw new Error(`${path}: 객체가 필요합니다.`);
  for (const [key, shape] of Object.entries(fields)) shape(v[key], `${path}.${key}`);
};
const array = (shape: Shape): Shape => (v, path) => {
  if (!Array.isArray(v)) throw new Error(`${path}: 배열이 필요합니다.`);
  v.forEach((item, i) => shape(item, `${path}[${i}]`));
};
const map = (shape: Shape): Shape => (v, path) => {
  if (!record(v)) throw new Error(`${path}: 기록 객체가 필요합니다.`);
  for (const [key, item] of Object.entries(v)) shape(item, `${path}.${key}`);
};
const oneOf = (...values: unknown[]) => scalar((v) => values.includes(v));
const enumShape = (name: keyof typeof SAVE_ENUMS) => oneOf(...Object.keys(SAVE_ENUMS[name]));
const nullable = (shape: Shape): Shape => (v, path) => { if (v !== null) shape(v, path); };
const optional = (shape: Shape): Shape => (v, path) => { if (v !== undefined) shape(v, path); };
const ns = nullable(str), ni = nullable(int), strings = array(str), currency = enumShape('currency');
const defaultEvent = obj({ day: int, level: enumShape('defaultLevel'), obligationId: str, currency,
  amountMinor: int, incurredDay: int, dueToSurviveMinor: int, lotsToSurvive: ni, lotsToClearAll: ni, usdAvailableMinor: int });
const unpaid = array(obj({ currency, amountMinor: int, count: int }));
const stateShape = obj({
  operations: nullable(obj({
    unaffordable: optional(array(obj({ day: int, buyOfferId: str, sellOfferId: str, quantity: int,
      shortfalls: array(obj({ currency, needMinor: int, availableMinor: int })) }))),
    batches: array(obj({ k: int, publishDay: int, index: array(obj({ goodId: str, bp: int, stepPct: ni })),
      destinations: nullable(array(obj({ goodId: str, cityId: str }))),
      rows: array(obj({ cityId: str, goodId: str, side: enumShape('marketSide'), basePriceMinor: int, regionalPct: int })),
      counterpartyPct: nullable(array(obj({ goodId: str, side: enumShape('marketSide'), pct: int }))),
      maxLots: nullable(array(obj({ goodId: str, lots: int }))), templateIds: strings, offerIds: strings, drawCount: int })),
    offers: array(obj({ id: str, kind: enumShape('offerKind'), counterpartyId: str, cityId: str, goodId: str,
      quantity: int, unitPriceMinor: int, serviceFeeMinor: int, declaredCargoValueMinor: ni, currency,
      validUntilDay: int, destinationCityId: ns, deliveryDeadlineDay: ni, paymentDueDay: ni, originCountryCode: ns,
      maxQuantity: int, quantityStep: int, serviceClass: nullable(enumShape('serviceClass')),
      publishDay: int, batchK: int, templateId: ns, titleKo: ns, prepWorkUnits: ni } satisfies Record<keyof OfferDef, Shape>)),
    expansions: array(obj({ id: str, orderedDay: int, effectiveDay: int })),
    handlingLog: array(obj({ day: int, capacityPt: int, usedPt: int,
      waits: array(obj({ taskId: str, contractId: str, wantPt: int, gotPt: int })) })),
    spaceContracts: array(obj({ id: str, routeId: str, signedDay: int, firstSailingDay: int, lastSailingDay: int,
      sailingCount: int, feeMinor: int, currency })),
    exchanges: array(obj({ id: str, day: int, direction: enumShape('exchangeDirection'), usdMinor: int, krwMinor: int, rateKrwPerUsd: int, spreadKrwMinor: int })),
    defaultEvents: array(defaultEvent), outcome: enumShape('campaignOutcome'),
    failure: nullable(obj({ day: int, obligationId: str, currency, amountMinor: int, reasonKo: str, incurredDay: int,
      unpaidByCurrency: unpaid, cashByCurrency: array(obj({ currency, amountMinor: int })),
      warningEvent: nullable(defaultEvent), dangerEvent: nullable(defaultEvent),
      optionalKrwSpendBeforeFirstUnpaid: array(obj({ entryId: str, day: int, amountMinor: int, reasonKo: str })),
      usdCommitmentsSinceIncurred: array(obj({ kind: oneOf('CONTRACT', 'SPACE_CONTRACT'), id: str, day: int, amountMinor: int })) })),
  } satisfies Record<keyof OperationsState, Shape>)),
  meta: obj({ engineVersion: str, rulesVersion: str, dataVersion: str, scenarioId: str }),
  day: scalar((v) => Number.isSafeInteger(v) && (v as number) >= 1),
  phase: enumShape('phase'),
  rng: obj({ seed: int, cursors: map(scalar((v) => Number.isSafeInteger(v) && (v as number) >= 0)) }),
  ledger: obj({ entries: array(obj({ id: str, day: int, currency, reason: str, contractId: optional(str),
    lines: array(obj({ amount: int, account: enumShape('account') })) })),
    postedIds: map(oneOf(true)) }),
  offers: array(obj({ id: str, status: enumShape('offerStatus') })),
  contracts: array(obj({ id: str, kind: enumShape('contractKind'),
    status: enumShape('contractStatus'), buyOfferId: ns, sellOfferId: ns,
    serviceOfferId: ns, supplierId: ns, customerId: str, goodId: str, quantity: int,
    creditTermId: optional(oneOf('BASE', 'D15', 'D30')),
    creditEligible: optional(obj({ dateRule: bool, limitBlocked: array(oneOf('D15', 'D30')) })),
    purchaseAmountMinor: int, saleAmountMinor: int, currency, originCityId: str, destinationCityId: str,
    deliveryDeadlineDay: int, paymentDueDay: int, acceptedDay: int, ownerEmployeeId: ns, cargoLotId: str,
    prepTaskId: str, bookingId: ns, invoiceId: ns, deliveredDay: ni, lateDays: int, priceReductionMinor: int,
    cancelledDay: ni, completedDay: ni })),
  cargoLots: array(obj({ id: str, owner: enumShape('cargoOwner'), ownerPartyId: ns, goodId: str,
    quantity: int, originCountryCode: str, carryingAmountMinor: int, currency, locationCityId: ns,
    status: enumShape('cargoStatus'),
    contractId: ns, shipmentId: ns })),
  bookings: array(obj({ id: str, contractId: str, routeId: str, sailingId: str, departureDay: int,
    massGrams: int, volumeLiters: int, prepaidFreightMinor: int, status: enumShape('bookingStatus') })),
  shipments: array(obj({ id: str, bookingId: str, contractId: str, cargoLotId: str, departureDay: int,
    scheduledArrivalDay: int, arrivalDay: ni, releaseDay: ni, observedWaitDays: int, delayEventIds: strings,
    dutyMinor: ni, dutyPaid: bool })),
  tasks: array(obj({ id: str, kind: enumShape('taskKind'),
    contractId: ns, subjectId: ns, cityId: str, requiredWorkUnits: int, progressWorkUnits: int,
    status: enumShape('taskStatus'), assignedEmployeeId: ns, startedDay: ni, completedDay: ni })),
  employees: array(obj({ id: str, xp: int, locationCityId: str, employmentStatus: enumShape('employmentStatus'), availableFromDay: int })),
  recruitment: obj({ candidates: array(obj({ employeeId: str,
    stage: enumShape('candidateStage'),
    discoveredDay: ni, questTaskId: ns, interviewReadyDay: ni, hiredDay: ni })), scoutedVenueIds: strings }),
  culture: obj({
    reports: array(obj({ key: str, activityId: str, topicId: str, cityId: str, sourceContactIds: strings,
      reporterEmployeeId: str, taskId: str, day: int, contentRevision: str, status: enumShape('cultureReportStatus') })),
    experiences: array(obj({ key: str, employeeId: str, activityId: str, topicId: str, cityId: str,
      countryCode: str, contentRevision: str, completedTaskId: str, verifiedDay: int })),
    relationEvents: array(obj({ key: str, employeeId: str, contactId: str, activityId: str, cityId: str,
      contentRevision: str, taskId: str, day: int, kind: enumShape('cultureRelationKind') })),
  }),
  invoices: array(obj({ id: str, contractId: str, currency, amountMinor: int, issuedDay: int, dueDay: int,
    status: enumShape('invoiceStatus'), receiptIds: strings })),
  obligations: array(obj({ id: str, currency, amountMinor: int, reasonKo: str, incurredDay: int, paidDay: ni })),
  notices: array(obj({ id: str, day: int, kind: enumShape('noticeKind'), eventInstanceId: str,
    titleKo: str, bodyKo: str, affectedShipmentIds: strings, evidenceKo: str })),
  delayDecisions: array(obj({ noticeId: str, shipmentId: str, choice: nullable(enumShape('delayChoice')), decidedDay: ni })),
  appliedEventIds: map(oneOf(true)), xpAwards: map(oneOf(true)), xpAwardAmounts: map(int),
  processedCommands: map(obj({ day: int, type: str, status: enumShape('commandStatus'), reasonKo: str })),
  closedDays: array(int), log: array(obj({ day: int, textKo: str })),
} satisfies Record<keyof GameState, Shape>);

export function checkSaveShape(value: unknown): asserts value is GameState {
  stateShape(value, 'state');
  const s = value as GameState;
  if (s.meta.rulesVersion === 'M2a-rules-4') {
    if (!Array.isArray(s.operations?.unaffordable)) throw new Error('state.operations.unaffordable: 배열이 필요합니다.');
  } else if (s.operations && Object.hasOwn(s.operations, 'unaffordable')) {
    throw new Error('state.operations.unaffordable: 규칙 4에서만 허용합니다.');
  }
}
