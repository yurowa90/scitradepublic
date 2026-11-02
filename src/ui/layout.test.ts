// TASK-0024: 배치 공통·배치안 A·Esc 닫기·한 열 화면 코드 순서·머리 줄.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame, openDay } from '../engine/engine';
import { serializeSave } from '../engine/save';
import { runDays } from '../engine/testkit';
import { startUi } from './main-testkit';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
type Ui = Awaited<ReturnType<typeof startUi>>;
const config = loadScenario('SCENARIO_M2_MULTI_TRADE');
const first = config.employees[0]!.id;
const header = (html: string) => html.match(/<header class="topbar">[\s\S]*?<\/header>/)![0];
const chip = (n: number) => `<button class="queue-chip" id="queue-chip" data-action="queue-jump" aria-label="오늘 할 일 ${n}건 보기">오늘 할 일 <b>${n}</b>건</button><div class="day-action">`;
const button = (html: string, action: string, key: string, value: string) => html.match(new RegExp(`<button[^>]*data-action="${action}" data-${key}="${value}"[^>]*>`))![0];
const pressEsc = (ui: Ui, extra: Record<string, unknown> = {}) => { const ev = { key: 'Escape', preventDefault: vi.fn(), ...extra }; ui.fireDoc('keydown', ev); return ev; };
const readCss = async () => (await vi.importActual<{ readFileSync: (p: URL, e: string) => string }>('node:fs')).readFileSync(new URL('./style.css', import.meta.url), 'utf8');
/** 4일 면담 준비 저장: 1일 첫 현장 조사(둘째 직원), 2일 발견한 후보 영입 의뢰(첫 직원). ID는 설정·상태에서 꺼낸다. */
const interviewSave = () => {
  const scout = { id: 'S', type: 'SCOUT_SITE' as const, venueId: config.recruitment!.scoutSites[0]!.venueId, employeeId: config.employees[1]!.id };
  const candidate = runDays(createGame(config), config, 1, { 1: [scout] }).state.recruitment.candidates.find((c) => c.stage === 'DISCOVERED')!.employeeId;
  const quest = { id: 'Q', type: 'START_RECRUIT_QUEST' as const, candidateId: candidate, employeeId: first };
  return serializeSave(openDay(runDays(createGame(config), config, 3, { 1: [scout], 2: [quest] }).state, config).state);
};

