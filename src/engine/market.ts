import { rowCurrency } from './risk';
// 공개 묶음은 지역 난수만 사용한다. 플레이어 행동과 게임 난수 커서에 영향을 받지 않는다.
import { cargoSpace, routeBetween } from './catalog';
import { drawUniform } from './rng';
import type { GameState, MarketBatch, MarketSide, OfferDef, ScenarioConfig } from './types';

export const halfUp = (n: number, d: number) => Math.floor((n + d / 2) / d);

export function batchZero(config: ScenarioConfig): MarketBatch {
  const m = config.operations!.market;
  return { k: 0, publishDay: m.publish.firstDay,
    index: m.index.goods.map((goodId) => ({ goodId, bp: m.index.startBp, stepPct: null })),
    destinations: null, rows: m.rows.map((r) => ({ ...r, regionalPct: 0 })),
    counterpartyPct: null, maxLots: null, templateIds: [], offerIds: config.offers.map((o) => o.id), drawCount: 0 };
}

export function generateBatch(seed: number, k: number, prevIndex: MarketBatch['index'], config: ScenarioConfig): { batch: MarketBatch; offers: OfferDef[] } {
  const m = config.operations!.market;
  let rng = { seed, cursors: {} };
  const stream = m.rng.streamPrefix + String(k).padStart(m.rng.streamDigits, '0');
  let drawCount = 0;
  const draw = () => { const d = drawUniform(rng, stream); rng = d.rng; drawCount++; return d.value; };
  const between = (range: number[]) => range[0]! + Math.floor(draw() * (range[1]! - range[0]! + 1));
  const pick = <T>(values: T[]) => values[Math.floor(draw() * values.length)]!;
  const publishDay = m.publish.firstDay + k * m.publish.intervalDays;
  const index = m.index.goods.map((goodId) => {
    const stepPct = between(m.index.stepPct);
    const bp = Math.max(m.index.minBp, Math.min(m.index.maxBp, halfUp(prevIndex.find((i) => i.goodId === goodId)!.bp * (100 + stepPct), 100)));
    return { goodId, bp, stepPct };
  });
  const destinations = m.trade.goods.map((g) => ({ goodId: g.goodId, cityId: pick(m.trade.sellCityIds) }));
  const rows = m.rows.map((r) => {
    const regionalPct = between(m.regionalPct);
    return { ...r, basePriceMinor: halfUp(r.basePriceMinor * index.find((i) => i.goodId === r.goodId)!.bp * (100 + regionalPct), 1000000), regionalPct };
  });
  const counterpartyPct = m.trade.goods.flatMap((g) => (['BUY', 'SELL'] as MarketSide[]).map((side) => ({ goodId: g.goodId, side, pct: between(m.counterpartyPct) })));
  const maxLots = m.trade.goods.map((g) => ({ goodId: g.goodId, lots: pick(m.trade.maxLotsChoices) }));
  const selected: string[] = [];
  for (const d of m.forwarding.draws) {
    const pool = m.forwarding.templates.filter((t) => t.serviceClass === d.serviceClass);
    for (let i = 0; i < d.count; i++) {
      const j = i + Math.floor(draw() * (pool.length - i));
      [pool[i], pool[j]] = [pool[j]!, pool[i]!];
      selected.push(pool[i]!.id);
    }
  }
  const templates = m.forwarding.templates.filter((t) => selected.includes(t.id));
  const prefix = `MKT-D${String(publishDay).padStart(3, '0')}`;
  const common = { publishDay, batchK: k, validUntilDay: publishDay + m.publish.validDays - 1,
    originCountryCode: config.cities.find((c) => c.id === m.trade.buyCityId)!.countryCode,
    declaredCargoValueMinor: null };
  const offers: OfferDef[] = [];
  for (const g of m.trade.goods) {
    const destination = destinations.find((d) => d.goodId === g.goodId)!.cityId;
    for (const side of ['BUY', 'SELL'] as const) {
      const cityId = side === 'BUY' ? m.trade.buyCityId : destination;
      const row = rows.find((r) => r.cityId === cityId && r.goodId === g.goodId && r.side === side)!;
      const pct = counterpartyPct.find((p) => p.goodId === g.goodId && p.side === side)!.pct;
      const deadline = side === 'BUY' ? null : publishDay + m.trade.sellDeadlineOffsetDays;
      const due = side === 'BUY' ? null : publishDay + m.trade.paymentOffsetDays.find((p) => p.cityId === cityId)!.days;
      if ((deadline !== null && deadline > config.campaignDays) || (due !== null && due > config.campaignDays)) continue;
      offers.push({ ...common, id: `${prefix}-${g.idTag}-${side}`, kind: side === 'BUY' ? 'supplier' : 'customer',
        counterpartyId: side === 'BUY' ? g.buyCounterpartyId : g.sellCounterparties.find((p) => p.cityId === cityId)!.counterpartyId,
        cityId, goodId: g.goodId, quantity: g.baseLot, quantityStep: g.baseLot,
        maxQuantity: maxLots.find((v) => v.goodId === g.goodId)!.lots * g.baseLot,
        unitPriceMinor: halfUp(row.basePriceMinor * (100 + pct), 100), serviceFeeMinor: 0, currency: rowCurrency(config, side),
        destinationCityId: null, deliveryDeadlineDay: deadline, paymentDueDay: due,
        serviceClass: null, templateId: null, titleKo: null, prepWorkUnits: null });
    }
  }
  for (const t of templates) {
    const deliveryDeadlineDay = publishDay + t.deadlineOffsetDays, paymentDueDay = publishDay + t.paymentOffsetDays;
    if (deliveryDeadlineDay > config.campaignDays || paymentDueDay > config.campaignDays) continue;
    offers.push({ ...common, id: `${prefix}-${t.id}`, kind: 'forwarding', counterpartyId: t.counterpartyId,
      cityId: m.trade.buyCityId, goodId: t.goodId, quantity: t.quantity, maxQuantity: t.quantity, quantityStep: t.quantity,
      unitPriceMinor: 0, serviceFeeMinor: t.serviceFeeMinor, currency: t.currency, destinationCityId: t.destinationCityId,
      deliveryDeadlineDay, paymentDueDay, serviceClass: t.serviceClass, templateId: t.id, titleKo: t.titleKo, prepWorkUnits: t.prepWorkUnits });
  }
  return { batch: { k, publishDay, index, destinations, rows, counterpartyPct, maxLots,
    templateIds: templates.map((t) => t.id), offerIds: offers.map((o) => o.id), drawCount }, offers };
}

