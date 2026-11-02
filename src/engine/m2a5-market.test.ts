import { describe, expect, it } from 'vitest';
import { createGame, commitDay, openDay, planState } from './engine';
import { batchZero, generateBatch, offerDef, openTradePairs, prepWorkUnitsFor } from './market';
import { marketTable } from './market-lazy';
import { createRng, drawUniform } from './rng';
import { deserializeSave, serializeSave } from './save';
import { runDays } from './testkit';
import { contractReport } from './reports';
import { caseOf, config, atDay, planned, scriptOf, applied, acceptGeneratedFeasible } from './m2a5-testkit';
import type { OfferDef } from './types';

const c1 = caseOf('P0-M2A5-01'), n1 = c1.expected_numeric;
const keepAlive = { [c1.test_fixture.keep_alive_day]: [c1.test_fixture.keep_alive_command] };
function allBatches(seed = config.seed, save = false) {
  let s = createGame({ ...config, seed });
  if (save) {
    s = runDays(s, config, c1.test_fixture.save_day).state;
    s = deserializeSave(serializeSave(s), { dataVersion: config.dataVersion });
  }
  return runDays(s, config, c1.test_fixture.last_publish_day, keepAlive).state;
}
let cachedComplete: ReturnType<typeof allBatches> | undefined;
const complete = () => cachedComplete ??= allBatches();

describe('P0-M2A5-01 결정적 견적 공개', () => {
  it('22개 추첨과 묶음 전체 정의가 인수 수치와 일치한다', () => {
    let rng = createRng(config.seed);
    const values = [];
    const stream = config.operations!.market.rng.streamPrefix + String(c1.test_fixture.batch_k).padStart(config.operations!.market.rng.streamDigits, '0');
    for (let i = 0; i < n1.draw_count; i++) { const d = drawUniform(rng, stream); rng = d.rng; values.push(Number(d.value.toFixed(6))); }
    expect(values).toEqual(n1.draw_values);
    expect(generateBatch(config.seed, c1.test_fixture.batch_k, batchZero(config).index, config)).toEqual(n1.generated);
  });
  it('전날 마감에서 공개하며 재전송·게임 커서는 결과에 영향을 주지 않는다', () => {
    const before = atDay(c1.actions[0]!.day);
    expect(before.operations!.offers).toEqual([]);
    expect(openTradePairs(before, config)).toEqual([]);
    expect(marketTable(before, config)).toEqual(n1.table_before_publish);
    const after = commitDay(before, config, []).state;
    expect(after.operations!.offers).toEqual(n1.generated.offers);
    expect(after.rng.cursors).toEqual({});
    expect(commitDay(after, config, [], before.day).state).toEqual(after);
    const changed = structuredClone(before); changed.rng.cursors[config.operations!.market.rng.streamPrefix + '01'] = 100;
    expect(commitDay(changed, config, []).state.operations).toEqual(after.operations);
    expect(openDay(after, config).state.operations).toEqual(after.operations);
  });
  it('두 실행·저장 재개·처음부터 재계산이 같고 다른 시드는 다르다', () => {
    expect(allBatches().operations).toEqual(complete().operations);
    expect(allBatches(config.seed, true).operations).toEqual(complete().operations);
    let previous = batchZero(config);
    for (const batch of complete().operations!.batches.slice(1)) {
      const generated = generateBatch(config.seed, batch.k, previous.index, config);
      expect(generated).toEqual({ batch, offers: complete().operations!.offers.filter((o) => o.batchK === batch.k) });
      previous = batch;
    }
    expect(allBatches(c1.test_fixture.other_seed).operations!.batches).not.toEqual(complete().operations!.batches);
    expect(complete().operations!.batches.map((b) => b.publishDay)).toEqual(n1.publish_days);
    expect(complete().operations!.batches.at(-1)!.offerIds).toEqual(n1.last_offer_ids);
  });
});