describe('배치 공통: 카드 아래 상세·펼침 띠·훈련 칸', () => {
  it('카드로 고르면 상세가 그 카드 바로 뒤에, 운영표 줄·이름 단추로 고르면 운영표 뒤에 있다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    const underCard = () => {
      const html = ui.app.innerHTML, card = html.search(new RegExp(`<article class="card [^"]*is-selected" data-action="select-card" data-emp="${first}"`));
      const detail = html.indexOf('<div class="card-detail">');
      return card >= 0 && detail > card && html.indexOf('<article', card + 1) > detail && html.indexOf('<section class="employee-detail"') > detail
        && html.indexOf('<section class="employee-detail"') < html.indexOf('<table class="roster">');
    };
    const underRoster = () => {
      const html = ui.app.innerHTML;
      return !html.includes('<div class="card-detail">') && html.indexOf('<section class="employee-detail"') > html.indexOf('</table>', html.indexOf('<table class="roster">'));
    };
    ui.click({ action: 'select-card', emp: first }); expect(underCard()).toBe(true);
    const row = () => ui.app.querySelectorAll('[data-action]').find((e) => 'tagName' in e && e.tagName === 'TR' && e.dataset.emp === first)!;
    vi.advanceTimersByTime(501); ui.clickTarget(row()); expect(underRoster()).toBe(true);
    ui.click({ action: 'select-card', emp: first }); expect(underCard()).toBe(true);
    const pick = ui.app.querySelectorAll('[data-action]').find((e) => 'tagName' in e && e.tagName === 'BUTTON' && e.dataset.action === 'select-card' && e.dataset.emp === first)!;
    vi.advanceTimersByTime(501); ui.clickTarget(pick); expect(underRoster()).toBe(true);
    ui.keydown(ui.rendered({ action: 'select-card', emp: first }), 'Enter'); expect(underCard()).toBe(true);
  });
  it('고른 카드가 필터로 숨으면 상세는 운영표 뒤에 있고 필터를 풀면 카드 아래로 돌아온다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'select-card', emp: first });
    ui.click({ action: 'crew-filter', filter: 'busy' });
    const html = ui.app.innerHTML;
    expect(html).not.toContain('<div class="card-detail">');
    expect(html.indexOf('<section class="employee-detail"')).toBeGreaterThan(html.indexOf('<table class="roster">'));
    ui.click({ action: 'crew-filter', filter: 'all' }); expect(ui.app.innerHTML).toContain('<div class="card-detail">');
  });
  it('펼친 상세는 훈련 단추 아래 끝 + 8px이 알림 자리 72px 위에 오게 한 번 굴리고 제목은 막대 아래 8px에 남긴다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'select-card', emp: first });
    ui.bounds[`train:${first}`] = { top: 760, bottom: 797, height: 37 };
    ui.bounds[`training-h-${first}`] = { top: 400, bottom: 420, height: 20 };
    ui.scrollBy.mockClear(); ui.click({ action: 'detail', emp: first });
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 797 + 8 - (800 - 72));
    ui.scrollBy.mockClear(); ui.click({ action: 'detail', emp: first }); expect(ui.scrollBy).not.toHaveBeenCalled();
    ui.bounds[`training-h-${first}`] = { top: 150, bottom: 170, height: 20 };
    ui.click({ action: 'detail', emp: first }); expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 150 - 100 - 8);
    ui.click({ action: 'detail', emp: first }); ui.bounds[`train:${first}`] = { top: 600, bottom: 637, height: 37 };
    ui.scrollBy.mockClear(); ui.click({ action: 'detail', emp: first }); expect(ui.scrollBy).not.toHaveBeenCalled();
  });
  it('알림이 있으면 펼친 상세의 띠 아래 끝은 알림 위 끝이다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.setToastTop(600);
    ui.click({ action: 'select-card', emp: first });
    ui.bounds[`train:${first}`] = { top: 603, bottom: 640, height: 37 }; ui.bounds[`training-h-${first}`] = { top: 400, bottom: 420, height: 20 };
    ui.scrollBy.mockClear(); ui.click({ action: 'detail', emp: first });
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 640 + 8 - 600);
  });
  it('펼친 면담은 고용 단추를 같은 규칙으로 띠 안에 두고 접을 때는 굴리지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(interviewSave());
    const candidate = ui.rendered({ action: 'interview' }).dataset.candidate!;
    ui.setToastTop(790); // 불러오기 알림이 떠 있다. 알림 위 끝(790)보다 72px 예약(728)이 더 위다.
    ui.bounds[`hire:${candidate}`] = { top: 700, bottom: 744, height: 44 }; ui.bounds[`interview-h-${candidate}`] = { top: 300, bottom: 330, height: 30 };
    ui.scrollBy.mockClear(); ui.click({ action: 'interview', candidate });
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 744 + 8 - (800 - 72));
    ui.scrollBy.mockClear(); ui.click({ action: 'interview', candidate }); expect(ui.scrollBy).not.toHaveBeenCalled();
  });
  it('훈련을 넣고 위 내용이 늘면 예정 표시를 누른 높이에 둔다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'select-card', emp: first }); ui.click({ action: 'detail', emp: first });
    ui.scrollBy.mockClear(); ui.afterRender(() => { ui.slotTops[`train-${first}`] = 230; });
    ui.click({ action: 'train', emp: first });
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 50);
    expect(ui.app.innerHTML).toContain(`<div data-action-slot="train-${first}"><span class="pill" id="status-train-${first}" tabindex="-1">일반 훈련 예정</span></div>`);
  });
  it('M1 화면에는 카드 아래 상세·오늘 할 일 단추·훈련 칸이 없다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.change({ action: 'scenario' }, 'SCENARIO_M1_ONE_TRADE');
    ui.click({ action: 'select-card' }); ui.click({ action: 'accept' });
    for (const part of ['class="card-detail"', 'queue-chip', 'data-action-slot="train-']) expect(ui.app.innerHTML).not.toContain(part);
  });
});

