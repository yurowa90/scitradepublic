import { describe, expect, it } from 'vitest';
import { loadScenario } from '../content/scenario';
import { cityName, listSailings, routeBetween } from '../engine/catalog';
import { commitDay, createGame, openDay, planState } from '../engine/engine';
import { isAvailableFromToday } from '../engine/employees';
import { formatMoney } from '../engine/money';
import { fundsPosition } from '../engine/reservations';
import { taskSubjectKo } from '../engine/tasks';
import { tradePairs, upcomingPayments } from '../engine/reports';
import { acceptAllFeasible, runDays, runToCampaignEnd } from '../engine/testkit';
import type { Command, GameState, ScenarioConfig } from '../engine/types';
import { esc } from './html';
import { scheduleBlock, scheduleItems, scheduleKeys, scheduleWindow } from './schedule';

const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const trainingConfig = () => {
  const cfg = structuredClone(config);
  cfg.growth!.ordinaryTraining.durationDays = 3;
  return cfg;
};
const opened = (cfg = config) => openDay(createGame(cfg), cfg).state;
const atDay = (cfg: ScenarioConfig, day: number, commands: Command[]) =>
  openDay(runDays(opened(cfg), cfg, day - 1, { 1: commands }).state, cfg).state;
const block = (s: GameState, cfg = config, prev: Record<string, number | null> | null = null) =>
  scheduleBlock(s, cfg, { open: true, prev, link: esc });
function lateCommands(cfg: ScenarioConfig): Command[] {
  const start = opened(cfg), pair = tradePairs(cfg)[0]!;
  const accept: Command = { id: 'LATE', type: 'ACCEPT_TRADE', ...pair };
  const c = planState(start, cfg, [accept]).state.contracts[0]!;
  const route = routeBetween(cfg, c.originCityId, c.destinationCityId)!;
  const sailing = listSailings(cfg, route.id, start.day + 1)
    .find((s) => s.scheduledArrivalDay + cfg.terms.customsDays > c.deliveryDeadlineDay)!;
  return [{ ...accept, plan: { employeeId: cfg.employees[0]!.id, sailingId: sailing.id } }];
}

