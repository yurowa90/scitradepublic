import { afterEach, describe, expect, it, vi } from 'vitest';
import { displayKo, esc, josa } from './html';
import { loadScenario, SELECTABLE_SCENARIO_IDS } from '../content/scenario';
import { createGame, openDay, planState } from '../engine/engine';
import { quotePreview } from '../engine/readers';
import { openTradePairs, offerDef } from '../engine/market';
import { formatMoney } from '../engine/money';
import { serializeSave } from '../engine/save';
import { simulate } from '../engine/sim/sim';
import { policyById } from '../engine/sim/policies';
import type { GameState } from '../engine/types';
import { scheduleItems } from './schedule';
import { lastDepartureWarnings } from './trade';
import { startUi, screensReady } from './main-testkit';
import { balanceSheetAt } from '../engine/path11-readers';
import { referenceUsd } from './market';
import { referenceRate, usdToKrwMinor } from '../engine/risk';

afterEach(() => { vi.doUnmock('./lazy'); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('TASK-0087 표시 경로', () => {
  it('학생 화면 원문의 괄호 조사는 0건이다', async () => {
    const { checkUiCopy } = await import('../../tools/check_ui_copy.mjs' as string);
    expect(checkUiCopy()).toEqual([]);
  });

  it.each([
    ['견적 OFFER_BUY_01은(는) 더 이상 유효하지 않습니다.', '견적 OFFER_BUY_01은 더 이상 유효하지 않습니다.'],
    ['계약 CT001 체결 (운송 주선): 가구 120개을(를) 평택 → 하이퐁 운송.', '계약 CT001 체결 (운송 주선): 가구 120개를 평택 → 하이퐁 운송.'],
    ['귀솔은(는) 5일부터 업무를 맡을 수 있습니다.', '귀솔은 5일부터 업무를 맡을 수 있습니다.'],
    ['물보리은(는) 평택에 있습니다. 이 업무는 하이퐁 현지 인력이 필요합니다.', '물보리는 평택에 있습니다. 이 업무는 하이퐁 현지 인력이 필요합니다.'],
    ['귀솔은(는) 다른 업무(현장 조사)를 진행 중입니다.', '귀솔은 다른 업무(현장 조사)를 진행 중입니다.'],
    ['물보리은(는) 이미 이 활동에 참여했습니다.', '물보리는 이미 이 활동에 참여했습니다.'],
    ['같은 활동에 오늘 이미 귀솔이(가) 갑니다.', '같은 활동에 오늘 이미 귀솔이 갑니다.'],
    ['CT001 출항 전 취소. 고객 화물 가구 120개은(는) 화주에게 돌려줌', 'CT001 출항 전 취소. 고객 화물 가구 120개는 화주에게 돌려줌'],
    ['CT001 출항 전 취소. 상품 100상자은(는) 반품 없이 회사 재고로 평택에 남음', 'CT001 출항 전 취소. 상품 100상자는 반품 없이 회사 재고로 평택에 남음'],
    ['계약 CT001이(가) 없습니다.', '계약 CT001이 없습니다.'],
    ['USD 1.5은(는) 최소 단위 정수로 표현할 수 없습니다.', 'USD 1.5는 최소 단위 정수로 표현할 수 없습니다.'],
    ['비율 0.005은(는) basis point 정수로 표현할 수 없습니다.', '비율 0.005는 basis point 정수로 표현할 수 없습니다.'],
    ['CT001이(가) 두 번 출항했습니다', 'CT001이 두 번 출항했습니다'],
  ])('엔진에 보존한 문장 꼴: %s', (input, output) => {
    expect(displayKo(input)).toBe(output);
    expect(esc(input)).toBe(output);
  });

  it.each([
    ['원', '을/를', '을'], ['USD', '을/를', '를'], ['KRW', '이/가', '가'],
    ['50상자', '을/를', '를'], ['50kg', '은/는', '은'], ['30m³', '이/가', '가'],
    ['2pt', '은/는', '는'], ['1', '으로/로', '로'], ['10', '으로/로', '으로'],
    ['1000', '으로/로', '으로'], ['10000', '은/는', '은'], ['1000000000000', '은/는', '는'],
    ['서울', '으로/로', '로'], ['평택', '와/과', '과'], ['ABC', '와/과', '와'], ['L', '이/가', '이'],
  ] as const)('읽는 소리: %s', (word, pair, expected) => expect(josa(word, pair)).toBe(expected));

  it('모르는 말은 보존하고 HTML과 알림에 같은 변환을 적용한다', async () => {
    const unknown = 'bonjour은(는) ?이(가)';
    expect(displayKo(unknown)).toBe(unknown);
    expect(displayKo('귀솔와(과) 물보리(으)로')).toBe('귀솔과 물보리로');
    expect(esc('<귀솔> & "물보리"')).toBe('&lt;귀솔&gt; &amp; &quot;물보리&quot;');
    const { liveRegionText } = await import('./session');
    expect(liveRegionText('', '귀솔은(는) 대기 중입니다.')).toBe('귀솔은 대기 중입니다.');
  });

  it('기본 화면 묶음 불러오기 실패는 빈 화면 대신 새로 고침을 안내한다', async () => {
    vi.doMock('./lazy', async (original) => ({
      ...await original<typeof import('./lazy')>(),
      lazyScreen: () => ({ ensure: () => Promise.reject(new Error('시험용 연결 실패')), get: () => null }),
    }));
    const ui = await startUi(undefined, true);
    expect(ui.app.innerHTML).toContain('화면 일부를 불러오지 못했습니다.');
    expect(ui.app.innerHTML).toContain('data-action="reload"');
  });

  it('실제 기본 진입은 외상 거래이며 원화 견적·참고 이익·필요 자금을 통화별로 표시한다', async () => {
    const ui = await startUi(undefined, true);
    expect(ui.app.innerHTML).toContain('<option value="SCENARIO_M2_OPS_CREDIT" selected>');
    expect(SELECTABLE_SCENARIO_IDS.at(-1)).toBe('SCENARIO_M2_MULTI_TRADE');
    const cfg = loadScenario('SCENARIO_M2_OPS_CREDIT'), s = openDay(createGame(cfg), cfg).state;
    const pair = openTradePairs(s, cfg)[0]!, buy = offerDef(s, cfg, pair.buyOfferId)!;
    const q = quotePreview(s, cfg, pair, buy.quantity), e = q.referenceEstimate!;
    expect(ui.app.innerHTML).toContain(`× ${formatMoney(buy.currency, buy.unitPriceMinor)}`);
    expect(ui.app.innerHTML).toContain(`−${formatMoney(buy.currency, q.purchase)}`);
    for (const m of q.cashNeedByCurrency!) expect(ui.app.innerHTML).toContain(formatMoney(m.currency, m.amountMinor));
    expect(ui.app.innerHTML).toContain(`예상 이익 (원화 매입 포함 · 급여 전)</th><td>${e.pnlKrw >= 0 ? '+' : '−'}${formatMoney('USD', Math.abs(referenceUsd(e.pnlKrw, e.rateKrwPerUsd)))}`);
    expect(ui.app.innerHTML).toContain('DDP 유사 단순화');
    expect(ui.app.innerHTML).toContain('거래 용어 풀이');
    expect(ui.app.innerHTML.match(/선복: 배에 실을 자리/g)).toHaveLength(1);
    expect(ui.app.innerHTML.match(/신고가액: 화주가 신고한 물건 값/g)).toHaveLength(1);
    expect(ui.app.innerHTML).not.toMatch(/K-IFRS|그림 미제작|강화 \+0/);
  });

  it('마지막 정시 편 예약 마감은 확인을 거치고 예약 대기 뒤에는 경고하지 않는다', async () => {
    const cfg = loadScenario('SCENARIO_M1_ONE_TRADE');
    let s = openDay(createGame(cfg), cfg).state;
    const commands = [{ id: 'A', type: 'ACCEPT_TRADE' as const, buyOfferId: 'OFFER_BUY_01', sellOfferId: 'OFFER_SELL_01' }];
    s = planState(s, cfg, commands).state;
    expect(lastDepartureWarnings(s, cfg)).toHaveLength(1);
    const booked = planState(s, cfg, [{ id: 'B', type: 'BOOK_SAILING', contractId: s.contracts[0]!.id, sailingId: 'ROUTE01-D002' }]).state;
    expect(lastDepartureWarnings(booked, cfg)).toEqual([]);
    const ui = await startUi(); await screensReady(); await ui.change({ action: 'scenario' }, cfg.id);
    ui.click({ action: 'accept' });
    expect(ui.app.innerHTML).toContain('오늘 예약하지 않으면 납기 안 마지막 출항편');
    vi.mocked(confirm).mockReturnValue(false);
    ui.click({ action: 'end-day' }); expect(ui.app.innerHTML).toContain('<b>1일</b>');
    vi.mocked(confirm).mockReturnValue(true);
    ui.click({ action: 'end-day' }); expect(ui.app.innerHTML).toContain('<b>2일</b>');
  });

  it('시드 2001 대손 다음 날의 다음 수금·수금 예정에는 해당 송장이 없고 장부에는 대손으로 남는다', async () => {
    const cfg = { ...loadScenario('SCENARIO_M2_OPS_CREDIT'), seed: 2001 };
    let after: GameState | undefined;
    const end = simulate(cfg, policyById('TERM_GREEDY')!, 2001, (s) => {
      if (!after && s.invoices.some((i) => i.status === 'WRITTEN_OFF')) after = structuredClone(s);
    }).state;
    expect(after).toBeDefined();
    const debt = after!.invoices.find((i) => i.status === 'WRITTEN_OFF')!;
    expect(after!.day).toBe(after!.ledger.entries.find((e) => e.id === `BADDEBT-${debt.id}`)!.day + 1);
    const ui = await startUi(); await screensReady(); await ui.importText(serializeSave(after!));
    const top = ui.app.innerHTML.match(/다음 수금<\/span><b>(.*?)<\/b>/)![1]!;
    const { receiptSchedule } = await import('./market');
    const next = receiptSchedule(after!)[0];
    expect(top).toBe(next ? `${next.dueDay}일 ${formatMoney(next.currency, next.outstandingMinor)}` : '없음');
    expect(receiptSchedule(after!).some((i) => i.id === debt.id)).toBe(false);
    expect(scheduleItems(after!, cfg, 90).some((i) => i.kind === 'RECEIPT' && i.contractId === debt.contractId)).toBe(false);
    const paid = after!.invoices.filter((i) => i.status === 'PAID');
    for (const invoice of paid) expect(scheduleItems(after!, cfg, 90).some((i) => i.kind === 'RECEIPT' && i.contractId === invoice.contractId)).toBe(false);
    expect(ui.app.innerHTML).toContain('대손');
    await ui.importText(serializeSave(end));
    const net = (day: number) => balanceSheetAt(end, cfg, day).byCurrency.reduce((sum, row) => {
      const amount = row.assets.reduce((n, r) => n + r.amountMinor, 0) - row.liabilities.reduce((n, r) => n + r.amountMinor, 0);
      return sum + (row.currency === 'USD' ? usdToKrwMinor(amount, referenceRate(cfg, end.rng.seed, day)) : amount);
    }, 0);
    expect(ui.app.innerHTML).toContain(`회사 순자산 변화: 시작 ${formatMoney('KRW', net(1))} → 끝 ${formatMoney('KRW', net(90))}`);
    expect(ui.app.innerHTML).toContain('USD 거래 손익(급여·임차료·원화 비용 제외)');
  });
});