describe('배치안 A: 오늘 할 일 단추', () => {
  it('M2 막대의 단추는 하루 진행 바로 앞이고 건수는 오늘 할 일 목록의 줄 수다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    const rows = () => (ui.app.innerHTML.match(/<ol class="pending">([\s\S]*?)<\/ol>/)?.[1]?.match(/<li\b/g) ?? []).length;
    expect(header(ui.app.innerHTML)).toContain(chip(0));
    ui.click({ action: 'accept' }); expect(header(ui.app.innerHTML)).toContain(chip(1)); expect(rows()).toBe(1);
    ui.click({ action: 'assign' }); expect(header(ui.app.innerHTML)).toContain(chip(2));
    // 앞 명령을 빼면 남은 배정은 실행할 수 없는 줄(bad)로 남는다. 그 줄도 센다.
    ui.click({ action: 'unqueue', index: '0' });
    expect(ui.app.innerHTML).toContain('<li class="bad">'); expect(rows()).toBe(1); expect(header(ui.app.innerHTML)).toContain(chip(1));
  });
  it('단추를 누르면 오늘 할 일 제목으로 굴리고 초점을 두며 500ms 동안 다른 누름을 막고 알림은 그대로다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); const before = ui.announcements.length;
    ui.scrollIds.length = 0; ui.focusIds.length = 0; ui.focus.mockClear();
    ui.click({ action: 'queue-jump' });
    expect(ui.scrollIds).toEqual(['queue-h']); expect(ui.focusIds).toEqual(['queue-h']);
    expect(ui.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true }); expect(ui.scroll).toHaveBeenLastCalledWith({ block: 'start' });
    vi.advanceTimersByTime(499); ui.clickNow({ action: 'accept' }); expect(header(ui.app.innerHTML)).toContain(chip(0));
    vi.advanceTimersByTime(1); ui.clickNow({ action: 'accept' }); expect(header(ui.app.innerHTML)).toContain(chip(1));
    expect(ui.announcements).toHaveLength(before + 1);
  });
  it('키보드 순서(Tab → focusin → Enter → click)에서 단추는 고정 막대 안이라 Shift+Tab 위치 복원을 받고 같은 곳으로 간다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.win.scrollY = 1200;
    ui.fireDoc('keydown', { key: 'Tab', shiftKey: true }); ui.win.scrollY = 800;
    ui.fireDoc('focusin', { target: ui.rendered({ action: 'queue-jump' }) });
    expect(ui.win.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 1200);
    ui.fireDoc('keydown', { key: 'Enter' }); ui.scrollIds.length = 0; vi.advanceTimersByTime(501); ui.clickNow({ action: 'queue-jump' }, 0);
    expect(ui.scrollIds).toEqual(['queue-h']); expect(ui.doc.activeElement.id).toBe('queue-h');
  });
});

describe('배치안 A: 하루 진행 뒤 마지막 조작 열', () => {
  const side = (ui: Ui, type = 'pointerdown') => ui.fireApp(type, { target: ui.rendered({ action: 'schedule-toggle' }) });
  const endDayScroll = async (before: (ui: Ui) => unknown, start = () => startUi()) => {
    const ui = await start(); ui.click({ action: 'accept' });
    const contract = ui.rendered({ action: 'cancel' }).dataset.contract!;
    await before(ui);
    ui.bounds['queue-h'] = { top: 300, bottom: 330, height: 30 }; ui.bounds[`contract-h-${contract}`] = { top: 250, bottom: 280, height: 30 };
    ui.afterRender(() => { ui.bounds['queue-h'] = { top: 380, bottom: 410, height: 30 }; ui.bounds[`contract-h-${contract}`] = { top: 200, bottom: 230, height: 30 }; });
    ui.scrollBy.mockClear(); ui.click({ action: 'end-day' });
    return ui.scrollBy.mock.calls;
  };
  it.each(['pointerdown', 'wheel', 'touchstart', 'focusin'])('오른쪽 칸에서 %s 뒤 하루 진행은 오른쪽 후보 하나로 한 번 보정한다', async (type) => {
    expect(await endDayScroll((ui) => side(ui, type))).toEqual([[0, 80]]);
  });
  it('막대 아래에서 시작하는 후보를 막대에 걸친 후보보다 먼저 쓴다', async () => {
    expect(await endDayScroll((ui) => { side(ui); ui.bounds['crew-h'] = { top: 80, bottom: 130, height: 50 }; })).toEqual([[0, 80]]);
  });
  it('주 열을 누른 뒤에는 계약 제목 규칙 그대로다', async () => {
    expect(await endDayScroll((ui) => { side(ui); ui.fireApp('pointerdown', { target: ui.rendered({ action: 'cancel' }) }); })).toEqual([[0, -50]]);
  });
  it('고정 막대를 눌러도 마지막 열은 그대로다', async () => {
    expect(await endDayScroll((ui) => { side(ui); ui.fireApp('pointerdown', { target: ui.rendered({ action: 'end-day' }) }); })).toEqual([[0, 80]]);
  });
  it('한 열이면 오른쪽을 눌렀어도 계약 제목 규칙이다', async () => {
    expect(await endDayScroll((ui) => { ui.setOneColumn(true); side(ui); })).toEqual([[0, -50]]);
  });
  it('M1이면 오른쪽을 눌렀어도 계약 제목 규칙이다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.change({ action: 'scenario' }, 'SCENARIO_M1_ONE_TRADE');
    ui.click({ action: 'accept' }); ui.click({ action: 'assign' }); ui.click({ action: 'book' });
    const contract = ui.rendered({ action: 'cancel' }).dataset.contract!;
    ui.fireApp('pointerdown', { target: ui.rendered({ action: 'unqueue' }) });
    ui.bounds['queue-h'] = { top: 300, bottom: 330, height: 30 }; ui.bounds[`contract-h-${contract}`] = { top: 250, bottom: 280, height: 30 };
    ui.afterRender(() => { ui.bounds['queue-h'] = { top: 380, bottom: 410, height: 30 }; ui.bounds[`contract-h-${contract}`] = { top: 200, bottom: 230, height: 30 }; });
    ui.scrollBy.mockClear(); ui.click({ action: 'end-day' });
    expect(ui.scrollBy.mock.calls).toEqual([[0, -50]]);
  });
  it.each(['load', 'import', 'restart', 'scenario'])('%s 뒤에는 마지막 열이 비워진다', async (how) => {
    const save = serializeSave(openDay(createGame(config), config).state);
    vi.stubGlobal('localStorage', { getItem: () => save, setItem: () => undefined });
    expect(await endDayScroll(() => undefined, async () => {
      const ui = await startUi(); await (await import('./main-testkit')).screensReady(); side(ui);
      if (how === 'load') ui.click({ action: 'load' });
      if (how === 'import') await ui.importText(save);
      if (how === 'restart') ui.click({ action: 'restart' });
      if (how === 'scenario') ui.change({ action: 'scenario' }, config.id);
      return ui;
    })).toEqual([[0, -50]]);
  });
});

