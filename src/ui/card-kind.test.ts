import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadScenario } from '../content/scenario';
import { createGame } from '../engine/engine';
import { crewCard } from './card';
import { startUi } from './main-testkit';

const fs = await import('node:fs' as string) as { readFileSync(p: string, e: string): string };
const read = (path: string) => fs.readFileSync(path, 'utf8');
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.doUnmock('./card-najeon.css'); });

describe('TASK-0079 카드 종류·자개 틀', () => {
  it('자료의 동물·신수·값 없음으로 클래스를 정하고 접근 이름은 그대로 둔다', () => {
    const config = loadScenario('SCENARIO_M2_MULTI_TRADE'), state = createGame(config);
    for (const [id, kind] of [['EMP01', 'animal'], ['EMP06', 'myth_inspired']]) {
      state.employees.find((e) => e.id === id)!.employmentStatus = 'employed';
      const def = config.employees.find((e) => e.id === id)!;
      const html = crewCard(def, state, false, config);
      expect(html).toContain(`card creature-${kind}`);
      const plain = crewCard({ ...def, character: { ...def.character, creatureKind: null } }, state, false, config);
      expect(plain).toContain('card creature-none');
      expect(html.match(/aria-label="[^"]*"/)?.[0]).toBe(plain.match(/aria-label="[^"]*"/)?.[0]);
    }
  });

  it('자개 선택자는 신수에만 적용하고 덮개의 절대 배치·그리기 속성만 허용한다', () => {
    const css = read('src/ui/card-najeon.css').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/animation|transition/);
    const blocks = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    expect(blocks.length).toBeGreaterThan(0);
    for (const [, selector, body] of blocks) {
      for (const part of selector!.split(',')) expect(part).toContain('.creature-myth_inspired');
      const properties = body!.replace(/url\("[^"]*"\)/g, 'url()').split(';').map((d) => d.trim()).filter(Boolean).map((d) => d.slice(0, d.indexOf(':')).trim());
      if (selector!.includes('::')) {
        expect(body).toMatch(/position:\s*absolute/);
        expect(body).toMatch(/pointer-events:\s*none/);
        for (const prop of properties) expect(['content', 'position', 'pointer-events', 'inset', 'background', 'mask']).toContain(prop);
      } else expect(properties).toEqual(['--shell', 'border-radius']);
    }
    expect(css).toContain('5px 25px repeat-y');
  });

  it('첫 렌더에서는 받지 않고 대기 타이머 뒤 한 번 받으며 실패는 삼킨다', async () => {
    let calls = 0;
    vi.doMock('./card-najeon.css', () => { calls++; throw new Error('시험용 CSS 실패'); });
    await startUi();
    expect(calls).toBe(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toBe(1);
  });

  it('idle 콜백이 있으면 첫 idle에 한 번 예약하고 정적으로 가져오지 않는다', async () => {
    const callbacks: (() => void)[] = [];
    const stubGlobal = vi.stubGlobal;
    vi.spyOn(vi, 'stubGlobal').mockImplementation((name, value) => {
      if (name === 'window') (value as { requestIdleCallback: (callback: () => void) => void }).requestIdleCallback = (callback: () => void) => { callbacks.push(callback); };
      return stubGlobal(name, value);
    });
    let calls = 0;
    vi.doMock('./card-najeon.css', () => { calls++; return {}; });
    await startUi();
    expect(calls).toBe(0);
    expect(callbacks).toHaveLength(2);
    callbacks[0]!();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(calls).toBe(1);
    const source = read('src/ui/main.ts');
    expect(source).not.toMatch(/^import\s+['"]\.\/card-najeon\.css['"]/m);
  });

  it('head의 color-scheme은 CSS :root와 같은 only dark다', () => {
    const meta = read('index.html').match(/<meta name="color-scheme" content="([^"]+)"/)!;
    const root = read('src/ui/style.css').match(/:root\s*\{([\s\S]*?)\}/)![1]!;
    const scheme = root.match(/color-scheme:\s*([^;]+);/)![1]!;
    expect(meta[1]).toBe(scheme);
    expect(scheme).toBe('only dark');
  });
});