export function offerDef(state: GameState, config: ScenarioConfig, id: string): OfferDef | undefined {
  return config.offers.find((o) => o.id === id) ?? state.operations?.offers.find((o) => o.id === id);
}

export function openTradePairs(state: GameState, config: ScenarioConfig): { buyOfferId: string; sellOfferId: string }[] {
  const open = state.offers.filter((o) => o.status === 'OPEN').map((o) => offerDef(state, config, o.id)!)
    .filter((o) => o.publishDay <= state.day && o.validUntilDay >= state.day);
  return open.filter((o) => o.kind === 'supplier').flatMap((buy) => open.filter((sell) => sell.kind === 'customer'
    && buy.publishDay === sell.publishDay && buy.goodId === sell.goodId && routeBetween(config, buy.cityId, sell.cityId))
    .map((sell) => ({ buyOfferId: buy.id, sellOfferId: sell.id })));
}



export function prepWorkUnitsFor(config: ScenarioConfig, offer: OfferDef, quantity: number): number {
  if (!config.operations) return offer.kind === 'forwarding' ? config.terms.forwardingPrepWorkUnits : config.terms.prepWorkUnits;
  const prep = config.operations.prep;
  if (offer.kind !== 'forwarding') return config.terms.prepWorkUnits + (quantity / offer.quantityStep - 1) * prep.tradeExtraPerLot;
  if (offer.serviceClass === 'HANDLING') return offer.prepWorkUnits!;
  return Math.max(prep.minWorkUnits, Math.ceil(cargoSpace(config, offer.goodId, quantity).volumeLiters / prep.standardLitersPerWorkUnit));
}