describe('일정 읽기와 엔진 실행 비교', () => {
  it('규칙 1 첫 수락의 운임·관세 일정 문구와 금액 전체', () => {
    const pair = tradePairs(config)[0]!;
    const s = planState(opened(), config, [{ id: 'LEGACY-SCHEDULE', type: 'ACCEPT_TRADE', ...pair }]).state;
    const rows = scheduleItems(s, config, config.campaignDays).filter((r) => r.key.startsWith('PAY:FREIGHT:') || r.key.startsWith('PAY:DUTY:'));
    expect(rows.map(({ kind, day, textKo, money }) => ({ kind, day, textKo, money }))).toEqual([
      { kind: 'PAYMENT', day: 1, textKo: '운송편 예약 마감 · 운임 선지급', money: { currency: 'USD', amountMinor: -20000 } },
      { kind: 'PAYMENT', day: null, textKo: '수입 관세', money: { currency: 'USD', amountMinor: -5000 } },
    ]);
  });

  it.each([0, 1])('예정일 = 엔진 실제 값 (통관 %s일)', (customsDays) => {
    const cfg = trainingConfig(); cfg.terms.customsDays = customsDays;
    const start = opened(cfg), commands = acceptAllFeasible(start, cfg);
    const planned = planState(start, cfg, commands).state;
    const items = scheduleItems(planned, cfg, cfg.campaignDays);
    const end = runToCampaignEnd(start, cfg, { [start.day]: commands }).state;
    for (const kind of ['TASK_DONE', 'DEPARTURE', 'ARRIVAL', 'DEADLINE', 'RECEIPT', 'PAYMENT']) {
      expect(items.some((i) => i.kind === kind)).toBe(true);
    }
    expect(items.some((i) => i.kind === 'DELIVERY')).toBe(customsDays > 0);
    for (const i of items) {
      const contract = end.contracts.find((c) => c.id === i.contractId);
      switch (i.kind) {
        case 'TASK_DONE': expect(i.day).toBe(end.tasks.find((t) => `TASK:${t.id}` === i.key)!.completedDay); break;
        case 'DEPARTURE': expect(i.day).toBe(end.shipments.find((sh) => `DEP:${sh.bookingId}` === i.key)!.departureDay); break;
        case 'ARRIVAL':
          expect(i.day).toBe(end.shipments.find((sh) => sh.contractId === i.contractId)!.arrivalDay);
          expect(i.textKo).toBe(`${customsDays === 0 ? '도착·인도' : '도착'} — ${cityName(cfg, contract!.destinationCityId)}`);
          break;
        case 'DELIVERY': expect(i.day).toBe(contract!.deliveredDay); break;
        case 'DEADLINE': expect(i.day).toBe(contract!.deliveryDeadlineDay); break;
        case 'RECEIPT':
          expect(i.day).toBe(contract!.completedDay);
          expect(i.money).toEqual({ currency: contract!.currency, amountMinor: end.invoices.find((inv) => inv.contractId === i.contractId)!.amountMinor });
          break;
      }
    }
  });
  it('반출일이 지난 화물은 오늘 인도하고 계약일과 오늘 중 늦은 날 수금한다', () => {
    const cfg = trainingConfig(); cfg.terms.customsDays = 1;
    const commands = acceptAllFeasible(opened(cfg), cfg);
    const end = runToCampaignEnd(opened(cfg), cfg, { 1: commands }).state;
    const actual = end.shipments[0]!;
    const s = structuredClone(atDay(cfg, actual.arrivalDay! + 1, commands));
    const sh = s.shipments.find((sh) => sh.contractId === actual.contractId)!;
    sh.releaseDay = s.day - 1;
    const c = s.contracts.find((c) => c.id === sh.contractId)!;
    const items = scheduleItems(s, cfg, cfg.campaignDays);
    expect(items.find((i) => i.key === `DLV:${c.id}`)!.day).toBe(s.day);
    expect(items.find((i) => i.key === `RCV:${c.id}`)!.day).toBe(Math.max(c.paymentDueDay, s.day));
    expect(commitDay(s, cfg, []).state.contracts.find((x) => x.id === c.id)!.deliveredDay).toBe(s.day);
    sh.dutyPaid = false;
    expect(scheduleItems(s, cfg).find((i) => i.key === `DLV:${c.id}`)!.day).toBeNull();
    expect(scheduleItems(s, cfg).some((i) => i.key === `RCV:${c.id}`)).toBe(false);
  });
  it('일수 업무는 시작 날과 이튿날 모두 실제 훈련 완료일과 같다', () => {
    const cfg = trainingConfig();
    const commands: Command[] = [{ id: 'TRAIN', type: 'START_TRAINING', employeeId: cfg.employees[0]!.id }];
    const end = runToCampaignEnd(opened(cfg), cfg, { 1: commands }).state;
    for (const s of [planState(opened(cfg), cfg, commands).state, atDay(cfg, opened(cfg).day + 1, commands)]) {
      const item = scheduleItems(s, cfg).find((i) => i.kind === 'TASK_DONE')!;
      expect(item.day).toBe(end.tasks[0]!.completedDay);
      expect(item.textKo).toBe(`일반 훈련 완료 — ${cfg.employees[0]!.nameKo}`);
    }
  });
  it('급여 줄 압축은 첫날과 직원·금액이 바뀐 날만 남긴다', () => {
    const s = structuredClone(opened());
    const candidate = s.employees.find((e) => e.id === config.recruitment!.candidateEmployeeIds[0])!;
    candidate.employmentStatus = 'employed'; candidate.availableFromDay = s.day + 2;
    const rows = upcomingPayments(s, config).filter((r) => r.kind === 'WAGE');
    const items = scheduleItems(s, config).filter((i) => i.key.startsWith('PAY:WAGE:'));
    const first = rows.find((r) => r.day === s.day)!, changed = rows.find((r) => r.day === candidate.availableFromDay)!;
    expect(items.map((i) => ({ day: i.day, textKo: i.textKo, money: i.money }))).toEqual([
      { day: first.day, textKo: `${first.labelKo} (매일)`, money: { currency: first.currency, amountMinor: -first.amountMinor } },
      { day: changed.day, textKo: `${changed.labelKo}로 바뀜`, money: { currency: changed.currency, amountMinor: -changed.amountMinor } },
    ]);
  });
  it('지난 날짜·날짜 미정과 미지급 묶음은 날짜순으로 앞뒤에 둔다', () => {
    const cfg = structuredClone(config);
    cfg.startingCash[cfg.payrollCurrency] = cfg.employees.filter((e) => isAvailableFromToday(opened(cfg), e.id))
      .reduce((sum, e) => sum + e.salaryPerDayMinor, 0) - 1;
    for (const last of [opened(cfg).day, opened(cfg).day + 1]) {
      const s = openDay(runDays(opened(cfg), cfg, last).state, cfg).state;
      const unpaid = s.obligations.filter((o) => o.paidDay === null && o.currency === cfg.payrollCurrency);
      if (last > opened(cfg).day) expect(unpaid.length).toBeGreaterThanOrEqual(2);
      const items = scheduleItems(s, cfg);
      const overdue = items.filter((i) => i.key.startsWith('PAY:OVERDUE:') && i.money!.currency === cfg.payrollCurrency);
      const first = Math.min(...unpaid.map((o) => o.incurredDay));
      expect(overdue).toHaveLength(1);
      expect(overdue[0]).toEqual(expect.objectContaining({ day: first,
        textKo: `밀린 지급 ${unpaid.length}건 (${first}일부터, 현금이 들어오면 먼저 갚음)`,
        money: { currency: cfg.payrollCurrency, amountMinor: -fundsPosition(s, cfg, cfg.payrollCurrency).unpaidObligations } }));
      expect(items[0]).toBe(overdue[0]);
    }
    const accepted = planState(opened(), config, [{ id: 'NO-BOOK', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }]).state;
    const undated = scheduleItems(accepted, config).filter((i) => i.day === null);
    expect(undated.length).toBeGreaterThan(0);
    expect(scheduleItems(accepted, config).slice(-undated.length)).toEqual(undated);
    expect(block(accepted)).toContain('<b>날짜 미정</b>');
    const cmds = lateCommands(config), c = planState(opened(), config, cmds).state.contracts[0]!;
    const past = atDay(config, c.deliveryDeadlineDay + 1, cmds);
    const deadline = scheduleItems(past, config)[0]!;
    expect(deadline).toMatchObject({ key: `DUE:${c.id}`, day: c.deliveryDeadlineDay, textKo: `납기 지남 (${c.deliveryDeadlineDay}일)` });
    expect(block(past)).toContain('<b>지난 날짜</b>');
  });
  it('늦은 편과 감액은 실제 청구서 금액과 같다', () => {
    const cmds = lateCommands(config), planned = planState(opened(), config, cmds).state;
    const receipt = scheduleItems(planned, config, config.campaignDays).find((i) => i.kind === 'RECEIPT')!;
    const end = runToCampaignEnd(opened(), config, { 1: cmds }).state;
    expect(receipt.day).toBe(end.contracts[0]!.completedDay);
    expect(receipt.money!.amountMinor).toBe(end.invoices[0]!.amountMinor);
    expect(end.contracts[0]!.priceReductionMinor).toBe(config.terms.lateDeliveryPriceReductionMinor);
  });
  it('새 일정·날짜 바뀜은 캠페인 전체 일정과 비교하고 급여 날짜 이동을 제외한다', () => {
    const cfg = trainingConfig(), cmds = acceptAllFeasible(opened(cfg), cfg);
    const planned = planState(opened(cfg), cfg, cmds).state;
    expect((block(planned, cfg, {}).match(/>새 일정</g) ?? []).length).toBe(scheduleItems(planned, cfg).length);
    expect(block(planned, cfg, scheduleKeys(planned, cfg))).not.toContain('>새 일정<');
    expect(block(planned, cfg, scheduleKeys(planned, cfg))).not.toContain('날짜 바뀜');
    const actual = runToCampaignEnd(opened(cfg), cfg, { 1: cmds }).state.shipments[0]!;
    const arrival = actual.arrivalDay!;
    const c = planned.contracts.find((c) => c.id === actual.contractId)!;
    cfg.portRestrictions = [{ eventInstanceId: 'SYNTH-WAIT', templateId: 'SYNTH', cityId: c.destinationCityId,
      announceDay: 1, startDay: arrival, endDay: arrival, forecastKo: '시험용 가상 공지' }];
    const before = atDay(cfg, arrival, cmds), prev = scheduleKeys(before, cfg);
    const after = openDay(commitDay(before, cfg, []).state, cfg).state;
    const html = block(after, cfg, prev);
    const line = html.split('<li>').find((line) => line.startsWith(`${esc(c.id)} 도착·인도`))!.split('</li>')[0]!;
    expect(line).toContain(`<span class="tag">날짜 바뀜 (원래 ${arrival}일)</span>`);
    for (const item of scheduleItems(after, cfg).filter((i) => i.key.startsWith('PAY:WAGE:'))) {
      const wageLine = html.split(`<li>${item.textKo}`)[1]!.split('</li>')[0]!;
      expect(wageLine).not.toContain('날짜 바뀜');
    }
    const all = scheduleItems(planned, cfg, cfg.campaignDays), window = scheduleWindow(planned, cfg);
    const later = all.filter((i) => i.day !== null && i.day > window.to);
    expect(block(planned, cfg)).toContain(`그 뒤 일정 ${later.length}건 — 가장 가까운 날은 ${Math.min(...later.map((i) => i.day!))}일입니다.`);
  });
  it('끝난 캠페인은 밀린 지급만 통화마다 하나로 읽는다', () => {
    const s = runToCampaignEnd(opened(), config).state, items = scheduleItems(s, config);
    const currencies = [...new Set(s.obligations.filter((o) => o.paidDay === null).map((o) => o.currency))];
    expect(items.map((i) => i.key).sort()).toEqual(currencies.map((c) => `PAY:OVERDUE:${c}`).sort());
    expect(items.every((i) => i.kind === 'PAYMENT')).toBe(true);
  });
  it('순수성·통화와 이스케이프를 보존한다', () => {
    const cfg = trainingConfig();
    const bad = '<img src=x onerror=alert(1)>';
    cfg.employees.forEach((e) => { e.nameKo = bad; }); cfg.cities.forEach((c) => { c.nameKo = bad; });
    const s = planState(opened(cfg), cfg, acceptAllFeasible(opened(cfg), cfg)).state;
    const before = structuredClone({ s, cfg });
    const items = scheduleItems(s, cfg, cfg.campaignDays), html = block(s, cfg);
    expect(html).not.toContain(bad); expect(html).toContain(esc(bad));
    for (const item of items) if (item.money) {
      expect(typeof item.money.currency).toBe('string'); expect(Number.isInteger(item.money.amountMinor)).toBe(true);
      const moneyLine = block(s, cfg).split('<li>').find((line) => line.startsWith(`${item.contractId ? esc(item.contractId) + ' ' : ''}${esc(item.textKo)}`));
      if (moneyLine) expect(moneyLine.split('</li>')[0]).not.toMatch(/USD.*원|원.*USD/);
    }
    expect({ s, cfg }).toEqual(before);
  });
});

