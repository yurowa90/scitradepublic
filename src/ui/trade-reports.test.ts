import { cityName, listSailings, routeBetween, unitKo } from '../engine/catalog';
import { workloadSummary } from '../engine/capacity';
import { isAvailableFromToday } from '../engine/employees';
import { formatMoney } from '../engine/money';
import { contractProgress } from '../engine/progress';
import { fundsPosition } from '../engine/reservations';
import type { Command } from '../engine/types';
import { BOTTLENECK_OF, bottlenecks, cargoListKo, heldCargoByGood, obligationLineKo, rateKo, settlementRows, upcomingSummary, workloadLinesKo } from './reports';
import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay, planState } from '../engine/engine';
import { campaignSummary, tradePairs, upcomingPayments, companyReport } from '../engine/reports';
import { acceptAllFeasible, runToCampaignEnd, runDays, standardDayOneCommands } from '../engine/testkit';
import { krwReportRows, KRW_REPORT_NOTE_CULTURE_KO, KRW_REPORT_NOTE_KO } from './reports';
import { cancellationPreviewKo } from './trade';
import { crewNoteKo } from './crew-status';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
describe('취소 안내와 원화 보고', () => {
  it.each([['ROUTE01',150],['ROUTE02',130]] as const)('%s 예약의 엔진 환급·취소비를 표시한다', (route, refund) => {
    const commands = standardDayOneCommands(config);
    const second = route === 'ROUTE02';
    commands[0] = { id: 'A', type: 'ACCEPT_TRADE', buyOfferId: second ? 'OFFER_BUY_02' : 'OFFER_BUY_01', sellOfferId: second ? 'OFFER_SELL_02' : 'OFFER_SELL_01' };
    commands[2] = { id: 'B', type: 'BOOK_SAILING', contractId: 'CT001', sailingId: `${route}-D002` };
    const state = planState(openDay(createGame(config), config).state, config, commands).state;
    const before = structuredClone(state);
    expect(cancellationPreviewKo(state, config, 'CT001')).toBe(`운임 ${refund}.00 USD 환급·취소비 50.00 USD, `);
    expect(state).toEqual(before);
  });
  it('성장과 M1 각주는 실제 직원 처리량과 범위를 표시한다', () => {
    const m1=loadScenario('SCENARIO_M1_ONE_TRADE');
    expect(crewNoteKo(m1)).toBe('처리량은 고정값(하루 2pt)만 씁니다. 능력·속성·레벨·시너지는 이 시나리오에서 쓰지 않습니다. 일급 80,000원.');
    for(const cfg of [config,m1]) {
      expect(crewNoteKo(cfg)).not.toContain('하루 Npt');
      expect(crewNoteKo(cfg)).toContain('하루 2pt');
    }
    const cfg=structuredClone(config);cfg.employees[1]!.workUnitsPerDay=3;
    expect(crewNoteKo(cfg)).toContain('하루 2~3pt');
  });
  it('고용 1회와 훈련 1회 뒤 모든 원화 행의 순서·금액·현금식을 맞춘다', () => {
    const state = runDays(createGame(config), config, 4, {
      1: [{ id:'S',type:'SCOUT_SITE',venueId:'VEN_PORT',employeeId:'EMP02' }],
      2: [{ id:'Q',type:'START_RECRUIT_QUEST',candidateId:'EMP04',employeeId:'EMP01' }],
      4: [{ id:'H',type:'HIRE_CANDIDATE',candidateId:'EMP04' }, {id:'T',type:'START_TRAINING',employeeId:'EMP02'}],
    }).state;
    const report = companyReport(state, config), p = report.payroll;
    expect(p).toMatchObject({ openingEquity:10_000_000, wageExpense:640_000, recruitmentExpense:550_000, trainingExpense:50_000, profit:-1_240_000,cash:8_760_000 });
    const html = krwReportRows(report, config);
    expect([...html.matchAll(/<th>(.*?)<\/th>/g)].map((m)=>m[1])).toEqual(['시작 운영 자금','급여','영입 계약금','훈련비','현지 활동비','운영 손익','미지급 급여','현금']);
    expect([...html.matchAll(/<td>(.*?)<\/td>/g)].map((m)=>m[1])).toEqual(['10,000,000원','−640,000원','−550,000원','−50,000원','0원','−1,240,000원','0원','8,760,000원']);
    expect(p.cash).toBe(p.openingEquity+p.profit+p.accountsPayable);
    expect(KRW_REPORT_NOTE_CULTURE_KO).toContain('계약금·훈련비·현지 활동비는 한 번 내는 원화 비용');
    expect(KRW_REPORT_NOTE_KO).toContain('계약금·훈련비는 한 번 내는 원화 비용');
    expect(crewNoteKo(config)).toBe('레벨·능력은 성장 기록으로 보여 주며 아직 처리량(하루 2pt)에는 쓰지 않습니다. 레벨이 올라도 급여·직책은 바뀌지 않습니다. 일급 80,000원.');
  });
});

