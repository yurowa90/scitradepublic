import { simulate } from './sim/sim';
import { policyById } from './sim/policies';
import { describe, expect, it } from 'vitest';
import { loadCreditProfile, loadRiskProfile, loadScenario } from '../content/scenario';
import { applyReceipt, commitDay, createGame, creditTermCheck, openDay, planState } from './engine';
import { checkInvariants } from './invariants';
import { balance, post, summarize, type LedgerEntry } from './ledger';
import { offerDef, openTradePairs } from './market';
import { applyBasisPoints, formatMoney } from './money';
import { paymentDefaultStatus } from './operations';
import { contractProgress } from './progress';
import { campaignSummary, contractReport, contractRiskReport } from './reports';
import { receivableSchedule } from './reports-lazy';
import { carryAccrued, defaultFor, divHalfAway, referenceRate, usdToKrwMinor, withRiskLevel, withRiskLevelV2 } from './risk';
import { drawUniform } from './rng';
import { deserializeSave, serializeSave } from './save';
import type { CreditTermId, GameState, ScenarioConfig } from './types';

const config = (level: 'R0P' | 'R1' | 'R2' | 'R3' | 'R4' = 'R4', seed = 2001) => withRiskLevelV2(
  { ...loadScenario('SCENARIO_M2_OPS_COS_LAVER'), seed }, level, loadRiskProfile('RISK_PROFILE_V2'), loadCreditProfile('RISK_PROFILE_V2'));
const amount = (entries: LedgerEntry[], account: 'CASH' | 'RECEIVABLE_CARRY' | 'BAD_DEBT') => entries
  .flatMap((e) => e.lines).filter((l) => l.account === account).reduce((n, l) => n + l.amount, 0);
const entriesFor = (s: GameState, prefix: string) => s.ledger.entries.filter((e) => e.id.startsWith(prefix));

// 실제 인수로 만든 계약을 인도 완료 손 고정물로 바꾼다. 매출·원가·현금은 모두 복식 분개한다.
function fixture(mode: 'DEFAULT' | 'LATE' | 'PARTIAL' | 'ON_TIME' = 'DEFAULT', due = 10,
  cfg = config(), term: CreditTermId = 'BASE') {
  cfg = structuredClone(cfg);
  cfg.terms.paymentDueDay = null;
  const risk = cfg.operations!.risk!;
  for (const t of risk.credit!.terms) { t.premiumBp = 0; t.factorPct = 100; }
  for (const g of risk.credit!.pDefaultBpByGrade) g.pDefaultBp = mode === 'DEFAULT' ? 10000 : 0;
  for (const g of risk.profile.collections.grades) {
    g.pOnTimeBp = mode === 'ON_TIME' ? 10000 : 0;
    g.pLateBp = mode === 'PARTIAL' ? 0 : 10000 - g.pOnTimeBp;
    g.pPartialBp = mode === 'PARTIAL' ? 10000 : 0;
  }
  risk.profile.collections.lateMinDays = mode === 'DEFAULT' ? 15 : 6;
  risk.profile.collections.lateMaxDays = mode === 'DEFAULT' ? 15 : 6;
  risk.profile.collections.partialBp = 5000;
  let s = openDay(createGame(cfg), cfg).state;
  post(s.ledger, { id: '시험-자본', day: 1, currency: 'KRW', reason: '손 고정물 자본',
    lines: [{ account: 'CASH', amount: 1000000000 }, { account: 'OPENING_EQUITY', amount: -1000000000 }] });
  const pair = openTradePairs(s, cfg)[0]!;
  const buy = offerDef(s, cfg, pair.buyOfferId)!, sell = offerDef(s, cfg, pair.sellOfferId)!;
  for (const o of [buy, sell]) { o.quantity = 1; o.quantityStep = 1; o.maxQuantity = 1; }
  sell.unitPriceMinor = 12345; sell.paymentDueDay = due - risk.credit!.terms.find((t) => t.id === term)!.days;
  const accepted = planState(s, cfg, [{ id: '손-인수', type: 'ACCEPT_TRADE', ...pair, quantity: 1, creditTermId: term }]);
  expect(accepted.results[0]!.status).toBe('APPLIED'); s = accepted.state;
  const c = s.contracts[0]!, invId = `INV-${c.id}`, lot = s.cargoLots[0]!;
  c.deliveredDay = 1; c.status = 'IN_PROGRESS'; c.invoiceId = invId;
  lot.status = 'DELIVERED'; s.tasks.find((t) => t.id === c.prepTaskId)!.status = 'ABORTED';
  s.invoices.push({ id: invId, contractId: c.id, amountMinor: 12345, currency: 'USD', dueDay: due,
    issuedDay: 1, status: 'OUTSTANDING', receiptIds: [] });
  const add = (id: string, currency: LedgerEntry['currency'], lines: LedgerEntry['lines']) => post(s.ledger,
    { id, currency, day: 1, contractId: c.id, reason: '인도 손 고정물', lines });
  add(`SALE-${c.id}`, 'USD', [{ account: 'ACCOUNTS_RECEIVABLE', amount: 12345 }, { account: 'REVENUE', amount: -12345 }]);
  add(`COGS-${c.id}`, lot.currency, [{ account: 'COST_OF_GOODS_SOLD', amount: lot.carryingAmountMinor }, { account: 'INVENTORY', amount: -lot.carryingAmountMinor }]);
  const route = cfg.routes.find((r) => r.fromCityId === c.originCityId && r.toCityId === c.destinationCityId)!;
  add(`FREIGHT-PREPAY-${c.id}`, 'USD', [{ account: 'COST_OF_GOODS_SOLD', amount: route.bookingFeeMinor }, { account: 'CASH', amount: -route.bookingFeeMinor }]);
  s.shipments.push({ id: '손-선적', contractId: c.id, bookingId: '손-예약', cargoLotId: lot.id,
    departureDay: 1, scheduledArrivalDay: 1, arrivalDay: 1, releaseDay: 1, dutyMinor: 0, dutyPaid: true, observedWaitDays: 0, delayEventIds: [] });
  expect(() => checkInvariants(s, cfg)).not.toThrow();
  return { cfg, s, id: c.id, invId, pair };
}
type Fixture = ReturnType<typeof fixture>;
function through(f: Fixture, day: number): GameState {
  let s = structuredClone(f.s);
  while (s.day <= day && s.phase !== 'ENDED') s = commitDay(openDay(s, f.cfg).state, f.cfg, []).state;
  return s;
}
const inv = (s: GameState, f: Fixture) => s.invoices.find((i) => i.id === f.invId)!;
const ctr = (s: GameState, f: Fixture) => s.contracts.find((c) => c.id === f.id)!;
const carries = (s: GameState, f: Fixture) => entriesFor(s, `CARRY-${f.invId}-`);
const receipts = (s: GameState, f: Fixture) => entriesFor(s, `RECEIPT-RCPT-${f.invId}`);

