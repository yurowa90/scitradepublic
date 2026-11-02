import { describe, expect, it } from 'vitest';
import { loadScenario, SCENARIO_IDS } from '../content/scenario';
import { commitDay, createGame, openDay, planState } from './engine';
import { exchangePreview, hiringOutlook, quotePreview, warehouseSummary, weeklyBottleneck, type QuoteOfferIds } from './readers';
import { cargoSpace } from './catalog';
import { offerDef } from './market';
import { upcomingPayments } from './reports';
import { atDay, applied, caseOf, config, fresh, scriptOf } from './m2a5-testkit';
import type { EngineCommand, GameState, ScenarioConfig } from './types';

const c18 = caseOf('P0-M2A5-18'), n18 = c18.expected_numeric, f18 = c18.test_fixture;
const c19 = caseOf('P0-M2A5-19'), n19 = c19.expected_numeric, f19 = c19.test_fixture;
const trade = c19.actions.find((a) => a.variant === 'trade')!;
const tradeCommand = trade.commands[0] as Extract<EngineCommand, { type: 'ACCEPT_TRADE' }>;
const ids: QuoteOfferIds = { buyOfferId: tradeCommand.buyOfferId, sellOfferId: tradeCommand.sellOfferId };
const storage = c19.actions.find((a) => a.variant === 'storage')!;
const storageCommand = storage.commands[0] as Extract<EngineCommand, { type: 'ACCEPT_FORWARDING' }>;
const invested = () => atDay(f18.invested_day, config, scriptOf(c18, 'invested'));
const full = () => planState(atDay(storage.day), config, f19.storage_commands).state;
function read<T>(s: GameState, cfg: ScenarioConfig, fn: () => T): T {
  const before = structuredClone(s), configBefore = structuredClone(cfg);
  const result = fn();
  expect(s).toEqual(before); expect(cfg).toEqual(configBefore);
  return result;
}
function impactState() {
  const s = atDay(trade.day);
  const employee = s.employees.find((e) => e.id === f19.impact_candidate)!;
  employee.employmentStatus = 'employed'; employee.availableFromDay = s.day;
  const p = planState(s, config, f19.impact_commands);
  expect(p.results).toEqual(applied(f19.impact_commands));
  p.state.tasks[0]!.requiredWorkUnits = f19.impact_required_pt;
  return p.state;
}

describe('P0-M2A5-18 본사·창고 표와 병목 표', () => {
  it('기본·투자 적용 뒤 표 전체와 네 고용 반례를 비교한다', () => {
    for (const [s, expected] of [[fresh(), n18.initial], [invested(), n18.invested]] as const) {
      expect(read(s, config, () => warehouseSummary(s, config))).toEqual(expected);
    }
    for (const row of n18.hiring) {
      const s = row.invested ? invested() : fresh();
      expect(read(s, config, () => weeklyBottleneck(s, config, row.candidate_id))).toEqual(row.outlook.bottleneck);
      expect(read(s, config, () => hiringOutlook(s, config, row.candidate_id))).toEqual(row.outlook);
    }
  });
  it('기존 계약의 준비량과 예약 선복을 본사 표에서 읽는다', () => {
    const s = full();
    expect(read(s, config, () => warehouseSummary(s, config))).toEqual(n18.storage);
  });
  it('임차료·선복 요금은 급여보다 먼저 정렬하고 이동 예약 창 밖 요금도 보인다', () => {
    const initial = fresh(), s = invested(), later = atDay(31, config, scriptOf(c18, 'invested'));
    expect(read(initial, config, () => upcomingPayments(initial, config, 1))).toEqual(n18.payments_initial);
    expect(read(s, config, () => upcomingPayments(s, config, f18.payment_through_day))).toEqual(n18.payments_invested);
    expect(read(later, config, () => upcomingPayments(later, config, later.day))).toEqual(n18.payments_expanded_rent);
  });
  it('오늘 수락한 직접 무역과 일반 주선의 준비량은 관측 창 밖이다', () => {
    const p = planState(atDay(f18.storage_day), config, f18.history_commands);
    expect(p.results).toEqual(applied(f18.history_commands));
    expect(read(p.state, config, () => warehouseSummary(p.state, config))).toEqual(n18.with_trade);
  });
  it('28일 창은 수락일이 경계인 계약을 포함하고 오래된 계약을 뺀다', () => {
    for (const day of f18.history_days) {
      const s = atDay(day, config, { [f18.storage_day]: f18.history_commands });
      expect(read(s, config, () => warehouseSummary(s, config))).toEqual(n18[`history_${day}`]);
    }
  });
  it('이미 분개한 고정비와 창 밖 행을 중복해서 넣지 않는다', () => {
    const s = invested();
    for (const row of n18.payments_invested.filter((r: any) => r.kind === 'SPACE_FEE')) s.ledger.postedIds[row.sourceId] = true;
    expect(read(s, config, () => upcomingPayments(s, config, f18.payment_through_day)))
      .toEqual(n18.payments_invested.filter((r: any) => r.kind !== 'SPACE_FEE'));
    const initial = fresh(); initial.ledger.postedIds[n18.payments_initial[0].sourceId] = true;
    expect(read(initial, config, () => upcomingPayments(initial, config, initial.day))).toEqual(n18.payments_initial.slice(1));
    expect(read(initial, config, () => upcomingPayments(initial, config, initial.day - 1))).toEqual([]);
  });
});

