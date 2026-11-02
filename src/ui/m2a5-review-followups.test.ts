import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario, OPERATIONS_SCENARIO_IDS, SCENARIO_IDS } from '../content/scenario';
import { createGame, openDay, commitDay, planState } from '../engine/engine';
import { listSailings, routeBetween } from '../engine/catalog';
import { offerDef, openTradePairs } from '../engine/market';
import { MINOR_PER_MAJOR, formatMoney } from '../engine/money';
import { dailyKrwDue, paymentDefaultStatus } from '../engine/operations';
import { payrollRunwayDay } from '../engine/previews';
import { quotePreview, exchangePreview } from '../engine/readers';
import { upcomingPayments } from '../engine/reports';
import { fundsPosition } from '../engine/reservations';
import { serializeSave } from '../engine/save';
import { runDays, runToCampaignEnd } from '../engine/testkit';
import type { EngineCommand } from '../engine/types';
import { payrollRunwayKo } from './growth';
import { esc } from './html';
import { fxLotKo, operationsQuoteFacts, paymentStatusKo } from './market';
import { startUi } from './main-testkit';
import { qtyKo } from './reports';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cfg = loadScenario(OPERATIONS_SCENARIO_IDS[0]);
const fresh = (c = cfg) => openDay(createGame(c), c).state;
const usd = (n: number) => formatMoney('USD', n);
const krw = (n: number) => formatMoney('KRW', n);
const exchange = (html: string) => html.split('<section class="exchange"')[1]!.split('</section>')[0]!;
const bar = (html: string) => html.split('id="status-h"')[1]!.split('</header>')[0]!;
const reportWhy = (html: string) => html.split('<div class="why">')[1]!.split('</div>')[0]!;
async function openedUi(c = cfg) {
  const ui = await startUi(c); await (await import('./main-testkit')).screensReady(); await ui.change({ action: 'scenario' }, c.id); return ui;
}
const spaceCommands = (c = cfg): EngineCommand[] => c.operations!.spaceContract.routeIds.map((routeId, i) => ({ id: `REVIEW-SPACE-${i}`, type: 'SIGN_SPACE_CONTRACT', routeId }));

// 시세표와 details의 DOM 속성만 보강한다. 공용 최소 DOM의 구현은 바꾸지 않는다.
function persistentElements(ui: Awaited<ReturnType<typeof startUi>>) {
  const original = ui.doc.getElementById;
  const memory = new Map<string, { html: string; el: any }>();
  ui.doc.getElementById = (id: string): any => {
    if (!['market-scroll', 'investment-details'].includes(id)) return original(id);
    if (!ui.app.innerHTML.includes(`id="${id}"`)) return null;
    let value = memory.get(id);
    if (value?.html !== ui.app.innerHTML) {
      const attrs = ui.app.innerHTML.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))![0];
      const el: any = { id, tagName: id === 'market-scroll' ? 'DIV' : 'DETAILS', dataset: {}, scrollLeft: 0,
        open: /\sopen(?:\s|>)/.test(attrs), closest: () => null, focus: vi.fn(() => { ui.doc.activeElement = el; }) };
      value = { html: ui.app.innerHTML, el }; memory.set(id, value);
    }
    return value!.el;
  };
  return (id: string) => ui.doc.getElementById(id) as any;
}