describe('Esc로 맨 위 칸 닫기', () => {
  it('열린 상세를 닫고 상세 단추로 초점을 돌려주며 띠 안으로 최소 거리만 옮기고 500ms 동안 누름을 막는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'select-card', emp: first }); ui.click({ action: 'detail', emp: first });
    ui.bounds[`detail:${first}`] = { top: 50, bottom: 94, height: 44 };
    ui.scrollBy.mockClear(); ui.focus.mockClear(); vi.advanceTimersByTime(501);
    const ev = pressEsc(ui);
    expect(ev.preventDefault).toHaveBeenCalledOnce();
    expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="false"');
    expect(ui.doc.activeElement.dataset).toEqual({ action: 'detail', emp: first });
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 50 - (100 + 8));
    expect(ui.focus).toHaveBeenLastCalledWith({ preventScroll: true });
    vi.advanceTimersByTime(499); ui.clickNow({ action: 'detail', emp: first }); expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="false"');
    vi.advanceTimersByTime(1); ui.clickNow({ action: 'detail', emp: first }); expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="true"');
    // 단추가 띠 아래에 있으면 아래 끝을 띠 아래 끝(화면 800 − 8)에 맞춘다.
    ui.bounds[`detail:${first}`] = { top: 770, bottom: 814, height: 44 };
    ui.scrollBy.mockClear(); vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 814 - (800 - 8)); expect(ui.doc.activeElement.dataset).toEqual({ action: 'detail', emp: first });
  });
  it('단추가 띠 안이면 굴리지 않고 초점만 돌려준다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'select-card', emp: first }); ui.click({ action: 'detail', emp: first });
    ui.scrollBy.mockClear(); vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.scrollBy).not.toHaveBeenCalled(); expect(ui.doc.activeElement.dataset.action).toBe('detail');
  });
  it('면담을 닫고 면담 단추로 초점을 돌려준다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); await ui.importText(interviewSave());
    const candidate = ui.rendered({ action: 'interview' }).dataset.candidate!;
    // 상세를 먼저 열었어도 나중에 연 면담이 맨 위다.
    ui.click({ action: 'select-card', emp: first }); ui.click({ action: 'detail', emp: first });
    ui.click({ action: 'interview', candidate }); vi.advanceTimersByTime(501); pressEsc(ui);
    expect(button(ui.app.innerHTML, 'interview', 'candidate', candidate)).toContain('aria-expanded="false"');
    expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="true"');
    expect(ui.doc.activeElement.dataset).toEqual({ action: 'interview', candidate });
  });
  it('기록장을 먼저 닫고 다음 Esc로 현지 패널을 닫아 열기 전 탭 위치로 되돌리고 현지 탭에 초점을 둔다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.bounds['local-tab'] = { top: 240, bottom: 284, height: 44 };
    ui.click({ action: 'culture-tab' }); ui.click({ action: 'culture-book' });
    vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.app.innerHTML).toContain('id="local"'); expect(ui.app.innerHTML).toContain('data-action="culture-book" aria-expanded="false"');
    expect(ui.doc.activeElement.dataset.action).toBe('culture-book');
    ui.scrollBy.mockClear(); ui.afterRender(() => { ui.bounds['local-tab'] = { top: 310, bottom: 354, height: 44 }; });
    vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.app.innerHTML).not.toContain('id="local"'); expect(ui.doc.activeElement.id).toBe('local-tab');
    expect(ui.scrollBy).toHaveBeenCalledExactlyOnceWith(0, 70);
  });
  it('맨 위 칸은 가장 최근에 열거나 그 안을 누르거나 초점을 둔 칸이다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'culture-tab' }); ui.click({ action: 'select-card', emp: first }); ui.click({ action: 'detail', emp: first });
    vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.app.innerHTML).toContain('id="local"'); expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="false"');
    ui.click({ action: 'detail', emp: first }); ui.click({ action: 'culture-tab' }); ui.click({ action: 'culture-tab' });
    vi.advanceTimersByTime(501); pressEsc(ui); expect(ui.app.innerHTML).not.toContain('id="local"');
    ui.click({ action: 'culture-tab' }); ui.fireApp('pointerdown', { target: ui.rendered({ action: 'train', emp: first }) });
    vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.app.innerHTML).toContain('id="local"'); expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="false"');
    ui.click({ action: 'detail', emp: first }); ui.fireApp('focusin', { target: ui.rendered({ action: 'culture-act' }) });
    vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.app.innerHTML).not.toContain('id="local"'); expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="true"');
    // 굴리기(wheel·touchstart)만으로는 맨 위 칸이 바뀌지 않는다.
    ui.click({ action: 'culture-tab' }); ui.fireApp('wheel', { target: ui.rendered({ action: 'train', emp: first }) });
    vi.advanceTimersByTime(501); pressEsc(ui);
    expect(ui.app.innerHTML).not.toContain('id="local"'); expect(button(ui.app.innerHTML, 'detail', 'emp', first)).toContain('aria-expanded="true"');
  });
  it.each([['열린 칸 없음', {}], ['반복', { repeat: true }], ['Ctrl', { ctrlKey: true }], ['Alt', { altKey: true }], ['Meta', { metaKey: true }], ['Shift', { shiftKey: true }], ['입력 조합 중', { isComposing: true }]])('%s이면 Esc가 아무것도 하지 않는다', async (_name, extra) => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); if (Object.keys(extra).length) ui.click({ action: 'culture-tab' });
    const before = ui.app.innerHTML; vi.advanceTimersByTime(501);
    const ev = pressEsc(ui, extra);
    expect(ev.preventDefault).not.toHaveBeenCalled(); expect(ui.app.innerHTML).toBe(before);
  });
  it('Esc는 위쪽 막대와 알림 영역을 바꾸지 않고 Tab 기록을 지운다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'culture-tab' }); ui.click({ action: 'culture-book' });
    const bar = header(ui.app.innerHTML), count = ui.announcements.length;
    vi.advanceTimersByTime(501); pressEsc(ui); vi.advanceTimersByTime(501); pressEsc(ui);
    expect(header(ui.app.innerHTML)).toBe(bar); expect(ui.announcements).toHaveLength(count);
    ui.win.scrollY = 1200; ui.fireDoc('keydown', { key: 'Tab', shiftKey: true }); pressEsc(ui); ui.win.scrollY = 800;
    ui.fireDoc('focusin', { target: ui.rendered({ action: 'end-day' }) });
    expect(ui.win.scrollTo).not.toHaveBeenCalled();
  });
});