describe('P0-M2A5-19 견적·환전 미리 보기', () => {
  it('8일 수량 200 직접 무역의 전체 견적을 읽는다', () => {
    const s = atDay(trade.day);
    expect(read(s, config, () => quotePreview(s, config, ids, tradeCommand.quantity))).toEqual(n19.trade);
  });
  it('보관 초과도 계산 가능한 수치를 주고 영향 계약은 비운다', () => {
    const s = full();
    expect(read(s, config, () => quotePreview(s, config, { offerId: storageCommand.offerId }))).toEqual(n19.storage);
  });
  it('두 방향 환전·오늘 고정비 부족 경고와 반례의 전체 결과를 비교한다', () => {
    for (const [i, f] of f19.fx.entries()) {
      const s = fresh();
      expect(read(s, config, () => exchangePreview(s, config, f.direction, f.usdAmountMinor))).toEqual(n19.fx[i]);
    }
  });
  it('새 배정으로 늦어지는 계약만 담고 예약 출항 불참을 표시한다', () => {
    const s = impactState();
    expect(read(s, config, () => quotePreview(s, config, ids, tradeCommand.quantity)))
      .toEqual({ ...n19.trade, storageAfterLiters: n19.impact_storage_after_liters, affectedContracts: n19.impact_affected });
  });
  it('쉬는 직원이 없으면 대기 배정을 예측하며 늦어지지 않는 계약은 제외한다', () => {
    const s = impactState();
    s.employees.find((e) => e.id === f19.impact_candidate)!.employmentStatus = 'candidate';
    expect(read(s, config, () => quotePreview(s, config, ids, tradeCommand.quantity)))
      .toEqual({ ...n19.trade, storageAfterLiters: n19.impact_storage_after_liters });
  });
  it('직원 상태 배열 순서가 바뀌어도 설정 순서로 배정한다', () => {
    const s = impactState(); s.employees.reverse();
    expect(read(s, config, () => quotePreview(s, config, ids, tradeCommand.quantity)))
      .toEqual({ ...n19.trade, storageAfterLiters: n19.impact_storage_after_liters, affectedContracts: n19.impact_affected });
  });
  it('다음 편의 감액을 기여이익에서 두 번 빼지 않는다', () => {
    const s = atDay(trade.day), cfg = structuredClone(config);
    s.operations!.offers.find((o) => o.id === tradeCommand.sellOfferId)!.deliveryDeadlineDay = f19.late_deadline;
    expect(read(s, cfg, () => quotePreview(s, cfg, ids, tradeCommand.quantity))).toEqual(n19.late);
  });
});

