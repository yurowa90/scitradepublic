import { OPERATIONS_SCENARIO_IDS } from '../content/scenario';
import type { OfferDef, OperationsState, MarketBatch, DefaultEvent } from './types';
import { expect, expectTypeOf, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame } from './engine';
import { ACCOUNT_KIND, type Account } from './ledger';
import { MINOR_PER_MAJOR, type Currency } from './money';
import { checkSaveShape, SAVE_ENUMS } from './save-shape';
import type { GameState, DayPhase, OfferState, Contract, CargoLot, Booking, Task,
  CultureReport, CultureRelationEvent, EmployeeState, CandidateState, Invoice, Notice, DelayDecision, CommandRecord } from './types';

it('저장 열거 목록 전부가 엔진 타입과 일치하고 통화·계정은 실행 시점 상수를 공유한다', () => {
  type EnumTypes = {
    offerKind: OfferDef['kind']; serviceClass: NonNullable<OfferDef['serviceClass']>;
    marketSide: MarketBatch['rows'][number]['side']; exchangeDirection: OperationsState['exchanges'][number]['direction'];
    campaignOutcome: OperationsState['outcome']; defaultLevel: DefaultEvent['level'];
    currency: Currency; account: Account; phase: DayPhase; offerStatus: OfferState['status'];
    contractKind: Contract['kind']; contractStatus: Contract['status']; cargoOwner: CargoLot['owner'];
    cargoStatus: CargoLot['status']; bookingStatus: Booking['status']; taskKind: Task['kind'];
    taskStatus: Task['status']; employmentStatus: EmployeeState['employmentStatus']; candidateStage: CandidateState['stage'];
    invoiceStatus: Invoice['status']; noticeKind: Notice['kind']; delayChoice: NonNullable<DelayDecision['choice']>;
    commandStatus: CommandRecord['status'];
    cultureReportStatus: CultureReport['status']; cultureRelationKind: CultureRelationEvent['kind'];
  };
  expectTypeOf<{ [K in keyof typeof SAVE_ENUMS]: keyof typeof SAVE_ENUMS[K] }>().toEqualTypeOf<EnumTypes>();
  expect(SAVE_ENUMS.currency).toBe(MINOR_PER_MAJOR);
  expect(SAVE_ENUMS.account).toBe(ACCOUNT_KIND);

  // 불변 조건과 분리해 모든 열거값의 저장 모양 허용·거절을 직접 확인한다.
  const base = createGame(loadScenario('SCENARIO_M2_MULTI_TRADE'));
  const targets = {
    offerKind: ['operations', 'offers', 0, 'kind'], serviceClass: ['operations', 'offers', 0, 'serviceClass'],
    marketSide: ['operations', 'batches', 0, 'rows', 0, 'side'], exchangeDirection: ['operations', 'exchanges', 0, 'direction'],
    campaignOutcome: ['operations', 'outcome'], defaultLevel: ['operations', 'defaultEvents', 0, 'level'],
    cultureReportStatus: ['culture', 'reports', 0, 'status'],
    cultureRelationKind: ['culture', 'relationEvents', 0, 'kind'],
    currency: ['ledger', 'entries', 0, 'currency'], account: ['ledger', 'entries', 0, 'lines', 0, 'account'],
    phase: ['phase'], offerStatus: ['offers', 0, 'status'],
    contractKind: ['contracts', 0, 'kind'], contractStatus: ['contracts', 0, 'status'],
    cargoOwner: ['cargoLots', 0, 'owner'], cargoStatus: ['cargoLots', 0, 'status'],
    bookingStatus: ['bookings', 0, 'status'], taskKind: ['tasks', 0, 'kind'], taskStatus: ['tasks', 0, 'status'],
    employmentStatus: ['employees', 0, 'employmentStatus'], candidateStage: ['recruitment', 'candidates', 0, 'stage'],
    invoiceStatus: ['invoices', 0, 'status'], noticeKind: ['notices', 0, 'kind'],
    delayChoice: ['delayDecisions', 0, 'choice'], commandStatus: ['processedCommands', 'TEST', 'status'],
  } satisfies Record<keyof EnumTypes, (string | number)[]>;
  const cfg = loadScenario(OPERATIONS_SCENARIO_IDS[0]);
  base.operations = createGame(cfg).operations;
  base.operations!.offers.push({ ...cfg.offers[0]!, serviceClass: 'STANDARD' });
  base.operations!.exchanges.push({ id: '', day: 1, direction: 'USD_TO_KRW', usdMinor: 1, krwMinor: 1, rateKrwPerUsd: 1, spreadKrwMinor: 1 });
  base.operations!.defaultEvents.push({ day: 1, level: 'WARNING', obligationId: '', currency: 'KRW', amountMinor: 1,
    incurredDay: 1, dueToSurviveMinor: 1, lotsToSurvive: 1, lotsToClearAll: 1, usdAvailableMinor: 1 });
  base.culture.reports.push({ key: '', activityId: '', topicId: '', cityId: '', sourceContactIds: [],
    reporterEmployeeId: '', taskId: '', day: 1, contentRevision: '1', status: 'UNVERIFIED' });
  base.culture.relationEvents.push({ key: '', employeeId: '', contactId: '', activityId: '', cityId: '',
    contentRevision: '1', taskId: '', day: 1, kind: 'SHARED_ACTIVITY' });
  base.contracts.push({ id: 'CT', kind: 'DIRECT_TRADE', status: 'ACTIVE', buyOfferId: null, sellOfferId: null,
    serviceOfferId: null, supplierId: null, customerId: '', goodId: '', quantity: 1, purchaseAmountMinor: 0,
    saleAmountMinor: 0, currency: 'KRW', originCityId: '', destinationCityId: '', deliveryDeadlineDay: 1,
    paymentDueDay: 1, acceptedDay: 1, ownerEmployeeId: null, cargoLotId: '', prepTaskId: '', bookingId: null,
    invoiceId: null, deliveredDay: null, lateDays: 0, priceReductionMinor: 0, cancelledDay: null, completedDay: null });
  base.cargoLots.push({ id: '', owner: 'COMPANY', ownerPartyId: null, goodId: '', quantity: 1,
    originCountryCode: '', carryingAmountMinor: 0, currency: 'KRW', locationCityId: null,
    status: 'PREPARING', contractId: null, shipmentId: null });
  base.bookings.push({ id: '', contractId: '', routeId: '', sailingId: '', departureDay: 1,
    massGrams: 0, volumeLiters: 0, prepaidFreightMinor: 0, status: 'BOOKED' });
  base.tasks.push({ id: '', kind: 'SCOUT', contractId: null, subjectId: null, cityId: '', requiredWorkUnits: 1,
    progressWorkUnits: 0, status: 'QUEUED', assignedEmployeeId: null, startedDay: null, completedDay: null });
  base.invoices.push({ id: '', contractId: '', currency: 'KRW', amountMinor: 1, issuedDay: 1, dueDay: 1,
    status: 'OUTSTANDING', receiptIds: [] });
  base.notices.push({ id: '', day: 1, kind: 'PORT_RESTRICTION', eventInstanceId: '', titleKo: '', bodyKo: '',
    affectedShipmentIds: [], evidenceKo: '' });
  base.delayDecisions.push({ noticeId: '', shipmentId: '', choice: null, decidedDay: null });
  base.processedCommands.TEST = { day: 1, type: 'START_TRAINING', status: 'APPLIED', reasonKo: '' };
  const set = (s: GameState, path: (string | number)[], value: unknown) => {
    const parent = path.slice(0, -1).reduce<any>((o, key) => o[key], s);
    parent[path.at(-1)!] = value;
  };
  expect(() => checkSaveShape(base)).not.toThrow();
  for (const name of Object.keys(targets) as (keyof EnumTypes)[]) {
    for (const value of Object.keys(SAVE_ENUMS[name])) {
      const s = structuredClone(base);
      set(s, targets[name], value);
      expect(() => checkSaveShape(s), `${name}: ${value}`).not.toThrow();
    }
    const s = structuredClone(base);
    set(s, targets[name], 'INVALID');
    expect(() => checkSaveShape(s), name).toThrow(/저장 필드 모양/);
  }
});
