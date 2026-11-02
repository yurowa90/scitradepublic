import { creditTermCheck } from './engine';
import { offerDef } from './market';
import type { GameState, ScenarioConfig } from './types';
/** 정책·화면용 외상 선택지. 대손 확률과 조건 계수는 공개하지 않는다. */
export function creditTermOptions(s: GameState, config: ScenarioConfig, buyOfferId: string, sellOfferId: string, quantity?: number) {
  if (config.rules.rulesVersion !== 'M2a-rules-4') return [];
  const q = quantity ?? offerDef(s, config, buyOfferId)?.quantity ?? 0;
  return (['BASE', 'D15', 'D30'] as const).map((termId) => {
    const { allowed, reasonKo, saleAmountMinor, paymentDueDay, grade, limitMinor, exposureMinor } =
      creditTermCheck(s, config, buyOfferId, sellOfferId, q, termId);
    return { termId, allowed, reasonKo, saleAmountMinor, paymentDueDay, grade, limitMinor, exposureMinor };
  });
}
