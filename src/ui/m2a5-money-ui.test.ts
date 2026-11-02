import { afterEach, describe, expect, it, vi } from 'vitest';
import acceptance from '../../tests/acceptance_cases.json';
import { loadScenario, OPERATIONS_SCENARIO_IDS, SCENARIO_IDS } from '../content/scenario';
import { listSailings } from '../engine/catalog';
import { commitDay, createGame, openDay, planState } from '../engine/engine';
import { dailyKrwDue, paymentDefaultStatus } from '../engine/operations';
import { hiringOutlook } from '../engine/readers';
import { campaignSummary, companyReport } from '../engine/reports';
import { formatMoney } from '../engine/money';
import { serializeSave } from '../engine/save';
import { runDays, type DayScript } from '../engine/testkit';
import { scriptOf, type OperationCase } from '../engine/m2a5-testkit';
import type { EngineCommand, GameState, ScenarioConfig } from '../engine/types';
import { interviewBlock } from './recruitment';
import { failureBlock, operationsSettlement, paymentAlert } from './money-alerts';
import { krwReportRows, settlementRows } from './reports';
import { operationsTopbar } from './market';
import { constraintLabel } from './warehouse';
import { startUi } from './main-testkit';
import { esc } from './html';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const cfg = loadScenario(OPERATIONS_SCENARIO_IDS[0]), legacy = SCENARIO_IDS.map(loadScenario).find((c) => c.recruitment && c.growth && c.culture)!;
const fresh = (config = cfg) => openDay(createGame(config), config).state;
const next = (s: GameState, commands: EngineCommand[] = [], config = cfg) => openDay(commitDay(s, config, commands).state, config).state;
const loadedUi = async (s: GameState, config = cfg) => {
  const ui = await startUi(config); await (await import('./main-testkit')).screensReady(); await ui.change({ action: 'scenario' }, config.id);
  await ui.importText(serializeSave(s)); return ui;
};
const sha256 = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((n) => n.toString(16).padStart(2, '0')).join('');
const check = { commandId: 'TEST-HIRE', status: 'APPLIED' as const, reasonKo: '처리됨' };
const spaceCommands = (config = cfg): EngineCommand[] => config.operations!.spaceContract.routeIds.map((routeId, i) => ({ id: `TEST-SPACE-${i}`, type: 'SIGN_SPACE_CONTRACT', routeId }));
function interviewState(config = cfg, invest = false) {
  // 발견 전 후보를 첫 현장 조사로 찾고 의뢰를 끝내 면담 단계까지 진행한다.
  let s = next(fresh(config), [{ id: 'TEST-SCOUT', type: 'SCOUT_SITE', venueId: config.recruitment!.scoutSites[0]!.venueId, employeeId: config.employees[1]!.id }, ...(invest ? spaceCommands(config) : [])], config);
  while (!s.recruitment.candidates.some((c) => c.stage === 'DISCOVERED')) s = next(s, [], config);
  const id = s.recruitment.candidates.find((c) => c.stage === 'DISCOVERED')!.employeeId;
  s = next(s, [{ id: 'TEST-QUEST', type: 'START_RECRUIT_QUEST', candidateId: id, employeeId: config.employees[0]!.id }], config);
  while (s.recruitment.candidates.find((c) => c.employeeId === id)!.stage !== 'INTERVIEW_READY') s = next(s, [], config);
  return { s, e: config.employees.find((e) => e.id === id)! };
}
// 환전 없이 매일 실제 마감한다. 첫 미지급·위험·실패 날은 엔진 상태에서 찾는다.
function idleStates(config = cfg, script: DayScript = {}) {
  const days: GameState[] = [fresh(config)];
  while (days.at(-1)!.phase !== 'ENDED') days.push(next(days.at(-1)!, script[days.at(-1)!.day] ?? [], config));
  return { days, warning: days.find((s) => paymentDefaultStatus(s, config).level === 'WARNING')!, danger: days.find((s) => paymentDefaultStatus(s, config).level === 'DANGER')!, beforeFailure: days.at(-2)!, failed: days.at(-1)! };
}
const idle = idleStates();
const completionCase = (acceptance.cases as unknown as OperationCase[]).find((c) => c.expected_numeric?.completed_day && c.expected_numeric?.would_fail_day)!;
const completionScript = scriptOf(completionCase);
// 인수 완료 대본의 첫 명령에 확장과 두 노선 계약을 더한다. 시작 USD를 전부 환전하므로 선복 서명을 먼저 한다.
const investedScript: DayScript = { ...completionScript, 1: [{ id: 'TEST-EXPAND', type: 'EXPAND_WAREHOUSE' }, ...spaceCommands(), ...completionScript[1]!] };
const attemptedInvestment = runDays(createGame(cfg), cfg, cfg.campaignDays, investedScript).state;
// 원래 완료 대본은 시작 USD를 전부 환전해 추가 선복 요금을 못 낸다. 추가 투자 비용만 시작 자금에 더한 설정을 실제 실행해 행 전체를 확인한다.
const investedConfig = structuredClone(cfg);
const signed = planState(fresh(), cfg, spaceCommands()).state.operations!.spaceContracts;
investedConfig.startingCash.USD! += signed.reduce((n, c) => n + c.sailingCount * c.feeMinor, 0);
investedConfig.startingCash.KRW! += cfg.operations!.facility.expansion.setupFeeMinor + Math.ceil(cfg.campaignDays / cfg.operations!.fixedCosts.rent.periodDays) * cfg.operations!.facility.expansion.rentIncreaseMinor;
const invested = runDays(createGame(investedConfig), investedConfig, investedConfig.campaignDays, investedScript).state;
const normalCompleted = runDays(createGame(cfg), cfg, cfg.campaignDays, completionScript).state;
const money = formatMoney;
const labelsAndValues = (html: string) => [...html.matchAll(/<tr[^>]*><th[^>]*>(.*?)<\/th><td>(.*?)<\/td><\/tr>/g)].map((m) => [m[1], m[2]]);
function outlookLines(s: GameState, id: string, config = cfg) {
  const q = hiringOutlook(s, config, id), b = q.bottleneck;
  const names = b.binding.after.map(constraintLabel).join('·');
  return [`이 직원 하루 일급 ${money('KRW', q.wageKrwPerDay)} — 일주일이면 USD 약 ${money('USD', q.wageUsdLotsPerWeek! * config.operations!.fx.lotUsdMinor)} 환전`,
    `최근 4묶음 작업 견적 ${q.recentHandlingOfferedPt}pt / 받은 ${q.recentHandlingAcceptedPt}pt`,
    `작업 포함 주선 1건 기여이익 ${money('USD', b.contributionPerJobMinor)}`,
    `다음 주 받을 수 있는 작업 포함 주선: 지금 ${b.usableBefore}건 → 고용 뒤 ${b.usableAfter}건(가장 좁은 곳: ${names})`,
    ...(b.extraJobsPerWeek === 0 ? [`이 직원을 뽑아도 ${names}에 막혀 더 받을 수 없습니다`] : [])];
}