describe('TASK-0058 화면 검수 후속', () => {
  it('환전 경고·거절은 단추에 연결되고 경고 성공 알림은 방향·금액을 읽는다', async () => {
    const c = structuredClone(cfg), start = fresh();
    const cost = exchangePreview(start, c, 'KRW_TO_USD', 2 * c.operations!.fx.lotUsdMinor).krwMinor;
    c.startingCash.KRW = cost + dailyKrwDue(start, c, start.day) - 1;
    const s = fresh(c), ui = await openedUi(c);
    await ui.change({ action: 'exchange-direction' }, 'KRW_TO_USD');
    await ui.change({ action: 'exchange-amount' }, '2');
    const q = exchangePreview(s, c, 'KRW_TO_USD', 2 * c.operations!.fx.lotUsdMinor);
    expect(q.warningKo).toBeTruthy();
    expect(exchange(ui.app.innerHTML)).toContain(`<p class="reason" id="exchange-warning">${esc(q.warningKo!)}</p>`);
    expect(exchange(ui.app.innerHTML)).toContain('data-action="exchange" aria-describedby="exchange-warning"');
    ui.click({ action: 'exchange' });
    expect(ui.announcements.at(-1)).toContain(`${q.warningKo} 환전 KRW→USD ${usd(2 * c.operations!.fx.lotUsdMinor)}`);
    expect(ui.app.innerHTML).toContain('class="flash-toast flash warn"');
    const poor = structuredClone(cfg); poor.startingCash.USD = 0;
    const denied = await openedUi(poor);
    expect(exchange(denied.app.innerHTML)).toContain('id="exchange-reason"');
    expect(exchange(denied.app.innerHTML)).toContain('data-action="exchange" aria-describedby="exchange-reason"');
    // 자금에 맞는 선택에는 두 이유가 없으면 속성을 생략한다.
    const normal = await openedUi();
    expect(exchange(normal.app.innerHTML)).not.toContain('aria-describedby=');
  });

  it('환전 반복 알림은 실제로 줄어든 금액과 보정 묶음 수를 읽는다', async () => {
    const c = structuredClone(cfg), lot = c.operations!.fx.lotUsdMinor;
    c.startingCash.USD = 3 * lot;
    const ui = await openedUi(c);
    await ui.change({ action: 'exchange-amount' }, '2');
    ui.click({ action: 'exchange' }); const first = ui.announcements.at(-1)!;
    expect(first).toContain(`환전 USD→KRW ${usd(2 * lot)}`);
    expect(first).toContain(`남은 USD에 맞춰 다음 환전 금액을 ${usd(lot)}(1묶음)으로 줄였습니다.`);
    ui.click({ action: 'exchange' }); const second = ui.announcements.at(-1)!;
    expect(second).toContain(`환전 USD→KRW ${usd(lot)}`);
    expect(second).not.toContain(`환전 USD→KRW ${usd(2 * lot)}`);
    expect(first).not.toBe(second);
    const changed = await openedUi(c);
    await changed.change({ action: 'exchange-amount' }, '50');
    expect(changed.announcements.at(-1)).toContain(`다음 환전 금액을 ${usd(3 * lot)}(3묶음)으로 줄였습니다.`);
  });

  it.each(['exchange', 'expand-warehouse', 'sign-space-contract'])('칸 자리 없는 %s 단추는 알림 띠 위로 올리고 초점을 유지한다', async (action) => {
    const c = structuredClone(cfg);
    if (action !== 'exchange') { c.startingCash.KRW = 0; c.startingCash.USD = 0; } // 거절 때 단추가 남고, 성공 후 표시로 바뀌는 경로는 기존 대안 초점 규칙을 쓴다.
    const ui = await openedUi(c);
    const data: Record<string, string> = action === 'sign-space-contract' ? { action, route: cfg.operations!.spaceContract.routeIds[0]! } : { action };
    const key = `${action}:${'route' in data ? data.route : ''}`;
    ui.bounds[key] = { top: 668, bottom: 712, height: 44 };
    ui.setToastTop(670);
    ui.scrollBy.mockClear();
    ui.click(data);
    expect(ui.scrollBy).toHaveBeenCalledWith(0, 50);
    expect(ui.doc.activeElement.dataset.action).toBe(action);
    expect(ui.focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it('수량 변경으로 수락이 막히거나 풀릴 때 이유를 연결하고 알림 띠 없이 읽는다', async () => {
    const c = structuredClone(cfg), day = c.operations!.market.publish.firstDay + c.operations!.market.publish.intervalDays;
    const s = openDay(runDays(createGame(c), c, day - 1).state, c).state;
    const pair = openTradePairs(s, c).find((p) => { const b = offerDef(s, c, p.buyOfferId)!; return b.maxQuantity >= b.quantity + b.quantityStep; })!;
    const buy = offerDef(s, c, pair.buyOfferId)!;
    const small = quotePreview(s, c, pair, buy.quantity), large = quotePreview(s, c, pair, buy.quantity + buy.quantityStep);
    c.operations!.facility.storageLiters = small.storageAfterLiters;
    expect(large.storageAfterLiters).toBeGreaterThan(c.operations!.facility.storageLiters);
    const ui = await openedUi(c); await ui.importText(serializeSave(s));
    const key = `${pair.buyOfferId}+${pair.sellOfferId}`, reasonId = `quote-reason-${key}`;
    const toast = ui.app.innerHTML.match(/<div class="flash-toast[^>]*>.*?<\/div>/)?.[0];
    const count = ui.announcements.length;
    await ui.change({ action: 'offer-quantity', key }, String(buy.quantity + buy.quantityStep));
    const q = quotePreview(s, c, pair, buy.quantity + buy.quantityStep);
    expect(q.allowed).toBe(false);
    expect(ui.app.innerHTML).toContain(`<p class="reason" id="${reasonId}">${esc(q.reasonKo!)}</p>`);
    const select = ui.app.innerHTML.match(new RegExp(`<select[^>]+data-key="${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`))![0];
    expect(select).toContain(`aria-describedby="${reasonId}"`);
    expect(ui.app.innerHTML).toContain(`data-sell="${pair.sellOfferId}" aria-describedby="${reasonId}" disabled`);
    expect(ui.announcements.at(-1)).toBe(`수량 ${qtyKo(c, buy.goodId, q.quantity)}: 수락할 수 없습니다 — ${q.reasonKo}`);
    expect(ui.announcements.length).toBe(count + 1);
    expect(ui.app.innerHTML.match(/<div class="flash-toast[^>]*>.*?<\/div>/)?.[0]).toBe(toast);
    await ui.change({ action: 'offer-quantity', key }, String(buy.quantity));
    expect(ui.announcements.at(-1)).toBe(`수량 ${qtyKo(c, buy.goodId, buy.quantity)}: 수락할 수 있습니다`);
    expect(ui.app.innerHTML).not.toContain(`aria-describedby="${reasonId}"`);
  });

  it('시세표 칸은 열 전환 뒤 같은 id로 초점과 가로 위치를 보존한다', async () => {
    const ui = await openedUi(), get = persistentElements(ui);
    expect(ui.app.innerHTML).toContain('class="table-scroll" id="market-scroll" tabindex="0"');
    const before = get('market-scroll'); before.scrollLeft = 219; before.focus();
    ui.setOneColumn(true);
    const after = get('market-scroll');
    expect(after).not.toBe(before);
    expect(after.scrollLeft).toBe(219);
    expect(after.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(ui.doc.activeElement.id).toBe('market-scroll');
    ui.setOneColumn(false);
    expect(get('market-scroll').scrollLeft).toBe(219);
  });

  it.each([false, true])('통관 1일 인도 경계: 통관일까지 캠페인 포함 %s', async (included) => {
    const c = structuredClone(cfg); c.terms.customsDays = 1;
    const s = fresh(c), pair = openTradePairs(s, c)[0]!, q = quotePreview(s, c, pair);
    const route = routeBetween(c, offerDef(s, c, pair.buyOfferId)!.cityId, offerDef(s, c, pair.sellOfferId)!.cityId)!;
    const sailing = listSailings(c, route.id).find((v) => v.scheduledArrivalDay === q.arrivalDay)!;
    const cmd: EngineCommand = { id: 'CUSTOMS-BOUNDARY', type: 'ACCEPT_TRADE', ...pair, plan: { employeeId: c.employees[0]!.id, sailingId: sailing.id } };
    c.campaignDays = q.arrivalDay! + (included ? c.terms.customsDays : 0);
    expect(operationsQuoteFacts(quotePreview(s, c, pair), s, c).some((v) => v.includes('캠페인 안에 인도되지 않습니다'))).toBe(!included);
    const ui = await openedUi(c);
    expect(ui.app.innerHTML.includes('캠페인 안에 인도되지 않습니다')).toBe(!included);
    const end = runToCampaignEnd(s, c, { [s.day]: [cmd] }).state;
    expect(end.contracts[0]!.deliveredDay).toBe(included ? c.campaignDays : null);
  });

  it('50 USD 설정은 환전 이름표·보고·선택지·명령 금액을 함께 바꾼다', async () => {
    const c = structuredClone(cfg); c.operations!.fx.lotUsdMinor = 5000;
    // 원화 부족 보고가 첫날부터 보이는 설정으로 같은 문장 경로를 검사한다.
    c.startingCash.KRW = 0;
    const s = openDay(commitDay(fresh(c), c, []).state, c).state;
    const ui = await openedUi(c); await ui.importText(serializeSave(s));
    const label = `${c.operations!.fx.lotUsdMinor / MINOR_PER_MAJOR.USD} USD`;
    expect(fxLotKo(c)).toBe(label);
    expect(exchange(ui.app.innerHTML)).toContain(`금액 (${label} 단계)`);
    expect(exchange(ui.app.innerHTML)).toContain(`<option value="2">${usd(2 * c.operations!.fx.lotUsdMinor)} (2묶음)</option>`);
    expect(reportWhy(ui.app.innerHTML)).toContain(`환전 칸에서 ${label} 단위로 원화로 바꿀 수 있습니다`);
    await ui.change({ action: 'exchange-amount' }, '2'); ui.click({ action: 'exchange' }); ui.click({ action: 'end-day' });
    let text = ''; vi.stubGlobal('localStorage', { setItem: (_k: string, value: string) => { text = value; } }); ui.click({ action: 'save' });
    expect(JSON.parse(text).state.operations.exchanges.at(-1).usdMinor).toBe(2 * c.operations!.fx.lotUsdMinor);
  });

  it.each([false, true])('보고의 선복 요금 예약은 계약 예약과 나눈다 (직접 무역 %s)', async (trade) => {
    const c = structuredClone(cfg), routeId = c.operations!.spaceContract.routeIds[0]!;
    const sailing = listSailings(c, routeId, fresh(c).day + 1)[0]!;
    const signed = commitDay(fresh(c), c, [{ id: 'RESERVE-SPACE', type: 'SIGN_SPACE_CONTRACT', routeId }]).state;
    const day = sailing.departureDay - c.operations!.spaceContract.reserveDaysAhead;
    let s = openDay(runDays(signed, c, Math.max(signed.day, day) - 1).state, c).state;
    if (trade) s = planState(s, c, [{ id: 'RESERVE-TRADE', type: 'ACCEPT_TRADE', ...openTradePairs(s, c)[0]! }]).state;
    const f = fundsPosition(s, c, 'USD');
    expect(f.reservedCommitments).toBeGreaterThan(0);
    expect(f.reserved > f.reservedCommitments).toBe(trade);
    const ui = await openedUi(c); await ui.importText(serializeSave(s)); const why = reportWhy(ui.app.innerHTML);
    expect(why).toContain(`선복 장기 계약의 다가오는 출항 요금 ${usd(f.reservedCommitments)}`);
    expect(why).not.toContain('운임·관세를 미리 묶어');
    if (trade) expect(why).toContain(`체결한 계약이 낼 운임·관세 ${usd(f.reserved - f.reservedCommitments)}`);
    else expect(why).not.toContain('체결한 계약이 낼 운임·관세');
  });

  it('막대의 급여 가능일은 state와 다른 view 값이고 환전 칸은 방향별 읽기 값이다', async () => {
    const s = fresh(), ui = await openedUi(), lot = cfg.operations!.fx.lotUsdMinor;
    await ui.change({ action: 'exchange-amount' }, '5'); ui.click({ action: 'exchange' });
    const v = planState(s, cfg, [{ id: 'BAR-FX', type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: 5 * lot }]).state;
    expect(payrollRunwayDay(v, cfg)).not.toBe(payrollRunwayDay(s, cfg));
    expect(bar(ui.app.innerHTML)).toContain(`<span>원화 급여 가능일</span><b>${payrollRunwayKo(payrollRunwayDay(v, cfg), v.day, cfg.campaignDays)}</b>`);
    for (const direction of ['USD_TO_KRW', 'KRW_TO_USD'] as const) {
      await ui.change({ action: 'exchange-direction' }, direction); await ui.change({ action: 'exchange-amount' }, '2');
      const q = exchangePreview(v, cfg, direction, 2 * lot), html = exchange(ui.app.innerHTML);
      expect(html).toContain(`${cfg.operations!.fx.buyKrwPerUsd.toLocaleString('ko-KR')}원(받을 때)`);
      expect(html).toContain(`${cfg.operations!.fx.sellKrwPerUsd.toLocaleString('ko-KR')}원(살 때)`);
      expect(html).toContain(`<dt>내는 금액</dt><dd>${direction === 'USD_TO_KRW' ? usd(2 * lot) : krw(q.krwMinor)}</dd>`);
      expect(html).toContain(`<dt>받는 금액</dt><dd>${direction === 'USD_TO_KRW' ? krw(q.krwMinor) : usd(2 * lot)}</dd>`);
      expect(html).toContain(`<dd>${payrollRunwayKo(q.runwayBefore, v.day, cfg.campaignDays)} → ${payrollRunwayKo(q.runwayAfter, v.day, cfg.campaignDays)}</dd>`);
    }
  });

  it('지급 실패일과 캠페인 끝이 같으면 실패까지 전체 문구와 마지막 마감일이 같다', () => {
    let s = fresh(); while (paymentDefaultStatus(s, cfg).level === 'NONE') s = openDay(commitDay(s, cfg, []).state, cfg).state;
    const status = paymentDefaultStatus(s, cfg), c = { ...cfg, campaignDays: status.failAtCloseOfDay! };
    const remaining = cfg.operations!.paymentDefault.failureAgeDays - status.ageDays!;
    expect(paymentStatusKo(s, c)).toBe(`경고 · 실패까지 ${remaining}일`);
    const end = runToCampaignEnd(s, c).state;
    expect(end.operations!.outcome).toBe('FAILED');
    expect(end.closedDays.at(-1)).toBe(c.campaignDays);
    expect(end.operations!.failure!.day).toBe(c.campaignDays);
  });

  it('투자 칸은 기본 접힘·대기 및 체결 시 펼침이고 사용자가 고른 상태를 보존한다', async () => {
    const ui = await openedUi(), get = persistentElements(ui);
    expect(ui.app.innerHTML).toContain('<details class="investments" id="investment-details">');
    get('investment-details').open = true;
    await ui.change({ action: 'exchange-amount' }, '2');
    expect(get('investment-details').open).toBe(true);
    get('investment-details').open = false;
    ui.click({ action: 'expand-warehouse' });
    expect(ui.app.innerHTML).toContain('<details class="investments" id="investment-details" open>');
    expect(ui.app.innerHTML).toContain('(대기 1건)');
    expect(ui.app.innerHTML).toContain(`창고 확장 예정 ${fresh().day + cfg.operations!.facility.expansion.effectiveAfterDays}일`);
    ui.click({ action: 'end-day' });
    expect(get('investment-details').open).toBe(true);
    get('investment-details').open = false;
    await ui.change({ action: 'exchange-amount' }, '1');
    expect(get('investment-details').open).toBe(false);
    const signed = openDay(commitDay(fresh(), cfg, spaceCommands()).state, cfg).state;
    await ui.importText(serializeSave(signed)); expect(get('investment-details').open).toBe(true);
  });

  it('다가오는 USD 선복 요금은 체결 뒤 전체 남은 지급 목록의 합이며 계약 없으면 없다', async () => {
    const normal = await openedUi(); expect(exchange(normal.app.innerHTML)).not.toContain('앞으로 낼 선복 요금');
    const signed = openDay(commitDay(fresh(), cfg, spaceCommands()).state, cfg).state;
    const fees = upcomingPayments(signed, cfg, cfg.campaignDays).filter((p) => p.kind === 'SPACE_FEE' && p.day !== null);
    expect(signed.operations!.spaceContracts).toHaveLength(cfg.operations!.spaceContract.routeIds.length);
    expect(fees.length).toBeGreaterThan(cfg.operations!.spaceContract.routeIds.length);
    const ui = await openedUi(); await ui.importText(serializeSave(signed));
    expect(exchange(ui.app.innerHTML)).toContain(`앞으로 낼 선복 요금 ${usd(fees.reduce((sum, p) => sum + p.amountMinor, 0))}(${fees.length}편, 다음 ${Math.min(...fees.map((p) => p.day!))}일). 출항 ${cfg.operations!.spaceContract.reserveDaysAhead}일 전부터 쓸 수 있는 USD에서 묶입니다.`);
    await ui.change({ action: 'exchange-direction' }, 'KRW_TO_USD'); expect(exchange(ui.app.innerHTML)).not.toContain('앞으로 낼 선복 요금');
  });

  it('규칙 1 시나리오 select의 현재 항목이 selected다', async () => {
    const legacy = loadScenario(SCENARIO_IDS[0]), ui = await startUi(); await (await import('./main-testkit')).screensReady();
    expect(ui.app.innerHTML.match(/<select data-action="scenario">([\s\S]*?)<\/select>/)![1]).toContain(`<option value="${legacy.id}" selected>`);
  });
});