describe('일정 표시 경계', () => {
  it('미수 청구서는 정해진 수금일과 금액을 예상 표시 없이 읽는다', () => {
    const cfg = structuredClone(config); cfg.terms.paymentDueDay = cfg.campaignDays;
    const start = opened(cfg), cmds = acceptAllFeasible(start, cfg), end = runToCampaignEnd(start, cfg, { 1: cmds }).state;
    const s = atDay(cfg, end.contracts[0]!.deliveredDay! + 1, cmds);
    const invoices = s.invoices.filter((i) => i.status !== 'PAID'); expect(invoices.length).toBeGreaterThan(0);
    for (const invoice of invoices) expect(scheduleItems(s, cfg, cfg.campaignDays)).toContainEqual({ key: `RCV:${invoice.contractId}`,
      kind: 'RECEIPT', day: invoice.dueDay, contractId: invoice.contractId, textKo: '수금', estimate: false,
      money: { currency: invoice.currency, amountMinor: invoice.amountMinor } });
  });
  it('같은 날은 종류·키 순서이고 창 밖에서 들어온 일정은 새 일정이 아니다', () => {
    const cfg = trainingConfig(), commands = acceptAllFeasible(opened(cfg), cfg);
    const s = planState(opened(cfg), cfg, commands).state, all = scheduleItems(s, cfg, cfg.campaignDays);
    const kinds = ['TASK_DONE', 'DEPARTURE', 'ARRIVAL', 'DELIVERY', 'DEADLINE', 'RECEIPT', 'PAYMENT'];
    const expected = [...all].sort((a, b) => (a.day ?? Infinity) - (b.day ?? Infinity)
      || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    expect(all).toEqual(expected);
    const before = scheduleKeys(s, cfg), to = scheduleWindow(s, cfg).to;
    const outside = all.find((i) => i.day !== null && i.day > to && !i.key.startsWith('PAY:'))!;
    const after = atDay(cfg, outside.day! - 6, commands);
    const html = block(after, cfg, before);
    const line = html.split('<li>').find((line) => line.startsWith(`${outside.contractId ? esc(outside.contractId) + ' ' : ''}${esc(outside.textKo)}`))!;
    expect(line.split('</li>')[0]).not.toContain('새 일정');
    const emptyCfg = structuredClone(config); emptyCfg.employees.forEach((e) => { e.salaryPerDayMinor = 0; });
    const empty = opened(emptyCfg), days = scheduleWindow(empty, emptyCfg);
    expect(block(empty, emptyCfg)).toContain(`<p class="muted">앞으로 ${days.to - days.from + 1}일 동안 정해진 일이 없습니다.</p>`);
  });
  it('일정 창은 캠페인 마지막 날에서 자르고 단추 건수는 창 안 일정만 센다', () => {
    for (const day of [opened().day, config.campaignDays - 4, config.campaignDays]) {
      const s = { ...opened(), day }, w = scheduleWindow(s, config);
      expect(w).toEqual({ from: day, to: Math.min(config.campaignDays, day + 6) });
      expect(w.to).toBeLessThanOrEqual(config.campaignDays);
    }
    const s = planState(opened(), config, acceptAllFeasible(opened(), config)).state, w = scheduleWindow(s, config);
    expect(scheduleItems(s, config, config.campaignDays).filter((i) => i.day !== null && i.day > w.to).length).toBeGreaterThan(0);
    expect(block(s)).toContain(`<button class="link" id="schedule-toggle" data-action="schedule-toggle" aria-expanded="true" aria-controls="schedule-body">앞으로 ${w.to - w.from + 1}일 일정 (${scheduleItems(s, config).length}건)</button>`);
    expect(block(opened())).toContain(`<li><b>${opened().day}일 (오늘)</b><ul>`);
  });
  it('일정 줄은 수금 부호·예상 표시·조사 대상 글을 전체 문장으로 쓴다', () => {
    const cmds = acceptAllFeasible(opened(), config), end = runToCampaignEnd(opened(), config, { 1: cmds }).state;
    const c = end.contracts[0]!;
    // 인도 전이고 수금 예상일이 창 안에 든 첫날
    let s = opened(), receipt: ReturnType<typeof scheduleItems>[number] | undefined;
    for (let day = opened().day; day <= c.deliveredDay! && !receipt; day++) {
      s = atDay(config, day, cmds);
      receipt = scheduleItems(s, config).find((i) => i.key === `RCV:${c.id}` && i.estimate);
    }
    expect(receipt!.money!.amountMinor).toBeGreaterThan(0);
    const lineOf = (html: string, start: string) => html.split('<li>').find((l) => l.startsWith(start))!.split('</li>')[0]!;
    expect(lineOf(block(s), `${esc(c.id)} 수금`)).toBe(`${esc(c.id)} 수금 <b>+${esc(formatMoney(receipt!.money!.currency, receipt!.money!.amountMinor))}</b> <span class="tag tag-estimate">예상</span>`);
    const planned = planState(opened(), config, cmds).state;
    const task = scheduleItems(planned, config).find((i) => i.kind === 'TASK_DONE' && i.contractId !== null)!;
    expect(lineOf(block(planned), `${esc(task.contractId!)} ${esc(task.textKo)}`)).toBe(`${esc(task.contractId!)} ${esc(task.textKo)} <span class="tag tag-estimate">예상</span>`);
    const site = config.recruitment!.scoutSites[0]!, emp = config.employees[1]!;
    const scouting = planState(opened(), config, [{ id: 'SCOUT', type: 'SCOUT_SITE', venueId: site.venueId, employeeId: emp.id }]).state;
    const scoutTask = scouting.tasks.find((t) => t.kind === 'SCOUT')!;
    expect(scheduleItems(scouting, config).find((i) => i.key === `TASK:${scoutTask.id}`)!.textKo).toBe(`${taskSubjectKo(config, scoutTask)} 현장 조사 완료 — ${emp.nameKo}`);
  });
  it('출항일 아침의 예약 출항은 오늘 일정에 남는다', () => {
    const cmds = acceptAllFeasible(opened(), config), end = runToCampaignEnd(opened(), config, { 1: cmds }).state;
    const sh = end.shipments[0]!, s = atDay(config, sh.departureDay, cmds);
    expect(s.bookings.find((b) => b.id === sh.bookingId)!.status).toBe('BOOKED');
    expect(scheduleItems(s, config).find((i) => i.key === `DEP:${sh.bookingId}`)!.day).toBe(s.day);
  });
  it('날짜 바뀜은 앞당겨진 날·원래 미정을 적고 밀린 지급의 첫날 변화는 적지 않는다', () => {
    const planned = planState(opened(), config, acceptAllFeasible(opened(), config)).state;
    const task = scheduleItems(planned, config).find((i) => i.kind === 'TASK_DONE')!;
    const lineOf = (html: string, start: string) => html.split('<li>').find((l) => l.startsWith(start))!.split('</li>')[0]!;
    const start = `${esc(task.contractId!)} ${esc(task.textKo)}`;
    const prev = scheduleKeys(planned, config);
    prev[task.key] = task.day! + 2;
    expect(lineOf(block(planned, config, prev), start)).toBe(`${start} <span class="tag tag-estimate">예상</span> <span class="tag">날짜 바뀜 (원래 ${task.day! + 2}일)</span>`);
    prev[task.key] = null;
    expect(lineOf(block(planned, config, prev), start)).toBe(`${start} <span class="tag tag-estimate">예상</span> <span class="tag">날짜 바뀜 (원래 날짜 미정)</span>`);
    delete prev[task.key];
    expect(lineOf(block(planned, config, prev), start)).toBe(`${start} <span class="tag tag-estimate">예상</span> <span class="tag">새 일정</span>`);
    const cfg = structuredClone(config);
    cfg.startingCash[cfg.payrollCurrency] = cfg.employees.filter((e) => isAvailableFromToday(opened(cfg), e.id))
      .reduce((sum, e) => sum + e.salaryPerDayMinor, 0) - 1;
    const poor = openDay(runDays(opened(cfg), cfg, 2).state, cfg).state;
    const overdue = scheduleItems(poor, cfg).find((i) => i.key === `PAY:OVERDUE:${cfg.payrollCurrency}`)!;
    const moved = scheduleKeys(poor, cfg); moved[overdue.key] = overdue.day! - 1;
    expect(lineOf(block(poor, cfg, moved), esc(overdue.textKo))).toBe(`${esc(overdue.textKo)} <b>${esc(formatMoney(cfg.payrollCurrency, overdue.money!.amountMinor))}</b>`);
  });
  it('끝난 캠페인은 진행 중으로 남은 계약이 있어도 밀린 지급만 읽는다', () => {
    const s = runToCampaignEnd(opened(), config, { 1: [{ id: 'ENDED-ACTIVE', type: 'ACCEPT_TRADE', ...tradePairs(config)[0]! }] }).state;
    // 전제: 정리되지 않은 지난 납기 계약이 남아 있다.
    expect(s.contracts.some((c) => c.status === 'ACTIVE' && c.deliveredDay === null && c.deliveryDeadlineDay < s.day)).toBe(true);
    const items = scheduleItems(s, config, config.campaignDays);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.key.startsWith('PAY:OVERDUE:'))).toBe(true);
  });
});