describe('고용 면담 돈과 병목', () => {
  it('면담 네 줄과 더 받을 수 없음은 엔진 값이며 선복 투자 뒤에는 막힘 문장이 없다', () => {
    for (const invest of [false, true]) {
      const { s, e } = interviewState(cfg, invest), q = hiringOutlook(s, cfg, e.id);
      expect(q.bottleneck.extraJobsPerWeek === 0).toBe(!invest);
      const html = interviewBlock(s, cfg, e, check);
      expect([...html.match(/<ul class="hiring-outlook">(.*?)<\/ul>/s)![1]!.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1])).toEqual(outlookLines(s, e.id));
      expect(html.includes('더 받을 수 없습니다')).toBe(!invest);
    }
  });
  it('선복 계약 대기 화면의 면담은 view와 다른 state를 읽고 고용 대기 중에는 줄을 숨긴다', async () => {
    const ready = interviewState(), e = ready.e;
    let s = ready.s;
    // 선복 서명 뒤 효력이 다음 편에 적용되도록 다음 출항일 시작까지 진행한다.
    const departure = Math.min(...cfg.operations!.spaceContract.routeIds.map((id) => listSailings(cfg, id, s.day)[0]!.departureDay));
    while (s.day < departure) s = next(s);
    const ui = await loadedUi(s);
    ui.click({ action: 'interview', candidate: e.id });
    for (const route of cfg.operations!.spaceContract.routeIds) ui.click({ action: 'sign-space-contract', route });
    const view = planState(s, cfg, spaceCommands()).state;
    expect(outlookLines(view, e.id)).not.toEqual(outlookLines(s, e.id));
    const block = ui.app.innerHTML.split(`id="interview-${e.id}"`)[1]!.split('</article>')[0]!;
    for (const line of outlookLines(s, e.id)) expect(block).toContain(line);
    for (const line of outlookLines(view, e.id).filter((l) => !outlookLines(s, e.id).includes(l))) expect(block).not.toContain(line);
    ui.click({ action: 'hire', candidate: e.id });
    expect(ui.app.innerHTML).not.toContain('hiring-outlook');
    expect(ui.app.innerHTML).not.toContain('이 직원 하루 일급');
  });
  it('규칙 1 면담 칸은 기준 바이트와 같다', async () => {
    const { s, e } = interviewState(legacy);
    expect(await sha256(interviewBlock(s, legacy, e, check))).toBe('58d2c555caa23fde765123ee0956f941c129efabbdabb5207b7282e0041ae0aa');
  });
});

