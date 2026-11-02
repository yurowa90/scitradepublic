import { rowCurrency } from './risk';
import { halfUp, offerDef } from './market';
import type { GameState, ScenarioConfig } from './types';
export function marketTable(state: GameState, config: ScenarioConfig) {
  if (!state.operations || !config.operations) return [];
  const batch = state.operations.batches.filter((b) => b.publishDay <= state.day).at(-1)!;
  const next = batch.publishDay + config.operations.market.publish.intervalDays;
  return batch.rows.map((r) => {
    const indexBp = batch.index.find((i) => i.goodId === r.goodId)!.bp;
    return { cityId: r.cityId, goodId: r.goodId, side: r.side, basePriceMinor: r.basePriceMinor, currency: rowCurrency(config, r.side),
      indexPoints: halfUp(indexBp, 100), indexBp, observedDay: batch.publishDay, ageDays: state.day - batch.publishDay,
      nextObservationDay: next <= config.operations!.market.publish.lastDay ? next : null,
      hasQuoteInBatch: batch.offerIds.some((id) => { const o = offerDef(state, config, id)!;
        return o.goodId === r.goodId && o.cityId === r.cityId && o.kind === (r.side === 'BUY' ? 'supplier' : 'customer'); }) };
  });
}
