import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay } from '../engine/engine';
import { offerDef, openTradePairs } from '../engine/market';
import { formatMoney } from '../engine/money';
import { quotePreview } from '../engine/readers';
import { referenceUsd } from './market';
import { screensReady, startUi } from './main-testkit';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cards = (html: string) => html.match(/<article class="offer[^"]*"[\s\S]*?<\/article>/g) ?? [];
const hash = async (html: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(html)))].map((n) => n.toString(16).padStart(2, '0')).join('');

describe('TASK-0088 견적 머리 이익', () => {
  // 표시 변경 전 BASE에서 기록한 견적 카드 전체 HTML. USD 매입·운송 주선·옛 시나리오를 보호한다.
  it.each([
    ['SCENARIO_M2_MULTI_TRADE', 4, '7bc5cb28b655aad41091e67de8c6c46a873b5960b6ba4ab812418d3da66d8e55'],
    ['SCENARIO_M2_OPERATIONS', 4, '9e76778b3f5a9a34ace6235e55888e66cc7898d4eb2b1c07d9b992720368e82d'],
    ['SCENARIO_M2_OPS_CREDIT', 2, '41560f60f3829149edd795a342460025da6c45732482a8851c975776dbaa8ee8'],
  ] as const)('%s의 원화 참고값 없는 견적 HTML은 BASE와 같다', async (id, count, baseline) => {
    const cfg = loadScenario(id);
    const ui = await startUi(cfg); await screensReady(); await ui.change({ action: 'scenario' }, cfg.id);
    const unchanged = cards(ui.app.innerHTML).filter((card) => !card.includes('class="reference-profit"'));
    expect([unchanged.length, await hash(unchanged.join(''))]).toEqual([count, baseline]);
    expect(unchanged.length).toBeGreaterThan(0);
  });

  it.each([false, true])('주 시나리오 1일 화장품 견적은 원화 포함 이익을 먼저 보인다 (손실: %s)', async (loss) => {
    const cfg = loadScenario('SCENARIO_M2_OPS_CREDIT');
    // 매입 가격만 바꾼 시험 설정으로 음수 참고 손익의 색·부호도 확인한다.
    if (loss) cfg.offers.find((o) => o.kind === 'supplier' && o.goodId === 'COSMETICS')!.unitPriceMinor *= 2;
    const state = openDay(createGame(cfg), cfg).state;
    const pair = openTradePairs(state, cfg).find((p) => offerDef(state, cfg, p.buyOfferId)!.goodId === 'COSMETICS')!;
    const buy = offerDef(state, cfg, pair.buyOfferId)!;
    const q = quotePreview(state, cfg, pair, buy.quantity), estimate = q.referenceEstimate!;
    const expectedUsd = referenceUsd(estimate.pnlKrw, estimate.rateKrwPerUsd);
    expect(expectedUsd < 0).toBe(loss);
    const ui = loss ? await startUi(cfg) : await startUi(undefined, true);
    if (loss) { await screensReady(); await ui.change({ action: 'scenario' }, cfg.id); }
    const card = cards(ui.app.innerHTML).find((html) => html.includes(`data-buy="${buy.id}"`))!;
    const total = card.match(/<tr class="total">[\s\S]*?<\/tr>/)![0];
    expect(total).toBe(`<tr class="total"><th>예상 이익 (원화 매입 포함 · 급여 전)</th><td${loss ? ' class="neg"' : ''}>${loss ? '−' : '+'}${formatMoney('USD', Math.abs(expectedUsd))}</td></tr>`);
    const reference = card.match(/<p class="reference-profit">[\s\S]*?<\/p>/)![0];
    expect(reference).toBe(`<p class="reference-profit">기준 환율 ${estimate.rateKrwPerUsd.toLocaleString('ko-KR')}원/USD로 환산한 참고값입니다. USD로만 보면 +${formatMoney('USD', q.contributionBeforePayroll)}(원화 매입 ${formatMoney('KRW', q.purchase)} 제외).</p>`);
    expect(ui.app.innerHTML).toContain('원화로 사는 거래는 원화 매입 대금까지 뺀 값을 먼저 보여 줍니다.');
  });
});