describe('지급 경고와 위험', () => {
  it('첫 미지급 다음 화면에서 원인·나이·마감·회복 행동을 읽고 전날에는 없다', async () => {
    const s = idle.warning, status = paymentDefaultStatus(s, cfg), o = status.oldest!, r = status.recovery;
    expect(s.day).toBe(o.incurredDay + 1);
    expect(paymentAlert(idle.days[idle.days.indexOf(s) - 1]!, cfg)).toBe('');
    const ui = await loadedUi(s), html = ui.app.innerHTML;
    expect(html).toContain('지급 경고');
    expect(html).toContain(`${o.incurredDay}일 ${esc(o.reasonKo)} ${money(o.currency, o.amountMinor)}이 밀렸습니다`);
    expect(html).toContain(`밀린 지 ${status.ageDays}일. ${status.dangerFromDay}일부터 위험, ${status.failAtCloseOfDay}일 마감까지 못 갚으면 경영 실패입니다`);
    expect(r.lotsToSurvive).toBe(0);
    expect(html).toContain('오늘 마감에는 실패하지 않습니다');
    expect(html).not.toContain('최소 USD');
    expect(html).toContain(`밀린 원화를 모두 갚으려면 USD ${money('USD', r.lotsToClearAll! * cfg.operations!.fx.lotUsdMinor)}`);
    expect(html).toContain(money('USD', r.usdAvailableLots * cfg.operations!.fx.lotUsdMinor));
    expect(html).toContain(r.heldSpendingKo!);
    expect(html).toContain('실제로는 임금을 정한 날 지급해야 하며 하루 늦어도 체불입니다');
    expect(html.indexOf('id="report-h"')).toBeLessThan(html.indexOf('id="payment-alert-h"'));
    ui.click({ action: 'skip-to', target: 'exchange-h' });
    expect(ui.focusIds.at(-1)).toBe('exchange-h');
    expect(html).toContain('<h3 id="exchange-h" tabindex="-1">');
  });
  it('위험 단계와 실패 당일 마감 전의 최소 환전액을 구분한다', () => {
    expect(paymentAlert(idle.danger, cfg)).toContain('지급 위험');
    const r = paymentDefaultStatus(idle.beforeFailure, cfg).recovery;
    expect(r.lotsToSurvive).toBeGreaterThan(0);
    expect(paymentAlert(idle.beforeFailure, cfg)).toContain(`오늘 마감에 실패하지 않으려면 최소 USD ${money('USD', r.lotsToSurvive! * cfg.operations!.fx.lotUsdMinor)}`);
    expect(paymentAlert(idle.beforeFailure, cfg)).not.toContain('오늘 마감에는 실패하지 않습니다');
  });
  it('USD 미지급은 환전 묶음 대신 다음 수금과 필요한 원화를 보여 준다', async () => {
    const days = idleStates(cfg, investedScript), status = paymentDefaultStatus(days.warning, cfg), r = status.recovery;
    expect(status.oldest!.currency).toBe('USD'); expect(r.lotsToClearAll).toBeNull();
    const html = paymentAlert(days.warning, cfg);
    expect(html).toContain(`다음 수금: ${r.nextReceipt ? `${r.nextReceipt.day}일 ${money('USD', r.nextReceipt.amountMinor)}` : '없음'}`);
    expect(html).toContain(`원화로 USD를 사려면 ${money('KRW', r.krwToUsdRequiredMinor!)}`);
    expect(html).not.toContain('밀린 원화를 모두 갚으려면');
    expect(failureBlock(days.failed, cfg)).toContain('USD 미지급');
    expect(companyReport(days.failed, cfg).payroll.accountsPayable).toBe(0);
    const ui = await loadedUi(days.failed);
    expect(ui.app.innerHTML).toContain('캠페인이 끝나 더 갚을 수 없습니다. 남은 미지급은 결산에 있습니다.');
    expect(ui.app.innerHTML).not.toContain('환전 칸에서');
  });
  it('단계 변경 낭독을 하루 알림에 붙이고 같은 단계에서는 되풀이하지 않으며 재시작·불러오기로 초기화한다', async () => {
    const ui = await loadedUi(idle.days[idle.days.indexOf(idle.warning) - 1]!);
    ui.click({ action: 'end-day' });
    expect(ui.announcements.at(-1)).toContain('지급 경고 단계가 되었습니다');
    const count = () => ui.announcements.filter((a) => a.includes('지급 경고 단계가 되었습니다')).length;
    const before = count();
    ui.click({ action: 'crew-filter', filter: 'all' }); ui.click({ action: 'end-day' });
    expect(count()).toBe(before);
    await ui.importText(serializeSave(idle.danger));
    expect(ui.announcements.at(-1)).toContain('상태를 불러왔습니다');
    expect(ui.announcements.at(-1)).toContain('지급 위험 단계가 되었습니다');
    ui.click({ action: 'restart' });
    await ui.importText(serializeSave(idle.warning));
    expect(count()).toBe(before + 1);
  });
});