describe('M2a-5 읽기 함수 성질', () => {
  it('처리 배분이 있는 상태에서 모든 읽기는 결정적이고 상태를 바꾸지 않는다', () => {
    const s = impactState();
    const call = () => ({ warehouse: warehouseSummary(s, config), bottleneck: weeklyBottleneck(s, config, f19.impact_candidate),
      hiring: hiringOutlook(s, config, f19.impact_candidate), quote: quotePreview(s, config, ids, tradeCommand.quantity),
      exchange: exchangePreview(s, config, 'USD_TO_KRW', f19.fx[0].usdAmountMinor), payments: upcomingPayments(s, config) });
    const a = read(s, config, call), b = read(s, config, call);
    expect(a).toEqual(b);
  });
  it('창고 대기량은 실제 배분과 같고 반환 객체를 바꿔도 상태가 보존된다', () => {
    const p = planState(impactState(), config, [f19.impact_accept_command]);
    expect(p.results).toEqual(applied([f19.impact_accept_command]));
    const before = structuredClone(p.state);
    const summary = read(p.state, config, () => warehouseSummary(p.state, config));
    expect(summary.handling).toEqual(n19.impact_handling);
    summary.handling.waits[0]!.gotPt = 0;
    expect(p.state).toEqual(before);
    const s = invested(), original = structuredClone(s);
    const warehouse = read(s, config, () => warehouseSummary(s, config));
    warehouse.spaceContracts[0]!.feeMinor = 0;
    expect(s).toEqual(original);
  });
  it('보관·수량·자금 거절 문장은 수락 명령과 정확히 같다', () => {
    const poorConfig = { ...config, startingCash: { ...config.startingCash, USD: f19.poor_usd } };
    const cases = [
      { s: full(), cfg: config, command: storageCommand, ids: { offerId: storageCommand.offerId } },
      { s: atDay(trade.day), cfg: config, command: { ...tradeCommand, quantity: f19.invalid_quantity }, ids },
      { s: atDay(trade.day, poorConfig), cfg: poorConfig, command: tradeCommand, ids },
    ];
    for (const { s, cfg, command, ids: offers } of cases) {
      const actual = read(s, cfg, () => quotePreview(s, cfg, offers, 'quantity' in command ? command.quantity : undefined));
      const result = planState(s, cfg, [command]).results[0]!;
      expect(result.status).toEqual('REJECTED'); expect(actual.allowed).toEqual(false);
      expect(actual.reasonKo).toBe(result.reasonKo); expect(actual.affectedContracts).toEqual([]);
    }
  });
  it('환전 거절은 금액·자금·종료·미개시 상태 모두 명령 문장과 같다', () => {
    for (const s of [fresh(), createGame(config), { ...fresh(), phase: 'ENDED' as const }]) {
      for (const f of f19.fx.slice(3)) {
        const result = planState(s, config, [{ id: 'FX-CHECK', type: 'EXCHANGE_CURRENCY', ...f }]).results[0]!;
        const actual = read(s, config, () => exchangePreview(s, config, f.direction, f.usdAmountMinor));
        expect(result.status).toEqual('REJECTED'); expect(actual.reasonKo).toBe(result.reasonKo);
      }
    }
  });
  it('실제 명령 ID와 미리 보기 ID가 겹쳐도 읽기 검사를 생략하지 않는다', () => {
    const s = fresh(); s.processedCommands['OPERATIONS-PREVIEW'] = { day: s.day, type: 'EXCHANGE_CURRENCY', status: 'APPLIED', reasonKo: '처리됨' };
    expect(read(s, config, () => exchangePreview(s, config, f19.fx[0].direction, f19.fx[0].usdAmountMinor))).toEqual(n19.fx[0]);
  });
  it.each(SCENARIO_IDS)('%s 규칙 1 지급 일정에는 기존 종류만 있다', (id) => {
    const cfg = loadScenario(id), s = openDay(createGame(cfg), cfg).state;
    const result = read(s, cfg, () => upcomingPayments(s, cfg));
    expect(result).toEqual(result.filter((r) => r.kind !== 'RENT' && r.kind !== 'SPACE_FEE'));
  });
});