// BASE의 실제 키 순서. 새 판본도 기존 보고에 필수 칸을 추가하지 않는다.
const componentKeys = ['schedule', 'fx', 'tariff', 'surcharge', 'late', 'claim', 'cancel', 'collection', 'open_valuation', 'residual'];
const reportKeys = ['contract', 'netRevenue', 'directCost', 'cancellationExpense', 'contribution'];
const bookKeys = ['currency', 'cash', 'inventory', 'prepaidFreight', 'forwardingWip', 'accountsReceivable', 'accountsPayable', 'totalAssets',
  'revenue', 'costOfGoodsSold', 'forwardingRevenue', 'forwardingCost', 'cancellationExpense', 'wageExpense', 'recruitmentExpense',
  'trainingExpense', 'cultureExpense', 'rentExpense', 'facilitySetupExpense', 'spaceContractExpense', 'fxSpreadExpense', 'currencyTransferNet', 'profit', 'openingEquity'];

describe('TASK-0067b 대손·이자', () => {
  it('1 R4 층과 R0P~R3의 0 성분·기존 동작', () => {
    expect(config().operations!.risk!.layers).toEqual(['FX', 'TARIFF', 'SURCHARGE', 'CLAIM', 'COLLECTION', 'DEFAULT', 'CARRY']);
    for (const level of ['R0P', 'R1', 'R2', 'R3'] as const) {
      const f = fixture('LATE', 10, config(level)), s = through(f, 26);
      expect(carries(s, f)).toEqual([]);
      expect(inv(s, f).status).toBe('PAID');
      const r = contractRiskReport(s, f.cfg, f.id);
      expect(r.components).toMatchObject({ default: 0, carry: 0, residual: 0 });
      expect(Object.keys(r.components)).toEqual([...componentKeys.slice(0, 8), 'default', 'carry', ...componentKeys.slice(8)]);
    }
  });
  it.each([
    ['R0P', '4be706cd19159210628684b4ffa004caa912d73f1d0ffede475b2aed6703a580'],
    ['R1', '299a8f0430a476fb279e8fd355670c432e3958ff162fae4a1e7cc8d7099c4c4a'],
    ['R2', '194635b6b1cf766dea842036772df948c2cd95f8ebcb682c27c09089b455cc51'],
    ['R3', '79e4a37fb2ab9b70c9a39fe958a9a9b0c627c8474c62284fb261751243af71af'],
  ] as const)('1 %s의 실제 상태·원장은 BASE 시드 2001과 같다', async (level, hash) => {
    // 기존 상태·원장 해시는 k=0 외상 프로필의 BASE 동작을 고정한다.
    const { saleMarginK: _, ...credit } = loadCreditProfile('RISK_PROFILE_V2');
    const cfg = withRiskLevelV2({ ...loadScenario('SCENARIO_M2_OPS_COS_LAVER'), seed: 2001 },
      level, loadRiskProfile('RISK_PROFILE_V2'), credit);
    const { state } = simulate(cfg, policyById('MAX_CONTRIBUTION')!, 2001);
    // TASK-0074의 놓친 견적 기록은 결정에 쓰이지 않는 새 칸이다. 이 칸을 뺀 상태가 BASE 해시와 같아야 한다.
    expect(Array.isArray(state.operations!.unaffordable)).toBe(true);
    const { unaffordable: _u, ...operations } = state.operations!;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ ...state, operations })));
    expect(Array.from(new Uint8Array(digest), (n) => n.toString(16).padStart(2, '0')).join('')).toBe(hash);
  });
  it('2 대손 추첨 결정론·조건 계수 반올림·DEFAULT 층', () => {
    const cfg = config(), risk = cfg.operations!.risk!, customer = risk.profile.collections.byCounterparty[0]!;
    risk.credit!.pDefaultBpByGrade.find((g) => g.grade === customer.grade)!.pDefaultBp = 201;
    for (const term of risk.credit!.terms) for (let seed = 2001; seed < 2201; seed++) {
      const v = Math.floor(drawUniform({ seed, cursors: { 'COLLECT:손-견적:default': 0 } }, 'COLLECT:손-견적:default').value * 10000);
      const probability = Math.floor((201 * term.factorPct + 50) / 100);
      const actual = defaultFor(cfg, seed, '손-견적', customer.counterpartyId, term.id);
      expect(actual).toBe(v < probability);
      expect(defaultFor(cfg, seed, '손-견적', customer.counterpartyId, term.id)).toBe(actual);
    }
    // 201 × 150 / 100 = 301.5: 추첨값 301은 반올림 302에서만 대손이다.
    let boundarySeed = 2001;
    while (Math.floor(drawUniform({ seed: boundarySeed, cursors: { 'COLLECT:손-견적:default': 0 } }, 'COLLECT:손-견적:default').value * 10000) !== 301) boundarySeed++;
    expect(defaultFor(cfg, boundarySeed, '손-견적', customer.counterpartyId, 'D15')).toBe(true);
    risk.layers = risk.layers.filter((l) => l !== 'DEFAULT');
    for (const g of risk.credit!.pDefaultBpByGrade) g.pDefaultBp = 10000;
    expect(defaultFor(cfg, 2001, '손-견적', customer.counterpartyId, 'BASE')).toBe(false);
  });
  it('2 같은 계약에서 D30 조건 계수가 BASE와 다른 대손 결과를 만든다', () => {
    const f = fixture('DEFAULT', 40);
    f.cfg.operations!.risk!.credit = structuredClone(loadCreditProfile('RISK_PROFILE_V2'));
    // 조건 계수만 분리하려고 기간·가산은 두 조건 모두 0으로 맞춘다.
    for (const term of f.cfg.operations!.risk!.credit!.terms) { term.days = 0; term.premiumBp = 0; }
    const c = ctr(f.s, f), risk = f.cfg.operations!.risk!;
    const stream = `COLLECT:${c.sellOfferId}:default`;
    // 시드 2003의 실제 계약 추첨값 953: BASE 500bp < 953 < D30 1000bp.
    const seed = 2003;
    expect(Math.floor(drawUniform({ seed, cursors: {} }, stream).value * 10000)).toBe(953);
    expect(defaultFor(f.cfg, seed, c.sellOfferId!, c.customerId, 'BASE')).toBe(false);
    expect(defaultFor(f.cfg, seed, c.sellOfferId!, c.customerId, 'D30')).toBe(true);
    f.s.rng.seed = seed; f.cfg.seed = seed;
    const base = through(f, 55);
    const d30 = structuredClone(f); ctr(d30.s, d30).creditTermId = 'D30';
    expect(ctr(f.s, f).creditTermId).toBe('BASE');
    expect(risk.credit!.terms.find((t) => t.id === 'D30')!.factorPct).toBe(200);
    expect(inv(through(d30, 55), d30).status).toBe('WRITTEN_OFF');
    expect(inv(base, f).status).toBe('PAID');
    expect(entriesFor(base, 'BADDEBT-')).toEqual([]);
  });
  it('2 추첨값이 반올림 확률과 같으면 대손이 아니다', () => {
    const cfg = config(), risk = cfg.operations!.risk!, customer = risk.profile.collections.byCounterparty[0]!;
    const draw = Math.floor(drawUniform({ seed: 2001, cursors: {} }, 'COLLECT:손-경계:default').value * 10000);
    risk.credit!.terms.find((t) => t.id === 'BASE')!.factorPct = 100;
    risk.credit!.pDefaultBpByGrade.find((g) => g.grade === customer.grade)!.pDefaultBp = draw;
    expect(divHalfAway(draw * 100, 100)).toBe(draw);
    expect(defaultFor(cfg, 2001, '손-경계', customer.counterpartyId, 'BASE')).toBe(false);
  });
  it('1 R4 (다) MAX_CONTRIBUTION 시드 2001 전체 실행', () => {
    const { state } = simulate(config('R4', 2001), policyById('MAX_CONTRIBUTION')!, 2001);
    expect(state.phase).toBe('ENDED');
    expect(state.operations!.outcome).toBe('COMPLETED');
  }, 60000);
  it('3 R4 주선 청구서는 대손 확률 10000이어도 결제일에 수금한다', () => {
    const f = fixture(); ctr(f.s, f).kind = 'FORWARDING';
    expect(f.cfg.operations!.risk!.credit!.pDefaultBpByGrade.every((g) => g.pDefaultBp === 10000)).toBe(true);
    const s = through(f, 10);
    expect(inv(s, f).status).toBe('PAID');
    expect(receipts(s, f).map((e) => [e.day, amount([e], 'CASH')])).toEqual([[10, 12345]]);
    expect(entriesFor(through(f, 25), 'BADDEBT-')).toEqual([]);
    expect(carries(through(f, 25), f)).toEqual([]);
  });
  it('5 결제일 뒤 부분 회수 두 번의 이자는 누적액의 증분이다', () => {
    const f = fixture('LATE');
    // 12일 마감까지 전액 미수, 13일부터 부분 회수 처리로 전환한다.
    f.s = through(f, 12);
    for (const g of f.cfg.operations!.risk!.profile.collections.grades) {
      g.pLateBp = 0; g.pPartialBp = 10000;
    }
    const s = through(f, 16);
    expect(receipts(s, f).map((e) => [e.day, amount([e], 'CASH')])).toEqual([[13, 6173], [16, 6172]]);
    // 12345×3×2=74070 → 7, 이후 6172×3×3=55548, 합 129618 → 13.
    expect(carries(s, f).map((e) => [e.id, e.day, amount([e], 'RECEIVABLE_CARRY')])).toEqual([
      [`CARRY-${f.invId}-1`, 13, 7], [`CARRY-${f.invId}-2`, 16, 6],
    ]);
    expect(carryAccrued(s, f.cfg, f.invId, 16)).toBe(129618);
    expect(amount(carries(s, f), 'RECEIVABLE_CARRY')).toBe(13);
    expect(divHalfAway(carryAccrued(s, f.cfg, f.invId, 16), 10000)).toBe(13);
  });
  it('3 대손 확정 분개 ID 순서 전체·금액·상태·로그', () => {
    const f = fixture();
    f.cfg.operations!.risk!.profile.collections.lateMinDays = 5;
    const before = through(f, 24), s = through(f, 25);
    expect(inv(s, f).dueDay + f.cfg.operations!.risk!.profile.collections.lateMaxDays).toBe(25);
    expect(inv(before, f).status).toBe('OVERDUE'); expect(receipts(before, f)).toEqual([]);
    const entries = s.ledger.entries.filter((e) => e.contractId === f.id && e.day === 25);
    expect(entries.map((e) => e.id)).toEqual([`RECEIPT-RCPT-${f.invId}-R`, `CARRY-${f.invId}-1`, `BADDEBT-${f.invId}`]);
    expect(entries.map((e) => e.lines)).toEqual([
      [{ account: 'CASH', amount: 3704 }, { account: 'ACCOUNTS_RECEIVABLE', amount: -3704 }],
      [{ account: 'RECEIVABLE_CARRY', amount: 52 }, { account: 'CASH', amount: -52 }],
      [{ account: 'BAD_DEBT', amount: 8641 }, { account: 'ACCOUNTS_RECEIVABLE', amount: -8641 }],
    ]);
    expect(inv(s, f)).toMatchObject({ status: 'WRITTEN_OFF', receiptIds: [`RCPT-${f.invId}-R`] });
    expect(ctr(s, f)).toMatchObject({ status: 'COMPLETED', completedDay: 25 });
    expect(s.log.filter((l) => l.textKo.includes('회수 불능'))).toEqual([
      expect.objectContaining({ day: 25, textKo: `${f.id} 대금 회수 불능 확정: ${formatMoney('USD', 3704)} 회수, ${formatMoney('USD', 8641)} 대손 처리` }),
    ]);
    expect(carryAccrued(s, f.cfg, f.invId, 26)).toBe(518490);
    expect(carryAccrued(s, f.cfg, f.invId, 90)).toBe(518490);
  });
  it.each(['BASE', 'D15'] as const)('3 %s의 확정일 90·91 경계', (term) => {
    for (const due of [75, 76]) {
      // 비BASE 날짜 선택은 인도 지연으로 실효 결제일이 하루 늘어나는 상황도 포함한다.
      const f = fixture('DEFAULT', 75, config(), term); inv(f.s, f).dueDay = due;
      const s = through(f, 90);
      expect(s.phase).toBe('ENDED');
      expect(inv(s, f).status).toBe(due === 75 ? 'WRITTEN_OFF' : 'OVERDUE');
      expect(balance(s.ledger, 'USD', 'ACCOUNTS_RECEIVABLE')).toBe(due === 75 ? 0 : 12345);
    }
  });
  it('4 비BASE 대손 종결 청구서는 노출액에서 제외', () => {
    const f = fixture('DEFAULT', 30, config(), 'D15');
    const exposure = (s: GameState) => creditTermCheck(s, f.cfg, f.pair.buyOfferId, f.pair.sellOfferId, 1, 'D15').exposureMinor;
    expect(exposure(f.s)).toBe(12345);
    const s = through(f, 45); expect(inv(s, f).status).toBe('WRITTEN_OFF'); expect(exposure(s)).toBe(0);
    ctr(s, f).status = 'IN_PROGRESS'; expect(exposure(s)).toBe(0);
  });
  it.each([['LATE', 185175, 19], ['PARTIAL', 92580, 9], ['DEFAULT', 518490, 52], ['ON_TIME', 0, 0]] as const)(
    '5 %s 합계 반올림·분개일 제외·마지막 수금일 이자', (mode, accrued, expected) => {
      const f = fixture(mode), day = mode === 'DEFAULT' ? 25 : mode === 'ON_TIME' ? 10 : 16, s = through(f, day);
      expect(amount(carries(s, f), 'RECEIVABLE_CARRY')).toBe(expected);
      expect(carryAccrued(s, f.cfg, f.invId, day)).toBe(accrued);
      expect(carryAccrued(s, f.cfg, f.invId, 90)).toBe(accrued);
      if (mode !== 'DEFAULT') expect(inv(s, f).status).toBe('PAID');
      if (expected) expect(carries(s, f)[0]!.day).toBe(day);
      if (mode === 'PARTIAL') expect(receipts(s, f).map((e) => [e.day, amount([e], 'CASH')])).toEqual([[10, 6173], [16, 6172]]);
      if (mode === 'LATE') expect(s.ledger.entries.filter((e) => e.contractId === f.id && e.day === 16).map((e) => e.id))
        .toEqual([`RECEIPT-RCPT-${f.invId}`, `CARRY-${f.invId}-1`]);
    });
  it('5 CARRY 층 없음·직접 무역 아닌 청구서는 이자 없음', () => {
    const f = fixture('LATE'); f.cfg.operations!.risk!.layers = f.cfg.operations!.risk!.layers.filter((l) => l !== 'CARRY');
    const s = through(f, 16); expect(carryAccrued(s, f.cfg, f.invId, 16)).toBe(0); expect(carries(s, f)).toEqual([]);
    f.cfg.operations!.risk!.layers.push('CARRY'); ctr(s, f).kind = 'FORWARDING';
    expect(carryAccrued(s, f.cfg, f.invId, 16)).toBe(0);
  });
  it('6 종결 경로·다음 수금일과 같은 날 금액·미수 보고·불변식', () => {
    const f = fixture(), s = through(f, 45), off = inv(s, f);
    s.obligations.push({ id: '시험-미지급', currency: 'USD', amountMinor: 100, incurredDay: 20, paidDay: null, reasonKo: '시험' });
    post(s.ledger, { id: '시험-미지급', currency: 'USD', day: 20, reason: '시험', lines: [{ account: 'CANCELLATION_EXPENSE', amount: 100 }, { account: 'ACCOUNTS_PAYABLE', amount: -100 }] });
    s.invoices.push({ ...off, id: '미수', amountMinor: 777, dueDay: 30, status: 'OUTSTANDING', receiptIds: [] });
    post(s.ledger, { id: '시험-미수', currency: 'USD', day: 25, reason: '시험', lines: [{ account: 'ACCOUNTS_RECEIVABLE', amount: 777 }, { account: 'REVENUE', amount: -777 }] });
    // 인도가 늦어 같은 결제일(30일)이 된 두 번째 대손 청구서를 원장까지 복제한다.
    const secondId = '둘째-계약', secondInv = `INV-${secondId}`;
    s.contracts.push({ ...ctr(s, f), id: secondId, invoiceId: secondInv, deliveredDay: 30, completedDay: 45 });
    s.invoices.push({ ...off, id: secondInv, contractId: secondId, dueDay: 30, issuedDay: 30,
      receiptIds: [`RCPT-${secondInv}-R`] });
    for (const entry of s.ledger.entries.filter((e) => e.contractId === f.id)) {
      const e = structuredClone(entry); e.id = e.id.replaceAll(f.id, secondId); e.contractId = secondId;
      if (e.id.startsWith('RECEIPT-') || e.id.startsWith('CARRY-') || e.id.startsWith('BADDEBT-')) e.day = 45;
      post(s.ledger, e);
    }
    expect(paymentDefaultStatus(s, f.cfg).recovery.nextReceipt).toEqual({ day: 30, amountMinor: 777 });
    expect(campaignSummary(s, f.cfg).openInvoices.map((i) => i.invoiceId)).toEqual(['미수']);
    expect(receivableSchedule(s, f.cfg).map((i) => i.invoiceId)).toEqual(['미수']);
    expect(contractProgress(s, f.cfg, ctr(s, f)).nextKo).toBe('25일 대금 회수 불능 · 대손 종결');
    expect(applyReceipt(s, '다시-수금', f.invId)).toBe(false);
    expect(() => checkInvariants(s, f.cfg)).not.toThrow();
    const later = through({ ...f, s: through(f, 25) }, 40);
    expect(receipts(later, f)).toEqual(receipts(through(f, 25), f));
    expect(carries(later, f)).toEqual(carries(through(f, 25), f));
  });
  it.each(['LATE', 'PARTIAL', 'ON_TIME'] as const)('7 대손 아닌 %s의 R3·R4 실제 수금 동일', (mode) => {
    const f = fixture(mode), a = through(f, 30), cfg = structuredClone(f.cfg);
    cfg.operations!.risk!.layers = cfg.operations!.risk!.layers.filter((l) => l !== 'DEFAULT' && l !== 'CARRY');
    const b = through({ ...f, cfg }, 30);
    expect(receipts(a, f)).toEqual(receipts(b, f));
  });
  it('8 확정일·평가일 환율 차이와 default·carry 성분 손 계산', () => {
    const cfg = config();
    let seed = 2001;
    while (seed < 20001 && !(referenceRate(cfg, seed, 25) === 1206
      && referenceRate(cfg, seed, 25) !== referenceRate(cfg, seed, 36))) seed++;
    const f = fixture('DEFAULT', 10, config('R4', seed)), s = through(f, 35);
    const rT = referenceRate(f.cfg, seed, 25), rE = referenceRate(f.cfg, seed, 36);
    expect(rT).not.toBe(rE);
    expect(seed).toBeLessThan(20001);
    // 같은 환율 비용 7센트와 이자 52센트는 함께 반올림해야 1원 차이를 잡는다.
    post(s.ledger, { id: 'SURCHARGE-손-반올림', day: 25, currency: 'USD', contractId: f.id, reason: '반올림 고정물',
      lines: [{ account: 'INVENTORY', amount: 7 }, { account: 'CASH', amount: -7 }] });
    post(s.ledger, { id: 'COGS-손-반올림', day: 25, currency: 'USD', contractId: f.id, reason: '반올림 고정물',
      lines: [{ account: 'COST_OF_GOODS_SOLD', amount: 7 }, { account: 'INVENTORY', amount: -7 }] });
    const r = contractRiskReport(s, f.cfg, f.id);
    const expectedDefault = usdToKrwMinor(3704, rT) - usdToKrwMinor(12345, rT);
    expect(expectedDefault).not.toBe(-usdToKrwMinor(8641, rT));
    // 이자와 같은 환율의 현금 원가를 모아 한 번 반올림한 차이다.
    const sameRateCosts = s.ledger.entries.filter((e) => e.contractId === f.id && e.currency === 'USD'
      && !e.id.startsWith('RECEIPT-') && !e.id.startsWith('CARRY-') && referenceRate(f.cfg, seed, e.day) === rT);
    const costs = amount(sameRateCosts, 'CASH');
    const expectedCarry = usdToKrwMinor(costs - 52, rT) - usdToKrwMinor(costs, rT);
    expect(r.components.residual).toBe(0);
    expect(r.components.default).toBe(expectedDefault);
    expect(expectedCarry).not.toBe(-usdToKrwMinor(52, rT));
    expect(r.components.carry).toBe(expectedCarry);
    expect(r.components.residual).toBe(0); expect(r.open).toBe(false);
  });
  it('8 진행 중·캠페인 끝의 미기재 이자는 마지막 마감까지만', () => {
    for (const [due, closed] of [[10, 14], [76, 90]] as const) {
      const f = fixture('DEFAULT', due), s = through(f, closed), r = contractRiskReport(s, f.cfg, f.id);
      const expected = Math.floor(((closed - due) * 12345 * 3 + 5000) / 10000);
      const evaluationDay = closed === 90 ? 90 : closed + 1;
      expect(r.evaluationDay).toBe(evaluationDay);
      expect(carries(s, f)).toEqual([]); expect(inv(s, f).status).toBe('OVERDUE');
      expect(r.components.default).toBe(0);
      expect(r.components.carry).toBe(-usdToKrwMinor(expected, referenceRate(f.cfg, s.rng.seed, evaluationDay)));
      expect(r.components.residual).toBe(0);
    }
    // 미기재 이자도 평가일(25일) 환율 1206의 원가 7센트와 묶는다.
    const pending = fixture('DEFAULT', 10, config('R4', 7737)), open = through(pending, 24);
    post(open.ledger, { id: 'SURCHARGE-미기재-반올림', day: 25, currency: 'USD', contractId: pending.id, reason: '평가일 원가',
      lines: [{ account: 'INVENTORY', amount: 7 }, { account: 'CASH', amount: -7 }] });
    post(open.ledger, { id: 'COGS-미기재-반올림', day: 25, currency: 'USD', contractId: pending.id, reason: '평가일 원가 대체',
      lines: [{ account: 'COST_OF_GOODS_SOLD', amount: 7 }, { account: 'INVENTORY', amount: -7 }] });
    expect(referenceRate(pending.cfg, 7737, 25)).toBe(1206);
    expect(carries(open, pending)).toEqual([]);
    const pendingReport = contractRiskReport(open, pending.cfg, pending.id);
    const combined = usdToKrwMinor(-59, 1206) - usdToKrwMinor(-7, 1206);
    const separate = -usdToKrwMinor(52, 1206);
    expect(combined).toBe(-628); expect(separate).toBe(-627);
    expect(pendingReport.components.carry).toBe(combined);
    expect(pendingReport.components.carry).not.toBe(separate);
    expect(pendingReport.components.residual).toBe(0);
    const f = fixture('LATE'), s = through(f, 20), r = contractRiskReport(s, f.cfg, f.id);
    expect(r.components.carry).toBe(-usdToKrwMinor(19, referenceRate(f.cfg, 2001, 16)));
    expect(r.components.residual).toBe(0);
  });
  it('9 원장 profit·계약 contribution에 두 비용 반영·기존 키 보존', () => {
    const f = fixture(), s = through(f, 25), c = ctr(s, f), report = contractReport(s, c);
    expect(report.contribution).toBe(report.netRevenue - report.directCost - report.cancellationExpense - 8641 - 52);
    expect(summarize(s.ledger, 'USD').profit).toBe(report.contribution);
    expect(Object.keys(report)).toEqual(reportKeys);
    const cfg3 = withRiskLevel({ ...loadScenario('SCENARIO_M2_OPS_COS_LAVER'), seed: 2001 }, 'R3', loadRiskProfile('RISK_PROFILE_DEFAULT'));
    expect(Object.keys(summarize(createGame(cfg3).ledger, 'USD'))).toEqual(bookKeys);
    expect(Object.keys(contractRiskReport(s, cfg3, f.id).components)).toEqual(componentKeys);
  });
  it('10 판본 4 대손·두 비용 계정 저장 왕복 바이트', () => {
    const f = fixture(), s = through(f, 25), text = serializeSave(s);
    expect(text).toContain('WRITTEN_OFF'); expect(text).toContain('BAD_DEBT'); expect(text).toContain('RECEIVABLE_CARRY');
    expect(JSON.parse(text).formatVersion).toBe(7);
    expect(serializeSave(deserializeSave(text, { config: f.cfg, dataVersion: f.cfg.dataVersion }))).toBe(text);
  });
  it('11 손으로 만든 대손·이자 위반 상태를 각각 거절', () => {
    const f = fixture(), valid = through(f, 25);
    const cases: [string, (s: GameState) => void][] = [
      ['대손 회수·손실 분개 수와 합계', (s) => { s.ledger.entries = s.ledger.entries.filter((e) => e.id !== `RECEIPT-RCPT-${f.invId}-R`); }],
      ['대손 회수·손실 분개 수와 합계', (s) => { s.ledger.entries = s.ledger.entries.filter((e) => e.id !== `BADDEBT-${f.invId}`); }],
      ['대손 회수·손실 분개 수와 합계', (s) => { s.ledger.entries.find((e) => e.id === `BADDEBT-${f.invId}`)!.lines[0]!.amount--; }],
      ['대손 회수·손실 분개일이 확정일과 다릅니다', (s) => { s.ledger.entries.find((e) => e.id === `BADDEBT-${f.invId}`)!.day--; }],
      ['대손 종결 계약의 상태·완료일이 다릅니다', (s) => { ctr(s, f).completedDay = 24; }],
      ['대손 확정 뒤 수금·이자 분개', (s) => { const e = structuredClone(receipts(s, f)[0]!); e.id += '-추가'; e.day = 26; post(s.ledger, e); }],
      ['대손 확정 뒤 수금·이자 분개', (s) => { const e = structuredClone(carries(s, f)[0]!); e.id += '-추가'; e.day = 26; post(s.ledger, e); }],
      ['확정일이 캠페인 끝을 넘는 청구서는 대손 종결할 수 없습니다', (s) => { inv(s, f).dueDay = 76; }],
      ['지연 이자 합계가 마지막 분개일 누적 이자와 다릅니다', (s) => { carries(s, f)[0]!.lines[0]!.amount++; carries(s, f)[0]!.lines[1]!.amount--; }],
    ];
    for (const [message, mutate] of cases) {
      const s = structuredClone(valid); mutate(s);
      expect(() => checkInvariants(s, f.cfg), message).toThrow(message);
    }
  });
  it('11 rules-3에는 대손 종결 청구서를 넣을 수 없다', () => {
    const f = fixture(), s = through(f, 25);
    const cfg = structuredClone(f.cfg); cfg.rules.rulesVersion = 'M2a-rules-3';
    expect(() => checkInvariants(s, cfg)).toThrow('대손·지연 이자는 규칙 4에서만 쓸 수 있습니다');
  });
  it('11 회수 0이면 회수 분개 없이 대손 종결·그 뒤 이자 없음', () => {
    const f = fixture(); f.cfg.operations!.risk!.credit!.recoveryBp = 0;
    const s = through(f, 40); expect(receipts(s, f)).toEqual([]);
    expect(balance(s.ledger, 'USD', 'BAD_DEBT')).toBe(12345);
    expect(() => checkInvariants(s, f.cfg)).not.toThrow();
  });
  it('12 결제일부터 확정 전날까지 대손과 지연 전액의 청구서·계약·로그·읽기가 같다', () => {
    const f = fixture(), cfg = structuredClone(f.cfg);
    for (const g of cfg.operations!.risk!.credit!.pDefaultBpByGrade) g.pDefaultBp = 0;
    for (let day = 10; day < 25; day++) {
      const a = through(f, day), b = through({ ...f, cfg }, day);
      expect(inv(a, f).status).toBe('OVERDUE');
      expect(defaultFor(f.cfg, 2001, ctr(a, f).sellOfferId!, ctr(a, f).customerId, 'BASE')).toBe(true);
      expect(defaultFor(cfg, 2001, ctr(b, f).sellOfferId!, ctr(b, f).customerId, 'BASE')).toBe(false);
      expect(inv(a, f)).toEqual(inv(b, f)); expect(ctr(a, f)).toEqual(ctr(b, f));
      const logs = (s: GameState) => s.log.filter((l) => l.textKo.includes(f.id)).map((l) => ({ ...l, textKo: l.textKo.replaceAll(f.id, '') }));
      expect(logs(a)).toEqual(logs(b));
      expect(contractProgress(a, f.cfg, ctr(a, f))).toEqual(contractProgress(b, cfg, ctr(b, f)));
      expect(paymentDefaultStatus(a, f.cfg)).toEqual(paymentDefaultStatus(b, cfg));
    }
  });
});