describe('경영 실패 기록과 끝 흐름', () => {
  it('실패일·원인·통화별 값·당시 회복 금액·선택 지출과 약정 목록을 실제 기록대로 표시한다', () => {
    const f = idle.failed.operations!.failure!, html = failureBlock(idle.failed, cfg);
    expect(idle.failed.day).toBe(f.day + 1);
    expect(html).toContain(`<h3 id="failure-h" tabindex="-1">${f.day}일 경영 실패</h3>`);
    expect(html).toContain(`${f.incurredDay}일 ${esc(f.reasonKo)} ${money(f.currency, f.amountMinor)}를 ${cfg.operations!.paymentDefault.failureAgeDays}일 동안 갚지 못했습니다`);
    const lines = [...html.matchAll(/<li>(.*?)<\/li>/g)].map((m) => m[1]);
    expect(lines).toEqual([...f.unpaidByCurrency.map((u) => `미지급 ${u.currency}: ${money(u.currency, u.amountMinor)} · ${u.count}건`),
      ...f.cashByCurrency.map((c) => `현금 ${c.currency}: ${money(c.currency, c.amountMinor)}`),
      ...[f.warningEvent, f.dangerEvent].flatMap((e) => e ? [`${e.day}일 ${e.level === 'WARNING' ? '경고' : '위험'}: 밀린 원화를 모두 갚는 데 USD ${money('USD', e.lotsToClearAll! * cfg.operations!.fx.lotUsdMinor)} 필요, 그때 쓸 수 있던 USD ${money('USD', e.usdAvailableMinor)}`] : [])]);
    expect(html).not.toContain('합계');
    expect(html).toContain(`첫 미지급 전 ${cfg.operations!.paymentDefault.failureAgeDays}일 동안의 원화 선택 지출</h4><p>없음</p>`);
    expect(html).toContain('미지급 뒤 새로 묶은 USD 약정</h4><p>없음</p>');
    expect(html).toContain('같은 시드로 다시 하기'); expect(html).toContain('결산 보기');
    for (const s of [fresh(), idle.warning, idle.danger, normalCompleted]) expect(failureBlock(s, cfg)).toBe('');
  });
  it('목록이 있는 실패 기록도 실제 선택 지출·선복 약정으로 만든다', () => {
    const base = idle.warning.operations!.defaultEvents[0]!, day = base.incurredDay - 2;
    const cmds: DayScript = { [day]: [{ id: 'LATE-EXPAND', type: 'EXPAND_WAREHOUSE' }], [base.incurredDay + 1]: spaceCommands() };
    const failed = runDays(createGame(cfg), cfg, cfg.campaignDays, cmds).state, f = failed.operations!.failure!;
    expect(f.optionalKrwSpendBeforeFirstUnpaid.length).toBeGreaterThan(0);
    expect(f.usdCommitmentsSinceIncurred.length).toBeGreaterThan(0);
    const html = failureBlock(failed, cfg);
    for (const e of f.optionalKrwSpendBeforeFirstUnpaid) expect(html).toContain(`${e.day}일 ${esc(e.reasonKo)} ${money('KRW', e.amountMinor)}`);
    for (const c of f.usdCommitmentsSinceIncurred) expect(html).toContain(`${c.day}일 선복 계약 ${c.id} ${money('USD', c.amountMinor)}`);
  });
  it('실패 하루 진행 뒤 실패일 알림·초점·마감 결산과 다시 시작 확인을 연결한다', async () => {
    const ui = await loadedUi(idle.beforeFailure), f = idle.failed.operations!.failure!;
    ui.click({ action: 'end-day' });
    expect(ui.announcements.at(-1)).toContain(`${f.day}일 경영 실패로 캠페인이 끝났습니다. 경영 보고에서 원인과 결산을 확인하세요.`);
    expect(ui.announcements.at(-1)).not.toContain(`${cfg.campaignDays}일 캠페인이 끝났습니다`);
    expect(ui.focusIds.at(-1)).toBe('failure-h');
    expect(ui.app.innerHTML).toContain(`${f.day}일 마감 결산</h3>`);
    expect(ui.app.innerHTML.indexOf('id="failure-h"')).toBeLessThan(ui.app.innerHTML.indexOf('id="settlement-h"'));
    ui.click({ action: 'skip-to', target: 'settlement-h' }); expect(ui.focusIds.at(-1)).toBe('settlement-h');
    vi.mocked(confirm).mockReturnValueOnce(false); ui.click({ action: 'restart' }); expect(ui.app.innerHTML).toContain('id="failure-h"');
    ui.click({ action: 'restart' }); expect(ui.app.innerHTML).not.toContain('id="failure-h"');
    const initial = await startUi(cfg); await (await import('./main-testkit')).screensReady(); await initial.change({ action: 'scenario' }, cfg.id);
    expect(ui.app.innerHTML).toBe(initial.app.innerHTML);
  });
  it('다른 시드 저장에서 실패해도 같은 시드로 다시 시작한다', async () => {
    const otherConfig = { ...cfg, seed: completionCase.test_fixture.other_seed as number };
    const failed = idleStates(otherConfig).failed;
    const ui = await loadedUi(failed); ui.click({ action: 'restart' });
    const restarted = ui.app.innerHTML;
    const other = await startUi(otherConfig); await (await import('./main-testkit')).screensReady(); await other.change({ action: 'scenario' }, cfg.id);
    expect(restarted).toBe(other.app.innerHTML);
  });
  it('규칙 2 완료 끝 화면의 알림·초점·결산 제목은 기존 문장 그대로다', async () => {
    const before = openDay(runDays(createGame(cfg), cfg, cfg.campaignDays - 1, completionScript).state, cfg).state;
    const ui = await loadedUi(before); ui.click({ action: 'end-day' });
    expect(ui.announcements.at(-1)).toBe(`${cfg.campaignDays}일 캠페인이 끝났습니다. 경영 보고의 ${cfg.campaignDays}일 결산에서 통화별 결과를 확인하세요.`);
    expect(ui.focusIds.at(-1)).toBe('settlement-h');
    expect(ui.app.innerHTML).toContain(`${cfg.campaignDays}일 결산</h3>`);
  });
});