describe('경영 보고 읽기 도우미', () => {
  const start = (cfg = config) => openDay(createGame(cfg), cfg).state;
  const accepted = () => openDay(runDays(start(), config, start().day, {
    [start().day]: [{ id: 'REPORT', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }],
  }).state, config).state;
  const shortCash = () => {
    const cfg = structuredClone(config);
    cfg.startingCash[cfg.payrollCurrency] = cfg.employees.filter((e) => isAvailableFromToday(start(cfg), e.id)).reduce((a, e) => a + e.salaryPerDayMinor, 0) - 1;
    return { cfg, state: openDay(runDays(start(cfg), cfg, start(cfg).day + 1).state, cfg).state };
  };
  it('품목별 화물은 고객과 회사의 보유 합계와 단위를 보존한다', () => {
    const commands: Command[] = config.offers.filter((o) => o.kind === 'forwarding').map((o, i) => ({ id: `FWD-${i}`, type: 'ACCEPT_FORWARDING', offerId: o.id }));
    const customer = runDays(start(), config, start().day, { [start().day]: commands }).state;
    const planned = planState(start(), config, [{ id: 'TRADE', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }]).state;
    const company = planState(planned, config, [{ id: 'CANCEL', type: 'CANCEL_CONTRACT', contractId: planned.contracts[0]!.id }]).state;
    for (const [s, owner] of [[customer, 'CUSTOMER'], [company, 'COMPANY']] as const) {
      const held = heldCargoByGood(s, config, owner), report = companyReport(s, config);
      const total = owner === 'CUSTOMER' ? report.customerCargoUnits : report.inventoryUnits;
      expect(held.reduce((a, i) => a + i.quantity, 0)).toBe(total);
      const expected = config.goods.flatMap((g) => {
        const q = s.cargoLots.filter((l) => l.owner === owner && l.goodId === g.id && l.status !== 'DELIVERED' && l.status !== 'RETURNED_TO_OWNER').reduce((a, l) => a + l.quantity, 0);
        return q ? [`${g.nameKo} ${q.toLocaleString('ko-KR')}${unitKo(g)}`] : [];
      }).join(' · ');
      expect(cargoListKo(config, held)).toBe(expected);
      if (owner === 'CUSTOMER') expect(cargoListKo(config, held)).not.toContain(`${total}개`);
    }
    expect(cargoListKo(config, heldCargoByGood(start(), config, 'COMPANY'))).toBe('없음');
  });
  it.each([[10000, '100%'], [6666, '66.66%'], [5050, '50.50%'], [1, '0.01%'], [0, '0%']] as const)('rateKo 표 %s → %s', (input, expected) => {
    expect(rateKo(input)).toBe(expected);
  });
  it('upcomingSummary는 종류·통화별로 합하고 네 줄 순서와 미정 건수를 보존한다', () => {
    const poor = shortCash(), normal = openDay(runDays(start(), config, start().day, { [start().day]: acceptAllFeasible(start(), config) }).state, config).state;
    for (const [s, cfg] of [[normal, config], [poor.state, poor.cfg]] as const) {
      const rows = upcomingPayments(s, cfg), summary = upcomingSummary(rows, cfg);
      expect(summary.currencies).toEqual([cfg.tradeCurrency, cfg.payrollCurrency]);
      expect(summary.lines.map((l) => [l.kind, l.labelKo])).toEqual([
        ['OVERDUE', '밀린 지급 (현금이 들어오면 먼저 갚음)'], ['WAGE', '급여 (하루 진행 때 자동)'],
        ['FREIGHT', '운임 (운송편을 예약할 때)'], ['DUTY', '관세 (도착할 때 자동)'],
      ]);
      for (const line of summary.lines) for (const [i, currency] of summary.currencies.entries()) {
        const matching = rows.filter((r) => r.day !== null && r.kind === line.kind && r.currency === currency);
        expect(line.amounts[i]).toBe(matching.length ? matching.reduce((a, r) => a + r.amountMinor, 0) : null);
      }
      expect(summary.noSailing.count + summary.unbooked.count).toBe(rows.filter((r) => r.day === null).length);
    }
    const rows = upcomingPayments(normal, config);
    expect(upcomingSummary([...rows, { ...rows[0]!, currency: 'XXX' }], config).currencies)
      .toEqual([config.tradeCurrency, config.payrollCurrency, 'XXX']);
    expect(upcomingSummary(rows, { ...config, payrollCurrency: config.tradeCurrency }).currencies)
      .toEqual([config.tradeCurrency, config.payrollCurrency]);
  });
  it('bottlenecks는 원인 문장·분류와 미지급을 보존하고 info 수금 대기는 제외한다', () => {
    const s = accepted(), groups = bottlenecks(s, config);
    expect(groups.map((g) => g.kind)).toEqual(['돈', '시간', '사람', '선복']);
    const c = s.contracts[0]!, blockers = contractProgress(s, config, c).blockers;
    const expected = { TASK_UNASSIGNED: '사람', TASK_WILL_MISS_SAILING: '사람', NO_BOOKING: '선복', NO_SAILING_LEFT: '선복',
      NEXT_SAILING_LATE: '시간', BOOKED_SAILING_LATE: '시간', WAITING_PORT_RESTRICTION: '시간', DUTY_UNPAID: '돈', AWAITING_PAYMENT: null };
    expect(BOTTLENECK_OF).toEqual(expected);
    for (const b of blockers) expect(groups.find((g) => g.kind === expected[b.code])!.items).toContainEqual({ contractId: c.id, textKo: b.messageKo });
    const cfg = structuredClone(config); cfg.terms.paymentDueDay = cfg.campaignDays;
    const commands = acceptAllFeasible(start(cfg), cfg), end = runToCampaignEnd(start(cfg), cfg, { 1: commands }).state;
    const delivered = end.contracts[0]!.deliveredDay!;
    const waiting = openDay(runDays(start(cfg), cfg, delivered, { 1: commands }).state, cfg).state;
    expect(contractProgress(waiting, cfg, waiting.contracts[0]!).blockers.map((b) => b.code)).toEqual(['AWAITING_PAYMENT']);
    expect(bottlenecks(waiting, cfg).every((g) => g.items.length === 0)).toBe(true);
    const poor = shortCash(), unpaid = fundsPosition(poor.state, poor.cfg, poor.cfg.payrollCurrency).unpaidObligations;
    expect(bottlenecks(poor.state, poor.cfg)[0]!.items[0]).toEqual({ contractId: null,
      textKo: `미지급금이 ${formatMoney(poor.cfg.payrollCurrency, unpaid)} 있습니다. 현금이 들어오면 먼저 갚습니다.` });
  });
  it('workloadLinesKo는 도시 업무·가용 처리량과 미래 근무자를 문장으로 보인다', () => {
    const s = accepted(), summary = workloadSummary(s, config);
    const expected = summary.byCity.map((r) => `${cityName(config, r.cityId)}: 남은 업무 ${r.unassignedWorkUnits + r.runningWorkUnits}pt(배정 전 ${r.unassignedWorkUnits}pt · 진행 중 ${r.runningWorkUnits}pt), 하루 처리 ${r.staffWorkUnitsPerDay - r.dayTaskWorkUnitsPerDay}pt → 약 ${r.daysToClear}일. 지금 바로 맡길 수 있는 처리량 하루 ${r.idleWorkUnitsPerDay}pt.`);
    expect(workloadLinesKo(summary, config)).toEqual(expected);
    const future = s.employees.find((e) => e.id === config.recruitment!.candidateEmployeeIds[0])!;
    future.employmentStatus = 'employed'; future.availableFromDay = s.day + 2;
    const def = config.employees.find((e) => e.id === future.id)!;
    expect(workloadLinesKo(workloadSummary(s, config), config)).toContain(`${def.nameKo}: ${future.availableFromDay}일부터 근무(하루 ${def.workUnitsPerDay}pt).`);
    const trained = planState(start(), config, [{ id: 'TRAIN', type: 'START_TRAINING', employeeId: config.employees[0]!.id }]).state;
    const row = workloadSummary(trained, config).byCity[0]!;
    expect(workloadLinesKo(workloadSummary(trained, config), config)[0]).toBe(`${cityName(config, row.cityId)}: 남은 업무 ${row.unassignedWorkUnits + row.runningWorkUnits}pt(배정 전 ${row.unassignedWorkUnits}pt · 진행 중 ${row.runningWorkUnits}pt), 하루 처리 ${row.staffWorkUnitsPerDay - row.dayTaskWorkUnitsPerDay}pt(훈련·현지 활동 중 ${row.dayTaskWorkUnitsPerDay}pt 빼고) → 남은 업무 없음. 지금 바로 맡길 수 있는 처리량 하루 ${row.idleWorkUnitsPerDay}pt.`);
  });
  it('settlementRows는 통화별 순자산 항등식과 급여 표의 행 생략을 지킨다', () => {
    const s = runToCampaignEnd(start(), config, { 1: acceptAllFeasible(start(), config) }).state;
    for (const standing of campaignSummary(s, config).byCurrency) {
      const rows = settlementRows(standing, config), value = (label: string) => rows.find((r) => r[0] === label)![1];
      expect(value('순자산 (자산 − 미지급금)')).toBe(value('시작 자본') + value('손익'));
      expect(value('순자산 (자산 − 미지급금)')).toBe(value('자산 합계') - value('미지급금'));
      if (standing.currency === config.payrollCurrency) for (const label of ['재고', '선급운임', '주선 진행원가', '매출채권', '계약 기여이익 합계']) expect(rows.some((r) => r[0] === label)).toBe(false);
    }
  });
  it('upcomingSummary는 날짜 미정 지급을 예약 전과 실을 편 없음으로 나눠 기간 표 칸에서 뺀다', () => {
    const accept: Command = { id: 'UNDATED', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! };
    const at = (day: number) => openDay(runDays(start(), config, day - 1, { [start().day]: [accept] }).state, config).state;
    const perCurrency = (summary: ReturnType<typeof upcomingSummary>, rows: ReturnType<typeof upcomingPayments>) =>
      summary.currencies.flatMap((currency) => {
        const matching = rows.filter((r) => r.currency === currency);
        return matching.length ? [{ currency, amountMinor: matching.reduce((a, r) => a + r.amountMinor, 0) }] : [];
      });
    // 예약 전 2일: 운임 마감일은 있고 관세 낼 날만 없다.
    const before = upcomingPayments(at(start().day + 1), config), unbookedRows = before.filter((r) => r.day === null);
    expect(unbookedRows.map((r) => r.kind)).toEqual(['DUTY']);
    expect(before.some((r) => r.kind === 'FREIGHT' && r.day !== null && r.contractId === unbookedRows[0]!.contractId)).toBe(true);
    const b = upcomingSummary(before, config);
    expect(b.unbooked).toEqual({ count: 1, amounts: perCurrency(b, unbookedRows) });
    expect(b.noSailing).toEqual({ count: 0, amounts: [] });
    expect(b.lines.find((l) => l.kind === 'DUTY')!.amounts).toEqual(b.currencies.map(() => null));
    // 그 노선의 마지막 출항일: 캠페인 안에 남은 출항편이 없어 그 계약의 운임·관세 모두 날짜가 없다.
    const c = planState(start(), config, [accept]).state.contracts[0]!;
    const route = routeBetween(config, c.originCityId, c.destinationCityId)!;
    const lastDeparture = Math.max(...listSailings(config, route.id).map((sailing) => sailing.departureDay));
    const late = upcomingPayments(at(lastDeparture), config), noSailingRows = late.filter((r) => r.day === null);
    expect(noSailingRows.map((r) => r.kind).sort()).toEqual(['DUTY', 'FREIGHT']);
    const l = upcomingSummary(late, config);
    expect(l.noSailing).toEqual({ count: 2, amounts: perCurrency(l, noSailingRows) });
    expect(l.unbooked).toEqual({ count: 0, amounts: [] });
    for (const kind of ['FREIGHT', 'DUTY']) expect(l.lines.find((line) => line.kind === kind)!.amounts).toEqual(l.currencies.map(() => null));
    // 통화가 다른 미정 지급은 더하지 않고 통화마다 따로 둔다.
    const other = { ...noSailingRows[0]!, currency: config.payrollCurrency, sourceId: `${noSailingRows[0]!.sourceId}-OTHER` };
    const mixed = upcomingSummary([...late, other], config);
    expect(mixed.noSailing).toEqual({ count: 3, amounts: [...perCurrency(l, noSailingRows), { currency: config.payrollCurrency, amountMinor: other.amountMinor }] });
  });
  it('settlementRows는 통화마다 행 이름·값·합계 줄을 정한 순서로 돌려준다', () => {
    const ended = [runToCampaignEnd(start(), config, { 1: acceptAllFeasible(start(), config) }).state, runToCampaignEnd(start(), config).state];
    const zeroTrade = campaignSummary(ended[1]!, config).byCurrency.find((st) => st.currency === config.tradeCurrency)!;
    // 명령 없이 끝내면 거래 통화의 재고·선급운임·주선 진행원가·매출채권·기여이익이 모두 0이다. 그래도 행은 남는다.
    expect([zeroTrade.inventory, zeroTrade.prepaidFreight, zeroTrade.forwardingWip, zeroTrade.accountsReceivable, zeroTrade.contractContribution]).toEqual([0, 0, 0, 0, 0]);
    for (const s of ended) for (const st of campaignSummary(s, config).byCurrency) {
      const trade = st.currency === config.tradeCurrency;
      if (!trade) expect([st.inventory, st.prepaidFreight, st.forwardingWip, st.accountsReceivable, st.contractContribution]).toEqual([0, 0, 0, 0, 0]);
      expect(settlementRows(st, config)).toEqual([
        ['현금', st.cash, false],
        ...(trade ? [['재고', st.inventory, false], ['선급운임', st.prepaidFreight, false], ['주선 진행원가', st.forwardingWip, false], ['매출채권', st.accountsReceivable, false]] : []),
        ['자산 합계', st.totalAssets, true], ['미지급금', st.accountsPayable, false], ['순자산 (자산 − 미지급금)', st.netAssets, true],
        ['시작 자본', st.openingEquity, false], ['손익', st.profit, false],
        ...(trade ? [['계약 기여이익 합계', st.contractContribution, false]] : []),
      ]);
    }
    // 급여 통화라도 0이 아닌 값은 행으로 남긴다.
    const krw = campaignSummary(ended[1]!, config).byCurrency.find((st) => st.currency === config.payrollCurrency)!;
    expect(settlementRows({ ...krw, inventory: 7, contractContribution: 9 }, config)).toEqual([
      ['현금', krw.cash, false], ['재고', 7, false], ['자산 합계', krw.totalAssets, true], ['미지급금', krw.accountsPayable, false],
      ['순자산 (자산 − 미지급금)', krw.netAssets, true], ['시작 자본', krw.openingEquity, false], ['손익', krw.profit, false], ['계약 기여이익 합계', 9, false],
    ]);
  });
  it('heldCargoByGood는 인도했거나 돌려준 화물을 빼고 회사 보고 수량과 맞춘다', () => {
    const units = (items: { quantity: number }[]) => items.reduce((a, i) => a + i.quantity, 0);
    const commands = acceptAllFeasible(start(), config), end = runToCampaignEnd(start(), config, { 1: commands }).state;
    const last = Math.max(...end.contracts.map((c) => c.deliveredDay!));
    const delivered = openDay(runDays(start(), config, last, { 1: commands }).state, config).state;
    for (const owner of ['COMPANY', 'CUSTOMER'] as const) expect(delivered.cargoLots.some((l) => l.owner === owner && l.status === 'DELIVERED')).toBe(true);
    const report = companyReport(delivered, config);
    expect(units(heldCargoByGood(delivered, config, 'COMPANY'))).toBe(report.inventoryUnits);
    expect(units(heldCargoByGood(delivered, config, 'CUSTOMER'))).toBe(report.customerCargoUnits);
    expect([report.inventoryUnits, report.customerCargoUnits]).toEqual([0, 0]);
    expect(cargoListKo(config, heldCargoByGood(delivered, config, 'COMPANY'))).toBe('없음');
    expect(cargoListKo(config, heldCargoByGood(delivered, config, 'CUSTOMER'))).toBe('없음');
    const forwarding: Command[] = config.offers.filter((o) => o.kind === 'forwarding').map((o, i) => ({ id: `RETURN-${i}`, type: 'ACCEPT_FORWARDING', offerId: o.id }));
    const planned = planState(start(), config, forwarding).state;
    const returned = planState(planned, config, [{ id: 'RETURN-CANCEL', type: 'CANCEL_CONTRACT', contractId: planned.contracts[0]!.id }]).state;
    expect(returned.cargoLots.some((l) => l.owner === 'CUSTOMER' && l.status === 'RETURNED_TO_OWNER')).toBe(true);
    expect(units(heldCargoByGood(returned, config, 'CUSTOMER'))).toBe(companyReport(returned, config).customerCargoUnits);
  });
  it('bottlenecks 묶음은 막힘 코드마다 한 줄이고 돈 묶음은 통화별 미지급과 음수 사용 가능 자금만 담는다', () => {
    const s = accepted(), c = s.contracts[0]!, blockers = contractProgress(s, config, c).blockers;
    expect(blockers.map((b) => b.code)).toEqual(['TASK_UNASSIGNED', 'NO_BOOKING', 'NEXT_SAILING_LATE']);
    const msg = (code: string) => blockers.find((b) => b.code === code)!.messageKo;
    expect(bottlenecks(s, config)).toEqual([
      { kind: '돈', items: [] },
      { kind: '시간', items: [{ contractId: c.id, textKo: msg('NEXT_SAILING_LATE') }] },
      { kind: '사람', items: [{ contractId: c.id, textKo: msg('TASK_UNASSIGNED') }] },
      { kind: '선복', items: [{ contractId: c.id, textKo: msg('NO_BOOKING') }] },
    ]);
    const empty = [{ kind: '시간', items: [] }, { kind: '사람', items: [] }, { kind: '선복', items: [] }];
    const poor = shortCash(), krwUnpaid = fundsPosition(poor.state, poor.cfg, poor.cfg.payrollCurrency).unpaidObligations;
    expect(bottlenecks(poor.state, poor.cfg)).toEqual([{ kind: '돈', items: [{ contractId: null,
      textKo: `미지급금이 ${formatMoney(poor.cfg.payrollCurrency, krwUnpaid)} 있습니다. 현금이 들어오면 먼저 갚습니다.` }] }, ...empty]);
    // 거래 통화의 미지급(관세를 못 낸 경우)도 같은 문장으로 따로 쓴다.
    const usdCfg = structuredClone(config); usdCfg.rules.fundsCheck = 'IMMEDIATE_CASH'; usdCfg.terms.dutyRateBasisPoints = 20000;
    const usdCommands = acceptAllFeasible(start(usdCfg), usdCfg);
    let usdState = start(usdCfg);
    for (let day = start(usdCfg).day + 1; day <= usdCfg.campaignDays && !fundsPosition(usdState, usdCfg, usdCfg.tradeCurrency).unpaidObligations; day++) {
      usdState = openDay(runDays(start(usdCfg), usdCfg, day - 1, { 1: usdCommands }).state, usdCfg).state;
    }
    const usdUnpaid = fundsPosition(usdState, usdCfg, usdCfg.tradeCurrency).unpaidObligations;
    expect(usdUnpaid).toBeGreaterThan(0);
    expect(fundsPosition(usdState, usdCfg, usdCfg.payrollCurrency).unpaidObligations).toBe(0);
    // 관세를 못 낸 계약의 막힘(DUTY_UNPAID)은 계약 없는 미지급 줄 뒤에 온다.
    const dutyBlocked = usdState.contracts.flatMap((c) => contractProgress(usdState, usdCfg, c).blockers
      .filter((b) => b.code === 'DUTY_UNPAID').map((b) => ({ contractId: c.id, textKo: b.messageKo })));
    expect(dutyBlocked.length).toBeGreaterThan(0);
    expect(bottlenecks(usdState, usdCfg)[0]).toEqual({ kind: '돈', items: [{ contractId: null,
      textKo: `미지급금이 ${formatMoney(usdCfg.tradeCurrency, usdUnpaid)} 있습니다. 현금이 들어오면 먼저 갚습니다.` }, ...dutyBlocked] });
    // 체결한 계약의 예약이 현금보다 많으면 사용 가능 자금 줄이 돈 묶음에 들어간다.
    const planned = planState(start(), config, acceptAllFeasible(start(), config)).state;
    const costly = structuredClone(config); costly.terms.dutyRateBasisPoints *= 100;
    const f = fundsPosition(planned, costly, costly.tradeCurrency);
    expect(costly.rules.fundsCheck).toBe('COMMITTED_OUTLAYS'); expect(f.available).toBeLessThan(0);
    expect(bottlenecks(planned, costly)[0]).toEqual({ kind: '돈', items: [{ contractId: null,
      textKo: `사용 가능 자금이 ${formatMoney(costly.tradeCurrency, f.available)}입니다. 체결한 계약의 운임·관세 예약이 현금보다 많습니다.` }] });
  });
  it('workloadLinesKo는 맡길 사람이 모두 훈련 중인 도시를 처리할 사람이 없다고 쓴다', () => {
    const cfg = structuredClone(config); cfg.growth!.ordinaryTraining.durationDays = 3;
    const employed = cfg.employees.filter((e) => start(cfg).employees.find((x) => x.id === e.id)!.employmentStatus === 'employed');
    const commands: Command[] = [{ id: 'BUSY-ACCEPT', type: 'ACCEPT_TRADE', ...tradePairs(cfg)[0]! },
      ...employed.map((e, i): Command => ({ id: `BUSY-TRAIN-${i}`, type: 'START_TRAINING', employeeId: e.id }))];
    const s = openDay(runDays(start(cfg), cfg, start(cfg).day, { [start(cfg).day]: commands }).state, cfg).state;
    const rows = workloadSummary(s, cfg).byCity.filter((r) => r.daysToClear === null);
    expect(rows.length).toBeGreaterThan(0);
    const lines = workloadLinesKo(workloadSummary(s, cfg), cfg);
    for (const r of rows) expect(lines).toContain(`${cityName(cfg, r.cityId)}: 남은 업무 ${r.unassignedWorkUnits + r.runningWorkUnits}pt(배정 전 ${r.unassignedWorkUnits}pt · 진행 중 ${r.runningWorkUnits}pt), 하루 처리 ${r.staffWorkUnitsPerDay - r.dayTaskWorkUnitsPerDay}pt${r.dayTaskWorkUnitsPerDay ? `(훈련·현지 활동 중 ${r.dayTaskWorkUnitsPerDay}pt 빼고)` : ''} → 지금 이 업무를 처리할 사람이 없음. 지금 바로 맡길 수 있는 처리량 하루 ${r.idleWorkUnitsPerDay}pt.`);
  });
  it('workloadLinesKo는 직원과 업무가 모두 없으면 대체 문장 하나를 돌려준다', () => {
    expect(workloadLinesKo({ day: start().day, byCity: [], employees: [], startingLater: [] }, config)).toEqual(['직원과 남은 업무가 없습니다.']);
  });
  it('obligationLineKo는 이유 글에 발생일이 없을 때만 날짜를 앞에 붙인다', () => {
    const poor = shortCash(), wage = poor.state.obligations[0]!;
    expect(wage.reasonKo).toContain(`${wage.incurredDay}일`);
    expect(obligationLineKo(wage)).toBe(wage.reasonKo);
    const usdCfg = structuredClone(config); usdCfg.rules.fundsCheck = 'IMMEDIATE_CASH'; usdCfg.terms.dutyRateBasisPoints = 20000;
    const end = runToCampaignEnd(start(usdCfg), usdCfg, { 1: acceptAllFeasible(start(usdCfg), usdCfg) }).state;
    const duty = end.obligations.find((o) => o.currency === usdCfg.tradeCurrency)!;
    expect(duty.reasonKo).not.toMatch(/\d일/);
    expect(obligationLineKo(duty)).toBe(`${duty.incurredDay}일 ${duty.reasonKo}`);
    // 다른 날짜(13일)가 들어 있어도 발생일(3일)이 아니면 앞에 붙인다.
    expect(obligationLineKo({ incurredDay: 3, reasonKo: '보상 13일분' })).toBe('3일 보상 13일분');
  });
});
