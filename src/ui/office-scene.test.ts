import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame } from '../engine/engine';
import * as assets from './assets';
import { spriteHtml } from './sprite';
import { runningTaskOf } from '../engine/reservations';
const readers = { spriteHtml, runningTaskOf };
import { officeButton } from './recruitment';
import { officeScale, officeSceneHtml, openOffice } from './office-scene';
import { startUi } from './main-testkit';

const config = () => loadScenario('SCENARIO_M2_MULTI_TRADE');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.doUnmock('./lazy'); });

/** 대화상자 수명·초점·크기 변경을 위한 최소 DOM. 배치는 브라우저 실측에 맡긴다. */
function modalDom() {
  const listeners: Record<string, (event: any) => void> = {};
  const progress = { disabled: false }, outside = { inert: false, querySelector: () => progress };
  const viewport = { innerHTML: '', clientWidth: 1000, getBoundingClientRect: () => ({ top: 100 }) };
  const title = { focus: vi.fn() }, closeButton = { focus: vi.fn(), addEventListener: vi.fn() };
  const root = { innerHTML: '', className: '', setAttribute: vi.fn(), remove: vi.fn(),
    querySelector: (selector: string): any => selector === '#office-h' ? title : selector === '[data-office-close]' ? closeButton : selector === '.office-viewport' ? viewport : { getBoundingClientRect: () => ({ top: 20 }) },
    addEventListener: (type: string, listener: (event: any) => void) => { listeners[type] = listener; },
  };
  const opener = { focus: vi.fn() };
  const observer = { observe: vi.fn(), disconnect: vi.fn() };
  let onResize!: () => void;
  const win = { innerHeight: 800, devicePixelRatio: 2, addEventListener: vi.fn(), removeEventListener: vi.fn() };
  const doc = { createElement: () => root, querySelector: () => outside, body: { appendChild: vi.fn() } };
  vi.stubGlobal('window', win); vi.stubGlobal('document', doc);
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { onResize = callback; } observe = observer.observe; disconnect = observer.disconnect; });
  return { root, viewport, title, closeButton, outside, progress, opener, observer, win, doc,
    resize: () => onResize(), key: (key: string, overrides = {}) => { const event = { key, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides }; listeners.keydown!(event); return event; },
  };
}