describe('결산과 원화 장부', () => {
  it('환전·확장·선복 계약 상태의 결산 행 전체와 고정비를 통화마다 비교한다', async () => {
    expect(attemptedInvestment.operations!.outcome).toBe('FAILED');
    expect(invested.operations!.outcome).toBe('COMPLETED');
    const sum = campaignSummary(invested, investedConfig);
    expect(invested.phase).toBe('ENDED');
    const ui = await loadedUi(invested, investedConfig), html = ui.app.innerHTML;
    const block = html.split('class="settlement"')[1]!.split('<p>계약 ')[0]!;
    expect([...block.matchAll(/<caption>(.*?)<\/caption>/g)].map((m) => m[1])).toEqual([...sum.operations!.fixedCostsByCurrency.map((c) => `고정비 · ${c.currency}`), '환전 기록', ...sum.byCurrency.map((c) => `결산 · ${c.currency}`)]);
    expect(block).toContain(sum.operations!.outcome === 'FAILED' ? `결과: 경영 실패(${sum.operations!.failure!.day}일)` : '결과: 완료');
    for (const c of sum.operations!.fixedCostsByCurrency) {
      const used: [string, number][] = [['임차료', c.rentExpense], ['확장 설치비', c.facilitySetupExpense], ['선복 요금', c.spaceContractExpense], ['환전 차감', c.fxSpreadExpense]];
      expect(c.rentExpense + c.facilitySetupExpense + c.spaceContractExpense + c.fxSpreadExpense).toBeGreaterThan(0);
      const table = block.split(`<caption>고정비 · ${c.currency}</caption>`)[1]!.split('</table>')[0]!;
      expect(labelsAndValues(table)).toEqual(used.filter(([, n]) => n !== 0).map(([l, n]) => [l, money(c.currency, n)]));
    }
    for (const c of sum.byCurrency) {
      const expected: [string, number, boolean][] = [['현금', c.cash, false]];
      for (const [l, n] of [['재고', c.inventory], ['선급운임', c.prepaidFreight], ['주선 진행원가', c.forwardingWip], ['매출채권', c.accountsReceivable]] as [string, number][]) if (c.currency === cfg.tradeCurrency || n !== 0) expected.push([l, n, false]);
      expected.push(['자산 합계', c.totalAssets, true], ['미지급금', c.accountsPayable, false], ['순자산 (자산 − 미지급금)', c.netAssets, true], ['시작 자본', c.openingEquity, false], ['손익', c.profit, false]);
      if (c.currency === cfg.tradeCurrency || c.contractContribution !== 0) expected.push(['계약 기여이익 합계', c.contractContribution, false]);
      if (c.currencyTransferNet !== 0) expected.push(['통화 간 이체(환전)', c.currencyTransferNet, false]);
      expect(settlementRows(c, cfg)).toEqual(expected);
      expect(labelsAndValues(block.split(`<caption>결산 · ${c.currency}</caption>`)[1]!.split('</table>')[0]!)).toEqual(expected.map(([l, n]) => [l, money(c.currency, n)]));
    }
    const xs = sum.operations!.exchanges;
    const table = block.split('<caption>환전 기록</caption>')[1]!.split('</table>')[0]!;
    expect([...table.matchAll(/<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g)].map((m) => m.slice(1))).toEqual(xs.map((e) => [`${e.day}일`, e.direction === 'USD_TO_KRW' ? 'USD→KRW' : 'KRW→USD', money('USD', e.usdMinor), money('KRW', e.krwMinor), money('KRW', e.spreadKrwMinor)]));
  });
  it('0인 고정비·이체 행은 없고 모두 0인 통화는 고정비 없음이다', () => {
    const sum = campaignSummary(normalCompleted, cfg), html = operationsSettlement(sum);
    expect(html).toContain('USD 고정비 없음'); expect(html).not.toContain('확장 설치비'); expect(html).not.toContain('선복 요금');
    for (const c of campaignSummary(idle.failed, cfg).byCurrency) expect(settlementRows(c, cfg).map(([l]) => l)).not.toContain('통화 간 이체(환전)');
    expect(krwReportRows(companyReport(idle.failed, cfg), cfg)).not.toContain('통화 간 이체(환전)');
    expect(krwReportRows(companyReport(idle.failed, cfg), cfg)).not.toContain('환전 차감');
  });
  it('원화 행 전체와 표시 값만으로 시작 자금·비용·이체 = 현금−미지급 항등식이 맞다', () => {
    for (const s of [invested, normalCompleted, idle.failed]) {
      const report = companyReport(s, cfg), p = report.payroll;
      const expected: [string, number][] = [['시작 운영 자금', p.openingEquity], ['급여', -p.wageExpense], ['영입 계약금', -p.recruitmentExpense], ['훈련비', -p.trainingExpense], ['현지 활동비', -p.cultureExpense],
        ...([['창고 임차료', -p.rentExpense], ['창고 확장 설치비', -p.facilitySetupExpense], ['환전 차감', -p.fxSpreadExpense], ['통화 간 이체(환전)', p.currencyTransferNet]] as [string, number][]).filter(([, n]) => n !== 0), ['운영 손익', p.profit], ['미지급(급여·임차료)', p.accountsPayable], ['현금', p.cash]];
      const rows = labelsAndValues(krwReportRows(report, cfg));
      expect(rows).toEqual(expected.map(([l, n]) => [l, money('KRW', n)]));
      const numeric = new Map(rows.map(([l, text]) => [l, Number(text!.replaceAll(',', '').replace('원', '').replace('−', '-'))]));
      const left = rows.slice(0, rows.findIndex(([l]) => l === '운영 손익')).reduce((n, [l]) => n + numeric.get(l)!, 0);
      expect(left).toBe(numeric.get('현금')! - numeric.get('미지급(급여·임차료)')!);
    }
  });
  it('규칙 1 결산·원화 보고는 기준 바이트와 같다', async () => {
    const s = runDays(createGame(legacy), legacy, legacy.campaignDays).state, ui = await loadedUi(s, legacy);
    const settlement = ui.app.innerHTML.match(/<div class="settlement">[\s\S]*?<\/details><\/div>/)![0];
    expect(await sha256(settlement)).toBe('7d13ed3a34ae75dc316dd687404f89beb1471d2743ec83a31afd8b912f279056');
    expect(await sha256(krwReportRows(companyReport(s, legacy), legacy))).toBe('5389a0b9965ed16d8dce36509f3cb94526d8a80c1becc9551b4378d3c0792851');
  });
});