describe('P0-M2A5-02 시세표·체결 가격 고정', () => {
  const c = caseOf('P0-M2A5-02'), n = c.expected_numeric;
  it('수량 선택·체결 이후 시세가 바뀌어도 계약과 정산을 보존한다', () => {
    const p = planned(c), contract = p.state.contracts[0]!;
    expect(p.results).toEqual(applied(c.actions[0]!.commands));
    expect(contract).toEqual({ id: 'CT001', kind: 'DIRECT_TRADE', status: 'IN_PROGRESS',
      buyOfferId: n1.generated.offers[0].id, sellOfferId: n1.generated.offers[1].id, serviceOfferId: null,
      supplierId: n1.generated.offers[0].counterpartyId, customerId: n1.generated.offers[1].counterpartyId,
      goodId: n1.generated.offers[0].goodId, quantity: n1.generated.offers[0].maxQuantity,
      purchaseAmountMinor: n.purchase, saleAmountMinor: n.sale, currency: 'USD', originCityId: config.homeCityId,
      destinationCityId: n1.generated.offers[1].cityId, deliveryDeadlineDay: n1.generated.offers[1].deliveryDeadlineDay,
      paymentDueDay: n.receipt, acceptedDay: c.actions[0]!.day, ownerEmployeeId: config.employees[0]!.id,
      cargoLotId: 'LOT001', prepTaskId: 'TASK001', bookingId: 'BK001', invoiceId: null, deliveredDay: null,
      lateDays: 0, priceReductionMinor: 0, cancelledDay: null, completedDay: null });
    const later = runDays(p.state, config, c.test_fixture.collect_day).state;
    expect(contractReport(later, later.contracts[0]!)).toEqual({ contract: { ...contract, status: 'COMPLETED', invoiceId: 'INV-CT001', deliveredDay: n.arrival, completedDay: n.receipt },
      netRevenue: n.sale, directCost: n.purchase + n.freight + n.duty, cancellationExpense: 0, contribution: n.contribution });
    expect(later.operations!.batches[2]!.index).toEqual(n.next_index_rows);
  });
  it('시세표 여섯 행 전체와 관측 나이·다음 공개일을 읽는다', () => {
    for (const day of c.test_fixture.observation_days as number[]) {
      const s = atDay(day, config, keepAlive), before = structuredClone(s);
      const expected = n.tables.find((t: any) => t.day === day).rows;
      expect(marketTable(s, config)).toEqual(expected); expect(s).toEqual(before);
    }
  });
});

describe('P0-M2A5-05 준비 업무량', () => {
  it('직접 무역·일반 주선·작업 포함 주선의 전체 준비량을 구분한다', () => {
    const c = caseOf('P0-M2A5-05'), n = c.expected_numeric;
    expect(config.offers.map((o) => prepWorkUnitsFor(config, o, o.quantity))).toEqual(n.initial_prep);
    const buys = n1.generated.offers.filter((o: OfferDef) => o.kind === 'supplier');
    expect(buys.map((o: OfferDef, i: number) => n.trade_quantities[i].map((q: number) => prepWorkUnitsFor(config, o, q)))).toEqual(n.trade_prep);
    const templates = config.operations!.market.forwarding.templates;
    const offers = templates.map((t) => ({ ...config.offers.find((o) => o.kind === 'forwarding')!, ...t, prepWorkUnits: t.prepWorkUnits }));
    expect(offers.map((o) => prepWorkUnitsFor(config, o, o.quantity))).toEqual(n.template_prep);
    expect(offers.filter((o) => o.serviceClass === 'HANDLING').map((o) => prepWorkUnitsFor(config, { ...o, quantity: o.quantity / 2 }, o.quantity / 2)))
      .toEqual(n.template_prep.slice(config.operations!.market.forwarding.templates.filter((t) => t.serviceClass === 'STANDARD').length));
  });
});

describe('P0-M2A5-16 가격 수용자', () => {
  it('수락·거절·취소가 시장 묶음과 견적을 바꾸지 않는다', () => {
    const c = caseOf('P0-M2A5-16');
    const cfg = { ...config, startingCash: { ...config.startingCash, KRW: config.startingCash.KRW! * 10 } };
    let active = createGame(cfg);
    while (active.day <= c.test_fixture.last_publish_day) {
      const opened = openDay(active, cfg).state;
      active = commitDay(opened, cfg, acceptGeneratedFeasible(opened, cfg)).state;
    }
    expect(active.contracts.some((c) => active.operations!.offers.some((o) => [c.buyOfferId, c.serviceOfferId].includes(o.id)))).toBe(true);
    expect({ batches: active.operations!.batches, offers: active.operations!.offers }).toEqual({ batches: complete().operations!.batches, offers: complete().operations!.offers });
  });
});

describe('M2a-5 시장 생성 성질', () => {
  it('모든 묶음은 순수하고 추첨 수·작업 포함 건수·ID 유일성을 지킨다', () => {
    const before = structuredClone(config);
    for (const b of complete().operations!.batches.slice(1)) {
      const input = complete().operations!.batches[b.k - 1]!.index, copied = structuredClone(input);
      const output = generateBatch(config.seed, b.k, input, config);
      expect(output).toEqual(generateBatch(config.seed, b.k, input, config));
      expect(input).toEqual(copied);
      expect([output.batch.drawCount, output.offers.filter((o) => o.serviceClass === 'HANDLING').length])
        .toEqual([n1.draw_count, b.publishDay === config.operations!.market.publish.lastDay ? 0 : n1.handling_count]);
    }
    expect(config).toEqual(before);
    const ids = complete().operations!.offers.map((o) => o.id);
    expect(ids).toEqual([...new Set(ids)]);
  });
});