describe('TASK-0079 사무실', () => {
  it('승인 시트가 있는 고용 동료가 있을 때만 제목 줄의 단추를 그린다', async () => {
    const cfg = config(), state = createGame(cfg);
    expect(officeButton(state)).toContain('data-action="open-office"');
    const ui = await startUi(); vi.clearAllTimers();
    expect(ui.app.innerHTML).toMatch(/<h2 id="crew-h"[^>]*>[^<]*<small>[^<]*<\/small><button data-action="open-office"[^>]*>사무실 보기<\/button><\/h2>/);
    expect(ui.app.innerHTML).not.toMatch(/<img[^>]+(?:company|work)\.png/);
    vi.spyOn(assets, 'characterSprite').mockReturnValue(null);
    expect(officeButton(state)).toBe('');
    const currentAssets = await import('./assets');
    vi.spyOn(currentAssets, 'characterSprite').mockReturnValue(null);
    await ui.click({ action: 'crew-filter', filter: 'all' });
    expect(ui.app.innerHTML).not.toContain('open-office');
    vi.restoreAllMocks();
    for (const employee of state.employees) employee.employmentStatus = 'candidate';
    expect(officeButton(state)).toBe('');
  });

  it('폭·높이·기기 배율로 1 이상의 정수 배율을 고른다', () => {
    expect(officeScale(1000, 700, 1)).toBe(1);
    expect(officeScale(900, 700, 2)).toBe(2);
    expect(officeScale(1400, 500, 2)).toBe(2);
    expect(officeScale(100, 100, 1)).toBe(1);
  });

  it('확정 업무에 따라 work·idle을 쓰고 배경과 모든 스프라이트의 배율을 맞춘다', () => {
    const cfg = config(), state = createGame(cfg);
    state.tasks.push({ id: 'OFFICE-TEST', kind: 'EXPORT_PREP', contractId: null, subjectId: null, cityId: 'PYEONGTAEK', requiredWorkUnits: 2, progressWorkUnits: 1, status: 'RUNNING', assignedEmployeeId: 'EMP01', startedDay: 1, completedDay: null });
    const before = JSON.stringify(state);
    for (const [n, dpr] of [[1, 1], [2, 2], [3, 2]]) {
      const html = officeSceneHtml(state, cfg, n!, dpr!, readers);
      expect(html).toContain(`--office-unit: ${n! / dpr!}px; --pixel-dpr: ${dpr}`);
      expect(html).toContain(`data-scale-n="${n}"`);
      expect(html).toContain('src="assets/backgrounds/company.png" width="640" height="360" alt=""');
      const sprites = [...html.matchAll(/<span class="pixel-sprite[^>]+>/g)].map((m) => m[0]);
      expect(sprites).toHaveLength(2);
      expect(sprites[0]).toContain('--sprite-row: 2');
      expect(sprites[0]).toContain('수출 준비 중');
      expect(sprites[1]).toContain('--sprite-row: 0');
      expect(sprites[1]).toContain('대기');
      for (const sprite of sprites) expect(sprite).toContain(`--sprite-scale: ${n};`);
      expect((html.match(/<li>/g) ?? [])).toHaveLength(2);
    }
    expect(JSON.stringify(state)).toBe(before);
  });

  it('여섯 자리 이후와 시트가 없는 동료도 글 목록에는 남긴다', () => {
    const cfg = config(), state = createGame(cfg), sheet = assets.characterSprite('EMP01')!;
    for (const employee of state.employees) employee.employmentStatus = 'employed';
    for (const id of ['EMP07', 'EMP08']) {
      cfg.employees.push({ ...cfg.employees[0]!, id, nameKo: `추가 ${id}` });
      state.employees.push({ ...state.employees[0]!, id });
    }
    vi.spyOn(assets, 'characterSprite').mockImplementation((id) => id === 'EMP08' ? null : sheet);
    const html = officeSceneHtml(state, cfg, 2, 2, readers);
    expect((html.match(/class="office-seat"/g) ?? [])).toHaveLength(6);
    expect((html.match(/<li>/g) ?? [])).toHaveLength(8);
    expect(html).toContain('<li>추가 EMP07, 대기</li>');
    expect(html).toContain('<li>추가 EMP08, 대기</li>');
  });

  it('제목 초점·inert·Tab 고리·Escape 복구와 resize 정리를 처리한다', () => {
    const dom = modalDom(), cfg = config(), closed = vi.fn();
    openOffice(createGame(cfg), cfg, dom.opener as unknown as HTMLElement, closed, readers);
    expect(dom.root.setAttribute).toHaveBeenCalledWith('role', 'dialog');
    expect(dom.root.setAttribute).toHaveBeenCalledWith('aria-modal', 'true');
    expect(dom.title.focus).toHaveBeenCalledOnce();
    expect(dom.outside.inert).toBe(true); expect(dom.progress.disabled).toBe(true);
    expect(dom.viewport.innerHTML).toContain('data-scale-n="3"');
    dom.viewport.clientWidth = 640; dom.resize();
    expect(dom.viewport.innerHTML).toContain('data-scale-n="2"');
    expect(dom.key('Tab').preventDefault).toHaveBeenCalledOnce(); expect(dom.closeButton.focus).toHaveBeenCalledOnce();
    dom.key('Tab', { shiftKey: true }); expect(dom.closeButton.focus).toHaveBeenCalledTimes(2);
    dom.key('Escape', { repeat: true }); expect(closed).not.toHaveBeenCalled();
    dom.key('Escape'); expect(closed).toHaveBeenCalledOnce(); expect(dom.opener.focus).toHaveBeenCalledOnce();
    expect(dom.outside.inert).toBe(false); expect(dom.progress.disabled).toBe(false);
    expect(dom.root.remove).toHaveBeenCalledOnce(); expect(dom.observer.disconnect).toHaveBeenCalledOnce();
    expect(dom.win.removeEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
  });

  it('움직임 줄이기는 기존 스프라이트의 해당 줄 0번 칸 규칙을 사용한다', async () => {
    const fs = await import('node:fs' as string) as { readFileSync(p: string, e: string): string };
    const css = fs.readFileSync('src/ui/style.css', 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.pixel-sprite\s*\{\s*animation: none; background-position-x: 0;/);
  });

  it('기존 inert·진행 불가 상태를 닫기 단추로 복구한다', () => {
    const dom = modalDom(), cfg = config(); dom.outside.inert = true; dom.progress.disabled = true;
    openOffice(createGame(cfg), cfg, dom.opener as unknown as HTMLElement, vi.fn(), readers);
    dom.closeButton.addEventListener.mock.calls[0]![1]();
    expect(dom.outside.inert).toBe(true); expect(dom.progress.disabled).toBe(true);
  });

  it('실제 열기 동작에서 배경 진행을 막고 Escape 뒤 단추로 돌아온다', async () => {
    const ui = await startUi(); vi.clearAllTimers();
    const dom = modalDom();
    vi.stubGlobal('document', ui.doc); vi.stubGlobal('window', ui.win);
    Object.assign(ui.win, { devicePixelRatio: 2, removeEventListener: vi.fn() });
    ui.doc.createElement.mockImplementation(() => dom.root as any);
    Object.assign(ui.doc.body, { appendChild: vi.fn() });
    const before = ui.app.innerHTML;
    await ui.click({ action: 'open-office' });
    expect(dom.root.innerHTML).toContain('사무실');
    expect(dom.viewport.innerHTML).toContain('company.png');
    expect((ui.app as unknown as { inert: boolean }).inert).toBe(true);
    await ui.click({ action: 'end-day' }); expect(ui.app.innerHTML).toBe(before);
    dom.key('Escape');
    expect(ui.doc.activeElement.dataset.action).toBe('open-office');
    await ui.click({ action: 'end-day' }); expect(ui.app.innerHTML).not.toBe(before);
  });

  it('지연 불러오기 실패는 기존 안내로 보여 주고 재시도 한도를 지킨다', async () => {
    let attempts = 0;
    vi.doMock('./lazy', async (original) => {
      const module = await original<typeof import('./lazy')>();
      return { ...module, lazyScreen<T>(loader: () => Promise<T>) {
        return module.lazyScreen(async () => {
          if (loader.toString().includes('office-scene')) { attempts++; throw new Error('시험용 사무실 실패'); }
          return loader();
        });
      } };
    });
    const ui = await startUi(); vi.clearAllTimers();
    for (let i = 0; i < 3; i++) {
      await ui.click({ action: 'open-office' });
      expect(attempts).toBe(Math.min(i + 1, 2));
      expect(ui.app.innerHTML).toContain(i === 0 ? '인터넷 연결을 확인하고 다시 눌러 주세요' : '저장하고 새로 고침해 주세요');
    }
  });
});