describe('종료 화면과 견적 유효기간', () => {
  it('정상 종료·미지급 막대는 종료 결과를 쓰고 환전·권유를 숨기며 남은 미지급은 그대로다', async () => {
    // 지시된 28묶음은 조정값을 박지 않고 완료 인수 대본 30묶음에서 두 묶음을 뺀다.
    const first = completionScript[1]!.find((c) => c.type === 'EXCHANGE_CURRENCY')!;
    if (first.type !== 'EXCHANGE_CURRENCY') throw new Error('완료 인수 대본에 환전 없음');
    const s = runDays(createGame(cfg), cfg, cfg.campaignDays, { 1: [{ ...first, usdAmountMinor: first.usdAmountMinor - 2 * cfg.operations!.fx.lotUsdMinor }] }).state;
    expect(s.operations!.outcome).toBe('COMPLETED');
    expect(companyReport(s, cfg).payroll.accountsPayable).toBeGreaterThan(0);
    const ui = await loadedUi(s), html = ui.app.innerHTML;
    expect(html.split('id="status-h"')[1]!.split('</header>')[0]).toContain('<span>원화 급여 가능일</span><b>캠페인 종료</b>');
    expect(html).toContain('종료 · 남은 미지급 있음(결산 참고)');
    expect(html).not.toContain('실패까지'); expect(html).not.toContain('하루 진행 뒤 예상:');
    expect(html).not.toContain('id="exchange-h"'); expect(html).not.toContain('환전 칸에서');
    expect(html).toContain('캠페인이 끝나 더 갚을 수 없습니다. 남은 미지급은 결산에 있습니다.');
    expect(html).toContain('남은 미지급 KRW:');
    expect(paymentAlert(s, cfg)).toBe('');
    expect(paymentAlert(openDay(runDays(createGame(cfg), cfg, cfg.campaignDays - 1, { 1: [{ ...first, usdAmountMinor: first.usdAmountMinor - 2 * cfg.operations!.fx.lotUsdMinor }] }).state, cfg).state, cfg)).toContain('캠페인이 끝날 때까지 못 갚으면 미지급을 남기고 끝납니다');
  });
  it('지급 정상으로 끝나면 종료 · 지급 정상이고 진행 중 환전 권유는 남는다', async () => {
    const cfgCopy = structuredClone(cfg);
    cfgCopy.startingCash.KRW = cfgCopy.campaignDays * dailyKrwDue(fresh(cfgCopy), cfgCopy, 1);
    const ended = runDays(createGame(cfgCopy), cfgCopy, cfgCopy.campaignDays).state;
    expect(companyReport(ended, cfgCopy).payroll.accountsPayable).toBe(0);
    expect(operationsTopbar(ended, cfgCopy)).toContain('종료 · 지급 정상');
    const ui = await loadedUi(idle.warning); expect(ui.app.innerHTML).toContain('환전 칸에서'); expect(ui.app.innerHTML).toContain('id="exchange-h"');
  });
  it('실패 종료에는 견적 카드·수량·환전이 없고 시세표·오늘 할 일은 종료 문구다', async () => {
    const ui = await loadedUi(idle.failed), html = ui.app.innerHTML, f = idle.failed.operations!.failure!;
    expect(html).not.toContain('<article class="offer'); expect(html).not.toContain('data-action="offer-quantity"'); expect(html).not.toContain('id="exchange-h"');
    expect(html).toContain('캠페인이 끝나 견적을 받을 수 없습니다'); expect(html).toContain('없음(캠페인 종료)');
    expect(html).toContain(`오늘 할 일 <small>${f.day}일 · 경영 실패</small>`);
    expect(html).not.toContain('실패까지');
    // 실제 표시 버튼이 사라진 뒤 들어온 오래된 클릭도 종료 거절 문장을 쓴다.
    ui.clickTarget({ dataset: { action: 'exchange' }, closest: (selector: string) => selector === '[data-action]' ? { dataset: { action: 'exchange' }, closest: () => null } : null });
    expect(ui.app.innerHTML).toContain('경영 실패로 캠페인이 끝나 새 명령을 넣을 수 없습니다');
    await ui.importText(serializeSave(normalCompleted));
    expect(ui.app.innerHTML).toContain(`${cfg.campaignDays}일 · 캠페인 종료`);
  });
  it('주선 견적 유효기간은 실패로 만료가 멈춘 기록에서도 화면에서 거른다', async () => {
    // 검수 재현의 시작 자금 사본을 일급 합과 임차료로 구성해 마지막 유효일 마감에 실패시키는 설정을 찾는다.
    // 종료 분기와 별도로 거름을 검증하기 위해 phase는 고치지 않고 열린 날의 실제 저장을 재개한다.
    const cfgCopy = structuredClone(cfg), publish = cfgCopy.operations!.market.publish;
    const expiryDay = publish.firstDay + publish.intervalDays * 7 + publish.validDays - 1;
    const firstUnpaid = expiryDay - cfgCopy.operations!.paymentDefault.failureAgeDays;
    const wage = cfgCopy.employees.filter((e) => fresh(cfgCopy).employees.some((s) => s.id === e.id && s.employmentStatus === 'employed')).reduce((n, e) => n + e.salaryPerDayMinor, 0);
    const rent = cfgCopy.operations!.fixedCosts.rent;
    cfgCopy.startingCash.KRW = (firstUnpaid - 1) * wage + Math.ceil((firstUnpaid - 1) / rent.periodDays) * rent.amountMinor;
    const run = idleStates(cfgCopy), f = run.failed.operations!.failure!;
    const expired = [...cfgCopy.offers, ...run.failed.operations!.offers].filter((o) => o.kind === 'forwarding' && o.validUntilDay === f.day && run.failed.offers.some((s) => s.id === o.id && s.status === 'OPEN'));
    expect(expired.length).toBeGreaterThan(0);
    const ui = await loadedUi(run.beforeFailure, cfgCopy);
    expect(ui.app.innerHTML).toContain('<article class="offer forwarding"');
    const { visibleForwardingOffers } = await import('./main');
    expect(visibleForwardingOffers(run.failed, cfgCopy)).toEqual([]);
    expect(visibleForwardingOffers(run.beforeFailure, cfgCopy).length).toBeGreaterThan(0);
    ui.click({ action: 'end-day' });
    for (const o of expired) expect(ui.app.innerHTML).not.toContain(`data-offer="${o.id}"`);
    expect(ui.app.innerHTML).not.toContain(`견적 유효: ${f.day}일까지`);
  });
});