describe('M2a-5 병목 표 경계', () => {
  it('1일 관측 창은 비어 있고 투자 없음과 S+E의 고용 반례를 보존한다', () => {
    for (const row of n18.hiring) {
      const s = row.invested ? invested() : fresh();
      // 투자 완료 상태를 1일에 놓는 용량 반례다. 실제 확장 명령 효력일은 바꾸지 않는다.
      s.day = 1;
      for (const expansion of s.operations!.expansions) expansion.effectiveDay = 1;
      for (const space of s.operations!.spaceContracts) space.firstSailingDay = config.routes.find((r) => r.id === space.routeId)!.firstDepartureDay;
      const expected = structuredClone(row.outlook.bottleneck);
      expected.storageDetail.windowDays = 0;
      expect(read(s, config, () => weeklyBottleneck(s, config, row.candidate_id))).toEqual(expected);
    }
  });
  it('공개 묶음이 없으면 수요 null이고 동률 제약을 모두 남긴다', () => {
    const s = fresh(); s.operations!.batches = [];
    expect(read(s, config, () => weeklyBottleneck(s, config))).toEqual(n18.initial.bottleneck);
  });
  it('본사 직원 0명이면 직원이 병목이다', () => {
    const s = fresh(); s.employees = [];
    const expected = structuredClone(n18.initial.bottleneck);
    expected.rows[1] = { constraint: 'STAFF', before: 0, after: 0 };
    Object.assign(expected, { usableBefore: 0, usableAfter: 0, binding: { before: ['STAFF'], after: ['STAFF'] } });
    expect(read(s, config, () => weeklyBottleneck(s, config))).toEqual(expected);
  });
  it('무게 상한 0인 노선은 선복 처리량이 없다', () => {
    const cfg = structuredClone(config); cfg.routes.forEach((r) => r.capacityKg = 0);
    const s = fresh(cfg), expected = structuredClone(n18.initial.bottleneck);
    expected.rows[4] = { constraint: 'SAILING', before: 0, after: 0 };
    Object.assign(expected, { usableBefore: 0, usableAfter: 0, binding: { before: ['SAILING'], after: ['SAILING'] } });
    expect(read(s, cfg, () => weeklyBottleneck(s, cfg))).toEqual(expected);
  });
  it('후보가 없거나 이미 고용됐으면 고용 전후가 같다', () => {
    const s = fresh();
    for (const id of [undefined, 'UNKNOWN', config.employees[0]!.id]) {
      expect(read(s, config, () => weeklyBottleneck(s, config, id))).toEqual(n18.initial.bottleneck);
    }
  });
  it('주간 직원 용량은 근무 시작 전·훈련 중 직원도 포함한다', () => {
    const s = fresh();
    s.employees.filter((e) => e.employmentStatus === 'employed').forEach((e) => e.availableFromDay = config.campaignDays);
    expect(read(s, config, () => weeklyBottleneck(s, config))).toEqual(n18.initial.bottleneck);
  });
});

