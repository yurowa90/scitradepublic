import { afterEach, describe, expect, it, vi } from 'vitest';
import acceptance from '../../tests/acceptance_cases.json';
import { loadScenario, OPERATIONS_SCENARIO_IDS, SCENARIO_IDS } from '../content/scenario';
import { listSailings, routeBetween, findSailing } from '../engine/catalog';
import * as engine from '../engine/engine';
import { createGame, commitDay, openDay, planState } from '../engine/engine';
import { offerDef, openTradePairs } from '../engine/market';
import { lateDeliveryReduction, paymentDefaultStatus, storageCapacityLiters, handlingCapacityPt } from '../engine/operations';
import { warehouseSummary, weeklyBottleneck } from '../engine/readers';
import { serializeSave } from '../engine/save';
import { runDays, type DayScript } from '../engine/testkit';
import type { OperationCase } from '../engine/m2a5-testkit';
import type { EngineCommand, GameState, ScenarioConfig } from '../engine/types';
import { formatMoney } from '../engine/money';
import { esc } from './html';
import { exchangeBlock, exchangeSelection, operationsTopbar, paymentStatusKo } from './market';
import { SITUATION_BUTTON, startUi } from './main-testkit';
import { bottlenecks, BOTTLENECK_OF } from './reports';
import { scheduleBlock, scheduleItems } from './schedule';
import { initialUiState } from './session';
import { investmentBlock, warehouseBlock, weeklyBottleneckTable, routeLabel } from './warehouse';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cfg = loadScenario(OPERATIONS_SCENARIO_IDS[0]), legacy = loadScenario(SCENARIO_IDS[0]);
const fresh = (config = cfg) => openDay(createGame(config), config).state;
const atDay = (day: number, script: DayScript = {}, config = cfg) => openDay(runDays(createGame(config), config, day - 1, script).state, config).state;
const next = (s: GameState, cmds: EngineCommand[] = [], config = cfg) => openDay(commitDay(s, config, cmds).state, config).state;
const expand: EngineCommand = { id: 'TEST-EXPAND', type: 'EXPAND_WAREHOUSE' };
const loadedUi = async (s = fresh(), config = cfg) => {
  const ui = await startUi(config); await (await import('./main-testkit')).screensReady(); await ui.change({ action: 'scenario' }, config.id);
  await ui.importText(serializeSave(s)); return ui;
};
const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((n) => n.toString(16).padStart(2, '0')).join('');
const tbody = (html: string) => html.match(/<tbody>([\s\S]*?)<\/tbody>/)![1]!;
const rows = (html: string) => [...tbody(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => m[1]!);
// 창고 처리 대기 예외는 인수 자료의 impact 픽스처에서만 만든다.
const cases = acceptance.cases as unknown as OperationCase[];
const impactCase = cases.find((c) => 'impact_candidate' in (c.test_fixture ?? {}))!;
const fixture = impactCase.test_fixture as Record<string, any>;
const historyCase = cases.find((c) => 'history_commands' in (c.test_fixture ?? {}))!;
const history = historyCase.test_fixture as Record<string, any>;
function impactState() {
  const trade = impactCase.actions.find((a) => a.variant === 'trade')!;
  const s = atDay(trade.day), e = s.employees.find((e) => e.id === fixture.impact_candidate)!;
  e.employmentStatus = 'employed'; e.availableFromDay = s.day;
  const p = planState(s, cfg, fixture.impact_commands);
  expect(p.results.every((r) => r.status === 'APPLIED')).toBe(true);
  p.state.tasks[0]!.requiredWorkUnits = fixture.impact_required_pt;
  const waiting = planState(p.state, cfg, [fixture.impact_accept_command]);
  expect(waiting.results[0]!.status).toBe('APPLIED');
  return waiting.state;
}

describe('본사·창고와 주간 병목', () => {
  it('다섯 줄 순서는 수요·직원·창고 처리·보관·선복이고 규칙 1에는 없다', async () => {
    const ui = await loadedUi(), q = warehouseSummary(fresh(), cfg);
    expect(rows(ui.app.innerHTML.split('class="warehouse-summary"')[1]!)).toEqual([
      `<th scope="row">수요</th><td>최근 묶음 ${q.demand.batchPublishDay}일 공개 · 열린 견적 준비 ${q.demand.openPrepPt}pt·부피 ${q.demand.openVolumeLiters / 1000} m³ · 최근 4묶음 견적 pt / 받은 pt: 아직 묶음 없음</td>`,
      `<th scope="row">직원</th><td>본사 하루 처리 ${q.staff.workUnitsPerDay}pt · 오늘 남는 ${q.staff.idleWorkUnitsToday}pt</td>`,
      `<th scope="row">창고 처리</th><td>오늘 한도 ${q.handling.capacityPtToday}pt · 계획 사용 ${q.handling.plannedUsePtToday}pt · 대기 업무 ${q.handling.waitTaskCount}건·대기 ${q.handling.waitPt}pt</td>`,
      `<th scope="row">보관</th><td>사용 ${q.storage.usedLiters / 1000} m³ / 한도 ${q.storage.capacityLiters / 1000} m³ · 미배정 회사 화물 ${q.storage.heldUnallocatedLiters / 1000} m³</td>`,
      `<th scope="row">선복</th><td>${esc(q.sailings.map((s) => { const sailing = findSailing(cfg, s.sailingId)!; return `${routeLabel(cfg, sailing.routeId)} ${sailing.departureDay}일 편: 사용 ${s.usedLiters / 1000} m³ / 한도 ${s.capacityLiters / 1000} m³ · ${s.usedGrams / 1000} / ${s.capacityGrams / 1000} kg`; }).join(' · '))}</td>`,
    ]);
    expect(ui.app.innerHTML.indexOf('id="warehouse-h"')).toBeLessThan(ui.app.innerHTML.indexOf('<h4>업무 부하'));
    await ui.change({ action: 'scenario' }, legacy.id);
    expect(ui.app.innerHTML).not.toContain('class="warehouse"');
  });

  it('확장 효력일에만 전·후 한도 문장이 있고 다음 날에는 없다', () => {
    const s = next(fresh(), [expand]), after = next(s);
    const sentence = `한도가 ${storageCapacityLiters(s, cfg, s.day - 1) / 1000} → ${storageCapacityLiters(s, cfg, s.day) / 1000} m³로 늘어 사용률이 내려갔습니다`;
    expect(s.day).toBe(s.operations!.expansions[0]!.effectiveDay);
    expect(warehouseBlock(s, s, cfg, [])).toContain(sentence);
    expect(warehouseBlock(after, after, cfg, [])).not.toContain('사용률이 내려갔습니다');
  });

  it('확장 대기열은 예정 문장과 두 행의 한도 제외 근거를 보이고 빼면 사라진다', async () => {
    const ui = await loadedUi(), s = fresh(), v = planState(s, cfg, [expand]).state, e = v.operations!.expansions[0]!;
    ui.click({ action: 'expand-warehouse' });
    expect(ui.app.innerHTML).toContain(`${e.effectiveDay}일부터 창고 한도가 ${storageCapacityLiters(v, cfg, e.effectiveDay) / 1000} m³·처리 ${handlingCapacityPt(v, cfg, e.effectiveDay)}pt로 늘어납니다(확장 예정)`);
    const table = weeklyBottleneckTable(s, v, cfg);
    for (const [i, r] of weeklyBottleneck(v, cfg).rows.entries()) {
      const text = rows(table)[i]!;
      expect(text.includes(`${e.effectiveDay}일 확장 뒤 한도는 아직 넣지 않았습니다`)).toBe(['STORAGE', 'WAREHOUSE_HANDLING'].includes(r.constraint));
    }
    ui.click({ action: 'unqueue', index: '0' });
    expect(ui.app.innerHTML).not.toContain('(확장 예정)');
    expect(ui.app.innerHTML).not.toContain('확장 뒤 한도는 아직 넣지 않았습니다');
  });

  it('병목 표는 전체 행 값·순서와 가장 좁음 표시를 읽기 함수와 비교한다', () => {
    // 첫 반복 묶음이 공개되는 날에는 수요 null 반례도 함께 비교한다.
    for (const s of [fresh(), atDay(cfg.operations!.market.publish.firstDay + cfg.operations!.market.publish.intervalDays)]) {
      const q = weeklyBottleneck(s, cfg), html = weeklyBottleneckTable(s, s, cfg), lines = rows(html);
      const expectedNames = ['수요', '직원', '창고 처리', '보관', '선복'];
      expect([...tbody(html).matchAll(/data-constraint="([^"]+)"/g)].map((m) => m[1])).toEqual(q.rows.map((r) => r.constraint));
      expect(lines.map((line, i) => ({ name: line.match(/<th[^>]*>([^<]+)/)![1], cell: line.match(/<td>(.*?)<\/td>/)![1] }))).toEqual(q.rows.map((r, i) => ({ name: expectedNames[i], cell: `${r.before === null ? '아직 묶음 없음' : r.before}${q.binding.before.includes(r.constraint) ? ' <span>← 가장 좁음</span>' : ''}` })));
      expect(html).toContain(`다른 일에 주당 ${q.otherPtPerWeek}pt`);
      expect(html).toContain('이 표는 지난 기록의 평균·최고를 다음 주에 그대로 놓은 추정입니다. 도착이 몰리면 실제로는 더 적게 처리합니다.');
    }
  });

  it('보관 근거는 최고가 평균보다 큰 실제 이력과 첫날 기본값을 구분한다', () => {
    // 자료의 반복 화물 수락 다음 날은 점유가 생기고, 그 뒤 날은 최고와 평균이 갈라진다.
    const s = atDay(history.storage_day + 2, { [history.storage_day]: history.history_commands });
    const d = weeklyBottleneck(s, cfg).storageDetail;
    expect(d.windowDays).toBeGreaterThan(0); expect(d.otherPeakLiters).toBeGreaterThan(d.otherOccupancyLiters);
    const html = weeklyBottleneckTable(s, s, cfg);
    expect(html).toContain(`지난 ${d.windowDays}일 다른 화물이 창고를 가장 많이 쓴 날 ${d.otherPeakLiters / 1000} m³(평균 ${d.otherOccupancyLiters / 1000} m³), 작업 화물은 평균 ${d.handlingDwellDays}일 머묾. 가장 많이 쓴 날 기준으로 계산합니다`);
    expect(html).not.toContain('아직 쌓인 기록이 없어');
    const initial = weeklyBottleneckTable(fresh(), fresh(), cfg);
    expect(initial).toContain(`아직 쌓인 기록이 없어 기본값(머묾 ${weeklyBottleneck(fresh(), cfg).storageDetail.handlingDwellDays}일)으로 계산했습니다`);
    expect(initial).not.toContain('가장 많이 쓴 날 기준으로 계산합니다');
  });
});

describe('투자 미리보기와 대기열', () => {
  it('효력일 후 한도가 전과 다르고 계획과 같으며 실제 자금 부족은 엔진 문장을 쓴다', () => {
    const s = fresh(), planned = planState(s, cfg, [expand]), day = s.day + cfg.operations!.facility.expansion.effectiveAfterDays;
    expect(planned.results[0]!.status).toBe('APPLIED');
    expect(storageCapacityLiters(planned.state, cfg, day)).not.toBe(storageCapacityLiters(s, cfg, day));
    expect(handlingCapacityPt(planned.state, cfg, day)).not.toBe(handlingCapacityPt(s, cfg, day));
    const html = investmentBlock(s, s, cfg, []);
    expect(html).toContain(`${storageCapacityLiters(s, cfg, day) / 1000} m³ → ${storageCapacityLiters(planned.state, cfg, day) / 1000} m³`);
    expect(html).toContain(`${handlingCapacityPt(s, cfg, day)}pt → ${handlingCapacityPt(planned.state, cfg, day)}pt`);
    expect(html).toContain(formatMoney('KRW', cfg.operations!.facility.expansion.setupFeeMinor));
    expect(html).toContain(formatMoney('KRW', cfg.operations!.facility.expansion.rentIncreaseMinor));
    let poor = s;
    while (planState(poor, cfg, [expand]).results[0]!.status === 'APPLIED') poor = next(poor);
    const refused = planState(poor, cfg, [expand]).results[0]!;
    expect(refused.status).toBe('REJECTED');
    expect(investmentBlock(poor, poor, cfg, [])).toContain(`<p class="reason">${esc(refused.reasonKo)}</p>`);
    expect(investmentBlock(poor, poor, cfg, [])).toContain('data-action="expand-warehouse"');
    expect(html).not.toContain(esc(refused.reasonKo));
  });

  it('환전 대기열 뒤 투자 계획은 state에 한 번만 적용한다', () => {
    const s = fresh(), fx: EngineCommand = { id: 'FX-QUEUED', type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: cfg.operations!.fx.lotUsdMinor };
    const view = planState(s, cfg, [fx]).state, plan = planState(s, cfg, [fx, expand]);
    expect(plan.results.at(-1)!.status).toBe('APPLIED');
    const planner = vi.spyOn(engine, 'planState');
    const html = investmentBlock(s, view, cfg, [fx]);
    expect(planner.mock.calls.length).toBeGreaterThan(0);
    for (const call of planner.mock.calls) {
      expect(call[0]).toBe(s); expect(call[2][0]).toBe(fx);
    }
    expect(html).toContain(`${storageCapacityLiters(view, cfg, s.day + cfg.operations!.facility.expansion.effectiveAfterDays) / 1000} m³ → ${storageCapacityLiters(plan.state, cfg, s.day + cfg.operations!.facility.expansion.effectiveAfterDays) / 1000} m³`);
    // 같은 ID의 중복 처리 거절 문장은 올바른 계획의 투자 칸에 없어야 한다.
    expect(html).not.toContain('이미');
  });

  it('확장 단추를 두 번 눌러도 하나만 남고 확장 뒤에는 단추가 없다', async () => {
    const ui = await loadedUi(), button = ui.rendered({ action: 'expand-warehouse' });
    ui.click({ action: 'expand-warehouse' }); vi.advanceTimersByTime(501); ui.clickTarget(button);
    const queue = ui.app.innerHTML.split('<ol class="pending">')[1]!.split('</ol>')[0]!;
    expect(queue.match(/aria-label="창고 확장 빼기"/g)).toHaveLength(1);
    expect(ui.app.innerHTML).not.toContain('data-action="expand-warehouse"');
    ui.click({ action: 'end-day' });
    expect(ui.app.innerHTML).not.toContain('data-action="expand-warehouse"');
  });

  it('선복 계약 줄은 계획의 편수·첫·끝 편을 쓰며 미계약 노선에는 단추가 있다', async () => {
    const ui = await loadedUi(), routeId = cfg.operations!.spaceContract.routeIds[0]!, cmd: EngineCommand = { id: 'SPACE', type: 'SIGN_SPACE_CONTRACT', routeId };
    const plan = planState(fresh(), cfg, [cmd]), c = plan.state.operations!.spaceContracts[0]!;
    expect(ui.app.innerHTML).toContain(`계약 예정: ${c.firstSailingDay}일 편부터 ${c.lastSailingDay}일 편까지 ${c.sailingCount}편`);
    ui.click({ action: 'sign-space-contract', route: routeId });
    expect(ui.app.innerHTML).toContain(`${c.firstSailingDay}일 편부터 ${c.lastSailingDay}일 편까지 ${c.sailingCount}편 계약됨`);
    expect(ui.app.innerHTML).not.toContain(`data-action="sign-space-contract" data-route="${routeId}"`);
    for (const other of cfg.operations!.spaceContract.routeIds.filter((r) => r !== routeId)) expect(ui.app.innerHTML).toContain(`data-action="sign-space-contract" data-route="${other}"`);
    expect(ui.app.innerHTML).toContain('쓰지 않아도 냄, 해지 없음');
    expect(ui.app.innerHTML).toContain('선복 계약');
  });
});

describe('창고 막힘·빈 견적·정리', () => {
  it('창고 처리 대기를 정확히 쓰고 규칙 1 막힘 목록은 바이트로 같다', () => {
    const s = impactState(), q = warehouseSummary(s, cfg), group = bottlenecks(s, cfg).find((g) => g.kind === '창고')!;
    expect(q.handling.waits.length).toBeGreaterThan(0);
    for (const w of q.handling.waits) expect(group.items).toContainEqual({ contractId: w.contractId, textKo: `${w.contractId} 준비 업무가 창고 처리 한도에 걸려 오늘 ${w.gotPt}/${w.wantPt}pt만 진행합니다` });
    expect(bottlenecks(fresh(), cfg).find((g) => g.kind === '창고')!.items).toEqual([]);
    expect(JSON.stringify(bottlenecks(fresh(legacy), legacy))).toBe('[{"kind":"돈","items":[]},{"kind":"시간","items":[]},{"kind":"사람","items":[]},{"kind":"선복","items":[]}]');
    expect(Object.values(BOTTLENECK_OF)).not.toContain('창고');
  });

  it('보관 90% 이상은 경고하고 그 아래는 쓰지 않는다', () => {
    // 반복 묶음마다 실제 수락을 시도해 보관 경고 조건에 도달한 날을 찾는다.
    const publish = cfg.operations!.market.publish;
    let s = fresh();
    for (let day = publish.firstDay; day <= publish.lastDay; day += publish.intervalDays) {
      s = atDay(day);
      if (s.phase === 'ENDED') break;
      for (const offer of [...cfg.offers, ...s.operations!.offers].filter((o) => o.kind === 'forwarding')) {
        const plan = planState(s, cfg, [{ id: `FILL-${offer.id}`, type: 'ACCEPT_FORWARDING', offerId: offer.id }]);
        if (plan.results[0]!.status === 'APPLIED') s = plan.state;
      }
      const storage = warehouseSummary(s, cfg).storage;
      if (storage.usedLiters >= storage.capacityLiters * 0.9) break;
    }
    const q = warehouseSummary(s, cfg);
    expect(q.storage.usedLiters).toBeGreaterThanOrEqual(q.storage.capacityLiters * 0.9);
    expect(bottlenecks(s, cfg).find((g) => g.kind === '창고')!.items).toContainEqual({ contractId: null, textKo: `창고 보관 ${q.storage.usedLiters / 1000}/${q.storage.capacityLiters / 1000} m³ — 새 화물을 받기 어렵습니다` });
    expect(JSON.stringify(bottlenecks(fresh(), cfg))).not.toContain('새 화물을 받기 어렵습니다');
  });

  it('빈 계약의 만료 뒤 다음 공개일을 쓰고 공개가 끝나면 기존 안내를 쓴다', async () => {
    // 시작 견적 만료 다음 날이며 다음 반복 묶음 전이다.
    const day = Math.max(...cfg.offers.map((o) => o.validUntilDay)) + 1, s = atDay(day), ui = await loadedUi(s);
    const p = cfg.operations!.market.publish;
    const nextPublish = Array.from({ length: Math.floor((p.lastDay - p.firstDay) / p.intervalDays) + 1 }, (_, i) => p.firstDay + i * p.intervalDays).find((d) => d > day)!;
    expect(ui.app.innerHTML).toContain(`다음 견적 묶음은 ${nextPublish}일에 나옵니다`);
    expect(ui.app.innerHTML).not.toContain('견적이 만료되었습니다. ‘처음부터’');
    // 환전으로 매일 원화를 보충해 실제 마지막 공개 뒤까지 진행한다.
    let late = fresh();
    while (late.day <= p.lastDay && late.phase !== 'ENDED') late = next(late, [{ id: `FUND-${late.day}`, type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: cfg.operations!.fx.lotUsdMinor }]);
    expect(late.day).toBeGreaterThan(p.lastDay);
    await ui.importText(serializeSave(late));
    expect(ui.app.innerHTML).toContain('견적이 만료되었습니다. ‘처음부터’로 다시 시작할 수 있습니다.');
    expect(ui.app.innerHTML).not.toContain('다음 견적 묶음은');
  });

  it('규칙 2 첫 화면은 이번 표·창고 행·지급 기준 설명을 빼면 정리 전 전체 문자열과 같다', async () => {
    const ui = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await ui.change({ action: 'scenario' }, cfg.id);
    // cf034bb와 비교할 때 지시서가 새로 넣거나 바꾼 부분만 제외한다. 환전·시세표 접근성 속성은 TASK-0058에서 추가한 부분만 제외한다.
    expect(ui.app.innerHTML.match(/<option value="SCENARIO_M2_OPS_CREDIT"[^>]*>[^<]*<\/option>/g)).toHaveLength(1);
    // TASK-0079: 카드 종류 클래스와 '사무실 보기' 단추 두 조각만 걷는다(code-split.test.ts normalizeArtHtml과 같은 규칙).
    const html = ui.app.innerHTML.replace(/ creature-(animal|myth_inspired|none)/g, '').replace(/<button[^>]*data-action="open-office"[^>]*>사무실 보기<\/button>/g, '').replace(/<option value="SCENARIO_M2_OPS_CREDIT"[^>]*>[^<]*<\/option>/g, '').replace(SITUATION_BUTTON, '').replace(/빌드 [^<]+/, '빌드 BASE')
      .replace(/<section class="warehouse"[\s\S]*?(?=<h4>업무 부하)/, '')
      .replace('<li><b>창고</b> 없음</li>', '')
      .replace('<th>미지급(급여·임차료)</th>', '<th>미지급 급여</th>')
      .replace('<h3 id="exchange-h" tabindex="-1">', '<h3 id="exchange-h">')
      .replace('id="market-scroll" tabindex="0" ', '')
      .replace('title="확정 기준" aria-describedby="payment-description"', 'title="대기 중인 명령 반영" aria-describedby="payment-description"')
      .replace('id="payment-description" class="visually-hidden">확정 기준</small>', 'id="payment-description" class="visually-hidden">대기 중인 명령 반영</small>');
    expect(await sha256(html)).toBe('60fd0707fde9953b9201e4c71a243d01f4e7e7a6267b58cf60064b90a36a516d');
  });

  it('초기 환전 상태와 다섯 번째 선택 인자는 기존 네 인자 화면과 같다', () => {
    const initial = initialUiState(), s = fresh();
    expect(initial.exchangeLots).toBe(1); expect(initial).not.toHaveProperty('exchangeUsdMinor');
    const selection = exchangeSelection(s, cfg, initial.exchangeDirection, initial.exchangeLots);
    expect(exchangeBlock(s, cfg, initial.exchangeDirection, initial.exchangeLots, selection)).toBe(exchangeBlock(s, cfg, 'USD_TO_KRW', 1));
  });
});

describe('일정 수령액·지급 상태 기준', () => {
  function latePlanned(config: ScenarioConfig) {
    const initial = fresh(config), pair = openTradePairs(initial, config)[0]!;
    const route = routeBetween(config, offerDef(initial, config, pair.buyOfferId)!.cityId, offerDef(initial, config, pair.sellOfferId)!.cityId)!;
    // 첫 출항 직후에 수락하고 그 다음 편을 예약하여 여러 날 늦는 실제 계약을 만든다.
    const s = atDay(route.firstDepartureDay + 1, {}, config), sailing = listSailings(config, route.id, s.day + 1)[0]!;
    const employee = s.employees.find((e) => e.employmentStatus === 'employed' && e.locationCityId === config.homeCityId)!;
    const plan = planState(s, config, [{ id: 'LATE-TRADE', type: 'ACCEPT_TRADE', ...pair, plan: { employeeId: employee.id, sailingId: sailing.id } }]);
    expect(plan.results[0]!.status).toBe('APPLIED');
    return plan.state;
  }

  it('여러 날 늦는 규칙 2 일정 수령액은 엔진 감액과 같고 규칙 1 일정 출력은 같다', async () => {
    const s = latePlanned(cfg), c = s.contracts[0]!, booking = s.bookings[0]!, route = cfg.routes.find((r) => r.id === booking.routeId)!;
    const delivery = booking.departureDay + route.transitDays + cfg.terms.customsDays;
    expect(delivery - c.deliveryDeadlineDay).toBeGreaterThan(1);
    const receipt = scheduleItems(s, cfg, cfg.campaignDays).find((i) => i.kind === 'RECEIPT' && i.contractId === c.id)!;
    expect(receipt.money!.amountMinor).toBe(c.saleAmountMinor - lateDeliveryReduction(cfg, c.saleAmountMinor, delivery - c.deliveryDeadlineDay));
    const old = latePlanned(legacy), lc = old.contracts[0]!, lb = old.bookings[0]!, lr = legacy.routes.find((r) => r.id === lb.routeId)!;
    const oldReceipt = scheduleItems(old, legacy, legacy.campaignDays).find((i) => i.kind === 'RECEIPT')!;
    expect(oldReceipt.money!.amountMinor).toBe(lc.saleAmountMinor - (lb.departureDay + lr.transitDays + legacy.terms.customsDays > lc.deliveryDeadlineDay ? legacy.terms.lateDeliveryPriceReductionMinor : 0));
    // cf034bb 사본에서 같은 실제 늦은 계약의 규칙 1 일정 HTML 전체를 기록했다.
    const html = scheduleBlock(old, legacy, { open: true, prev: null, link: (id) => id });
    expect(await sha256(html)).toBe('a57180dd46aad7834aa0db32d9f5d3ec9eb2ac90b1017eabaec8a543acc48e04');
  });

  it('감액으로 수령액이 0인 실제 계약에는 수금 행이 없다', () => {
    // 첫 반복 작업 포함 주선은 긴 다음 출항편을 예약하면 상한에 도달한다.
    const p = cfg.operations!.market.publish, s = atDay(p.firstDay + p.intervalDays);
    const offer = s.operations!.offers.find((o) => o.serviceClass === 'HANDLING')!;
    const route = routeBetween(cfg, offer.cityId, offer.destinationCityId!)!, employee = s.employees.find((e) => e.employmentStatus === 'employed')!;
    const sailing = listSailings(cfg, route.id, offer.deliveryDeadlineDay! + Math.ceil(offer.serviceFeeMinor! / cfg.terms.lateDeliveryPriceReductionMinor))[0]!;
    const plan = planState(s, cfg, [{ id: 'ZERO', type: 'ACCEPT_FORWARDING', offerId: offer.id, plan: { employeeId: employee.id, sailingId: sailing.id } }]);
    expect(plan.results[0]!.status).toBe('APPLIED');
    const c = plan.state.contracts[0]!, delivery = sailing.departureDay + route.transitDays + cfg.terms.customsDays;
    expect(lateDeliveryReduction(cfg, c.saleAmountMinor, delivery - c.deliveryDeadlineDay)).toBe(c.saleAmountMinor);
    expect(scheduleItems(plan.state, cfg, cfg.campaignDays).some((i) => i.kind === 'RECEIPT' && i.contractId === c.id)).toBe(false);
  });

  it('정상 단계나 빈 대기열에서는 하루 마감 예측을 호출하지 않는다', () => {
    const s = fresh(), planner = vi.spyOn(engine, 'commitDay');
    operationsTopbar(s, cfg, s, [expand]);
    expect(planner).not.toHaveBeenCalled();
    let warning = s;
    while (paymentDefaultStatus(warning, cfg).level === 'NONE') warning = next(warning);
    planner.mockClear(); operationsTopbar(warning, cfg, warning, []);
    expect(planner).not.toHaveBeenCalled();
    planner.mockImplementationOnce(() => { throw new Error('실행할 수 없는 계획'); });
    expect(operationsTopbar(warning, cfg, warning, [expand])).not.toContain('하루 진행 뒤 예상:');
  });

  it('실패 마감일 환전 대기 중에도 지급 칸은 확정 기준이고 하루 뒤 예상은 회복·실패를 구분한다', async () => {
    let s = fresh();
    while (!paymentDefaultStatus(s, cfg).failsAtCloseToday && s.phase !== 'ENDED') s = next(s);
    const status = paymentDefaultStatus(s, cfg); expect(status.failsAtCloseToday).toBe(true);
    const lots = status.recovery.lotsToClearAll!, fx: EngineCommand = { id: 'SAVE-KRW', type: 'EXCHANGE_CURRENCY', direction: 'USD_TO_KRW', usdAmountMinor: lots * cfg.operations!.fx.lotUsdMinor };
    const view = planState(s, cfg, [fx]).state;
    expect(paymentStatusKo(view, cfg)).toBe(paymentStatusKo(s, cfg));
    const forecast = paymentStatusKo(commitDay(s, cfg, [fx]).state, cfg); expect(forecast).not.toBe('경영 실패');
    const ui = await loadedUi(s);
    // 환전을 빼도 대기열에 선복 명령이 남아 환전 없는 마감 예상을 표시한다.
    ui.click({ action: 'sign-space-contract', route: cfg.operations!.spaceContract.routeIds[0]! });
    await ui.change({ action: 'exchange-amount' }, String(lots)); ui.click({ action: 'exchange' });
    expect(ui.app.innerHTML.split('id="status-h"')[1]!.split('</header>')[0]).toContain(`<span>지급 상태</span><b>${esc(paymentStatusKo(s, cfg))}</b><small id="payment-description" class="visually-hidden">확정 기준</small><small class="payment-forecast">하루 진행 뒤 예상: ${esc(forecast)}</small>`);
    expect(ui.app.innerHTML).toContain('title="확정 기준"');
    expect(ui.app.innerHTML).toContain('지급 상태는 확정 기준이고, 하루 진행 뒤 예상을 따로 보입니다.');
    ui.click({ action: 'unqueue', index: '1' });
    expect(ui.app.innerHTML).toContain('하루 진행 뒤 예상: 경영 실패');
    ui.click({ action: 'unqueue', index: '0' });
    expect(ui.app.innerHTML).not.toContain('하루 진행 뒤 예상:');
    expect(operationsTopbar(fresh(), cfg, fresh(), [fx])).not.toContain('하루 진행 뒤 예상:');
  });
});