describe('한 열 화면 코드 순서', () => {
  const PANEL: Record<string, string> = { trade: '<section class="panel trade"', crew: '<aside class="panel crew"', resources: '<section class="panel resources"',
    queue: '<section class="panel queue"', world: '<section class="panel world"', report: '<section class="panel report"', log: '<section class="panel log"' };
  const domOrder = (html: string) => Object.keys(PANEL).sort((a, b) => html.indexOf(PANEL[a]!) - html.indexOf(PANEL[b]!));
  const areaOrder = (areas: string) => [...new Set(areas.match(/"([^"]+)"/g)!.flatMap((row) => row.slice(1, -1).trim().split(/\s+/)))];
  it('한 열이면 한 열 격자 순서, 세 열이면 세 열 격자 순서로 그리고 미디어 조건은 CSS와 같다', async () => {
    const css = await readCss();
    const three = areaOrder(css.match(/\.layout \{[^}]*grid-template-areas:([^;]+);/)![1]!);
    const one = areaOrder(css.match(/@media \(max-width: 1000px\) \{[^}]*\}[^}]*grid-template-areas:([^;]+);/)![1]!);
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    expect(domOrder(ui.app.innerHTML)).toEqual(three);
    ui.setOneColumn(true); expect(domOrder(ui.app.innerHTML)).toEqual(one);
    ui.click({ action: 'accept' }); expect(domOrder(ui.app.innerHTML)).toEqual(one);
    ui.click({ action: 'map-mode', mode: 'world' }); expect(domOrder(ui.app.innerHTML)).toEqual(one);
    ui.setOneColumn(false); expect(domOrder(ui.app.innerHTML)).toEqual(three);
    ui.change({ action: 'scenario' }, 'SCENARIO_M1_ONE_TRADE'); expect(domOrder(ui.app.innerHTML)).toEqual(three);
    ui.setOneColumn(true); expect(domOrder(ui.app.innerHTML)).toEqual(one);
    expect(ui.mediaQueries).toEqual([css.match(/@media (\([^)]*\)) \{\n {2}\.layout, \.layout\.map-wide \{ grid-template-rows: none; \}/)![1]]);
  });
  it('패널 사이 글자는 기존 화면 코드와 같은 줄바꿈과 들여쓰기다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); const gap = '\n      \n  ';
    const pairs = (html: string, order: string[]) => order.slice(1).every((key, i) => html.includes(`${i === 0 ? '</div>' : order[i] === 'crew' ? '</aside>' : '</section>'}${gap}${PANEL[key]}`));
    expect(pairs(ui.app.innerHTML, ['trade', 'crew', 'resources', 'queue', 'world', 'report', 'log'])).toBe(true);
    ui.setOneColumn(true); expect(pairs(ui.app.innerHTML, ['trade', 'queue', 'crew', 'resources', 'report', 'world', 'log'])).toBe(true);
  });
  it('폭이 바뀌어 다시 그려도 초점은 같은 조작에 남고 굴리지 않는다', async () => {
    const ui = await startUi(); await (await import('./main-testkit')).screensReady(); ui.click({ action: 'accept' }); ui.click({ action: 'end-day' });
    ui.doc.activeElement = ui.rendered({ action: 'schedule-toggle' }); ui.focusIds.length = 0; ui.focus.mockClear();
    ui.bounds['schedule-toggle'] = { top: 2000, bottom: 2044, height: 44 };
    ui.setOneColumn(true);
    expect(ui.focusIds).toEqual(['schedule-toggle']); expect(ui.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(ui.scrollBy).not.toHaveBeenCalled(); expect(ui.win.scrollTo).not.toHaveBeenCalled();
    ui.doc.activeElement = ui.rendered({ action: 'crew-filter', filter: 'free' }); ui.focusIds.length = 0;
    ui.setOneColumn(false); expect(ui.doc.activeElement.dataset).toEqual({ action: 'crew-filter', filter: 'free' }); expect(ui.focusIds).toEqual([]);
    ui.doc.activeElement = null; ui.focus.mockClear(); ui.setOneColumn(true); expect(ui.focus).not.toHaveBeenCalled();
  });
});

describe('머리 줄', () => {
  it('빌드 표시 문구 폭을 9.5rem으로 묶어 빌드 표시를 둘째 줄에 두고 문구는 그대로다', async () => {
    expect(await readCss()).toMatch(/\.brand \.sub \{ max-width: 9\.5rem; \}/);
    const ui = await startUi(); await (await import('./main-testkit')).screensReady();
    // 빌드 표시는 git 작업 트리에서 해시(+수정), 밖에서 dev다(main.test.ts ‘빌드 표시는 머리 문구에 있고…’와 같은 식).
    expect(ui.app.innerHTML).toMatch(/<div class="brand"><span class="logo">Scitrade<\/span><span class="sub">시제품 · 모든 숫자는 가상값 · 빌드 (dev|[0-9a-f]{7}(\+수정)?)<\/span><\/div>/);
  });
});