describe('P0-M2A5-20 28일 병목 실측', () => {
  const spec = caseOf('P0-M2A5-20'), f = spec.test_fixture, n = spec.expected_numeric;
  it('계약 원기록의 독립 손계산과 전체 병목 표가 같다', () => {
    for (const [day, expected] of [[f.day, n.bottleneck], [n.mixed_day.day, n.mixed_day.bottleneck]]) {
      const s = atDay(day, config, f.script);
      expect(read(s, config, () => weeklyBottleneck(s, config, f.candidate_id))).toEqual(expected);
    }
    // 진행 명령은 그대로 두고 읽기 용량만 경계에 놓아 300L 차감이 내림에 가려지지 않게 한다.
    const s = atDay(n.mixed_day.day, config, f.script), cfg = structuredClone(config);
    cfg.operations!.facility.storageLiters = n.mixed_day.storage_boundary.capacity_liters;
    expect(read(s, cfg, () => weeklyBottleneck(s, cfg, f.candidate_id))).toEqual(n.mixed_day.storage_boundary.bottleneck);
  });
  it.each([false, true])('재구성 점유는 모든 날의 실제 마감 비작업 화물 점유와 같다 (반환 경계 %s)', (recurringReturn) => {
    const cfg = structuredClone(config);
    // 기본 진행의 반환 고객 화물은 묶음 0이라 제외된다. 추가 조건에서는 읽기용 견적
    // 정의만 반복 견적으로 옮겨 같은 실제 반환 기록의 경계도 따로 검사한다.
    const moved = recurringReturn ? cfg.offers.filter((o) => o.kind === 'forwarding' && o.serviceClass !== 'HANDLING') : [];
    cfg.offers = cfg.offers.filter((o) => !moved.includes(o));
    const observed = (state: GameState) => {
      const view = structuredClone(state);
      view.operations!.offers.push(...structuredClone(moved));
      return view;
    };
    let s = createGame(config);
    const actual: number[] = [];
    for (let t = 1; t < f.day; t++) {
      s = openDay(s, config).state;
      const commands: EngineCommand[] = f.script[t] ?? [];
      const closed = commitDay(s, config, commands);
      expect(closed.results).toEqual(applied(commands));
      s = closed.state;
      const view = observed(s);
      actual.push(view.cargoLots.filter((lot) => {
        if (lot.locationCityId !== config.homeCityId || !['PREPARING', 'AWAITING_DEPARTURE', 'HELD_UNALLOCATED'].includes(lot.status)) return false;
        const c = view.contracts.find((c) => c.cargoLotId === lot.id);
        if (c && cfg.offers.some((o) => o.id === (c.serviceOfferId ?? c.buyOfferId))) return false;
        return !c || c.kind !== 'FORWARDING' || offerDef(view, cfg, c.serviceOfferId!)?.serviceClass !== 'HANDLING';
      }).reduce((sum, lot) => sum + cargoSpace(config, lot.goodId, lot.quantity).volumeLiters, 0));
    }
    // 최종 원기록을 날짜축만 평행 이동하여 각 t+1을 길이 1인 관측 창의 1일에 놓는다.
    // 그러면 평균의 내림에 가려지는 차이 없이 실제 재구성 코드의 하루 점유를 읽는다.
    const reconstructed = actual.map((_, i) => {
      const shifted = observed(s), offset = i + 1;
      shifted.day = 2;
      for (const c of shifted.contracts) {
        c.acceptedDay -= offset;
        if (c.cancelledDay !== null) c.cancelledDay -= offset;
      }
      for (const sh of shifted.shipments) sh.departureDay -= offset;
      return read(shifted, cfg, () => weeklyBottleneck(shifted, cfg)).storageDetail.otherOccupancyLiters;
    });
    expect(reconstructed).toEqual(actual);
  });
  it('28일보다 오래된 준비는 빠지고 남은 미배정 화물은 계속 점유한다', () => {
    const s = atDay(f.day + 14, config, f.script);
    const b = read(s, config, () => weeklyBottleneck(s, config));
    expect({ otherPtPerWeek: b.otherPtPerWeek, storageDetail: b.storageDetail }).toEqual(n.older_window);
  });
  it('시작 견적에 있는 HANDLING 계약도 체류 표본에서 제외한다', () => {
    const s = atDay(f.day, config, f.script), cfg = structuredClone(config);
    const offer = s.operations!.offers.find((o) => o.serviceClass === 'HANDLING'
      && s.contracts.some((c) => c.serviceOfferId === o.id))!;
    cfg.offers.push(structuredClone(offer));
    const expected = structuredClone(n.bottleneck);
    expected.storageDetail.handlingDwellDays = n18.initial.bottleneck.storageDetail.handlingDwellDays;
    expect(read(s, cfg, () => weeklyBottleneck(s, cfg, f.candidate_id))).toEqual(expected);
  });
});
